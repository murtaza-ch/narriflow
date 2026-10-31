import { expect, test } from "bun:test";
import { executionSnapshotIdentityHash, executionSnapshotQuiescenceHash, validateExecutionSnapshotEvidence, readFencedWorker } from "./execution-snapshot";

const worker = { origin: "https://api.narriflow.test", version: "fenced-version-1", admissionState: "fenced" as const };
async function proof() {
  const quiescence = { stoppedAt: "2026-10-31T10:00:00.000Z", writesDrainedAt: "2026-10-31T10:00:31.000Z", capturedAt: "2026-10-31T10:00:40.000Z", verifiedAt: "2026-10-31T10:01:00.000Z", evidenceSha256: "e".repeat(64),
    consumers: { httpIngress: "fenced" as const, cron: "stopped" as const, cleanup: "stopped" as const, nativeDispatch: "deferred" as const, localDispatch: "deferred" as const, legacyWorkers: "stopped" as const } };
  const value = { version: 1 as const, sourceEpoch: 7, fencedAt: "2026-10-31T10:00:00.000Z", schema: "public", accountId: "5359f28d385b8632c3abee12d1f5b011", worker, migrationSha256: "a".repeat(64), snapshotSha256: "b".repeat(64), quiescence,
    identitySha256: "", quiescenceSha256: "" };
  value.identitySha256 = await executionSnapshotIdentityHash(value);
  value.quiescenceSha256 = await executionSnapshotQuiescenceHash(quiescence);
  return value;
}
test("snapshot proof binds the exact fence, migration, bytes and explicit quiescence evidence", async () => {
  const value = await proof();
  expect(await validateExecutionSnapshotEvidence({ proof: value, snapshotSha256: value.snapshotSha256, localMigrationSha256: value.migrationSha256, worker })).toMatchObject({ proof: value });
  for (const changed of [{ ...value, snapshotSha256: "c".repeat(64) }, { ...value, identitySha256: "0".repeat(64) }, { ...value, quiescence: { ...value.quiescence, evidenceSha256: "f".repeat(64) } }, { ...value, quiescence: { ...value.quiescence, consumers: { ...value.quiescence.consumers, cleanup: "running" } } }, { ...value, quiescence: { ...value.quiescence, writesDrainedAt: "2026-10-31T09:59:59.000Z" } }]) {
    await expect(validateExecutionSnapshotEvidence({ proof: changed, snapshotSha256: value.snapshotSha256, localMigrationSha256: value.migrationSha256, worker })).rejects.toMatchObject({ code: "restore_snapshot_proof_invalid" });
  }
  await expect(validateExecutionSnapshotEvidence({ proof: value, snapshotSha256: value.snapshotSha256, localMigrationSha256: value.migrationSha256, worker: { ...worker, version: "unwitnessed-version" } })).rejects.toMatchObject({ code: "restore_snapshot_proof_invalid" });
});
test("the fresh Worker proof uses explicit origin, no redirects, bounded metadata and fenced/version checks", async () => {
  const observed = await readFencedWorker("https://api.narriflow.test", { fetch: async (url, options) => {
    expect(String(url)).toBe("https://api.narriflow.test/api/health"); expect(options?.redirect).toBe("error"); expect(options?.cache).toBe("no-store");
    return Response.json({ ok: true, service: "narriflow-api", version: worker.version, admissionState: "fenced" }, { headers: { "cache-control": "no-store" } });
  } });
  expect(observed).toEqual(worker);
  for (const state of ["open", "closed"]) await expect(readFencedWorker(worker.origin, { fetch: async () => Response.json({ ok: true, service: "narriflow-api", version: worker.version, admissionState: state }, { headers: { "cache-control": "no-store" } }) })).rejects.toMatchObject({ code: "restore_worker_not_fenced" });
  await expect(readFencedWorker(`${worker.origin}/wrong`, { fetch: async () => { throw new Error("Must not fetch"); } })).rejects.toMatchObject({ code: "restore_snapshot_proof_invalid" });
});
