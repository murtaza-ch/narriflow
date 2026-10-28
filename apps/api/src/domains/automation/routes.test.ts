import { describe, expect, test } from "bun:test";
import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import { ExpectedDomainFailureError, ZoomError } from "@narriflow/services";
import { Hono } from "hono";
import { routeBodyLimit } from "../../body-limits";
import { installRequestPolicy, requireAdmissionDeclaration } from "../../http/admission";
import type { ApiEnv } from "../../http/env";
import { apiErrorHandler, apiNotFoundHandler, errorEnvelopeMiddleware } from "../../http/errors";
import { apiRequestId } from "../../http/logging";
import type { RateLimitCheck } from "../../http/request-policy";
import { createRequestPolicyRuntime } from "../../http/request-policy-runtime";
import { requireJsonContentType } from "../../http/route";
import { createAutomationRoutes, type AutomationRouteDeps } from "./routes";

const WORKSPACE_ID = "workspace-a";
const RULE_ID = "10000000-0000-4000-8000-000000000001";
const GRANT_ID = "20000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "30000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "40000000-0000-4000-8000-000000000001";
const KEY = "11111111-1111-4111-8111-111111111111";

const user = { id: "actor-user", clerkId: "clerk-1" } as AppUser;
function context(overrides: Partial<WorkspaceActorContext>): WorkspaceActorContext {
  return {
    userId: "actor-user",
    workspaceId: WORKSPACE_ID,
    workspaceName: "Workspace A",
    workspaceOwnerUserId: "owner-user",
    role: "editor",
    status: "active",
    pricingTier: "pro",
    isPersonal: false,
    workspaceSelectionChanged: false,
    ...overrides,
  };
}

interface Call {
  name: string;
  args: unknown[];
}

const rule = (overrides: Record<string, unknown> = {}) => ({ id: RULE_ID, name: "Podcast", status: "active", ...overrides });
const grant = (overrides: Record<string, unknown> = {}) => ({
  id: GRANT_ID,
  kind: "publish",
  status: "active",
  autopilotRuleId: RULE_ID,
  accountLabel: "Dana (@dana)",
  reviewerCount: 0,
  expiresAt: "2026-12-01T00:00:00.000Z",
  ...overrides,
});

function harness(
  options: {
    workspace?: Partial<WorkspaceActorContext>;
    rateLimit?: () => RateLimitCheck;
    overrides?: Partial<AutomationRouteDeps>;
  } = {},
) {
  const calls: Call[] = [];
  const record = (name: string, result: unknown = {}) => async (...args: unknown[]) => {
    calls.push({ name, args });
    return result;
  };
  const deps = {
    autopilotService: {
      listRules: record("listRules", [rule(), rule({ id: "rule-2", name: "Paused", status: "paused" })]),
      updateRule: record("updateRule", rule()),
      deleteRule: record("deleteRule"),
      takeOver: record("takeOver", rule()),
    },
    automationCommands: {
      createRule: record("createRule", { rule: rule(), replayed: false }),
      runRuleNow: record("runRuleNow", { rule: rule(), replayed: false }),
    },
    recipeService: { list: record("listRecipes", [{ id: "recipe-1" }]) },
    standingGrants: {
      list: record("listGrants", [grant(), grant({ id: "revoked", status: "revoked" }), grant({ id: "orphan", autopilotRuleId: null })]),
      create: record("createGrant", { id: GRANT_ID }),
      renew: record("renewGrant"),
      pause: record("pauseGrant"),
      revoke: record("revokeGrant"),
    },
    socialOAuthService: {
      listAccounts: record("listAccounts", [
        { id: ACCOUNT_ID, status: "active", publishingEligible: true, platform: "youtube_shorts", displayName: "Dana", handle: "@dana" },
        { id: "tt", status: "active", publishingEligible: true, platform: "tiktok", displayName: "TT", handle: null },
        { id: "off", status: "active", publishingEligible: false, platform: "linkedin", displayName: "Off", handle: null },
      ]),
    },
    zoomService: {
      listConnections: record("listConnections", [{ id: CONNECTION_ID }]),
      disconnect: record("disconnect"),
      createAuthorizationUrl: record("createAuthorizationUrl", "https://zoom.us/oauth/authorize?state=abc"),
      handleCallback: record("handleCallback"),
    },
    zoomConfigured: () => true,
    callbackOrigin: "http://localhost:4000",
    webOrigin: "http://localhost:3000",
    ...options.overrides,
  } as unknown as AutomationRouteDeps;

  const runtime = createRequestPolicyRuntime({
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer good"
        ? ({ status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never)
        : ({ status: "unauthenticated", reason: "missing_credential" } as const),
    loadAppUser: async () => user,
    resolveScopedWorkspace: async (_user, hint) => (hint === WORKSPACE_ID ? context(options.workspace ?? {}) : null),
    staffAllowlist: new Set(),
    policy: {
      resolveProject: async () => ({ kind: "inaccessible" }) as never,
      rateLimit: async () => options.rateLimit?.() ?? { allowed: true },
      now: () => 1_000,
    },
  });
  // The first-party chain of `createApiApp`, around only this domain.
  const chain = new Hono<ApiEnv>();
  chain.use("*", errorEnvelopeMiddleware());
  chain.use("*", routeBodyLimit("control"));
  chain.use("*", requireJsonContentType());
  chain.use("*", installRequestPolicy(runtime));
  chain.use("*", requireAdmissionDeclaration());
  chain.route("/", createAutomationRoutes(deps));
  const app = new Hono<ApiEnv>();
  app.use("*", apiRequestId());
  app.onError(apiErrorHandler);
  app.notFound(apiNotFoundHandler);
  app.route("/api", chain);
  const request = (path: string, init: RequestInit & { json?: unknown; key?: string; signedOut?: boolean } = {}) => {
    const { json, key, signedOut, ...rest } = init;
    const headers: Record<string, string> = { "x-workspace-id": WORKSPACE_ID };
    if (!signedOut) headers.authorization = "Bearer good";
    if (json !== undefined) headers["content-type"] = "application/json";
    if (key) headers["idempotency-key"] = key;
    return app.request(path, {
      ...rest,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      headers: { ...headers, ...(rest.headers as Record<string, string> | undefined) },
    });
  };
  return { app, request, calls };
}

const newRule = { name: "Podcast", sourceKind: "rss", rssUrl: "https://podcast.test/feed.xml", recipeId: RULE_ID };

describe("rule creation", () => {
  test("requires an Idempotency-Key and the content.edit capability", async () => {
    const editor = harness();
    const noKey = await editor.request("/api/autopilot/rules", { method: "POST", json: newRule });
    expect(noKey.status).toBe(400);
    expect((await noKey.json()).error).toBe("idempotency_key_required");
    const viewer = harness({ workspace: { role: "viewer" } });
    expect((await viewer.request("/api/autopilot/rules", { method: "POST", json: newRule, key: KEY })).status).toBe(403);
    expect([...editor.calls, ...viewer.calls]).toEqual([]);
  });

  test("passes the caller's key to the receipt-backed command and marks a replay", async () => {
    const fresh = harness();
    const created = await fresh.request("/api/autopilot/rules", { method: "POST", json: newRule, key: KEY });
    expect(created.status).toBe(201);
    expect(created.headers.get("idempotent-replayed")).toBeNull();
    expect(fresh.calls[0]!.name).toBe("createRule");
    expect(fresh.calls[0]!.args[0]).toMatchObject({ actorUserId: "actor-user", workspaceId: WORKSPACE_ID });
    expect(fresh.calls[0]!.args[2]).toMatchObject({ clientIdempotencyKey: KEY });

    const replay = harness({
      overrides: { automationCommands: { createRule: async () => ({ rule: rule(), replayed: true }), runRuleNow: async () => ({ rule: rule(), replayed: true }) } as never },
    });
    const again = await replay.request("/api/autopilot/rules", { method: "POST", json: newRule, key: KEY });
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
  });

  test("an exhausted limiter refuses only new work, and replay is answered first", async () => {
    // The command is the one that decides: replay never reaches beforeAccept, new work does.
    const commands = {
      createRule: async (_actor: unknown, _input: unknown, mutation: { clientIdempotencyKey: string; beforeAccept?: () => Promise<void> }) => {
        if (mutation.clientIdempotencyKey !== KEY) await mutation.beforeAccept?.();
        return { rule: rule(), replayed: mutation.clientIdempotencyKey === KEY };
      },
      runRuleNow: async () => ({ rule: rule(), replayed: false }),
    };
    const limited = harness({
      rateLimit: () => ({ allowed: false, limit: 5, remaining: 0, retryAfterSeconds: 1800 }),
      overrides: { automationCommands: commands as never },
    });
    const replayed = await limited.request("/api/autopilot/rules", { method: "POST", json: newRule, key: KEY });
    expect(replayed.status).toBe(201);
    const fresh = await limited.request("/api/autopilot/rules", { method: "POST", json: newRule, key: "another-key" });
    expect(fresh.status).toBe(429);
    expect((await fresh.json()).error).toBe("rate_limited");

    const down = harness({
      rateLimit: () => ({ allowed: true, availability: "unavailable" }),
      overrides: { automationCommands: commands as never },
    });
    const unavailable = await down.request("/api/autopilot/rules", { method: "POST", json: newRule, key: "another-key" });
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error).toBe("mutations_unavailable");
  });

  test("the shared schema refuses malformed rules before any service runs", async () => {
    const { request, calls } = harness();
    const response = await request("/api/autopilot/rules", { method: "POST", json: { name: "" }, key: KEY });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_input");
    expect(calls).toEqual([]);
  });
});

describe("rule controls", () => {
  test("run-now needs processing.consume and a key, and marks a replay", async () => {
    const viewer = harness({ workspace: { role: "viewer" } });
    expect((await viewer.request(`/api/autopilot/rules/${RULE_ID}/run-now`, { method: "POST", key: KEY })).status).toBe(403);
    const editor = harness();
    const noKey = await editor.request(`/api/autopilot/rules/${RULE_ID}/run-now`, { method: "POST" });
    expect(noKey.status).toBe(400);
    const ok = await editor.request(`/api/autopilot/rules/${RULE_ID}/run-now`, { method: "POST", key: KEY });
    expect(ok.status).toBe(200);
    expect(editor.calls[0]).toMatchObject({ name: "runRuleNow", args: [{ actorUserId: "actor-user" }, RULE_ID, { clientIdempotencyKey: KEY }] });
  });

  test("take-over is workspace.manage; update and delete are content.edit", async () => {
    const editor = harness();
    expect((await editor.request(`/api/autopilot/rules/${RULE_ID}/take-over`, { method: "POST" })).status).toBe(403);
    expect((await editor.request(`/api/autopilot/rules/${RULE_ID}`, { method: "PATCH", json: { name: "Renamed" } })).status).toBe(200);
    expect((await editor.request(`/api/autopilot/rules/${RULE_ID}`, { method: "DELETE" })).status).toBe(200);
    const admin = harness({ workspace: { role: "admin" } });
    expect((await admin.request(`/api/autopilot/rules/${RULE_ID}/take-over`, { method: "POST" })).status).toBe(200);
    expect(admin.calls[0]).toMatchObject({ name: "takeOver", args: [{}, RULE_ID] });
  });

  test("a malformed rule id is a 400 instead of reaching the database", async () => {
    const { request, calls } = harness();
    expect((await request("/api/autopilot/rules/not-a-uuid", { method: "DELETE" })).status).toBe(400);
    expect((await request("/api/autopilot/rules/not-a-uuid/run-now", { method: "POST", key: KEY })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("screen aggregates", () => {
  test("the Autopilot overview carries the page's props from parallel reads", async () => {
    const { request, calls } = harness({ workspace: { role: "owner" } });
    const response = await request("/api/automation");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(calls.map((call) => call.name).sort()).toEqual(["listConnections", "listGrants", "listRecipes", "listRules"]);
    expect(body).toMatchObject({
      zoomEnabled: true,
      autopilotIncluded: true,
      workspaceStatus: "active",
      newRuleRequirement: null,
      access: { canEdit: true, canRun: true, canTakeOver: true, canConnectZoom: true, canManageBilling: true },
      zoomConnections: [{ id: CONNECTION_ID }],
    });
    // Only live grants tied to a rule appear, summarized to one destination line.
    expect(body.grants).toEqual([
      { id: GRANT_ID, ruleId: RULE_ID, kind: "publish", status: "active", destination: "Dana (@dana)", expiresAt: "2026-12-01T00:00:00.000Z" },
    ]);
  });

  test("a deployment without Zoom never reads connections, and a viewer gets read-only facts", async () => {
    const { request, calls } = harness({ workspace: { role: "viewer", pricingTier: "creator" }, overrides: { zoomConfigured: () => false } });
    const body = await (await request("/api/automation")).json();
    expect(calls.map((call) => call.name)).not.toContain("listConnections");
    expect(body).toMatchObject({
      zoomEnabled: false,
      zoomConnections: [],
      autopilotIncluded: false,
      access: { canEdit: false, canRun: false, canTakeOver: false, canConnectZoom: false, canManageBilling: false },
    });
  });

  test("the grants overview offers only accounts a grant may target", async () => {
    const { request } = harness({ workspace: { role: "admin", pricingTier: "business" } });
    const body = await (await request("/api/automation/standing-grants")).json();
    expect(body.accounts).toEqual([{ id: ACCOUNT_ID, label: "Dana (@dana)", platform: "youtube_shorts" }]);
    expect(body.rules).toEqual([{ id: RULE_ID, name: "Podcast" }, { id: "rule-2", name: "Paused" }]);
    expect(body).toMatchObject({ canManage: true, reviewAvailable: true, autopilotIncluded: true, pricingTier: "business" });
    expect(body.grants).toHaveLength(3);
  });
});

describe("Standing Grants", () => {
  const publish = { kind: "publish", autopilotRuleId: RULE_ID, socialAccountId: ACCOUNT_ID, dailyCap: 2, weeklyCap: 5, expiresInDays: 30 };

  test("every grant control needs workspace.manage", async () => {
    const editor = harness();
    for (const [path, json] of [
      ["/api/automation/standing-grants", publish],
      [`/api/automation/standing-grants/${GRANT_ID}/renew`, { dailyCap: 2, weeklyCap: 5, expiresInDays: 30 }],
      [`/api/automation/standing-grants/${GRANT_ID}/pause`, undefined],
      [`/api/automation/standing-grants/${GRANT_ID}/revoke`, undefined],
    ] as const) {
      expect((await editor.request(path, { method: "POST", json })).status).toBe(403);
    }
    expect(editor.calls).toEqual([]);
  });

  test("create validates the shared schema, then calls the service", async () => {
    const { request, calls } = harness({ workspace: { role: "admin" } });
    const bad = await request("/api/automation/standing-grants", { method: "POST", json: { ...publish, weeklyCap: 1 } });
    expect(bad.status).toBe(400);
    const created = await request("/api/automation/standing-grants", { method: "POST", json: publish });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: GRANT_ID });
    expect(calls.map((call) => call.name)).toEqual(["createGrant"]);
    expect(calls[0]!.args[1]).toEqual(publish);
  });

  test("a duplicate grant keeps its domain code in the common envelope", async () => {
    const { request } = harness({
      workspace: { role: "admin" },
      overrides: {
        standingGrants: {
          create: async () => {
            throw new ExpectedDomainFailureError({ code: "standing_grant_duplicate", kind: "conflict", message: "This rule already has a grant for that destination." });
          },
        } as never,
      },
    });
    const response = await request("/api/automation/standing-grants", { method: "POST", json: publish });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("standing_grant_duplicate");
  });

  test("renew takes the grant from the path and the terms from the body", async () => {
    const { request, calls } = harness({ workspace: { role: "admin" } });
    const bad = await request(`/api/automation/standing-grants/${GRANT_ID}/renew`, { method: "POST", json: { dailyCap: 9, weeklyCap: 1, expiresInDays: 3 } });
    expect(bad.status).toBe(400);
    const terms = { dailyCap: 2, weeklyCap: 5, expiresInDays: 30, reviewerEmails: ["a@example.test"] };
    const ok = await request(`/api/automation/standing-grants/${GRANT_ID}/renew`, { method: "POST", json: terms });
    expect(ok.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "renewGrant", args: [{ workspaceId: WORKSPACE_ID }, { grantId: GRANT_ID, ...terms }] });
  });

  test("pause and revoke call the service with the validated grant id", async () => {
    const { request, calls } = harness({ workspace: { role: "owner" } });
    expect((await request(`/api/automation/standing-grants/${GRANT_ID}/pause`, { method: "POST" })).status).toBe(200);
    expect((await request(`/api/automation/standing-grants/${GRANT_ID}/revoke`, { method: "POST" })).status).toBe(200);
    expect((await request("/api/automation/standing-grants/nope/revoke", { method: "POST" })).status).toBe(400);
    expect(calls.map((call) => [call.name, call.args[1]])).toEqual([["pauseGrant", GRANT_ID], ["revokeGrant", GRANT_ID]]);
  });
});

describe("Zoom", () => {
  test("the start is a POST returning the authorization URL built on the API origin", async () => {
    const { request, calls } = harness();
    const response = await request("/api/zoom/oauth/start", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authorizationUrl: "https://zoom.us/oauth/authorize?state=abc" });
    expect(calls[0]!.args[1]).toBe("http://localhost:4000");
    // A navigation can no longer start it.
    expect((await request("/api/zoom/oauth/start")).status).toBe(404);
  });

  test("the start needs a session and content.edit", async () => {
    const { request, calls } = harness({ workspace: { role: "viewer" } });
    expect((await request("/api/zoom/oauth/start", { method: "POST", signedOut: true })).status).toBe(401);
    expect((await request("/api/zoom/oauth/start", { method: "POST" })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("an unconfigured Zoom keeps its typed failure", async () => {
    const { request } = harness({
      overrides: { zoomService: { createAuthorizationUrl: async () => { throw new ZoomError("zoom_not_configured"); } } as never },
    });
    const response = await request("/api/zoom/oauth/start", { method: "POST" });
    expect((await response.json()).error).toBe("zoom_not_configured");
  });

  test("connections list for viewers; disconnect needs content.edit and a UUID", async () => {
    const viewer = harness({ workspace: { role: "viewer" } });
    expect((await viewer.request("/api/zoom/connections")).status).toBe(200);
    expect((await viewer.request(`/api/zoom/connections/${CONNECTION_ID}`, { method: "DELETE" })).status).toBe(403);
    const editor = harness();
    expect((await editor.request("/api/zoom/connections/nope", { method: "DELETE" })).status).toBe(400);
    const ok = await editor.request(`/api/zoom/connections/${CONNECTION_ID}`, { method: "DELETE" });
    expect(await ok.json()).toEqual({ disconnected: true });
    expect(editor.calls[0]).toMatchObject({ name: "disconnect", args: [{}, CONNECTION_ID] });
  });

  test("the callback needs no session: it hands only the state and code to the service and redirects to the web app", async () => {
    const { request, calls } = harness();
    const response = await request("/api/zoom/oauth/callback?state=opaque&code=private-code&redirect=https://evil.test/", { signedOut: true, headers: { "x-workspace-id": "" } });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:3000/autopilot?zoom=connected");
    expect(calls).toEqual([{ name: "handleCallback", args: [{ state: "opaque", code: "private-code", origin: "http://localhost:4000" }] }]);
  });

  test("the callback reports provider denial, a missing code and typed failures as an Autopilot notice", async () => {
    const { request, calls } = harness({
      overrides: {
        zoomService: {
          handleCallback: async ({ state }: { state: string }) => {
            if (state === "stale") throw new ZoomError("zoom_oauth_state_invalid");
            throw new Error("database exploded with secret details");
          },
        } as never,
      },
    });
    const locationOf = async (query: string) => (await request(`/api/zoom/oauth/callback?${query}`, { signedOut: true })).headers.get("location");
    expect(await locationOf("error=access_denied&state=s&code=c")).toBe("http://localhost:3000/autopilot?zoom=zoom_oauth_failed");
    expect(await locationOf("state=only")).toBe("http://localhost:3000/autopilot?zoom=zoom_oauth_failed");
    expect(await locationOf("state=stale&code=c")).toBe("http://localhost:3000/autopilot?zoom=zoom_oauth_state_invalid");
    expect(await locationOf("state=boom&code=c")).toBe("http://localhost:3000/autopilot?zoom=zoom_oauth_failed");
    expect(calls).toEqual([]);
  });
});
