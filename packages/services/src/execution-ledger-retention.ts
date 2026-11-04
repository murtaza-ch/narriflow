import { Prisma } from "@prisma/client";
import type { MaintenancePage, MaintenancePhaseHandler, MaintenancePosition } from "./execution-maintenance";

const DAY = 86_400_000;
const FINISHED_ATTEMPT = Prisma.sql`('completed','failed','released','cancelled','expired','superseded')`;
/** One SQL statement removes this many rows per page, so a backlog does not
 * cost a Workflow per 32 rows. `processed` stays inside the page contract. */
const ROWS_PER_PAGE = 32;

/** Every window is longer than whatever can still read the row.
 * - dispatches 30: inbox receipts replay their wake ids for 7 days. A later
 *   replay of the identity only appends an identical wake, which grants nothing.
 * - attempts 90: the token fences an executor for 45 minutes at most; a missing
 *   token fails closed as invalid_reference. Matches WorkflowEvent history.
 * - artifacts 30: the row is ownership evidence for its object, so it goes only
 *   after that object's deletion was acknowledged.
 * - cleanupObligations 30: a completed row only remembers the deletion, and it
 *   stays while an artifact still names the object.
 * - outboundDeliveries 30, past the delivery's own expiry: the row dedupes one
 *   event per target and holds its receipt object until then.
 * - zoomJobs 30: eventKey dedupes Zoom's redelivery, which ends within hours.
 * - operationReceipts 90 and completionCallbacks 90: client retries of an
 *   idempotency key end long before this, and a callback follows its receipt.
 * - uploadSessions 30: past the hard expiry, with cleanup finished.
 * - analyticsEvents 365: append-only product history with no runtime reader.
 * - oauthStates 1: an expired state can never complete a connection. */
export const EXECUTION_LEDGER_RETENTION_DAYS = { dispatches: 30, attempts: 90, artifacts: 30, cleanupObligations: 30, outboundDeliveries: 30, zoomJobs: 30,
  operationReceipts: 90, completionCallbacks: 90, uploadSessions: 30, analyticsEvents: 365, oauthStates: 1 } as const;

function before(page: MaintenancePage, days: number) { return new Date(Math.max(0, page.cutoff.getTime() - days * DAY)); }
function quoted(value: string) { return Prisma.raw(`"${value}"`); }
function outcome(selected: MaintenancePosition[], all: MaintenancePosition[], page: MaintenancePage, batch: number) {
  return { processed: Math.min(selected.length, page.limit), next: all.length > batch ? selected.at(-1)! : null, dispatchIds: [] };
}
function cursor(page: MaintenancePage, clock: Prisma.Sql, id: Prisma.Sql) {
  if (page.after?.tie) throw new Error("maintenance_cursor_invalid");
  return page.after ? Prisma.sql`AND (${clock}, ${id}) > ((${page.after.at}::timestamp), ${page.after.id}::uuid)` : Prisma.empty;
}

/** Table, clock and predicate are fixed by this module, never request input. */
function retained(table: string, clock: string, days: number, where: (bound: Date) => Prisma.Sql, key = "id"): MaintenancePhaseHandler {
  return async (tx, page) => {
    const name = quoted(table), field = quoted(clock), id = quoted(key), batch = page.limit * ROWS_PER_PAGE, bound = before(page, days);
    const all = await tx.$queryRaw<MaintenancePosition[]>(Prisma.sql`SELECT ${id} AS id, ${field} AS at FROM ${name} WHERE ${where(bound)}
      AND ${field} <= (${bound}::timestamp) ${cursor(page, field, id)} ORDER BY ${field}, ${id} LIMIT ${batch + 1}`);
    const selected = all.slice(0, batch);
    if (selected.length) await tx.$executeRaw(Prisma.sql`DELETE FROM ${name} WHERE ${id} IN (${Prisma.join(selected.map(row => Prisma.sql`${row.id}::uuid`))})`);
    return outcome(selected, all, page, batch);
  };
}

/** Terminal only, and past the delivery's own expiry. */
export const expireOutboundDeliveryPage = retained("OutboundDelivery", "expiresAt", EXECUTION_LEDGER_RETENTION_DAYS.outboundDeliveries, () => Prisma.sql`status IN ('completed','failed','cancelled')`);
export const expireZoomWebhookJobPage = retained("ZoomWebhookJob", "availableAt", EXECUTION_LEDGER_RETENTION_DAYS.zoomJobs,
  bound => Prisma.sql`status IN ('completed','failed') AND "completedAt" <= (${bound}::timestamp)`);
export const expireOperationReceiptPage = retained("OperationReceipt", "createdAt", EXECUTION_LEDGER_RETENTION_DAYS.operationReceipts, () => Prisma.sql`TRUE`);
export const expireCompletionCallbackPage = retained("CompletionCallback", "updatedAt", EXECUTION_LEDGER_RETENTION_DAYS.completionCallbacks,
  () => Prisma.sql`state IN ('delivered','failed','cancelled')`);
export const expireProgramAnalyticsEventPage = retained("ProgramAnalyticsEvent", "createdAt", EXECUTION_LEDGER_RETENTION_DAYS.analyticsEvents, () => Prisma.sql`TRUE`);
export const expireUploadSessionPage = retained("UploadSession", "expiresAt", EXECUTION_LEDGER_RETENTION_DAYS.uploadSessions,
  bound => Prisma.sql`status IN ('queued_for_ingest','aborted','expired','failed') AND "cleanupRetryAt" IS NULL AND "hardExpiresAt" <= (${bound}::timestamp)`);
export const expireSocialOAuthStatePage = retained("SocialOAuthState", "expiresAt", EXECUTION_LEDGER_RETENTION_DAYS.oauthStates, () => Prisma.sql`TRUE`);

/** FK order is artifact, attempt, dispatch. An artifact proves who owned its
 * object, and media cleanup refuses an assigned object without it, so it leaves
 * only after that object's deletion was acknowledged and nothing else is open. */
export const expireExecutionArtifactPage: MaintenancePhaseHandler = async (tx, page) => {
  const clock = Prisma.sql`done."completedAt"`, id = Prisma.sql`artifact.id`, batch = page.limit * ROWS_PER_PAGE;
  const all = await tx.$queryRaw<MaintenancePosition[]>(Prisma.sql`SELECT artifact.id, done."completedAt" AS at FROM "MediaCleanupObligation" done
    JOIN "ExecutionArtifact" artifact ON artifact."storageKey" = done."objectKey"
    JOIN "ExecutionAttempt" attempt ON attempt."attemptToken" = artifact."attemptToken"
    WHERE done."completedAt" <= (${before(page, EXECUTION_LEDGER_RETENTION_DAYS.artifacts)}::timestamp) AND attempt.status IN ${FINISHED_ATTEMPT}
      AND NOT EXISTS (SELECT 1 FROM "MediaCleanupObligation" pending WHERE pending."objectKey" = done."objectKey" AND pending."completedAt" IS NULL)
      ${cursor(page, clock, id)} ORDER BY ${clock}, ${id} LIMIT ${batch + 1}`);
  const selected = all.slice(0, batch);
  if (selected.length) await tx.executionArtifact.deleteMany({ where: { id: { in: [...new Set(selected.map(row => row.id))] } } });
  return outcome(selected, all, page, batch);
};
export const expireCleanupObligationPage = retained("MediaCleanupObligation", "completedAt", EXECUTION_LEDGER_RETENTION_DAYS.cleanupObligations,
  () => Prisma.sql`NOT EXISTS (SELECT 1 FROM "ExecutionArtifact" artifact WHERE artifact."storageKey" = "MediaCleanupObligation"."objectKey")`);
/** The absolute deadline bounds the attempt's whole life and is indexed. */
export const expireExecutionAttemptPage = retained("ExecutionAttempt", "operationDeadlineAt", EXECUTION_LEDGER_RETENTION_DAYS.attempts,
  () => Prisma.sql`status IN ${FINISHED_ATTEMPT} AND NOT EXISTS (SELECT 1 FROM "ExecutionArtifact" artifact WHERE artifact."attemptToken" = "ExecutionAttempt"."attemptToken")`, "attemptToken");

/** Wakes, deadlines and native spawns are finished once acknowledged. A domain
 * registration is different: recovery, source handoff and restore re-read it
 * for as long as the subject lives, so only a registration whose subject row is
 * gone may leave. Unacknowledged and dead-lettered rows always stay. */
export const expireExecutionDispatchPage = retained("ExecutionDispatch", "acknowledgedAt", EXECUTION_LEDGER_RETENTION_DAYS.dispatches, bound => Prisma.sql`"dueAt" <= (${bound}::timestamp)
  AND NOT EXISTS (SELECT 1 FROM "ExecutionAttempt" attempt WHERE attempt."dispatchId" = "ExecutionDispatch".id)
  AND ("wakeKind" IS NOT NULL OR "deadlineKind" IS NOT NULL OR kind IN ('maintenance','project_progress','modal_execution','local_fetch') OR CASE "subjectKind"
    WHEN 'ingest_job' THEN NOT EXISTS (SELECT 1 FROM "IngestJob" subject WHERE subject.id = "subjectId"::uuid)
    WHEN 'workflow_run' THEN NOT EXISTS (SELECT 1 FROM "WorkflowRun" subject WHERE subject.id = "subjectId"::uuid)
    WHEN 'render_group' THEN NOT EXISTS (SELECT 1 FROM "RenderGroup" subject WHERE subject.id = "subjectId"::uuid)
    WHEN 'clip_preparation' THEN NOT EXISTS (SELECT 1 FROM "ClipPreparation" subject WHERE subject.id = "subjectId"::uuid)
    WHEN 'clip_selection_window' THEN NOT EXISTS (SELECT 1 FROM "ClipSelectionWindow" subject WHERE subject.id = "subjectId"::uuid)
    WHEN 'outbound_delivery' THEN NOT EXISTS (SELECT 1 FROM "OutboundDelivery" subject WHERE subject.id = "subjectId"::uuid)
    WHEN 'upload_session' THEN NOT EXISTS (SELECT 1 FROM "UploadSession" subject WHERE subject.id = "subjectId"::uuid)
    WHEN 'zoom_notification' THEN NOT EXISTS (SELECT 1 FROM "ZoomWebhookJob" subject WHERE subject.id = "subjectId"::uuid)
    WHEN 'completion_callback' THEN NOT EXISTS (SELECT 1 FROM "CompletionCallback" subject WHERE subject.id = "subjectId"::uuid)
    ELSE FALSE END)`);
