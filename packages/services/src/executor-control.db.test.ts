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
    prisma = new PrismaClient({ adapter: new PrismaPg(pool), transactionOptions: { maxWait: 10_000, timeout: 30_000 } });
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
    async expireExecution(tx, reference) {
      await tx.ingestJob.update({ where: { id: reference.subject.id }, data: { status: "failed" } });
      const wake = await appendExecutionDispatch(tx, { ...reference, subject: reference.subject, kind: "operation_driver", dueAt: new Date(), wakeKind: "execution_finished" });
      dispatches.push(wake.reference.dispatchId);
      return { kind: "expired", dispatchIds: [wake.reference.dispatchId] };
    },
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

  test("a conflicting delivery ID and a changed input hash cannot gain authority", async () => {
    const f = await fixture();
    const control = createExecutorControl({ database: prisma, subjectKind: "ingest_job", domain });
    const command = { action: "acquire" as const, reference: f.reference, attemptToken: f.token, owner: randomUUID(), leaseSeconds: 120 };
    const request = verified();
    await control.execute({ command, verifiedRequest: request });
    await expect(control.execute({ command, verifiedRequest: verified("c".repeat(64), request.metadata.deliveryId) })).rejects.toMatchObject({ code: "replay_conflict" });
    await expect(control.execute({ command: { ...command, reference: { ...f.reference, inputHash: "c".repeat(64) } }, verifiedRequest: verified() })).rejects.toMatchObject({ code: "invalid_reference" });
    expect((await prisma.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).attemptCount).toBe(0);
  }, 30_000);


  test("a watchdog re-reads renewed leases and replays expiry wakes after a lost acknowledgement", async () => {
    const f = await fixture();
    let reject = true;
    const delivered: string[][] = [];
    const control = createExecutorControl({ database: prisma, subjectKind: "ingest_job", domain, deliverWakes: async ids => {
      delivered.push([...ids]);
      if (reject) throw new Error("scheduler_unavailable");
    } });
    const owner = randomUUID();
    await control.execute({ command: { action: "acquire", reference: f.reference, attemptToken: f.token, owner, leaseSeconds: 120 }, verifiedRequest: verified() });
    const deliveryId = randomUUID(); receipts.push(deliveryId);
    const deadline = { reference: f.reference, attemptToken: f.token, kind: "lease", observedDeadlineAt: new Date(Date.now() - 1000).toISOString() };
    const before = await control.expireDeadline({ deadline, deliveryId });
    expect(before.kind).toBe("sleep");
    expect((await prisma.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).status).toBe("running");
    await prisma.executionAttempt.update({ where: { attemptToken: f.token }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    await expect(control.expireDeadline({ deadline, deliveryId })).rejects.toThrow("scheduler_unavailable");
    expect((await prisma.executionAttempt.findUniqueOrThrow({ where: { attemptToken: f.token } })).status).toBe("expired");
    reject = false;
    expect((await control.expireDeadline({ deadline, deliveryId })).kind).toBe("expired");
    expect(delivered[1]).toEqual(delivered[0]);
    expect((await prisma.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).attemptCount).toBe(0);
  }, 45_000);

  test("an expired owner cannot renew or record a process start", async () => {
    const f = await fixture();
    const control = createExecutorControl({ database: prisma, subjectKind: "ingest_job", domain });
    const owner = randomUUID(), fence = { reference: f.reference, attemptToken: f.token, owner };
    await control.execute({ command: { action: "acquire", reference: f.reference, attemptToken: f.token, owner, leaseSeconds: 120 }, verifiedRequest: verified() });
    await prisma.executionAttempt.update({ where: { attemptToken: f.token }, data: { leaseExpiresAt: new Date(Date.now() - 1_000) } });
    expect(await control.execute({ command: { action: "renew", fence, leaseSeconds: 120 }, verifiedRequest: verified() })).toEqual({ disposition: "expired" });
    expect(await control.execute({ command: { action: "process-start", fence }, verifiedRequest: verified() })).toEqual({ disposition: "expired" });
    expect((await prisma.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).attemptCount).toBe(0);
  }, 30_000);

  test("a failed transaction rolls back both process charging and the inbox receipt", async () => {
    const f = await fixture();
    const owner = randomUUID(), fence = { reference: f.reference, attemptToken: f.token, owner };
    const control = createExecutorControl({ database: prisma, subjectKind: "ingest_job", domain });
    await control.execute({ command: { action: "acquire", reference: f.reference, attemptToken: f.token, owner, leaseSeconds: 120 }, verifiedRequest: verified() });
    const failing = createExecutorControl({ database: prisma, subjectKind: "ingest_job", domain: { ...domain,
      async startExecution(tx, ref, c) { await domain.startExecution(tx, ref, c); throw new Error("injected_before_commit"); },
    } });
    const request = verified(), command = { action: "process-start" as const, fence };
    await expect(failing.execute({ command, verifiedRequest: request })).rejects.toThrow("injected_before_commit");
    expect((await prisma.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).attemptCount).toBe(0);
    expect(await prisma.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience: "executor-control", deliveryId: request.metadata.deliveryId } } })).toBeNull();
    expect(await control.execute({ command, verifiedRequest: request })).toEqual({ disposition: "started" });
    expect((await prisma.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).attemptCount).toBe(1);
  }, 30_000);

  test("a lost wake acknowledgement replays committed ownership and the same wake", async () => {
    const f = await fixture();
    const request = verified(), owner = randomUUID();
    let acquisitions = 0, deliveries = 0;
    const control = createExecutorControl({ database: prisma, subjectKind: "ingest_job", domain: { ...domain,
      async acquireExecution(tx, ref, c) {
        acquisitions++;
        await domain.acquireExecution(tx, ref, c);
        const wake = await appendExecutionDispatch(tx, { deploymentEpoch: c.reference.deploymentEpoch,
          generation: c.reference.generation, kind: "operation_driver", subject: c.reference.subject,
          inputHash: c.reference.inputHash, dueAt: c.now, wakeKind: "execution_acquired",
          deadlineKind: "lease", observedDeadlineAt: c.leaseExpiresAt });
        dispatches.push(wake.reference.dispatchId);
        return { dispatchIds: [wake.reference.dispatchId] };
      },
    }, async deliverWakes(ids) {
      deliveries++;
      const receipt = await prisma.executionInboxReceipt.findUniqueOrThrow({ where: { audience_deliveryId: {
        audience: "executor-control", deliveryId: request.metadata.deliveryId,
      } } });
      expect(receipt.wakeDispatchIds).toEqual([...ids]);
      expect((await prisma.executionAttempt.findUniqueOrThrow({ where: { attemptToken: f.token } })).owner).toBe(owner);
      if (deliveries === 1) throw new Error("injected_lost_scheduler_ack");
    } });
    const input = { command: { action: "acquire", reference: f.reference, attemptToken: f.token, owner, leaseSeconds: 120 }, verifiedRequest: request };
    await expect(control.execute(input)).rejects.toThrow("injected_lost_scheduler_ack");
    expect((await control.execute(input)).disposition).toBe("acquired");
    expect(acquisitions).toBe(1);
    expect(deliveries).toBe(2);
  }, 30_000);
});
