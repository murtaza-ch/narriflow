import { RenderFixtureLifecycle } from "./render-group-test-fixture";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  setSystemTime,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  buildCaptionedVideoContentPack,
  buildCaptionedVideoSettings,
  buildGenerationContentPack,
  CLIP_AUTO_LAYOUT_ENGINE,
  CLIP_AUTO_LAYOUT_VERSION,
  fitSuppliedUtterances,
  studioEditsSchema,
  workflowStageUpdatedEventSchema,
} from "@narriflow/validators";
import { Pool } from "pg";
import {
  type WorkflowAttemptRef,
  getWorkflowRunLifecycle,
  WORKFLOW_RELEASE_GRACE_MS,
  WorkflowAttemptLost,
  WorkflowFailure,
} from "./workflow-run-lifecycle";
import { decodeFrozenClipEditorDocument } from "./clip-editor-document-persistence";
import { clipExportService } from "./clip-export.service";
import { notificationService } from "./notification.service";
import { clipService } from "./clip.service";
import { projectService } from "./project.service";
import { workspaceLibraryService } from "./workspace-library.service";
import { createCallbackCipher, createCompletionCallbackProcessor } from "./completion-callback";
import { createOperationStatusReader } from "./operation-status";

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
  const prismaGlobal = globalThis as unknown as {
    narriflowPrismaClient?: PrismaClient;
  };

  beforeAll(() => {
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
    previousGlobalPrisma = prismaGlobal.narriflowPrismaClient;
    prismaGlobal.narriflowPrismaClient = prisma;
  });

  beforeEach(async () => {
    await prisma.workspace.deleteMany({
      where: { owner: { clerkId: { startsWith: "workflow-db-test:" } } },
    });
    await prisma.user.deleteMany({
      where: { clerkId: { startsWith: "workflow-db-test:" } },
    });
  });

  afterAll(async () => {
    prismaGlobal.narriflowPrismaClient = previousGlobalPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

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

  async function claimRenderAttempt() {
    const lifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const attempt = await lifecycle.claim("clip_rendering");
    if (!attempt) throw new Error("clip-rendering claim missing");
    return { attempt, lifecycle };
  }

  function eventClient(overrides: {
    findMany?: (args: Parameters<PrismaClient["workflowEvent"]["findMany"]>[0]) => Promise<unknown>;
    updateMany?: (args: Parameters<PrismaClient["workflowEvent"]["updateMany"]>[0]) => Promise<{ count: number }>;
  }) {
    return new Proxy(prisma, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property !== "workflowEvent") return typeof value === "function" ? value.bind(target) : value;
        return new Proxy(target.workflowEvent, {
          get(delegate, method) {
            if (method === "findMany" && overrides.findMany) return overrides.findMany;
            if (method === "updateMany" && overrides.updateMany) return overrides.updateMany;
            const member = Reflect.get(delegate, method);
            return typeof member === "function" ? member.bind(delegate) : member;
          },
        });
      },
    });
  }

  async function failAndClaimNextRenderAttempt(
    runId: string,
    lifecycle: RenderFixtureLifecycle,
    attempt: WorkflowAttemptRef,
  ) {
    await lifecycle.finishGroups();
    await lifecycle.retryGroups(runId);
    await lifecycle.failAttempt(
      attempt,
      new WorkflowFailure("transient_render_failure", "retryable", "retry"),
    );
    await prisma.workflowRun.update({
      where: { id: runId },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
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

  test("project expiry cancels queued runs through the lifecycle", async () => {
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
  });

  test("export-bundle commands own their fenced child transactions", async () => {
    const createBundle = async () => {
      const { user, workspace, project, run } = await fixture("export_bundle");
      const operation = await prisma.campaignOperation.create({
        data: {
          workspaceId: workspace.id,
          projectId: project.id,
          actorUserId: user.id,
          action: "export_bundle",
          idempotencyKey: randomUUID(),
          requestFingerprint: randomUUID(),
          validatedOptions: {},
          pricingTier: "business",
          requestedCount: 1,
          workflowRunId: run.id,
          items: {
            create: {
              requestedClipId: randomUUID(),
              status: "failed",
              errorCode: "export_bundle_build_failed",
            },
          },
          bundle: { create: { workflowRunId: run.id, manifest: {} } },
        },
        include: { bundle: true, items: true },
      });
      if (!operation.bundle) throw new Error("export bundle fixture missing");
      return { operation, bundle: operation.bundle, item: operation.items[0]!, run };
    };

    const first = await createBundle();
    const lifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const firstAttempt = await lifecycle.claim("export_bundle");
    if (!firstAttempt) throw new Error("export-bundle claim missing");
    await lifecycle.beginExportBundleBuild(firstAttempt, {
      bundleId: first.bundle.id,
      operationId: first.operation.id,
      attemptStorageKey: "projects/test/attempt.zip",
    });
    expect(
      await prisma.exportBundle.findUniqueOrThrow({
        where: { id: first.bundle.id },
      }),
    ).toMatchObject({
      status: "building",
      attemptStorageKey: "projects/test/attempt.zip",
    });
    expect(
      await prisma.campaignOperationItem.findUniqueOrThrow({
        where: { id: first.item.id },
      }),
    ).toMatchObject({ status: "pending", errorCode: null });

    await lifecycle.completeExportBundleBuild(firstAttempt, {
      bundleId: first.bundle.id,
      operationId: first.operation.id,
      storageKey: "projects/test/final.zip",
      sizeBytes: 42,
      checksumSha256: "checksum",
      operationStatus: "completed",
      succeededCount: 1,
    });
    expect(
      await prisma.exportBundle.findUniqueOrThrow({
        where: { id: first.bundle.id },
      }),
    ).toMatchObject({
      status: "completed",
      attemptStorageKey: null,
      storageKey: "projects/test/final.zip",
      sizeBytes: 42n,
    });
    expect(
      await prisma.campaignOperation.findUniqueOrThrow({
        where: { id: first.operation.id },
      }),
    ).toMatchObject({
      status: "completed",
      succeededCount: 1,
      failedCount: 0,
    });

    const second = await createBundle();
    const secondAttempt = await lifecycle.claim("export_bundle");
    if (!secondAttempt) throw new Error("second export-bundle claim missing");
    await lifecycle.beginExportBundleBuild(secondAttempt, {
      bundleId: second.bundle.id,
      operationId: second.operation.id,
      attemptStorageKey: "projects/test/failed-attempt.zip",
    });
    await lifecycle.failExportBundleBuild(secondAttempt, {
      bundleId: second.bundle.id,
      operationId: second.operation.id,
      errorCode: "export_bundle_build_failed",
      failedCount: 1,
    });
    expect(
      await prisma.exportBundle.findUniqueOrThrow({
        where: { id: second.bundle.id },
      }),
    ).toMatchObject({
      status: "failed",
      attemptStorageKey: null,
      errorCode: "export_bundle_build_failed",
    });
    expect(
      await prisma.campaignOperation.findUniqueOrThrow({
        where: { id: second.operation.id },
      }),
    ).toMatchObject({ status: "failed", succeededCount: 0, failedCount: 1 });
    await expect(
      lifecycle.beginExportBundleBuild(secondAttempt, {
        bundleId: first.bundle.id,
        operationId: first.operation.id,
        attemptStorageKey: "projects/test/wrong.zip",
      }),
    ).rejects.toBeInstanceOf(WorkflowAttemptLost);
  });

  test("the first owned begin freezes eligible pending variants without rewriting history", async () => {
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
  });

  test("the render state loader returns one attempt-start project and work-set snapshot", async () => {
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
  });

  test("an initially empty Render Work Set cannot expand on retry", async () => {
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
      await failAndClaimNextRenderAttempt(run.id, firstLifecycle, firstAttempt);
    const retryWorkSet = await retryLifecycle.beginRenderWorkSet(retryAttempt);

    expect(retryWorkSet.frozenAt).toEqual(firstWorkSet.frozenAt);
    expect(retryWorkSet.variantIds).toEqual([]);
    expect(retryWorkSet.variantIds).not.toContain(lateVariant.id);
  });

  test("a retry reads only the variants already bound to its Workflow Run", async () => {
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
      await failAndClaimNextRenderAttempt(run.id, firstLifecycle, firstAttempt);
    const retryWorkSet = await retryLifecycle.beginRenderWorkSet(retryAttempt);

    expect(retryWorkSet.variantIds).toEqual([originalVariant.id]);
    expect(retryWorkSet.variantIds).not.toContain(lateVariant.id);
  });

  test("a stale Workflow Attempt cannot begin a Render Work Set", async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle: firstLifecycle, attempt: staleAttempt } =
      await claimRenderAttempt();
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await firstLifecycle.reapExpiredAttempts()).toBe(1);
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    const { lifecycle: currentLifecycle, attempt: currentAttempt } =
      await claimRenderAttempt();

    await expect(
      firstLifecycle.beginRenderWorkSet(staleAttempt),
    ).rejects.toBeInstanceOf(WorkflowAttemptLost);
    expect(
      await prisma.workflowEvent.count({
        where: { workflowRunId: run.id, notificationRequired: true },
      }),
    ).toBe(0);
    expect(
      (await currentLifecycle.beginRenderWorkSet(currentAttempt)).variantIds,
    ).toEqual([variant.id]);
  });

  test("a retry excludes variants deleted from its frozen Render Work Set", async () => {
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
      await failAndClaimNextRenderAttempt(run.id, firstLifecycle, firstAttempt);
    expect(
      (await retryLifecycle.beginRenderWorkSet(retryAttempt)).variantIds,
    ).toEqual([]);
  });

  test("the frozen Render Work Set includes export-bound pending variants", async () => {
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
  });

  test("a candidate-assignment failure leaves the Render Work Set unfrozen", async () => {
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
  });

  test("a failure immediately before commit rolls back assignment and freezing together", async () => {
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
  });

  test("a variant created after candidate selection remains unassigned", async () => {
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
  });

  test("a mixed Render Work Set settles partial with durable notification intent", async () => {
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
      notificationDeliveredAt: null,
    });

    const handedOff: string[] = [];
    const dispatcher = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
      handoffNotification: async (payload) => {
        handedOff.push(payload.kind);
      },
    });
    expect(await dispatcher.dispatchEvents()).toBeGreaterThan(0);
    expect(handedOff).toEqual(["clip_render.partial"]);
    expect(await dispatcher.dispatchEvents()).toBe(0);
    expect(handedOff).toEqual(["clip_render.partial"]);
  });

  test("terminal Render Work Set outcomes carry distinct typed notification payloads", async () => {
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
  });

  test("notification dispatch replays safely around durable ledger handoff", async () => {
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
    let failurePoint: "before_handoff" | "after_handoff" | null =
      "before_handoff";
    const dispatcher = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
      handoffNotification: async (payload) => {
        if (failurePoint === "before_handoff") {
          throw new Error("crash_before_ledger_handoff");
        }
        await notificationService.handoff({
          projectId: payload.projectId,
          sourceId: payload.workflowRunId,
          outcome:
            payload.kind === "clip_render.failed"
              ? "generation_failed"
              : "clips_ready",
        });
        if (failurePoint === "after_handoff") {
          throw new Error("crash_after_ledger_handoff");
        }
      },
    });

    expect(await dispatcher.dispatchEvents()).toBe(0);
    expect(
      await prisma.notificationLedger.count({
        where: { projectId: project.id, sourceId: run.id },
      }),
    ).toBe(0);

    failurePoint = "after_handoff";
    await prisma.workflowEvent.update({
      where: { id: event.id },
      data: { nextDeliveryAt: new Date(Date.now() - 1_000) },
    });
    expect(await dispatcher.dispatchEvents()).toBe(0);
    expect(
      await prisma.notificationLedger.count({
        where: { projectId: project.id, sourceId: run.id },
      }),
    ).toBe(1);

    failurePoint = null;
    await prisma.workflowEvent.update({
      where: { id: event.id },
      data: { nextDeliveryAt: new Date(Date.now() - 1_000) },
    });
    expect(await dispatcher.dispatchEvents()).toBeGreaterThan(0);
    expect(
      await prisma.workflowEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).toMatchObject({
      notificationDeliveredAt: expect.any(Date),
      deliveryAttempts: 3,
      lastDeliveryError: null,
    });
    expect(
      await prisma.notificationLedger.findMany({
        where: { projectId: project.id, sourceId: run.id },
      }),
    ).toEqual([
      expect.objectContaining({ outcome: "clips_ready", status: "pending" }),
    ]);
    expect(
      await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toEqual(settledRun);
    expect(
      await prisma.clipRender.findUniqueOrThrow({ where: { id: variant.id } }),
    ).toEqual(settledVariant);
  });

  test("notification delivery leaves unrelated Workflow Events on their normal dispatch path", async () => {
    const { project, run } = await fixture("dubbing");
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: "completed" },
    });
    const published: string[] = [];
    let notificationHandoffs = 0;
    const dispatcher = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
      publishRedis: async (event) => {
        published.push(event.workflowRunId);
        return true;
      },
      handoffNotification: async () => {
        notificationHandoffs += 1;
      },
    });
    const admitted = await dispatcher.admit({
      projectId: project.id,
      idempotencyKey: `unrelated-event:${randomUUID()}`,
      stage: "dubbing",
    });

    expect(await dispatcher.dispatchEvents()).toBe(1);
    expect(published).toEqual([admitted.id]);
    expect(notificationHandoffs).toBe(0);
    expect(
      await prisma.workflowEvent.findFirstOrThrow({
        where: { workflowRunId: admitted.id },
      }),
    ).toMatchObject({
      redisPublishedAt: expect.any(Date),
      notificationRequired: false,
      notificationDeliveredAt: null,
      lastDeliveryError: null,
    });
  });

  test("notification dispatch rejects an invalid durable terminal payload", async () => {
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
    let handoffs = 0;
    const dispatcher = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
      handoffNotification: async () => {
        handoffs += 1;
      },
    });

    expect(await dispatcher.dispatchEvents()).toBe(0);
    expect(handoffs).toBe(0);
    expect(
      await prisma.workflowEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).toMatchObject({
      notificationDeliveredAt: null,
      deliveryAttempts: 1,
      lastDeliveryError: expect.any(String),
    });
    expect(
      await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({ status: "failed", requestedCount: 1, failedCount: 1 });
  });

  test.each(["recovered", "exhausted"])("successful siblings survive transient backoff until %s", async (ending) => {
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

      await failOwnedRenderVariant(lifecycle, attempt, transient.id, "retryable", "storage_temporarily_unavailable");
      const before = Date.now();
      const outcome = await lifecycle.settleRenderWorkSet(attempt);
      if (count === 3) {
        expect(outcome).toMatchObject({ status: "partial", succeeded: 1, failed: 2 });
        expect(await lifecycle.settleRenderWorkSet(attempt)).toEqual(outcome);
        break;
      }
      expect(outcome).toMatchObject({ status: "pending", succeeded: 1, failed: 1 });
      const queued = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(queued).toMatchObject({ status: "running", progress: 60, succeededCount: 1, failedCount: 1 });
      expect((await prisma.renderGroup.findFirstOrThrow({where:{workflowRunId:run.id}})).nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + count * 30_000);
      expect(await prisma.workflowEvent.count({ where: { workflowRunId: run.id, notificationRequired: true } })).toBe(0);
      expect(await prisma.clipRender.findUniqueOrThrow({ where: { id: transient.id } })).toMatchObject({ status: "pending", workflowAttemptId: null, failureDisposition: null });
      expect(await prisma.clipRender.findUniqueOrThrow({ where: { id: completed.id } })).toEqual(preserved);
      expect(await prisma.clipRender.findUniqueOrThrow({ where: { id: permanent.id } })).toEqual(permanentRow);
      expect(await lifecycle.claim("clip_rendering")).toBeNull();
      await prisma.workflowRun.update({ where: { id: run.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
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
  });

  test("zero success requeues only retryable variants and reports durable failure counts", async () => {
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
      status: "running",
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
  });

  test("settlement does not retry a render without explicit retry disposition", async () => {
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
  });

  test("a subsequent Workflow Attempt settles without repeating a completed variant", async () => {
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

    const second = await failAndClaimNextRenderAttempt(
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
  });

  test("an all-permanent zero-success set fails without spending another attempt", async () => {
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
      attemptCount: 1,
      requestedCount: 2,
      succeededCount: 0,
      failedCount: 2,
      errorCode: "render_work_set_failed",
    });
  });

  test("concurrent terminal replay serializes before follow-up unique-key contention", async () => {
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
          dedupeKey: `${run.id}:${attempt.attemptId}:terminal:completed`,
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
  });

  for (const failpoint of [
    { phase: "aggregate update", table: "WorkflowRun", operation: "UPDATE" },
    { phase: "terminal event append", table: "WorkflowEvent", operation: "INSERT" },
    { phase: "follow-up admission", table: "WorkflowRun", operation: "INSERT" },
  ] as const) {
    for (const timing of ["BEFORE", "AFTER"] as const) {
      test(`settlement is atomic when ${timing} ${failpoint.phase} fails`, async () => {
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
        await prisma.renderGroup.updateMany({ where: { workflowRunId: run.id }, data: { chargedAttemptCount: 3 } });
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
      });
    }
  }

  test("an all-superseded Render Work Set completes without notification intent", async () => {
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
  });

  test("a render retry retains its frozen work count when every variant was superseded", async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const first = await claimRenderAttempt();
    await first.lifecycle.beginRenderWorkSet(first.attempt);
    await first.lifecycle.failAttempt(first.attempt, new WorkflowFailure("render_interrupted", "retryable", "retry"));
    await prisma.clipRender.delete({ where: { id: variant.id } });
    await prisma.workflowRun.update({
      where: { id: run.id }, data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    const retry = await claimRenderAttempt();
    expect((await retry.lifecycle.beginRenderWorkSet(retry.attempt)).variantIds).toEqual([]);

    expect(await retry.lifecycle.settleRenderWorkSet(retry.attempt)).toMatchObject({
      status: "completed", requested: 1, succeeded: 0, failed: 0, superseded: 1,
    });
    expect(await prisma.workflowEvent.count({
      where: { workflowRunId: run.id, notificationRequired: true },
    })).toBe(0);
  });

  test("retry exhaustion creates durable failed-render notification intent", async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    await lifecycle.markClipRenderVariantRendering(attempt, variant.id);
    await prisma.renderGroup.updateMany({ where: { workflowRunId: run.id }, data: { chargedAttemptCount: 3 } });

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
    ).toMatchObject({ status: "failed", notificationDeliveredAt: null });
  });

  test("terminal render reaping settles the full lineage as partial", async () => {
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
          exportVariantId: exportVariant.id,
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
    await prisma.renderGroup.updateMany({ where: { workflowRunId: run.id }, data: { chargedAttemptCount: 3 } });

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
  });

  test("Clip Export status follows bulk requeue and terminal reaping", async () => {
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
        exportVariantId: exportVariant.id,
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
    ).toEqual({ status: "running" });
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
    await prisma.renderGroup.updateMany({ where: { workflowRunId: run.id }, data: { chargedAttemptCount: 3 } });
    await last.lifecycle.settleRenderWorkSet(last.attempt);

    const settled = await readExport();
    expect(settled.status).toBe("failed");
    expect(settled.completedAt).not.toBeNull();
  });

  test("terminal render reaping completes an all-superseded lineage silently", async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    await prisma.clipRender.delete({ where: { id: variant.id } });
    await prisma.renderGroup.updateMany({ where: { workflowRunId: run.id }, data: { chargedAttemptCount: 3 } });

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
  });

  test("50 identical admissions return one deterministic run", async () => {
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
  });

  test("different idempotency keys racing for one stage return one live run", async () => {
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
  });

  test("existing Content Packs must be committed and belong to the admitted project", async () => {
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
  });

  test("STT admission atomically binds its content pack, transcript, and initial event", async () => {
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
      transcriptProvider: "assemblyai",
      transcriptProviderModel: "universal-3-pro",
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
    expect(transcript.provider).toBe("assemblyai");
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("queued");
  });

  test("claim returns the one explicit attempt protocol", async () => {
    const { project, run } = await fixture("dubbing");
    const lifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });

    const attempt = await lifecycle.claim("dubbing");

    expect(attempt).toMatchObject({
      workflowRunId: run.id,
      projectId: project.id,
      stage: "dubbing",
      status: "running",
      attemptCount: 1,
    });
    expect(attempt?.attemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("progress and dubbing artifacts are fenced by the explicit attempt", async () => {
    const { project, run } = await fixture("dubbing");
    const clip = await clipFixture(project.id, run.id);
    const [completedDub, failedDub] = await Promise.all([
      prisma.clipDub.create({
        data: {
          projectId: project.id,
          clipId: clip.id,
          aspectRatio: "ratio_9_16",
          targetLanguageCode: "es",
          voice: "marin",
          model: "test",
          status: "queued",
        },
      }),
      prisma.clipDub.create({
        data: {
          projectId: project.id,
          clipId: clip.id,
          aspectRatio: "ratio_9_16",
          targetLanguageCode: "fr",
          voice: "marin",
          model: "test",
          status: "queued",
        },
      }),
    ]);
    // Each accepted dub holds its generation count before a worker runs it.
    await prisma.generatedMediaUsageReservation.createMany({
      data: [completedDub, failedDub].map((dub) => ({
        jobId: dub.id,
        kind: "dub" as const,
        workspaceId: project.workspaceId,
        policy: "metered",
        periodStart: new Date(Date.UTC(2026, 9, 1)),
        attachedAt: new Date(),
      })),
    });
    const lifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const attempt = await lifecycle.claim("dubbing");
    if (!attempt) throw new Error("claim missing");

    await lifecycle.reportProgress(attempt, 42);
    expect((await lifecycle.markDubProcessing(attempt, completedDub.id)).count).toBe(1);
    expect(
      (
        await lifecycle.completeDub(attempt, completedDub.id, {
          status: "completed",
          transcriptText: "hello",
          translatedText: "hola",
          audioStorageKey: "test/dub.mp3",
          renderStorageKey: "test/dub.mp4",
          audioSizeBytes: 10n,
          renderSizeBytes: 20n,
          durationSec: 1,
          model: "test",
          errorCode: null,
          completedAt: new Date(),
        })
      ).count,
    ).toBe(1);
    expect((await lifecycle.markDubProcessing(attempt, failedDub.id)).count).toBe(1);
    expect((await lifecycle.failDub(attempt, failedDub.id, "dub_failed")).count).toBe(1);

    const [storedRun, storedCompleted, storedFailed] = await Promise.all([
      prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
      prisma.clipDub.findUniqueOrThrow({ where: { id: completedDub.id } }),
      prisma.clipDub.findUniqueOrThrow({ where: { id: failedDub.id } }),
    ]);
    expect(storedRun.progress).toBe(42);
    expect(storedCompleted).toMatchObject({
      status: "completed",
      workflowAttemptId: attempt.attemptId,
    });
    expect(storedFailed).toMatchObject({
      status: "failed",
      workflowAttemptId: attempt.attemptId,
      errorCode: "dub_failed",
    });
    expect(
      await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: completedDub.id } }),
    ).toMatchObject({ status: "finalized", actualUnits: 1 });
  });

  test("one of twenty racing workers owns a queued run", async () => {
    const { run } = await fixture();
    const claims = await Promise.all(
      Array.from({ length: 20 }, () =>
        new RenderFixtureLifecycle({ prisma, leaseOwner: randomUUID() }).claim(
          "dubbing",
        ),
      ),
    );
    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.workflowRunId).toBe(run.id);
    expect(winners[0]?.attemptId).toBeTruthy();
  });

  test("an expired owner cannot settle after another attempt reclaims the run", async () => {
    const { run } = await fixture();
    const firstLifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const first = await firstLifecycle.claim("dubbing");
    expect(first?.workflowRunId).toBe(run.id);
    if (!first) throw new Error("first claim missing");

    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await firstLifecycle.reapExpiredAttempts()).toBe(1);
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });

    const secondLifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const second = await secondLifecycle.claim("dubbing");
    expect(second).not.toBeNull();
    if (!second) throw new Error("second claim missing");

    await expect(firstLifecycle.completeStage(first)).rejects.toBeInstanceOf(
      WorkflowAttemptLost,
    );
    await secondLifecycle.completeStage(second);
    const settled = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(settled.status).toBe("completed");
    expect(settled.attemptId).toBe(second.attemptId);
  });

  test("a stale attempt cannot write a child artifact inside a fenced transaction", async () => {
    const { run, project } = await fixture("clip_rendering");
    const firstLifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const first = await firstLifecycle.claim("clip_rendering");
    if (!first) throw new Error("first claim missing");
    const clip = await prisma.clip.create({
      data: {
        projectId: project.id,
        workflowRunId: run.id,
        index: 0,
        startSec: 0,
        endSec: 10,
        hookText: "Before",
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
    const render = await prisma.clipRender.create({
      data: {
        clipId: clip.id,
        aspectRatio: "ratio_9_16",
        status: "rendering",
        workflowAttemptId: first.attemptId,
      },
    });

    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await firstLifecycle.reapExpiredAttempts()).toBe(1);
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    const second = await new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    }).claim("clip_rendering");
    if (!second) throw new Error("second claim missing");

    await expect(
      firstLifecycle.completeClipRenderVariant(first, render.id, {
        storageKey: "test/stale.mp4",
        sizeBytes: 100,
        durationSec: 10,
      }),
    ).rejects.toBeInstanceOf(WorkflowAttemptLost);
    expect(
      (await prisma.clipRender.findUniqueOrThrow({ where: { id: render.id } }))
        .status,
    ).not.toBe("completed");
  });

  test("a stale render attempt cannot publish media analysis", async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const firstLifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const first = await firstLifecycle.claim("clip_rendering");
    if (!first) throw new Error("first claim missing");

    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await firstLifecycle.reapExpiredAttempts()).toBe(1);
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    const second = await new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    }).claim("clip_rendering");
    if (!second) throw new Error("second claim missing");

    await expect(
      firstLifecycle.completeClipAutoLayoutAnalysis(first, {
        clipId: clip.id,
        analysis: { version: 1 },
        editorRevision: clip.editorRevision,
        previewStorageKey: "stale-preview",
      }),
    ).rejects.toBeInstanceOf(WorkflowAttemptLost);
    await expect(
      firstLifecycle.setClipLayoutAnalysis(first, {
        clipId: clip.id,
        analysis: { version: 1 },
        editorRevision: clip.editorRevision,
        previewStorageKey: "stale-preview",
      }),
    ).rejects.toBeInstanceOf(WorkflowAttemptLost);
    await expect(
      firstLifecycle.setClipLayoutAnalysisFailure(first, {
        clipId: clip.id,
        failure: { version: 1, state: "failed" },
        editorRevision: clip.editorRevision,
        previewStorageKey: "stale-preview",
      }),
    ).rejects.toBeInstanceOf(WorkflowAttemptLost);
    await expect(
      firstLifecycle.completeClipSplitLayoutAnalysis(first, {
        clipId: clip.id,
        analysis: { version: 1 },
        editorRevision: clip.editorRevision,
        previewStorageKey: "stale-preview",
      }),
    ).rejects.toBeInstanceOf(WorkflowAttemptLost);
    await expect(
      firstLifecycle.completeClipSplitLayoutFailure(first, {
        clipId: clip.id,
        failure: { version: 1, state: "failed" },
        editorRevision: clip.editorRevision,
        previewStorageKey: "stale-preview",
      }),
    ).rejects.toBeInstanceOf(WorkflowAttemptLost);
    const stored = await prisma.clip.findUniqueOrThrow({
      where: { id: clip.id },
      select: {
        autoLayoutAnalysis: true,
        splitLayoutAnalysis: true,
        layoutAnalysis: true,
      },
    });
    expect(stored.autoLayoutAnalysis).toBeNull();
    expect(stored.splitLayoutAnalysis).toBeNull();
    expect(stored.layoutAnalysis).toBeNull();
  });

  test("media analysis writes are limited to the frozen Render Work Set", async () => {
    const { project, run } = await fixture("clip_rendering");
    const ownedClip = await clipFixture(project.id, run.id, 0);
    const unownedClip = await clipFixture(project.id, run.id, 1);
    const ownedVariant = await prisma.clipRender.create({
      data: { clipId: ownedClip.id, aspectRatio: "ratio_9_16" },
    });
    const ownedPreviewStorageKey = `previews/${ownedClip.id}/current.mp4`;
    await prisma.clip.update({
      where: { id: ownedClip.id },
      data: { previewStorageKey: ownedPreviewStorageKey },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    expect((await lifecycle.beginRenderWorkSet(attempt)).variantIds).toEqual([
      ownedVariant.id,
    ]);
    expect(
      await lifecycle.markClipRenderVariantRendering(attempt, ownedVariant.id),
    ).toBe(true);

    await expect(
      lifecycle.setClipLayoutAnalysis(attempt, {
        clipId: unownedClip.id,
        analysis: { version: 1 },
        editorRevision: unownedClip.editorRevision,
        previewStorageKey: "unowned-preview",
      }),
    ).rejects.toBeInstanceOf(WorkflowAttemptLost);
    await expect(
      lifecycle.setClipLayoutAnalysisFailure(attempt, {
        clipId: unownedClip.id,
        failure: { version: 1, state: "failed" },
        editorRevision: unownedClip.editorRevision,
        previewStorageKey: "unowned-preview",
      }),
    ).rejects.toBeInstanceOf(WorkflowAttemptLost);
    await expect(
      lifecycle.completeClipAutoLayoutAnalysis(attempt, {
        clipId: unownedClip.id,
        analysis: { version: 1 },
        editorRevision: unownedClip.editorRevision,
        previewStorageKey: "unowned-preview",
      }),
    ).rejects.toBeInstanceOf(WorkflowAttemptLost);
    await expect(
      lifecycle.completeClipSplitLayoutAnalysis(attempt, {
        clipId: unownedClip.id,
        analysis: { version: 1 },
        editorRevision: unownedClip.editorRevision,
        previewStorageKey: "unowned-preview",
      }),
    ).rejects.toBeInstanceOf(WorkflowAttemptLost);
    await expect(
      lifecycle.completeClipSplitLayoutFailure(attempt, {
        clipId: unownedClip.id,
        failure: { version: 1, state: "failed" },
        editorRevision: unownedClip.editorRevision,
        previewStorageKey: "unowned-preview",
      }),
    ).rejects.toBeInstanceOf(WorkflowAttemptLost);
    await expect(
      lifecycle.setClipLayoutAnalysis(attempt, {
        clipId: ownedClip.id,
        analysis: { version: 1 },
        editorRevision: ownedClip.editorRevision,
        previewStorageKey: ownedPreviewStorageKey,
      }),
    ).resolves.toBe(true);
    await expect(
      lifecycle.completeClipSplitLayoutAnalysis(attempt, {
        clipId: ownedClip.id,
        analysis: { version: 1, engine: "explicit-split-v1" },
        editorRevision: ownedClip.editorRevision,
        previewStorageKey: ownedPreviewStorageKey,
      }),
    ).resolves.toBe(true);
    await expect(
      lifecycle.setClipLayoutAnalysisFailure(attempt, {
        clipId: ownedClip.id,
        failure: { version: 1, state: "failed" },
        editorRevision: ownedClip.editorRevision + 1,
        previewStorageKey: ownedPreviewStorageKey,
      }),
    ).resolves.toBe(false);
    await expect(
      lifecycle.completeClipSplitLayoutFailure(attempt, {
        clipId: ownedClip.id,
        failure: { version: 1, state: "failed" },
        editorRevision: ownedClip.editorRevision,
        previewStorageKey: `${ownedPreviewStorageKey}.stale`,
      }),
    ).resolves.toBe(false);

    const [storedOwned, storedUnowned] = await Promise.all([
      prisma.clip.findUniqueOrThrow({ where: { id: ownedClip.id } }),
      prisma.clip.findUniqueOrThrow({ where: { id: unownedClip.id } }),
    ]);
    expect(storedOwned.layoutAnalysis).toEqual({ version: 1 });
    expect(storedOwned.splitLayoutAnalysis).toEqual({
      version: 1,
      engine: "explicit-split-v1",
    });
    expect(storedOwned.autoLayoutAnalysis).toBeNull();
    expect(storedUnowned.layoutAnalysis).toBeNull();
    expect(storedUnowned.autoLayoutAnalysis).toBeNull();
    expect(storedUnowned.splitLayoutAnalysis).toBeNull();
  });

  test("automatic-layout evidence is create-only and never upgrades unknown engines", async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const previewStorageKey = `previews/${clip.id}/current.mp4`;
    await prisma.clip.update({
      where: { id: clip.id },
      data: {
        previewStorageKey,
        autoLayoutAnalysis: { version: 99, engine: "shot-layout-v99" },
        autoLayoutStatus: "completed",
      },
    });
    const variant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    expect((await lifecycle.beginRenderWorkSet(attempt)).variantIds).toEqual([
      variant.id,
    ]);
    expect(
      await lifecycle.markClipRenderVariantRendering(attempt, variant.id),
    ).toBe(true);

    const input = {
      clipId: clip.id,
      analysis: {
        version: CLIP_AUTO_LAYOUT_VERSION,
        engine: CLIP_AUTO_LAYOUT_ENGINE,
        sourceIdentity: "source:current",
      },
      editorRevision: clip.editorRevision,
      previewStorageKey,
    };
    await expect(
      lifecycle.completeClipAutoLayoutAnalysis(attempt, input),
    ).resolves.toBe(false);
    expect((await prisma.clip.findUniqueOrThrow({ where: { id: clip.id } })).autoLayoutAnalysis)
      .toEqual({ version: 99, engine: "shot-layout-v99" });
    await prisma.clip.update({ where: { id: clip.id }, data: { autoLayoutAnalysis: Prisma.DbNull } });
    await expect(
      lifecycle.completeClipAutoLayoutAnalysis(attempt, input),
    ).resolves.toBe(true);
    await expect(
      lifecycle.completeClipAutoLayoutAnalysis(attempt, {
        ...input,
        analysis: { ...input.analysis, sourceIdentity: "source:newer" },
      }),
    ).resolves.toBe(false);
    expect(
      (
        await prisma.clip.findUniqueOrThrow({ where: { id: clip.id } })
      ).autoLayoutAnalysis,
    ).toEqual(input.analysis);
  });

  test("a stage-specific child command rejects an attempt from another stage", async () => {
    const { project } = await fixture("clip_rendering");
    const lifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const attempt = await lifecycle.claim("clip_rendering");
    if (!attempt) throw new Error("claim missing");

    await expect(lifecycle.replaceDetectedClips(attempt, [])).rejects.toBeInstanceOf(
      WorkflowAttemptLost,
    );
    expect(await prisma.clip.count({ where: { projectId: project.id } })).toBe(0);
  });

  test("detected-clip replacement durably retires every referenced media object", async () => {
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
    const lifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const attempt = await lifecycle.claim("moment_detection");
    if (!attempt) throw new Error("moment-detection claim missing");

    await lifecycle.replaceDetectedClips(attempt, []);

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
  });

  test("detected-clip replacement rolls back cleanup admission when Clip removal fails", async () => {
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
    const lifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const attempt = await lifecycle.claim("moment_detection");
    if (!attempt) throw new Error("moment-detection claim missing");
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
      await expect(lifecycle.replaceDetectedClips(attempt, [])).rejects.toThrow(
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
  });

  test("a detection attempt atomically admits unowned auto-render work", async () => {
    const { project } = await fixture("moment_detection");
    const clip = await clipFixture(project.id, (
      await prisma.workflowRun.findFirstOrThrow({
        where: { projectId: project.id, stage: "moment_detection" },
      })
    ).id);
    const lifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const attempt = await lifecycle.claim("moment_detection");
    if (!attempt) throw new Error("moment-detection claim missing");

    const admitted = await lifecycle.admitAutoRenderWork(attempt, {
      idempotencyKey: `auto-render-${attempt.workflowRunId}`,
      renders: [
        {
          clipId: clip.id,
          aspectRatio: "ratio_9_16",
          status: "pending",
          resolution: "1080p",
        },
      ],
    });

    const [render, run] = await Promise.all([
      prisma.clipRender.findFirstOrThrow({ where: { clipId: clip.id } }),
      prisma.workflowRun.findUniqueOrThrow({ where: { id: admitted.id } }),
    ]);
    expect(run.stage).toBe("clip_rendering");
    expect(run.status).toBe("queued");
    expect(render.status).toBe("pending");
    expect(render.workflowRunId).toBeNull();
    expect(render.workflowAttemptId).toBeNull();
  });

  test("a captioned video's export is admitted by the transaction that completes detection, once, and only for the attempt that owns the clip", async () => {
    const { user, workspace, project, run } = await fixture("moment_detection");
    await prisma.project.update({ where: { id: project.id }, data: { sourceDurationSeconds: 8 } });
    const clip = await clipFixture(project.id, run.id);
    // An 8-second whole-source clip: outside the detected-clip bounds, inside the whole-source ones.
    await prisma.clip.update({ where: { id: clip.id }, data: { endSec: 8, wholeSource: true } });
    const lifecycle = getWorkflowRunLifecycle();
    const attempt = await lifecycle.claim("moment_detection");
    if (!attempt) throw new Error("moment-detection claim missing");

    const settings = { aspectRatios: ["1:1", "9:16"] as ["1:1", "9:16"], resolution: "1080p" as const };
    // A forged attempt completes nothing and admits nothing.
    const forged = { ...attempt, attemptId: randomUUID() };
    await expect(lifecycle.completeMomentDetection(forged, { admit: clipExportService.captionedExportWrite(forged, { ...settings, aspectRatios: ["4:5"] }) })).rejects.toBeInstanceOf(WorkflowAttemptLost);
    expect(await prisma.clipExport.count({ where: { projectId: project.id } })).toBe(0);
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("running");

    await lifecycle.completeMomentDetection(attempt, { admit: clipExportService.captionedExportWrite(attempt, settings) });
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("completed");

    const exports = await prisma.clipExport.findMany({
      where: { projectId: project.id },
      include: { variants: { include: { render: true }, orderBy: { aspectRatio: "asc" } } },
    });
    expect(exports).toHaveLength(1);
    // The plan decides the granted output exactly as for an export requested by hand.
    expect(exports[0]).toMatchObject({ clipId: clip.id, workspaceId: workspace.id, createdByUserId: user.id, editorRevision: 0, status: "queued", progress: 0, resolution: "720p", watermark: true });
    expect(exports[0]!.variants.map((variant) => [variant.aspectRatio, variant.status, variant.resolution])).toEqual([["ratio_9_16", "pending", "720p"], ["ratio_1_1", "pending", "720p"]]);
    for (const variant of exports[0]!.variants) {
      expect(variant.render).toMatchObject({ clipId: clip.id, status: "pending", exportVariantId: variant.id, workflowRunId: null });
      // The frozen snapshot carries the boundary policy, so the render worker can decode it.
      expect(variant.render!.clipSnapshot).toMatchObject({ wholeSource: true, startSec: 0, endSec: 8 });
      expect(decodeFrozenClipEditorDocument(variant.render!.clipSnapshot, 8)).toMatchObject({ clipStartSec: 0, clipEndSec: 8 });
    }
    // The completion event freezes the export for the generation.
    const completion = await prisma.workflowEvent.findFirstOrThrow({ where: { workflowRunId: run.id, status: "completed" } });
    expect(completion.payload).toMatchObject({ generationExport: { exportId: exports[0]!.id, clipId: clip.id } });
  });

  test("detected clips are seeded with the Project's Brand Profile music through the real persistence path", async () => {
    const { project, run } = await fixture("moment_detection");
    const trackId = randomUUID();
    await prisma.project.update({ where: { id: project.id }, data: { brandProfileSnapshot: {
      version: 1, profileId: randomUUID(), profileRevision: 1, name: "Northstar", identity: {}, voice: {}, approvalRule: "none", style: null,
      audio: { music: [{ assetId: trackId, title: "Theme", durationSec: 60 }, { assetId: randomUUID(), title: "Second", durationSec: 30 }], sfx: [] },
    } } });
    const attempt = await getWorkflowRunLifecycle().claim("moment_detection");
    if (!attempt) throw new Error("moment-detection claim missing");
    expect(attempt.workflowRunId).toBe(run.id);

    const detected = (startSec: number) => ({
      startSec, endSec: startSec + 30, title: null, hookText: "Hook", payoffText: null, reasoning: "Fixture", category: "hook" as const,
      platformFit: ["tiktok" as const], hookStrengthScore: 70, emotionalIntensityScore: 70, storyCompletenessScore: 70, pacingScore: 70,
      durationOptimalityScore: 70, viralityScore: 70, tiktokScore: 70, youtubeScore: 70, instagramScore: 70, transcriptSlice: [],
    });
    await clipService.persistDetectedClips(attempt, [detected(0), detected(60)], { provider: "test", model: "test", totalTokensUsed: 1 });

    const clips = await prisma.clip.findMany({ where: { projectId: project.id }, orderBy: { index: "asc" } });
    expect(clips).toHaveLength(2);
    for (const clip of clips) {
      expect(studioEditsSchema.parse(clip.studioEdits).music).toMatchObject({ assetId: trackId, title: "Theme", url: null });
    }
  });

  test("a captioned video without its clip cannot complete detection, and nothing is admitted or completed", async () => {
    const { project, run } = await fixture("moment_detection");
    const attempt = await getWorkflowRunLifecycle().claim("moment_detection");
    if (!attempt) throw new Error("moment-detection claim missing");
    await expect(getWorkflowRunLifecycle().completeMomentDetection(attempt, { admit: clipExportService.captionedExportWrite(attempt, { aspectRatios: ["9:16"], resolution: "720p" }) }))
      .rejects.toMatchObject({ code: "clip_not_found" });
    expect(await prisma.clipExport.count({ where: { projectId: project.id } })).toBe(0);
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("running");
  });

  test("export child completion settles its parent aggregate in the same lifecycle command", async () => {
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
        exportVariantId: exportVariant.id,
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
  });

  test.each(["retry success", "retry exhaustion", "partial success"])("a retryable render failure cannot freeze a failed export callback before %s", async (ending) => {
    const { project, run, workspace } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const exported = await prisma.clipExport.create({ data: { workspaceId: workspace.id, projectId: project.id, clipId: clip.id, editorRevision: 0, fingerprint: randomUUID(), resolution: "1080p", watermark: false } });
    const variant = await prisma.clipExportVariant.create({ data: { exportId: exported.id, aspectRatio: "ratio_9_16", resolution: "1080p", watermark: false } });
    const render = await prisma.clipRender.create({ data: { clipId: clip.id, aspectRatio: "ratio_9_16", exportVariantId: variant.id } });
    const callback = await prisma.completionCallback.create({ data: { workspaceId: workspace.id, operationKind: "export", operationId: exported.id, receiptId: randomUUID(), encryptedUrl: "unused", urlHost: "example.test", urlFingerprint: randomUUID(), eventId: randomUUID() } });
    const observer = createCompletionCallbackProcessor({ prisma, readTrusted: createOperationStatusReader(prisma).readTrusted, leaseOwner: randomUUID(), cipher: createCallbackCipher("workflow-callback-test-key") });
    const sibling = ending === "partial success" ? await prisma.clipRender.create({ data: { clipId: clip.id, aspectRatio: "ratio_1_1" } }) : null;
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    await lifecycle.markClipRenderVariantRendering(attempt, render.id);
    if (sibling) {
      await lifecycle.markClipRenderVariantRendering(attempt, sibling.id);
      await lifecycle.completeClipRenderVariant(attempt, sibling.id, { storageKey: "tests/sibling.mp4", sizeBytes: 100, durationSec: 5 });
    }
    if (ending !== "retry success") await prisma.renderGroup.updateMany({ where: { workflowRunId: run.id }, data: { chargedAttemptCount: 3 } });
    await lifecycle.failClipRenderVariant(attempt, render.id, "storage_temporarily_unavailable", "retryable");
    expect(await observer.observe()).toBe(0);
    expect(await prisma.completionCallback.findUniqueOrThrow({ where: { id: callback.id } })).toMatchObject({ state: "waiting", payload: null });
    expect(await prisma.clipExport.findUniqueOrThrow({ where: { id: exported.id } })).toMatchObject({ status: "rendering", completedAt: null });
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
    expect(await observer.observe()).toBe(1);
    expect(await prisma.clipExport.findUniqueOrThrow({ where: { id: exported.id } })).toMatchObject({ status: ending === "retry success" ? "ready" : "failed", completedAt: expect.any(Date) });
    expect(await prisma.completionCallback.findUniqueOrThrow({ where: { id: callback.id } })).toMatchObject({ state: "pending", payload: { data: { state: ending === "retry success" ? "completed" : "failed" } } });
  });

  test("concurrent export child completions serialize parent aggregate settlement", async () => {
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
            exportVariantId: variant.id,
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
  });

  test("a child command rejects an attempt ref with the wrong project", async () => {
    const { user, workspace, run } = await fixture("moment_detection");
    const otherProject = await prisma.project.create({
      data: {
        title: "Other workflow project",
        sourceMediaUrl: "r2://test/other.mp4",
        workspaceId: workspace.id,
        createdByUserId: user.id,
      },
    });
    const lifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const attempt = await lifecycle.claim("moment_detection");
    if (!attempt) throw new Error("claim missing");
    const forged = { ...attempt, projectId: otherProject.id };

    await expect(lifecycle.replaceDetectedClips(forged, [])).rejects.toBeInstanceOf(
      WorkflowAttemptLost,
    );
    expect(
      (await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }))
        .status,
    ).toBe("running");
  });

  test.each(["before execution", "during execution"])("graceful shutdown %s releases Workflow Attempts without spending retries", async (when) => {
    for (const stage of ["stt", "moment_detection", "clip_rendering", "dubbing", "export_bundle"] as const) {
      const { run } = await fixture(stage);
      const lifecycle = new RenderFixtureLifecycle({ prisma, leaseOwner: randomUUID() });
      for (let shutdownCount = 0; shutdownCount < 4; shutdownCount += 1) {
        const attempt = await lifecycle.claim(stage);
        if (!attempt) throw new Error(`Missing ${stage} claim after shutdown ${shutdownCount}`);
        const shutdown = new AbortController();
        const reason = new Error("worker_shutdown");
        if (when === "before execution") shutdown.abort(reason);
        let executions = 0;
        await expect(lifecycle.runAttempt(attempt, async ({ signal }) => {
          executions += 1;
          shutdown.abort(reason);
          signal.throwIfAborted();
        }, { signal: shutdown.signal })).rejects.toBe(reason);
        expect(executions).toBe(when === "before execution" ? 0 : 1);
        expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
          status: "queued", attemptCount: 0, attemptId: null, leaseOwner: null, leaseExpiresAt: null, errorCode: null,
        });
        await prisma.workflowRun.update({ where: { id: run.id }, data: { nextAttemptAt: new Date(Date.now() - 1) } });
      }
    }
  });

  test.each([
    ["retry", "complete"], ["shutdown", "complete"], ["retry", "permanent failure"], ["shutdown", "retry exhaustion"],
  ])("dubbing retains earlier completed outputs after %s and %s", async (interruption, ending) => {
    const { run, project, workspace } = await fixture("dubbing");
    const clip = await clipFixture(project.id, run.id);
    const dubs = await Promise.all(["es", "fr"].map((targetLanguageCode) => prisma.clipDub.create({
      data: { projectId: project.id, clipId: clip.id, targetLanguageCode, voice: "marin", model: "test" },
    })));
    await prisma.generatedMediaUsageReservation.createMany({ data: dubs.map((dub) => ({
      jobId: dub.id, workspaceId: workspace.id, kind: "dub", policy: "metered", periodStart: new Date(Date.UTC(2026, 9, 1)), attachedAt: new Date(),
    })) });
    const lifecycle = new RenderFixtureLifecycle({ prisma, leaseOwner: randomUUID() });
    const first = await lifecycle.claim("dubbing");
    if (!first) throw new Error("first claim missing");
    for (const dub of dubs) expect((await lifecycle.markDubProcessing(first, dub.id)).count).toBe(1);
    await lifecycle.completeDub(first, dubs[0]!.id, {
      status: "completed", transcriptText: "hello", translatedText: "hola", audioStorageKey: "tests/dub.mp3", renderStorageKey: "tests/dub.mp4",
      audioSizeBytes: 100n, renderSizeBytes: 200n, durationSec: 5, completedAt: new Date(),
    });
    if (interruption === "shutdown") await lifecycle.releaseAttempt(first);
    else await lifecycle.failAttempt(first, new WorkflowFailure("worker_interrupted", "retryable", "retry"));
    await prisma.workflowRun.update({ where: { id: run.id }, data: { nextAttemptAt: new Date(Date.now() - 1) } });
    const next = await lifecycle.claim("dubbing");
    if (!next) throw new Error("next claim missing");
    expect((await lifecycle.markDubProcessing(next, dubs[1]!.id)).count).toBe(1);
    await lifecycle.failDub(next, dubs[1]!.id, "translation_rejected");
    if (ending === "complete") await lifecycle.completeDubbing(next);
    else {
      if (ending === "retry exhaustion") await prisma.workflowRun.update({ where: { id: run.id }, data: { attemptCount: 3 } });
      await lifecycle.failAttempt(next, new WorkflowFailure("dubbing_failed", ending === "retry exhaustion" ? "retryable" : "permanent", "failed"));
    }
    expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "partial", requestedCount: 2, succeededCount: 1, failedCount: 1,
    });
    expect((await prisma.clipDub.findUniqueOrThrow({ where: { id: dubs[0]!.id } })).status).toBe("completed");
  });

  test("terminal dubbing failure settles unclaimed queued siblings and releases their usage", async () => {
    const { run, project, workspace } = await fixture("dubbing");
    const clip = await clipFixture(project.id, run.id);
    const dubs = await Promise.all(["es", "fr"].map((targetLanguageCode) => prisma.clipDub.create({
      data: { projectId: project.id, clipId: clip.id, targetLanguageCode, voice: "marin", model: "test" },
    })));
    await prisma.generatedMediaUsageReservation.createMany({ data: dubs.map((dub) => ({
      jobId: dub.id, workspaceId: workspace.id, kind: "dub", policy: "metered", periodStart: new Date(Date.UTC(2026, 9, 1)), attachedAt: new Date(),
    })) });
    const lifecycle = new RenderFixtureLifecycle({ prisma, leaseOwner: randomUUID() });
    const attempt = await lifecycle.claim("dubbing");
    if (!attempt) throw new Error("claim missing");
    expect((await lifecycle.markDubProcessing(attempt, dubs[0]!.id)).count).toBe(1);
    await lifecycle.failAttempt(attempt, new WorkflowFailure("provider_not_configured", "permanent", "failed"));
    expect(await prisma.clipDub.findMany({ where: { projectId: project.id }, select: { status: true } }))
      .toEqual([{ status: "failed" }, { status: "failed" }]);
    expect(await prisma.generatedMediaUsageReservation.findMany({ where: { jobId: { in: dubs.map((dub) => dub.id) } }, select: { status: true } }))
      .toEqual([{ status: "released" }, { status: "released" }]);
    expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }))
      .toMatchObject({ status: "failed", requestedCount: 2, succeededCount: 0, failedCount: 2 });
  });

  test("shutdown release cannot refund an expired claim or change its replacement", async () => {
    const { run } = await fixture();
    const lifecycle = new RenderFixtureLifecycle({ prisma, leaseOwner: randomUUID() });
    const old = await lifecycle.claim("dubbing");
    if (!old) throw new Error("claim missing");
    await prisma.workflowRun.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });
    expect(await lifecycle.releaseAttempt(old)).toBe(false);
    expect(await lifecycle.reapExpiredAttempts()).toBe(1);
    await prisma.workflowRun.update({ where: { id: run.id }, data: { nextAttemptAt: new Date(Date.now() - 1) } });
    const next = await lifecycle.claim("dubbing");
    if (!next) throw new Error("replacement claim missing");
    expect(await lifecycle.releaseAttempt(old)).toBe(false);
    expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "running", attemptCount: 2, attemptId: next.attemptId });
    expect(await lifecycle.releaseAttempt(next)).toBe(true);
    expect(await lifecycle.releaseAttempt(next)).toBe(false);
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).attemptCount).toBe(1);
  });

  test("shutdown release leaves an accepted provider transcript waiting instead of submitting again", async () => {
    const { run, project } = await fixture("stt");
    const lifecycle = new RenderFixtureLifecycle({ prisma, leaseOwner: randomUUID() });
    const attempt = await lifecycle.claim("stt");
    if (!attempt) throw new Error("claim missing");
    await lifecycle.waitForProvider(attempt, { providerJobId: "accepted-before-shutdown", nextPollAt: new Date(Date.now() + 60_000) });
    expect(await lifecycle.releaseAttempt(attempt)).toBe(false);
    expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "waiting", attemptId: attempt.attemptId, attemptCount: 1 });
    expect((await prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } })).providerJobId).toBe("accepted-before-shutdown");
  });

  test("coordinator release preserves healthy groups and their completed and permanent outcomes", async () => {
    const { run, project } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variants = await Promise.all((["ratio_9_16", "ratio_1_1", "ratio_4_5"] as const).map((aspectRatio) =>
      prisma.clipRender.create({ data: { clipId: clip.id, aspectRatio } })));
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    for (const variant of variants) await lifecycle.markClipRenderVariantRendering(attempt, variant.id);
    await lifecycle.completeClipRenderVariant(attempt, variants[0]!.id, { storageKey: "tests/completed-before-shutdown.mp4", sizeBytes: 100, durationSec: 5 });
    await lifecycle.failClipRenderVariant(attempt, variants[1]!.id, "invalid_source", "permanent");
    expect(await lifecycle.releaseAttempt(attempt)).toBe(true);
    expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "queued", requestedCount: 3, attemptCount: 0 });
    expect(await prisma.clipRender.findUniqueOrThrow({ where: { id: variants[0]!.id } })).toMatchObject({ status: "completed", storageKey: "tests/completed-before-shutdown.mp4" });
    expect(await prisma.clipRender.findUniqueOrThrow({ where: { id: variants[1]!.id } })).toMatchObject({ status: "failed", failureDisposition: "permanent" });
    expect(await prisma.clipRender.findUniqueOrThrow({ where: { id: variants[2]!.id } })).toMatchObject({ status: "rendering", workflowAttemptId: null });
    await expect(lifecycle.completeClipRenderVariant(attempt, variants[2]!.id, { storageKey: "tests/stale-shutdown.mp4", sizeBytes: 100, durationSec: 5 })).rejects.toBeInstanceOf(WorkflowAttemptLost);
  });

  test("unstarted group resource release consumes no media budget", async () => {
    const { run, project } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    await prisma.clipRender.create({ data: { clipId: clip.id, aspectRatio: "ratio_9_16" } });
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    for (let i = 0; i < 8; i++) {
      const group = (await lifecycle.fixtureGroups.claim({ workflowRunId: run.id }))!;
      expect(group).not.toBeNull();
      await lifecycle.fixtureGroups.release({ ...group, reason: "pre_start_rejection" });
    }
    expect(await prisma.renderGroup.findFirstOrThrow({ where: { workflowRunId: run.id } })).toMatchObject({ chargedAttemptCount: 0 });
    expect(await prisma.renderGroupExecution.count({ where: { group: { workflowRunId: run.id }, startedAt: null, result: "released", charged: false } })).toBe(8);
  });

  test("shutdown releases a claim before an unresponsive handler returns", async () => {
    const { run } = await fixture();
    const lifecycle = new RenderFixtureLifecycle({ prisma, leaseOwner: randomUUID() });
    const attempt = await lifecycle.claim("dubbing");
    if (!attempt) throw new Error("claim missing");
    let handlerStarted!: () => void;
    let finishHandler!: () => void;
    let claimReleased!: () => void;
    const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
    const gate = new Promise<void>((resolve) => { finishHandler = resolve; });
    const released = new Promise<void>((resolve) => { claimReleased = resolve; });
    const release = lifecycle.releaseAttempt.bind(lifecycle);
    lifecycle.releaseAttempt = async (owned) => { const changed = await release(owned); claimReleased(); return changed; };
    const shutdown = new AbortController();
    const reason = new Error("worker_shutdown");
    const execution = lifecycle.runAttempt(attempt, async () => { handlerStarted(); await gate; }, { signal: shutdown.signal }).then(() => null, (error) => error);
    await started;
    try {
      shutdown.abort(reason);
      await released;
      expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("queued");
      finishHandler();
      expect(await execution).toBe(reason);
    } finally {
      finishHandler();
      await execution;
    }
  });

  test("a peer cannot claim a released attempt until its grace period passes", async () => {
    const { run } = await fixture();
    const lifecycle = new RenderFixtureLifecycle({ prisma, leaseOwner: randomUUID() });
    const peer = new RenderFixtureLifecycle({ prisma, leaseOwner: randomUUID() });
    const attempt = await lifecycle.claim("dubbing");
    if (!attempt) throw new Error("claim missing");
    const releasedAfter = Date.now();
    expect(await lifecycle.releaseAttempt(attempt)).toBe(true);
    const { status, nextAttemptAt } = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(status).toBe("queued");
    const delayMs = (nextAttemptAt?.getTime() ?? 0) - releasedAfter;
    expect(delayMs).toBeGreaterThan(WORKFLOW_RELEASE_GRACE_MS - 5_000);
    expect(delayMs).toBeLessThan(WORKFLOW_RELEASE_GRACE_MS + 5_000);
    // The aborted handler may still be inside a paid provider call.
    expect(await peer.claim("dubbing")).toBeNull();
    await prisma.workflowRun.update({ where: { id: run.id }, data: { nextAttemptAt: new Date(Date.now() - 1) } });
    expect(await peer.claim("dubbing")).toMatchObject({ workflowRunId: run.id, attemptCount: 1 });
  });

  test("a heartbeat blocked behind the handler's committed render settlement does not lose ownership", async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variant = await prisma.clipRender.create({ data: { clipId: clip.id, aspectRatio: "ratio_9_16" } });
    const claimed = await claimRenderAttempt();
    await claimed.lifecycle.beginRenderWorkSet(claimed.attempt);
    await claimed.lifecycle.markClipRenderVariantRendering(claimed.attempt, variant.id);
    await claimed.lifecycle.completeClipRenderVariant(claimed.attempt, variant.id, { storageKey: "tests/heartbeat-success.mp4", sizeBytes: 123, durationSec: 10 });
    await claimed.lifecycle.finishGroups();
    let entered!: () => void;
    const settlementWritten = new Promise<void>((resolve) => { entered = resolve; });
    let commit!: () => void;
    const allowCommit = new Promise<void>((resolve) => { commit = resolve; });
    let heartbeatStarted!: () => void;
    const heartbeatPending = new Promise<void>((resolve) => { heartbeatStarted = resolve; });
    let heartbeatReturned!: () => void;
    const heartbeatDone = new Promise<void>((resolve) => { heartbeatReturned = resolve; });
    const adapter = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === "$transaction") return (operation: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(async (tx) => {
          const result = await operation(tx);
          entered();
          await allowCommit;
          return result;
        });
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const runner = new RenderFixtureLifecycle({ prisma: adapter, leaseOwner: claimed.lifecycle.leaseOwner,
      leaseDurationMs: 10_000, heartbeatIntervalMs: 5 });
    const heartbeat = runner.heartbeat.bind(runner);
    runner.heartbeat = async (attempt) => {
      await settlementWritten;
      heartbeatStarted();
      try { await heartbeat(attempt); } finally { heartbeatReturned(); }
    };
    const result = runner.runAttempt(claimed.attempt, async ({ signal }) => {
      const settlement = runner.settleRenderWorkSet(claimed.attempt);
      try {
        await heartbeatPending;
        // PostgreSQL reports the real heartbeat UPDATE waiting on settlement.
        let waiting = false;
        for (let check = 0; check < 100 && !waiting; check += 1) {
          const rows = await pool.query<{ waiting: boolean }>(`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
              AND query LIKE '%UPDATE%"heartbeatAt"%' AND wait_event_type = 'Lock'
          ) AS waiting`);
          waiting = rows.rows[0]!.waiting;
          if (!waiting) await Bun.sleep(5);
        }
        expect(waiting).toBe(true);
        expect(signal.aborted).toBe(false);
      } finally { commit(); }
      expect(await settlement).toMatchObject({ status: "completed" });
      await heartbeatDone;
      await Bun.sleep(10);
      expect(signal.aborted).toBe(false);
      return "settled";
    });
    await expect(result).resolves.toBe("settled");
  });

  test("true lease loss before render settlement commits still aborts the handler", async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    await prisma.clipRender.create({ data: { clipId: clip.id, aspectRatio: "ratio_9_16" } });
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    await prisma.workflowRun.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    await expect(lifecycle.runAttempt(attempt, async ({ signal }) => {
      await lifecycle.settleRenderWorkSet(attempt);
      signal.throwIfAborted();
    })).rejects.toBeInstanceOf(WorkflowAttemptLost);
    expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "running" });
    expect(await prisma.workflowEvent.count({ where: { workflowRunId: run.id, notificationRequired: true } })).toBe(0);
  });

  test("heartbeat renews ownership and a live attempt is not reaped", async () => {
    const { run } = await fixture();
    const lifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 1_000,
    });
    const attempt = await lifecycle.claim("dubbing");
    if (!attempt) throw new Error("claim missing");
    const originalExpiry = attempt.leaseExpiresAt;
    await lifecycle.heartbeat(attempt);
    const renewed = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(renewed.leaseExpiresAt!.getTime()).toBeGreaterThanOrEqual(
      originalExpiry.getTime(),
    );
    expect(await lifecycle.reapExpiredAttempts()).toBe(0);
  });

  test("Workflow Attempt deadlines do not shift with the database session timezone", async () => {
    await fixture();
    const offsetPool = new Pool({ connectionString: databaseUrl,
      options: "-c timezone=Asia/Karachi", max: 1 });
    const offsetPrisma = new PrismaClient({ adapter: new PrismaPg(offsetPool,
      databaseSchema ? { schema: databaseSchema } : undefined),
      transactionOptions: { maxWait: 120_000, timeout: 120_000 } });
    try {
      const lifecycle = new RenderFixtureLifecycle({ prisma: offsetPrisma,
        leaseOwner: randomUUID(), leaseDurationMs: 10_000, heartbeatIntervalMs: 1_000 });
      const attempt = await lifecycle.claim("dubbing");
      if (!attempt) throw new Error("claim missing");
      const clock = await offsetPool.query<{ databaseNow: Date }>(
        'SELECT clock_timestamp() AS "databaseNow"',
      );
      const remaining = attempt.leaseExpiresAt.getTime() - clock.rows[0]!.databaseNow.getTime();
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(10_000);
      await lifecycle.heartbeat(attempt);
      expect(await lifecycle.reapExpiredAttempts()).toBe(0);
    } finally {
      await offsetPrisma.$disconnect();
      await offsetPool.end();
    }
  });

  test("a lease renewed after reaper discovery wins the expiry compare-and-set", async () => {
    const { run } = await fixture();
    const lifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const attempt = await lifecycle.claim("dubbing");
    if (!attempt) throw new Error("claim missing");

    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    await expect(
      lifecycle.failAttempt(
        attempt,
        new WorkflowFailure("worker_stalled", "retryable", "expired"),
        { expiredLeaseOnly: true },
      ),
    ).rejects.toBeInstanceOf(WorkflowAttemptLost);

    const stillOwned = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(stillOwned.status).toBe("running");
    expect(stillOwned.attemptId).toBe(attempt.attemptId);
  });

  test("waiting STT is not reaped and finalizes only its correlated attempt", async () => {
    const { run, project } = await fixture("stt");
    const lifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const claimed = await lifecycle.claim("stt");
    if (!claimed) throw new Error("claim missing");
    const attempt = claimed;
    await lifecycle.waitForProvider(attempt, {
      providerJobId: "provider-job-1",
      nextPollAt: new Date(Date.now() - 1_000),
    });
    expect(await lifecycle.reapExpiredAttempts()).toBe(0);
    const due = await lifecycle.claimDueWaitingTranscripts(10, 5_000);
    expect(due).toHaveLength(1);
    expect(due[0]?.attemptId).toBe(attempt.attemptId);

    await lifecycle.completeTranscript(attempt, {
        provider: "assemblyai",
        providerModel: "test",
        providerJobId: "provider-job-1",
        languageCode: "en",
        languageConfidence: 1,
        text: "test transcript",
        utterances: [] as Prisma.InputJsonValue,
        speakerCount: 1,
        durationSeconds: 10,
        rawStorageKey: null,
      });

    const [settled, transcript, child] = await Promise.all([
      prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
      prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } }),
      prisma.workflowRun.findFirstOrThrow({
        where: { projectId: project.id, stage: "moment_detection" },
      }),
    ]);
    expect(settled.status).toBe("completed");
    expect(transcript.workflowAttemptId).toBe(attempt.attemptId);
    expect(child.status).toBe("queued");
  });

  describe("transcription for a captioned video", () => {
    const probe = (audio: boolean) => ({ durationSec: 8, video: { width: 1080, height: 1920, frameRate: { numerator: 24, denominator: 1 }, startTimecode: null }, audio: audio ? { sampleRate: 48_000, channels: 2 } : null });
    async function captionedRun(captions: Parameters<typeof buildCaptionedVideoSettings>[0]["captions"], options: { audio?: boolean } = {}) {
      const { project, run } = await fixture("stt");
      await prisma.project.update({ where: { id: project.id }, data: { sourceDurationSeconds: 8, languageCode: "auto", sourceProbe: probe(options.audio ?? true) } });
      const pack = await prisma.contentPack.create({ data: { projectId: project.id, ...buildCaptionedVideoContentPack(buildCaptionedVideoSettings({ captions })) } });
      await prisma.workflowRun.update({ where: { id: run.id }, data: { contentPackId: pack.id } });
      const lifecycle = getWorkflowRunLifecycle();
      const attempt = await lifecycle.claim("stt");
      if (!attempt) throw new Error("stt claim missing");
      return { project, run, pack, lifecycle, attempt, plan: await projectService.getTranscriptPlanForWorker({ projectId: project.id, contentPackId: attempt.contentPackId }) };
    }

    test("supplied captions complete the claimed run with no provider job and queue detection on the same pack", async () => {
      const { project, run, pack, lifecycle, attempt, plan } = await captionedRun({ source: "supplied", text: "1\n00:00:00,000 --> 00:00:02,000\nHello there\n\n2\n00:00:09,000 --> 00:00:10,000\npast the end" });
      expect(plan).toMatchObject({ plan: { kind: "supplied" }, durationSeconds: 8, languageCode: null });
      if (plan.plan.kind !== "supplied") throw new Error("expected supplied captions");
      const utterances = fitSuppliedUtterances(plan.plan.utterances, 8);
      await lifecycle.completeTranscript(attempt, { provider: "supplied_captions", providerModel: null, providerJobId: null, languageCode: plan.languageCode, languageConfidence: null,
        text: utterances.map((utterance) => utterance.text).join(" "), utterances, speakerCount: 1, durationSeconds: plan.durationSeconds, rawStorageKey: null });

      const [settled, transcript, child] = await Promise.all([
        prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
        prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } }),
        prisma.workflowRun.findFirstOrThrow({ where: { projectId: project.id, stage: "moment_detection" } }),
      ]);
      expect(settled.status).toBe("completed");
      expect(transcript).toMatchObject({ status: "completed", provider: "supplied_captions", providerJobId: null, languageCode: null, text: "Hello there", durationSeconds: 8 });
      expect((transcript.utterancesJson as Array<{ text: string }>).map((utterance) => utterance.text)).toEqual(["Hello there"]);
      expect(child).toMatchObject({ status: "queued", contentPackId: pack.id });
    });

    test.each([
      ["declined captions", { source: "none" as const }, true, "captions_none"],
      ["a source with no audio stream", { source: "auto" as const }, false, "no_audio_stream"],
    ])("%s complete the claimed run with an empty transcript", async (_name, captions, audio, reason) => {
      const { project, lifecycle, attempt, plan } = await captionedRun(captions, { audio });
      expect(plan.plan).toEqual({ kind: "empty", reason });
      await lifecycle.completeTranscript(attempt, { provider: "none", providerModel: null, providerJobId: null, languageCode: plan.languageCode, languageConfidence: null,
        text: "", utterances: [], speakerCount: 0, durationSeconds: plan.durationSeconds, rawStorageKey: null });
      expect(await prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } })).toMatchObject({ status: "completed", text: "", utterancesJson: [], speakerCount: 0 });
      expect(await prisma.workflowRun.count({ where: { projectId: project.id, stage: "moment_detection", status: "queued" } })).toBe(1);
    });

    test("spoken captions on a source that may have speech still need the provider", async () => {
      const { plan } = await captionedRun({ source: "auto" });
      expect(plan.plan).toEqual({ kind: "speech_to_text" });
    });

    test("only a caption-only generation may finish a provider transcript with no speech", async () => {
      const { run } = await captionedRun({ source: "auto" });
      expect(await projectService.runAllowsEmptyTranscript(run.id)).toBe(true);
      const ordinary = await fixture("stt");
      const pack = await prisma.contentPack.create({ data: { projectId: ordinary.project.id, ...buildGenerationContentPack() } });
      await prisma.workflowRun.update({ where: { id: ordinary.run.id }, data: { contentPackId: pack.id } });
      expect(await projectService.runAllowsEmptyTranscript(ordinary.run.id)).toBe(false);
    });
  });

  test("concurrent transitions allocate unique monotonic project sequences", async () => {
    const { project } = await fixture();
    await prisma.workflowRun.deleteMany({ where: { projectId: project.id } });
    await prisma.workflowEvent.deleteMany({ where: { projectId: project.id } });
    await prisma.project.update({
      where: { id: project.id },
      data: { workflowEventSeq: 0 },
    });
    await prisma.workflowRun.createMany({
      data: Array.from({ length: 8 }, (_, index) => ({
        projectId: project.id,
        idempotencyKey: `sequence:${index}`,
        stage: "dubbing",
        status: "queued",
      })),
    });
    const claims = [];
    for (let index = 0; index < 8; index += 1) {
      const lifecycle = new RenderFixtureLifecycle({
        prisma,
        leaseOwner: randomUUID(),
      });
      const attempt = await lifecycle.claim("dubbing");
      if (!attempt) throw new Error(`claim ${index} missing`);
      claims.push({ lifecycle, attempt });
    }
    await prisma.workflowEvent.deleteMany({ where: { projectId: project.id } });
    await prisma.project.update({
      where: { id: project.id },
      data: { workflowEventSeq: 0 },
    });

    await Promise.all(
      claims.map(({ lifecycle, attempt }) => lifecycle.completeStage(attempt)),
    );
    const events = await prisma.workflowEvent.findMany({
      where: { projectId: project.id },
      orderBy: { seq: "asc" },
      select: { seq: true },
    });
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("Workflow Event delivery starts each lease when its work begins", async () => {
    const { run } = await fixture();
    const remaining: number[] = [];
    let clock = Date.now();
    let advanced = false;
    const client = eventClient({ async updateMany(args) {
      const result = await prisma.workflowEvent.updateMany(args);
      if (!advanced && args?.data.deliveryLeaseOwner === null && args.data.lastDeliveryError === null) {
        advanced = true;
        clock += 31_000;
        setSystemTime(new Date(clock));
      }
      return result;
    } });
    const lifecycle = new RenderFixtureLifecycle({ prisma: client, leaseOwner: randomUUID(), publishRedis: async (payload) => {
      const event = await prisma.workflowEvent.findFirstOrThrow({ where: { workflowRunId: run.id, seq: payload.seq } });
      remaining.push(event.deliveryLeaseExpiresAt!.getTime() - Date.now());
      return true;
    } });
    const attempt = await lifecycle.claim("dubbing");
    if (!attempt) throw new Error("claim missing");
    await lifecycle.reportProgress(attempt, 20);
    try {
      clock = Date.now() + 1_000;
      setSystemTime(new Date(clock));
      expect(await lifecycle.dispatchEvents()).toBe(2);
      expect(remaining).toHaveLength(2);
      expect(remaining.every((value) => value > 0)).toBe(true);
    } finally {
      setSystemTime();
    }
  });

  test("Workflow Event claiming rechecks backoff after discovery", async () => {
    const { run } = await fixture();
    let published = 0;
    let postponed = false;
    const deferredUntil = new Date(Date.now() + 60_000);
    const client = eventClient({ async findMany(args) {
      const candidates = await prisma.workflowEvent.findMany(args);
      if (!postponed && candidates.length) {
        postponed = true;
        await prisma.workflowEvent.updateMany({ where: { id: { in: candidates.map((event) => event.id) } }, data: { nextDeliveryAt: deferredUntil } });
      }
      return candidates;
    } });
    const lifecycle = new RenderFixtureLifecycle({ prisma: client, leaseOwner: randomUUID(), publishRedis: async () => { published += 1; return true; } });
    await lifecycle.claim("dubbing");
    expect(await lifecycle.dispatchEvents()).toBe(0);
    expect(published).toBe(0);
    expect(await prisma.workflowEvent.findFirstOrThrow({ where: { workflowRunId: run.id } })).toMatchObject({ nextDeliveryAt: deferredUntil, deliveryAttempts: 0 });
  });

  test("Workflow Event delivery reloads completed channel checkpoints after claiming", async () => {
    const { run } = await fixture();
    let published = 0;
    let analytics = 0;
    let checkpointed = false;
    const client = eventClient({ async findMany(args) {
      const candidates = await prisma.workflowEvent.findMany(args);
      if (!checkpointed && candidates.length) {
        checkpointed = true;
        await prisma.workflowEvent.updateMany({ where: { id: { in: candidates.map((event) => event.id) } }, data: { redisPublishedAt: new Date() } });
      }
      return candidates;
    } });
    const lifecycle = new RenderFixtureLifecycle({ prisma: client, leaseOwner: randomUUID(),
      publishRedis: async () => { published += 1; return true; }, publishAnalytics: async () => { analytics += 1; } });
    const attempt = await lifecycle.claim("dubbing");
    if (!attempt) throw new Error("claim missing");
    await lifecycle.completeStage(attempt);
    await prisma.workflowEvent.deleteMany({ where: { workflowRunId: run.id, analyticsRequired: false } });
    expect(await lifecycle.dispatchEvents()).toBe(1);
    expect(published).toBe(0);
    expect(analytics).toBe(1);
  });

  test("a stale Workflow Event execution cannot clear a newer claim by the same worker", async () => {
    const { run } = await fixture();
    let firstStarted!: () => void;
    let nextStarted!: () => void;
    let failFirst!: (error: Error) => void;
    let finishNext!: (result: boolean) => void;
    const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
    const nextReady = new Promise<void>((resolve) => { nextStarted = resolve; });
    const firstGate = new Promise<boolean>((_resolve, reject) => { failFirst = reject; });
    const nextGate = new Promise<boolean>((resolve) => { finishNext = resolve; });
    let calls = 0;
    const lifecycle = new RenderFixtureLifecycle({ prisma, leaseOwner: "shared-event-worker", publishRedis: async () => {
      calls += 1;
      if (calls === 1) { firstStarted(); return firstGate; }
      nextStarted(); return nextGate;
    } });
    await lifecycle.claim("dubbing");
    const first = lifecycle.dispatchEvents();
    await firstReady;
    const event = await prisma.workflowEvent.findFirstOrThrow({ where: { workflowRunId: run.id } });
    await prisma.workflowEvent.update({ where: { id: event.id }, data: { deliveryLeaseExpiresAt: new Date(Date.now() - 1) } });
    const next = lifecycle.dispatchEvents();
    await nextReady;
    const claimed = await prisma.workflowEvent.findUniqueOrThrow({ where: { id: event.id } });
    try {
      failFirst(new Error("stale delivery failed"));
      expect(await first).toBe(0);
      expect(await prisma.workflowEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
        deliveryLeaseOwner: claimed.deliveryLeaseOwner, lastDeliveryError: null, nextDeliveryAt: claimed.nextDeliveryAt,
      });
      finishNext(true);
      expect(await next).toBe(1);
      expect((await prisma.workflowEvent.findUniqueOrThrow({ where: { id: event.id } })).redisPublishedAt).not.toBeNull();
    } finally {
      failFirst(new Error("cleanup")); finishNext(true);
      await Promise.allSettled([first, next]);
    }
  });

  test("an unavailable Redis publisher is not acknowledged as delivered", async () => {
    const { project, run } = await fixture();
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: "completed" },
    });
    const dependencies = {
      prisma,
      leaseOwner: randomUUID(),
      publishRedis: async () => false,
    };
    const lifecycle = new RenderFixtureLifecycle(dependencies);
    const admitted = await lifecycle.admit({
      projectId: project.id,
      idempotencyKey: `delivery:${randomUUID()}`,
      stage: "dubbing",
    });

    expect(await lifecycle.dispatchEvents()).toBe(0);
    const event = await prisma.workflowEvent.findFirstOrThrow({
      where: { workflowRunId: admitted.id },
    });
    expect(event.redisPublishedAt).toBeNull();
    expect(event.deliveryAttempts).toBe(1);
    expect(event.nextDeliveryAt.getTime()).toBeGreaterThan(
      event.createdAt.getTime(),
    );
  });

  test("aggregate completion persists an explicit partial outcome", async () => {
    const { run } = await fixture("dubbing");
    const lifecycle = new RenderFixtureLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const attempt = await lifecycle.claim("dubbing");
    if (!attempt) throw new Error("claim missing");

    await lifecycle.completeAggregateStage(attempt, {
      requestedCount: 5,
      succeededCount: 3,
      failedCount: 2,
    });

    const settled = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(settled.status).toBe("partial");
    expect(settled.requestedCount).toBe(5);
    expect(settled.succeededCount).toBe(3);
    expect(settled.failedCount).toBe(2);
  });

  test("lists a ready source as processing while its current detection run is active", async () => {
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
  });

  test("paginates downstream processing projects without dropping their filtered count", async () => {
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
  });

  test("keeps an older active run ahead of a newer terminal sibling in list and detail progress", async () => {
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
  });

  test("treats search wildcards as literal text", async () => {
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
  });
});
