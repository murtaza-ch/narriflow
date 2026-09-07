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
import { workflowStageUpdatedEventSchema } from "@narriflow/validators";
import { Pool } from "pg";
import {
  type WorkflowAttemptRef,
  WorkflowAttemptLost,
  WorkflowFailure,
  WorkflowRunLifecycle,
} from "./workflow-run-lifecycle";
import { notificationService } from "./notification.service";
import { clipService } from "./clip.service";

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
        userId: user.id,
        workspaceId: workspace.id,
        createdByUserId: user.id,
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
    const lifecycle = new WorkflowRunLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const attempt = await lifecycle.claim("clip_rendering");
    if (!attempt) throw new Error("clip-rendering claim missing");
    return { attempt, lifecycle };
  }

  async function failAndClaimNextRenderAttempt(
    runId: string,
    lifecycle: WorkflowRunLifecycle,
    attempt: WorkflowAttemptRef,
  ) {
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
    lifecycle: WorkflowRunLifecycle,
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
    const lifecycle = new WorkflowRunLifecycle({ prisma });

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
    const lifecycle = new WorkflowRunLifecycle({
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
      userId: user.id,
      workspaceId: workspace.id,
      ownerTier: "pro",
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
    const dispatcher = new WorkflowRunLifecycle({
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
    const dispatcher = new WorkflowRunLifecycle({
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
    const dispatcher = new WorkflowRunLifecycle({
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
    const dispatcher = new WorkflowRunLifecycle({
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
      status: "requeued",
      requested: 2,
      succeeded: 0,
      failed: 1,
      superseded: 0,
      followUpWorkflowRunId: null,
    });
    expect(
      await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({
      status: "queued",
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
        errorCode: "legacy_render_failure",
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
      errorCode: "legacy_render_failure",
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
      workflowAttemptId: first.attempt.attemptId,
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
    { phase: "child settlement", table: "ClipRender", operation: "UPDATE" },
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
        await prisma.workflowRun.update({
          where: { id: run.id },
          data: { attemptCount: 3 },
        });
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

  test("retry exhaustion creates durable failed-render notification intent", async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    await lifecycle.markClipRenderVariantRendering(attempt, variant.id);
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { attemptCount: 3 },
    });

    await lifecycle.failAttempt(
      attempt,
      new WorkflowFailure("worker_stalled", "retryable", "lease expired"),
    );

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
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { attemptCount: 3 },
    });

    await lifecycle.failAttempt(
      attempt,
      new WorkflowFailure("worker_stalled", "retryable", "lease expired"),
    );

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

  test("terminal render reaping completes an all-superseded lineage silently", async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const variant = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16" },
    });
    const { lifecycle, attempt } = await claimRenderAttempt();
    await lifecycle.beginRenderWorkSet(attempt);
    await prisma.clipRender.delete({ where: { id: variant.id } });
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { attemptCount: 3 },
    });

    await lifecycle.failAttempt(
      attempt,
      new WorkflowFailure("worker_stalled", "retryable", "lease expired"),
    );

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
      () => new WorkflowRunLifecycle({ prisma, leaseOwner: randomUUID() }),
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
        new WorkflowRunLifecycle({
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
        userId: user.id,
        workspaceId: workspace.id,
        createdByUserId: user.id,
      },
    });
    const packData = {
      outputTypes: ["short_clip" as const],
      clipCountTarget: 3,
      clipDurationSecTarget: 45,
      toneConstraints: [],
      captionPreset: "default",
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
    const lifecycle = new WorkflowRunLifecycle({ prisma });

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
    const lifecycle = new WorkflowRunLifecycle({
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
        autoRenderClips: false,
        toneConstraints: [],
        captionPreset: "default",
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
    const lifecycle = new WorkflowRunLifecycle({
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
    const lifecycle = new WorkflowRunLifecycle({
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
  });

  test("one of twenty racing workers owns a queued run", async () => {
    const { run } = await fixture();
    const claims = await Promise.all(
      Array.from({ length: 20 }, () =>
        new WorkflowRunLifecycle({ prisma, leaseOwner: randomUUID() }).claim(
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
    const firstLifecycle = new WorkflowRunLifecycle({
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

    const secondLifecycle = new WorkflowRunLifecycle({
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
    const firstLifecycle = new WorkflowRunLifecycle({
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
    const second = await new WorkflowRunLifecycle({
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
    const firstLifecycle = new WorkflowRunLifecycle({
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
    const second = await new WorkflowRunLifecycle({
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
        failure: { version: 2, state: "failed" },
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
        failure: { version: 2, state: "failed" },
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
        failure: { version: 2, state: "failed" },
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

  test("automatic-layout evidence is create-only", async () => {
    const { project, run } = await fixture("clip_rendering");
    const clip = await clipFixture(project.id, run.id);
    const previewStorageKey = `previews/${clip.id}/current.mp4`;
    await prisma.clip.update({
      where: { id: clip.id },
      data: {
        previewStorageKey,
        autoLayoutAnalysis: { version: 1, sourceIdentity: "source:stale" },
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
      analysis: { version: 1, sourceIdentity: "source:current" },
      editorRevision: clip.editorRevision,
      previewStorageKey,
    };
    await expect(
      lifecycle.completeClipAutoLayoutAnalysis(attempt, input),
    ).resolves.toBe(false);
    expect(
      (
        await prisma.clip.findUniqueOrThrow({ where: { id: clip.id } })
      ).autoLayoutAnalysis,
    ).toEqual({ version: 1, sourceIdentity: "source:stale" });
  });

  test("a stage-specific child command rejects an attempt from another stage", async () => {
    const { project } = await fixture("clip_rendering");
    const lifecycle = new WorkflowRunLifecycle({
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
    const lifecycle = new WorkflowRunLifecycle({
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
    const lifecycle = new WorkflowRunLifecycle({
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
    const lifecycle = new WorkflowRunLifecycle({
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
        userId: user.id,
        workspaceId: workspace.id,
        createdByUserId: user.id,
      },
    });
    const lifecycle = new WorkflowRunLifecycle({
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

  test("heartbeat renews ownership and a live attempt is not reaped", async () => {
    const { run } = await fixture();
    const lifecycle = new WorkflowRunLifecycle({
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
      databaseSchema ? { schema: databaseSchema } : undefined) });
    try {
      const lifecycle = new WorkflowRunLifecycle({ prisma: offsetPrisma,
        leaseOwner: randomUUID(), leaseDurationMs: 10_000, heartbeatIntervalMs: 1_000 });
      const attempt = await lifecycle.claim("dubbing");
      if (!attempt) throw new Error("claim missing");
      const remaining = attempt.leaseExpiresAt.getTime() - Date.now();
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
    const lifecycle = new WorkflowRunLifecycle({
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
    const lifecycle = new WorkflowRunLifecycle({
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
      const lifecycle = new WorkflowRunLifecycle({
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
    const lifecycle = new WorkflowRunLifecycle(dependencies);
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
    const { run } = await fixture("clip_rendering");
    const lifecycle = new WorkflowRunLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    const attempt = await lifecycle.claim("clip_rendering");
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
});
