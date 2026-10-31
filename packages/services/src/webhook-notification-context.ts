import {createHash} from 'node:crypto';
import type {Prisma} from '@prisma/client';
import {roleHasWorkspaceCapability} from '@narriflow/validators';
export const WEBHOOK_DISABLED_REASON_TEXT={
 consecutive_failures:'Narriflow could not deliver 20 events in a row',
 cursor_expired:'Delivery fell more than 30 days behind, so events expired before they were sent',
 endpoint_gone:'The endpoint answered 410 Gone',
 delivery_attempts_exhausted:'The delivery used its 20 native attempts before acknowledgment; re-enable it to retry',
} as const;
/** The disabled cycle, current recipient and membership are read again under
 * Workspace/subscription authority before any provider request or settlement. */
export async function readWebhookNotificationContext(tx:Prisma.TransactionClient,id:string){
 const row=await tx.webhookDisabledNotificationLedger.findUnique({where:{id},include:{webhook:true,workspace:{include:{owner:{select:{id:true,primaryEmail:true,emailVerifiedAt:true,deletedAt:true}}}}}});
 if(!row||!['active','restricted'].includes(row.workspace.status)||row.webhook.workspaceId!==row.workspaceId||row.webhook.status!=='disabled'||row.webhook.disableRevision!==row.disableRevision||row.webhook.disabledReason!==row.reason||row.webhook.urlHost!==row.urlHost||!Object.hasOwn(WEBHOOK_DISABLED_REASON_TEXT,row.reason))return null;
 const member=row.webhook.createdByUserId?await tx.workspaceMember.findUnique({where:{workspaceId_userId:{workspaceId:row.workspaceId,userId:row.webhook.createdByUserId}},include:{user:{select:{id:true,primaryEmail:true,emailVerifiedAt:true,deletedAt:true}}}}):null;
 const candidates=[member&&roleHasWorkspaceCapability(member.role,'api.manage')?member.user:null,row.workspace.owner];
 const recipient=candidates.find(user=>user&&!user.deletedAt&&user.primaryEmail&&user.emailVerifiedAt);
 if(!recipient?.primaryEmail)return null;
 return{webhookId:row.webhookId,disableRevision:row.disableRevision,urlHost:row.urlHost,reason:row.reason as keyof typeof WEBHOOK_DISABLED_REASON_TEXT,to:recipient.primaryEmail,
  contextFingerprint:createHash('sha256').update(JSON.stringify(['webhook-disabled-recipient-v1',row.workspaceId,row.webhookId,row.disableRevision,row.reason,row.urlHost,recipient.id,recipient.primaryEmail,recipient.emailVerifiedAt!.toISOString()])).digest('hex')};
}
