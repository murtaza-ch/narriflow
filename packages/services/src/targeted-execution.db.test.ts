import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import type { ExecutorMutationContext } from "./executor-domain-control";
import { createExecutorControl } from "./executor-control";
import type { ExecutionCommand } from "@narriflow/validators/execution";
import { RenderGroupLifecycle, type RenderGroupExecutionReference } from "./render-group-lifecycle";
import { renderGroupExportIdentity } from "./render-group-contract";
import { withServiceEnvironment } from "./runtime-environment";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const dbDescribe = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;

dbDescribe("Targeted serverless domain execution", () => {
  let db: PrismaClient;
  let epoch: number;
  const users: string[] = [], dispatches: string[] = [], subjects: string[] = [], receipts: string[] = [];
  beforeAll(async () => {
    assertExecutionDatabaseTestTarget(url, process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public");
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    if (schema !== "public" && !/^serverless_execution_test_[a-z0-9]+$/.test(schema)) throw new Error("Only disposable execution schemas are allowed");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }), transactionOptions: { timeout: 60_000, maxWait: 30_000 } });
    const [actual] = await db.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS "schema"`;
    if (actual?.schema !== schema) throw new Error("Wrong execution schema");
    epoch = (await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
  }, 60_000);
  afterEach(async () => {
    subjects.push(...(await db.workflowEvent.findMany({ where: { project: { workspace: { ownerUserId: { in: users } } } }, select: { id: true } })).map(row => row.id));
    subjects.push(...(await db.workspaceEvent.findMany({ where: { workspace: { ownerUserId: { in: users } } }, select: { id: true } })).map(row => row.id));
    await db.executionInboxReceipt.deleteMany({ where: { deliveryId: { in: receipts } } });
    await db.executionArtifact.deleteMany({ where: { attempt: { dispatchId: { in: dispatches } } } });
    await db.executionAttempt.deleteMany({ where: { dispatchId: { in: dispatches } } });
    await db.executionDispatch.deleteMany({ where: { OR: [{ id: { in: dispatches } }, { subjectId: { in: subjects } }] } });
    await db.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    users.length = dispatches.length = subjects.length = receipts.length = 0;
  }, 60_000);
  afterAll(async () => { await db?.$disconnect(); });

  async function fixture() {
    const user = await db.user.create({ data: { clerkId: `targeted-execution:${crypto.randomUUID()}` } });
    users.push(user.id);
    const workspace = await db.workspace.create({ data: { name: "Targeted execution gate", ownerUserId: user.id } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Targeted execution gate", sourceMediaUrl: "r2://gate/source", sourceStorageKey: "gate/source", ingestStatus: "ready" } });
    const workSetGeneration = crypto.randomUUID();
    const run = await db.workflowRun.create({ data: { projectId: project.id, stage: "clip_rendering", status: "queued", idempotencyKey: crypto.randomUUID(), renderWorkSetGeneration: workSetGeneration, renderWorkSetFrozenAt: new Date(), requestedCount: 1, deploymentEpoch: epoch } });
    const clip = await db.clip.create({ data: { projectId: project.id, workflowRunId: run.id, index: 0, startSec: 0, endSec: 10, hookText: "gate", reasoning: "gate", category: "hook", transcriptSlice: [], viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50, durationOptimalityScore: 50, tiktokScore: 50, youtubeScore: 50, instagramScore: 50, llmProvider: "gate", llmModel: "gate", editorRevision: 1 } });
    const variant = await db.clipRender.create({ data: { clipId: clip.id, workflowRunId: run.id, aspectRatio: "ratio_9_16", resolution: "1080p", editorRevision: 1 } });
    const group = await db.renderGroup.create({ data: { workflowRunId: run.id, workSetGeneration, clipId: clip.id, exportIdentity: renderGroupExportIdentity({ clipId: clip.id, exportId: null, editorRevision: 1, resolution: "1080p", watermark: true }), deploymentEpoch: epoch, members: { create: { clipRenderId: variant.id } } } });
    subjects.push(group.id, run.id);
    const record = await db.$transaction((tx) => appendExecutionDispatch(tx, { deploymentEpoch: epoch, kind: "modal_execution", subject: { kind: "render_group", id: group.id }, generation: 1, inputHash: "a".repeat(64), dueAt: new Date("2026-10-31T00:00:00.000Z") }));
    dispatches.push(record.reference.dispatchId);
    const attemptToken = crypto.randomUUID(), owner = crypto.randomUUID();
    const [clock] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
    const deadline = new Date(clock!.now.getTime() + 10 * 60_000);
    await db.executionAttempt.create({ data: { attemptToken, dispatchId: record.reference.dispatchId, deploymentEpoch: epoch, generation: 1, inputHash: record.reference.inputHash, functionName: "render_group", operationDeadlineAt: deadline } });
    const lifecycle = new RenderGroupLifecycle({ prisma: db, releaseGraceMs: 0 });
    return { lifecycle, reference: record.reference, attemptToken, owner, deadline, group, variant, run };
  }

  async function mutate<T>(value: Awaited<ReturnType<typeof fixture>>, action: (tx: Prisma.TransactionClient, ref: RenderGroupExecutionReference, context: ExecutorMutationContext) => Promise<T>) {
    return withServiceEnvironment({}, () => db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id" = 1 FOR SHARE`;
      const locked = await value.lifecycle.lockExecution(tx, value.reference, value.attemptToken);
      if (locked.kind !== "current") throw new Error("Expected current domain authority");
      await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken" = ${value.attemptToken}::uuid FOR UPDATE`;
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
      const context: ExecutorMutationContext = { reference: value.reference, attemptToken: value.attemptToken, owner: value.owner, now: clock!.now, leaseExpiresAt: new Date(clock!.now.getTime() + 120_000), operationDeadlineAt: value.deadline, functionName: "render_group", fingerprints: { source: "gate-source#1", analysis: null, toolchain: "gate-toolchain" } };
      return action(tx, locked.ref, context);
    }));
  }

  function verified() {
    const deliveryId = crypto.randomUUID(); receipts.push(deliveryId);
    return { requestHash: crypto.randomUUID().replaceAll("-", "").repeat(2), metadata: { version: 1 as const, keyId: "gate-key", audience: "executor-control" as const,
      method: "POST" as const, canonicalTarget: "/api/execution/command", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId, signature: "0".repeat(64) } };
  }
  function control(value: Awaited<ReturnType<typeof fixture>>) {
    const wakes: string[] = [];
    const api = createExecutorControl({ database: db, subjectKind: "render_group", domain: value.lifecycle,
      prepareContext: async () => ({ source: "gate-source#1", analysis: null, toolchain: "gate-toolchain" }),
      deliverWakes: async (ids) => { wakes.push(...ids); },
      artifacts: { head: async (assignment) => ({ etag: '"gate-etag"', contentType: assignment.contentType, byteLength: 1024n, sha256: "a".repeat(64) }),
        prepare: async (_assignment, artifact) => ({ ...artifact, role: "render_variant" as const, renderId: value.variant.id, durationSec: 10 }) },
    });
    return { api, wakes, send: (command: ExecutionCommand, receipt = verified()) => withServiceEnvironment({}, () => api.execute({ command, verifiedRequest: receipt })) };
  }
  function acquire(value: Awaited<ReturnType<typeof fixture>>, owner = value.owner): ExecutionCommand {
    return { action: "acquire", reference: value.reference, attemptToken: value.attemptToken, owner, leaseSeconds: 120 };
  }
  function fence(value: Awaited<ReturnType<typeof fixture>>) { return { reference: value.reference, attemptToken: value.attemptToken, owner: value.owner }; }

  test("a render parent freezes and settles without ever acquiring a coordinator lease", async () => {
    const value = await fixture();
    await db.renderGroup.delete({ where: { id: value.group.id } });
    await db.workflowRun.update({ where: { id: value.run.id }, data: { renderWorkSetGeneration: null, renderWorkSetFrozenAt: null, requestedCount: null } });
    await db.clipRender.update({ where: { id: value.variant.id }, data: { workflowRunId: null } });
    const lifecycle = withServiceEnvironment({}, () => new WorkflowRunLifecycle({ prisma: db }));
    const reference = (await db.$transaction(tx => lifecycle.dispatchRunWithinTransaction(tx, value.run.id))).reference;
    const groups = [{ configuration: { clipId: value.group.clipId, exportId: null, editorRevision: 1, resolution: "1080p", watermark: true }, variantIds: [value.variant.id] }];
    expect((await withServiceEnvironment({}, () => lifecycle.prepareRenderRun({ ...reference, generation: reference.generation + 1 }, groups))).kind).toBe("superseded");
    const prepared = await withServiceEnvironment({}, () => lifecycle.prepareRenderRun(reference, groups));
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error("Expected a prepared Render Work Set");
    subjects.push(...prepared.groups.map(group => group.groupId));
    const parent = await db.workflowRun.findUniqueOrThrow({ where: { id: value.run.id } });
    expect(parent).toMatchObject({ status: "waiting", attemptId: null, leaseOwner: null, leaseExpiresAt: null, attemptCount: 0, requestedCount: 1 });
    expect(parent.renderWorkSetGeneration).not.toBeNull();
    expect((await withServiceEnvironment({}, () => lifecycle.prepareRenderRun(reference, groups))).dispatchIds).toEqual(prepared.dispatchIds);
    await expect(withServiceEnvironment({}, () => lifecycle.prepareRenderRun(reference, [{ ...groups[0]!, configuration: { ...groups[0]!.configuration, watermark: false } }]))).rejects.toThrow("immutable");
    const pending = await withServiceEnvironment({}, () => lifecycle.settleRenderRun(reference));
    expect(pending.kind === "settled" ? pending.outcome.status : pending.kind).toBe("pending");
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: value.run.id } })).toMatchObject({ status: "waiting", leaseOwner: null, attemptId: null, attemptCount: 0 });
    const group = await db.renderGroup.findUniqueOrThrow({ where: { id: prepared.groups[0]!.groupId } });
    const driver = (await readExecutionDispatch(db, prepared.dispatchIds[0]!))!;
    const modal = await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, kind: "modal_execution", subject: { kind: "render_group", id: group.id },
      generation: group.generation, inputHash: driver.reference.inputHash, dueAt: driver.dueAt }));
    dispatches.push(modal.reference.dispatchId);
    const attemptToken = crypto.randomUUID(), owner = crypto.randomUUID(), deadline = new Date(Date.now() + 10 * 60_000);
    await db.executionAttempt.create({ data: { attemptToken, dispatchId: modal.reference.dispatchId, deploymentEpoch: epoch, generation: group.generation,
      inputHash: modal.reference.inputHash, functionName: "render_group", operationDeadlineAt: deadline } });
    const child = { ...value, group, reference: modal.reference, attemptToken, owner, deadline };
    const server = control(child);
    expect((await server.send(acquire(child))).disposition).toBe("acquired");
    await server.send({ action: "process-start", fence: fence(child) });
    const live = await withServiceEnvironment({}, () => lifecycle.settleRenderRun(reference));
    expect(live.kind === "settled" ? live.outcome.status : live.kind).toBe("pending");
    const artifact = await db.executionArtifact.create({ data: { attemptToken, owner, role: "render_variant", bindingHash: "b".repeat(64),
      storageKey: `execution/${epoch}/${attemptToken}/${owner}/variant.mp4`, contentType: "video/mp4", maxBytes: 4096n, grantExpiresAt: new Date(Date.now() + 60_000) } });
    await server.send({ action: "commit-artifact", fence: fence(child), artifact: { artifactId: artifact.id, role: "render_variant", contentType: "video/mp4",
      byteLength: 1024, etag: '"gate-etag"', sha256: "a".repeat(64), bindingHash: artifact.bindingHash } });
    const wake = await db.executionDispatch.findFirstOrThrow({ where: { subjectKind: "render_group", subjectId: group.id, kind: "render_run", wakeKind: "group_outcome" } });
    const wakeReference = (await readExecutionDispatch(db, wake.id))!.reference;
    const completed = await withServiceEnvironment({}, () => lifecycle.settleRenderRun(wakeReference));
    expect(completed.kind === "settled" ? completed.outcome : completed).toMatchObject({ status: "completed", requested: 1, succeeded: 1, failed: 0 });
    const replay = await withServiceEnvironment({}, () => lifecycle.settleRenderRun(reference));
    expect(replay).toEqual(completed);
    expect(await db.workflowEvent.count({ where: { workflowRunId: value.run.id, notificationRequired: true } })).toBe(1);
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: value.run.id } })).toMatchObject({ attemptId: null, attemptCount: 0, leaseOwner: null });
  }, 180_000);

  test("audio readiness cannot acquire rendering before verified video is ready", async () => {
    const value = await fixture();
    await db.project.update({ where: { id: value.run.projectId }, data: { ingestStatus: "downloading", sourceStorageKey: null } });
    const server = control(value);
    await expect(server.send(acquire(value))).rejects.toThrow();
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ status: "queued", attemptToken: null, chargedAttemptCount: 0 });
    expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: value.attemptToken } })).toMatchObject({ status: "admitted", owner: null });
    await db.project.update({ where: { id: value.run.projectId }, data: { ingestStatus: "ready", sourceStorageKey: "gate/source" } });
    expect((await server.send(acquire(value))).disposition).toBe("acquired");
  }, 90_000);

  test("a pre-start release creates no charged render attempt and admits one new generation", async () => {
    const value = await fixture();
    await mutate(value, (tx, ref, context) => value.lifecycle.acquireExecution(tx, ref, context));
    await mutate(value, (tx, ref, context) => value.lifecycle.releaseExecution(tx, ref, context, { reason: "startup_rejected" }));
    const group = await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } });
    expect(group).toMatchObject({ status: "queued", chargedAttemptCount: 0, generation: 2, attemptToken: null });
    const ledger = await db.renderGroupExecution.findUniqueOrThrow({ where: { token: value.attemptToken } });
    expect(ledger).toMatchObject({ charged: false, startedAt: null, result: "released" });
  }, 60_000);

  test("real executor owner acquisition races once and process-start replay charges once without a parent lease", async () => {
    const value = await fixture();
    const server = control(value);
    const other = crypto.randomUUID();
    const results = await Promise.all([server.send(acquire(value)), server.send(acquire(value, other))]);
    expect(results.map((result) => result.disposition).sort()).toEqual(["acquired", "busy"]);
    if (results[1]!.disposition === "acquired") value.owner = other;
    const receipt = verified();
    const command = { action: "process-start" as const, fence: fence(value) };
    expect(await server.send(command, receipt)).toEqual({ disposition: "started" });
    expect(await server.send(command, receipt)).toEqual({ disposition: "started" });
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ chargedAttemptCount: 1, generation: 1 });
    expect(await db.renderGroupExecution.findUniqueOrThrow({ where: { token: value.attemptToken } })).toMatchObject({ charged: true });
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: value.run.id } })).toMatchObject({ status: "queued", attemptId: null, leaseOwner: null, leaseExpiresAt: null, attemptCount: 0 });
    const wake = await db.executionDispatch.findFirstOrThrow({ where: { subjectId: value.group.id, wakeKind: "execution_acquired" } });
    expect(wake).toMatchObject({ deadlineKind: "lease", generation: 1 });
    expect(wake.observedDeadlineAt).not.toBeNull();
  }, 90_000);

  test("renewal adds no timer and an old watchdog observes the new live lease", async () => {
    const value = await fixture();
    const server = control(value);
    await server.send(acquire(value));
    await server.send({ action: "process-start", fence: fence(value) });
    const before = await db.executionDispatch.count({ where: { subjectId: value.group.id } });
    const result = await server.send({ action: "renew", fence: fence(value), leaseSeconds: 120 });
    expect(result.disposition).toBe("renewed");
    expect(await db.executionDispatch.count({ where: { subjectId: value.group.id } })).toBe(before);
    const observed = await mutate(value, (tx) => value.lifecycle.expireExecution(tx, value.reference, value.attemptToken, { kind: "lease", observedDeadlineAt: new Date(0) }));
    expect(observed.kind).toBe("sleep");
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ status: "running", chargedAttemptCount: 1 });
  }, 90_000);

  test("the final validated artifact commits child outcome and parent wake together, leaving parent settlement unleased", async () => {
    const value = await fixture();
    const server = control(value);
    await server.send(acquire(value));
    await server.send({ action: "process-start", fence: fence(value) });
    const assignment = await db.executionArtifact.create({ data: { attemptToken: value.attemptToken, owner: value.owner, role: "render_variant", bindingHash: "b".repeat(64),
      storageKey: `execution/${epoch}/${value.attemptToken}/${value.owner}/variant.mp4`, contentType: "video/mp4", maxBytes: 4096n, grantExpiresAt: value.deadline } });
    const result = await server.send({ action: "commit-artifact", fence: fence(value), artifact: { artifactId: assignment.id, role: "render_variant", contentType: "video/mp4",
      byteLength: 1024, sha256: "a".repeat(64), etag: '"gate-etag"', bindingHash: assignment.bindingHash } });
    expect(result).toEqual({ disposition: "committed", artifactId: assignment.id });
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ status: "completed", chargedAttemptCount: 1, attemptToken: null });
    expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: value.attemptToken } })).toMatchObject({ status: "completed" });
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: value.run.id } })).toMatchObject({ status: "queued", leaseOwner: null, leaseExpiresAt: null });
    expect(await db.executionDispatch.findFirst({ where: { subjectId: value.group.id, kind: "render_run", wakeKind: "group_outcome" } })).not.toBeNull();
    expect(await db.executionDispatch.findFirst({ where: { subjectId: value.group.id, kind: "operation_driver", wakeKind: "execution_finished" } })).not.toBeNull();
  }, 90_000);

  test("an unacquired operation deadline settles failed without a fabricated render execution or charge", async () => {
    const value = await fixture();
    const expired = new Date(0);
    await db.executionAttempt.update({ where: { attemptToken: value.attemptToken }, data: { createdAt: new Date(-60_000), operationDeadlineAt: expired } });
    const result = await mutate(value, (tx) => value.lifecycle.expireExecution(tx, value.reference, value.attemptToken, { kind: "operation", observedDeadlineAt: expired }));
    expect(result.kind).toBe("expired");
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ status: "failed", chargedAttemptCount: 0 });
    expect(await db.renderGroupExecution.findUnique({ where: { token: value.attemptToken } })).toBeNull();
    expect(await db.clipRender.findUniqueOrThrow({ where: { id: value.variant.id } })).toMatchObject({ status: "failed", errorCode: "operation_deadline_exceeded" });
  }, 90_000);

});
