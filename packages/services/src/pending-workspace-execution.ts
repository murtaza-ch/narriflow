import { lockExecutionRecoveryParents } from "./execution-recovery-locks";
import { createHash } from "node:crypto";
import { Prisma,type PrismaClient } from "@prisma/client";
import { executionDispatchReferenceSchema,type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { readExecutionAdmission } from "./execution-admission";
import { appendExecutionDispatch,readExecutionDispatch } from "./execution-dispatch";
import { executeExecutionPage,readExecutionPageReceipt } from "./execution-page-receipt";
import type { MaintenancePhaseHandler } from "./execution-maintenance";
import { recoverBillingReconciliation } from "./billing-reconciliation";
const hash=(epoch:number,id:string)=>createHash("sha256").update(JSON.stringify(["pending-workspace-cleanup-v1",epoch,id])).digest("hex");
async function append(tx:Prisma.TransactionClient,epoch:number,id:string,cutoff:Date){const subject=`pw1.${id}.${cutoff.getTime()}`;return (await appendExecutionDispatch(tx,{kind:"maintenance",subject:{kind:"maintenance",id:subject},generation:1,deploymentEpoch:epoch,inputHash:hash(epoch,subject),dueAt:cutoff})).reference;}
export const planPendingWorkspaceExpiryPage:MaintenancePhaseHandler=async(tx,page)=>{
 const after=page.after?Prisma.sql`AND ("createdAt",id)>((${page.after.at}::timestamptz AT TIME ZONE 'UTC'),${page.after.id}::uuid)`:Prisma.empty;
 const rows=await tx.$queryRaw<Array<{id:string;at:Date}>>`SELECT id,"createdAt" AS at FROM "Workspace" WHERE status='pending_payment' AND "personalOwnerUserId" IS NULL AND "createdAt"<=(${new Date(page.cutoff.getTime()-2*86400000)}::timestamptz AT TIME ZONE 'UTC') AND "updatedAt"<=(${new Date(page.cutoff.getTime()-3600000)}::timestamptz AT TIME ZONE 'UTC') ${after} ORDER BY "createdAt",id LIMIT ${page.limit+1}`;
 const selected=rows.slice(0,page.limit),dispatchIds:string[]=[];await lockExecutionRecoveryParents(tx,selected.map(row=>({workspaceId:row.id})));for(const row of selected){const billing=await recoverBillingReconciliation(tx,row.id);if(billing)dispatchIds.push(billing.dispatchId);dispatchIds.push((await append(tx,page.deploymentEpoch,row.id,page.cutoff)).dispatchId);}return {processed:selected.length,next:rows.length>page.limit?selected.at(-1)!:null,dispatchIds};
};
export function createPendingWorkspaceExecution(options:{database:PrismaClient;register(ids:readonly string[]):Promise<void>;expire(id:string,epoch:number):Promise<boolean>}){return {async run(value:ExecutionDispatchReference):Promise<{kind:"complete"}>{
 const ref=executionDispatchReferenceSchema.parse(value),match=/^pw1\.([a-f0-9-]{36})\.(0|[1-9][0-9]{0,12})$/.exec(ref.subject.id);if(ref.kind!=="maintenance"||ref.subject.kind!=="maintenance"||ref.generation!==1||!match||hash(ref.deploymentEpoch,ref.subject.id)!==ref.inputHash)throw Error("pending_workspace_reference_invalid");
 const state=await options.database.$transaction(async tx=>{const epoch=await readExecutionAdmission(tx),ledger=await readExecutionDispatch(tx,ref.dispatchId);if(!ledger||JSON.stringify(ledger.reference)!==JSON.stringify(ref))throw Error("pending_workspace_reference_invalid");if(epoch.epoch!==ref.deploymentEpoch)return null;return {receipt:await readExecutionPageReceipt(tx,ref,"maintenance-page")};});if(!state)return {kind:"complete"};if(state.receipt){await options.register(state.receipt.dispatchIds);return {kind:"complete"};}
 await options.expire(match[1]!,ref.deploymentEpoch);
 const result=await options.database.$transaction(async tx=>{if((await readExecutionAdmission(tx)).epoch!==ref.deploymentEpoch)return {dispatchIds:[]};return executeExecutionPage(tx,ref,"maintenance-page",async()=>({kind:"complete",processed:1,dispatchIds:[]}));});await options.register(result.dispatchIds);return {kind:"complete"};
}};}
