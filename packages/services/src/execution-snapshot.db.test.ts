import { IngestJobLifecycle } from "./ingest-job-lifecycle";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { ProcessingUsage } from "./processing-usage";
import { ingestExecutionInputHash } from "./ingest-source-execution";
import { startIngestTestExecution } from "./ingest-execution-test-support";
import { createSourceVideoValidator } from "./source-readiness";
import { restoreIngestJobsPage } from "./execution-source-recovery-pages";
import { capturedExecutionSnapshotFixture } from "./execution-snapshot-test-support";
import { withExecutionDispatches } from "./execution-dispatch-runtime";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { ExecutionRestoreService } from "./execution-restore";
import { appendExecutionDispatch } from "./execution-dispatch";
import { fenceExecutionSnapshot, attestQuiescedExecutionSnapshot, readExecutionSnapshotMigrationHash, validateExecutionSnapshotEvidence } from "./execution-snapshot";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
const worker = { origin: "https://api.narriflow.test", version: "fenced-version-1", admissionState: "fenced" as const };
suite("Fenced snapshot source proof", () => {
  let database: PrismaClient;
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url, schema);
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }), transactionOptions: { maxWait: 10_000, timeout: 30_000 } });
  });
  afterAll(async () => { await database?.$disconnect(); });
  test("fencing closes and advances once without creating work permission, and capture binds the actual migration/fence facts", async () => {
    const original = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    const fenced = await fenceExecutionSnapshot(database, { expectedEpoch: original.epoch, worker });
    expect(fenced).toMatchObject({ sourceEpoch: original.epoch + 1, admissionOpen: false });
    expect(await fenceExecutionSnapshot(database, { expectedEpoch: original.epoch, worker })).toEqual(fenced);
    const migrationSha256 = await database.$transaction(tx => readExecutionSnapshotMigrationHash(tx));
    const now = new Date().toISOString(), quiescence = { stoppedAt: fenced.fencedAt, writesDrainedAt: now, capturedAt: now, verifiedAt: now, evidenceSha256: "e".repeat(64), consumers: { httpIngress: "fenced" as const, cron: "stopped" as const, cleanup: "stopped" as const, nativeDispatch: "deferred" as const, localDispatch: "deferred" as const, legacyWorkers: "stopped" as const } };
    const proof = await attestQuiescedExecutionSnapshot(database, { snapshotSha256: "b".repeat(64), localMigrationSha256: migrationSha256, worker, quiescence });
    expect(proof).toMatchObject({ sourceEpoch: fenced.sourceEpoch, fencedAt: fenced.fencedAt, migrationSha256, snapshotSha256: "b".repeat(64) });
    expect(await validateExecutionSnapshotEvidence({ proof, snapshotSha256: proof.snapshotSha256, localMigrationSha256: migrationSha256, worker })).toMatchObject({ proof });
    expect(await database.executionDispatch.count({ where: { deploymentEpoch: fenced.sourceEpoch } })).toBe(0);
    await database.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: fenced.sourceEpoch, generation: 1, kind: "operation_driver", subject: { kind: "maintenance", id: `post-fence-${crypto.randomUUID()}` }, inputHash: "a".repeat(64), dueAt: new Date() }));
    await expect(attestQuiescedExecutionSnapshot(database, { snapshotSha256: "b".repeat(64), localMigrationSha256: migrationSha256, worker, quiescence })).rejects.toMatchObject({ code: "restore_snapshot_history_unknown" });
    await expect(fenceExecutionSnapshot(database, { expectedEpoch: original.epoch, worker })).rejects.toMatchObject({ code: "restore_snapshot_history_unknown" });
  });
  test("an epoch-only begin cannot change authority without the validated quiesced snapshot proof", async () => {
    const before = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    const restore = new ExecutionRestoreService({ database, register: async () => {} });
    await expect(restore.begin({ expectedEpoch: before.epoch, fenceAboveEpoch: before.epoch } as never)).rejects.toMatchObject({ code: "restore_snapshot_proof_required" });
    expect(await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).toEqual(before);
  });

  test("fresh source admission and manual/automatic retries retain the current epoch before and after restore", async () => {
    const original = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    const fence = await fenceExecutionSnapshot(database, { expectedEpoch: original.epoch, worker });
    const epoch = fence.sourceEpoch;
    expect(epoch).toBeGreaterThan(1);
    await database.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: true } });
    const user = await database.user.create({ data: { clerkId: `fresh-epoch:${crypto.randomUUID()}` } });
    const workspace = await database.workspace.create({ data: { name: "Fresh epoch admission", ownerUserId: user.id, pricingTier: "business" } });
    const usage = new ProcessingUsage({ prisma: database, log: () => {} }), workflow = new WorkflowRunLifecycle({ prisma: database });
    const lifecycle = new IngestJobLifecycle({ prisma: database, workflow, usage, executionInputHash: job => ingestExecutionInputHash(job, "f".repeat(64)),
      validateVideo: createSourceVideoValidator(usage), requireRetryActor: async (actorId, workspaceId) => { expect(actorId).toBe(user.id); expect(workspaceId).toBe(workspace.id); } });
    const registrations: string[] = [];
    const confirm = { database, deliver: async (ids: readonly string[]) => { registrations.push(...ids); } };
    async function admit() {
      return withExecutionDispatches(() => database.$transaction(async tx => {
        const projectId = crypto.randomUUID();
        await usage.reserve(tx, { projectId, workspaceId: workspace.id, actorUserId: user.id, intakeKind: "upload", declaredSeconds: 60 });
        const project = await tx.project.create({ data: { id: projectId, workspaceId: workspace.id, title: "Current source", sourceType: "upload", sourceMediaUrl: "r2://verified/source.mp4", ingestStatus: "queued" } });
        const job = await lifecycle.enqueue(tx, { projectId, jobType: "upload_finalize", payload: { uploadSessionId: crypto.randomUUID(), storageKey: "verified/source.mp4", verifiedSizeBytes: 42, verifiedContentType: "video/mp4", verifiedEtag: '"source"' }, acquisition: { audioPolicy: "none" } });
        const reference = await lifecycle.queueExecutionWithinTransaction(tx, job.id);
        return { project, job, reference };
      }), confirm);
    }
    try {
      const first = await admit();
      expect(await database.ingestJob.findUniqueOrThrow({ where: { id: first.job.id } })).toMatchObject({ deploymentEpoch: epoch, generation: 1, claimId: null, attemptCount: 0 });
      expect(first.reference).toMatchObject({ deploymentEpoch: epoch, subject: { kind: "ingest_job", id: first.job.id } });
      expect(registrations).toContain(first.reference!.dispatchId);
      const native = await startIngestTestExecution(database, lifecycle, workflow, first.job.id);
      await native.command("fail", { failureCode: "source_media_invalid", retryable: false });
      const retry = await withExecutionDispatches(() => lifecycle.retry({ projectId: first.project.id, workspaceId: workspace.id, actorUserId: user.id }), confirm);
      const manual = await database.ingestJob.findUniqueOrThrow({ where: { id: retry.queuedJobId } });
      expect(manual).toMatchObject({ deploymentEpoch: epoch, status: "queued", attemptCount: 0 });
      const manualDispatch = await database.executionDispatch.findFirstOrThrow({ where: { kind: "import_pipeline", subjectKind: "ingest_job", subjectId: manual.id, deploymentEpoch: epoch } });
      expect(registrations).toContain(manualDispatch.id);
      const next = await startIngestTestExecution(database, lifecycle, workflow, manual.id);
      const before = await database.ingestJob.findUniqueOrThrow({ where: { id: manual.id } });
      await next.command("fail", { failureCode: "remote_download_failed", retryable: true });
      expect(await database.ingestJob.findUniqueOrThrow({ where: { id: manual.id } })).toMatchObject({ deploymentEpoch: epoch, generation: 2, status: "queued", attemptCount: 1, operationDeadlineAt: before.operationDeadlineAt });
      expect(await database.executionDispatch.findFirstOrThrow({ where: { kind: "operation_driver", subjectKind: "ingest_job", subjectId: manual.id, generation: 2, deadlineKind: null, wakeKind: null } })).toMatchObject({ deploymentEpoch: epoch });
      const proof = await capturedExecutionSnapshotFixture(database);
      const begun = await new ExecutionRestoreService({ database, register: async () => {} }).begin(proof);
      const state = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
      await database.$transaction(tx => restoreIngestJobsPage(tx, { deploymentEpoch: begun.deploymentEpoch, snapshotEpoch: proof.expectedEpoch, fenceAboveEpoch: proof.fenceAboveEpoch,
        cutoff: state.changedAt, after: null, limit: 32 }));
      await database.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: true } });
      const afterRestore = await admit();
      expect(await database.ingestJob.findUniqueOrThrow({ where: { id: afterRestore.job.id } })).toMatchObject({ deploymentEpoch: begun.deploymentEpoch, generation: 1, attemptCount: 0 });
      expect(afterRestore.reference).toMatchObject({ deploymentEpoch: begun.deploymentEpoch });
      expect(registrations).toContain(afterRestore.reference!.dispatchId);
    } finally {
      await database.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: false } });
    }
  });

});
