import type {
  assistedSocialCopyService,
  bulkSocialSchedulingService,
  performanceService,
  publishingQueue,
  refreshTikTokInbox,
  socialOAuthService,
  socialPublishingOptions,
  SocialService,
  workspaceLibraryService,
  workspaceService,
} from "@narriflow/services";
import { PlanRequirementError, SocialOAuthError } from "@narriflow/services";
import {
  acceptSocialPostProposalSchema,
  bulkSocialScheduleSchema,
  confirmSocialPublicationSchema,
  generateAssistedCopySchema,
  proposeSocialPostSchema,
  publishingPreviewSchema,
  recheckSocialPublicationSchema,
  republishSocialPublicationSchema,
  socialPlatformSchema,
  updateSocialPostProposalSchema,
  workspaceAllowsCapability,
} from "@narriflow/validators";
import {
  acceptAllProposalsRequestSchema,
  calendarPostsQuerySchema,
  completeFacebookPageSelectionSchema,
  composerOptionsQuerySchema,
  facebookSelectionTokenParamSchema,
  projectSocialPostsQuerySchema,
  publishingCalendarQuerySchema,
  savePostingScheduleRequestSchema,
  socialOAuthStartRequestSchema,
} from "@narriflow/validators/api/publishing";
import { z } from "zod";
import { createRouteApp, getActor, getRecordedRateLimit } from "../../http/admission";
import { getIdempotencyKey, requireIdempotencyKey } from "../../http/idempotency";
import { enforceRecordedRateLimit } from "../../http/limits";
import type { ApiEnv } from "../../http/env";
import { validate } from "../../http/route";
import type { Context } from "hono";
import { uuidParams } from "../platform/params";
import { publishingAdmission as access } from "./admission";
import { socialOAuthFailure } from "./oauth-failure";
import { safeSocialRedirectPath } from "./redirect";
import { paddedCalendarWindow, performanceEmptyNextStep } from "./screens";

/** Services and origins the publishing routes use. `runtime.ts` supplies the production values. */
export interface PublishingRouteDeps {
  socialOAuthService: Pick<
    typeof socialOAuthService,
    | "listAccounts"
    | "createAuthorizationUrl"
    | "handleCallback"
    | "getFacebookPageSelection"
    | "completeFacebookPageSelection"
    | "disconnectAccount"
  >;
  assistedSocialCopyService: typeof assistedSocialCopyService;
  socialService: Pick<
    SocialService,
    | "listProjectPosts"
    | "cancelPost"
    | "inspectPublication"
    | "recheckPublication"
    | "confirmPublication"
    | "republishPublication"
  >;
  bulkSocialSchedulingService: Pick<typeof bulkSocialSchedulingService, "preview" | "schedule">;
  publishingQueue: Pick<
    typeof publishingQueue,
    | "propose"
    | "listProposals"
    | "countProposals"
    | "updateProposalCaption"
    | "reject"
    | "accept"
    | "acceptAll"
    | "setPostingSchedule"
    | "getPostingSchedule"
  >;
  performanceService: Pick<typeof performanceService, "whatWorked" | "guidance">;
  workspaceLibraryService: Pick<
    typeof workspaceLibraryService,
    "listCalendarPosts" | "getCalendarFilters" | "getCalendarComposerOptions"
  >;
  workspaceService: Pick<typeof workspaceService, "getWorkspace">;
  socialPublishingOptions: typeof socialPublishingOptions;
  refreshTikTokInbox: typeof refreshTikTokInbox;
  /** Origin providers call back to (the API). Used to build the provider redirect URI. */
  callbackOrigin: string;
  /** Origin humans return to (the web app). Used for every browser redirect. */
  webOrigin: string;
}

const accountParams = uuidParams("accountId");
const proposalParams = uuidParams("proposalId");
const postParams = uuidParams("id", "postId");
const platformParams = z.object({ platform: socialPlatformSchema });

/** The receipt facts of a retryable command: its key, and the limiter outcome enforced only for new work. */
function mutationOf(c: Context<ApiEnv>) {
  return {
    clientIdempotencyKey: getIdempotencyKey(c),
    beforeAccept: async () => enforceRecordedRateLimit(getRecordedRateLimit(c)),
    onReplay: () => c.header("Idempotent-Replayed", "true"),
  };
}

/** Social accounts and OAuth, the publishing queue, post publication and recovery, and the publishing screens' reads. */
export function createPublishingRoutes(deps: PublishingRouteDeps) {
  const { callbackOrigin, webOrigin } = deps;

  async function timezoneOf(actor: { actorUserId: string; workspaceId: string }) {
    return (await deps.workspaceService.getWorkspace(actor.actorUserId, actor.workspaceId))?.timezone ?? "UTC";
  }

  return createRouteApp(access)
    .post(
      "/projects/:id/assisted-copy/generations",
      uuidParams("id"),
      validate("json", generateAssistedCopySchema),
      async (c) => {
        const appUser = getActor(c);
        return c.json(
          await deps.assistedSocialCopyService.generate({
            actorUserId: appUser.actorUserId,
            workspaceId: appUser.workspaceId,
            projectId: c.req.valid("param").id,
            ...c.req.valid("json"),
          }),
          201,
        );
      },
    )

    // Social accounts and OAuth ------------------------------------------------

    .get("/social/accounts", async (c) => {
      const accounts = await deps.socialOAuthService.listAccounts(getActor(c));
      return c.json({ accounts }, 200);
    })

    .post(
      "/social/oauth/start/:platform",
      validate("param", platformParams),
      validate("json", socialOAuthStartRequestSchema),
      async (c) => {
        const authorizationUrl = await deps.socialOAuthService
          .createAuthorizationUrl(getActor(c), {
            platform: c.req.valid("param").platform,
            origin: callbackOrigin,
            redirectPath: safeSocialRedirectPath(c.req.valid("json").redirect),
          })
          .catch((error: unknown) => {
            throw socialOAuthFailure(error);
          });
        return c.json({ authorizationUrl }, 200);
      },
    )

    // Provider navigation carries no session: identity comes from the stored
    // one-use OAuth state, never from a Clerk token.
    .get("/social/oauth/callback", async (c) => {
      const redirect = new URL("/settings/social-accounts", webOrigin);
      const code = c.req.query("code");
      const state = c.req.query("state");
      const providerError = c.req.query("error");
      if (providerError) {
        redirect.searchParams.set("error", providerError.slice(0, 100));
        return c.redirect(redirect.toString(), 302);
      }
      if (!code || !state) {
        redirect.searchParams.set("error", "social_oauth_callback_missing");
        return c.redirect(redirect.toString(), 302);
      }
      try {
        const result = await deps.socialOAuthService.handleCallback({
          state,
          code,
          origin: callbackOrigin,
        });
        const successRedirect = new URL(safeSocialRedirectPath(result.redirectPath), webOrigin);
        if (result.facebookSelectionToken) {
          successRedirect.searchParams.set("facebook_selection", result.facebookSelectionToken);
        } else {
          successRedirect.searchParams.set("connected", String(result.accounts.length));
        }
        return c.redirect(successRedirect.toString(), 302);
      } catch (error) {
        redirect.searchParams.set(
          "error",
          error instanceof SocialOAuthError || error instanceof PlanRequirementError
            ? error.code
            : "social_oauth_callback_failed",
        );
        return c.redirect(redirect.toString(), 302);
      }
    })

    .get(
      "/social/oauth/facebook-selection/:token",
      validate("param", facebookSelectionTokenParamSchema),
      async (c) => {
        const pages = await deps.socialOAuthService
          .getFacebookPageSelection(getActor(c), c.req.valid("param").token)
          .catch((error: unknown) => {
            throw socialOAuthFailure(error);
          });
        return c.json({ pages }, 200);
      },
    )

    .post(
      "/social/oauth/facebook-selection/:token",
      validate("param", facebookSelectionTokenParamSchema),
      validate("json", completeFacebookPageSelectionSchema),
      async (c) => {
        const account = await deps.socialOAuthService
          .completeFacebookPageSelection(getActor(c), c.req.valid("param").token, c.req.valid("json").pageId)
          .catch((error: unknown) => {
            throw socialOAuthFailure(error);
          });
        return c.json({ account }, 201);
      },
    )

    .delete("/social/accounts/:accountId", accountParams, async (c) => {
      await deps.socialOAuthService.disconnectAccount(getActor(c), c.req.valid("param").accountId);
      return c.json({ ok: true }, 200);
    })

    .get("/social/accounts/:accountId/posting-schedule", accountParams, async (c) => {
      const schedule = await deps.publishingQueue.getPostingSchedule(getActor(c), c.req.valid("param").accountId);
      return c.json({ schedule }, 200);
    })

    .put(
      "/social/accounts/:accountId/posting-schedule",
      accountParams,
      validate("json", savePostingScheduleRequestSchema),
      async (c) => {
        const schedule = await deps.publishingQueue.setPostingSchedule(
          getActor(c),
          c.req.valid("param").accountId,
          c.req.valid("json").schedule,
        );
        return c.json({ schedule }, 200);
      },
    )

    .get("/social/accounts/:accountId/tiktok-options", accountParams, async (c) => {
      const options = await deps.socialPublishingOptions(getActor(c), c.req.valid("param").accountId);
      return c.json(
        {
          directEnabled: options.directEnabled,
          inboxEnabled: options.inboxEnabled,
          privacyOptions: options.privacyOptions,
          commentDisabled: options.commentDisabled,
          duetDisabled: options.duetDisabled,
          stitchDisabled: options.stitchDisabled,
        },
        200,
      );
    })

    // Queue proposals ----------------------------------------------------------

    .post(
      "/social/proposals",
      requireIdempotencyKey(),
      validate("json", proposeSocialPostSchema),
      async (c) => {
        const { proposal, replayed } = await deps.publishingQueue.propose(getActor(c), c.req.valid("json"), {
          source: "person",
          mutation: mutationOf(c),
        });
        if (replayed) c.header("Idempotent-Replayed", "true");
        return c.json({ proposalId: proposal.proposalId }, replayed ? 200 : 201);
      },
    )

    .post("/social/proposals/accept-all", validate("json", acceptAllProposalsRequestSchema), async (c) => {
      const result = await deps.publishingQueue.acceptAll(getActor(c), { after: c.req.valid("json").after });
      return c.json(result, 200);
    })

    .patch(
      "/social/proposals/:proposalId",
      proposalParams,
      validate("json", updateSocialPostProposalSchema),
      async (c) => {
        await deps.publishingQueue.updateProposalCaption(
          getActor(c),
          c.req.valid("param").proposalId,
          c.req.valid("json").caption,
        );
        return c.json({ ok: true }, 200);
      },
    )

    .post("/social/proposals/:proposalId/reject", proposalParams, async (c) => {
      await deps.publishingQueue.reject(getActor(c), c.req.valid("param").proposalId);
      return c.json({ ok: true }, 200);
    })

    .post(
      "/social/proposals/:proposalId/accept",
      proposalParams,
      validate("json", acceptSocialPostProposalSchema),
      async (c) => {
        const accepted = await deps.publishingQueue.accept(
          getActor(c),
          c.req.valid("param").proposalId,
          c.req.valid("json"),
        );
        return c.json({ accepted: [accepted], skippedTikTok: 0, failed: [] }, 200);
      },
    )

    // Screen aggregates and reads ----------------------------------------------

    .get("/publishing/calendar", validate("query", publishingCalendarQuerySchema), async (c) => {
      const actor = getActor(c);
      const query = c.req.valid("query");
      const [posts, timezone, filters, proposalCount] = await Promise.all([
        deps.workspaceLibraryService.listCalendarPosts(actor, {
          ...paddedCalendarWindow(query),
          status: query.status,
          platform: query.platform,
          accountId: query.account,
          projectId: query.project,
        }),
        timezoneOf(actor),
        deps.workspaceLibraryService.getCalendarFilters(actor),
        deps.publishingQueue.countProposals(actor),
      ]);
      return c.json(
        { posts, timezone, filters, proposalCount, canPublish: workspaceAllowsCapability(actor, "publishing.manage") },
        200,
      );
    })

    .get("/publishing/queue", async (c) => {
      const actor = getActor(c);
      const [proposals, accounts, timezone] = await Promise.all([
        deps.publishingQueue.listProposals(actor),
        deps.socialOAuthService.listAccounts(actor),
        timezoneOf(actor),
      ]);
      return c.json(
        {
          proposals,
          accounts,
          timezone,
          canManage: workspaceAllowsCapability(actor, "publishing.manage"),
          canConnect: workspaceAllowsCapability(actor, "social.manage"),
        },
        200,
      );
    })

    .get("/publishing/proposals", async (c) => {
      return c.json({ proposals: await deps.publishingQueue.listProposals(getActor(c)) }, 200);
    })

    .get("/publishing/proposals/count", async (c) => {
      return c.json({ count: await deps.publishingQueue.countProposals(getActor(c)) }, 200);
    })

    .get("/workspace/calendar/posts", validate("query", calendarPostsQuerySchema), async (c) => {
      const query = c.req.valid("query");
      const posts = await deps.workspaceLibraryService.listCalendarPosts(getActor(c), {
        from: query.from,
        to: query.to,
        status: query.status,
        platform: query.platform,
        accountId: query.account,
        projectId: query.project,
      });
      return c.json({ posts }, 200);
    })

    .get("/workspace/calendar/filters", async (c) => {
      return c.json(await deps.workspaceLibraryService.getCalendarFilters(getActor(c)), 200);
    })

    .get(
      "/workspace/calendar/composer-options",
      validate("query", composerOptionsQuerySchema),
      async (c) => {
        const { q, cursor } = c.req.valid("query");
        return c.json(
          await deps.workspaceLibraryService.getCalendarComposerOptions(getActor(c), { query: q, cursor }),
          200,
        );
      },
    )

    .get("/performance/what-worked", async (c) => {
      const actor = getActor(c);
      const [summary, accounts] = await Promise.all([
        deps.performanceService.whatWorked(actor),
        deps.socialOAuthService.listAccounts(actor),
      ]);
      return c.json({ summary, emptyNextStep: performanceEmptyNextStep(actor, accounts) }, 200);
    })

    .get("/performance/guidance", async (c) => {
      return c.json({ guidance: await deps.performanceService.guidance(getActor(c)) }, 200);
    })

    // Project publishing -------------------------------------------------------

    .post(
      "/projects/:id/campaign-operations/schedule/preview",
      uuidParams("id"),
      validate("json", publishingPreviewSchema),
      async (c) => {
        const actor = getActor(c);
        return c.json(
          await deps.bulkSocialSchedulingService.preview(actor.actorUserId, actor.workspaceId, c.req.valid("json")),
          200,
        );
      },
    )

    .post(
      "/projects/:id/campaign-operations/schedule",
      uuidParams("id"),
      validate("json", bulkSocialScheduleSchema),
      async (c) => {
        const actor = getActor(c);
        return c.json(
          await deps.bulkSocialSchedulingService.schedule({
            actorUserId: actor.actorUserId,
            workspaceId: actor.workspaceId,
            projectId: c.req.valid("param").id,
            value: c.req.valid("json"),
          }),
          201,
        );
      },
    )

    .get(
      "/projects/:id/social-accounts/:accountId/publishing-options",
      uuidParams("id", "accountId"),
      async (c) => {
        return c.json(await deps.socialPublishingOptions(getActor(c), c.req.valid("param").accountId), 200);
      },
    )

    .post("/projects/:id/social-posts/:postId/refresh-inbox", postParams, async (c) => {
      const { id, postId } = c.req.valid("param");
      return c.json(await deps.refreshTikTokInbox(getActor(c), id, postId), 200);
    })

    .get(
      "/projects/:id/social-posts",
      uuidParams("id"),
      validate("query", projectSocialPostsQuerySchema),
      async (c) => {
        const { active, tracked, cursor } = c.req.valid("query");
        const page = await deps.socialService.listProjectPosts(getActor(c), c.req.valid("param").id, {
          activeOnly: active === "1",
          trackedIds: (tracked ?? "").split(",").filter(Boolean),
          cursor,
        });
        return c.json({ posts: page.items, nextCursor: page.nextCursor }, 200);
      },
    )

    .delete("/projects/:id/social-posts/:postId", postParams, async (c) => {
      const { id, postId } = c.req.valid("param");
      return c.json(await deps.socialService.cancelPost(getActor(c), id, postId), 200);
    })

    .get("/projects/:id/social-posts/:postId/publication", postParams, async (c) => {
      const { id, postId } = c.req.valid("param");
      return c.json(await deps.socialService.inspectPublication(getActor(c), postId, id), 200);
    })

    // Recovery commands are receipt-backed: a retry with the same key returns the
    // first outcome, and an exhausted or unavailable limiter refuses only new work.
    .post(
      "/projects/:id/social-posts/:postId/recheck",
      requireIdempotencyKey(),
      postParams,
      validate("json", recheckSocialPublicationSchema),
      async (c) => {
        const { id, postId } = c.req.valid("param");
        return c.json(
          await deps.socialService.recheckPublication(getActor(c), postId, c.req.valid("json"), id, mutationOf(c)),
          200,
        );
      },
    )

    .post(
      "/projects/:id/social-posts/:postId/confirm",
      requireIdempotencyKey(),
      postParams,
      validate("json", confirmSocialPublicationSchema),
      async (c) => {
        const { id, postId } = c.req.valid("param");
        return c.json(
          await deps.socialService.confirmPublication(getActor(c), postId, c.req.valid("json"), id, mutationOf(c)),
          200,
        );
      },
    )

    .post(
      "/projects/:id/social-posts/:postId/publish-again",
      requireIdempotencyKey(),
      postParams,
      validate("json", republishSocialPublicationSchema),
      async (c) => {
        const { id, postId } = c.req.valid("param");
        return c.json(
          await deps.socialService.republishPublication(getActor(c), postId, c.req.valid("json"), id, mutationOf(c)),
          201,
        );
      },
    );
}

export type PublishingRoutes = ReturnType<typeof createPublishingRoutes>;
