import { restoreBillingPage, restoreLibraryPage } from "./execution-account-recovery-pages";
import { queueLibraryIndex } from "./library-index";
import { queueBillingReconciliation } from "./billing-reconciliation";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { createMediaCleanupControl, queueMediaCleanupWithinTransaction } from "./media-cleanup-control";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { revokeRestoredAttemptsPage } from "./execution-restore-pages";
import { ExecutionRestoreService, EXECUTION_RESTORE_PHASES } from "./execution-restore";
import { ExecutionMaintenanceService, HOURLY_MAINTENANCE_PHASES } from "./execution-maintenance";
import { capturedExecutionSnapshotFixture, SNAPSHOT_TEST_WORKER } from "./execution-snapshot-test-support";
import { fenceExecutionSnapshot, executionSnapshotIdentityHash, validateExecutionSnapshotEvidence } from "./execution-snapshot";

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
  test("a validated quiesced snapshot advances once and a lost ACK resumes the same proof-bound obligation", async () => {
    const maintenance = new ExecutionMaintenanceService({ database, register: async () => {}, phases: Object.fromEntries(HOURLY_MAINTENANCE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])) });
    const old = await maintenance.start({ cadence: "hourly", scheduledAt: new Date("2026-10-31T10:00:00.000Z") });
    const input = await capturedExecutionSnapshotFixture(database), targetEpoch = input.expectedEpoch + 1;
    let loseAcknowledgement = true;
    const registered: string[][] = [];
    const restore = new ExecutionRestoreService({ database, register: async ids => {
      expect(await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ epoch: targetEpoch, admissionOpen: false });
      expect(await maintenance.run(old)).toMatchObject({ kind: "superseded" });
      registered.push([...ids]); if (loseAcknowledgement) throw new Error("Lost restore acknowledgement");
    } });
    await expect(restore.begin(input)).rejects.toThrow("Lost restore acknowledgement");
    loseAcknowledgement = false;
    const recovered = await restore.begin(input);
    expect(recovered).toMatchObject({ previousEpoch: input.expectedEpoch, deploymentEpoch: targetEpoch });
    expect(registered[1]).toEqual(registered[0]);
    expect(await database.executionDispatch.count({ where: { deploymentEpoch: targetEpoch, subjectId: { startsWith: "rs2." } } })).toBe(1);
    await expect(restore.begin({ ...input, expectedEpoch: input.expectedEpoch + 2 })).rejects.toMatchObject({ code: "restore_snapshot_proof_invalid" });
    expect((await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).admissionOpen).toBe(false);
  });
  test("the begin obligation and epoch fence roll back together when registration intent cannot be persisted", async () => {
    const input = await capturedExecutionSnapshotFixture(database), before = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    const restore = new ExecutionRestoreService({ database, register: async () => {} });
    const trigger = `restore_begin_${crypto.randomUUID().replaceAll("-", "")}`;
    await database.$executeRawUnsafe(`CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."subjectId" LIKE 'rs2.${before.epoch}.${before.epoch}.${before.epoch + 1}.%' THEN RAISE EXCEPTION 'injected_restore_begin_failure'; END IF; RETURN NEW; END $$`);
    await database.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE INSERT ON "ExecutionDispatch" FOR EACH ROW EXECUTE FUNCTION "${trigger}"()`);
    try {
      await expect(restore.begin(input)).rejects.toThrow();
      expect(await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).toEqual(before);
      expect(await database.executionDispatch.count({ where: { deploymentEpoch: before.epoch + 1, subjectId: { startsWith: "rs2." } } })).toBe(0);
    } finally {
      await database.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "ExecutionDispatch"`);
      await database.$executeRawUnsafe(`DROP FUNCTION "${trigger}"()`);
    }
    expect(await restore.begin(input)).toMatchObject({ deploymentEpoch: before.epoch + 1 });
  });
  test("an epoch fence after cleanup timer confirmation prevents new DELETE HTTP", async () => {
    const before = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    const intent = await database.mediaCleanupObligation.create({ data: { origin: "clip_editor_document_persistence", cleanupClass: "mutable_render", objectKey: `projects/${crypto.randomUUID()}/renders/${crypto.randomUUID()}.mp4`, nextAttemptAt: new Date(0) } });
    const reference = (await database.$transaction(tx => queueMediaCleanupWithinTransaction(tx, intent.id)))!; let deletes = 0;
    const control = createMediaCleanupControl({ database, hold: async () => null, register: async () => { await fenceExecutionSnapshot(database, { expectedEpoch: before.epoch, worker: SNAPSHOT_TEST_WORKER }); }, storage: { async deleteExact() { deletes++; } } });
    expect(await control.run(reference)).toMatchObject({ kind: "superseded" }); expect(deletes).toBe(0);
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
    const input = await capturedExecutionSnapshotFixture(database); let loseAcknowledgement = false;
    const registered: string[][] = [];
    const restore = new ExecutionRestoreService({ database, limit: 1, register: async ids => { registered.push([...ids]); if (loseAcknowledgement) throw new Error("Restore page ACK lost"); },
      phases: { ...Object.fromEntries(EXECUTION_RESTORE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])), attempts: revokeRestoredAttemptsPage } });
    const begun = await restore.begin(input); loseAcknowledgement = true;
    await expect(restore.run(begun.reference)).rejects.toThrow("Restore page ACK lost");
    expect(await database.executionAttempt.count({ where: { deploymentEpoch: { lte: before.epoch }, status: { in: ["admitted", "running"] } } })).toBe(activeBefore - 1);
    loseAcknowledgement = false; const replay = await restore.run(begun.reference);
    expect(replay.dispatchIds).toEqual(registered[1]!);
    expect(await database.executionAttempt.count({ where: { deploymentEpoch: { lte: before.epoch }, status: { in: ["admitted", "running"] } } })).toBe(activeBefore - 1);
    expect(await database.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience: "restore-page", deliveryId: begun.reference.dispatchId } } })).toMatchObject({ wakeDispatchIds: replay.dispatchIds });
    let reference = (await readExecutionDispatch(database, replay.dispatchIds.at(-1)!))!.reference, completed = false;
    for (let index = 0; index < activeBefore + 2; index++) {
      const next = await restore.run(reference); expect(next.processed).toBeLessThanOrEqual(1);
      if (next.kind === "complete") { completed = true; break; }
      reference = (await readExecutionDispatch(database, next.dispatchIds.at(-1)!))!.reference;
    }
    expect(completed).toBe(true);
    expect(await database.executionAttempt.count({ where: { attemptToken: { in: tokens }, status: "superseded", revokedAt: { not: null } } })).toBe(2);
    expect((await database.executionAttempt.findUniqueOrThrow({ where: { attemptToken: tokens[2]! } })).status).toBe("completed");
    expect((await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).admissionOpen).toBe(false);
    await expect(restore.run({ ...reference, inputHash: "0".repeat(64) })).rejects.toMatchObject({ code: "restore_reference_invalid" });
  }, 60_000);
  test("operator inspection proves the current registered source pair and exact page receipt without reopening or resetting work", async () => {
    const input = await capturedExecutionSnapshotFixture(database);
    const restore = new ExecutionRestoreService({ database, register: async () => {}, phases: Object.fromEntries(EXECUTION_RESTORE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])) });
    const begun = await restore.begin(input);
    expect((await restore.inspectCurrent()).restore?.reference).toEqual(begun.reference);
    expect(await restore.inspect(begun.reference.dispatchId)).toMatchObject({ reference: begun.reference, snapshotEpoch: input.expectedEpoch, fenceAboveEpoch: input.expectedEpoch, deploymentEpoch: input.expectedEpoch + 1, admissionOpen: false, receipt: null });
    await restore.run(begun.reference);
    expect(await restore.inspect(begun.reference.dispatchId)).toMatchObject({ receipt: { kind: "complete", processed: 0, dispatchIds: [] } });
    expect((await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch).toBe(input.expectedEpoch + 1);
  });
  test("higher live epochs, changed migration facts and any source-epoch permission reject before a new restore bump", async () => {
    const input = await capturedExecutionSnapshotFixture(database), restore = new ExecutionRestoreService({ database, register: async () => {} });
    const before = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    await expect(restore.begin({ ...input, fenceAboveEpoch: input.expectedEpoch + 1 })).rejects.toMatchObject({ code: "restore_snapshot_history_unknown" });
    const proof = { ...input.evidence.proof, migrationSha256: "c".repeat(64) }; proof.identitySha256 = await executionSnapshotIdentityHash(proof);
    const changed = await validateExecutionSnapshotEvidence({ proof, snapshotSha256: proof.snapshotSha256, localMigrationSha256: proof.migrationSha256, worker: SNAPSHOT_TEST_WORKER });
    await expect(restore.begin({ ...input, evidence: changed })).rejects.toMatchObject({ code: "restore_snapshot_proof_invalid" });
    await database.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: before.epoch, generation: 1, kind: "operation_driver", subject: { kind: "maintenance", id: `unknown-tail-${crypto.randomUUID()}` }, inputHash: "a".repeat(64), dueAt: new Date() }));
    await expect(restore.begin(input)).rejects.toMatchObject({ code: "restore_snapshot_history_unknown" });
    expect(await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).toEqual(before);
  });
  test("bounded account recovery reuses billing identity and paid library progress without extending budgets", async () => {
    const user=await database.user.create({data:{clerkId:`restore-accounts-${crypto.randomUUID()}`}});
    const workspace=await database.workspace.create({data:{name:"Restored account",ownerUserId:user.id}});
    const project=await database.project.create({data:{workspaceId:workspace.id,title:"Restored library",sourceMediaUrl:"https://example.test/source",ingestStatus:"ready"}});
    const transcript=await database.transcript.create({data:{projectId:project.id,status:"completed",completedAt:new Date(),utterancesJson:[],durationSeconds:60}});
    const billing=await database.workspaceBillingAccount.create({data:{workspaceId:workspace.id,providerCustomerId:`cus_${crypto.randomUUID()}`,nextReconcileAt:new Date("2026-01-01T00:00:00.000Z"),attemptCount:7}});
    await database.$transaction(async tx=>{await queueBillingReconciliation(tx,workspace.id);await queueLibraryIndex(tx,transcript.id);});
    await database.transcript.update({where:{id:transcript.id},data:{passagesAttempts:2,passagesIndexedFor:null}});
    const original=await database.transcript.findUniqueOrThrow({where:{id:transcript.id}});
    const source=await capturedExecutionSnapshotFixture(database);
    const restore=new ExecutionRestoreService({database,limit:1,register:async()=>{},phases:{...Object.fromEntries(EXECUTION_RESTORE_PHASES.map(phase=>[phase,async()=>({processed:0,next:null})])),billing:restoreBillingPage,library:restoreLibraryPage}});
    const begun=await restore.begin(source);let reference=begun.reference;
    for(let i=0;i<250;i++){const outcome=await restore.run(reference);if(outcome.kind==="complete")break;reference=(await readExecutionDispatch(database,outcome.dispatchIds.at(-1)!))!.reference;}
    const afterBilling=await database.workspaceBillingAccount.findUniqueOrThrow({where:{id:billing.id}}),afterLibrary=await database.transcript.findUniqueOrThrow({where:{id:transcript.id}});
    expect(afterBilling).toMatchObject({providerCustomerId:billing.providerCustomerId,attemptCount:7,nextReconcileAt:billing.nextReconcileAt,reconcileAttemptId:null,leaseExpiresAt:null,reconciliationEpoch:begun.deploymentEpoch});
    expect(afterLibrary).toMatchObject({passagesAttempts:2,passagesSourceHash:original.passagesSourceHash,passagesDeadlineAt:original.passagesDeadlineAt,passagesClaimId:null,passagesLeaseUntil:null,passagesEpoch:begun.deploymentEpoch});
    expect(afterLibrary.passagesGeneration).toBe(original.passagesGeneration+1);
    await database.workspace.delete({where:{id:workspace.id}});
  });

});
