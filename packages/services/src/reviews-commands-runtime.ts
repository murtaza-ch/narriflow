import { getPrismaClient } from "@narriflow/db/client";
import { getOperationReceiptExecutor } from "./operation-receipt-runtime";
import { requirePlanFeature } from "./plan-features";
import { accessibleProjectWhere } from "./project-access";
import { createReviewNotificationStore } from "./review-notification.service";
import { createReviewsCommands } from "./reviews-commands";
import { decryptReviewValue, encryptReviewValue, reviewDeliverySecret, reviewService, ReviewServiceError } from "./review.service";
import { workspaceService } from "./workspace.service";

// Resolve the singleton lazily so importing the HTTP app does not require a database.
export const reviewsCommands = createReviewsCommands({
  receipts: { execute: (input) => getOperationReceiptExecutor().execute(input) },
  service: reviewService,
  async authorize(scope, command) {
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "review.manage");
    if (command === "create_review_round" || command === "invite_reviewers") requirePlanFeature(actor.pricingTier, "review.rooms");
    const project = await getPrismaClient()?.project.findFirst({ where: { id: scope.projectId, workspaceId: scope.workspaceId, ...accessibleProjectWhere() }, select: { id: true } });
    if (!project) throw new ReviewServiceError("review_project_not_found", "Project was not found");
  },
  retry: async (tx, scope, roundId, ledgerId) => ({ retrying: await createReviewNotificationStore(tx).retry(scope, roundId, ledgerId, new Date()) }),
  protect: (value) => encryptReviewValue(JSON.stringify(value), reviewDeliverySecret()),
  reveal: (value) => JSON.parse(decryptReviewValue(value, reviewDeliverySecret())) as unknown,
});
