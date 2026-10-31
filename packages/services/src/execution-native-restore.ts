import { Prisma } from "@prisma/client";
import type { ExecutionRestorePage,ExecutionRestorePhaseHandler } from "./execution-restore";
import { assertExecutionRestorePage } from "./execution-restore-pages";
import { lockExecutionRecoveryParents } from "./execution-recovery-locks";
import { nativeValidationExecutionInputHash } from "./native-validation";
import { outboundProbeExecutionInputHash } from "./outbound-probe";
import { outboundDeliveryExecutionInputHash } from "./outbound-delivery";
type Row={id:string;at:Date;workspaceId:string;projectId?:string};
type Table="NativeValidationJob"|"OutboundProbe"|"OutboundDelivery"|"GeneratedMediaJob"|"ThumbnailFrameOperation";
async function candidates(tx:Prisma.TransactionClient,page:ExecutionRestorePage,table:Table,active:Prisma.Sql){
 await assertExecutionRestorePage(tx,page);
 const project=["GeneratedMediaJob","ThumbnailFrameOperation"].includes(table)?Prisma.sql`,d."projectId"`:Prisma.empty;
 const after=page.after?Prisma.sql`AND (d."createdAt",d.id)>((${page.after.at}::timestamptz AT TIME ZONE 'UTC'),${page.after.id}::uuid)`:Prisma.empty;
 return tx.$queryRaw<Row[]>(Prisma.sql`SELECT d.id,d."createdAt" AS at,d."workspaceId"${project} FROM ${Prisma.raw(`"${table}"`)} d
 WHERE d."deploymentEpoch"<=${page.snapshotEpoch} AND (${active}) AND d."createdAt"<=(${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after}
 ORDER BY d."createdAt",d.id LIMIT ${page.limit+1}`);
}
const outcome=(rows:Row[],page:ExecutionRestorePage)=>({processed:Math.min(rows.length,page.limit),next:rows.length>page.limit?rows[page.limit-1]!:null,dispatchIds:[]});
async function assertRevoked(tx:Prisma.TransactionClient,id:string,kind:string){if(await tx.executionAttempt.findFirst({where:{status:{in:["admitted","running"]},dispatch:{subjectKind:kind,subjectId:id}},select:{attemptToken:true}}))throw Error("restore_native_permission_not_revoked");}
function restore(table:Table,kind:string,active:Prisma.Sql,apply:(tx:Prisma.TransactionClient,id:string,page:ExecutionRestorePage)=>Promise<unknown>):ExecutionRestorePhaseHandler{return async(tx,page)=>{
 const rows=await candidates(tx,page,table,active),selected=rows.slice(0,page.limit);await lockExecutionRecoveryParents(tx,selected);
 for(const row of [...selected].sort((a,b)=>a.id.localeCompare(b.id))){await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id=${row.id}::uuid FOR UPDATE`);await assertRevoked(tx,row.id,kind);await apply(tx,row.id,page);}return outcome(rows,page);
};}
// Partial binary/evidence pointers belong to the old owner, not to the
// restored job. Committed artifacts and starts remain immutable history.
export const restoreNativeValidationPage=restore("NativeValidationJob","native_validation",Prisma.sql`status IN ('queued','processing')`,async(tx,id,page)=>{const row=await tx.nativeValidationJob.findUniqueOrThrow({where:{id}});return tx.nativeValidationJob.update({where:{id},data:{deploymentEpoch:page.deploymentEpoch,generation:{increment:1},inputHash:nativeValidationExecutionInputHash({...row,deploymentEpoch:page.deploymentEpoch}),status:"queued",attemptToken:null,executorOwner:null,leaseExpiresAt:null,result:Prisma.DbNull}});});
export const restoreOutboundProbePage=restore("OutboundProbe","outbound_probe",Prisma.sql`status IN ('queued','processing')`,async(tx,id,page)=>{const row=await tx.outboundProbe.findUniqueOrThrow({where:{id}});return tx.outboundProbe.update({where:{id},data:{deploymentEpoch:page.deploymentEpoch,generation:{increment:1},inputHash:outboundProbeExecutionInputHash({...row,deploymentEpoch:page.deploymentEpoch}),status:"queued",attemptToken:null,executorOwner:null,leaseExpiresAt:null}});});
export const restoreOutboundDeliveryPage=restore("OutboundDelivery","outbound_delivery",Prisma.sql`status IN ('preparing','queued','processing')`,async(tx,id,page)=>{const row=await tx.outboundDelivery.findUniqueOrThrow({where:{id}});return tx.outboundDelivery.update({where:{id},data:{deploymentEpoch:page.deploymentEpoch,generation:{increment:1},inputHash:outboundDeliveryExecutionInputHash({...row,deploymentEpoch:page.deploymentEpoch}),status:row.bodyEtag?"queued":"preparing",attemptToken:null,executorOwner:null,leaseExpiresAt:null}});});
export const restoreThumbnailPage=restore("ThumbnailFrameOperation","thumbnail_frame",Prisma.sql`status IN ('queued','processing')`,async(tx,id,page)=>tx.thumbnailFrameOperation.update({where:{id},data:{deploymentEpoch:page.deploymentEpoch,generation:{increment:1},status:"queued",claimId:null,executorOwner:null,claimExpiresAt:null,validationState:Prisma.DbNull}}));
export const restoreGeneratedMediaPage=restore("GeneratedMediaJob","generated_media",Prisma.sql`status IN ('queued','running','waiting')`,async(tx,id,page)=>{
 const row=await tx.generatedMediaJob.findUniqueOrThrow({where:{id}}),attempt=row.claimId?await tx.executionAttempt.findUnique({where:{attemptToken:row.claimId},select:{processStartedAt:true}}):null;
 const unknown=row.outcomeUnknown || (row.executionMode==="generate" && Boolean(attempt?.processStartedAt));
 const result=row.resultState&&typeof row.resultState==="object"&&!Array.isArray(row.resultState)?{...row.resultState}:null;if(result)delete result.inputPlan;
 return tx.generatedMediaJob.update({where:{id},data:{deploymentEpoch:page.deploymentEpoch,generation:{increment:1},status:unknown?"waiting":"queued",outcomeUnknown:unknown,claimId:unknown?row.claimId:null,executorOwner:null,claimExpiresAt:null,resultState:result as Prisma.InputJsonValue??Prisma.DbNull,...(unknown?{retryAt:null,errorCode:row.errorCode??"generated_media_restored_outcome_unknown"}:{})}});
});
