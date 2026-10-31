import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { clipSelectionTranscriptHash, clipSelectionWindowResultKey, createClipSelectionLifecycle, type ClipSelectionWindowAttempt } from "./clip-selection-window";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const dbDescribe = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
dbDescribe("Fenced clip selection provider windows", () => {
  let db: PrismaClient;
  const users: string[] = [];
  let ordinal = 0;
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    assertExecutionDatabaseTestTarget(url, schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 8 }, { schema }), transactionOptions: { maxWait: 10_000, timeout: 30_000 } });
  });
  afterAll(async () => {
    await db.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });
  async function fixture(count = 1, estimatedTokens = 60, expired = false) {
    const user = await db.user.create({ data: { clerkId: `selection-owner-gate:${crypto.randomUUID()}` } }); users.push(user.id);
    const workspace = await db.workspace.create({ data: { ownerUserId: user.id, name: "Selection owner gate" } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Selection owner gate", sourceMediaUrl: "r2://gate/source", ingestStatus: "ready" } });
    const transcript = await db.transcript.create({ data: { projectId: project.id, status: "completed", workflowAttemptId: crypto.randomUUID(), sourceRevision: 1, text: "Frozen transcript" } });
    const epoch = (await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
    const run = await db.workflowRun.create({ data: { projectId: project.id, stage: "moment_detection", status: "waiting", idempotencyKey: crypto.randomUUID(), deploymentEpoch: epoch } });
    const windows = await db.$transaction(async tx => {
      await appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: "operation_driver", subject: { kind: "workflow_run", id: run.id }, inputHash: "a".repeat(64), dueAt: run.createdAt });
      const rows = [];
      for (let index = 0; index < count; index++) {
        const row = await tx.clipSelectionWindow.create({ data: { projectId: project.id, workflowRunId: run.id, workflowGeneration: 1, deploymentEpoch: epoch,
          transcriptId: transcript.id, transcriptGeneration: 1, transcriptAttemptId: transcript.workflowAttemptId, transcriptContentHash: await clipSelectionTranscriptHash(transcript), sourceRevision: 1,
          selectionHash: "b".repeat(64), windowCount: count, windowIndex: index, startSec: index * 1800, endSec: index * 1800 + 1920, inputHash: "c".repeat(64),
          inputStorageKey: `projects/${project.id}/selection/${run.id}/input.json`, inputEtag: '"input"', inputChecksumSha256: "d".repeat(64), inputByteLength: 4096n,
          estimatedTokens, providerQueuedAt: new Date(Date.now() - 100_000 + ordinal++ * 10), operationDeadlineAt: new Date(Date.now() + (expired ? -1000 : 600_000)),
          ...(expired ? { createdAt: new Date(Date.now() - 601_000) } : {}) } });
        const dispatch = await appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: "operation_driver", subject: { kind: "clip_selection_window", id: row.id }, inputHash: row.inputHash, dueAt: row.createdAt });
        rows.push({ row, reference: dispatch.reference });
      }
      return rows;
    });
    return { project, transcript, run, windows };
  }
  function result(attempt: ClipSelectionWindowAttempt) {
    return { storageKey: clipSelectionWindowResultKey(attempt, "e".repeat(64)), etag: '"result"', sha256: "e".repeat(64), byteLength: 1234, tokensUsed: 99, providerRequestId: "req_gate" };
  }
  async function admitStarted(service: ReturnType<typeof createClipSelectionLifecycle>, reference: Parameters<ReturnType<typeof createClipSelectionLifecycle>["admit"]>[0], invocation: { owner: string }) {
    const acquired = await service.admit(reference, invocation);
    if (acquired.kind === "acquired") expect((await service.start(acquired.attempt)).kind).toBe("started");
    return acquired;
  }
  test("racing invocations start one paid request and immutable completion replay preserves its receipt", async () => {
    const f = await fixture(), reference = f.windows[0]!.reference;
    const service = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 1, maxEstimatedTokens: 100 });
    const responses = await Promise.all([service.admit(reference, { owner: crypto.randomUUID() }), service.admit(reference, { owner: crypto.randomUUID() })]);
    const begun = responses.find(response => response.kind === "acquired");
    expect(responses.map(response => response.kind).sort()).toEqual(["acquired", "wait"]);
    if (!begun || begun.kind !== "acquired") throw new Error("No admitted window");
    expect(responses.find(response => response.kind === "wait")!.dispatchIds).toEqual(begun.dispatchIds);
    expect((await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } }))).toMatchObject({ status: "waiting", attemptId: null, leaseOwner: null, leaseExpiresAt: null, attemptCount: 0 });
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: reference.subject.id } })).attemptCount).toBe(0);
    expect(await service.start(begun.attempt)).toMatchObject({ kind: "started", leaseExpiresAt: begun.leaseExpiresAt, operationDeadlineAt: begun.operationDeadlineAt });
    expect((await service.start(begun.attempt)).kind).toBe("already_started");
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: reference.subject.id } })).attemptCount).toBe(1);
    const completed = await service.complete(begun.attempt, result(begun.attempt));
    expect(completed.kind).toBe("completed");
    expect(await service.complete(begun.attempt, result(begun.attempt))).toEqual(completed);
    expect((await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: begun.attempt.token } }))).toMatchObject({ status: "completed", leaseExpiresAt: begun.leaseExpiresAt });
    expect((await service.start(begun.attempt)).kind).toBe("superseded");
    await expect(service.complete(begun.attempt, { ...result(begun.attempt), etag: '"different"' })).rejects.toThrow("receipt conflict");
  });
  test("a later Project gets the next provider turn and a release admits it before its observed capacity deadline", async () => {
    const first = await fixture(2), second = await fixture();
    const service = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 1, maxEstimatedTokens: 100 });
    const begun = await admitStarted(service, first.windows[0]!.reference, { owner: crypto.randomUUID() });
    expect(begun.kind).toBe("acquired");
    if (begun.kind !== "acquired") throw new Error("No admitted window");
    expect((await admitStarted(service, first.windows[1]!.reference, { owner: crypto.randomUUID() })).kind).toBe("wait");
    const blocked = await admitStarted(service, second.windows[0]!.reference, { owner: crypto.randomUUID() });
    expect(blocked.kind).toBe("wait");
    const released = await service.complete(begun.attempt, result(begun.attempt));
    expect(released.dispatchIds.length).toBe(2);
    const next = await admitStarted(service, second.windows[0]!.reference, { owner: crypto.randomUUID() });
    expect(next.kind).toBe("acquired");
    if (next.kind !== "acquired") throw new Error("Capacity release did not wake the fair Project");
    await service.complete(next.attempt, result(next.attempt));
    const last = await admitStarted(service, first.windows[1]!.reference, { owner: crypto.randomUUID() });
    expect(last.kind).toBe("acquired");
    if (last.kind === "acquired") await service.complete(last.attempt, result(last.attempt));
  });
  test("weighted admission reserves the fair head rather than starving it with smaller requests", async () => {
    const first = await fixture(1, 80), large = await fixture(1, 80), small = await fixture(1, 20);
    const service = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 3, maxEstimatedTokens: 100 });
    const active = await admitStarted(service, first.windows[0]!.reference, { owner: crypto.randomUUID() });
    if (active.kind !== "acquired") throw new Error("First request was not admitted");
    expect((await admitStarted(service, large.windows[0]!.reference, { owner: crypto.randomUUID() })).kind).toBe("wait");
    expect((await admitStarted(service, small.windows[0]!.reference, { owner: crypto.randomUUID() })).kind).toBe("wait");
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: small.windows[0]!.row.id } })).attemptCount).toBe(0);
    await service.complete(active.attempt, result(active.attempt));
    const admittedLarge = await admitStarted(service, large.windows[0]!.reference, { owner: crypto.randomUUID() });
    expect(admittedLarge.kind).toBe("acquired");
    const admittedSmall = await admitStarted(service, small.windows[0]!.reference, { owner: crypto.randomUUID() });
    expect(admittedSmall.kind).toBe("acquired");
    if (admittedLarge.kind === "acquired") await service.complete(admittedLarge.attempt, result(admittedLarge.attempt));
    if (admittedSmall.kind === "acquired") await service.complete(admittedSmall.attempt, result(admittedSmall.attempt));
  });
  test("three charged retries keep one immutable deadline and revoke each previous executor before redispatch", async () => {
    const f = await fixture(), service = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 1, maxEstimatedTokens: 100 });
    let reference = f.windows[0]!.reference;
    const attempts: ClipSelectionWindowAttempt[] = [];
    for (let index = 0; index < 3; index++) {
      const active = await admitStarted(service, reference, { owner: crypto.randomUUID() });
      expect(active.kind).toBe("acquired");
      if (active.kind !== "acquired") throw new Error("Retry not admitted");
      attempts.push(active.attempt);
      const settled = await service.retry(active.attempt, { code: "openai_request_failed", dueAt: new Date(0) });
      expect(settled.kind).toBe(index < 2 ? "retried" : "failed");
      expect((await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: active.attempt.token } }))).toMatchObject({ status: "failed", failureCode: "openai_request_failed" });
      const row = await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: reference.subject.id } });
      expect(row.operationDeadlineAt).toEqual(f.windows[0]!.row.operationDeadlineAt);
      if (index < 2) {
        const registered = await Promise.all(settled.dispatchIds.map(id => readExecutionDispatch(db, id)));
        reference = registered.find(record => record?.reference.subject.kind === "clip_selection_window" && record.wakeKind === null)!.reference;
        expect(reference.generation).toBe(index + 2);
        const replayed = await service.retry(active.attempt, { code: "openai_request_failed", dueAt: new Date(0) });
        expect(replayed.dispatchIds).toContain(reference.dispatchId);
      }
    }
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: reference.subject.id } }))).toMatchObject({ status: "failed", attemptCount: 3, generation: 3 });
    expect((await service.complete(attempts[0]!, result(attempts[0]!))).kind).toBe("superseded");
    expect((await admitStarted(service, reference, { owner: crypto.randomUUID() })).kind).toBe("failed");
  });
  test("expired queued work spends no attempt and a changed Transcript or forged ledger tuple cannot choose private inputs", async () => {
    const expired = await fixture(1, 60, true), current = await fixture();
    const service = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 1, maxEstimatedTokens: 100 });
    expect((await service.expire(expired.windows[0]!.reference)).kind).toBe("failed");
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: expired.windows[0]!.row.id } })).attemptCount).toBe(0);
    expect((await admitStarted(service, { ...current.windows[0]!.reference, inputHash: "f".repeat(64) }, { owner: crypto.randomUUID() })).kind).toBe("superseded");
    await db.transcript.update({ where: { id: current.transcript.id }, data: { selectionGeneration: { increment: 1 }, text: "Replacement transcript" } });
    expect((await admitStarted(service, current.windows[0]!.reference, { owner: crypto.randomUUID() })).kind).toBe("superseded");
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: current.windows[0]!.row.id } })).attemptCount).toBe(0);
  });
  test("a superseded transcript at the front of the queue cannot block another Project", async () => {
    const stale = await fixture(), fresh = await fixture();
    await db.transcript.update({ where: { id: stale.transcript.id }, data: { selectionGeneration: { increment: 1 } } });
    const service = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 1, maxEstimatedTokens: 100 });
    const admitted = await admitStarted(service, fresh.windows[0]!.reference, { owner: crypto.randomUUID() });
    expect(admitted.kind).toBe("acquired");
    if (admitted.kind === "acquired") await service.complete(admitted.attempt, result(admitted.attempt));
  });
  test("source replacement revokes an unstarted historical owner without charging when its exact watchdog is observed", async () => {
    const f = await fixture(), service = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 1, maxEstimatedTokens: 100 });
    const active = await service.admit(f.windows[0]!.reference, { owner: crypto.randomUUID() });
    if (active.kind !== "acquired") throw new Error("Window not acquired");
    await db.transcript.update({ where: { id: f.transcript.id }, data: { selectionGeneration: { increment: 1 }, text: "Replacement" } });
    expect((await service.start(active.attempt)).kind).toBe("superseded");
    expect((await service.expire(active.attempt.reference)).kind).toBe("superseded");
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: f.windows[0]!.row.id } }))).toMatchObject({ status: "cancelled", attemptCount: 0 });
    expect((await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: active.attempt.token } }))).toMatchObject({ status: "superseded", failureCode: "selection_source_superseded", processStartedAt: null });
  });
  test("changed contents cannot consume a permit or strand the fair queue even if a writer failed to advance its Transcript generation", async () => {
    const stale = await fixture(), fresh = await fixture();
    await db.transcript.update({ where: { id: stale.transcript.id }, data: { text: "Changed contents" } });
    const service = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 1, maxEstimatedTokens: 100 });
    expect((await service.admit(stale.windows[0]!.reference, { owner: crypto.randomUUID() })).kind).toBe("superseded");
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: stale.windows[0]!.row.id } }))).toMatchObject({ status: "cancelled", attemptCount: 0, executorOwner: null });
    const admitted = await admitStarted(service, fresh.windows[0]!.reference, { owner: crypto.randomUUID() });
    expect(admitted.kind).toBe("acquired");
    if (admitted.kind === "acquired") await service.complete(admitted.attempt, result(admitted.attempt));
  });
  test("completion rechecks the database lease after waiting for the account lock", async () => {
    const f = await fixture(), service = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 1, maxEstimatedTokens: 100 });
    const active = await admitStarted(service, f.windows[0]!.reference, { owner: crypto.randomUUID() });
    if (active.kind !== "acquired") throw new Error("Window not acquired");
    const leaseExpiresAt = new Date(Date.now() + 1500);
    await db.clipSelectionWindow.update({ where: { id: f.windows[0]!.row.id }, data: { leaseExpiresAt } });
    await db.executionAttempt.update({ where: { attemptToken: active.attempt.token }, data: { leaseExpiresAt } });
    let release!: () => void, markHeld!: (pid: number) => void;
    const released = new Promise<void>(resolve => { release = resolve; }), held = new Promise<number>(resolve => { markHeld = resolve; });
    const holder = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('provider_capacity:openai:clip_selection', 0)) IS NULL AS "locked"`;
      const [session] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      markHeld(session!.pid); await released;
    });
    const pid = await held, completing = service.complete(active.attempt, result(active.attempt));
    try {
      let blocked = false;
      for (let count = 0; count < 100 && !blocked; count++) {
        const [activity] = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid}::integer = ANY(pg_blocking_pids(pid))) AS blocked`;
        blocked = activity!.blocked; if (!blocked) await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      expect(Date.now()).toBeLessThan(leaseExpiresAt.getTime());
      await new Promise(resolve => setTimeout(resolve, Math.max(0, leaseExpiresAt.getTime() - Date.now() + 30)));
    } finally { release(); await holder; }
    expect((await completing).kind).toBe("superseded");
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: f.windows[0]!.row.id } })).resultStorageKey).toBeNull();
    expect((await service.expire(active.attempt.reference)).kind).toBe("superseded");
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: f.windows[0]!.row.id } }))).toMatchObject({ status: "queued", generation: 2, attemptCount: 1 });
  });
});
