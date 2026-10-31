import { appendProgressEventDispatch } from "./progress-outbox";
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type IngestJob, type SourceAudio } from "@prisma/client";
import {
  defaultAspectRatioSchema,
  finishingSettingsSchema,
  sourceLanguageCodeSchema,
  MAX_INGEST_RETRY_ATTEMPTS,
  SCRIBE_MODEL_ID,
  sourceProbeSchema,
  USER_ERROR_MESSAGES,
  wholeSourceWindow,
  wholeSourceWindowFault,
  type SourceProbe,
  type WorkflowStageUpdatedEvent,
} from "@narriflow/validators";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { freezeGenerationFinishing, queueSettledGenerationFinishing } from "./generation-finishing";
import { accessibleProjectWhere } from "./project-access";
import { autoTriggerIdempotencyKey } from "./generation-sequencing";
import {
  decideAutoRetry,
  autoRetryBackoffMs,
  claimBackoffWhereClauses,
  INGEST_AUTO_RETRY_MAX_ATTEMPTS,
  INGEST_RETRIES_EXHAUSTED_CODE,
  isAutoRetryableFailureCode,
} from "./processing-retry-policy";
import type { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import {
  PROCESSING_USAGE_TRANSACTION,
  lockWorkspaceUsage,
  type ProcessingUsage,
} from "./processing-usage";
import { admitMediaCleanupObligations } from "./media-cleanup";
import { emitIntakeFinished, queueIntakeFinishedByGeneration } from "./operation-finished";
import { flushWorkspaceEvents } from "./workspace-event";

import { sourceAudioBindingSchema, sourceVideoBindingSchema, type SourceAudioBinding, type SourceVideoBinding, type ExecutionDispatchReference, type ExecutionDisposition } from "@narriflow/validators/execution";
import { sourceAudioBindingHash } from "./source-audio-binding";
import { appendExecutionDispatch } from "./execution-dispatch";
import type { ExecutorArtifactCommit, ExecutorDomainLock, ExecutorFailureInput, ExecutorMutationContext, ExecutorMutationResult, ExecutorProgressInput, ExecutorReleaseInput, ExecutorExpiryObservation, ExecutorExpiryResult } from "./executor-domain-control";

export interface IngestExecutionReference {
  id: string;
  projectId: string;
  generation: number;
  deploymentEpoch: number;
  sourceRevision: number;
  attemptToken: string;
}
export type IngestArtifactCommit = ExecutorArtifactCommit & (
  { role: "source_audio"; binding: SourceAudioBinding } | { role: "source_video"; binding: SourceVideoBinding }
);
export type IngestVideoValidator = (tx: Prisma.TransactionClient, input: {
  ref: IngestExecutionReference;
  artifact: ExecutorArtifactCommit & { role: "source_video"; binding: SourceVideoBinding };
  sourceAudio: SourceAudio | null;
}) => Promise<{ kind: "accepted" | "waiting_for_audio" } | { kind: "rejected"; failureCode: "source_audio_video_mismatch" }>;

// Placeholder until the Scribe worker adapter lands (ticket 06).
const PENDING_STT_PROVIDER_MODEL = SCRIBE_MODEL_ID;

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
/** A Drive intake can't be retried: its sealed token is gone, so the person picks the file again. */
export class IngestReselectRequiredError extends ExpectedDomainFailureError<"drive_token_expired"> {
  constructor() {
    super({
      code: "drive_token_expired",
      kind: "conflict",
      message: "Choose the file again from Google Drive.",
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
  /** Sealed Drive access token; null for every other job type. */
  sourceCredential: string | null;
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
  progressRequired?: boolean;
  sourceBucket?: string;
  /** Required for video publication. Performs only typed validation/DB facts, never R2 I/O under locks. */
  validateVideo?: IngestVideoValidator;
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
    const event = await tx.workflowEvent.create({
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
        progressRequired: true,
        notificationRequired: input.notify ?? false,
        availableAt: now,
        nextDeliveryAt: now,
      },
    });
    await appendProgressEventDispatch(tx, event);
  }
  async enqueue(
    tx: Tx,
    input: {
      id?: string;
      projectId: string;
      jobType: IngestJob["jobType"];
      payload: Prisma.InputJsonValue;
      sourceCredential?: string;
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
  private async executionState(tx: Tx, reference: ExecutionDispatchReference, attemptToken: string): Promise<
    { kind: "current"; ref: IngestExecutionReference; job: IngestJob; now: Date } | { kind: "terminal"; disposition: ExecutionDisposition }
  > {
    if (reference.subject.kind !== "ingest_job") return { kind: "terminal", disposition: { disposition: "superseded" } };
    const initial = await tx.ingestJob.findUnique({ where: { id: reference.subject.id }, include: { project: { select: { workspaceId: true } } } });
    if (!initial) return { kind: "terminal", disposition: { disposition: "superseded" } };
    await lockWorkspaceUsage(tx, initial.project.workspaceId);
    await this.lockGeneration(tx, initial.projectId);
    await tx.$queryRaw`SELECT "id" FROM "IngestJob" WHERE "id" = ${initial.id}::uuid FOR UPDATE`;
    const job = await tx.ingestJob.findUnique({ where: { id: initial.id } });
    const project = await tx.project.findUnique({ where: { id: initial.projectId }, select: { sourceRevision: true } });
    const now = await this.now(tx);
    if (!job || !project || job.deploymentEpoch !== reference.deploymentEpoch || job.generation !== reference.generation || job.sourceRevision !== project.sourceRevision) {
      return { kind: "terminal", disposition: { disposition: "superseded" } };
    }
    if (job.status === "completed") return { kind: "terminal", disposition: { disposition: "completed" } };
    if (job.status === "cancelled") return { kind: "terminal", disposition: { disposition: "cancelled" } };
    if (job.status === "failed") return { kind: "terminal", disposition: { disposition: "failed", failureCode: "source_ingest_failed" } };
    if (job.status === "running" && job.claimId !== attemptToken) return { kind: "terminal", disposition: { disposition: "superseded" } };
    return { kind: "current", ref: { id: job.id, projectId: job.projectId, generation: job.generation, deploymentEpoch: job.deploymentEpoch, sourceRevision: job.sourceRevision, attemptToken }, job, now };
  }

  async lockExecution(tx: Tx, reference: ExecutionDispatchReference, attemptToken: string): Promise<ExecutorDomainLock<IngestExecutionReference>> {
    const state = await this.executionState(tx, reference, attemptToken);
    if (state.kind === "terminal") return state;
    const project = await tx.project.findFirst({ where: { id: state.ref.projectId, ...accessibleProjectWhere(state.now), workspace: { status: "active" } }, select: { id: true } });
    return project ? { kind: "current", ref: state.ref } : { kind: "terminal", disposition: { disposition: "cancelled" } };
  }

  private executionClaim(ref: IngestExecutionReference, context: ExecutorMutationContext): IngestClaimRef {
    if (context.reference.subject.kind !== "ingest_job" || context.reference.subject.id !== ref.id || context.reference.generation !== ref.generation ||
      context.reference.deploymentEpoch !== ref.deploymentEpoch || context.attemptToken !== ref.attemptToken) throw new IngestJobClaimLost(ref.id);
    return { id: ref.id, projectId: ref.projectId, claimId: ref.attemptToken };
  }

  private async ownedExecution(tx: Tx, ref: IngestExecutionReference, context: ExecutorMutationContext) {
    const claim = this.executionClaim(ref, context);
    const now = await this.now(tx);
    const job = await tx.ingestJob.findFirst({ where: { ...this.owned(claim, now), generation: ref.generation, deploymentEpoch: ref.deploymentEpoch,
      executorOwner: context.owner, sourceRevision: ref.sourceRevision, operationDeadlineAt: { gt: now }, project: { sourceRevision: ref.sourceRevision } } });
    if (!job) throw new IngestJobClaimLost(ref.id);
    return { claim, job, now };
  }

  async acquireExecution(tx: Tx, ref: IngestExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const claim = this.executionClaim(ref, context);
    const job = await tx.ingestJob.findUniqueOrThrow({ where: { id: ref.id } });
    const now = await this.now(tx);
    const retryAt = job.attemptCount === 0 ? job.createdAt : new Date(job.updatedAt.getTime() + autoRetryBackoffMs(job.attemptCount));
    if (job.status !== "queued" || job.claimId || job.executorOwner || job.generation !== ref.generation || job.deploymentEpoch !== ref.deploymentEpoch ||
      job.sourceRevision !== ref.sourceRevision || job.attemptCount >= INGEST_AUTO_RETRY_MAX_ATTEMPTS || retryAt > now || context.leaseExpiresAt <= now || context.leaseExpiresAt > context.operationDeadlineAt ||
      context.operationDeadlineAt <= now || (job.operationDeadlineAt && job.operationDeadlineAt.getTime() !== context.operationDeadlineAt.getTime())) throw new IngestJobClaimLost(claim.id);
    await tx.ingestJob.update({ where: { id: job.id }, data: { status: "running", claimId: claim.claimId, executorOwner: context.owner,
      claimExpiresAt: context.leaseExpiresAt, operationDeadlineAt: context.operationDeadlineAt, startedAt: null, completedAt: null } });
    const absolute = await appendExecutionDispatch(tx, { deploymentEpoch: ref.deploymentEpoch, kind: "operation_driver", subject: { kind: "ingest_job", id: ref.id },
      generation: ref.generation, inputHash: context.reference.inputHash, dueAt: context.operationDeadlineAt, deadlineKind: "operation", observedDeadlineAt: context.operationDeadlineAt });
    const acquired = await appendExecutionDispatch(tx, { deploymentEpoch: ref.deploymentEpoch, kind: "operation_driver", subject: { kind: "ingest_job", id: ref.id },
      generation: ref.generation, inputHash: context.reference.inputHash, dueAt: now, wakeKind: "execution_acquired", deadlineKind: "lease", observedDeadlineAt: context.leaseExpiresAt });
    return { dispatchIds: [absolute.reference.dispatchId, acquired.reference.dispatchId] };
  }

  async renewExecution(tx: Tx, ref: IngestExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const { job, now } = await this.ownedExecution(tx, ref, context);
    if (!job.operationDeadlineAt || job.operationDeadlineAt.getTime() !== context.operationDeadlineAt.getTime() || context.leaseExpiresAt <= now ||
      context.leaseExpiresAt > job.operationDeadlineAt) throw new IngestJobClaimLost(ref.id);
    await tx.ingestJob.update({ where: { id: ref.id }, data: { claimExpiresAt: context.leaseExpiresAt } });
    return undefined;
  }

  async startExecution(tx: Tx, ref: IngestExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const { job, now } = await this.ownedExecution(tx, ref, context);
    if (job.startedAt) return undefined;
    await tx.ingestJob.update({ where: { id: ref.id }, data: { startedAt: now, attemptCount: { increment: 1 } } });
    return undefined;
  }

  private async executionWakes(tx: Tx, ref: IngestExecutionReference, inputHash: string, wakeKind: string, retryAt?: Date): Promise<{ dispatchIds: string[] }> {
    const current = retryAt ? await tx.ingestJob.update({ where: { id: ref.id }, data: { generation: { increment: 1 } } })
      : await tx.ingestJob.findUniqueOrThrow({ where: { id: ref.id } });
    const now = await this.now(tx);
    const parent = await appendExecutionDispatch(tx, { deploymentEpoch: ref.deploymentEpoch, kind: "import_pipeline", subject: { kind: "ingest_job", id: ref.id },
      generation: current.generation, inputHash, dueAt: now, wakeKind });
    const ids = [parent.reference.dispatchId];
    if (wakeKind !== "audio_ready" && wakeKind !== "video_evidence_ready") {
      const finished = await appendExecutionDispatch(tx, { deploymentEpoch: ref.deploymentEpoch, kind: "operation_driver", subject: { kind: "ingest_job", id: ref.id },
        generation: ref.generation, inputHash, dueAt: now, wakeKind: "execution_finished" });
      ids.push(finished.reference.dispatchId);
    }
    if (retryAt) {
      const retry = await appendExecutionDispatch(tx, { deploymentEpoch: ref.deploymentEpoch, kind: "operation_driver", subject: { kind: "ingest_job", id: ref.id },
        generation: current.generation, inputHash, dueAt: retryAt });
      ids.push(retry.reference.dispatchId);
    }
    return { dispatchIds: ids };
  }

  async commitArtifactExecution(tx: Tx, ref: IngestExecutionReference, context: ExecutorMutationContext, artifact: IngestArtifactCommit): Promise<ExecutorMutationResult> {
    await this.ownedExecution(tx, ref, context);
    if (artifact.role === "source_audio") {
      const binding = sourceAudioBindingSchema.parse(artifact.binding);
      if (binding.projectId !== ref.projectId || binding.sourceRevision !== ref.sourceRevision || binding.object.key !== artifact.storageKey ||
        BigInt(binding.object.byteLength) !== artifact.byteLength || binding.object.etag !== artifact.etag || binding.object.sha256 !== artifact.sha256) throw new IngestJobClaimLost(ref.id);
      const bindingHash = await sourceAudioBindingHash(binding);
      const existing = await tx.sourceAudio.findUnique({ where: { projectId_sourceRevision: { projectId: ref.projectId, sourceRevision: ref.sourceRevision } } });
      if (existing && (existing.id !== binding.sourceAudioId || existing.bindingHash !== bindingHash)) throw new IngestJobClaimLost(ref.id);
      if (!existing) await tx.sourceAudio.create({ data: { id: binding.sourceAudioId, projectId: ref.projectId, sourceRevision: ref.sourceRevision,
        mediaProvider: binding.mediaIdentity.provider, mediaId: binding.mediaIdentity.mediaId, audioTrack: binding.audioTrack, bindingHash,
        storageKey: binding.object.key, etag: binding.object.etag, byteLength: BigInt(binding.object.byteLength), checksumSha256: binding.object.sha256,
        durationSeconds: binding.durationSeconds, audioStartTimeSec: binding.audioStartTimeSec, probeVersion: binding.probeVersion, toolchainFingerprint: binding.toolchainFingerprint } });
      const wakes = await this.executionWakes(tx, ref, context.reference.inputHash, "audio_ready");
      // Video can commit first. Only this invocation's sealed evidence is eligible.
      const pending = await tx.executionArtifact.findMany({ where: { attemptToken: context.attemptToken, owner: context.owner, role: "source_video",
        committedAt: { not: null }, sourceVideoBinding: { not: Prisma.DbNull } }, take: 2 });
      if (pending.length > 1) throw new Error("source_video_evidence_ambiguous");
      const video = pending[0];
      if (!video) return wakes;
      if (video.byteLength === null || video.checksumSha256 === null || video.etag === null) throw new Error("source_video_evidence_incomplete");
      const finalized = await this.finalizeVideoExecution(tx, ref, context, { artifactId: video.id, role: "source_video", storageKey: video.storageKey,
        contentType: video.contentType, byteLength: video.byteLength, sha256: video.checksumSha256, etag: video.etag, bindingHash: video.bindingHash,
        binding: sourceVideoBindingSchema.parse(video.sourceVideoBinding) });
      return { dispatchIds: [...wakes.dispatchIds, ...(finalized?.dispatchIds ?? [])] };
    }
    if (artifact.role !== "source_video") throw new Error("source_artifact_role_invalid");
    const binding = sourceVideoBindingSchema.parse(artifact.binding);
    if (binding.projectId !== ref.projectId || binding.sourceRevision !== ref.sourceRevision) throw new IngestJobClaimLost(ref.id);
    await tx.executionArtifact.update({ where: { id: artifact.artifactId }, data: { sourceVideoBinding: binding as unknown as Prisma.InputJsonValue } });
    return this.finalizeVideoExecution(tx, ref, context, { ...artifact, binding });
  }

  private async finalizeVideoExecution(tx: Tx, ref: IngestExecutionReference, context: ExecutorMutationContext,
    artifact: ExecutorArtifactCommit & { role: "source_video"; binding: SourceVideoBinding }): Promise<ExecutorMutationResult> {
    if (!this.deps.validateVideo) throw new Error("source_video_validation_unavailable");
    const { claim, job, now } = await this.ownedExecution(tx, ref, context);
    const audio = await tx.sourceAudio.findUnique({ where: { projectId_sourceRevision: { projectId: ref.projectId, sourceRevision: ref.sourceRevision } } });
    const decision = await this.deps.validateVideo(tx, { ref, artifact, sourceAudio: audio });
    if (decision.kind === "waiting_for_audio") return this.executionWakes(tx, ref, context.reference.inputHash, "video_evidence_ready");
    if (decision.kind === "rejected") {
      const result = await this.settleFailure(tx, job, this.owned(claim, now), decision.failureCode, decision.failureCode, `${claim.claimId}:source_mismatch`, now, "permanent");
      if (!result) throw new IngestJobClaimLost(ref.id);
      return this.executionWakes(tx, ref, context.reference.inputHash, "ingest_failed");
    }
    await this.completeWithinTransaction(tx, claim, { sourceStorageKey: artifact.storageKey, sourceMimeType: artifact.contentType,
      sourceSizeBytes: Number(artifact.byteLength), sourceDurationSeconds: Math.ceil(artifact.binding.probe.durationSec), sourceProbe: artifact.binding.probe });
    return this.executionWakes(tx, ref, context.reference.inputHash, "video_ready");
  }

  async failExecution(tx: Tx, ref: IngestExecutionReference, context: ExecutorMutationContext, failure: ExecutorFailureInput): Promise<ExecutorMutationResult> {
    const { claim, job, now } = await this.ownedExecution(tx, ref, context);
    const decision = await this.settleFailure(tx, job, this.owned(claim, now), failure.failureCode, failure.failureCode,
      `${claim.claimId}:failed`, now, failure.retryable ? undefined : "permanent");
    if (!decision) throw new IngestJobClaimLost(ref.id);
    return this.executionWakes(tx, ref, context.reference.inputHash, "ingest_outcome", decision.outcome === "requeue" ? new Date(now.getTime() + autoRetryBackoffMs(job.attemptCount)) : undefined);
  }

  async releaseExecution(tx: Tx, ref: IngestExecutionReference, context: ExecutorMutationContext, release: ExecutorReleaseInput): Promise<ExecutorMutationResult> {
    const { claim, now } = await this.ownedExecution(tx, ref, context);
    await this.releaseWithinTransaction(tx, claim);
    return this.executionWakes(tx, ref, context.reference.inputHash, "ingest_released", new Date(now.getTime() + (release.reason === "startup_rejected" ? 0 : 30_000)));
  }

  async progressExecution(tx: Tx, ref: IngestExecutionReference, context: ExecutorMutationContext, progress: ExecutorProgressInput): Promise<ExecutorMutationResult> {
    const { claim } = await this.ownedExecution(tx, ref, context);
    await this.progressWithinTransaction(tx, claim, progress.phase === "downloading" ? "downloading" : "normalizing");
    return undefined;
  }

  async expireExecution(tx: Tx, reference: ExecutionDispatchReference, attemptToken: string, observation: ExecutorExpiryObservation): Promise<ExecutorExpiryResult> {
    if (!["lease", "operation"].includes(observation.kind) || !Number.isFinite(observation.observedDeadlineAt.getTime())) throw new Error("Invalid execution deadline observation");
    const state = await this.executionState(tx, reference, attemptToken);
    if (state.kind === "terminal") return { kind: state.disposition.disposition === "superseded" ? "superseded" : "terminal" };
    const { job, ref, now } = state;
    const admitted = await tx.executionAttempt.findFirst({ where: { attemptToken, deploymentEpoch: reference.deploymentEpoch, generation: reference.generation, inputHash: reference.inputHash,
      dispatch: { id: reference.dispatchId, kind: reference.kind, subjectKind: "ingest_job", subjectId: ref.id } } });
    if (!admitted || (job.operationDeadlineAt && job.operationDeadlineAt.getTime() !== admitted.operationDeadlineAt.getTime()) ||
      (observation.kind === "operation" && observation.observedDeadlineAt.getTime() !== admitted.operationDeadlineAt.getTime())) return { kind: "superseded" };
    const absolute = admitted.operationDeadlineAt;
    const deadline = job.status === "running" && job.claimExpiresAt ? new Date(Math.min(job.claimExpiresAt.getTime(), absolute.getTime())) : absolute;
    if (deadline > now) return { kind: "sleep", dueAt: deadline };
    const permanent = absolute <= now;
    const decision = await this.settleFailure(tx, job, { id: job.id, generation: ref.generation, deploymentEpoch: ref.deploymentEpoch,
      status: job.status, claimId: job.claimId, ...(job.status === "running" ? { claimExpiresAt: { lte: now } } : {}) }, permanent ? "operation_deadline_exceeded" : "worker_stalled",
      permanent ? "Source acquisition deadline expired" : "Ingest execution lease expired", `${attemptToken}:expired`, now, permanent ? "permanent" : undefined);
    if (!decision) return { kind: "superseded" };
    return { kind: "expired", ...await this.executionWakes(tx, ref, reference.inputHash, "ingest_expired", decision.outcome === "requeue" ? new Date(now.getTime() + autoRetryBackoffMs(job.attemptCount)) : undefined) };
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
                    { jobType: { in: ["upload_finalize", "rss_import", "drive_import", "zoom_import"] } },
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
          sourceCredential: candidate.sourceCredential,
          attemptCount: candidate.attemptCount + 1,
          claimId,
        };
      }
      return null;
    });
  }
  async renew(claim: IngestClaimRef): Promise<void> {
    return this.deps.prisma.$transaction((tx) => this.renewWithinTransaction(tx, claim));
  }
  /** Caller owns the transaction and flushes Workspace Events after all domain locks. */
  async renewWithinTransaction(tx: Tx, claim: IngestClaimRef): Promise<void> {


    const now = await this.now(tx);
    const updated = await tx.ingestJob.updateMany({
      where: this.owned(claim, now),
      data: { claimExpiresAt: new Date(now.getTime() + this.leaseMs) },
    });
    if (!updated.count) throw new IngestJobClaimLost(claim.id);
  }
  async progress(
    claim: IngestClaimRef,
    status: "downloading" | "normalizing",
  ): Promise<void> {
    return this.deps.prisma.$transaction((tx) => this.progressWithinTransaction(tx, claim, status));
  }
  /** Caller owns the transaction and flushes Workspace Events after all domain locks. */
  async progressWithinTransaction(tx: Tx, 
    claim: IngestClaimRef,
    status: "downloading" | "normalizing",
  ): Promise<void> {


    const now = await this.now(tx);
    const updated = await tx.ingestJob.updateMany({
      where: this.owned(claim, now),
      data: {
        lastError: null,
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
      sourceProbe?: SourceProbe | null;
    },
  ): Promise<void> {
    return this.deps.prisma.$transaction((tx) => this.completeWithinTransaction(tx, claim, source));
  }
  /** Caller owns the transaction and flushes Workspace Events after all domain locks. */
  async completeWithinTransaction(tx: Tx, 
    claim: IngestClaimRef,
    source: {
      sourceStorageKey: string;
      sourceMediaUrl?: string;
      sourceInput?: string | null;
      sourceMimeType?: string | null;
      sourceSizeBytes?: number | null;
      sourceDurationSeconds?: number | null;
      sourceProbe?: SourceProbe | null;
    },
  ): Promise<void> {
    const { sourceProbe, ...sourceFacts } = source;

    const now = await this.now(tx);
    const updated = await tx.ingestJob.updateMany({
      where: this.owned(claim, now),
      data: {
        status: "completed",
        claimId: null,
        claimExpiresAt: null,
        executorOwner: null,
        completedAt: now,
        lastError: null,
        sourceCredential: null,
        generationHandoffAt: null,
        generationHandoffRetryAt: null,
      },
    });
    if (!updated.count) throw new IngestJobClaimLost(claim.id);
    await tx.project.update({
      where: { id: claim.projectId },
      data: {
        ...sourceFacts,
        sourceMediaUrl:
          source.sourceMediaUrl ??
          `r2://${this.deps.sourceBucket ?? "unknown-bucket"}/${source.sourceStorageKey}`,
        sourceSizeBytes:
          typeof source.sourceSizeBytes === "number"
            ? BigInt(source.sourceSizeBytes)
            : undefined,
        sourceProbe: sourceProbe ?? Prisma.DbNull,
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
    return this.deps.prisma.$transaction((tx) => this.pinSourceWithinTransaction(tx, claim, input));
  }
  /** Caller owns the transaction and flushes Workspace Events after all domain locks. */
  async pinSourceWithinTransaction(tx: Tx, 
    claim: IngestClaimRef,
    input: {
      sourceStorageKey: string;
      releasedStorageKey: string;
      releaseNotBefore: Date;
    },
  ): Promise<void> {


    const now = await this.now(tx);
    const owned = await tx.ingestJob.updateMany({
      where: this.owned(claim, now),
      data: { lastError: null },
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
  }
  private async settleFailure(
    tx: Tx,
    job: Pick<IngestJob, "id" | "projectId" | "attemptCount">,
    where: Prisma.IngestJobWhereInput,
    code: string,
    message: string,
    transition: string,
    now: Date,
    disposition?: "permanent",
  ): Promise<IngestFailureDecision | null> {
    const decision = disposition === "permanent" ? { outcome: "permanent" as const, terminalErrorCode: code } : decideAutoRetry(
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
        executorOwner: null,
        startedAt: null,
        lastError: `${code}: ${message}`,
        completedAt: terminal ? now : null,
        updatedAt: now,
        // A requeued job may still download within the token's lifetime.
        ...(terminal ? { sourceCredential: null } : {}),
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
    if (terminal) await emitIntakeFinished(tx, job.id, "failed");
    return decision;
  }
  async fail(
    claim: IngestClaimRef,
    code: string,
    message: string,
  ): Promise<IngestFailureDecision> {
    return this.deps.prisma.$transaction((tx) => this.failWithinTransaction(tx, claim, code, message));
  }
  /** Caller owns the transaction and flushes Workspace Events after all domain locks. */
  async failWithinTransaction(tx: Tx, 
    claim: IngestClaimRef,
    code: string,
    message: string,
  ): Promise<IngestFailureDecision> {


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
  }
  /** Graceful process shutdown is not a failed source attempt. Release its
   * claim immediately and refund the claim's automatic retry budget. */
  async release(claim: IngestClaimRef): Promise<void> {
    return this.deps.prisma.$transaction((tx) => this.releaseWithinTransaction(tx, claim));
  }
  /** Caller owns the transaction and flushes Workspace Events after all domain locks. */
  async releaseWithinTransaction(tx: Tx, claim: IngestClaimRef): Promise<void> {


    const now = await this.now(tx);
    const prior = await tx.ingestJob.findFirst({ where: this.owned(claim, now) });
    if (!prior) return;
    const updated = await tx.ingestJob.updateMany({
      where: this.owned(claim, now),
      data: {
        status: "queued",
        claimId: null,
        claimExpiresAt: null,
        executorOwner: null,
        startedAt: null,
        ...(prior.startedAt && prior.attemptCount > 0 ? { attemptCount: { decrement: 1 } } : {}),
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
        data: { status: "cancelled", completedAt: now, lastError: "MCP_CANCELLED", sourceCredential: null } });
      if (!changed.count) return false;
      await this.deps.usage.release(tx, { projectId: input.projectId, reason: "MCP_CANCELLED" });
      await tx.project.updateMany({ where: { id: input.projectId, ingestStatus: "queued" },
        data: { ingestStatus: "failed", ingestErrorCode: "MCP_CANCELLED" } });
      await this.event(tx, { id: job.id, projectId: job.projectId, transition: "mcp_cancelled",
        stage: "ingest", status: "failed", progress: 0, errorCode: "MCP_CANCELLED" }, now);
      await emitIntakeFinished(tx, job.id, "cancelled");
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
      if (intake?.ingestStatus === "failed" && intake.ingestJobs[0]?.jobType === "drive_import")
        throw new IngestReselectRequiredError();
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
          // A captioned video is its whole window, so a window outside the
          // whole-source bounds is refused before it costs minutes or speech-to-text.
          // Other caption-only runs fail in detection and leave the Project ready.
          const fault = pack.mode === "caption_only" && pack.captionedVideo !== null && project.sourceDurationSeconds !== null
            ? wholeSourceWindowFault(wholeSourceWindow(pack, {
                durationSec: project.sourceDurationSeconds,
                probeDurationSec: sourceProbeSchema.safeParse(project.sourceProbe).data?.durationSec ?? null,
              }))
            : null;
          if (fault) {
            await this.failHandoff(tx, job, fault, USER_ERROR_MESSAGES[fault]!);
            return { handoff: false };
          }
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
          const admitted = await this.deps.workflow.admitWithHandoff(
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
            // Finishing was frozen onto the Content Pack at acceptance; it
            // becomes this generation's row here, beside the handoff.
            await this.freezePackFinishing(tx, project, pack, run.id);
            await this.acknowledgeHandoff(tx, job, run.id);
            if (run.created)
              await tx.transcript.upsert({
                where: { projectId: project.id },
                create: {
                  projectId: project.id,
                  status: "queued",
                  provider: "elevenlabs",
                  providerModel: PENDING_STT_PROVIDER_MODEL,
                },
                update: {
                  status: "queued",
                  providerJobId: null,
                  workflowAttemptId: null,
                  errorCode: null,
                  completedAt: null,
                  provider: "elevenlabs",
                  providerModel: PENDING_STT_PROVIDER_MODEL,
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
          await flushWorkspaceEvents(tx);
          return admitted;
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
    await emitIntakeFinished(tx, job.id, "failed");
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
  /** Records the handoff and the exact run it handed off to, atomically. */
  private async acknowledgeHandoff(
    tx: Tx,
    job: { id: string; projectId: string },
    generationRunId: string,
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
      data: { generationHandoffAt: clock, generationHandoffRetryAt: null, generationRunId },
    });
    if (!accepted.count) throw new IngestJobClaimLost(job.id);
    // The generation may have finished before this intake acknowledged it. The
    // caller's transaction writes the event last.
    await queueIntakeFinishedByGeneration(tx, generationRunId);
  }
  /** null means no generation exists; false means another handoff settled first. */
  private async acknowledgeExistingGeneration(
    tx: Tx,
    job: { id: string; projectId: string },
    contentPackId: string,
  ): Promise<boolean | null> {
    // The earliest run for this committed pack is the generation the intake
    // started; a later regeneration must not become this intake's lineage.
    const existing = await tx.workflowRun.findFirst({
      where: { projectId: job.projectId, stage: "stt", contentPackId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (!existing) return null;
    try {
      await this.acknowledgeHandoff(tx, job, existing.id);
      // The intake's finishing must not vanish because another path admitted
      // the generation first. A generation that already finished will not
      // settle again, so its transition is applied here.
      const pack = await tx.contentPack.findUnique({
        where: { id: contentPackId },
        include: { project: { select: { id: true, workspaceId: true, createdByUserId: true } } },
      });
      if (pack?.finishing && (await this.freezePackFinishing(tx, pack.project, pack, existing.id)))
        await queueSettledGenerationFinishing(tx, job.projectId, existing.id);
      await flushWorkspaceEvents(tx);
      return true;
    } catch (error) {
      if (error instanceof IngestJobClaimLost) return false;
      throw error;
    }
  }
  /** Freezes the finishing a Content Pack carries onto the generation the
   * intake handed off to. True when this created the row. A generation that
   * another path already froze different finishing onto keeps it; the intake
   * has no caller to refuse, so that is logged. */
  private async freezePackFinishing(
    tx: Tx,
    project: { id: string; workspaceId: string; createdByUserId: string | null },
    pack: { finishing: Prisma.JsonValue; defaultAspectRatio: string; autopilotRuleId: string | null },
    originRunId: string,
  ): Promise<boolean> {
    if (!pack.finishing) return false;
    const frozen = await freezeGenerationFinishing(tx, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      originRunId,
      actorUserId: project.createdByUserId,
      settings: finishingSettingsSchema.parse(pack.finishing),
      autopilotRuleId: pack.autopilotRuleId,
      defaultAspectRatio: defaultAspectRatioSchema.catch("9:16").parse(pack.defaultAspectRatio),
    });
    if (!frozen.created && !frozen.matches)
      console.warn(JSON.stringify({ level: "warn", message: "ingest_finishing_conflict_ignored", projectId: project.id, originRunId }));
    return frozen.created;
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
