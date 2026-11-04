import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { appendExecutionDispatch, createExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { ExecutionMaintenanceService, HOURLY_MAINTENANCE_PHASES, type MaintenancePage } from "./execution-maintenance";
import { recoverMediaCleanupPage } from "./execution-retention-pages";
import { recoverMediaCleanupWakePage } from "./execution-safety-pages";
import { createMediaCleanupControl, queueMediaCleanupWithinTransaction } from "./media-cleanup-control";
import { mediaCleanupObjectRetainUntil } from "./media-cleanup-holds";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Media cleanup independent safety wakes", () => {
  let database: PrismaClient;
  const ids: string[] = [], tokens: string[] = [];
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url, schema);
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString: url!, max: 1 }, { schema }), transactionOptions: { timeout: 5000, maxWait: 1000 } });
  });
  afterEach(async () => {
    await database.executionDispatch.deleteMany({ where: { subjectKind: "media_cleanup", subjectId: { in: ids.splice(0) } } });
    await database.mediaCleanupObligation.deleteMany({ where: { objectKey: { startsWith: "cleanup-safety-fixture/" } } });
    const attempts = tokens.splice(0);
    await database.executionArtifact.deleteMany({ where: { attemptToken: { in: attempts } } });
    await database.executionAttempt.deleteMany({ where: { attemptToken: { in: attempts } } });
  });
  afterAll(async () => { await database?.$disconnect(); });
  async function page(after: MaintenancePage["after"] = null, limit = 32): Promise<MaintenancePage> {
    return { deploymentEpoch: (await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch, cutoff: new Date(), after, limit };
  }
  async function fixture(options: { due?: Date; base?: boolean; claimExpiresAt?: Date; assigned?: boolean } = {}) {
    const row = await database.mediaCleanupObligation.create({ data: { origin: options.assigned ? "assigned_execution_artifact" : "clip_editor_document_persistence", cleanupClass: options.assigned ? "assigned_artifact" : "mutable_render", objectKey: `cleanup-safety-fixture/${crypto.randomUUID()}.mp4`,
      nextAttemptAt: options.due ?? new Date(0), ...(options.claimExpiresAt ? { claimId: crypto.randomUUID(), claimExpiresAt: options.claimExpiresAt } : {}) } });
    ids.push(row.id);
    const reference = options.base === false ? null : (await database.$transaction(tx => queueMediaCleanupWithinTransaction(tx, row.id)))!;
    return { row, reference };
  }
  async function assignedOutput(objectKey: string, grant: Date) {
    const epoch = (await page()).deploymentEpoch, token = crypto.randomUUID(), owner = crypto.randomUUID(); tokens.push(token);
    const producer = await database.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: "modal_execution", subject: { kind: "clip_preparation", id: crypto.randomUUID() }, inputHash: "a".repeat(64), dueAt: new Date(0) }));
    const attempt = await database.executionAttempt.create({ data: { attemptToken: token, dispatchId: producer.reference.dispatchId, deploymentEpoch: epoch, generation: 1, inputHash: producer.reference.inputHash, functionName: "prepare_clip", status: "completed", owner,
      createdAt: new Date(0), operationDeadlineAt: new Date(2), leaseExpiresAt: new Date(2), processStartedAt: new Date(1), finishedAt: new Date(2) } });
    await database.executionArtifact.create({ data: { attemptToken: token, owner, role: "preview_video", bindingHash: "a".repeat(64), storageKey: objectKey, contentType: "video/mp4", maxBytes: 100n, createdAt: new Date(0), grantExpiresAt: grant } });
    return attempt;
  }
  async function acknowledge(reference: NonNullable<Awaited<ReturnType<typeof fixture>>["reference"]>) {
    await database.executionDispatch.update({ where: { id: reference.dispatchId }, data: { acknowledgedAt: new Date(), destinationId: "errored-original-driver" } });
    return database.executionDispatch.findUniqueOrThrow({ where: { id: reference.dispatchId } });
  }

  test("daily replay cannot repair an acknowledged driver; an independent hourly wake deletes only its exact object", async () => {
    const f = await fixture({ assigned: true }), foreign = await fixture(), original = await acknowledge(f.reference!);
    const attempt = await assignedOutput(f.row.objectKey, new Date(1));
    await database.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: false } });
    const observation = await page();
    const daily = await database.$transaction(tx => recoverMediaCleanupPage(tx, observation));
    expect(daily.dispatchIds).toContain(f.reference!.dispatchId);
    let schedules = 0;
    const dispatch = createExecutionDispatch({ database, scheduler: { deliver: async () => { schedules++; throw Error("Must not reschedule acknowledged base"); } } });
    expect(await dispatch.deliver(f.reference!.dispatchId)).toMatchObject({ status: "acknowledged" });
    expect(schedules).toBe(0);
    const planned = await database.$transaction(tx => recoverMediaCleanupWakePage(tx, observation));
    const wake = (await Promise.all(planned.dispatchIds!.map(id => readExecutionDispatch(database, id)))).find(row => row?.reference.subject.id === f.row.id)!;
    expect(wake.reference).toMatchObject({ ...f.reference!, dispatchId: wake.reference.dispatchId });
    expect(wake.reference.dispatchId).not.toBe(f.reference!.dispatchId);
    expect(wake.wakeKind).toBe(`hourly_${observation.cutoff.getTime()}`);
    expect(wake.dueAt).toEqual(observation.cutoff);
    expect(await database.executionDispatch.findUniqueOrThrow({ where: { id: f.reference!.dispatchId } })).toEqual(original);
    expect(await database.executionAttempt.findUniqueOrThrow({ where: { attemptToken: attempt.attemptToken } })).toEqual(attempt);
    const deleted: string[] = [];
    const control = createMediaCleanupControl({ database, hold: mediaCleanupObjectRetainUntil, register: async () => {}, storage: { deleteExact: async key => { deleted.push(key); } } });
    await expect(control.run({ ...wake.reference, inputHash: "0".repeat(64) })).rejects.toMatchObject({ code: "cleanup_reference_invalid" });
    expect(await control.run(wake.reference)).toMatchObject({ kind: "complete" });
    expect(await control.run(wake.reference)).toMatchObject({ kind: "complete" });
    expect(deleted).toEqual([f.row.objectKey]);
    expect((await database.mediaCleanupObligation.findUniqueOrThrow({ where: { id: foreign.row.id } })).completedAt).toBeNull();
    expect(await database.executionDispatch.findUniqueOrThrow({ where: { id: f.reference!.dispatchId } })).toEqual(original);
    expect(await database.executionAttempt.findUniqueOrThrow({ where: { attemptToken: attempt.attemptToken } })).toEqual(attempt);
  });

  test("due cursor pages deduplicate each observation and leave future, claimed, completed and missing-base intents alone", async () => {
    const due = await Promise.all(Array.from({ length: 5 }, () => fixture()));
    const future = await fixture({ due: new Date(Date.now() + 60_000) }), claimed = await fixture({ claimExpiresAt: new Date(Date.now() + 60_000) }), missing = await fixture({ base: false }), completed = await fixture();
    await database.mediaCleanupObligation.update({ where: { id: completed.row.id }, data: { completedAt: new Date() } });
    const before = await database.mediaCleanupObligation.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
    const observation = await page(null, 2), seen: string[] = [];
    let cursor = observation.after;
    do {
      const current = { ...observation, after: cursor };
      const planned = await database.$transaction(tx => recoverMediaCleanupWakePage(tx, current));
      expect(planned.processed).toBeLessThanOrEqual(2);
      expect(await database.$transaction(tx => recoverMediaCleanupWakePage(tx, current))).toEqual(planned);
      for (const id of planned.dispatchIds!) seen.push((await readExecutionDispatch(database, id))!.reference.subject.id);
      cursor = planned.next;
    } while (cursor);
    expect(seen.sort()).toEqual(due.map(value => value.row.id).sort());
    expect(new Set(seen).size).toBe(5);
    expect(await database.mediaCleanupObligation.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } })).toEqual(before);
    const daily = await database.$transaction(tx => recoverMediaCleanupPage(tx, { ...observation, limit: 32 }));
    const missingBase = await database.executionDispatch.findFirstOrThrow({ where: { subjectKind: "media_cleanup", subjectId: missing.row.id, wakeKind: null } });
    expect(daily.dispatchIds).toContain(missingBase.id);
    expect(seen).not.toContain(future.row.id); expect(seen).not.toContain(claimed.row.id); expect(seen).not.toContain(missing.row.id);
  });

  test("registration loss replays the committed page and same wake, not a new cleanup attempt", async () => {
    const f = await fixture(); await acknowledge(f.reference!);
    let fail = false;
    const deliveries: string[][] = [];
    const phases = Object.fromEntries(HOURLY_MAINTENANCE_PHASES.map(name => [name, name === "cleanup_wakes" ? recoverMediaCleanupWakePage : async () => ({ processed: 0, next: null, dispatchIds: [] })]));
    const maintenance = new ExecutionMaintenanceService({ database, phases, register: async ids => { deliveries.push([...ids]); if (fail) throw Error("registration reply lost"); } });
    const root = await maintenance.start({ cadence: "hourly", scheduledAt: new Date() });
    fail = true;
    await expect(maintenance.run(root)).rejects.toThrow("registration reply lost");
    const continuation = deliveries.at(-1)!;
    expect((await database.mediaCleanupObligation.findUniqueOrThrow({ where: { id: f.row.id } })).attemptCount).toBe(0);
    fail = false;
    const { dispatchIds } = await maintenance.run(root);
    expect(dispatchIds.slice(-1)).toEqual(continuation);
    expect(deliveries.slice(-2)).toEqual([continuation, dispatchIds.slice(0, -1)]);
    expect(await database.executionDispatch.count({ where: { subjectId: f.row.id, wakeKind: { startsWith: "hourly_" } } })).toBe(1);
  });

  test("the real hold retains grants and a live claim acquired after observation still blocks deletion", async () => {
    const f = await fixture({ assigned: true });
    const grant = new Date(Date.now() + 60_000);
    const attempt = await assignedOutput(f.row.objectKey, grant);
    const observation = await page();
    const planned = await database.$transaction(tx => recoverMediaCleanupWakePage(tx, observation));
    const reference = (await readExecutionDispatch(database, planned.dispatchIds![0]!))!.reference;
    let deletes = 0;
    const control = createMediaCleanupControl({ database, hold: mediaCleanupObjectRetainUntil, register: async () => {}, storage: { deleteExact: async () => { deletes++; } } });
    const expiry = new Date(Date.now() + 30_000);
    await database.mediaCleanupObligation.update({ where: { id: f.row.id }, data: { claimId: crypto.randomUUID(), claimExpiresAt: expiry } });
    expect(await control.run(reference)).toMatchObject({ kind: "wait", until: expiry });
    expect(deletes).toBe(0);
    await database.mediaCleanupObligation.update({ where: { id: f.row.id }, data: { claimId: null, claimExpiresAt: null } });
    expect(await control.run(reference)).toMatchObject({ kind: "retry", until: new Date(grant.getTime() + 120_000) });
    expect(deletes).toBe(0);
    expect((await database.mediaCleanupObligation.findUniqueOrThrow({ where: { id: f.row.id } })).failureCode).toBe("object_retained");
    expect(await database.executionAttempt.findUniqueOrThrow({ where: { attemptToken: attempt.attemptToken } })).toEqual(attempt);
  });

  test("old-epoch observations and stale input bindings never obtain cleanup authority", async () => {
    const f = await fixture(), observation = await page();
    const planned = await database.$transaction(tx => recoverMediaCleanupWakePage(tx, observation));
    const wake = (await readExecutionDispatch(database, planned.dispatchIds![0]!))!.reference;
    let deletes = 0;
    const control = createMediaCleanupControl({ database, hold: mediaCleanupObjectRetainUntil, register: async () => {}, storage: { deleteExact: async () => { deletes++; } } });
    const wrongBinding = await database.$transaction(tx => appendExecutionDispatch(tx, { ...wake, inputHash: "0".repeat(64), wakeKind: "hourly_bad_binding", dueAt: observation.cutoff }));
    expect(await control.run(wrongBinding.reference)).toMatchObject({ kind: "superseded" });
    await database.executionEpoch.update({ where: { id: 1 }, data: { epoch: { increment: 1 } } });
    expect(await control.run(wake)).toMatchObject({ kind: "superseded" });
    const current = await page();
    expect(await database.$transaction(tx => recoverMediaCleanupWakePage(tx, current))).toEqual({ processed: 0, next: null, dispatchIds: [] });
    expect((await database.mediaCleanupObligation.findUniqueOrThrow({ where: { id: f.row.id } })).attemptCount).toBe(0);
    expect(deletes).toBe(0);
  });
});
