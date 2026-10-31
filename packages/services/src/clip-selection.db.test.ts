import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const dbDescribe = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;

dbDescribe("Clip selection durable window invariants", () => {
  let db: PrismaClient;
  const users: string[] = [];
  beforeAll(async () => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    assertExecutionDatabaseTestTarget(url, schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }), transactionOptions: { timeout: 30_000, maxWait: 10_000 } });
    const [actual] = await db.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`;
    if (actual?.schema !== schema) throw new Error("Wrong execution schema");
  });
  afterAll(async () => {
    await db.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });
  async function fixture() {
    const user = await db.user.create({ data: { clerkId: `selection-gate:${crypto.randomUUID()}` } }); users.push(user.id);
    const workspace = await db.workspace.create({ data: { ownerUserId: user.id, name: "Selection gate" } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Selection gate", sourceMediaUrl: "r2://gate/source", ingestStatus: "ready" } });
    const transcript = await db.transcript.create({ data: { projectId: project.id, status: "completed", workflowAttemptId: crypto.randomUUID(), sourceRevision: 1, text: "Frozen transcript" } });
    const epoch = (await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
    const run = await db.workflowRun.create({ data: { projectId: project.id, stage: "moment_detection", status: "waiting", idempotencyKey: crypto.randomUUID(), deploymentEpoch: epoch } });
    function window(workflowRunId = run.id) {
      return { projectId: project.id, workflowRunId, workflowGeneration: 1, deploymentEpoch: epoch, generation: 1,
        transcriptId: transcript.id, transcriptGeneration: 1, transcriptAttemptId: transcript.workflowAttemptId, transcriptContentHash: "a".repeat(64), sourceRevision: 1,
        selectionHash: "b".repeat(64), windowCount: 2, windowIndex: 0, startSec: 0, endSec: 1920, inputHash: "c".repeat(64),
        inputStorageKey: `projects/${project.id}/selection/${workflowRunId}/window-0.json`, inputEtag: '"input"', inputChecksumSha256: "d".repeat(64), inputByteLength: 4096n,
        estimatedTokens: 40_000, operationDeadlineAt: new Date(Date.now() + 600_000) };
    }
    return { project, transcript, run, window, epoch };
  }
  test("different runs over one transcript freeze independent window zero identities", async () => {
    const f = await fixture();
    const other = await db.workflowRun.create({ data: { projectId: f.project.id, stage: "moment_detection", status: "waiting", idempotencyKey: crypto.randomUUID(), deploymentEpoch: f.epoch } });
    const first = await db.clipSelectionWindow.create({ data: f.window() });
    const second = await db.clipSelectionWindow.create({ data: f.window(other.id) });
    expect(first.id).not.toBe(second.id);
    expect(await db.clipSelectionWindow.count({ where: { transcriptId: f.transcript.id, windowIndex: 0 } })).toBe(2);
    await expect(Promise.resolve(db.clipSelectionWindow.create({ data: f.window() }))).rejects.toThrow();
  });
  test("a frozen input or absolute deadline cannot be rewritten while an uncharged child retry can advance its fence", async () => {
    const f = await fixture(), row = await db.clipSelectionWindow.create({ data: f.window() });
    await expect(Promise.resolve(db.clipSelectionWindow.update({ where: { id: row.id }, data: { inputHash: "e".repeat(64) } }))).rejects.toThrow();
    await expect(Promise.resolve(db.clipSelectionWindow.update({ where: { id: row.id }, data: { operationDeadlineAt: new Date(row.operationDeadlineAt.getTime() + 1000) } }))).rejects.toThrow();
    const token = crypto.randomUUID(), owner = crypto.randomUUID();
    await db.clipSelectionWindow.update({ where: { id: row.id }, data: { status: "running", attemptToken: token, executorOwner: owner, leaseExpiresAt: new Date(Date.now() + 120_000) } });
    const retried = await db.clipSelectionWindow.update({ where: { id: row.id }, data: { status: "queued", attemptToken: null, executorOwner: null, leaseExpiresAt: null, generation: 2 } });
    expect(retried).toMatchObject({ workflowGeneration: 1, generation: 2, attemptCount: 0, operationDeadlineAt: row.operationDeadlineAt, inputHash: row.inputHash });
  });
  test("window lineage cannot cross projects and an incomplete result cannot become completed", async () => {
    const f = await fixture(), other = await fixture();
    await expect(Promise.resolve(db.clipSelectionWindow.create({ data: f.window(other.run.id) }))).rejects.toThrow();
    const row = await db.clipSelectionWindow.create({ data: f.window() });
    await expect(Promise.resolve(db.clipSelectionWindow.update({ where: { id: row.id }, data: { status: "completed", completedAt: new Date() } }))).rejects.toThrow();
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("queued");
  });
  test("completed result references remain immutable and the charged budget cannot reset", async () => {
    const f = await fixture(), row = await db.clipSelectionWindow.create({ data: f.window() });
    await db.clipSelectionWindow.update({ where: { id: row.id }, data: { status: "running", attemptToken: crypto.randomUUID(), executorOwner: crypto.randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 120_000), attemptCount: 1 } });
    await expect(Promise.resolve(db.clipSelectionWindow.update({ where: { id: row.id }, data: { attemptCount: 0 } }))).rejects.toThrow();
    await db.clipSelectionWindow.update({ where: { id: row.id }, data: { status: "completed", leaseExpiresAt: null, resultStorageKey: `execution/${f.epoch}/result.json`,
      resultEtag: '"result"', resultHash: "e".repeat(64), resultByteLength: 1024n, tokensUsed: 100, completedAt: new Date() } });
    await expect(Promise.resolve(db.clipSelectionWindow.update({ where: { id: row.id }, data: { resultHash: "f".repeat(64) } }))).rejects.toThrow();
  });
});
