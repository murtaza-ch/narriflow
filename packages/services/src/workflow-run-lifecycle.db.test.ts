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
import { Pool } from "pg";
import {
  WorkflowAttemptContextRequired,
  WorkflowAttemptLost,
  WorkflowFailure,
  WorkflowRunLifecycle,
  workflowAttemptRef,
} from "./workflow-run-lifecycle";
import { projectService } from "./project.service";
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
    const project = await prisma.project.create({
      data: {
        title: "Workflow lifecycle test",
        sourceMediaUrl: "r2://test/source.mp4",
        userId: user.id,
      },
    });
    const run = await prisma.workflowRun.create({
      data: {
        projectId: project.id,
        idempotencyKey: `fixture:${suffix}`,
        stage,
        status: "queued",
        lifecycleVersion: 2,
      },
    });
    return { user, project, run };
  }

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
    const { user, project } = await fixture("moment_detection");
    await prisma.workflowRun.deleteMany({ where: { projectId: project.id } });
    const otherProject = await prisma.project.create({
      data: {
        title: "Other workflow project",
        sourceMediaUrl: "r2://test/other.mp4",
        userId: user.id,
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
      firstLifecycle.completeClipRenderVariant(first, {
        clipRenderId: render.id,
        exportVariantId: null,
        storageKey: "test/stale.mp4",
        sizeBytes: 100,
        durationSec: 10,
        completedAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(WorkflowAttemptLost);
    expect(
      (await prisma.clipRender.findUniqueOrThrow({ where: { id: render.id } }))
        .status,
    ).not.toBe("completed");
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

  test("a child command rejects an attempt ref with the wrong project", async () => {
    const { user, run } = await fixture("moment_detection");
    const otherProject = await prisma.project.create({
      data: {
        title: "Other workflow project",
        sourceMediaUrl: "r2://test/other.mp4",
        userId: user.id,
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

  test("a context-free caller cannot claim a protocol-v2 child artifact", async () => {
    const { run, project } = await fixture("clip_rendering");
    const clip = await prisma.clip.create({
      data: {
        projectId: project.id,
        workflowRunId: run.id,
        index: 0,
        startSec: 0,
        endSec: 10,
        hookText: "Guarded",
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
      data: { clipId: clip.id, aspectRatio: "ratio_9_16", status: "pending" },
    });

    await expect(
      clipService.markClipRenderVariantRendering(render.id),
    ).rejects.toBeInstanceOf(WorkflowAttemptContextRequired);
    expect(
      (await prisma.clipRender.findUniqueOrThrow({ where: { id: render.id } }))
        .status,
    ).toBe("pending");
  });

  test("a protocol-v2 run cannot fall through a context-free compatibility completion", async () => {
    const { run } = await fixture("dubbing");
    await expect(
      projectService.completeDubbingWorkflowRun(run.id),
    ).rejects.toBeInstanceOf(WorkflowAttemptContextRequired);
    expect(
      (await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }))
        .status,
    ).toBe("queued");
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
    const attempt = workflowAttemptRef({
      id: claimed.workflowRunId,
      projectId: claimed.projectId,
      stage: claimed.stage,
      attemptId: claimed.attemptId,
      attemptCount: claimed.attemptCount,
    });
    await lifecycle.waitForProvider(attempt, {
      providerJobId: "provider-job-1",
      nextPollAt: new Date(Date.now() - 1_000),
    });
    expect(await lifecycle.reapExpiredAttempts()).toBe(0);
    const due = await lifecycle.claimDueWaitingTranscripts(10, 5_000);
    expect(due).toHaveLength(1);
    expect(due[0]?.attemptId).toBe(attempt.attemptId);

    await lifecycle.runWaitingAttempt(attempt, () =>
      lifecycle.completeTranscript(attempt, {
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
      }),
    );

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
    expect(child.lifecycleVersion).toBe(2);
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
        lifecycleVersion: 2,
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

  test("a protocol-v2 admission advances past an event inserted by a protocol-v1 writer", async () => {
    const { project, run } = await fixture();
    await prisma.workflowEvent.deleteMany({ where: { projectId: project.id } });
    await prisma.project.update({
      where: { id: project.id },
      data: { workflowEventSeq: 0 },
    });
    await prisma.workflowEvent.create({
      data: {
        projectId: project.id,
        workflowRunId: run.id,
        seq: 1,
        stage: "dubbing",
        status: "queued",
        progress: 0,
        emittedAt: new Date(),
        dedupeKey: null,
        payload: {
          event: "workflow.stage.updated",
          projectId: project.id,
          workflowRunId: run.id,
          seq: 1,
          stage: "dubbing",
          status: "queued",
          progress: 0,
          errorCode: null,
          emittedAt: new Date().toISOString(),
        },
      },
    });
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: "completed" },
    });

    const lifecycle = new WorkflowRunLifecycle({
      prisma,
      leaseOwner: randomUUID(),
    });
    await expect(
      lifecycle.admit({
        projectId: project.id,
        idempotencyKey: `mixed-version:${randomUUID()}`,
        stage: "dubbing",
      }),
    ).resolves.toMatchObject({ created: true });

    const [events, advancedProject] = await Promise.all([
      prisma.workflowEvent.findMany({
        where: { projectId: project.id },
        orderBy: { seq: "asc" },
        select: { seq: true },
      }),
      prisma.project.findUniqueOrThrow({ where: { id: project.id } }),
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(advancedProject.workflowEventSeq).toBe(2);
  });

  test("a protocol-v2 admission retries when a protocol-v1 writer wins the same sequence", async () => {
    const { project, run } = await fixture();
    await prisma.workflowEvent.deleteMany({ where: { projectId: project.id } });
    await prisma.project.update({
      where: { id: project.id },
      data: { workflowEventSeq: 0 },
    });
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: "completed" },
    });

    const legacyWriter = await pool.connect();
    let legacyTransactionOpen = false;
    try {
      await legacyWriter.query("BEGIN");
      legacyTransactionOpen = true;
      await legacyWriter.query(
        `INSERT INTO "WorkflowEvent" (
          "id", "projectId", "workflowRunId", "seq", "stage", "status",
          "progress", "emittedAt"
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'dubbing', 'queued', 0, CURRENT_TIMESTAMP)`,
        [randomUUID(), project.id, run.id],
      );

      const lifecycle = new WorkflowRunLifecycle({
        prisma,
        leaseOwner: randomUUID(),
      });
      const admission = lifecycle.admit({
        projectId: project.id,
        idempotencyKey: `mixed-version-race:${randomUUID()}`,
        stage: "dubbing",
      });

      let collisionIsWaiting = false;
      for (let poll = 0; poll < 50 && !collisionIsWaiting; poll += 1) {
        const waiting = await pool.query<Array<{ count: bigint }>>(
          `
          SELECT COUNT(*)::bigint AS "count"
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> $1
            AND wait_event_type = 'Lock'
            AND query NOT LIKE '%pg_stat_activity%'
        `,
          [legacyWriter.processID],
        );
        collisionIsWaiting = Number(waiting.rows[0]?.count ?? 0) > 0;
      }
      expect(collisionIsWaiting).toBe(true);
      await legacyWriter.query("COMMIT");
      legacyTransactionOpen = false;

      await expect(admission).resolves.toMatchObject({ created: true });
      expect(
        (
          await prisma.workflowEvent.findMany({
            where: { projectId: project.id },
            orderBy: { seq: "asc" },
            select: { seq: true },
          })
        ).map((event) => event.seq),
      ).toEqual([1, 2]);
    } finally {
      if (legacyTransactionOpen) await legacyWriter.query("ROLLBACK");
      legacyWriter.release();
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
