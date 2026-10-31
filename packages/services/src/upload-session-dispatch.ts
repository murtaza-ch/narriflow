import { createHash } from "node:crypto";
import type { Prisma,UploadSession } from "@prisma/client";
import { appendExecutionDispatch } from "./execution-dispatch";
import { readExecutionAdmission } from "./execution-admission";
import { collectExecutionDispatch } from "./execution-dispatch-runtime";
export function uploadSessionExecutionInputHash(row:Pick<UploadSession,"id"|"immutableInputFingerprint"|"storageKey"|"hardExpiresAt">,epoch:number){return createHash("sha256").update(JSON.stringify(["upload-session-execution-v1",row.id,row.immutableInputFingerprint,row.storageKey,row.hardExpiresAt.toISOString(),epoch])).digest("hex");}
export function uploadSessionNextDue(row:Pick<UploadSession,"status"|"reconciliationLeaseExpiresAt"|"admissionClaimExpiresAt"|"reconcileAt"|"cleanupRetryAt"|"expiresAt"|"hardExpiresAt">,now:Date){
 if(row.reconciliationLeaseExpiresAt&&row.reconciliationLeaseExpiresAt>now)return row.reconciliationLeaseExpiresAt;
 if(row.status==="initiating")return new Date(Math.max(row.admissionClaimExpiresAt?.getTime()??now.getTime(),row.reconcileAt?.getTime()??0));
 if(row.status==="uploading")return new Date(Math.min(row.expiresAt.getTime(),row.hardExpiresAt.getTime(),row.cleanupRetryAt?.getTime()??Infinity));
 return row.reconcileAt??now;
}
export async function appendUploadSessionDispatch(tx:Prisma.TransactionClient,row:UploadSession){
 if(!["initiating","uploading","finalizing","reconciling","compensating"].includes(row.status))return [];
 const {epoch}=await readExecutionAdmission(tx),inputHash=uploadSessionExecutionInputHash(row,epoch),identity={kind:"operation_driver" as const,subject:{kind:"upload_session" as const,id:row.id},generation:1,deploymentEpoch:epoch,inputHash};
 const base=await appendExecutionDispatch(tx,{...identity,dueAt:row.createdAt});
 const state=createHash("sha256").update(JSON.stringify([row.status,row.expiresAt.toISOString(),row.cleanupRetryAt?.toISOString(),row.reconcileAt?.toISOString(),row.admissionClaimExpiresAt?.toISOString(),row.reconciliationLeaseExpiresAt?.toISOString()])).digest("hex").slice(0,32);
 const wake=await appendExecutionDispatch(tx,{...identity,dueAt:new Date(0),wakeKind:`up_${state}`});
 for(const item of [base,wake])collectExecutionDispatch(tx,item.reference.dispatchId);return [base.reference.dispatchId,wake.reference.dispatchId];
}
