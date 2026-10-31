import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, ZoomConnection } from "@prisma/client";
import { workspaceAllowsCapability } from "@narriflow/validators";
import { readExecutionAdmission } from "./execution-admission";
type Tx=Prisma.TransactionClient;
export class ZoomTokenRefreshError extends Error {
  constructor(readonly code:"unavailable"|"busy"|"unconfirmed"){super(`zoom_refresh_${code}`);}
}
export interface ZoomTokenReplacement {accessTokenEncrypted:string;refreshTokenEncrypted:string;expiresInSeconds:number;scopes:string[]}
async function clock(tx:Tx){const {epoch}=await readExecutionAdmission(tx);const now=(await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`)[0]!.now;return {epoch,now};}
async function locked(tx:Tx,id:string){
  const initial=await tx.zoomConnection.findUnique({where:{id}});
  if(!initial)return null;
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${initial.userId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "WorkspaceMember" WHERE "workspaceId"=${initial.workspaceId}::uuid AND "userId"=${initial.userId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${initial.workspaceId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "ZoomConnection" WHERE id=${id}::uuid FOR UPDATE`;
  const row=await tx.zoomConnection.findUnique({where:{id}});
  if(!row||row.userId!==initial.userId||row.workspaceId!==initial.workspaceId)return null;
  const member=await tx.workspaceMember.findUnique({where:{workspaceId_userId:{workspaceId:row.workspaceId,userId:row.userId}},include:{user:{select:{deletedAt:true}},workspace:{select:{status:true}}}});
  return member&&!member.user.deletedAt&&workspaceAllowsCapability({role:member.role,status:member.workspace.status},"processing.consume")?row:null;
}
function same(a:ZoomConnection,b:ZoomConnection){return a.workspaceId===b.workspaceId&&a.userId===b.userId&&a.zoomUserId===b.zoomUserId&&a.zoomAccountId===b.zoomAccountId&&a.authorizedAt.getTime()===b.authorizedAt.getTime()&&a.accessTokenEncrypted===b.accessTokenEncrypted&&a.refreshTokenEncrypted===b.refreshTokenEncrypted;}
const unavailable={error:"unavailable" as const},busy={error:"busy" as const};
async function unknown(tx:Tx,id:string){await tx.zoomConnection.update({where:{id},data:{refreshOutcomeUnknown:true,refreshClaimId:null,refreshLeaseExpiresAt:null,refreshStartedAt:null}});return {error:"unconfirmed" as const};}
/** A token can rotate once after the started marker. The SQL lock ends before
 * exchange; uncertainty remains unusable until an explicit OAuth reconnect. */
export async function refreshZoomConnectionToken(options:{database:PrismaClient;connectionId:string;exchange(snapshot:Readonly<ZoomConnection>):Promise<ZoomTokenReplacement>}):Promise<ZoomConnection>{
  const db=options.database;
  const admitted=await db.$transaction(async tx=>{
    const observed=await clock(tx),row=await locked(tx,options.connectionId);
    if(!row||row.revokedAt||row.refreshOutcomeUnknown||!row.accessTokenEncrypted||!row.refreshTokenEncrypted)return unavailable;
    if(row.refreshClaimId){
      if(row.refreshLeaseExpiresAt!>observed.now)return busy;
      if(row.refreshStartedAt)return unknown(tx,row.id);
    }
    if(row.expiresAt&&row.expiresAt.getTime()>observed.now.getTime()+60_000)return {row};
    const owner=randomUUID();
    const claimed=await tx.zoomConnection.update({where:{id:row.id},data:{refreshClaimId:owner,refreshLeaseExpiresAt:new Date(observed.now.getTime()+45_000),refreshStartedAt:null}});
    return {claim:{epoch:observed.epoch,owner,row:claimed}};
  });
  if("error" in admitted)throw new ZoomTokenRefreshError(admitted.error!);
  if("row" in admitted)return admitted.row!;
  const claim=admitted.claim;
  const started=await db.$transaction(async tx=>{
    const observed=await clock(tx),row=await locked(tx,options.connectionId);
    if(!row||row.revokedAt||row.refreshOutcomeUnknown)return unavailable;
    if(observed.epoch!==claim.epoch||row.refreshClaimId!==claim.owner||!same(row,claim.row)||row.refreshStartedAt||!row.refreshLeaseExpiresAt||row.refreshLeaseExpiresAt<=observed.now)return busy;
    await tx.zoomConnection.update({where:{id:row.id},data:{refreshStartedAt:observed.now}});
    return {started:true};
  });
  if("error" in started)throw new ZoomTokenRefreshError(started.error);
  let replacement:ZoomTokenReplacement|undefined;
  try{replacement=await options.exchange(claim.row);}catch{/* A missing ACK cannot prove that the provider kept its old refresh token. */}
  const outcome=await db.$transaction(async tx=>{
    const observed=await clock(tx),row=await locked(tx,options.connectionId);
    if(!row||row.revokedAt||row.refreshOutcomeUnknown)return unavailable;
    if(observed.epoch!==claim.epoch||row.refreshClaimId!==claim.owner||!same(row,claim.row))return busy;
    if(!replacement||!replacement.accessTokenEncrypted||!replacement.refreshTokenEncrypted||!Number.isFinite(replacement.expiresInSeconds)||replacement.expiresInSeconds<=0||!row.refreshStartedAt||!row.refreshLeaseExpiresAt||row.refreshLeaseExpiresAt<=observed.now)return unknown(tx,row.id);
    const stored=await tx.zoomConnection.update({where:{id:row.id},data:{accessTokenEncrypted:replacement.accessTokenEncrypted,refreshTokenEncrypted:replacement.refreshTokenEncrypted,expiresAt:new Date(observed.now.getTime()+replacement.expiresInSeconds*1000),scopes:replacement.scopes,refreshClaimId:null,refreshLeaseExpiresAt:null,refreshStartedAt:null}});
    return {row:stored};
  });
  if("error" in outcome)throw new ZoomTokenRefreshError(outcome.error!);
  return outcome.row!;
}
