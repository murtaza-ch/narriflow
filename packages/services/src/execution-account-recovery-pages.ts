import { Prisma } from "@prisma/client";
import { assertExecutionRestorePage } from "./execution-restore-pages";
import { lockExecutionRecoveryParents as lockParents } from "./execution-recovery-locks";
import { recoverBillingReconciliation } from "./billing-reconciliation";
import { queueLibraryIndex, recoverLibraryIndex } from "./library-index";
import type { MaintenancePhaseHandler, MaintenancePosition } from "./execution-maintenance";
import type { ExecutionRestorePhaseHandler } from "./execution-restore";

const after = (point: MaintenancePosition | null, field: Prisma.Sql, id = Prisma.sql`id`) => point ? Prisma.sql`AND (${field},${id}) > ((${point.at}::timestamptz AT TIME ZONE 'UTC'),${point.id}::uuid)` : Prisma.empty;
export const recoverBillingPage: MaintenancePhaseHandler = async (tx, page) => {
  const rows = await tx.$queryRaw<Array<{ id: string; at: Date; workspaceId: string }>>`SELECT id,"nextReconcileAt" AS at,"workspaceId" FROM "WorkspaceBillingAccount"
    WHERE "reconciliationEpoch"=${page.deploymentEpoch} AND "reconciliationGeneration">0 AND "nextReconcileAt"<=(${page.cutoff}::timestamptz AT TIME ZONE 'UTC')
    ${after(page.after, Prisma.sql`"nextReconcileAt"`)} ORDER BY "nextReconcileAt",id LIMIT ${page.limit + 1}`;
  const selected = rows.slice(0,page.limit); await lockParents(tx,selected); const dispatchIds: string[] = [];
  for (const row of selected) { const ref = await recoverBillingReconciliation(tx,row.workspaceId); if (ref) dispatchIds.push(ref.dispatchId); }
  return { processed:selected.length, next:rows.length>page.limit ? selected.at(-1)! : null, dispatchIds };
};
export const recoverLibraryPage: MaintenancePhaseHandler = async (tx, page) => {
  const rows = await tx.$queryRaw<Array<{ id: string; at: Date; workspaceId: string; projectId: string }>>`SELECT t.id,t."passagesRetryAt" AS at,p."workspaceId",t."projectId" FROM "Transcript" t JOIN "Project" p ON p.id=t."projectId"
    WHERE t.status='completed' AND t."passagesEpoch"=${page.deploymentEpoch} AND t."passagesGeneration">0 AND t."passagesRetryAt"<=(${page.cutoff}::timestamptz AT TIME ZONE 'UTC')
    ${after(page.after,Prisma.sql`t."passagesRetryAt"`,Prisma.sql`t.id`)} ORDER BY t."passagesRetryAt",t.id LIMIT ${page.limit + 1}`;
  const selected=rows.slice(0,page.limit); await lockParents(tx,selected); const dispatchIds:string[]=[];
  for(const row of selected){const ref=await recoverLibraryIndex(tx,row.id);if(ref)dispatchIds.push(ref.dispatchId);}
  return {processed:selected.length,next:rows.length>page.limit?selected.at(-1)!:null,dispatchIds};
};
export const restoreBillingPage: ExecutionRestorePhaseHandler = async (tx,page) => {
  await assertExecutionRestorePage(tx,page);
  const rows=await tx.$queryRaw<Array<{id:string;at:Date;workspaceId:string}>>`SELECT id,"createdAt" AS at,"workspaceId" FROM "WorkspaceBillingAccount"
    WHERE "reconciliationEpoch"<${page.deploymentEpoch} AND "createdAt"<=(${page.cutoff}::timestamptz AT TIME ZONE 'UTC')
    ${after(page.after,Prisma.sql`"createdAt"`)} ORDER BY "createdAt",id LIMIT ${page.limit+1}`;
  const selected=rows.slice(0,page.limit);await lockParents(tx,selected);const dispatchIds:string[]=[];
  for(const row of selected){const ref=await recoverBillingReconciliation(tx,row.workspaceId,{deferDispatch:true});if(ref)dispatchIds.push(ref.dispatchId);}
  return {processed:selected.length,next:rows.length>page.limit?selected.at(-1)!:null,dispatchIds};
};
export const restoreLibraryPage: ExecutionRestorePhaseHandler = async(tx,page)=>{
  await assertExecutionRestorePage(tx,page);
  const rows=await tx.$queryRaw<Array<{id:string;at:Date;workspaceId:string;projectId:string}>>`SELECT t.id,t."createdAt" AS at,p."workspaceId",t."projectId" FROM "Transcript" t JOIN "Project" p ON p.id=t."projectId"
    WHERE t.status='completed' AND t."passagesEpoch"<${page.deploymentEpoch} AND t."passagesGeneration">0 AND t."passagesRetryAt" IS NOT NULL
      AND t."createdAt"<=(${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after(page.after,Prisma.sql`t."createdAt"`,Prisma.sql`t.id`)} ORDER BY t."createdAt",t.id LIMIT ${page.limit+1}`;
  const selected=rows.slice(0,page.limit);await lockParents(tx,selected);const dispatchIds:string[]=[];
  for(const row of selected){const ref=await queueLibraryIndex(tx,row.id,{deferDispatch:true});if(ref)dispatchIds.push(ref.dispatchId);}
  return {processed:selected.length,next:rows.length>page.limit?selected.at(-1)!:null,dispatchIds};
};
