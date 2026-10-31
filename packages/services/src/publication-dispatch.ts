import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";

const scheduleInclude = { frozenState: true } satisfies Prisma.SocialPostInclude;
export type PublicationSchedule = Prisma.SocialPostGetPayload<{ include: typeof scheduleInclude }>;
type Tx = Prisma.TransactionClient;

/** Schedule intent and physical-cycle identity are distinct. Provider checkpoints
 * and mutable statuses never alter the frozen input of an already admitted cycle. */
export function publicationExecutionInputHash(post: PublicationSchedule) {
 const frozen = post.frozenState;
 return createHash("sha256").update(JSON.stringify([
  "publication-execution-v1", post.id,post.workspaceId,post.projectId,post.createdByUserId,
  post.deploymentEpoch,post.generation,post.scheduleRevision,post.immutableRequestHash,
  post.scheduledFor?.toISOString() ?? null,post.standingGrantId,post.standingGrantRevision,
  frozen ? [frozen.id,frozen.clipExportId,frozen.clipExportVariantId,frozen.editorRevision,
   frozen.exportFingerprint,frozen.platform,frozen.socialAccountId,frozen.capabilityVersion,
   createHash("sha256").update(frozen.caption).digest("hex")] : null,
 ])).digest("hex");
}

export async function appendPublicationDispatch(tx: Tx, postId: string, options: {
 dueAt?: Date; wakeKind?: string;
} = {}) {
 const post = await tx.socialPost.findUniqueOrThrow({where:{id:postId},include:scheduleInclude});
 const epoch = await tx.executionEpoch.findUniqueOrThrow({where:{id:1}});
 if (post.deploymentEpoch!==epoch.epoch) throw new Error("publication_epoch_superseded");
 const result = await appendExecutionDispatch(tx,{
  deploymentEpoch:post.deploymentEpoch,generation:post.generation,kind:"operation_driver",
  subject:{kind:"social_publication",id:post.id},inputHash:publicationExecutionInputHash(post),
  dueAt:options.dueAt ?? post.nextAttemptAt ?? post.scheduledFor ?? post.createdAt,
  ...(options.wakeKind ? {wakeKind:options.wakeKind} : {}),
 });
 return result.reference.dispatchId;
}

export type PublicationScheduleObservation =
 | {kind:"superseded"}
 | {kind:"terminal"}
 | {kind:"sleep";dueAt:Date}
 | {kind:"waiting_export";clipExportVariantId:string}
 | {kind:"ready";post:PublicationSchedule};

/** The Workflow rereads this snapshot after every sleep. A stale wake cannot
 * claim a newer revision, even if its old due time has already arrived. */
export async function observePublicationSchedule(
 database: Pick<PrismaClient,"$transaction">, reference:ExecutionDispatchReference,
):Promise<PublicationScheduleObservation>{
 return database.$transaction(async tx=>{
  const epoch=await tx.executionEpoch.findUniqueOrThrow({where:{id:1}});
  const ledger=(await readExecutionDispatch(tx,reference.dispatchId))?.reference;
  if(reference.kind!=="operation_driver"||reference.subject.kind!=="social_publication"||
   reference.deploymentEpoch!==epoch.epoch || !ledger || ledger.dispatchId!==reference.dispatchId || ledger.kind!==reference.kind || ledger.subject.kind!==reference.subject.kind || ledger.subject.id!==reference.subject.id || ledger.deploymentEpoch!==reference.deploymentEpoch || ledger.generation!==reference.generation || ledger.inputHash!==reference.inputHash)return {kind:"superseded"};
  await tx.$queryRaw`SELECT "id" FROM "SocialPost" WHERE "id"=${reference.subject.id}::uuid FOR UPDATE`;
  const post=await tx.socialPost.findUnique({where:{id:reference.subject.id},include:scheduleInclude});
  if(!post || post.deploymentEpoch!==epoch.epoch || post.generation!==reference.generation ||
   publicationExecutionInputHash(post)!==reference.inputHash)return {kind:"superseded"};
  if(["draft","cancelled","posted","inbox_delivered","failed","needs_attention"].includes(post.status))return {kind:"terminal"};
  const [clock]=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
  const dueAt=post.nextAttemptAt??post.scheduledFor??post.createdAt;
  if(dueAt>clock!.now)return {kind:"sleep",dueAt};
  if(!post.frozenState)return {kind:"terminal"};
  if(!post.frozenState.storageKey || post.frozenState.sizeBytes===null || post.frozenState.durationSec===null)
   return {kind:"waiting_export",clipExportVariantId:post.frozenState.clipExportVariantId};
  return {kind:"ready",post};
 });
}
