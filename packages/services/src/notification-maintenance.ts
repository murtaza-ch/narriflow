import {Prisma} from "@prisma/client";
import type {MaintenancePage,MaintenancePhaseHandler} from "./execution-maintenance";
import type {ExecutionRestorePhaseHandler} from "./execution-restore";
import {assertExecutionRestorePage} from "./execution-restore-pages";
import {readExecutionAdmission} from "./execution-admission";
import {appendExecutionDispatch} from "./execution-dispatch";
import {collectExecutionDispatch} from "./execution-dispatch-runtime";
import {lockWorkspaceUsage} from "./processing-usage";
import {appendNotificationDelivery,type NotificationTarget} from "./notification-execution";
type Tx=Prisma.TransactionClient;
type Row={id:string;at:Date;projectId:string|null;workspaceId:string;reviewRoundId?:string;grantId?:string};
async function validate(tx:Tx,page:MaintenancePage){
 if(!Number.isSafeInteger(page.limit)||page.limit<1||page.limit>32||!Number.isSafeInteger(page.cutoff.getTime())||page.cutoff.getTime()<0||
  page.after&&(!Number.isSafeInteger(page.after.at.getTime())||page.after.at>page.cutoff||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(page.after.id)||page.after.tie!==undefined))throw Error('notification_page_invalid');
 if((await readExecutionAdmission(tx)).epoch!==page.deploymentEpoch)throw Error('notification_page_superseded');
}
async function rows(tx:Tx,kind:NotificationTarget['kind'],page:MaintenancePage,restore:boolean){
 const table=kind==='project'?Prisma.sql`"NotificationLedger"`:kind==='review'?Prisma.sql`"ReviewNotificationLedger"`:Prisma.sql`"GrantPauseNotificationLedger"`;
 const join=kind==='project'?Prisma.sql`JOIN "Project" p ON p.id=n."projectId"`:kind==='review'?Prisma.sql`JOIN "ReviewRound" r ON r.id=n."reviewRoundId" JOIN "Project" p ON p.id=r."projectId"`:Prisma.empty;
 const round=kind==='review'?Prisma.sql`,n."reviewRoundId"`:kind==='grant'?Prisma.sql`,n."grantId"`:Prisma.empty;
 const parents=kind==='grant'?Prisma.sql`NULL::uuid AS "projectId",n."workspaceId"`:Prisma.sql`p.id AS "projectId",p."workspaceId"`;
 const epoch=restore?Prisma.sql`n."deploymentEpoch"<${page.deploymentEpoch}`:Prisma.sql`n."deploymentEpoch"=${page.deploymentEpoch}`;
 const after=page.after?Prisma.sql`AND (n."createdAt",n.id)>((${page.after.at}::timestamptz AT TIME ZONE 'UTC'),${page.after.id}::uuid)`:Prisma.empty;
 return tx.$queryRaw<Row[]>`SELECT n.id,n."createdAt" AS at,${parents} ${round} FROM ${table} n ${join}
  WHERE ${epoch} AND n.status IN ('pending','claimed') AND n."createdAt"<=(${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after}
  ORDER BY n."createdAt",n.id LIMIT ${page.limit+1}`;
}
async function lockRows(tx:Tx,kind:NotificationTarget['kind'],selected:Row[]){
 for(const id of [...new Set(selected.map(row=>row.workspaceId))].sort())await lockWorkspaceUsage(tx,id);
 const projects=[...new Set(selected.flatMap(row=>row.projectId?[row.projectId]:[]))].sort(),rounds=[...new Set(selected.flatMap(row=>row.reviewRoundId?[row.reviewRoundId]:[]))].sort(),ids=selected.map(row=>row.id).sort();
 const workspaces=[...new Set(selected.map(row=>row.workspaceId))].sort();
 if(kind==='grant'&&workspaces.length)await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=ANY(${workspaces}::uuid[]) ORDER BY id FOR SHARE`;
 const grants=[...new Set(selected.flatMap(row=>row.grantId?[row.grantId]:[]))].sort();
 if(grants.length)await tx.$queryRaw`SELECT id FROM "StandingGrant" WHERE id=ANY(${grants}::uuid[]) ORDER BY id FOR SHARE`;
 if(projects.length)await tx.$queryRaw`SELECT id FROM "Project" WHERE id=ANY(${projects}::uuid[]) ORDER BY id FOR UPDATE`;
 if(rounds.length)await tx.$queryRaw`SELECT id FROM "ReviewRound" WHERE id=ANY(${rounds}::uuid[]) ORDER BY id FOR UPDATE`;
 if(ids.length){if(kind==='project')await tx.$queryRaw`SELECT id FROM "NotificationLedger" WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;else if(kind==='review') await tx.$queryRaw`SELECT id FROM "ReviewNotificationLedger" WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;else await tx.$queryRaw`SELECT id FROM "GrantPauseNotificationLedger" WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;}
}
function result(all:Row[],page:MaintenancePage,dispatchIds:string[]=[]){return{processed:Math.min(all.length,page.limit),next:all.length>page.limit?{at:all[page.limit-1]!.at,id:all[page.limit-1]!.id}:null,dispatchIds};}
function recovery(kind:NotificationTarget['kind']):MaintenancePhaseHandler{return async(tx,page)=>{
 await validate(tx,page);const all=await rows(tx,kind,page,false),selected=all.slice(0,page.limit),ids:string[]=[];await lockRows(tx,kind,selected);
 for(const row of selected){
  const current=kind==='project'?await tx.notificationLedger.findUnique({where:{id:row.id}}):kind==='review'?await tx.reviewNotificationLedger.findUnique({where:{id:row.id}}):await tx.grantPauseNotificationLedger.findUnique({where:{id:row.id}});
  if(!current||current.deploymentEpoch!==page.deploymentEpoch||!['pending','claimed'].includes(current.status))continue;
  const base=await appendNotificationDelivery(tx,{kind,id:row.id});
  const wake=await appendExecutionDispatch(tx,{...base,dueAt:page.cutoff,wakeKind:`notification_safety_${page.cutoff.getTime()}`});collectExecutionDispatch(tx,wake.reference.dispatchId);ids.push(base.dispatchId,wake.reference.dispatchId);
 }
 return result(all,page,ids);
};}
function restore(kind:NotificationTarget['kind']):ExecutionRestorePhaseHandler{return async(tx,page)=>{
 await assertExecutionRestorePage(tx,page);await validate(tx,page);const all=await rows(tx,kind,page,true),selected=all.slice(0,page.limit);await lockRows(tx,kind,selected);
 for(const row of selected){
  const current=kind==='project'?await tx.notificationLedger.findUnique({where:{id:row.id}}):kind==='review'?await tx.reviewNotificationLedger.findUnique({where:{id:row.id}}):await tx.grantPauseNotificationLedger.findUnique({where:{id:row.id}});
  if(!current||current.deploymentEpoch>=page.deploymentEpoch||!['pending','claimed'].includes(current.status))continue;
  const data={deploymentEpoch:page.deploymentEpoch,generation:current.generation+1,status:'pending',claimToken:null,leaseExpiresAt:null,submissionStartedAt:null,
   attemptCount:current.attemptCount+(current.status==='claimed'&&!current.submissionStartedAt?1:0)};
  if(kind==='project')await tx.notificationLedger.update({where:{id:row.id},data});else if(kind==='review') await tx.reviewNotificationLedger.update({where:{id:row.id},data});else await tx.grantPauseNotificationLedger.update({where:{id:row.id},data});
 }
 return result(all,page);
};}
export const planProjectNotificationRecoveryPage=recovery('project');
export const planReviewNotificationRecoveryPage=recovery('review');
export const planProjectNotificationRestorePage=restore('project');
export const planReviewNotificationRestorePage=restore('review');

export const planGrantNotificationRecoveryPage=recovery('grant');
export const planGrantNotificationRestorePage=restore('grant');
