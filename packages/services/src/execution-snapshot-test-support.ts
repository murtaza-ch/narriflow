import type { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { fenceExecutionSnapshot, attestQuiescedExecutionSnapshot, readExecutionSnapshotMigrationHash, validateExecutionSnapshotEvidence } from "./execution-snapshot";

export const SNAPSHOT_TEST_WORKER = { origin: "https://api.narriflow.test", version: "fenced-version-1", admissionState: "fenced" as const };
/** Controlled platform/file observations, real database fence/migration proof.
 * No production path skips proof validation or accepts an epoch-only begin. */
export async function capturedExecutionSnapshotFixture(database: PrismaClient) {
  const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
  assertExecutionDatabaseTestTarget(process.env.SERVERLESS_TEST_DATABASE_URL, schema);
  const [bound] = await database.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`;
  if (bound?.schema !== schema) throw new Error("Wrong snapshot fixture schema");
  const before = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
  const fence = await fenceExecutionSnapshot(database, { expectedEpoch: before.epoch, worker: SNAPSHOT_TEST_WORKER });
  const now = (await database.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`)[0]!.now.toISOString();
  const localMigrationSha256 = await database.$transaction(tx => readExecutionSnapshotMigrationHash(tx));
  const snapshotSha256 = "b".repeat(64);
  const proof = await attestQuiescedExecutionSnapshot(database, { snapshotSha256, localMigrationSha256, worker: SNAPSHOT_TEST_WORKER,
    quiescence: { stoppedAt: fence.fencedAt, writesDrainedAt: now, capturedAt: now, verifiedAt: now, evidenceSha256: "e".repeat(64),
      consumers: { httpIngress: "fenced", cron: "stopped", cleanup: "stopped", nativeDispatch: "deferred", localDispatch: "deferred", legacyWorkers: "stopped" } } });
  const evidence = await validateExecutionSnapshotEvidence({ proof, snapshotSha256, localMigrationSha256, worker: SNAPSHOT_TEST_WORKER });
  return { evidence, expectedEpoch: fence.sourceEpoch, fenceAboveEpoch: fence.sourceEpoch };
}
