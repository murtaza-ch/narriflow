import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Clip preparation frozen input ledger", () => {
  let client: Client;
  const id = crypto.randomUUID();
  beforeAll(async () => {
    assertExecutionDatabaseTestTarget(url, schema);
    client = new Client({ connectionString: url }); await client.connect();
    if (!/^serverless_execution_test_[a-z0-9]+$/.test(schema)) throw new Error("Disposable schema required");
    await client.query(`SET search_path TO "${schema}"`);
  });
  afterAll(async () => { await client?.query('DELETE FROM "ClipPreparation" WHERE "id"=$1', [id]); await client?.end(); });
  test("sealed input and absolute deadline survive a retry and reject replacement or partial ownership", async () => {
    const epoch = (await client.query('SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1')).rows[0].epoch;
    await client.query(`INSERT INTO "ClipPreparation" ("id","projectId","clipId","sourceRevision","editorRevision","bindingHash","engineHash","inputHash","inputStorageKey","inputEtag","inputByteLength","inputChecksumSha256","deploymentEpoch","operationDeadlineAt","updatedAt")
      VALUES ($1,$2,$3,1,2,$4,$4,$4,'projects/frozen/input.json','"input"',1234,$5,$6,now()+interval '45 minutes',now())`, [id, crypto.randomUUID(), crypto.randomUUID(), "a".repeat(64), "b".repeat(64), epoch]);
    const initial = (await client.query('SELECT * FROM "ClipPreparation" WHERE "id"=$1', [id])).rows[0];
    await client.query('UPDATE "ClipPreparation" SET "generation"=2 WHERE "id"=$1', [id]);
    for (const [column, value] of [["inputEtag", '"replacement"'], ["inputChecksumSha256", "c".repeat(64)], ["bindingHash", "d".repeat(64)], ["operationDeadlineAt", new Date(Date.now() + 3600000)]]) {
      await expect(client.query(`UPDATE "ClipPreparation" SET "${column}"=$2 WHERE "id"=$1`, [id, value])).rejects.toThrow("immutable");
    }
    await expect(client.query('UPDATE "ClipPreparation" SET "status"=\'running\',"executorOwner"=$2 WHERE "id"=$1', [id, crypto.randomUUID()])).rejects.toThrow();
    const current = (await client.query('SELECT * FROM "ClipPreparation" WHERE "id"=$1', [id])).rows[0];
    expect(current).toMatchObject({ generation: 2, status: "queued", inputEtag: initial.inputEtag, inputChecksumSha256: initial.inputChecksumSha256 });
    expect(current.operationDeadlineAt).toEqual(initial.operationDeadlineAt);
  });
});
