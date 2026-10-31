import {readWebhookNotificationContext,WEBHOOK_DISABLED_REASON_TEXT} from "./webhook-notification-context";
import {readGrantNotificationContext} from "./grant-notification-context";
import {standingGrantPauseMessage} from "@narriflow/validators";
import {createHash} from "node:crypto";
import {getPrismaClient} from "@narriflow/db/client";
import {notificationDeliveryPayloadSchema,notificationDeliveryFactsSchema,notificationDeliveryEnvelopeSchema} from "@narriflow/validators/notification-delivery";
import {createNotificationExecution,type NotificationTarget,type SealedNotification} from "./notification-execution";
import {createNotificationStore,buildNotificationMail,type NotificationOutcome} from "./notification.service";
import {createReviewNotificationStore,buildReviewNotificationMail} from "./review-notification.service";
import {encryptReviewValue,decryptReviewValue,reviewDeliverySecret} from "./review.service";
import {readServiceEnvironment} from "./runtime-environment";
import {deliverExecutionDispatches} from "./execution-dispatch-runtime";
function database(){const value=getPrismaClient();if(!value)throw Error('notification_database_unavailable');return value;}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function open(sealed:SealedNotification){
 const json=decryptReviewValue(sealed.encrypted,reviewDeliverySecret());
 if(json.length>131072||digest(json)!==sealed.hash)throw Error('notification_seal_invalid');
 return notificationDeliveryEnvelopeSchema.parse(JSON.parse(json));
}
async function currentMail(target:NotificationTarget){
 const environment=readServiceEnvironment();if(!environment.RESEND_API_KEY?.trim())return null;
 const origin=environment.WEB_ORIGIN;if(!origin)throw Error('notification_web_origin_unavailable');
 const from=environment.NARRIFLOW_EMAIL_FROM??'Narriflow <no-reply@narriflow.app>';
 if(target.kind==='webhook'){
  const current=await database().$transaction(tx=>readWebhookNotificationContext(tx,target.id));if(!current)return null;
  const email=await import('@narriflow/email/worker');const template=email.webhookDisabled({urlHost:current.urlHost,reason:WEBHOOK_DISABLED_REASON_TEXT[current.reason],settingsLink:new URL('/settings/api#webhooks',origin).toString()});
  return{input:{...template,to:current.to,from,idempotencyKey:''},contextFingerprint:current.contextFingerprint};
 }
 if(target.kind==='grant'){
  const current=await database().$transaction(async tx=>{const at=(await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`)[0]!.now;return readGrantNotificationContext(tx,target.id,at);});if(!current)return null;
  const email=await import('@narriflow/email/worker');const template=email.standingGrantPaused({ruleName:current.ruleName,destination:current.destination,reason:standingGrantPauseMessage(current.reason)??'The grant paused.',settingsLink:new URL('/settings/automation-grants',origin).toString()});
  return{input:{...template,to:current.to,from,idempotencyKey:''},contextFingerprint:current.contextFingerprint};
 }
 if(target.kind==='review'){
  const context=await createReviewNotificationStore().getContext(target.id);if(!context)return null;
  const payload=await buildReviewNotificationMail({to:context.recipient,kind:context.kind,projectTitle:context.projectTitle,roundTitle:context.roundTitle,
   reviewUrl:new URL(context.reviewPath,origin).toString(),...(context.optOut?{optOut:{url:new URL(context.optOut.path,origin).toString(),workspaceName:context.optOut.workspaceName}}:{}),idempotencyKey:''});
  return{input:{...payload,from},contextFingerprint:digest(JSON.stringify([target.id,context.recipient,context.reviewPath,context.optOut?.path??null]))};
 }
 const ledger=await database().notificationLedger.findUnique({where:{id:target.id}});if(!ledger)return null;
 const store=createNotificationStore(),project=await store.getProject(ledger.projectId);
 if(!project||(ledger.outcome!=='project_expiring'&&!project.notifyOnComplete))return null;
 if(!['clips_ready','no_clips','generation_failed','import_failed','project_expiring','finishing_ready'].includes(ledger.outcome))return null;
 const delivery=ledger.outcome==='finishing_ready'?await store.getFinishingDelivery?.(ledger.sourceId):null;
 const recipient=ledger.outcome==='finishing_ready'?delivery?.primaryEmail:project.primaryEmail;
 if(!recipient||(ledger.outcome==='project_expiring'&&(!project.emailVerifiedAt||!project.expiresAt)))return null;
 const facts=notificationDeliveryFactsSchema.safeParse(ledger.facts);
 const payload=await buildNotificationMail({to:recipient,outcome:ledger.outcome as NotificationOutcome,projectTitle:project.title,
  clipCount:facts.success&&facts.data.clipCount!==null?facts.data.clipCount:delivery?.clipCount??project.clipCount,
  reason:facts.success?facts.data.reason??'The operation could not be completed.':'The operation could not be completed.',
  deepLink:new URL(ledger.outcome==='project_expiring'?'/settings/billing':`/projects/${project.id}`,origin).toString(),expiresAt:project.expiresAt?.toISOString()??null,idempotencyKey:''});
 return{input:{...payload,from},contextFingerprint:digest(JSON.stringify([target.id,recipient,ledger.outcome==='project_expiring'?project.expiresAt?.toISOString():null]))};
}
/** The existing adapter sends a byte-stable frozen request on every retry.
 * Encrypted bodies keep review tokens out of reference-only dispatch ledgers. */
export async function prepareNotificationDelivery(target:NotificationTarget,previous:SealedNotification|null){
 const current=await currentMail(target);if(!current)return null;
 if(previous){const envelope=open(previous);if(envelope.contextFingerprint!==current.contextFingerprint)return null;return {...previous,contextFingerprint:envelope.contextFingerprint};}
 const {idempotencyKey:_key,...input}=current.input;
 const envelope=notificationDeliveryEnvelopeSchema.parse({request:notificationDeliveryPayloadSchema.parse(input),contextFingerprint:current.contextFingerprint}),json=JSON.stringify(envelope);
 if(json.length>65536)throw Error('notification_payload_too_large');
 return{encrypted:encryptReviewValue(json,reviewDeliverySecret()),hash:digest(json),contextFingerprint:current.contextFingerprint};
}
export function getNotificationExecution(){
 return createNotificationExecution({database:database(),register:deliverExecutionDispatches,prepare:prepareNotificationDelivery,
  async send(_target,sealed,key){
   const email=await import('@narriflow/email/worker');
   const result=await email.sendEmail({...open(sealed).request,idempotencyKey:key});
   return{sent:result.sent,...(result.id?{providerMessageId:result.id}:{})};
  }});
}
