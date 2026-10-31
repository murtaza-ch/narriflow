import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

const databaseUrl = process.env.SERVERLESS_TEST_DATABASE_URL;
const databaseSchema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

dbDescribe("Serverless execution ledger database contract", () => {
  let pool: Pool;
  beforeAll(async () => {
    if (!databaseUrl) throw new Error("SERVERLESS_TEST_DATABASE_URL is required");
    if (!databaseSchema?.startsWith("serverless_execution_test_")) throw new Error("A disposable schema is required");
    const target = new URL(databaseUrl);
    // This named disposable branch is deliberately separate from the shared dev endpoint.
    if (target.hostname.includes("ep-rough-hill-b57kvyah")) {
      throw new Error("Serverless gates cannot run against the shared development endpoint");
    }
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const current = await pool.query('SELECT current_schema() AS "schema"');
    if (current.rows[0]?.schema !== databaseSchema) throw new Error("Wrong disposable schema");
  });
  afterAll(async () => { await pool?.end(); });

  async function isolated<T>(action: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try { await client.query("BEGIN"); return await action(client); }
    finally { await client.query("ROLLBACK"); client.release(); }
  }
  async function dispatch(client: PoolClient) {
    const id = randomUUID();
    await client.query(`INSERT INTO "ExecutionDispatch"
      ("id","kind","subjectKind","subjectId","generation","deploymentEpoch","inputHash","deliveryKey","dueAt","nextDeliveryAt","updatedAt")
      VALUES ($1,'modal_execution','ingest_job',$2,1,1,$3,$4,now(),now(),now())`,
      [id, randomUUID(), "a".repeat(64), `test:${id}`]);
    return id;
  }

  test("a deployment has one positive epoch and starts with admission closed", async () => {
    const result = await pool.query('SELECT "epoch", "admissionOpen" FROM "ExecutionEpoch" WHERE "id" = 1');
    expect(result.rows).toEqual([{ epoch: 1, admissionOpen: false }]);
  });

  test("a second epoch authority cannot be inserted", () => isolated(async (client) => {
    await expect(client.query('INSERT INTO "ExecutionEpoch" ("id") VALUES (2)')).rejects.toMatchObject({ code: "23514" });
  }));

  test("a delivery identity is unique even when delivered twice", () => isolated(async (client) => {
    const id = await dispatch(client);
    await expect(client.query(`INSERT INTO "ExecutionDispatch"
      ("id","kind","subjectKind","subjectId","generation","deploymentEpoch","inputHash","deliveryKey","dueAt","nextDeliveryAt","updatedAt")
      SELECT $1,"kind","subjectKind","subjectId","generation","deploymentEpoch","inputHash","deliveryKey","dueAt","nextDeliveryAt",now()
      FROM "ExecutionDispatch" WHERE "id"=$2`, [randomUUID(), id])).rejects.toMatchObject({ code: "23505" });
  }));

  test("executor admission cannot bind a different generation", () => isolated(async (client) => {
    const id = await dispatch(client);
    await expect(client.query(`INSERT INTO "ExecutionAttempt"
      ("attemptToken","dispatchId","deploymentEpoch","generation","inputHash","functionName","operationDeadlineAt","updatedAt")
      VALUES ($1,$2,1,2,$3,'fetch_source',now()+interval '45 minutes',now())`,
      [randomUUID(), id, "a".repeat(64)])).rejects.toMatchObject({ code: "23503" });
  }));

  test("ownership cannot exist without a lease", () => isolated(async (client) => {
    const id = await dispatch(client);
    await expect(client.query(`INSERT INTO "ExecutionAttempt"
      ("attemptToken","dispatchId","deploymentEpoch","generation","inputHash","functionName","owner","operationDeadlineAt","updatedAt")
      VALUES ($1,$2,1,1,$3,'fetch_source',$4,now()+interval '45 minutes',now())`,
      [randomUUID(), id, "a".repeat(64), randomUUID()])).rejects.toMatchObject({ code: "23514" });
  }));

  test("a frozen object input has a separate immutable byte digest", () => isolated(async client => {
    const id = await dispatch(client), token = randomUUID();
    await client.query(`INSERT INTO "ExecutionAttempt"
      ("attemptToken","dispatchId","deploymentEpoch","generation","inputHash","functionName","operationDeadlineAt","updatedAt",
       "inputStorageKey","inputEtag","inputByteLength","inputChecksumSha256")
      VALUES ($1,$2,1,1,$3,'prepare_clip',now()+interval '45 minutes',now(),'execution-input/test','"object"',1024,$4)`,
      [token, id, "a".repeat(64), "b".repeat(64)]);
    await expect(client.query('UPDATE "ExecutionAttempt" SET "inputChecksumSha256"=$1 WHERE "attemptToken"=$2', ["c".repeat(64), token]))
      .rejects.toMatchObject({ code: "23514" });
  }));

  test("an object input cannot omit the byte digest or exceed its bounded JSON limit", async () => {
    for (const [size, digest] of [[1024, null], [16777217, "b".repeat(64)]] as const) await isolated(async client => {
      const id = await dispatch(client);
      await expect(client.query(`INSERT INTO "ExecutionAttempt"
        ("attemptToken","dispatchId","deploymentEpoch","generation","inputHash","functionName","operationDeadlineAt","updatedAt",
         "inputStorageKey","inputEtag","inputByteLength","inputChecksumSha256")
        VALUES ($1,$2,1,1,$3,'prepare_clip',now()+interval '45 minutes',now(),'execution-input/test','"object"',$4,$5)`,
        [randomUUID(), id, "a".repeat(64), size, digest])).rejects.toMatchObject({ code: "23514" });
    });
  });

  test("a receipt identity cannot silently replace its recorded disposition", () => isolated(async (client) => {
    const id = randomUUID();
    await client.query(`INSERT INTO "ExecutionInboxReceipt"
      ("audience","deliveryId","requestHash","keyId","disposition","expiresAt")
      VALUES ('executor-control',$1,$2,'v1','{"disposition":"started"}',now()+interval '1 day')`, [id, "b".repeat(64)]);
    await expect(client.query(`INSERT INTO "ExecutionInboxReceipt"
      ("audience","deliveryId","requestHash","keyId","disposition","expiresAt")
      VALUES ('executor-control',$1,$2,'v1','{"disposition":"completed"}',now()+interval '1 day')`, [id, "c".repeat(64)])).rejects.toMatchObject({ code: "23505" });
  }));

  async function audioFixture(client: PoolClient) {
    const user = randomUUID(), workspace = randomUUID(), project = randomUUID(), audio = randomUUID();
    await client.query('INSERT INTO "User" ("id","clerkId","updatedAt") VALUES ($1,$2,now())', [user, `execution-gate:${user}`]);
    await client.query('INSERT INTO "Workspace" ("id","name","ownerUserId","updatedAt") VALUES ($1,\'Execution gate\',$2,now())', [workspace, user]);
    await client.query('INSERT INTO "Project" ("id","title","sourceMediaUrl","workspaceId","updatedAt") VALUES ($1,\'Execution gate\',\'r2://gate/source\',$2,now())', [project, workspace]);
    await client.query(`INSERT INTO "SourceAudio" ("id","projectId","sourceRevision","mediaProvider","mediaId","audioTrack","bindingHash","storageKey","etag","byteLength","checksumSha256","durationSeconds","audioStartTimeSec","probeVersion","toolchainFingerprint")
      VALUES ($1,$2,1,'youtube','abcdefghijk','{}',$3,$4,'gate-etag',1024,$3,3600,0,'normalized-probe-v1',$3)`, [audio, project, "a".repeat(64), `gate/${audio}`]);
    return { project, audio };
  }

  test("whole-source audio evidence cannot be rewritten after admission", () => isolated(async (client) => {
    const { audio } = await audioFixture(client);
    await expect(client.query('UPDATE "SourceAudio" SET "durationSeconds"=7200 WHERE "id"=$1', [audio])).rejects.toMatchObject({ code: "23514" });
  }));

  test("a transcript cannot reuse audio from another Project source revision", () => isolated(async (client) => {
    const { project, audio } = await audioFixture(client);
    await expect(client.query('INSERT INTO "Transcript" ("id","projectId","sourceAudioId","sourceRevision","updatedAt") VALUES ($1,$2,$3,2,now())', [randomUUID(), project, audio])).rejects.toMatchObject({ code: "23503" });
  }));
});
