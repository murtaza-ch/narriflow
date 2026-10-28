import { reviewNotificationService, reviewService } from "@narriflow/services";
import {
  createReviewRoundSchema,
  internalReviewCommentSchema,
  inviteReviewersSchema,
  resolvePricingTier,
  retryReviewNotificationSchema,
  workspaceAllowsCapability,
} from "@narriflow/validators";
import { createRouteApp, getActor } from "../../http/admission";
import { validate } from "../../http/route";
import { uuidParams } from "../platform/params";
import { reviewsAdmission as access } from "./admission";

/** Services the reviews routes call. `runtime.ts` supplies the production instances. */
export interface ReviewsRouteDeps {
  reviewService: typeof reviewService;
  reviewNotificationService: typeof reviewNotificationService;
}

/** Internal (signed-in) review rounds. Guest, share and opt-out routes are added by the review owner. */
export function createReviewsRoutes(deps: ReviewsRouteDeps) {
  const { reviewService, reviewNotificationService } = deps;

  return createRouteApp(access)
    .post(
      "/projects/:id/review-rounds",
      uuidParams("id"),
      validate("json", createReviewRoundSchema),
      async (c) => {
        const appUser = getActor(c);
        return c.json(
          await reviewService.createRound(
            {
              actorUserId: appUser.actorUserId,
              workspaceId: appUser.workspaceId,
              projectId: c.req.valid("param").id,
              pricingTier: resolvePricingTier(appUser.pricingTier),
            },
            c.req.valid("json"),
          ),
          201,
        );
      },
    )

    .get(
      "/projects/:id/review-rounds",
      uuidParams("id"),
      async (c) => {
        const appUser = getActor(c);
        const manage = workspaceAllowsCapability(
          { role: appUser.role, status: appUser.status },
          "review.manage",
        );
        return c.json(
          await reviewService.internalRoom(
            appUser.workspaceId,
            c.req.valid("param").id,
            manage ? "manage" : "view",
          ),
          200,
        );
      },
    )

    .post(
      "/projects/:id/review-rounds/:roundId/invite",
      uuidParams("id", "roundId"),
      validate("json", inviteReviewersSchema),
      async (c) => {
        const appUser = getActor(c);
        const { id, roundId } = c.req.valid("param");
        return c.json(
          await reviewService.inviteReviewers(
            {
              actorUserId: appUser.actorUserId,
              workspaceId: appUser.workspaceId,
              projectId: id,
              pricingTier: resolvePricingTier(appUser.pricingTier),
            },
            roundId,
            c.req.valid("json"),
          ),
          200,
        );
      },
    )

    .post(
      "/projects/:id/review-rounds/:roundId/comments",
      uuidParams("id", "roundId"),
      validate("json", internalReviewCommentSchema),
      async (c) => {
        const appUser = getActor(c);
        const { id, roundId } = c.req.valid("param");
        return c.json(
          await reviewService.addInternalComment(
            { actorUserId: appUser.actorUserId, workspaceId: appUser.workspaceId, projectId: id },
            roundId,
            c.req.valid("json"),
          ),
          201,
        );
      },
    )

    .post(
      "/projects/:id/review-rounds/:roundId/comments/:commentId/resolve",
      uuidParams("id", "roundId", "commentId"),
      async (c) => {
        const appUser = getActor(c);
        const { id, roundId, commentId } = c.req.valid("param");
        return c.json(
          await reviewService.resolveComment(
            { actorUserId: appUser.actorUserId, workspaceId: appUser.workspaceId, projectId: id },
            roundId,
            commentId,
            true,
          ),
          200,
        );
      },
    )

    .post(
      "/projects/:id/review-rounds/:roundId/comments/:commentId/reopen",
      uuidParams("id", "roundId", "commentId"),
      async (c) => {
        const appUser = getActor(c);
        const { id, roundId, commentId } = c.req.valid("param");
        return c.json(
          await reviewService.resolveComment(
            { actorUserId: appUser.actorUserId, workspaceId: appUser.workspaceId, projectId: id },
            roundId,
            commentId,
            false,
          ),
          200,
        );
      },
    )

    .post(
      "/projects/:id/review-rounds/:roundId/notifications/retry",
      uuidParams("id", "roundId"),
      validate("json", retryReviewNotificationSchema),
      async (c) => {
        const appUser = getActor(c);
        const { id, roundId } = c.req.valid("param");
        const result = await reviewNotificationService.retry(
          { workspaceId: appUser.workspaceId, projectId: id },
          roundId,
          c.req.valid("json").ledgerId,
        );
        return result.retrying
          ? c.json(result, 200)
          : c.json(
              {
                error: "review_notification_not_found",
                message: "Failed notification was not found",
              },
              404,
            );
      },
    )

    .post(
      "/projects/:id/review-rounds/:roundId/revoke",
      uuidParams("id", "roundId"),
      async (c) => {
        const appUser = getActor(c);
        const { id, roundId } = c.req.valid("param");
        return c.json(
          await reviewService.revokeRound(
            { actorUserId: appUser.actorUserId, workspaceId: appUser.workspaceId, projectId: id },
            roundId,
          ),
          200,
        );
      },
    );
}

export type ReviewsRoutes = ReturnType<typeof createReviewsRoutes>;
