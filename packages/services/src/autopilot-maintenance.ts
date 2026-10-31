import { Prisma } from "@prisma/client";
import type { MaintenancePage, MaintenancePhaseHandler } from "./execution-maintenance";
import type { ExecutionRestorePhaseHandler } from "./execution-restore";
import { assertExecutionRestorePage } from "./execution-restore-pages";
import { readExecutionAdmission } from "./execution-admission";
import { lockWorkspaceUsage } from "./processing-usage";
import { recoverAutopilotRule } from "./autopilot-execution";
import { recoverZoomNotification } from "./zoom-execution";
type Tx=Prisma.TransactionClient;
type Row={id:string;at:Date;workspaceId:string|null};
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const date=(value:Date)=>value instanceof Date&&Number.isSafeInteger(value.getTime())&&value.getTime()>=0;
async function validate(tx:Tx,page:MaintenancePage){
  if(!Number.isInteger(page.limit)||page.limit<1||page.limit>32||!date(page.cutoff)||page.after&&(!date(page.after.at)||page.after.at>page.cutoff||!uuid.test(page.after.id)||page.after.tie!==undefined))throw Error("autopilot_recovery_page_invalid");
  if((await readExecutionAdmission(tx)).epoch!==page.deploymentEpoch)throw Error("autopilot_recovery_epoch_superseded");
}
function after(page:MaintenancePage,alias:string){return page.after?Prisma.sql`AND (${Prisma.raw(alias)}."createdAt",${Prisma.raw(alias)}.id)>((${page.after.at}::timestamptz AT TIME ZONE 'UTC'),${page.after.id}::uuid)`:Prisma.empty;}
async function parents(tx:Tx,rows:Row[]){
  const ids=[...new Set(rows.flatMap(row=>row.workspaceId?[row.workspaceId]:[]))].sort();
  for(const id of ids)await lockWorkspaceUsage(tx,id);
  if(ids.length)await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR SHARE`;
}
function result(rows:Row[],limit:number,ids:string[]=[]){const dispatchIds=[...new Set(ids)];if(dispatchIds.length>127)throw Error("autopilot_recovery_dispatch_bound");return {processed:Math.min(rows.length,limit),next:rows.length>limit?{at:rows[limit-1]!.at,id:rows[limit-1]!.id}:null,dispatchIds};}
/** Current accepted rows include future timers; final restore reuses this same
 * createdAt cursor before admission reopens. At most4*31 identifiers escape. */
export const planAutopilotRecoveryPage:MaintenancePhaseHandler=async(tx,page)=>{
  await validate(tx,page);const limit=Math.min(31,page.limit);
  const rows=await tx.$queryRaw<Row[]>`SELECT r.id,r."createdAt" AS at,r."workspaceId" FROM "AutopilotRule" r WHERE r."deploymentEpoch"=${page.deploymentEpoch} AND r."sourceKind"='rss' AND r.status IN ('active','running') AND r."createdAt"<=(${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after(page,"r")} ORDER BY r."createdAt",r.id LIMIT ${limit+1}`;
  const selected=rows.slice(0,limit),ids:string[]=[];await parents(tx,selected);
  for(const row of selected)ids.push(...await recoverAutopilotRule(tx,row.id,`hourly_rss.${page.cutoff.getTime()}`));
  return result(rows,limit,ids);
};
export const planZoomNotificationRecoveryPage:MaintenancePhaseHandler=async(tx,page)=>{
  await validate(tx,page);const limit=page.limit;
  const rows=await tx.$queryRaw<Row[]>`SELECT j.id,j."createdAt" AS at,CASE WHEN j."executionTarget"->>'kind'='recording' THEN (j."executionTarget"#>>'{scope,workspaceId}')::uuid ELSE c."workspaceId" END AS "workspaceId"
    FROM "ZoomWebhookJob" j LEFT JOIN "ZoomConnection" c ON c.id=CASE WHEN j."executionTarget"->>'kind'='deauthorize' THEN (j."executionTarget"->>'connectionId')::uuid ELSE NULL END
    WHERE j."deploymentEpoch"=${page.deploymentEpoch} AND j.status IN ('queued','running') AND j."createdAt"<=(${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after(page,"j")} ORDER BY j."createdAt",j.id LIMIT ${limit+1}`;
  const selected=rows.slice(0,limit),ids:string[]=[];await parents(tx,selected);
  for(const row of selected)ids.push(...await recoverZoomNotification(tx,row.id,`hourly_zoom.${page.cutoff.getTime()}`));
  return result(rows,limit,ids);
};
/** Only short owners and execution metadata change. Frozen source intent,
 * original due/deadline, attempts and probes survive; no product IDs append. */
export const planAutopilotRestorePage:ExecutionRestorePhaseHandler=async(tx,page)=>{
  await validate(tx,page);await assertExecutionRestorePage(tx,page);
  const rows=await tx.$queryRaw<Row[]>`SELECT r.id,r."createdAt" AS at,r."workspaceId" FROM "AutopilotRule" r WHERE r."deploymentEpoch"<=${page.snapshotEpoch} AND r."createdAt"<=(${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after(page,"r")} ORDER BY r."createdAt",r.id LIMIT ${page.limit+1}`;
  const selected=rows.slice(0,page.limit);await parents(tx,selected);
  for(const item of [...selected].sort((a,b)=>a.id.localeCompare(b.id))){
    await tx.$queryRaw`SELECT id FROM "AutopilotRule" WHERE id=${item.id}::uuid FOR NO KEY UPDATE`;
    const row=await tx.autopilotRule.findUnique({where:{id:item.id}});
    if(!row||row.deploymentEpoch>page.snapshotEpoch)continue;
    await tx.autopilotRule.update({where:{id:row.id},data:{deploymentEpoch:page.deploymentEpoch,generation:{increment:1},claimToken:null,leaseExpiresAt:null,...(row.status==="running"&&!row.executionCycleId?{status:"active"}:{})}});
  }
  return result(rows,page.limit);
};
export const planZoomNotificationRestorePage:ExecutionRestorePhaseHandler=async(tx,page)=>{
  await validate(tx,page);await assertExecutionRestorePage(tx,page);
  const rows=await tx.$queryRaw<Row[]>`SELECT j.id,j."createdAt" AS at,CASE WHEN j."executionTarget"->>'kind'='recording' THEN (j."executionTarget"#>>'{scope,workspaceId}')::uuid ELSE c."workspaceId" END AS "workspaceId"
    FROM "ZoomWebhookJob" j LEFT JOIN "ZoomConnection" c ON c.id=CASE WHEN j."executionTarget"->>'kind'='deauthorize' THEN (j."executionTarget"->>'connectionId')::uuid ELSE NULL END
    WHERE j."deploymentEpoch"<=${page.snapshotEpoch} AND j.status IN ('queued','running') AND j."createdAt"<=(${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after(page,"j")} ORDER BY j."createdAt",j.id LIMIT ${page.limit+1}`;
  const selected=rows.slice(0,page.limit);await parents(tx,selected);
  for(const item of [...selected].sort((a,b)=>a.id.localeCompare(b.id))){
    await tx.$queryRaw`SELECT id FROM "ZoomWebhookJob" WHERE id=${item.id}::uuid FOR NO KEY UPDATE`;
    const row=await tx.zoomWebhookJob.findUnique({where:{id:item.id}});
    if(!row||row.deploymentEpoch>page.snapshotEpoch||!["queued","running"].includes(row.status))continue;
    await tx.zoomWebhookJob.update({where:{id:row.id},data:{deploymentEpoch:page.deploymentEpoch,generation:{increment:1},status:"queued",claimToken:null,leaseExpiresAt:null}});
  }
  return result(rows,page.limit);
};
