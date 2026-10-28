import {
  assistedSocialCopyService,
  PlanRequirementError,
  SocialOAuthError,
  socialOAuthService,
} from "@narriflow/services";
import { generateAssistedCopySchema, socialPlatformSchema } from "@narriflow/validators";
import { createRouteApp, getActor } from "../../http/admission";
import { validate } from "../../http/route";
import { uuidParams } from "../platform/params";
import { publishingAdmission as access } from "./admission";
import { safeSocialRedirectPath } from "./redirect";

/** Services and origins the publishing routes use. `runtime.ts` supplies the production values. */
export interface PublishingRouteDeps {
  socialOAuthService: typeof socialOAuthService;
  assistedSocialCopyService: typeof assistedSocialCopyService;
  /** Origin providers call back to (the API). Used to build the provider redirect URI. */
  callbackOrigin: string;
  /** Origin humans return to (the web app). Used for every browser redirect. */
  webOrigin: string;
}

const FACEBOOK_SELECTION_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

/** Assisted copy and native social-account OAuth. Posts, calendar and proposals are added by the publishing owner. */
export function createPublishingRoutes(deps: PublishingRouteDeps) {
  const { socialOAuthService, assistedSocialCopyService, callbackOrigin, webOrigin } = deps;

  return createRouteApp(access)
    .post(
      "/projects/:id/assisted-copy/generations",
      uuidParams("id"),
      validate("json", generateAssistedCopySchema),
      async (c) => {
        const appUser = getActor(c);
        return c.json(
          await assistedSocialCopyService.generate({
            actorUserId: appUser.actorUserId,
            workspaceId: appUser.workspaceId,
            projectId: c.req.valid("param").id,
            ...c.req.valid("json"),
          }),
          201,
        );
      },
    )

    .get("/social/accounts", async (c) => {
      const accounts = await socialOAuthService.listAccounts(getActor(c));
      return c.json({ accounts }, 200);
    })

    .get(
      "/social/oauth/start/:platform",
      async (c) => {
        const platform = socialPlatformSchema.safeParse(c.req.param("platform"));
        if (!platform.success) {
          return c.json({ error: "invalid_input", message: "Unsupported social platform" }, 400);
        }
        const redirectPath = safeSocialRedirectPath(c.req.query("redirect"));
        try {
          const url = await socialOAuthService.createAuthorizationUrl(getActor(c), {
            platform: platform.data,
            origin: callbackOrigin,
            redirectPath,
          });
          return c.redirect(url, 302);
        } catch (error) {
          if (!(error instanceof SocialOAuthError)) throw error;
          const redirect = new URL(redirectPath, webOrigin);
          redirect.searchParams.set("error", error.code);
          return c.redirect(redirect.toString(), 302);
        }
      },
    )

    // Provider navigation carries no session: identity comes from the stored
    // one-use OAuth state, never from a Clerk token.
    .get(
      "/social/oauth/callback",
      async (c) => {
        const redirect = new URL("/settings/social-accounts", webOrigin);
        const code = c.req.query("code");
        const state = c.req.query("state");
        const providerError = c.req.query("error");
        if (providerError) {
          redirect.searchParams.set("error", providerError);
          return c.redirect(redirect.toString(), 302);
        }
        if (!code || !state) {
          redirect.searchParams.set("error", "social_oauth_callback_missing");
          return c.redirect(redirect.toString(), 302);
        }
        try {
          const result = await socialOAuthService.handleCallback({
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
      },
    )

    .get(
      "/social/oauth/facebook-selection/:token",
      async (c) => {
        const token = c.req.param("token");
        if (!FACEBOOK_SELECTION_TOKEN.test(token)) {
          return c.json({ error: "social_facebook_selection_invalid" }, 400);
        }
        try {
          return c.json(
            { pages: await socialOAuthService.getFacebookPageSelection(getActor(c), token) },
            200,
          );
        } catch (error) {
          const isKnown = error instanceof SocialOAuthError;
          return c.json(
            {
              error: isKnown ? error.code : "social_facebook_selection_failed",
              message: isKnown ? error.message : "Facebook Pages could not be loaded",
            },
            400,
          );
        }
      },
    )

    .post(
      "/social/oauth/facebook-selection/:token",
      async (c) => {
        const token = c.req.param("token");
        const payload = (await c.req.json().catch(() => null)) as { pageId?: unknown } | null;
        if (
          !FACEBOOK_SELECTION_TOKEN.test(token) ||
          typeof payload?.pageId !== "string" ||
          payload.pageId.length > 200
        ) {
          return c.json({ error: "invalid_input" }, 400);
        }
        try {
          const account = await socialOAuthService.completeFacebookPageSelection(
            getActor(c),
            token,
            payload.pageId,
          );
          return c.json({ account }, 201);
        } catch (error) {
          if (error instanceof PlanRequirementError) {
            return c.json(
              { error: error.code, message: error.message, details: error.details },
              402,
            );
          }
          const isKnown = error instanceof SocialOAuthError;
          return c.json(
            {
              error: isKnown ? error.code : "social_facebook_selection_failed",
              message: isKnown ? error.message : "Facebook Page could not be connected",
            },
            400,
          );
        }
      },
    )

    .delete(
      "/social/accounts/:accountId",
      async (c) => {
        await socialOAuthService.disconnectAccount(getActor(c), c.req.param("accountId"));
        return c.json({ ok: true }, 200);
      },
    );
}

export type PublishingRoutes = ReturnType<typeof createPublishingRoutes>;
