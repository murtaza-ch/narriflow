import { Prisma } from "@prisma/client";
import type { MaintenancePage, MaintenancePhaseHandler, MaintenancePosition } from "./execution-maintenance";
import { queueMediaCleanupBatchWithinTransaction } from "./media-cleanup-control";

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;
export const EXECUTION_RETENTION_DAYS = { workflowEvents: 90, workspaceEvents: 30, webhookLogs: 30, sources: 90 } as const;
/** These are fixed identifiers owned by the service, never request input. */
type Table = "WorkflowEvent" | "WorkspaceEvent" | "WebhookDeliveryLog" | "GeneratedMediaJob" | "ProjectDeletionReceipt" | "MediaCleanupObligation";
function quoted(value: string) { return Prisma.raw(`"${value}"`); }
async function rows(tx: Tx, page: MaintenancePage, table: Table, clock: string, where: Prisma.Sql, cutoff = page.cutoff) {
  if (page.after?.tie) throw new Error("maintenance_cursor_invalid");
  const field = quoted(clock), after = page.after ? Prisma.sql`AND (${field}, id) > ((${page.after.at}::timestamptz AT TIME ZONE 'UTC'), ${page.after.id}::uuid)` : Prisma.empty;
  return tx.$queryRaw<Array<MaintenancePosition>>(Prisma.sql`SELECT id, ${field} AS at FROM ${quoted(table)} WHERE ${where}
    AND ${field} <= (${cutoff}::timestamptz AT TIME ZONE 'UTC') ${after} ORDER BY ${field}, id LIMIT ${page.limit + 1}`);
}
function result(selected: MaintenancePosition[], all: MaintenancePosition[], page: MaintenancePage, dispatchIds: string[] = []) {
  return { processed: selected.length, next: all.length > page.limit ? selected.at(-1)! : null, dispatchIds };
}
function old(cutoff: Date, days: number) { return new Date(Math.max(0, cutoff.getTime() - days * DAY)); }
export const expireWorkflowEventPage: MaintenancePhaseHandler = async (tx, page) => {
  const all = await rows(tx, page, "WorkflowEvent", "emittedAt", Prisma.sql`(NOT "notificationRequired" OR "notificationDeliveredAt" IS NOT NULL)
    AND (NOT "progressRequired" OR "progressPublishedAt" IS NOT NULL) AND (NOT "analyticsRequired" OR "analyticsPublishedAt" IS NOT NULL)`, old(page.cutoff, EXECUTION_RETENTION_DAYS.workflowEvents));
  const selected = all.slice(0, page.limit);
  if (selected.length) await tx.workflowEvent.deleteMany({ where: { id: { in: selected.map(row => row.id) }, OR: [{ notificationRequired: false }, { notificationDeliveredAt: { not: null } }] } });
  return result(selected, all, page);
};
/** WorkspaceEventKey is permanent transition memory; event retention cannot
 * make a later settlement emit the same transition for a second time. */
export const expireWorkspaceEventPage: MaintenancePhaseHandler = async (tx, page) => {
  const all = await rows(tx, page, "WorkspaceEvent", "createdAt", Prisma.sql`TRUE`, old(page.cutoff, EXECUTION_RETENTION_DAYS.workspaceEvents)), selected = all.slice(0, page.limit);
  if (selected.length) await tx.workspaceEvent.deleteMany({ where: { id: { in: selected.map(row => row.id) } } });
  return result(selected, all, page);
};
export const expireWebhookLogPage: MaintenancePhaseHandler = async (tx, page) => {
  const all = await rows(tx, page, "WebhookDeliveryLog", "createdAt", Prisma.sql`TRUE`, old(page.cutoff, EXECUTION_RETENTION_DAYS.webhookLogs)), selected = all.slice(0, page.limit);
  if (selected.length) await tx.webhookDeliveryLog.deleteMany({ where: { id: { in: selected.map(row => row.id) } } });
  return result(selected, all, page);
};
export const expireGeneratedPromptPage: MaintenancePhaseHandler = async (tx, page) => {
  const all = await rows(tx, page, "GeneratedMediaJob", "promptExpiresAt", Prisma.sql`status IN ('completed','failed','rejected','cancelled') AND "protectedPrompt" <> ''`), selected = all.slice(0, page.limit);
  if (selected.length) await tx.generatedMediaJob.updateMany({ where: { id: { in: selected.map(row => row.id) }, status: { in: ["completed", "failed", "rejected", "cancelled"] }, promptExpiresAt: { lte: page.cutoff } }, data: { protectedPrompt: "" } });
  return result(selected, all, page);
};
export const expireProjectDeletionReceiptPage: MaintenancePhaseHandler = async (tx, page) => {
  const all = await rows(tx, page, "ProjectDeletionReceipt", "deleteAfter", Prisma.sql`TRUE`), selected = all.slice(0, page.limit);
  if (selected.length) await tx.projectDeletionReceipt.deleteMany({ where: { id: { in: selected.map(row => row.id) }, deleteAfter: { lte: page.cutoff } } });
  return result(selected, all, page);
};
/** This daily safety page knows exact persisted intents only. It never lists
 * a bucket, infers an orphan, or marks an object deleted without actual ACK. */
export const recoverMediaCleanupPage: MaintenancePhaseHandler = async (tx, page) => {
  const all = await rows(tx, page, "MediaCleanupObligation", "nextAttemptAt", Prisma.sql`"completedAt" IS NULL`), selected = all.slice(0, page.limit);
  const dispatchIds = (await queueMediaCleanupBatchWithinTransaction(tx, selected.map(row => row.id))).map(row => row.dispatchId);
  return result(selected, all, page, dispatchIds);
};
