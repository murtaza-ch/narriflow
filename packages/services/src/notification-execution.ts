import {readWebhookNotificationContext} from "./webhook-notification-context";
import {readGrantNotificationContext} from "./grant-notification-context";
import {createHash,randomUUID} from "node:crypto";
import {Prisma,type PrismaClient} from "@prisma/client";
import {executionDispatchReferenceSchema,type ExecutionDispatchReference} from "@narriflow/validators/execution";
import {readExecutionAdmission} from "./execution-admission";
import {appendExecutionDispatch,readExecutionDispatch} from "./execution-dispatch";
import {collectExecutionDispatch} from "./execution-dispatch-runtime";
import {lockWorkspaceUsage} from "./processing-usage";
import {accessibleProjectWhere} from "./project-access";
import { databaseNow } from "./execution-clock";

type Tx=Prisma.TransactionClient;
export type NotificationTarget={kind:'project'|'review'|'grant'|'webhook';id:string};
export interface SealedNotification {encrypted:string;hash:string;contextFingerprint?:string}
export interface NotificationSendResult {sent:boolean;providerMessageId?:string;retryable?:boolean}
const MAX_ATTEMPTS=3,LEASE_MS=5*60_000;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function identity(target:NotificationTarget){if(!uuid.test(target.id))throw Error('notification_target_invalid');return `em1.${target.kind==='project'?'p':target.kind==='review'?'r':target.kind==='grant'?'g':'w'}.${target.id}`;}
export function notificationTarget(reference:ExecutionDispatchReference):NotificationTarget|null{
 if(reference.kind!=='operation_driver'||reference.subject.kind!=='notification')return null;
 const match=/^em1\.([prgw])\.([a-f0-9-]{36})$/.exec(reference.subject.id);
 if(!match||!uuid.test(match[2]!))return null;return{kind:match[1]==='p'?'project':match[1]==='r'?'review':match[1]==='g'?'grant':'webhook',id:match[2]!};
}
async function view(tx:Tx,target:NotificationTarget){
 if(target.kind==='webhook'){const row=await tx.webhookDisabledNotificationLedger.findUnique({where:{id:target.id}});return row?{row,projectId:null,workspaceId:row.workspaceId,identity:[row.workspaceId,row.webhookId,row.disableRevision,row.reason,row.urlHost]}:null;}
 if(target.kind==='grant'){const row=await tx.grantPauseNotificationLedger.findUnique({where:{id:target.id}});return row?{row,projectId:null,workspaceId:row.workspaceId,identity:[row.workspaceId,row.grantId,row.pauseEventId,row.grantRevision,row.reason]}:null;}
 if(target.kind==='project'){
  const row=await tx.notificationLedger.findUnique({where:{id:target.id},include:{project:{select:{workspaceId:true}}}});
  return row?{row,projectId:row.projectId,workspaceId:row.project.workspaceId,identity:[row.projectId,row.sourceId,row.outcome]}:null;
 }
 const row=await tx.reviewNotificationLedger.findUnique({where:{id:target.id},include:{reviewRound:{select:{projectId:true,workspaceId:true}}}});
 return row?{row,projectId:row.reviewRound.projectId,workspaceId:row.reviewRound.workspaceId,identity:[row.reviewRoundId,row.recipientEmail,row.kind,row.scopeKey]}:null;
}
type View=NonNullable<Awaited<ReturnType<typeof view>>>;
type Update={status?:string;deploymentEpoch?:number;generation?:number;claimToken?:string|null;leaseExpiresAt?:Date|null;attemptCount?:number;nextAttemptAt?:Date;deliveryInputEncrypted?:string;deliveryInputHash?:string;deliveryContextFingerprint?:string;submissionStartedAt?:Date|null;providerMessageId?:string|null;sentAt?:Date;failureCode?:string|null};
async function update(tx:Tx,target:NotificationTarget,data:Update){
 if(target.kind==='project')await tx.notificationLedger.update({where:{id:target.id},data});
 else if(target.kind==='review') await tx.reviewNotificationLedger.update({where:{id:target.id},data});
 else if(target.kind==='grant')await tx.grantPauseNotificationLedger.update({where:{id:target.id},data});
 else await tx.webhookDisabledNotificationLedger.update({where:{id:target.id},data});
}
function hash(target:NotificationTarget,value:View){return createHash('sha256').update(JSON.stringify(['notification-delivery-v1',identity(target),value.row.deploymentEpoch,value.row.generation,value.identity,value.row.operationDeadlineAt.toISOString()])).digest('hex');}
async function lockLeaf(tx:Tx,target:NotificationTarget){
 if(target.kind==='project')await tx.$queryRaw`SELECT id FROM "NotificationLedger" WHERE id=${target.id}::uuid FOR UPDATE`;
 else if(target.kind==='review') await tx.$queryRaw`SELECT id FROM "ReviewNotificationLedger" WHERE id=${target.id}::uuid FOR UPDATE`;
 else if(target.kind==='grant')await tx.$queryRaw`SELECT id FROM "GrantPauseNotificationLedger" WHERE id=${target.id}::uuid FOR UPDATE`;
 else await tx.$queryRaw`SELECT id FROM "WebhookDisabledNotificationLedger" WHERE id=${target.id}::uuid FOR UPDATE`;
}
async function lock(tx:Tx,target:NotificationTarget,initial:View){
 await lockWorkspaceUsage(tx,initial.workspaceId);
 if(target.kind==='grant'||target.kind==='webhook'){
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${initial.workspaceId}::uuid FOR SHARE`;
  if(target.kind==='grant'){const row=initial.row as {grantId:string};await tx.$queryRaw`SELECT id FROM "StandingGrant" WHERE id=${row.grantId}::uuid FOR SHARE`;}
  else{const row=initial.row as {webhookId:string};await tx.$queryRaw`SELECT id FROM "WebhookSubscription" WHERE id=${row.webhookId}::uuid FOR SHARE`;}
  await lockLeaf(tx,target);return;
 }
 await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${initial.projectId}::uuid FOR UPDATE`;
 if(target.kind==='project')await tx.$queryRaw`SELECT id FROM "NotificationLedger" WHERE id=${target.id}::uuid FOR UPDATE`;
 else{await tx.$queryRaw`SELECT id FROM "ReviewRound" WHERE id=${(initial.row as {reviewRoundId:string}).reviewRoundId}::uuid FOR UPDATE`;await tx.$queryRaw`SELECT id FROM "ReviewNotificationLedger" WHERE id=${target.id}::uuid FOR UPDATE`;}
}
async function append(tx:Tx,target:NotificationTarget,value:View,deadline?:Date){
 const record=await appendExecutionDispatch(tx,{deploymentEpoch:value.row.deploymentEpoch,generation:value.row.generation,kind:'operation_driver',subject:{kind:'notification',id:identity(target)},inputHash:hash(target,value),dueAt:deadline??value.row.nextAttemptAt,
  ...(deadline?{deadlineKind:'lease' as const,observedDeadlineAt:deadline}:{})});
 collectExecutionDispatch(tx,record.reference.dispatchId);return record.reference;
}
/** The caller inserts its intent in this same transaction. Replays preserve
 * the accepted deadline and the provider idempotency key across generations. */
export async function appendNotificationDelivery(tx:Tx,target:NotificationTarget){
 const admission=await readExecutionAdmission(tx),initial=await view(tx,target);if(!initial)throw Error('notification_not_found');
 await lockLeaf(tx,target);const value=(await view(tx,target))!;
 if(value.row.deploymentEpoch!==admission.epoch)throw Error('notification_epoch_superseded');
 return append(tx,target,value);
}
async function current(tx:Tx,reference:ExecutionDispatchReference,owner?:string){
 const target=notificationTarget(reference);if(!target)return null;
 const admission=await readExecutionAdmission(tx),record=await readExecutionDispatch(tx,reference.dispatchId);
 if(admission.epoch!==reference.deploymentEpoch||!record||JSON.stringify(record.reference)!==JSON.stringify(reference))return null;
 const initial=await view(tx,target);if(!initial)return null;await lock(tx,target,initial);
 const value=(await view(tx,target))!,now=await databaseNow(tx),row=value.row;
 if(row.deploymentEpoch!==reference.deploymentEpoch||row.generation!==reference.generation||hash(target,value)!==reference.inputHash)return null;
 const context=target.kind==='grant'?await readGrantNotificationContext(tx,target.id,now):target.kind==='webhook'?await readWebhookNotificationContext(tx,target.id):null;
 const available=(target.kind==='grant'||target.kind==='webhook')?context!==null&&(!row.deliveryInputHash||(row as {deliveryContextFingerprint:string}).deliveryContextFingerprint===context.contextFingerprint):Boolean(await tx.project.findFirst({where:{id:value.projectId!,workspaceId:value.workspaceId,...accessibleProjectWhere(now),workspace:{status:'active'}},select:{id:true}}));
 if(owner&&(target.kind==='grant'||target.kind==='webhook')&&value.row.deliveryInputHash&&(value.row as {deliveryContextFingerprint:string}).deliveryContextFingerprint!==context?.contextFingerprint)return null;
 if(owner&&(!available||row.status!=='claimed'||row.claimToken!==owner||!row.leaseExpiresAt||row.leaseExpiresAt<=now||row.operationDeadlineAt<=now))return null;
 return{target,value,now,record,available,context};
}
type DriverResult={kind:'complete'|'superseded'}|{kind:'sleep'|'wait';dueAt:Date};
export function createNotificationExecution(options:{database:PrismaClient;register(ids:readonly string[]):Promise<void>;prepare(target:NotificationTarget,sealed:SealedNotification|null):Promise<SealedNotification|null>;send(target:NotificationTarget,sealed:SealedNotification,key:string):Promise<NotificationSendResult>}){
 const {database,register}=options;
 async function repair(reference:ExecutionDispatchReference){
  const ids=await database.$transaction(async tx=>{
   const target=notificationTarget(reference),record=await readExecutionDispatch(tx,reference.dispatchId),admission=await readExecutionAdmission(tx);
   if(!target||admission.epoch!==reference.deploymentEpoch||!record||JSON.stringify(record.reference)!==JSON.stringify(reference))return[];
   const value=await view(tx,target);if(!value||value.row.deploymentEpoch!==admission.epoch||!['pending','claimed'].includes(value.row.status))return[];
   return[(await appendNotificationDelivery(tx,target)).dispatchId];
  });if(ids.length)await register(ids);
 }
 return{async run(value:ExecutionDispatchReference):Promise<DriverResult>{
  const reference=executionDispatchReferenceSchema.parse(value);
  const prepared=await database.$transaction(async tx=>{
   const state=await current(tx,reference);if(!state)return{kind:'superseded' as const};
   const {target,value,now,record,available}=state,row=value.row;
   if(!['pending','claimed'].includes(row.status))return{kind:'complete' as const};
   if(!available||row.operationDeadlineAt<=now||(row.status==='pending'&&row.attemptCount>=MAX_ATTEMPTS)){await update(tx,target,{status:available?'failed':'skipped',claimToken:null,leaseExpiresAt:null,failureCode:available?'notification_deadline_or_budget':'context_unavailable'});return{kind:'complete' as const};}
   if(record.observedDeadlineAt&&record.observedDeadlineAt>now)return{kind:'sleep' as const,dueAt:record.observedDeadlineAt};
   if(row.status==='claimed'&&row.claimToken&&row.leaseExpiresAt){
    if(row.leaseExpiresAt>now)return{kind:'wait' as const,dueAt:row.leaseExpiresAt};
    await update(tx,target,{status:'pending',generation:row.generation+1,claimToken:null,leaseExpiresAt:null,attemptCount:row.attemptCount+(row.submissionStartedAt?0:1),submissionStartedAt:null});
    return{kind:'advanced' as const,id:(await append(tx,target,(await view(tx,target))!)).dispatchId};
   }
   if(row.nextAttemptAt>now)return{kind:'sleep' as const,dueAt:new Date(Math.min(row.nextAttemptAt.getTime(),row.operationDeadlineAt.getTime()))};
   const owner=randomUUID(),lease=new Date(Math.min(now.getTime()+LEASE_MS,row.operationDeadlineAt.getTime()));
   await update(tx,target,{status:'claimed',claimToken:owner,leaseExpiresAt:lease,submissionStartedAt:null});
   return{kind:'claimed' as const,target,owner,providerKey:target.kind==='webhook'?`webhook-disabled:${(row as {webhookId:string}).webhookId}:${(row as {disableRevision:number}).disableRevision}`:target.kind==='grant'?`standing-grant-paused:${(row as {grantId:string}).grantId}:${(row as {grantRevision:number}).grantRevision}`:`${target.kind==='project'?'notification-ledger':'review-notification'}-${target.id}`,sealed:row.deliveryInputEncrypted&&row.deliveryInputHash?{encrypted:row.deliveryInputEncrypted,hash:row.deliveryInputHash,...((target.kind==='grant'||target.kind==='webhook')?{contextFingerprint:(row as {deliveryContextFingerprint:string}).deliveryContextFingerprint}:{})}:null,watchdog:(await append(tx,target,(await view(tx,target))!,lease)).dispatchId};
  });
  if(prepared.kind==='advanced'){await register([prepared.id]);return{kind:'complete'};}
  if(prepared.kind!=='claimed'){if(prepared.kind==='superseded')await repair(reference);return prepared;}
  try{await register([prepared.watchdog]);}catch(error){
   await database.$transaction(async tx=>{const state=await current(tx,reference,prepared.owner);if(state)await update(tx,state.target,{status:'pending',claimToken:null,leaseExpiresAt:null});});throw error;
  }
  let sealed:SealedNotification|null;
  try{sealed=await options.prepare(prepared.target,prepared.sealed);}catch{
   sealed=null;
   // No physical provider request began. Let the original bounded watchdog
   // recover configuration/storage failure without inventing success.
   throw Error('notification_preparation_unavailable');
  }
  if(sealed&&(!sealed.encrypted||sealed.encrypted.length>131072||!/^[a-f0-9]{64}$/.test(sealed.hash)))throw Error('notification_seal_invalid');
  const admitted=await database.$transaction(async tx=>{
   const state=await current(tx,reference,prepared.owner);if(!state)return false;
   if(!sealed){await update(tx,state.target,{status:'skipped',claimToken:null,leaseExpiresAt:null,failureCode:'context_unavailable'});return false;}
   if((state.target.kind==='grant'||state.target.kind==='webhook')&&(!sealed.contextFingerprint||state.context?.contextFingerprint!==sealed.contextFingerprint)){await update(tx,state.target,{status:'skipped',claimToken:null,leaseExpiresAt:null,failureCode:'recipient_changed'});return false;}
   const row=state.value.row;
   if(row.deliveryInputHash&&row.deliveryInputHash!==sealed.hash)throw Error('notification_sealed_input_changed');
   await update(tx,state.target,{deliveryInputEncrypted:sealed.encrypted,deliveryInputHash:sealed.hash,...((state.target.kind==='grant'||state.target.kind==='webhook')?{deliveryContextFingerprint:sealed.contextFingerprint}:{}),submissionStartedAt:state.now,attemptCount:row.attemptCount+1});return true;
  });
  if(!admitted)return{kind:sealed?'superseded':'complete'};
  const key=prepared.providerKey;
  let outcome:NotificationSendResult;
  try{outcome=await options.send(prepared.target,sealed!,key);}catch{outcome={sent:false};}
  const settled=await database.$transaction(async tx=>{
   const state=await current(tx,reference,prepared.owner);if(!state)return null;
   const row=state.value.row;
   if(outcome.sent){await update(tx,state.target,{status:'sent',claimToken:null,leaseExpiresAt:null,providerMessageId:outcome.providerMessageId??null,sentAt:state.now,failureCode:null});return{ids:[] as string[]};}
   if(outcome.retryable===false||row.attemptCount>=MAX_ATTEMPTS){await update(tx,state.target,{status:'failed',claimToken:null,leaseExpiresAt:null,failureCode:'provider_unavailable'});return{ids:[] as string[]};}
   await update(tx,state.target,{status:'pending',generation:row.generation+1,claimToken:null,leaseExpiresAt:null,submissionStartedAt:null,nextAttemptAt:new Date(Math.min(state.now.getTime()+row.attemptCount*60_000,row.operationDeadlineAt.getTime())),failureCode:'provider_unavailable'});
   return{ids:[(await append(tx,state.target,(await view(tx,state.target))!)).dispatchId]};
  });
  if(!settled)return{kind:'superseded'};if(settled.ids.length)await register(settled.ids);return{kind:'complete'};
 }};
}

/** Admission producers call this with their existing Project transaction. No
 * provider request occurs; settlement and its exact delivery commit together. */
export async function appendProjectNotificationIntent(tx:Tx,input:{projectId:string;sourceId:string;outcome:string;clipCount?:number;reason?:string}){
 const admission=await readExecutionAdmission(tx);
 const project=await tx.project.findUnique({where:{id:input.projectId},select:{notifyOnComplete:true}});
 if(!project || (input.outcome!=="project_expiring"&&!project.notifyOnComplete))return null;
 const row=await tx.notificationLedger.upsert({where:{projectId_sourceId_outcome:{projectId:input.projectId,sourceId:input.sourceId,outcome:input.outcome}},update:{},create:{projectId:input.projectId,sourceId:input.sourceId,outcome:input.outcome,deploymentEpoch:admission.epoch,facts:{clipCount:input.clipCount??null,reason:input.reason?.slice(0,2000)??null}}});
 await appendNotificationDelivery(tx,{kind:'project',id:row.id});return row;
}

/** Replays only a bounded set of notification IDs captured by this receipt's
 * original transaction. No source scan or new domain admission is performed. */
export async function recoverNotificationDispatchIds(tx:Tx,value:unknown){
 if(value===undefined)return;
 if(!Array.isArray(value)||value.length>128||value.some(id=>typeof id!=="string"||!uuid.test(id)))throw Error("notification_receipt_dispatch_invalid");
 const admission=await readExecutionAdmission(tx);
 const rows=await tx.executionDispatch.findMany({where:{id:{in:value},deploymentEpoch:admission.epoch,kind:"operation_driver",subjectKind:"notification"},select:{id:true,subjectId:true}});
 for(const row of rows)if(/^em1\.[prgw]\.[a-f0-9-]{36}$/.test(row.subjectId))collectExecutionDispatch(tx,row.id);
}

/** A fresh human retry may use another bounded attempt cycle while retaining
 * the original encrypted request, provider key and23-hour absolute deadline. */
export async function retryNotificationDeliveryWithinTransaction(tx:Tx,target:NotificationTarget,scope:{workspaceId:string;projectId:string}){
 const admission=await readExecutionAdmission(tx),initial=await view(tx,target);
 if(!initial||initial.workspaceId!==scope.workspaceId||initial.projectId!==scope.projectId)return false;
 await lock(tx,target,initial);const value=(await view(tx,target))!,now=await databaseNow(tx);
 if(value.row.deploymentEpoch!==admission.epoch||value.row.status!=='failed'||value.row.operationDeadlineAt<=now)return false;
 if(!admission.admissionOpen)throw Error('notification_retry_admission_closed');
 await update(tx,target,{status:'pending',generation:value.row.generation+1,attemptCount:0,claimToken:null,leaseExpiresAt:null,submissionStartedAt:null,nextAttemptAt:now,failureCode:null});
 await append(tx,target,(await view(tx,target))!);return true;
}

/** Terminal parent replay repairs only the mail intents its accepted source
 * already owns. It cannot create a new notification or extend a child budget. */
export async function recoverProjectNotificationDeliveries(tx:Tx,input:{projectId:string;sourceId:string;outcomes:readonly string[]}){
 if(!input.outcomes.length||input.outcomes.length>6||input.outcomes.some(value=>!['clips_ready','no_clips','generation_failed','import_failed','project_expiring','finishing_ready'].includes(value)))throw Error("notification_recovery_invalid");
 const {epoch}=await readExecutionAdmission(tx);
 const rows=await tx.notificationLedger.findMany({where:{projectId:input.projectId,sourceId:input.sourceId,outcome:{in:[...input.outcomes]},deploymentEpoch:epoch},orderBy:{id:"asc"},take:6});
 const ids:string[]=[];for(const row of rows)ids.push((await appendNotificationDelivery(tx,{kind:"project",id:row.id})).dispatchId);return ids;
}

/** A system pause accepts one workspace notice in the same transaction. No
 * latest-grant lookup, fake Project, provider request, or new retry core. */
export async function appendGrantPauseNotificationIntent(tx:Tx,input:{workspaceId:string;grantId:string;pauseEventId:string;grantRevision:number;reason:string}){
 const {epoch}=await readExecutionAdmission(tx),at=await databaseNow(tx);
 const row=await tx.grantPauseNotificationLedger.upsert({where:{grantId_grantRevision:{grantId:input.grantId,grantRevision:input.grantRevision}},update:{},create:{...input,deploymentEpoch:epoch,createdAt:at,nextAttemptAt:at,operationDeadlineAt:new Date(at.getTime()+23*3600_000)}});
 if(row.workspaceId!==input.workspaceId||row.pauseEventId!==input.pauseEventId||row.reason!==input.reason)throw Error('grant_notification_intent_conflict');
 await appendNotificationDelivery(tx,{kind:'grant',id:row.id});return row;
}

/** A disable transition and its notice share the subscription authority
 * transaction. Repeated acceptance repairs only the original bounded intent. */
export async function appendWebhookDisabledNotificationIntent(tx:Tx,sub:{id:string;workspaceId:string;disableRevision:number;disabledReason:string|null;urlHost:string}){
 if(sub.disableRevision<1||!sub.disabledReason)throw Error('webhook_notification_intent_invalid');
 const {epoch}=await readExecutionAdmission(tx),at=await databaseNow(tx);
 const row=await tx.webhookDisabledNotificationLedger.upsert({where:{webhookId_disableRevision:{webhookId:sub.id,disableRevision:sub.disableRevision}},update:{},create:{workspaceId:sub.workspaceId,webhookId:sub.id,disableRevision:sub.disableRevision,reason:sub.disabledReason,urlHost:sub.urlHost,deploymentEpoch:epoch,createdAt:at,nextAttemptAt:at,operationDeadlineAt:new Date(at.getTime()+23*3600_000)}});
 if(row.workspaceId!==sub.workspaceId||row.reason!==sub.disabledReason||row.urlHost!==sub.urlHost)throw Error('webhook_notification_intent_conflict');
 await appendNotificationDelivery(tx,{kind:'webhook',id:row.id});return row;
}
