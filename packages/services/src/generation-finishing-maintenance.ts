import { Prisma } from "@prisma/client";
import type { MaintenancePage, MaintenancePhaseHandler } from "./execution-maintenance";
import type { ExecutionRestorePhaseHandler } from "./execution-restore";
import { assertExecutionRestorePage } from "./execution-restore-pages";
import { readExecutionAdmission } from "./execution-admission";
import { appendExecutionDispatch } from "./execution-dispatch";
import { collectExecutionDispatch } from "./execution-dispatch-runtime";
import { queueGenerationFinishing } from "./generation-finishing";
import { lockWorkspaceUsage } from "./processing-usage";

type Tx = Prisma.TransactionClient;
type Row = { id: string; at: Date; workspaceId: string; projectId: string };
async function validate(tx: Tx, page: MaintenancePage) {
  if (!Number.isSafeInteger(page.limit) || page.limit<1 || page.limit>32 || !Number.isSafeInteger(page.cutoff.getTime()) || page.cutoff.getTime()<0 ||
    (page.after && (!Number.isSafeInteger(page.after.at.getTime()) || page.after.at>page.cutoff || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(page.after.id) || page.after.tie!==undefined)))throw Error("finishing_page_invalid");
  if((await readExecutionAdmission(tx)).epoch!==page.deploymentEpoch)throw Error("finishing_page_superseded");
}
function after(page: MaintenancePage) {
  return page.after ? Prisma.sql`AND ("createdAt",id) > ((${page.after.at}::timestamptz AT TIME ZONE 'UTC'),${page.after.id}::uuid)` : Prisma.empty;
}
async function lockRows(tx: Tx, rows: Row[]) {
  for(const id of [...new Set(rows.map(row=>row.workspaceId))].sort())await lockWorkspaceUsage(tx,id);
  const projects=[...new Set(rows.map(row=>row.projectId))].sort(), ids=rows.map(row=>row.id).sort();
  if(projects.length)await tx.$queryRaw`SELECT id FROM "Project" WHERE id=ANY(${projects}::uuid[]) ORDER BY id FOR UPDATE`;
  if(ids.length)await tx.$queryRaw`SELECT id FROM "GenerationFinishing" WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
}
function result(rows: Row[], limit: number, dispatchIds: string[]=[]) {
  return {processed:Math.min(rows.length,limit),next:rows.length>limit?{id:rows[limit-1]!.id,at:rows[limit-1]!.at}:null,dispatchIds};
}

/** Repairs only current obligations. A separate cutoff wake reaches a parked
 * Workflow even if its original scheduler registration was acknowledged. */
export const planFinishingRecoveryPage: MaintenancePhaseHandler = async(tx,page)=>{
  await validate(tx,page);
  const rows=await tx.$queryRaw<Row[]>`SELECT id,"createdAt" AS at,"workspaceId","projectId" FROM "GenerationFinishing"
    WHERE "deploymentEpoch"=${page.deploymentEpoch} AND state IN ('due','running','exporting')
    AND "createdAt"<=(${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after(page)} ORDER BY "createdAt",id LIMIT ${page.limit+1}`;
  const selected=rows.slice(0,page.limit), ids:string[]=[];await lockRows(tx,selected);
  for(const row of selected){
    const base=await queueGenerationFinishing(tx,row.id);if(!base)continue;
    const wake=await appendExecutionDispatch(tx,{...base,dueAt:page.cutoff,wakeKind:`finishing_safety_${page.cutoff.getTime()}`});
    collectExecutionDispatch(tx,wake.reference.dispatchId);ids.push(base.dispatchId,wake.reference.dispatchId);
  }
  return result(rows,page.limit,[...new Set(ids)]);
};

/** Metadata-only restore. Frozen settings, paid child identities and original
 * deadlines survive; no product dispatch is appended until final redispatch. */
export const planFinishingRestorePage: ExecutionRestorePhaseHandler = async(tx,page)=>{
  await assertExecutionRestorePage(tx,page);await validate(tx,page);
  const rows=await tx.$queryRaw<Row[]>`SELECT id,"createdAt" AS at,"workspaceId","projectId" FROM "GenerationFinishing"
    WHERE "deploymentEpoch"<=${page.snapshotEpoch} AND state IN ('waiting','due','running','exporting')
    AND "createdAt"<=(${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after(page)} ORDER BY "createdAt",id LIMIT ${page.limit+1}`;
  const selected=rows.slice(0,page.limit);await lockRows(tx,selected);
  for(const row of selected){
    const current=await tx.generationFinishing.findUnique({where:{id:row.id}});
    if(!current || current.deploymentEpoch>page.snapshotEpoch || !['waiting','due','running','exporting'].includes(current.state))continue;
    const abandoned=current.state==='running' && current.claimToken!==null;
    await tx.generationFinishing.update({where:{id:row.id},data:{deploymentEpoch:page.deploymentEpoch,
      generation:current.generation===0?0:{increment:1},state:current.state==='running'?'due':current.state,
      attempts:abandoned?{increment:1}:undefined,claimToken:null,leaseExpiresAt:null}});
  }
  return result(rows,page.limit);
};
