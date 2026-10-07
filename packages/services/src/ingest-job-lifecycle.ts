import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type IngestJob } from "@prisma/client";
import {
  ASSEMBLYAI_SPEECH_MODEL_CHAIN,
  sourceLanguageCodeSchema,
  type WorkflowStageUpdatedEvent,
} from "@narriflow/validators";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { accessibleProjectWhere } from "./project-access";
import { autoTriggerIdempotencyKey } from "./generation-sequencing";
import {
  decideAutoRetry,
  claimBackoffWhereClauses,
  INGEST_AUTO_RETRY_MAX_ATTEMPTS,
  INGEST_RETRIES_EXHAUSTED_CODE,
  isAutoRetryableFailureCode,
} from "./processing-retry-policy";
import type { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import {
  PROCESSING_USAGE_TRANSACTION,
  type ProcessingUsage,
} from "./processing-usage";
import { admitMediaCleanupObligations } from "./media-cleanup";

export const MAX_INGEST_RETRY_ATTEMPTS = 5;
function intakeKindFor(jobType: IngestJob["jobType"]) {
  return jobType === "upload_finalize"
    ? ("upload" as const)
    : jobType === "rss_import"
      ? ("rss" as const)
      : ("link" as const);
}
export class IngestJobClaimLost extends Error {
  readonly code = "ingest_job_claim_lost";
  constructor(public readonly jobId: string) {
    super(`Ingest Job ${jobId} is no longer owned by this worker`);
    this.name = "IngestJobClaimLost";
  }
}
export class IngestNotFailedError extends ExpectedDomainFailureError<"ingest_not_failed"> {
  constructor() {
    super({
      code: "ingest_not_failed",
      kind: "conflict",
      message: "This project's ingest isn't in a failed state.",
    });
  }
}
export class IngestRetryLimitExceededError extends ExpectedDomainFailureError<
  "ingest_retry_limit_exceeded",
  { maxAttempts: number }
> {
  constructor(maxAttempts: number) {
    super({
      code: "ingest_retry_limit_exceeded",
      kind: "conflict",
      message: `This upload has failed ${maxAttempts} times. Start a new upload to try again.`,
      details: { maxAttempts },
    });
  }
}
class IngestGenerationAlreadyAdmitted extends Error {}

export interface IngestClaimRef {
  id: string;
  projectId: string;
  claimId: string;
}
export interface ClaimedIngestJob extends IngestClaimRef {
  jobType: IngestJob["jobType"];
  payload: Prisma.JsonValue;
  attemptCount: number;
}
export interface IngestExecutionContext {
  signal: AbortSignal;
}
export type IngestFailureDecision =
  | { outcome: "requeue" }
  | { outcome: "permanent"; terminalErrorCode: string };
type Tx = Prisma.TransactionClient;
export interface IngestJobLifecycleDependencies {
  prisma: PrismaClient;
  workflow: Pick<WorkflowRunLifecycle, "admitWithHandoff">;
  usage: Pick<ProcessingUsage, "reserve" | "settle" | "release">;
  requireRetryActor(actorUserId: string, workspaceId: string): Promise<unknown>;
  redisRequired?: boolean;
  sourceBucket?: string;
  now?: () => Date;
  leaseMs?: number;
  heartbeatMs?: number;
  scheduler?: {
    schedule(callback: () => void, intervalMs: number): unknown;
    cancel(handle: unknown): void;
  };
}

/** Owns source intake claims and all dependent durable state. Producers enqueue
 * in their admission transaction; workers carry the returned claim throughout. */
export class IngestJobLifecycle {
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly scheduler: NonNullable<
    IngestJobLifecycleDependencies["scheduler"]
  >;
  constructor(private readonly deps: IngestJobLifecycleDependencies) {
    this.leaseMs = deps.leaseMs ?? 10 * 60_000;
    this.heartbeatMs = deps.heartbeatMs ?? 2 * 60_000;
    if (this.heartbeatMs * 2 >= this.leaseMs)
      throw new Error("Ingest heartbeat must be less than half its lease");
    this.scheduler = deps.scheduler ?? {
      schedule: (callback, ms) => setInterval(callback, ms),
      cancel: (handle) =>
        clearInterval(handle as ReturnType<typeof setInterval>),
    };
  }
  private async now(tx: Tx): Promise<Date> {
    if (this.deps.now) return this.deps.now();
    const rows = await tx.$queryRaw<
      Array<{ now: Date }>
    >`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
    if (!rows[0]) throw new Error("Database clock unavailable");
    return rows[0].now;
  }
  private owned(claim: IngestClaimRef, now: Date): Prisma.IngestJobWhereInput {
    return {
      id: claim.id,
      projectId: claim.projectId,
      claimId: claim.claimId,
      status: "running",
      claimExpiresAt: { gt: now },
    };
  }
  private async event(
    tx: Tx,
    input: {
      id: string;
      projectId: string;
      transition: string;
      stage: WorkflowStageUpdatedEvent["stage"];
      status: WorkflowStageUpdatedEvent["status"];
      progress: number;
      errorCode?: string;
      notify?: boolean;
    },
    now: Date,
  ) {
    const allocator = await tx.project.update({
      where: { id: input.projectId },
      data: { workflowEventSeq: { increment: 1 } },
      select: { workflowEventSeq: true },
    });
    const payload: WorkflowStageUpdatedEvent = {
      event: "workflow.stage.updated",
      projectId: input.projectId,
      workflowRunId: null,
      ingestJobId: input.id,
      seq: allocator.workflowEventSeq,
      stage: input.stage,
      status: input.status,
      progress: input.progress,
      errorCode: input.errorCode ?? null,
      emittedAt: now.toISOString(),
      ...(input.notify
        ? {
            notification: {
              kind: "ingest.failed" as const,
              projectId: input.projectId,
              ingestJobId: input.id,
            },
          }
        : {}),
    };
    await tx.workflowEvent.create({
      data: {
        projectId: input.projectId,
        workflowRunId: null,
        ingestJobId: input.id,
        seq: payload.seq,
        stage: input.stage,
        status: input.status,
        progress: input.progress,
        errorCode: input.errorCode ?? null,
        emittedAt: now,
        dedupeKey: `ingest:${input.id}:${input.transition}`,
        payload: payload as unknown as Prisma.InputJsonValue,
        redisRequired: this.deps.redisRequired ?? false,
        notificationRequired: input.notify ?? false,
        availableAt: now,
        nextDeliveryAt: now,
      },
    });
  }
  async enqueue(
    tx: Tx,
    input: {
      id?: string;
      projectId: string;
      jobType: IngestJob["jobType"];
      payload: Prisma.InputJsonValue;
      uploadSessionId?: string;
    },
  ): Promise<{ id: string }> {
    const job = await tx.ingestJob.create({ data: input });
    await this.event(
      tx,
      {
        id: job.id,
        projectId: job.projectId,
        transition: "queued",
        stage: "ingest_queued",
        status: "queued",
        progress: 5,
      },
      await this.now(tx),
    );
    return { id: job.id };
  }
  async claim(
    options: { youtubeAvailable?: boolean } = {},
  ): Promise<ClaimedIngestJob | null> {
    return this.deps.prisma.$transaction(async (tx) => {
      const now = await this.now(tx);
      const eligible: Prisma.IngestJobWhereInput = {
        status: "queued",
        project: {
          ...accessibleProjectWhere(now),
          workspace: { status: "active" },
        },
        AND: [
          {
            OR: claimBackoffWhereClauses(
              INGEST_AUTO_RETRY_MAX_ATTEMPTS,
              now.getTime(),
            ),
          },
          ...(options.youtubeAvailable === false
            ? [
                {
                  OR: [
                    { jobType: { in: ["upload_finalize", "rss_import"] } },
                    {
                      jobType: "link_import",
                      NOT: {
                        payload: { path: ["provider"], equals: "youtube" },
                      },
                    },
                  ],
                } satisfies Prisma.IngestJobWhereInput,
              ]
            : []),
        ],
      };
      for (let contention = 0; contention < 5; contention++) {
        const candidate = await tx.ingestJob.findFirst({
          where: eligible,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        if (!candidate) return null;
        const claimId = randomUUID();
        const claimed = await tx.ingestJob.updateMany({
          where: {
            ...eligible,
            id: candidate.id,
            updatedAt: candidate.updatedAt,
          },
          data: {
            status: "running",
            claimId,
            claimExpiresAt: new Date(now.getTime() + this.leaseMs),
            startedAt: now,
            attemptCount: { increment: 1 },
          },
        });
        if (!claimed.count) continue;
        return {
          id: candidate.id,
          projectId: candidate.projectId,
          jobType: candidate.jobType,
          payload: candidate.payload,
          attemptCount: candidate.attemptCount + 1,
          claimId,
        };
      }
      return null;
    });
  }
  async renew(claim: IngestClaimRef): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      const now = await this.now(tx);
      const updated = await tx.ingestJob.updateMany({
        where: this.owned(claim, now),
        data: { claimExpiresAt: new Date(now.getTime() + this.leaseMs) },
      });
      if (!updated.count) throw new IngestJobClaimLost(claim.id);
    });
  }
  async progress(
    claim: IngestClaimRef,
    status: "downloading" | "normalizing",
  ): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      const now = await this.now(tx);
      const updated = await tx.ingestJob.updateMany({
        where: this.owned(claim, now),
        data: {
          lastError: null,
          claimExpiresAt: new Date(now.getTime() + this.leaseMs),
        },
      });
      if (!updated.count) throw new IngestJobClaimLost(claim.id);
      const project = await tx.project.updateMany({
        where: { id: claim.projectId, ...accessibleProjectWhere(now) },
        data: { ingestStatus: status, ingestErrorCode: null },
      });
      if (!project.count) throw new IngestJobClaimLost(claim.id);
      await this.event(
        tx,
        {
          ...claim,
          transition: `${claim.claimId}:${status}`,
          stage:
            status === "downloading"
              ? "ingest_downloading"
              : "ingest_normalizing",
          status: "running",
          progress: status === "downloading" ? 40 : 75,
        },
        now,
      );
    });
  }
  async complete(
    claim: IngestClaimRef,
    source: {
      sourceStorageKey: string;
      sourceMediaUrl?: string;
      sourceInput?: string | null;
      sourceMimeType?: string | null;
      sourceSizeBytes?: number | null;
      sourceDurationSeconds?: number | null;
    },
  ): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      const now = await this.now(tx);
      const updated = await tx.ingestJob.updateMany({
        where: this.owned(claim, now),
        data: {
          status: "completed",
          claimId: null,
          claimExpiresAt: null,
          completedAt: now,
          lastError: null,
          generationHandoffAt: null,
          generationHandoffRetryAt: null,
        },
      });
      if (!updated.count) throw new IngestJobClaimLost(claim.id);
      await tx.project.update({
        where: { id: claim.projectId },
        data: {
          ...source,
          sourceMediaUrl:
            source.sourceMediaUrl ??
            `r2://${this.deps.sourceBucket ?? "unknown-bucket"}/${source.sourceStorageKey}`,
          sourceSizeBytes:
            typeof source.sourceSizeBytes === "number"
              ? BigInt(source.sourceSizeBytes)
              : undefined,
          ingestStatus: "ready",
          ingestErrorCode: null,
          ingestCompletedAt: now,
        },
      });
      await this.event(
        tx,
        {
          ...claim,
          transition: `${claim.claimId}:completed`,
          stage: "ingest_ready",
          status: "completed",
          progress: 100,
        },
        now,
      );
    });
  }
  /** Records an ingest-owned pinned copy of a verified upload as the Project
   * source and schedules the grantable upload key for Media Cleanup after any
   * still-valid upload grant has expired. */
  async pinSource(
    claim: IngestClaimRef,
    input: {
      sourceStorageKey: string;
      releasedStorageKey: string;
      releaseNotBefore: Date;
    },
  ): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      const now = await this.now(tx);
      const owned = await tx.ingestJob.updateMany({
        where: this.owned(claim, now),
        data: { claimExpiresAt: new Date(now.getTime() + this.leaseMs) },
      });
      if (!owned.count) throw new IngestJobClaimLost(claim.id);
      await tx.project.update({
        where: { id: claim.projectId },
        data: { sourceStorageKey: input.sourceStorageKey },
      });
      if (input.releasedStorageKey !== input.sourceStorageKey)
        await admitMediaCleanupObligations(tx.mediaCleanupObligation, [
          {
            origin: "upload_source_pinning",
            cleanupClass: "upload_source",
            projectId: claim.projectId,
            objectKey: input.releasedStorageKey,
            notBefore: input.releaseNotBefore,
          },
        ]);
    });
  }
  private async settleFailure(
    tx: Tx,
    job: Pick<IngestJob, "id" | "projectId" | "attemptCount">,
    where: Prisma.IngestJobWhereInput,
    code: string,
    message: string,
    transition: string,
    now: Date,
  ): Promise<IngestFailureDecision | null> {
    const decision = decideAutoRetry(
      job.attemptCount,
      code,
      INGEST_AUTO_RETRY_MAX_ATTEMPTS,
      INGEST_RETRIES_EXHAUSTED_CODE,
    );
    const terminal = decision.outcome === "permanent";
    const updated = await tx.ingestJob.updateMany({
      where,
      data: {
        status: terminal ? "failed" : "queued",
        claimId: null,
        claimExpiresAt: null,
        startedAt: null,
        lastError: `${code}: ${message}`,
        completedAt: terminal ? now : null,
        updatedAt: now,
      },
    });
    if (!updated.count) return null;
    if (terminal)
      await this.deps.usage.release(tx, {
        projectId: job.projectId,
        reason: decision.terminalErrorCode,
      });
    await tx.project.update({
      where: { id: job.projectId },
      data: {
        ingestStatus: terminal ? "failed" : "queued",
        ingestErrorCode: terminal ? decision.terminalErrorCode : null,
      },
    });
    await this.event(
      tx,
      {
        ...job,
        transition,
        stage: terminal ? "ingest" : "ingest_retrying",
        status: terminal ? "failed" : "queued",
        progress: terminal ? 100 : 40,
        ...(terminal
          ? { errorCode: decision.terminalErrorCode, notify: true }
          : {}),
      },
      now,
    );
    return decision;
  }
  async fail(
    claim: IngestClaimRef,
    code: string,
    message: string,
  ): Promise<IngestFailureDecision> {
    return this.deps.prisma.$transaction(async (tx) => {
      const now = await this.now(tx);
      const job = await tx.ingestJob.findFirst({
        where: this.owned(claim, now),
      });
      if (!job) throw new IngestJobClaimLost(claim.id);
      const result = await this.settleFailure(
        tx,
        job,
        this.owned(claim, now),
        code,
        message,
        `${claim.claimId}:failed`,
        now,
      );
      if (!result) throw new IngestJobClaimLost(claim.id);
      return result;
    });
  }
  /** Graceful process shutdown is not a failed source attempt. Release its
   * claim immediately and refund the claim's automatic retry budget. */
  async release(claim: IngestClaimRef): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      const now = await this.now(tx);
      const updated = await tx.ingestJob.updateMany({
        where: this.owned(claim, now),
        data: {
          status: "queued",
          claimId: null,
          claimExpiresAt: null,
          startedAt: null,
          attemptCount: { decrement: 1 },
          updatedAt: now,
        },
      });
      if (!updated.count) return;
      await tx.project.update({
        where: { id: claim.projectId },
        data: { ingestStatus: "queued", ingestErrorCode: null },
      });
      await this.event(
        tx,
        {
          ...claim,
          transition: `${claim.claimId}:released`,
          stage: "ingest_queued",
          status: "queued",
          progress: 5,
        },
        now,
      );
    });
  }
  async reapExpired(limit = 100): Promise<number> {
    const now = await this.deps.prisma.$transaction((tx) => this.now(tx));
    const expired = await this.deps.prisma.ingestJob.findMany({
      where: { status: "running", claimExpiresAt: { lte: now } },
      take: limit,
      orderBy: { claimExpiresAt: "asc" },
    });
    let reaped = 0;
    for (const job of expired) {
      const result = await this.deps.prisma.$transaction(async (tx) => {
        const clock = await this.now(tx);
        return this.settleFailure(
          tx,
          job,
          {
            id: job.id,
            status: "running",
            claimId: job.claimId,
            claimExpiresAt: { lte: clock },
          },
          "worker_stalled",
          "Ingest claim expired",
          `${job.claimId}:reaped`,
          clock,
        );
      });
      if (result) reaped++;
    }
    return reaped;
  }
  async cancelQueuedOperation(input: { actorUserId: string; workspaceId: string; projectId: string; ingestJobId: string }): Promise<boolean> {
    await this.deps.requireRetryActor(input.actorUserId, input.workspaceId);
    return this.deps.prisma.$transaction(async (tx) => {
      const job = await tx.ingestJob.findFirst({ where: { id: input.ingestJobId, projectId: input.projectId,
        status: "queued", project: { workspaceId: input.workspaceId, ...accessibleProjectWhere() } } });
      if (!job) return false;
      const now = await this.now(tx);
      const changed = await tx.ingestJob.updateMany({ where: { id: job.id, status: "queued" },
        data: { status: "cancelled", completedAt: now, lastError: "MCP_CANCELLED" } });
      if (!changed.count) return false;
      await this.deps.usage.release(tx, { projectId: input.projectId, reason: "MCP_CANCELLED" });
      await tx.project.updateMany({ where: { id: input.projectId, ingestStatus: "queued" },
        data: { ingestStatus: "failed", ingestErrorCode: "MCP_CANCELLED" } });
      await this.event(tx, { id: job.id, projectId: job.projectId, transition: "mcp_cancelled",
        stage: "ingest", status: "failed", progress: 0, errorCode: "MCP_CANCELLED" }, now);
      return true;
    });
  }

  async retry(input: {
    projectId: string;
    workspaceId: string;
    actorUserId: string;
  }): Promise<{
    queuedJobId: string;
    attemptsUsed: number;
    maxAttempts: number;
  }> {
    await this.deps.requireRetryActor(input.actorUserId, input.workspaceId);
    return this.deps.prisma.$transaction(async (tx) => {
      const intake = await tx.project.findFirst({
        where: {
          id: input.projectId,
          workspaceId: input.workspaceId,
          ...accessibleProjectWhere(),
        },
        select: {
          ingestStatus: true,
          sourceDurationSeconds: true,
          ingestJobs: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 1,
            select: { jobType: true },
          },
        },
      });
      // Re-admission takes the Workspace usage lock before any Project lock.
      // A released reservation returns to the current period under fresh
      // allowance, per-video, and capacity checks.
      if (intake?.ingestStatus === "failed" && intake.ingestJobs[0])
        await this.deps.usage.reserve(tx, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          actorUserId: input.actorUserId,
          intakeKind: intakeKindFor(intake.ingestJobs[0].jobType),
          declaredSeconds: intake.sourceDurationSeconds,
        });
      // Serializes the status guard, manual budget, fresh job and event.
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${input.projectId}::uuid FOR UPDATE`;
      const project = await tx.project.findFirst({
        where: {
          id: input.projectId,
          workspaceId: input.workspaceId,
          ...accessibleProjectWhere(),
        },
      });
      if (!project)
        throw new ExpectedDomainFailureError({
          code: "project_not_found",
          kind: "missing",
          message: "Project not found.",
        });
      if (project.ingestStatus !== "failed") throw new IngestNotFailedError();
      const count = await tx.ingestJob.count({
        where: { projectId: input.projectId },
      });
      if (count >= MAX_INGEST_RETRY_ATTEMPTS)
        throw new IngestRetryLimitExceededError(MAX_INGEST_RETRY_ATTEMPTS);
      const last = await tx.ingestJob.findFirst({
        where: { projectId: input.projectId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if (!last)
        throw new ExpectedDomainFailureError({
          code: "ingest_retry_source_not_found",
          kind: "missing",
          message: "No ingest source was found to retry.",
        });
      await tx.project.update({
        where: { id: input.projectId },
        data: { ingestStatus: "queued", ingestErrorCode: null },
      });
      const job = await this.enqueue(tx, {
        projectId: input.projectId,
        jobType: last.jobType,
        payload: last.payload as Prisma.InputJsonValue,
      });
      return {
        queuedJobId: job.id,
        attemptsUsed: count + 1,
        maxAttempts: MAX_INGEST_RETRY_ATTEMPTS,
      };
    }, PROCESSING_USAGE_TRANSACTION);
  }
  async processGenerationHandoffs(limit = 25, jobId?: string): Promise<number> {
    const now = await this.deps.prisma.$transaction((tx) => this.now(tx));
    const jobs = await this.deps.prisma.$queryRaw<
      Array<{ id: string; projectId: string }>
    >(Prisma.sql`
      SELECT job.id, job."projectId" FROM "IngestJob" job JOIN "Project" project ON project.id = job."projectId"
      WHERE job.status = 'completed' AND job."generationHandoffAt" IS NULL AND project."ingestStatus" = 'ready'
        AND (project."expiresAt" IS NULL OR project."expiresAt" > ${now}) AND project."purgeStartedAt" IS NULL
        AND (job."generationHandoffRetryAt" IS NULL OR job."generationHandoffRetryAt" <= ${now})
        ${jobId ? Prisma.sql`AND job.id = ${jobId}::uuid` : Prisma.empty}
      ORDER BY COALESCE(job."generationHandoffRetryAt", job."completedAt", job."createdAt"), job.id LIMIT ${limit}
    `);
    let settled = 0;
    for (const job of jobs) {
      let contentPackId: string | null = null;
      try {
        const project = await this.deps.prisma.project.findUniqueOrThrow({
          where: { id: job.projectId },
        });
        const pack = await this.deps.prisma.contentPack.findFirst({
          where: { projectId: job.projectId },
          orderBy: { createdAt: "desc" },
        });
        if (!pack || pack.draft) {
          await this.deferHandoff(job.id, now);
          continue;
        }
        contentPackId = pack.id;
        const key = autoTriggerIdempotencyKey(project.id, pack.id);
        const acknowledged = await this.deps.prisma.$transaction(async (tx) => {
          await this.lockGeneration(tx, project.id);
          return this.acknowledgeExistingGeneration(tx, job, pack.id);
        });
        if (acknowledged !== null) {
          if (acknowledged) settled++;
          continue;
        }
        const language = sourceLanguageCodeSchema.safeParse(
          project.languageCode,
        );
        const result = await this.deps.prisma.$transaction(async (tx) => {
          // Settlement precedes speech-to-text admission in this transaction.
          const settlement = await this.deps.usage.settle(tx, project.id);
          if (settlement.outcome === "not_ready")
            throw new Error("ingest_handoff_source_unmeasured");
          if (settlement.outcome === "refused") {
            await this.failHandoff(
              tx,
              job,
              settlement.failure.code,
              settlement.failure.message,
            );
            return { handoff: false };
          }
          return this.deps.workflow.admitWithHandoff(
          {
            projectId: project.id,
            idempotencyKey: key,
            stage: "stt",
            contentPackId: pack.id,
          },
          async (tx, run) => {
            const prior = await tx.workflowRun.findFirst({
              where: {
                id: { not: run.id },
                projectId: project.id,
                stage: "stt",
                contentPackId: pack.id,
              },
              select: { id: true },
            });
            if (prior) throw new IngestGenerationAlreadyAdmitted();
            await this.acknowledgeHandoff(tx, job);
            if (run.created)
              await tx.transcript.upsert({
                where: { projectId: project.id },
                create: {
                  projectId: project.id,
                  status: "queued",
                  provider: "assemblyai",
                  providerModel: ASSEMBLYAI_SPEECH_MODEL_CHAIN.join(","),
                },
                update: {
                  status: "queued",
                  providerJobId: null,
                  workflowAttemptId: null,
                  errorCode: null,
                  completedAt: null,
                  provider: "assemblyai",
                  providerModel: ASSEMBLYAI_SPEECH_MODEL_CHAIN.join(","),
                },
              });
            if (language.success)
              await tx.project.update({
                where: { id: project.id },
                data: { languageCode: language.data },
              });
            return true;
          },
          tx,
          );
        }, PROCESSING_USAGE_TRANSACTION);
        if (result.handoff) settled++;
      } catch (error) {
        if (error instanceof IngestJobClaimLost) continue;
        if (error instanceof IngestGenerationAlreadyAdmitted && contentPackId) {
          const acknowledged = await this.deps.prisma.$transaction(
            async (tx) => {
              await this.lockGeneration(tx, job.projectId);
              return this.acknowledgeExistingGeneration(
                tx,
                job,
                contentPackId!,
              );
            },
          );
          if (acknowledged) settled++;
          continue;
        }
        const code =
          error instanceof ExpectedDomainFailureError
            ? error.code
            : "ingest_handoff_unavailable";
        if (
          error instanceof ExpectedDomainFailureError &&
          (!isAutoRetryableFailureCode(code) ||
            [
              "invalid",
              "unprocessable",
              "missing",
              "forbidden",
              "payment_required",
            ].includes(error.kind))
        ) {
          const acknowledged = await this.deps.prisma.$transaction(
            async (tx) => {
              await this.lockGeneration(tx, job.projectId);
              if (contentPackId) {
                const existing = await this.acknowledgeExistingGeneration(
                  tx,
                  job,
                  contentPackId,
                );
                if (existing !== null) return existing;
              }
              await this.failHandoff(tx, job, code, error.message);
              return false;
            },
          );
          if (acknowledged) settled++;
        } else {
          console.warn(
            JSON.stringify({
              level: "warn",
              message: "ingest_generation_handoff_deferred",
              jobId: job.id,
              projectId: job.projectId,
              errorCode: code,
            }),
          );
          await this.deferHandoff(job.id, now);
        }
      }
    }
    return settled;
  }
  /** Settles a permanently refused generation handoff: the Ingest Job and
   * Project fail with an actionable code, the unsettled reservation releases,
   * and a notification intent is recorded, all in the caller's transaction. */
  private async failHandoff(
    tx: Tx,
    job: { id: string; projectId: string },
    code: string,
    message: string,
  ): Promise<boolean> {
    const clock = await this.now(tx);
    const failed = await tx.ingestJob.updateMany({
      where: {
        id: job.id,
        status: "completed",
        generationHandoffAt: null,
        project: { ingestStatus: "ready" },
      },
      data: {
        status: "failed",
        generationHandoffAt: clock,
        generationHandoffRetryAt: null,
        lastError: `${code}: ${message}`,
      },
    });
    if (!failed.count) return false;
    await this.deps.usage.release(tx, { projectId: job.projectId, reason: code });
    await tx.project.update({
      where: { id: job.projectId },
      data: { ingestStatus: "failed", ingestErrorCode: code },
    });
    await this.event(
      tx,
      {
        ...job,
        transition: "handoff:failed",
        stage: "ingest",
        status: "failed",
        progress: 100,
        errorCode: code,
        notify: true,
      },
      clock,
    );
    return true;
  }
  /** Records a settlement refusal from a request-path generation start (browser
   * setup, MCP) exactly as the Ingest Generation Handoff records its own. */
  async refuseGeneration(
    tx: Tx,
    projectId: string,
    failure: ExpectedDomainFailureError,
  ): Promise<void> {
    const job = await tx.ingestJob.findFirst({
      where: { projectId, status: "completed", generationHandoffAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, projectId: true },
    });
    if (job && (await this.failHandoff(tx, job, failure.code, failure.message)))
      return;
    await tx.project.updateMany({
      where: { id: projectId, ingestStatus: "ready" },
      data: { ingestStatus: "failed", ingestErrorCode: failure.code },
    });
  }
  private async lockGeneration(tx: Tx, projectId: string): Promise<void> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0)) IS NULL AS "locked"`;
  }
  private async acknowledgeHandoff(
    tx: Tx,
    job: { id: string; projectId: string },
  ): Promise<void> {
    const clock = await this.now(tx);
    const accepted = await tx.ingestJob.updateMany({
      where: {
        id: job.id,
        projectId: job.projectId,
        status: "completed",
        generationHandoffAt: null,
        project: { ingestStatus: "ready", ...accessibleProjectWhere(clock) },
      },
      data: { generationHandoffAt: clock, generationHandoffRetryAt: null },
    });
    if (!accepted.count) throw new IngestJobClaimLost(job.id);
  }
  /** null means no generation exists; false means another handoff settled first. */
  private async acknowledgeExistingGeneration(
    tx: Tx,
    job: { id: string; projectId: string },
    contentPackId: string,
  ): Promise<boolean | null> {
    const existing = await tx.workflowRun.findFirst({
      where: { projectId: job.projectId, stage: "stt", contentPackId },
      select: { id: true },
    });
    if (!existing) return null;
    try {
      await this.acknowledgeHandoff(tx, job);
      return true;
    } catch (error) {
      if (error instanceof IngestJobClaimLost) return false;
      throw error;
    }
  }
  private async deferHandoff(id: string, now: Date) {
    await this.deps.prisma.ingestJob.updateMany({
      where: { id, status: "completed", generationHandoffAt: null },
      data: { generationHandoffRetryAt: new Date(now.getTime() + 60_000) },
    });
  }
  async runClaim<T>(
    claim: IngestClaimRef,
    handler: (context: IngestExecutionContext) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T | undefined> {
    const external = options.signal ?? new AbortController().signal;
    if (external.aborted) {
      await this.release(claim);
      return undefined;
    }
    const ownership = new AbortController();
    const signal = AbortSignal.any([external, ownership.signal]);
    let pending: Promise<void> | null = null;
    const handle = this.scheduler.schedule(() => {
      if (signal.aborted || pending) return;
      pending = this.renew(claim)
        .catch((error) => {
          ownership.abort(error);
        })
        .finally(() => {
          pending = null;
        });
    }, this.heartbeatMs);
    const stopHeartbeat = () => this.scheduler.cancel(handle);
    let shutdownRelease: Promise<void> | undefined;
    const releaseForShutdown = () => {
      stopHeartbeat();
      shutdownRelease ??= this.release(claim).catch((error) => {
        console.warn(
          JSON.stringify({
            level: "error",
            message: "ingest_shutdown_release_failed",
            jobId: claim.id,
            projectId: claim.projectId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    };
    signal.addEventListener("abort", stopHeartbeat, { once: true });
    external.addEventListener("abort", releaseForShutdown, { once: true });
    try {
      return await handler({ signal });
    } catch (error) {
      if (ownership.signal.aborted) throw ownership.signal.reason;
      if (external.aborted) return undefined;
      throw error;
    } finally {
      signal.removeEventListener("abort", stopHeartbeat);
      external.removeEventListener("abort", releaseForShutdown);
      this.scheduler.cancel(handle);
      if (pending) await pending;
      if (external.aborted) {
        releaseForShutdown();
        await shutdownRelease;
      }
    }
  }
}
