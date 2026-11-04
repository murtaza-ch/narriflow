import {clipPreparationReadyObjectsSchema} from "@narriflow/validators/clip-preparation";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import type { ExecutorMutationContext } from "./executor-domain-control";
import { createExecutorControl } from "./executor-control";
import type { ExecutionCommand } from "@narriflow/validators/execution";
import { RenderGroupLifecycle, renderGroupParentSettlement, type RenderGroupExecutionReference } from "./render-group-lifecycle";
import { RENDER_GROUP_MAX_UNCHARGED_ATTEMPTS, renderGroupExportIdentity } from "./render-group-contract";
import { renderArtifactBindingHash } from "./render-artifact";
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

  async function fixture(executionDeadline?: Date, aspects: readonly ("ratio_9_16" | "ratio_16_9" | "ratio_1_1")[] = ["ratio_9_16"], sealed = true) {
    const user = await db.user.create({ data: { clerkId: `targeted-execution:${crypto.randomUUID()}` } });
    users.push(user.id);
    const workspace = await db.workspace.create({ data: { name: "Targeted execution gate", ownerUserId: user.id } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Targeted execution gate", sourceMediaUrl: "r2://gate/source", sourceStorageKey: "gate/source", ingestStatus: "ready" } });
    const workSetGeneration = crypto.randomUUID();
    const run = await db.workflowRun.create({ data: { projectId: project.id, stage: "clip_rendering", status: "queued", idempotencyKey: crypto.randomUUID(), renderWorkSetGeneration: workSetGeneration, renderWorkSetFrozenAt: new Date(), requestedCount: aspects.length, deploymentEpoch: epoch } });
    const clip = await db.clip.create({ data: { projectId: project.id, workflowRunId: run.id, index: 0, startSec: 0, endSec: 10, hookText: "gate", reasoning: "gate", category: "hook", transcriptSlice: [], viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50, durationOptimalityScore: 50, tiktokScore: 50, youtubeScore: 50, instagramScore: 50, llmProvider: "gate", llmModel: "gate", editorRevision: 1 } });
    const variants = await Promise.all(aspects.map(aspectRatio => db.clipRender.create({ data: { clipId: clip.id, workflowRunId: run.id, aspectRatio, resolution: "1080p", editorRevision: 1 } })));
    const variant = variants[0]!;
    const group = await db.renderGroup.create({ data: { workflowRunId: run.id, workSetGeneration, clipId: clip.id, exportIdentity: renderGroupExportIdentity({ clipId: clip.id, exportId: null, editorRevision: 1, resolution: "1080p", watermark: true }), deploymentEpoch: epoch, members: { create: variants.map(value => ({ clipRenderId: value.id })) } } });
    subjects.push(group.id, run.id);
    const record = await db.$transaction((tx) => appendExecutionDispatch(tx, { deploymentEpoch: epoch, kind: "modal_execution", subject: { kind: "render_group", id: group.id }, generation: 1, inputHash: "a".repeat(64), dueAt: new Date("2026-10-31T00:00:00.000Z") }));
    dispatches.push(record.reference.dispatchId);
    const attemptToken = crypto.randomUUID(), owner = crypto.randomUUID();
    const [clock] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
    const deadline = executionDeadline ?? new Date(clock!.now.getTime() + 10 * 60_000);
    const input = sealed ? await sealInput(group, run.projectId, deadline) : {};
    await db.executionAttempt.create({ data: { attemptToken, dispatchId: record.reference.dispatchId, deploymentEpoch: epoch, generation: 1, inputHash: record.reference.inputHash, functionName: "render_group", operationDeadlineAt: deadline,
      ...input, createdAt: executionDeadline ? new Date(executionDeadline.getTime() - 60_000) : undefined } });
    const lifecycle = new RenderGroupLifecycle({ prisma: db, releaseGraceMs: 0 });
    return { lifecycle, reference: record.reference, attemptToken, owner, deadline, group, variant, variants, run };
  }

  async function sealInput(group: { id: string; clipId: string }, projectId: string, deadline: Date) {
    const preparation = await db.clipPreparation.upsert({ where: { clipId_bindingHash_deploymentEpoch: { clipId: group.clipId, bindingHash: "a".repeat(64), deploymentEpoch: epoch } }, update: {}, create: { projectId, clipId: group.clipId, sourceRevision: 1, editorRevision: 1,
      deploymentEpoch: epoch, operationDeadlineAt: deadline, bindingHash: "a".repeat(64), engineHash: "b".repeat(64), inputHash: "c".repeat(64),
      inputStorageKey: `projects/${projectId}/preparations/${crypto.randomUUID()}/${crypto.randomUUID()}.json`, inputEtag: '"preparation"', inputByteLength: 1000n, inputChecksumSha256: "d".repeat(64),
      createdAt: new Date(Math.min(Date.now(), deadline.getTime()-60000)),
      readyObjects:clipPreparationReadyObjectsSchema.parse({preview:{storageKey:`projects/${projectId}/preparations/${group.clipId}/fixture-preview.mp4`,etag:'"preview"',byteLength:1024,sha256:"f".repeat(64)},peaks:null,manifest:{storageKey:`projects/${projectId}/preparations/${group.clipId}/fixture-manifest.json`,etag:'"manifest"',byteLength:1024,sha256:"f".repeat(64)}}),
      status: "completed", chargedAttempts: 1, completedAt: new Date(), result: { version: 1, fixture: "verified preparation fixture" } } });
    const input = { inputStorageKey: `projects/${projectId}/render-groups/${group.id}/${crypto.randomUUID()}.json`, inputEtag: '"render"', inputByteLength: 2000n, inputChecksumSha256: "e".repeat(64) };
    await db.renderGroup.update({ where: { id: group.id }, data: { ...input, preparationId: preparation.id } });
    return input;
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
  function control(value: Awaited<ReturnType<typeof fixture>>, deliver?: (ids: readonly string[]) => Promise<void>) {
    const wakes: string[] = [];
    const api = createExecutorControl({ database: db, subjectKind: "render_group", domain: value.lifecycle,
      prepareContext: async () => ({ source: "gate-source#1", analysis: null, toolchain: "gate-toolchain" }),
      deliverWakes: async (ids) => { wakes.push(...ids); await deliver?.(ids); },
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
    expect((await withServiceEnvironment({}, () => lifecycle.prepareRenderRun({ ...reference, generation: reference.generation + 1 }))).kind).toBe("superseded");
    const prepared = await withServiceEnvironment({}, () => lifecycle.prepareRenderRun(reference));
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error("Expected a prepared Render Work Set");
    subjects.push(...prepared.groups.map(group => group.groupId));
    const parent = await db.workflowRun.findUniqueOrThrow({ where: { id: value.run.id } });
    expect(parent).toMatchObject({ status: "waiting", attemptId: null, leaseOwner: null, leaseExpiresAt: null, attemptCount: 0, requestedCount: 1 });
    expect(parent.renderWorkSetGeneration).not.toBeNull();
    await db.workspace.update({ where: { id: (await db.project.findUniqueOrThrow({ where: { id: value.run.projectId } })).workspaceId }, data: { pricingTier: "business" } });
    expect((await withServiceEnvironment({}, () => lifecycle.prepareRenderRun(reference))).dispatchIds).toEqual(prepared.dispatchIds);
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: prepared.groups[0]!.groupId } })).toMatchObject({ exportIdentity: renderGroupExportIdentity({ clipId: value.group.clipId, exportId: null, editorRevision: 1, resolution: "1080p", watermark: true }) });
    const late = await db.clipRender.create({ data: { clipId: value.group.clipId, aspectRatio: "ratio_16_9", resolution: "1080p", editorRevision: 1 } });
    const pending = await withServiceEnvironment({}, () => lifecycle.settleRenderRun(reference));
    expect(pending.kind === "settled" ? pending.outcome.status : pending.kind).toBe("pending");
    expect(pending.kind === "settled" ? pending.wait?.deadlines.map(value => value.reference.subject.kind) : []).toEqual(["render_group"]);
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: value.run.id } })).toMatchObject({ status: "waiting", leaseOwner: null, attemptId: null, attemptCount: 0 });
    const group = await db.renderGroup.findUniqueOrThrow({ where: { id: prepared.groups[0]!.groupId } });
    const driver = (await Promise.all(prepared.dispatchIds.map(id => readExecutionDispatch(db,id)))).find(record => record?.reference.kind === "operation_driver" && record.deadlineKind === null)!;
    const modal = await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, kind: "modal_execution", subject: { kind: "render_group", id: group.id },
      generation: group.generation, inputHash: driver.reference.inputHash, dueAt: driver.dueAt }));
    dispatches.push(modal.reference.dispatchId);
    const attemptToken = crypto.randomUUID(), owner = crypto.randomUUID(), deadline = group.operationDeadlineAt!;
    const input = await sealInput(group, value.run.projectId, deadline);
    await db.executionAttempt.create({ data: { attemptToken, dispatchId: modal.reference.dispatchId, deploymentEpoch: epoch, generation: group.generation,
      inputHash: modal.reference.inputHash, functionName: "render_group", operationDeadlineAt: deadline, ...input } });
    const child = { ...value, group, reference: modal.reference, attemptToken, owner, deadline };
    const server = control(child);
    expect((await server.send(acquire(child))).disposition).toBe("acquired");
    await server.send({ action: "process-start", fence: fence(child) });
    const live = await withServiceEnvironment({}, () => lifecycle.settleRenderRun(reference));
    expect(live.kind === "settled" ? live.outcome.status : live.kind).toBe("pending");
    const artifact = await db.executionArtifact.create({ data: { attemptToken, owner, role: "render_variant", bindingHash: await renderArtifactBindingHash({ inputHash: child.reference.inputHash, renderId: value.variant.id, role: "render_variant" }),
      storageKey: `execution/${epoch}/${attemptToken}/${owner}/variant.mp4`, contentType: "video/mp4", maxBytes: 4096n, grantExpiresAt: new Date(Date.now() + 60_000) } });
    await server.send({ action: "commit-artifact", fence: fence(child), artifact: { artifactId: artifact.id, role: "render_variant", contentType: "video/mp4",
      byteLength: 1024, etag: '"gate-etag"', sha256: "a".repeat(64), bindingHash: artifact.bindingHash } });
    const parentWake = await db.executionDispatch.findFirstOrThrow({ where: { subjectKind: "workflow_run", subjectId: value.run.id, kind: "render_run", wakeKind: { startsWith: "group_" } } });
    expect((await readExecutionDispatch(db,parentWake.id))!.reference).toMatchObject({ ...reference, dispatchId: parentWake.id });
    expect(await db.executionDispatch.count({ where: { subjectId: { in: [value.run.id, group.id] }, kind: "render_run", wakeKind: { not: null } } })).toBe(1);
    const wakeReference = (await readExecutionDispatch(db, parentWake.id))!.reference;
    const completed = await withServiceEnvironment({}, () => lifecycle.settleRenderRun(wakeReference));
    expect(completed.kind === "settled" ? completed.outcome : completed).toMatchObject({ status: "completed", requested: 1, succeeded: 1, failed: 0 });
    if (completed.kind !== "settled" || !completed.outcome.followUpWorkflowRunId) throw new Error("Expected one late-variant follow-up");
    subjects.push(completed.outcome.followUpWorkflowRunId);
    expect(await db.clipRender.findUniqueOrThrow({ where: { id: late.id } })).toMatchObject({ status: "pending", workflowRunId: null });
    const followUpReference = (await db.$transaction(tx => lifecycle.dispatchRunWithinTransaction(tx, completed.outcome.followUpWorkflowRunId!))).reference;
    const followUp = await withServiceEnvironment({}, () => lifecycle.prepareRenderRun(followUpReference));
    expect(followUp.kind === "prepared" ? followUp.workSet.variantIds : []).toEqual([late.id]);
    if (followUp.kind === "prepared") subjects.push(...followUp.groups.map(group => group.groupId));
    const replay = await withServiceEnvironment({}, () => lifecycle.settleRenderRun(reference));
    expect(replay).toEqual(completed);
    expect(await db.workflowEvent.count({ where: { workflowRunId: value.run.id, notificationRequired: true } })).toBe(1);
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: value.run.id } })).toMatchObject({ attemptId: null, attemptCount: 0, leaseOwner: null });
  }, 180_000);

  test("a missing video freezes admission and expires at the accepted run deadline without a native owner", async () => {
    const value = await fixture();
    await db.renderGroup.delete({ where: { id: value.group.id } });
    const acceptedAt = new Date(Date.now() - 46 * 60_000);
    await db.workflowRun.update({ where: { id: value.run.id }, data: { createdAt: acceptedAt, renderWorkSetGeneration: null, renderWorkSetFrozenAt: null, requestedCount: null } });
    await db.clipRender.update({ where: { id: value.variant.id }, data: { workflowRunId: null } });
    await db.project.update({ where: { id: value.run.projectId }, data: { ingestStatus: "pending", sourceStorageKey: null } });
    const lifecycle = withServiceEnvironment({}, () => new WorkflowRunLifecycle({ prisma: db }));
    const reference = (await db.$transaction(tx => lifecycle.dispatchRunWithinTransaction(tx, value.run.id))).reference;
    const result = await withServiceEnvironment({}, () => lifecycle.prepareRenderRun(reference));
    expect(result.kind).toBe("terminal");
    const parent = await db.workflowRun.findUniqueOrThrow({ where: { id: value.run.id } });
    expect(parent).toMatchObject({ status: "failed", operationDeadlineAt: new Date(acceptedAt.getTime() + 45 * 60_000), attemptId: null, attemptCount: 0, leaseOwner: null, requestedCount: 1, failedCount: 1 });
    expect(await db.clipRender.findUniqueOrThrow({ where: { id: value.variant.id } })).toMatchObject({ status: "failed", errorCode: "source_video_unavailable", failureDisposition: "permanent" });
    const watchdog = await db.executionDispatch.findFirstOrThrow({ where: { subjectId: value.run.id, deadlineKind: "operation" } });
    expect(watchdog.observedDeadlineAt).toEqual(parent.operationDeadlineAt);
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectKind: "render_group", subjectId: { in: (await db.renderGroup.findMany({ where: { workflowRunId: value.run.id } })).map(group => group.id) } } } })).toBe(0);
    expect(await db.renderGroupExecution.count({ where: { group: { workflowRunId: value.run.id } } })).toBe(0);
    subjects.push(...(await db.renderGroup.findMany({ where: { workflowRunId: value.run.id } })).map(group => group.id));
  });

  test("variants already assigned to the accepted run are included in its frozen denominator", async () => {
    const value = await fixture();
    await db.renderGroup.delete({ where: { id: value.group.id } });
    await db.workflowRun.update({ where: { id: value.run.id }, data: { renderWorkSetGeneration: null, renderWorkSetFrozenAt: null, requestedCount: null } });
    const lifecycle = withServiceEnvironment({}, () => new WorkflowRunLifecycle({ prisma: db }));
    const reference = (await db.$transaction(tx => lifecycle.dispatchRunWithinTransaction(tx, value.run.id))).reference;
    const prepared = await withServiceEnvironment({}, () => lifecycle.prepareRenderRun(reference));
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error("Expected prepared assigned variants");
    expect(prepared.workSet.variantIds).toEqual([value.variant.id]);
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: value.run.id } })).toMatchObject({ requestedCount: 1, status: "waiting", attemptCount: 0, attemptId: null });
    subjects.push(...prepared.groups.map(group => group.groupId));
  });

  test("a group seals one preparation and one complete input tuple across retries", async () => {
    const value = await fixture(undefined, undefined, false);
    const preparation = await db.clipPreparation.create({ data: { projectId: value.run.projectId, clipId: value.group.clipId,
      sourceRevision: 1, editorRevision: 1, bindingHash: "a".repeat(64), engineHash: "b".repeat(64), inputHash: "c".repeat(64),
      inputStorageKey: "projects/frozen/preparation.json", inputEtag: '"preparation"', inputByteLength: 1000n, inputChecksumSha256: "d".repeat(64),
      deploymentEpoch: epoch, operationDeadlineAt: new Date(Date.now()+600000) } });
    try {
      await db.renderGroup.update({ where: { id: value.group.id }, data: { preparationId: preparation.id } });
      await expect(Promise.resolve(db.renderGroup.update({ where: { id: value.group.id }, data: { inputStorageKey: "projects/frozen/render.json" } }))).rejects.toThrow();
      const input = { inputStorageKey: "projects/frozen/render.json", inputEtag: '"render"', inputByteLength: 2000n, inputChecksumSha256: "e".repeat(64) };
      await db.renderGroup.update({ where: { id: value.group.id }, data: input });
      await expect(Promise.resolve(db.renderGroup.update({ where: { id: value.group.id }, data: { inputEtag: '"replacement"' } }))).rejects.toThrow("immutable");
      await expect(Promise.resolve(db.renderGroup.update({ where: { id: value.group.id }, data: { preparationId: null } }))).rejects.toThrow();
      await db.renderGroup.update({ where: { id: value.group.id }, data: { generation: { increment: 1 } } });
      expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ ...input, preparationId: preparation.id, generation: 2 });
    } finally {
      await db.renderGroup.delete({ where: { id: value.group.id } });
      await db.clipPreparation.delete({ where: { id: preparation.id } });
    }
  });

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

  test("a queued native token cannot acquire before completed preparation and its exact sealed capsule exist", async () => {
    const value = await fixture(undefined, undefined, false), server = control(value);
    await expect(server.send(acquire(value))).rejects.toThrow();
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ status: "queued", chargedAttemptCount: 0, attemptToken: null });
    expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: value.attemptToken } })).toMatchObject({ owner: null, processStartedAt: null });
    expect(await db.renderGroupExecution.count({ where: { groupId: value.group.id } })).toBe(0);
  });

  test("the shared preparation deadline resolves a running native owner by its actual generic token", async () => {
    const value = await fixture(), server = control(value);
    await server.send(acquire(value));
    const watchdog = await db.executionDispatch.findFirstOrThrow({ where: { subjectId: value.group.id, kind: "operation_driver", deadlineKind: "operation" } });
    expect(await value.lifecycle.expirePreparationDeadline((await readExecutionDispatch(db,watchdog.id))!.reference,
      { kind: "operation", observedDeadlineAt: value.deadline })).toEqual({ kind: "native", attemptToken: value.attemptToken });
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ status: "running", chargedAttemptCount: 0, attemptToken: value.attemptToken });
  });

  test("a pre-start release creates no charged render attempt and admits one new generation", async () => {
    const value = await fixture();
    await mutate(value, (tx, ref, context) => value.lifecycle.acquireExecution(tx, ref, context));
    await mutate(value, (tx, ref, context) => value.lifecycle.releaseExecution(tx, ref, context, { reason: "startup_rejected" }));
    const group = await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } });
    expect(group).toMatchObject({ status: "queued", chargedAttemptCount: 0, generation: 2, attemptToken: null });
    const ledger = await db.renderGroupExecution.findUniqueOrThrow({ where: { token: value.attemptToken } });
    expect(ledger).toMatchObject({ charged: false, startedAt: null, result: "released" });
    expect(group.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
  }, 60_000);

  test("repeated pre-start rejections back off and settle the group on their own budget", async () => {
    const value = await fixture(), now = new Date();
    await db.renderGroupExecution.createMany({ data: Array.from({ length: RENDER_GROUP_MAX_UNCHARGED_ATTEMPTS - 1 }, () => ({ token: crypto.randomUUID(), groupId: value.group.id, owner: crypto.randomUUID(), claimedAt: now, finishedAt: now, result: "released" as const })) });
    await mutate(value, (tx, ref, context) => value.lifecycle.acquireExecution(tx, ref, context));
    await mutate(value, (tx, ref, context) => value.lifecycle.releaseExecution(tx, ref, context, { reason: "startup_rejected" }));
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ status: "failed", chargedAttemptCount: 0, nextAttemptAt: null, failureDisposition: "permanent" });
    expect(await db.clipRender.findUniqueOrThrow({ where: { id: value.variant.id } })).toMatchObject({ status: "failed", failureDisposition: "permanent" });
    await withServiceEnvironment({}, () => db.$transaction(tx => renderGroupParentSettlement(tx, value.run.id))).then(decision => expect(decision).toMatchObject({ eligible: true, status: "failed" }));
  }, 60_000);

  test("a frozen, dispatched parent skips admission and each group outcome wakes it once", async () => {
    const value = await fixture(), workflow = withServiceEnvironment({}, () => new WorkflowRunLifecycle({ prisma: db }));
    await db.renderGroupMember.deleteMany({ where: { groupId: value.group.id } });
    await db.executionAttempt.deleteMany({ where: { dispatchId: value.reference.dispatchId } });
    await db.renderGroup.delete({ where: { id: value.group.id } });
    await db.workflowRun.update({ where: { id: value.run.id }, data: { renderWorkSetGeneration: null, renderWorkSetFrozenAt: null, requestedCount: null } });
    const parent = (await db.$transaction(tx => workflow.dispatchRunWithinTransaction(tx, value.run.id))).reference;
    const prepared = await withServiceEnvironment({}, () => workflow.prepareRenderRun(parent));
    if (prepared.kind !== "prepared") throw new Error("Expected the first prepare to admit the work set");
    subjects.push(...prepared.groups.map(group => group.groupId));
    expect((await withServiceEnvironment({}, () => workflow.prepareRenderRun(parent))).kind).toBe("prepared");
    await db.executionDispatch.updateMany({ where: { id: { in: prepared.dispatchIds } }, data: { acknowledgedAt: new Date(), destinationId: "fixture" } });
    const events = await db.workflowEvent.count({ where: { workflowRunId: value.run.id } });
    expect(await withServiceEnvironment({}, () => workflow.prepareRenderRun(parent))).toEqual({ kind: "dispatched", dispatchIds: [] });
    expect(await db.workflowEvent.count({ where: { workflowRunId: value.run.id } })).toBe(events);
    await db.executionDispatch.updateMany({ where: { id: prepared.dispatchIds[0]! }, data: { acknowledgedAt: null } });
    expect((await withServiceEnvironment({}, () => workflow.prepareRenderRun(parent))).kind).toBe("prepared");
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
    let loseAck = false;
    const server = control(value, async () => { if (loseAck) throw new Error("lost_group_wake_ack"); });
    await server.send(acquire(value));
    await server.send({ action: "process-start", fence: fence(value) });
    const assignment = await db.executionArtifact.create({ data: { attemptToken: value.attemptToken, owner: value.owner, role: "render_variant", bindingHash: await renderArtifactBindingHash({ inputHash: value.reference.inputHash, renderId: value.variant.id, role: "render_variant" }),
      storageKey: `execution/${epoch}/${value.attemptToken}/${value.owner}/variant.mp4`, contentType: "video/mp4", maxBytes: 4096n, grantExpiresAt: value.deadline } });
    const command = { action: "commit-artifact" as const, fence: fence(value), artifact: { artifactId: assignment.id, role: "render_variant" as const, contentType: "video/mp4",
      byteLength: 1024, sha256: "a".repeat(64), etag: '"gate-etag"', bindingHash: assignment.bindingHash } };
    const receipt = verified();
    loseAck = true;
    await expect(server.send(command, receipt)).rejects.toThrow("lost_group_wake_ack");
    loseAck = false;
    const result = await server.send(command, receipt);
    expect(result).toEqual({ disposition: "committed", artifactId: assignment.id,
      renderGroup: { status: "completed", requested: 1, succeeded: 1, failed: 0, superseded: 0 } });
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ status: "completed", chargedAttemptCount: 1, attemptToken: null });
    expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: value.attemptToken } })).toMatchObject({ status: "completed" });
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: value.run.id } })).toMatchObject({ status: "queued", leaseOwner: null, leaseExpiresAt: null });
    expect(await db.executionDispatch.count({ where: { subjectId: value.run.id, kind: "render_run", wakeKind: { startsWith: "group_" } } })).toBe(1);
    expect(await db.executionDispatch.findFirst({ where: { subjectId: value.group.id, kind: "operation_driver", wakeKind: "execution_finished" } })).not.toBeNull();
  }, 90_000);

  test("a Workspace restriction leaves a running group to its lease deadline and keeps it retryable", async () => {
    const value = await fixture(), server = control(value);
    await server.send(acquire(value)); await server.send({ action: "process-start", fence: fence(value) });
    const project = await db.project.findUniqueOrThrow({ where: { id: value.run.projectId } });
    await db.workspace.update({ where: { id: project.workspaceId }, data: { status: "restricted" } });
    expect(await server.send({ action: "renew", fence: fence(value), leaseSeconds: 120 })).toEqual({ disposition: "cancelled" });
    const past = new Date(0), deliveryId = crypto.randomUUID(); receipts.push(deliveryId);
    await db.renderGroup.update({ where: { id: value.group.id }, data: { leaseExpiresAt: past } });
    await db.executionAttempt.update({ where: { attemptToken: value.attemptToken }, data: { leaseExpiresAt: past } });
    const deadline = { reference: value.reference, attemptToken: value.attemptToken, kind: "lease", observedDeadlineAt: past.toISOString() };
    expect((await withServiceEnvironment({}, () => server.api.expireDeadline({ deadline, deliveryId }))).kind).toBe("expired");
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ status: "queued", generation: 2, attemptToken: null, leaseOwner: null, chargedAttemptCount: 1 });
    expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: value.attemptToken } })).toMatchObject({ status: "expired" });
    expect(await db.clipRender.findUniqueOrThrow({ where: { id: value.variant.id } })).toMatchObject({ status: "pending" });
  });

  async function withExportVariant(value: Awaited<ReturnType<typeof fixture>>) {
    const project = await db.project.findUniqueOrThrow({ where: { id: value.run.projectId } });
    const exported = await db.clipExport.create({ data: { workspaceId: project.workspaceId, projectId: project.id, clipId: value.group.clipId, editorRevision: 1,
      fingerprint: crypto.randomUUID(), resolution: "1080p", watermark: true, status: "rendering" } });
    const variant = await db.clipExportVariant.create({ data: { exportId: exported.id, aspectRatio: "ratio_9_16", resolution: "1080p", watermark: true, status: "pending" } });
    await db.clipRender.update({ where: { id: value.variant.id }, data: { exportVariantId: variant.id } });
    return { exported, variant };
  }

  test.each(["parent", "source"] as const)("%s cancellation fails export variants and settles the export in the same transaction", async mode => {
    const value = await fixture(), { exported, variant } = await withExportVariant(value);
    const workflow = withServiceEnvironment({}, () => new WorkflowRunLifecycle({ prisma: db }));
    if (mode === "parent") {
      expect(await withServiceEnvironment({}, () => workflow.cancelQueuedProjectRuns({ projectId: value.run.projectId, errorCode: "PROJECT_EXPIRED" }))).toBe(1);
    } else {
      await db.$transaction(tx => workflow.dispatchRunWithinTransaction(tx, value.run.id));
      await withServiceEnvironment({}, () => db.$transaction(async tx => {
        await tx.$queryRaw`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id" = 1 FOR SHARE`;
        await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${value.run.projectId}::uuid FOR UPDATE`;
        return workflow.cancelSourceExecutionsWithinTransaction(tx, { projectId: value.run.projectId, deploymentEpoch: epoch, errorCode: "source_unavailable", now: new Date() });
      }));
    }
    expect(await db.clipRender.findUniqueOrThrow({ where: { id: value.variant.id } })).toMatchObject({ status: "failed", failureDisposition: "permanent" });
    expect(await db.clipExportVariant.findUniqueOrThrow({ where: { id: variant.id } })).toMatchObject({ status: "failed" });
    expect((await db.clipExport.findUniqueOrThrow({ where: { id: exported.id } })).status).toBe("failed");
  });

  test("source cancellation fails the unfrozen renders of a run that never reached a group", async () => {
    const value = await fixture();
    await db.renderGroupMember.deleteMany({ where: { groupId: value.group.id } });
    await db.executionAttempt.deleteMany({ where: { dispatchId: value.reference.dispatchId } });
    await db.renderGroup.delete({ where: { id: value.group.id } });
    const workflow = withServiceEnvironment({}, () => new WorkflowRunLifecycle({ prisma: db }));
    await db.$transaction(tx => workflow.dispatchRunWithinTransaction(tx, value.run.id));
    await withServiceEnvironment({}, () => db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id" = 1 FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${value.run.projectId}::uuid FOR UPDATE`;
      return workflow.cancelSourceExecutionsWithinTransaction(tx, { projectId: value.run.projectId, deploymentEpoch: epoch, errorCode: "source_unavailable", now: new Date() });
    }));
    expect(await db.clipRender.findUniqueOrThrow({ where: { id: value.variant.id } })).toMatchObject({ status: "failed", errorCode: "source_unavailable" });
  });

  test("a source or frozen variant configuration change blocks an already-running owner's publication", async () => {
    for (const change of ["source_revision", "resolution"] as const) {
      const value = await fixture(), server = control(value);
      await server.send(acquire(value)); await server.send({ action: "process-start", fence: fence(value) });
      const bindingHash = await renderArtifactBindingHash({ inputHash: value.reference.inputHash, renderId: value.variant.id, role: "render_variant" });
      const assigned = await db.executionArtifact.create({ data: { attemptToken: value.attemptToken, owner: value.owner, role: "render_variant", bindingHash,
        storageKey: `execution/${epoch}/${value.attemptToken}/${value.owner}/${crypto.randomUUID()}.mp4`, contentType: "video/mp4", maxBytes: 4096n, grantExpiresAt: value.deadline } });
      if (change === "source_revision") await db.project.update({ where: { id: value.run.projectId }, data: { sourceRevision: { increment: 1 } } });
      else await db.clipRender.update({ where: { id: value.variant.id }, data: { resolution: "720p" } });
      const command = { action: "commit-artifact" as const, fence: fence(value), artifact: { artifactId: assigned.id, role: "render_variant" as const, contentType: "video/mp4", byteLength: 1024, etag: '"gate-etag"', sha256: "a".repeat(64), bindingHash } };
      if (change === "source_revision") {
        expect(await server.send(command)).toEqual({ disposition: "superseded" });
        expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ status: "superseded", attemptToken: null, chargedAttemptCount: 1 });
        expect(await db.renderGroupExecution.findUniqueOrThrow({ where: { token: value.attemptToken } })).toMatchObject({ result: "superseded", charged: true });
      } else await expect(server.send(command)).rejects.toThrow();
      expect(await db.clipRender.findUniqueOrThrow({ where: { id: value.variant.id } })).toMatchObject({ storageKey: null, durationSec: null });
      expect((await db.executionArtifact.findUniqueOrThrow({ where: { id: assigned.id } })).committedAt).toBeNull();
    }
  });

  test("an unacquired operation deadline settles failed without a fabricated render execution or charge", async () => {
    const expired = new Date(0);
    const value = await fixture(expired);
    const result = await mutate(value, (tx) => value.lifecycle.expireExecution(tx, value.reference, value.attemptToken, { kind: "operation", observedDeadlineAt: expired }));
    expect(result.kind).toBe("expired");
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ status: "failed", chargedAttemptCount: 0 });
    expect(await db.renderGroupExecution.findUnique({ where: { token: value.attemptToken } })).toBeNull();
    expect(await db.clipRender.findUniqueOrThrow({ where: { id: value.variant.id } })).toMatchObject({ status: "failed", errorCode: "operation_deadline_exceeded" });
  }, 90_000);

  test("a durable pre-input deadline expires a queued group with no generic invocation or invented process history", async () => {
    const value = await fixture(undefined, undefined, false);
    await db.executionAttempt.delete({ where: { attemptToken: value.attemptToken } });
    const absolute = new Date(0);
    await db.renderGroup.update({ where: { id: value.group.id }, data: { operationDeadlineAt: absolute } });
    const deadline = await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, kind: "operation_driver", subject: value.reference.subject,
      generation: 1, inputHash: value.reference.inputHash, dueAt: absolute, deadlineKind: "operation", observedDeadlineAt: absolute }));
    const observation = { kind: "operation" as const, observedDeadlineAt: absolute };
    expect(await value.lifecycle.expirePreparationDeadline(deadline.reference, { ...observation, observedDeadlineAt: new Date(1) })).toEqual({ kind: "superseded" });
    const expired = await value.lifecycle.expirePreparationDeadline(deadline.reference, observation);
    expect(expired.kind).toBe("expired");
    expect("dispatchIds" in expired ? expired.dispatchIds?.length : 0).toBe(2);
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ status: "failed", attemptToken: null, leaseOwner: null, chargedAttemptCount: 0, operationDeadlineAt: absolute });
    expect(await db.renderGroupExecution.count({ where: { groupId: value.group.id } })).toBe(0);
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectId: value.group.id } } })).toBe(0);
    expect(await db.clipRender.findUniqueOrThrow({ where: { id: value.variant.id } })).toMatchObject({ status: "failed", failureDisposition: "permanent", errorCode: "operation_deadline_exceeded" });
    const replay = await value.lifecycle.expirePreparationDeadline(deadline.reference, observation);
    expect(replay.kind).toBe("terminal");
    expect("dispatchIds" in replay ? [...replay.dispatchIds ?? []].sort() : []).toEqual("dispatchIds" in expired ? [...expired.dispatchIds ?? []].sort() : []);
  }, 90_000);

  test("a direct queued deadline reconciles an admitted but unacquired Generic Attempt without charging it", async () => {
    const absolute = new Date(0), value = await fixture(absolute), server = control(value);
    await db.renderGroup.update({ where: { id: value.group.id }, data: { operationDeadlineAt: absolute } });
    const watchdog = await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, kind: "operation_driver", subject: value.reference.subject,
      generation: 1, inputHash: value.reference.inputHash, dueAt: absolute, deadlineKind: "operation", observedDeadlineAt: absolute }));
    const direct = await value.lifecycle.expirePreparationDeadline(watchdog.reference, { kind: "operation", observedDeadlineAt: absolute });
    expect(direct.kind).toBe("expired");
    expect((await server.api.expireDeadline({ deadline: { reference: value.reference, attemptToken: value.attemptToken, kind: "operation", observedDeadlineAt: absolute.toISOString() }, deliveryId: watchdog.reference.dispatchId })).kind).toBe("terminal");
    receipts.push(watchdog.reference.dispatchId);
    expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: value.attemptToken } })).toMatchObject({ status: "failed", owner: null, processStartedAt: null });
    expect(await db.renderGroupExecution.count({ where: { groupId: value.group.id } })).toBe(0);
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ chargedAttemptCount: 0 });
    expect(server.wakes.slice().sort()).toEqual("dispatchIds" in direct ? [...direct.dispatchIds ?? []].sort() : []);
  });

  test("sealed member failures retain permanent results and retry only failed retryable variants after the last success", async () => {
    let value = await fixture(undefined, ["ratio_9_16", "ratio_16_9", "ratio_1_1"]);
    const commit = async (renderId: string, failure?: { errorCode: string; disposition: "retryable" | "permanent" }) => {
      const role = failure ? "render_outcome" as const : "render_variant" as const;
      const bindingHash = await renderArtifactBindingHash({ inputHash: value.reference.inputHash, renderId, role });
      const artifact = { artifactId: crypto.randomUUID(), role, storageKey: `execution/${epoch}/${value.attemptToken}/${value.owner}/${crypto.randomUUID()}`,
        contentType: failure ? "application/json" : "video/mp4", byteLength: 1024n, etag: '"gate-etag"', sha256: "a".repeat(64), bindingHash,
        renderId, ...(failure ? { failure: { version: 1 as const, kind: "failed" as const, renderId, bindingHash, ...failure } } : { durationSec: 10,
          brollCredits: [{ pexelsId: 72, authorName: "Author", authorUrl: null, pageUrl: "https://www.pexels.com/video/72/" }] }) };
      return mutate(value, (tx, ref, context) => value.lifecycle.commitArtifactExecution(tx, ref, context, artifact));
    };
    await mutate(value, (tx, ref, context) => value.lifecycle.acquireExecution(tx, ref, context));
    await mutate(value, (tx, ref, context) => value.lifecycle.startExecution(tx, ref, context));
    await commit(value.variants[1]!.id, { errorCode: "render_encode_unavailable", disposition: "retryable" });
    await commit(value.variants[2]!.id, { errorCode: "caption_glyph_unavailable", disposition: "permanent" });
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ status: "running", generation: 1, chargedAttemptCount: 1 });
    const retry = await commit(value.variant.id);
    expect((await Promise.all((retry?.dispatchIds ?? []).map(id => readExecutionDispatch(db,id)))).filter(record => record?.reference.kind === "render_run" && record.reference.subject.kind === "workflow_run")).toHaveLength(1);
    expect(retry?.renderGroup).toEqual({ status: "queued", requested: 3, succeeded: 1, failed: 1, superseded: 0 });
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ status: "queued", generation: 2, chargedAttemptCount: 1, operationDeadlineAt: value.deadline });
    expect(await db.clipRender.findUniqueOrThrow({ where: { id: value.variant.id } })).toMatchObject({ status: "completed", durationSec: 10,
      brollCredits: [{ pexelsId: 72, authorName: "Author", authorUrl: null, pageUrl: "https://www.pexels.com/video/72/" }] });
    expect(await db.clipRender.findUniqueOrThrow({ where: { id: value.variants[1]!.id } })).toMatchObject({ status: "pending", storageKey: null });
    expect(await db.clipRender.findUniqueOrThrow({ where: { id: value.variants[2]!.id } })).toMatchObject({ status: "failed", failureDisposition: "permanent", errorCode: "caption_glyph_unavailable" });
    const retainedSuccess = await db.clipRender.findUniqueOrThrow({ where: { id: value.variant.id } });
    const previous = value;
    const record = await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, kind: "modal_execution", subject: value.reference.subject, generation: 2, inputHash: value.reference.inputHash, dueAt: new Date() }));
    dispatches.push(record.reference.dispatchId);
    const attemptToken = crypto.randomUUID(), owner = crypto.randomUUID();
    const priorInput = await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } });
    await db.executionAttempt.create({ data: { attemptToken, dispatchId: record.reference.dispatchId, deploymentEpoch: epoch, generation: 2, inputHash: record.reference.inputHash, functionName: "render_group", operationDeadlineAt: value.deadline,
      inputStorageKey: priorInput.inputStorageKey, inputEtag: priorInput.inputEtag, inputByteLength: priorInput.inputByteLength, inputChecksumSha256: priorInput.inputChecksumSha256 } });
    await db.renderGroup.update({ where: { id: value.group.id }, data: { nextAttemptAt: new Date(0) } });
    value = { ...value, reference: record.reference, attemptToken, owner };
    await mutate(value, (tx, ref, context) => value.lifecycle.acquireExecution(tx, ref, context));
    await mutate(value, (tx, ref, context) => value.lifecycle.startExecution(tx, ref, context));
    await expect(mutate(value, (tx, ref, context) => value.lifecycle.commitArtifactExecution(tx, ref, context, { artifactId: crypto.randomUUID(), role: "render_outcome", renderId: value.variants[1]!.id,
      storageKey: "assigned/failure.json", contentType: "application/json", byteLength: 12n, sha256: "a".repeat(64), etag: '"gate"', bindingHash: "a".repeat(64),
      failure: { version: 1, kind: "failed", renderId: previous.variant.id, bindingHash: "a".repeat(64), errorCode: "invalid_source", disposition: "permanent" } }))).rejects.toThrow("Invalid prepared render artifact");
    const settled = await commit(value.variants[1]!.id);
    expect(settled?.renderGroup).toEqual({ status: "partial", requested: 3, succeeded: 2, failed: 1, superseded: 0 });
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: value.group.id } })).toMatchObject({ status: "partial", generation: 2, chargedAttemptCount: 2 });
    expect(await db.renderGroupVariantOutcome.findMany({ where: { groupId: value.group.id }, orderBy: [{ token: "asc" }, { clipRenderId: "asc" }] })).toHaveLength(4);
    expect(await db.clipRender.findUniqueOrThrow({ where: { id: value.variant.id } })).toEqual(retainedSuccess);
    expect(await db.renderGroupVariantOutcome.findUniqueOrThrow({ where: { token_clipRenderId: { token: previous.attemptToken, clipRenderId: value.variant.id } } })).toMatchObject({ result: "completed" });
    expect(await db.renderGroupExecution.findUniqueOrThrow({ where: { token: value.attemptToken } })).toMatchObject({ result: "partial", charged: true });
  }, 90_000);

});
