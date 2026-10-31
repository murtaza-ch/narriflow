import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { createMediaCleanupControl, queueMediaCleanupWithinTransaction } from "./media-cleanup-control";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { revokeRestoredAttemptsPage } from "./execution-restore-pages";
import { ExecutionRestoreService, EXECUTION_RESTORE_PHASES } from "./execution-restore";
import { ExecutionMaintenanceService, HOURLY_MAINTENANCE_PHASES } from "./execution-maintenance";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Execution restore authority", () => {
  let database: PrismaClient;
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url, schema);
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }), transactionOptions: { maxWait: 10_000, timeout: 30_000 } });
  });
  afterAll(async () => { await database?.$disconnect(); });
  test("begin closes and advances the epoch once, fencing an old command before registering recovery; a lost ACK resumes the same restore", async () => {
    const epoch = (await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
    const fenceAboveEpoch = epoch + 3, targetEpoch = fenceAboveEpoch + 1;
    const maintenance = new ExecutionMaintenanceService({ database, register: async () => {},
      phases: Object.fromEntries(HOURLY_MAINTENANCE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])) });
    const old = await maintenance.start({ cadence: "hourly", scheduledAt: new Date("2026-10-31T10:00:00.000Z") });
    let loseAcknowledgement = true;
    const registered: string[][] = [];
    const restore = new ExecutionRestoreService({ database, register: async ids => {
      expect(await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ epoch: targetEpoch, admissionOpen: false });
      expect(await maintenance.run(old)).toMatchObject({ kind: "superseded" });
      registered.push([...ids]);
      if (loseAcknowledgement) throw new Error("Lost restore acknowledgement");
    } });
    await expect(restore.begin({ expectedEpoch: epoch, fenceAboveEpoch })).rejects.toThrow("Lost restore acknowledgement");
    loseAcknowledgement = false;
    const recovered = await restore.begin({ expectedEpoch: epoch, fenceAboveEpoch });
    expect(recovered).toMatchObject({ previousEpoch: epoch, deploymentEpoch: targetEpoch });
    expect(registered[1]).toEqual(registered[0]);
    expect(await database.executionDispatch.count({ where: { deploymentEpoch: targetEpoch, subjectId: { startsWith: "rs1." } } })).toBe(1);
    await expect(restore.begin({ expectedEpoch: epoch + 2, fenceAboveEpoch })).rejects.toMatchObject({ code: "restore_epoch_changed" });
    expect((await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).admissionOpen).toBe(false);
  });
  test("the begin obligation and epoch fence roll back together when registration intent cannot be persisted", async () => {
    const before = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    const restore = new ExecutionRestoreService({ database, register: async () => {} });
    const trigger = `restore_begin_${crypto.randomUUID().replaceAll("-", "")}`;
    await database.$executeRawUnsafe(`CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."subjectId" LIKE 'rs1.${before.epoch}.${before.epoch}.${before.epoch + 1}.%' THEN RAISE EXCEPTION 'injected_restore_begin_failure'; END IF; RETURN NEW; END $$`);
    await database.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE INSERT ON "ExecutionDispatch" FOR EACH ROW EXECUTE FUNCTION "${trigger}"()`);
    try {
      await expect(restore.begin({ expectedEpoch: before.epoch, fenceAboveEpoch: before.epoch })).rejects.toThrow();
      expect(await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).toEqual(before);
      expect(await database.executionDispatch.count({ where: { deploymentEpoch: before.epoch + 1, subjectId: { startsWith: "rs1." } } })).toBe(0);
    } finally {
      await database.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "ExecutionDispatch"`);
      await database.$executeRawUnsafe(`DROP FUNCTION "${trigger}"()`);
    }
    expect(await restore.begin({ expectedEpoch: before.epoch, fenceAboveEpoch: before.epoch })).toMatchObject({ deploymentEpoch: before.epoch + 1 });
  });
  test("an epoch fence after cleanup timer confirmation prevents new DELETE HTTP", async () => {
    const before = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    const restore = new ExecutionRestoreService({ database, register: async () => {} });
    const intent = await database.mediaCleanupObligation.create({ data: { origin: "clip_editor_document_persistence", cleanupClass: "mutable_render", objectKey: `projects/${crypto.randomUUID()}/renders/${crypto.randomUUID()}.mp4`, nextAttemptAt: new Date(0) } });
    const reference = (await database.$transaction(tx => queueMediaCleanupWithinTransaction(tx, intent.id)))!;
    let deletes = 0;
    const control = createMediaCleanupControl({ database, hold: async () => null, register: async () => { await restore.begin({ expectedEpoch: before.epoch, fenceAboveEpoch: before.epoch }); }, storage: { async deleteExact() { deletes++; } } });
    expect(await control.run(reference)).toMatchObject({ kind: "superseded" });
    expect(deletes).toBe(0);
    expect((await database.mediaCleanupObligation.findUniqueOrThrow({ where: { id: intent.id } })).completedAt).toBeNull();
  });

  test("bounded restore pages revoke old execution authority once and replay their committed cursor after ACK loss", async () => {
    const before = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } }), tokens: string[] = [];
    for (const status of ["admitted", "running", "completed"]) {
      const record = await database.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: before.epoch, generation: 1, kind: "modal_execution", subject: { kind: "ingest_job", id: crypto.randomUUID() }, inputHash: "a".repeat(64), dueAt: new Date(0) }));
      const token = crypto.randomUUID(); tokens.push(token);
      await database.executionAttempt.create({ data: { attemptToken: token, dispatchId: record.reference.dispatchId, deploymentEpoch: before.epoch, generation: 1, inputHash: record.reference.inputHash, functionName: "fetch_source", status,
        createdAt: new Date(0), operationDeadlineAt: new Date(3), ...(status !== "admitted" ? { owner: crypto.randomUUID(), leaseExpiresAt: new Date(2), processStartedAt: new Date(1) } : {}), ...(status === "completed" ? { finishedAt: new Date(2) } : {}) } });
    }
    const activeBefore = await database.executionAttempt.count({ where: { deploymentEpoch: { lte: before.epoch }, status: { in: ["admitted", "running"] } } });
    let loseAcknowledgement = false;
    const registered: string[][] = [];
    const restore = new ExecutionRestoreService({ database, limit: 1, register: async ids => { registered.push([...ids]); if (loseAcknowledgement) throw new Error("Restore page ACK lost"); },
      phases: { ...Object.fromEntries(EXECUTION_RESTORE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])), attempts: revokeRestoredAttemptsPage } });
    const begun = await restore.begin({ expectedEpoch: before.epoch, fenceAboveEpoch: before.epoch });
    loseAcknowledgement = true;
    await expect(restore.run(begun.reference)).rejects.toThrow("Restore page ACK lost");
    expect(await database.executionAttempt.count({ where: { deploymentEpoch: { lte: before.epoch }, status: { in: ["admitted", "running"] } } })).toBe(activeBefore - 1);
    loseAcknowledgement = false;
    const replay = await restore.run(begun.reference);
    expect(replay.dispatchIds).toEqual(registered[1]!);
    expect(await database.executionAttempt.count({ where: { deploymentEpoch: { lte: before.epoch }, status: { in: ["admitted", "running"] } } })).toBe(activeBefore - 1);
    expect(await database.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience: "restore-page", deliveryId: begun.reference.dispatchId } } })).toMatchObject({ wakeDispatchIds: replay.dispatchIds });
    let reference = (await readExecutionDispatch(database, replay.dispatchIds.at(-1)!))!.reference;
    let completed = false;
    for (let index = 0; index < activeBefore + 2; index++) {
      const next = await restore.run(reference);
      expect(next.processed).toBeLessThanOrEqual(1);
      if (next.kind === "complete") { completed = true; break; }
      reference = (await readExecutionDispatch(database, next.dispatchIds.at(-1)!))!.reference;
    }
    expect(completed).toBe(true);
    expect(await database.executionAttempt.count({ where: { attemptToken: { in: tokens }, status: "superseded", revokedAt: { not: null } } })).toBe(2);
    expect((await database.executionAttempt.findUniqueOrThrow({ where: { attemptToken: tokens[2]! } })).status).toBe("completed");
    expect((await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).admissionOpen).toBe(false);
    await expect(restore.run({ ...reference, inputHash: "0".repeat(64) })).rejects.toMatchObject({ code: "restore_reference_invalid" });
  }, 60_000);

});
