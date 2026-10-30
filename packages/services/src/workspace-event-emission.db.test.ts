import { RenderFixtureLifecycle } from "./render-group-test-fixture";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@prisma/client";
import { buildCaptionedVideoContentPack, buildCaptionedVideoSettings } from "@narriflow/validators";
import { Pool } from "pg";
import { clipExportService } from "./clip-export.service";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { IngestJobLifecycle } from "./ingest-job-lifecycle";
import { queueExportsFinishedByRun, queueFinishedGenerations, queueProjectExpiryFinished } from "./operation-finished";
import { createOperationStatusReader, encodeOperationId } from "./operation-status";
import { WorkflowFailure } from "./workflow-run-lifecycle";
import { deleteExpiredWorkspaceEvents, flushWorkspaceEvents, listWorkspaceEvents } from "./workspace-event";

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

dbDescribe("Workspace Events written by operation settlement", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  const globals = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
  let previousGlobalPrisma: PrismaClient | undefined;

  beforeAll(() => {
    if (!url || !schema?.startsWith("workflow_lifecycle_test_")) throw new Error("Workspace Event tests require a disposable workflow schema");
    pool = new Pool({ connectionString: url, max: 8 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), transactionOptions: { maxWait: 60_000, timeout: 60_000 } });
    previousGlobalPrisma = globals.narriflowPrismaClient;
    globals.narriflowPrismaClient = prisma;
  });
  beforeEach(async () => {
    await prisma.workspace.deleteMany({ where: { owner: { clerkId: { startsWith: "workspace-event-emission:" } } } });
    await prisma.user.deleteMany({ where: { clerkId: { startsWith: "workspace-event-emission:" } } });
  });
  afterAll(async () => {
    globals.narriflowPrismaClient = previousGlobalPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function fixture(ingestStatus: "ready" | "queued" = "ready") {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { clerkId: `workspace-event-emission:${suffix}` } });
    const workspace = await prisma.workspace.create({ data: { name: "Emission", ownerUserId: user.id, pricingTier: "business", members: { create: { userId: user.id, role: "owner" } } } });
    const project = await prisma.project.create({ data: { title: "Emission", sourceMediaUrl: "r2://test/source.mp4", workspaceId: workspace.id, createdByUserId: user.id, ingestStatus } });
    await prisma.processingUsageReservation.create({ data: { projectId: project.id, workspaceId: workspace.id, intakeKind: "link",
      periodStart: new Date(Date.UTC(2026, 0, 1)), reservedSeconds: 60, settledSeconds: 60, state: "settled" } });
    return { user, workspace, project };
  }
  const workflow = () => new RenderFixtureLifecycle({ prisma, leaseOwner: randomUUID() });
  const feed = async (workspaceId: string) => (await listWorkspaceEvents(prisma, { workspaceId }, { limit: 200 })).data;
  const subjects = async (workspaceId: string) => (await feed(workspaceId)).map((event) => event.subject);
  const finishedSubject = (kind: "intake" | "generation" | "export", id: string, projectId: string, state: string) =>
    ({ operation: { kind, id: encodeOperationId({ kind, id }) }, projectId, state });

  async function clip(projectId: string, workflowRunId: string, index = 0) {
    return prisma.clip.create({ data: { projectId, workflowRunId, index, startSec: 0, endSec: 10, hookText: `Clip ${index}`, reasoning: "Fixture", category: "hook",
      transcriptSlice: [], viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50, durationOptimalityScore: 50,
      tiktokScore: 50, youtubeScore: 50, instagramScore: 50, llmProvider: "test", llmModel: "test" } });
  }

  async function uploadSession(f: Awaited<ReturnType<typeof fixture>>) {
    const id = randomUUID();
    await prisma.uploadSession.create({ data: { id, workspaceId: f.workspace.id, actorUserId: f.user.id, clientIdempotencyKey: randomUUID(),
      immutableInputFingerprint: "fixture", preallocatedProjectId: f.project.id, title: "Upload", fileName: "upload.mp4", fileSizeBytes: BigInt(10),
      contentType: "video/mp4", browserFingerprint: "fixture", generationSettings: {}, transferKind: "single", storageKey: `uploads/${id}.mp4`,
      status: "queued_for_ingest", expiresAt: new Date(Date.now() + 3_600_000), hardExpiresAt: new Date(Date.now() + 7_200_000) } });
    return id;
  }
  const admitStt = (lifecycle: RenderFixtureLifecycle, projectId: string) => lifecycle.admitTranscript({ projectId, idempotencyKey: `stt:${randomUUID()}`,
    languageCode: "en", transcriptProvider: "assemblyai", transcriptProviderModel: "test", contentPack: PACK as never });
  /** An Ingest Job that completed and handed off to this generation run. */
  const handedOffJob = (projectId: string, generationRunId: string, uploadSessionId?: string) => prisma.ingestJob.create({ data: { projectId,
    jobType: uploadSessionId ? "upload_finalize" : "link_import", payload: {}, status: "completed", completedAt: new Date(), generationHandoffAt: new Date(),
    generationRunId, ...(uploadSessionId ? { uploadSessionId } : {}) } });

  /** Admits speech-to-text for a handed-off link intake and runs the transcript
   * to completion, leaving detection queued. */
  async function transcribed(f: Awaited<ReturnType<typeof fixture>>) {
    const lifecycle = workflow();
    const stt = await admitStt(lifecycle, f.project.id);
    const job = await handedOffJob(f.project.id, stt.id);
    const attempt = await lifecycle.claim("stt");
    if (!attempt) throw new Error("stt claim missing");
    await lifecycle.completeTranscript(attempt, { provider: "assemblyai", providerModel: "test", providerJobId: null, languageCode: "en",
      languageConfidence: 1, text: "transcript", utterances: [] as Prisma.InputJsonValue, speakerCount: 1, durationSeconds: 10, rawStorageKey: null });
    return { stt, job };
  }

  /** Runs detection with `count` clips, each admitted for one pending render. */
  async function detected(f: Awaited<ReturnType<typeof fixture>>, count: number) {
    const lifecycle = workflow();
    const detection = await lifecycle.claim("moment_detection");
    if (!detection) throw new Error("detection claim missing");
    const clips = await Promise.all(Array.from({ length: count }, (_, index) => clip(f.project.id, detection.workflowRunId, index)));
    await lifecycle.admitAutoRenderWork(detection, { idempotencyKey: `auto-render-${detection.workflowRunId}`,
      renders: clips.map((row) => ({ clipId: row.id, aspectRatio: "ratio_9_16", status: "pending", resolution: "1080p" })) as never });
    await lifecycle.completeMomentDetection(detection);
    const renderer = workflow();
    const attempt = await renderer.claim("clip_rendering");
    if (!attempt) throw new Error("render claim missing");
    await renderer.beginRenderWorkSet(attempt);
    const renders = await prisma.clipRender.findMany({ where: { clipId: { in: clips.map((row) => row.id) } }, orderBy: { createdAt: "asc" } });
    return { renderer, attempt, renders };
  }
  const done = { storageKey: "projects/test/render.mp4", sizeBytes: 1024, durationSec: 10 };

  test("a generation reaching completed emits one operation.finished, and its link intake finishes with it", async () => {
    const f = await fixture();
    const { stt, job } = await transcribed(f);
    expect(await feed(f.workspace.id)).toEqual([]);
    const { renderer, attempt, renders } = await detected(f, 1);
    expect(await feed(f.workspace.id)).toEqual([]);
    await renderer.markClipRenderVariantRendering(attempt, renders[0]!.id);
    await renderer.completeClipRenderVariant(attempt, renders[0]!.id, done);
    // The event is written when the render run settles, not per render.
    expect(await feed(f.workspace.id)).toEqual([]);
    await renderer.settleRenderWorkSet(attempt);

    const page = await feed(f.workspace.id);
    expect(page.map((event) => event.type)).toEqual(["operation.finished", "operation.finished"]);
    expect(page.map((event) => event.subject)).toEqual([
      finishedSubject("generation", stt.id, f.project.id, "completed"),
      finishedSubject("intake", job.id, f.project.id, "completed"),
    ]);

    // Replaying the settlement, or re-deriving the lineage, writes nothing new.
    await renderer.settleRenderWorkSet(attempt);
    await prisma.$transaction(async (tx) => {
      await queueFinishedGenerations(tx, { id: attempt.workflowRunId, projectId: f.project.id });
      await flushWorkspaceEvents(tx);
    });
    expect(await feed(f.workspace.id)).toHaveLength(2);
    expect((await prisma.workspaceEventCounter.findUniqueOrThrow({ where: { workspaceId: f.workspace.id } })).lastSeq).toBe(2n);
  });

  test("a generation with one failed render finishes partial", async () => {
    const f = await fixture();
    const { stt, job } = await transcribed(f);
    const { renderer, attempt, renders } = await detected(f, 2);
    await renderer.markClipRenderVariantRendering(attempt, renders[0]!.id);
    await renderer.completeClipRenderVariant(attempt, renders[0]!.id, done);
    await renderer.markClipRenderVariantRendering(attempt, renders[1]!.id);
    await renderer.failClipRenderVariant(attempt, renders[1]!.id, "source_invalid", "permanent");
    expect(await feed(f.workspace.id)).toEqual([]);
    await renderer.settleRenderWorkSet(attempt);
    expect(await subjects(f.workspace.id)).toEqual([
      finishedSubject("generation", stt.id, f.project.id, "partial"),
      finishedSubject("intake", job.id, f.project.id, "partial"),
    ]);
  });

  test("a generation whose speech-to-text fails permanently finishes failed, with its upload intake named by the Upload Session", async () => {
    const f = await fixture();
    const lifecycle = workflow();
    const stt = await admitStt(lifecycle, f.project.id);
    const sessionId = await uploadSession(f);
    await handedOffJob(f.project.id, stt.id, sessionId);
    const attempt = await lifecycle.claim("stt");
    if (!attempt) throw new Error("stt claim missing");
    await lifecycle.failAttempt(attempt, new WorkflowFailure("transcription_failed", "permanent", "no audio"));
    expect(await subjects(f.workspace.id)).toEqual([
      finishedSubject("generation", stt.id, f.project.id, "failed"),
      finishedSubject("intake", sessionId, f.project.id, "failed"),
    ]);
  });

  test("cancelling a queued generation finishes it cancelled; a retryable failure that requeues finishes nothing", async () => {
    const requeued = await fixture();
    const retrying = workflow();
    await admitStt(retrying, requeued.project.id);
    const first = await retrying.claim("stt");
    await retrying.failAttempt(first!, new WorkflowFailure("provider_down", "retryable", "try again"));
    expect(await feed(requeued.workspace.id)).toEqual([]);

    const f = await fixture();
    const stt = await admitStt(workflow(), f.project.id);
    const job = await handedOffJob(f.project.id, stt.id);
    expect(await workflow().cancelQueuedGenerationOperation({ workspaceId: f.workspace.id, projectId: f.project.id, workflowRunId: stt.id })).toBe(true);
    expect(await subjects(f.workspace.id)).toEqual([
      finishedSubject("generation", stt.id, f.project.id, "cancelled"),
      finishedSubject("intake", job.id, f.project.id, "cancelled"),
    ]);
  });

  async function exportFixture(f: Awaited<ReturnType<typeof fixture>>, variants = 1) {
    const run = await prisma.workflowRun.create({ data: { projectId: f.project.id, idempotencyKey: `export-render:${randomUUID()}`, stage: "clip_rendering", status: "queued" } });
    // The clip belongs to its own run, so it never collides with a generation's clips.
    const owner = await clip(f.project.id, run.id, 7);
    const exported = await prisma.clipExport.create({ data: { projectId: f.project.id, workspaceId: f.workspace.id, createdByUserId: f.user.id, clipId: owner.id,
      editorRevision: 0, fingerprint: randomUUID(), resolution: "1080p", watermark: false } });
    const ratios = ["ratio_9_16", "ratio_1_1"] as const;
    const renders = [];
    for (const ratio of ratios.slice(0, variants)) {
      const variant = await prisma.clipExportVariant.create({ data: { exportId: exported.id, aspectRatio: ratio, resolution: "1080p", watermark: false } });
      renders.push(await prisma.clipRender.create({ data: { clipId: owner.id, aspectRatio: ratio, exportVariantId: variant.id } }));
    }
    return { run, exported, renders, project: f.project, workspace: f.workspace, user: f.user };
  }
  async function claimRender(lifecycle = workflow()) {
    const attempt = await lifecycle.claim("clip_rendering");
    if (!attempt) throw new Error("render claim missing");
    await lifecycle.beginRenderWorkSet(attempt);
    return { lifecycle, attempt };
  }
  const exportSubject = (x: Awaited<ReturnType<typeof exportFixture>>, state: string) => finishedSubject("export", x.exported.id, x.project.id, state);

  test("an export finishing writes one event when its last variant completes, and replays write none", async () => {
    const f = await fixture();
    const x = await exportFixture(f, 2);
    const { lifecycle, attempt } = await claimRender();
    await lifecycle.markClipRenderVariantRendering(attempt, x.renders[0]!.id);
    await lifecycle.completeClipRenderVariant(attempt, x.renders[0]!.id, done);
    expect(await feed(f.workspace.id)).toEqual([]);
    await lifecycle.markClipRenderVariantRendering(attempt, x.renders[1]!.id);
    await lifecycle.completeClipRenderVariant(attempt, x.renders[1]!.id, done);
    expect(await subjects(f.workspace.id)).toEqual([exportSubject(x, "completed")]);
    await lifecycle.settleRenderWorkSet(attempt);
    await prisma.$transaction(async (tx) => {
      await queueExportsFinishedByRun(tx, x.run.id);
      await flushWorkspaceEvents(tx);
    });
    expect(await feed(f.workspace.id)).toHaveLength(1);
  });

  test("an export with a failed format and a completed one finishes partial once the format's retries are exhausted", async () => {
    const f = await fixture();
    const x = await exportFixture(f, 2);
    const current = await claimRender();
    await current.lifecycle.markClipRenderVariantRendering(current.attempt, x.renders[0]!.id);
    await current.lifecycle.completeClipRenderVariant(current.attempt, x.renders[0]!.id, done);
    // A retryable failure beside a completed sibling is retried automatically (ADR 0003),
    // so the export is not finished while the run requeues it.
    for (;;) {
      await current.lifecycle.markClipRenderVariantRendering(current.attempt, x.renders[1]!.id);
      await current.lifecycle.failClipRenderVariant(current.attempt, x.renders[1]!.id, "encode_failed", "retryable");
      expect(await feed(f.workspace.id)).toEqual([]);
      const settled = await current.lifecycle.settleRenderWorkSet(current.attempt);
      if (settled.status !== "pending") break;
      expect(await feed(f.workspace.id)).toEqual([]);
      await prisma.workflowRun.update({ where: { id: x.run.id }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
      await current.lifecycle.retryGroups(x.run.id);
    }
    expect(await subjects(f.workspace.id)).toEqual([exportSubject(x, "partial")]);
  });

  test("a retryable render failure that the run requeues is not a finished export; the retry's outcome is", async () => {
    const f = await fixture();
    const x = await exportFixture(f);
    const first = await claimRender();
    await first.lifecycle.markClipRenderVariantRendering(first.attempt, x.renders[0]!.id);
    await first.lifecycle.failClipRenderVariant(first.attempt, x.renders[0]!.id, "transient_render_failure", "retryable");
    expect((await prisma.clipExport.findUniqueOrThrow({ where: { id: x.exported.id } })).status).toBe("rendering");
    expect(await feed(f.workspace.id)).toEqual([]);
    expect((await first.lifecycle.settleRenderWorkSet(first.attempt)).status).toBe("pending");
    expect(await feed(f.workspace.id)).toEqual([]);

    await prisma.workflowRun.update({ where: { id: x.run.id }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
    await first.lifecycle.retryGroups(x.run.id);
    const second = first;
    await second.lifecycle.markClipRenderVariantRendering(second.attempt, x.renders[0]!.id);
    await second.lifecycle.completeClipRenderVariant(second.attempt, x.renders[0]!.id, done);
    await second.lifecycle.settleRenderWorkSet(second.attempt);
    expect(await subjects(f.workspace.id)).toEqual([exportSubject(x, "completed")]);
  });

  test("an export whose retries are exhausted finishes failed when its run settles", async () => {
    const f = await fixture();
    const x = await exportFixture(f);
    let current = await claimRender();
    for (let retry = 0; retry < 2; retry += 1) {
      await current.lifecycle.failAttempt(current.attempt, new WorkflowFailure("transient_render_failure", "retryable", "retry"));
      await prisma.workflowRun.update({ where: { id: x.run.id }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
      current = await claimRender();
    }
    await current.lifecycle.markClipRenderVariantRendering(current.attempt, x.renders[0]!.id);
    await prisma.renderGroup.updateMany({ where: { workflowRunId: x.run.id }, data: { chargedAttemptCount: 3 } });
    await current.lifecycle.failClipRenderVariant(current.attempt, x.renders[0]!.id, "transient_render_failure", "retryable");
    expect(await feed(f.workspace.id)).toEqual([]);
    expect((await current.lifecycle.settleRenderWorkSet(current.attempt)).status).toBe("failed");
    expect(await subjects(f.workspace.id)).toEqual([exportSubject(x, "failed")]);
  });

  test("cancelling a queued export finishes it cancelled", async () => {
    const f = await fixture();
    const x = await exportFixture(f);
    expect(await clipExportService.cancelQueuedOperation({ actorUserId: f.user.id, workspaceId: f.workspace.id }, x.exported.id)).toBe(true);
    expect(await subjects(f.workspace.id)).toEqual([exportSubject(x, "cancelled")]);
  });

  test("a lineage that finished before its events expired is not announced again by a later settlement", async () => {
    const f = await fixture();
    await transcribed(f);
    const { renderer, attempt, renders } = await detected(f, 1);
    await renderer.markClipRenderVariantRendering(attempt, renders[0]!.id);
    await renderer.completeClipRenderVariant(attempt, renders[0]!.id, done);
    await renderer.settleRenderWorkSet(attempt);
    expect(await feed(f.workspace.id)).toHaveLength(2);

    const day = 24 * 60 * 60 * 1000;
    await prisma.workspaceEvent.updateMany({ where: { workspaceId: f.workspace.id }, data: { createdAt: new Date(Date.now() - 31 * day) } });
    expect(await deleteExpiredWorkspaceEvents(prisma)).toBeGreaterThanOrEqual(2);
    expect(await feed(f.workspace.id)).toEqual([]);

    // Another run settles in the same Project, and the old lineage is derived again.
    const x = await exportFixture(f);
    const second = await claimRender();
    await second.lifecycle.markClipRenderVariantRendering(second.attempt, x.renders[0]!.id);
    await second.lifecycle.completeClipRenderVariant(second.attempt, x.renders[0]!.id, done);
    await second.lifecycle.settleRenderWorkSet(second.attempt);
    await prisma.$transaction(async (tx) => {
      await queueFinishedGenerations(tx, { id: attempt.workflowRunId, projectId: f.project.id });
      await flushWorkspaceEvents(tx);
    });
    expect(await subjects(f.workspace.id)).toEqual([exportSubject(x, "completed")]);
  });

  test("a retried export that finishes again is a second event: one per terminal transition", async () => {
    const f = await fixture();
    const x = await exportFixture(f);
    const first = await claimRender();
    await first.lifecycle.markClipRenderVariantRendering(first.attempt, x.renders[0]!.id);
    await first.lifecycle.failClipRenderVariant(first.attempt, x.renders[0]!.id, "source_invalid", "permanent");
    await first.lifecycle.settleRenderWorkSet(first.attempt);
    expect(await subjects(f.workspace.id)).toEqual([exportSubject(x, "failed")]);

    // The writes of ClipExportService.retryFailed, which queues the export again.
    await prisma.$transaction(async (tx) => {
      await tx.clipExportVariant.update({ where: { id: x.renders[0]!.exportVariantId! }, data: { status: "pending", errorCode: null, startedAt: null, completedAt: null } });
      await tx.clipRender.update({ where: { id: x.renders[0]!.id }, data: { status: "pending", errorCode: null, startedAt: null, completedAt: null, workflowRunId: null, workflowAttemptId: null } });
      await tx.clipExport.update({ where: { id: x.exported.id }, data: { status: "queued", progress: 0, errorCode: null, completedAt: null, retryCount: { increment: 1 } } });
    });
    expect(await workflow().rescuePendingClipRenderingRun()).not.toBeNull();
    const second = await claimRender();
    await second.lifecycle.markClipRenderVariantRendering(second.attempt, x.renders[0]!.id);
    await second.lifecycle.completeClipRenderVariant(second.attempt, x.renders[0]!.id, done);
    await second.lifecycle.settleRenderWorkSet(second.attempt);
    expect(await subjects(f.workspace.id)).toEqual([exportSubject(x, "failed"), exportSubject(x, "completed")]);
    const events = await feed(f.workspace.id);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
  });

  /** Counts how many transactions a lifecycle opens, so a silent retry shows. */
  function countingPrisma(failFirst = 0) {
    const state = { transactions: 0, failures: failFirst };
    const wrapped = new Proxy(prisma, {
      get(target, property) {
        if (property !== "$transaction") return Reflect.get(target, property);
        return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) => {
          state.transactions += 1;
          return target.$transaction(async (tx) => {
            const result = await work(tx);
            if (state.failures > 0) {
              state.failures -= 1;
              throw Object.assign(new Error("simulated serialization failure"), { code: "P2034" });
            }
            return result;
          }, options as never);
        };
      },
    }) as PrismaClient;
    return { wrapped, state };
  }

  test("a lifecycle transaction that retries writes its events exactly once", async () => {
    const f = await fixture();
    const stt = await admitStt(workflow(), f.project.id);
    const job = await handedOffJob(f.project.id, stt.id);
    const { wrapped, state } = countingPrisma(1);
    const flaky = new RenderFixtureLifecycle({ prisma: wrapped, leaseOwner: randomUUID() });
    expect(await flaky.cancelQueuedGenerationOperation({ workspaceId: f.workspace.id, projectId: f.project.id, workflowRunId: stt.id })).toBe(true);
    // The first attempt flushed its events and then rolled back; the retry wrote them again, once.
    expect(state.transactions).toBe(2);
    expect(await subjects(f.workspace.id)).toEqual([
      finishedSubject("generation", stt.id, f.project.id, "cancelled"),
      finishedSubject("intake", job.id, f.project.id, "cancelled"),
    ]);
    expect((await prisma.workspaceEventCounter.findUniqueOrThrow({ where: { workspaceId: f.workspace.id } })).lastSeq).toBe(2n);
    expect(await prisma.workspaceEventKey.count({ where: { workspaceId: f.workspace.id } })).toBe(2);
  });

  test("an export finishing while a generation is cancelled in the same Project takes locks in one order, with no retry", async () => {
    for (let round = 0; round < 6; round += 1) {
      const f = await fixture();
      const stt = await admitStt(workflow(), f.project.id);
      await handedOffJob(f.project.id, stt.id);
      const x = await exportFixture(f);
      const { wrapped, state } = countingPrisma();
      const lifecycle = new RenderFixtureLifecycle({ prisma: wrapped, leaseOwner: randomUUID() });
      const attempt = await lifecycle.claim("clip_rendering");
      if (!attempt) throw new Error("render claim missing");
      await lifecycle.beginRenderWorkSet(attempt);
      await lifecycle.markClipRenderVariantRendering(attempt, x.renders[0]!.id);
      state.transactions = 0;
      const [completed, cancelled] = await Promise.all([
        lifecycle.completeClipRenderVariant(attempt, x.renders[0]!.id, done),
        lifecycle.cancelQueuedGenerationOperation({ workspaceId: f.workspace.id, projectId: f.project.id, workflowRunId: stt.id }),
      ]);
      expect(completed).toBe(true);
      expect(cancelled).toBe(true);
      // One transaction each: a deadlock or serialization failure would have retried one of them.
      expect(state.transactions).toBe(2);
      const outcomes = (await subjects(f.workspace.id)).map((subject) => {
        const { operation, state } = subject as { operation: { kind: string }; state: string };
        return `${operation.kind}:${state}`;
      });
      expect(outcomes.sort()).toEqual(["export:completed", "generation:cancelled", "intake:cancelled"]);
    }
  });

  test("Project expiry finishes its queued generation, intake and export", async () => {
    const f = await fixture();
    const stt = await admitStt(workflow(), f.project.id);
    const handedOff = await handedOffJob(f.project.id, stt.id);
    const queuedImport = await prisma.ingestJob.create({ data: { projectId: f.project.id, jobType: "link_import", payload: {} } });
    const x = await exportFixture(f);
    // ProjectRetentionService.claimDueProject cancels queued intakes and fails queued exports.
    expect(await workflow().cancelQueuedProjectRuns({ projectId: f.project.id, errorCode: "PROJECT_EXPIRED" })).toBeGreaterThanOrEqual(2);
    await prisma.$transaction(async (tx) => {
      await tx.ingestJob.updateMany({ where: { projectId: f.project.id, status: "queued" }, data: { status: "cancelled", lastError: "PROJECT_EXPIRED", completedAt: new Date() } });
      await tx.clipExport.updateMany({ where: { projectId: f.project.id, status: "queued" }, data: { status: "failed", errorCode: "PROJECT_EXPIRED" } });
      await queueProjectExpiryFinished(tx, f.project.id);
      await flushWorkspaceEvents(tx);
    });
    const outcomes = (await subjects(f.workspace.id)).map((subject) => {
      const { operation, state } = subject as { operation: { id: string }; state: string };
      return `${operation.id}:${state}`;
    }).sort();
    const named = (kind: "intake" | "generation" | "export", id: string, state: string) => `${encodeOperationId({ kind, id })}:${state}`;
    expect(outcomes).toEqual([
      named("generation", stt.id, "cancelled"),
      named("intake", handedOff.id, "cancelled"),
      named("intake", queuedImport.id, "cancelled"),
      named("export", x.exported.id, "failed"),
    ].sort());
  });

  describe("intake before generation", () => {
    let clock = Date.now();
    function ingest() {
      return new IngestJobLifecycle({ prisma, workflow: workflow(), requireRetryActor: async () => {}, now: () => new Date(clock),
        usage: { reserve: async () => undefined as never, release: async () => undefined as never, settle: async () => ({ outcome: "settled" }) as never } });
    }
    async function queuedJob(f: Awaited<ReturnType<typeof fixture>>) {
      await prisma.project.update({ where: { id: f.project.id }, data: { ingestStatus: "queued" } });
      return prisma.ingestJob.create({ data: { projectId: f.project.id, jobType: "link_import", payload: {} } });
    }

    test("a retried then permanently failed ingest finishes the intake failed exactly once", async () => {
      const f = await fixture();
      const job = await queuedJob(f);
      const module = ingest();
      const first = (await module.claim())!;
      expect(await module.fail(first, "remote_fetch_timeout", "timeout")).toEqual({ outcome: "requeue" });
      expect(await feed(f.workspace.id)).toEqual([]);
      clock += 30_001;
      const second = (await module.claim())!;
      expect(second.id).toBe(job.id);
      expect(await module.fail(second, "remote_url_unsafe", "unsafe")).toMatchObject({ outcome: "permanent" });
      expect(await subjects(f.workspace.id)).toEqual([finishedSubject("intake", job.id, f.project.id, "failed")]);
    });

    test("cancelling a queued intake finishes it cancelled", async () => {
      const f = await fixture();
      const job = await queuedJob(f);
      expect(await ingest().cancelQueuedOperation({ actorUserId: f.user.id, workspaceId: f.workspace.id, projectId: f.project.id, ingestJobId: job.id })).toBe(true);
      expect(await subjects(f.workspace.id)).toEqual([finishedSubject("intake", job.id, f.project.id, "cancelled")]);
    });

    test("a refused generation handoff finishes the intake failed", async () => {
      const f = await fixture();
      const job = await prisma.ingestJob.create({ data: { projectId: f.project.id, jobType: "link_import", payload: {}, status: "completed", completedAt: new Date() } });
      const module = ingest();
      const refuse = () => prisma.$transaction((tx) => module.refuseGeneration(tx, f.project.id,
        new ExpectedDomainFailureError({ code: "upload_too_long", kind: "unprocessable", message: "Too long" })));
      await refuse();
      await refuse();
      expect(await subjects(f.workspace.id)).toEqual([finishedSubject("intake", job.id, f.project.id, "failed")]);
    });

    test("an intake that acknowledges an already finished generation finishes with it", async () => {
      const f = await fixture();
      const lifecycle = workflow();
      const stt = await admitStt(lifecycle, f.project.id);
      const attempt = await lifecycle.claim("stt");
      await lifecycle.failAttempt(attempt!, new WorkflowFailure("transcription_failed", "permanent", "no audio"));
      expect(await subjects(f.workspace.id)).toEqual([finishedSubject("generation", stt.id, f.project.id, "failed")]);

      const job = await prisma.ingestJob.create({ data: { projectId: f.project.id, jobType: "link_import", payload: {}, status: "completed", completedAt: new Date() } });
      expect(await ingest().processGenerationHandoffs(10, job.id)).toBe(1);
      expect(await subjects(f.workspace.id)).toEqual([
        finishedSubject("generation", stt.id, f.project.id, "failed"),
        finishedSubject("intake", job.id, f.project.id, "failed"),
      ]);
    });

    test("an acknowledgement racing a speech-to-text failure still finishes the intake exactly once", async () => {
      const f = await fixture();
      const leaseOwner = randomUUID();
      let armed = false;
      let release!: () => void;
      let settling!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { settling = resolve; });
      // Holds the failure's transaction open after its writes and flush, before it commits.
      const held = new Proxy(prisma, {
        get(target, property) {
          if (property !== "$transaction") return Reflect.get(target, property);
          return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) => target.$transaction(async (tx) => {
            const result = await work(tx);
            if (armed) { settling(); await gate; }
            return result;
          }, options as never);
        },
      }) as PrismaClient;
      const lifecycle = new RenderFixtureLifecycle({ prisma: held, leaseOwner });
      const stt = await admitStt(lifecycle, f.project.id);
      const attempt = await lifecycle.claim("stt");
      if (!attempt) throw new Error("stt claim missing");
      const job = await prisma.ingestJob.create({ data: { projectId: f.project.id, jobType: "link_import", payload: {}, status: "completed", completedAt: new Date() } });

      armed = true;
      const failing = lifecycle.failAttempt(attempt, new WorkflowFailure("transcription_failed", "permanent", "no audio"));
      await reached;
      armed = false;
      // The failure has not committed, so the acknowledgement sees a running run and no intake yet.
      let acknowledged = false;
      const acknowledging = ingest().processGenerationHandoffs(10, job.id).then((count) => { acknowledged = true; return count; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(acknowledged).toBe(false);
      release();
      await failing;
      expect(await acknowledging).toBe(1);
      expect(await subjects(f.workspace.id)).toEqual([
        finishedSubject("generation", stt.id, f.project.id, "failed"),
        finishedSubject("intake", job.id, f.project.id, "failed"),
      ]);
    });
  });
  describe("a captioned video", () => {
    const settings = buildCaptionedVideoSettings({ framing: "fit", aspectRatios: ["9:16", "1:1"], captions: { source: "none" } });

    /** A link intake handed off to a captioned video: speech-to-text done, detection claimed
     * and its whole-source clip written, detection not yet completed. */
    async function detecting(f: Awaited<ReturnType<typeof fixture>>, lifecycle = workflow()) {
      await prisma.project.update({ where: { id: f.project.id }, data: { sourceDurationSeconds: 10 } });
      const stt = await lifecycle.admitTranscript({ projectId: f.project.id, idempotencyKey: `stt:${randomUUID()}`, languageCode: "en",
        transcriptProvider: "assemblyai", transcriptProviderModel: "test", contentPack: buildCaptionedVideoContentPack(settings) as never });
      const job = await handedOffJob(f.project.id, stt.id);
      const sttAttempt = await lifecycle.claim("stt");
      if (!sttAttempt) throw new Error("stt claim missing");
      await lifecycle.completeTranscript(sttAttempt, { provider: "assemblyai", providerModel: "test", providerJobId: null, languageCode: "en",
        languageConfidence: 1, text: "transcript", utterances: [] as Prisma.InputJsonValue, speakerCount: 1, durationSeconds: 10, rawStorageKey: null });
      const detection = await lifecycle.claim("moment_detection");
      if (!detection) throw new Error("detection claim missing");
      await writeClip(f.project.id, detection.workflowRunId);
      return { lifecycle, stt, job, detection };
    }
    async function writeClip(projectId: string, detectionRunId: string) {
      const whole = await clip(projectId, detectionRunId);
      await prisma.clip.update({ where: { id: whole.id }, data: { wholeSource: true } });
    }
    /** Completes detection the way the worker does: the export is admitted in the same transaction. */
    const complete = (x: Awaited<ReturnType<typeof detecting>>) =>
      x.lifecycle.completeMomentDetection(x.detection, { admit: clipExportService.captionedExportWrite(x.detection, settings) });
    const theExport = (f: Awaited<ReturnType<typeof fixture>>) =>
      prisma.clipExport.findFirstOrThrow({ where: { projectId: f.project.id }, include: { variants: { include: { render: true }, orderBy: { createdAt: "asc" } } } });
    /** Export renders are picked up by any render run of the Project. */
    const queueRenderRun = (f: Awaited<ReturnType<typeof fixture>>) =>
      prisma.workflowRun.create({ data: { projectId: f.project.id, idempotencyKey: `export-render:${randomUUID()}`, stage: "clip_rendering", status: "queued" } });
    async function finishVariants(f: Awaited<ReturnType<typeof fixture>>, how: "complete" | "fail") {
      await queueRenderRun(f);
      const exported = await theExport(f);
      const { lifecycle, attempt } = await claimRender();
      for (const variant of exported.variants) {
        await lifecycle.markClipRenderVariantRendering(attempt, variant.render!.id);
        if (how === "complete") await lifecycle.completeClipRenderVariant(attempt, variant.render!.id, done);
        else await lifecycle.failClipRenderVariant(attempt, variant.render!.id, "source_invalid", "permanent");
      }
      return { lifecycle, attempt, exported };
    }

    test("its generation finishes once, when its export does, and not when detection completes", async () => {
      const f = await fixture();
      const x = await detecting(f);
      await complete(x);
      // Detection is done, but the export is still to render: the generation is working.
      expect(await feed(f.workspace.id)).toEqual([]);
      const exported = await theExport(f);

      await queueRenderRun(f);
      const { lifecycle: renderer, attempt } = await claimRender();
      const [first, second] = exported.variants;
      await renderer.markClipRenderVariantRendering(attempt, first!.render!.id);
      await renderer.completeClipRenderVariant(attempt, first!.render!.id, done);
      expect(await feed(f.workspace.id)).toEqual([]);
      await renderer.markClipRenderVariantRendering(attempt, second!.render!.id);
      await renderer.completeClipRenderVariant(attempt, second!.render!.id, done);

      // The export's own event is unchanged; the generation and its handed-off intake finish with it.
      expect(await subjects(f.workspace.id)).toEqual([
        finishedSubject("export", exported.id, f.project.id, "completed"),
        finishedSubject("generation", x.stt.id, f.project.id, "completed"),
        finishedSubject("intake", x.job.id, f.project.id, "completed"),
      ]);

      // Replaying the settlements, or re-deriving the lineage, writes nothing new.
      await renderer.settleRenderWorkSet(attempt);
      await prisma.$transaction(async (tx) => {
        await queueFinishedGenerations(tx, { id: x.detection.workflowRunId, projectId: f.project.id });
        await queueExportsFinishedByRun(tx, attempt.workflowRunId);
        await flushWorkspaceEvents(tx);
      });
      expect(await feed(f.workspace.id)).toHaveLength(3);
      expect((await prisma.workspaceEventCounter.findUniqueOrThrow({ where: { workspaceId: f.workspace.id } })).lastSeq).toBe(3n);
    });

    test("a failed export finishes its generation failed, once", async () => {
      const f = await fixture();
      const x = await detecting(f);
      await complete(x);
      const { lifecycle, attempt, exported } = await finishVariants(f, "fail");
      await lifecycle.settleRenderWorkSet(attempt);
      expect(await subjects(f.workspace.id)).toEqual([
        finishedSubject("export", exported.id, f.project.id, "failed"),
        finishedSubject("generation", x.stt.id, f.project.id, "failed"),
        finishedSubject("intake", x.job.id, f.project.id, "failed"),
      ]);
    });

    test("the export exists only with the completed run: a render rescue running beside detection's completion can't lose the generation's event", async () => {
      const f = await fixture();
      let armed = false;
      let release!: () => void;
      let completing!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { completing = resolve; });
      // Holds detection's completion open after every write (the export, the run, the events), before it commits.
      const held = new Proxy(prisma, {
        get(target, property) {
          if (property !== "$transaction") return Reflect.get(target, property);
          return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) => target.$transaction(async (tx) => {
            const result = await work(tx);
            if (armed) { completing(); await gate; }
            return result;
          }, options as never);
        },
      }) as PrismaClient;
      const x = await detecting(f, new RenderFixtureLifecycle({ prisma: held, leaseOwner: randomUUID() }));

      armed = true;
      const completion = complete(x);
      await reached;
      armed = false;
      // The rescue finds nothing: the export's renders are not visible before the run is completed.
      expect(await workflow().rescuePendingClipRenderingRun()).toBeNull();
      expect(await prisma.clipExport.count({ where: { projectId: f.project.id } })).toBe(0);
      release();
      await completion;

      // Now both are visible together. The rescue admits the render run and the export settles into the generation's event.
      expect(await workflow().rescuePendingClipRenderingRun()).not.toBeNull();
      const exported = await theExport(f);
      const { lifecycle, attempt } = await claimRender();
      for (const variant of exported.variants) {
        await lifecycle.markClipRenderVariantRendering(attempt, variant.render!.id);
        await lifecycle.completeClipRenderVariant(attempt, variant.render!.id, done);
      }
      await lifecycle.settleRenderWorkSet(attempt);
      expect(await subjects(f.workspace.id)).toEqual([
        finishedSubject("export", exported.id, f.project.id, "completed"),
        finishedSubject("generation", x.stt.id, f.project.id, "completed"),
        finishedSubject("intake", x.job.id, f.project.id, "completed"),
      ]);
    });

    test("a detection retry leaves no first export behind and renders one: nothing is lost or doubled", async () => {
      const f = await fixture();
      const first = await detecting(f);
      // The first attempt wrote its clip and then lost its worker before completing: no export exists for the retry to cascade away.
      expect(await prisma.clipExport.count({ where: { projectId: f.project.id } })).toBe(0);
      await first.lifecycle.failAttempt(first.detection, new WorkflowFailure("worker_lost", "retryable", "worker restarted"));
      await prisma.workflowRun.update({ where: { id: first.detection.workflowRunId }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
      const lifecycle = workflow();
      const retry = await lifecycle.claim("moment_detection");
      if (!retry) throw new Error("detection retry claim missing");
      expect(retry.workflowRunId).toBe(first.detection.workflowRunId);
      // Detection replaces the project's clips, as `persistDetectedClips` does.
      await prisma.clip.deleteMany({ where: { projectId: f.project.id } });
      await writeClip(f.project.id, retry.workflowRunId);
      await lifecycle.completeMomentDetection(retry, { admit: clipExportService.captionedExportWrite(retry, settings) });

      expect(await prisma.clipExport.count({ where: { projectId: f.project.id } })).toBe(1);
      expect(await feed(f.workspace.id)).toEqual([]);
      const { lifecycle: renderer, attempt, exported } = await finishVariants(f, "complete");
      await renderer.settleRenderWorkSet(attempt);
      expect(await subjects(f.workspace.id)).toEqual([
        finishedSubject("export", exported.id, f.project.id, "completed"),
        finishedSubject("generation", first.stt.id, f.project.id, "completed"),
        finishedSubject("intake", first.job.id, f.project.id, "completed"),
      ]);
    });

    test("a retried export is a second export event, but its generation stays as first announced", async () => {
      const f = await fixture();
      const x = await detecting(f);
      await complete(x);
      const { lifecycle, attempt, exported } = await finishVariants(f, "fail");
      await lifecycle.settleRenderWorkSet(attempt);
      expect(await createOperationStatusReader(prisma).readTrusted({ workspaceId: f.workspace.id }, { kind: "generation", id: x.stt.id })).toMatchObject({ state: "failed" });

      // The person retries the failed export (as `retryFailed` does): both formats render again and succeed.
      await prisma.clipExport.update({ where: { id: exported.id }, data: { retryCount: 1, status: "queued", progress: 0, errorCode: null, completedAt: null } });
      await prisma.clipExportVariant.updateMany({ where: { exportId: exported.id }, data: { status: "pending", errorCode: null, completedAt: null } });
      await prisma.clipRender.updateMany({ where: { exportVariantId: { in: exported.variants.map((variant) => variant.id) } }, data: { status: "pending", errorCode: null, failureDisposition: null, workflowRunId: null, workflowAttemptId: null, completedAt: null } });
      await queueRenderRun(f);
      const retry = await claimRender();
      for (const variant of exported.variants) {
        await retry.lifecycle.markClipRenderVariantRendering(retry.attempt, variant.render!.id);
        await retry.lifecycle.completeClipRenderVariant(retry.attempt, variant.render!.id, done);
      }

      expect(await subjects(f.workspace.id)).toEqual([
        finishedSubject("export", exported.id, f.project.id, "failed"),
        finishedSubject("generation", x.stt.id, f.project.id, "failed"),
        finishedSubject("intake", x.job.id, f.project.id, "failed"),
        finishedSubject("export", exported.id, f.project.id, "completed"),
      ]);
      // The export operation reports the retry; the generation keeps what it announced.
      expect(await createOperationStatusReader(prisma).readTrusted({ workspaceId: f.workspace.id }, { kind: "export", id: exported.id })).toMatchObject({ state: "completed" });
      expect(await createOperationStatusReader(prisma).readTrusted({ workspaceId: f.workspace.id }, { kind: "generation", id: x.stt.id })).toMatchObject({ state: "failed", results: { exportId: exported.id } });
    });

    test("deleting the export after it ended doesn't change what the generation reported", async () => {
      const f = await fixture();
      const x = await detecting(f);
      await complete(x);
      const { lifecycle, attempt, exported } = await finishVariants(f, "complete");
      await lifecycle.settleRenderWorkSet(attempt);
      const status = () => createOperationStatusReader(prisma).readTrusted({ workspaceId: f.workspace.id }, { kind: "generation", id: x.stt.id });
      const reported = await status();
      expect(reported).toMatchObject({ state: "completed", results: { exportId: exported.id } });
      await prisma.clipExport.delete({ where: { id: exported.id } });
      expect(await status()).toEqual(reported);
    });
  });
});
