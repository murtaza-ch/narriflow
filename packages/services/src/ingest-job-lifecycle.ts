import {appendProjectNotificationIntent} from "./notification-execution";
import { autopilotFinishingAuthoritySchema } from "@narriflow/validators/autopilot-finishing-authority";
import { appendProgressEventDispatch, flushProjectProgressDrains, queueProjectProgressCatchup } from "./progress-outbox";
import { requireExecutionAdmissionOpen, readExecutionAdmission } from "./execution-admission";
import { Prisma, type PrismaClient, type IngestJob, type SourceAudio, type Project } from "@prisma/client";
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
  SINGLE_PUT_CLEANUP_DELAY_MS,
} from "@narriflow/validators";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { freezeGenerationFinishing, queueSettledGenerationFinishing } from "./generation-finishing";
import { accessibleProjectWhere } from "./project-access";
import { autoTriggerIdempotencyKey } from "./generation-sequencing";
import {
  decideAutoRetry,
  autoRetryBackoffMs,
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
import { emitIntakeFinished, queueIntakeFinishedByGeneration } from "./operation-finished";
import { flushWorkspaceEvents } from "./workspace-event";
import { collectExecutionDispatch, takeExecutionDispatchIds } from "./execution-dispatch-runtime";

import { ingestAcquisitionSchema, type IngestAcquisition, sourceAudioBindingSchema, sourceVideoBindingSchema, type SourceAudioBinding, type SourceVideoBinding, type ExecutionDispatchReference, type ExecutionDisposition, executionDispatchReferenceSchema } from "@narriflow/validators/execution";
import { sourceAudioBindingHash } from "./source-audio-binding";
import { admitMediaCleanupObligations } from "./media-cleanup-admission";
import { resolveIngestSourceDefinition } from "./ingest-source-definition";
import { commitSourceLanguageProbeWithinTransaction } from "./transcription-probe";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
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
  { role: "source_audio"; binding: SourceAudioBinding } | { role: "source_video"; binding: SourceVideoBinding } | { role: "probe" }
);
export type IngestVideoValidator = (tx: Prisma.TransactionClient, input: {
  ref: IngestExecutionReference;
  artifact: ExecutorArtifactCommit & { role: "source_video"; binding: SourceVideoBinding };
  sourceAudio: SourceAudio | null;
}) => Promise<{ kind: "accepted" | "waiting_for_audio" } | { kind: "rejected"; failureCode: "source_audio_video_mismatch" }>;

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
    super(`Ingest Job ${jobId} is no longer owned by this executor`);
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
export type IngestGenerationHandoffResult = {
  kind: "admitted" | "acknowledged" | "waiting_for_pack" | "not_ready" | "superseded" | "refused" | "deferred";
  dispatchIds: string[];
  workflowRunId?: string;
  retryAt?: Date;
};

export interface IngestClaimRef {
  id: string;
  projectId: string;
  claimId: string;
}
export type IngestFailureDecision =
  | { outcome: "requeue" }
  | { outcome: "permanent"; terminalErrorCode: string };
type Tx = Prisma.TransactionClient;
export interface IngestJobLifecycleDependencies {
  prisma: PrismaClient;
  workflow: Pick<WorkflowRunLifecycle, "admitWithHandoff" | "dispatchRunWithinTransaction" | "cancelSourceExecutionsWithinTransaction">;
  usage: Pick<ProcessingUsage, "reserve" | "settle" | "release">;
  requireRetryActor(actorUserId: string, workspaceId: string): Promise<unknown>;
  sourceBucket?: string;
  /** Required for video publication. Performs only typed validation/DB facts, never R2 I/O under locks. */
  validateVideo?: IngestVideoValidator;
  /** Freezes initial admission identity and verifies the exact replay/retry subject. */
  executionInputHash?: (job: IngestJob) => Promise<string>;
  now?: () => Date;

}

/** Source transitions run under the executor's fenced transaction. */
export class IngestJobLifecycle {
  constructor(private readonly deps: IngestJobLifecycleDependencies) {}
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
    if(input.notify)await appendProjectNotificationIntent(tx,{projectId:input.projectId,sourceId:input.id,outcome:"import_failed"});
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
        notificationDeliveredAt: input.notify ? now : null,
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
      acquisition: IngestAcquisition;
      sourceCredential?: string;
      uploadSessionId?: string;
    },
  ): Promise<{ id: string; dispatchId: string }> {
    const { epoch } = await readExecutionAdmission(tx);
    const project = await tx.project.findUniqueOrThrow({ where: { id: input.projectId }, select: { sourceRevision: true } });
    const {acquisition,...data}=input;
    if (!data.payload || typeof data.payload!=="object" || Array.isArray(data.payload)) throw new Error("ingest_source_payload_invalid");
    const frozen={...data.payload,acquisition:ingestAcquisitionSchema.parse(acquisition)} as Prisma.InputJsonObject;
    const job = await tx.ingestJob.create({ data: { ...data,payload:frozen, sourceRevision: project.sourceRevision, deploymentEpoch: epoch } });
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
    const dispatch = await this.queueExecutionWithinTransaction(tx, job.id);
    if (!dispatch) throw Error("ingest_initial_dispatch_missing");
    return { id: job.id, dispatchId: dispatch.dispatchId };
  }
  /** Initial source admission and an honest replay use one canonical subject.
   * The caller confirms the collected obligation only after its intake commits. */
  async queueExecutionWithinTransaction(tx: Tx, id: string): Promise<ExecutionDispatchReference | null> {
    const { epoch } = await readExecutionAdmission(tx);
    const job = await tx.ingestJob.findUnique({ where: { id } });
    if (!job || job.deploymentEpoch !== epoch) return null;
    const active = ["queued","running"].includes(job.status);
    const project = await tx.project.findUnique({ where: { id: job.projectId }, select: { sourceRevision: true } });
    if (!project || project.sourceRevision !== job.sourceRevision) return null;
    if (!this.deps.executionInputHash) throw Error("ingest_execution_hash_unavailable");
    const inputHash = await this.deps.executionInputHash(job);
    const known = await tx.executionDispatch.findFirst({ where: { deploymentEpoch: epoch, generation: job.generation, kind: "import_pipeline", subjectKind: "ingest_job", subjectId: job.id, wakeKind: null, deadlineKind: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
    if (known) {
      const registered = await readExecutionDispatch(tx,known.id);
      if (!registered) throw Error("ingest_initial_dispatch_missing");
      if (registered.reference.inputHash !== inputHash) throw Error("ingest_initial_dispatch_invalid");
      // Completed-source generation handoff still reads this frozen reference.
      if (active) collectExecutionDispatch(tx,registered.reference.dispatchId);
      return registered.reference;
    }
    if (!active) return null;
    const dispatch = await appendExecutionDispatch(tx,{ deploymentEpoch: epoch, generation: job.generation, kind: "import_pipeline", subject: { kind: "ingest_job", id: job.id }, inputHash, dueAt: job.createdAt });
    collectExecutionDispatch(tx,dispatch.reference.dispatchId);
    return dispatch.reference;
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
    const project = await tx.project.findFirst({ where: { id: state.ref.projectId, ...accessibleProjectWhere(state.now) }, select: { workspace: { select: { status: true } } } });
    if (!project) return { kind: "terminal", disposition: { disposition: "cancelled" } };
    return project.workspace.status === "active" ? { kind: "current", ref: state.ref } : { kind: "terminal", disposition: { disposition: "cancelled" }, restricted: true };
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
    const outcomeInputHash = inputHash;
    const current = retryAt ? await tx.ingestJob.update({ where: { id: ref.id }, data: { generation: { increment: 1 } } })
      : await tx.ingestJob.findUniqueOrThrow({ where: { id: ref.id } });
    if (retryAt) {
      if (!this.deps.executionInputHash) throw new Error("ingest_execution_hash_unavailable");
      inputHash = await this.deps.executionInputHash(current);
    }
    const now = await this.now(tx);
    const parent = await appendExecutionDispatch(tx, { deploymentEpoch: ref.deploymentEpoch, kind: "import_pipeline", subject: { kind: "ingest_job", id: ref.id },
      generation: ref.generation, inputHash: outcomeInputHash, dueAt: now, wakeKind });
    const ids = [parent.reference.dispatchId];
    if (wakeKind === "video_ready") {
      const renders = await tx.workflowRun.findMany({ where: { projectId: current.projectId, stage: "clip_rendering", status: { in: ["queued", "running", "waiting"] } }, take: 2, select: { id: true } });
      if (renders.length > 1) throw new Error("render_run_active_conflict");
      for (const run of renders) {
        const registered = await this.deps.workflow.dispatchRunWithinTransaction(tx, run.id);
        const videoReady = await appendExecutionDispatch(tx, { deploymentEpoch: registered.reference.deploymentEpoch, kind: "render_run", subject: registered.reference.subject,
          generation: registered.reference.generation, inputHash: registered.reference.inputHash, dueAt: now, wakeKind: "video_ready" });
        ids.push(videoReady.reference.dispatchId);
      }
    }
    if (wakeKind !== "audio_ready" && wakeKind !== "video_evidence_ready") {
      const finished = await appendExecutionDispatch(tx, { deploymentEpoch: ref.deploymentEpoch, kind: "operation_driver", subject: { kind: "ingest_job", id: ref.id },
        generation: ref.generation, inputHash: outcomeInputHash, dueAt: now, wakeKind: "execution_finished" });
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
    if (artifact.role === "probe") return commitSourceLanguageProbeWithinTransaction(tx, { reference: context.reference, attemptToken: context.attemptToken, owner: context.owner }, artifact);
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
      let finalized: ExecutorMutationResult;
      if (video) {
        if (video.byteLength === null || video.checksumSha256 === null || video.etag === null) throw new Error("source_video_evidence_incomplete");
        finalized = await this.finalizeVideoExecution(tx, ref, context, { artifactId: video.id, role: "source_video", storageKey: video.storageKey,
          contentType: video.contentType, byteLength: video.byteLength, sha256: video.checksumSha256, etag: video.etag, bindingHash: video.bindingHash,
          binding: sourceVideoBindingSchema.parse(video.sourceVideoBinding) });
      }
      // Validate already-arrived video first: known mismatches never admit or debit STT.
      const audioReady = await readExecutionDispatch(tx, wakes.dispatchIds[0]!);
      if (!audioReady) throw new Error("source_audio_handoff_obligation_missing");
      const handoff = await this.handoffGenerationWithinTransaction(tx, audioReady.reference);
      return { dispatchIds: [...wakes.dispatchIds, ...(finalized?.dispatchIds ?? []), ...handoff.dispatchIds] };
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
      const cancelled = await this.deps.workflow.cancelSourceExecutionsWithinTransaction(tx, { projectId: ref.projectId,
        deploymentEpoch: ref.deploymentEpoch, errorCode: decision.failureCode, now, discardTranscript: true });
      const result = await this.settleFailure(tx, job, this.owned(claim, now), decision.failureCode, decision.failureCode, `${claim.claimId}:source_mismatch`, now, "permanent");
      if (!result) throw new IngestJobClaimLost(ref.id);
      const wakes = await this.executionWakes(tx, ref, context.reference.inputHash, "ingest_failed");
      return { dispatchIds: [...cancelled.dispatchIds, ...wakes.dispatchIds] };
    }
    await this.completeWithinTransaction(tx, claim, { sourceStorageKey: artifact.storageKey, sourceMimeType: artifact.contentType,
      sourceSizeBytes: Number(artifact.byteLength), sourceDurationSeconds: Math.ceil(artifact.binding.probe.durationSec), sourceProbe: artifact.binding.probe });
    // The pinned copy now owns the source, so the upload's original goes once no PUT can still land on it.
    if (job.jobType === "upload_finalize") {
      const definition = await resolveIngestSourceDefinition(job, {});
      if (definition.kind !== "upload_source") throw new Error("source_upload_payload_invalid");
      await admitMediaCleanupObligations(tx, [{ origin: "upload_source_pinning", cleanupClass: "upload_source", projectId: ref.projectId, objectKey: definition.source.storageKey,
        notBefore: new Date(now.getTime() + SINGLE_PUT_CLEANUP_DELAY_MS) }]);
    }
    return this.executionWakes(tx, ref, context.reference.inputHash, "video_ready");
  }

  async failExecution(tx: Tx, ref: IngestExecutionReference, context: ExecutorMutationContext, failure: ExecutorFailureInput): Promise<ExecutorMutationResult> {
    const { claim, job, now } = await this.ownedExecution(tx, ref, context);
    const mismatch = ["source_audio_video_mismatch", "source_identity_mismatch"].includes(failure.failureCode);
    const code = mismatch ? "source_audio_video_mismatch" : failure.failureCode;
    const decision = await this.settleFailure(tx, job, this.owned(claim, now), code, code,
      `${claim.claimId}:${mismatch ? "source_mismatch" : "failed"}`, now, mismatch || !failure.retryable ? "permanent" : undefined);
    if (!decision) throw new IngestJobClaimLost(ref.id);
    const closed = decision.outcome === "permanent" ? await this.closeAdmittedGeneration(tx, ref, decision.terminalErrorCode, now, mismatch) : [];
    const wakes = await this.executionWakes(tx, ref, context.reference.inputHash, mismatch ? "ingest_failed" : "ingest_outcome",
      decision.outcome === "requeue" ? new Date(now.getTime() + autoRetryBackoffMs(job.attemptCount)) : undefined);
    return { dispatchIds: [...closed, ...wakes.dispatchIds] };
  }

  /** Audio-first handoff admits a generation before the video is verified. A
   * source that ends in failure can never reach ready, and every run guard then
   * refuses it, so the same commit cancels that work. Usage settled from the
   * audio stays settled and leaves an operator refund fact, but only when that
   * admitted work was actually cancelled: finished work was delivered. A
   * completed Transcript survives unless the audio is the mismatch. */
  private async closeAdmittedGeneration(tx: Tx, ref: Pick<IngestExecutionReference, "projectId" | "sourceRevision" | "deploymentEpoch">, errorCode: string, now: Date, discardTranscript = false): Promise<string[]> {
    const admitted = await tx.workflowRun.count({ where: { projectId: ref.projectId, deploymentEpoch: ref.deploymentEpoch, status: { in: ["queued", "running", "waiting"] } } });
    if (!admitted) return [];
    const cancelled = await this.deps.workflow.cancelSourceExecutionsWithinTransaction(tx, { projectId: ref.projectId, deploymentEpoch: ref.deploymentEpoch, errorCode, now, discardTranscript });
    const reservation = await tx.processingUsageReservation.findUnique({ where: { projectId: ref.projectId }, select: { state: true } });
    const audio = await tx.sourceAudio.findUnique({ where: { projectId_sourceRevision: { projectId: ref.projectId, sourceRevision: ref.sourceRevision } } });
    if (reservation?.state === "settled" && audio) await tx.sourceRefundNeed.upsert({
      where: { projectId_sourceRevision: { projectId: ref.projectId, sourceRevision: ref.sourceRevision } },
      create: { projectId: ref.projectId, sourceRevision: ref.sourceRevision, sourceAudioId: audio.id, sourceAudioBindingHash: audio.bindingHash, videoBindingHash: null }, update: {},
    });
    return cancelled.dispatchIds;
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
    const closed = decision.outcome === "permanent" ? await this.closeAdmittedGeneration(tx, ref, decision.terminalErrorCode, now) : [];
    const wakes = await this.executionWakes(tx, ref, reference.inputHash, "ingest_expired", decision.outcome === "requeue" ? new Date(now.getTime() + autoRetryBackoffMs(job.attemptCount)) : undefined);
    return { kind: "expired", dispatchIds: [...closed, ...wakes.dispatchIds] };
  }

  private async progressWithinTransaction(tx: Tx, 
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
  private async completeWithinTransaction(tx: Tx, 
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
  private async releaseWithinTransaction(tx: Tx, claim: IngestClaimRef): Promise<void> {


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
  async cancelQueuedOperation(input: { actorUserId: string; workspaceId: string; projectId: string; ingestJobId: string }): Promise<boolean> {
    await this.deps.requireRetryActor(input.actorUserId, input.workspaceId);
    return this.deps.prisma.$transaction(async (tx) => {
      await readExecutionAdmission(tx);
      await lockWorkspaceUsage(tx, input.workspaceId);
      await this.lockGeneration(tx, input.projectId);
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
      for (const id of await this.closeAdmittedGeneration(tx, job, "MCP_CANCELLED", now)) collectExecutionDispatch(tx, id);
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
      await requireExecutionAdmissionOpen(tx);
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
        acquisition: ingestAcquisitionSchema.parse(last.payload && typeof last.payload==="object" && !Array.isArray(last.payload)?last.payload.acquisition:null),
      });
      await flushProjectProgressDrains(tx);
      return {
        queuedJobId: job.id,
        attemptsUsed: count + 1,
        maxAttempts: MAX_INGEST_RETRY_ATTEMPTS,
      };
    }, PROCESSING_USAGE_TRANSACTION);
  }
  /** Executes one trusted Import Pipeline obligation. No queue scan grants authority. */
  async handoffGeneration(reference: ExecutionDispatchReference): Promise<IngestGenerationHandoffResult> {
    const parsed = executionDispatchReferenceSchema.safeParse(reference);
    if (!parsed.success || parsed.data.kind !== "import_pipeline" || parsed.data.subject.kind !== "ingest_job") {
      return { kind: "superseded", dispatchIds: [] };
    }
    return this.handoffGenerationForJob(parsed.data.subject.id, parsed.data);
  }

  private async lockHandoff(tx: Tx, id: string, reference?: ExecutionDispatchReference): Promise<
    { kind: "superseded" | "not_ready" } | { kind: "ready"; job: IngestJob; project: Project; audio: SourceAudio | null; now: Date; epoch: number }
  > {
    const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id" = 1 FOR SHARE`;
    if (!epoch || (reference && reference.deploymentEpoch !== epoch.epoch)) return { kind: "superseded" };
    if (reference) {
      const ledger = (await readExecutionDispatch(tx, reference.dispatchId))?.reference;
      if (!ledger || ledger.kind !== reference.kind || ledger.subject.kind !== reference.subject.kind || ledger.subject.id !== id ||
        ledger.deploymentEpoch !== reference.deploymentEpoch || ledger.generation !== reference.generation || ledger.inputHash !== reference.inputHash) return { kind: "superseded" };
    }
    const initial = await tx.ingestJob.findUnique({ where: { id }, include: { project: { select: { workspaceId: true } } } });
    if (!initial) return { kind: "superseded" };
    await lockWorkspaceUsage(tx, initial.project.workspaceId);
    await this.lockGeneration(tx, initial.projectId);
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${initial.projectId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "IngestJob" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const now = await this.now(tx);
    const job = await tx.ingestJob.findUniqueOrThrow({ where: { id } });
    const project = await tx.project.findFirst({ where: { id: job.projectId, ...accessibleProjectWhere(now) } });
    if (project?.ingestStatus === "failed") return { kind: "not_ready" };
    if (!project || job.deploymentEpoch !== epoch.epoch || job.sourceRevision !== project.sourceRevision ||
      (reference && job.generation !== reference.generation)) return { kind: "superseded" };
    const audio = await tx.sourceAudio.findUnique({ where: { projectId_sourceRevision: { projectId: project.id, sourceRevision: project.sourceRevision } } });
    if (!((job.status === "completed" && project.ingestStatus === "ready") || (job.status === "running" && audio))) return { kind: "not_ready" };
    return { kind: "ready", job, project, audio, now, epoch: epoch.epoch };
  }

  private async appendGenerationDispatch(tx: Tx, runId: string, epoch: number): Promise<string[]> {
    const dispatch = await this.deps.workflow.dispatchRunWithinTransaction(tx, runId);
    if (dispatch.reference.deploymentEpoch !== epoch) throw new Error("workflow_generation_superseded");
    return [dispatch.reference.dispatchId];
  }

  private async acknowledgeGenerationForPack(tx: Tx, job: { id: string; projectId: string }, contentPackId: string, epoch: number): Promise<IngestGenerationHandoffResult | null> {
    if (await this.acknowledgeExistingGeneration(tx, job, contentPackId) === null) return null;
    const current = await tx.ingestJob.findUniqueOrThrow({ where: { id: job.id }, select: { generationRunId: true } });
    return { kind: "acknowledged", workflowRunId: current.generationRunId ?? undefined,
      dispatchIds: current.generationRunId ? await this.appendGenerationDispatch(tx, current.generationRunId, epoch) : [] };
  }

  /** Caller owns the transaction and confirms the returned scheduling receipts after commit. */
  async handoffGenerationWithinTransaction(tx: Tx, reference: ExecutionDispatchReference): Promise<IngestGenerationHandoffResult> {
    const parsed = executionDispatchReferenceSchema.safeParse(reference);
    if (!parsed.success || parsed.data.kind !== "import_pipeline" || parsed.data.subject.kind !== "ingest_job") return { kind: "superseded", dispatchIds: [] };
    return this.handoffForJobWithinTransaction(tx, parsed.data.subject.id, parsed.data);
  }

  private async handoffForJobWithinTransaction(tx: Tx, id: string, reference?: ExecutionDispatchReference): Promise<IngestGenerationHandoffResult> {
        const state = await this.lockHandoff(tx, id, reference);
        if (state.kind !== "ready") return { kind: state.kind, dispatchIds: [] };
        const { job, project, audio, now, epoch } = state;
        queueProjectProgressCatchup(tx, project.id);
        if (job.generationHandoffAt && job.generationRunId) return { kind: "acknowledged", workflowRunId: job.generationRunId,
          dispatchIds: await this.appendGenerationDispatch(tx, job.generationRunId, epoch) };
        if (job.generationHandoffAt) return { kind: "refused", dispatchIds: [] };
        if (job.generationHandoffRetryAt && job.generationHandoffRetryAt > now) return { kind: "deferred", retryAt: job.generationHandoffRetryAt, dispatchIds: [] };
        // Re-read the latest pack under the admission lock. Drafts never authorize STT.
        const pack = await tx.contentPack.findFirst({ where: { projectId: project.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
        if (!pack || pack.draft) return { kind: "waiting_for_pack", dispatchIds: [] };
        const existing = await this.acknowledgeGenerationForPack(tx, job, pack.id, epoch);
        if (existing) return existing;
        const probe = sourceProbeSchema.safeParse(project.sourceProbe).data;
        const measuredDuration = audio?.durationSeconds ?? probe?.durationSec ?? null;
        const fault = pack.mode === "caption_only" && pack.captionedVideo !== null && measuredDuration !== null
          ? wholeSourceWindowFault(wholeSourceWindow(pack, { durationSec: measuredDuration, probeDurationSec: measuredDuration })) : null;
        if (fault) {
          await this.failHandoff(tx, job, fault, USER_ERROR_MESSAGES[fault]!);
          return { kind: "refused", dispatchIds: [] };
        }
        // Settlement, STT admission, transcript source binding and dispatch are one commit.
        const settlement = await this.deps.usage.settle(tx, project.id);
        if (settlement.outcome === "not_ready") return { kind: "not_ready", dispatchIds: [] };
        if (settlement.outcome === "refused") {
          await this.failHandoff(tx, job, settlement.failure.code, settlement.failure.message);
          return { kind: "refused", dispatchIds: [] };
        }
        const language = sourceLanguageCodeSchema.safeParse(project.languageCode);
        const admitted = await this.deps.workflow.admitWithHandoff({ projectId: project.id, idempotencyKey: autoTriggerIdempotencyKey(project.id, pack.id), stage: "stt", contentPackId: pack.id }, async (tx, run) => {
          await this.freezePackFinishing(tx, project, pack, run.id);
          await this.acknowledgeHandoff(tx, job, run.id);
          if (run.created) await tx.transcript.upsert({ where: { projectId: project.id },
            create: { projectId: project.id, status: "queued", provider: "elevenlabs", providerModel: PENDING_STT_PROVIDER_MODEL,
              sourceAudioId: audio?.id ?? null, sourceRevision: project.sourceRevision },
            update: { status: "queued", providerJobId: null, providerRequestId: null, providerSubmissionDeadlineAt: null, providerSubmittedAt: null, providerResultDeadlineAt: null,
              workflowAttemptId: null, errorCode: null, completedAt: null, provider: "elevenlabs", providerModel: PENDING_STT_PROVIDER_MODEL,
              sourceAudioId: audio?.id ?? null, sourceRevision: project.sourceRevision } });
          if (language.success) await tx.project.update({ where: { id: project.id }, data: { languageCode: language.data } });
          return this.appendGenerationDispatch(tx, run.id, epoch);
        }, tx);
        return { kind: admitted.created ? "admitted" : "acknowledged", workflowRunId: admitted.id, dispatchIds: admitted.handoff };
  }

  /** The interim scanner delegates here; all admission decisions live in this body. */
  private async handoffGenerationForJob(id: string, reference?: ExecutionDispatchReference): Promise<IngestGenerationHandoffResult> {
    try {
      return await this.deps.prisma.$transaction(async tx => {
        const result = await this.handoffForJobWithinTransaction(tx, id, reference);
        await flushWorkspaceEvents(tx);
        return { ...result, dispatchIds: [...new Set([...result.dispatchIds, ...await flushProjectProgressDrains(tx), ...takeExecutionDispatchIds(tx)])] };
      }, PROCESSING_USAGE_TRANSACTION);
    } catch (error) {
      if (error instanceof IngestJobClaimLost) return { kind: "superseded", dispatchIds: [] };
      const code = error instanceof ExpectedDomainFailureError ? error.code : "ingest_handoff_unavailable";
      return this.deps.prisma.$transaction(async (tx) => {
        const state = await this.lockHandoff(tx, id, reference);
        if (state.kind !== "ready") return { kind: state.kind, dispatchIds: [] };
        // The failed transaction released its locks. A manual admission may
        // have committed before this fresh failure transition acquires them.
        const pack = await tx.contentPack.findFirst({ where: { projectId: state.project.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
        const accepted = pack && !pack.draft ? await this.acknowledgeGenerationForPack(tx, state.job, pack.id, state.epoch) : null;
        if (accepted) {
          queueProjectProgressCatchup(tx, state.project.id);
          await flushWorkspaceEvents(tx);
          return { ...accepted, dispatchIds: [...new Set([...accepted.dispatchIds, ...await flushProjectProgressDrains(tx), ...takeExecutionDispatchIds(tx)])] };
        }
        if (error instanceof ExpectedDomainFailureError && (!isAutoRetryableFailureCode(code) || ["invalid", "unprocessable", "missing", "forbidden", "payment_required"].includes(error.kind))) {
          await this.failHandoff(tx, state.job, code, error.message);
          await flushWorkspaceEvents(tx);
          return { kind: "refused", dispatchIds: [...await flushProjectProgressDrains(tx), ...takeExecutionDispatchIds(tx)] };
        }
        console.warn(JSON.stringify({ level: "warn", message: "ingest_generation_handoff_deferred", jobId: id, projectId: state.project.id, errorCode: code }));
        const retryAt = new Date(state.now.getTime() + 60_000);
        await tx.ingestJob.updateMany({ where: { id, generationHandoffAt: null }, data: { generationHandoffRetryAt: retryAt } });
        return { kind: "deferred", retryAt, dispatchIds: [] };
      }, PROCESSING_USAGE_TRANSACTION);
    }
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
    const current = await tx.ingestJob.findUnique({ where: { id: job.id }, select: { sourceRevision: true, generation: true, deploymentEpoch: true } });
    if (!current) return false;
    const failed = await tx.ingestJob.updateMany({
      where: {
        id: job.id,
        sourceRevision: current.sourceRevision,
        generation: current.generation,
        deploymentEpoch: current.deploymentEpoch,
        generationHandoffAt: null,
        project: { sourceRevision: current.sourceRevision },
        OR: [{ status: "completed", project: { ingestStatus: "ready" } },
          { status: "running", project: { sourceAudio: { some: { sourceRevision: current.sourceRevision } } } }],
      },
      data: {
        status: "failed",
        claimId: null,
        executorOwner: null,
        claimExpiresAt: null,
        sourceCredential: null,
        generationHandoffAt: clock,
        generationHandoffRetryAt: null,
        lastError: `${code}: ${message}`,
      },
    });
    if (!failed.count) return false;
    // The active native download loses authority in this same refusal commit.
    await tx.executionAttempt.updateMany({ where: { deploymentEpoch: current.deploymentEpoch, generation: current.generation,
      status: { in: ["admitted", "running"] }, dispatch: { subjectKind: "ingest_job", subjectId: job.id,
        deploymentEpoch: current.deploymentEpoch, generation: current.generation } },
      data: { status: "failed", failureCode: code, revokedAt: clock, finishedAt: clock } });
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
    const current = await tx.ingestJob.findUniqueOrThrow({ where: { id: job.id }, select: { sourceRevision: true } });
    const accepted = await tx.ingestJob.updateMany({
      where: {
        id: job.id,
        projectId: job.projectId,
        sourceRevision: current.sourceRevision,
        generationHandoffAt: null,
        project: { sourceRevision: current.sourceRevision, ...accessibleProjectWhere(clock) },
        OR: [{ status: "completed", project: { ingestStatus: "ready" } },
          { status: "running", project: { sourceAudio: { some: { sourceRevision: current.sourceRevision } } } }],
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
    pack: { finishing: Prisma.JsonValue; defaultAspectRatio: string; autopilotRuleId: string | null; autopilotAuthority: Prisma.JsonValue },
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
      autopilotAuthority: pack.autopilotAuthority === null ? undefined : autopilotFinishingAuthoritySchema.parse(pack.autopilotAuthority),
      defaultAspectRatio: defaultAspectRatioSchema.catch("9:16").parse(pack.defaultAspectRatio),
    });
    if (!frozen.created && !frozen.matches)
      console.warn(JSON.stringify({ level: "warn", message: "ingest_finishing_conflict_ignored", projectId: project.id, originRunId }));
    return frozen.created;
  }
}
