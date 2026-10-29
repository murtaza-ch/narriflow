/**
 * End-to-end: a real Bun server, a real Redis (when `redis-server` exists), the
 * production route and the browser hub with the real transport. Timing-based, so
 * it only runs when asked (it skips in `bun test src/`):
 *
 *   LIVE_STREAM_SECONDS=9  bun test src/domains/progress/live.test.ts   # ~30s
 *   LIVE_STREAM_SECONDS=70 bun test src/domains/progress/live.test.ts   # beyond a minute
 *
 * Short token lifetime, heartbeat and Bun idle timeout make the interesting
 * transitions (token expiry reconnects, idle timeout lifted, Redis loss)
 * happen many times inside the run.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import Redis from "ioredis";
import { createApiRuntime } from "../../../../../packages/api-client/src/core";
import { createProgressHub } from "../../../../../packages/api-client/src/progress/hub";
import { createRequestPolicyRuntime } from "../../http/request-policy-runtime";
import { createLifecycle } from "../../server-hooks";
import { createInventoryApp } from "../../test-app";
import { createRedisSubscribeLive } from "./redis";
import { createProgressRoutes } from "./routes";
import type { SequencedEvent } from "./stream";

const SECONDS = Number(process.env.LIVE_STREAM_SECONDS ?? 0);
const REDIS_PORT = 6391;
const PROJECT_ID = "50000000-0000-4000-8000-000000000001";
const RUN_ID = "60000000-0000-4000-8000-000000000001";
const TOKEN_TTL_MS = 5_000;
const HEARTBEAT_MS = 3_000;
/** Quiet gaps longer than Bun's 2s idle timeout, so only the per-request lift keeps the stream open. */
const QUIET_MS = 4_000;

const hasRedis = Bun.which("redis-server") !== null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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

describe.skipIf(SECONDS <= 0)("progress stream over a real server", () => {
  const redisServer = hasRedis && SECONDS > 0
    ? Bun.spawn(["redis-server", "--port", String(REDIS_PORT), "--save", "", "--appendonly", "no"], { stdout: "ignore", stderr: "ignore" })
    : null;
  afterAll(() => redisServer?.kill());

  test(
    `delivers every event once, in order, across token expiry, idle timeouts and Redis loss for ${SECONDS}s`,
    async () => {
      if (redisServer) await sleep(400);
      const redisUrl = `redis://127.0.0.1:${REDIS_PORT}`;
      const publisher = redisServer ? new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, retryStrategy: () => null }) : null;
      publisher?.on("error", () => undefined);

      // The durable log and what the "worker" does: persist, then publish.
      const log: SequencedEvent[] = [];
      let seq = 0;
      const emit = async () => {
        seq += 1;
        const event = {
          event: "workflow.stage.updated",
          projectId: PROJECT_ID,
          workflowRunId: RUN_ID,
          seq,
          stage: "clip_rendering",
          status: "running",
          progress: seq % 100,
          errorCode: null,
          emittedAt: new Date().toISOString(),
        };
        log.push(event);
        // The worker never waits on Redis: the log is the source of truth.
        void publisher?.publish(`workflow:${PROJECT_ID}`, JSON.stringify(event)).catch(() => undefined);
      };

      // Server side: tokens are `t<expiresAtMs>`; membership can be revoked.
      const world = { membership: true, verifications: 0, opened: 0 };
      const user = { id: "actor-user", clerkId: "clerk-1" } as AppUser;
      const policyRuntime = createRequestPolicyRuntime({
        authenticate: async (request) => {
          world.verifications += 1;
          const expires = Number(/^Bearer t(\d+)$/.exec(request.headers.get("authorization") ?? "")?.[1]);
          return Number.isFinite(expires) && expires > Date.now()
            ? ({ status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never)
            : ({ status: "unauthenticated", reason: "rejected_token" } as const);
        },
        loadAppUser: async () => user,
        resolveScopedWorkspace: async (_user, hint) => (hint === "workspace-a" && world.membership ? context : null),
        staffAllowlist: new Set(),
        policy: {
          resolveProject: async () => ({ kind: "active", projectId: PROJECT_ID }),
          rateLimit: async () => ({ allowed: true, availability: "available" }),
          now: Date.now,
        },
      });
      const lifecycle = createLifecycle();
      const app = createInventoryApp({
        policyRuntime,
        health: { isDraining: () => lifecycle.draining },
        domains: {
          progress: createProgressRoutes({
            getEventsSince: async (_project, since) => log.filter((event) => event.seq > since),
            subscribeLive: redisServer ? createRedisSubscribeLive(redisUrl) : null,
            limits: { maxConnections: 10, maxConnectionsPerActor: 5 },
            timing: { heartbeatMs: HEARTBEAT_MS, fallbackPollMs: 500 },
          }),
        },
      });
      const server = Bun.serve({
        port: 0,
        // Shorter than the heartbeat: the stream survives only because the route lifts it per request.
        idleTimeout: 2,
        fetch: (request, bunServer) => {
          if (new URL(request.url).pathname.startsWith("/api/stream/")) world.opened += 1;
          return app.fetch(request, { server: bunServer, lifecycle });
        },
      });

      // Client side: the production runtime and hub against that server.
      const runtime = createApiRuntime({
        baseUrl: `http://127.0.0.1:${server.port}`,
        getToken: async () => `t${Date.now() + TOKEN_TTL_MS}`,
      });
      runtime.setIdentity("clerk-1");
      runtime.selectWorkspace("workspace-a");
      const hub = createProgressHub({ transport: runtime.transport, queryClient: runtime.queryClient, lingerMs: 50 });
      const scope = { userId: "clerk-1", workspaceId: "workspace-a" };

      const received: number[] = [];
      const second: number[] = [];
      const revoked: string[] = [];
      const fatal: string[] = [];
      let opens = 0;
      const stop = hub.subscribe(scope, PROJECT_ID, {
        sinceSeq: 0,
        onEvent: (event) => received.push(event.seq),
        onOpen: () => {
          opens += 1;
        },
        onRevoked: (control) => revoked.push(control.error),
        onFatal: (error) => fatal.push(error.code),
      });
      // A second consumer shares the connection.
      const stopSecond = hub.subscribe(scope, PROJECT_ID, { sinceSeq: 0, onEvent: (event) => second.push(event.seq) });

      const heapBefore = process.memoryUsage().heapUsed;
      const end = Date.now() + SECONDS * 1_000;
      const redisLossAt = Date.now() + SECONDS * 400;
      let redisKilled = false;
      while (Date.now() < end) {
        if (redisServer && !redisKilled && Date.now() >= redisLossAt) {
          redisServer.kill();
          redisKilled = true;
        }
        for (let burst = 0; burst < 3; burst += 1) {
          await emit();
          await sleep(100);
        }
        await sleep(QUIET_MS);
      }
      // Everything emitted so far arrives, whichever path (Redis, log catch-up, polling) carried it.
      const deadline = Date.now() + 12_000;
      while ((received.length < seq || second.length < seq) && Date.now() < deadline) await sleep(50);

      const expected = Array.from({ length: seq }, (_, index) => index + 1);
      expect(received).toEqual(expected);
      expect(second).toEqual(expected);
      expect(fatal).toEqual([]);
      expect(revoked).toEqual([]);
      // The token lives 5s and is checked every 3s: a reconnect every 6-8s, never one per
      // Bun idle timeout (2s), which the quiet gaps would trigger if the route did not lift it.
      expect(world.opened).toBeGreaterThanOrEqual(Math.floor(SECONDS / 10));
      expect(world.opened).toBeLessThanOrEqual(Math.ceil(SECONDS / 5) + 2);
      expect(opens).toBe(world.opened);
      expect(world.verifications).toBeGreaterThan(world.opened);
      // Bounded memory over the run (generous: allocator noise, not a leak).
      expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(64 * 1024 * 1024);

      // Revocation: one safe control event, no reconnect storm.
      world.membership = false;
      const revokeDeadline = Date.now() + 12_000;
      while (revoked.length + fatal.length === 0 && Date.now() < revokeDeadline) await sleep(50);
      // Either the heartbeat sends the control event, or a reconnect that raced it is refused with 409.
      expect([...revoked, ...fatal]).toEqual(["workspace_selection_changed"]);
      const openedAtRevoke = world.opened;
      await sleep(HEARTBEAT_MS * 3);
      expect(world.opened).toBe(openedAtRevoke);

      stop();
      stopSecond();
      await sleep(300);
      expect(server.pendingRequests).toBe(0);
      publisher?.disconnect();
      await server.stop(true);
    },
    (SECONDS + 60) * 1_000,
  );
});
