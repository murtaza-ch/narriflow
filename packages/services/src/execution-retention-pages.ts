import { appendProjectNotificationIntent } from "./notification-execution";
import { takeExecutionDispatchIds } from "./execution-dispatch-runtime";
import { lockExecutionRecoveryParents } from "./execution-recovery-locks";
import { admitMediaCleanupObligations } from "./media-cleanup-admission";
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
  const field = quoted(clock), after = page.after ? Prisma.sql`AND (${field}, id) > ((${page.after.at}::timestamp), ${page.after.id}::uuid)` : Prisma.empty;
  return tx.$queryRaw<Array<MaintenancePosition>>(Prisma.sql`SELECT id, ${field} AS at FROM ${quoted(table)} WHERE ${where}
    AND ${field} <= (${cutoff}::timestamp) ${after} ORDER BY ${field}, id LIMIT ${page.limit + 1}`);
}
function result(selected: MaintenancePosition[], all: MaintenancePosition[], page: MaintenancePage, dispatchIds: string[] = []) {
  return { processed: selected.length, next: all.length > page.limit ? selected.at(-1)! : null, dispatchIds };
}
function old(cutoff: Date, days: number) { return new Date(Math.max(0, cutoff.getTime() - days * DAY)); }
export const expireWorkflowEventPage: MaintenancePhaseHandler = async (tx, page) => {
  const all = await rows(tx, page, "WorkflowEvent", "emittedAt", Prisma.sql`(NOT "notificationRequired" OR "notificationDeliveredAt" IS NOT NULL)
    AND (NOT "progressRequired" OR "progressPublishedAt" IS NOT NULL)`, old(page.cutoff, EXECUTION_RETENTION_DAYS.workflowEvents));
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
  if (selected.length) {const receipts=await tx.projectDeletionReceipt.findMany({where:{id:{in:selected.map(row=>row.id)},deleteAfter:{lte:page.cutoff}},select:{tombstoneStorageKey:true,deleteAfter:true}});for(const receipt of receipts)if(!/^retention-receipts\/v1\/[a-f0-9]{64}\.json$/.test(receipt.tombstoneStorageKey))throw Error("project_deletion_receipt_key_invalid");await admitMediaCleanupObligations(tx,receipts.map(row=>({origin:"project_retention",cleanupClass:"retention_receipt",objectKey:row.tombstoneStorageKey,notBefore:row.deleteAfter})));await tx.projectDeletionReceipt.deleteMany({ where: { id: { in: selected.map(row => row.id) }, deleteAfter: { lte: page.cutoff } } });}
  return result(selected, all, page,takeExecutionDispatchIds(tx));
};
/** This daily safety page knows exact persisted intents only. It never lists
 * a bucket, infers an orphan, or marks an object deleted without actual ACK. */
export const recoverMediaCleanupPage: MaintenancePhaseHandler = async (tx, page) => {
  const all = await rows(tx, page, "MediaCleanupObligation", "nextAttemptAt", Prisma.sql`"completedAt" IS NULL`), selected = all.slice(0, page.limit);
  const dispatchIds = (await queueMediaCleanupBatchWithinTransaction(tx, selected.map(row => row.id))).map(row => row.dispatchId);
  return result(selected, all, page, dispatchIds);
};

/** Retire only an authoritative current video object. SourceAudio is a separate
 * immutable transcription binding and is not part of video retention. */
export const retireSourceMediaPage:MaintenancePhaseHandler=async(tx,page)=>{
 const cutoff=old(page.cutoff,EXECUTION_RETENTION_DAYS.sources),after=page.after?Prisma.sql`AND (p."ingestCompletedAt",p.id)>((${page.after.at}::timestamp),${page.after.id}::uuid)`:Prisma.empty;
 const all=await tx.$queryRaw<Array<{id:string;at:Date;workspaceId:string;projectId:string}>>`SELECT p.id,p.id AS "projectId",p."ingestCompletedAt" AS at,p."workspaceId" FROM "Project" p
 WHERE p."ingestStatus"='ready' AND p."sourceStorageKey" IS NOT NULL AND p."purgeStartedAt" IS NULL AND p."ingestCompletedAt"<(${cutoff}::timestamp)
 AND NOT EXISTS(SELECT 1 FROM "WorkflowRun" r WHERE r."projectId"=p.id AND r.status IN ('queued','running','waiting'))
 AND NOT EXISTS(SELECT 1 FROM "IngestJob" j WHERE j."projectId"=p.id AND j.status IN ('queued','running'))
 AND NOT EXISTS(SELECT 1 FROM "Clip" c WHERE c."projectId"=p.id AND c."previewStorageKey" IS NULL)
 AND EXISTS(SELECT 1 FROM "Clip" c JOIN "ClipRender" r ON r."clipId"=c.id WHERE c."projectId"=p.id AND r.status='completed' AND r."storageKey" IS NOT NULL)
 ${after} ORDER BY p."ingestCompletedAt",p.id LIMIT ${page.limit+1}`;
 const selected=all.slice(0,page.limit);await lockExecutionRecoveryParents(tx,selected);
 const dispatchIds:string[]=[];
 for(const candidate of selected){
  const project=await tx.project.findUniqueOrThrow({where:{id:candidate.id},include:{workflowRuns:{where:{status:{in:["queued","running","waiting"]}},take:1,select:{id:true}},ingestJobs:{where:{status:{in:["queued","running"]}},take:1,select:{id:true}},clips:{where:{previewStorageKey:null},take:1,select:{id:true}}}});
  if(project.purgeStartedAt||project.ingestStatus!=="ready"||!project.sourceStorageKey||!project.ingestCompletedAt||project.ingestCompletedAt>=cutoff||project.workflowRuns.length||project.ingestJobs.length||project.clips.length)continue;
  const artifact=await tx.executionArtifact.findUnique({where:{storageKey:project.sourceStorageKey},include:{attempt:{include:{dispatch:true}}}});
  if(!artifact?.committedAt||artifact.role!=="source_video"||artifact.attempt.dispatch.subjectKind!=="ingest_job"||!await tx.ingestJob.findFirst({where:{id:artifact.attempt.dispatch.subjectId,projectId:project.id},select:{id:true}}))throw Error("source_retention_binding_unavailable");
  await tx.project.update({where:{id:project.id},data:{sourceStorageKey:null}});
  await admitMediaCleanupObligations(tx,[{origin:"assigned_execution_artifact",cleanupClass:"assigned_artifact",objectKey:artifact.storageKey,projectId:project.id,notBefore:new Date(Math.max(artifact.grantExpiresAt.getTime(),artifact.attempt.operationDeadlineAt.getTime())+120000)}]);
  const intent=await tx.mediaCleanupObligation.findUniqueOrThrow({where:{origin_cleanupClass_objectKey:{origin:"assigned_execution_artifact",cleanupClass:"assigned_artifact",objectKey:artifact.storageKey}}});
  dispatchIds.push(...(await queueMediaCleanupBatchWithinTransaction(tx,[intent.id])).map(row=>row.dispatchId));
 }
 return result(selected,all,page,dispatchIds);
};

export const planProjectExpiryWarningPage:MaintenancePhaseHandler=async(tx,page)=>{
 const at=Prisma.sql`p."expiresAt"-INTERVAL '24 hours'`,after=page.after?Prisma.sql`AND (${at},p.id)>((${page.after.at}::timestamp),${page.after.id}::uuid)`:Prisma.empty;
 const rows=await tx.$queryRaw<Array<{id:string;at:Date;projectId:string;workspaceId:string}>>`SELECT p.id,p.id AS "projectId",${at} AS at,p."workspaceId" FROM "Project" p WHERE p."expiresAt">(${page.cutoff}::timestamp) AND ${at}<=(${page.cutoff}::timestamp) AND p."purgeStartedAt" IS NULL ${after} ORDER BY ${at},p.id LIMIT ${page.limit+1}`,selected=rows.slice(0,page.limit);await lockExecutionRecoveryParents(tx,selected);
 for(const row of selected){const project=await tx.project.findUniqueOrThrow({where:{id:row.id},select:{expiresAt:true,purgeStartedAt:true}});if(project.expiresAt&&project.expiresAt>page.cutoff&&project.expiresAt.getTime()-86400000<=page.cutoff.getTime()&&!project.purgeStartedAt)await appendProjectNotificationIntent(tx,{projectId:row.id,sourceId:row.id,outcome:"project_expiring"});}
 return {processed:selected.length,next:rows.length>page.limit?selected.at(-1)!:null,dispatchIds:takeExecutionDispatchIds(tx)};
};
