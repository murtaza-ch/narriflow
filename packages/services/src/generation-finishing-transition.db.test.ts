import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@prisma/client";
import { processingCapacityFromEnv } from "./processing-usage-runtime";
import { Pool } from "pg";
import { freezeGenerationFinishing } from "./generation-finishing";
import { IngestJobLifecycle } from "./ingest-job-lifecycle";
import { queueFinishedGenerations } from "./operation-finished";
import { encodeOperationId } from "./operation-status";
import { ProcessingUsage } from "./processing-usage";
import { WorkflowFailure, WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { flushWorkspaceEvents, listWorkspaceEvents } from "./workspace-event";

/** Finishing's two hooks on the generation lifecycle, through the workflow
 * gate: the row is frozen in the handoff's admission transaction, and the
 * generation's settlement moves it in the same transaction that derives
 * `operation.finished`. */

const url = process.env.WORKFLOW_TEST_DATABASE_URL;
const schema = process.env.WORKFLOW_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_WORKFLOW_DB_TESTS === "1" && Boolean(url);
const dbDescribe = enabled ? describe : describe.skip;
setDefaultTimeout(180_000);

const PACK = {
  outputTypes: ["short_clip"], clipGenerationMode: "best", clipCountTarget: 3, clipDurationSecTarget: 45, minDurationSec: 15,
  preferredMinDurationSec: 30, preferredMaxDurationSec: 60, maxDurationSec: 90, platformTargets: ["tiktok"], toneConstraints: [],
  captionPreset: "brand_default", platformPlaybookVersion: "test", mode: "clip", autoHook: true, specificMoments: "",
  processingStartSec: null, processingEndSec: null, clipLengthPreset: "auto", defaultAspectRatio: "9:16",
} as const;
const FINISHING = { topClips: 2, minScore: 40, copyPlatforms: ["tiktok"], resolution: "1080p", delivery: "ready_to_review" } as const;

dbDescribe("Finishing hooks on the generation lifecycle", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  const globals = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
  let previousGlobalPrisma: PrismaClient | undefined;

  beforeAll(() => {
    if (!url || !schema?.startsWith("workflow_lifecycle_test_")) throw new Error("Finishing tests require a disposable workflow schema");
    pool = new Pool({ connectionString: url, max: 8 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), transactionOptions: { maxWait: 60_000, timeout: 60_000 } });
    previousGlobalPrisma = globals.narriflowPrismaClient;
    globals.narriflowPrismaClient = prisma;
  });
  beforeEach(async () => {
    await prisma.workspace.deleteMany({ where: { owner: { clerkId: { startsWith: "finishing-transition:" } } } });
    await prisma.user.deleteMany({ where: { clerkId: { startsWith: "finishing-transition:" } } });
  });
  afterAll(async () => {
    globals.narriflowPrismaClient = previousGlobalPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function fixture() {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { clerkId: `finishing-transition:${suffix}` } });
    const workspace = await prisma.workspace.create({ data: { name: "Finishing", ownerUserId: user.id, pricingTier: "business", members: { create: { userId: user.id, role: "owner" } } } });
    const project = await prisma.project.create({ data: { title: "Finishing", sourceMediaUrl: "r2://test/source.mp4", workspaceId: workspace.id, createdByUserId: user.id, ingestStatus: "ready", sourceDurationSeconds: 60 } });
    return { user, workspace, project };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const settledUsage = (f: Fixture) => prisma.processingUsageReservation.create({ data: { projectId: f.project.id, workspaceId: f.workspace.id, intakeKind: "link",
    periodStart: new Date(Date.UTC(2026, 0, 1)), reservedSeconds: 60, settledSeconds: 60, state: "settled" } });
  const workflow = () => new WorkflowRunLifecycle({ prisma, leaseOwner: randomUUID() });
  const feed = async (workspaceId: string) => (await listWorkspaceEvents(prisma, { workspaceId }, { limit: 200 })).data;
  const finishingRow = (originRunId: string) => prisma.generationFinishing.findUniqueOrThrow({ where: { originRunId } });
  const freeze = (f: Fixture, originRunId: string, settings: Parameters<typeof freezeGenerationFinishing>[1]["settings"] = FINISHING) =>
    prisma.$transaction((tx) => freezeGenerationFinishing(tx, { workspaceId: f.workspace.id, projectId: f.project.id, originRunId, actorUserId: f.user.id, settings, defaultAspectRatio: "9:16" }));

  async function clip(projectId: string, workflowRunId: string, index: number) {
    return prisma.clip.create({ data: { projectId, workflowRunId, index, startSec: 0, endSec: 10, hookText: `Clip ${index}`, reasoning: "Fixture", category: "hook",
      transcriptSlice: [], viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50, durationOptimalityScore: 50,
      tiktokScore: 50, youtubeScore: 50, instagramScore: 50, llmProvider: "test", llmModel: "test" } });
  }
  const admitStt = (lifecycle: WorkflowRunLifecycle, projectId: string) => lifecycle.admitTranscript({ projectId, idempotencyKey: `stt:${randomUUID()}`,
    languageCode: "en", transcriptProvider: "assemblyai", transcriptProviderModel: "test", contentPack: PACK as never });
  const done = { storageKey: "projects/test/render.mp4", sizeBytes: 1024, durationSec: 10 };

  /** A finishing-bearing generation, transcribed and detected, with its renders claimed. */
  async function rendering(f: Fixture, clipCount: number) {
    await settledUsage(f);
    const lifecycle = workflow();
    const stt = await admitStt(lifecycle, f.project.id);
    await freeze(f, stt.id);
    const attempt = await lifecycle.claim("stt");
    await lifecycle.completeTranscript(attempt!, { provider: "assemblyai", providerModel: "test", providerJobId: null, languageCode: "en", languageConfidence: 1,
      text: "transcript", utterances: [] as Prisma.InputJsonValue, speakerCount: 1, durationSeconds: 10, rawStorageKey: null });
    const detection = (await lifecycle.claim("moment_detection"))!;
    const clips = await Promise.all(Array.from({ length: clipCount }, (_, index) => clip(f.project.id, detection.workflowRunId, index)));
    await lifecycle.admitAutoRenderWork(detection, { idempotencyKey: `auto-render-${detection.workflowRunId}`,
      renders: clips.map((row) => ({ clipId: row.id, aspectRatio: "ratio_9_16", status: "pending", resolution: "1080p" })) as never });
    await lifecycle.completeMomentDetection(detection);
    const renderer = workflow();
    const render = (await renderer.claim("clip_rendering"))!;
    await renderer.beginRenderWorkSet(render);
    const renders = await prisma.clipRender.findMany({ where: { clipId: { in: clips.map((row) => row.id) } }, orderBy: { createdAt: "asc" } });
    return { stt, renderer, render, renders };
  }

  test("the handoff freezes finishing once for the generation it admits, and replays find the same row", async () => {
    const f = await fixture();
    await prisma.ingestJob.create({ data: { projectId: f.project.id, jobType: "link_import", payload: {}, status: "completed", completedAt: new Date() } });
    const job = await prisma.ingestJob.findFirstOrThrow({ where: { projectId: f.project.id } });
    await prisma.processingUsageReservation.create({ data: { projectId: f.project.id, workspaceId: f.workspace.id, intakeKind: "link",
      periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)), reservedSeconds: 60, state: "reserved" } });
    await prisma.contentPack.create({ data: { projectId: f.project.id, outputTypes: ["short_clip"], clipGenerationMode: "best", clipCountTarget: 3, clipDurationSecTarget: 45,
      platformTargets: ["tiktok"], toneConstraints: [], captionPreset: "brand_default", platformPlaybookVersion: "test", defaultAspectRatio: "1:1",
      finishing: { topClips: 2, minScore: 40, copyPlatforms: ["tiktok"], resolution: "1080p", delivery: "ready_to_review" } } });
    const lifecycle = new IngestJobLifecycle({ prisma, workflow: workflow(), usage: new ProcessingUsage({ prisma, capacityLimits: processingCapacityFromEnv({}), log: () => {} }),
      requireRetryActor: async () => {}, sourceBucket: "finishing-test" });

    expect(await lifecycle.processGenerationHandoffs(1, job.id)).toBe(1);
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId: f.project.id, stage: "stt" } });
    const row = await finishingRow(run.id);
    expect(row).toMatchObject({ workspaceId: f.workspace.id, projectId: f.project.id, actorUserId: f.user.id, state: "waiting", reason: null, picks: null });
    // The format is resolved from the generation's own default, not a global one.
    expect(row.settings).toEqual({ topClips: 2, minScore: 40, copyPlatforms: ["tiktok"], resolution: "1080p", delivery: "ready_to_review", queueAccountIds: [], aspectRatios: ["1:1"] });

    // A replay of the handoff, and a second freeze for the same generation, change nothing.
    expect(await lifecycle.processGenerationHandoffs(1, job.id)).toBe(0);
    await freeze(f, run.id, { topClips: 9, minScore: 0, copyPlatforms: [], resolution: "720p", delivery: "ready_to_review" });
    expect(await prisma.generationFinishing.count({ where: { projectId: f.project.id } })).toBe(1);
    expect((await finishingRow(run.id)).settings).toEqual(row.settings);
  });

  test("the finishing row records the Autopilot rule only when the pack's import named one", async () => {
    const handoff = async (autopilotRuleId: string | null) => {
      const f = await fixture();
      const job = await prisma.ingestJob.create({ data: { projectId: f.project.id, jobType: "link_import", payload: {}, status: "completed", completedAt: new Date() } });
      await prisma.processingUsageReservation.create({ data: { projectId: f.project.id, workspaceId: f.workspace.id, intakeKind: "link",
        periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)), reservedSeconds: 60, state: "reserved" } });
      await prisma.contentPack.create({ data: { projectId: f.project.id, outputTypes: ["short_clip"], clipGenerationMode: "best", clipCountTarget: 3, clipDurationSecTarget: 45,
        platformTargets: ["tiktok"], toneConstraints: [], captionPreset: "brand_default", platformPlaybookVersion: "test", defaultAspectRatio: "1:1", autopilotRuleId,
        finishing: { topClips: 2, minScore: 40, copyPlatforms: [], resolution: "1080p", delivery: "ready_to_review" } } });
      const lifecycle = new IngestJobLifecycle({ prisma, workflow: workflow(), usage: new ProcessingUsage({ prisma, capacityLimits: processingCapacityFromEnv({}), log: () => {} }),
        requireRetryActor: async () => {}, sourceBucket: "finishing-test" });
      expect(await lifecycle.processGenerationHandoffs(1, job.id)).toBe(1);
      const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId: f.project.id, stage: "stt" } });
      return finishingRow(run.id);
    };
    const ruleId = randomUUID();
    // The Autopilot import names its rule on the pack; a request's settings never do, so a grant covers only the former.
    expect(await handoff(ruleId)).toMatchObject({ autopilotRuleId: ruleId });
    expect(await handoff(null)).toMatchObject({ autopilotRuleId: null });
  });

  test("only a generation's speech-to-text run can carry finishing", async () => {
    const f = await fixture();
    const detection = await prisma.workflowRun.create({ data: { projectId: f.project.id, stage: "moment_detection", status: "queued", idempotencyKey: `detect:${randomUUID()}` } });
    await expect(freeze(f, detection.id)).rejects.toMatchObject({ code: "finishing_origin_invalid" });
    const other = await fixture();
    const stt = await prisma.workflowRun.create({ data: { projectId: other.project.id, stage: "stt", status: "queued", idempotencyKey: `stt:${randomUUID()}` } });
    // Nor one that belongs to another Project.
    await expect(freeze(f, stt.id)).rejects.toMatchObject({ code: "finishing_origin_invalid" });
    expect(await prisma.generationFinishing.count({ where: { projectId: { in: [f.project.id, other.project.id] } } })).toBe(0);
    await freeze(other, stt.id);
    expect(await prisma.generationFinishing.count({ where: { projectId: other.project.id } })).toBe(1);
  });

  /** A ready Project whose committed pack asks for finishing, with a handoff waiting and a generation for that pack already admitted by another path. */
  async function preAdmitted(runStatus: "queued" | "failed", existingFinishing?: Parameters<typeof freeze>[2]) {
    const f = await fixture();
    const job = await prisma.ingestJob.create({ data: { projectId: f.project.id, jobType: "link_import", payload: {}, status: "completed", completedAt: new Date() } });
    const pack = await prisma.contentPack.create({ data: { projectId: f.project.id, outputTypes: ["short_clip"], clipGenerationMode: "best", clipCountTarget: 3, clipDurationSecTarget: 45,
      platformTargets: ["tiktok"], toneConstraints: [], captionPreset: "brand_default", platformPlaybookVersion: "test", defaultAspectRatio: "16:9",
      finishing: { topClips: 2, minScore: 40, copyPlatforms: [], resolution: "1080p", delivery: "ready_to_review" } } });
    const run = await prisma.workflowRun.create({ data: { projectId: f.project.id, stage: "stt", status: runStatus, errorCode: runStatus === "failed" ? "transcription_failed" : null,
      idempotencyKey: `other-path:${randomUUID()}`, contentPackId: pack.id } });
    if (existingFinishing) await freeze(f, run.id, existingFinishing);
    const lifecycle = new IngestJobLifecycle({ prisma, workflow: workflow(), usage: new ProcessingUsage({ prisma, capacityLimits: processingCapacityFromEnv({}), log: () => {} }),
      requireRetryActor: async () => {}, sourceBucket: "finishing-test" });
    return { f, job, run, lifecycle };
  }

  test("a handoff that finds its generation already admitted still freezes the intake's finishing", async () => {
    const { f, job, run, lifecycle } = await preAdmitted("queued");
    expect(await lifecycle.processGenerationHandoffs(1, job.id)).toBe(1);
    expect((await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).generationRunId).toBe(run.id);
    const row = await finishingRow(run.id);
    expect(row).toMatchObject({ state: "waiting", actorUserId: f.user.id });
    expect(row.settings).toEqual({ topClips: 2, minScore: 40, copyPlatforms: [], resolution: "1080p", delivery: "ready_to_review", queueAccountIds: [], aspectRatios: ["16:9"] });
  });

  test("and when that generation has already failed, the frozen row is skipped at once with its event", async () => {
    const { f, job, run, lifecycle } = await preAdmitted("failed");
    expect(await lifecycle.processGenerationHandoffs(1, job.id)).toBe(1);
    expect(await finishingRow(run.id)).toMatchObject({ state: "skipped", reason: "generation_failed" });
    const events = await feed(f.workspace.id);
    expect(events.filter((event) => event.type === "finishing.finished").map((event) => event.subject)).toMatchObject([{ state: "skipped", reason: "generation_failed", exportIds: [] }]);
  });

  test("a generation another path already froze different finishing onto keeps it; the handoff still settles", async () => {
    const { job, run, lifecycle } = await preAdmitted("queued", { topClips: 9, minScore: 0, copyPlatforms: ["x"], resolution: "720p", delivery: "ready_to_review" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await lifecycle.processGenerationHandoffs(1, job.id)).toBe(1);
      expect(warn.mock.calls.some(([line]) => String(line).includes("ingest_finishing_conflict_ignored"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect((await finishingRow(run.id)).settings).toMatchObject({ topClips: 9, resolution: "720p" });
    // The path that froze it first named no rule, and the intake can't add one afterwards.
    expect((await finishingRow(run.id)).autopilotRuleId).toBeNull();
    expect((await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).generationRunId).toBe(run.id);
  });

  test("a handoff without finishing creates no row", async () => {
    const f = await fixture();
    const job = await prisma.ingestJob.create({ data: { projectId: f.project.id, jobType: "link_import", payload: {}, status: "completed", completedAt: new Date() } });
    await prisma.processingUsageReservation.create({ data: { projectId: f.project.id, workspaceId: f.workspace.id, intakeKind: "link",
      periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)), reservedSeconds: 60, state: "reserved" } });
    await prisma.contentPack.create({ data: { projectId: f.project.id, outputTypes: ["short_clip"], clipGenerationMode: "best", clipCountTarget: 3, clipDurationSecTarget: 45,
      platformTargets: ["tiktok"], toneConstraints: [], captionPreset: "brand_default", platformPlaybookVersion: "test" } });
    const lifecycle = new IngestJobLifecycle({ prisma, workflow: workflow(), usage: new ProcessingUsage({ prisma, capacityLimits: processingCapacityFromEnv({}), log: () => {} }),
      requireRetryActor: async () => {}, sourceBucket: "finishing-test" });
    expect(await lifecycle.processGenerationHandoffs(1, job.id)).toBe(1);
    expect(await prisma.generationFinishing.count({ where: { projectId: f.project.id } })).toBe(0);
  });

  test("a completed generation makes finishing due in the settling transaction, and a replay changes nothing", async () => {
    const f = await fixture();
    const { stt, renderer, render, renders } = await rendering(f, 1);
    expect((await finishingRow(stt.id)).state).toBe("waiting");
    await renderer.markClipRenderVariantRendering(render, renders[0]!.id);
    await renderer.completeClipRenderVariant(render, renders[0]!.id, done);
    // Not until the generation settles.
    expect((await finishingRow(stt.id)).state).toBe("waiting");
    await renderer.settleRenderWorkSet(render);

    const due = await finishingRow(stt.id);
    expect(due.state).toBe("due");
    expect(due.dueAt).not.toBeNull();
    expect(due.finishedAt).toBeNull();
    // Due is not an outcome: only the generation's own event is written.
    expect((await feed(f.workspace.id)).map((event) => event.type)).toEqual(["operation.finished"]);

    await renderer.settleRenderWorkSet(render);
    await prisma.$transaction(async (tx) => {
      await queueFinishedGenerations(tx, { id: render.workflowRunId, projectId: f.project.id });
      await flushWorkspaceEvents(tx);
    });
    expect((await finishingRow(stt.id)).dueAt).toEqual(due.dueAt);
  });

  test("a partial generation also makes finishing due", async () => {
    const f = await fixture();
    const { stt, renderer, render, renders } = await rendering(f, 2);
    await renderer.markClipRenderVariantRendering(render, renders[0]!.id);
    await renderer.completeClipRenderVariant(render, renders[0]!.id, done);
    await renderer.markClipRenderVariantRendering(render, renders[1]!.id);
    await renderer.failClipRenderVariant(render, renders[1]!.id, "source_invalid", "permanent");
    await renderer.settleRenderWorkSet(render);
    expect((await finishingRow(stt.id)).state).toBe("due");
    expect((await feed(f.workspace.id)).map((event) => event.subject)).toMatchObject([{ state: "partial" }]);
  });

  test("a failed generation skips finishing with that reason and writes its one finishing.finished", async () => {
    const f = await fixture();
    await settledUsage(f);
    const lifecycle = workflow();
    const stt = await admitStt(lifecycle, f.project.id);
    await freeze(f, stt.id);
    const attempt = await lifecycle.claim("stt");
    await lifecycle.failAttempt(attempt!, new WorkflowFailure("transcription_failed", "permanent", "no audio"));

    const skipped = await finishingRow(stt.id);
    expect(skipped).toMatchObject({ state: "skipped", reason: "generation_failed" });
    expect(skipped.finishedAt).not.toBeNull();
    const events = await feed(f.workspace.id);
    expect(events.map((event) => event.type)).toEqual(["operation.finished", "finishing.finished"]);
    expect(events[1]!.subject).toEqual({
      projectId: f.project.id,
      operation: { kind: "generation", id: encodeOperationId({ kind: "generation", id: stt.id }) },
      state: "skipped",
      reason: "generation_failed",
      exportIds: [],
    });

    // Re-deriving the lineage finds the finished row and the claimed event key.
    await prisma.$transaction(async (tx) => {
      await queueFinishedGenerations(tx, { id: stt.id, projectId: f.project.id });
      await flushWorkspaceEvents(tx);
    });
    expect(await feed(f.workspace.id)).toHaveLength(2);
  });

  test("a cancelled generation skips finishing as cancelled", async () => {
    const f = await fixture();
    await settledUsage(f);
    const stt = await admitStt(workflow(), f.project.id);
    await freeze(f, stt.id);
    expect(await workflow().cancelQueuedGenerationOperation({ workspaceId: f.workspace.id, projectId: f.project.id, workflowRunId: stt.id })).toBe(true);
    expect(await finishingRow(stt.id)).toMatchObject({ state: "skipped", reason: "generation_cancelled" });
    expect((await feed(f.workspace.id)).map((event) => event.type)).toEqual(["operation.finished", "finishing.finished"]);
  });

  test("a generation that did not ask for finishing is unaffected", async () => {
    const f = await fixture();
    await settledUsage(f);
    const lifecycle = workflow();
    await admitStt(lifecycle, f.project.id);
    const attempt = await lifecycle.claim("stt");
    await lifecycle.failAttempt(attempt!, new WorkflowFailure("transcription_failed", "permanent", "no audio"));
    expect(await prisma.generationFinishing.count({ where: { projectId: f.project.id } })).toBe(0);
    expect((await feed(f.workspace.id)).map((event) => event.type)).toEqual(["operation.finished"]);
  });
});
