import { Prisma } from "@prisma/client";
import type { MaintenancePhaseHandler } from "./execution-maintenance";
import { admitMediaCleanupObligations } from "./media-cleanup-admission";
import { takeExecutionDispatchIds } from "./execution-dispatch-runtime";
/** Private validation/RSS result rows outlive every fixed native and Rule
 * deadline by at least thirty days. Live published assets retain their own keys. */
function expire(probe:boolean):MaintenancePhaseHandler{return async(tx,page)=>{
 const cutoff=new Date(page.cutoff.getTime()-30*86400000),table=Prisma.raw(probe?'"OutboundProbe"':'"NativeValidationJob"'),after=page.after?Prisma.sql`AND (d."createdAt",d.id)>((${page.after.at}::timestamp),${page.after.id}::uuid)`:Prisma.empty;
 const held=probe?Prisma.sql`AND NOT EXISTS(SELECT 1 FROM "AutopilotRule" r WHERE r."executionProbeId"=d.id AND r.status='running' AND r."operationDeadlineAt">clock_timestamp() AT TIME ZONE 'UTC')`:Prisma.empty;
 const rows=await tx.$queryRaw<Array<{id:string;at:Date}>>(Prisma.sql`SELECT d.id,d."createdAt" AS at FROM ${table} d WHERE d.status IN ('completed','failed','cancelled') AND d."createdAt"<=(${cutoff}::timestamp) ${held} ${after} ORDER BY d."createdAt",d.id LIMIT ${page.limit+1}`),selected=rows.slice(0,page.limit),ids=selected.map(row=>row.id);
 if(ids.length){const artifacts=await tx.executionArtifact.findMany({where:{attempt:{dispatch:{subjectKind:probe?"outbound_probe":"native_validation",subjectId:{in:ids}}}},select:{storageKey:true,grantExpiresAt:true,attempt:{select:{operationDeadlineAt:true}}}});await admitMediaCleanupObligations(tx,artifacts.map(row=>({origin:"assigned_execution_artifact",cleanupClass:"assigned_artifact",objectKey:row.storageKey,notBefore:new Date(Math.max(row.grantExpiresAt.getTime(),row.attempt.operationDeadlineAt.getTime())+120000)})));
 if(probe)await tx.outboundProbe.deleteMany({where:{id:{in:ids}}});else {const inputs=await tx.nativeValidationJob.findMany({where:{id:{in:ids}},select:{inputStorageKey:true,operationDeadlineAt:true}});await admitMediaCleanupObligations(tx,inputs.map(row=>({origin:"native_validation_input",cleanupClass:"upload_source",objectKey:row.inputStorageKey,notBefore:new Date(row.operationDeadlineAt.getTime()+120000)})));await tx.nativeValidationJob.deleteMany({where:{id:{in:ids}}});}}
 return {processed:selected.length,next:rows.length>page.limit?selected.at(-1)!:null,dispatchIds:takeExecutionDispatchIds(tx)};
};}
export const expireNativeValidationRowsPage=expire(false);
export const expireOutboundProbeRowsPage=expire(true);

/** Sealed provider keys and bodies survive every 23-hour delivery deadline
 * and a thirty-day replay window. Active mail is never a retention candidate. */
export const expireGrantNotificationRowsPage:MaintenancePhaseHandler=async(tx,page)=>{
 if(page.after?.tie||!Number.isSafeInteger(page.limit)||page.limit<1||page.limit>32)throw Error("maintenance_cursor_invalid");
 const cutoff=new Date(page.cutoff.getTime()-30*86400000),after=page.after?Prisma.sql`AND ("createdAt",id)>((${page.after.at}::timestamp),${page.after.id}::uuid)`:Prisma.empty;
 const rows=await tx.$queryRaw<Array<{id:string;at:Date}>>(Prisma.sql`SELECT id,"createdAt" AS at FROM "GrantPauseNotificationLedger" WHERE status IN ('sent','failed','skipped')
  AND "createdAt"<=(${cutoff}::timestamp) ${after} ORDER BY "createdAt",id LIMIT ${page.limit+1}`),selected=rows.slice(0,page.limit);
 if(selected.length)await tx.grantPauseNotificationLedger.deleteMany({where:{id:{in:selected.map(row=>row.id)},status:{in:["sent","failed","skipped"]},createdAt:{lte:cutoff}}});
 return {processed:selected.length,next:rows.length>page.limit?selected.at(-1)!:null,dispatchIds:[]};
};

export const expireWebhookNotificationRowsPage:MaintenancePhaseHandler=async(tx,page)=>{
 if(page.after?.tie||!Number.isSafeInteger(page.limit)||page.limit<1||page.limit>32)throw Error("maintenance_cursor_invalid");
 const cutoff=new Date(page.cutoff.getTime()-30*86400000),after=page.after?Prisma.sql`AND ("createdAt",id)>((${page.after.at}::timestamp),${page.after.id}::uuid)`:Prisma.empty;
 const rows=await tx.$queryRaw<Array<{id:string;at:Date}>>(Prisma.sql`SELECT id,"createdAt" AS at FROM "WebhookDisabledNotificationLedger" WHERE status IN ('sent','failed','skipped')
  AND "createdAt"<=(${cutoff}::timestamp) ${after} ORDER BY "createdAt",id LIMIT ${page.limit+1}`),selected=rows.slice(0,page.limit);
 if(selected.length)await tx.webhookDisabledNotificationLedger.deleteMany({where:{id:{in:selected.map(row=>row.id)},status:{in:["sent","failed","skipped"]},createdAt:{lte:cutoff}}});
 return {processed:selected.length,next:rows.length>page.limit?selected.at(-1)!:null,dispatchIds:[]};
};
