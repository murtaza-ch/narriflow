import { bindServiceTestEnvironment } from "./runtime-test-support";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { RenderFixtureLifecycle } from "./render-group-test-fixture";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  buildCaptionedVideoContentPack,
  buildCaptionedVideoSettings,
  buildGenerationContentPack,
  studioEditsSchema,
  workflowStageUpdatedEventSchema,
} from "@narriflow/validators";
import { Pool } from "pg";
import {
  type WorkflowAttemptRef,
  WORKFLOW_MAX_ATTEMPTS,
  WORKFLOW_RETRIES_EXHAUSTED_CODE,
  WorkflowFailure,
  WorkflowRunLifecycle,
} from "./workflow-run-lifecycle";
import { decodeClipEditorDocumentFromStorage, encodeClipEditorDocumentForStorage, } from "./clip-editor-document-persistence";
import { createNotificationExecution } from "./notification-execution";
import { clipService } from "./clip.service";
import { projectService } from "./project.service";
import { workspaceLibraryService } from "./workspace-library.service";
import { createCallbackCipher } from "./completion-callback";
import { OutboundDeliveryService } from "./outbound-delivery";
import { createOperationStatusReader } from "./operation-status";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { createTranscriptionAdmission } from "./transcription-admission";
import type { ProviderAttemptReference } from "@narriflow/validators/execution";
import { createClipSelectionPreparation, type ClipSelectionStorage } from "./clip-selection-preparation";
import { createClipSelectionLifecycle } from "./clip-selection-window";
import { createClipSelectionControl } from "./clip-selection-control";
import { clipSelectionBytesHash } from "./clip-selection-input";
import { createExecutorControl } from "./executor-control";
import { appendWorkflowEvent } from "./workflow-event-append";
import { createExecutionDispatch } from "./execution-dispatch";
import { deliverProgressDispatch } from "./progress-outbox";
import { withProgressDelivery } from "./progress-delivery";

const databaseUrl = process.env.WORKFLOW_TEST_DATABASE_URL;
const databaseSchema = process.env.WORKFLOW_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_WORKFLOW_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);

function assertSafeTestDatabase(url: string) {
  const parsed = new URL(url);
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  const namedTestDatabase = parsed.pathname.toLowerCase().includes("test");
  const isolatedTestSchema = Boolean(
    databaseSchema?.startsWith("workflow_lifecycle_test_"),
  );
  if (!local && !namedTestDatabase && !isolatedTestSchema) {
    throw new Error(
      "Workflow DB tests require a local/test database or isolated workflow test schema",
    );
  }
}

dbDescribe("WorkflowRunLifecycle PostgreSQL invariants", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let previousGlobalPrisma: PrismaClient | undefined;
  const prismaGlobal = createDatabaseTestContext();

  beforeAll(bindServiceTestEnvironment(prismaGlobal.bind(() => {
    if (!databaseUrl) throw new Error("WORKFLOW_TEST_DATABASE_URL is required");
    assertSafeTestDatabase(databaseUrl);
    pool = new Pool({ connectionString: databaseUrl, max: 5 });
    prisma = new PrismaClient({
      adapter: new PrismaPg(
        pool,
        databaseSchema ? { schema: databaseSchema } : undefined,
      ),
      transactionOptions: { maxWait: 120_000, timeout: 120_000 },
    });
    previousGlobalPrisma = prismaGlobal.client;
    prismaGlobal.client = prisma;
  })));

  beforeEach(bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    await prisma.workspace.deleteMany({
      where: { owner: { clerkId: { startsWith: "workflow-db-test:" } } },
    });
    await prisma.user.deleteMany({
      where: { clerkId: { startsWith: "workflow-db-test:" } },
    });
  })));

  afterAll(bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    prismaGlobal.client = previousGlobalPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  })));

  async function fixture(stage = "dubbing") {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        clerkId: `workflow-db-test:${suffix}`,
        primaryEmail: `workflow-${suffix}@example.test`,
      },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: "Workflow lifecycle test",
        ownerUserId: user.id,
        personalOwnerUserId: user.id,
        members: {
          create: { userId: user.id, role: "owner" },
        },
      },
    });
    const project = await prisma.project.create({
      data: {
        title: "Workflow lifecycle test",
        sourceMediaUrl: "r2://test/source.mp4",
        workspaceId: workspace.id,
        createdByUserId: user.id,
      },
    });
    // Speech-to-text admission requires settled Processing Usage.
    await prisma.processingUsageReservation.create({
      data: {
        projectId: project.id,
        workspaceId: workspace.id,
        intakeKind: "upload",
        periodStart: new Date(Date.UTC(2026, 0, 1)),
        reservedSeconds: 60,
        settledSeconds: 60,
        state: "settled",
      },
    });
    const run = await prisma.workflowRun.create({
      data: {
        projectId: project.id,
        idempotencyKey: `fixture:${suffix}`,
        stage,
        status: "queued",
      },
    });
    return { user, workspace, project, run };
  }

  async function clipFixture(projectId: string, workflowRunId: string, index = 0) {
    return prisma.clip.create({
      data: {
        projectId,
        workflowRunId,
        index,
        startSec: 0,
        endSec: 10,
        hookText: `Render work set clip ${index}`,
        reasoning: "Test fixture",
        category: "hook",
        transcriptSlice: [],
        viralityScore: 50,
        hookStrengthScore: 50,
        emotionalIntensityScore: 50,
        pacingScore: 50,
        durationOptimalityScore: 50,
        tiktokScore: 50,
        youtubeScore: 50,
        instagramScore: 50,
        llmProvider: "test",
        llmModel: "test",
      },
    });
  }

  function frozenExportSnapshot(clip: Awaited<ReturnType<typeof clipFixture>>) {
    const document = encodeClipEditorDocumentForStorage(decodeClipEditorDocumentFromStorage(clip, { durationSec: null, wholeSource: clip.wholeSource }), { durationSec: null, wholeSource: clip.wholeSource });
    return JSON.parse(JSON.stringify({ ...clip, ...document })) as Prisma.InputJsonValue;
  }

  async function spendRenderStarts(lifecycle: RenderFixtureLifecycle, attempt: WorkflowAttemptRef, variantId: string, target = 3) {
    const member = await prisma.renderGroupMember.findFirstOrThrow({ where: { workflowRunId: attempt.workflowRunId, clipRenderId: variantId } });
    if ((await prisma.renderGroup.findUniqueOrThrow({ where: { id: member.groupId } })).status === "queued") await lifecycle.retryGroups(attempt.workflowRunId);
    await lifecycle.markClipRenderVariantRendering(attempt, variantId);
    while ((await lifecycle.groupFor(attempt, variantId)).attempt.chargedAttemptCount < target) {
      await lifecycle.failClipRenderVariant(attempt, variantId, "fixture_retry", "retryable");
      await lifecycle.finishGroups();
      await lifecycle.retryGroups(attempt.workflowRunId);
      await lifecycle.markClipRenderVariantRendering(attempt, variantId);
    }
  }

  async function preparedSelection(runId: string, clips: unknown[] = [0, 40, 80].map(start => ({ title: `Story ${start}`, start_time: start, end_time: start + 30, hook_text: "Hook", payoff_text: "Payoff", reasoning: "Fixture", category: "hook", platform_fit: ["tiktok"], hook_strength: 70, emotional_intensity: 70, story_completeness_score: 70, broll_cues: [] }))) {
    const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });
    await prisma.project.update({ where: { id: run.projectId }, data: { sourceDurationSeconds: 120, ingestStatus: "ready" } });
    if (!run.contentPackId) {
      const pack = await prisma.contentPack.create({ data: { projectId: run.projectId, ...buildGenerationContentPack({ clipCountTarget: 3, clipLengthPreset: "30_to_60s" }) } });
      await prisma.workflowRun.update({ where: { id: run.id }, data: { contentPackId: pack.id } });
    }
    await prisma.transcript.create({ data: { projectId: run.projectId, status: "completed", sourceRevision: 1, workflowAttemptId: randomUUID(), languageCode: "en", speakerCount: 1,
      text: "Frozen transcript", utterancesJson: Array.from({ length: 120 }, (_, index) => ({ index, speaker: 0, speakerLabel: "Speaker 1", startSec: index, endSec: index + 1,
        text: `Story ${index}.`, confidence: null, words: [{ word: `Story${index}.`, startSec: index, endSec: index + 1, confidence: null }] })) } });
    const workflow = new WorkflowRunLifecycle({ prisma }), reference = (await prisma.$transaction(tx => workflow.dispatchRunWithinTransaction(tx, run.id))).reference;
    const objects = new Map<string, Uint8Array>();
    const storage: ClipSelectionStorage = {
      async write(key, bytes) { objects.set(key, bytes.slice()); return { etag: '"sealed"', byteLength: bytes.byteLength, sha256: await clipSelectionBytesHash(bytes) }; },
      async read(object) { const bytes = objects.get(object.storageKey); if (!bytes || object.etag !== '"sealed"') throw Error("Changed private selection object"); return bytes.slice(); },
    };
    const preparation = createClipSelectionPreparation({ database: prisma, storage, provider: { model: "gpt-5.4-mini", reasoningEffort: "medium", maxOutputTokens: 32000 } });
    const prepared = await preparation.prepare(reference);
    if (prepared.kind !== "prepared") throw Error("Expected selection preparation");
    const control = createClipSelectionControl({ preparation, storage, lifecycle: createClipSelectionLifecycle({ database: prisma, maxInFlightRequests: 1, maxEstimatedTokens: 240000 }), finalization: workflow,
      deliver: async ids => { expect(await prisma.executionDispatch.count({ where: { id: { in: [...ids] } } })).toBe(ids.length); },
      provider: { async generate() { return { kind: "completed", tokensUsed: 123, providerRequestId: "workflow-selection-fixture", rateLimitHeaders: {}, content: JSON.stringify({ clips }) }; } },
    });
    for (const window of prepared.windows) expect(await control.runWindow(window)).toEqual({ kind: "complete", outcome: "completed" });
    return { control, reference };
  }

  async function claimRenderAttempt() {
    const lifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const attempt = await lifecycle.claim("clip_rendering");
    if (!attempt) throw new Error("clip-rendering claim missing");
    return { attempt, lifecycle };
  }

  async function admittedNotification(projectId: string, workflowRunId: string) {
    const ledger = await prisma.notificationLedger.findFirstOrThrow({ where: { projectId, sourceId: workflowRunId } });
    const dispatch = await prisma.executionDispatch.findFirstOrThrow({ where: { kind: "operation_driver", subjectKind: "notification",
      subjectId: `em1.p.${ledger.id}`, generation: ledger.generation, deadlineKind: null } });
    return { ledger, reference: (await readExecutionDispatch(prisma, dispatch.id))!.reference };
  }

  async function replayRenderParentAfterGroupRetry(
    runId: string,
    lifecycle: RenderFixtureLifecycle,
    _attempt: WorkflowAttemptRef,
  ) {
    await lifecycle.finishGroups();
    await lifecycle.retryGroups(runId);
    return claimRenderAttempt();
  }

  async function failOwnedRenderVariant(
    lifecycle: RenderFixtureLifecycle,
    attempt: WorkflowAttemptRef,
    variantId: string,
    disposition: "retryable" | "permanent",
    errorCode: string,
  ) {
    await lifecycle.markClipRenderVariantRendering(attempt, variantId);
    await lifecycle.failClipRenderVariant(attempt, variantId, errorCode, disposition);
  }

  async function proveRenderWorkSetBeginRollback(
    installFailure: (names: {
      functionName: string;
      triggerName: string;
    }) => Promise<() => Promise<void>>,
  ) {
    const { project, run } = await fixture("clip_rendering");
    const firstClip = await clipFixture(project.id, run.id);
    const secondClip = await clipFixture(project.id, run.id, 1);
    const firstVariant = await prisma.clipRender.create({
      data: { clipId: firstClip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    const suffix = randomUUID().replaceAll("-", "");
    const names = {
      functionName: `workflow_test_failure_${suffix}`,
      triggerName: `workflow_test_failure_${suffix}`,
    };
    const cleanup = await installFailure(names);
    try {
      await expect(lifecycle.beginRenderWorkSet(attempt)).rejects.toThrow();
    } finally {
      await cleanup();
    }
    const secondVariant = await prisma.clipRender.create({
      data: { clipId: secondClip.id, aspectRatio: "ratio_1_1" },
    });

    const workSet = await lifecycle.beginRenderWorkSet(attempt);

    expect([...workSet.variantIds].sort()).toEqual(
      [firstVariant.id, secondVariant.id].sort(),
    );
  }

  async function renderSettlementSnapshot(input: {
    projectId: string;
    workflowRunId: string;
    variantId: string;
    lateVariantId: string;
  }) {
    const [run, variant, lateVariant, eventCount, followUpCount] =
      await Promise.all([
        prisma.workflowRun.findUniqueOrThrow({
          where: { id: input.workflowRunId },
          select: {
            status: true,
            progress: true,
            errorCode: true,
            attemptId: true,
            leaseOwner: true,
            leaseExpiresAt: true,
            requestedCount: true,
            succeededCount: true,
            failedCount: true,
          },
        }),
        prisma.clipRender.findUniqueOrThrow({
          where: { id: input.variantId },
          select: {
            status: true,
            errorCode: true,
            failureDisposition: true,
            workflowAttemptId: true,
            completedAt: true,
          },
        }),
        prisma.clipRender.findUniqueOrThrow({
          where: { id: input.lateVariantId },
          select: {
            status: true,
            workflowRunId: true,
            workflowAttemptId: true,
          },
        }),
        prisma.workflowEvent.count({
          where: { workflowRunId: input.workflowRunId },
        }),
        prisma.workflowRun.count({
          where: {
            projectId: input.projectId,
            idempotencyKey: `drain-${input.workflowRunId}`,
          },
        }),
      ]);
    return { run, variant, lateVariant, eventCount, followUpCount };
  }

  test("project expiry cancels queued runs through the lifecycle", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("dubbing");
    const running = await prisma.workflowRun.create({
      data: {
        projectId: project.id,
        idempotencyKey: `running:${randomUUID()}`,
        stage: "clip_rendering",
        status: "running",
      },
    });
    const lifecycle = new RenderFixtureLifecycle({ prisma });

    const cancelled = await lifecycle.cancelQueuedProjectRuns({
      projectId: project.id,
      errorCode: "PROJECT_EXPIRED",
    });

    expect(cancelled).toBe(1);
    expect(
      await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({ status: "cancelled", errorCode: "PROJECT_EXPIRED" });
    expect(
      await prisma.workflowRun.findUniqueOrThrow({ where: { id: running.id } }),
    ).toMatchObject({ status: "running", errorCode: null });
    expect(
      await prisma.workflowEvent.count({ where: { workflowRunId: run.id } }),
    ).toBe(0);
  })));

  test("the first exact parent preparation freezes eligible pending variants without rewriting history", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const [pending, completed, failed] = await Promise.all([
      prisma.clipRender.create({
        data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
      }),
      prisma.clipRender.create({
        data: {
          clipId: clip.id,
          aspectRatio: "ratio_1_1",
          status: "completed",
          storageKey: "test/completed.mp4",
          completedAt: new Date(),
        },
      }),
      prisma.clipRender.create({
        data: {
          clipId: clip.id,
          aspectRatio: "ratio_16_9",
          status: "failed",
          errorCode: "historical_failure",
          completedAt: new Date(),
        },
      }),
    ]);
    const { lifecycle, attempt } = await claimRenderAttempt();

    const workSet = await lifecycle.beginRenderWorkSet(attempt);

    expect(workSet.workflowRunId).toBe(run.id);
    expect(workSet.frozenAt).toBeInstanceOf(Date);
    expect(workSet.variantIds).toEqual([pending.id]);
    expect(workSet.variantIds).not.toContain(completed.id);
    expect(workSet.variantIds).not.toContain(failed.id);
  })));

  test("the render state loader returns one attempt-start project and work-set snapshot", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { user, workspace, project, run } = await fixture("clip_rendering");
    await Promise.all([
      prisma.workspace.update({
        where: { id: workspace.id },
        data: { pricingTier: "pro" },
      }),
      prisma.project.update({
        where: { id: project.id },
        data: {
          sourceStorageKey: `projects/${project.id}/source/input.mp4`,
          sourceDurationSeconds: 42,
          brandSnapshot: { primaryColor: "#123456" },
        },
      }),
    ]);
    const clip = await clipFixture(project.id, run.id);
    await prisma.clip.update({
      where: { id: clip.id },
      data: { splitLayoutAnalysis: { version: 1, engine: "explicit-split-v1" } },
    });
    const pending = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const completed = await prisma.clipRender.create({
      data: {
        clipId: clip.id,
        aspectRatio: "ratio_1_1",
        status: "completed",
        storageKey: "test/already-completed.mp4",
        completedAt: new Date(),
      },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);

    const state = await clipService.getFrozenRenderingStateForWorkSet(
      project.id,
      run.id,
    );

    expect(state).toMatchObject({
      sourceStorageKey: `projects/${project.id}/source/input.mp4`,
      sourceDurationSeconds: 42,
      workspaceId: workspace.id,
      pricingTier: "pro",
      workspaceOwnerUserId: user.id,
      brandSnapshot: {
        status: "available",
        value: { primaryColor: "#123456" },
      },
    });
    expect(state?.pendingRenders.map((render) => render.id)).toEqual([
      pending.id,
    ]);
    expect(state?.pendingRenders.map((render) => render.id)).not.toContain(
      completed.id,
    );
    expect(state?.pendingRenders[0]?.clip.splitLayoutAnalysis).toEqual({
      version: 1,
      engine: "explicit-split-v1",
    });
  })));

  test("an initially empty Render Work Set cannot expand on retry", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const { lifecycle: firstLifecycle, attempt: firstAttempt } =
      await claimRenderAttempt();

    const firstWorkSet = await firstLifecycle.beginRenderWorkSet(firstAttempt);
    expect(firstWorkSet.variantIds).toEqual([]);
    const lateVariant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle: retryLifecycle, attempt: retryAttempt } =
      await replayRenderParentAfterGroupRetry(run.id, firstLifecycle, firstAttempt);
    const retryWorkSet = await retryLifecycle.beginRenderWorkSet(retryAttempt);

    expect(retryWorkSet.frozenAt).toEqual(firstWorkSet.frozenAt);
    expect(retryWorkSet.variantIds).toEqual([]);
    expect(retryWorkSet.variantIds).not.toContain(lateVariant.id);
  })));

  test("a retry reads only the variants already bound to its Workflow Run", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const firstClip = await clipFixture(project.id, run.id);
    const retryClip = await clipFixture(project.id, run.id, 1);
    const originalVariant = await prisma.clipRender.create({
      data: { clipId: firstClip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle: firstLifecycle, attempt: firstAttempt } =
      await claimRenderAttempt();
    expect(
      (await firstLifecycle.beginRenderWorkSet(firstAttempt)).variantIds,
    ).toEqual([originalVariant.id]);
    const lateVariant = await prisma.clipRender.create({
      data: { clipId: retryClip.id, aspectRatio: "ratio_1_1" },
    });
    const { lifecycle: retryLifecycle, attempt: retryAttempt } =
      await replayRenderParentAfterGroupRetry(run.id, firstLifecycle, firstAttempt);
    const retryWorkSet = await retryLifecycle.beginRenderWorkSet(retryAttempt);

    expect(retryWorkSet.variantIds).toEqual([originalVariant.id]);
    expect(retryWorkSet.variantIds).not.toContain(lateVariant.id);
  })));

  test("a changed ledger tuple cannot begin a Render Work Set", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variant = await prisma.clipRender.create({ data: { clipId: clip.id, aspectRatio: "ratio_9_16" } });
    const { lifecycle, attempt } = await claimRenderAttempt();
    const reference = await lifecycle.referenceFor(attempt);
    expect(await lifecycle.prepareRenderRun({ ...reference, inputHash: "f".repeat(64) })).toMatchObject({ kind: "superseded" });
    expect(await prisma.workflowEvent.count({ where: { workflowRunId: run.id, notificationRequired: true } })).toBe(0);
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).renderWorkSetFrozenAt).toBeNull();
    expect((await lifecycle.beginRenderWorkSet(attempt)).variantIds).toEqual([variant.id]);
    expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ attemptId: null, leaseOwner: null, attemptCount: 0 });
  })));

  test("a retry excludes variants deleted from its frozen Render Work Set", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle: firstLifecycle, attempt: firstAttempt } =
      await claimRenderAttempt();
    expect(
      (await firstLifecycle.beginRenderWorkSet(firstAttempt)).variantIds,
    ).toEqual([variant.id]);
    await prisma.clipRender.delete({ where: { id: variant.id } });
    const { lifecycle: retryLifecycle, attempt: retryAttempt } =
      await replayRenderParentAfterGroupRetry(run.id, firstLifecycle, firstAttempt);
    expect(
      (await retryLifecycle.beginRenderWorkSet(retryAttempt)).variantIds,
    ).toEqual([]);
  })));

  test("the frozen Render Work Set includes export-bound pending variants", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const clipExport = await prisma.clipExport.create({
      data: {
        projectId: project.id,
        clipId: clip.id,
        editorRevision: 1,
        fingerprint: `workflow-db-test:${randomUUID()}`,
        resolution: "1080p",
        watermark: false,
      },
    });
    const exportVariant = await prisma.clipExportVariant.create({
      data: {
        exportId: clipExport.id,
        aspectRatio: "ratio_9_16",
        resolution: "1080p",
        watermark: false,
      },
    });
    const render = await prisma.clipRender.create({
      data: {
        clipId: clip.id,
        aspectRatio: "ratio_9_16",
        exportVariantId: exportVariant.id,
        editorRevision: 1,
        clipSnapshot: { id: clip.id, editorRevision: 1 },
      },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();

    expect((await lifecycle.beginRenderWorkSet(attempt)).variantIds).toEqual([
      render.id,
    ]);
  })));

  test("a candidate-assignment failure leaves the Render Work Set unfrozen", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    await proveRenderWorkSetBeginRollback(
      async ({ functionName, triggerName }) => {
        await pool.query(`
          CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION 'render_work_set_candidate_failure';
          END;
          $$ LANGUAGE plpgsql;
          CREATE TRIGGER "${triggerName}"
          BEFORE UPDATE OF "workflowRunId" ON "ClipRender"
          FOR EACH ROW
          WHEN (OLD."workflowRunId" IS DISTINCT FROM NEW."workflowRunId")
          EXECUTE FUNCTION "${functionName}"();
        `);
        return async () => {
          await pool.query(`
            DROP TRIGGER IF EXISTS "${triggerName}" ON "ClipRender";
            DROP FUNCTION IF EXISTS "${functionName}"();
          `);
        };
      },
    );
  })));

  test("a failure immediately before commit rolls back assignment and freezing together", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    await proveRenderWorkSetBeginRollback(
      async ({ functionName, triggerName }) => {
        await pool.query(`
          CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION 'render_work_set_commit_failure';
          END;
          $$ LANGUAGE plpgsql;
          CREATE CONSTRAINT TRIGGER "${triggerName}"
          AFTER UPDATE ON "WorkflowRun"
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW
          WHEN (
            OLD."renderWorkSetFrozenAt" IS DISTINCT FROM NEW."renderWorkSetFrozenAt"
          )
          EXECUTE FUNCTION "${functionName}"();
        `);
        return async () => {
          await pool.query(`
            DROP TRIGGER IF EXISTS "${triggerName}" ON "WorkflowRun";
            DROP FUNCTION IF EXISTS "${functionName}"();
          `);
        };
      },
    );
  })));

  test("a variant created after candidate selection remains unassigned", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const firstClip = await clipFixture(project.id, run.id);
    const lateClip = await clipFixture(project.id, run.id, 1);
    const firstVariant = await prisma.clipRender.create({
      data: { clipId: firstClip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `workflow_test_pause_candidate_${suffix}`;
    const triggerName = `workflow_test_pause_candidate_${suffix}`;
    const advisoryLockKey = Math.floor(Math.random() * 2_000_000_000);
    const lockHolder = await pool.connect();
    let lockHeld = false;
    let beginning: Promise<Awaited<ReturnType<typeof lifecycle.beginRenderWorkSet>>> | null = null;
    try {
      await lockHolder.query("SELECT pg_advisory_lock($1)", [advisoryLockKey]);
      lockHeld = true;
      await pool.query(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${advisoryLockKey});
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER "${triggerName}"
        BEFORE UPDATE OF "workflowRunId" ON "ClipRender"
        FOR EACH ROW
        WHEN (OLD."workflowRunId" IS DISTINCT FROM NEW."workflowRunId")
        EXECUTE FUNCTION "${functionName}"();
      `);
      beginning = lifecycle.beginRenderWorkSet(attempt);
      let assignmentWaiting = false;
      for (let poll = 0; poll < 100 && !assignmentWaiting; poll += 1) {
        const waiting = await pool.query<Array<{ count: bigint }>>(`
          SELECT COUNT(*)::bigint AS "count"
          FROM pg_stat_activity
          WHERE pid <> ${lockHolder.processID}
            AND wait_event_type = 'Lock'
            AND query LIKE '%ClipRender%'
            AND query NOT LIKE '%pg_stat_activity%'
        `);
        assignmentWaiting = Number(waiting.rows[0]?.count ?? 0) > 0;
        if (!assignmentWaiting) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(assignmentWaiting).toBe(true);
      const lateVariant = await prisma.clipRender.create({
        data: { clipId: lateClip.id, aspectRatio: "ratio_1_1" },
      });
      await lockHolder.query("SELECT pg_advisory_unlock($1)", [advisoryLockKey]);
      lockHeld = false;

      const workSet = await beginning;
      expect(workSet.variantIds).toEqual([firstVariant.id]);
      expect(workSet.variantIds).not.toContain(lateVariant.id);
    } finally {
      if (lockHeld) {
        await lockHolder.query("SELECT pg_advisory_unlock($1)", [advisoryLockKey]);
      }
      await beginning?.catch(() => undefined);
      await pool.query(`
        DROP TRIGGER IF EXISTS "${triggerName}" ON "ClipRender";
        DROP FUNCTION IF EXISTS "${functionName}"();
      `);
      lockHolder.release();
    }
  })));

  test("a mixed Render Work Set settles partial with durable notification intent", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const [completedVariant, failedVariant] = await Promise.all([
      prisma.clipRender.create({
        data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
      }),
      prisma.clipRender.create({
        data: { clipId: clip.id, aspectRatio: "ratio_1_1" },
      }),
    ]);
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    await lifecycle.markClipRenderVariantRendering(attempt, completedVariant.id);
    await lifecycle.completeClipRenderVariant(attempt, completedVariant.id, {
      storageKey: "projects/test/renders/completed-attempt.mp4",
      sizeBytes: 1024,
      durationSec: 10,
    });
    await lifecycle.markClipRenderVariantRendering(attempt, failedVariant.id);
    await lifecycle.failClipRenderVariant(attempt, failedVariant.id, "source_invalid", "permanent");

    const outcome = await lifecycle.settleRenderWorkSet(attempt);

    expect(outcome).toEqual({
      status: "partial",
      requested: 2,
      succeeded: 1,
      failed: 1,
      superseded: 0,
      followUpWorkflowRunId: null,
    });
    expect(
      await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({
      status: "partial",
      requestedCount: 2,
      succeededCount: 1,
      failedCount: 1,
    });
    expect(
      await prisma.workflowEvent.findFirstOrThrow({
        where: { workflowRunId: run.id, notificationRequired: true },
      }),
    ).toMatchObject({
      status: "partial",
      notificationDeliveredAt: expect.any(Date),
    });

    const { ledger, reference } = await admittedNotification(project.id, run.id);
    expect(ledger).toMatchObject({ outcome: "clips_ready", status: "pending", facts: { clipCount: 1, reason: null }, attemptCount: 0 });
    const handedOff: string[] = [];
    const dispatcher = createNotificationExecution({ database: prisma, register: async ids => {
      expect(await prisma.executionDispatch.count({ where: { id: { in: [...ids] } } })).toBe(ids.length);
    }, prepare: async (_target, sealed) => sealed ?? { encrypted: "sealed-partial-clips", hash: "a".repeat(64) }, send: async target => {
      expect(target).toEqual({ kind: "project", id: ledger.id }); handedOff.push(ledger.outcome); return { sent: true, providerMessageId: "partial-fixture" };
    } });
    expect(await dispatcher.run(reference)).toEqual({ kind: "complete" });
    expect(await dispatcher.run(reference)).toEqual({ kind: "complete" });
    expect(handedOff).toEqual(["clips_ready"]);
    expect(await prisma.notificationLedger.findUniqueOrThrow({ where: { id: ledger.id } })).toMatchObject({ status: "sent", attemptCount: 1 });
  })));

  test("terminal Render Work Set outcomes carry distinct typed notification payloads", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const settle = async (outcome: "completed" | "partial" | "failed") => {
      const { project, run } = await fixture("clip_rendering");
      const clip = await clipFixture(project.id, run.id);
      const variants = await Promise.all(
        Array.from({ length: outcome === "partial" ? 2 : 1 }, (_, index) =>
          prisma.clipRender.create({
            data: {
              clipId: clip.id,
              aspectRatio: index === 0 ? "ratio_9_16" : "ratio_1_1",
            },
          }),
        ),
      );
      const { lifecycle, attempt } = await claimRenderAttempt();
      await lifecycle.beginRenderWorkSet(attempt);

      if (outcome !== "failed") {
        const completed = variants[0]!;
        await lifecycle.markClipRenderVariantRendering(attempt, completed.id);
        await lifecycle.completeClipRenderVariant(attempt, completed.id, {
          storageKey: `projects/test/renders/${outcome}.mp4`,
          sizeBytes: 512,
          durationSec: 8,
        });
      }
      if (outcome !== "completed") {
        const failed = variants.at(-1)!;
        await failOwnedRenderVariant(
          lifecycle,
          attempt,
          failed.id,
          "permanent",
          "source_invalid",
        );
      }

      await lifecycle.settleRenderWorkSet(attempt);
      const event = await prisma.workflowEvent.findFirstOrThrow({
        where: { workflowRunId: run.id, notificationRequired: true },
      });
      return workflowStageUpdatedEventSchema.parse(event.payload);
    };

    const completed = await settle("completed");
    const partial = await settle("partial");
    const failed = await settle("failed");

    expect([
      completed.notification,
      partial.notification,
      failed.notification,
    ]).toEqual([
      {
        kind: "clip_render.completed",
        projectId: completed.projectId,
        workflowRunId: completed.workflowRunId,
        requested: 1,
        succeeded: 1,
        failed: 0,
        superseded: 0,
      },
      {
        kind: "clip_render.partial",
        projectId: partial.projectId,
        workflowRunId: partial.workflowRunId,
        requested: 2,
        succeeded: 1,
        failed: 1,
        superseded: 0,
      },
      {
        kind: "clip_render.failed",
        projectId: failed.projectId,
        workflowRunId: failed.workflowRunId,
        requested: 1,
        succeeded: 0,
        failed: 1,
        superseded: 0,
      },
    ]);
  })));

  test("notification dispatch replays safely around durable ledger handoff", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    await lifecycle.markClipRenderVariantRendering(attempt, variant.id);
    await lifecycle.completeClipRenderVariant(attempt, variant.id, {
      storageKey: "projects/test/renders/replay-safe.mp4",
      sizeBytes: 512,
      durationSec: 8,
    });
    await lifecycle.settleRenderWorkSet(attempt);

    const event = await prisma.workflowEvent.findFirstOrThrow({
      where: { workflowRunId: run.id, notificationRequired: true },
    });
    const settledRun = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    const settledVariant = await prisma.clipRender.findUniqueOrThrow({
      where: { id: variant.id },
    });
    const { ledger, reference } = await admittedNotification(project.id, run.id);
    expect(ledger).toMatchObject({ status: "pending", attemptCount: 0, facts: { clipCount: 1, reason: null } });
    expect(event.notificationDeliveredAt).toBeInstanceOf(Date);
    let failurePoint: "registration" | "provider_response" | null = "registration";
    let preparations = 0;
    const providerKeys: string[] = [], bodies: string[] = [];
    const sealed = { encrypted: "sealed-original-clips-ready-request", hash: "b".repeat(64) };
    const dispatcher = createNotificationExecution({ database: prisma,
      register: async ids => {
        expect(await prisma.executionDispatch.count({ where: { id: { in: [...ids] } } })).toBe(ids.length);
        if (failurePoint === "registration") throw Error("crash_before_delivery_registration");
      },
      prepare: async (target, previous) => {
        expect(target).toEqual({ kind: "project", id: ledger.id }); preparations++;
        if (previous) expect(previous).toEqual(sealed);
        return previous ?? sealed;
      },
      send: async (_target, body, key) => {
        providerKeys.push(key); bodies.push(body.encrypted);
        if (failurePoint === "provider_response") throw Error("crash_after_provider_acceptance");
        return { sent: true, providerMessageId: "same-idempotency-key" };
      },
    });
    await expect(dispatcher.run(reference)).rejects.toThrow("crash_before_delivery_registration");
    expect(preparations).toBe(0);
    expect(await prisma.notificationLedger.findUniqueOrThrow({ where: { id: ledger.id } })).toMatchObject({ status: "pending", attemptCount: 0, deliveryInputEncrypted: null });
    failurePoint = "provider_response";
    await dispatcher.run(reference);
    const uncertain = await prisma.notificationLedger.findUniqueOrThrow({ where: { id: ledger.id } });
    expect(uncertain).toMatchObject({ status: "pending", attemptCount: 1, generation: 2, deliveryInputEncrypted: sealed.encrypted, deliveryInputHash: sealed.hash });
    // Advance only the disposable retry clock; keep its committed dispatch and
    // original provider key/body/deadline. A refreshed Project cannot re-seal it.
    await prisma.notificationLedger.update({ where: { id: ledger.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await prisma.project.update({ where: { id: project.id }, data: { title: "Changed after provider acceptance" } });
    failurePoint = null;
    const retry = await admittedNotification(project.id, run.id);
    await dispatcher.run(retry.reference);
    await dispatcher.run(retry.reference);
    expect(providerKeys).toEqual([`notification-ledger-${ledger.id}`, `notification-ledger-${ledger.id}`]);
    expect(bodies).toEqual([sealed.encrypted, sealed.encrypted]);
    expect(await prisma.notificationLedger.count({ where: { projectId: project.id, sourceId: run.id } })).toBe(1);
    expect(await prisma.notificationLedger.findUniqueOrThrow({ where: { id: ledger.id } })).toMatchObject({ status: "sent", attemptCount: 2, operationDeadlineAt: ledger.operationDeadlineAt });
    expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toEqual(settledRun);
    expect(await prisma.clipRender.findUniqueOrThrow({ where: { id: variant.id } })).toEqual(settledVariant);
  })));

  test("notification delivery leaves unrelated Workflow Events on their durable progress path", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("dubbing");
    await prisma.workflowRun.update({ where: { id: run.id }, data: { status: "completed" } });
    const lifecycle = new WorkflowRunLifecycle({ prisma });
    const admitted = await lifecycle.admit({ projectId: project.id, idempotencyKey: `unrelated-event:${randomUUID()}`, stage: "dubbing" });
    const event = await prisma.workflowEvent.findFirstOrThrow({ where: { workflowRunId: admitted.id } });
    const dispatch = await prisma.executionDispatch.findFirstOrThrow({ where: { kind: "project_progress", subjectKind: "maintenance", subjectId: { startsWith: `pe1.${Buffer.from(project.id.replaceAll("-", ""), "hex").toString("base64url")}.` } } });
    const published: string[] = [];
    await withProgressDelivery({ publish: async (_scope, payload) => { published.push(payload.workflowRunId); }, revoke: async () => {}, registerContinuations: async () => {} }, async () => {
      expect((await createExecutionDispatch({ database: prisma, scheduler: { deliver: ({ reference }) => deliverProgressDispatch(prisma, reference) } }).deliver(dispatch.id)).status).toBe("acknowledged");
    });
    expect(published).toContain(admitted.id);
    expect(await prisma.workflowEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ progressPublishedAt: expect.any(Date), notificationRequired: false, notificationDeliveredAt: null });
    expect(await prisma.notificationLedger.count({ where: { projectId: project.id } })).toBe(0);
  })));

  test("invalid progress notification payloads cannot replace the already admitted delivery facts", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    await failOwnedRenderVariant(
      lifecycle,
      attempt,
      variant.id,
      "permanent",
      "source_invalid",
    );
    await lifecycle.settleRenderWorkSet(attempt);

    const event = await prisma.workflowEvent.findFirstOrThrow({
      where: { workflowRunId: run.id, notificationRequired: true },
    });
    const payload = event.payload as Prisma.JsonObject;
    await prisma.workflowEvent.update({
      where: { id: event.id },
      data: {
        payload: {
          ...payload,
          notification: {
            ...(payload.notification as Prisma.JsonObject),
            requested: "not-a-count",
          },
        },
      },
    });
    const invalidEvent = await prisma.workflowEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(() => workflowStageUpdatedEventSchema.parse(invalidEvent.payload)).toThrow();
    const { ledger, reference } = await admittedNotification(project.id, run.id);
    expect(ledger).toMatchObject({ outcome: "generation_failed", facts: { clipCount: 0, reason: null } });
    let sends = 0;
    await createNotificationExecution({ database: prisma, register: async () => {},
      prepare: async (_target, sealed) => sealed ?? { encrypted: "sealed-failure-facts", hash: "c".repeat(64) },
      send: async () => { sends++; return { sent: true }; },
    }).run(reference);
    expect(sends).toBe(1);
    expect(await prisma.notificationLedger.findUniqueOrThrow({ where: { id: ledger.id } })).toMatchObject({ status: "sent", facts: ledger.facts });
    expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "failed", requestedCount: 1, failedCount: 1 });
  })));

  test.each(["recovered", "exhausted"])("successful siblings survive transient backoff until %s", bindServiceTestEnvironment(prismaGlobal.bind(async (ending) => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const completed = await prisma.clipRender.create({ data: { clipId: clip.id, aspectRatio: "ratio_9_16" } });
    const transient = await prisma.clipRender.create({ data: { clipId: clip.id, aspectRatio: "ratio_1_1" } });
    const permanent = await prisma.clipRender.create({ data: { clipId: clip.id, aspectRatio: "ratio_16_9" } });
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    await lifecycle.markClipRenderVariantRendering(attempt, completed.id);
    await lifecycle.completeClipRenderVariant(attempt, completed.id, { storageKey: "tests/preserved-success.mp4", sizeBytes: 123, durationSec: 10 });
    await failOwnedRenderVariant(lifecycle, attempt, permanent.id, "permanent", "source_media_invalid");
    const preserved = await prisma.clipRender.findUniqueOrThrow({ where: { id: completed.id } });
    const permanentRow = await prisma.clipRender.findUniqueOrThrow({ where: { id: permanent.id } });
    for (let count = 1; count <= 3; count += 1) {

      const before = Date.now();
      await failOwnedRenderVariant(lifecycle, attempt, transient.id, "retryable", "storage_temporarily_unavailable");
      const outcome = await lifecycle.settleRenderWorkSet(attempt);
      if (count === 3) {
        expect(outcome).toMatchObject({ status: "partial", succeeded: 1, failed: 2 });
        expect(await lifecycle.settleRenderWorkSet(attempt)).toEqual(outcome);
        break;
      }
      expect(outcome).toMatchObject({ status: "pending", succeeded: 1, failed: 1 });
      const queued = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(queued).toMatchObject({ status: "waiting", attemptId: null, attemptCount: 0, leaseOwner: null, progress: 60, succeededCount: 1, failedCount: 1 });
      expect((await prisma.renderGroup.findFirstOrThrow({where:{workflowRunId:run.id}})).nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + count * 30_000);
      expect(await prisma.workflowEvent.count({ where: { workflowRunId: run.id, notificationRequired: true } })).toBe(0);
      expect(await prisma.clipRender.findUniqueOrThrow({ where: { id: transient.id } })).toMatchObject({ status: "pending", workflowAttemptId: null, failureDisposition: null });
      expect(await prisma.clipRender.findUniqueOrThrow({ where: { id: completed.id } })).toEqual(preserved);
      expect(await prisma.clipRender.findUniqueOrThrow({ where: { id: permanent.id } })).toEqual(permanentRow);
      expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).leaseExpiresAt).toBeNull();
      await lifecycle.retryGroups(run.id);
      expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ progress: 60, succeededCount: 1, failedCount: 1 });
      await lifecycle.beginRenderWorkSet(attempt);
      expect(await lifecycle.markClipRenderVariantRendering(attempt, completed.id)).toBe(false);
      expect(await lifecycle.markClipRenderVariantRendering(attempt, permanent.id)).toBe(false);
      if (ending === "recovered") {
        await lifecycle.markClipRenderVariantRendering(attempt, transient.id);
        await lifecycle.completeClipRenderVariant(attempt, transient.id, { storageKey: "tests/recovered.mp4", sizeBytes: 123, durationSec: 10 });
        expect(await lifecycle.settleRenderWorkSet(attempt)).toMatchObject({ status: "partial", succeeded: 2, failed: 1 });
        break;
      }
    }
    expect(await prisma.workflowEvent.count({ where: { workflowRunId: run.id, notificationRequired: true } })).toBe(1);
    expect(await prisma.clipRender.findUniqueOrThrow({ where: { id: completed.id } })).toEqual(preserved);
    expect(await prisma.clipRender.findUniqueOrThrow({ where: { id: permanent.id } })).toEqual(permanentRow);
  })));

  test("zero success requeues only retryable variants and reports durable failure counts", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const [permanentVariant, retryableVariant] = await Promise.all([
      prisma.clipRender.create({
        data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
      }),
      prisma.clipRender.create({
        data: { clipId: clip.id, aspectRatio: "ratio_1_1" },
      }),
    ]);
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    for (const [variant, disposition] of [
      [permanentVariant, "permanent"],
      [retryableVariant, "retryable"],
    ] as const) {
      await failOwnedRenderVariant(
        lifecycle,
        attempt,
        variant.id,
        disposition,
        `${disposition}_render_failure`,
      );
    }

    expect(await lifecycle.settleRenderWorkSet(attempt)).toEqual({
      status: "pending",
      requested: 2,
      succeeded: 0,
      failed: 1,
      superseded: 0,
      followUpWorkflowRunId: null,
    });
    expect(
      await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({
      status: "waiting",
      requestedCount: 2,
      succeededCount: 0,
      failedCount: 1,
    });
    expect(
      await prisma.clipRender.findUniqueOrThrow({
        where: { id: permanentVariant.id },
      }),
    ).toMatchObject({ status: "failed", failureDisposition: "permanent" });
    expect(
      await prisma.clipRender.findUniqueOrThrow({
        where: { id: retryableVariant.id },
      }),
    ).toMatchObject({ status: "pending", failureDisposition: null });
    expect(
      await prisma.workflowEvent.count({
        where: { workflowRunId: run.id, notificationRequired: true },
      }),
    ).toBe(0);
  })));

  test("settlement does not retry a render without explicit retry disposition", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    await prisma.clipRender.update({
      where: { id: variant.id },
      data: {
        status: "failed",
        errorCode: "unclassified_render_failure",
        failureDisposition: null,
      },
    });

    expect(await lifecycle.settleRenderWorkSet(attempt)).toEqual({
      status: "failed",
      requested: 1,
      succeeded: 0,
      failed: 1,
      superseded: 0,
      followUpWorkflowRunId: null,
    });
    expect(
      await prisma.clipRender.findUniqueOrThrow({ where: { id: variant.id } }),
    ).toMatchObject({
      status: "failed",
      errorCode: "unclassified_render_failure",
      failureDisposition: null,
    });
  })));

  test("a subsequent native generation settles without repeating a completed variant", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const [completedVariant, interruptedVariant] = await Promise.all([
      prisma.clipRender.create({
        data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
      }),
      prisma.clipRender.create({
        data: { clipId: clip.id, aspectRatio: "ratio_1_1" },
      }),
    ]);
    const first = await claimRenderAttempt();
    await first.lifecycle.beginRenderWorkSet(first.attempt);
    await first.lifecycle.markClipRenderVariantRendering(first.attempt, completedVariant.id);
    await first.lifecycle.completeClipRenderVariant(first.attempt, completedVariant.id, {
      storageKey: "projects/test/renders/first-attempt.mp4",
      sizeBytes: 100,
      durationSec: 5,
    });
    await first.lifecycle.markClipRenderVariantRendering(first.attempt, interruptedVariant.id);

    const second = await replayRenderParentAfterGroupRetry(
      run.id,
      first.lifecycle,
      first.attempt,
    );
    expect(
      [
        ...(await second.lifecycle.beginRenderWorkSet(second.attempt)).variantIds,
      ].sort(),
    ).toEqual([completedVariant.id, interruptedVariant.id].sort());
    expect(
      await prisma.clipRender.findUniqueOrThrow({
        where: { id: completedVariant.id },
      }),
    ).toMatchObject({
      status: "completed",
      workflowAttemptId: null,
    });
    await second.lifecycle.markClipRenderVariantRendering(second.attempt, interruptedVariant.id);
    await second.lifecycle.completeClipRenderVariant(second.attempt, interruptedVariant.id, {
      storageKey: "projects/test/renders/second-attempt.mp4",
      sizeBytes: 100,
      durationSec: 5,
    });

    expect(await second.lifecycle.settleRenderWorkSet(second.attempt)).toEqual({
      status: "completed",
      requested: 2,
      succeeded: 2,
      failed: 0,
      superseded: 0,
      followUpWorkflowRunId: null,
    });
  })));

  test("an all-permanent zero-success set fails without spending another attempt", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variants = await Promise.all(
      (["ratio_9_16", "ratio_1_1"] as const).map((aspectRatio) =>
        prisma.clipRender.create({ data: { clipId: clip.id, aspectRatio } }),
      ),
    );
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    for (const variant of variants) {
      await failOwnedRenderVariant(
        lifecycle,
        attempt,
        variant.id,
        "permanent",
        "render_input_permanent",
      );
    }

    expect(await lifecycle.settleRenderWorkSet(attempt)).toEqual({
      status: "failed",
      requested: 2,
      succeeded: 0,
      failed: 2,
      superseded: 0,
      followUpWorkflowRunId: null,
    });
    expect(
      await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({
      status: "failed",
      attemptCount: 0,
      requestedCount: 2,
      succeededCount: 0,
      failedCount: 2,
      errorCode: "render_work_set_failed",
    });
  })));

  test("concurrent terminal replay serializes before follow-up unique-key contention", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const firstClip = await clipFixture(project.id, run.id);
    const lateClip = await clipFixture(project.id, run.id, 1);
    const completedVariant = await prisma.clipRender.create({
      data: { clipId: firstClip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    const lateVariant = await prisma.clipRender.create({
      data: { clipId: lateClip.id, aspectRatio: "ratio_1_1" },
    });
    await lifecycle.markClipRenderVariantRendering(attempt, completedVariant.id);
    await lifecycle.completeClipRenderVariant(attempt, completedVariant.id, {
      storageKey: "projects/test/renders/replayed.mp4",
      sizeBytes: 100,
      durationSec: 5,
    });

    const admissionLock = await pool.connect();
    let lockHeld = false;
    let settlement:
      | Promise<Awaited<ReturnType<typeof lifecycle.settleRenderWorkSet>>[]>
      | undefined;
    let outcomes: Awaited<ReturnType<typeof lifecycle.settleRenderWorkSet>>[] = [];
    try {
      await admissionLock.query(
        "SELECT pg_advisory_lock(hashtextextended($1, 0))",
        [project.id],
      );
      lockHeld = true;
      settlement = Promise.all(
        Array.from({ length: 10 }, () => lifecycle.settleRenderWorkSet(attempt)),
      );
      let waitingCount = 0;
      for (let poll = 0; poll < 100 && waitingCount < 2; poll += 1) {
        const waiting = await admissionLock.query<Array<{ count: bigint }>>(`
          SELECT COUNT(*)::bigint AS "count"
          FROM pg_stat_activity
          WHERE pid <> ${admissionLock.processID}
            AND wait_event_type = 'Lock'
            AND query LIKE '%pg_advisory_xact_lock%'
        `);
        waitingCount = Number(waiting.rows[0]?.count ?? 0);
        if (waitingCount < 2) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(waitingCount).toBeGreaterThanOrEqual(2);
      await admissionLock.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [project.id],
      );
      lockHeld = false;
      outcomes = await settlement;
    } finally {
      if (lockHeld) {
        await admissionLock.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [project.id],
        );
      }
      admissionLock.release();
      await settlement?.catch(() => undefined);
    }
    expect(new Set(outcomes.map((outcome) => JSON.stringify(outcome))).size).toBe(
      1,
    );
    const followUpId = outcomes[0]?.followUpWorkflowRunId;
    expect(followUpId).not.toBeNull();
    expect(
      await prisma.workflowRun.count({
        where: {
          projectId: project.id,
          idempotencyKey: `drain-${run.id}`,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.workflowEvent.count({
        where: {
          workflowRunId: run.id,
          status: "completed",
        },
      }),
    ).toBe(1);
    expect(
      await prisma.workflowEvent.count({
        where: {
          workflowRunId: followUpId!,
          dedupeKey: `${followUpId}:${followUpId}:admitted`,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.clipRender.findUniqueOrThrow({ where: { id: lateVariant.id } }),
    ).toMatchObject({ status: "pending", workflowRunId: null });
  })));

  for (const failpoint of [
    { phase: "aggregate update", table: "WorkflowRun", operation: "UPDATE" },
    { phase: "terminal event append", table: "WorkflowEvent", operation: "INSERT" },
    { phase: "follow-up admission", table: "WorkflowRun", operation: "INSERT" },
  ] as const) {
    for (const timing of ["BEFORE", "AFTER"] as const) {
      test(`settlement is atomic when ${timing} ${failpoint.phase} fails`, bindServiceTestEnvironment(prismaGlobal.bind(async () => {
        const { project, run } = await fixture("clip_rendering");
        const firstClip = await clipFixture(project.id, run.id);
        const lateClip = await clipFixture(project.id, run.id, 1);
        const variant = await prisma.clipRender.create({
          data: { clipId: firstClip.id, aspectRatio: "ratio_9_16" },
        });
        const { lifecycle, attempt } = await claimRenderAttempt();
        await lifecycle.beginRenderWorkSet(attempt);
        const lateVariant = await prisma.clipRender.create({
          data: { clipId: lateClip.id, aspectRatio: "ratio_1_1" },
        });
        await lifecycle.markClipRenderVariantRendering(attempt, variant.id);
        await spendRenderStarts(lifecycle, attempt, variant.id);
        await lifecycle.finishGroups();
        const snapshotInput = {
          projectId: project.id,
          workflowRunId: run.id,
          variantId: variant.id,
          lateVariantId: lateVariant.id,
        };
        const before = await renderSettlementSnapshot(snapshotInput);
        const suffix = randomUUID().replaceAll("-", "");
        const functionName = `workflow_test_settlement_${suffix}`;
        const triggerName = `workflow_test_settlement_${suffix}`;
        await pool.query(`
          CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION 'workflow_test_settlement_failure';
          END;
          $$ LANGUAGE plpgsql;
          CREATE TRIGGER "${triggerName}"
          ${timing} ${failpoint.operation} ON "${failpoint.table}"
          FOR EACH ROW
          EXECUTE FUNCTION "${functionName}"();
        `);
        try {
          await expect(lifecycle.settleRenderWorkSet(attempt)).rejects.toThrow(
            "workflow_test_settlement_failure",
          );
        } finally {
          await pool.query(`
            DROP TRIGGER IF EXISTS "${triggerName}" ON "${failpoint.table}";
            DROP FUNCTION IF EXISTS "${functionName}"();
          `);
        }

        expect(await renderSettlementSnapshot(snapshotInput)).toEqual(before);
        expect(await lifecycle.settleRenderWorkSet(attempt)).toMatchObject({
          status: "failed",
          requested: 1,
          succeeded: 0,
          failed: 1,
          superseded: 0,
          followUpWorkflowRunId: expect.any(String),
        });
      })));
    }
  }

  test("an all-superseded Render Work Set completes without notification intent", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    expect((await lifecycle.beginRenderWorkSet(attempt)).variantIds).toEqual([
      variant.id,
    ]);
    await prisma.clipRender.delete({ where: { id: variant.id } });

    expect(await lifecycle.settleRenderWorkSet(attempt)).toEqual({
      status: "completed",
      requested: 1,
      succeeded: 0,
      failed: 0,
      superseded: 1,
      followUpWorkflowRunId: null,
    });
    expect(
      await prisma.workflowEvent.count({
        where: { workflowRunId: run.id, notificationRequired: true },
      }),
    ).toBe(0);
  })));

  test("a render retry retains its frozen work count when every variant was superseded", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const first = await claimRenderAttempt();
    await first.lifecycle.beginRenderWorkSet(first.attempt);
    await first.lifecycle.finishGroups();
    await prisma.clipRender.delete({ where: { id: variant.id } });

    const retry = await claimRenderAttempt();
    expect((await retry.lifecycle.beginRenderWorkSet(retry.attempt)).variantIds).toEqual([]);

    expect(await retry.lifecycle.settleRenderWorkSet(retry.attempt)).toMatchObject({
      status: "completed", requested: 1, succeeded: 0, failed: 0, superseded: 1,
    });
    expect(await prisma.workflowEvent.count({
      where: { workflowRunId: run.id, notificationRequired: true },
    })).toBe(0);
  })));

  test("retry exhaustion creates durable failed-render notification intent", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    await lifecycle.markClipRenderVariantRendering(attempt, variant.id);
    await spendRenderStarts(lifecycle, attempt, variant.id);

    await lifecycle.settleRenderWorkSet(attempt);

    expect(
      await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({
      status: "failed",
      requestedCount: 1,
      succeededCount: 0,
      failedCount: 1,
    });
    expect(
      await prisma.workflowEvent.findFirstOrThrow({
        where: { workflowRunId: run.id, notificationRequired: true },
      }),
    ).toMatchObject({ status: "failed", notificationDeliveredAt: expect.any(Date) });
    const { ledger } = await admittedNotification(project.id, run.id);
    expect(ledger).toMatchObject({ outcome: "generation_failed", status: "pending", attemptCount: 0 });
  })));

  test("terminal native retry exhaustion settles the full lineage as partial", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const clipExport = await prisma.clipExport.create({
      data: {
        projectId: project.id,
        clipId: clip.id,
        editorRevision: 0,
        fingerprint: randomUUID(),
        resolution: "1080p",
        watermark: false,
      },
    });
    const exportVariant = await prisma.clipExportVariant.create({
      data: {
        exportId: clipExport.id,
        aspectRatio: "ratio_4_5",
        resolution: "1080p",
        watermark: false,
      },
    });
    const [completedVariant, pendingVariant, permanentVariant] = await Promise.all([
      prisma.clipRender.create({
        data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
      }),
      prisma.clipRender.create({
        data: { clipId: clip.id, aspectRatio: "ratio_1_1" },
      }),
      prisma.clipRender.create({
        data: {
          clipId: clip.id,
          aspectRatio: "ratio_4_5",
          exportVariantId: exportVariant.id, clipSnapshot: frozenExportSnapshot(clip), editorRevision: clip.editorRevision,
        },
      }),
    ]);
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    const lateVariant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_16_9" },
    });
    await lifecycle.markClipRenderVariantRendering(attempt, completedVariant.id);
    await lifecycle.completeClipRenderVariant(attempt, completedVariant.id, {
      storageKey: "projects/test/renders/reaper-completed.mp4",
      sizeBytes: 100,
      durationSec: 5,
    });
    await lifecycle.markClipRenderVariantRendering(attempt, permanentVariant.id);
    await lifecycle.failClipRenderVariant(attempt, permanentVariant.id, "source_invalid", "permanent");
    await spendRenderStarts(lifecycle, attempt, pendingVariant.id);

    await lifecycle.settleRenderWorkSet(attempt);

    expect(
      await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({
      status: "partial",
      requestedCount: 3,
      succeededCount: 1,
      failedCount: 2,
    });
    expect(
      await prisma.clipRender.findUniqueOrThrow({
        where: { id: pendingVariant.id },
      }),
    ).toMatchObject({ status: "failed", failureDisposition: "retryable" });
    expect(
      await prisma.clipExportVariant.findUniqueOrThrow({
        where: { id: exportVariant.id },
      }),
    ).toMatchObject({ status: "failed", errorCode: "source_invalid" });
    expect(
      await prisma.workflowEvent.findFirstOrThrow({
        where: { workflowRunId: run.id, notificationRequired: true },
      }),
    ).toMatchObject({ status: "partial" });
    const followUpRun = await prisma.workflowRun.findUniqueOrThrow({
      where: {
        projectId_idempotencyKey: {
          projectId: project.id,
          idempotencyKey: `drain-${run.id}`,
        },
      },
    });
    expect(followUpRun).toMatchObject({
      status: "queued",
      stage: "clip_rendering",
    });
    const [parentTerminalEvent, followUpQueuedEvent] = await Promise.all([
      prisma.workflowEvent.findFirstOrThrow({
        where: { workflowRunId: run.id, status: "partial" },
      }),
      prisma.workflowEvent.findFirstOrThrow({
        where: { workflowRunId: followUpRun.id, status: "queued" },
      }),
    ]);
    expect(parentTerminalEvent.seq).toBeLessThan(followUpQueuedEvent.seq);
    expect(
      await prisma.clipRender.findUniqueOrThrow({ where: { id: lateVariant.id } }),
    ).toMatchObject({ status: "pending", workflowRunId: null });
  })));

  test("Clip Export status follows native retry and terminal settlement", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const clipExport = await prisma.clipExport.create({
      data: {
        projectId: project.id,
        clipId: clip.id,
        editorRevision: 0,
        fingerprint: randomUUID(),
        resolution: "1080p",
        watermark: false,
      },
    });
    const exportVariant = await prisma.clipExportVariant.create({
      data: {
        exportId: clipExport.id,
        aspectRatio: "ratio_9_16",
        resolution: "1080p",
        watermark: false,
      },
    });
    const render = await prisma.clipRender.create({
      data: {
        clipId: clip.id,
        aspectRatio: "ratio_9_16",
        exportVariantId: exportVariant.id, clipSnapshot: frozenExportSnapshot(clip), editorRevision: clip.editorRevision,
      },
    });
    const readExport = () =>
      prisma.clipExport.findUniqueOrThrow({
        where: { id: clipExport.id },
        select: { status: true, completedAt: true },
      });

    const first = await claimRenderAttempt();
    await first.lifecycle.beginRenderWorkSet(first.attempt);
    await first.lifecycle.markClipRenderVariantRendering(first.attempt, render.id);
    await first.lifecycle.failClipRenderVariant(
      first.attempt,
      render.id,
      "render_upload_failed",
      "retryable",
    );
    await first.lifecycle.settleRenderWorkSet(first.attempt);
    expect(
      await prisma.workflowRun.findUniqueOrThrow({
        where: { id: run.id },
        select: { status: true },
      }),
    ).toEqual({ status: "waiting" });
    expect(await readExport()).toEqual({ status: "queued", completedAt: null });

    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    await first.lifecycle.retryGroups(run.id);
    const last = first;
    await last.lifecycle.beginRenderWorkSet(last.attempt);
    await last.lifecycle.markClipRenderVariantRendering(last.attempt, render.id);
    expect((await readExport()).status).toBe("rendering");
    await spendRenderStarts(last.lifecycle, last.attempt, render.id);
    await last.lifecycle.settleRenderWorkSet(last.attempt);

    const settled = await readExport();
    expect(settled.status).toBe("failed");
    expect(settled.completedAt).not.toBeNull();
  })));

  test("terminal native retry exhaustion completes an all-superseded lineage silently", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    await prisma.clipRender.delete({ where: { id: variant.id } });

    await lifecycle.settleRenderWorkSet(attempt);

    expect(
      await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({
      status: "completed",
      requestedCount: 1,
      succeededCount: 0,
      failedCount: 0,
    });
    expect(
      await prisma.workflowEvent.count({
        where: { workflowRunId: run.id, notificationRequired: true },
      }),
    ).toBe(0);
  })));

  test("50 identical admissions return one deterministic run", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project } = await fixture();
    await prisma.workflowRun.deleteMany({ where: { projectId: project.id } });
    const lifecycles = Array.from(
      { length: 50 },
      () => new RenderFixtureLifecycle({ prisma, leaseOwner: randomUUID() }),
    );
    const settledAdmissions = await Promise.allSettled(
      lifecycles.map((lifecycle) =>
        lifecycle.admit({
          projectId: project.id,
          idempotencyKey: "same-logical-request",
          stage: "dubbing",
        }),
      ),
    );
    const rejected = settledAdmissions.filter(
      (result) => result.status === "rejected",
    );
    expect(rejected).toEqual([]);
    const results = settledAdmissions.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(
      await prisma.workflowRun.count({ where: { projectId: project.id } }),
    ).toBe(1);
    expect(
      await prisma.workflowEvent.count({ where: { projectId: project.id } }),
    ).toBe(1);
  })));

  test("different idempotency keys racing for one stage return one live run", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project } = await fixture("moment_detection");
    await prisma.workflowRun.deleteMany({ where: { projectId: project.id } });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        new RenderFixtureLifecycle({
          prisma,
          leaseOwner: randomUUID(),
        }).admit({
          projectId: project.id,
          idempotencyKey: `different-key:${index}`,
          stage: "moment_detection",
        }),
      ),
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(
      await prisma.workflowRun.count({ where: { projectId: project.id } }),
    ).toBe(1);
    expect(
      await prisma.workflowEvent.count({ where: { projectId: project.id } }),
    ).toBe(1);
  })));

  test("existing Content Packs must be committed and belong to the admitted project", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { user, workspace, project } = await fixture("moment_detection");
    await prisma.workflowRun.deleteMany({ where: { projectId: project.id } });
    const otherProject = await prisma.project.create({
      data: {
        title: "Other workflow project",
        sourceMediaUrl: "r2://test/other.mp4",
        workspaceId: workspace.id,
        createdByUserId: user.id,
      },
    });
    const packData = {
      outputTypes: ["short_clip" as const],
      clipCountTarget: 3,
      clipDurationSecTarget: 45,
      toneConstraints: [],
      captionPreset: "brand_default",
      platformPlaybookVersion: "test",
    };
    const [otherPack, draftPack] = await Promise.all([
      prisma.contentPack.create({
        data: { projectId: otherProject.id, ...packData },
      }),
      prisma.contentPack.create({
        data: { projectId: project.id, ...packData, draft: true },
      }),
    ]);
    const lifecycle = new RenderFixtureLifecycle({ prisma });

    await expect(
      lifecycle.admit({
        projectId: project.id,
        idempotencyKey: "wrong-project-pack",
        stage: "moment_detection",
        contentPackId: otherPack.id,
      }),
    ).rejects.toThrow("workflow_content_pack_invalid");
    await expect(
      lifecycle.admit({
        projectId: project.id,
        idempotencyKey: "draft-pack",
        stage: "moment_detection",
        contentPackId: draftPack.id,
      }),
    ).rejects.toThrow("workflow_content_pack_invalid");
  })));

  test("STT admission atomically binds its content pack, transcript, and initial event", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project } = await fixture("stt");
    await prisma.workflowRun.deleteMany({ where: { projectId: project.id } });
    const lifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const admitted = await lifecycle.admitTranscript({
      projectId: project.id,
      idempotencyKey: `stt-admission:${randomUUID()}`,
      languageCode: "en",
      transcriptProvider: "elevenlabs",
      transcriptProviderModel: "scribe_v2",
      contentPack: {
        outputTypes: ["short_clip"],
        clipGenerationMode: "best",
        clipCountTarget: 3,
        clipDurationSecTarget: 45,
        minDurationSec: 15,
        preferredMinDurationSec: 30,
        preferredMaxDurationSec: 60,
        maxDurationSec: 90,
        platformTargets: ["tiktok"],
        toneConstraints: [],
        captionPreset: "brand_default",
        platformPlaybookVersion: "test",
        mode: "clip",
        autoHook: true,
        specificMoments: "",
        processingStartSec: null,
        processingEndSec: null,
        clipLengthPreset: "auto",
        defaultAspectRatio: "9:16",
      },
    });

    const [run, transcript, events] = await Promise.all([
      prisma.workflowRun.findUniqueOrThrow({
        where: { id: admitted.id },
        include: { contentPack: true },
      }),
      prisma.transcript.findUniqueOrThrow({
        where: { projectId: project.id },
      }),
      prisma.workflowEvent.findMany({
        where: { workflowRunId: admitted.id },
      }),
    ]);
    expect(run.contentPack?.clipCountTarget).toBe(3);
    expect(transcript.status).toBe("queued");
    expect(transcript.provider).toBe("elevenlabs");
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("queued");
  })));

  test("detected-clip replacement durably retires every referenced media object", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("moment_detection");
    const clip = await clipFixture(project.id, run.id);
    await prisma.clip.update({
      where: { id: clip.id },
      data: { previewStorageKey: `private/${clip.id}/preview.mp4` },
    });
    await prisma.clipRender.create({
      data: {
        clipId: clip.id,
        aspectRatio: "ratio_9_16",
        status: "completed",
        storageKey: `private/${clip.id}/render.mp4`,
      },
    });
    const selection = await preparedSelection(run.id);
    await selection.control.runParent(selection.reference);

    expect(await prisma.clip.findUnique({ where: { id: clip.id } })).toBeNull();
    expect(
      await prisma.mediaCleanupObligation.findMany({
        where: {
          origin: "detected_clip_replacement",
          projectId: project.id,
          clipId: clip.id,
        },
        orderBy: { cleanupClass: "asc" },
        select: { cleanupClass: true, objectKey: true },
      }),
    ).toEqual([
      {
        cleanupClass: "mutable_render",
        objectKey: `private/${clip.id}/render.mp4`,
      },
      {
        cleanupClass: "preview_peaks",
        objectKey: `private/${clip.id}/preview.peaks.json`,
      },
      {
        cleanupClass: "preview_proxy",
        objectKey: `private/${clip.id}/preview.mp4`,
      },
    ]);
  })));

  test("detected-clip replacement rolls back cleanup admission when Clip removal fails", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("moment_detection");
    const clip = await clipFixture(project.id, run.id);
    const render = await prisma.clipRender.create({
      data: {
        clipId: clip.id,
        aspectRatio: "ratio_9_16",
        status: "completed",
        storageKey: `private/${clip.id}/render.mp4`,
      },
    });
    const selection = await preparedSelection(run.id);
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `workflow_test_clip_delete_failure_${suffix}`;
    const triggerName = `workflow_test_clip_delete_failure_${suffix}`;
    await pool.query(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'detected_clip_replacement_delete_failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER "${triggerName}"
      BEFORE DELETE ON "Clip"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
    `);
    try {
      await expect(selection.control.runParent(selection.reference)).rejects.toThrow(
        "detected_clip_replacement_delete_failure",
      );
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS "${triggerName}" ON "Clip";
        DROP FUNCTION IF EXISTS "${functionName}"();
      `);
    }

    expect(await prisma.clip.findUnique({ where: { id: clip.id } })).not.toBeNull();
    expect(
      await prisma.clipRender.findUnique({ where: { id: render.id } }),
    ).not.toBeNull();
    expect(
      await prisma.mediaCleanupObligation.count({
        where: { origin: "detected_clip_replacement", clipId: clip.id },
      }),
    ).toBe(0);
  })));

  test("detected clips are seeded with the Project's Brand Profile music through the real persistence path", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("moment_detection");
    const trackId = randomUUID();
    await prisma.project.update({ where: { id: project.id }, data: { brandProfileSnapshot: {
      version: 1, profileId: randomUUID(), profileRevision: 1, name: "Northstar", identity: {}, voice: {}, approvalRule: "none", style: null,
      audio: { music: [{ assetId: trackId, title: "Theme", durationSec: 60 }, { assetId: randomUUID(), title: "Second", durationSec: 30 }], sfx: [] },
    } } });
    await prisma.project.update({ where: { id: project.id }, data: { sourceDurationSeconds: 120, ingestStatus: "ready" } });
    const pack = await prisma.contentPack.create({ data: { projectId: project.id, ...buildGenerationContentPack({ clipCountTarget: 3, clipLengthPreset: "30_to_60s" }) } });
    await prisma.workflowRun.update({ where: { id: run.id }, data: { contentPackId: pack.id } });
    await prisma.transcript.create({ data: { projectId: project.id, status: "completed", sourceRevision: 1, workflowAttemptId: randomUUID(), languageCode: "en", speakerCount: 1,
      text: "A frozen transcript with three independent stories.", utterancesJson: Array.from({ length: 120 }, (_, index) => ({ index, speaker: 0, speakerLabel: "Speaker 1", startSec: index, endSec: index + 1,
        text: `Story ${index}.`, confidence: null, words: [{ word: `Story${index}.`, startSec: index, endSec: index + 1, confidence: null }] })) } });
    const workflow = new WorkflowRunLifecycle({ prisma }), reference = (await prisma.$transaction(tx => workflow.dispatchRunWithinTransaction(tx, run.id))).reference;
    const objects = new Map<string, Uint8Array>();
    const storage: ClipSelectionStorage = {
      async write(key, bytes) { objects.set(key, bytes.slice()); return { etag: '"sealed"', byteLength: bytes.byteLength, sha256: await clipSelectionBytesHash(bytes) }; },
      async read(object) { const bytes = objects.get(object.storageKey); if (!bytes || object.etag !== '"sealed"') throw Error("Changed private selection object"); return bytes.slice(); },
    };
    const preparation = createClipSelectionPreparation({ database: prisma, storage, provider: { model: "gpt-5.4-mini", reasoningEffort: "medium", maxOutputTokens: 32000 } });
    const prepared = await preparation.prepare(reference);
    if (prepared.kind !== "prepared") throw Error("Expected actual selection preparation");
    let providerCalls = 0;
    const control = createClipSelectionControl({ preparation, storage,
      lifecycle: createClipSelectionLifecycle({ database: prisma, maxInFlightRequests: 1, maxEstimatedTokens: 240000 }), finalization: workflow,
      deliver: async ids => { expect(await prisma.executionDispatch.count({ where: { id: { in: [...ids] } } })).toBe(ids.length); },
      provider: { async generate() { providerCalls++; return { kind: "completed", tokensUsed: 123, providerRequestId: "brand-music-fixture", rateLimitHeaders: {},
        content: JSON.stringify({ clips: [0, 40, 80].map(start => ({ title: `Story ${start}`, start_time: start, end_time: start + 30, hook_text: "Hook", payoff_text: "Payoff", reasoning: "Fixture",
          category: "hook", platform_fit: ["tiktok"], hook_strength: 70, emotional_intensity: 70, story_completeness_score: 70, broll_cues: [] })) }) }; } },
    });
    for (const window of prepared.windows) expect(await control.runWindow(window)).toEqual({ kind: "complete", outcome: "completed" });
    expect(await control.runParent(reference)).toEqual({ kind: "complete", outcome: "completed" });
    const clips = await prisma.clip.findMany({ where: { projectId: project.id }, orderBy: { index: "asc" } });
    expect(clips).toHaveLength(3);
    for (const clip of clips) expect(studioEditsSchema.parse(clip.studioEdits).music).toMatchObject({ assetId: trackId, title: "Theme", url: null });
    expect(await prisma.workflowRun.findFirstOrThrow({ where: { projectId: project.id, stage: "clip_rendering" } })).toMatchObject({ status: "queued", attemptId: null, leaseOwner: null, attemptCount: 0 });
    expect(await prisma.clipRender.count({ where: { clip: { projectId: project.id }, status: "pending", workflowRunId: null, workflowAttemptId: null } })).toBe(3);
    expect(providerCalls).toBe(1);
    expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "completed", attemptId: null, leaseOwner: null, attemptCount: 0 });
  })));

  test("a captioned video cannot finalize detection before immutable clip preparation, and nothing is admitted or completed", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("moment_detection");
    await prisma.project.update({ where: { id: project.id }, data: { sourceDurationSeconds: 8, ingestStatus: "ready" } });
    const pack = await prisma.contentPack.create({ data: { projectId: project.id, ...buildCaptionedVideoContentPack(buildCaptionedVideoSettings({ captions: { source: "none" } })) } });
    await prisma.workflowRun.update({ where: { id: run.id }, data: { contentPackId: pack.id } });
    await prisma.transcript.create({ data: { projectId: project.id, sourceRevision: 1, status: "completed", workflowAttemptId: randomUUID(), text: "", utterancesJson: [] } });
    const lifecycle = new WorkflowRunLifecycle({ prisma }), reference = (await prisma.$transaction(tx => lifecycle.dispatchRunWithinTransaction(tx, run.id))).reference;
    expect(await lifecycle.finalizeClipSelection(reference, null)).toMatchObject({ kind: "not_prepared", dispatchIds: [] });
    expect(await prisma.clipExport.count({ where: { projectId: project.id } })).toBe(0);
    expect(await prisma.clip.count({ where: { projectId: project.id } })).toBe(0);
    expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "queued", attemptId: null, leaseOwner: null, attemptCount: 0 });
    expect(await prisma.workflowEvent.count({ where: { workflowRunId: run.id, status: "completed" } })).toBe(0);
  })));

  test("export child completion settles its parent aggregate in the same lifecycle command", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const clipExport = await prisma.clipExport.create({
      data: {
        projectId: project.id,
        clipId: clip.id,
        editorRevision: 0,
        fingerprint: randomUUID(),
        resolution: "1080p",
        watermark: false,
      },
    });
    const exportVariant = await prisma.clipExportVariant.create({
      data: {
        exportId: clipExport.id,
        aspectRatio: "ratio_9_16",
        resolution: "1080p",
        watermark: false,
      },
    });
    const render = await prisma.clipRender.create({
      data: {
        clipId: clip.id,
        aspectRatio: "ratio_9_16",
        exportVariantId: exportVariant.id, clipSnapshot: frozenExportSnapshot(clip), editorRevision: clip.editorRevision,
      },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    await lifecycle.markClipRenderVariantRendering(attempt, render.id);

    expect(
      await prisma.clipExport.findUniqueOrThrow({ where: { id: clipExport.id } }),
    ).toMatchObject({ status: "rendering", progress: 5 });

    await lifecycle.completeClipRenderVariant(attempt, render.id, {
      storageKey: "projects/test/exports/completed.mp4",
      sizeBytes: 100,
      durationSec: 5,
    });

    expect(
      await prisma.clipExport.findUniqueOrThrow({ where: { id: clipExport.id } }),
    ).toMatchObject({
      status: "ready",
      progress: 100,
      errorCode: null,
      completedAt: expect.any(Date),
    });
  })));

  test.each(["retry success", "retry exhaustion", "partial success"])("a retryable render failure cannot freeze a failed export callback before %s", bindServiceTestEnvironment(prismaGlobal.bind(async (ending) => {
    const { project, run, workspace } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const exported = await prisma.clipExport.create({ data: { workspaceId: workspace.id, projectId: project.id, clipId: clip.id, editorRevision: 0, fingerprint: randomUUID(), resolution: "1080p", watermark: false } });
    const variant = await prisma.clipExportVariant.create({ data: { exportId: exported.id, aspectRatio: "ratio_9_16", resolution: "1080p", watermark: false } });
    const render = await prisma.clipRender.create({ data: { clipId: clip.id, aspectRatio: "ratio_9_16", exportVariantId: variant.id, clipSnapshot: frozenExportSnapshot(clip), editorRevision: clip.editorRevision } });
    const callback = await prisma.completionCallback.create({ data: { workspaceId: workspace.id, operationKind: "export", operationId: exported.id, receiptId: randomUUID(), encryptedUrl: "unused", urlHost: "example.test", urlFingerprint: "a".repeat(64), eventId: randomUUID() } });
    const sourceBodies=new Map<string,Uint8Array>();
    const observer = new OutboundDeliveryService(prisma,{readTrusted:createOperationStatusReader(prisma).readTrusted,cipher:createCallbackCipher("workflow-callback-test-key"),register:async()=>{},body:{put:async(plan,bytes)=>{sourceBodies.set(plan.storageKey,bytes);},head:async plan=>sourceBodies.has(plan.storageKey)?{etag:'"body"',sha256:plan.sha256,byteLength:plan.byteLength}:null,read:async()=>{throw new Error("No native execution in lifecycle freeze test");}}});
    const sibling = ending === "partial success" ? await prisma.clipRender.create({ data: { clipId: clip.id, aspectRatio: "ratio_1_1" } }) : null;
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    await lifecycle.markClipRenderVariantRendering(attempt, render.id);
    if (sibling) {
      await lifecycle.markClipRenderVariantRendering(attempt, sibling.id);
      await lifecycle.completeClipRenderVariant(attempt, sibling.id, { storageKey: "tests/sibling.mp4", sizeBytes: 100, durationSec: 5 });
    }
    await lifecycle.failClipRenderVariant(attempt, render.id, "storage_temporarily_unavailable", "retryable");
    expect((await observer.prepareCompletion(callback.id)).kind).toBe("waiting");
    expect(await prisma.completionCallback.findUniqueOrThrow({ where: { id: callback.id } })).toMatchObject({ state: "waiting", payload: null });
    expect(await prisma.clipExport.findUniqueOrThrow({ where: { id: exported.id } })).toMatchObject({ status: "queued", completedAt: null });
    if (ending !== "retry success") {
      await spendRenderStarts(lifecycle, attempt, render.id);
      await lifecycle.failClipRenderVariant(attempt, render.id, "storage_temporarily_unavailable", "retryable");
    }
    expect(await lifecycle.settleRenderWorkSet(attempt)).toMatchObject({ status: ending === "retry success" ? "pending" : ending === "partial success" ? "partial" : "failed" });
    if (ending === "retry success") {
      await prisma.workflowRun.update({ where: { id: run.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await lifecycle.retryGroups(run.id);
      const retry = { lifecycle, attempt };
      await retry.lifecycle.beginRenderWorkSet(retry.attempt);
      await retry.lifecycle.markClipRenderVariantRendering(retry.attempt, render.id);
      await retry.lifecycle.completeClipRenderVariant(retry.attempt, render.id, { storageKey: "tests/retry-success.mp4", sizeBytes: 100, durationSec: 5 });
      await retry.lifecycle.settleRenderWorkSet(retry.attempt);
    }
    await prisma.completionCallback.update({ where: { id: callback.id }, data: { nextObservationAt: new Date(Date.now() - 1000) } });
    expect((await observer.prepareCompletion(callback.id)).kind).toBe("accepted");
    expect(await prisma.clipExport.findUniqueOrThrow({ where: { id: exported.id } })).toMatchObject({ status: ending === "retry success" ? "ready" : "failed", completedAt: expect.any(Date) });
    expect(await prisma.completionCallback.findUniqueOrThrow({ where: { id: callback.id } })).toMatchObject({ state: "pending", payload: { data: { state: ending === "retry success" ? "completed" : "failed" } } });
  })));

  test("concurrent export child completions serialize parent aggregate settlement", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const clipExport = await prisma.clipExport.create({
      data: {
        projectId: project.id,
        clipId: clip.id,
        editorRevision: 0,
        fingerprint: randomUUID(),
        resolution: "1080p",
        watermark: false,
      },
    });
    const exportVariants = await Promise.all(
      (["ratio_9_16", "ratio_1_1"] as const).map((aspectRatio) =>
        prisma.clipExportVariant.create({
          data: {
            exportId: clipExport.id,
            aspectRatio,
            resolution: "1080p",
            watermark: false,
          },
        }),
      ),
    );
    const renders = await Promise.all(
      exportVariants.map((variant) =>
        prisma.clipRender.create({
          data: {
            clipId: clip.id,
            aspectRatio: variant.aspectRatio,
            exportVariantId: variant.id, clipSnapshot: frozenExportSnapshot(clip), editorRevision: clip.editorRevision,
          },
        }),
      ),
    );
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    await Promise.all(
      renders.map((render) =>
        lifecycle.markClipRenderVariantRendering(attempt, render.id),
      ),
    );

    await Promise.all(
      renders.map((render, index) =>
        lifecycle.completeClipRenderVariant(attempt, render.id, {
          storageKey: `projects/test/exports/concurrent-${index}.mp4`,
          sizeBytes: 100,
          durationSec: 5,
        }),
      ),
    );

    expect(
      await prisma.clipExport.findUniqueOrThrow({ where: { id: clipExport.id } }),
    ).toMatchObject({
      status: "ready",
      progress: 100,
      errorCode: null,
      completedAt: expect.any(Date),
    });
  })));

  describe("durable provider submission", () => {
    async function providerReply(pending: ReturnType<WorkflowRunLifecycle["expireProviderDeadline"]>) {
      const value = await pending;
      const { dispatchIds, ...disposition } = value;
      if (value.kind === "applied") expect(dispatchIds?.length).toBeGreaterThan(0);
      if (dispatchIds) {
        expect(new Set(dispatchIds).size).toBe(dispatchIds.length);
        expect(dispatchIds.length).toBeLessThanOrEqual(128);
        const epoch = (await prisma.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
        expect(await prisma.executionDispatch.count({ where: { id: { in: dispatchIds }, deploymentEpoch: epoch } })).toBe(dispatchIds.length);
      }
      return disposition;
    }
    const transcriptInput = (providerJobId: string, providerRequestId: string) => ({
      provider: "elevenlabs",
      providerModel: "scribe_v2",
      providerJobId,
      providerRequestId,
      languageCode: "en",
      languageConfidence: 1,
      text: "test transcript",
      utterances: [] as Prisma.InputJsonValue,
      speakerCount: 1,
      durationSeconds: 10,
      rawStorageKey: null,
    });
    async function begun(expiredDeadline?: Date) {
      const { run, project } = await fixture("stt");
      const epoch = (await prisma.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
      await prisma.project.update({ where: { id: project.id }, data: { ingestStatus: "ready", sourceDurationSeconds: 10,
        sourceProbe: { durationSec: 10, video: null, audio: { sampleRate: 48000, channels: 2 } } } });
      const source = await prisma.ingestJob.create({ data: { projectId: project.id, deploymentEpoch: epoch, jobType: "upload_finalize", payload: {}, status: "completed" } });
      const sourceToken = randomUUID(), sourceOwner = randomUUID(), storageKey = `execution/${epoch}/${sourceToken}/${sourceOwner}/source.m4a`;
      const sourceDispatch = await prisma.$transaction(tx => appendExecutionDispatch(tx, { kind: "modal_execution", subject: { kind: "ingest_job", id: source.id },
        generation: 1, deploymentEpoch: epoch, inputHash: "a".repeat(64), dueAt: source.createdAt }));
      await prisma.executionAttempt.create({ data: { attemptToken: sourceToken, dispatchId: sourceDispatch.reference.dispatchId, deploymentEpoch: epoch,
        generation: 1, inputHash: sourceDispatch.reference.inputHash, functionName: "fetch_source", owner: sourceOwner, status: "completed",
        leaseExpiresAt: new Date(Date.now() + 120000), operationDeadlineAt: new Date(Date.now() + 45 * 60000), processStartedAt: new Date(), finishedAt: new Date() } });
      await prisma.executionArtifact.create({ data: { attemptToken: sourceToken, owner: sourceOwner, role: "source_audio", storageKey,
        bindingHash: "b".repeat(64), contentType: "audio/mp4", maxBytes: 4096n, byteLength: 1024n, etag: '"audio"', checksumSha256: "c".repeat(64), grantExpiresAt: new Date(Date.now() + 60000), committedAt: new Date() } });
      const audio = await prisma.sourceAudio.create({ data: { projectId: project.id, sourceRevision: project.sourceRevision, mediaProvider: "upload", mediaId: project.id,
        audioTrack: { id: "0", codec: "aac", sampleRate: 48000, channels: 2 }, bindingHash: "d".repeat(64), storageKey, etag: '"audio"', byteLength: 1024n,
        checksumSha256: "c".repeat(64), durationSeconds: 10, audioStartTimeSec: 0, probeVersion: "normalized-probe-1", toolchainFingerprint: "e".repeat(64) } });
      await prisma.transcript.create({ data: { projectId: project.id, sourceRevision: project.sourceRevision, sourceAudioId: audio.id } });
      const owner = randomUUID(), worker = new WorkflowRunLifecycle({ prisma, leaseOwner: owner });
      // The API process holds no lease; it is a different lifecycle instance.
      const api = new WorkflowRunLifecycle({ prisma, leaseOwner: randomUUID() });
      const reference = (await prisma.$transaction(tx => worker.dispatchRunWithinTransaction(tx, run.id))).reference;
      const admitted = await createTranscriptionAdmission({ database: prisma, workflow: worker, maxUnits: 12 }).admit(reference, { owner });
      if (admitted.kind !== "begun") throw Error(`Expected provider admission, got ${admitted.kind}`);
      // A disposable past-deadline fixture exercises DB-clock expiry without
      // waiting ten minutes. It does not alter the accepted Generic deadline.
      const deadline = expiredDeadline ?? admitted.intent.submissionDeadlineAt!;
      if (expiredDeadline) {
        if (expiredDeadline >= admitted.intent.serverTime) throw Error("Only an already expired disposable deadline may be seeded");
        await prisma.transcript.update({ where: { projectId: project.id }, data: { providerSubmissionDeadlineAt: deadline } });
        await prisma.workflowRun.update({ where: { id: run.id }, data: { nextPollAt: deadline } });
      }
      const attempt: ProviderAttemptReference & WorkflowAttemptRef = { ...admitted.intent.reference, projectId: project.id, stage: "stt", attemptCount: 1 };
      expect(await prisma.executionAttempt.findUniqueOrThrow({ where: { attemptToken: attempt.attemptId } })).toMatchObject({ status: "completed", processStartedAt: expect.any(Date), revokedAt: expect.any(Date) });
      expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).attemptCount).toBe(1);
      return { run, project, worker, api, attempt, deadline };
    }

    test("shutdown recovery leaves an accepted provider transcript waiting instead of submitting again", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { run, project, worker, api, attempt } = await begun();
      await providerReply(api.recordProviderAcceptance(attempt, { requestId: "request-before-shutdown", transcriptionId: "accepted-before-shutdown", nextPollAt: new Date(Date.now() + 60000) }));
      const history = await prisma.executionAttempt.findUniqueOrThrow({ where: { attemptToken: attempt.attemptId } });
      const reference = (await readExecutionDispatch(prisma, history.dispatchId))!.reference;
      const replay = await createTranscriptionAdmission({ database: prisma, workflow: worker, maxUnits: 12 }).admit(reference, { owner: randomUUID() });
      expect(replay.kind).toBe("already_waiting");
      if (replay.kind !== "already_waiting") throw Error("Expected the same accepted provider intent");
      expect(replay.intent.reference).toEqual({ workflowRunId: attempt.workflowRunId, attemptId: attempt.attemptId, deploymentEpoch: attempt.deploymentEpoch, sourceRevision: attempt.sourceRevision, sourceAudioId: attempt.sourceAudioId });
      expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "waiting", attemptId: attempt.attemptId, attemptCount: 1, leaseOwner: null, leaseExpiresAt: null });
      expect((await prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } })).providerJobId).toBe("accepted-before-shutdown");
      expect(await prisma.executionAttempt.count({ where: { dispatch: { subjectId: run.id }, functionName: "stt" } })).toBe(1);
    })));

    test("waiting STT survives its closed Generic watchdog and finalizes only its correlated attempt", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { run, project, worker, api, attempt } = await begun();
      await providerReply(api.recordProviderAcceptance(attempt, { requestId: "provider-request-1", transcriptionId: "provider-job-1", nextPollAt: new Date(Date.now() - 1000) }));
      const history = await prisma.executionAttempt.findUniqueOrThrow({ where: { attemptToken: attempt.attemptId } });
      const reference = (await readExecutionDispatch(prisma, history.dispatchId))!.reference;
      const control = createExecutorControl({ database: prisma, domain: worker, subjectKind: "workflow_run", deliverWakes: async () => {} });
      expect(await control.expireDeadline({ deadline: { reference, attemptToken: attempt.attemptId, kind: "lease", observedDeadlineAt: history.leaseExpiresAt!.toISOString() }, deliveryId: randomUUID() })).toEqual({ kind: "terminal" });
      expect(await worker.readProviderControl(attempt)).toMatchObject({ kind: "waiting", attempt: { attemptId: attempt.attemptId }, providerJobId: "provider-job-1" });
      expect(await providerReply(api.completeProviderTranscript({ ...attempt, attemptId: randomUUID() }, transcriptInput("provider-job-1", "provider-request-1")))).toEqual({ kind: "stale", reason: "attempt_superseded" });
      expect(await providerReply(api.completeProviderTranscript(attempt, transcriptInput("provider-job-1", "provider-request-1")))).toEqual({ kind: "applied" });
      expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "completed", attemptCount: 1 });
      expect((await prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } })).workflowAttemptId).toBe(attempt.attemptId);
      expect(await prisma.workflowRun.findFirstOrThrow({ where: { projectId: project.id, stage: "moment_detection" } })).toMatchObject({ status: "queued", attemptId: null, leaseOwner: null });
    })));

    test("begin parks the run waiting with no provider id and stamps Scribe", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { run, project, attempt, deadline } = await begun();
      expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "waiting", leaseOwner: null, leaseExpiresAt: null, attemptId: attempt.attemptId, nextPollAt: deadline,
      });
      expect(await prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } })).toMatchObject({
        provider: "elevenlabs", providerModel: "scribe_v2", providerJobId: null, providerRequestId: null,
        providerSubmissionDeadlineAt: deadline, workflowAttemptId: attempt.attemptId, status: "processing",
      });
    })));

    test("acceptance stores both ids, is idempotent, and rejects a different transcription", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { project, api, attempt } = await begun();
      const accepted = { requestId: "req-1", transcriptionId: "tr-1", nextPollAt: new Date(Date.now() + 60_000) };
      expect(await providerReply(api.recordProviderAcceptance(attempt, accepted))).toEqual({ kind: "applied" });
      expect(await providerReply(api.recordProviderAcceptance(attempt, accepted))).toEqual({ kind: "duplicate" });
      expect(await providerReply(api.recordProviderAcceptance(attempt, { ...accepted, transcriptionId: "tr-other" }))).toEqual({ kind: "stale", reason: "provider_job_mismatch" });
      expect(await prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } })).toMatchObject({
        providerJobId: "tr-1", providerRequestId: "req-1", providerSubmissionDeadlineAt: null,
      });
    })));

    test("a callback before acceptance completes the run and the late acceptance never resurrects it", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { run, project, api, attempt } = await begun();
      expect(await providerReply(api.completeProviderTranscript(attempt, transcriptInput("tr-1", "req-1")))).toEqual({ kind: "applied" });
      expect(await providerReply(api.recordProviderAcceptance(attempt, { requestId: "req-1", transcriptionId: "tr-1", nextPollAt: new Date() }))).toEqual({ kind: "duplicate" });
      expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "completed", nextPollAt: null });
      expect(await prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } })).toMatchObject({
        status: "completed", providerJobId: "tr-1", providerRequestId: "req-1", providerSubmissionDeadlineAt: null,
      });
    })));

    test("a duplicate success delivery changes nothing", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { project, run, api, attempt } = await begun();
      await api.recordProviderAcceptance(attempt, { requestId: "req-1", transcriptionId: "tr-1", nextPollAt: new Date() });
      const first = await api.completeProviderTranscript(attempt, transcriptInput("tr-1", "req-1"));
      const duplicate = await api.completeProviderTranscript(attempt, transcriptInput("tr-1", "req-1"));
      expect(await providerReply(Promise.resolve(first))).toEqual({ kind: "applied" });
      expect(await providerReply(Promise.resolve(duplicate))).toEqual({ kind: "duplicate" });
      expect(duplicate.dispatchIds?.slice().sort()).toEqual(first.dispatchIds?.slice().sort());
      expect(await prisma.workflowRun.count({ where: { projectId: project.id, stage: "moment_detection" } })).toBe(1);
      expect(await prisma.workflowEvent.count({ where: { workflowRunId: run.id, stage: "stt", status: "completed" } })).toBe(1);
      expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).attemptCount).toBe(1);
    })));

    test("a completion for another transcription of the same attempt is stale", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { api, attempt, run } = await begun();
      await api.recordProviderAcceptance(attempt, { requestId: "req-1", transcriptionId: "tr-1", nextPollAt: new Date() });
      expect(await providerReply(api.completeProviderTranscript(attempt, transcriptInput("tr-other", "req-1")))).toEqual({ kind: "stale", reason: "provider_job_mismatch" });
      expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("waiting");
    })));

    test("a crash before the id is saved fails at the deadline and the next attempt resubmits", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { run, project, worker, api, attempt, deadline } = await begun(new Date(Date.now() - 1_000));
      expect(await worker.readProviderControl(attempt)).toMatchObject({ kind: "waiting", attempt: { attemptId: attempt.attemptId }, providerJobId: null, submissionDeadlineAt: deadline });
      expect(await providerReply(worker.expireProviderDeadline(attempt, { kind: "submission", observedDeadlineAt: deadline }))).toEqual({ kind: "applied" });
      expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "queued", attemptId: null, attemptCount: 1,
      });
      expect(await prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } })).toMatchObject({
        providerJobId: null, providerRequestId: null, providerSubmissionDeadlineAt: null, workflowAttemptId: null,
      });
      // The first attempt's late acceptance cannot resurrect anything.
      expect(await providerReply(api.recordProviderAcceptance(attempt, { requestId: "late", transcriptionId: "late", nextPollAt: new Date() }))).toEqual({ kind: "stale", reason: "attempt_superseded" });

      await prisma.workflowRun.update({ where: { id: run.id }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
      const queued = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
      const nextDispatch = await prisma.executionDispatch.findFirstOrThrow({ where: { subjectKind: "workflow_run", subjectId: run.id,
        generation: queued.generation, deploymentEpoch: attempt.deploymentEpoch, kind: "operation_driver", wakeKind: null, deadlineKind: null } });
      const next = await createTranscriptionAdmission({ database: prisma, workflow: worker, maxUnits: 12 }).admit((await readExecutionDispatch(prisma, nextDispatch.id))!.reference, { owner: randomUUID() });
      expect(next.kind).toBe("begun");
      if (next.kind !== "begun") throw Error("Expected authorized provider retry");
      expect(next.intent.reference.attemptId).not.toBe(attempt.attemptId);
      expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).attemptCount).toBe(2);
      expect(await prisma.executionAttempt.count({ where: { dispatch: { subjectId: run.id }, functionName: "stt", processStartedAt: { not: null } } })).toBe(2);
    })));

    test("an unconfirmed submission before its deadline, or one accepted meanwhile, is left alone", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const early = await begun();
      expect(await early.worker.expireProviderDeadline(early.attempt, { kind: "submission", observedDeadlineAt: early.deadline })).toEqual({ kind: "sleep", dueAt: early.deadline });
      const accepted = await begun();
      await accepted.api.recordProviderAcceptance(accepted.attempt, { requestId: "r", transcriptionId: "t", nextPollAt: new Date() });
      expect(await providerReply(accepted.worker.expireProviderDeadline(accepted.attempt, { kind: "submission", observedDeadlineAt: accepted.deadline }))).toEqual({ kind: "stale", reason: "submission_confirmed" });
    })));

    test("a completion that omits provider ids keeps the accepted ones", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const omitting = { ...transcriptInput("x", "y"), providerJobId: null, providerRequestId: null };
      const { project, api, attempt } = await begun();
      await api.recordProviderAcceptance(attempt, { requestId: "req-1", transcriptionId: "tr-1", nextPollAt: new Date() });
      expect(await providerReply(api.completeProviderTranscript(attempt, omitting))).toEqual({ kind: "applied" });
      expect(await prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } })).toMatchObject({
        status: "completed", providerJobId: "tr-1", providerRequestId: "req-1",
      });

      // Only the request id supplied (the documented webhook): the transcription id survives.
      const partial = await begun();
      await partial.api.recordProviderAcceptance(partial.attempt, { requestId: "req-2", transcriptionId: "tr-2", nextPollAt: new Date() });
      expect(await providerReply(partial.api.completeProviderTranscript(partial.attempt, { ...omitting, providerRequestId: "req-2" }))).toEqual({ kind: "applied" });
      expect(await prisma.transcript.findUniqueOrThrow({ where: { projectId: partial.project.id } })).toMatchObject({
        providerJobId: "tr-2", providerRequestId: "req-2",
      });
    })));

    test("a callback while the submission is unconfirmed completes the same attempt", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { run, project, api, attempt } = await begun();
      expect(await providerReply(api.completeProviderTranscript(attempt, { ...transcriptInput("tr-1", "req-1") }))).toEqual({ kind: "applied" });
      expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "completed", attemptId: attempt.attemptId });
      expect(await prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } })).toMatchObject({
        status: "completed", providerJobId: "tr-1", providerRequestId: "req-1", workflowAttemptId: attempt.attemptId,
      });
    })));

    test("an exhausted attempt budget fails the run at the deadline with the retry-exhausted code", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { run, worker, attempt, deadline } = await begun(new Date(Date.now() - 1_000));
      await prisma.workflowRun.update({ where: { id: run.id }, data: { attemptCount: WORKFLOW_MAX_ATTEMPTS } });
      expect(await providerReply(worker.expireProviderDeadline(attempt, { kind: "submission", observedDeadlineAt: deadline }))).toEqual({ kind: "applied" });
      expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "failed", errorCode: WORKFLOW_RETRIES_EXHAUSTED_CODE,
      });
    })));

    test("a stale attempt's completion and failure are no-ops", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { run, worker, api, attempt, deadline } = await begun(new Date(Date.now() - 1_000));
      await providerReply(worker.expireProviderDeadline(attempt, { kind: "submission", observedDeadlineAt: deadline }));
      expect(await providerReply(api.completeProviderTranscript(attempt, transcriptInput("tr-1", "req-1")))).toEqual({ kind: "stale", reason: "attempt_superseded" });
      expect(await providerReply(api.failProviderAttempt(attempt, new WorkflowFailure("elevenlabs_quota_exhausted", "permanent", "x")))).toEqual({ kind: "stale", reason: "attempt_superseded" });
      expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("queued");
      expect(await providerReply(api.completeProviderTranscript({ ...attempt, workflowRunId: randomUUID(), attemptId: randomUUID() }, transcriptInput("a", "b")))).toEqual({ kind: "stale", reason: "run_missing" });
    })));

    test("a cancelled run acknowledges callbacks without changing", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { run, project, api, attempt } = await begun();
      await prisma.workflowRun.update({ where: { id: run.id }, data: { status: "failed", errorCode: "MCP_CANCELLED", nextPollAt: null } });
      expect(await providerReply(api.completeProviderTranscript(attempt, transcriptInput("tr-1", "req-1")))).toEqual({ kind: "terminal", status: "failed" });
      expect(await providerReply(api.recordProviderAcceptance(attempt, { requestId: "req-1", transcriptionId: "tr-1", nextPollAt: new Date() }))).toEqual({ kind: "terminal", status: "failed" });
      expect(await providerReply(api.failProviderAttempt(attempt, new WorkflowFailure("elevenlabs_quota_exhausted", "permanent", "x")))).toEqual({ kind: "terminal", status: "failed" });
      expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "failed", errorCode: "MCP_CANCELLED" });
      expect((await prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } })).providerJobId).toBeNull();
    })));

    test("an error event fails the attempt with the normal retry policy, once", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const retryable = await begun();
      expect(await providerReply(retryable.api.failProviderAttempt(
        retryable.attempt,
        new WorkflowFailure("elevenlabs_transcription_failed", "retryable", "x"),
        { requestId: "req-1" },
      ))).toEqual({ kind: "applied" });
      expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: retryable.run.id } })).toMatchObject({ status: "queued", attemptId: null });
      expect(await providerReply(retryable.api.failProviderAttempt(retryable.attempt, new WorkflowFailure("x", "retryable", "x")))).toEqual({ kind: "stale", reason: "attempt_superseded" });

      const permanent = await begun();
      expect(await providerReply(permanent.api.failProviderAttempt(
        permanent.attempt,
        new WorkflowFailure("elevenlabs_quota_exhausted", "permanent", "x"),
      ))).toEqual({ kind: "applied" });
      expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: permanent.run.id } })).toMatchObject({ status: "failed", errorCode: "elevenlabs_quota_exhausted" });
      expect(await prisma.transcript.findUniqueOrThrow({ where: { projectId: permanent.project.id } })).toMatchObject({ status: "failed", errorCode: "elevenlabs_quota_exhausted" });
      expect(await providerReply(permanent.api.failProviderAttempt(permanent.attempt, new WorkflowFailure("x", "permanent", "x")))).toEqual({ kind: "terminal", status: "failed" });
    })));

    test("an acceptance after the attempt failed is acknowledged and records nothing", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { project, api, attempt } = await begun();
      await api.failProviderAttempt(attempt, new WorkflowFailure("elevenlabs_quota_exhausted", "permanent", "x"));
      expect(await providerReply(api.recordProviderAcceptance(attempt, { requestId: "req-1", transcriptionId: "tr-1", nextPollAt: new Date() }))).toEqual({ kind: "terminal", status: "failed" });
      expect((await prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } })).providerJobId).toBeNull();
    })));

    test("lookup resolves the project for the finalizer and leaves ownedAttemptWhere strict", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { project, api, attempt } = await begun();
      expect(await api.lookupProviderAttempt(attempt)).toMatchObject({
        kind: "waiting", attempt: { projectId: project.id, stage: "stt" }, providerJobId: null,
      });
      // The generic completion still needs a lease or a waiting run; a running
      // run owned by another process is untouched by the provider entry points.
      const other = await fixture("stt");
      const reference = (await prisma.$transaction(tx => api.dispatchRunWithinTransaction(tx, other.run.id))).reference;
      const attemptToken = randomUUID(), owner = randomUUID();
      await prisma.executionAttempt.create({ data: { attemptToken, dispatchId: reference.dispatchId, deploymentEpoch: reference.deploymentEpoch,
        generation: reference.generation, inputHash: reference.inputHash, functionName: "stt", operationDeadlineAt: new Date(Date.now() + 600000) } });
      const control = createExecutorControl({ database: prisma, domain: api, subjectKind: "workflow_run", deliverWakes: async ids => {
        expect(await prisma.executionDispatch.count({ where: { id: { in: [...ids] } } })).toBe(ids.length);
      } });
      expect(await control.execute({ command: { action: "acquire", reference, attemptToken, owner, leaseSeconds: 120 }, verifiedRequest: {
        requestHash: "f".repeat(64), metadata: { version: 1, keyId: "workflow-provider-test", audience: "executor-control", method: "POST", canonicalTarget: "/api/execution/command",
          bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId: randomUUID(), signature: "0".repeat(64) },
      } })).toMatchObject({ disposition: "acquired" });
      const key: ProviderAttemptReference = { workflowRunId: other.run.id, attemptId: attemptToken, deploymentEpoch: reference.deploymentEpoch, sourceRevision: other.project.sourceRevision, sourceAudioId: null };
      expect(await providerReply(api.completeProviderTranscript(key, transcriptInput("tr", "req")))).toEqual({ kind: "stale", reason: "not_waiting" });
      expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: other.run.id } })).toMatchObject({ status: "running", leaseOwner: owner, attemptCount: 0 });
      await prisma.executionAttempt.update({ where: { attemptToken }, data: { status: "cancelled", revokedAt: new Date(), finishedAt: new Date() } });
    })));
  });

  describe("transcription for a captioned video", () => {
    const probe = (audio: boolean) => ({ durationSec: 8, video: { width: 1080, height: 1920, frameRate: { numerator: 24, denominator: 1 }, startTimecode: null }, audio: audio ? { sampleRate: 48_000, channels: 2 } : null });
    async function captionedRun(captions: Parameters<typeof buildCaptionedVideoSettings>[0]["captions"], options: { audio?: boolean } = {}) {
      const { project, run } = await fixture("stt");
      await prisma.project.update({ where: { id: project.id }, data: { sourceDurationSeconds: 8, languageCode: "auto", sourceProbe: probe(options.audio ?? true) } });
      const pack = await prisma.contentPack.create({ data: { projectId: project.id, ...buildCaptionedVideoContentPack(buildCaptionedVideoSettings({ captions })) } });
      await prisma.workflowRun.update({ where: { id: run.id }, data: { contentPackId: pack.id } });
      await prisma.transcript.create({ data: { projectId: project.id, sourceRevision: project.sourceRevision } });
      const lifecycle = new WorkflowRunLifecycle({ prisma });
      const reference = (await prisma.$transaction(tx => lifecycle.dispatchRunWithinTransaction(tx, run.id))).reference;
      const result = await createTranscriptionAdmission({ database: prisma, workflow: lifecycle, maxUnits: 12 }).admit(reference, { owner: randomUUID() });
      expect(await prisma.executionAttempt.count({ where: { dispatch: { subjectId: run.id } } })).toBe(0);
      expect(await prisma.executionDispatch.count({ where: { id: { in: result.dispatchIds } } })).toBe(result.dispatchIds.length);
      return { project, run, pack, lifecycle, reference, result };
    }

    test("supplied captions complete the unowned run with no provider job and queue detection on the same pack", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { project, run, pack, result } = await captionedRun({ source: "supplied", text: "1\n00:00:00,000 --> 00:00:02,000\nHello there\n\n2\n00:00:09,000 --> 00:00:10,000\npast the end" });
      expect(result.kind).toBe("completed");
      const [settled, transcript, child] = await Promise.all([
        prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
        prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } }),
        prisma.workflowRun.findFirstOrThrow({ where: { projectId: project.id, stage: "moment_detection" } }),
      ]);
      expect(settled.status).toBe("completed");
      expect(transcript).toMatchObject({ status: "completed", provider: "supplied_captions", providerJobId: null, languageCode: null, text: "Hello there", durationSeconds: 8 });
      expect((transcript.utterancesJson as Array<{ text: string }>).map((utterance) => utterance.text)).toEqual(["Hello there"]);
      expect(child).toMatchObject({ status: "queued", contentPackId: pack.id });
    })));

    test.each([
      ["declined captions", { source: "none" as const }, true],
      ["a source with no audio stream", { source: "auto" as const }, false],
    ])("%s complete the unowned run with an empty transcript", bindServiceTestEnvironment(prismaGlobal.bind(async (_name, captions, audio) => {
      const { project, run, result } = await captionedRun(captions, { audio });
      expect(result.kind).toBe("completed");
      expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "completed", attemptCount: 0, leaseOwner: null, leaseExpiresAt: null });
      expect(await prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } })).toMatchObject({ status: "completed", text: "", utterancesJson: [], speakerCount: 0 });
      const transcript = await prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } });
      expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).attemptId).toBe(transcript.workflowAttemptId);
      expect(await prisma.workflowRun.count({ where: { projectId: project.id, stage: "moment_detection", status: "queued" } })).toBe(1);
    })));

    test("spoken captions wait for verified SourceAudio before provider permission", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { result } = await captionedRun({ source: "auto" });
      expect(result).toMatchObject({ kind: "audio_pending" });
    })));

    test("only a caption-only generation may finish a provider transcript with no speech", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { run } = await captionedRun({ source: "auto" });
      expect(await projectService.runAllowsEmptyTranscript(run.id)).toBe(true);
      const ordinary = await fixture("stt");
      const pack = await prisma.contentPack.create({ data: { projectId: ordinary.project.id, ...buildGenerationContentPack() } });
      await prisma.workflowRun.update({ where: { id: ordinary.run.id }, data: { contentPackId: pack.id } });
      expect(await projectService.runAllowsEmptyTranscript(ordinary.run.id)).toBe(false);
    })));
  });

  test("concurrent transitions allocate unique monotonic project sequences", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { project, run } = await fixture("moment_detection");
    await Promise.all(Array.from({ length: 8 }, (_, index) => prisma.$transaction(tx => appendWorkflowEvent(tx, {
      projectId: project.id, workflowRunId: run.id, attemptId: randomUUID(), stage: "moment_detection", status: "waiting", progress: index,
      errorCode: null, transition: "sequence" }, { progressRequired: true, analyticsEnabled: false }))));
    const events = await prisma.workflowEvent.findMany({ where: { projectId: project.id }, orderBy: { seq: "asc" }, select: { seq: true } });
    expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  })));

  test("lists a ready source as processing while its current detection run is active", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { user, workspace, project, run } = await fixture("moment_detection");
    await prisma.project.update({
      where: { id: project.id },
      data: { ingestStatus: "ready" },
    });
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: "running" },
    });

    const page = await workspaceLibraryService.listProjects({ actorUserId: user.id, workspaceId: workspace.id }, {
      status: "processing",
    });

    expect(page.items.map((item) => item.id)).toContain(project.id);
    expect(page.items.find((item) => item.id === project.id)?.progress).toEqual({
      status: "processing",
      label: "Detecting",
      active: true,
    });
    expect(page.statusCounts.processing).toBe(1);
  })));

  test("paginates downstream processing projects without dropping their filtered count", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const first = await fixture("moment_detection");
    const secondProject = await prisma.project.create({
      data: {
        title: "Second processing project",
        sourceMediaUrl: "r2://test/second-source.mp4",
        workspaceId: first.workspace.id,
        createdByUserId: first.user.id,
        ingestStatus: "ready",
      },
    });
    const secondRun = await prisma.workflowRun.create({
      data: {
        projectId: secondProject.id,
        idempotencyKey: `second:${randomUUID()}`,
        stage: "moment_detection",
        status: "running",
      },
    });
    await prisma.project.updateMany({
      where: { id: first.project.id },
      data: { ingestStatus: "ready" },
    });
    await prisma.workflowRun.updateMany({
      where: { id: { in: [first.run.id, secondRun.id] } },
      data: { status: "running" },
    });

    const page = await workspaceLibraryService.listProjects({ actorUserId: first.user.id, workspaceId: first.workspace.id }, {
      status: "processing",
      limit: 1,
    });
    const next = await workspaceLibraryService.listProjects({ actorUserId: first.user.id, workspaceId: first.workspace.id }, {
      status: "processing",
      limit: 1,
      cursor: page.nextCursor,
    });

    expect(page.totalCount).toBe(2);
    expect(new Set([...page.items, ...next.items].map((item) => item.id))).toEqual(
      new Set([first.project.id, secondProject.id]),
    );
  })));

  test("keeps an older active run ahead of a newer terminal sibling in list and detail progress", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { user, workspace, project, run } = await fixture("clip_rendering");
    await prisma.project.update({
      where: { id: project.id },
      data: { ingestStatus: "ready" },
    });
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: "running" },
    });
    await prisma.workflowRun.create({
      data: {
        projectId: project.id,
        idempotencyKey: `newer-terminal:${randomUUID()}`,
        stage: "dubbing",
        status: "completed",
        updatedAt: new Date(Date.now() + 10_000),
      },
    });

    const page = await workspaceLibraryService.listProjects({ actorUserId: user.id, workspaceId: workspace.id }, {
      status: "processing",
    });
    const snapshot = await projectService.getProjectSnapshot(
      { actorUserId: user.id, workspaceId: workspace.id },
      project.id,
    );

    expect(page.items.find((item) => item.id === project.id)?.progress).toEqual({
      status: "processing",
      label: "Rendering",
      active: true,
    });
    expect(snapshot.activeRun?.stage).toBe("clip_rendering");
    expect(snapshot.progress).toEqual(page.items.find((item) => item.id === project.id)?.progress);
  })));

  test("treats search wildcards as literal text", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { user, workspace, project } = await fixture();
    await prisma.project.update({
      where: { id: project.id },
      data: { title: "100%_ready" },
    });
    await prisma.project.create({
      data: {
        title: "100xxready",
        sourceMediaUrl: "r2://test/non-literal-match.mp4",
        workspaceId: workspace.id,
        createdByUserId: user.id,
      },
    });

    const page = await workspaceLibraryService.listProjects({ actorUserId: user.id, workspaceId: workspace.id }, {
      query: "100%_ready",
    });

    expect(page.items.map((item) => item.id)).toEqual([project.id]);
  })));
});
