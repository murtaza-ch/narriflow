import { RenderFixtureLifecycle } from "./render-group-test-fixture";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { clipExportService } from "./clip-export.service";

const databaseUrl = process.env.WORKFLOW_TEST_DATABASE_URL;
const databaseSchema = process.env.WORKFLOW_TEST_DATABASE_SCHEMA;
const dbDescribe = process.env.ALLOW_WORKFLOW_DB_TESTS === "1" && databaseUrl ? describe : describe.skip;
setDefaultTimeout(180_000);

dbDescribe("Manual Clip Export retry PostgreSQL invariants", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  const globals = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
  let previous: PrismaClient | undefined;
  const prefix = "clip-export-retry-db:";
  beforeAll(() => {
    if (!databaseUrl || !databaseSchema || !/^workflow_lifecycle_test_[a-z0-9_]+$/.test(databaseSchema)) {
      throw new Error("Manual retry tests require a disposable workflow schema");
    }
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: databaseSchema }),
      transactionOptions: { maxWait: 120_000, timeout: 120_000 } });
    previous = globals.narriflowPrismaClient;
    globals.narriflowPrismaClient = prisma;
  });
  beforeEach(async () => {
    await prisma.workspace.deleteMany({ where: { owner: { clerkId: { startsWith: prefix } } } });
    await prisma.user.deleteMany({ where: { clerkId: { startsWith: prefix } } });
  });
  afterAll(async () => { globals.narriflowPrismaClient = previous; await prisma?.$disconnect(); await pool?.end(); });

  async function fixture() {
    const user = await prisma.user.create({ data: { clerkId: `${prefix}${randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: {
      name: "Manual export retry", ownerUserId: user.id, personalOwnerUserId: user.id,
      pricingTier: "creator", members: { create: { userId: user.id, role: "owner" } },
    } });
    const project = await prisma.project.create({ data: {
      workspaceId: workspace.id, createdByUserId: user.id, title: "Retry test", ingestStatus: "ready",
      sourceMediaUrl: "r2://test/source.mp4", sourceDurationSeconds: 30,
    } });
    const oldAttemptId = randomUUID();
    const oldRun = await prisma.workflowRun.create({ data: {
      projectId: project.id, stage: "clip_rendering", status: "partial", attemptId: oldAttemptId,
      attemptCount: 3, idempotencyKey: randomUUID(), requestedCount: 2, succeededCount: 1, failedCount: 1,
    } });
    const clip = await prisma.clip.create({ data: {
      projectId: project.id, workflowRunId: oldRun.id, index: 0, startSec: 0, endSec: 10,
      hookText: "Retry clip", reasoning: "Test", category: "hook", transcriptSlice: [],
      viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50,
      durationOptimalityScore: 50, tiktokScore: 50, youtubeScore: 50, instagramScore: 50,
      llmProvider: "test", llmModel: "test",
    } });
    const exported = await prisma.clipExport.create({ data: {
      projectId: project.id, workspaceId: workspace.id, createdByUserId: user.id, clipId: clip.id,
      workflowRunId: oldRun.id, editorRevision: 0, fingerprint: randomUUID(),
      resolution: "720p", watermark: true, status: "partial_ready", progress: 100, completedAt: new Date(),
    } });
    const snapshot = { startSec: 0, endSec: 10, wholeSource: false, transcriptSlice: [],
      captionPreset: {}, studioEdits: {}, deletedRanges: [], brollUrl: null,
      editorDocumentVersion: 1, sceneBlocks: [], censorSegments: [], mediaMotions: [] };
    const success = await prisma.clipExportVariant.create({ data: {
      exportId: exported.id, aspectRatio: "ratio_9_16", resolution: "720p", watermark: true,
      status: "completed", storageKey: "tests/preserved.mp4", sizeBytes: 123n, durationSec: 10, completedAt: new Date(),
      render: { create: { clipId: clip.id, aspectRatio: "ratio_9_16", resolution: "720p", editorRevision: 0,
        clipSnapshot: snapshot, workflowRunId: oldRun.id, workflowAttemptId: oldAttemptId,
        status: "completed", storageKey: "tests/preserved.mp4", sizeBytes: 123n, durationSec: 10 } },
    }, include: { render: true } });
    const failed = await prisma.clipExportVariant.create({ data: {
      exportId: exported.id, aspectRatio: "ratio_1_1", resolution: "720p", watermark: true,
      status: "failed", errorCode: "render_output_invalid", completedAt: new Date(),
      // Stale result fields must also be cleared on both rows.
      storageKey: "tests/stale.mp4", sizeBytes: 9n, durationSec: 1,
      render: { create: { clipId: clip.id, aspectRatio: "ratio_1_1", resolution: "720p", editorRevision: 0,
        clipSnapshot: snapshot, workflowRunId: oldRun.id, workflowAttemptId: oldAttemptId,
        status: "failed", failureDisposition: "retryable", errorCode: "render_output_invalid",
        storageKey: "tests/stale.mp4", sizeBytes: 9n, durationSec: 1, startedAt: new Date(), completedAt: new Date() } },
    }, include: { render: true } });
    const scope = { workspaceId: workspace.id, actorUserId: user.id };
    const retry = () => clipExportService.retryFailed(scope, project.id, clip.id, exported.id);
    return { project, clip, exported, oldRun, success, failed, retry };
  }

  test("actual simultaneous retry requests detach failed lineage once, admit claimable work and preserve successful bytes", async () => {
    const f = await fixture();
    const snapshots = await Promise.all([f.retry(), f.retry(), f.retry()]);
    for (const snapshot of snapshots) expect(snapshot).toMatchObject({ status: "rendering", progress: 45 });
    const exported = await prisma.clipExport.findUniqueOrThrow({ where: { id: f.exported.id } });
    expect(exported).toMatchObject({ retryCount: 1, status: "rendering", progress: 45, completedAt: null, resolution: "720p", watermark: true });
    expect(exported.workflowRunId).not.toBe(f.oldRun.id);
    expect(await prisma.clipRender.findUniqueOrThrow({ where: { id: f.failed.render!.id } })).toMatchObject({
      workflowRunId: null, workflowAttemptId: null, failureDisposition: null, status: "pending",
      storageKey: null, sizeBytes: null, durationSec: null, startedAt: null, completedAt: null, errorCode: null,
      clipSnapshot: f.failed.render!.clipSnapshot, resolution: "720p", editorRevision: 0,
    });
    expect(await prisma.clipExportVariant.findUniqueOrThrow({ where: { id: f.failed.id } })).toMatchObject({
      status: "pending", storageKey: null, sizeBytes: null, durationSec: null, startedAt: null, completedAt: null,
    });
    expect(await prisma.clipExportVariant.findUniqueOrThrow({ where: { id: f.success.id }, include: { render: true } })).toEqual(f.success);
    const lifecycle = new RenderFixtureLifecycle({ prisma, leaseOwner: randomUUID() });
    expect(await lifecycle.rescuePendingClipRenderingRun()).toBeNull();
    const attempt = await lifecycle.claim("clip_rendering");
    if (!attempt) throw new Error("Manual retry must be claimable");
    expect(attempt.workflowRunId).toBe(exported.workflowRunId!);
    expect((await lifecycle.beginRenderWorkSet(attempt)).variantIds).toEqual([f.failed.render!.id]);
    await f.retry();
    expect(await lifecycle.markClipRenderVariantRendering(attempt, f.failed.render!.id)).toBe(true);
    const active = await prisma.clipRender.findUniqueOrThrow({ where: { id: f.failed.render!.id } });
    await f.retry();
    expect(await prisma.clipRender.findUniqueOrThrow({ where: { id: active.id } })).toEqual(active);
    await lifecycle.completeClipRenderVariant(attempt, active.id, { storageKey: "tests/retried.mp4", sizeBytes: 456, durationSec: 10 });
    expect(await lifecycle.settleRenderWorkSet(attempt)).toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
    expect(await prisma.clipExport.findUniqueOrThrow({ where: { id: f.exported.id } })).toMatchObject({ status: "ready", progress: 100, retryCount: 1 });
    expect(await prisma.clipExportVariant.findUniqueOrThrow({ where: { id: f.success.id }, include: { render: true } })).toEqual(f.success);
    expect(await prisma.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(2);
  });

  test("an all-failed export can manually retry permanent failures with the same frozen outputs", async () => {
    const f = await fixture();
    await prisma.clipRender.update({ where: { id: f.success.render!.id }, data: { status: "failed", failureDisposition: "permanent", errorCode: "source_media_invalid" } });
    await prisma.clipExportVariant.update({ where: { id: f.success.id }, data: { status: "failed", errorCode: "source_media_invalid" } });
    await clipExportService.syncAggregate(f.exported.id);
    expect(await prisma.clipExport.findUniqueOrThrow({ where: { id: f.exported.id } })).toMatchObject({ status: "failed" });
    expect(await f.retry()).toMatchObject({ status: "queued", progress: 0 });
    const lifecycle = new RenderFixtureLifecycle({ prisma, leaseOwner: randomUUID() });
    const attempt = await lifecycle.claim("clip_rendering");
    if (!attempt) throw new Error("All-failed manual retry missing");
    const workSet = await lifecycle.beginRenderWorkSet(attempt);
    expect(workSet.variantIds.sort()).toEqual([f.failed.render!.id, f.success.render!.id].sort());
    for (const id of workSet.variantIds) {
      const render = await prisma.clipRender.findUniqueOrThrow({ where: { id } });
      expect(render).toMatchObject({ failureDisposition: null, workflowAttemptId: null, storageKey: null,
        resolution: "720p", clipSnapshot: f.failed.render!.clipSnapshot });
      await lifecycle.markClipRenderVariantRendering(attempt, id);
      await lifecycle.completeClipRenderVariant(attempt, id, { storageKey: `tests/manual-${id}.mp4`, sizeBytes: 456, durationSec: 10 });
    }
    expect(await lifecycle.settleRenderWorkSet(attempt)).toMatchObject({ status: "completed", succeeded: 2, failed: 0 });
    expect(await prisma.clipExport.findUniqueOrThrow({ where: { id: f.exported.id } })).toMatchObject({ status: "ready", retryCount: 1, watermark: true, resolution: "720p" });
  });

  test("a delayed retry cannot reset a failed child still owned by a live automatic retry", async () => {
    const f = await fixture();
    await prisma.workflowRun.update({ where: { id: f.oldRun.id }, data: { status: "queued", attemptCount: 1, nextAttemptAt: new Date(Date.now() + 30_000) } });
    const original = await prisma.clipRender.findUniqueOrThrow({ where: { id: f.failed.render!.id } });
    await Promise.all([f.retry(), f.retry()]);
    expect(await prisma.clipRender.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect(await prisma.clipExport.findUniqueOrThrow({ where: { id: f.exported.id } })).toEqual(f.exported);
  });

  test("a retry shares an active frozen run's normal drain follow-up without expanding its work set", async () => {
    const f = await fixture();
    const lifecycle = new RenderFixtureLifecycle({ prisma, leaseOwner: randomUUID() });
    await lifecycle.admit({ projectId: f.project.id, stage: "clip_rendering", idempotencyKey: "active-before-retry" });
    const attempt = await lifecycle.claim("clip_rendering");
    if (!attempt) throw new Error("Active run missing");
    expect((await lifecycle.beginRenderWorkSet(attempt)).variantIds).toEqual([]);
    await f.retry();
    expect((await lifecycle.beginRenderWorkSet(attempt)).variantIds).toEqual([]);
    const settled = await lifecycle.settleRenderWorkSet(attempt);
    expect(settled.followUpWorkflowRunId).toBeTruthy();
    const followUp = await lifecycle.claim("clip_rendering");
    if (!followUp) throw new Error("Retry follow-up missing");
    expect(followUp.workflowRunId).toBe(settled.followUpWorkflowRunId!);
    expect((await lifecycle.beginRenderWorkSet(followUp)).variantIds).toEqual([f.failed.render!.id]);
  });

  test("failed admission rolls back retry count, child resets, aggregates and outbox", async () => {
    const f = await fixture();
    await prisma.$executeRawUnsafe(`CREATE FUNCTION "${databaseSchema}".reject_manual_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'manual retry rejected'; END; $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_manual_retry BEFORE INSERT ON "${databaseSchema}"."WorkflowRun" FOR EACH ROW EXECUTE FUNCTION "${databaseSchema}".reject_manual_retry()`);
    try {
      await expect(f.retry()).rejects.toThrow("manual retry rejected");
      expect(await prisma.clipExport.findUniqueOrThrow({ where: { id: f.exported.id } })).toEqual(f.exported);
      expect(await prisma.clipExportVariant.findUniqueOrThrow({ where: { id: f.failed.id }, include: { render: true } })).toEqual(f.failed);
      expect(await prisma.workflowEvent.count({ where: { projectId: f.project.id } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER reject_manual_retry ON "${databaseSchema}"."WorkflowRun"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION "${databaseSchema}".reject_manual_retry()`);
    }
  });
});
