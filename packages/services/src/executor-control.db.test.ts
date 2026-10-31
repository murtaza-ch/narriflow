import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { appendExecutionDispatch } from "./execution-dispatch";
import type { ExecutorDomainControl } from "./executor-domain-control";
import { createExecutorControl } from "./executor-control";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const enabled = process.env.ALLOW_EXECUTION_CONTROL_DB_TESTS === "1" && Boolean(url);
const dbDescribe = enabled ? describe : describe.skip;

dbDescribe("Executor control authority and replay", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  const users: string[] = [], dispatches: string[] = [], receipts: string[] = [];
  beforeAll(() => {
    if (!url || new URL(url).hostname !== "ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech") throw new Error("Executor gates require the isolated branch");
    pool = new Pool({ connectionString: url, max: 5 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool), transactionOptions: { timeout: 30_000 } });
  });
  afterAll(async () => {
    await prisma.executionInboxReceipt.deleteMany({ where: { deliveryId: { in: receipts } } });
    await prisma.executionArtifact.deleteMany({ where: { attempt: { dispatchId: { in: dispatches } } } });
    await prisma.executionAttempt.deleteMany({ where: { dispatchId: { in: dispatches } } });
    await prisma.executionDispatch.deleteMany({ where: { id: { in: dispatches } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect(); await pool.end();
  });

  const domain: ExecutorDomainControl<{ id: string }> = {
    async lockExecution(tx, reference) {
      await tx.$queryRaw`SELECT "id" FROM "IngestJob" WHERE "id"=${reference.subject.id}::uuid FOR UPDATE`;
      const job = await tx.ingestJob.findUniqueOrThrow({ where: { id: reference.subject.id } });
      return job.status === "cancelled" ? { kind: "terminal", disposition: { disposition: "cancelled" } }
        : { kind: "current", ref: { id: job.id } };
    },
    async acquireExecution(tx, ref, c) {
      await tx.ingestJob.update({ where: { id: ref.id }, data: { status: "running", claimId: c.attemptToken, executorOwner: c.owner, claimExpiresAt: c.leaseExpiresAt } });
    },
    async renewExecution(tx, ref, c) { await tx.ingestJob.update({ where: { id: ref.id }, data: { claimExpiresAt: c.leaseExpiresAt } }); },
    async startExecution(tx, ref, c) { await tx.ingestJob.update({ where: { id: ref.id }, data: { startedAt: c.now, attemptCount: { increment: 1 } } }); },
    async commitArtifactExecution() { throw new Error("No artifact admitted in this fixture"); },
    async failExecution(tx, ref) { await tx.ingestJob.update({ where: { id: ref.id }, data: { status: "failed" } }); },
    async releaseExecution(tx, ref) { await tx.ingestJob.update({ where: { id: ref.id }, data: { status: "queued" } }); },
    async progressExecution() {},
  };

  async function fixture() {
    const user = await prisma.user.create({ data: { clerkId: `executor-gate:${randomUUID()}` } }); users.push(user.id);
    const workspace = await prisma.workspace.create({ data: { name: "Executor gate", ownerUserId: user.id } });
    const project = await prisma.project.create({ data: { workspaceId: workspace.id, title: "Executor gate", sourceMediaUrl: "r2://gate/source" } });
    const job = await prisma.ingestJob.create({ data: { projectId: project.id, jobType: "upload_finalize", payload: {} } });
    const epoch = await prisma.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    const dispatch = await prisma.$transaction(tx => appendExecutionDispatch(tx, {
      deploymentEpoch: epoch.epoch, generation: 1, kind: "modal_execution", subject: { kind: "ingest_job", id: job.id }, inputHash: "a".repeat(64), dueAt: new Date(),
    }));
    dispatches.push(dispatch.reference.dispatchId);
    const token = randomUUID();
    await prisma.executionAttempt.create({ data: { attemptToken: token, dispatchId: dispatch.reference.dispatchId, deploymentEpoch: epoch.epoch, generation: 1, inputHash: "a".repeat(64), functionName: "fetch_source", operationDeadlineAt: new Date(Date.now() + 45 * 60_000) } });
    return { reference: dispatch.reference, token, job };
  }
  function verified(hash = "b".repeat(64), deliveryId = randomUUID()) {
    receipts.push(deliveryId);
    return { requestHash: hash, metadata: { version: 1 as const, keyId: "test-v1", audience: "executor-control" as const, method: "POST" as const,
      canonicalTarget: "/api/execution/acquire", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId, signature: "0".repeat(64) } };
  }

  test("two invocations acquire one owner and a replayed process start charges once", async () => {
    const f = await fixture();
    const control = createExecutorControl({ database: prisma, subjectKind: "ingest_job", domain });
    const owner = randomUUID(), other = randomUUID();
    const [a, b] = await Promise.all([owner, other].map(invocation => control.execute({
      command: { action: "acquire", reference: f.reference, attemptToken: f.token, owner: invocation, leaseSeconds: 120 }, verifiedRequest: verified(),
    })));
    expect([a.disposition, b.disposition].sort()).toEqual(["acquired", "busy"]);
    const winner = a.disposition === "acquired" ? owner : other;
    const fence = { reference: f.reference, attemptToken: f.token, owner: winner };
    const request = verified();
    const command = { action: "process-start" as const, fence };
    expect(await control.execute({ command, verifiedRequest: request })).toEqual({ disposition: "started" });
    expect(await control.execute({ command, verifiedRequest: request })).toEqual({ disposition: "started" });
    expect((await prisma.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).attemptCount).toBe(1);
  }, 30_000);
});
