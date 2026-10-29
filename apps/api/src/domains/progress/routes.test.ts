import { describe, expect, test } from "bun:test";
import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import { createRequestPolicyRuntime } from "../../http/request-policy-runtime";
import { createLifecycle } from "../../server-hooks";
import { createInventoryApp } from "../../test-app";
import { type ProgressRouteDeps, createProgressRoutes } from "./routes";
import { collectFrames, createFakeBackend, ev } from "./test-support";

const PROJECT_ID = "50000000-0000-4000-8000-000000000001";
const WEB = "http://localhost:3000";
const user = { id: "actor-user", clerkId: "clerk-1" } as AppUser;
const context: WorkspaceActorContext = {
  userId: "actor-user",
  workspaceId: "workspace-a",
  workspaceName: "Workspace A",
  workspaceOwnerUserId: "owner-user",
  role: "editor",
  status: "active",
  pricingTier: "creator",
  isPersonal: false,
  workspaceSelectionChanged: false,
};

interface World {
  /** Flip to simulate the session token expiring. */
  tokenValid: boolean;
  membership: boolean;
  project: "active" | "missing";
  rateAllowed: boolean;
  authentications: number;
}

function build(options: { limits?: ProgressRouteDeps["limits"]; log?: Parameters<typeof createFakeBackend>[0] } = {}) {
  const world: World = { tokenValid: true, membership: true, project: "active", rateAllowed: true, authentications: 0 };
  const backend = createFakeBackend(options.log ?? []);
  const policyRuntime = createRequestPolicyRuntime({
    authenticate: async (request) => {
      world.authentications += 1;
      return request.headers.get("authorization") === "Bearer good" && world.tokenValid
        ? ({ status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never)
        : ({ status: "unauthenticated", reason: "rejected_token" } as const);
    },
    loadAppUser: async () => user,
    resolveScopedWorkspace: async (_user, hint) => (hint === "workspace-a" && world.membership ? context : null),
    staffAllowlist: new Set(),
    policy: {
      resolveProject: async () =>
        world.project === "active" ? { kind: "active", projectId: PROJECT_ID } : { kind: "missing" },
      rateLimit: async () => ({ allowed: world.rateAllowed, availability: "available", retryAfterSeconds: 30, limit: 30, remaining: 3 }),
      now: () => 1_000,
    },
  });
  const timeouts: number[] = [];
  const lifecycle = createLifecycle();
  const app = createInventoryApp({
    policyRuntime,
    health: { isDraining: () => lifecycle.draining },
    domains: {
      progress: createProgressRoutes({
        getEventsSince: backend.getEventsSince,
        subscribeLive: backend.subscribeLive,
        limits: options.limits ?? { maxConnections: 10, maxConnectionsPerActor: 5 },
        timing: { heartbeatMs: 20, fallbackPollMs: 20 },
      }),
    },
  });
  const env = { lifecycle, server: { timeout: (_r: Request, s: number) => void timeouts.push(s), requestIP: () => null } };
  const headers = { authorization: "Bearer good", "x-workspace-id": "workspace-a", origin: WEB };
  const open = (path = `/api/stream/${PROJECT_ID}`, init: RequestInit = {}) =>
    app.request(path, { headers, ...init }, env);
  return { world, backend, timeouts, lifecycle, open };
}

describe("GET /api/stream/:projectId", () => {
  test("streams SSE with the stream headers, replays after sinceSeq and lifts the idle timeout for this request", async () => {
    const t = build({ log: [ev(1), ev(2), ev(3)] });
    const response = await t.open(`/api/stream/${PROJECT_ID}?sinceSeq=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("x-workspace-id")).toBe("workspace-a");
    expect(response.headers.get("access-control-allow-origin")).toBe(WEB);
    const reader = collectFrames(response.body as ReadableStream<Uint8Array>);
    await reader.until(() => reader.seqs().length === 2);
    expect(reader.seqs()).toEqual([2, 3]);
    expect(t.timeouts).toEqual([0]);
    await reader.cancel();
    await reader.done;
  });

  test("refuses before streaming: signed out, concealed Project, bad id, exhausted start limit", async () => {
    const t = build();
    expect((await t.open(undefined, { headers: { "x-workspace-id": "workspace-a", origin: WEB } })).status).toBe(401);
    t.world.project = "missing";
    const missing = await t.open();
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "project_not_found" });
    t.world.project = "active";
    expect((await t.open("/api/stream/not-a-uuid")).status).toBe(400);
    t.world.rateAllowed = false;
    const limited = await t.open();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    expect(t.timeouts).toEqual([]); // only admitted streams lift the timeout
  });

  test("each heartbeat verifies the token again; an expired token ends with one control event so the client can reconnect", async () => {
    const t = build();
    const response = await t.open();
    const reader = collectFrames(response.body as ReadableStream<Uint8Array>);
    await reader.until((f) => f.some((x) => x.event === "ping"));
    const before = t.world.authentications;
    expect(before).toBeGreaterThan(1); // admission plus at least one re-check
    t.world.tokenValid = false;
    await reader.done;
    expect(reader.frames.filter((f) => f.event === "authorization.revoked")).toEqual([
      { event: "authorization.revoked", data: { error: "authentication_required", requestId: expect.any(String) } },
    ]);
    expect(t.backend.liveCount).toBe(0);
  });

  test("revoked membership and a vanished Project each end the stream with their own code", async () => {
    for (const [mutate, code] of [
      [(w: World) => { w.membership = false; }, "workspace_selection_changed"],
      [(w: World) => { w.project = "missing"; }, "project_not_found"],
    ] as const) {
      const t = build();
      const response = await t.open();
      const reader = collectFrames(response.body as ReadableStream<Uint8Array>);
      await reader.until((f) => f.some((x) => x.event === "ping"));
      mutate(t.world);
      await reader.done;
      expect(reader.frames.at(-1)).toMatchObject({ event: "authorization.revoked", data: { error: code } });
    }
  });

  test("bounds open streams per actor and frees the slot when one closes", async () => {
    const t = build({ limits: { maxConnections: 10, maxConnectionsPerActor: 1 } });
    const first = await t.open();
    expect(first.status).toBe(200);
    const second = await t.open();
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("5");
    expect(await second.json()).toMatchObject({ error: "too_many_streams" });
    const reader = collectFrames(first.body as ReadableStream<Uint8Array>);
    await reader.until((f) => f.length > 0);
    await reader.cancel();
    await reader.done;
    expect((await t.open()).status).toBe(200);
  });

  test("bounds streams per process", async () => {
    const t = build({ limits: { maxConnections: 1, maxConnectionsPerActor: 5 } });
    expect((await t.open()).status).toBe(200);
    const refused = await t.open();
    expect(refused.status).toBe(503); // 5xx bodies are always generic; the status and Retry-After carry the meaning
    expect(refused.headers.get("retry-after")).toBe("5");
  });

  test("SIGTERM closes open streams and releases their subscriptions", async () => {
    const t = build();
    const response = await t.open();
    const reader = collectFrames(response.body as ReadableStream<Uint8Array>);
    await reader.until((f) => f.length > 0 && t.backend.liveCount === 1);
    await t.lifecycle.beginDrain();
    await reader.done;
    expect(t.backend.liveCount).toBe(0);
  });

  test("a stream requested while draining is refused with Retry-After", async () => {
    const t = build();
    const draining = t.lifecycle.beginDrain();
    const response = await t.open();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(t.backend.state.subscribed).toBe(0);
    await draining;
  });
});
