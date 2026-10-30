import { describe, expect, mock, test } from "bun:test";
import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import { Hono } from "hono";
import { createLifecycle, disableIdleTimeout, getLifecycle } from "./server-hooks";
import { NATIVE_BODY_CAP_BYTES } from "./http/limits";
import { bodyClass } from "./body-limits";
import { createRouteApp, getActor } from "./http/admission";
import type { ApiEnv } from "./http/env";
import { createRequestPolicyRuntime } from "./http/request-policy-runtime";
import { createProjectsRoutes, type ProjectsRouteDeps } from "./domains/projects/routes";
import { createInventoryApp } from "./test-app";

const WEB = "http://localhost:3000";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const user = { id: "actor-user", clerkId: "clerk-1" } as AppUser;
const context: WorkspaceActorContext = {
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

function policyRuntime() {
  return createRequestPolicyRuntime({
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer good"
        ? ({ status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never)
        : ({ status: "unauthenticated", reason: "missing_credential" } as const),
    loadAppUser: async () => user,
    resolveScopedWorkspace: async (_user, hint) => (hint === "workspace-a" ? context : null),
    staffAllowlist: new Set(),
    policy: {
      resolveProject: async () => ({ kind: "active", projectId: PROJECT_ID }),
      rateLimit: async () => ({ allowed: true }),
      now: () => 1_000,
    },
  });
}

const signedIn = {
  authorization: "Bearer good",
  "x-workspace-id": "workspace-a",
  origin: WEB,
};

describe("ingress", () => {
  test("health answers without credentials and names no secret", async () => {
    const app = createInventoryApp();
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "narriflow-api", version: "test" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  test("readiness needs the database but not Redis or providers, and fails while draining", async () => {
    expect((await createInventoryApp().request("/api/ready")).status).toBe(200);

    const down = createInventoryApp({
      health: { checkDatabase: async () => Promise.reject(new Error("connection refused: secret-host")) },
    });
    const failed = await down.request("/api/ready");
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      ok: false,
      status: "unavailable",
      checks: { configuration: "ok", database: "failed" },
    });

    const slow = createInventoryApp({
      health: { checkDatabase: () => new Promise(() => {}), databaseTimeoutMs: 20 },
    });
    expect((await slow.request("/api/ready")).status).toBe(503);

    const lifecycle = createLifecycle();
    const draining = createInventoryApp({ health: { isDraining: () => lifecycle.draining } });
    await lifecycle.beginDrain();
    const drained = await draining.request("/api/ready");
    expect(drained.status).toBe(503);
    expect(await drained.json()).toEqual({ ok: false, status: "draining" });
  });

  test("an unknown path is a JSON 404, never a missing-policy 500", async () => {
    const response = await createInventoryApp().request("/api/nothing-here");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });

  test("a first-party route without a credential is a JSON 401 with the request ID", async () => {
    const response = await createInventoryApp().request("/api/recipes", {
      headers: { origin: WEB, "x-request-id": "req-1" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "authentication_required", requestId: "req-1" });
    expect(response.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("a browser origin outside the allowlist is refused, preflight included", async () => {
    const app = createInventoryApp();
    const get = await app.request("/api/recipes", { headers: { origin: "https://evil.example" } });
    expect(get.status).toBe(403);
    expect(get.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await app.request("/api/recipes", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(403);
  });

  test("a registered first-party handler with no admission declaration is refused before it runs", async () => {
    const handler = mock(() => Response.json({ hidden: true }));
    const rogue = new Hono<ApiEnv>().get("/rogue", handler);
    const response = await createInventoryApp({ domains: { session: rogue } }).request("/api/rogue", {
      headers: signedIn,
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "request_policy_missing" });
    expect(handler).not.toHaveBeenCalled();
  });

  test("the staff area exists and answers 401 to an anonymous caller", async () => {
    const response = await createInventoryApp().request("/api/admin/anything", { headers: { origin: WEB } });
    expect(response.status).toBe(401);
  });
});

describe("request bodies", () => {
  const oneMiB = 1024 * 1024;

  function chunked(bytes: number): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream({
      pull(controller) {
        if (sent >= bytes) return controller.close();
        const size = Math.min(64 * 1024, bytes - sent);
        controller.enqueue(new Uint8Array(size).fill(0x20));
        sent += size;
      },
    });
  }

  function post(app: Hono<ApiEnv>, path: string, bytes: number) {
    return app.request(path, {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/json" },
      body: chunked(bytes),
      duplex: "half",
    } as RequestInit);
  }

  test("a chunked body over the control ceiling is a 413 envelope before authentication", async () => {
    const response = await post(createInventoryApp(), "/api/recipes", oneMiB + 1);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "payload_too_large" });
  });

  test("a route that declares the editor class accepts what the control class refuses", async () => {
    const editorRoute = createRouteApp({
      "POST /bulk": { kind: "workspace", capability: "content.edit" },
    }).post("/bulk", bodyClass("editor"), (c) => c.json({ workspace: getActor(c).workspaceId }));
    const app = createInventoryApp({
      policyRuntime: policyRuntime(),
      domains: { studio: editorRoute },
    });
    const accepted = await post(app, "/api/bulk", 2 * oneMiB);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ workspace: "workspace-a" });
    expect((await post(app, "/api/bulk", 8 * oneMiB + 1)).status).toBe(413);
  });

  test("webhooks keep their 1 MiB ceiling and are not subject to CORS or content-type guards", async () => {
    const app = createInventoryApp();
    const tooLarge = await app.request("/api/webhooks/clerk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chunked(oneMiB + 1),
      duplex: "half",
    } as RequestInit);
    expect(tooLarge.status).toBe(413);

    const unsigned = await app.request("/api/webhooks/clerk", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      body: "{}",
    });
    // Reaches the Svix adapter (which rejects the missing signature), not CORS or the JSON guard.
    expect(unsigned.status).toBe(400);
  });
});

describe("partitioned handlers behind the real policy", () => {
  function projectsApp(deps: Partial<ProjectsRouteDeps>) {
    return createInventoryApp({
      policyRuntime: policyRuntime(),
      domains: { projects: createProjectsRoutes(deps as ProjectsRouteDeps) },
    });
  }

  test("a read passes the admitted actor to the service and keeps its 404 shape", async () => {
    const getProjectSnapshot = mock(async (_actor: unknown, id: string) => ({
      project: id === PROJECT_ID ? { id } : null,
      lastSeq: 7,
    }));
    const app = projectsApp({ projectService: { getProjectSnapshot } as never });
    const found = await app.request(`/api/projects/${PROJECT_ID}`, { headers: signedIn });
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ project: { id: PROJECT_ID }, lastSeq: 7 });
    expect(getProjectSnapshot.mock.calls[0]?.[0]).toMatchObject({
      actorUserId: "actor-user",
      workspaceId: "workspace-a",
    });
  });

  test("a mutation needs its Idempotency-Key, then validates input, in the policy's order", async () => {
    const triggerGeneration = mock(async () => ({ workflowRunId: "run-1" }));
    const app = projectsApp({ projectService: { triggerGeneration } as never });
    const base = { ...signedIn, "content-type": "application/json" };
    const url = `/api/projects/${PROJECT_ID}/generate`;

    const noKey = await app.request(url, { method: "POST", headers: base, body: "{}" });
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({ error: "idempotency_key_required" });

    const invalid = await app.request(url, {
      method: "POST",
      headers: { ...base, "idempotency-key": "k-1" },
      body: JSON.stringify({ contentPack: "nope" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "invalid_input" });
    expect(triggerGeneration).not.toHaveBeenCalled();
  });

  test("an unauthenticated caller never learns what the input schema accepts", async () => {
    const app = projectsApp({ projectService: {} as never });
    const response = await app.request(`/api/projects/${PROJECT_ID}/generate`, {
      method: "POST",
      headers: { origin: WEB, "content-type": "application/json", "idempotency-key": "k" },
      body: "not json",
    });
    expect(response.status).toBe(401);
  });
});

describe("server hooks", () => {
  test("an admitted stream can lift Bun's idle timeout for its own request only", async () => {
    const timeout = mock((_request: Request, _seconds: number) => {});
    const app = new Hono<ApiEnv>().get("/stream", (c) => {
      disableIdleTimeout(c);
      return c.text("ok");
    });
    const request = new Request("http://localhost/stream");
    await app.fetch(request, { server: { timeout, requestIP: () => null } });
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout.mock.calls[0]?.[0]).toBe(request);
    expect(timeout.mock.calls[0]?.[1]).toBe(0);
  });

  test("without a server binding the hook does nothing", async () => {
    const app = new Hono<ApiEnv>().get("/stream", (c) => {
      disableIdleTimeout(c);
      return c.text("ok");
    });
    expect((await app.request("/stream")).status).toBe(200);
  });

  test("draining closes registered subscribers once and skips ones that already ended", async () => {
    const lifecycle = createLifecycle();
    const closed: string[] = [];
    lifecycle.onDrain(() => void closed.push("a"));
    const unregister = lifecycle.onDrain(() => void closed.push("b"));
    lifecycle.onDrain(async () => {
      throw new Error("a failing closer must not stop the others");
    });
    unregister();
    expect(lifecycle.draining).toBe(false);
    await lifecycle.beginDrain();
    await lifecycle.beginDrain();
    expect(lifecycle.draining).toBe(true);
    expect(closed).toEqual(["a"]);
  });
});

describe("draining", () => {
  test("a closer registered after the drain began runs at once and never waits for a drain that already happened", async () => {
    const lifecycle = createLifecycle();
    const closed: string[] = [];
    await lifecycle.beginDrain();
    const unregister = lifecycle.onDrain(() => void closed.push("late"));
    expect(closed).toEqual(["late"]);
    unregister();
    // Also while the earlier closers are still running.
    const slow = createLifecycle();
    let release!: () => void;
    slow.onDrain(() => new Promise<void>((resolve) => (release = resolve)));
    const draining = slow.beginDrain();
    slow.onDrain(() => void closed.push("during"));
    expect(closed).toEqual(["late", "during"]);
    release();
    await draining;
  });

  test("every closer runs even when one throws synchronously or rejects, and a second drain shares the first", async () => {
    const lifecycle = createLifecycle();
    const closed: string[] = [];
    lifecycle.onDrain(() => {
      throw new Error("sync failure");
    });
    lifecycle.onDrain(async () => {
      throw new Error("async failure");
    });
    lifecycle.onDrain(() => void closed.push("after"));
    const first = lifecycle.beginDrain();
    expect(lifecycle.beginDrain()).toBe(first);
    await first;
    expect(closed).toEqual(["after"]);
  });

  test("once draining, a first-party request is a 503 envelope with Retry-After and CORS", async () => {
    const lifecycle = createLifecycle();
    const app = createInventoryApp({ health: { isDraining: () => lifecycle.draining } });
    expect((await app.request("/api/recipes", { headers: { origin: WEB } })).status).toBe(401);
    await lifecycle.beginDrain();
    const response = await app.request("/api/recipes", {
      headers: { origin: WEB, "x-request-id": "req-drain" },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(response.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(await response.json()).toMatchObject({
      error: "server_draining",
      requestId: "req-drain",
      retryAfterSeconds: 5,
    });
    // Readiness is how the platform learns; liveness stays up.
    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/api/ready")).status).toBe(503);
  });

  test("a request paused before it registers its stream closer is closed when SIGTERM begins the drain", async () => {
    const lifecycle = createLifecycle();
    let proceed!: () => void;
    const paused = new Promise<void>((resolve) => (proceed = resolve));
    const reached = mock(() => {});
    const closer = mock(() => {});
    const stream = createRouteApp({ "GET /stream": { trust: "public_share_token" } }).get("/stream", async (c) => {
      reached();
      await paused;
      getLifecycle(c)?.onDrain(closer);
      return c.text("subscribed");
    });
    const app = createInventoryApp({
      domains: { progress: stream },
      health: { isDraining: () => lifecycle.draining },
    });
    const inflight = app.request("/api/stream", {}, { lifecycle });
    while (reached.mock.calls.length === 0) await Promise.resolve();

    const drain = lifecycle.beginDrain();
    // New admission is already refused while the paused request is still in flight.
    expect((await app.request("/api/stream", {}, { lifecycle })).status).toBe(503);
    proceed();
    expect((await inflight).status).toBe(200);
    await drain;
    expect(closer).toHaveBeenCalledTimes(1);
  });
});

describe("ingress refusals stay readable by first-party browsers", () => {
  test("a 414 or 431 for an allowed origin carries CORS headers; other origins and API classes do not", async () => {
    const app = createInventoryApp();
    const longPath = `/api/recipes?q=${"a".repeat(9 * 1024)}`;
    const allowed = await app.request(longPath, { headers: { origin: WEB } });
    expect(allowed.status).toBe(414);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(allowed.headers.get("vary")).toContain("Origin");
    expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();
    expect(await allowed.json()).toMatchObject({ error: "uri_too_long" });

    const padded: Record<string, string> = { origin: WEB };
    for (let index = 0; index < 10; index += 1) padded[`x-pad-${index}`] = "v".repeat(4 * 1024);
    const headers = await app.request("/api/recipes", { headers: padded });
    expect(headers.status).toBe(431);
    expect(headers.headers.get("access-control-allow-origin")).toBe(WEB);

    const foreign = await app.request(longPath, { headers: { origin: "https://evil.example" } });
    expect(foreign.status).toBe(414);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();

    const webhook = await app.request(`/api/webhooks/clerk?q=${"a".repeat(9 * 1024)}`, {
      headers: { origin: WEB },
    });
    expect(webhook.status).toBe(414);
    expect(webhook.headers.get("access-control-allow-origin")).toBeNull();
    const rest = await app.request(`/api/v1/projects?q=${"a".repeat(9 * 1024)}`, { headers: { origin: WEB } });
    expect(rest.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("native body ceiling", () => {
  const request = (url: string, bytes: number) =>
    fetch(url, {
      method: "POST",
      headers: { origin: WEB, "content-type": "application/json", authorization: "Bearer good", "x-workspace-id": "workspace-a" },
      body: new Uint8Array(bytes),
    });

  test("a body over the route class but under Bun's cap gets the common 413 envelope with CORS; beyond the cap Bun answers natively", async () => {
    // Bun's cap is sized for the provider-result class; every other route keeps
    // the 16 MiB ceiling in the application (see webhook-ingress.test.ts).
    const app = createInventoryApp({ policyRuntime: policyRuntime() });
    expect(NATIVE_BODY_CAP_BYTES).toBeGreaterThan(8 * 1024 * 1024);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      maxRequestBodySize: NATIVE_BODY_CAP_BYTES,
      fetch: (req, bunServer) => app.fetch(req, { server: bunServer }),
    });
    try {
      const url = `http://127.0.0.1:${server.port}/api/recipes`;
      const enveloped = await request(url, 9 * 1024 * 1024);
      expect(enveloped.status).toBe(413);
      expect(enveloped.headers.get("access-control-allow-origin")).toBe(WEB);
      expect(enveloped.headers.get("x-request-id")).toBeTruthy();
      expect(await enveloped.json()).toMatchObject({ error: "payload_too_large" });

      // The documented exception: Bun refuses a declared length over its cap
      // before the application runs (413, or a bare 400 on a reused connection
      // in the Bun 1.3.6 image), so there is no envelope or request ID.
      const ceiling = await request(url, 17 * 1024 * 1024);
      expect(ceiling.status).toBe(413);
      expect(ceiling.headers.get("x-request-id")).toBeTruthy();
      expect(await ceiling.json()).toMatchObject({ error: "payload_too_large" });

      const native = await request(url, NATIVE_BODY_CAP_BYTES + 1);
      expect([400, 413]).toContain(native.status);
      expect(native.headers.get("x-request-id")).toBeNull();
      expect(await native.text()).toBe("");
    } finally {
      await server.stop(true);
    }
  });
});
