import { getPrismaClient } from "@narriflow/db/client";
import { assistedSocialCopyService } from "./assisted-social-copy-runtime";
import { clipExportService } from "./clip-export.service";
import { publishingQueue } from "./publishing-queue.service";
import { createGenerationFinishing, readProjectFinishing, type GenerationFinishingDependencies } from "./generation-finishing";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { acceptProposalUnderGrant, sendReviewRoundUnderGrant } from "./standing-grant-runtime";
import { workspaceService } from "./workspace.service";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("DATABASE_URL is required for finishing");
  return prisma;
}

/** Fresh runtime wiring for one targeted Finishing command. */
export function getGenerationFinishing(notify: GenerationFinishingDependencies["notify"]) {
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
    createExport: (scope, projectId, clipId, input, key) => clipExportService.create(scope, projectId, clipId, input, key),
    retryExport: (scope, projectId, clipId, exportId) => clipExportService.retryFailed(scope, projectId, clipId, exportId),
    writeCopy: (input) => assistedSocialCopyService.generate(input),
    queueAccounts: (workspaceId, accountIds) => publishingQueue.activeAccounts(workspaceId, accountIds),
    propose: (input) => publishingQueue.propose(
      { actorUserId: input.actorUserId, workspaceId: input.workspaceId },
      { clipId: input.clipId, exportId: input.exportId, socialAccountId: input.socialAccountId },
      { source: "finishing", copyGenerationId: input.copyGenerationId, mutation: { clientIdempotencyKey: input.idempotencyKey } },
    ),
    acceptUnderGrant: acceptProposalUnderGrant,
    sendReviewRound: sendReviewRoundUnderGrant,
    notify,
  });
}

/** The newest finishing on a Project, for its page. */
export function getProjectFinishing(scope: { workspaceId: string; projectId: string }) {
  return readProjectFinishing(requirePrisma(), scope);
}
