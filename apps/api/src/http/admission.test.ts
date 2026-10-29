import { describe, expect, mock, test } from "bun:test";
import { type AppUser, ClerkDirectoryUnavailableError, type WorkspaceActorContext } from "@narriflow/auth";
import { ExpectedDomainFailureError } from "@narriflow/services";
import { Hono } from "hono";
import { z } from "zod";
import {
  getActor,
  guardMiddleware,
  getProject,
  getRecordedRateLimit,
  getSignedInActor,
  installRequestPolicy,
  registerRoute,
  requireAdmissionDeclaration,
} from "./admission";
import type { ApiEnv } from "./env";
import {
  apiErrorHandler,
  apiNotFoundHandler,
  errorEnvelopeMiddleware,
} from "./errors";
import { getIdempotencyKey, requireIdempotencyKey } from "./idempotency";
import { enforceRecordedRateLimit } from "./limits";
import { apiRequestId } from "./logging";
import type {
  AuthenticatedRequestPolicyDependencies,
  ProjectAdmissionResult,
  RateLimitCheck,
} from "./request-policy";
import { createRequestPolicyRuntime } from "./request-policy-runtime";
import { requireJsonContentType, validate } from "./route";

const user = { id: "actor-user", clerkId: "clerk-1" } as AppUser;
const workspaceContext: WorkspaceActorContext = {
  userId: "actor-user",
  workspaceId: "workspace-a",
  workspaceName: "Workspace A",
  workspaceOwnerUserId: "owner-user",
  role: "owner",
  status: "active",
  pricingTier: "creator",
  isPersonal: false,
  workspaceSelectionChanged: false,
};

interface HarnessOptions {
  loadAppUser?: () => Promise<AppUser>;
  context?: WorkspaceActorContext | null;
  project?: ProjectAdmissionResult;
  rateLimit?: (input: { key: string; limit: number; windowSeconds: number }) => RateLimitCheck;
  register?: (app: Hono<ApiEnv>) => void;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const rateKeys: string[] = [];
  const policy: AuthenticatedRequestPolicyDependencies = {
    resolveProject: async () => {
      calls.push("project");
      return options.project ?? { kind: "active", projectId: PROJECT_ID };
    },
    rateLimit: async (input) => {
      calls.push("rate");
      rateKeys.push(input.key);
      return options.rateLimit?.(input) ?? { allowed: true };
    },
    now: () => 1_000,
    recordDiagnostic: (value) => diagnostics.push(value),
  };
  const authenticate = mock(async (request: Request) => {
    calls.push("authenticate");
    return request.headers.get("authorization") === "Bearer good"
      ? ({ status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never)
      : ({ status: "unauthenticated", reason: "missing_credential" } as const);
  });
  const runtime = createRequestPolicyRuntime({
    authenticate,
    loadAppUser: async () => {
      calls.push("user");
      return options.loadAppUser ? options.loadAppUser() : user;
    },
    resolveScopedWorkspace: async (_user, hint) => {
      calls.push(`workspace:${hint ?? "none"}`);
      return hint === "workspace-a" ? (options.context ?? workspaceContext) : null;
    },
    staffAllowlist: new Set(),
    policy,
  });
  const app = new Hono<ApiEnv>();
  app.use("*", apiRequestId());
  app.use("*", errorEnvelopeMiddleware());
  app.onError(apiErrorHandler);
  app.notFound(apiNotFoundHandler);
  app.use("*", installRequestPolicy(runtime));
  app.use("*", requireAdmissionDeclaration());
  registerRoute(app, "GET", "/api/ping", { kind: "workspace", capability: "content.view" }, [(c) =>
    c.json({ workspace: getActor(c).workspaceId })]);
  options.register?.(app);
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: "Bearer good",
        "x-workspace-id": "workspace-a",
        "x-request-id": "outer-request-1",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  return { app, request, calls, diagnostics, rateKeys, authenticate };
}

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

test("a scoped response reports the admitted Workspace rather than an unverified hint", async () => {
  const { request } = harness();
  const response = await request("/api/ping");
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Workspace-Id")).toBe("workspace-a");
});

describe("fail-closed route registration", () => {
  test.each(["GET", "POST", "PUT", "PATCH", "DELETE"])(
    "returns the JSON 404 for an unmatched %s request without resolving an actor",
    async (method) => {
      const { request, authenticate } = harness();
      const response = await request("/api/unknown-route", { method });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: "not_found", requestId: "outer-request-1" });
      expect(authenticate).not.toHaveBeenCalled();
    },
  );

  test("returns 404 for an unsupported method on a known path", async () => {
    const { request } = harness();
    expect((await request("/api/ping", { method: "PUT" })).status).toBe(404);
  });

  test.each(["get", "all"] as const)(
    "refuses an undeclared registered %s handler before it runs",
    async (method) => {
      const handler = mock(() => Response.json({ privateData: "hidden" }));
      const { request, authenticate } = harness({
        register: (app) => {
          app[method]("/api/undeclared", handler);
        },
      });
      const response = await request("/api/undeclared");
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: "request_policy_missing" });
      expect(handler).not.toHaveBeenCalled();
      expect(authenticate).not.toHaveBeenCalled();
    },
  );

  // The F01 shape: the first registration that matches answers, so a later
  // marker must never vouch for an earlier unguarded handler.
  test("an unguarded duplicate registered before the guarded route is refused, not served", async () => {
    const unguarded = mock(() => Response.json({ unauthorized: true }));
    const guarded = mock(() => Response.json({ guarded: true }));
    const { request, authenticate } = harness({
      register: (app) => {
        app.get("/api/probe", unguarded);
        registerRoute(app, "GET", "/api/probe", { kind: "workspace", capability: "content.view" }, [guarded]);
      },
    });
    for (const headers of [{ authorization: "" }, {}]) {
      const response = await request("/api/probe", { headers });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: "request_policy_missing" });
    }
    expect(unguarded).not.toHaveBeenCalled();
    expect(guarded).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
  });

  test("an unguarded duplicate registered behind the guarded route is refused too", async () => {
    const unguarded = mock(() => Response.json({ unauthorized: true }));
    const guarded = mock(() => Response.json({ guarded: true }));
    const { request } = harness({
      register: (app) => {
        registerRoute(app, "GET", "/api/probe", { kind: "workspace", capability: "content.view" }, [guarded]);
        app.get("/api/probe", unguarded);
      },
    });
    const response = await request("/api/probe");
    expect(response.status).toBe(500);
    expect(unguarded).not.toHaveBeenCalled();
    expect(guarded).not.toHaveBeenCalled();
  });

  test("lets a route with declared independent trust run without a session", async () => {
    const { request, authenticate } = harness({
      register: (app) => {
        registerRoute(app, "GET", "/api/share/:token", { trust: "public_share_token" }, [
          (c) => c.json({ shared: true }),
        ]);
      },
    });
    const response = await request("/api/share/abc", { headers: { authorization: "" } });
    expect(response.status).toBe(200);
    expect(authenticate).not.toHaveBeenCalled();
  });
});

describe("Authenticated Request Policy order over HTTP", () => {
  test("a missing Bearer is a 401 before the Workspace, limits or handler are consulted", async () => {
    const handler = mock(() => Response.json({}));
    const { request, calls } = harness({
      register: (app) => {
        registerRoute(app, "GET", "/api/guarded", { kind: "workspace", capability: "content.view" }, [handler]);
      },
    });
    const response = await request("/api/guarded", { headers: { authorization: "" } });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "authentication_required",
      requestId: "outer-request-1",
    });
    expect(calls).toEqual(["authenticate"]);
    expect(handler).not.toHaveBeenCalled();
  });

  test("a removed or absent Workspace selection is a 409 and never falls back to another Workspace", async () => {
    const handler = mock(() => Response.json({}));
    const { request, calls } = harness({
      register: (app) => {
        registerRoute(app, "POST", "/api/commands", { kind: "workspace", capability: "content.edit" }, [handler]);
      },
    });
    const removed = await request("/api/commands", {
      method: "POST",
      headers: { "x-workspace-id": "workspace-removed" },
    });
    expect(removed.status).toBe(409);
    expect(await removed.json()).toMatchObject({ error: "workspace_selection_changed" });
    const absent = await request("/api/commands", {
      method: "POST",
      headers: { "x-workspace-id": "" },
    });
    expect(absent.status).toBe(409);
    expect(handler).not.toHaveBeenCalled();
    expect(calls).not.toContain("rate");
    expect(calls).not.toContain("project");
  });

  test("signed-in admission ignores the Workspace selection entirely", async () => {
    const { request, calls } = harness({
      register: (app) => {
        registerRoute(app, "GET", "/api/session/bootstrap", { kind: "signed_in" }, [(c) =>
          c.json({ actor: getSignedInActor(c).actorUserId })]);
      },
    });
    const response = await request("/api/session/bootstrap", {
      headers: { "x-workspace-id": "workspace-removed" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ actor: "actor-user" });
    expect(calls.some((call) => call.startsWith("workspace:"))).toBe(false);
  });

  test("runs identity, Workspace, capability, rate, Project, input then the handler", async () => {
    const { request, calls } = harness({
      register: (app) => {
        registerRoute(app, "POST", "/api/projects/:id/rename", { kind: "project", capability: "content.edit", projectParam: "id" }, [validate("json", z.object({ title: z.string() }).strict()),
          (c) => {
            calls.push("handler");
            return c.json({
              project: getProject(c).projectId,
              title: c.req.valid("json").title,
            });
          }]);
      },
    });
    const response = await request(`/api/projects/${PROJECT_ID}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "A clip" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ project: PROJECT_ID, title: "A clip" });
    expect(calls).toEqual([
      "authenticate",
      "user",
      "workspace:workspace-a",
      "project",
      "rate",
      "handler",
    ]);
  });

  test("a viewer is refused on a mutation before the limiter, Project or handler", async () => {
    const handler = mock(() => Response.json({}));
    const { request, calls } = harness({
      context: { ...workspaceContext, role: "viewer" },
      register: (app) => {
        registerRoute(app, "POST", "/api/projects/:id/rename", { kind: "project", capability: "content.edit", projectParam: "id" }, [handler]);
      },
    });
    const response = await request(`/api/projects/${PROJECT_ID}/rename`, { method: "POST" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "capability_denied" });
    expect(calls).not.toContain("rate");
    expect(calls).not.toContain("project");
    expect(handler).not.toHaveBeenCalled();
  });

  test("invalid input is reported only after admission and never reaches the handler", async () => {
    const handler = mock(() => Response.json({}));
    const register = (app: Hono<ApiEnv>) => {
      registerRoute(app, "POST", "/api/things", { kind: "workspace", capability: "content.edit" }, [validate("json", z.object({ title: z.string() }).strict()),
        handler]);
    };
    const anonymous = harness({ register });
    const refused = await anonymous.request("/api/things", {
      method: "POST",
      headers: { authorization: "", "content-type": "application/json" },
      body: "{broken",
    });
    // Unauthenticated callers learn nothing about the schema or the body.
    expect(refused.status).toBe(401);

    const signedIn = harness({ register });
    const invalid = await signedIn.request("/api/things", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: 42, ownerUserId: "forged" }),
    });
    expect(invalid.status).toBe(400);
    const body = await invalid.json();
    expect(body).toMatchObject({
      error: "invalid_input",
      requestId: "outer-request-1",
      issues: [{ path: ["title"], code: "invalid_type" }, { code: "unrecognized_keys" }],
    });
    const malformed = await signedIn.request("/api/things", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "invalid_json" });
    expect(handler).not.toHaveBeenCalled();
  });

  test("an absent optional body validates as an empty object and malformed JSON stays distinguishable", async () => {
    const { request } = harness({
      register: (app) => {
        registerRoute(app, "POST", "/api/optional", { kind: "workspace", capability: "content.edit" }, [validate("json", z.object({ note: z.string().optional() }).strict()),
          (c) => c.json({ received: c.req.valid("json") })]);
      },
    });
    const empty = await request("/api/optional", { method: "POST" });
    expect(await empty.json()).toEqual({ received: {} });
    const malformed = await request("/api/optional", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    });
    expect(malformed.status).toBe(400);
  });

  test("conceals a missing Project and reports an entitled Workspace mismatch", async () => {
    const register = (app: Hono<ApiEnv>) => {
      registerRoute(app, "GET", "/api/projects/:id", { kind: "project", capability: "content.view", projectParam: "id" }, [(c) => c.json({ id: getProject(c).projectId })]);
    };
    const missing = harness({ project: { kind: "missing" }, register });
    const concealed = await missing.request(`/api/projects/${PROJECT_ID}`);
    expect(concealed.status).toBe(404);
    expect(await concealed.json()).toMatchObject({ error: "project_not_found" });

    const mismatch = harness({
      project: {
        kind: "workspace_mismatch",
        projectId: PROJECT_ID,
        workspaceId: "workspace-b",
        workspaceName: "Workspace B",
      },
      register,
    });
    const switched = await mismatch.request(`/api/projects/${PROJECT_ID}`);
    expect(switched.status).toBe(409);
    expect(await switched.json()).toMatchObject({
      error: "active_workspace_mismatch",
      details: { workspaceId: "workspace-b", workspaceName: "Workspace B" },
    });
  });

  test("a failed admission carries the outer request ID in header, body and diagnostics", async () => {
    const { request, diagnostics } = harness({ context: { ...workspaceContext, role: "viewer" } });
    const response = await request("/api/ping", { method: "GET" });
    // viewer has content.view, so use a mutation capability route for the refusal.
    expect(response.status).toBe(200);
    const denied = harness({
      context: { ...workspaceContext, role: "viewer" },
      register: (app) => {
        registerRoute(app, "POST", "/api/x", { kind: "workspace", capability: "content.edit" }, [(c) => c.json({})]);
      },
    });
    const refusal = await denied.request("/api/x", { method: "POST" });
    expect(refusal.headers.get("x-request-id")).toBe("outer-request-1");
    expect((await refusal.json()).requestId).toBe("outer-request-1");
    expect(denied.diagnostics.map((entry) => entry.requestId)).toEqual(["outer-request-1"]);
    expect(diagnostics.map((entry) => entry.requestId)).toEqual(["outer-request-1"]);
  });
});

describe("actor resolution is per request", () => {
  test("one request verifies the token once even across several reads", async () => {
    const { request, authenticate } = harness({
      register: (app) => {
        registerRoute(app, "GET", "/api/twice", { kind: "workspace", capability: "content.view" }, [(c) =>
          c.json({ ok: Boolean(c.get("requestActors")) })]);
      },
    });
    await request("/api/twice");
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  test("nothing is cached between requests", async () => {
    const { request, authenticate } = harness();
    await request("/api/ping");
    await request("/api/ping");
    expect(authenticate).toHaveBeenCalledTimes(2);
  });

  test("an identity provider outage is a 503 with retry guidance, not a sign-out", async () => {
    const policy: AuthenticatedRequestPolicyDependencies = {
      resolveProject: async () => ({ kind: "missing" }),
      rateLimit: async () => ({ allowed: true }),
      now: () => 0,
    };
    const runtime = createRequestPolicyRuntime({
      authenticate: async () => ({ status: "unavailable" }),
      loadAppUser: async () => user,
      resolveScopedWorkspace: async () => workspaceContext,
      staffAllowlist: new Set(),
      policy,
    });
    const app = new Hono<ApiEnv>();
    app.use("*", apiRequestId());
    app.onError(apiErrorHandler);
    app.use("*", installRequestPolicy(runtime));
    registerRoute(app, "GET", "/api/ping", { kind: "signed_in" }, [(c) => c.json({})]);
    const response = await app.request("/api/ping", { headers: { authorization: "Bearer x" } });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toMatchObject({ error: "authentication_unavailable" });
  });
});

describe("rate limiting", () => {
  test("a Clerk directory outage while provisioning is a retryable 503, not a 500 or a sign-out", async () => {
    const outage = harness({
      loadAppUser: async () => {
        throw new ClerkDirectoryUnavailableError(new TypeError("fetch failed"));
      },
    });
    const response = await outage.request("/api/ping");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toMatchObject({
      error: "authentication_unavailable",
      requestId: "outer-request-1",
    });

    const database = harness({
      loadAppUser: async () => {
        throw new Error("database down");
      },
    });
    expect((await database.request("/api/ping")).status).toBe(500);
  });

  test("GET uses the read tier and POST the mutation tier, with the operation limit after the baseline", async () => {
    const { request, rateKeys } = harness({
      register: (app) => {
        registerRoute(app, "GET", "/api/items", { kind: "workspace", capability: "content.view" }, [(c) => c.json({})]);
        registerRoute(app, "POST", "/api/projects/:id/generate", {
            kind: "project",
            capability: "processing.consume",
            projectParam: "id",
            rate: { scope: "actor", prefix: "gen", limit: 20 },
          }, [(c) => c.json({})]);
      },
    });
    await request("/api/items");
    await request(`/api/projects/${PROJECT_ID}/generate`, { method: "POST" });
    expect(rateKeys).toEqual([
      "api-read:workspace-a:actor-user",
      "api-mutation:workspace-a:actor-user",
      "gen:actor-user",
    ]);
  });

  test("the editor tier has its own per-clip and actor-global buckets and skips the mutation bucket", async () => {
    const { request, rateKeys } = harness({
      register: (app) => {
        registerRoute(app, "PUT", "/api/projects/:id/clips/:clipId/editor-document", {
            kind: "project",
            capability: "content.edit",
            projectParam: "id",
            tier: "editor",
          }, [(c) => c.json({})]);
      },
    });
    await request(`/api/projects/${PROJECT_ID}/clips/clip-1/editor-document`, { method: "PUT" });
    expect(rateKeys).toEqual([
      "api-editor:workspace-a:actor-user:clip-1",
      "api-editor-global:actor-user",
    ]);
  });

  test("a tier override moves a polling POST to the read bucket", async () => {
    const { request, rateKeys } = harness({
      register: (app) => {
        registerRoute(app, "POST", "/api/upload-sessions/status", { kind: "workspace", capability: "processing.consume", tier: "read" }, [(c) => c.json({})]);
      },
    });
    await request("/api/upload-sessions/status", { method: "POST" });
    expect(rateKeys).toEqual(["api-read:workspace-a:actor-user"]);
  });

  test("an exhausted ordinary limit is a 429 with Retry-After and no handler call", async () => {
    const handler = mock(() => Response.json({}));
    const { request } = harness({
      rateLimit: () => ({ allowed: false, retryAfterSeconds: 12 }),
      register: (app) => {
        registerRoute(app, "POST", "/api/limited", { kind: "workspace", capability: "content.edit" }, [handler]);
      },
    });
    const response = await request("/api/limited", { method: "POST" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(await response.json()).toMatchObject({ error: "rate_limited", retryAfterSeconds: 12 });
    expect(handler).not.toHaveBeenCalled();
  });

  test("reports the tightest window in RateLimit headers", async () => {
    const { request } = harness({
      rateLimit: ({ limit }) => ({
        allowed: true,
        availability: "available",
        limit,
        remaining: limit - 1,
      }),
    });
    const response = await request("/api/ping");
    expect(response.headers.get("ratelimit-limit")).toBe("300");
    expect(response.headers.get("ratelimit-remaining")).toBe("299");
    expect(response.headers.get("ratelimit-reset")).toBe("59");
  });

  describe("receipt commands", () => {
    function receiptApp(options: { replayed: boolean; rateLimit: HarnessOptions["rateLimit"] }) {
      return harness({
        rateLimit: options.rateLimit,
        register: (app) => {
          registerRoute(app, "POST", "/api/folders", { kind: "workspace", capability: "content.edit", deferRateRefusal: true }, [requireIdempotencyKey(),
            (c) => {
              // The domain replays an immutable receipt before it enforces the limiter.
              if (options.replayed) {
                c.header("Idempotent-Replayed", "true");
                return c.json({ id: "folder-1", key: getIdempotencyKey(c) });
              }
              enforceRecordedRateLimit(getRecordedRateLimit(c));
              return c.json({ id: "folder-2" }, 201);
            }]);
        },
      });
    }
    const post = (h: ReturnType<typeof harness>, key = "key-1") =>
      h.request("/api/folders", { method: "POST", headers: { "idempotency-key": key } });

    test("an immutable replay is answered even when the limiter is exhausted", async () => {
      const response = await post(receiptApp({ replayed: true, rateLimit: () => ({ allowed: false }) }));
      expect(response.status).toBe(200);
      expect(response.headers.get("idempotent-replayed")).toBe("true");
    });

    test("an immutable replay is answered even when the limiter is unavailable", async () => {
      const response = await post(
        receiptApp({ replayed: true, rateLimit: () => ({ allowed: true, availability: "unavailable" }) }),
      );
      expect(response.status).toBe(200);
    });

    test("new work is refused 429 when counters are exhausted", async () => {
      const response = await post(
        receiptApp({ replayed: false, rateLimit: () => ({ allowed: false, availability: "available", retryAfterSeconds: 30 }) }),
      );
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("30");
    });

    test("new work is paused 503 mutations_unavailable when the limiter is unavailable", async () => {
      const response = await post(
        receiptApp({ replayed: false, rateLimit: () => ({ allowed: true, availability: "unavailable" }) }),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.json()).toMatchObject({ error: "mutations_unavailable" });
    });

    test("new work proceeds when the limiter is healthy", async () => {
      const response = await post(
        receiptApp({ replayed: false, rateLimit: () => ({ allowed: true, availability: "available" }) }),
      );
      expect(response.status).toBe(201);
    });

    test("a missing Idempotency-Key is refused after admission", async () => {
      const h = receiptApp({ replayed: false, rateLimit: () => ({ allowed: true }) });
      const response = await h.request("/api/folders", { method: "POST" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "idempotency_key_required" });
    });
  });
});

describe("handler failures keep the common envelope", () => {
  const testApp = (handler: () => Response | Promise<Response>) =>
    harness({
      register: (app) => {
        registerRoute(app, "GET", "/api/projects-list", { kind: "workspace", capability: "content.view" }, [handler]);
      },
    });

  test("normalizes literal handler failures with the request ID", async () => {
    const { request } = testApp(() =>
      Response.json(
        { error: "literal_invalid", message: "Safe literal message", private: "hidden" },
        { status: 400 },
      ),
    );
    const response = await request("/api/projects-list");
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("outer-request-1");
    expect(await response.json()).toEqual({
      error: "literal_invalid",
      message: "Safe literal message",
      requestId: "outer-request-1",
    });
  });

  test.each([
    ["invalid", 400],
    ["unprocessable", 422],
    ["forbidden", 403],
    ["payment_required", 402],
    ["missing", 404],
    ["conflict", 409],
    ["rate_limited", 429],
    ["unavailable", 503],
  ] as const)("translates the %s domain kind at the middleware seam", async (kind, status) => {
    const { request } = testApp(() => {
      throw new ExpectedDomainFailureError({
        code: `example_${kind}`,
        kind,
        message: "Safe domain message.",
      });
    });
    const response = await request("/api/projects-list");
    expect(response.status).toBe(status);
    expect(response.headers.get("x-request-id")).toBe("outer-request-1");
    expect(await response.json()).toEqual({
      error: `example_${kind}`,
      message: "Safe domain message.",
      requestId: "outer-request-1",
    });
  });

  test("bounds details and applies retry guidance", async () => {
    const details = {
      ["k".repeat(300)]: "value",
      ...Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`field${index}`, index === 0 ? "x".repeat(300) : index]),
      ),
    };
    const { request } = testApp(() => {
      throw new ExpectedDomainFailureError({
        code: "provider_busy",
        kind: "rate_limited",
        message: "Try again soon.",
        details,
        retryAfterSeconds: 2.1,
      });
    });
    const response = await request("/api/projects-list");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    const body = await response.json();
    expect(body.retryAfterSeconds).toBe(3);
    expect(Object.keys(body.details)).toHaveLength(16);
    expect(Object.keys(body.details)[0]).toHaveLength(80);
    expect(body.details.field0).toHaveLength(240);
  });

  test("redacts unknown exceptions and keeps the diagnostic request ID", async () => {
    const { request } = testApp(() => {
      throw new Error("private provider token");
    });
    const response = await request("/api/projects-list");
    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe("outer-request-1");
    const body = await response.json();
    expect(body).toEqual({
      error: "internal_error",
      message: "Something went wrong. Try again or contact support.",
      requestId: "outer-request-1",
    });
    expect(JSON.stringify(body)).not.toContain("provider token");
  });
});

describe("JSON content type guard", () => {
  test("refuses a body that is not application/json with a 415 envelope", async () => {
    const handler = mock(() => Response.json({}));
    const h = harness({
      register: (app) => {
        app.use("/api/json/*", guardMiddleware(requireJsonContentType()));
        registerRoute(app, "POST", "/api/json/thing", { kind: "workspace", capability: "content.edit" }, [handler]);
      },
    });
    const response = await h.request("/api/json/thing", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: "unsupported_media_type" });
    expect(handler).not.toHaveBeenCalled();
  });
});
