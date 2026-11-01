import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { bindServiceTestEnvironment } from "./runtime-test-support";
import { clipExportService } from "./clip-export.service";
import { withExecutionDispatches } from "./execution-dispatch-runtime";
import { RenderFixtureLifecycle } from "./render-group-test-fixture";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Clip Export atomic scheduler handoff", () => {
  let db: PrismaClient;
  const context = createDatabaseTestContext();
  const scoped = <T>(run: () => Promise<T>) => bindServiceTestEnvironment(context.bind(run))();
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url, schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5 }, { schema }), transactionOptions: { timeout: 30_000, maxWait: 10_000 } });
    context.client = db;
  });
  afterAll(async () => { await db?.$disconnect(); });
  async function fixture() {
    const user = await db.user.create({ data: { clerkId: `export-handoff:${crypto.randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { name: "Export handoff", ownerUserId: user.id, personalOwnerUserId: user.id, pricingTier: "creator", members: { create: { userId: user.id, role: "owner" } } } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, createdByUserId: user.id, title: "Export handoff", ingestStatus: "ready", sourceMediaUrl: "r2://fixture/source", sourceStorageKey: "fixture/source", sourceDurationSeconds: 30 } });
    const origin = await db.workflowRun.create({ data: { projectId: project.id, stage: "moment_detection", status: "completed", idempotencyKey: crypto.randomUUID() } });
    const clip = await db.clip.create({ data: { projectId: project.id, workflowRunId: origin.id, index: 0, startSec: 0, endSec: 10, hookText: "Export", reasoning: "Fixture", category: "hook", transcriptSlice: [],
      viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50, durationOptimalityScore: 50, tiktokScore: 50, youtubeScore: 50, instagramScore: 50, llmProvider: "fixture", llmModel: "fixture" } });
    const scope = { actorUserId: user.id, workspaceId: workspace.id }, key = crypto.randomUUID();
    const create = () => clipExportService.create(scope, project.id, clip.id, { expectedRevision: 0, aspectRatios: ["9:16"], resolution: "720p" }, key);
    return { user, workspace, project, clip, key, create, lifecycle: new RenderFixtureLifecycle({ prisma: db }) };
  }
  test("create commits exact render membership and initial dispatch before registration; same-key replay recollects it", () => scoped(async () => {
    const f = await fixture();
    let deliveries = 0;
    const deliver = async (ids: readonly string[]) => {
      const exported = await db.clipExport.findFirstOrThrow({ where: { clipId: f.clip.id } });
      expect(exported.workflowRunId).not.toBeNull();
      const renders = await db.clipRender.findMany({ where: { clipId: f.clip.id } });
      expect(renders).toHaveLength(1);
      expect(renders[0]!.workflowRunId).toBe(exported.workflowRunId);
      const dispatch = await db.executionDispatch.findFirstOrThrow({ where: { kind: "render_run", subjectId: exported.workflowRunId! } });
      expect(ids).toContain(dispatch.id);
      deliveries++;
      if (deliveries === 1) throw Error("registration unavailable");
    };
    await expect(withExecutionDispatches(f.create, { database: db, deliver })).rejects.toThrow("registration unavailable");
    expect(deliveries).toBe(1);
    const before = await db.workflowRun.findFirstOrThrow({ where: { projectId: f.project.id, stage: "clip_rendering" } });
    const receipt = await db.operationReceipt.findFirstOrThrow({ where: { clientIdempotencyKey: f.key } });
    const replay = await withExecutionDispatches(f.create, { database: db, deliver });
    expect(replay).toMatchObject({ replayed: true, receiptId: receipt.id, export: { id: receipt.resourceId } });
    expect(deliveries).toBe(2);
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    expect(before.operationDeadlineAt?.getTime()).toBe((await db.clipExport.findUniqueOrThrow({ where: { id: receipt.resourceId } })).createdAt.getTime() + 45 * 60_000);
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectId: before.id } } })).toBe(0);
    expect(await db.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(1);
  }));
  async function orphan(f: Awaited<ReturnType<typeof fixture>>) {
    const accepted = await f.create();
    const exported = await db.clipExport.findUniqueOrThrow({ where: { id: accepted.export.id } });
    await db.clipRender.updateMany({ where: { clipId: f.clip.id }, data: { workflowRunId: null } });
    await db.clipExport.update({ where: { id: exported.id }, data: { workflowRunId: null } });
    await db.executionDispatch.deleteMany({ where: { subjectId: exported.workflowRunId! } });
    await db.workflowRun.delete({ where: { id: exported.workflowRunId! } });
    return { accepted, exported };
  }
  test("same-key recovery of accepted unowned work keeps original identity and absolute budget", () => scoped(async () => {
    const f = await fixture(), old = await orphan(f);
    let delivered: readonly string[] = [];
    const replay = await withExecutionDispatches(f.create, { database: db, deliver: async ids => { delivered = ids; } });
    expect(replay).toMatchObject({ receiptId: old.accepted.receiptId, replayed: true, export: { id: old.exported.id } });
    const exported = await db.clipExport.findUniqueOrThrow({ where: { id: old.exported.id } });
    const run = await db.workflowRun.findUniqueOrThrow({ where: { id: exported.workflowRunId! } });
    expect(run.operationDeadlineAt?.getTime()).toBe(old.exported.createdAt.getTime() + 45 * 60_000);
    expect(run.attemptCount).toBe(0);
    expect(delivered).toContain((await db.executionDispatch.findFirstOrThrow({ where: { subjectId: run.id, kind: "render_run" } })).id);
    expect(await db.clipExport.count({ where: { clipId: f.clip.id } })).toBe(1);
    expect(await db.operationReceipt.count({ where: { clientIdempotencyKey: f.key } })).toBe(1);
    const parent = await f.lifecycle.renderParent(run.id);
    await f.lifecycle.beginRenderWorkSet(parent);
    const group = await db.renderGroup.findFirstOrThrow({ where: { workflowRunId: run.id } });
    expect(group.operationDeadlineAt).toEqual(run.operationDeadlineAt);
  }));
  test("late unowned replay is truthfully terminal without a new run, attempt, charge or budget", () => scoped(async () => {
    const f = await fixture(), old = await orphan(f);
    await db.clipExport.update({ where: { id: old.exported.id }, data: { createdAt: new Date(Date.now() - 46 * 60_000) } });
    const replay = await f.create();
    expect(replay).toMatchObject({ receiptId: old.accepted.receiptId, replayed: true, export: { id: old.exported.id, status: "failed", errorCode: "operation_deadline_exceeded" } });
    expect(await db.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(0);
    expect(await db.clipRender.findFirstOrThrow({ where: { clipId: f.clip.id } })).toMatchObject({ status: "failed", failureDisposition: "permanent", workflowRunId: null, errorCode: "operation_deadline_exceeded" });
  }));
  test("frozen active work set stays immutable; its durable drain adopts the exact late export", () => scoped(async () => {
    const f = await fixture();
    const active = await f.lifecycle.admit({ projectId: f.project.id, stage: "clip_rendering", idempotencyKey: "existing-empty" });
    const parent = await f.lifecycle.renderParent(active.id);
    expect((await f.lifecycle.beginRenderWorkSet(parent)).variantIds).toEqual([]);
    const frozen = await db.workflowRun.findUniqueOrThrow({ where: { id: active.id } });
    let ids: readonly string[] = [];
    const accepted = await withExecutionDispatches(f.create, { database: db, deliver: async value => { ids = value; } });
    expect(await db.clipRender.findFirstOrThrow({ where: { clipId: f.clip.id } })).toMatchObject({ workflowRunId: null });
    expect((await db.workflowRun.findUniqueOrThrow({ where: { id: active.id } })).renderWorkSetFrozenAt).toEqual(frozen.renderWorkSetFrozenAt);
    expect(ids).toContain((await db.executionDispatch.findFirstOrThrow({ where: { subjectId: active.id, kind: "render_run" } })).id);
    const settled = await f.lifecycle.settleRenderWorkSet(parent);
    expect(settled.followUpWorkflowRunId).toBeTruthy();
    const follow = await f.lifecycle.renderParent(settled.followUpWorkflowRunId!);
    const work = await f.lifecycle.beginRenderWorkSet(follow);
    expect(work.variantIds).toEqual([(await db.clipRender.findFirstOrThrow({ where: { clipId: f.clip.id } })).id]);
    expect(await db.clipExport.findUniqueOrThrow({ where: { id: accepted.export.id } })).toMatchObject({ workflowRunId: follow.workflowRunId });
    expect((await db.renderGroup.findFirstOrThrow({ where: { workflowRunId: follow.workflowRunId } })).operationDeadlineAt?.getTime()).toBe((await db.clipExport.findUniqueOrThrow({ where: { id: accepted.export.id } })).createdAt.getTime() + 45 * 60_000);
    expect(await db.clipRender.count({ where: { workflowRunId: active.id } })).toBe(0);
  }));
  test("receipt persistence failure rolls back export, membership and initial dispatch together", () => scoped(async () => {
    const f = await fixture();
    context.client = db.$extends({ query: { operationReceipt: { create: async () => { throw Error("receipt persistence lost"); } } } }) as unknown as PrismaClient;
    try { await expect(f.create()).rejects.toThrow("receipt persistence lost"); } finally { context.client = db; }
    expect(await db.clipExport.count({ where: { clipId: f.clip.id } })).toBe(0);
    expect(await db.clipRender.count({ where: { clipId: f.clip.id } })).toBe(0);
    expect(await db.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(0);
  }));
  test("unowned acceptance from an older epoch cannot create current work", () => scoped(async () => {
    const f = await fixture(), old = await orphan(f);
    const epoch = await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    await db.clipExport.update({ where: { id: old.exported.id }, data: { createdAt: new Date(epoch.changedAt.getTime() - 1) } });
    await expect(f.create()).rejects.toThrow("render_admission_epoch_superseded");
    expect(await db.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(0);
  }));

  test("standalone render admission collects new and shared run obligations; terminal same-key replay creates nothing", () => scoped(async () => {
    const f = await fixture();
    const input = { projectId: f.project.id, idempotencyKey: "ordinary", variants: [{ clipId: f.clip.id, aspectRatio: "ratio_9_16" as const, resolution: "720p" }] };
    let deliveries = 0;
    const deliver = async (ids: readonly string[]) => { expect(ids.length).toBeGreaterThan(0); deliveries++; };
    const admitted = await withExecutionDispatches(() => f.lifecycle.admitClipRendering(input), { database: db, deliver });
    expect((await withExecutionDispatches(() => f.lifecycle.admitClipRendering({ ...input, idempotencyKey: "ordinary-shared" }), { database: db, deliver })).id).toBe(admitted.id);
    expect(deliveries).toBe(2);
    await db.clipRender.updateMany({ where: { clipId: f.clip.id }, data: { status: "completed", storageKey: "fixture/completed" } });
    await db.workflowRun.update({ where: { id: admitted.id }, data: { status: "completed" } });
    await f.lifecycle.admitClipRendering(input);
    expect(await db.clipRender.findFirstOrThrow({ where: { clipId: f.clip.id } })).toMatchObject({ status: "completed", storageKey: "fixture/completed" });
    expect(await db.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(1);
  }));

  test("an accepted receipt cannot admit work after retention or workspace access is revoked", () => scoped(async () => {
    const f = await fixture();await orphan(f);
    await db.project.update({ where: { id: f.project.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    await expect(f.create()).rejects.toMatchObject({ code: "project_not_found" });
    expect(await db.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(0);
  }));

  test("closed admission recovers only the exact already accepted receipt and preserves its original budget", () => scoped(async () => {
    const f = await fixture(), old = await orphan(f), fresh = await fixture();
    await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: false } });
    try {
      let deliveries = 0;
      const replay = await withExecutionDispatches(f.create, { database: db, deliver: async ids => { expect(ids.length).toBeGreaterThan(0); deliveries++; } });
      expect(replay).toMatchObject({ replayed: true, receiptId: old.accepted.receiptId, export: { id: old.exported.id } });
      const exported = await db.clipExport.findUniqueOrThrow({ where: { id: old.exported.id } });
      const run = await db.workflowRun.findUniqueOrThrow({ where: { id: exported.workflowRunId! } });
      expect(run.operationDeadlineAt?.getTime()).toBe(old.exported.createdAt.getTime() + 45 * 60_000);
      expect(run.attemptCount).toBe(0);
      await expect(db.$transaction(tx => f.lifecycle.handoffClipExportWithinTransaction(tx, old.exported.id, f.workspace.id, { id: old.accepted.receiptId, actorUserId: fresh.user.id }))).rejects.toThrow("render_receipt_recovery_invalid");
      await withExecutionDispatches(f.create, { database: db, deliver: async ids => { expect(ids.length).toBeGreaterThan(0); deliveries++; } });
      expect(deliveries).toBe(2);
      expect(await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toEqual(run);
      await expect(fresh.create()).rejects.toMatchObject({ code: "execution_admission_closed" });
      expect(await db.clipExport.count({ where: { clipId: fresh.clip.id } })).toBe(0);
    } finally { await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: true } }); }
  }));

  test("a lost explicit-retry parent cannot borrow an unrelated active run or its budget", () => scoped(async () => {
    const f = await fixture(), old = await orphan(f);
    await db.clipExport.update({ where: { id: old.exported.id }, data: { retryCount: 1 } });
    const unrelated = await f.lifecycle.admit({ projectId: f.project.id, stage: "clip_rendering", idempotencyKey: "unrelated" });
    const before = await db.workflowRun.findUniqueOrThrow({ where: { id: unrelated.id } });
    await expect(f.create()).rejects.toThrow("render_retry_handoff_missing");
    expect(await db.clipRender.findFirstOrThrow({ where: { clipId: f.clip.id } })).toMatchObject({ workflowRunId: null, status: "pending" });
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: unrelated.id } })).toEqual(before);
    expect(await db.renderGroup.count({ where: { workflowRunId: unrelated.id } })).toBe(0);
  }));

});
