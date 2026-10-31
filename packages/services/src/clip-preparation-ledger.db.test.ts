import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Clip preparation frozen input ledger", () => {
  let client: Client;
  let database: PrismaClient;
  let projectId: string, clipId: string, userId: string, workspaceId: string;
  const id = crypto.randomUUID();
  beforeAll(async () => {
    assertExecutionDatabaseTestTarget(url, schema);
    client = new Client({ connectionString: url }); await client.connect();
    if (!/^serverless_execution_test_[a-z0-9]+$/.test(schema)) throw new Error("Disposable schema required");
    await client.query(`SET search_path TO "${schema}"`);
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }, { schema }) });
    const user = await database.user.create({ data: { clerkId: `preparation-ledger:${crypto.randomUUID()}` } }); userId = user.id;
    const workspace = await database.workspace.create({ data: { name: "Preparation ledger gate", ownerUserId: user.id } }); workspaceId = workspace.id;
    const project = await database.project.create({ data: { workspaceId, title: "Preparation source", sourceMediaUrl: "r2://fixture" } }); projectId = project.id;
    const run = await database.workflowRun.create({ data: { projectId, stage: "moment_detection", status: "queued", idempotencyKey: crypto.randomUUID() } });
    const clip = await database.clip.create({ data: { projectId, workflowRunId: run.id, index: 0, startSec: 0, endSec: 10, hookText: "gate", reasoning: "gate", category: "hook", transcriptSlice: [],
      viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50, durationOptimalityScore: 50, tiktokScore: 50, youtubeScore: 50, instagramScore: 50, llmProvider: "gate", llmModel: "gate" } }); clipId = clip.id;
  });
  afterAll(async () => { await client?.query('DELETE FROM "ClipPreparation" WHERE "id"=$1', [id]); await client?.end();
    if (workspaceId) await database.workspace.delete({ where: { id: workspaceId } });
    if (userId) await database.user.delete({ where: { id: userId } });
    await database?.$disconnect(); });
  test("sealed input and absolute deadline survive a retry and reject replacement or partial ownership", async () => {
    const epoch = (await client.query('SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1')).rows[0].epoch;
    await client.query(`INSERT INTO "ClipPreparation" ("id","projectId","clipId","sourceRevision","editorRevision","bindingHash","engineHash","inputHash","inputStorageKey","inputEtag","inputByteLength","inputChecksumSha256","deploymentEpoch","operationDeadlineAt","updatedAt")
      VALUES ($1,$2,$3,1,2,$4,$4,$4,'projects/frozen/input.json','"input"',1234,$5,$6,now()+interval '45 minutes',now())`, [id, projectId, clipId, "a".repeat(64), "b".repeat(64), epoch]);
    const initial = (await client.query('SELECT * FROM "ClipPreparation" WHERE "id"=$1', [id])).rows[0];
    await client.query('UPDATE "ClipPreparation" SET status=\'running\',"attemptToken"=$2,"executorOwner"=$3,"leaseExpiresAt"=now()+interval \'120 seconds\',"chargedAttempts"=1 WHERE id=$1', [id, crypto.randomUUID(), crypto.randomUUID()]);
    await expect(client.query('UPDATE "ClipPreparation" SET "chargedAttempts"=0 WHERE id=$1', [id])).rejects.toThrow();
    await expect(client.query('UPDATE "ClipPreparation" SET "generation"=4 WHERE id=$1', [id])).rejects.toThrow();
    await client.query('UPDATE "ClipPreparation" SET status=\'queued\',"generation"=2,"attemptToken"=NULL,"executorOwner"=NULL,"leaseExpiresAt"=NULL WHERE "id"=$1', [id]);
    for (const [column, value] of [["inputEtag", '"replacement"'], ["inputChecksumSha256", "c".repeat(64)], ["bindingHash", "d".repeat(64)], ["operationDeadlineAt", new Date(Date.now() + 3600000)]]) {
      await expect(client.query(`UPDATE "ClipPreparation" SET "${column}"=$2 WHERE "id"=$1`, [id, value])).rejects.toThrow("immutable");
    }
    await expect(client.query('UPDATE "ClipPreparation" SET "status"=\'running\',"executorOwner"=$2 WHERE "id"=$1', [id, crypto.randomUUID()])).rejects.toThrow();
    const current = (await client.query('SELECT * FROM "ClipPreparation" WHERE "id"=$1', [id])).rows[0];
    expect(current).toMatchObject({ generation: 2, status: "queued", inputEtag: initial.inputEtag, inputChecksumSha256: initial.inputChecksumSha256 });
    expect(current.operationDeadlineAt).toEqual(initial.operationDeadlineAt);
  });
  test("completed preparation evidence and historical charge cannot be replaced", async () => {
    await client.query('UPDATE "ClipPreparation" SET status=\'running\',"attemptToken"=$2,"executorOwner"=$3,"leaseExpiresAt"=now()+interval \'120 seconds\',"chargedAttempts"=2 WHERE id=$1', [id, crypto.randomUUID(), crypto.randomUUID()]);
    await client.query('UPDATE "ClipPreparation" SET status=\'completed\',"executorOwner"=NULL,"leaseExpiresAt"=NULL,"completedAt"=now(),result=\'{"fixture":true}\'::jsonb WHERE id=$1', [id]);
    await expect(client.query('UPDATE "ClipPreparation" SET result=\'{"replacement":true}\'::jsonb WHERE id=$1', [id])).rejects.toThrow();
    await expect(client.query('UPDATE "ClipPreparation" SET status=\'queued\',"completedAt"=NULL WHERE id=$1', [id])).rejects.toThrow();
    expect((await client.query('SELECT status,"chargedAttempts",result FROM "ClipPreparation" WHERE id=$1', [id])).rows[0]).toEqual({ status: "completed", chargedAttempts: 2, result: { fixture: true } });
  });
});
