import { bindServiceTestEnvironment } from "./runtime-test-support";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { RenderFixtureLifecycle } from "./render-group-test-fixture";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { decodeClipEditorDocumentFromStorage, encodeClipEditorDocumentForStorage } from "./clip-editor-document-persistence";
import { clipExportService } from "./clip-export.service";

const databaseUrl = process.env.WORKFLOW_TEST_DATABASE_URL;
const databaseSchema = process.env.WORKFLOW_TEST_DATABASE_SCHEMA;
const dbDescribe = process.env.ALLOW_WORKFLOW_DB_TESTS === "1" && databaseUrl ? describe : describe.skip;
setDefaultTimeout(180_000);

dbDescribe("Manual Clip Export retry PostgreSQL invariants", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  const globals = createDatabaseTestContext();
  let previous: PrismaClient | undefined;
  const prefix = "clip-export-retry-db:";
  beforeAll(bindServiceTestEnvironment(globals.bind(() => {
    if (!databaseUrl || !databaseSchema || !/^workflow_lifecycle_test_[a-z0-9_]+$/.test(databaseSchema)) {
      throw new Error("Manual retry tests require a disposable workflow schema");
    }
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: databaseSchema }),
      transactionOptions: { maxWait: 120_000, timeout: 120_000 } });
    previous = globals.client;
    globals.client = prisma;
  })));
  beforeEach(bindServiceTestEnvironment(globals.bind(async () => {
    await prisma.workspace.deleteMany({ where: { owner: { clerkId: { startsWith: prefix } } } });
    await prisma.user.deleteMany({ where: { clerkId: { startsWith: prefix } } });
  })));
  afterAll(bindServiceTestEnvironment(globals.bind(async () => { globals.client = previous; await prisma?.$disconnect(); await pool?.end(); })));

  async function fixture(options: { liveAutomaticRetry?: boolean } = {}) {
    const user = await prisma.user.create({ data: { clerkId: `${prefix}${randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: {
      name: "Manual export retry", ownerUserId: user.id, personalOwnerUserId: user.id,
      pricingTier: "creator", members: { create: { userId: user.id, role: "owner" } },
    } });
    const project = await prisma.project.create({ data: {
      workspaceId: workspace.id, createdByUserId: user.id, title: "Retry test", ingestStatus: "ready",
      sourceMediaUrl: "r2://test/source.mp4", sourceDurationSeconds: 30,
    } });
    const lifecycle = new RenderFixtureLifecycle({ prisma });
    const admitted = await lifecycle.admit({ projectId: project.id, stage: "clip_rendering", idempotencyKey: randomUUID() });
    let oldRun = await prisma.workflowRun.findUniqueOrThrow({ where: { id: admitted.id } });
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
      resolution: "720p", watermark: true, status: "queued", progress: 0,
    } });
    const snapshot = JSON.parse(JSON.stringify({ ...clip, ...encodeClipEditorDocumentForStorage(decodeClipEditorDocumentFromStorage(clip, { durationSec: 30, wholeSource: false }), { durationSec: 30, wholeSource: false }) }));
    let success = await prisma.clipExportVariant.create({ data: {
      exportId: exported.id, aspectRatio: "ratio_9_16", resolution: "720p", watermark: true,
      status: "pending",
      render: { create: { clipId: clip.id, aspectRatio: "ratio_9_16", resolution: "720p", editorRevision: 0,
        clipSnapshot: snapshot, status: "pending" } },
    }, include: { render: true } });
    let failed = await prisma.clipExportVariant.create({ data: {
      exportId: exported.id, aspectRatio: "ratio_1_1", resolution: "720p", watermark: true,
      status: "pending",
      render: { create: { clipId: clip.id, aspectRatio: "ratio_1_1", resolution: "720p", editorRevision: 0,
        clipSnapshot: snapshot, status: "pending" } },
    }, include: { render: true } });
    const extra = options.liveAutomaticRetry ? await prisma.clipExportVariant.create({ data: {
      exportId: exported.id, aspectRatio: "ratio_4_5", resolution: "720p", watermark: true, status: "pending",
      render: { create: { clipId: clip.id, aspectRatio: "ratio_4_5", resolution: "720p", editorRevision: 0, clipSnapshot: snapshot, status: "pending" } },
    }, include: { render: true } }) : null;
    const parent = await lifecycle.renderParent(oldRun.id);await lifecycle.beginRenderWorkSet(parent);
    await lifecycle.markClipRenderVariantRendering(parent, success.render!.id);
    await lifecycle.completeClipRenderVariant(parent, success.render!.id, { storageKey: "server-assigned", sizeBytes: 123, durationSec: 10 });
    await lifecycle.failClipRenderVariant(parent, failed.render!.id, "render_output_invalid", options.liveAutomaticRetry ? "retryable" : "permanent");
    if (!options.liveAutomaticRetry) await lifecycle.settleRenderWorkSet(parent);
    oldRun = await prisma.workflowRun.findUniqueOrThrow({ where: { id: oldRun.id } });
    success = await prisma.clipExportVariant.findUniqueOrThrow({ where: { id: success.id }, include: { render: true } });
    // Deliberately stale result metadata must not survive a manual retry.
    await prisma.clipRender.update({ where: { id: failed.render!.id }, data: { storageKey: "tests/stale.mp4", sizeBytes: 9n, durationSec: 1 } });
    failed = await prisma.clipExportVariant.update({ where: { id: failed.id }, data: { storageKey: "tests/stale.mp4", sizeBytes: 9n, durationSec: 1 }, include: { render: true } });
    const scope = { workspaceId: workspace.id, actorUserId: user.id };
    const retry = () => clipExportService.retryFailed(scope, project.id, clip.id, exported.id);
    return { project, clip, exported: await prisma.clipExport.findUniqueOrThrow({ where: { id: exported.id } }), oldRun, success, failed, retry, lifecycle, parent, extra };
  }

  test("actual simultaneous retry requests detach failed lineage once, admit claimable work and preserve successful bytes", bindServiceTestEnvironment(globals.bind(async () => {
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
    expect(await prisma.executionDispatch.count({ where: { kind: "render_run", subjectId: exported.workflowRunId!, generation: 1, wakeKind: null } })).toBe(1);
    const attempt = await lifecycle.renderParent((await prisma.clipExport.findUniqueOrThrow({ where: { id: f.exported.id } })).workflowRunId!);
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
  })));

  test("an all-failed export can manually retry permanent failures with the same frozen outputs", bindServiceTestEnvironment(globals.bind(async () => {
    const f = await fixture();
    await prisma.clipRender.update({ where: { id: f.success.render!.id }, data: { status: "failed", failureDisposition: "permanent", errorCode: "source_media_invalid" } });
    await prisma.clipExportVariant.update({ where: { id: f.success.id }, data: { status: "failed", errorCode: "source_media_invalid" } });
    await clipExportService.syncAggregate(f.exported.id);
    expect(await prisma.clipExport.findUniqueOrThrow({ where: { id: f.exported.id } })).toMatchObject({ status: "failed" });
    expect(await f.retry()).toMatchObject({ status: "queued", progress: 0 });
    const lifecycle = new RenderFixtureLifecycle({ prisma, leaseOwner: randomUUID() });
    const attempt = await lifecycle.renderParent((await prisma.clipExport.findUniqueOrThrow({ where: { id: f.exported.id } })).workflowRunId!);
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
  })));

  test("a delayed retry cannot reset a failed child still owned by a live automatic retry", bindServiceTestEnvironment(globals.bind(async () => {
    const f = await fixture({ liveAutomaticRetry: true });
    const original = await prisma.clipRender.findUniqueOrThrow({ where: { id: f.failed.render!.id } });
    await Promise.all([f.retry(), f.retry()]);
    expect(await prisma.clipRender.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect(await prisma.clipExport.findUniqueOrThrow({ where: { id: f.exported.id } })).toEqual(f.exported);
    expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: f.oldRun.id } })).toMatchObject({ attemptCount: 0, attemptId: null, leaseOwner: null });
    const active = await prisma.renderGroup.findFirstOrThrow({ where: { workflowRunId: f.oldRun.id } });
    expect(active).toMatchObject({ status: "running", chargedAttemptCount: 1 });
    await f.lifecycle.completeClipRenderVariant(f.parent, f.extra!.render!.id, { storageKey: "server-assigned", sizeBytes: 123, durationSec: 10 });
    await f.lifecycle.settleRenderWorkSet(f.parent);await f.lifecycle.retryGroups(f.oldRun.id);
    await f.lifecycle.markClipRenderVariantRendering(f.parent, f.failed.render!.id);
    await f.lifecycle.completeClipRenderVariant(f.parent, f.failed.render!.id, { storageKey: "server-assigned", sizeBytes: 123, durationSec: 10 });
    await f.lifecycle.settleRenderWorkSet(f.parent);
  })));

  test("a retry shares an active frozen run's normal drain follow-up without expanding its work set", bindServiceTestEnvironment(globals.bind(async () => {
    const f = await fixture();
    const lifecycle = new RenderFixtureLifecycle({ prisma, leaseOwner: randomUUID() });
    const active = await lifecycle.admit({ projectId: f.project.id, stage: "clip_rendering", idempotencyKey: "active-before-retry" });
    const attempt = await lifecycle.renderParent(active.id);
    if (!attempt) throw new Error("Active run missing");
    expect((await lifecycle.beginRenderWorkSet(attempt)).variantIds).toEqual([]);
    await f.retry();
    expect((await lifecycle.beginRenderWorkSet(attempt)).variantIds).toEqual([]);
    const settled = await lifecycle.settleRenderWorkSet(attempt);
    expect(settled.followUpWorkflowRunId).toBeTruthy();
    const followUp = await lifecycle.renderParent(settled.followUpWorkflowRunId!);
    if (!followUp) throw new Error("Retry follow-up missing");
    expect(followUp.workflowRunId).toBe(settled.followUpWorkflowRunId!);
    expect((await lifecycle.beginRenderWorkSet(followUp)).variantIds).toEqual([f.failed.render!.id]);
  })));

  test("failed admission rolls back retry count, child resets, aggregates and outbox", bindServiceTestEnvironment(globals.bind(async () => {
    const f = await fixture();
    const eventCount = await prisma.workflowEvent.count({ where: { projectId: f.project.id } });
    await prisma.$executeRawUnsafe(`CREATE FUNCTION "${databaseSchema}".reject_manual_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'manual retry rejected'; END; $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_manual_retry BEFORE INSERT ON "${databaseSchema}"."WorkflowRun" FOR EACH ROW EXECUTE FUNCTION "${databaseSchema}".reject_manual_retry()`);
    try {
      await expect(f.retry()).rejects.toThrow("manual retry rejected");
      expect(await prisma.clipExport.findUniqueOrThrow({ where: { id: f.exported.id } })).toEqual(f.exported);
      expect(await prisma.clipExportVariant.findUniqueOrThrow({ where: { id: f.failed.id }, include: { render: true } })).toEqual(f.failed);
      expect(await prisma.workflowEvent.count({ where: { projectId: f.project.id } })).toBe(eventCount);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER reject_manual_retry ON "${databaseSchema}"."WorkflowRun"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION "${databaseSchema}".reject_manual_retry()`);
    }
  })));
});
