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

});
