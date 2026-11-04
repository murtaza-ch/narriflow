import { Prisma } from "@prisma/client";
import { appendExecutionDispatches } from "./execution-dispatch";
import type { MaintenancePhaseHandler } from "./execution-maintenance";
import { accessibleProjectSql } from "./project-access";
import { executionDispatchReferenceSchema, type ExecutionSubject } from "@narriflow/validators/execution";

type SubjectKind = ExecutionSubject["kind"];
/** A wake for an inaccessible Project or a restricted Workspace does nothing
 * but add a ledger row and a Workflow. Reactivation returns the row to the page. */
function liveProject(projectId: Prisma.Sql) {
  return Prisma.sql`EXISTS (SELECT 1 FROM "Project" project JOIN "Workspace" workspace ON workspace.id = project."workspaceId"
    WHERE project.id = ${projectId} AND ${accessibleProjectSql("project", Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`)} AND workspace.status = 'active')`;
}
/** Drafts never authorize STT, so an abandoned draft has nothing to wake until a pack commits. */
const committedPack = Prisma.sql`EXISTS (SELECT 1 FROM (SELECT pack.draft FROM "ContentPack" pack WHERE pack."projectId" = "IngestJob"."projectId"
  ORDER BY pack."createdAt" DESC, pack.id DESC LIMIT 1) latest WHERE NOT latest.draft)`;
const readySource = Prisma.sql`EXISTS (SELECT 1 FROM "Project" project WHERE project.id = "IngestJob"."projectId" AND project."ingestStatus" = 'ready')`;
const liveRunProject = Prisma.sql`EXISTS (SELECT 1 FROM "WorkflowRun" run WHERE run.id = "RenderGroup"."workflowRunId" AND ${liveProject(Prisma.sql`run."projectId"`)})`;
/** A safety observation re-enters the existing driver. It cannot acquire a
 * token, spend a charge or manufacture an immutable domain input from old data. */
function recovery(table: string, subjectKind: SubjectKind, active: Prisma.Sql): MaintenancePhaseHandler {
  const name = Prisma.raw(`"${table}"`);
  return async (tx, page) => {
    if (page.after?.tie) throw new Error("maintenance_cursor_invalid");
    const after = page.after ? Prisma.sql`AND ("createdAt", id) > ((${page.after.at}::timestamp), ${page.after.id}::uuid)` : Prisma.empty;
    const rows = await tx.$queryRaw<Array<{ id: string; at: Date; generation: number }>>(Prisma.sql`SELECT id,"createdAt" AS at,generation FROM ${name}
      WHERE "deploymentEpoch"=${page.deploymentEpoch} AND (${active}) AND "createdAt"<=(${page.cutoff}::timestamp) ${after}
      ORDER BY "createdAt",id LIMIT ${page.limit + 1}`);
    const selected = rows.slice(0, page.limit);
    if (!selected.length) return { processed: 0, next: null, dispatchIds: [] };
    const inputs = Prisma.join(selected.map(row => Prisma.sql`(${row.id}::uuid,${row.generation}::integer)`));
    const registered = await tx.$queryRaw<Array<{ id: string; dispatchId: string | null; kind: string | null; inputHash: string | null; generation: number }>>(Prisma.sql`SELECT target.id,target.generation,
      registration.id AS "dispatchId",registration.kind,registration."inputHash" FROM (VALUES ${inputs}) AS target(id,generation)
      LEFT JOIN LATERAL (SELECT id,kind,"inputHash" FROM "ExecutionDispatch" WHERE "deploymentEpoch"=${page.deploymentEpoch}
        AND "subjectKind"=${subjectKind} AND "subjectId"=target.id::text AND generation=target.generation
        AND kind IN ('operation_driver','import_pipeline','render_run') AND "wakeKind" IS NULL AND "deadlineKind" IS NULL ORDER BY "createdAt",id LIMIT 1) registration ON TRUE`);
    // A group frozen before its video arrives has no driver until video_ready
    // registers one. One such row must never cost the rest of the hourly sweep.
    const dispatches = await appendExecutionDispatches(tx, registered.flatMap(row => {
      const reference = executionDispatchReferenceSchema.safeParse({ dispatchId: row.dispatchId, kind: row.kind,
        subject: { kind: subjectKind, id: row.id }, generation: row.generation, deploymentEpoch: page.deploymentEpoch, inputHash: row.inputHash });
      if (!reference.success) {
        console.warn(JSON.stringify({ level: "warn", message: "maintenance_domain_registration_missing", subjectKind, subjectId: row.id, generation: row.generation }));
        return [];
      }
      return [{ ...reference.data, dueAt: page.cutoff, wakeKind: `hourly_${page.cutoff.getTime()}` }];
    }));
    return { processed: selected.length, next: rows.length > page.limit ? selected.at(-1)! : null, dispatchIds: dispatches.map(row => row.reference.dispatchId) };
  };
}
export const recoverIngestWakePage = recovery("IngestJob", "ingest_job", Prisma.sql`${liveProject(Prisma.sql`"IngestJob"."projectId"`)} AND (status IN ('queued','running') OR (status='completed' AND "generationHandoffAt" IS NULL AND ${readySource} AND ${committedPack}))`);
export const recoverWorkflowWakePage = recovery("WorkflowRun", "workflow_run", Prisma.sql`status IN ('queued','running','waiting') AND stage IN ('moment_detection','clip_rendering') AND ${liveProject(Prisma.sql`"WorkflowRun"."projectId"`)}`);
export const recoverProviderWaitPage = recovery("WorkflowRun", "workflow_run", Prisma.sql`stage='stt' AND status IN ('queued','running','waiting') AND ${liveProject(Prisma.sql`"WorkflowRun"."projectId"`)}`);
export const recoverRenderGroupWakePage = recovery("RenderGroup", "render_group", Prisma.sql`status IN ('queued','running') AND ${liveRunProject}`);
export const recoverSelectionWakePage = recovery("ClipSelectionWindow", "clip_selection_window", Prisma.sql`status IN ('queued','running') AND ${liveProject(Prisma.sql`"ClipSelectionWindow"."projectId"`)}`);
export const recoverPreparationWakePage = recovery("ClipPreparation", "clip_preparation", Prisma.sql`status IN ('queued','running') AND ${liveProject(Prisma.sql`"ClipPreparation"."projectId"`)}`);
export const recoverNativeValidationWakePage = recovery("NativeValidationJob", "native_validation", Prisma.sql`status IN ('queued','processing')`);
export const recoverThumbnailWakePage = recovery("ThumbnailFrameOperation", "thumbnail_frame", Prisma.sql`status IN ('queued','processing')`);
export const recoverGeneratedMediaWakePage = recovery("GeneratedMediaJob", "generated_media", Prisma.sql`status IN ('queued','running','waiting') AND NOT "outcomeUnknown"`);
export const recoverOutboundProbeWakePage = recovery("OutboundProbe", "outbound_probe", Prisma.sql`status IN ('queued','processing')`);
export const recoverOutboundDeliveryWakePage = recovery("OutboundDelivery", "outbound_delivery", Prisma.sql`status IN ('queued','processing')`);

/** Cleanup registration can be acknowledged before its Workflow fails. Observe
 * only due, unclaimed intents with a current base; daily repair owns missing
 * bases. A distinct wake re-enters the exact authority through Maintenance. */
export const recoverMediaCleanupWakePage: MaintenancePhaseHandler = async (tx, page) => {
  if (page.after?.tie) throw new Error("maintenance_cursor_invalid");
  const after = page.after ? Prisma.sql`AND (intent."nextAttemptAt", intent.id) > ((${page.after.at}::timestamp), ${page.after.id}::uuid)` : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ id: string; at: Date; dispatchId: string; generation: number; inputHash: string }>>(Prisma.sql`
    SELECT intent.id, intent."nextAttemptAt" AS at, registration.id AS "dispatchId", registration.generation, registration."inputHash"
    FROM "MediaCleanupObligation" intent
    JOIN LATERAL (SELECT id, generation, "inputHash", "dueAt" FROM "ExecutionDispatch"
      WHERE "deploymentEpoch" = ${page.deploymentEpoch} AND kind = 'operation_driver' AND "subjectKind" = 'media_cleanup'
        AND "subjectId" = intent.id::text AND "wakeKind" IS NULL AND "deadlineKind" IS NULL
      ORDER BY generation DESC LIMIT 1) registration ON registration."dueAt" = intent."nextAttemptAt"
    WHERE intent."completedAt" IS NULL AND intent."nextAttemptAt" <= (${page.cutoff}::timestamp)
      AND (intent."claimExpiresAt" IS NULL OR intent."claimExpiresAt" <= (${page.cutoff}::timestamp)) ${after}
    ORDER BY intent."nextAttemptAt", intent.id LIMIT ${page.limit + 1}`);
  const selected = rows.slice(0, page.limit);
  const dispatches = await appendExecutionDispatches(tx, selected.map(row => ({
    ...executionDispatchReferenceSchema.parse({ dispatchId: row.dispatchId, kind: "operation_driver", subject: { kind: "media_cleanup", id: row.id },
      generation: row.generation, deploymentEpoch: page.deploymentEpoch, inputHash: row.inputHash }),
    dueAt: page.cutoff, wakeKind: `hourly_${page.cutoff.getTime()}`,
  })));
  const last = selected.at(-1);
  return { processed: selected.length, next: rows.length > page.limit && last ? { at: last.at, id: last.id } : null, dispatchIds: dispatches.map(row => row.reference.dispatchId) };
};
