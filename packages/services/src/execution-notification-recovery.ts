import { Prisma } from "@prisma/client";
import type { MaintenancePhaseHandler } from "./execution-maintenance";
import type { ExecutionRestorePage,ExecutionRestorePhaseHandler } from "./execution-restore";
import { assertExecutionRestorePage } from "./execution-restore-pages";
import { readExecutionAdmission } from "./execution-admission";
import { lockExecutionRecoveryParents } from "./execution-recovery-locks";
import { appendCompletionCallbackDispatch,appendWebhookSubscriptionDispatch } from "./notification-dispatch";
type Kind="callback"|"subscription";
function rows(tx:Prisma.TransactionClient,page:Pick<ExecutionRestorePage,"cutoff"|"after"|"limit">,kind:Kind){
 const table=Prisma.raw(kind==="callback"?'"CompletionCallback"':'"WebhookSubscription"'),active=kind==="callback"?Prisma.sql`state IN ('waiting','pending')`:Prisma.sql`status='active'`,after=page.after?Prisma.sql`AND ("createdAt",id)>((${page.after.at}::timestamp),${page.after.id}::uuid)`:Prisma.empty;
 return tx.$queryRaw<Array<{id:string;at:Date;workspaceId:string}>>(Prisma.sql`SELECT id,"createdAt" AS at,"workspaceId" FROM ${table} WHERE ${active} AND "createdAt"<=(${page.cutoff}::timestamp) ${after} ORDER BY "createdAt",id LIMIT ${page.limit+1}`);
}
function rebind(kind:Kind):ExecutionRestorePhaseHandler{return async(tx,page)=>{
 await assertExecutionRestorePage(tx,page);const found=await rows(tx,page,kind),selected=found.slice(0,page.limit);await lockExecutionRecoveryParents(tx,selected);
 const ids=selected.map(row=>row.id);if(kind==="callback")await tx.completionCallback.updateMany({where:{id:{in:ids},state:{in:["waiting","pending"]}},data:{leaseOwner:null,leaseExpiresAt:null}});else await tx.webhookSubscription.updateMany({where:{id:{in:ids},status:"active"},data:{leaseOwner:null,leaseExpiresAt:null}});
 return {processed:selected.length,next:found.length>page.limit?selected.at(-1)!:null,dispatchIds:[]};
};}
function recover(kind:Kind):MaintenancePhaseHandler{return async(tx,page)=>{
 const epoch=await readExecutionAdmission(tx);if(epoch.epoch!==page.deploymentEpoch)throw Error("notification_recovery_epoch_changed");
 const found=await rows(tx,page,kind),selected=found.slice(0,page.limit);await lockExecutionRecoveryParents(tx,selected);const dispatchIds:string[]=[];
 for(const row of selected){if(kind==="callback"){const item=await tx.completionCallback.findUniqueOrThrow({where:{id:row.id}});if(["waiting","pending"].includes(item.state))dispatchIds.push(await appendCompletionCallbackDispatch(tx,item,`hourly_${page.cutoff.getTime()}`));}else{const item=await tx.webhookSubscription.findUniqueOrThrow({where:{id:row.id}});if(item.status==="active")dispatchIds.push(await appendWebhookSubscriptionDispatch(tx,item,`hourly_${page.cutoff.getTime()}`));}}
 return {processed:selected.length,next:found.length>page.limit?selected.at(-1)!:null,dispatchIds};
};}
export const restoreCallbacksPage=rebind("callback");
export const restoreWebhookSubscriptionsPage=rebind("subscription");
export const recoverCallbacksPage=recover("callback");
export const recoverWebhookSubscriptionsPage=recover("subscription");
