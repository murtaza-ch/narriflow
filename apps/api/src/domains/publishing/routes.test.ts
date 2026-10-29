import { describe, expect, test } from "bun:test";
import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import { ExpectedDomainFailureError, SocialOAuthError } from "@narriflow/services";
import { createRequestPolicyRuntime } from "../../http/request-policy-runtime";
import type { RateLimitCheck } from "../../http/request-policy";
import { Hono } from "hono";
import { routeBodyLimit } from "../../body-limits";
import { loadApiConfig } from "../../config";
import { installRequestPolicy, requireAdmissionDeclaration } from "../../http/admission";
import type { ApiEnv } from "../../http/env";
import { apiErrorHandler, apiNotFoundHandler, errorEnvelopeMiddleware } from "../../http/errors";
import { apiRequestId } from "../../http/logging";
import { requireJsonContentType } from "../../http/route";
import { createPublishingRoutes, type PublishingRouteDeps } from "./routes";

const WORKSPACE_ID = "workspace-a";
const PROJECT_ID = "40000000-0000-4000-8000-000000000001";
const POST_ID = "50000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "60000000-0000-4000-8000-000000000001";
const PROPOSAL_ID = "70000000-0000-4000-8000-000000000001";
const KEY = "11111111-1111-4111-8111-111111111111";

const user = { id: "actor-user", clerkId: "clerk-1" } as AppUser;
function context(role: WorkspaceActorContext["role"]): WorkspaceActorContext {
  return {
    userId: "actor-user",
    workspaceId: WORKSPACE_ID,
    workspaceName: "Workspace A",
    workspaceOwnerUserId: "owner-user",
    role,
    status: "active",
    pricingTier: "creator",
    isPersonal: false,
    workspaceSelectionChanged: false,
  };
}

interface Call {
  name: string;
  args: unknown[];
}

function harness(options: { role?: WorkspaceActorContext["role"]; rateLimit?: () => RateLimitCheck; overrides?: Partial<PublishingRouteDeps> } = {}) {
  const calls: Call[] = [];
  const record = (name: string, result: unknown = {}) => async (...args: unknown[]) => {
    calls.push({ name, args });
    return result;
  };
  const config = loadApiConfig({
    NODE_ENV: "test",
    API_ORIGIN: "http://localhost:4000",
    WEB_ORIGIN: "http://localhost:3000",
    CORS_ALLOWED_ORIGINS: "http://localhost:3000",
    CLERK_AUTHORIZED_PARTIES: "http://localhost:3000",
    CLERK_SECRET_KEY: "sk_test_inert",
    CLERK_PUBLISHABLE_KEY: "pk_test_inert",
  });
  const deps = {
    socialOAuthService: {
      listAccounts: record("listAccounts", [{ id: ACCOUNT_ID, platform: "youtube_shorts", publishingEligible: true }]),
      createAuthorizationUrl: record("createAuthorizationUrl", "https://accounts.example/authorize?state=abc"),
      handleCallback: record("handleCallback", { accounts: [{}], redirectPath: "/settings/social-accounts" }),
      getFacebookPageSelection: record("getFacebookPageSelection", []),
      completeFacebookPageSelection: record("completeFacebookPageSelection", { id: ACCOUNT_ID }),
      disconnectAccount: record("disconnectAccount"),
    },
    assistedSocialCopyService: { generate: record("generate") },
    socialService: {
      listProjectPosts: record("listProjectPosts", { items: [], nextCursor: null }),
      cancelPost: record("cancelPost"),
      inspectPublication: record("inspectPublication"),
      recheckPublication: record("recheckPublication"),
      confirmPublication: record("confirmPublication"),
      republishPublication: record("republishPublication"),
    },
    bulkSocialSchedulingService: { preview: record("preview"), schedule: record("schedule") },
    publishingQueue: {
      propose: record("propose", { proposal: { proposalId: PROPOSAL_ID }, replayed: false }),
      listProposals: record("listProposals", []),
      countProposals: record("countProposals", 3),
      updateProposalCaption: record("updateProposalCaption"),
      reject: record("reject"),
      accept: record("accept", { socialPostId: POST_ID }),
      acceptAll: record("acceptAll", { accepted: [], skippedTikTok: 1, failed: [], remaining: 0, nextCursor: null }),
      setPostingSchedule: record("setPostingSchedule", { slots: [] }),
      getPostingSchedule: record("getPostingSchedule", null),
    },
    performanceService: { whatWorked: record("whatWorked", { measured: 0 }), guidance: record("guidance", { enabled: false }) },
    workspaceLibraryService: {
      listCalendarPosts: record("listCalendarPosts", []),
      getCalendarFilters: record("getCalendarFilters", { accounts: [], projects: [] }),
      getCalendarComposerOptions: record("getCalendarComposerOptions", { clips: [], accounts: [], nextCursor: null }),
    },
    workspaceService: { getWorkspace: record("getWorkspace", { timezone: "Asia/Karachi" }) },
    socialPublishingOptions: record("socialPublishingOptions", {
      directEnabled: true,
      inboxEnabled: false,
      privacyOptions: ["SELF_ONLY"],
      commentDisabled: false,
      duetDisabled: false,
      stitchDisabled: false,
      creatorToken: "must-not-leak",
    }),
    refreshTikTokInbox: record("refreshTikTokInbox"),
    callbackOrigin: config.apiOrigin,
    webOrigin: config.webOrigin,
    ...options.overrides,
  } as unknown as PublishingRouteDeps;

  const runtime = createRequestPolicyRuntime({
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer good"
        ? ({ status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never)
        : ({ status: "unauthenticated", reason: "missing_credential" } as const),
    loadAppUser: async () => user,
    resolveScopedWorkspace: async (_user, hint) => (hint === WORKSPACE_ID ? context(options.role ?? "editor") : null),
    staffAllowlist: new Set(),
    policy: {
      resolveProject: async () => ({ kind: "active", projectId: PROJECT_ID }),
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
  chain.route("/", createPublishingRoutes(deps));
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

const publicationPath = `/api/projects/${PROJECT_ID}/social-posts/${POST_ID}`;

describe("OAuth start", () => {
  test("returns the provider authorization URL as JSON using the API callback origin", async () => {
    const { request, calls } = harness({ role: "admin" });
    const response = await request("/api/social/oauth/start/youtube_shorts", {
      method: "POST",
      json: { redirect: "/settings/social-accounts?x=1" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authorizationUrl: "https://accounts.example/authorize?state=abc" });
    expect(calls[0]!.name).toBe("createAuthorizationUrl");
    expect(calls[0]!.args[1]).toEqual({
      platform: "youtube_shorts",
      origin: "http://localhost:4000",
      redirectPath: "/settings/social-accounts?x=1",
    });
  });

  test("an unsafe return path falls back to the default instead of being stored", async () => {
    const { request, calls } = harness({ role: "admin" });
    await request("/api/social/oauth/start/tiktok", { method: "POST", json: { redirect: "https://evil.example/" } });
    expect((calls[0]!.args[1] as { redirectPath: string }).redirectPath).toBe("/settings/social-accounts");
  });

  test("is no longer a GET navigation and needs a session", async () => {
    const { request, calls } = harness();
    expect((await request("/api/social/oauth/start/tiktok")).status).toBe(404);
    const signedOut = await request("/api/social/oauth/start/tiktok", { method: "POST", json: {}, signedOut: true });
    expect(signedOut.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("needs the social.manage capability and a known platform", async () => {
    const editor = harness({ role: "editor" });
    expect((await editor.request("/api/social/oauth/start/tiktok", { method: "POST", json: {} })).status).toBe(403);
    const admin = harness({ role: "admin" });
    expect((await admin.request("/api/social/oauth/start/myspace", { method: "POST", json: {} })).status).toBe(400);
    expect(admin.calls).toEqual([]);
  });

  test("a provider configuration failure is a safe 503 that names no environment variable", async () => {
    const { request } = harness({
      role: "admin",
      overrides: {
        socialOAuthService: {
          createAuthorizationUrl: async () => {
            throw new SocialOAuthError("social_oauth_env_missing", "Missing required environment variable: TIKTOK_CLIENT_SECRET");
          },
        },
      } as unknown as Partial<PublishingRouteDeps>,
    });
    const response = await request("/api/social/oauth/start/tiktok", { method: "POST", json: {} });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("social_oauth_env_missing");
    expect(text).not.toContain("TIKTOK_CLIENT_SECRET");
  });
});

describe("OAuth callback", () => {
  const callback = (query: string) => {
    const h = harness();
    return h.request(`/api/social/oauth/callback${query}`, { signedOut: true }).then((response) => ({ response, ...h }));
  };

  test("needs no session: it hands the stored state to the service and redirects to the web origin", async () => {
    const { response, calls } = await callback("?state=s&code=c");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:3000/settings/social-accounts?connected=1");
    expect(calls).toEqual([{ name: "handleCallback", args: [{ state: "s", code: "c", origin: "http://localhost:4000" }] }]);
  });

  test("a Facebook Page choice is carried to the web page by selection token", async () => {
    const h = harness({
      overrides: {
        socialOAuthService: {
          handleCallback: async () => ({ accounts: [], redirectPath: "/settings/social-accounts", facebookSelectionToken: "t".repeat(40) }),
        },
      } as unknown as Partial<PublishingRouteDeps>,
    });
    const response = await h.request("/api/social/oauth/callback?state=s&code=c", { signedOut: true });
    expect(response.headers.get("location")).toBe(
      `http://localhost:3000/settings/social-accounts?facebook_selection=${"t".repeat(40)}`,
    );
  });

  test("provider denial, missing parameters and expired state all return to the web page with a code", async () => {
    const denied = await callback("?error=access_denied");
    expect(denied.response.headers.get("location")).toBe("http://localhost:3000/settings/social-accounts?error=access_denied");
    expect(denied.calls).toEqual([]);
    const missing = await callback("?state=only");
    expect(missing.response.headers.get("location")).toContain("error=social_oauth_callback_missing");
    const expired = harness({
      overrides: {
        socialOAuthService: {
          handleCallback: async () => {
            throw new SocialOAuthError("social_oauth_state_invalid", "Social OAuth state is missing or expired");
          },
        },
      } as unknown as Partial<PublishingRouteDeps>,
    });
    const response = await expired.request("/api/social/oauth/callback?state=s&code=c", { signedOut: true });
    expect(response.headers.get("location")).toBe("http://localhost:3000/settings/social-accounts?error=social_oauth_state_invalid");
  });

  test("an unexpected failure shows a generic code, never its message", async () => {
    const h = harness({
      overrides: {
        socialOAuthService: {
          handleCallback: async () => {
            throw new Error("connect ECONNREFUSED provider-secret");
          },
        },
      } as unknown as Partial<PublishingRouteDeps>,
    });
    const response = await h.request("/api/social/oauth/callback?state=s&code=c", { signedOut: true });
    const location = response.headers.get("location")!;
    expect(location).toContain("error=social_oauth_callback_failed");
    expect(location).not.toContain("secret");
  });
});

describe("Facebook Page selection", () => {
  const TOKEN = "a".repeat(40);

  test("rejects a malformed token before the service and passes a valid one with the actor", async () => {
    const { request, calls } = harness({ role: "admin" });
    expect((await request("/api/social/oauth/facebook-selection/short")).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await request(`/api/social/oauth/facebook-selection/${TOKEN}`)).status).toBe(200);
    expect(calls[0]!.name).toBe("getFacebookPageSelection");
    expect(calls[0]!.args[1]).toBe(TOKEN);
  });

  test("completes a Page choice with 201 and refuses a missing page id", async () => {
    const { request, calls } = harness({ role: "admin" });
    const path = `/api/social/oauth/facebook-selection/${TOKEN}`;
    expect((await request(path, { method: "POST", json: {} })).status).toBe(400);
    const ok = await request(path, { method: "POST", json: { pageId: "123" } });
    expect(ok.status).toBe(201);
    expect(calls.map((call) => call.name)).toEqual(["completeFacebookPageSelection"]);
  });

  test("an expired selection is a 400 with the service code", async () => {
    const { request } = harness({
      role: "admin",
      overrides: {
        socialOAuthService: {
          getFacebookPageSelection: async () => {
            throw new SocialOAuthError("social_facebook_selection_expired", "Facebook Page selection expired");
          },
        },
      } as unknown as Partial<PublishingRouteDeps>,
    });
    const response = await request(`/api/social/oauth/facebook-selection/${TOKEN}`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("social_facebook_selection_expired");
  });
});

describe("accounts and posting schedules", () => {
  test("any member who can view content lists accounts; connecting and disconnecting stay with social.manage", async () => {
    const viewer = harness({ role: "viewer" });
    expect((await viewer.request("/api/social/accounts")).status).toBe(200);
    expect((await viewer.request("/api/social/oauth/start/tiktok", { method: "POST", json: {} })).status).toBe(403);
    expect((await viewer.request(`/api/social/accounts/${ACCOUNT_ID}`, { method: "DELETE" })).status).toBe(403);
    expect((await viewer.request("/api/publishing/queue")).status).toBe(200);
    const admin = harness({ role: "admin" });
    expect((await admin.request("/api/social/accounts")).status).toBe(200);
  });

  test("disconnect needs social.manage and a UUID", async () => {
    const editor = harness({ role: "editor" });
    expect((await editor.request(`/api/social/accounts/${ACCOUNT_ID}`, { method: "DELETE" })).status).toBe(403);
    const admin = harness({ role: "admin" });
    expect((await admin.request("/api/social/accounts/not-a-uuid", { method: "DELETE" })).status).toBe(400);
    expect((await admin.request(`/api/social/accounts/${ACCOUNT_ID}`, { method: "DELETE" })).status).toBe(200);
    expect(admin.calls.map((call) => call.name)).toEqual(["disconnectAccount"]);
  });

  test("saves and clears a schedule through the strict shared schema", async () => {
    const { request, calls } = harness();
    const path = `/api/social/accounts/${ACCOUNT_ID}/posting-schedule`;
    const schedule = { slots: [{ weekday: "mon", time: "09:00" }] };
    expect((await request(path, { method: "PUT", json: { schedule } })).status).toBe(200);
    expect((await request(path, { method: "PUT", json: { schedule: null } })).status).toBe(200);
    expect((await request(path, { method: "PUT", json: { schedule: { slots: [{ weekday: "mon", time: "25:00" }] } } })).status).toBe(400);
    expect(calls.map((call) => [call.name, call.args[2]])).toEqual([
      ["setPostingSchedule", schedule],
      ["setPostingSchedule", null],
    ]);
  });

  test("a viewer reads a schedule but cannot save one", async () => {
    const { request, calls } = harness({ role: "viewer" });
    const path = `/api/social/accounts/${ACCOUNT_ID}/posting-schedule`;
    expect((await request(path)).status).toBe(200);
    expect((await request(path, { method: "PUT", json: { schedule: null } })).status).toBe(403);
    expect(calls.map((call) => call.name)).toEqual(["getPostingSchedule"]);
  });

  test("TikTok options expose only the creator choices, never the rest of the provider payload", async () => {
    const { request } = harness();
    const response = await request(`/api/social/accounts/${ACCOUNT_ID}/tiktok-options`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      directEnabled: true,
      inboxEnabled: false,
      privacyOptions: ["SELF_ONLY"],
      commentDisabled: false,
      duetDisabled: false,
      stitchDisabled: false,
    });
  });
});

describe("queue proposals", () => {
  const proposal = { clipId: POST_ID, exportId: POST_ID, socialAccountId: ACCOUNT_ID, caption: "Hello" };

  test("proposing needs an Idempotency-Key and hands the receipt key to the service", async () => {
    const { request, calls } = harness();
    const missing = await request("/api/social/proposals", { method: "POST", json: proposal });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe("idempotency_key_required");
    const created = await request("/api/social/proposals", { method: "POST", json: proposal, key: KEY });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ proposalId: PROPOSAL_ID });
    expect(calls).toHaveLength(1);
    const options = calls[0]!.args[2] as { source: string; mutation: { clientIdempotencyKey: string } };
    expect(options.source).toBe("person");
    expect(options.mutation.clientIdempotencyKey).toBe(KEY);
  });

  test("a replay answers 200 with the replay header", async () => {
    const { request } = harness({
      overrides: {
        publishingQueue: { propose: async () => ({ proposal: { proposalId: PROPOSAL_ID }, replayed: true }) },
      } as unknown as Partial<PublishingRouteDeps>,
    });
    const response = await request("/api/social/proposals", { method: "POST", json: proposal, key: KEY });
    expect(response.status).toBe(200);
    expect(response.headers.get("idempotent-replayed")).toBe("true");
  });

  test("an exhausted limiter refuses new proposals only after the receipt lookup, and never a replay", async () => {
    const exhausted = () => ({ allowed: false, availability: "available", retryAfterSeconds: 30 }) as RateLimitCheck;
    const fresh = harness({
      rateLimit: exhausted,
      overrides: {
        publishingQueue: {
          propose: async (_actor: unknown, _input: unknown, options: { mutation: { beforeAccept(): Promise<void> } }) => {
            await options.mutation.beforeAccept();
            return { proposal: { proposalId: PROPOSAL_ID }, replayed: false };
          },
        },
      } as unknown as Partial<PublishingRouteDeps>,
    });
    const refused = await fresh.request("/api/social/proposals", { method: "POST", json: proposal, key: KEY });
    expect(refused.status).toBe(429);
    const replay = harness({
      rateLimit: exhausted,
      overrides: {
        publishingQueue: { propose: async () => ({ proposal: { proposalId: PROPOSAL_ID }, replayed: true }) },
      } as unknown as Partial<PublishingRouteDeps>,
    });
    expect((await replay.request("/api/social/proposals", { method: "POST", json: proposal, key: KEY })).status).toBe(200);
  });

  test("an unavailable limiter pauses new proposals with a 503 instead of failing open", async () => {
    const { request } = harness({
      rateLimit: () => ({ allowed: true, availability: "unavailable" }) as RateLimitCheck,
      overrides: {
        publishingQueue: {
          propose: async (_actor: unknown, _input: unknown, options: { mutation: { beforeAccept(): Promise<void> } }) => {
            await options.mutation.beforeAccept();
            return { proposal: { proposalId: PROPOSAL_ID }, replayed: false };
          },
        },
      } as unknown as Partial<PublishingRouteDeps>,
    });
    const response = await request("/api/social/proposals", { method: "POST", json: proposal, key: KEY });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("mutations_unavailable");
  });

  test("accepting passes the TikTok choices through and keeps the single-accept response shape", async () => {
    const { request, calls } = harness();
    const tiktok = { deliveryMode: "direct", privacyLevel: "SELF_ONLY", disableComment: true, disableDuet: false, disableStitch: false, isAigc: false };
    const response = await request(`/api/social/proposals/${PROPOSAL_ID}/accept`, { method: "POST", json: { tiktok } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: [{ socialPostId: POST_ID }], skippedTikTok: 0, failed: [] });
    expect(calls[0]!.args.slice(1)).toEqual([PROPOSAL_ID, { tiktok }]);
    const bare = await request(`/api/social/proposals/${PROPOSAL_ID}/accept`, { method: "POST" });
    expect(bare.status).toBe(200);
    expect(calls[1]!.args.slice(1)).toEqual([PROPOSAL_ID, {}]);
  });

  test("accept-all continues from a cursor and reports skipped TikTok proposals", async () => {
    const { request, calls } = harness();
    const response = await request("/api/social/proposals/accept-all", { method: "POST", json: { after: PROPOSAL_ID } });
    expect(await response.json()).toMatchObject({ skippedTikTok: 1, nextCursor: null });
    expect(calls[0]!.args[1]).toEqual({ after: PROPOSAL_ID });
    await request("/api/social/proposals/accept-all", { method: "POST", json: {} });
    expect(calls[1]!.args[1]).toEqual({ after: null });
    expect((await request("/api/social/proposals/accept-all", { method: "POST", json: { after: "x" } })).status).toBe(400);
  });

  test("edits and rejects a proposal; a viewer can do neither", async () => {
    const { request, calls } = harness();
    expect((await request(`/api/social/proposals/${PROPOSAL_ID}`, { method: "PATCH", json: { caption: "New" } })).status).toBe(200);
    expect((await request(`/api/social/proposals/${PROPOSAL_ID}/reject`, { method: "POST" })).status).toBe(200);
    expect(calls.map((call) => call.name)).toEqual(["updateProposalCaption", "reject"]);
    const viewer = harness({ role: "viewer" });
    expect((await viewer.request(`/api/social/proposals/${PROPOSAL_ID}/reject`, { method: "POST" })).status).toBe(403);
    expect((await viewer.request("/api/social/proposals/accept-all", { method: "POST", json: {} })).status).toBe(403);
    expect(viewer.calls).toEqual([]);
  });

  test("a domain refusal keeps its stable code", async () => {
    const { request } = harness({
      overrides: {
        publishingQueue: {
          accept: async () => {
            throw new ExpectedDomainFailureError({ code: "posting_schedule_missing", kind: "unprocessable", message: "Add posting slots first." });
          },
        },
      } as unknown as Partial<PublishingRouteDeps>,
    });
    const response = await request(`/api/social/proposals/${PROPOSAL_ID}/accept`, { method: "POST" });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe("posting_schedule_missing");
  });
});

describe("screen reads", () => {
  const from = "2026-10-01T00:00:00.000Z";
  const to = "2026-10-31T23:59:59.000Z";

  test("the calendar pads the view window by 36 hours and applies the filters", async () => {
    const { request, calls } = harness();
    const response = await request(
      `/api/publishing/calendar?from=${from}&to=${to}&status=failed&platform=tiktok&account=${ACCOUNT_ID}&project=${PROJECT_ID}`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ timezone: "Asia/Karachi", proposalCount: 3, canPublish: true, posts: [] });
    const list = calls.find((call) => call.name === "listCalendarPosts")!;
    expect(list.args[1]).toEqual({
      from: new Date("2026-09-29T12:00:00.000Z"),
      to: new Date("2026-11-02T11:59:59.000Z"),
      status: "failed",
      platform: "tiktok",
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
    });
  });

  test("an unknown status or platform is ignored, as a stale calendar link always was", async () => {
    const { request, calls } = harness();
    await request(`/api/publishing/calendar?from=${from}&to=${to}&status=gone&platform=myspace`);
    const filters = calls.find((call) => call.name === "listCalendarPosts")!.args[1] as Record<string, unknown>;
    expect(filters.status).toBeUndefined();
    expect(filters.platform).toBeUndefined();
  });

  test("the raw posts read uses exactly the window it is given and bounds the window", async () => {
    const { request, calls } = harness();
    expect((await request(`/api/workspace/calendar/posts?from=${from}&to=${to}`)).status).toBe(200);
    expect((calls[0]!.args[1] as { from: Date }).from).toEqual(new Date(from));
    expect((await request(`/api/workspace/calendar/posts?from=2020-01-01T00:00:00Z&to=${to}`)).status).toBe(400);
    expect((await request(`/api/workspace/calendar/posts?from=${to}&to=${from}`)).status).toBe(400);
    expect((await request("/api/workspace/calendar/posts?from=yesterday&to=today")).status).toBe(400);
  });

  test("a viewer sees the calendar but cannot publish from it, and cannot open the composer", async () => {
    const { request } = harness({ role: "viewer" });
    const calendar = await request(`/api/publishing/calendar?from=${from}&to=${to}`);
    expect((await calendar.json()).canPublish).toBe(false);
    expect((await request("/api/workspace/calendar/composer-options")).status).toBe(403);
  });

  test("the queue aggregate reports who can manage and connect", async () => {
    const editor = await harness({ role: "editor" }).request("/api/publishing/queue");
    expect(await editor.json()).toMatchObject({ canManage: true, canConnect: false, timezone: "Asia/Karachi" });
    const admin = await harness({ role: "admin" }).request("/api/publishing/queue");
    expect(await admin.json()).toMatchObject({ canManage: true, canConnect: true });
  });

  test("proposal list and count are separate reads", async () => {
    const { request } = harness();
    expect(await (await request("/api/publishing/proposals")).json()).toEqual({ proposals: [] });
    expect(await (await request("/api/publishing/proposals/count")).json()).toEqual({ count: 3 });
  });

  test("What worked carries the empty-state next step; guidance is its own read", async () => {
    const { request } = harness({ role: "editor" });
    expect(await (await request("/api/performance/what-worked")).json()).toEqual({
      summary: { measured: 0 },
      emptyNextStep: "publish",
    });
    expect(await (await request("/api/performance/guidance")).json()).toEqual({ guidance: { enabled: false } });
    const viewer = harness({ role: "viewer" });
    expect((await (await viewer.request("/api/performance/what-worked")).json()).emptyNextStep).toBeNull();
  });
});

describe("project publishing", () => {
  test("recovery commands need a key and hand it to the service with the actual actor and project", async () => {
    const { request, calls } = harness();
    for (const [action, body] of [
      ["recheck", { reason: "Check again" }],
      ["confirm", { reason: "Confirmed", evidenceKind: "platform_url", externalUrl: "https://youtube.com/watch?v=video" }],
      ["publish-again", { reason: "New attempt", duplicateRiskAcknowledged: true }],
    ] as const) {
      calls.length = 0;
      const missing = await request(`${publicationPath}/${action}`, { method: "POST", json: body });
      expect(missing.status).toBe(400);
      const response = await request(`${publicationPath}/${action}`, { method: "POST", json: body, key: KEY });
      expect(response.status).toBe(action === "publish-again" ? 201 : 200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args.slice(1, 4)).toEqual([POST_ID, body, PROJECT_ID]);
      expect((calls[0]!.args[4] as { clientIdempotencyKey: string }).clientIdempotencyKey).toBe(KEY);
    }
  });

  test.each([
    ["recheck", { reason: "Check", actorUserId: "forged" }],
    ["confirm", { reason: "Confirmed", evidenceKind: "platform_url" }],
    ["publish-again", { reason: "Retry", duplicateRiskAcknowledged: false }],
  ])("rejects invalid %s input before the domain operation", async (action, body) => {
    const { request, calls } = harness();
    const response = await request(`${publicationPath}/${action}`, { method: "POST", json: body, key: KEY });
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(calls).toEqual([]);
  });

  test("a recovery retry is answered when the limiter is exhausted, but new recovery work is refused", async () => {
    const exhausted = () => ({ allowed: false, availability: "available", retryAfterSeconds: 10 }) as RateLimitCheck;
    const fresh = harness({
      rateLimit: exhausted,
      overrides: {
        socialService: {
          recheckPublication: async (...args: unknown[]) => {
            await (args[4] as { beforeAccept(): Promise<void> }).beforeAccept();
            return {};
          },
        },
      } as unknown as Partial<PublishingRouteDeps>,
    });
    const refused = await fresh.request(`${publicationPath}/recheck`, { method: "POST", json: { reason: "again" }, key: KEY });
    expect(refused.status).toBe(429);
    const replay = harness({
      rateLimit: exhausted,
      overrides: { socialService: { recheckPublication: async () => ({ status: "reconciling" }) } } as unknown as Partial<PublishingRouteDeps>,
    });
    expect((await replay.request(`${publicationPath}/recheck`, { method: "POST", json: { reason: "again" }, key: KEY })).status).toBe(200);
  });

  test.each([
    ["recheck", "recheckPublication", { reason: "again" }],
    ["confirm", "confirmPublication", { reason: "seen it", evidenceKind: "platform_url", externalUrl: "https://example.com/p/1" }],
    ["publish-again", "republishPublication", { reason: "again", duplicateRiskAcknowledged: true }],
  ])("a replayed %s decision carries Idempotent-Replayed, a first acceptance does not", async (action, method, json) => {
    const call = async (replay: boolean) => {
      const { request } = harness({
        overrides: {
          socialService: {
            [method]: async (...args: unknown[]) => {
              if (replay) (args[4] as { onReplay(): void }).onReplay();
              return { status: "scheduled" };
            },
          },
        } as unknown as Partial<PublishingRouteDeps>,
      });
      return request(`${publicationPath}/${action}`, { method: "POST", json, key: KEY });
    };
    expect((await call(false)).headers.get("idempotent-replayed")).toBeNull();
    expect((await call(true)).headers.get("idempotent-replayed")).toBe("true");
  });

  test("malformed JSON and post identifiers are refused through the policy", async () => {
    const { request, calls } = harness();
    const malformed = await request(`${publicationPath}/recheck`, { method: "POST", key: KEY, body: "{", headers: { "content-type": "application/json" } });
    expect(malformed.status).toBe(400);
    const badId = await request(`/api/projects/${PROJECT_ID}/social-posts/invalid/recheck`, { method: "POST", json: { reason: "Check" }, key: KEY });
    expect(badId.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("capability is checked before invalid mutation input is read", async () => {
    const { request, calls } = harness({ role: "viewer" });
    const response = await request(`${publicationPath}/recheck`, { method: "POST", json: { reason: "" }, key: KEY });
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
    expect((await request(`${publicationPath}/publication`)).status).toBe(200);
    expect(calls.map((call) => call.name)).toEqual(["inspectPublication"]);
  });

  test("passes provider options and inbox refresh identifiers once", async () => {
    const { request, calls } = harness();
    expect((await request(`/api/projects/${PROJECT_ID}/social-accounts/${ACCOUNT_ID}/publishing-options`)).status).toBe(200);
    expect((await request(`${publicationPath}/refresh-inbox`, { method: "POST" })).status).toBe(200);
    expect(calls.map((call) => [call.name, call.args.slice(1)])).toEqual([
      ["socialPublishingOptions", [ACCOUNT_ID]],
      ["refreshTikTokInbox", [PROJECT_ID, POST_ID]],
    ]);
  });

  test("lists posts with the active, tracked and cursor options", async () => {
    const { request, calls } = harness();
    const response = await request(`/api/projects/${PROJECT_ID}/social-posts?active=1&tracked=a,b&cursor=c`);
    expect(await response.json()).toEqual({ posts: [], nextCursor: null });
    expect(calls[0]!.args.slice(1)).toEqual([PROJECT_ID, { activeOnly: true, trackedIds: ["a", "b"], cursor: "c" }]);
  });

  test("cancels a post through the project route that the calendar also uses", async () => {
    const { request, calls } = harness();
    expect((await request(publicationPath, { method: "DELETE" })).status).toBe(200);
    expect(calls[0]!.args.slice(1)).toEqual([PROJECT_ID, POST_ID]);
  });

  test("passes validated preview input and refuses forged timing authority", async () => {
    const { request, calls } = harness();
    const input = {
      clipIds: [POST_ID],
      scheduleMode: "now",
      startDate: "2026-10-04",
      timeZone: "Asia/Karachi",
      postingWindow: { start: "09:00", end: "17:00" },
      frequency: { unit: "hours", value: 2 },
      dstDisambiguation: null,
    };
    const path = `/api/projects/${PROJECT_ID}/campaign-operations/schedule/preview`;
    expect((await request(path, { method: "POST", json: input })).status).toBe(200);
    expect(calls[0]!.args.slice(0, 2)).toEqual(["actor-user", WORKSPACE_ID]);
    expect((await request(path, { method: "POST", json: { ...input, workspaceId: "forged" } })).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  test("does not expose the removed single scheduling or metrics routes", async () => {
    const { request } = harness();
    expect((await request(`/api/projects/${PROJECT_ID}/social-posts`, { method: "POST", json: {} })).status).toBe(404);
    expect((await request(`${publicationPath}/metrics`)).status).toBe(404);
  });
});
