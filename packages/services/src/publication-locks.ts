import type { Prisma } from "@prisma/client";

/** The same order applies to API scheduling, callbacks and executor commands.
 * Shared owner rows serialize revocation/purge without blocking foreign keys. */
export async function lockPublicationScope(tx:Prisma.TransactionClient,scope:{workspaceId:string|null;projectId:string;socialAccountId:string|null}){
 if(scope.workspaceId)await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id"=${scope.workspaceId}::uuid FOR SHARE`;
 await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${scope.projectId}::uuid FOR SHARE`;
 if(scope.socialAccountId)await tx.$queryRaw`SELECT "id" FROM "SocialAccount" WHERE "id"=${scope.socialAccountId}::uuid FOR SHARE`;
}
export async function lockPublicationPost(tx: Prisma.TransactionClient, postId:string){
 const row=await tx.socialPost.findUnique({where:{id:postId},select:{workspaceId:true,projectId:true,socialAccountId:true}});
 if(!row)return null;
 await lockPublicationScope(tx,row);
 await tx.$queryRaw`SELECT "id" FROM "SocialPost" WHERE "id"=${postId}::uuid FOR UPDATE`;
 return row;
}
/** Domain rows precede the generic ExecutionAttempt lock. */
export async function lockPublicationAttempt(tx: Prisma.TransactionClient, attemptId: string) {
 const row=await tx.socialPublicationAttempt.findUnique({where:{id:attemptId},select:{socialPostId:true}});
 if(!row)return null;
 await lockPublicationPost(tx,row.socialPostId);
 await tx.$queryRaw`SELECT "id" FROM "SocialPublicationAttempt" WHERE "id"=${attemptId}::uuid FOR UPDATE`;
 return row.socialPostId;
}
