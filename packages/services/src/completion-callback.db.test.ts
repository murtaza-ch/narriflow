import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { Webhook } from "standardwebhooks";
import { contentPackSchema, PLATFORM_PLAYBOOK_VERSION } from "@narriflow/validators";
import {
  callbackEventId,
  createCallbackCipher,
  createCallbackSigningSecrets,
  createCompletionCallbackProcessor,
  prepareCallbackRegistration,
  resetCompletionCallbacks,
  type CallbackPayload,
} from "./completion-callback";
import { createOperationStatusReader, decodeOperationId } from "./operation-status";
import { prismaUploadSessionPersistence } from "./upload-session.service";
import { projectService } from "./project.service";
import type { PinnedTransport } from "./url-guard";

const databaseUrl = process.env.INTEGRATION_TEST_DATABASE_URL;
const schema = process.env.INTEGRATION_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_INTEGRATION_DB_TESTS === "1" && Boolean(databaseUrl);
const describeDb = enabled ? describe : describe.skip;
setDefaultTimeout(180_000);
process.env.SOCIAL_TOKEN_ENCRYPTION_KEY ??= "completion-callback-test-key-not-a-secret";

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];
const pack = contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 5, clipDurationSecTarget: 30, platformPlaybookVersion: PLATFORM_PLAYBOOK_VERSION });

/** A fake receiver: records each request and answers with the next status. */
function receiver(statuses: Array<number | "timeout">) {
  const requests: Array<{ url: string; headers: Headers; body: string }> = [];
  const transport: PinnedTransport = async (url, request) => {
    requests.push({ url: url.toString(), headers: request.headers, body: String(request.body) });
    const next = statuses.shift() ?? 200;
    if (next === "timeout") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    return new Response(null, { status: next });
  };
  return { transport, requests };
}

describeDb("Completion Callback PostgreSQL invariants", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const globalPrisma = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
  let actorUserId: string;
  let workspaceId: string;
  let clock = new Date(Math.ceil(Date.now() / 1000) * 1000 + 1000);
  const now = () => clock;
  const cipher = createCallbackCipher();
  const processor = (transport: PinnedTransport, leaseOwner = `test:${randomUUID()}`) =>
    createCompletionCallbackProcessor({ prisma, readTrusted: (scope, operation) => createOperationStatusReader(prisma).readTrusted(scope, operation),
      leaseOwner, now, random: () => 0.5, cipher, transport, resolver: publicResolver, log: () => {} });
  const scope = () => ({ actorUserId, workspaceId });
  const secrets = () => createCallbackSigningSecrets({ prisma, cipher, now });
  const verify = (secret: string, request: { headers: Headers; body: string }) =>
    new Webhook(secret).verify(request.body, Object.fromEntries(["webhook-id", "webhook-timestamp", "webhook-signature"].map((name) => [name, request.headers.get(name)!])));
  const pendingRow = (state: string) => {
    const eventId = randomUUID();
    const payload: CallbackPayload = { id: eventId, type: "operation.completed", version: 1, createdAt: clock.toISOString(), workspaceId,
      data: { operationId: "op_fixture", kind: "export", state: "completed", projectId: null } };
    return prisma.completionCallback.create({
      data: {
        workspaceId, operationKind: "export", operationId: randomUUID(), receiptId: randomUUID(),
        ...prepareCallbackRegistration(new URL("https://hooks.example/resume/abc"), cipher),
        eventId, state, payload: payload as unknown as Prisma.InputJsonValue, nextAttemptAt: clock,
      },
    });
  };

  beforeAll(async () => {
    if (!databaseUrl || !schema || !/^integration_test_[a-z0-9_]+$/.test(schema)) throw new Error("Integration DB tests require a disposable integration_test_ schema");
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), transactionOptions: { maxWait: 120_000, timeout: 120_000 } });
    priorPrisma = globalPrisma.narriflowPrismaClient;
    globalPrisma.narriflowPrismaClient = prisma;
    const actor = await prisma.user.create({ data: { clerkId: `callback-test:${randomUUID()}` } });
    actorUserId = actor.id;
    const workspace = await prisma.workspace.create({ data: { name: "Callbacks", ownerUserId: actor.id, pricingTier: "business", members: { create: { userId: actor.id, role: "owner" } } } });
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    globalPrisma.narriflowPrismaClient = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

  const link = (key: string, url: string) => projectService.queueLinkIngest(scope(), { title: `Callback ${key}`, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    { generationContext: { contentPack: pack, languageCode: "en" }, mutation: { clientIdempotencyKey: key, callback: { url: new URL(url) } } });

  test("a callback request refuses before any work commits when the Workspace has no signing secret", async () => {
    const key = randomUUID();
    await expect(link(key, "https://hooks.example/a")).rejects.toMatchObject({ code: "callback_secret_required" });
    expect(await prisma.project.count({ where: { title: `Callback ${key}` } })).toBe(0);
    expect(await prisma.operationReceipt.count({ where: { clientIdempotencyKey: key } })).toBe(0);
  });

  let linkIntake: { receiptId: string; projectId: string; jobId: string };
  let currentSecret: string;

  test("acceptance registers exactly one callback per receipt, including on replay", async () => {
    currentSecret = (await secrets().rotate(workspaceId)).secret;
    const key = randomUUID();
    const first = await link(key, "https://hooks.example/a");
    const replay = await link(key, "https://hooks.example/a");
    expect(replay.replayed).toBe(true);
    const receipt = await prisma.operationReceipt.findFirstOrThrow({ where: { clientIdempotencyKey: key } });
    const rows = await prisma.completionCallback.findMany({ where: { receiptId: receipt.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "waiting", operationKind: "intake", operationId: first.queuedJobId, urlHost: "hooks.example", eventId: callbackEventId(receipt.id) });
    expect(rows[0]!.encryptedUrl).not.toContain("hooks.example");
    await expect(link(key, "https://hooks.example/b")).rejects.toMatchObject({ code: "operation_idempotency_conflict" });
    linkIntake = { receiptId: receipt.id, projectId: first.project.id, jobId: first.queuedJobId! };
  });

  test("a Project deleted while its callback waits produces one unavailable event", async () => {
    const receive = receiver([200]);
    const worker = processor(receive.transport);
    expect(await worker.observe()).toBe(0);
    let row = await prisma.completionCallback.findUniqueOrThrow({ where: { receiptId: linkIntake.receiptId } });
    expect(row).toMatchObject({ state: "waiting", observationCount: 1 });
    expect(row.nextObservationAt.getTime() - clock.getTime()).toBe(15_000);

    await prisma.project.delete({ where: { id: linkIntake.projectId } });
    clock = new Date(clock.getTime() + 15_000);
    expect(await worker.observe()).toBe(1);
    expect(await worker.deliver()).toBe(1);
    expect(await worker.observe()).toBe(0);
    expect(await worker.deliver()).toBe(0);
    row = await prisma.completionCallback.findUniqueOrThrow({ where: { receiptId: linkIntake.receiptId } });
    expect(row).toMatchObject({ state: "delivered", attempts: 1, lastResponseStatus: 200 });
    expect(receive.requests).toHaveLength(1);
    const event = verify(currentSecret, receive.requests[0]!) as CallbackPayload;
    expect(receive.requests[0]!.url).toBe("https://hooks.example/a");
    expect(event).toMatchObject({ id: row.eventId, type: "operation.completed", version: 1, workspaceId,
      data: { kind: "intake", state: "unavailable", projectId: null, failureCode: "project_unavailable" } });
    expect(decodeOperationId(event.data.operationId)).toEqual({ kind: "intake", id: linkIntake.jobId });
  });

  test("a permanent upload failure produces one failed event for the upload intake", async () => {
    const sessionId = randomUUID();
    await prisma.uploadSession.create({ data: { id: sessionId, workspaceId, actorUserId, clientIdempotencyKey: randomUUID(), immutableInputFingerprint: "fixture",
      preallocatedProjectId: randomUUID(), title: "Upload", fileName: "upload.mp4", fileSizeBytes: 10n, contentType: "video/mp4", browserFingerprint: "fixture",
      generationSettings: {}, transferKind: "single", storageKey: `uploads/${sessionId}.mp4`, status: "uploading",
      expiresAt: new Date(Date.now() + 3_600_000), hardExpiresAt: new Date(Date.now() + 7_200_000) } });
    const registration = prepareCallbackRegistration(new URL("https://hooks.example/upload"), cipher);
    const claimed = await prismaUploadSessionPersistence.beginFinalization({ sessionId, parts: [], reconcileAt: new Date(), updatedAt: new Date(), callback: registration });
    expect(claimed.claimed).toBe(true);
    const again = await prismaUploadSessionPersistence.beginFinalization({ sessionId, parts: [], reconcileAt: new Date(), updatedAt: new Date(), callback: registration });
    expect(again.claimed).toBe(false);
    await prismaUploadSessionPersistence.registerUploadCallback({ sessionId, workspaceId, callback: registration });
    await expect(prismaUploadSessionPersistence.registerUploadCallback({ sessionId, workspaceId, callback: prepareCallbackRegistration(new URL("https://hooks.example/other"), cipher) }))
      .rejects.toMatchObject({ code: "operation_idempotency_conflict" });
    expect(await prisma.completionCallback.count({ where: { uploadSessionId: sessionId } })).toBe(1);

    // Reconciliation later fails permanently.
    await prisma.uploadSession.update({ where: { id: sessionId }, data: { status: "failed", failureCode: "upload_object_size_mismatch" } });
    const receive = receiver([200]);
    const worker = processor(receive.transport);
    expect(await worker.observe()).toBe(1);
    expect(await worker.deliver()).toBe(1);
    const event = JSON.parse(receive.requests[0]!.body) as CallbackPayload;
    expect(event.id).toBe(callbackEventId(sessionId));
    expect(event.data).toMatchObject({ kind: "intake", state: "failed", failureCode: "upload_object_size_mismatch" });
    expect(decodeOperationId(event.data.operationId)).toEqual({ kind: "intake", id: sessionId });
  });

  test("an upload callback without a signing secret leaves the session uploading", async () => {
    const other = await prisma.workspace.create({ data: { name: "No secret", ownerUserId: actorUserId, pricingTier: "business" } });
    const sessionId = randomUUID();
    await prisma.uploadSession.create({ data: { id: sessionId, workspaceId: other.id, actorUserId, clientIdempotencyKey: randomUUID(), immutableInputFingerprint: "fixture",
      preallocatedProjectId: randomUUID(), title: "Upload", fileName: "upload.mp4", fileSizeBytes: 10n, contentType: "video/mp4", browserFingerprint: "fixture",
      generationSettings: {}, transferKind: "single", storageKey: `uploads/${sessionId}.mp4`, status: "uploading",
      expiresAt: new Date(Date.now() + 3_600_000), hardExpiresAt: new Date(Date.now() + 7_200_000) } });
    await expect(prismaUploadSessionPersistence.beginFinalization({ sessionId, parts: [], reconcileAt: new Date(), updatedAt: new Date(),
      callback: prepareCallbackRegistration(new URL("https://hooks.example/upload"), cipher) })).rejects.toMatchObject({ code: "callback_secret_required" });
    expect((await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe("uploading");
  });

  test("retries back off with jitter, timeouts retry, and 410 cancels", async () => {
    const row = await pendingRow("pending");
    const receive = receiver([500, "timeout", 410]);
    const worker = processor(receive.transport);
    await worker.deliver();
    let current = await prisma.completionCallback.findUniqueOrThrow({ where: { id: row.id } });
    expect(current).toMatchObject({ state: "pending", attempts: 1, lastResponseStatus: 500 });
    expect(current.nextAttemptAt!.getTime() - clock.getTime()).toBe(30_000);
    expect(await worker.deliver()).toBe(0);
    clock = new Date(clock.getTime() + 30_000);
    await worker.deliver();
    current = await prisma.completionCallback.findUniqueOrThrow({ where: { id: row.id } });
    expect(current).toMatchObject({ state: "pending", attempts: 2, lastResponseStatus: null });
    expect(current.nextAttemptAt!.getTime() - clock.getTime()).toBe(120_000);
    clock = new Date(clock.getTime() + 120_000);
    await worker.deliver();
    current = await prisma.completionCallback.findUniqueOrThrow({ where: { id: row.id } });
    expect(current).toMatchObject({ state: "cancelled", attempts: 3, lastResponseStatus: 410, nextAttemptAt: null });
    expect(new Set(receive.requests.map((request) => request.headers.get("webhook-id")))).toEqual(new Set([row.eventId]));
  });

  test("the retry budget ends in failed, and redelivery restarts it with the same event ID", async () => {
    const row = await pendingRow("pending");
    const receive = receiver(Array(10).fill(503));
    const worker = processor(receive.transport);
    for (let attempt = 1; attempt <= 10; attempt++) {
      await prisma.completionCallback.update({ where: { id: row.id }, data: { nextAttemptAt: clock } });
      await worker.deliver();
    }
    expect(await prisma.completionCallback.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ state: "failed", attempts: 10, nextAttemptAt: null });
    const reset = await prisma.$transaction((tx) => resetCompletionCallbacks(tx, scope(), { kind: "export", id: row.operationId }, clock));
    expect(reset).toEqual([{ eventId: row.eventId, state: "pending" }]);
    const redelivered = receiver([204]);
    await processor(redelivered.transport).deliver();
    expect(await prisma.completionCallback.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ state: "delivered", attempts: 1 });
    expect(redelivered.requests[0]!.headers.get("webhook-id")).toBe(row.eventId);
    await expect(prisma.$transaction((tx) => resetCompletionCallbacks(tx, scope(), { kind: "export", id: randomUUID() }, clock))).rejects.toMatchObject({ code: "callback_not_found" });
  });

  test("a worker that lost its lease can't overwrite the newer outcome", async () => {
    const row = await pendingRow("pending");
    let release!: () => void;
    let started!: () => void;
    const reached = new Promise<void>((resolve) => { started = resolve; });
    const stale = processor(async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); return new Response(null, { status: 500 }); }, "stale-worker");
    const slow = stale.deliver();
    await reached;
    await prisma.completionCallback.update({ where: { id: row.id }, data: { leaseExpiresAt: new Date(clock.getTime() - 1) } });
    await processor(receiver([200]).transport, "fresh-worker").deliver();
    release();
    await slow;
    expect(await prisma.completionCallback.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ state: "delivered", attempts: 1, lastResponseStatus: 200 });
  });

  test("callbacks claim their lease when delivery starts, rather than while waiting in a batch", async () => {
    const previousClock = clock;
    const rows = await Promise.all(Array.from({ length: 8 }, () => pendingRow("pending")));
    const remainingLeases: number[] = [];
    try {
      const worker = processor(async (_url, request) => {
        const row = await prisma.completionCallback.findUniqueOrThrow({ where: { eventId: request.headers.get("webhook-id")! } });
        remainingLeases.push(row.leaseExpiresAt!.getTime() - clock.getTime());
        clock = new Date(clock.getTime() + 9_000);
        return new Response(null, { status: 200 });
      });
      expect(await worker.deliver(8)).toBe(8);
      expect(remainingLeases).toHaveLength(8);
      expect(remainingLeases.every((remaining) => remaining > 0)).toBe(true);
    } finally {
      await prisma.completionCallback.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
      clock = previousClock;
    }
  });

  test("an expired callback claim cannot acknowledge a delivery", async () => {
    const previousClock = clock;
    const row = await pendingRow("pending");
    try {
      const worker = processor(async () => {
        clock = new Date(clock.getTime() + 60_001);
        return new Response(null, { status: 200 });
      });
      expect(await worker.deliver()).toBe(0);
      expect(await prisma.completionCallback.findUniqueOrThrow({ where: { id: row.id } }))
        .toMatchObject({ state: "pending", attempts: 0, deliveredAt: null });
      expect(await processor(receiver([200]).transport).deliver()).toBe(1);
    } finally {
      await prisma.completionCallback.delete({ where: { id: row.id } });
      clock = previousClock;
    }
  });

  test("an old callback execution cannot cancel a new claim by the same worker", async () => {
    const previousClock = clock;
    const row = await pendingRow("pending");
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    let oldStarted!: () => void;
    let newStarted!: () => void;
    const oldReady = new Promise<void>((resolve) => { oldStarted = resolve; });
    const newReady = new Promise<void>((resolve) => { newStarted = resolve; });
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const newGate = new Promise<void>((resolve) => { releaseNew = resolve; });
    const old = processor(async () => { oldStarted(); await oldGate; return new Response(null, { status: 410 }); }, "same-worker").deliver();
    await oldReady;
    clock = new Date(clock.getTime() + 60_001);
    const fresh = processor(async () => { newStarted(); await newGate; return new Response(null, { status: 200 }); }, "same-worker").deliver();
    await newReady;
    const freshClaim = await prisma.completionCallback.findUniqueOrThrow({ where: { id: row.id } });
    try {
      releaseOld();
      expect(await old).toBe(0);
      expect(await prisma.completionCallback.findUniqueOrThrow({ where: { id: row.id } }))
        .toMatchObject({ state: "pending", leaseOwner: freshClaim.leaseOwner });
      releaseNew();
      expect(await fresh).toBe(1);
      expect(await prisma.completionCallback.findUniqueOrThrow({ where: { id: row.id } }))
        .toMatchObject({ state: "delivered", attempts: 1, lastResponseStatus: 200 });
    } finally {
      releaseOld(); releaseNew();
      await Promise.allSettled([old, fresh]);
      await prisma.completionCallback.delete({ where: { id: row.id } });
      clock = previousClock;
    }
  });

  test("rotation keeps the previous secret signing during the overlap, then retires it", async () => {
    const before = currentSecret;
    const rotated = (await secrets().rotate(workspaceId)).secret;
    expect(await secrets().signingSecrets(workspaceId)).toEqual([rotated, before]);
    const status = await secrets().status(workspaceId);
    expect(status.current).not.toBeNull();
    expect(status.previousRetiresAt).toBe(new Date(clock.getTime() + 86_400_000).toISOString());
    const row = await pendingRow("pending");
    const receive = receiver([200]);
    await processor(receive.transport).deliver();
    for (const secret of [before, rotated]) expect(verify(secret, receive.requests[0]!)).toBeDefined();
    expect(row.id).toBeString();
    clock = new Date(clock.getTime() + 86_400_001);
    expect(await secrets().signingSecrets(workspaceId)).toEqual([rotated]);
    currentSecret = rotated;
  });
});
