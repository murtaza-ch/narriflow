import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { Webhook } from "standardwebhooks";
import type { WorkspaceEventType } from "@narriflow/validators";
import { createCallbackCipher, createCallbackSigningSecrets } from "./completion-callback";
import type { PinnedTransport } from "./url-guard";
import {
  createWebhookDeliveryProcessor,
  createWebhookSubscriptions,
  WEBHOOK_IDLE_POLL_MS,
  WEBHOOK_PLAN_HOLD_MS,
  WEBHOOK_TEST_INTERVAL_MS,
  type WebhookDisabledNotice,
  type WebhookNoticeResult,
  type WebhookPayload,
} from "./webhook-subscription";
import { appendWorkspaceEvent, deleteExpiredWorkspaceEvents } from "./workspace-event";

const databaseUrl = process.env.INTEGRATION_TEST_DATABASE_URL;
const schema = process.env.INTEGRATION_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_INTEGRATION_DB_TESTS === "1" && Boolean(databaseUrl);
const describeDb = enabled ? describe : describe.skip;
setDefaultTimeout(180_000);
process.env.SOCIAL_TOKEN_ENCRYPTION_KEY ??= "webhook-subscription-test-key-not-a-secret";

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];
const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await condition()) return;
    await sleep(10);
  }
  throw new Error("Timed out waiting for the condition");
};

describeDb("Webhook Subscription PostgreSQL invariants", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let userId: string;
  let userEmail: string;
  let clock = new Date(Math.ceil(Date.now() / 1000) * 1000 + 1000);
  const now = () => clock;
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
  const cipher = createCallbackCipher();
  const logs: Array<Record<string, unknown>> = [];

  /** A real HTTP server on loopback, reached through the injected pinned
   * transport so the guard's address checks still run on a public resolver.
   * Each request takes the next scripted status; once the script is empty it answers 200. */
  let server: ReturnType<typeof Bun.serve>;
  const received: Array<{ path: string; headers: Headers; body: string }> = [];
  const script: number[] = [];
  let onRequest: (() => Promise<void>) | null = null;
  /** Requests to `path` wait for `gate` before they leave; every request waits `delayMs`. */
  let stall: { path: string; gate: Promise<void> } | null = null;
  let delayMs = 0;
  const transport: PinnedTransport = async (url, request) => {
    if (stall?.path === url.pathname) await stall.gate;
    if (delayMs) await sleep(delayMs);
    const answer = await fetch(`http://127.0.0.1:${server.port}${url.pathname}`, { method: request.method, headers: request.headers, body: request.body, signal: request.signal });
    await answer.body?.cancel();
    if (onRequest) await onRequest();
    return new Response(null, { status: answer.status });
  };

  const processor = (leaseOwner = `test:${randomUUID()}`, notifyDisabled?: (notice: WebhookDisabledNotice) => Promise<WebhookNoticeResult>, client: PrismaClient = prisma) =>
    createWebhookDeliveryProcessor({ prisma: client, leaseOwner, now, random: () => 0.5, cipher, transport, resolver: publicResolver, log: (entry) => logs.push(entry), notifyDisabled });
  /** A client whose first Workspace Event counter read, the start of a drain, waits for `gate`. */
  const stalled = (gate: Promise<void>) => {
    let waiting = true;
    return new Proxy(prisma, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property !== "workspaceEventCounter") return typeof value === "function" ? value.bind(target) : value;
        return {
          findUnique: async (args: Parameters<PrismaClient["workspaceEventCounter"]["findUnique"]>[0]) => {
            if (waiting) {
              waiting = false;
              await gate;
            }
            return target.workspaceEventCounter.findUnique(args);
          },
        };
      },
    });
  };
  const subscriptions = () => createWebhookSubscriptions({ prisma, cipher, now, transport, resolver: publicResolver });
  const secrets = () => createCallbackSigningSecrets({ prisma, cipher, now });

  beforeAll(async () => {
    if (!databaseUrl || !schema || !/^integration_test_[a-z0-9_]+$/.test(schema)) throw new Error("Webhook tests require a disposable integration_test_ schema");
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), transactionOptions: { maxWait: 60_000, timeout: 60_000 } });
    userEmail = `webhooks-${randomUUID()}@example.test`;
    userId = (await prisma.user.create({ data: { clerkId: `webhooks:${randomUUID()}`, primaryEmail: userEmail, emailVerifiedAt: new Date() } })).id;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push({ path: new URL(request.url).pathname, headers: request.headers, body: await request.text() });
        return new Response(null, { status: script.shift() ?? 200 });
      },
    });
  });

  afterAll(async () => {
    await server?.stop(true);
    await prisma?.$disconnect();
    await pool?.end();
  });

  /** A Workspace with a signing secret, like one that already set up callbacks. */
  async function workspace(options: { secret?: boolean } = {}) {
    const workspaceId = (await prisma.workspace.create({ data: { name: "Webhooks", ownerUserId: userId, pricingTier: "business", members: { create: { userId, role: "owner" } } } })).id;
    const secret = options.secret === false ? null : (await secrets().rotate(workspaceId)).secret;
    return { actor: { actorUserId: userId, workspaceId }, workspaceId, secret: secret! };
  }
  const subscribe = (actor: { actorUserId: string; workspaceId: string }, path: string, types: WorkspaceEventType[] = ["operation.finished"]) =>
    subscriptions().create(actor, { url: new URL(`https://hooks.example${path}`), types });

  let counter = 0;
  /** A committed event; `tag` names the operation it reports. */
  async function emit(workspaceId: string, tag: string, type: WorkspaceEventType = "operation.finished") {
    const dedupeKey = `webhook-test:${workspaceId}:${tag}:${counter++}`;
    const projectId = randomUUID();
    await prisma.$transaction((tx) => type === "operation.finished"
      ? appendWorkspaceEvent(tx, { workspaceId, projectId: null, type, dedupeKey, subject: { operation: { kind: "export", id: tag }, projectId, state: "completed" } })
      : type === "social_post.finished"
        ? appendWorkspaceEvent(tx, { workspaceId, projectId: null, type, dedupeKey, subject: { socialPostId: randomUUID(), projectId, clipId: null, platform: "tiktok", state: "posted" } })
        : appendWorkspaceEvent(tx, { workspaceId, projectId: null, type, dedupeKey, subject: { ruleId: randomUUID(), projectId, episodeId: tag } }));
  }
  /** The worker claims every due subscription, so each test starts with none. */
  const reset = async () => {
    received.length = 0;
    script.length = 0;
    logs.length = 0;
    onRequest = null;
    stall = null;
    delayMs = 0;
    await prisma.webhookSubscription.deleteMany({});
  };
  /** Verifies with the Standard Webhooks library at the moment the request was signed. */
  const verify = (secret: string, request: { headers: Headers; body: string }) => {
    setSystemTime(new Date(Number(request.headers.get("webhook-timestamp")) * 1000));
    try {
      return new Webhook(secret).verify(request.body, Object.fromEntries(["webhook-id", "webhook-timestamp", "webhook-signature"].map((name) => [name, request.headers.get(name)!]))) as WebhookPayload;
    } finally {
      setSystemTime();
    }
  };
  const row = (id: string) => prisma.webhookSubscription.findUniqueOrThrow({ where: { id } });
  const operationIds = (payloads: WebhookPayload[]) => payloads.map((payload) => (payload.subject as { operation: { id: string } }).operation.id);
  /** Ages a Workspace's events through `throughSeq` past retention and runs the
   * purge. Event rows carry real creation times, so this uses real time, not the test clock. */
  async function expireEvents(workspaceId: string, throughSeq: number) {
    await prisma.workspaceEvent.updateMany({ where: { workspaceId, seq: { lte: throughSeq } }, data: { createdAt: new Date(Date.now() - 31 * DAY_MS) } });
    await deleteExpiredWorkspaceEvents(prisma, new Date());
  }

  test("sends matching events in seq order, signed, and moves the cursor only after each 2xx", async () => {
    await reset();
    const { actor, workspaceId, secret } = await workspace();
    const created = await subscribe(actor, "/secret-token/a");
    expect(created).toMatchObject({ status: "active", urlHost: "hooks.example", types: ["operation.finished"], lastDeliveredSeq: 0, consecutiveFailures: 0 });
    expect(JSON.stringify(created)).not.toContain("secret-token");
    const stored = await prisma.webhookSubscription.findFirstOrThrow({ where: { workspaceId } });
    expect(stored.encryptedUrl).not.toContain("hooks.example");

    await emit(workspaceId, "first");
    await emit(workspaceId, "ignored", "autopilot.episode_imported");
    await emit(workspaceId, "second");
    await emit(workspaceId, "third");
    script.push(200, 200, 500);

    expect(await processor().deliver()).toBe(2);
    // The third attempt failed: the cursor stays at the second event.
    const payloads = received.map((request) => verify(secret, request));
    expect(operationIds(payloads)).toEqual(["first", "second", "third"]);
    expect(payloads.map((payload) => payload.seq)).toEqual([1, 3, 4]);
    expect(received.map((request) => request.headers.get("webhook-id"))).toEqual(payloads.map((payload) => payload.id));
    expect(payloads[0]).toMatchObject({ type: "operation.finished", version: 1, workspaceId, subject: { state: "completed" } });
    expect(received.every((request) => request.path === "/secret-token/a")).toBe(true);
    expect(await row(created.webhookId)).toMatchObject({ lastDeliveredSeq: 3n, consecutiveFailures: 1, lastResponseStatus: 500, status: "active" });
    // No log line carries the URL path or the payload.
    expect(JSON.stringify(logs)).not.toContain("secret-token");
    expect(JSON.stringify(logs)).not.toContain("completed");
    expect(logs.filter((entry) => entry.message === "webhook_delivery_attempt")).toHaveLength(3);
  });

  test("a Workspace without API access is held, never starves others, and resumes from its cursor when access returns", async () => {
    await reset();
    const held = await workspace();
    const other = await workspace();
    const heldHook = await subscribe(held.actor, "/held");
    const otherHook = await subscribe(other.actor, "/other");
    await emit(held.workspaceId, "while-entitled");
    expect(await processor().deliver()).toBe(1);
    // Both caught up and idle; make them due again for the next tick.
    await prisma.webhookSubscription.updateMany({ where: { id: { in: [heldHook.webhookId, otherHook.webhookId] } }, data: { nextAttemptAt: clock } });

    await prisma.workspace.update({ where: { id: held.workspaceId }, data: { pricingTier: "creator" } });
    await emit(held.workspaceId, "after-downgrade");
    await emit(other.workspaceId, "other-workspace");
    received.length = 0;
    expect(await processor().deliver()).toBe(1);
    expect(received.map((request) => request.path)).toEqual(["/other"]);
    const onHold = await row(heldHook.webhookId);
    expect(onHold).toMatchObject({ status: "active", lastDeliveredSeq: 1n, consecutiveFailures: 0, leaseOwner: null });
    expect(onHold.nextAttemptAt.getTime() - clock.getTime()).toBe(WEBHOOK_PLAN_HOLD_MS);
    expect(logs.some((entry) => entry.message === "webhook_delivery_held" && entry.webhookId === heldHook.webhookId)).toBe(true);

    // Restored: the next look after the hold sends what waited, from the cursor.
    await prisma.workspace.update({ where: { id: held.workspaceId }, data: { pricingTier: "pro" } });
    advance(WEBHOOK_PLAN_HOLD_MS);
    received.length = 0;
    expect(await processor().deliver()).toBe(1);
    expect(operationIds(received.map((request) => verify(held.secret, request)))).toEqual(["after-downgrade"]);
    expect(await row(heldHook.webhookId)).toMatchObject({ lastDeliveredSeq: 2n, status: "active" });
  });

  test("a restricted Workspace is held even when its plan includes API access, as API admission refuses it", async () => {
    await reset();
    const { actor, workspaceId, secret } = await workspace();
    const created = await subscribe(actor, "/restricted");
    await prisma.workspace.update({ where: { id: workspaceId }, data: { pricingTier: "pro", status: "restricted" } });
    await emit(workspaceId, "while-restricted");
    expect(await processor().deliver()).toBe(0);
    expect(received).toHaveLength(0);
    const onHold = await row(created.webhookId);
    expect(onHold).toMatchObject({ status: "active", lastDeliveredSeq: 0n, consecutiveFailures: 0, leaseOwner: null });
    expect(onHold.nextAttemptAt.getTime() - clock.getTime()).toBe(WEBHOOK_PLAN_HOLD_MS);

    await prisma.workspace.update({ where: { id: workspaceId }, data: { status: "active" } });
    advance(WEBHOOK_PLAN_HOLD_MS);
    expect(await processor().deliver()).toBe(1);
    expect(operationIds(received.map((request) => verify(secret, request)))).toEqual(["while-restricted"]);
  });

  test("losing API access mid-page stops before the next POST and keeps the cursor", async () => {
    await reset();
    const { actor, workspaceId } = await workspace();
    const created = await subscribe(actor, "/mid-page");
    await emit(workspaceId, "sent");
    await emit(workspaceId, "held");
    onRequest = async () => {
      onRequest = null;
      await prisma.workspace.update({ where: { id: workspaceId }, data: { pricingTier: "free" } });
    };
    expect(await processor().deliver()).toBe(1);
    expect(received).toHaveLength(1);
    expect(await row(created.webhookId)).toMatchObject({ lastDeliveredSeq: 1n, consecutiveFailures: 0, status: "active", leaseOwner: null });
  });

  test("retries a failed event with the same id after the callback backoff, and sends what follows only after it", async () => {
    await reset();
    const { actor, workspaceId, secret } = await workspace();
    const created = await subscribe(actor, "/retry");
    await emit(workspaceId, "stuck");
    await emit(workspaceId, "behind");
    script.push(503);
    const worker = processor();

    expect(await worker.deliver()).toBe(0);
    expect(operationIds(received.map((request) => verify(secret, request)))).toEqual(["stuck"]);
    expect(await row(created.webhookId)).toMatchObject({ lastDeliveredSeq: 0n, consecutiveFailures: 1, lastResponseStatus: 503 });
    expect((await row(created.webhookId)).nextAttemptAt.getTime() - clock.getTime()).toBe(30_000);

    expect(await worker.deliver()).toBe(0);
    expect(received).toHaveLength(1);

    advance(30_000);
    expect(await worker.deliver()).toBe(2);
    const payloads = received.map((request) => verify(secret, request));
    expect(operationIds(payloads)).toEqual(["stuck", "stuck", "behind"]);
    expect(payloads[1]!.id).toBe(payloads[0]!.id);
    expect(await row(created.webhookId)).toMatchObject({ lastDeliveredSeq: 2n, consecutiveFailures: 0, lastResponseStatus: 200 });
  });

  test("a subscription whose lease was taken can't move the cursor, and the event is sent again", async () => {
    await reset();
    const { actor, workspaceId } = await workspace();
    const created = await subscribe(actor, "/fenced");
    await emit(workspaceId, "contested");
    onRequest = async () => {
      onRequest = null;
      await prisma.webhookSubscription.update({ where: { id: created.webhookId }, data: { leaseOwner: "someone-else", leaseExpiresAt: new Date(clock.getTime() + 60_000) } });
    };
    expect(await processor().deliver()).toBe(0);
    expect(received).toHaveLength(1);
    expect(await row(created.webhookId)).toMatchObject({ lastDeliveredSeq: 0n, leaseOwner: "someone-else" });

    advance(61_000);
    expect(await processor().deliver()).toBe(1);
    expect(received).toHaveLength(2);
    expect(JSON.parse(received[1]!.body).id).toBe(JSON.parse(received[0]!.body).id);
    expect(await row(created.webhookId)).toMatchObject({ lastDeliveredSeq: 1n });
  });

  test("two workers racing for a subscription send each event once, in order", async () => {
    await reset();
    const { actor, workspaceId, secret } = await workspace();
    await subscribe(actor, "/race");
    for (const tag of ["a", "b", "c", "d", "e"]) await emit(workspaceId, tag);
    const delivered = await Promise.all([processor().deliver(), processor().deliver()]);
    expect(delivered.reduce((sum, count) => sum + count, 0)).toBe(5);
    expect(operationIds(received.map((request) => verify(secret, request)))).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("disables after 20 consecutive failures, emails the creator once, and re-enabling resumes where it stopped", async () => {
    await reset();
    const { actor, workspaceId, secret } = await workspace();
    const created = await subscribe(actor, "/flaky");
    await emit(workspaceId, "one");
    await emit(workspaceId, "two");
    script.push(...Array.from({ length: 20 }, () => 500));
    const notices: WebhookDisabledNotice[] = [];
    const worker = processor(undefined, async (notice) => { notices.push(notice); return { sent: true }; });

    for (let attempt = 1; attempt <= 20; attempt++) {
      expect(await row(created.webhookId)).toMatchObject({ status: "active", consecutiveFailures: attempt - 1 });
      await worker.deliver();
      advance(25 * 60 * 60 * 1000);
    }
    expect(received).toHaveLength(20);
    expect(new Set(received.map((request) => verify(secret, request).id)).size).toBe(1);
    expect(await row(created.webhookId)).toMatchObject({ status: "disabled", disabledReason: "consecutive_failures", consecutiveFailures: 20, lastDeliveredSeq: 0n, disabledNotifiedAt: null });

    await worker.deliver();
    expect(received).toHaveLength(20);

    expect(await worker.notifyDisabled()).toBe(1);
    expect(await worker.notifyDisabled()).toBe(0);
    expect(notices).toEqual([{ to: userEmail, webhookId: created.webhookId, urlHost: "hooks.example", reason: "consecutive_failures" }]);

    const resumed = await subscriptions().enable(actor, created.webhookId);
    expect(resumed).toMatchObject({ status: "active", disabledReason: null, consecutiveFailures: 0, lastDeliveredSeq: 0 });
    expect(await worker.deliver()).toBe(2);
    expect(operationIds(received.slice(20).map((request) => verify(secret, request)))).toEqual(["one", "two"]);
    expect(await row(created.webhookId)).toMatchObject({ lastDeliveredSeq: 2n, disabledNotifiedAt: null });
  });

  test("a success resets the failure count", async () => {
    await reset();
    const { actor, workspaceId } = await workspace();
    const created = await subscribe(actor, "/recovers");
    await emit(workspaceId, "x");
    await emit(workspaceId, "y");
    script.push(500, 500, 200, 500);
    const worker = processor();
    await worker.deliver();
    advance(25 * 60 * 60 * 1000);
    await worker.deliver();
    expect(await row(created.webhookId)).toMatchObject({ consecutiveFailures: 2 });
    advance(25 * 60 * 60 * 1000);
    await worker.deliver();
    expect(await row(created.webhookId)).toMatchObject({ lastDeliveredSeq: 1n, consecutiveFailures: 1, status: "active" });
  });

  test("a 410 disables the subscription at once", async () => {
    await reset();
    const { actor, workspaceId } = await workspace();
    const created = await subscribe(actor, "/gone");
    await emit(workspaceId, "x");
    script.push(410);
    expect(await processor().deliver()).toBe(0);
    expect(await row(created.webhookId)).toMatchObject({ status: "disabled", disabledReason: "endpoint_gone", lastDeliveredSeq: 0n });
  });

  test("a missing signing secret counts as a failed delivery and sends nothing", async () => {
    await reset();
    const { actor, workspaceId } = await workspace();
    const created = await subscribe(actor, "/unsigned");
    await prisma.callbackSigningSecret.deleteMany({ where: { workspaceId } });
    await emit(workspaceId, "x");
    await processor().deliver();
    expect(received).toHaveLength(0);
    expect(await row(created.webhookId)).toMatchObject({ consecutiveFailures: 1, lastDeliveredSeq: 0n });
    expect(logs.find((entry) => entry.message === "webhook_delivery_attempt")).toMatchObject({ reason: "signing_secret_missing" });
  });

  test("disables when events it hadn't sent expired, and re-enabling continues from the oldest retained event", async () => {
    await reset();
    const { actor, workspaceId, secret } = await workspace();
    const created = await subscribe(actor, "/behind");
    for (const tag of ["old-1", "old-2", "kept"]) await emit(workspaceId, tag);
    await expireEvents(workspaceId, 2);

    expect(await processor().deliver()).toBe(0);
    expect(received).toHaveLength(0);
    expect(await row(created.webhookId)).toMatchObject({ status: "disabled", disabledReason: "cursor_expired", lastDeliveredSeq: 0n });

    // Enabling only marks it; the next drain decides where to continue.
    expect(await subscriptions().enable(actor, created.webhookId)).toMatchObject({ status: "active", lastDeliveredSeq: 0 });
    expect(await processor().deliver()).toBe(1);
    expect(operationIds(received.map((request) => verify(secret, request)))).toEqual(["kept"]);
    expect(await row(created.webhookId)).toMatchObject({ lastDeliveredSeq: 3n, status: "active" });
  });

  test("disables when every unsent event expired", async () => {
    await reset();
    const { actor, workspaceId } = await workspace();
    const created = await subscribe(actor, "/all-gone");
    await emit(workspaceId, "a");
    await emit(workspaceId, "b");
    await expireEvents(workspaceId, 2);
    await processor().deliver();
    expect(await row(created.webhookId)).toMatchObject({ status: "disabled", disabledReason: "cursor_expired" });
    expect(await subscriptions().enable(actor, created.webhookId)).toMatchObject({ status: "active", lastDeliveredSeq: 0 });
    expect(await processor().deliver()).toBe(0);
    expect(await row(created.webhookId)).toMatchObject({ status: "active", skipExpiredOnResume: false, lastDeliveredSeq: 2n });
  });

  test("a subscription to a quiet type stays active when other types' events expire", async () => {
    await reset();
    const { actor, workspaceId, secret } = await workspace();
    const created = await subscribe(actor, "/quiet", ["social_post.finished"]);
    for (const tag of ["noise-1", "noise-2", "noise-3"]) await emit(workspaceId, tag);
    const worker = processor();

    expect(await worker.deliver()).toBe(0);
    // Caught up: the cursor follows the head, and the next look is one idle interval away.
    const idle = await row(created.webhookId);
    expect(idle).toMatchObject({ lastDeliveredSeq: 3n, status: "active" });
    expect(idle.nextAttemptAt.getTime() - clock.getTime()).toBe(WEBHOOK_IDLE_POLL_MS);

    advance(WEBHOOK_IDLE_POLL_MS);
    await expireEvents(workspaceId, 3);
    expect(await prisma.workspaceEvent.count({ where: { workspaceId } })).toBe(0);
    expect(await worker.deliver()).toBe(0);
    expect(await row(created.webhookId)).toMatchObject({ status: "active", lastDeliveredSeq: 3n });

    await emit(workspaceId, "post", "social_post.finished");
    advance(WEBHOOK_IDLE_POLL_MS);
    expect(await worker.deliver()).toBe(1);
    expect(verify(secret, received[0]!)).toMatchObject({ seq: 4, type: "social_post.finished" });
  });

  test("a new subscription starts at the newest event", async () => {
    await reset();
    const { actor, workspaceId, secret } = await workspace();
    await emit(workspaceId, "before");
    const created = await subscribe(actor, "/fresh");
    expect(created.lastDeliveredSeq).toBe(1);
    await emit(workspaceId, "after");
    await processor().deliver();
    expect(operationIds(received.map((request) => verify(secret, request)))).toEqual(["after"]);
  });

  test("rotating the signing secret signs with both during the overlap", async () => {
    await reset();
    const { actor, workspaceId, secret } = await workspace();
    await subscribe(actor, "/rotation");
    const next = (await secrets().rotate(workspaceId)).secret;
    await emit(workspaceId, "x");
    await processor().deliver();
    expect(verify(secret, received[0]!).id).toBe(verify(next, received[0]!).id);
  });

  test("create refuses without a signing secret, repeats, and past the limit; reads and writes stay in the Workspace", async () => {
    await reset();
    const bare = await workspace({ secret: false });
    await expect(subscribe(bare.actor, "/x")).rejects.toMatchObject({ code: "callback_secret_required" });
    expect(await prisma.webhookSubscription.count({ where: { workspaceId: bare.workspaceId } })).toBe(0);

    const { actor, workspaceId } = await workspace();
    const first = await subscribe(actor, "/dup");
    await expect(subscribe(actor, "/dup", ["autopilot.episode_imported"])).rejects.toMatchObject({ code: "webhook_exists", details: { webhookId: first.webhookId } });
    for (let index = 1; index < 10; index++) await subscribe(actor, `/n${index}`);
    await expect(subscribe(actor, "/eleventh")).rejects.toMatchObject({ code: "webhook_limit_reached" });
    expect(await subscriptions().list(actor)).toHaveLength(10);

    const outsider = { actorUserId: userId, workspaceId: (await workspace()).workspaceId };
    expect(await subscriptions().list(outsider)).toEqual([]);
    for (const call of [
      () => subscriptions().enable(outsider, first.webhookId),
      () => subscriptions().delete(outsider, first.webhookId),
      () => subscriptions().test(outsider, first.webhookId),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "webhook_not_found" });
    }
    expect(await prisma.webhookSubscription.count({ where: { workspaceId } })).toBe(10);
    expect(await subscriptions().delete(actor, first.webhookId)).toEqual({ webhookId: first.webhookId });
    await expect(subscriptions().delete(actor, first.webhookId)).rejects.toMatchObject({ code: "webhook_not_found" });
  });

  test("test sends one signed webhook.test event and moves no cursor, even while disabled", async () => {
    await reset();
    const { actor, workspaceId, secret } = await workspace();
    const created = await subscribe(actor, "/test-me");
    await emit(workspaceId, "pending");
    await prisma.webhookSubscription.update({ where: { id: created.webhookId }, data: { status: "disabled", disabledReason: "endpoint_gone", disabledAt: clock } });
    script.push(204);

    const result = await subscriptions().test(actor, created.webhookId);
    expect(result).toMatchObject({ delivered: true, status: 204 });
    expect(received).toHaveLength(1);
    const payload = verify(secret, received[0]!);
    expect(payload).toMatchObject({ id: result.eventId, seq: 0, type: "webhook.test", version: 1, workspaceId, subject: {} });
    expect(await row(created.webhookId)).toMatchObject({ lastDeliveredSeq: 0n, status: "disabled" });

    script.push(500);
    advance(WEBHOOK_TEST_INTERVAL_MS);
    expect(await subscriptions().test(actor, created.webhookId)).toMatchObject({ delivered: false, status: 500 });
  });

  test("a webhook takes one test every 5 seconds, without sending the refused one", async () => {
    await reset();
    const { actor } = await workspace();
    const first = await subscribe(actor, "/throttled");
    const other = await subscribe(actor, "/not-throttled");
    await subscriptions().test(actor, first.webhookId);
    await expect(subscriptions().test(actor, first.webhookId)).rejects.toMatchObject({ code: "webhook_test_throttled", kind: "rate_limited", retryAfterSeconds: 5 });
    expect(received).toHaveLength(1);
    // The limit is per webhook.
    await subscriptions().test(actor, other.webhookId);
    expect(received.map((request) => request.path)).toEqual(["/throttled", "/not-throttled"]);
    advance(WEBHOOK_TEST_INTERVAL_MS - 1);
    await expect(subscriptions().test(actor, first.webhookId)).rejects.toMatchObject({ code: "webhook_test_throttled" });
    advance(1);
    await subscriptions().test(actor, first.webhookId);
    expect(received).toHaveLength(3);
  });

  test("enabling and testing need the scopes of the event types the webhook carries", async () => {
    await reset();
    const { actor } = await workspace();
    const created = await subscribe(actor, "/outcomes", ["social_post.finished"]);
    await prisma.webhookSubscription.update({ where: { id: created.webhookId }, data: { status: "disabled", disabledReason: "endpoint_gone", disabledAt: clock } });
    const without = { scopes: ["processing:write"] };
    for (const call of [() => subscriptions().enable(actor, created.webhookId, without), () => subscriptions().test(actor, created.webhookId, without)]) {
      await expect(call()).rejects.toMatchObject({ code: "scope_required", details: { scope: "publishing:read" } });
    }
    expect(received).toHaveLength(0);
    expect(await row(created.webhookId)).toMatchObject({ status: "disabled", lastTestedAt: null });

    const withScope = { scopes: ["processing:write", "publishing:read"] };
    expect(await subscriptions().test(actor, created.webhookId, withScope)).toMatchObject({ delivered: true });
    expect(await subscriptions().enable(actor, created.webhookId, withScope)).toMatchObject({ status: "active" });
  });

  test("falls back to the Workspace owner when the creator is gone, and skips when nobody can be emailed", async () => {
    await reset();
    const { actor } = await workspace();
    const created = await subscribe(actor, "/orphan");
    await prisma.webhookSubscription.update({ where: { id: created.webhookId }, data: { createdByUserId: null, status: "disabled", disabledReason: "endpoint_gone", disabledAt: clock } });
    const notices: WebhookDisabledNotice[] = [];
    expect(await processor(undefined, async (notice) => { notices.push(notice); return { sent: true }; }).notifyDisabled()).toBe(1);
    expect(notices.map((notice) => notice.to)).toEqual([userEmail]);

    await prisma.webhookSubscription.update({ where: { id: created.webhookId }, data: { disabledNotifiedAt: null } });
    await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: null } });
    expect(await processor(undefined, async (notice) => { notices.push(notice); return { sent: true }; }).notifyDisabled()).toBe(0);
    expect(notices).toHaveLength(1);
    await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  });

  test("emails the creator while they are a member, and the owner once they have left", async () => {
    await reset();
    const { workspaceId } = await workspace();
    const member = async (label: string) => {
      const email = `${label}-${randomUUID()}@example.test`;
      const user = await prisma.user.create({ data: { clerkId: `webhooks:${label}:${randomUUID()}`, primaryEmail: email, emailVerifiedAt: new Date() } });
      await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role: "editor" } });
      return { userId: user.id, email };
    };
    const stays = await member("stays");
    const leaves = await member("leaves");
    const staying = await subscribe({ actorUserId: stays.userId, workspaceId }, "/stays");
    const leaving = await subscribe({ actorUserId: leaves.userId, workspaceId }, "/leaves");
    await prisma.workspaceMember.deleteMany({ where: { workspaceId, userId: leaves.userId } });
    await prisma.webhookSubscription.updateMany({ where: { workspaceId }, data: { status: "disabled", disabledReason: "endpoint_gone", disabledAt: clock } });

    const notices: WebhookDisabledNotice[] = [];
    expect(await processor(undefined, async (notice) => { notices.push(notice); return { sent: true }; }).notifyDisabled()).toBe(2);
    expect(Object.fromEntries(notices.map((notice) => [notice.webhookId, notice.to]))).toEqual({ [staying.webhookId]: stays.email, [leaving.webhookId]: userEmail });
  });

  test("a notice that was skipped stays due, is logged, and is tried again a few minutes later", async () => {
    await reset();
    const { actor, workspaceId } = await workspace();
    const created = await subscribe(actor, "/mute");
    await emit(workspaceId, "x");
    script.push(410);
    const calls: WebhookDisabledNotice[] = [];
    let outcome: WebhookNoticeResult = { sent: false, reason: "emails_disabled" };
    const worker = processor(undefined, async (notice) => { calls.push(notice); return outcome; });
    await worker.deliver();
    expect(await row(created.webhookId)).toMatchObject({ status: "disabled", disabledNotifiedAt: null });

    expect(await worker.notifyDisabled()).toBe(0);
    expect(await row(created.webhookId)).toMatchObject({ disabledNotifiedAt: null });
    expect(logs.find((entry) => entry.message === "webhook_disabled_notice_skipped")).toMatchObject({ webhookId: created.webhookId, reason: "emails_disabled" });
    // Paused: it doesn't hammer the mailer or the log every tick.
    expect(await worker.notifyDisabled()).toBe(0);
    expect(calls).toHaveLength(1);

    advance(5 * 60_000);
    outcome = { sent: true };
    expect(await worker.notifyDisabled()).toBe(1);
    expect(calls).toHaveLength(2);
    expect((await row(created.webhookId)).disabledNotifiedAt).not.toBeNull();
    expect(await worker.notifyDisabled()).toBe(0);
  });

  test("a worker whose lease lapsed sends nothing once another worker has taken over", async () => {
    await reset();
    const { actor, workspaceId, secret } = await workspace();
    const created = await subscribe(actor, "/stale");
    for (const tag of ["e1", "e2", "e3"]) await emit(workspaceId, tag);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const slow = processor(`slow:${randomUUID()}`, undefined, stalled(gate)).deliver();
    await until(async () => (await row(created.webhookId)).leaseOwner?.startsWith("slow:") === true);

    // The slow worker is stuck before its first POST while its lease runs out.
    advance(61_000);
    expect(await processor().deliver()).toBe(3);
    expect(operationIds(received.map((request) => verify(secret, request)))).toEqual(["e1", "e2", "e3"]);

    resume();
    expect(await slow).toBe(0);
    // It had the same three events in hand, and POSTed none of them.
    expect(received).toHaveLength(3);
    expect(await row(created.webhookId)).toMatchObject({ lastDeliveredSeq: 3n, status: "active" });
    expect(logs.find((entry) => entry.message === "webhook_delivery_stopped")).toMatchObject({ webhookId: created.webhookId, seq: 1 });
  });

  test("a worker does not POST an event the cursor has already passed, even while it still holds the lease", async () => {
    await reset();
    const { actor, workspaceId } = await workspace();
    const created = await subscribe(actor, "/passed");
    for (const tag of ["e1", "e2"]) await emit(workspaceId, tag);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const worker = processor(`holder:${randomUUID()}`, undefined, stalled(gate)).deliver();
    await until(async () => (await row(created.webhookId)).leaseOwner?.startsWith("holder:") === true);
    // Someone else's progress lands without touching the lease.
    await prisma.webhookSubscription.update({ where: { id: created.webhookId }, data: { lastDeliveredSeq: 2n } });
    resume();
    expect(await worker).toBe(0);
    expect(received).toHaveLength(0);
    expect(await row(created.webhookId)).toMatchObject({ lastDeliveredSeq: 2n });
  });

  test("deleting a subscription mid-drain stops the POSTs behind the one in flight", async () => {
    await reset();
    const { actor, workspaceId } = await workspace();
    const created = await subscribe(actor, "/doomed");
    for (const tag of ["e1", "e2", "e3"]) await emit(workspaceId, tag);
    onRequest = async () => {
      onRequest = null;
      await subscriptions().delete(actor, created.webhookId);
    };
    expect(await processor().deliver()).toBe(0);
    expect(received).toHaveLength(1);
    expect(await prisma.webhookSubscription.count({ where: { id: created.webhookId } })).toBe(0);
  });

  test("disabling a subscription mid-drain stops the POSTs behind the one in flight", async () => {
    await reset();
    const { actor, workspaceId } = await workspace();
    const created = await subscribe(actor, "/paused");
    for (const tag of ["e1", "e2", "e3"]) await emit(workspaceId, tag);
    onRequest = async () => {
      onRequest = null;
      await prisma.webhookSubscription.update({ where: { id: created.webhookId }, data: { status: "disabled", disabledReason: "endpoint_gone", disabledAt: clock } });
    };
    expect(await processor().deliver()).toBe(0);
    expect(received).toHaveLength(1);
    expect(await row(created.webhookId)).toMatchObject({ status: "disabled", lastDeliveredSeq: 0n });
  });

  test("a slow endpoint holds one lane, not the others", async () => {
    await reset();
    const { actor, workspaceId } = await workspace();
    const slow = await subscribe(actor, "/slow");
    const fast = await subscribe(actor, "/fast");
    await emit(workspaceId, "e1");
    let open!: () => void;
    stall = { path: "/slow", gate: new Promise<void>((resolve) => { open = resolve; }) };

    const tick = processor().deliver();
    await until(async () => received.some((request) => request.path === "/fast"));
    // The fast endpoint is done while the slow one is still waiting.
    expect(await row(fast.webhookId)).toMatchObject({ lastDeliveredSeq: 1n });
    expect(await row(slow.webhookId)).toMatchObject({ lastDeliveredSeq: 0n });
    open();
    expect(await tick).toBe(2);
    expect(received.map((request) => request.path).sort()).toEqual(["/fast", "/slow"]);
  });

  test("a tick's budget ends a drain between events, and the next tick continues in order", async () => {
    await reset();
    const { actor, workspaceId, secret } = await workspace();
    const created = await subscribe(actor, "/budget");
    for (const tag of ["e1", "e2", "e3", "e4", "e5"]) await emit(workspaceId, tag);

    expect(await processor().deliver({ budgetMs: 0 })).toBe(0);
    expect(received).toHaveLength(0);

    delayMs = 100;
    const first = await processor().deliver({ budgetMs: 150 });
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThan(5);
    expect(await row(created.webhookId)).toMatchObject({ lastDeliveredSeq: BigInt(first), leaseOwner: null });
    expect((await row(created.webhookId)).nextAttemptAt.getTime()).toBeLessThanOrEqual(clock.getTime());

    delayMs = 0;
    expect(first + await processor().deliver()).toBe(5);
    expect(operationIds(received.map((request) => verify(secret, request)))).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });

  test("re-enabling after events expired isn't undone by a purge that runs before the first drain, and mails once", async () => {
    await reset();
    const { actor, workspaceId } = await workspace();
    const created = await subscribe(actor, "/revived");
    for (const tag of ["old-1", "old-2", "kept"]) await emit(workspaceId, tag);
    await expireEvents(workspaceId, 2);
    const notices: WebhookDisabledNotice[] = [];
    const worker = processor(undefined, async (notice) => { notices.push(notice); return { sent: true }; });

    await worker.deliver();
    expect(await row(created.webhookId)).toMatchObject({ status: "disabled", disabledReason: "cursor_expired" });
    expect(await worker.notifyDisabled()).toBe(1);

    await subscriptions().enable(actor, created.webhookId);
    // The purge reaches the one event it was waiting for before any drain looks.
    await expireEvents(workspaceId, 3);
    expect(await worker.deliver()).toBe(0);
    expect(await row(created.webhookId)).toMatchObject({ status: "active", skipExpiredOnResume: false, lastDeliveredSeq: 3n, disabledReason: null });
    expect(await worker.notifyDisabled()).toBe(0);
    expect(notices).toHaveLength(1);
    expect(received).toHaveLength(0);

    // The skip is spent: falling behind again is still caught.
    await emit(workspaceId, "n1");
    await emit(workspaceId, "n2");
    await expireEvents(workspaceId, 4);
    advance(WEBHOOK_IDLE_POLL_MS);
    expect(await worker.deliver()).toBe(0);
    expect(await row(created.webhookId)).toMatchObject({ status: "disabled", disabledReason: "cursor_expired" });
  });
});
