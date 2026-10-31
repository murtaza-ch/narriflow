import {appendProjectNotificationIntent} from "./notification-execution";
import type { Prisma } from "@prisma/client";
import type { WorkspaceCapability } from "@narriflow/validators";
import { getPrismaClient } from "@narriflow/db/client";
import { assistedSocialCopyService } from "./assisted-social-copy-runtime";
import { clipExportService } from "./clip-export.service";
import { publishingQueue } from "./publishing-queue.service";
import { assertGenerationFinishingAuthority, createGenerationFinishing, readProjectFinishing, type FinishingWorkAuthority } from "./generation-finishing";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { acceptProposalUnderGrant, sendReviewRoundUnderGrant } from "./standing-grant-runtime";
import { workspaceService } from "./workspace.service";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("DATABASE_URL is required for finishing");
  return prisma;
}

function childFence(authority: FinishingWorkAuthority, scope: {workspaceId:string;projectId:string;actorUserId?:string;clipId?:string;capability?:WorkspaceCapability}) {
  return (tx: Prisma.TransactionClient) => assertGenerationFinishingAuthority(tx,authority,scope);
}

/** Fresh runtime wiring for one targeted Finishing command. */
export function getGenerationFinishing() {
  return createGenerationFinishing({
    prisma: requirePrisma(),
    register: deliverExecutionDispatches,
    requireActor: (userId, workspaceId) => workspaceService.requireActor(userId, workspaceId, "processing.consume"),
    canManagePublishing: (userId, workspaceId) =>
      workspaceService.requireActor(userId, workspaceId, "publishing.manage").then(
        () => true,
        (error) => {
          if (error instanceof ExpectedDomainFailureError) return false;
          throw error;
        },
      ),
    createExport: (scope, projectId, clipId, input, key, authority) => clipExportService.create(scope, projectId, clipId, input, key, {clientIdempotencyKey:key,beforeMutation:childFence(authority,{...scope,projectId,clipId})}),
    retryExport: (scope, projectId, clipId, exportId, authority) => clipExportService.retryFailed(scope, projectId, clipId, exportId, childFence(authority,{...scope,projectId,clipId})),
    writeCopy: (input, authority) => assistedSocialCopyService.generate(input,{beforeWrite:childFence(authority,input)}),
    queueAccounts: (workspaceId, accountIds) => publishingQueue.activeAccounts(workspaceId, accountIds),
    propose: async (input, authority) => {
      const finishing=await requirePrisma().generationFinishing.findUniqueOrThrow({where:{id:authority.reference.subject.id},select:{projectId:true}});
      return publishingQueue.propose(
      { actorUserId: input.actorUserId, workspaceId: input.workspaceId },
      { clipId: input.clipId, exportId: input.exportId, socialAccountId: input.socialAccountId },
      { source: "finishing", copyGenerationId: input.copyGenerationId, mutation: { clientIdempotencyKey: input.idempotencyKey, beforeMutation:childFence(authority,{...input,projectId:finishing.projectId,capability:"publishing.manage"}) } },
    ); },
    acceptUnderGrant: (input,authority) => acceptProposalUnderGrant(input,{beforeWrite:childFence(authority,{...input,capability:"publishing.manage"})}),
    sendReviewRound: (input,authority) => sendReviewRoundUnderGrant(input,{beforeWrite:childFence(authority,input)}),
    notify: async (input,authority,tx) => {
      if(input.sourceId!==authority.reference.subject.id)throw Error("finishing_notification_identity_invalid");
      // The owner and current Project are locked by final settlement.
      await appendProjectNotificationIntent(tx,{...input,outcome:"finishing_ready"});
    },
  });
}

/** The newest finishing on a Project, for its page. */
export function getProjectFinishing(scope: { workspaceId: string; projectId: string }) {
  return readProjectFinishing(requirePrisma(), scope);
}
