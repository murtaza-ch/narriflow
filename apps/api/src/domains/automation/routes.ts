import {
  type AutomationCommands,
  type ZoomService,
  ZoomError,
  autopilotService,
  recipeService,
  socialOAuthService,
  standingGrants,
} from "@narriflow/services";
import {
  autopilotRuleInputSchema,
  autopilotRuleUpdateSchema,
  createStandingGrantSchema,
  renewStandingGrantRequestSchema,
  standingGrantReferenceSchema,
} from "@narriflow/validators/api/automation";
import { createRouteApp, getActor, getRecordedRateLimit } from "../../http/admission";
import { getIdempotencyKey, requireIdempotencyKey } from "../../http/idempotency";
import { enforceRecordedRateLimit } from "../../http/limits";
import { validate } from "../../http/route";
import { uuidParams } from "../platform/params";
import { automationAdmission as access } from "./admission";
import { readAutomation, readStandingGrants } from "./read-models";

/** Services the automation routes call. `runtime.ts` supplies the production instances. */
export interface AutomationRouteDeps {
  autopilotService: Pick<
    typeof autopilotService,
    "listRules" | "updateRule" | "deleteRule" | "takeOver"
  >;
  automationCommands: Pick<AutomationCommands, "createRule" | "runRuleNow">;
  recipeService: Pick<typeof recipeService, "list">;
  standingGrants: Pick<typeof standingGrants, "list" | "create" | "renew" | "pause" | "revoke">;
  socialOAuthService: Pick<typeof socialOAuthService, "listAccounts">;
  zoomService: Pick<ZoomService, "listConnections" | "disconnect" | "createAuthorizationUrl" | "handleCallback">;
  zoomConfigured(): boolean;
  /** A: where Zoom redirects the browser after consent. */
  callbackOrigin: string;
  /** W: where the browser lands after the callback. */
  webOrigin: string;
}

/** Autopilot rules, Standing Grants and Zoom connections, and the two screens that read them. */
export function createAutomationRoutes(deps: AutomationRouteDeps) {
  const { autopilotService, automationCommands, standingGrants, zoomService, callbackOrigin, webOrigin } = deps;

  return (
    createRouteApp(access)
      // Rules ---------------------------------------------------------------
      .get("/autopilot/rules", async (c) => {
        const rules = await autopilotService.listRules(getActor(c));
        return c.json({ rules }, 200);
      })

      // A retried create with the same Idempotency-Key replays the rule the first attempt saved.
      // An exhausted or unavailable limiter refuses only new work, after that replay lookup.
      .post(
        "/autopilot/rules",
        requireIdempotencyKey(),
        validate("json", autopilotRuleInputSchema),
        async (c) => {
          const { rule, replayed } = await automationCommands.createRule(getActor(c), c.req.valid("json"), {
            clientIdempotencyKey: getIdempotencyKey(c),
            beforeAccept: async () => enforceRecordedRateLimit(getRecordedRateLimit(c)),
          });
          if (replayed) c.header("Idempotent-Replayed", "true");
          return c.json(rule, 201);
        },
      )

      .patch(
        "/autopilot/rules/:ruleId",
        uuidParams("ruleId"),
        validate("json", autopilotRuleUpdateSchema),
        async (c) => {
          const rule = await autopilotService.updateRule(
            getActor(c),
            c.req.param("ruleId"),
            c.req.valid("json"),
          );
          return c.json(rule, 200);
        },
      )

      .delete("/autopilot/rules/:ruleId", uuidParams("ruleId"), async (c) => {
        await autopilotService.deleteRule(getActor(c), c.req.param("ruleId"));
        return c.json({ ok: true }, 200);
      })

      .post("/autopilot/rules/:ruleId/take-over", async (c) => {
        const rule = await autopilotService.takeOver(getActor(c), c.req.param("ruleId"));
        return c.json(rule, 200);
      })

      .post("/autopilot/rules/:ruleId/run-now", requireIdempotencyKey(), uuidParams("ruleId"), async (c) => {
        const { rule, replayed } = await automationCommands.runRuleNow(getActor(c), c.req.param("ruleId"), {
          clientIdempotencyKey: getIdempotencyKey(c),
          beforeAccept: async () => enforceRecordedRateLimit(getRecordedRateLimit(c)),
        });
        if (replayed) c.header("Idempotent-Replayed", "true");
        return c.json(rule, 200);
      })

      // Screens -------------------------------------------------------------
      .get("/automation", async (c) => c.json(await readAutomation(deps, getActor(c)), 200))

      .get("/automation/standing-grants", async (c) =>
        c.json(await readStandingGrants(deps, getActor(c)), 200),
      )

      // Standing Grants -----------------------------------------------------
      // A repeated create meets the duplicate-grant check (409 `standing_grant_duplicate`).
      .post("/automation/standing-grants", validate("json", createStandingGrantSchema), async (c) => {
        const grant = await standingGrants.create(getActor(c), c.req.valid("json"));
        return c.json(grant, 201);
      })

      .post(
        "/automation/standing-grants/:grantId/renew",
        validate("param", standingGrantReferenceSchema),
        validate("json", renewStandingGrantRequestSchema),
        async (c) => {
          await standingGrants.renew(getActor(c), { ...c.req.valid("json"), ...c.req.valid("param") });
          return c.json({ ok: true }, 200);
        },
      )

      .post(
        "/automation/standing-grants/:grantId/pause",
        validate("param", standingGrantReferenceSchema),
        async (c) => {
          await standingGrants.pause(getActor(c), c.req.valid("param").grantId);
          return c.json({ ok: true }, 200);
        },
      )

      .post(
        "/automation/standing-grants/:grantId/revoke",
        validate("param", standingGrantReferenceSchema),
        async (c) => {
          await standingGrants.revoke(getActor(c), c.req.valid("param").grantId);
          return c.json({ ok: true }, 200);
        },
      )

      // Zoom ----------------------------------------------------------------
      .get("/zoom/connections", async (c) => {
        const connections = await zoomService.listConnections(getActor(c));
        return c.json({ connections }, 200);
      })

      .delete("/zoom/connections/:connectionId", uuidParams("connectionId"), async (c) => {
        await zoomService.disconnect(getActor(c), c.req.param("connectionId"));
        return c.json({ disconnected: true }, 200);
      })

      // A navigation cannot carry the session Bearer, so the browser asks here and then follows the URL.
      .post("/zoom/oauth/start", async (c) => {
        const authorizationUrl = await zoomService.createAuthorizationUrl(getActor(c), callbackOrigin);
        return c.json({ authorizationUrl }, 200);
      })

      // Provider navigation carries no session: identity comes from the stored one-use OAuth
      // state, never from a Clerk token. Every outcome is a redirect to the Autopilot page.
      .get("/zoom/oauth/callback", async (c) => {
        const redirect = new URL("/autopilot", webOrigin);
        try {
          const state = c.req.query("state");
          const code = c.req.query("code");
          if (!state || !code || c.req.query("error")) throw new ZoomError("zoom_oauth_failed");
          await zoomService.handleCallback({ state, code, origin: callbackOrigin });
          redirect.searchParams.set("zoom", "connected");
        } catch (error) {
          const code = error instanceof ZoomError ? error.code : "zoom_oauth_failed";
          if (!(error instanceof ZoomError)) {
            console.warn(JSON.stringify({ level: "warn", message: "zoom_oauth_callback_failed", code }));
          }
          redirect.searchParams.set("zoom", code);
        }
        return c.redirect(redirect.href, 302);
      })
  );
}

export type AutomationRoutes = ReturnType<typeof createAutomationRoutes>;
