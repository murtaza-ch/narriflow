import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { createMediaCleanupControl, queueMediaCleanupWithinTransaction } from "./media-cleanup-control";
import { createMediaCleanupDrain, queueMediaCleanupRangeWithinTransaction } from "./media-cleanup-drain";
import { mediaCleanupObjectRetainUntil } from "./media-cleanup-holds";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Exact media cleanup authority", () => {
  let database: PrismaClient;
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url, schema);
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5 }, { schema }), transactionOptions: { maxWait: 10_000, timeout: 30_000 } });
  });
  afterAll(async () => { await database?.$disconnect(); });
  async function fixture() {
    const row = await database.mediaCleanupObligation.create({ data: { origin: "clip_editor_document_persistence", cleanupClass: "mutable_render", objectKey: `projects/${crypto.randomUUID()}/renders/${crypto.randomUUID()}.mp4`, nextAttemptAt: new Date(0) } });
    return { row, reference: (await database.$transaction(tx => queueMediaCleanupWithinTransaction(tx, row.id)))! };
  }
  test("a producer range pages known rows and commits targeted wakes with a replayable cursor", async () => {
    const rows = await database.mediaCleanupObligation.createManyAndReturn({ data: Array.from({ length: 5 }, () => ({ origin: "clip_editor_document_persistence", cleanupClass: "mutable_render", objectKey: `projects/${crypto.randomUUID()}/renders/${crypto.randomUUID()}.mp4`, nextAttemptAt: new Date(0) })) });
    let reference = (await database.$transaction(tx => queueMediaCleanupRangeWithinTransaction(tx, rows.map(row => row.id))))!;
    const registered: string[][] = [];
    const drain = createMediaCleanupDrain({ database, register: async ids => { registered.push([...ids]); }, limit: 2 });
    const first = await drain.run(reference);
    expect(first).toMatchObject({ kind: "continue", processed: 2 });
    expect(first.dispatchIds).toHaveLength(3);
    expect(await drain.run(reference)).toEqual(first);
    reference = (await readExecutionDispatch(database, first.dispatchIds.at(-1)!))!.reference;
    const second = await drain.run(reference);
    expect(second).toMatchObject({ kind: "continue", processed: 2 });
    reference = (await readExecutionDispatch(database, second.dispatchIds.at(-1)!))!.reference;
    expect(await drain.run(reference)).toMatchObject({ kind: "complete", processed: 1 });
    expect(await database.executionDispatch.count({ where: { subjectKind: "media_cleanup", subjectId: { in: rows.map(row => row.id) }, wakeKind: null } })).toBe(5);
    expect(registered.every(ids => ids.length <= 3)).toBe(true);
  });
  test("one exact owner confirms its lease timer before DELETE, and committed replay issues no HTTP", async () => {
    const { row, reference } = await fixture();
    const registered: string[][] = []; let deletes = 0;
    const control = createMediaCleanupControl({ database, register: async ids => { registered.push([...ids]); }, hold: async () => null, storage: { async deleteExact(key) {
      deletes++; expect(key).toBe(row.objectKey);
      expect(registered).toHaveLength(1);
      const timer = await readExecutionDispatch(database, registered[0]![0]!);
      expect(timer).toMatchObject({ deadlineKind: "lease", wakeKind: "cleanup_claimed" });
      expect((await database.mediaCleanupObligation.findUniqueOrThrow({ where: { id: row.id } })).completedAt).toBeNull();
    } } });
    expect(await control.run(reference)).toMatchObject({ kind: "complete" });
    expect(await control.run(reference)).toEqual({ kind: "complete", dispatchIds: [] });
    expect(deletes).toBe(1);
    expect(await database.mediaCleanupObligation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ attemptCount: 1, claimId: null });
  });
  test("concurrent commands cannot both delete and a live claim reports its authoritative wait", async () => {
    const { reference } = await fixture();
    let release!: () => void, started!: () => void, deletes = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
    const control = createMediaCleanupControl({ database, register: async () => {}, hold: async () => null, storage: { async deleteExact() { deletes++; started(); await waiting; } } });
    const first = control.run(reference);
    await ready;
    expect(await control.run(reference)).toMatchObject({ kind: "wait" });
    release(); await first;
    expect(deletes).toBe(1);
  });
  test("unknown DELETE acceptance retains the exact intent and registers a new bounded retry", async () => {
    const { row, reference } = await fixture(); let deletes = 0;
    const registered: string[][] = [];
    const control = createMediaCleanupControl({ database, register: async ids => { registered.push([...ids]); }, hold: async () => null,
      storage: { async deleteExact(key) { deletes++; expect(key).toBe(row.objectKey); throw new Error("transport reply lost"); } } });
    const result = await control.run(reference);
    expect(result).toMatchObject({ kind: "retry" });
    const current = await database.mediaCleanupObligation.findUniqueOrThrow({ where: { id: row.id } });
    expect(current).toMatchObject({ objectKey: row.objectKey, completedAt: null, claimId: null, attemptCount: 1, failureCode: "storage_delete_unconfirmed" });
    const next = (await readExecutionDispatch(database, result.dispatchIds[0]!))!;
    expect(next.reference.generation).toBe(reference.generation + 1);
    expect(next.dueAt.getTime()).toBeGreaterThan(Date.now());
    expect(registered.at(-1)).toEqual(result.dispatchIds);
    expect(await control.run(reference)).toMatchObject({ kind: "superseded" });
    expect(deletes).toBe(1);
    expect(await database.$transaction(tx => queueMediaCleanupWithinTransaction(tx, row.id))).toEqual(next.reference);
  });
  test("old-reference replay confirms a committed retry after its scheduling acknowledgement was lost", async () => {
    const { reference } = await fixture(); let registrations = 0, deletes = 0;
    const control = createMediaCleanupControl({ database, register: async () => { if (++registrations === 2) throw new Error("retry ACK lost"); }, hold: async () => null,
      storage: { async deleteExact() { deletes++; throw new Error("DELETE response lost"); } } });
    await expect(control.run(reference)).rejects.toThrow("retry ACK lost");
    const next = await database.executionDispatch.findFirstOrThrow({ where: { subjectKind: "media_cleanup", subjectId: reference.subject.id, generation: 2, wakeKind: null } });
    expect(await control.run(reference)).toEqual({ kind: "superseded", dispatchIds: [next.id] });
    expect(registrations).toBe(3);
    expect(deletes).toBe(1);
  });
  test("a referenced or grant-held object is rescheduled and never forgotten", async () => {
    const { row, reference } = await fixture(); let deletes = 0;
    const until = new Date(Date.now() + 86_400_000);
    const control = createMediaCleanupControl({ database, register: async () => {}, hold: async () => until, storage: { async deleteExact() { deletes++; } } });
    const result = await control.run(reference);
    expect(result).toMatchObject({ kind: "retry", until });
    expect(await database.mediaCleanupObligation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ completedAt: null, claimId: null, nextAttemptAt: until, failureCode: "object_retained" });
    expect((await readExecutionDispatch(database, result.dispatchIds[0]!))!.dueAt).toEqual(until);
    expect(deletes).toBe(0);
  });
  test("a lost watchdog confirmation leaves the claim recoverable without starting DELETE", async () => {
    const { row, reference } = await fixture(); let deletes = 0;
    const control = createMediaCleanupControl({ database, register: async () => { throw new Error("registration unavailable"); }, hold: async () => null, storage: { async deleteExact() { deletes++; } } });
    await expect(control.run(reference)).rejects.toThrow("registration unavailable");
    expect(deletes).toBe(0);
    const claim = await database.mediaCleanupObligation.findUniqueOrThrow({ where: { id: row.id } });
    expect(claim.claimId).not.toBeNull();
    const confirmed: string[][] = [];
    const replay = createMediaCleanupControl({ database, register: async ids => { confirmed.push([...ids]); }, hold: async () => null, storage: { async deleteExact() { deletes++; } } });
    expect(await replay.run(reference)).toMatchObject({ kind: "wait", until: claim.claimExpiresAt });
    expect(confirmed[0]).toHaveLength(1);
    expect(deletes).toBe(0);
    await database.mediaCleanupObligation.update({ where: { id: row.id }, data: { claimExpiresAt: new Date(0) } });
    const recovered = createMediaCleanupControl({ database, register: async () => {}, hold: async () => null, storage: { async deleteExact() { deletes++; } } });
    expect(await recovered.run(reference)).toMatchObject({ kind: "complete" });
    expect((await database.mediaCleanupObligation.findUniqueOrThrow({ where: { id: row.id } })).attemptCount).toBe(2);
    expect(deletes).toBe(1);
  });
  test("adoption extending a tentative hold replaces the old due time without losing its wake", async () => {
    const { row, reference } = await fixture(); let deletes = 0;
    const until = new Date(Date.now() + 720_000);
    await database.mediaCleanupObligation.update({ where: { id: row.id }, data: { nextAttemptAt: until } });
    const control = createMediaCleanupControl({ database, register: async () => {}, hold: async () => null, storage: { async deleteExact() { deletes++; } } });
    const result = await control.run(reference);
    expect(result).toMatchObject({ kind: "retry", until });
    expect((await readExecutionDispatch(database, result.dispatchIds[0]!))!.dueAt).toEqual(until);
    expect(deletes).toBe(0);
  });
  test("assigned output grants drain before deletion and a committed source survives until its Project reference is gone", async () => {
    const user = await database.user.create({ data: { clerkId: `cleanup-holds:${crypto.randomUUID()}` } });
    const workspace = await database.workspace.create({ data: { name: "Cleanup holds", ownerUserId: user.id } });
    const project = await database.project.create({ data: { title: "Cleanup source", sourceMediaUrl: "r2://fixture/source", workspaceId: workspace.id } });
    const job = await database.ingestJob.create({ data: { projectId: project.id, jobType: "upload_finalize", payload: {}, status: "completed" } });
    const epoch = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    const dispatch = await database.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch.epoch, generation: 1, kind: "modal_execution", subject: { kind: "ingest_job", id: job.id }, inputHash: "a".repeat(64), dueAt: new Date(0) }));
    const token = crypto.randomUUID(), owner = crypto.randomUUID(), key = `execution/${epoch.epoch}/${token}/${owner}/${crypto.randomUUID()}`;
    await database.executionAttempt.create({ data: { attemptToken: token, dispatchId: dispatch.reference.dispatchId, deploymentEpoch: epoch.epoch, generation: 1, inputHash: dispatch.reference.inputHash, functionName: "fetch_source", createdAt: new Date(Date.now() - 900_000), operationDeadlineAt: new Date(Date.now() - 300_000), status: "completed", owner, leaseExpiresAt: new Date(Date.now() - 300_000), processStartedAt: new Date(Date.now() - 600_000), finishedAt: new Date(Date.now() - 299_000) } });
    const expiresAt = new Date(Date.now() + 60_000);
    const artifact = await database.executionArtifact.create({ data: { attemptToken: token, owner, role: "source_video", bindingHash: "a".repeat(64), storageKey: key, contentType: "video/mp4", maxBytes: 100n, createdAt: new Date(0), grantExpiresAt: expiresAt } });
    const intent = await database.mediaCleanupObligation.create({ data: { origin: "assigned_execution_artifact", cleanupClass: "assigned_artifact", objectKey: key, nextAttemptAt: new Date(0) } });
    expect(await database.$transaction(tx => mediaCleanupObjectRetainUntil(tx, intent, new Date()))).toEqual(new Date(expiresAt.getTime() + 120_000));
    await database.executionArtifact.update({ where: { id: artifact.id }, data: { grantExpiresAt: new Date(1), committedAt: new Date(2), byteLength: 100n, checksumSha256: "a".repeat(64), etag: '"sealed"' } });
    await database.project.update({ where: { id: project.id }, data: { sourceStorageKey: key } });
    let reference = (await database.$transaction(tx => queueMediaCleanupWithinTransaction(tx, intent.id)))!, deletes = 0;
    const control = createMediaCleanupControl({ database, register: async () => {}, hold: mediaCleanupObjectRetainUntil, storage: { async deleteExact() { deletes++; } } });
    expect(await control.run(reference)).toMatchObject({ kind: "retry" });
    expect(deletes).toBe(0);
    await database.project.delete({ where: { id: project.id } });
    await database.mediaCleanupObligation.update({ where: { id: intent.id }, data: { nextAttemptAt: new Date(0) } });
    reference = (await database.$transaction(tx => queueMediaCleanupWithinTransaction(tx, intent.id)))!;
    expect(await control.run(reference)).toMatchObject({ kind: "complete" });
    expect(deletes).toBe(1);
  });
  test("immutable dispatch inputs are checked before selecting the trusted object or hold port", async () => {
    const { reference } = await fixture(); let calls = 0;
    const control = createMediaCleanupControl({ database, register: async () => {}, hold: async () => { calls++; return null; }, storage: { async deleteExact() { calls++; } } });
    await expect(control.run({ ...reference, inputHash: "0".repeat(64) })).rejects.toMatchObject({ code: "cleanup_reference_invalid" });
    expect(calls).toBe(0);
  });
});
