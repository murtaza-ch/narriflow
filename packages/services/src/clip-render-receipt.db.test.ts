import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { bindServiceTestEnvironment } from "./runtime-test-support";
import { clipService } from "./clip.service";
import { workspaceService } from "./workspace.service";
import { campaignOperationService } from "./campaign-operation.service";
import { withExecutionDispatches } from "./execution-dispatch-runtime";
import { RenderFixtureLifecycle } from "./render-group-test-fixture";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Standalone render command receipts", () => {
  let db: PrismaClient;
  const context = createDatabaseTestContext();
  const scoped = <T>(run: () => Promise<T>) => bindServiceTestEnvironment(context.bind(run))();
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url, schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }, { schema }), transactionOptions: { timeout: 30_000, maxWait: 10_000 } });
    context.client = db;
  });
  afterAll(async () => { await db?.$disconnect(); });
  async function fixture() {
    const user = await db.user.create({ data: { clerkId: `render-receipt:${crypto.randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { name: "Render receipt", ownerUserId: user.id, personalOwnerUserId: user.id, pricingTier: "creator", members: { create: { userId: user.id, role: "owner" } } } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, createdByUserId: user.id, title: "Render receipt", ingestStatus: "ready", sourceMediaUrl: "r2://fixture/source", sourceStorageKey: "fixture/source", sourceDurationSeconds: 30 } });
    const origin = await db.workflowRun.create({ data: { projectId: project.id, stage: "moment_detection", status: "completed", idempotencyKey: crypto.randomUUID() } });
    const addClip = (index: number) => db.clip.create({ data: { projectId: project.id, workflowRunId: origin.id, index, startSec: 0, endSec: 10, hookText: "Export", reasoning: "Fixture", category: "hook", transcriptSlice: [],
      viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50, durationOptimalityScore: 50, tiktokScore: 50, youtubeScore: 50, instagramScore: 50, llmProvider: "fixture", llmModel: "fixture" } });
    const clip = await addClip(0), actor = { actorUserId: user.id, workspaceId: workspace.id };
    const trigger = (key: string, clipIds?: string[], ratios: ("9:16" | "1:1")[] = ["9:16"]) => clipService.triggerClipRendering(actor, project.id, key, clipIds, ratios, "720p");
    return { user, workspace, project, clip, actor, trigger, addClip, lifecycle: new RenderFixtureLifecycle({ prisma: db }) };
  }

  test("public direct render same-key alias cannot create a second charged group after terminal", () => scoped(async () => {
    const f = await fixture(), actor = { workspaceId: f.workspace.id, actorUserId: f.user.id };
    const trigger = (key: string) => clipService.triggerClipRendering(actor, f.project.id, key, undefined, ["9:16"], "720p");
    const first = await trigger("initial-key"), shared = await trigger("shared-key");
    expect(shared.workflowRunId).toBe(first.workflowRunId);
    const parent = await f.lifecycle.renderParent(first.workflowRunId);
    const member = (await f.lifecycle.beginRenderWorkSet(parent)).variantIds[0]!;
    await f.lifecycle.markClipRenderVariantRendering(parent, member);
    await f.lifecycle.completeClipRenderVariant(parent, member, { storageKey: "fixture/completed", sizeBytes: 1000, durationSec: 10 });
    expect((await f.lifecycle.settleRenderWorkSet(parent)).status).toBe("completed");
    const replay = await trigger("shared-key");
    const next = await f.lifecycle.renderParent(replay.workflowRunId);
    const replayMember = (await f.lifecycle.beginRenderWorkSet(next)).variantIds[0]!;
    await f.lifecycle.markClipRenderVariantRendering(next, replayMember);
    const groups = await db.renderGroup.findMany({ where: { workflowRun: { projectId: f.project.id } }, select: { chargedAttemptCount: true } });
    expect(groups.reduce((sum, group) => sum + group.chargedAttemptCount, 0)).toBe(1);
    expect(replay.workflowRunId).toBe(shared.workflowRunId);
  }));
  test("all-clips receipt freezes accepted selection/result and fingerprints only canonical caller input", () => scoped(async () => {
    const f = await fixture(), key = crypto.randomUUID();
    const accepted = await f.trigger(key);
    const later = await f.addClip(1);
    expect(await f.trigger(key)).toEqual(accepted);
    expect(await db.clipRender.count({ where: { clipId: later.id } })).toBe(0);
    const receipt = await db.operationReceipt.findFirstOrThrow({ where: { workspaceId: f.workspace.id, command: "render_clips" } });
    const stored = receipt.result as { selection: Array<{ id: string; clipId: string }>; response: typeof accepted };
    expect(stored.response).toEqual(accepted);expect(stored.selection.map(item => item.clipId)).toEqual([f.clip.id]);
    expect((await db.clipRender.findUniqueOrThrow({ where: { id: stored.selection[0]!.id } })).workflowRunId).toBe(accepted.workflowRunId);
    await expect(f.trigger(key, undefined, ["1:1"])).rejects.toMatchObject({ code: "operation_idempotency_conflict" });
    expect(await db.operationReceipt.count({ where: { workspaceId: f.workspace.id, command: "render_clips" } })).toBe(1);
  }));
  test("concurrent distinct keys retain their own receipt but share one admitted render run", () => scoped(async () => {
    const f = await fixture();
    const values = await Promise.all([f.trigger("one"), f.trigger("two"), f.trigger("three")]);
    expect(new Set(values.map(value => value.workflowRunId)).size).toBe(1);
    expect(await db.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(1);
    expect(await db.operationReceipt.count({ where: { workspaceId: f.workspace.id, command: "render_clips" } })).toBe(3);
    expect(await db.clipRender.count({ where: { clipId: f.clip.id } })).toBe(1);
  }));
  test("receipt failure rolls back selected membership, native run and initial dispatch", () => scoped(async () => {
    const f = await fixture();
    context.client = db.$extends({ query: { operationReceipt: { create: async () => { throw Error("receipt persistence lost"); } } } }) as unknown as PrismaClient;
    try { await expect(f.trigger("rollback")).rejects.toThrow("receipt persistence lost"); } finally { context.client = db; }
    expect(await db.clipRender.count({ where: { clipId: f.clip.id } })).toBe(0);
    expect(await db.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(0);
    expect(await db.operationReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  }));
  test("same receipt recollects registration while closed; a fresh render request still refuses", () => scoped(async () => {
    const f = await fixture(), accepted = await f.trigger("accepted");
    await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: false } });
    try {
      let delivered: readonly string[] = [];
      expect(await withExecutionDispatches(() => f.trigger("accepted"), { database: db, deliver: async ids => { delivered = ids; } })).toEqual(accepted);
      expect(delivered).toContain((await db.executionDispatch.findFirstOrThrow({ where: { kind: "render_run", subjectId: accepted.workflowRunId } })).id);
      await expect(f.trigger("fresh")).rejects.toMatchObject({ code: "execution_admission_closed" });
      expect(await db.operationReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    } finally { await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: true } }); }
  }));
  test("a caller lost before CampaignOperation result persistence resumes the same underlying receipt after terminal", () => scoped(async () => {
    const f = await fixture(), first = await f.trigger("initial"), key = crypto.randomUUID();
    const selected = () => campaignOperationService.renderSelected({ ...f.actor, projectId: f.project.id, pricingTier: "creator", idempotencyKey: key, clipIds: [f.clip.id], resolution: "720p", aspectRatios: ["9:16"], execute: ids => f.trigger(key, ids) });
    context.client = db.$extends({ query: { campaignOperation: { updateMany: async ({ args, query }) => {
      if (["completed", "partial", "failed"].includes(String(args.data.status))) throw Error("caller lost before campaign result");
      return query(args);
    } } } }) as unknown as PrismaClient;
    try { await expect(selected()).rejects.toThrow("caller lost before campaign result"); } finally { context.client = db; }
    const operation = await db.campaignOperation.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
    expect(operation.status).toBe("running");
    expect(await db.operationReceipt.count({ where: { workspaceId: f.workspace.id, command: "render_clips", clientIdempotencyKey: key } })).toBe(1);
    const parent = await f.lifecycle.renderParent(first.workflowRunId), member = (await f.lifecycle.beginRenderWorkSet(parent)).variantIds[0]!;
    await f.lifecycle.markClipRenderVariantRendering(parent, member);
    await f.lifecycle.completeClipRenderVariant(parent, member, { storageKey: "fixture/completed", sizeBytes: 1000, durationSec: 10 });await f.lifecycle.settleRenderWorkSet(parent);
    await db.campaignOperation.update({ where: { id: operation.id }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });
    const other = await db.user.create({ data: { clerkId: `render-receipt-other:${crypto.randomUUID()}` } });
    await db.workspaceMember.create({ data: { workspaceId: f.workspace.id, userId: other.id, role: "editor" } });
    await workspaceService.requireActor(other.id, f.workspace.id, "processing.consume");
    const pending = await db.campaignOperation.findUniqueOrThrow({ where: { id: operation.id } });
    await expect(campaignOperationService.renderSelected({ workspaceId: f.workspace.id, actorUserId: other.id, projectId: f.project.id, pricingTier: "creator", idempotencyKey: key, clipIds: [f.clip.id], resolution: "720p", aspectRatios: ["9:16"],
      execute: ids => clipService.triggerClipRendering({ workspaceId: f.workspace.id, actorUserId: other.id }, f.project.id, key, ids, ["9:16"], "720p"),
    })).rejects.toMatchObject({ code: "campaign_operation_forbidden", kind: "forbidden" });
    expect(await db.campaignOperation.findUniqueOrThrow({ where: { id: operation.id } })).toEqual(pending);
    expect(await db.operationReceipt.count({ where: { workspaceId: f.workspace.id, actorUserId: other.id } })).toBe(0);
    expect(await selected()).toMatchObject({ workflowRunId: first.workflowRunId, operationId: operation.id, replayed: true });
    expect(await db.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(1);
    expect((await db.renderGroup.findMany({ where: { workflowRunId: first.workflowRunId } })).reduce((sum, group) => sum + group.chargedAttemptCount, 0)).toBe(1);
  }));

  test("a new receipt joining a frozen run preserves its work set and drains the selected late member once", () => scoped(async () => {
    const f = await fixture(), active = await f.lifecycle.admit({ projectId: f.project.id, stage: "clip_rendering", idempotencyKey: "frozen-first" });
    const parent = await f.lifecycle.renderParent(active.id);
    expect((await f.lifecycle.beginRenderWorkSet(parent)).variantIds).toEqual([]);
    const accepted = await f.trigger("late-alias"), stored = await db.operationReceipt.findFirstOrThrow({ where: { workspaceId: f.workspace.id, command: "render_clips" } });
    expect(accepted.workflowRunId).toBe(active.id);
    const selection = (stored.result as { selection: Array<{ id: string }> }).selection;
    expect((await db.clipRender.findUniqueOrThrow({ where: { id: selection[0]!.id } })).workflowRunId).toBeNull();
    expect((await f.lifecycle.beginRenderWorkSet(parent)).variantIds).toEqual([]);
    const settled = await f.lifecycle.settleRenderWorkSet(parent), follow = await f.lifecycle.renderParent(settled.followUpWorkflowRunId!);
    let delivered: readonly string[] = [];
    expect(await withExecutionDispatches(() => f.trigger("late-alias"), { database: db, deliver: async ids => { delivered = ids; } })).toEqual(accepted);
    expect(delivered).toContain((await db.executionDispatch.findFirstOrThrow({ where: { kind: "render_run", subjectId: follow.workflowRunId } })).id);
    expect((await f.lifecycle.beginRenderWorkSet(follow)).variantIds).toEqual(selection.map(item => item.id));
    expect(await f.trigger("late-alias")).toEqual(accepted);
    expect(await db.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(2);
  }));

  test("reused ordinary cache IDs never redirect an old receipt to later accepted work", () => scoped(async () => {
    const f = await fixture(), original = await f.trigger("original"), parent = await f.lifecycle.renderParent(original.workflowRunId);
    await f.lifecycle.beginRenderWorkSet(parent);
    const late = await f.addClip(1);await f.trigger("late", [late.id]);
    const originalMember = await db.clipRender.findFirstOrThrow({ where: { clipId: f.clip.id } });
    await f.lifecycle.completeClipRenderVariant(parent, originalMember.id, { storageKey: "fixture/completed", sizeBytes: 1000, durationSec: 10 });
    const settled = await f.lifecycle.settleRenderWorkSet(parent), drain = await f.lifecycle.renderParent(settled.followUpWorkflowRunId!);
    await f.trigger("reset-original", [f.clip.id]);
    let collected: readonly string[] = [];
    expect(await withExecutionDispatches(() => f.trigger("original"), { database: db, deliver: async ids => { collected = ids; } })).toEqual(original);
    expect(collected).toEqual([]);
    await f.lifecycle.beginRenderWorkSet(drain);
    const lateMember = await db.clipRender.findFirstOrThrow({ where: { clipId: late.id } });
    await f.lifecycle.completeClipRenderVariant(drain, lateMember.id, { storageKey: "fixture/late-completed", sizeBytes: 1000, durationSec: 10 });
    // A newer request resets this same cache ID while another drain member is unfinished.
    await f.trigger("reset-late", [late.id]);
    collected = [];
    await withExecutionDispatches(() => f.trigger("late", [late.id]), { database: db, deliver: async ids => { collected = ids; } });
    expect(collected).toEqual([]);
    expect((await db.workflowRun.findUniqueOrThrow({ where: { id: drain.workflowRunId } })).status).toBe("waiting");
  }));

});
