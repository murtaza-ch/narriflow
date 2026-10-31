import {createHash} from "node:crypto";
import type {Prisma,PrismaClient} from "@prisma/client";
import type {ExecutionDispatchReference} from "@narriflow/validators/execution";
import {readExecutionAdmission} from "./execution-admission";
import {appendExecutionDispatch,readExecutionDispatch} from "./execution-dispatch";
import {collectExecutionDispatch,takeExecutionDispatchIds} from "./execution-dispatch-runtime";
import {executeExecutionPage} from "./execution-page-receipt";
import {appendPublicationDispatch,recoverPublicationDispatches,samePublicationDispatch,type PublicationSchedule} from "./publication-dispatch";
import {lockPublicationPost} from "./publication-locks";
import {emitSocialPostFinished} from "./social-post-finished";
import {queueWorkspaceEvent,flushWorkspaceEvents} from "./workspace-event";
type Tx=Prisma.TransactionClient;
const PAGE=32,uuid="[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const pagePattern=new RegExp(`^pub1\\.([eg])\\.(${uuid})\\.([a-f0-9]{32})\\.(0|${uuid})$`);
const expiryPattern=new RegExp(`^pub1\\.x\\.(${uuid})\\.([1-9][0-9]{0,9})\\.([1-9][0-9]{0,14})$`);
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now=async(tx:Tx)=>(await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`)[0]!.now;
async function append(tx:Tx,id:string,dueAt=new Date(0)){
 const {epoch}=await readExecutionAdmission(tx);
 const row=await appendExecutionDispatch(tx,{deploymentEpoch:epoch,generation:1,kind:"maintenance",subject:{kind:"maintenance",id},inputHash:hash(["publication-page-v1",id]),dueAt});
 collectExecutionDispatch(tx,row.reference.dispatchId);return row.reference.dispatchId;
}
export function isPublicationProducerReference(reference:ExecutionDispatchReference){return reference.kind==="maintenance"&&reference.subject.kind==="maintenance"&&(pagePattern.test(reference.subject.id)||expiryPattern.test(reference.subject.id));}
/** The exact variant's committed terminal facts name a new result; a redelivery
 * reproduces this identity, while a later explicit render gets a distinct one. */
export async function appendPublicationExportWake(tx:Tx,variantId:string){
 const variant=await tx.clipExportVariant.findUnique({where:{id:variantId}});
 if(!variant||!["completed","failed"].includes(variant.status))return null;
 const token=hash([variant.id,variant.status,variant.storageKey,variant.sizeBytes?.toString()??null,variant.durationSec,variant.completedAt?.toISOString()??null]).slice(0,32);
 return append(tx,`pub1.e.${variant.id}.${token}.0`);
}
export async function appendPublicationGrantWake(tx:Tx,grantId:string){
 const event=await tx.standingGrantEvent.findFirst({where:{grantId,kind:{in:["created","renewed","paused","revoked","expired"]}},orderBy:[{createdAt:"desc"},{id:"desc"}],select:{id:true}});
 return event?append(tx,`pub1.g.${grantId}.${event.id.replaceAll("-","")}.0`):null;
}
export async function appendPublicationGrantExpiry(tx:Tx,grant:{id:string;revision:number;expiresAt:Date}){
 return append(tx,`pub1.x.${grant.id}.${grant.revision}.${grant.expiresAt.getTime()}`,grant.expiresAt);
}

/** Caller holds the Post's canonical locks. Only the initially absent tuple may
 * fill; native work still requires the exact sealed RenderArtifact binding. */
export async function refreshPublicationExport(tx:Tx,post:PublicationSchedule):Promise<"ready"|"waiting"|"terminal">{
 const frozen=post.frozenState;if(!frozen)return "terminal";
 if(frozen.storageKey&&frozen.sizeBytes!==null&&frozen.durationSec!==null)return "ready";
 const variant=await tx.clipExportVariant.findUnique({where:{id:frozen.clipExportVariantId},include:{export:true}});
 if(!variant||variant.exportId!==frozen.clipExportId||variant.export.projectId!==post.projectId||variant.export.editorRevision!==frozen.editorRevision||variant.export.fingerprint!==frozen.exportFingerprint||variant.status==="failed"||variant.export.status==="failed"){
  await tx.socialPost.update({where:{id:post.id},data:{status:"failed",errorCode:"social_export_failed",errorDisposition:"permanent",nextAttemptAt:null}});
  await appendPublicationDispatch(tx,post.id,{dueAt:new Date(0),wakeKind:"publication_export_failed"});
  await emitSocialPostFinished(tx,{socialPostId:post.id});return "terminal";
 }
 if(variant.status!=="completed"||!variant.storageKey||variant.sizeBytes===null||variant.durationSec===null)return "waiting";
 await tx.frozenPublicationState.update({where:{id:frozen.id},data:{storageKey:variant.storageKey,sizeBytes:variant.sizeBytes,durationSec:variant.durationSec,mediaReadyAt:variant.completedAt??await now(tx)}});
 await tx.socialPost.updateMany({where:{id:post.id,status:"preparing_video"},data:{status:"scheduled"}});return "ready";
}
export async function returnPublicationGrantPost(tx:Tx,post:PublicationSchedule,grant:{id:string;revision:number;status:string}){
 if(!["revoked","expired"].includes(grant.status)||!["scheduled","preparing_video"].includes(post.status)||await tx.socialPublicationAttempt.count({where:{socialPostId:post.id}}))return false;
 await tx.frozenPublicationState.deleteMany({where:{socialPostId:post.id}});
 await tx.socialPost.update({where:{id:post.id},data:{status:"draft",scheduledFor:null,nextAttemptAt:null,standingGrantId:null,standingGrantRevision:null}});
 await tx.socialPostProposal.updateMany({where:{socialPostId:post.id},data:{acceptedAt:null,acceptedByUserId:null}});
 await tx.standingGrantEvent.create({data:{grantId:grant.id,kind:"returned",revision:grant.revision,actorUserId:null,reason:"Scheduled post returned to the proposal inbox because its grant ended"}});return true;
}
export interface PublicationProducerResult {kind:"complete"|"superseded"|"sleep";dispatchIds:string[];dueAt?:Date}
/** One exact fixed obligation, a bounded page, and post-commit confirmation.
 * Cursor pages have durable receipts, so a lost ACK cannot strand their child. */
export function createPublicationProducers(options:{database:PrismaClient;register(ids:readonly string[]):Promise<void>}){
 const db=options.database;
 return {async dispatch(reference:ExecutionDispatchReference):Promise<PublicationProducerResult>{
  const result=await db.$transaction(async tx=>{
   const {epoch}=await readExecutionAdmission(tx),ledger=await readExecutionDispatch(tx,reference.dispatchId);
   if(!isPublicationProducerReference(reference)||epoch!==reference.deploymentEpoch||!ledger||!samePublicationDispatch(ledger.reference,reference))return {kind:"superseded" as const,dispatchIds:[]};
   const clock=await now(tx);if(ledger.dueAt>clock)return {kind:"sleep" as const,dueAt:ledger.dueAt,dispatchIds:[]};
   const outcome=await executeExecutionPage(tx,reference,"maintenance-page",async()=>{
    const expires=expiryPattern.exec(reference.subject.id);
    if(expires){
     await tx.$queryRaw`SELECT "id" FROM "StandingGrant" WHERE "id"=${expires[1]}::uuid FOR UPDATE`;
     const grant=await tx.standingGrant.findUnique({where:{id:expires[1]}});
     if(!grant||grant.revision!==Number(expires[2])||grant.expiresAt.getTime()!==Number(expires[3])||!["active","paused"].includes(grant.status))return {kind:"complete",processed:0,dispatchIds:[]};
     await tx.standingGrant.update({where:{id:grant.id},data:{status:"expired",pauseNoticePending:false,pauseNoticeLeaseUntil:null}});
     await tx.standingGrantEvent.create({data:{grantId:grant.id,kind:"expired",revision:grant.revision,actorUserId:null}});
     await appendPublicationGrantWake(tx,grant.id);
     queueWorkspaceEvent(tx,{workspaceId:grant.workspaceId,projectId:null,type:"grant.expired",subject:{grantId:grant.id,kind:grant.kind,autopilotRuleId:grant.autopilotRuleId},dedupeKey:`grant.expired:${grant.id}:${grant.revision}`});await flushWorkspaceEvents(tx);
     return {kind:"complete",processed:1,dispatchIds:takeExecutionDispatchIds(tx)};
    }
    const page=pagePattern.exec(reference.subject.id)!;
    const rows=await tx.socialPost.findMany({where:{deploymentEpoch:epoch,...(page[4]!=="0"?{id:{gt:page[4]}}:{}),...(page[1]==="e"?{frozenState:{clipExportVariantId:page[2]},status:"preparing_video"}:{standingGrantId:page[2]})},orderBy:{id:"asc"},take:PAGE+1,select:{id:true}});
    for(const row of rows.slice(0,PAGE)){
     await lockPublicationPost(tx,row.id);
     const post=await tx.socialPost.findUnique({where:{id:row.id},include:{frozenState:true}});if(!post||post.deploymentEpoch!==epoch)continue;
     if(page[1]==="e")await refreshPublicationExport(tx,post);
     else {const grant=await tx.standingGrant.findUnique({where:{id:page[2]}});if(grant)await returnPublicationGrantPost(tx,post,grant);}
     await appendPublicationDispatch(tx,post.id,{dueAt:new Date(0),wakeKind:`pub_${hash([reference.subject.id,post.id]).slice(0,32)}`});
    }
    if(rows.length>PAGE)await append(tx,`pub1.${page[1]}.${page[2]}.${page[3]}.${rows[PAGE-1]!.id}`);
    return {kind:rows.length>PAGE?"continue":"complete",processed:Math.min(PAGE,rows.length),dispatchIds:takeExecutionDispatchIds(tx)};
   });
   return {kind:"complete" as const,dispatchIds:outcome.dispatchIds};
  });
  for(let offset=0;offset<result.dispatchIds.length;offset+=128)await options.register(result.dispatchIds.slice(offset,offset+128));return result;
 }};
}

/** Restore invalidates physical owners, never the provider identity or charged
 * history. Reconciliation continues on the same logical attempt and deadline. */
export async function restorePublication(tx:Tx,postId:string,epoch:number){
 await lockPublicationPost(tx,postId);const post=await tx.socialPost.findUnique({where:{id:postId},include:{publicationAttempts:true}});
 if(!post||post.deploymentEpoch===epoch)return recoverPublicationDispatches(tx,postId);
 if(post.deploymentEpoch>epoch)throw Error("publication_epoch_superseded");
 const clock=await now(tx);
 for(const attempt of post.publicationAttempts){if(!attempt.currentClaimId)continue;await tx.publicationClaim.updateMany({where:{id:attempt.currentClaimId},data:{releasedAt:clock,accountSlotKey:null}});await tx.socialPublicationAttempt.update({where:{id:attempt.id},data:{currentClaimId:null}});}
 await tx.socialPost.update({where:{id:post.id},data:{deploymentEpoch:epoch,generation:{increment:1}}});
 if(!["preparing_video","scheduled","publishing","processing","reconciling"].includes(post.status))return [];
 return [await appendPublicationDispatch(tx,post.id,{wakeKind:"publication_restored"})];
}
