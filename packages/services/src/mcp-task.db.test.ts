import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { createMcpTaskRegistry, type McpTaskRecord } from "./mcp-task";
import { prismaMcpTaskPersistence, getMcpTaskDomainState, cancelMcpTaskDomainWork } from "./mcp-task-runtime";
import { workspaceService } from "./workspace.service";
import { buildMcpContentPack } from "@narriflow/validators";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";

const url = process.env.MCP_TEST_DATABASE_URL;
const schema = process.env.MCP_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_MCP_DB_TESTS === "1" && Boolean(url);
const db = enabled ? describe : describe.skip;
setDefaultTimeout(180_000);

db("durable MCP Task lifecycle", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let userId: string;
  let workspaceId: string;
  let projectId: string;
  const globals = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
  let previous: PrismaClient | undefined;
  beforeAll(async () => {
    if (!url || !schema || !/^mcp_test_[a-z0-9_]+$/.test(schema)) throw new Error("Tasks require a disposable schema");
    pool = new Pool({ connectionString: url, max: 10 });
    if ((await pool.query("SELECT current_schema() AS schema")).rows[0]?.schema !== schema) throw new Error("Wrong disposable schema");
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), transactionOptions: { maxWait: 120_000, timeout: 120_000 } });
    previous = globals.narriflowPrismaClient; globals.narriflowPrismaClient = prisma;
    userId = (await prisma.user.create({ data: { clerkId: `mcp-task-test:${randomUUID()}` } })).id;
    workspaceId = (await prisma.workspace.create({ data: { name: "Task test", ownerUserId: userId, pricingTier: "business", members: { create: { userId, role: "owner" } } } })).id;
    projectId = (await prisma.project.create({ data: { workspaceId, createdByUserId: userId, title: "Task fixture", sourceMediaUrl: "https://example.test/video.mp4", ingestStatus: "ready" } })).id;
  });
  beforeEach(async () => {
    projectId = (await prisma.project.create({ data: { workspaceId, createdByUserId: userId, title: "Task fixture", sourceMediaUrl: "https://example.test/video.mp4", ingestStatus: "ready" } })).id;
  });
  afterAll(async () => { globals.narriflowPrismaClient = previous; await prisma?.$disconnect(); await pool?.end(); });
  function registry() {
    return createMcpTaskRegistry({ persistence: prismaMcpTaskPersistence(prisma),
      authorize: async (record) => { await workspaceService.requireActor(record.ownerUserId, record.workspaceId, "content.view"); },
      resolve: async (record) => {
        const state = await getMcpTaskDomainState(record);
        if (state?.cancelled) return { status: "cancelled" };
        if (state?.status === "completed") return { status: "completed", result: { done: true } };
        return { status: "working" };
      }, cancel: cancelMcpTaskDomainWork,
    });
  }
  async function taskInput(): Promise<Omit<McpTaskRecord, "id" | "status" | "terminalOutcome" | "createdAt" | "updatedAt" | "expiresAt" | "cancellationRequestedAt">> {
    const pack = await prisma.contentPack.create({ data: { projectId, ...buildMcpContentPack() } });
    const run = await prisma.workflowRun.create({ data: { projectId, contentPackId: pack.id, stage: "stt", status: "queued", idempotencyKey: randomUUID() } });
    return { ownerUserId: userId, callerId: `oauth:client:${userId}`, workspaceId, toolName: "narriflow_generate_clips", domainKind: "generation", domainId: run.id,
      projectId, clipId: null, originatingOperationId: randomUUID(), resultContract: { version: 1 }, initialResult: { operationId: run.id } };
  }
  async function detection(input: Awaited<ReturnType<typeof taskInput>>, status: string) {
    const origin = await prisma.workflowRun.update({ where: { id: input.domainId }, data: { status: "completed" } });
    return prisma.workflowRun.create({ data: { projectId, contentPackId: origin.contentPackId, stage: "moment_detection", status,
      idempotencyKey: `${origin.idempotencyKey}__moment_detection` } });
  }
  async function clip(detectionId: string, index = 0) {
    return prisma.clip.create({ data: { projectId, workflowRunId: detectionId, index, startSec: 0, endSec: 30,
      hookText: "Test hook", reasoning: "Test", category: "story", transcriptSlice: [], viralityScore: 50,
      hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50, durationOptimalityScore: 50,
      tiktokScore: 50, youtubeScore: 50, instagramScore: 50, llmProvider: "test", llmModel: "test" } });
  }
  async function renderRun(childId: string, status: string) {
    return prisma.workflowRun.create({ data: { projectId, stage: "clip_rendering", status, idempotencyKey: `auto-render-${childId}` } });
  }
  async function event(workflowRunId: string, stage: "moment_detection" | "clip_rendering", status: string, extra: Record<string, unknown>) {
    const project = await prisma.project.update({ where: { id: projectId }, data: { workflowEventSeq: { increment: 1 } } });
    await prisma.workflowEvent.create({ data: { projectId, workflowRunId, stage, status,
      progress: 50, seq: project.workflowEventSeq, emittedAt: new Date(), dedupeKey: `fixture:${randomUUID()}`,
      payload: { event: "workflow.stage.updated", projectId, workflowRunId, seq: project.workflowEventSeq,
        stage, status, progress: 50, errorCode: null, emittedAt: new Date().toISOString(), ...extra } } });
  }
  async function handoff(childId: string, workId: string, renderIds: string[]) {
    await event(childId, "moment_detection", "running", { followUpWorkflowRunId: workId, generationRenderIds: renderIds });
  }
  test("concurrent registrations reconnect to one handle and immutable terminal snapshot", async () => {
    const input = await taskInput(); const owned = { ownerUserId: input.ownerUserId, callerId: input.callerId };
    const receipts = await Promise.all(Array.from({ length: 6 }, () => registry().register(input)));
    expect(new Set(receipts.map((row) => row.id)).size).toBe(1);
    const id = receipts[0]!.id;
    await detection(input, "completed");
    expect((await registry().get(id, owned)).terminalOutcome).toEqual({ status: "completed", result: { done: true } });
    await prisma.workflowRun.update({ where: { id: input.domainId }, data: { status: "failed" } });
    expect((await registry().get(id, owned)).status).toBe("completed");
    await expect(Promise.resolve(prisma.mcpTask.update({ where: { id }, data: { status: "cancelled", terminalOutcome: { status: "cancelled" } } }))).rejects.toThrow();
    await expect(Promise.resolve(prisma.mcpTask.update({ where: { id }, data: { resultContract: { version: 2 } } }))).rejects.toThrow();
  });
  test("terminal settlement races preserve the first durable outcome", async () => {
    const row = await registry().register(await taskInput()); const store = prismaMcpTaskPersistence(prisma);
    await Promise.all([store.settle(row.id, { status: "completed", result: { done: true } }, new Date()), store.settle(row.id, { status: "cancelled" }, new Date())]);
    const first = await store.read(row.id);
    await store.settle(row.id, { status: "failed", error: { code: -1, message: "Late error" } }, new Date());
    expect((await store.read(row.id))?.terminalOutcome).toEqual(first?.terminalOutcome);
  });
  test("cooperative cancellation races queued work admission without cancelling a running claim", async () => {
    const input = await taskInput(); const row = await registry().register(input);
    const [claim] = await Promise.all([
      prisma.workflowRun.updateMany({ where: { id: input.domainId, status: "queued" }, data: { status: "running" } }),
      registry().cancel(row.id, { ownerUserId: userId, callerId: input.callerId }),
    ]);
    const work = await prisma.workflowRun.findUniqueOrThrow({ where: { id: input.domainId } });
    expect(work.status).toBe(claim.count ? "running" : "failed");
    if (!claim.count) expect(work.errorCode).toBe("MCP_CANCELLED");
    const polled = await registry().get(row.id, { ownerUserId: userId, callerId: input.callerId });
    expect(polled.status).toBe(claim.count ? "working" : "cancelled");
  });
  test("expiry and caller isolation leave domain execution untouched", async () => {
    const input = await taskInput(); const at = new Date("2026-01-01T00:00:00Z");
    const row = await createMcpTaskRegistry({ persistence: prismaMcpTaskPersistence(prisma), now: () => at,
      authorize: async () => {}, resolve: async () => ({ status: "working" }), cancel: async () => { throw new Error("Must not cancel"); } }).register(input);
    await expect(registry().get(row.id, { ownerUserId: userId, callerId: input.callerId })).rejects.toMatchObject({ code: "mcp_task_not_found" });
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: input.domainId } })).status).toBe("queued");
    const current = await registry().register(await taskInput());
    await expect(registry().get(current.id, { ownerUserId: userId, callerId: "another-client" })).rejects.toMatchObject({ code: "mcp_task_not_found" });
  });
  test("generation remains working after STT and isolates the exact detection child", async () => {
    const input = await taskInput(); const row = await registry().register(input);
    const child = await detection(input, "queued");
    await detection(await taskInput(), "failed");
    expect(await getMcpTaskDomainState(row)).toEqual({ status: "working", cancelled: false });
    expect((await registry().get(row.id, { ownerUserId: userId, callerId: input.callerId })).status).toBe("working");
    await prisma.workflowRun.update({ where: { id: child.id }, data: { status: "failed", errorCode: "detection_failed" } });
    expect(await getMcpTaskDomainState(row)).toEqual({ status: "failed", cancelled: false });
  });
  test("generation waits for its clip renders and reports partial rendering", async () => {
    const input = await taskInput(); const row = await registry().register(input);
    const child = await detection(input, "completed");
    const work = await renderRun(child.id, "queued");
    const first = await clip(child.id); const second = await clip(child.id, 1);
    const completed = await prisma.clipRender.create({ data: { clipId: first.id, aspectRatio: "ratio_9_16", status: "completed", workflowRunId: work.id } });
    const rendering = await prisma.clipRender.create({ data: { clipId: second.id, aspectRatio: "ratio_9_16", status: "pending", workflowRunId: work.id } });
    await handoff(child.id, work.id, [completed.id, rendering.id]);
    expect(await getMcpTaskDomainState(row)).toEqual({ status: "working", cancelled: false });
    await prisma.clipRender.update({ where: { id: rendering.id }, data: { status: "failed", errorCode: "render_failed" } });
    await prisma.workflowRun.update({ where: { id: work.id }, data: { status: "partial" } });
    expect(await getMcpTaskDomainState(row)).toEqual({ status: "partial", cancelled: false });
  });
  test("cancellation reaches a queued detection child while a running detection wins", async () => {
    const input = await taskInput(); const row = await registry().register(input); const child = await detection(input, "queued");
    await registry().cancel(row.id, { ownerUserId: userId, callerId: input.callerId });
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: input.domainId } })).status).toBe("completed");
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: child.id } })).errorCode).toBe("MCP_CANCELLED");
    expect((await registry().get(row.id, { ownerUserId: userId, callerId: input.callerId })).status).toBe("cancelled");
    const runningInput = await taskInput(); const running = await registry().register(runningInput); const runningChild = await detection(runningInput, "running");
    await registry().cancel(running.id, { ownerUserId: userId, callerId: runningInput.callerId });
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: runningChild.id } })).status).toBe("running");
    expect((await registry().get(running.id, { ownerUserId: userId, callerId: runningInput.callerId })).status).toBe("working");
  });
  test("shared render cancellation stops only this generation's pending variants", async () => {
    const input = await taskInput(); const row = await registry().register(input); const child = await detection(input, "completed");
    const otherChild = await detection(await taskInput(), "completed");
    const shared = await renderRun(child.id, "running");
    const pendingClip = await clip(child.id); const runningClip = await clip(child.id, 1); const otherClip = await clip(otherChild.id);
    const pending = await prisma.clipRender.create({ data: { clipId: pendingClip.id, aspectRatio: "ratio_9_16", status: "pending", workflowRunId: shared.id } });
    const running = await prisma.clipRender.create({ data: { clipId: runningClip.id, aspectRatio: "ratio_9_16", status: "rendering", workflowRunId: shared.id } });
    const other = await prisma.clipRender.create({ data: { clipId: otherClip.id, aspectRatio: "ratio_9_16", status: "pending", workflowRunId: shared.id } });
    await handoff(child.id, shared.id, [pending.id, running.id]);
    await registry().cancel(row.id, { ownerUserId: userId, callerId: input.callerId });
    expect((await prisma.clipRender.findUniqueOrThrow({ where: { id: pending.id } })).errorCode).toBe("MCP_CANCELLED");
    expect((await prisma.clipRender.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("rendering");
    expect((await prisma.clipRender.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("pending");
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: shared.id } })).status).toBe("running");
    expect(await getMcpTaskDomainState(row)).toEqual({ status: "working", cancelled: false });
    await prisma.clipRender.update({ where: { id: running.id }, data: { status: "completed" } });
    await event(shared.id, "clip_rendering", "running", { generationRenderResults: [{ renderId: running.id, status: "completed", errorCode: null }] });
    expect((await registry().get(row.id, { ownerUserId: userId, callerId: input.callerId })).status).toBe("cancelled");
  });
  test("durable child outcomes survive Studio cache reset and ignore unrelated shared drains", async () => {
    const input = await taskInput(); const row = await registry().register(input); const child = await detection(input, "running");
    const attemptId = randomUUID();
    await prisma.workflowRun.update({ where: { id: child.id }, data: { attemptId, attemptCount: 1, leaseOwner: "mcp-generation-history",
      leaseExpiresAt: new Date(Date.now() + 60_000) } });
    const generated = await clip(child.id);
    const lifecycle = new WorkflowRunLifecycle({ prisma, leaseOwner: "mcp-generation-history", publishRedis: async () => {} });
    const attempt = { projectId, workflowRunId: child.id, stage: "moment_detection" as const, attemptId, attemptCount: 1 };
    const admitted = await lifecycle.admitAutoRenderWork(attempt, { idempotencyKey: `auto-render-${child.id}`,
      renders: [{ clipId: generated.id, aspectRatio: "ratio_9_16", resolution: "1080p" }] });
    await lifecycle.completeMomentDetection(attempt);
    expect(await getMcpTaskDomainState(row)).toEqual({ status: "working", cancelled: false });
    const renderAttemptId = randomUUID();
    await prisma.workflowRun.update({ where: { id: admitted.id }, data: { status: "running", attemptId: renderAttemptId,
      attemptCount: 1, leaseOwner: "mcp-generation-history", leaseExpiresAt: new Date(Date.now() + 60_000) } });
    const renderAttempt = { projectId, workflowRunId: admitted.id, stage: "clip_rendering" as const, attemptId: renderAttemptId, attemptCount: 1 };
    const workSet = await lifecycle.beginRenderWorkSet(renderAttempt);
    const renderId = workSet.variantIds[0]!;
    expect(await lifecycle.markClipRenderVariantRendering(renderAttempt, renderId)).toBe(true);
    expect(await lifecycle.completeClipRenderVariant(renderAttempt, renderId, { storageKey: "private/test.mp4", sizeBytes: 100, durationSec: 30 })).toBe(true);
    // Original child outcomes settle even while a shared run remains active.
    expect(await getMcpTaskDomainState(row)).toEqual({ status: "completed", cancelled: false });
    await prisma.clipRender.update({ where: { id: renderId }, data: { status: "pending", storageKey: null, workflowRunId: null } });
    expect(await getMcpTaskDomainState(row)).toEqual({ status: "completed", cancelled: false });
    await registry().cancel(row.id, { ownerUserId: userId, callerId: input.callerId });
    expect((await prisma.clipRender.findUniqueOrThrow({ where: { id: renderId } })).status).toBe("pending");
    await prisma.workflowRun.update({ where: { id: admitted.id }, data: { status: "completed" } });
    const unrelatedDrain = await prisma.workflowRun.create({ data: { projectId, stage: "clip_rendering", status: "queued", idempotencyKey: `drain-${admitted.id}` } });
    expect(await getMcpTaskDomainState(row)).toEqual({ status: "completed", cancelled: false });
    await prisma.workflowRun.update({ where: { id: unrelatedDrain.id }, data: { status: "completed" } });
  });
  test("retryable child failure does not settle a Task before the later attempt succeeds", async () => {
    const input = await taskInput(); const row = await registry().register(input); const child = await detection(input, "completed");
    const work = await renderRun(child.id, "queued"); const generated = await clip(child.id);
    const render = await prisma.clipRender.create({ data: { clipId: generated.id, aspectRatio: "ratio_9_16", status: "pending", workflowRunId: work.id } });
    await handoff(child.id, work.id, [render.id]);
    const lifecycle = new WorkflowRunLifecycle({ prisma, leaseOwner: "mcp-generation-retry", publishRedis: async () => {} });
    const first = await lifecycle.claim("clip_rendering");
    if (!first) throw new Error("Expected queued render claim");
    await lifecycle.beginRenderWorkSet(first);
    expect(await lifecycle.markClipRenderVariantRendering(first, render.id)).toBe(true);
    expect(await lifecycle.failClipRenderVariant(first, render.id, "temporary_provider_error", "retryable")).toBe(true);
    expect(await getMcpTaskDomainState(row)).toEqual({ status: "working", cancelled: false });
    expect((await registry().get(row.id, { ownerUserId: userId, callerId: input.callerId })).status).toBe("working");
    expect((await lifecycle.settleRenderWorkSet(first)).status).toBe("requeued");
    expect(await getMcpTaskDomainState(row)).toEqual({ status: "working", cancelled: false });
    await prisma.workflowRun.update({ where: { id: work.id }, data: { nextAttemptAt: null } });
    const second = await lifecycle.claim("clip_rendering");
    if (!second) throw new Error("Expected retry claim");
    await lifecycle.beginRenderWorkSet(second);
    expect(await lifecycle.markClipRenderVariantRendering(second, render.id)).toBe(true);
    expect(await lifecycle.completeClipRenderVariant(second, render.id, { storageKey: "private/retry.mp4", sizeBytes: 100, durationSec: 30 })).toBe(true);
    expect(await getMcpTaskDomainState(row)).toEqual({ status: "completed", cancelled: false });
  });
  test("permanent failure history survives later clip replacement before the first Task poll", async () => {
    const input = await taskInput(); const row = await registry().register(input); const child = await detection(input, "completed");
    const work = await renderRun(child.id, "running");
    const generated = await clip(child.id);
    const render = await prisma.clipRender.create({ data: { clipId: generated.id, aspectRatio: "ratio_9_16", status: "pending", workflowRunId: work.id } });
    await handoff(child.id, work.id, [render.id]);
    const attemptId = randomUUID();
    await prisma.workflowRun.update({ where: { id: work.id }, data: { attemptId, attemptCount: 1, leaseOwner: "mcp-generation-failure",
      leaseExpiresAt: new Date(Date.now() + 60_000) } });
    const lifecycle = new WorkflowRunLifecycle({ prisma, leaseOwner: "mcp-generation-failure", publishRedis: async () => {} });
    const attempt = { projectId, workflowRunId: work.id, stage: "clip_rendering" as const, attemptId, attemptCount: 1 };
    expect(await lifecycle.markClipRenderVariantRendering(attempt, render.id)).toBe(true);
    expect(await lifecycle.failClipRenderVariant(attempt, render.id, "render_failed", "permanent")).toBe(true);
    await prisma.clip.deleteMany({ where: { workflowRunId: child.id } });
    expect(await getMcpTaskDomainState(row)).toEqual({ status: "failed", cancelled: false });
  });
});
