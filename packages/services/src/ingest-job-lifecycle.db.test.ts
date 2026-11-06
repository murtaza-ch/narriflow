import { bindServiceTestEnvironment } from "./runtime-test-support";
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
import { startIngestTestExecution } from "./ingest-execution-test-support";
import { createSourceVideoValidator } from "./source-readiness";
import { ingestExecutionInputHash, prepareIngestSourceExecution } from "./ingest-source-execution";
import { appendExecutionDispatch } from "./execution-dispatch";

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
  beforeAll(bindServiceTestEnvironment(() => {
    if (!schema?.startsWith("workflow_lifecycle_test_"))
      throw new Error("Ingest tests require a disposable schema");
    pool = new Pool({ connectionString: url, max: 4 });
    prisma = new PrismaClient({
      adapter: new PrismaPg(pool, { schema }),
      transactionOptions: { timeout: 30_000 },
    });
  }));
  afterEach(bindServiceTestEnvironment(async () => {
    const userIds = users.splice(0);
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }));
  afterAll(bindServiceTestEnvironment(async () => {
    await prisma.$disconnect();
    await pool.end();
  }));
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
      now: () => new Date(Math.max(clock, Date.now())),
      requireRetryActor: async () => {},
      executionInputHash: job => ingestExecutionInputHash(job, "f".repeat(64)),
      usage: usage(),
      sourceBucket: "ingest-test",
      validateVideo: createSourceVideoValidator(usage()),
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
    source: { jobType?: "link_import" | "drive_import"; sourceCredential?: string } = {},
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
        sourceProbe: status === "ready" ? { durationSec: 60, video: null, audio: null } : undefined,
      },
    });
    const job = await prisma.ingestJob.create({
      data: {
        projectId: project.id,
        jobType: source.jobType ?? "link_import",
        sourceCredential: source.sourceCredential,
        payload: { acquisition: { audioPolicy: "none" }, provider: "dropbox", url: "https://www.dropbox.com/s/ingest-source/video.mp4", ...payload },
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
    lost = false,
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
                        if (!condition || condition(args)) {
                          if (lost) return Promise.resolve({ count: 0 });
                          throw new Error("injected persistence failure");
                        }
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

  async function targetedHandoff(module: IngestJobLifecycle, jobId: string) {
    const job = await prisma.ingestJob.findUniqueOrThrow({ where: { id: jobId } });
    const inputHash = await ingestExecutionInputHash(job, "f".repeat(64));
    const record = await prisma.$transaction(tx => appendExecutionDispatch(tx, {
      deploymentEpoch: job.deploymentEpoch, generation: job.generation,
      kind: "import_pipeline", subject: { kind: "ingest_job", id: job.id }, inputHash, dueAt: job.createdAt,
    }));
    return module.handoffGeneration(record.reference);
  }

  function afterRollback(error: Error, action: () => Promise<void>): PrismaClient {
    let pending = true;
    return new Proxy(prisma, {
      get(target, property) {
        if (property !== "$transaction") return Reflect.get(target, property);
        return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { maxWait?: number; timeout?: number }) => {
          try { return await target.$transaction(work, options); }
          catch (failure) {
            if (pending && failure === error) { pending = false; await action(); }
            throw failure;
          }
        };
      },
    }) as PrismaClient;
  }

  const start = async (module: IngestJobLifecycle, jobId: string, database = prisma) => {
    const job = await prisma.ingestJob.findUniqueOrThrow({ where: { id: jobId } });
    // Advance only this disposable fixture's retry eligibility, preserving its
    // original operation deadline, generation and charged attempt count.
    if (job.attemptCount) await prisma.ingestJob.update({ where: { id: jobId }, data: { updatedAt: new Date(Date.now() - 10 * 60_000) } });
    return startIngestTestExecution(database, module, new WorkflowRunLifecycle({ prisma: database }), jobId);
  };

  test("an executor's stale generation cannot progress, fail or publish its assigned source", bindServiceTestEnvironment(async () => {
    const { project, job } = await fixture();
    const execution = await start(lifecycle(), job.id);
    await prisma.ingestJob.update({ where: { id: job.id }, data: { claimId: randomUUID() } });
    const before = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    for (const command of [() => execution.command("renew", { leaseSeconds: 120 }),
      () => execution.command("progress", { phase: "downloading", progress: 40 }),
      () => execution.command("fail", { failureCode: "remote_url_unsafe", retryable: false }),
      () => execution.complete()]) expect(await command()).toMatchObject({ disposition: "superseded" });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toEqual(before);
    expect(await prisma.executionArtifact.findUniqueOrThrow({ where: { id: execution.assignment.id } })).toMatchObject({ committedAt: null });
    expect(await prisma.workflowEvent.count({ where: { projectId: project.id } })).toBe(0);
  }));

  test("transient failure rotates the exact source generation and permanent failure records one notification", bindServiceTestEnvironment(async () => {
    const { project, job } = await fixture();
    const module = lifecycle();
    const first = await start(module, job.id);
    expect(await first.command("fail", { failureCode: "remote_download_failed", retryable: true })).toMatchObject({ disposition: "failed" });
    const retry = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(retry).toMatchObject({ status: "queued", generation: 2, attemptCount: 1 });
    expect(await prisma.executionDispatch.findFirstOrThrow({ where: { subjectId: job.id, kind: "import_pipeline", generation: 1, wakeKind: "ingest_outcome" } }))
      .toMatchObject({ inputHash: first.fence.reference.inputHash });
    expect(await prisma.executionDispatch.findFirstOrThrow({ where: { subjectId: job.id, kind: "operation_driver", generation: 1, wakeKind: "execution_finished" } }))
      .toMatchObject({ inputHash: first.fence.reference.inputHash });
    const due = await prisma.executionDispatch.findFirstOrThrow({ where: { subjectId: job.id, generation: 2, kind: "operation_driver", wakeKind: null } });
    expect(due.dueAt.getTime()).toBeGreaterThan(clock);
    const second = await start(module, job.id);
    expect(second.fence.attemptToken).not.toBe(first.fence.attemptToken);
    await second.command("fail", { failureCode: "remote_url_unsafe", retryable: false });
    expect(await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "failed", attemptCount: 2 });
    const event = await prisma.workflowEvent.findFirstOrThrow({ where: { projectId: project.id, status: "failed" } });
    expect(event).toMatchObject({ notificationRequired: true, ingestJobId: job.id, workflowRunId: null });
    const ledger = await prisma.notificationLedger.findFirstOrThrow({ where: { projectId: project.id, sourceId: job.id, outcome: "import_failed" } });
    expect(ledger.status).toBe("pending");
    expect(await prisma.notificationLedger.count({ where: { projectId: project.id, sourceId: job.id } })).toBe(1);
    expect(await prisma.executionDispatch.count({ where: { kind: "operation_driver", subjectKind: "notification", subjectId: `em1.p.${ledger.id}`, deadlineKind: null } })).toBe(1);
  }));

  test("a run rejected before start spends attempts, waits out its backoff, and stops at the retry limit", bindServiceTestEnvironment(async () => {
    const { project, job } = await fixture();
    const module = lifecycle();
    const claim = async () => {
      const current = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
      if (current.attemptCount) await prisma.ingestJob.update({ where: { id: job.id }, data: { updatedAt: new Date(Date.now() - 10 * 60_000) } });
      return startIngestTestExecution(prisma, module, new WorkflowRunLifecycle({ prisma }), job.id, { started: false });
    };
    const first = await claim();
    await first.command("fail", { failureCode: "source_runtime_invalid", retryable: true });
    const retry = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(retry).toMatchObject({ status: "queued", attemptCount: 1, startedAt: null });
    const due = await prisma.executionDispatch.findFirstOrThrow({ where: { subjectId: job.id, generation: retry.generation, kind: "operation_driver", wakeKind: null } });
    expect(due.dueAt.getTime()).toBeGreaterThan(Date.now());
    const reference = await prisma.$transaction(tx => module.queueExecutionWithinTransaction(tx, job.id));
    const prepared = await prepareIngestSourceExecution({ database: prisma, domain: module, reference: reference!, toolchainFingerprint: "f".repeat(64), executionKind: "modal_execution" });
    expect(prepared.kind).toBe("sleep");
    await (await claim()).command("fail", { failureCode: "source_runtime_invalid", retryable: true });
    expect(await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "queued", attemptCount: 2 });
    await (await claim()).command("fail", { failureCode: "source_runtime_invalid", retryable: true });
    expect(await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "failed", attemptCount: 3, lastError: expect.stringContaining("source_runtime_invalid") });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ ingestStatus: "failed", ingestErrorCode: "ingest_retries_exhausted" });
  }));

  test("outbox insertion failure rolls back actual Core progress, source acceptance, failure and expiry", bindServiceTestEnvironment(async () => {
    const { project, job } = await fixture();
    const database = transactionFault("create", "workflowEvent");
    const execution = await start(lifecycle({ prisma: database }), job.id, database);
    await expect(execution.command("progress", { phase: "preparing", progress: 75 })).rejects.toThrow("injected");
    await expect(execution.complete()).rejects.toThrow("injected");
    await expect(execution.command("fail", { failureCode: "remote_url_unsafe", retryable: false })).rejects.toThrow("injected");
    await expect(execution.expire()).rejects.toThrow("injected");
    expect(await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "running" });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ sourceStorageKey: null });
    expect(await prisma.executionArtifact.findUniqueOrThrow({ where: { id: execution.assignment.id } })).toMatchObject({ committedAt: null });
  }));

  test("actual assigned source acceptance keeps probe, storage URI and pending handoff durable", bindServiceTestEnvironment(async () => {
    const { project, job } = await fixture();
    const execution = await start(lifecycle(), job.id);
    expect(await execution.complete()).toMatchObject({ disposition: "committed" });
    const accepted = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(accepted).toMatchObject({ sourceMediaUrl: `r2://ingest-test/${execution.assignment.storageKey}`, sourceSizeBytes: 42n,
      ingestStatus: "ready", sourceProbe: { durationSec: 12.5, facts: { format: { name: "fixture" } } } });
    expect(await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ generationHandoffAt: null, status: "completed" });
    expect(await prisma.workflowEvent.findFirstOrThrow({ where: { ingestJobId: job.id } })).toMatchObject({ stage: "ingest_ready" });
  }));

  test("manual retry rolls back queued Project if job insertion fails", bindServiceTestEnvironment(async () => {
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
  }));
  test("concurrent manual retries create one fresh job, with a separate manual budget", bindServiceTestEnvironment(async () => {
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
  }));
  test("targeted expiry respects a renewed deadline, retries each charged start, and ends at the original cap", bindServiceTestEnvironment(async () => {
    const { project, job } = await fixture();
    const module = lifecycle();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const execution = await start(module, job.id);
      expect(await execution.command("renew", { leaseSeconds: 120 })).toMatchObject({ disposition: "renewed" });
      const result = await execution.control.expireDeadline({ deadline: { reference: execution.fence.reference, attemptToken: execution.fence.attemptToken,
        kind: "lease", observedDeadlineAt: new Date(clock - 1_000).toISOString() }, deliveryId: randomUUID() });
      expect(result.kind).toBe("sleep");
      expect(await execution.expire()).toEqual({ kind: "expired" });
      expect(await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ attemptCount: attempt, status: attempt === 3 ? "failed" : "queued" });
    }
    expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ ingestStatus: "failed", ingestErrorCode: "ingest_retries_exhausted" });
    expect(await prisma.workflowEvent.count({ where: { projectId: project.id, notificationRequired: true } })).toBe(1);
  }));
  test("six graceful executor releases preserve automatic retry budget while retaining their execution history", bindServiceTestEnvironment(async () => {
    const { job } = await fixture();
    const module = lifecycle();
    for (let deploy = 0; deploy < 6; deploy++) {
      const execution = await start(module, job.id);
      await execution.command("progress", { phase: "downloading", progress: 40 });
      expect(await execution.command("release", { reason: "shutdown" })).toMatchObject({ disposition: "released" });
    }
    expect(await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "queued", attemptCount: 0, generation: 7 });
    expect(await prisma.executionAttempt.count({ where: { dispatch: { subjectId: job.id }, status: "released", processStartedAt: { not: null } } })).toBe(6);
  }));
  test("an admitted ingest handoff survives creator removal without impersonating the Workspace owner", bindServiceTestEnvironment(async () => {
    const { project, job, workspace } = await fixture("ready");
    const creator = await prisma.user.create({ data: { clerkId: `ingest-creator:${randomUUID()}` } });
    users.push(creator.id);
    await prisma.project.update({ where: { id: project.id }, data: { createdByUserId: creator.id } });
    await committedPack(project.id);
    await prisma.user.delete({ where: { id: creator.id } });
    await reservation(project.id, workspace.id);
    const module = lifecycle();
    expect(await targetedHandoff(module, job.id)).toMatchObject({ kind: "admitted" });
    expect(
      (await prisma.processingUsageReservation.findUniqueOrThrow({ where: { projectId: project.id } })).state,
    ).toBe("settled");
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).createdByUserId).toBeNull();
    expect(await prisma.workflowRun.count({ where: { projectId: project.id, stage: "stt" } })).toBe(1);
  }));
  test("settlement refusal atomically fails Project/job, releases usage, and leaves actionable notification", bindServiceTestEnvironment(async () => {
    const { project, job, workspace } = await fixture("ready");
    await committedPack(project.id);
    await reservation(project.id, workspace.id);
    // The probed source exceeds the Free per-video cap.
    await prisma.project.update({ where: { id: project.id }, data: { sourceDurationSeconds: 61 * 60, sourceProbe: { durationSec: 61 * 60, video: null, audio: null } } });
    const module = lifecycle();
    expect(await targetedHandoff(module, job.id)).toMatchObject({ kind: "refused" });
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
    expect(await targetedHandoff(module, job.id)).toMatchObject({ kind: "not_ready" });
  }));
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
          sourceProbe: { durationSec: options.probe ?? sourceDurationSeconds, video: null, audio: null },
        },
      });
      const module = lifecycle();
      return { project, job, handed: (await targetedHandoff(module, job.id)).kind === "admitted" ? 1 : 0 };
    }
    const reservationState = async (projectId: string) =>
      (await prisma.processingUsageReservation.findUniqueOrThrow({ where: { projectId } })).state;

    test("a captioned video over 3 minutes is refused before it costs minutes or speech-to-text", bindServiceTestEnvironment(async () => {
      const { project, job, handed } = await captionOnlyHandoff(181);
      expect(handed).toBe(0);
      expect(await reservationState(project.id)).toBe("released");
      expect(await prisma.workflowRun.count({ where: { projectId: project.id } })).toBe(0);
      expect(await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "failed", lastError: expect.stringContaining("whole_source_too_long") });
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).ingestErrorCode).toBe("whole_source_too_long");
      expect(await prisma.workflowEvent.count({ where: { ingestJobId: job.id, notificationRequired: true } })).toBe(1);
    }));

    test("a source under a second is refused, while 8 seconds and exactly 3 minutes are admitted", bindServiceTestEnvironment(async () => {
      const short = await captionOnlyHandoff(1, { probe: 0.6 });
      expect(short.handed).toBe(0);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: short.project.id } })).ingestErrorCode).toBe("whole_source_too_short");
      for (const seconds of [8, 180]) {
        const admitted = await captionOnlyHandoff(seconds);
        expect(admitted.handed).toBe(1);
        expect(await reservationState(admitted.project.id)).toBe("settled");
        expect(await prisma.workflowRun.count({ where: { projectId: admitted.project.id, stage: "stt" } })).toBe(1);
      }
    }));

    test("the exact probed duration decides: 180.4 seconds is a 3 minute source, 180.6 is not", bindServiceTestEnvironment(async () => {
      // Project.sourceDurationSeconds is rounded (180 and 181); the probe is exact.
      const admitted = await captionOnlyHandoff(180, { probe: 180.4 });
      expect(admitted.handed).toBe(1);
      expect(await prisma.workflowRun.count({ where: { projectId: admitted.project.id, stage: "stt" } })).toBe(1);
      const over = await captionOnlyHandoff(181, { probe: 180.6 });
      expect(over.handed).toBe(0);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: over.project.id } })).ingestErrorCode).toBe("whole_source_too_long");
      // An 8.4 second source is admitted whole.
      expect((await captionOnlyHandoff(8, { probe: 8.4 })).handed).toBe(1);
    }));

    test("a processing window decides, not the length of a long source", bindServiceTestEnvironment(async () => {
      expect((await captionOnlyHandoff(1_800, { window: [60, 150] })).handed).toBe(1);
      const tooWide = await captionOnlyHandoff(1_800, { window: [0, 600] });
      expect(tooWide.handed).toBe(0);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: tooWide.project.id } })).ingestErrorCode).toBe("whole_source_too_long");
    }));

    test("a plain caption-only run keeps its Project ready and fails in detection, not at the handoff", bindServiceTestEnvironment(async () => {
      const admitted = await captionOnlyHandoff(600, { plain: true });
      expect(admitted.handed).toBe(1);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: admitted.project.id } })).ingestStatus).toBe("ready");
    }));

    test("a clip-mode source of any length is not subject to the whole-source bounds", bindServiceTestEnvironment(async () => {
      const { project, job, workspace } = await fixture("ready");
      await committedPack(project.id);
      await reservation(project.id, workspace.id, "reserved", 600);
      await prisma.project.update({ where: { id: project.id }, data: { sourceDurationSeconds: 600 } });
      expect(await targetedHandoff(lifecycle(), job.id)).toMatchObject({ kind: "admitted" });
    }));
  });
  test("handoff retry is durable and exact replay cannot admit a second generation or touch another intake", bindServiceTestEnvironment(async () => {
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
    expect(await targetedHandoff(module, job.id)).toMatchObject({ kind: "deferred" });
    expect(
      (await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } }))
        .generationHandoffRetryAt,
    ).not.toBeNull();
    clock += 61_000;
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
    expect(await targetedHandoff(module, job.id)).toMatchObject({ kind: "admitted" });
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
    expect(await targetedHandoff(module, job.id)).toMatchObject({ kind: "acknowledged" });
  }));
  test("a manually admitted same-pack run acknowledges handoff after its stage advances", bindServiceTestEnvironment(async () => {
    const { project, job, workspace } = await fixture("ready");
    const pack = await committedPack(project.id);
    await reservation(project.id, workspace.id, "settled");
    const workflow = new WorkflowRunLifecycle({ prisma });
    const manual = await workflow.admitTranscript({
      projectId: project.id,
      idempotencyKey: `manual:${randomUUID()}`,
      contentPackId: pack.id,
      transcriptProvider: "elevenlabs",
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
    expect(await targetedHandoff(module, job.id)).toMatchObject({ kind: "acknowledged" });
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
  }));
  test("a same-pack admission after rollback wins over a stale permanent error", bindServiceTestEnvironment(async () => {
    const { project, job, workspace } = await fixture("ready");
    const pack = await committedPack(project.id);
    await reservation(project.id, workspace.id, "settled");
    const workflow = new WorkflowRunLifecycle({ prisma });
    let manualId = "";
    const failure = new ExpectedDomainFailureError({ code: "project_access_denied", kind: "forbidden", message: "access changed after admission" });
    const module = lifecycle({
      prisma: afterRollback(failure, async () => {
        const manual = await workflow.admitTranscript({ projectId: project.id, idempotencyKey: `manual:${randomUUID()}`, contentPackId: pack.id,
          transcriptProvider: "elevenlabs", transcriptProviderModel: "test" });
        manualId = manual.id;
      }),
      usage: usage({
        beforeSettle: async () => { throw failure; },
      }),
    });
    const recovered = await targetedHandoff(module, job.id);
    expect(recovered).toMatchObject({ kind: "acknowledged", workflowRunId: manualId });
    const wake = await prisma.executionDispatch.findFirstOrThrow({ where: {
      kind: "operation_driver", subjectKind: "workflow_run", subjectId: manualId, wakeKind: null, deadlineKind: null,
    } });
    expect(recovered.dispatchIds).toContain(wake.id);
    expect((await targetedHandoff(module, job.id)).dispatchIds).toContain(wake.id);
    expect(await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ generationRunId: manualId });
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
  }));
  test("a manual stage completing after rollback is acknowledged without an extra automatic run", bindServiceTestEnvironment(async () => {
    const { project, job, workspace } = await fixture("ready");
    const pack = await committedPack(project.id);
    await reservation(project.id, workspace.id, "settled");
    const workflow = new WorkflowRunLifecycle({ prisma });
    let manualId = "";
    const failure = new Error("admission interrupted");
    const module = lifecycle({
      prisma: afterRollback(failure, async () => {
        const run = await workflow.admitTranscript({ projectId: project.id, idempotencyKey: `manual:${randomUUID()}`, contentPackId: pack.id,
          transcriptProvider: "elevenlabs", transcriptProviderModel: "test" });
        manualId = run.id;
        await prisma.workflowRun.update({ where: { id: run.id }, data: { status: "completed" } });
      }),
      usage: usage({
        beforeSettle: async () => { throw failure; },
      }),
    });
    const recovered = await targetedHandoff(module, job.id);
    expect(recovered).toMatchObject({ kind: "acknowledged", workflowRunId: manualId });
    const wake = await prisma.executionDispatch.findFirstOrThrow({ where: {
      kind: "operation_driver", subjectKind: "workflow_run", subjectId: manualId, wakeKind: null, deadlineKind: null,
    } });
    expect(recovered.dispatchIds).toContain(wake.id);
    expect((await targetedHandoff(module, job.id)).dispatchIds).toContain(wake.id);
    expect(await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ generationRunId: manualId });
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
  }));
  test("lost handoff guard rolls back its newly admitted run, outbox, and settlement", bindServiceTestEnvironment(async () => {
    const { project, job, workspace } = await fixture("ready");
    await committedPack(project.id);
    await reservation(project.id, workspace.id);
    const module = lifecycle({ prisma: transactionFault("updateMany", "ingestJob",
      args => Boolean((args as { data?: { generationRunId?: string } }).data?.generationRunId), true) });
    expect(await targetedHandoff(module, job.id)).toMatchObject({ kind: "superseded" });
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
  }));
  describe("Drive Picker intake credential", () => {
    const SEALED = "v1:sealed-test-credential";
    async function driveFixture() {
      return fixture("queued", { fileId: "drive-file-id-0001", fileName: "a.mp4" }, { jobType: "drive_import", sourceCredential: SEALED });
    }
    const credential = async (id: string) =>
      (await prisma.ingestJob.findUniqueOrThrow({ where: { id } })).sourceCredential;

    test("a requeued native download retains the sealed credential", bindServiceTestEnvironment(async () => {
      const { job } = await driveFixture();
      const execution = await start(lifecycle(), job.id);
      await execution.command("fail", { failureCode: "source_download_failed", retryable: true });
      expect(await credential(job.id)).toBe(SEALED);
      expect(await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "queued", attemptCount: 1 });
    }));

    test("completing the download discards the credential", bindServiceTestEnvironment(async () => {
      const { job } = await driveFixture();
      const module = lifecycle();
      const execution = await start(module, job.id);
      await execution.complete();
      expect(await credential(job.id)).toBeNull();
    }));

    test("a permanent failure, targeted final expiry, and cancellation discard it", bindServiceTestEnvironment(async () => {
      const expired = await driveFixture();
      const module = lifecycle();
      const execution = await start(module, expired.job.id);
      await execution.command("fail", { failureCode: "drive_token_expired", retryable: false });
      expect(await credential(expired.job.id)).toBeNull();
      expect(
        await prisma.project.findUniqueOrThrow({ where: { id: expired.project.id } }),
      ).toMatchObject({ ingestStatus: "failed", ingestErrorCode: "drive_token_expired" });

      const stalled = await driveFixture();
      await prisma.ingestJob.update({
        where: { id: stalled.job.id },
        data: { attemptCount: 2, operationDeadlineAt: new Date(Date.now() + 45 * 60_000), updatedAt: new Date(clock - 60 * 60_000) },
      });
      const last = await start(module, stalled.job.id);
      expect(await credential(stalled.job.id)).toBe(SEALED);
      expect(await last.expire()).toEqual({ kind: "expired" });
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
    }));

    test("a failed Drive import is never retried with a new job, because the token is gone", bindServiceTestEnvironment(async () => {
      const { project, job, user, workspace } = await driveFixture();
      const module = lifecycle();
      await reservation(project.id, workspace.id);
      const execution = await start(module, job.id);
      await execution.command("fail", { failureCode: "drive_file_unavailable", retryable: false });
      await expect(
        module.retry({ projectId: project.id, workspaceId: workspace.id, actorUserId: user.id }),
      ).rejects.toBeInstanceOf(IngestReselectRequiredError);
      expect(await prisma.ingestJob.count({ where: { projectId: project.id } })).toBe(1);
      expect(await credential(job.id)).toBeNull();
    }));
  });
});
