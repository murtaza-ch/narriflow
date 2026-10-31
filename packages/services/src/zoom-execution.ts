import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type ZoomWebhookJob } from "@prisma/client";
import { workspaceAllowsCapability, zoomNotificationSchema, type ZoomRecordingNotification, type ZoomNotification } from "@narriflow/validators";
import { zoomExecutionTargetSchema, zoomRecordingTargetSchema, type ZoomRecordingTarget } from "@narriflow/validators/autopilot-execution";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { ExecutionDispatchError, ExecutionDispatchPendingError, appendExecutionDispatch, executionDispatchIdentity, readExecutionDispatch } from "./execution-dispatch";
import { collectExecutionDispatch } from "./execution-dispatch-runtime";
import { readExecutionAdmission } from "./execution-admission";
import { operationFingerprint } from "./operation-receipt";
import { lockWorkspaceUsage } from "./processing-usage";
import { lockAutopilotImportPlan } from "./autopilot-finishing-authority";
import { autopilotPlanPauseReason } from "./autopilot-plan";
import { ruleFingerprint } from "./standing-grant";
type Tx = Prisma.TransactionClient;
const clock = async (tx:Tx)=>(await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`)[0]!.now;
export const ZOOM_NOTIFICATION_DEADLINE_MS = 30*86400_000;
export function zoomNotificationInputHash(row:ZoomWebhookJob) {
  return operationFingerprint(["zoom-notification-v1",row.id,row.eventKey,row.payload,row.deploymentEpoch,row.generation,row.ruleCursor,row.executionTarget,row.availableAt.toISOString(),row.operationDeadlineAt?.toISOString()]);
}
async function appendZoom(tx:Tx,row:ZoomWebhookJob,deadline?:{kind:"lease"|"operation";at:Date}) {
  const identity = {kind:"operation_driver" as const,subject:{kind:"zoom_notification" as const,id:row.id},deploymentEpoch:row.deploymentEpoch,generation:row.generation,...(deadline?{deadlineKind:deadline.kind,observedDeadlineAt:deadline.at}:{})};
  const known = await tx.executionDispatch.findUnique({where:{deliveryKey:(await executionDispatchIdentity(identity)).deliveryKey},select:{dueAt:true}});
  const record = await appendExecutionDispatch(tx,{...identity,inputHash:zoomNotificationInputHash(row),dueAt:known?.dueAt??deadline?.at??row.availableAt});
  collectExecutionDispatch(tx,record.reference.dispatchId);
  return record.reference;
}
async function repair(tx:Tx,row:ZoomWebhookJob):Promise<string[]> {
  if(row.deploymentEpoch!==(await readExecutionAdmission(tx)).epoch||!["queued","running"].includes(row.status))return [];
  const ids=[(await appendZoom(tx,row)).dispatchId];
  if(row.operationDeadlineAt)ids.push((await appendZoom(tx,row,{kind:"operation",at:row.operationDeadlineAt})).dispatchId);
  if(row.claimToken&&row.leaseExpiresAt)ids.push((await appendZoom(tx,row,{kind:"lease",at:row.leaseExpiresAt})).dispatchId);
  return ids;
}
export async function queueZoomNotification(tx:Tx,id:string) {
  const {epoch}=await readExecutionAdmission(tx),row=await tx.zoomWebhookJob.findUnique({where:{id}});
  if(!row||row.deploymentEpoch!==epoch||!["queued","running"].includes(row.status))return null;
  return appendZoom(tx,row);
}
async function lockRuleParents(tx:Tx,id:string) {
  const initial=await tx.autopilotRule.findUnique({where:{id},include:{zoomConnection:true}});
  if(!initial)return null;
  const users=[...new Set([initial.createdByUserId,initial.zoomConnection?.userId].filter((id):id is string=>!!id))].sort();
  for(const user of users)await tx.$queryRaw`SELECT id FROM "User" WHERE id=${user}::uuid FOR SHARE`;
  for(const user of users)await tx.$queryRaw`SELECT id FROM "WorkspaceMember" WHERE "workspaceId"=${initial.workspaceId}::uuid AND "userId"=${user}::uuid FOR SHARE`;
  await lockWorkspaceUsage(tx,initial.workspaceId);
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${initial.workspaceId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "Recipe" WHERE id=${initial.recipeId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "AutopilotRule" WHERE id=${id}::uuid FOR NO KEY UPDATE`;
  if(initial.zoomConnectionId)await tx.$queryRaw`SELECT id FROM "ZoomConnection" WHERE id=${initial.zoomConnectionId}::uuid FOR SHARE`;
  return tx.autopilotRule.findUnique({where:{id},include:{zoomConnection:true}});
}
async function actorAllowed(tx:Tx,workspaceId:string,userId:string|null) {
  if(!userId)return false;
  const member=await tx.workspaceMember.findUnique({where:{workspaceId_userId:{workspaceId,userId}},include:{user:{select:{deletedAt:true}},workspace:{select:{status:true}}}});
  return !!member&&!member.user.deletedAt&&workspaceAllowsCapability({role:member.role,status:member.workspace.status},"processing.consume");
}
async function currentJob(tx:Tx,reference:ExecutionDispatchReference) {
  await tx.$queryRaw`SELECT id FROM "ZoomWebhookJob" WHERE id=${reference.subject.id}::uuid FOR NO KEY UPDATE`;
  const row=await tx.zoomWebhookJob.findUnique({where:{id:reference.subject.id}});
  return row&&row.deploymentEpoch===reference.deploymentEpoch&&row.generation===reference.generation&&zoomNotificationInputHash(row)===reference.inputHash&&["queued","running"].includes(row.status)?row:null;
}
export type ZoomExecutionResult = {kind:"complete"|"superseded"}|{kind:"sleep"|"wait";dueAt:Date};
export interface ZoomNotificationExecutionDependencies {
  database:PrismaClient;
  register(ids:readonly string[]):Promise<void>;
  importRecording(input:{notification:ZoomRecordingNotification;target:ZoomRecordingTarget;reference:ExecutionDispatchReference;claimToken:string}):Promise<{count:number;refusal?:"deferred"|"too_long"|"brand_profile"}>;
  revokeConnection(id:string,before:Date):Promise<void>;
}
type Deauthorization=Extract<ZoomNotification,{event:"app_deauthorized"}>;
type Prepared={result:ZoomExecutionResult;ids:string[]}|{action:"recording";row:ZoomWebhookJob;target:ZoomRecordingTarget;notification:ZoomRecordingNotification;claimToken:string;ids:string[]}|{action:"deauthorize";row:ZoomWebhookJob;connectionId:string;notification:Deauthorization;claimToken:string;ids:string[]};
export class ZoomNotificationExecution {
  constructor(private readonly deps:ZoomNotificationExecutionDependencies){}
  async run(value:ExecutionDispatchReference):Promise<ZoomExecutionResult>{
    const reference=executionDispatchReferenceSchema.parse(value);
    const prepared=await this.deps.database.$transaction<Prepared>(async tx=>{
      const admission=await readExecutionAdmission(tx),record=await readExecutionDispatch(tx,reference.dispatchId);
      if(reference.kind!=="operation_driver"||reference.subject.kind!=="zoom_notification"||reference.deploymentEpoch!==admission.epoch||!record||JSON.stringify(record.reference)!==JSON.stringify(reference))return {result:{kind:"superseded"},ids:[]};
      const initial=await tx.zoomWebhookJob.findUnique({where:{id:reference.subject.id}});
      if(!initial)return {result:{kind:"superseded"},ids:[]};
      if(initial.deploymentEpoch!==admission.epoch||initial.generation!==reference.generation||zoomNotificationInputHash(initial)!==reference.inputHash||!["queued","running"].includes(initial.status))return {result:{kind:"superseded"},ids:await repair(tx,initial)};
      let now=await clock(tx);
      if(record.observedDeadlineAt&&record.observedDeadlineAt>now)return {result:{kind:"sleep",dueAt:record.observedDeadlineAt},ids:[]};
      if(initial.operationDeadlineAt&&initial.operationDeadlineAt<=now){
        const expired=await currentJob(tx,reference);
        if(!expired)return {result:{kind:"superseded"},ids:[]};
        await tx.zoomWebhookJob.update({where:{id:expired.id},data:{status:"failed",generation:{increment:1},completedAt:now,lastError:"zoom_notification_deadline",claimToken:null,leaseExpiresAt:null}});
        return {result:{kind:"complete"},ids:[]};
      }
      if(initial.availableAt>now)return {result:{kind:"sleep",dueAt:initial.availableAt},ids:[]};
      const notification=zoomNotificationSchema.parse(initial.payload);
      if(notification.event==="app_deauthorized")return this.prepareDeauthorization(tx,reference,notification,now);
      const target=initial.executionTarget===null?null:zoomExecutionTargetSchema.parse(initial.executionTarget);
      if(target&&target.kind!=="recording")throw Error("zoom_notification_target_invalid");
      const candidate=target?{id:target.plan.source.ruleId}:await tx.autopilotRule.findFirst({where:{sourceKind:"zoom",status:{in:["active","paused"]},createdAt:{lte:new Date(Math.min(initial.createdAt.getTime(),notification.eventTs))},...(initial.ruleCursor?{id:{gt:initial.ruleCursor}}:{}),zoomConnection:{zoomAccountId:notification.accountId,zoomUserId:notification.hostId,revokedAt:null},workspace:{status:"active"}},orderBy:{id:"asc"},select:{id:true}});
      const rule=candidate?await lockRuleParents(tx,candidate.id):null;
      const row=await currentJob(tx,reference);
      if(!row)return {result:{kind:"superseded"},ids:[]};
      now=await clock(tx);
      if(!row.operationDeadlineAt)throw Error("zoom_notification_deadline_missing");
      if(row.operationDeadlineAt<=now){await tx.zoomWebhookJob.update({where:{id:row.id},data:{status:"failed",generation:{increment:1},completedAt:now,lastError:"zoom_notification_deadline",claimToken:null,leaseExpiresAt:null}});return {result:{kind:"complete"},ids:[]};}
      if(!candidate){await tx.zoomWebhookJob.update({where:{id:row.id},data:{status:"completed",generation:{increment:1},completedAt:now,claimToken:null,leaseExpiresAt:null,lastError:null}});return {result:{kind:"complete"},ids:[]};}
      const skip=()=>this.advance(tx,row,candidate.id,true);
      if(!rule||rule.sourceKind!=="zoom")return {result:{kind:"complete"},ids:await skip()};
      if(!rule.zoomConnection||rule.zoomConnection.revokedAt||rule.zoomConnection.refreshOutcomeUnknown||!rule.zoomConnection.accessTokenEncrypted||!rule.zoomConnection.refreshTokenEncrypted){await tx.autopilotRule.update({where:{id:rule.id},data:{status:"paused",pauseKind:"zoom_connection",lastError:"Zoom access is unavailable. Reconnect Zoom, then resume this rule."}});return {result:{kind:"complete"},ids:await skip()};}
      if(rule.zoomConnection.zoomAccountId!==notification.accountId||rule.zoomConnection.zoomUserId!==notification.hostId||rule.zoomTopicFilter&&!notification.topic.toLocaleLowerCase().includes(rule.zoomTopicFilter.toLocaleLowerCase()))return {result:{kind:"complete"},ids:await skip()};
      if(target&&(rule.workspaceId!==target.scope.workspaceId||rule.createdByUserId!==target.scope.actorUserId||rule.zoomConnectionId!==target.connectionId||rule.zoomConnection.userId!==target.connectionUserId||await ruleFingerprint(tx,rule.id)!==target.plan.source.sourceRuleFingerprint))return {result:{kind:"complete"},ids:await skip()};
      if(rule.status!=="active"&&!(rule.status==="paused"&&["brand_profile","acting_member"].includes(rule.pauseKind??"")))return {result:{kind:"complete"},ids:await skip()};
      const planReason=rule.status==="active"?await autopilotPlanPauseReason(tx,rule):null;
      if(planReason){await tx.autopilotRule.update({where:{id:rule.id},data:{status:"paused",pauseKind:"plan",lastError:planReason}});return {result:{kind:"complete"},ids:await skip()};}
      if(!target){
        if(!rule.createdByUserId)return {result:{kind:"complete"},ids:await skip()};
        const plan=await lockAutopilotImportPlan(tx,rule,{allowPaused:true});
        const frozen=zoomRecordingTargetSchema.parse({kind:"recording",plan,scope:{workspaceId:rule.workspaceId,actorUserId:rule.createdByUserId},connectionId:rule.zoomConnection.id,connectionUserId:rule.zoomConnection.userId,titlePrefix:rule.titlePrefix});
        if(new TextEncoder().encode(JSON.stringify(frozen)).byteLength>65536)throw Error("zoom_notification_target_too_large");
        const next=await tx.zoomWebhookJob.update({where:{id:row.id},data:{generation:{increment:1},executionTarget:frozen as unknown as Prisma.InputJsonValue,claimToken:null,leaseExpiresAt:null}});
        return {result:{kind:"complete"},ids:await repair(tx,next)};
      }
      if(rule.status==="paused")return {result:{kind:"wait",dueAt:row.operationDeadlineAt},ids:await repair(tx,row)};
      if(!await actorAllowed(tx,rule.workspaceId,rule.createdByUserId)){await tx.autopilotRule.update({where:{id:rule.id},data:{status:"paused",pauseKind:"acting_member",lastError:"Its acting member can no longer process videos. A Workspace Owner or Admin can take over."}});return {result:{kind:"wait",dueAt:row.operationDeadlineAt},ids:await repair(tx,row)};}
      if(!await actorAllowed(tx,rule.workspaceId,rule.zoomConnection.userId)){await tx.autopilotRule.update({where:{id:rule.id},data:{status:"paused",pauseKind:"zoom_connection",lastError:"Zoom access is unavailable. Reconnect Zoom, then resume this rule."}});return {result:{kind:"complete"},ids:await skip()};}
      if(row.claimToken&&row.leaseExpiresAt){
        if(row.leaseExpiresAt>now)return {result:{kind:"wait",dueAt:row.leaseExpiresAt},ids:await repair(tx,row)};
        const next=await tx.zoomWebhookJob.update({where:{id:row.id},data:{generation:{increment:1},claimToken:null,leaseExpiresAt:null}});
        return {result:{kind:"complete"},ids:await repair(tx,next)};
      }
      const claimToken=randomUUID(),leaseExpiresAt=new Date(Math.min(now.getTime()+120_000,row.operationDeadlineAt.getTime()));
      const claimed=await tx.zoomWebhookJob.update({where:{id:row.id},data:{status:"running",claimToken,leaseExpiresAt,attempts:{increment:1}}});
      return {action:"recording",row:claimed,target,notification,claimToken,ids:await repair(tx,claimed)};
    });
    if(prepared.ids.length)await this.deps.register(prepared.ids);
    if("result" in prepared)return prepared.result;
    if(prepared.action==="deauthorize")return this.runDeauthorization(reference,prepared);
    try{
      const admitted=await this.deps.importRecording({notification:prepared.notification,target:prepared.target,reference,claimToken:prepared.claimToken});
      const ids=await this.deps.database.$transaction(async tx=>{
        const row=await this.owned(tx,reference,prepared.claimToken,prepared.target);
        if(!row)return null;
        if(admitted.refusal==="deferred")return this.defer(tx,row,"zoom_intake_deferred");
        if(admitted.refusal==="brand_profile"){
          await tx.autopilotRule.update({where:{id:prepared.target.plan.source.ruleId},data:{status:"paused",pauseKind:"brand_profile",lastError:"The Recipe's Brand Profile cannot be applied. Fix the Brand Kit or Recipe, then resume this rule."}});
          return this.defer(tx,row,"zoom_brand_profile_unavailable");
        }
        await tx.autopilotRule.update({where:{id:prepared.target.plan.source.ruleId},data:{lastCheckedAt:await clock(tx),lastSuccessAt:await clock(tx),lastError:null,consecutiveFailures:0}});
        return this.advance(tx,row,prepared.target.plan.source.ruleId,admitted.refusal==="too_long");
      });
      if(ids===null)return {kind:"superseded"};
      await this.deps.register(ids);
      return {kind:"complete"};
    }catch(error){
      if(error instanceof ExecutionDispatchError){
        if(error instanceof ExecutionDispatchPendingError)await this.deps.database.$transaction(async tx=>{const row=await this.owned(tx,reference,prepared.claimToken,prepared.target);if(row)await tx.zoomWebhookJob.update({where:{id:row.id},data:{claimToken:null,leaseExpiresAt:null}});});
        throw error;
      }
      const ids=await this.deps.database.$transaction(async tx=>{const row=await this.owned(tx,reference,prepared.claimToken,prepared.target);return row?this.defer(tx,row,"zoom_import_failed"):null;});
      if(ids===null)throw error;
      await this.deps.register(ids);
      return {kind:"complete"};
    }
  }
  private async prepareDeauthorization(tx:Tx,reference:ExecutionDispatchReference,notification:Deauthorization,now:Date):Promise<Prepared>{
    const row=await currentJob(tx,reference);
    if(!row)return {result:{kind:"superseded"},ids:[]};
    now=await clock(tx);
    if(row.operationDeadlineAt<=now){await tx.zoomWebhookJob.update({where:{id:row.id},data:{status:"failed",generation:{increment:1},completedAt:now,lastError:"zoom_notification_deadline",claimToken:null,leaseExpiresAt:null}});return {result:{kind:"complete"},ids:[]};}
    const target=row.executionTarget===null?null:zoomExecutionTargetSchema.parse(row.executionTarget);
    if(target&&target.kind!=="deauthorize")throw Error("zoom_notification_target_invalid");
    if(!target){
      const connection=await tx.zoomConnection.findFirst({where:{zoomAccountId:notification.accountId,zoomUserId:notification.userId,revokedAt:null,...(row.ruleCursor?{id:{gt:row.ruleCursor}}:{})},orderBy:{id:"asc"},select:{id:true}});
      if(!connection){await tx.zoomWebhookJob.update({where:{id:row.id},data:{status:"completed",generation:{increment:1},completedAt:now,claimToken:null,leaseExpiresAt:null,lastError:null}});return {result:{kind:"complete"},ids:[]};}
      const next=await tx.zoomWebhookJob.update({where:{id:row.id},data:{generation:{increment:1},executionTarget:{kind:"deauthorize",connectionId:connection.id}}});
      return {result:{kind:"complete"},ids:await repair(tx,next)};
    }
    if(row.claimToken&&row.leaseExpiresAt){
      if(row.leaseExpiresAt>now)return {result:{kind:"wait",dueAt:row.leaseExpiresAt},ids:await repair(tx,row)};
      const next=await tx.zoomWebhookJob.update({where:{id:row.id},data:{generation:{increment:1},claimToken:null,leaseExpiresAt:null}});
      return {result:{kind:"complete"},ids:await repair(tx,next)};
    }
    const claimToken=randomUUID(),leaseExpiresAt=new Date(Math.min(now.getTime()+120_000,row.operationDeadlineAt!.getTime()));
    const claimed=await tx.zoomWebhookJob.update({where:{id:row.id},data:{status:"running",claimToken,leaseExpiresAt,attempts:{increment:1}}});
    return {action:"deauthorize",row:claimed,connectionId:target.connectionId,notification,claimToken,ids:await repair(tx,claimed)};
  }
  private async runDeauthorization(reference:ExecutionDispatchReference,prepared:Extract<Prepared,{action:"deauthorize"}>):Promise<ZoomExecutionResult>{
    const owned=async(tx:Tx)=>{
      if((await readExecutionAdmission(tx)).epoch!==reference.deploymentEpoch)return null;
      const row=await currentJob(tx,reference),now=await clock(tx);
      return row&&row.claimToken===prepared.claimToken&&row.leaseExpiresAt&&row.leaseExpiresAt>now&&row.operationDeadlineAt&&row.operationDeadlineAt>now?row:null;
    };
    try{
      await this.deps.revokeConnection(prepared.connectionId,new Date(prepared.notification.eventTs));
      const ids=await this.deps.database.$transaction(async tx=>{const row=await owned(tx);return row?this.advance(tx,row,prepared.connectionId):null;});
      if(ids===null)return {kind:"superseded"};
      await this.deps.register(ids);return {kind:"complete"};
    }catch(error){
      if(error instanceof ExecutionDispatchError){
        if(error instanceof ExecutionDispatchPendingError)await this.deps.database.$transaction(async tx=>{const row=await owned(tx);if(row)await tx.zoomWebhookJob.update({where:{id:row.id},data:{claimToken:null,leaseExpiresAt:null}});});
        throw error;
      }
      const ids=await this.deps.database.$transaction(async tx=>{const row=await owned(tx);return row?this.defer(tx,row,"zoom_deauthorization_deferred"):null;});
      if(ids===null)throw error;
      await this.deps.register(ids);return {kind:"complete"};
    }
  }
  /** Project intake already holds User/Member, Usage, Workspace, Recipe,
   * Rule and Connection locks. This final SHARE protects the short command. */
  async assertIntakeWithinTransaction(tx:Tx,input:{reference:ExecutionDispatchReference;claimToken:string;target:ZoomRecordingTarget;notification:ZoomRecordingNotification}) {
    const {reference,target}=input;
    if((await readExecutionAdmission(tx)).epoch!==reference.deploymentEpoch||reference.kind!=="operation_driver"||reference.subject.kind!=="zoom_notification")throw Error("zoom_notification_superseded");
    const ledger=await readExecutionDispatch(tx,reference.dispatchId);
    await tx.$queryRaw`SELECT id FROM "ZoomWebhookJob" WHERE id=${reference.subject.id}::uuid FOR SHARE`;
    const row=await tx.zoomWebhookJob.findUnique({where:{id:reference.subject.id}}),now=await clock(tx);
    if(!ledger||JSON.stringify(ledger.reference)!==JSON.stringify(reference)||!row||row.status!=="running"||row.deploymentEpoch!==reference.deploymentEpoch||row.generation!==reference.generation||zoomNotificationInputHash(row)!==reference.inputHash||row.claimToken!==input.claimToken||!row.leaseExpiresAt||row.leaseExpiresAt<=now||!row.operationDeadlineAt||row.operationDeadlineAt<=now||operationFingerprint(row.executionTarget)!==operationFingerprint(target)||operationFingerprint(row.payload)!==operationFingerprint(input.notification))throw Error("zoom_notification_superseded");
    const rule=await tx.autopilotRule.findUnique({where:{id:target.plan.source.ruleId},include:{zoomConnection:true}});
    if(!rule||rule.status!=="active"||rule.sourceKind!=="zoom"||rule.createdByUserId!==target.scope.actorUserId||rule.workspaceId!==target.scope.workspaceId||rule.zoomConnectionId!==target.connectionId||!rule.zoomConnection||rule.zoomConnection.revokedAt||rule.zoomConnection.refreshOutcomeUnknown||rule.zoomConnection.userId!==target.connectionUserId||!rule.zoomConnection.accessTokenEncrypted||!rule.zoomConnection.refreshTokenEncrypted||rule.zoomConnection.zoomAccountId!==input.notification.accountId||rule.zoomConnection.zoomUserId!==input.notification.hostId||await ruleFingerprint(tx,rule.id)!==target.plan.source.sourceRuleFingerprint||!await actorAllowed(tx,rule.workspaceId,rule.createdByUserId)||!await actorAllowed(tx,rule.workspaceId,rule.zoomConnection.userId)||await autopilotPlanPauseReason(tx,rule))throw Error("zoom_notification_superseded");
  }
  private async owned(tx:Tx,reference:ExecutionDispatchReference,token:string,target:ZoomRecordingTarget){
    if((await readExecutionAdmission(tx)).epoch!==reference.deploymentEpoch)return null;
    await lockRuleParents(tx,target.plan.source.ruleId);
    const row=await currentJob(tx,reference),now=await clock(tx);
    return row&&row.claimToken===token&&row.leaseExpiresAt&&row.leaseExpiresAt>now&&row.operationDeadlineAt&&row.operationDeadlineAt>now?row:null;
  }
  private async advance(tx:Tx,row:ZoomWebhookJob,cursor:string,skipped=false){
    const next=await tx.zoomWebhookJob.update({where:{id:row.id},data:{status:"queued",generation:{increment:1},availableAt:await clock(tx),ruleCursor:cursor,executionTarget:Prisma.DbNull,claimToken:null,leaseExpiresAt:null,lastError:null,...(skipped?{skippedTargets:{increment:1}}:{})}});
    return repair(tx,next);
  }
  private async defer(tx:Tx,row:ZoomWebhookJob,code:string){
    const now=await clock(tx),dueAt=new Date(Math.min(now.getTime()+Math.min(3600_000,60_000*2**Math.min(row.attempts,6)),row.operationDeadlineAt!.getTime()));
    const next=await tx.zoomWebhookJob.update({where:{id:row.id},data:{status:"queued",generation:{increment:1},claimToken:null,leaseExpiresAt:null,availableAt:dueAt,lastError:code}});
    return repair(tx,next);
  }
}
