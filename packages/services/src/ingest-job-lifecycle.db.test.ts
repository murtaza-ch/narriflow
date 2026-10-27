import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
import { Pool } from "pg";
import {
  IngestJobClaimLost,
  IngestJobLifecycle,
  IngestNotFailedError,
  IngestReselectRequiredError,
  IngestRetryLimitExceededError,
  type IngestJobLifecycleDependencies,
} from "./ingest-job-lifecycle";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { autoTriggerIdempotencyKey } from "./generation-sequencing";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { ProcessingUsage } from "./processing-usage";
import { creditDebitSeconds } from "@narriflow/validators";

const url = process.env.WORKFLOW_TEST_DATABASE_URL;
const schema = process.env.WORKFLOW_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_WORKFLOW_DB_TESTS === "1" && Boolean(url);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);

dbDescribe("Ingest Job lifecycle PostgreSQL interface", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let clock = Date.now();
  const users: string[] = [];
  beforeAll(() => {
    if (!schema?.startsWith("workflow_lifecycle_test_"))
      throw new Error("Ingest tests require a disposable schema");
    pool = new Pool({ connectionString: url, max: 4 });
    prisma = new PrismaClient({
      adapter: new PrismaPg(pool, { schema }),
      transactionOptions: { timeout: 30_000 },
    });
  });
  afterEach(async () => {
    const userIds = users.splice(0);
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
  function usage(
    hooks: { beforeSettle?: () => Promise<void> } = {},
  ): IngestJobLifecycleDependencies["usage"] {
    const real = new ProcessingUsage({
      prisma,
      log: () => {},
    });
    return {
      reserve: (tx, input) => real.reserve(tx, input),
      release: (tx, input) => real.release(tx, input),
      settle: async (tx, projectId) => {
        await hooks.beforeSettle?.();
        return real.settle(tx, projectId);
      },
    };
  }
  function lifecycle(overrides: Partial<IngestJobLifecycleDependencies> = {}) {
    return new IngestJobLifecycle({
      prisma,
      workflow: new WorkflowRunLifecycle({ prisma }),
      now: () => new Date(clock),
      requireRetryActor: async () => {},
      usage: usage(),
      sourceBucket: "ingest-test",
      ...overrides,
    });
  }
  async function reservation(
    projectId: string,
    workspaceId: string,
    state: "reserved" | "settled" = "reserved",
    seconds = 60,
  ) {
    const now = new Date();
    return prisma.processingUsageReservation.create({
      data: {
        projectId,
        workspaceId,
        intakeKind: "link",
        periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        // The ledger debits whole credits of the source's length.
        reservedSeconds: creditDebitSeconds(seconds),
        settledSeconds: state === "settled" ? creditDebitSeconds(seconds) : null,
        state,
      },
    });
  }
  async function fixture(
    status: "queued" | "ready" | "failed" = "queued",
    payload = {},
  ) {
    clock = Date.now();
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        clerkId: `ingest-db:${suffix}`,
        primaryEmail: `ingest-${suffix}@example.test`,
      },
    });
    users.push(user.id);
    const workspace = await prisma.workspace.create({
      data: {
        name: "Ingest lifecycle",
        ownerUserId: user.id,
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    const project = await prisma.project.create({
      data: {
        title: "Ingest",
        sourceMediaUrl: "r2://pending",
        workspaceId: workspace.id,
        createdByUserId: user.id,
        ingestStatus: status,
        sourceDurationSeconds: status === "ready" ? 60 : null,
      },
    });
    const job = await prisma.ingestJob.create({
      data: {
        projectId: project.id,
        jobType: "link_import",
        payload,
        status:
          status === "ready"
            ? "completed"
            : status === "failed"
              ? "failed"
              : "queued",
        completedAt: status === "ready" ? new Date(clock) : null,
      },
    });
    return { project, job, user, workspace };
  }
  async function committedPack(projectId: string) {
    return prisma.contentPack.create({
      data: {
        projectId,
        outputTypes: ["short_clip"],
        clipGenerationMode: "viral_moments",
        clipCountTarget: 10,
        clipDurationSecTarget: 45,
        platformTargets: ["tiktok"],
        toneConstraints: [],
        captionPreset: "brand_default",
        platformPlaybookVersion: "2026-07-01",
      },
    });
  }
  function transactionFault(
    method: "create" | "updateMany",
    table: "ingestJob" | "workflowEvent",
    condition?: (args: unknown) => boolean,
  ): PrismaClient {
    return new Proxy(prisma, {
      get(target, property) {
        if (property !== "$transaction") return Reflect.get(target, property);
        return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction((tx) =>
            work(
              new Proxy(tx, {
                get(inner, field) {
                  if (field !== table) return Reflect.get(inner, field);
                  return new Proxy(Reflect.get(inner, field), {
                    get(model, name) {
                      if (name !== method) return Reflect.get(model, name);
                      return (args: unknown) => {
                        if (!condition || condition(args))
                          throw new Error("injected persistence failure");
                        return Reflect.get(model, name).call(model, args);
                      };
                    },
                  });
                },
              }),
            ),
          );
      },
    }) as PrismaClient;
  }

  test("every stale claim command rejects without changing Project or events", async () => {
    const { project, job } = await fixture();
    const module = lifecycle();
    const claim = (await module.claim())!;
    expect(claim.id).toBe(job.id);
    await prisma.ingestJob.update({
      where: { id: claim.id },
      data: { claimId: randomUUID() },
    });
    await expect(module.renew(claim)).rejects.toBeInstanceOf(
      IngestJobClaimLost,
    );
    await expect(module.progress(claim, "downloading")).rejects.toBeInstanceOf(
      IngestJobClaimLost,
    );
    await expect(
      module.fail(claim, "worker_unhandled_error", "stale"),
    ).rejects.toBeInstanceOf(IngestJobClaimLost);
    await expect(
      module.complete(claim, { sourceStorageKey: "new.mp4" }),
    ).rejects.toBeInstanceOf(IngestJobClaimLost);
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } }))
        .ingestStatus,
    ).toBe("queued");
    expect(
      await prisma.workflowEvent.count({ where: { projectId: project.id } }),
    ).toBe(0);
  });
  test("expired unreaped claims cannot report progress or settle", async () => {
    await fixture();
    const module = lifecycle();
    const claim = (await module.claim())!;
    clock += 10 * 60_000;
    await expect(module.renew(claim)).rejects.toBeInstanceOf(
      IngestJobClaimLost,
    );
    await expect(module.progress(claim, "normalizing")).rejects.toBeInstanceOf(
      IngestJobClaimLost,
    );
    await expect(
      module.fail(claim, "remote_url_unsafe", "expired"),
    ).rejects.toBeInstanceOf(IngestJobClaimLost);
    await expect(
      module.complete(claim, { sourceStorageKey: "new.mp4" }),
    ).rejects.toBeInstanceOf(IngestJobClaimLost);
  });
  test("transient failure requeues with backoff; permanent failure stores notification intent", async () => {
    const { project, job } = await fixture();
    const module = lifecycle();
    const first = (await module.claim())!;
    expect(await module.fail(first, "remote_fetch_timeout", "timeout")).toEqual(
      { outcome: "requeue" },
    );
    expect(await module.claim()).toBeNull();
    clock += 30_001;
    const second = (await module.claim())!;
    expect(second.id).toBe(job.id);
    expect(second.attemptCount).toBe(2);
    expect(await module.fail(second, "remote_url_unsafe", "unsafe")).toEqual({
      outcome: "permanent",
      terminalErrorCode: "remote_url_unsafe",
    });
    const event = await prisma.workflowEvent.findFirstOrThrow({
      where: { projectId: project.id, status: "failed" },
    });
    expect(event.notificationRequired).toBe(true);
    expect(event.workflowRunId).toBeNull();
    expect(event.ingestJobId).toBe(job.id);
    expect(event.payload).toMatchObject({
      ingestJobId: job.id,
      notification: { kind: "ingest.failed", ingestJobId: job.id },
    });
    const notifications: unknown[] = [];
    const dispatcher = new WorkflowRunLifecycle({
      prisma,
      handoffNotification: async (payload) => {
        notifications.push(payload);
      },
    });
    await prisma.workflowEvent.update({
      where: { id: event.id },
      data: { nextDeliveryAt: new Date(Date.now() - 1) },
    });
    await dispatcher.dispatchEvents();
    await dispatcher.dispatchEvents();
    expect(notifications).toEqual([
      { kind: "ingest.failed", projectId: project.id, ingestJobId: job.id },
    ]);
    expect(
      (
        await prisma.workflowEvent.findUniqueOrThrow({
          where: { id: event.id },
        })
      ).notificationDeliveredAt,
    ).not.toBeNull();
  });
  test("outbox insertion failure rolls back source acceptance and progress", async () => {
    const { project, job } = await fixture();
    const normal = lifecycle();
    const claim = (await normal.claim())!;
    const broken = lifecycle({
      prisma: transactionFault("create", "workflowEvent"),
    });
    await expect(broken.progress(claim, "normalizing")).rejects.toThrow(
      "injected",
    );
    await expect(
      broken.complete(claim, { sourceStorageKey: "new.mp4" }),
    ).rejects.toThrow("injected");
    await expect(
      broken.fail(claim, "remote_url_unsafe", "unsafe"),
    ).rejects.toThrow("injected");
    clock += 10 * 60_000;
    await expect(broken.reapExpired()).rejects.toThrow("injected");
    expect(
      (await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } }))
        .status,
    ).toBe("running");
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } }))
        .sourceStorageKey,
    ).toBeNull();
  });
  test("source acceptance keeps the storage URI and pending handoff durable", async () => {
    const { project, job } = await fixture();
    const module = lifecycle();
    const claim = (await module.claim())!;
    const sourceProbe = {
      durationSec: 12.5,
      video: { width: 1920, height: 1080, frameRate: { numerator: 30000, denominator: 1001 }, startTimecode: null },
      audio: { sampleRate: 48000, channels: 2 },
    };
    await module.complete(claim, {
      sourceStorageKey: "projects/source.mp4",
      sourceSizeBytes: 42,
      sourceProbe,
    });
    const accepted = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
    });
    expect(accepted.sourceMediaUrl).toBe(
      "r2://ingest-test/projects/source.mp4",
    );
    expect(accepted.sourceSizeBytes).toBe(42n);
    expect(accepted.sourceProbe).toEqual(sourceProbe);
    expect(accepted.ingestStatus).toBe("ready");
    expect(
      (await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } }))
        .generationHandoffAt,
    ).toBeNull();
    expect(
      (
        await prisma.workflowEvent.findFirstOrThrow({
          where: { ingestJobId: job.id },
        })
      ).stage,
    ).toBe("ingest_ready");
  });
  test("manual retry rolls back queued Project if job insertion fails", async () => {
    const { project, workspace, user } = await fixture("failed");
    const module = lifecycle({
      prisma: transactionFault("create", "ingestJob"),
    });
    await expect(
      module.retry({
        projectId: project.id,
        workspaceId: workspace.id,
        actorUserId: user.id,
      }),
    ).rejects.toThrow("injected");
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } }))
        .ingestStatus,
    ).toBe("failed");
    expect(
      await prisma.ingestJob.count({ where: { projectId: project.id } }),
    ).toBe(1);
    expect(
      await prisma.workflowEvent.count({ where: { projectId: project.id } }),
    ).toBe(0);
  });
  test("concurrent manual retries create one fresh job, with a separate manual budget", async () => {
    const { project, job, workspace, user } = await fixture("failed");
    await prisma.ingestJob.update({
      where: { id: job.id },
      data: { attemptCount: 3 },
    });
    const module = lifecycle();
    const input = {
      projectId: project.id,
      workspaceId: workspace.id,
      actorUserId: user.id,
    };
    const results = await Promise.allSettled([
      module.retry(input),
      module.retry(input),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (
        results.find(
          (result) => result.status === "rejected",
        ) as PromiseRejectedResult
      ).reason,
    ).toBeInstanceOf(IngestNotFailedError);
    expect(
      await prisma.ingestJob.count({ where: { projectId: project.id } }),
    ).toBe(2);
    for (let used = 2; used < 5; used++) {
      await prisma.project.update({
        where: { id: project.id },
        data: { ingestStatus: "failed" },
      });
      expect((await module.retry(input)).attemptsUsed).toBe(used + 1);
    }
    await prisma.project.update({
      where: { id: project.id },
      data: { ingestStatus: "failed" },
    });
    await expect(module.retry(input)).rejects.toBeInstanceOf(
      IngestRetryLimitExceededError,
    );
  });
  test("reaper preserves renewed leases, retries expired claims, then fails with durable intent at cap", async () => {
    const { project, job } = await fixture();
    const module = lifecycle();
    const first = (await module.claim())!;
    clock += 9 * 60_000;
    await module.renew(first);
    clock += 2 * 60_000;
    expect(await module.reapExpired()).toBe(0);
    clock += 9 * 60_000;
    expect(await module.reapExpired()).toBe(1);
    await expect(
      module.fail(first, "worker_unhandled_error", "late"),
    ).rejects.toBeInstanceOf(IngestJobClaimLost);
    clock += 30_001;
    const second = (await module.claim())!;
    clock += 10 * 60_000;
    expect(await module.reapExpired()).toBe(1);
    clock += 60_001;
    const third = (await module.claim())!;
    expect(second.attemptCount).toBe(2);
    expect(third.attemptCount).toBe(3);
    clock += 10 * 60_000;
    expect(await module.reapExpired()).toBe(1);
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } }))
        .ingestErrorCode,
    ).toBe("ingest_retries_exhausted");
    expect(
      await prisma.workflowEvent.count({
        where: { ingestJobId: job.id, notificationRequired: true },
      }),
    ).toBe(1);
  });
  test("repeated graceful deploy releases do not consume automatic retries", async () => {
    const { job } = await fixture();
    const module = lifecycle();
    for (let deploy = 0; deploy < 6; deploy++) {
      const claim = (await module.claim())!;
      expect(claim.attemptCount).toBe(1);
      await module.progress(claim, "downloading");
      await module.release(claim);
    }
    const row = await prisma.ingestJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(row.status).toBe("queued");
    expect(row.attemptCount).toBe(0);
  });
  test("an admitted ingest handoff survives creator removal without impersonating the Workspace owner", async () => {
    const { project, job, workspace } = await fixture("ready");
    const creator = await prisma.user.create({ data: { clerkId: `ingest-creator:${randomUUID()}` } });
    users.push(creator.id);
    await prisma.project.update({ where: { id: project.id }, data: { createdByUserId: creator.id } });
    await committedPack(project.id);
    await prisma.user.delete({ where: { id: creator.id } });
    await reservation(project.id, workspace.id);
    const module = lifecycle();
    expect(await module.processGenerationHandoffs(1, job.id)).toBe(1);
    expect(
      (await prisma.processingUsageReservation.findUniqueOrThrow({ where: { projectId: project.id } })).state,
    ).toBe("settled");
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).createdByUserId).toBeNull();
    expect(await prisma.workflowRun.count({ where: { projectId: project.id, stage: "stt" } })).toBe(1);
  });
  test("settlement refusal atomically fails Project/job, releases usage, and leaves actionable notification", async () => {
    const { project, job, workspace } = await fixture("ready");
    await committedPack(project.id);
    await reservation(project.id, workspace.id);
    // The probed source exceeds the Free per-video cap.
    await prisma.project.update({ where: { id: project.id }, data: { sourceDurationSeconds: 61 * 60 } });
    const module = lifecycle();
    expect(await module.processGenerationHandoffs(1, job.id)).toBe(0);
    expect(
      (await prisma.processingUsageReservation.findUniqueOrThrow({ where: { projectId: project.id } })).state,
    ).toBe("released");
    expect(await prisma.workflowRun.count({ where: { projectId: project.id } })).toBe(0);
    const row = await prisma.ingestJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(row.status).toBe("failed");
    expect(row.generationHandoffAt).not.toBeNull();
    expect(row.generationHandoffRetryAt).toBeNull();
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } }))
        .ingestErrorCode,
    ).toBe("upload_too_long");
    expect(
      await prisma.workflowEvent.count({
        where: { ingestJobId: job.id, notificationRequired: true },
      }),
    ).toBe(1);
    expect(await module.processGenerationHandoffs(1, job.id)).toBe(0);
  });
  describe("whole-source windows at the generation handoff", () => {
    const captionedVideo = { framing: "fit", aspectRatios: ["9:16"], resolution: "1080p", captions: { source: "none" } };
    async function captionOnlyHandoff(sourceDurationSeconds: number, options: { probe?: number; window?: [number, number]; plain?: boolean } = {}) {
      const { project, job, workspace } = await fixture("ready");
      await prisma.contentPack.create({
        data: {
          projectId: project.id, outputTypes: ["short_clip"], clipCountTarget: 10, clipDurationSecTarget: 45, toneConstraints: [],
          captionPreset: "brand_default", platformPlaybookVersion: "2026-07-01", mode: "caption_only",
          processingStartSec: options.window?.[0] ?? null, processingEndSec: options.window?.[1] ?? null,
          ...(options.plain ? {} : { captionedVideo }),
        },
      });
      await reservation(project.id, workspace.id, "reserved", sourceDurationSeconds);
      await prisma.project.update({
        where: { id: project.id },
        data: {
          sourceDurationSeconds,
          ...(options.probe === undefined ? {} : { sourceProbe: { durationSec: options.probe, video: null, audio: null } }),
        },
      });
      const module = lifecycle();
      return { project, job, handed: await module.processGenerationHandoffs(1, job.id) };
    }
    const reservationState = async (projectId: string) =>
      (await prisma.processingUsageReservation.findUniqueOrThrow({ where: { projectId } })).state;

    test("a captioned video over 3 minutes is refused before it costs minutes or speech-to-text", async () => {
      const { project, job, handed } = await captionOnlyHandoff(181);
      expect(handed).toBe(0);
      expect(await reservationState(project.id)).toBe("released");
      expect(await prisma.workflowRun.count({ where: { projectId: project.id } })).toBe(0);
      expect(await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "failed", lastError: expect.stringContaining("whole_source_too_long") });
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).ingestErrorCode).toBe("whole_source_too_long");
      expect(await prisma.workflowEvent.count({ where: { ingestJobId: job.id, notificationRequired: true } })).toBe(1);
    });

    test("a source under a second is refused, while 8 seconds and exactly 3 minutes are admitted", async () => {
      const short = await captionOnlyHandoff(1, { probe: 0.6 });
      expect(short.handed).toBe(0);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: short.project.id } })).ingestErrorCode).toBe("whole_source_too_short");
      for (const seconds of [8, 180]) {
        const admitted = await captionOnlyHandoff(seconds);
        expect(admitted.handed).toBe(1);
        expect(await reservationState(admitted.project.id)).toBe("settled");
        expect(await prisma.workflowRun.count({ where: { projectId: admitted.project.id, stage: "stt" } })).toBe(1);
      }
    });

    test("the exact probed duration decides: 180.4 seconds is a 3 minute source, 180.6 is not", async () => {
      // Project.sourceDurationSeconds is rounded (180 and 181); the probe is exact.
      const admitted = await captionOnlyHandoff(180, { probe: 180.4 });
      expect(admitted.handed).toBe(1);
      expect(await prisma.workflowRun.count({ where: { projectId: admitted.project.id, stage: "stt" } })).toBe(1);
      const over = await captionOnlyHandoff(181, { probe: 180.6 });
      expect(over.handed).toBe(0);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: over.project.id } })).ingestErrorCode).toBe("whole_source_too_long");
      // An 8.4 second source is admitted whole.
      expect((await captionOnlyHandoff(8, { probe: 8.4 })).handed).toBe(1);
    });

    test("a processing window decides, not the length of a long source", async () => {
      expect((await captionOnlyHandoff(1_800, { window: [60, 150] })).handed).toBe(1);
      const tooWide = await captionOnlyHandoff(1_800, { window: [0, 600] });
      expect(tooWide.handed).toBe(0);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: tooWide.project.id } })).ingestErrorCode).toBe("whole_source_too_long");
    });

    test("a plain caption-only run keeps its Project ready and fails in detection, not at the handoff", async () => {
      const admitted = await captionOnlyHandoff(600, { plain: true });
      expect(admitted.handed).toBe(1);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: admitted.project.id } })).ingestStatus).toBe("ready");
    });

    test("a clip-mode source of any length is not subject to the whole-source bounds", async () => {
      const { project, job, workspace } = await fixture("ready");
      await committedPack(project.id);
      await reservation(project.id, workspace.id, "reserved", 600);
      await prisma.project.update({ where: { id: project.id }, data: { sourceDurationSeconds: 600 } });
      expect(await lifecycle().processGenerationHandoffs(1, job.id)).toBe(1);
    });
  });
  test("handoff retry is durable, fair to due retries and exactly-once at admission", async () => {
    const { project, job, workspace } = await fixture("ready");
    const pack = await committedPack(project.id);
    await reservation(project.id, workspace.id);
    let calls = 0;
    const module = lifecycle({
      usage: usage({
        beforeSettle: async () => {
          if (++calls === 1) throw new Error("temporary admission outage");
        },
      }),
    });
    await module.processGenerationHandoffs(1, job.id);
    expect(
      (await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } }))
        .generationHandoffRetryAt,
    ).not.toBeNull();
    clock += 60_001;
    const newProject = await prisma.project.create({
      data: {
        title: "New draft",
        workspaceId: project.workspaceId,
        sourceMediaUrl: "r2://pending",
        ingestStatus: "ready",
      },
    });
    await prisma.ingestJob.create({
      data: {
        projectId: newProject.id,
        jobType: "link_import",
        payload: {},
        status: "completed",
        completedAt: new Date(clock),
      },
    });
    expect(await module.processGenerationHandoffs(1)).toBe(1);
    const handedOff = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(handedOff.generationHandoffAt).not.toBeNull();
    const admitted = await prisma.workflowRun.findMany({
      where: {
        projectId: project.id,
        idempotencyKey: autoTriggerIdempotencyKey(project.id, pack.id),
      },
      select: { id: true },
    });
    expect(admitted).toHaveLength(1);
    // The admitted run is stored as this intake's lineage with the acknowledgement.
    expect(handedOff.generationRunId).toBe(admitted[0]!.id);
    expect(
      (
        await prisma.transcript.findUniqueOrThrow({
          where: { projectId: project.id },
        })
      ).status,
    ).toBe("queued");
    expect(await module.processGenerationHandoffs(1, job.id)).toBe(0);
  });
  test("a manually admitted same-pack run acknowledges handoff after its stage advances", async () => {
    const { project, job, workspace } = await fixture("ready");
    const pack = await committedPack(project.id);
    await reservation(project.id, workspace.id, "settled");
    const workflow = new WorkflowRunLifecycle({ prisma });
    const manual = await workflow.admitTranscript({
      projectId: project.id,
      idempotencyKey: `manual:${randomUUID()}`,
      contentPackId: pack.id,
      transcriptProvider: "assemblyai",
      transcriptProviderModel: "test",
    });
    await prisma.workflowRun.update({
      where: { id: manual.id },
      data: { status: "completed" },
    });
    const module = lifecycle({
      usage: usage({
        beforeSettle: async () => {
          throw new Error("existing admission should skip settlement");
        },
      }),
    });
    expect(await module.processGenerationHandoffs(1, job.id)).toBe(1);
    expect(
      await prisma.workflowRun.count({
        where: { projectId: project.id, stage: "stt" },
      }),
    ).toBe(1);
    const acknowledged = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(acknowledged.generationHandoffAt).not.toBeNull();
    expect(acknowledged.generationRunId).toBe(manual.id);
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } }))
        .ingestStatus,
    ).toBe("ready");
  });
  test("a same-pack admission during settlement wins over a stale permanent error", async () => {
    const { project, job, workspace } = await fixture("ready");
    const pack = await committedPack(project.id);
    await reservation(project.id, workspace.id, "settled");
    const workflow = new WorkflowRunLifecycle({ prisma });
    const module = lifecycle({
      usage: usage({
        beforeSettle: async () => {
          await workflow.admitTranscript({
            projectId: project.id,
            idempotencyKey: `manual:${randomUUID()}`,
            contentPackId: pack.id,
            transcriptProvider: "assemblyai",
            transcriptProviderModel: "test",
          });
          throw new ExpectedDomainFailureError({
            code: "project_access_denied",
            kind: "forbidden",
            message: "access changed after admission",
          });
        },
      }),
    });
    expect(await module.processGenerationHandoffs(1, job.id)).toBe(1);
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } }))
        .ingestStatus,
    ).toBe("ready");
    expect(
      (await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } }))
        .status,
    ).toBe("completed");
    expect(
      await prisma.workflowEvent.count({
        where: { projectId: project.id, notificationRequired: true },
      }),
    ).toBe(0);
  });
  test("a manual stage completing during admission rolls back the extra automatic run", async () => {
    const { project, job, workspace } = await fixture("ready");
    const pack = await committedPack(project.id);
    await reservation(project.id, workspace.id, "settled");
    const workflow = new WorkflowRunLifecycle({ prisma });
    const module = lifecycle({
      usage: usage({
        beforeSettle: async () => {
          const run = await workflow.admitTranscript({
            projectId: project.id,
            idempotencyKey: `manual:${randomUUID()}`,
            contentPackId: pack.id,
            transcriptProvider: "assemblyai",
            transcriptProviderModel: "test",
          });
          await prisma.workflowRun.update({
            where: { id: run.id },
            data: { status: "completed" },
          });
        },
      }),
    });
    expect(await module.processGenerationHandoffs(1, job.id)).toBe(1);
    expect(
      await prisma.workflowRun.count({
        where: { projectId: project.id, stage: "stt" },
      }),
    ).toBe(1);
    expect(
      await prisma.workflowEvent.count({ where: { projectId: project.id } }),
    ).toBe(1);
    expect(
      (await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } }))
        .generationHandoffAt,
    ).not.toBeNull();
  });
  test("lost handoff guard rolls back its newly admitted run, outbox, and settlement", async () => {
    const { project, job, workspace } = await fixture("ready");
    await committedPack(project.id);
    await reservation(project.id, workspace.id);
    const module = lifecycle({
      usage: usage({
        beforeSettle: async () => {
          await prisma.ingestJob.update({
            where: { id: job.id },
            data: { generationHandoffAt: new Date(clock) },
          });
        },
      }),
    });
    expect(await module.processGenerationHandoffs(1, job.id)).toBe(0);
    expect(
      (await prisma.processingUsageReservation.findUniqueOrThrow({ where: { projectId: project.id } })).state,
    ).toBe("reserved");
    expect(
      await prisma.workflowRun.count({ where: { projectId: project.id } }),
    ).toBe(0);
    expect(
      await prisma.workflowEvent.count({ where: { projectId: project.id } }),
    ).toBe(0);
    expect(
      await prisma.transcript.count({ where: { projectId: project.id } }),
    ).toBe(0);
  });
  describe("Drive Picker intake credential", () => {
    const SEALED = "v1:sealed-test-credential";
    async function driveFixture() {
      const made = await fixture("queued", { fileId: "drive-file-id-0001", fileName: "a.mp4" });
      await prisma.ingestJob.update({
        where: { id: made.job.id },
        data: { jobType: "drive_import", sourceCredential: SEALED },
      });
      return made;
    }
    const credential = async (id: string) =>
      (await prisma.ingestJob.findUniqueOrThrow({ where: { id } })).sourceCredential;

    test("a claim carries the sealed credential, and a requeued job keeps it while it can still download", async () => {
      const { job } = await driveFixture();
      const module = lifecycle();
      const first = (await module.claim({ youtubeAvailable: false }))!;
      expect(first).toMatchObject({ id: job.id, jobType: "drive_import", sourceCredential: SEALED });
      expect(await module.fail(first, "source_download_failed", "socket closed")).toEqual({ outcome: "requeue" });
      expect(await credential(job.id)).toBe(SEALED);
    });

    test("completing the download discards the credential", async () => {
      const { job } = await driveFixture();
      const module = lifecycle();
      const claim = (await module.claim())!;
      await module.complete(claim, { sourceStorageKey: "projects/p/link/a.mp4" });
      expect(await credential(job.id)).toBeNull();
    });

    test("a permanent failure, the reaper's last attempt, and a cancellation all discard it", async () => {
      const expired = await driveFixture();
      const module = lifecycle();
      const claim = (await module.claim())!;
      expect(await module.fail(claim, "drive_token_expired", "expired")).toEqual({
        outcome: "permanent",
        terminalErrorCode: "drive_token_expired",
      });
      expect(await credential(expired.job.id)).toBeNull();
      expect(
        await prisma.project.findUniqueOrThrow({ where: { id: expired.project.id } }),
      ).toMatchObject({ ingestStatus: "failed", ingestErrorCode: "drive_token_expired" });

      const stalled = await driveFixture();
      await prisma.ingestJob.update({
        where: { id: stalled.job.id },
        data: { attemptCount: 2, updatedAt: new Date(clock - 60 * 60_000) },
      });
      const last = (await module.claim())!;
      expect(last.id).toBe(stalled.job.id);
      expect(await credential(stalled.job.id)).toBe(SEALED);
      clock += 11 * 60_000;
      expect(await module.reapExpired()).toBe(1);
      expect(await credential(stalled.job.id)).toBeNull();

      const cancelled = await driveFixture();
      expect(
        await module.cancelQueuedOperation({
          actorUserId: cancelled.user.id,
          workspaceId: cancelled.workspace.id,
          projectId: cancelled.project.id,
          ingestJobId: cancelled.job.id,
        }),
      ).toBe(true);
      expect(await credential(cancelled.job.id)).toBeNull();
    });

    test("a failed Drive import is never retried with a new job, because the token is gone", async () => {
      const { project, job, user, workspace } = await driveFixture();
      const module = lifecycle();
      await reservation(project.id, workspace.id);
      await module.fail((await module.claim())!, "drive_file_unavailable", "gone");
      await expect(
        module.retry({ projectId: project.id, workspaceId: workspace.id, actorUserId: user.id }),
      ).rejects.toBeInstanceOf(IngestReselectRequiredError);
      expect(await prisma.ingestJob.count({ where: { projectId: project.id } })).toBe(1);
      expect(await credential(job.id)).toBeNull();
    });
  });
  test("unavailable YouTube skips its current link payload while other intake claims", async () => {
    const { project, job } = await fixture("queued", {
      provider: "youtube",
      url: "https://youtube.test/a",
    });
    const direct = await prisma.ingestJob.create({
      data: {
        projectId: project.id,
        jobType: "link_import",
        payload: { provider: "dropbox", url: "https://dropbox.test/b" },
      },
    });
    expect((await lifecycle().claim({ youtubeAvailable: false }))?.id).toBe(
      direct.id,
    );
    const youtube = await prisma.ingestJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(youtube.status).toBe("queued");
    expect(youtube.attemptCount).toBe(0);
  });
});
