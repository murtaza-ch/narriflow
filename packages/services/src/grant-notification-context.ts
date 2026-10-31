import {createHash} from 'node:crypto';
import type {Prisma} from '@prisma/client';
/** Read under the Workspace and grant authority locks at the final send marker.
 * Names are display facts; the fingerprint binds permission and recipient. */
export async function readGrantNotificationContext(tx:Prisma.TransactionClient,id:string,at:Date){
 const row=await tx.grantPauseNotificationLedger.findUnique({where:{id},include:{pauseEvent:true,grant:{include:{autopilotRule:{select:{name:true}},socialAccount:{select:{displayName:true}}}},workspace:{include:{owner:{select:{id:true,primaryEmail:true,emailVerifiedAt:true,deletedAt:true}}}}}});
 if(!row||row.workspace.status!=='active'||row.grant.workspaceId!==row.workspaceId||row.grant.status!=='paused'||row.grant.expiresAt<=at||row.grant.revision!==row.grantRevision||row.grant.pausedReason!==row.reason||row.pauseEvent.grantId!==row.grantId||row.pauseEvent.kind!=='paused'||row.pauseEvent.actorUserId!==null||row.pauseEvent.revision!==row.grantRevision||row.pauseEvent.reason!==row.reason)return null;
 const member=row.grant.grantedByUserId?await tx.workspaceMember.findUnique({where:{workspaceId_userId:{workspaceId:row.workspaceId,userId:row.grant.grantedByUserId}},include:{user:{select:{id:true,primaryEmail:true,emailVerifiedAt:true,deletedAt:true}}}}):null;
 const candidates=[member&&['owner','admin'].includes(member.role)?member.user:null,row.workspace.owner];
 const recipient=candidates.find(user=>user&&!user.deletedAt&&user.primaryEmail&&user.emailVerifiedAt);
 if(!recipient?.primaryEmail)return null;
 const reviewers=Array.isArray(row.grant.reviewerEmails)?row.grant.reviewerEmails.length:0;
 return {grantId:row.grantId,grantRevision:row.grantRevision,reason:row.reason,to:recipient.primaryEmail,
  ruleName:row.grant.autopilotRule?.name??'A deleted rule',destination:row.grant.socialAccount?.displayName??`${reviewers} reviewer${reviewers===1?'':'s'}`,
  contextFingerprint:createHash('sha256').update(JSON.stringify(['grant-pause-recipient-v1',row.workspaceId,row.grantId,row.grantRevision,row.pauseEventId,row.reason,recipient.id,recipient.primaryEmail,recipient.emailVerifiedAt!.toISOString()])).digest('hex')};
}
