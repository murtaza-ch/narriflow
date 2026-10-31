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
  test("racing invocations start one paid request and immutable completion replay preserves its receipt", async () => {
    const f = await fixture(), reference = f.windows[0]!.reference;
    const service = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 1, maxEstimatedTokens: 100 });
    const responses = await Promise.all([service.admit(reference, { owner: crypto.randomUUID() }), service.admit(reference, { owner: crypto.randomUUID() })]);
    const begun = responses.find(response => response.kind === "begun");
    expect(responses.map(response => response.kind).sort()).toEqual(["begun", "wait"]);
    if (!begun || begun.kind !== "begun") throw new Error("No admitted window");
    expect(responses.find(response => response.kind === "wait")!.dispatchIds).toEqual(begun.dispatchIds);
    expect((await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } }))).toMatchObject({ status: "waiting", attemptId: null, leaseOwner: null, leaseExpiresAt: null, attemptCount: 0 });
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: reference.subject.id } })).attemptCount).toBe(1);
    const completed = await service.complete(begun.attempt, result(begun.attempt));
    expect(completed.kind).toBe("completed");
    expect(await service.complete(begun.attempt, result(begun.attempt))).toEqual(completed);
    expect((await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: begun.attempt.token } }))).toMatchObject({ status: "completed", leaseExpiresAt: begun.leaseExpiresAt });
    await expect(service.complete(begun.attempt, { ...result(begun.attempt), etag: '"different"' })).rejects.toThrow("receipt conflict");
  });
  test("a later Project gets the next provider turn and a release admits it before its observed capacity deadline", async () => {
    const first = await fixture(2), second = await fixture();
    const service = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 1, maxEstimatedTokens: 100 });
    const begun = await service.admit(first.windows[0]!.reference, { owner: crypto.randomUUID() });
    expect(begun.kind).toBe("begun");
    if (begun.kind !== "begun") throw new Error("No admitted window");
    expect((await service.admit(first.windows[1]!.reference, { owner: crypto.randomUUID() })).kind).toBe("wait");
    const blocked = await service.admit(second.windows[0]!.reference, { owner: crypto.randomUUID() });
    expect(blocked.kind).toBe("wait");
    const released = await service.complete(begun.attempt, result(begun.attempt));
    expect(released.dispatchIds.length).toBe(2);
    const next = await service.admit(second.windows[0]!.reference, { owner: crypto.randomUUID() });
    expect(next.kind).toBe("begun");
    if (next.kind !== "begun") throw new Error("Capacity release did not wake the fair Project");
    await service.complete(next.attempt, result(next.attempt));
    const last = await service.admit(first.windows[1]!.reference, { owner: crypto.randomUUID() });
    expect(last.kind).toBe("begun");
    if (last.kind === "begun") await service.complete(last.attempt, result(last.attempt));
  });
  test("weighted admission reserves the fair head rather than starving it with smaller requests", async () => {
    const first = await fixture(1, 80), large = await fixture(1, 80), small = await fixture(1, 20);
    const service = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 3, maxEstimatedTokens: 100 });
    const active = await service.admit(first.windows[0]!.reference, { owner: crypto.randomUUID() });
    if (active.kind !== "begun") throw new Error("First request was not admitted");
    expect((await service.admit(large.windows[0]!.reference, { owner: crypto.randomUUID() })).kind).toBe("wait");
    expect((await service.admit(small.windows[0]!.reference, { owner: crypto.randomUUID() })).kind).toBe("wait");
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: small.windows[0]!.row.id } })).attemptCount).toBe(0);
    await service.complete(active.attempt, result(active.attempt));
    const admittedLarge = await service.admit(large.windows[0]!.reference, { owner: crypto.randomUUID() });
    expect(admittedLarge.kind).toBe("begun");
    const admittedSmall = await service.admit(small.windows[0]!.reference, { owner: crypto.randomUUID() });
    expect(admittedSmall.kind).toBe("begun");
    if (admittedLarge.kind === "begun") await service.complete(admittedLarge.attempt, result(admittedLarge.attempt));
    if (admittedSmall.kind === "begun") await service.complete(admittedSmall.attempt, result(admittedSmall.attempt));
  });
  test("three charged retries keep one immutable deadline and revoke each previous executor before redispatch", async () => {
    const f = await fixture(), service = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 1, maxEstimatedTokens: 100 });
    let reference = f.windows[0]!.reference;
    const attempts: ClipSelectionWindowAttempt[] = [];
    for (let index = 0; index < 3; index++) {
      const active = await service.admit(reference, { owner: crypto.randomUUID() });
      expect(active.kind).toBe("begun");
      if (active.kind !== "begun") throw new Error("Retry not admitted");
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
    expect((await service.admit(reference, { owner: crypto.randomUUID() })).kind).toBe("failed");
  });
  test("expired queued work spends no attempt and a changed Transcript or forged ledger tuple cannot choose private inputs", async () => {
    const expired = await fixture(1, 60, true), current = await fixture();
    const service = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 1, maxEstimatedTokens: 100 });
    expect((await service.expire(expired.windows[0]!.reference)).kind).toBe("failed");
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: expired.windows[0]!.row.id } })).attemptCount).toBe(0);
    expect((await service.admit({ ...current.windows[0]!.reference, inputHash: "f".repeat(64) }, { owner: crypto.randomUUID() })).kind).toBe("superseded");
    await db.transcript.update({ where: { id: current.transcript.id }, data: { selectionGeneration: { increment: 1 }, text: "Replacement transcript" } });
    expect((await service.admit(current.windows[0]!.reference, { owner: crypto.randomUUID() })).kind).toBe("superseded");
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: current.windows[0]!.row.id } })).attemptCount).toBe(0);
  });
  test("a superseded transcript at the front of the queue cannot block another Project", async () => {
    const stale = await fixture(), fresh = await fixture();
    await db.transcript.update({ where: { id: stale.transcript.id }, data: { selectionGeneration: { increment: 1 } } });
    const service = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 1, maxEstimatedTokens: 100 });
    const admitted = await service.admit(fresh.windows[0]!.reference, { owner: crypto.randomUUID() });
    expect(admitted.kind).toBe("begun");
    if (admitted.kind === "begun") await service.complete(admitted.attempt, result(admitted.attempt));
  });
});
