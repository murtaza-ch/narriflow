import { WORKFLOW_LEASE_DURATION_MS, WORKFLOW_HEARTBEAT_INTERVAL_MS, WorkflowFailure, WorkflowAttemptLost, type WorkflowAttemptRef, type WorkflowAttemptContext } from "./workflow-attempt-contract";
export { WORKFLOW_LEASE_DURATION_MS, WORKFLOW_HEARTBEAT_INTERVAL_MS, WorkflowFailure, WorkflowAttemptLost, workflowHttpFailureDisposition, workflowFailureFromUnknown, rethrowWorkflowAttemptLost, type WorkflowFailureDisposition, type WorkflowAttemptRef, type WorkflowAttemptContext } from "./workflow-attempt-contract";
import { randomUUID } from "node:crypto";
import { readExecutionAdmission, assertExecutionAdmissionOpen } from "./execution-admission";
import { cancelRenderGroupsWithinTransaction, admitRenderGroupsWithinTransaction, renderGroupParentSettlement, type RenderGroupAdmission } from "./render-group-lifecycle";
import { renderGroupExecutionInputHash, renderGroupExportIdentity, type RenderGroupRef } from "./render-group-contract";
import { Prisma, type PrismaClient, type WorkflowRun, type Project } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  SCRIBE_MODEL_ID,
  workflowStageUpdatedEventSchema,
  planTranscript, parseStoredContentPack, sourceProbeSchema, fitSuppliedUtterances, toProviderLanguageCode,
  clipAspectRatioToDb, resolvePricingTier,
} from "@narriflow/validators";
import type {
  ClipCategory,
  ContentPack,
  RenderTerminalNotificationPayload,
  WorkflowStage,
  WorkflowStageUpdatedEvent,
  WorkflowStatus,
} from "@narriflow/validators";
import { accessibleProjectWhere } from "./project-access";
import {
  publishPersistedWorkflowEvent,
} from "./workflow.service";
import { notificationService, type NotificationOutcome } from "./notification.service";
import { syncClipExportAggregates } from "./clip-export-aggregates";
import {
  admitRetiredClipMediaCleanup,
} from "./media-cleanup";
import { queueExportsFinishedByRun, queueFinishedGenerations } from "./operation-finished";
import { flushWorkspaceEvents } from "./workspace-event";
import { takeNotificationDispatchIds } from "./notification-dispatch";
import { finalizeGenerationUsage, releaseFailedDubUsage } from "./generated-media-usage-ledger";
import { appendWorkflowEvent, type WorkflowEventInput } from "./workflow-event-append";
import { flushProjectProgressDrains, queueProjectProgressCatchup } from "./progress-outbox";
import { progressDeliveryPort } from "./progress-delivery";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { appendExecutionDispatch, readExecutionDispatch, executionDispatchIdentity, type ExecutionDispatchRecord } from "./execution-dispatch";
import { workflowRunExecutionInputHash } from "./workflow-execution-input";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference, type ExecutionDisposition, providerAttemptReferenceSchema, type ProviderAttemptReference } from "@narriflow/validators/execution";
export type { ProviderAttemptReference } from "@narriflow/validators/execution";
import { lockWorkspaceUsage } from "./processing-usage";
import type { ExecutorDomainLock, ExecutorMutationContext, ExecutorMutationResult, ExecutorFailureInput, ExecutorReleaseInput, ExecutorProgressInput, ExecutorArtifactCommit, ExecutorExpiryObservation, ExecutorExpiryResult } from "./executor-domain-control";
import { appendScribeCapacityWakesWithinTransaction } from "./transcription-admission";
import { lockClipSelectionParent, clipSelectionTranscriptHash, cancelClipSelectionWindowsWithinTransaction } from "./clip-selection-window";
import { admitCaptionedExportWithinTransaction, resolveClipExportOutput } from "./clip-export.service";
import type { ClipSelectionFinalizationResult, PreparedClipSelectionFinalization } from "./clip-selection-finalization";

/** How long a stopping worker lets in-flight handlers finish
 * (`WORKER_SHUTDOWN_DRAIN_MS`, 30s by default). */
export function workerShutdownDrainMs(env: Record<string, string | undefined> = {}): number {
  const configured = Number(env.WORKER_SHUTDOWN_DRAIN_MS ?? "30000");
  return Number.isFinite(configured) && configured > 0 ? configured : 30_000;
}
/** A released attempt's aborted handler may still be finishing an unfenced
 * provider call until the shutdown drain ends, so peers wait exactly that long
 * before claiming it. */
export const WORKFLOW_RELEASE_GRACE_MS = 30_000;
export const WORKFLOW_MAX_ATTEMPTS = 3;
export const WORKFLOW_RETRIES_EXHAUSTED_CODE = "workflow_retries_exhausted";

const WORKFLOW_RETRY_BASE_DELAY_MS = 30_000;
const EVENT_DELIVERY_LEASE_MS = 30_000;
const EVENT_MAX_DELIVERY_ATTEMPTS = 20;
const EVENT_MAX_BACKOFF_MS = 5 * 60 * 1000;
const TRANSACTION_RETRY_LIMIT = 10;

type TransactionClient = Prisma.TransactionClient;

export interface WorkflowExecutionReference {
  id: string;
  projectId: string;
  stage: WorkflowStage;
  generation: number;
  deploymentEpoch: number;
  attemptToken: string;
}

export interface ClaimedWorkflowAttempt extends WorkflowAttemptRef, ProviderAttemptReference {
  status: "running";
  progress: number;
  contentPackId: string | null;
  leaseExpiresAt: Date;
  project: {
    id: string;
    title: string;
    sourceMediaUrl: string;
    sourceType: string;
    sourceInput: string | null;
    sourceStorageKey: string | null;
    sourceMimeType: string | null;
    sourceDurationSeconds: number | null;
    sourceSizeBytes: bigint | null;
    createdByUserId: string | null;
    workspaceId: string;
  };
}

export interface WaitingWorkflowAttempt extends WorkflowAttemptRef, ProviderAttemptReference {
  progress: number;
  /** Null while the submission is unconfirmed: the worker can only expire it. */
  providerJobId: string | null;
  /** Set with a null `providerJobId`; the instant the unconfirmed submission fails. */
  submissionDeadlineAt: Date | null;
  submittedAt: Date;
}

/** Identifies the attempt a provider callback belongs to. The webhook carries
 * only `webhook_metadata`, so the project is resolved from the run. */

/** Provider ids a callback or recovery read supplies, to fence against a
 * different submission recorded for the same attempt. */
export interface ProviderIds {
  requestId?: string | null;
  transcriptionId?: string | null;
}

/** Outcome of a provider-driven settlement. Everything but `applied` is an
 * acknowledged no-op: nothing was written and nothing was resurrected. */
export type ProviderSettlementResult = (
  | { kind: "applied" }
  /** The same completion or acceptance was already recorded. */
  | { kind: "duplicate" }
  /** A newer attempt owns the run, the provider ids disagree, or the run is not waiting yet. */
  | {
      kind: "stale";
      reason:
        | "run_missing"
        | "invalid_reference"
        | "epoch_superseded"
        | "source_superseded"
        | "attempt_superseded"
        | "provider_job_mismatch"
        | "provider_deadline_expired"
        | "not_waiting"
        | "submission_pending"
        | "submission_confirmed";
    }
  /** The run already reached a terminal status (completed, failed, partial). */
  | { kind: "terminal"; status: WorkflowStatus }) & { dispatchIds?: string[] };

export interface ProviderSubmissionIntent {
  kind: "begun" | "already_waiting";
  reference: ProviderAttemptReference;
  serverTime: Date;
  submissionDeadlineAt: Date | null;
  providerAudioGrantExpiresAt: Date;
  dispatchIds: string[];
}

export type ProviderDeadlineResult = ProviderSettlementResult | { kind: "sleep"; dueAt: Date; dispatchIds?: string[] };
export type ProviderControlState =
  | (Extract<ProviderAttemptLookup, { kind: "waiting" }> & { serverTime: Date; nextCheckAt: Date | null })
  | Exclude<ProviderAttemptLookup, { kind: "waiting" }>;

type ProviderSettlementIntent = "accept" | "complete" | "fail";

function validProviderReference(key: ProviderAttemptReference): boolean {
  // Internal claim records also carry progress/project fields. Only the strict
  // lineage is projected here; HTTP metadata validates its entire object.
  return providerAttemptReferenceSchema.safeParse({ workflowRunId: key.workflowRunId, attemptId: key.attemptId,
    deploymentEpoch: key.deploymentEpoch, sourceRevision: key.sourceRevision, sourceAudioId: key.sourceAudioId }).success;
}


export type ProviderAttemptLookup =
  | {
      kind: "waiting";
      attempt: WorkflowAttemptRef;
      providerJobId: string | null;
      providerRequestId: string | null;
      submissionDeadlineAt: Date | null;
      resultDeadlineAt: Date | null;
      submittedAt: Date | null;
    }
  | Exclude<ProviderSettlementResult, { kind: "applied" }>;

export interface WorkflowAggregateResult {
  requestedCount: number;
  succeededCount: number;
  failedCount: number;
}

export interface RenderWorkSet {
  workflowRunId: string;
  frozenAt: Date;
  variantIds: readonly string[];
}

export interface RenderWorkSetOutcome {
  status: "completed" | "partial" | "failed" | "pending";
  requested: number;
  succeeded: number;
  failed: number;
  superseded: number;
  followUpWorkflowRunId: string | null;
}

export type RenderRunPreparation =
  | { kind: "prepared"; workSet: RenderWorkSet; groups: RenderGroupRef[]; dispatchIds: string[] }
  | { kind: "superseded" | "terminal" | "waiting_for_video"; dispatchIds: string[] };
export type RenderRunSettlement =
  | { kind: "settled"; outcome: RenderWorkSetOutcome; dispatchIds: string[] }
  | { kind: "superseded" | "not_prepared"; dispatchIds: string[] };

export type { RenderTerminalNotificationPayload } from "@narriflow/validators";

type RenderLineageVariant = {
  id: string;
  status: "pending" | "rendering" | "completed" | "failed";
  exportVariantId: string | null;
};

type RenderTerminalSettlement = {
  status: "completed" | "partial" | "failed";
  errorCode: string | null;
  requested: number;
  succeeded: number;
  failed: number;
  superseded: number;
  notification?: RenderTerminalNotificationPayload;
};

export interface CompleteTranscriptInput {
  provider: string;
  providerModel: string | null;
  providerJobId: string | null;
  /** The provider's request id; left unchanged on the row when omitted. */
  providerRequestId?: string | null;
  languageCode: string | null;
  languageConfidence: number | null;
  text: string;
  utterances: unknown;
  speakerCount: number;
  durationSeconds: number | null;
  rawStorageKey: string | null;
}

export interface WorkflowLifecycleDependencies {
  prisma?: PrismaClient;
  leaseOwner?: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  publishAnalytics?: (
    event: WorkflowStageUpdatedEvent,
    dedupeKey: string,
  ) => Promise<void>;
  publishProgress?: (event: WorkflowStageUpdatedEvent) => Promise<boolean>;
  handoffNotification?: (
    payload: NonNullable<WorkflowStageUpdatedEvent["notification"]>,
  ) => Promise<void>;
}

export interface AdmitWorkflowRunInput {
  projectId: string;
  idempotencyKey: string;
  stage: WorkflowStage;
  contentPackId?: string | null;
  contentPack?: ContentPack;
}

export interface DetectedClipArtifactInput {
  projectId: string;
  workflowRunId: string;
  index: number;
  startSec: number;
  endSec: number;
  title?: string | null;
  hookText: string;
  payoffText?: string | null;
  reasoning: string;
  category: ClipCategory;
  platformFit?: string[];
  transcriptSlice: Prisma.InputJsonValue;
  brollCues?: unknown;
  captionPreset: Prisma.InputJsonValue;
  studioEdits: Prisma.InputJsonValue;
  brollUrl: string | null;
  deletedRanges: Prisma.InputJsonValue;
  viralityScore: number;
  hookStrengthScore: number;
  emotionalIntensityScore: number;
  storyCompletenessScore?: number;
  pacingScore: number;
  durationOptimalityScore: number;
  tiktokScore: number;
  youtubeScore: number;
  instagramScore: number;
  llmProvider: string;
  llmModel: string;
  llmTokensUsed?: number | null;
}

export interface RenderArtifactInput {
  clipId: string;
  aspectRatio: string;
  status?: "pending";
  resolution: string;
}

export interface CompletedDubArtifactInput {
  status: "completed";
  transcriptText: string;
  translatedText: string;
  audioStorageKey: string;
  renderStorageKey: string;
  audioSizeBytes: bigint;
  renderSizeBytes: bigint;
  durationSec: number | null;
  model: string;
  errorCode: null;
  completedAt: Date;
}

export interface AdmitTranscriptWorkflowRunInput
  extends Omit<AdmitWorkflowRunInput, "stage"> {
  languageCode?: string | null;
  transcriptProvider: string;
  transcriptProviderModel: string | null;
}

function retryBackoffMs(attemptCount: number) {
  return WORKFLOW_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptCount - 1);
}

function eventBackoffMs(attemptCount: number) {
  return Math.min(EVENT_MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attemptCount - 1));
}

function terminalStatusForAggregate(
  result: WorkflowAggregateResult,
): Extract<WorkflowStatus, "completed" | "partial" | "failed"> {
  if (result.succeededCount === 0 && result.failedCount > 0) return "failed";
  if (result.succeededCount > 0 && result.failedCount > 0) return "partial";
  return "completed";
}

function validateAggregate(result: WorkflowAggregateResult) {
  if (
    !Number.isInteger(result.requestedCount) ||
    !Number.isInteger(result.succeededCount) ||
    !Number.isInteger(result.failedCount) ||
    result.requestedCount < 0 ||
    result.succeededCount < 0 ||
    result.failedCount < 0 ||
    result.succeededCount + result.failedCount !== result.requestedCount
  ) {
    throw new Error("Invalid workflow aggregate result counts");
  }
}

function retryableTransactionFailure(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && candidate; depth += 1) {
    if (typeof candidate !== "object") return false;
    const details = candidate as {
      code?: unknown;
      originalCode?: unknown;
      cause?: unknown;
      meta?: { modelName?: unknown };
    };
    if (
      (details.code === "P2002" &&
        details.meta?.modelName === "WorkflowEvent") ||
      details.code === "P2034" ||
      details.code === "40P01" ||
      details.code === "40001" ||
      details.originalCode === "40P01" ||
      details.originalCode === "40001"
    ) {
      return true;
    }
    candidate = details.cause;
  }
  return false;
}

export class WorkflowRunLifecycle {
  private readonly prisma: PrismaClient;
  readonly leaseOwner: string;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  private readonly publishAnalytics?: WorkflowLifecycleDependencies["publishAnalytics"];
  private readonly publishProgress: NonNullable<
    WorkflowLifecycleDependencies["publishProgress"]
  >;
  private readonly progressDeliveryRequired: boolean;
  private readonly handoffNotification: NonNullable<
    WorkflowLifecycleDependencies["handoffNotification"]
  >;

  private readonly executions = new Map<string, { settled: boolean; finished: boolean; settlement?: Promise<unknown> }>();

  /** Publish the local marker only after the fenced settlement commits. A
   * heartbeat blocked on its row lock must wait for that commit or rollback. */
  private async settlementTransaction<T>(attempt: WorkflowAttemptRef, operation: (tx: TransactionClient) => Promise<T>): Promise<T> {
    const execution = this.executions.get(attempt.attemptId);
    const settlement = this.transaction(operation);
    if (execution) execution.settlement = settlement;
    try {
      const result = await settlement;
      if (execution && !(result && typeof result === "object" && "status" in result && result.status === "pending")) execution.settled = true;
      return result;
    } finally {
      if (execution?.settlement === settlement) execution.settlement = undefined;
    }
  }

  constructor(dependencies: WorkflowLifecycleDependencies = {}) {
    const prisma = dependencies.prisma ?? getPrismaClient();
    if (!prisma) throw new Error("Database client unavailable");
    this.prisma = prisma;
    this.leaseOwner = dependencies.leaseOwner ?? randomUUID();
    this.leaseDurationMs = dependencies.leaseDurationMs ?? WORKFLOW_LEASE_DURATION_MS;
    this.heartbeatIntervalMs =
      dependencies.heartbeatIntervalMs ?? WORKFLOW_HEARTBEAT_INTERVAL_MS;
    this.publishAnalytics = dependencies.publishAnalytics;
    this.publishProgress =
      dependencies.publishProgress ?? publishPersistedWorkflowEvent;
    this.progressDeliveryRequired =
      true;
    this.handoffNotification =
      dependencies.handoffNotification ??
      (async (payload) => {
        const outcome: NotificationOutcome =
          payload.kind === "ingest.failed" ? "import_failed" : payload.kind === "clip_render.failed" ? "generation_failed" : "clips_ready";
        await notificationService.handoff({
          projectId: payload.projectId,
          sourceId: payload.kind === "ingest.failed" ? payload.ingestJobId : payload.workflowRunId,
          outcome,
        });
      });

    if (this.heartbeatIntervalMs * 2 >= this.leaseDurationMs) {
      throw new Error("Workflow heartbeat interval must be less than half the lease duration");
    }
  }

  private async transaction<T>(
    operation: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= TRANSACTION_RETRY_LIMIT; attempt += 1) {
      try {
        // Workspace Events queued by the operation are written last, after every
        // lock the operation takes, and are dropped with a retried attempt.
        let progressDispatchIds: string[] = [];
        const result = await this.prisma.$transaction(async (tx) => {
          const result = await operation(tx);
          await flushWorkspaceEvents(tx);
          progressDispatchIds = [...await flushProjectProgressDrains(tx), ...takeNotificationDispatchIds(tx)];
          return result;
        });
        if (progressDeliveryPort()) await deliverExecutionDispatches(progressDispatchIds);
        if (result !== null && typeof result === "object" && "dispatchIds" in result && Array.isArray(result.dispatchIds)) {
          return { ...result, dispatchIds: [...new Set([...result.dispatchIds, ...progressDispatchIds])] };
        }
        return result;
      } catch (error) {
        if (
          attempt === TRANSACTION_RETRY_LIMIT ||
          !retryableTransactionFailure(error)
        ) {
          throw error;
        }
      }
    }
    throw new Error("Workflow transaction retry limit exhausted");
  }

  private async databaseNow(tx: TransactionClient): Promise<Date> {
    // Prisma adapters decode raw timestamps as UTC. Return a UTC wall-clock
    // timestamp explicitly so a database session timezone cannot shift leases.
    const databaseClock = await tx.$queryRaw<Array<{ databaseNow: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS "databaseNow"
    `;
    const databaseNow = databaseClock[0]?.databaseNow;
    if (!databaseNow) throw new Error("Database clock unavailable");
    return databaseNow;
  }

  private ownedAttemptWhere(
    attempt: WorkflowAttemptRef,
    databaseNow: Date,
  ): Prisma.WorkflowRunWhereInput {
    return {
      id: attempt.workflowRunId,
      projectId: attempt.projectId,
      stage: attempt.stage,
      attemptId: attempt.attemptId,
      OR: [
        { status: "waiting" },
        {
          status: "running",
          leaseOwner: this.leaseOwner,
          leaseExpiresAt: { gt: databaseNow },
        },
      ],
    };
  }

  private appendEvent(tx: TransactionClient, input: WorkflowEventInput) {
    return appendWorkflowEvent(tx, input, {
      progressRequired: this.progressDeliveryRequired,
      analyticsEnabled: Boolean(this.publishAnalytics),
    });
  }

  private async lockAdmissionProject(
    tx: TransactionClient,
    projectId: string,
  ) {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0)) IS NULL AS "locked"
    `;
  }

  private async requireCommittedContentPack(
    tx: TransactionClient,
    projectId: string,
    contentPackId: string,
  ) {
    const contentPack = await tx.contentPack.findFirst({
      where: { id: contentPackId, projectId, draft: false },
      select: { id: true },
    });
    if (!contentPack) throw new Error("workflow_content_pack_invalid");
  }

  private async executionState(tx: TransactionClient, reference: ExecutionDispatchReference, attemptToken: string): Promise<
    { kind: "current"; ref: WorkflowExecutionReference; run: WorkflowRun; now: Date } | { kind: "terminal"; disposition: ExecutionDisposition }
  > {
    if (reference.subject.kind !== "workflow_run") return { kind: "terminal", disposition: { disposition: "superseded" } };
    const initial = await tx.workflowRun.findUnique({ where: { id: reference.subject.id }, include: { project: { select: { workspaceId: true } } } });
    if (!initial || initial.stage === "clip_rendering") return { kind: "terminal", disposition: { disposition: "superseded" } };
    await lockWorkspaceUsage(tx, initial.project.workspaceId);
    await this.lockAdmissionProject(tx, initial.projectId);
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${initial.projectId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "WorkflowRun" WHERE "id" = ${initial.id}::uuid FOR UPDATE`;
    const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: initial.id } });
    const now = await this.databaseNow(tx);
    const project = await tx.project.findFirst({ where: { id: run.projectId, ...accessibleProjectWhere(now), workspace: { status: "active" } }, select: { sourceRevision: true, ingestStatus: true } });
    if (!project || run.deploymentEpoch !== reference.deploymentEpoch || run.generation !== reference.generation) return { kind: "terminal", disposition: { disposition: "superseded" } };
    if (project.ingestStatus === "failed") return { kind: "terminal", disposition: { disposition: "cancelled" } };
    try {
      if (await this.runInputHash(tx, run, project.sourceRevision) !== reference.inputHash) return { kind: "terminal", disposition: { disposition: "superseded" } };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "workflow_source_revision_superseded") throw error;
      return { kind: "terminal", disposition: { disposition: "superseded" } };
    }
    if (run.status === "completed" || run.status === "partial") return { kind: "terminal", disposition: { disposition: "completed" } };
    if (run.status === "cancelled") return { kind: "terminal", disposition: { disposition: "cancelled" } };
    if (run.status === "failed") return { kind: "terminal", disposition: { disposition: "failed", failureCode: "workflow_failed" } };
    if ((run.status === "running" || run.status === "waiting") && run.attemptId !== attemptToken) return { kind: "terminal", disposition: { disposition: "superseded" } };
    return { kind: "current", ref: { id: run.id, projectId: run.projectId, stage: run.stage as WorkflowStage, generation: run.generation,
      deploymentEpoch: run.deploymentEpoch, attemptToken }, run, now };
  }

  async lockExecution(tx: TransactionClient, reference: ExecutionDispatchReference, attemptToken: string): Promise<ExecutorDomainLock<WorkflowExecutionReference>> {
    const state = await this.executionState(tx, reference, attemptToken);
    return state.kind === "terminal" ? state : { kind: "current", ref: state.ref };
  }

  private executionAttempt(ref: WorkflowExecutionReference, context: ExecutorMutationContext, attemptCount = 0): WorkflowAttemptRef {
    if (context.reference.subject.kind !== "workflow_run" || context.reference.subject.id !== ref.id || context.reference.generation !== ref.generation ||
      context.reference.deploymentEpoch !== ref.deploymentEpoch || context.attemptToken !== ref.attemptToken) throw new Error("workflow_execution_reference_lost");
    return { workflowRunId: ref.id, projectId: ref.projectId, stage: ref.stage, attemptId: ref.attemptToken, attemptCount };
  }

  /** A per-command owner binding; same-Tx helpers never open a nested transaction. */
  private executionOwner(owner: string): WorkflowRunLifecycle {
    return new WorkflowRunLifecycle({ prisma: this.prisma, leaseOwner: owner, leaseDurationMs: this.leaseDurationMs, heartbeatIntervalMs: this.heartbeatIntervalMs,
      publishAnalytics: this.publishAnalytics, publishProgress: this.publishProgress, handoffNotification: this.handoffNotification });
  }

  private async ownedExecution(tx: TransactionClient, ref: WorkflowExecutionReference, context: ExecutorMutationContext) {
    const attempt = this.executionAttempt(ref, context);
    const now = await this.databaseNow(tx);
    const run = await tx.workflowRun.findFirst({ where: { id: ref.id, projectId: ref.projectId, stage: ref.stage, generation: ref.generation,
      deploymentEpoch: ref.deploymentEpoch, status: "running", attemptId: ref.attemptToken, leaseOwner: context.owner,
      leaseExpiresAt: { gt: now }, operationDeadlineAt: { gt: now } } });
    if (!run) throw new WorkflowAttemptLost(attempt);
    return { run, now, attempt: { ...attempt, attemptCount: run.attemptCount } };
  }

  private async bindExecutionWithinTransaction(tx: TransactionClient, ref: WorkflowExecutionReference, context: ExecutorMutationContext) {
    const attempt = this.executionAttempt(ref, context);
    const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: ref.id } });
    const now = await this.databaseNow(tx);
    if (run.stage === "clip_rendering" || run.status !== "queued" || run.attemptId || run.leaseOwner || run.generation !== ref.generation || run.deploymentEpoch !== ref.deploymentEpoch ||
      run.attemptCount >= WORKFLOW_MAX_ATTEMPTS || (run.nextAttemptAt && run.nextAttemptAt > now) || context.leaseExpiresAt <= now ||
      context.leaseExpiresAt > context.operationDeadlineAt || context.operationDeadlineAt <= now ||
      (run.operationDeadlineAt && run.operationDeadlineAt.getTime() !== context.operationDeadlineAt.getTime())) throw new WorkflowAttemptLost(attempt);
    if (run.stage === "stt") {
      const usage = await tx.processingUsageReservation.findUnique({ where: { projectId: run.projectId }, select: { state: true } });
      if (usage?.state !== "settled" && usage?.state !== "refunded") throw new Error("processing_usage_not_settled");
    }
    await tx.workflowRun.update({ where: { id: run.id }, data: { status: "running", progress: 10, attemptId: ref.attemptToken, leaseOwner: context.owner,
      leaseExpiresAt: context.leaseExpiresAt, heartbeatAt: now, operationDeadlineAt: context.operationDeadlineAt, nextAttemptAt: null, nextPollAt: null, waitingSince: null, errorCode: null,
      requestedCount: null, ...(run.stage === "dubbing" ? {} : { succeededCount: null }), failedCount: null } });
    return { run, now };
  }

  async acquireExecution(tx: TransactionClient, ref: WorkflowExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const { run, now } = await this.bindExecutionWithinTransaction(tx, ref, context);
    const absolute = await appendExecutionDispatch(tx, { deploymentEpoch: ref.deploymentEpoch, kind: "operation_driver", subject: { kind: "workflow_run", id: run.id },
      generation: ref.generation, inputHash: context.reference.inputHash, dueAt: context.operationDeadlineAt, deadlineKind: "operation", observedDeadlineAt: context.operationDeadlineAt });
    const acquired = await appendExecutionDispatch(tx, { deploymentEpoch: ref.deploymentEpoch, kind: "operation_driver", subject: { kind: "workflow_run", id: run.id },
      generation: ref.generation, inputHash: context.reference.inputHash, dueAt: now, wakeKind: "execution_acquired", deadlineKind: "lease", observedDeadlineAt: context.leaseExpiresAt });
    return { dispatchIds: [absolute.reference.dispatchId, acquired.reference.dispatchId] };
  }

  async startExecution(tx: TransactionClient, ref: WorkflowExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const { run } = await this.ownedExecution(tx, ref, context);
    const execution = await tx.executionAttempt.findUniqueOrThrow({ where: { attemptToken: ref.attemptToken }, select: { processStartedAt: true } });
    if (execution.processStartedAt) return undefined;
    await tx.workflowRun.update({ where: { id: run.id }, data: { attemptCount: { increment: 1 } } });
    if (run.stage === "stt") await tx.transcript.update({ where: { projectId: run.projectId }, data: { workflowAttemptId: ref.attemptToken,
      status: "processing", provider: "elevenlabs", providerModel: SCRIBE_MODEL_ID, providerJobId: null, providerRequestId: null, providerSubmissionDeadlineAt: null, errorCode: null } });
    return undefined;
  }

  async renewExecution(tx: TransactionClient, ref: WorkflowExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const { run, now, attempt } = await this.ownedExecution(tx, ref, context);
    if (!run.operationDeadlineAt || run.operationDeadlineAt.getTime() !== context.operationDeadlineAt.getTime() || context.leaseExpiresAt <= now || context.leaseExpiresAt > run.operationDeadlineAt) throw new WorkflowAttemptLost(attempt);
    await tx.workflowRun.update({ where: { id: run.id }, data: { heartbeatAt: now, leaseExpiresAt: context.leaseExpiresAt } });
    return undefined;
  }

  async progressExecution(tx: TransactionClient, ref: WorkflowExecutionReference, context: ExecutorMutationContext, progress: ExecutorProgressInput): Promise<ExecutorMutationResult> {
    const { attempt } = await this.ownedExecution(tx, ref, context);
    await this.executionOwner(context.owner).reportProgressWithinTransaction(tx, attempt, progress.progress ?? 0);
    return undefined;
  }

  async commitArtifactExecution(_tx: TransactionClient, _ref: WorkflowExecutionReference, _context: ExecutorMutationContext, _artifact: ExecutorArtifactCommit): Promise<ExecutorMutationResult> {
    throw new Error("workflow_requires_typed_settlement");
  }

  private async executionWakes(tx: TransactionClient, ref: WorkflowExecutionReference, inputHash: string, retry: boolean): Promise<{ dispatchIds: string[] }> {
    if (retry) await tx.workflowRun.update({ where: { id: ref.id }, data: { generation: { increment: 1 }, operationDeadlineAt: null } });
    const finished = await appendExecutionDispatch(tx, { deploymentEpoch: ref.deploymentEpoch, kind: "operation_driver", subject: { kind: "workflow_run", id: ref.id },
      generation: ref.generation, inputHash, dueAt: await this.databaseNow(tx), wakeKind: "execution_finished" });
    const dispatchIds = [finished.reference.dispatchId];
    if (retry) dispatchIds.push((await this.dispatchRunWithinTransaction(tx, ref.id)).reference.dispatchId);
    return { dispatchIds };
  }

  async failExecution(tx: TransactionClient, ref: WorkflowExecutionReference, context: ExecutorMutationContext, failure: ExecutorFailureInput): Promise<ExecutorMutationResult> {
    const { attempt } = await this.ownedExecution(tx, ref, context);
    await this.executionOwner(context.owner).failAttemptWithinTransaction(tx, attempt, new WorkflowFailure(failure.failureCode, failure.retryable ? "retryable" : "permanent", failure.failureCode), {});
    const current = await tx.workflowRun.findUniqueOrThrow({ where: { id: ref.id }, select: { status: true } });
    return this.executionWakes(tx, ref, context.reference.inputHash, current.status === "queued");
  }

  async releaseExecution(tx: TransactionClient, ref: WorkflowExecutionReference, context: ExecutorMutationContext, release: ExecutorReleaseInput): Promise<ExecutorMutationResult> {
    const { run, attempt } = await this.ownedExecution(tx, ref, context);
    const execution = await tx.executionAttempt.findUniqueOrThrow({ where: { attemptToken: ref.attemptToken }, select: { processStartedAt: true } });
    if (!await this.executionOwner(context.owner).releaseAttemptWithinTransaction(tx, attempt, { refundAttempt: execution.processStartedAt !== null && run.attemptCount > 0, reason: release.reason })) throw new WorkflowAttemptLost(attempt);
    return this.executionWakes(tx, ref, context.reference.inputHash, true);
  }

  async expireExecution(tx: TransactionClient, reference: ExecutionDispatchReference, attemptToken: string, observation: ExecutorExpiryObservation): Promise<ExecutorExpiryResult> {
    const state = await this.executionState(tx, reference, attemptToken);
    if (state.kind === "terminal") return { kind: state.disposition.disposition === "superseded" ? "superseded" : "terminal" };
    const { run, ref, now } = state;
    const admitted = await tx.executionAttempt.findUniqueOrThrow({ where: { attemptToken }, include: { dispatch: true } });
    if (admitted.dispatchId !== reference.dispatchId || admitted.deploymentEpoch !== reference.deploymentEpoch || admitted.generation !== reference.generation ||
      admitted.inputHash !== reference.inputHash || admitted.dispatch.subjectKind !== "workflow_run" || admitted.dispatch.subjectId !== run.id) return { kind: "superseded" };
    if (observation.kind === "operation" && observation.observedDeadlineAt.getTime() !== admitted.operationDeadlineAt.getTime()) return { kind: "superseded" };
    const dueAt = new Date(Math.min(run.leaseExpiresAt?.getTime() ?? Infinity, admitted.operationDeadlineAt.getTime()));
    if (dueAt > now) return { kind: "sleep", dueAt };
    if (run.status === "waiting") throw new Error("provider_wait_execution_not_closed");
    const absolute = admitted.operationDeadlineAt <= now;
    if (run.status === "queued" && !run.attemptId) {
      if (!absolute) return { kind: "superseded" };
      await tx.workflowRun.update({ where: { id: run.id }, data: { status: "failed", progress: 100, errorCode: "operation_deadline_exceeded", nextAttemptAt: null } });
      if (run.stage === "stt") await tx.transcript.updateMany({ where: { projectId: run.projectId, status: "queued" }, data: { status: "failed", errorCode: "operation_deadline_exceeded" } });
      const event = { workflowRunId: run.id, projectId: run.projectId, stage: run.stage as WorkflowStage, attemptId: attemptToken };
      await this.appendEvent(tx, { ...event, status: "failed", progress: 100, errorCode: "operation_deadline_exceeded", transition: "expired_unacquired", analyticsRequired: true });
      await this.emitFinishedOperations(tx, event);
    } else {
      if (!run.attemptId || !run.leaseOwner || run.leaseExpiresAt === null || run.attemptId !== attemptToken) return { kind: "superseded" };
      await this.executionOwner(run.leaseOwner).failAttemptWithinTransaction(tx, { workflowRunId: run.id, projectId: run.projectId, stage: run.stage as WorkflowStage, attemptId: attemptToken, attemptCount: run.attemptCount },
        new WorkflowFailure(absolute ? "operation_deadline_exceeded" : "worker_stalled", absolute ? "permanent" : "retryable", "Workflow deadline expired"), { expiredLeaseOnly: true });
    }
    const current = await tx.workflowRun.findUniqueOrThrow({ where: { id: ref.id }, select: { status: true } });
    return { kind: "expired", ...await this.executionWakes(tx, ref, reference.inputHash, current.status === "queued") };
  }

  /** Registers the frozen run in the caller's domain transaction. Safe to replay. */
  async dispatchRunWithinTransaction(tx: TransactionClient, runId: string): Promise<ExecutionDispatchRecord> {
    const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: runId }, include: { project: { select: { sourceRevision: true } } } });

    const identity = { deploymentEpoch: run.deploymentEpoch, kind: run.stage === "clip_rendering" ? "render_run" as const : "operation_driver" as const,
      subject: { kind: "workflow_run" as const, id: run.id }, generation: run.generation };
    const key = await executionDispatchIdentity(identity);
    const existing = await tx.executionDispatch.findUnique({ where: { deliveryKey: key.deliveryKey }, select: { dueAt: true } });
    return appendExecutionDispatch(tx, { ...identity,
      inputHash: await this.runInputHash(tx, run, run.project.sourceRevision),
      dueAt: existing?.dueAt ?? run.nextAttemptAt ?? run.createdAt });
  }

  private async runInputHash(tx: TransactionClient, run: WorkflowRun, sourceRevision: number): Promise<string> {
    const transcript = await tx.transcript.findUnique({ where: { projectId: run.projectId }, select: { id: true, selectionGeneration: true, workflowAttemptId: true, sourceAudioId: true, sourceRevision: true } });
    if (transcript && transcript.sourceRevision !== sourceRevision) throw new Error("workflow_source_revision_superseded");
    return workflowRunExecutionInputHash({ id: run.id, projectId: run.projectId, stage: run.stage, contentPackId: run.contentPackId,
      generation: run.generation, deploymentEpoch: run.deploymentEpoch, sourceAudioId: transcript?.sourceAudioId ?? null, sourceRevision: transcript?.sourceRevision ?? sourceRevision,
      sourceTranscript: transcript ? { id: transcript.id, generation: transcript.selectionGeneration, attemptId: transcript.workflowAttemptId } : null });
  }

  private async admitWithinTransaction(
    tx: TransactionClient,
    input: Omit<AdmitWorkflowRunInput, "contentPack">,
  ): Promise<{ id: string; created: boolean }> {
    if (input.stage === "stt") {
      // Processing Usage settles inside every speech-to-text admission
      // transaction before this point. No stt run exists without it.
      const usage = await tx.processingUsageReservation.findUnique({
        where: { projectId: input.projectId },
        select: { state: true },
      });
      if (usage?.state !== "settled" && usage?.state !== "refunded")
        throw new Error("processing_usage_not_settled");
    }
    const workflowRunId = randomUUID();
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "WorkflowRun" (
        "id", "deploymentEpoch", "projectId", "idempotencyKey", "stage", "status",
        "progress", "attemptCount", "contentPackId",
        "createdAt", "updatedAt"
      ) VALUES (
        ${workflowRunId}::uuid, (SELECT "epoch" FROM "ExecutionEpoch" WHERE "id" = 1), ${input.projectId}::uuid,
        ${input.idempotencyKey}, ${input.stage}, 'queued', 0, 0,
        ${input.contentPackId ?? null}::uuid,
        (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      )
      ON CONFLICT ("projectId", "idempotencyKey") DO NOTHING
      RETURNING "id"
    `;
    if (inserted[0]) {
      await this.appendEvent(tx, {
        projectId: input.projectId,
        workflowRunId: inserted[0].id,
        attemptId: inserted[0].id,
        stage: input.stage,
        status: "queued",
        progress: 0,
        errorCode: null,
        transition: "admitted",
      });
      return { id: inserted[0].id, created: true };
    }
    const winner = await tx.workflowRun.findUniqueOrThrow({
      where: {
        projectId_idempotencyKey: {
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      select: { id: true },
    });
    return { id: winner.id, created: false };
  }

  private async recoverAdmissionConflict(
    input: Pick<AdmitWorkflowRunInput, "projectId" | "idempotencyKey" | "stage">,
    error: unknown,
  ) {
    if ((error as { code?: unknown }).code !== "P2002") throw error;
    const idempotentWinner = await this.prisma.workflowRun.findUnique({
      where: {
        projectId_idempotencyKey: {
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      select: { id: true },
    });
    if (idempotentWinner) return { id: idempotentWinner.id, created: false };
    const liveWinner = await this.prisma.workflowRun.findFirst({
      where: {
        projectId: input.projectId,
        stage: input.stage,
        status: { in: ["queued", "running", "waiting"] },
      },
      select: { id: true },
    });
    if (!liveWinner) throw error;
    return { id: liveWinner.id, created: false };
  }

  async admit(input: AdmitWorkflowRunInput): Promise<{ id: string; created: boolean }> {
    return this.admitRoot(input);
  }

  /** Ordinary render requests mutate their variants and register the run in
   * one admission transaction, including when an active run absorbs them. */
  async admitClipRendering(input: { projectId: string; idempotencyKey: string; variants: readonly {
    clipId: string; aspectRatio: Prisma.ClipRenderCreateManyInput["aspectRatio"]; resolution: Prisma.ClipRenderCreateManyInput["resolution"];
  }[] }): Promise<{ id: string; created: boolean }> {
    return this.admitRoot({ projectId: input.projectId, idempotencyKey: input.idempotencyKey, stage: "clip_rendering" }, input.variants);
  }

  private async admitRoot(input: AdmitWorkflowRunInput, variants?: readonly {
    clipId: string; aspectRatio: Prisma.ClipRenderCreateManyInput["aspectRatio"]; resolution: Prisma.ClipRenderCreateManyInput["resolution"];
  }[]): Promise<{ id: string; created: boolean }> {
    try {
      return await this.transaction(async (tx) => {
        const admission = await readExecutionAdmission(tx);
        await this.lockAdmissionProject(tx, input.projectId);
        const existing = await tx.workflowRun.findUnique({
          where: {
            projectId_idempotencyKey: {
              projectId: input.projectId,
              idempotencyKey: input.idempotencyKey,
            },
          },
          select: { id: true },
        });
        if (variants) {
          if (!admission.admissionOpen && existing) return { id: existing.id, created: false };
          assertExecutionAdmissionOpen(admission);
          const clipIds = [...new Set(variants.map(variant => variant.clipId))];
          if (await tx.clip.count({ where: { id: { in: clipIds }, projectId: input.projectId } }) !== clipIds.length) throw new Error("clip_render_admission_invalid");
          const current = await tx.clipRender.findMany({ where: { clipId: { in: clipIds }, exportVariantId: null }, select: { id: true, clipId: true, aspectRatio: true, status: true } });
          const byIdentity = new Map(current.map(row => [`${row.clipId}:${row.aspectRatio}`, row]));
          const creates: Prisma.ClipRenderCreateManyInput[] = [];
          const resets = new Map<Prisma.ClipRenderCreateManyInput["resolution"], string[]>();
          for (const variant of variants) {
            const row = byIdentity.get(`${variant.clipId}:${variant.aspectRatio}`);
            if (!row) creates.push({ ...variant, status: "pending" });
            else if (!["pending", "rendering"].includes(row.status)) {
              const ids = resets.get(variant.resolution) ?? []; ids.push(row.id); resets.set(variant.resolution, ids);
            }
          }
          if (creates.length) await tx.clipRender.createMany({ data: creates });
          for (const [resolution, ids] of resets) await tx.clipRender.updateMany({ where: { id: { in: ids } }, data: {
            status: "pending", storageKey: null, sizeBytes: null, durationSec: null, errorCode: null, failureDisposition: null,
            captionDiagnostics: Prisma.DbNull, workflowAttemptId: null, workflowRunId: null, startedAt: null, completedAt: null, resolution,
          } });
        }
        if (existing) return { id: existing.id, created: false };
        const active = await tx.workflowRun.findFirst({
          where: {
            projectId: input.projectId,
            stage: input.stage,
            status: { in: ["queued", "running", "waiting"] },
          },
          select: { id: true },
        });
        if (active) return { id: active.id, created: false };
        assertExecutionAdmissionOpen(admission);

        let contentPackId = input.contentPackId ?? null;
        if (input.contentPack) {
          const contentPack = await tx.contentPack.create({
            data: {
              ...input.contentPack,
              projectId: input.projectId,
              toneConstraints: input.contentPack.toneConstraints,
            },
            select: { id: true },
          });
          contentPackId = contentPack.id;
        } else if (contentPackId) {
          await this.requireCommittedContentPack(
            tx,
            input.projectId,
            contentPackId,
          );
        }
        const admitted = await this.admitWithinTransaction(tx, {
          projectId: input.projectId, idempotencyKey: input.idempotencyKey, stage: input.stage, contentPackId,
        });
        await this.dispatchRunWithinTransaction(tx, admitted.id);
        return admitted;
      });
    } catch (error) {
      return this.recoverAdmissionConflict(input, error);
    }
  }

  /** Manual retries share admission serialization with rescue and settlement.
   * Only settled failed children may leave their old lineage. Unassigned work
   * joins an unfrozen run or its normal drain follow-up. */
  async retryFailedClipExport(input: {
    projectId: string;
    exportId: string;
    expectedRetryCount: number;
    variantIds: string[];
  }): Promise<boolean> {
    return this.transaction(async (tx) => {
      const admission = await readExecutionAdmission(tx);
      await this.lockAdmissionProject(tx, input.projectId);
      const failed = await tx.clipExportVariant.findMany({
        where: {
          id: { in: input.variantIds }, exportId: input.exportId, status: "failed",
          export: { projectId: input.projectId, retryCount: input.expectedRetryCount, project: accessibleProjectWhere() },
          render: {
            status: "failed",
            OR: [{ workflowRunId: null }, { workflowRun: { status: { in: ["completed", "partial", "failed", "cancelled"] } } }],
          },
        },
        select: { id: true },
      });
      if (failed.length === 0) return false;
      assertExecutionAdmissionOpen(admission);
      const ids = failed.map((variant) => variant.id);
      const reset = { status: "pending" as const, errorCode: null, startedAt: null,
        completedAt: null, storageKey: null, sizeBytes: null, durationSec: null };
      await tx.clipRender.updateMany({
        where: { exportVariantId: { in: ids }, status: "failed" },
        data: { ...reset, workflowRunId: null, workflowAttemptId: null, failureDisposition: null },
      });
      await tx.clipExportVariant.updateMany({
        where: { id: { in: ids }, status: "failed" }, data: reset,
      });
      const exported = await tx.clipExport.update({
        where: { id: input.exportId },
        data: { retryCount: { increment: 1 } },
        select: { retryCount: true },
      });
      const active = await tx.workflowRun.findFirst({
        where: { projectId: input.projectId, stage: "clip_rendering", status: { in: ["queued", "running", "waiting"] } },
        select: { id: true },
      });
      const admitted = active ?? await this.admitWithinTransaction(tx, {
        projectId: input.projectId, stage: "clip_rendering",
        idempotencyKey: `export-retry:${input.exportId}:${exported.retryCount}`,
      });
      await tx.clipExport.update({ where: { id: input.exportId }, data: { workflowRunId: admitted.id } });
      await syncClipExportAggregates(tx, ids);
      await this.dispatchRunWithinTransaction(tx, admitted.id);
      return true;
    });
  }

  /** Recovers unassigned render work without creating another active run.
   * Admission, its event, and pending export linkage share the Project lock
   * and transaction used by ordinary render admission. */
  async rescuePendingClipRenderingRun(): Promise<string | null> {
    const candidate = await this.prisma.clipRender.findFirst({
      where: {
        status: "pending",
        workflowRunId: null,
        clip: {
          project: {
            ...accessibleProjectWhere(),
            workflowRuns: {
              none: {
                stage: "clip_rendering",
                status: { in: ["queued", "running", "waiting"] },
              },
            },
          },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { clip: { select: { projectId: true } } },
    });
    if (!candidate) return null;
    const projectId = candidate.clip.projectId;

    return this.transaction(async (tx) => {
      await this.lockAdmissionProject(tx, projectId);
      const project = await tx.project.findFirst({
        where: {
          id: projectId,
          ...accessibleProjectWhere(),
          clips: { some: { renders: { some: { status: "pending", workflowRunId: null } } } },
          workflowRuns: {
            none: {
              stage: "clip_rendering",
              status: { in: ["queued", "running", "waiting"] },
            },
          },
        },
        select: { id: true },
      });
      if (!project) return null;

      const run = await this.admitWithinTransaction(tx, {
        projectId,
        idempotencyKey: `render-rescue:${randomUUID()}`,
        stage: "clip_rendering",
      });
      await tx.clipExport.updateMany({
        where: { projectId, status: { in: ["queued", "rendering"] } },
        data: { workflowRunId: run.id },
      });
      await this.dispatchRunWithinTransaction(tx, run.id);
      return run.id;
    });
  }

  /** Admits a run and persists its domain handoff in the same transaction.
   * Workers can never claim a queued run whose required domain row is still
   * missing. The project advisory lock preserves the ordinary admission
   * serialization contract. */
  async admitWithHandoff<T>(
    input: AdmitWorkflowRunInput,
    handoff: (tx: TransactionClient, run: { id: string; created: boolean }) => Promise<T>,
    transactionClient?: TransactionClient,
  ): Promise<{ id: string; created: boolean; handoff: T }> {
    const admit = async (tx: TransactionClient) => {
      // A caller transaction is an already admitted parent's atomic handoff.
      const admission = transactionClient ? null : await readExecutionAdmission(tx);
      await this.lockAdmissionProject(tx, input.projectId);
      const existing = await tx.workflowRun.findUnique({
        where: { projectId_idempotencyKey: { projectId: input.projectId, idempotencyKey: input.idempotencyKey } },
        select: { id: true },
      });
      let admitted: { id: string; created: boolean };
      if (existing) {
        admitted = { id: existing.id, created: false };
      } else {
        if (admission) assertExecutionAdmissionOpen(admission);
        const active = await tx.workflowRun.findFirst({
          where: { projectId: input.projectId, stage: input.stage, status: { in: ["queued", "running", "waiting"] } },
          select: { id: true },
        });
        if (active) throw new Error("workflow_stage_admission_busy");
        if (input.contentPackId) await this.requireCommittedContentPack(tx, input.projectId, input.contentPackId);
        admitted = await this.admitWithinTransaction(tx, { ...input, contentPackId: input.contentPackId ?? null });
      }
      const value = await handoff(tx, admitted);
      await this.dispatchRunWithinTransaction(tx, admitted.id);
      return { ...admitted, handoff: value };
    };
    return transactionClient ? admit(transactionClient) : this.transaction(admit);
  }

  async admitTranscript(
    input: AdmitTranscriptWorkflowRunInput,
    transactionClient?: TransactionClient,
  ): Promise<{ id: string; created: boolean }> {
    const admit = async (tx: TransactionClient) => {
      const admission = transactionClient ? null : await readExecutionAdmission(tx);
      await this.lockAdmissionProject(tx, input.projectId);
      const existing = await tx.workflowRun.findUnique({
        where: {
          projectId_idempotencyKey: {
            projectId: input.projectId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: { id: true },
      });
      if (existing) return { id: existing.id, created: false };
      const active = await tx.workflowRun.findFirst({
        where: {
          projectId: input.projectId,
          stage: "stt",
          status: { in: ["queued", "running", "waiting"] },
        },
        select: { id: true },
      });
      if (active) return { id: active.id, created: false };
      if (admission) assertExecutionAdmissionOpen(admission);

      let contentPackId = input.contentPackId ?? null;
      if (input.contentPack) {
        const contentPack = await tx.contentPack.create({
          data: {
            ...input.contentPack,
            projectId: input.projectId,
            toneConstraints: input.contentPack.toneConstraints,
          },
          select: { id: true },
        });
        contentPackId = contentPack.id;
      } else if (contentPackId) {
        await this.requireCommittedContentPack(tx, input.projectId, contentPackId);
      }
      const admitted = await this.admitWithinTransaction(tx, {
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        stage: "stt",
        contentPackId,
      });
      if (!admitted.created) return admitted;

      if (input.languageCode !== undefined) {
        await tx.project.update({
          where: { id: input.projectId },
          data: { languageCode: input.languageCode },
        });
      }
      const project = await tx.project.findUniqueOrThrow({ where: { id: input.projectId }, select: { sourceRevision: true } });
      const audio = await tx.sourceAudio.findUnique({ where: { projectId_sourceRevision: { projectId: input.projectId, sourceRevision: project.sourceRevision } }, select: { id: true } });
      await tx.transcript.upsert({
        where: { projectId: input.projectId },
        create: {
          projectId: input.projectId,
          status: "queued",
          provider: input.transcriptProvider,
          providerModel: input.transcriptProviderModel,
          sourceAudioId: audio?.id ?? null,
          sourceRevision: project.sourceRevision,
          providerJobId: null,
          errorCode: null,
        },
        update: {
          status: "queued",
          provider: input.transcriptProvider,
          providerModel: input.transcriptProviderModel,
          sourceAudioId: audio?.id ?? null,
          sourceRevision: project.sourceRevision,
          providerJobId: null,
          workflowAttemptId: null,
          errorCode: null,
          completedAt: null,
        },
      });
      await this.dispatchRunWithinTransaction(tx, admitted.id);
      return admitted;
    };
    if (transactionClient) return admit(transactionClient);
    try {
      return await this.transaction(admit);
    } catch (error) {
      return this.recoverAdmissionConflict({ ...input, stage: "stt" }, error);
    }
  }

  async findReusableGenerationRun(
    projectId: string,
    includeCompleted: boolean,
  ): Promise<{ id: string; updatedAt: Date } | null> {
    return this.prisma.workflowRun.findFirst({
      where: {
        projectId,
        ...(includeCompleted
          ? {}
          : { status: { in: ["queued", "running", "waiting"] } }),
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, updatedAt: true },
    });
  }

  async claim<TStage extends WorkflowStage>(
    stage: TStage,
  ): Promise<(ClaimedWorkflowAttempt & { stage: TStage }) | null> {
    const attemptId = randomUUID();

    return this.transaction(async (tx) => {
      const now = await this.databaseNow(tx);
      const leaseExpiresAt = new Date(now.getTime() + this.leaseDurationMs);
      const candidate = await tx.workflowRun.findFirst({
        where: {
          stage,
          status: "queued",
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
          project: {
            ...accessibleProjectWhere(now),
            workspace: { status: "active" },
          },
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, progress: true },
      });
      if (!candidate) return null;

      const won = await tx.workflowRun.updateMany({
        where: {
          id: candidate.id,
          status: "queued",
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        data: {
          status: "running",
          progress: stage === "clip_rendering" ? Math.max(10, candidate.progress) : 10,
          attemptCount: { increment: 1 },
          attemptId,
          leaseOwner: this.leaseOwner,
          leaseExpiresAt,
          heartbeatAt: now,
          nextAttemptAt: null,
          nextPollAt: null,
          waitingSince: null,
          errorCode: null,
          // A frozen Render Work Set keeps its original size even when
          // editor changes remove variants before a retry starts.
          ...(stage === "clip_rendering" ? {} : { requestedCount: null }),
          // Completed children remain owned by their original attempt. Keep
          // settled render counts and the successful dubbing prefix on retry.
          ...(stage === "dubbing" || stage === "clip_rendering" ? {} : { succeededCount: null }),
          ...(stage === "clip_rendering" ? {} : { failedCount: null }),
        },
      });
      if (won.count === 0) return null;

      const run = await tx.workflowRun.findUnique({
        where: { id: candidate.id },
        include: {
          project: {
            select: {
              id: true,
              title: true,
              sourceMediaUrl: true,
              sourceType: true,
              sourceInput: true,
              sourceStorageKey: true,
              sourceRevision: true,
              transcript: { select: { sourceAudioId: true } },
              sourceMimeType: true,
              sourceDurationSeconds: true,
              sourceSizeBytes: true,
              createdByUserId: true,
              workspaceId: true,
            },
          },
        },
      });
      if (!run?.attemptId || !run.leaseExpiresAt) return null;

      if (stage === "stt") {
        await tx.transcript.upsert({
          where: { projectId: run.projectId },
          create: {
            projectId: run.projectId,
            status: "processing",
            provider: "elevenlabs",
            providerModel: SCRIBE_MODEL_ID,
            providerJobId: null,
            providerRequestId: null,
            providerSubmissionDeadlineAt: null,
            workflowAttemptId: run.attemptId,
          },
          update: {
            status: "processing",
            provider: "elevenlabs",
            providerModel: SCRIBE_MODEL_ID,
            providerJobId: null,
            providerRequestId: null,
            providerSubmissionDeadlineAt: null,
            workflowAttemptId: run.attemptId,
            errorCode: null,
          },
        });
      }

      await this.appendEvent(tx, {
        projectId: run.projectId,
        workflowRunId: run.id,
        attemptId: run.attemptId,
        stage,
        status: "running",
        progress: run.progress,
        errorCode: null,
        transition: "claimed",
      });

      return {
        workflowRunId: run.id,
        projectId: run.projectId,
        stage,
        attemptId: run.attemptId,
        deploymentEpoch: run.deploymentEpoch,
        sourceRevision: run.project.sourceRevision,
        sourceAudioId: run.project.transcript?.sourceAudioId ?? null,
        attemptCount: run.attemptCount,
        status: "running",
        progress: run.progress,
        contentPackId: run.contentPackId,
        leaseExpiresAt: run.leaseExpiresAt,
        project: run.project,
      };
    });
  }

  async cancelQueuedProjectRuns(input: {
    projectId: string;
    errorCode: string;
  }): Promise<number> {
    return this.transaction(async (tx) => {
      await this.lockAdmissionProject(tx, input.projectId);
      await tx.$queryRaw`SELECT "id" FROM "WorkflowRun" WHERE "projectId" = ${input.projectId}::uuid AND "status" = 'queued' ORDER BY "id" FOR UPDATE`;
      const queued = await tx.workflowRun.findMany({
        where: { projectId: input.projectId, status: "queued" },
        select: { id: true, stage: true },
      });
      const cancelled = await tx.workflowRun.updateMany({
        where: { id: { in: queued.map((run) => run.id) }, status: "queued" },
        data: { status: "cancelled", errorCode: input.errorCode },
      });
      for (const run of queued) {
        if (run.stage === "clip_rendering") await cancelRenderGroupsWithinTransaction(tx, run.id);
        await this.emitFinishedOperations(tx, { workflowRunId: run.id, projectId: input.projectId, stage: run.stage });
      }
      return cancelled.count;
    });
  }

  /** Caller holds epoch, Workspace usage, Project and Ingest locks in that order. */
  async cancelSourceExecutionsWithinTransaction(tx: TransactionClient, input: { projectId: string; deploymentEpoch: number; errorCode: string; now: Date }): Promise<{ dispatchIds: string[] }> {
    const current = await tx.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    if (current.epoch !== input.deploymentEpoch) return { dispatchIds: [] };
    await tx.$queryRaw`SELECT "id" FROM "WorkflowRun" WHERE "projectId" = ${input.projectId}::uuid AND "deploymentEpoch" = ${input.deploymentEpoch}
      AND status IN ('queued', 'running', 'waiting') ORDER BY "id" FOR UPDATE`;
    const runs = await tx.workflowRun.findMany({ where: { projectId: input.projectId, deploymentEpoch: input.deploymentEpoch, status: { in: ["queued", "running", "waiting"] } }, orderBy: { id: "asc" } });
    await tx.$queryRaw`SELECT g."id" FROM "RenderGroup" g JOIN "WorkflowRun" r ON r.id = g."workflowRunId"
      WHERE r."projectId" = ${input.projectId}::uuid AND g."deploymentEpoch" = ${input.deploymentEpoch} AND g.status IN ('queued', 'running') ORDER BY g.id FOR UPDATE OF g`;
    const groups = await tx.renderGroup.findMany({ where: { deploymentEpoch: input.deploymentEpoch, workflowRun: { projectId: input.projectId }, status: { in: ["queued", "running"] } }, orderBy: { id: "asc" } });
    const groupIds = groups.map(group => group.id), runIds = runs.map(run => run.id);
    if (groupIds.length) await tx.$queryRaw`SELECT "groupId", "clipRenderId" FROM "RenderGroupMember" WHERE "groupId" IN (${Prisma.join(groupIds.map(id => Prisma.sql`${id}::uuid`))}) ORDER BY "groupId", "clipRenderId" FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ClipSelectionWindow" WHERE "projectId" = ${input.projectId}::uuid AND "deploymentEpoch" = ${input.deploymentEpoch}
      AND status IN ('queued', 'running') ORDER BY id FOR UPDATE`;
    const selectionCapacityDispatchIds = await cancelClipSelectionWindowsWithinTransaction(tx, { ...input, cause: runs.find(run => run.stage === "moment_detection")?.id ?? input.projectId });
    await tx.$queryRaw`SELECT a."attemptToken" FROM "ExecutionAttempt" a JOIN "ExecutionDispatch" d ON d.id = a."dispatchId"
      LEFT JOIN "WorkflowRun" r ON d."subjectKind" = 'workflow_run' AND d."subjectId" = r.id::text
      LEFT JOIN "RenderGroup" g ON d."subjectKind" = 'render_group' AND d."subjectId" = g.id::text
      LEFT JOIN "WorkflowRun" parent ON parent.id = g."workflowRunId"
      WHERE a."deploymentEpoch" = ${input.deploymentEpoch} AND (r."projectId" = ${input.projectId}::uuid OR parent."projectId" = ${input.projectId}::uuid)
      AND a.status IN ('admitted', 'running') ORDER BY a."attemptToken" FOR UPDATE OF a`;
    await tx.executionAttempt.updateMany({ where: { deploymentEpoch: input.deploymentEpoch, status: { in: ["admitted", "running"] },
      dispatch: { OR: [{ subjectKind: "workflow_run", subjectId: { in: runIds } }, { subjectKind: "render_group", subjectId: { in: groupIds } }] } },
      data: { status: "failed", revokedAt: input.now, finishedAt: input.now, failureCode: input.errorCode } });
    await tx.workflowRun.updateMany({ where: { id: { in: runIds } }, data: { status: "cancelled", errorCode: input.errorCode, leaseOwner: null, leaseExpiresAt: null,
      heartbeatAt: null, nextAttemptAt: null, nextPollAt: null, waitingSince: null, updatedAt: input.now } });
    await tx.transcript.updateMany({ where: { projectId: input.projectId }, data: { status: "failed", errorCode: input.errorCode,
      providerSubmissionDeadlineAt: null, providerResultDeadlineAt: null } });
    if (groupIds.length) {
      const members = await tx.renderGroupMember.findMany({ where: { groupId: { in: groupIds }, invalidatedAt: null }, select: { clipRenderId: true } });
      await tx.renderGroupMember.updateMany({ where: { groupId: { in: groupIds }, invalidatedAt: null }, data: { invalidatedAt: input.now } });
      await tx.clipRender.updateMany({ where: { id: { in: members.map(member => member.clipRenderId) }, status: { in: ["pending", "rendering"] } },
        data: { status: "failed", errorCode: input.errorCode, failureDisposition: "permanent", completedAt: input.now } });
      await tx.renderGroupExecution.updateMany({ where: { groupId: { in: groupIds }, finishedAt: null }, data: { finishedAt: input.now, result: "superseded", errorCode: input.errorCode } });
      await tx.renderGroup.updateMany({ where: { id: { in: groupIds } }, data: { status: "superseded", errorCode: input.errorCode, attemptToken: null,
        leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, nextAttemptAt: null, settledAt: input.now, updatedAt: input.now } });
    }
    const capacityDispatchIds: string[] = [...selectionCapacityDispatchIds];
    if (runs.some(run => run.stage === "stt")) {
      const event = runs.find(run => run.stage === "stt")!;
      capacityDispatchIds.push(...(await appendScribeCapacityWakesWithinTransaction(tx, { deploymentEpoch: input.deploymentEpoch, attemptId: event.attemptId ?? event.id })).dispatchIds);
    }
    // Authority is revoked in bulk above. Terminal events and delivery intent
    // are created in bounded pages behind a persisted full-UUID cursor.
    return this.sourceCancellationPage(tx, { projectId: input.projectId, deploymentEpoch: input.deploymentEpoch, errorCode: input.errorCode, cancelledAt: input.now }, capacityDispatchIds);
  }

  private async appendStableExecutionWake(tx: TransactionClient, reference: ExecutionDispatchReference, wakeKind: string, dueAt: Date): Promise<ExecutionDispatchRecord> {
    const identity = { deploymentEpoch: reference.deploymentEpoch, kind: "operation_driver" as const, subject: reference.subject, generation: reference.generation, wakeKind };
    const existing = await tx.executionDispatch.findUnique({ where: { deliveryKey: (await executionDispatchIdentity(identity)).deliveryKey }, select: { dueAt: true } });
    return appendExecutionDispatch(tx, { ...identity, inputHash: reference.inputHash, dueAt: existing?.dueAt ?? dueAt });
  }

  private async sourceCancellationPage(tx: TransactionClient, input: { projectId: string; deploymentEpoch: number; errorCode: string; cancelledAt: Date }, extraIds: string[] = [],
    after?: { kind: "workflow_run" | "render_group"; id: string }): Promise<{ dispatchIds: string[] }> {
    // Reserve Ingest terminal2 + audio-ready1 + progress1 + notification1.
    const available = 123 - extraIds.length;
    if (available < 2) throw new Error("Source cancellation wake budget exceeded");
    const rows = await tx.$queryRaw<Array<{ kind: "workflow_run" | "render_group"; id: string }>>`SELECT kind, id FROM (
      SELECT 'workflow_run'::text AS kind, r.id FROM "WorkflowRun" r WHERE r."projectId" = ${input.projectId}::uuid
        AND r."deploymentEpoch" = ${input.deploymentEpoch} AND r.status = 'cancelled' AND r."errorCode" = ${input.errorCode}
        AND r."updatedAt" = (${input.cancelledAt}::timestamptz AT TIME ZONE 'UTC')
      UNION ALL SELECT 'render_group'::text AS kind, g.id FROM "RenderGroup" g JOIN "WorkflowRun" r ON r.id = g."workflowRunId"
        WHERE r."projectId" = ${input.projectId}::uuid AND g."deploymentEpoch" = ${input.deploymentEpoch} AND g.status = 'superseded' AND g."errorCode" = ${input.errorCode}
        AND g."updatedAt" = (${input.cancelledAt}::timestamptz AT TIME ZONE 'UTC')
        AND EXISTS (SELECT 1 FROM "ExecutionDispatch" d WHERE d."subjectKind" = 'render_group' AND d."subjectId" = g.id::text AND d."deploymentEpoch" = g."deploymentEpoch" AND d.generation = g.generation)
      ) cancelled WHERE (${after?.kind ?? null}::text IS NULL OR kind > ${after?.kind ?? null} OR (kind = ${after?.kind ?? null} AND id > ${after?.id ?? null}::uuid))
      ORDER BY kind, id LIMIT ${available + 1}`;
    const hasMore = rows.length > available;
    const page: string[] = [];
    for (const row of rows.slice(0, hasMore ? available - 1 : available)) {
      const subject = row.kind === "workflow_run" ? await tx.workflowRun.findUniqueOrThrow({ where: { id: row.id } }) : await tx.renderGroup.findUniqueOrThrow({ where: { id: row.id } });
      if (row.kind === "workflow_run") {
        const run = subject as WorkflowRun;
        await this.appendEvent(tx, { workflowRunId: run.id, projectId: run.projectId, stage: run.stage as WorkflowStage, attemptId: run.attemptId ?? run.id,
          status: "failed", progress: run.progress, errorCode: input.errorCode, transition: "source_cancelled", analyticsRequired: true });
        await this.emitFinishedOperations(tx, { workflowRunId: run.id, projectId: run.projectId, stage: run.stage });
      }
      const registered = await tx.executionDispatch.findFirstOrThrow({ where: { deploymentEpoch: input.deploymentEpoch, subjectKind: row.kind, subjectId: row.id,
        generation: subject.generation, wakeKind: null, deadlineKind: null }, orderBy: { createdAt: "asc" } });
      const registration = (await readExecutionDispatch(tx, registered.id))!;
      page.push((await this.appendStableExecutionWake(tx, registration.reference, "source_cancelled", input.cancelledAt)).reference.dispatchId);
    }
    if (hasMore) {
      const cursor = (await readExecutionDispatch(tx, page.at(-1)!))!;
      const continuation = await this.appendStableExecutionWake(tx, cursor.reference, `cancel_${cursor.reference.dispatchId.replaceAll("-", "")}`, cursor.dueAt);
      page.push(continuation.reference.dispatchId);
    }
    return { dispatchIds: [...extraIds, ...page] };
  }

  async continueSourceCancellation(value: ExecutionDispatchReference): Promise<{ dispatchIds: string[] }> {
    const reference = executionDispatchReferenceSchema.parse(value);
    return this.transaction(async tx => {
      const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id" = 1 FOR SHARE`;
      const record = await readExecutionDispatch(tx, reference.dispatchId);
      if (epoch?.epoch !== reference.deploymentEpoch || !record || JSON.stringify(record.reference) !== JSON.stringify(reference) || !/^cancel_[a-f0-9]{32}$/.test(record.wakeKind ?? "")) return { dispatchIds: [] };
      const hex = record.wakeKind!.slice(7), cursorId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const cursor = await readExecutionDispatch(tx, cursorId);
      if (!cursor || cursor.wakeKind !== "source_cancelled" || cursor.reference.deploymentEpoch !== reference.deploymentEpoch || cursor.reference.subject.kind !== reference.subject.kind || cursor.reference.subject.id !== reference.subject.id ||
        cursor.reference.generation !== reference.generation || cursor.reference.inputHash !== reference.inputHash) return { dispatchIds: [] };
      const run = reference.subject.kind === "workflow_run" ? await tx.workflowRun.findUnique({ where: { id: reference.subject.id }, include: { project: { select: { workspaceId: true } } } }) : null;
      const group = reference.subject.kind === "render_group" ? await tx.renderGroup.findUnique({ where: { id: reference.subject.id }, include: { workflowRun: { include: { project: { select: { workspaceId: true } } } } } }) : null;
      const projectId = run?.projectId ?? group?.workflowRun.projectId, workspaceId = run?.project.workspaceId ?? group?.workflowRun.project.workspaceId;
      const subject = run ?? group;
      if (!projectId || !workspaceId || !subject || !subject.errorCode || subject.updatedAt.getTime() !== cursor.dueAt.getTime() ||
        (run && run.status !== "cancelled") || (group && group.status !== "superseded")) return { dispatchIds: [] };
      await lockWorkspaceUsage(tx, workspaceId);
      await this.lockAdmissionProject(tx, projectId);
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId}::uuid FOR UPDATE`;
      queueProjectProgressCatchup(tx, projectId);
      return this.sourceCancellationPage(tx, { projectId, deploymentEpoch: reference.deploymentEpoch, errorCode: subject.errorCode, cancelledAt: cursor.dueAt }, [],
        { kind: run ? "workflow_run" : "render_group", id: reference.subject.id });
    });
  }

  /** Cancel the unclaimed part of this exact generation. Shared render runs
   * retain unrelated variants, and a running detection claim keeps authority. */
  async cancelQueuedGenerationOperation(input: { workspaceId: string; projectId: string; workflowRunId: string }): Promise<boolean> {
    return this.transaction(async (tx) => {
      await this.lockAdmissionProject(tx, input.projectId);
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT run."id" FROM "WorkflowRun" AS run
        INNER JOIN "Project" AS project ON project."id" = run."projectId"
        WHERE run."id" = ${input.workflowRunId}::uuid AND run."projectId" = ${input.projectId}::uuid
          AND project."workspaceId" = ${input.workspaceId}::uuid
        FOR UPDATE OF run
      `;
      if (!locked.length) return false;
      const origin = await tx.workflowRun.findFirst({ where: { id: input.workflowRunId, projectId: input.projectId,
        project: { workspaceId: input.workspaceId, ...accessibleProjectWhere() } } });
      if (!origin || origin.stage !== "stt") return false;
      if (origin.status === "queued") {
        await this.lockAdmissionProject(tx, input.projectId);
        return this.cancelQueuedRun(tx, origin);
      }
      if (origin.status !== "completed") return false;
      const child = await tx.workflowRun.findFirst({ where: { projectId: input.projectId, stage: "moment_detection",
        idempotencyKey: `${origin.idempotencyKey}__moment_detection`, contentPackId: origin.contentPackId } });
      if (!child) return false;
      // The Project admission lock precedes both generation row locks.
      await tx.$queryRaw`SELECT "id" FROM "WorkflowRun" WHERE "id" = ${child.id}::uuid FOR UPDATE`;
      const detection = await tx.workflowRun.findUniqueOrThrow({ where: { id: child.id } });
      if (detection.status !== "queued" && detection.status !== "completed") return false;
      await this.lockAdmissionProject(tx, input.projectId);
      if (detection.status === "queued") return this.cancelQueuedRun(tx, detection);
      const history = await tx.workflowEvent.findMany({ where: { projectId: input.projectId,
        OR: [{ workflowRunId: detection.id }, { stage: "clip_rendering" }] }, orderBy: { seq: "desc" }, select: { payload: true } });
      const parsed = history.flatMap((event) => {
        const value = workflowStageUpdatedEventSchema.safeParse(event.payload);
        return value.success && value.data.projectId === input.projectId ? [value.data] : [];
      });
      const handoff = parsed.find((event) => event.workflowRunId === detection.id && event.generationRenders);
      if (!handoff?.generationRenders) return false;
      const settledIds = new Set(parsed.flatMap((event) => (event.generationRenderResults ?? []).map((result) => result.renderId)));
      const outstandingIds = handoff.generationRenders.map((render) => render.renderId).filter((id) => !settledIds.has(id));
      const pending = await tx.clipRender.findMany({ where: { id: { in: outstandingIds }, status: "pending", exportVariantId: null,
        clip: { projectId: input.projectId, workflowRunId: detection.id } }, select: { id: true } });
      const cancelled = await tx.clipRender.updateMany({ where: { id: { in: pending.map((render) => render.id) }, status: "pending", exportVariantId: null,
        clip: { projectId: input.projectId, workflowRunId: detection.id } },
        data: { status: "failed", errorCode: "MCP_CANCELLED", failureDisposition: "permanent", completedAt: new Date() } });
      if (cancelled.count) {
        await this.appendEvent(tx, { projectId: input.projectId, workflowRunId: detection.id,
          attemptId: detection.attemptId ?? detection.id, stage: "moment_detection", status: "completed", progress: 100,
          errorCode: "MCP_CANCELLED", transition: "mcp_render_cancelled",
          generationRenderResults: (await tx.clipRender.findMany({ where: { id: { in: pending.map((render) => render.id) }, errorCode: "MCP_CANCELLED" }, select: { id: true } }))
            .map((render) => ({ renderId: render.id, status: "failed", errorCode: "MCP_CANCELLED" })) });
        await this.emitFinishedOperations(tx, { workflowRunId: detection.id, projectId: input.projectId, stage: "moment_detection" });
      }
      return cancelled.count > 0;
    });
  }

  private async cancelQueuedRun(tx: TransactionClient, run: {
    id: string; projectId: string; stage: string; attemptId: string | null; progress: number;
  }): Promise<boolean> {
      const changed = await tx.workflowRun.updateMany({ where: { id: run.id, status: "queued" },
        data: { status: "failed", errorCode: "MCP_CANCELLED", nextAttemptAt: null, nextPollAt: null } });
      if (!changed.count) return false;
      if (run.stage === "stt") await tx.transcript.updateMany({ where: { projectId: run.projectId, status: "queued" },
        data: { status: "failed", errorCode: "MCP_CANCELLED" } });
      await this.appendEvent(tx, { projectId: run.projectId, workflowRunId: run.id, attemptId: run.attemptId ?? run.id,
        stage: run.stage as WorkflowStage, status: "failed", progress: run.progress, errorCode: "MCP_CANCELLED", transition: "mcp_cancelled" });
      await this.emitFinishedOperations(tx, { workflowRunId: run.id, projectId: run.projectId, stage: run.stage });
      return true;
  }

  async heartbeat(attempt: WorkflowAttemptRef): Promise<void> {
    const updated = await this.prisma.$executeRaw`
      UPDATE "WorkflowRun"
      SET
        "heartbeatAt" = (clock_timestamp() AT TIME ZONE 'UTC'),
        "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + (${this.leaseDurationMs} * INTERVAL '1 millisecond'),
        "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE "id" = ${attempt.workflowRunId}
        AND "projectId" = ${attempt.projectId}::uuid
        AND "stage" = ${attempt.stage}
        AND "status" = 'running'
        AND "attemptId" = ${attempt.attemptId}::uuid
        AND "leaseOwner" = ${this.leaseOwner}
        AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
    `;
    if (updated === 0) throw new WorkflowAttemptLost(attempt);
  }

  async assertOwnership(attempt: WorkflowAttemptRef): Promise<void> {
    const owned = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "WorkflowRun"
      WHERE "id" = ${attempt.workflowRunId}
        AND "projectId" = ${attempt.projectId}::uuid
        AND "stage" = ${attempt.stage}
        AND "attemptId" = ${attempt.attemptId}::uuid
        AND (
          "status" = 'waiting'
          OR (
            "status" = 'running'
            AND "leaseOwner" = ${this.leaseOwner}
            AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
          )
        )
      LIMIT 1
    `;
    if (owned.length === 0) throw new WorkflowAttemptLost(attempt);
  }

  private async requireOwnedExportBundle(
    tx: TransactionClient,
    attempt: WorkflowAttemptRef,
    input: { bundleId: string; operationId: string },
  ) {
    await this.fenceChildMutation(tx, attempt, "export_bundle");
    const bundle = await tx.exportBundle.findFirst({
      where: {
        id: input.bundleId,
        operationId: input.operationId,
        workflowRunId: attempt.workflowRunId,
        operation: { projectId: attempt.projectId },
      },
      select: { id: true },
    });
    if (!bundle) throw new WorkflowAttemptLost(attempt);
  }

  async beginExportBundleBuild(
    attempt: WorkflowAttemptRef,
    input: {
      bundleId: string;
      operationId: string;
      attemptStorageKey: string;
    },
  ): Promise<void> {
    return this.transaction(async (tx) => {
      await this.requireOwnedExportBundle(tx, attempt, input);
      await tx.exportBundle.update({
        where: { id: input.bundleId },
        data: {
          status: "building",
          attemptStorageKey: input.attemptStorageKey,
          errorCode: null,
        },
      });
      await tx.campaignOperationItem.updateMany({
        where: {
          operationId: input.operationId,
          status: "failed",
          errorCode: "export_bundle_build_failed",
        },
        data: { status: "pending", errorCode: null, settledAt: null },
      });
      await tx.campaignOperation.update({
        where: { id: input.operationId },
        data: {
          status: "running",
          succeededCount: 0,
          failedCount: 0,
          completedAt: null,
        },
      });
    });
  }

  async completeExportBundleBuild(
    attempt: WorkflowAttemptRef,
    input: {
      bundleId: string;
      operationId: string;
      storageKey: string;
      sizeBytes: number;
      checksumSha256: string;
      operationStatus: "completed" | "partial";
      succeededCount: number;
    },
  ): Promise<void> {
    return this.transaction(async (tx) => {
      await this.requireOwnedExportBundle(tx, attempt, input);
      const completedAt = await this.databaseNow(tx);
      await tx.campaignOperationItem.updateMany({
        where: { operationId: input.operationId, status: "pending" },
        data: { status: "succeeded", settledAt: completedAt, errorCode: null },
      });
      await tx.exportBundle.update({
        where: { id: input.bundleId },
        data: {
          status: "completed",
          attemptStorageKey: null,
          storageKey: input.storageKey,
          sizeBytes: BigInt(input.sizeBytes),
          checksumSha256: input.checksumSha256,
          completedAt,
          errorCode: null,
        },
      });
      await tx.campaignOperation.update({
        where: { id: input.operationId },
        data: {
          status: input.operationStatus,
          succeededCount: input.succeededCount,
          failedCount: 0,
          completedAt,
        },
      });
    });
  }

  async failExportBundleBuild(
    attempt: WorkflowAttemptRef,
    input: {
      bundleId: string;
      operationId: string;
      errorCode: string;
      failedCount: number;
    },
  ): Promise<void> {
    return this.transaction(async (tx) => {
      await this.requireOwnedExportBundle(tx, attempt, input);
      const completedAt = await this.databaseNow(tx);
      await tx.exportBundle.update({
        where: { id: input.bundleId },
        data: {
          status: "failed",
          attemptStorageKey: null,
          errorCode: input.errorCode,
        },
      });
      await tx.campaignOperationItem.updateMany({
        where: { operationId: input.operationId, status: "pending" },
        data: {
          status: "failed",
          errorCode: input.errorCode,
          settledAt: completedAt,
        },
      });
      await tx.campaignOperation.update({
        where: { id: input.operationId },
        data: {
          status: "failed",
          succeededCount: 0,
          failedCount: input.failedCount,
          completedAt,
        },
      });
    });
  }

  async beginRenderWorkSet(
    attempt: WorkflowAttemptRef,
  ): Promise<RenderWorkSet> {
    return this.transaction(async (tx) => {
      await this.lockAdmissionProject(tx, attempt.projectId);
      await this.fenceChildMutation(tx, attempt, "clip_rendering");
      return this.beginRenderWorkSetWithinTransaction(tx, attempt);
    });
  }

  private async beginRenderWorkSetWithinTransaction(tx: TransactionClient, attempt: Pick<WorkflowAttemptRef, "workflowRunId" | "projectId">): Promise<RenderWorkSet> {
      const run = await tx.workflowRun.findUniqueOrThrow({
        where: { id: attempt.workflowRunId },
        select: { renderWorkSetFrozenAt: true },
      });

      let frozenAt = run.renderWorkSetFrozenAt;
      if (!frozenAt) {
        const candidates = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT render."id"
          FROM "ClipRender" AS render
          INNER JOIN "Clip" AS clip ON clip."id" = render."clipId"
          WHERE clip."projectId" = ${attempt.projectId}::uuid
            AND render."status" = 'pending'
            AND render."workflowRunId" IS NULL
          ORDER BY render."createdAt", render."id"
          FOR UPDATE OF render
        `;
        const candidateIds = candidates.map((candidate) => candidate.id);
        if (candidateIds.length > 0) {
          await tx.clipRender.updateMany({
            where: {
              id: { in: candidateIds },
              status: "pending",
              workflowRunId: null,
            },
            data: { workflowRunId: attempt.workflowRunId },
          });
        }
        frozenAt = await this.databaseNow(tx);
        await tx.workflowRun.update({
          where: { id: attempt.workflowRunId },
          data: {
            renderWorkSetFrozenAt: frozenAt,
            requestedCount: candidateIds.length,
          },
        });
      }

      const variants = await tx.clipRender.findMany({
        where: { workflowRunId: attempt.workflowRunId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      return {
        workflowRunId: attempt.workflowRunId,
        frozenAt,
        variantIds: variants.map((variant) => variant.id),
      };
  }

  /** Freeze and admit the complete partition in one coordinator transaction.
   * Configurations come from the worker's frozen export/entitlement snapshot. */
  async admitRenderGroups(attempt: WorkflowAttemptRef, groups: readonly RenderGroupAdmission[]): Promise<RenderGroupRef[]> {
    return this.transaction(async (tx) => {
      await this.lockAdmissionProject(tx, attempt.projectId);
      await this.fenceChildMutation(tx, attempt, "clip_rendering");
      await this.beginRenderWorkSetWithinTransaction(tx, attempt);
      return admitRenderGroupsWithinTransaction(tx, { workflowRunId: attempt.workflowRunId, projectId: attempt.projectId, groups });
    });
  }

  /**
   * Locks the owning Workflow Run row inside the caller's child-artifact
   * transaction. Reaping and terminal settlement must acquire the same row
   * lock, so ownership cannot change between this check and the child write.
   */
  private async fenceChildMutation(
    tx: TransactionClient,
    attempt: WorkflowAttemptRef,
    expectedStage: WorkflowStage,
  ): Promise<void> {
    if (attempt.stage !== expectedStage) throw new WorkflowAttemptLost(attempt);
    await this.lockAdmissionProject(tx, attempt.projectId);
    const owned = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "WorkflowRun"
      WHERE "id" = ${attempt.workflowRunId}
        AND "projectId" = ${attempt.projectId}::uuid
        AND "status" = 'running'
        AND "attemptId" = ${attempt.attemptId}::uuid
        AND "stage" = ${expectedStage}
        AND "leaseOwner" = ${this.leaseOwner}
        AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
      FOR UPDATE
    `;
    if (owned.length === 0) throw new WorkflowAttemptLost(attempt);
    const current = await tx.workflowRun.findFirst({ where: this.ownedAttemptWhere(attempt, await this.databaseNow(tx)), select: { id: true } });
    if (!current) throw new WorkflowAttemptLost(attempt);
  }

  /** Queues the Workspace Events for operations a run's terminal settlement
   * finished; the transaction wrapper writes them last. Call it after follow-up
   * work is admitted: a lineage is only terminal once nothing is left to drain. */
  private async emitFinishedOperations(
    tx: TransactionClient,
    run: { workflowRunId: string; projectId: string; stage: string },
  ) {
    if (run.stage === "clip_rendering") await queueExportsFinishedByRun(tx, run.workflowRunId);
    if (run.stage === "stt" || run.stage === "moment_detection" || run.stage === "clip_rendering") {
      await queueFinishedGenerations(tx, { id: run.workflowRunId, projectId: run.projectId });
    }
  }

  private async replaceDetectedClipsWithinTransaction(tx: TransactionClient, origin: { projectId: string; workflowRunId: string }, clips: DetectedClipArtifactInput[]) {
      await admitRetiredClipMediaCleanup(
        tx,
        "detected_clip_replacement",
        origin.projectId,
      );
      await tx.clip.deleteMany({ where: { projectId: origin.projectId } });
      if (clips.length > 0) {
        await tx.clip.createMany({
          data: clips.map((clip) => ({
            ...clip,
            projectId: origin.projectId,
            workflowRunId: origin.workflowRunId,
            brollCues:
              clip.brollCues === null || clip.brollCues === undefined
                ? Prisma.JsonNull
                : (clip.brollCues as Prisma.InputJsonValue),
          })),
        });
      }
  }

  async replaceDetectedClips(attempt: WorkflowAttemptRef, clips: DetectedClipArtifactInput[]) {
    await this.transaction(async tx => {
      await this.fenceChildMutation(tx, attempt, "moment_detection");
      await this.replaceDetectedClipsWithinTransaction(tx, attempt, clips);
    });
  }

  /** Runs a domain write in a transaction that only the owning moment
   * detection attempt can commit. */
  async fencedDetectionWrite<T>(
    attempt: WorkflowAttemptRef,
    write: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (tx) => {
      await this.fenceChildMutation(tx, attempt, "moment_detection");
      return write(tx);
    });
  }

  private async admitAutoRenderWorkWithinTransaction(tx: TransactionClient, origin: { projectId: string; workflowRunId: string; eventId: string }, input: { idempotencyKey: string; renders: RenderArtifactInput[] }) {
      if (input.renders.length > 0) {
        const projectClipCount = await tx.clip.count({
          where: {
            projectId: origin.projectId,
            id: { in: input.renders.map((render) => render.clipId) },
          },
        });
        if (
          projectClipCount !==
          new Set(input.renders.map((render) => render.clipId)).size
        ) {
          throw new WorkflowFailure("selection_render_membership_invalid", "permanent", "A selection render belongs to a different Project");
        }
        await tx.clipRender.createMany({
          data: input.renders.map((render) => ({
            ...render,
            aspectRatio: render.aspectRatio as Prisma.ClipRenderCreateManyInput["aspectRatio"],
          })),
          skipDuplicates: true,
        });
      }

      // The variants and their queued render run commit together. They are
      // deliberately not assigned to the detection attempt: beginRenderWorkSet
      // binds them to the render run, and the Render Group lifecycle binds
      // each child to the render attempt that actually owns its mutation.
      await this.lockAdmissionProject(tx, origin.projectId);
      const existing = await tx.workflowRun.findUnique({
        where: {
          projectId_idempotencyKey: {
            projectId: origin.projectId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: { id: true },
      });
      const active = await tx.workflowRun.findFirst({
        where: {
          projectId: origin.projectId,
          stage: "clip_rendering",
          status: { in: ["queued", "running", "waiting"] },
        },
        select: { id: true },
      });
      const admitted = existing ? { id: existing.id, created: false } : active ? { id: active.id, created: false } : await this.admitWithinTransaction(tx, {
        projectId: origin.projectId,
        idempotencyKey: input.idempotencyKey,
        stage: "clip_rendering",
        contentPackId: null,
      });
      const detection = await tx.workflowRun.findUniqueOrThrow({ where: { id: origin.workflowRunId }, select: { progress: true } });
      const generationRenders = await tx.clipRender.findMany({ where: { exportVariantId: null,
        clip: { projectId: origin.projectId, workflowRunId: origin.workflowRunId },
        OR: input.renders.map((render) => ({ clipId: render.clipId, aspectRatio: render.aspectRatio as Prisma.ClipRenderWhereInput["aspectRatio"] })) },
        orderBy: { id: "asc" }, select: { id: true, clipId: true } });
      await this.appendEvent(tx, { projectId: origin.projectId, workflowRunId: origin.workflowRunId,
        attemptId: origin.eventId, stage: "moment_detection", status: "running", progress: detection.progress,
        errorCode: null, transition: `render_handoff:${admitted.id}`, followUpWorkflowRunId: admitted.id,
        generationRenders: generationRenders.map((render) => ({ renderId: render.id, clipId: render.clipId })) });
      await this.dispatchRunWithinTransaction(tx, admitted.id);
      return admitted;
  }

  async admitAutoRenderWork(attempt: WorkflowAttemptRef, input: { idempotencyKey: string; renders: RenderArtifactInput[] }) {
    return this.transaction(async tx => {
      await this.fenceChildMutation(tx, attempt, "moment_detection");
      return this.admitAutoRenderWorkWithinTransaction(tx, { ...attempt, eventId: attempt.attemptId }, input);
    });
  }

  async markDubProcessing(attempt: WorkflowAttemptRef, dubId: string) {
    return this.transaction(async (tx) => {
      await this.fenceChildMutation(tx, attempt, "dubbing");
      // No provider call starts without the dub's own live count.
      const usage = await tx.generatedMediaUsageReservation.findUnique({
        where: { jobId: dubId },
        select: { kind: true, status: true },
      });
      if (usage?.kind !== "dub" || usage.status !== "reserved") {
        await tx.clipDub.updateMany({
          where: { id: dubId, projectId: attempt.projectId, status: "queued" },
          data: {
            status: "failed",
            workflowAttemptId: attempt.attemptId,
            errorCode: "dub_usage_not_reserved",
            completedAt: new Date(),
          },
        });
        return { count: 0 };
      }
      return tx.clipDub.updateMany({
        where: { id: dubId, projectId: attempt.projectId, status: "queued" },
        data: {
          status: "processing",
          workflowAttemptId: attempt.attemptId,
          startedAt: new Date(),
          errorCode: null,
        },
      });
    });
  }

  async completeDub(
    attempt: WorkflowAttemptRef,
    dubId: string,
    data: CompletedDubArtifactInput,
  ) {
    return this.transaction(async (tx) => {
      await this.fenceChildMutation(tx, attempt, "dubbing");
      const completed = await tx.clipDub.updateMany({
        where: {
          id: dubId,
          projectId: attempt.projectId,
          status: "processing",
          workflowAttemptId: attempt.attemptId,
        },
        data,
      });
      // Usable output and its count commit together.
      if (completed.count === 1) {
        await finalizeGenerationUsage(tx, { kind: "dub", jobId: dubId, units: 1 });
      }
      return completed;
    });
  }

  async failDub(
    attempt: WorkflowAttemptRef,
    dubId: string,
    errorCode: string,
  ) {
    return this.transaction(async (tx) => {
      await this.fenceChildMutation(tx, attempt, "dubbing");
      return tx.clipDub.updateMany({
        where: {
          id: dubId,
          projectId: attempt.projectId,
          workflowAttemptId: attempt.attemptId,
        },
        data: { status: "failed", errorCode, completedAt: new Date() },
      });
    });
  }

  /** A graceful shutdown returns owned work after `WORKFLOW_RELEASE_GRACE_MS`
   * instead of a full lease and refunds only this claim's retry. Expired,
   * waiting, and superseded attempts are untouched. */
  async releaseAttempt(attempt: WorkflowAttemptRef, options: {
    /** Controls coordinator/provider claim accounting; media charges belong to groups. */
    refundAttempt?: boolean;
    reason?: string;
  } = {}): Promise<boolean> {
    return this.transaction(tx => this.releaseAttemptWithinTransaction(tx, attempt, options));
  }

  async releaseAttemptWithinTransaction(tx: TransactionClient, attempt: WorkflowAttemptRef, options: { refundAttempt?: boolean; reason?: string } = {}): Promise<boolean> {
      if (attempt.stage === "clip_rendering") await this.lockAdmissionProject(tx, attempt.projectId);
      const now = await this.databaseNow(tx);
      const changed = await tx.workflowRun.updateMany({
        where: {
          id: attempt.workflowRunId, projectId: attempt.projectId, stage: attempt.stage,
          attemptId: attempt.attemptId, status: "running", leaseOwner: this.leaseOwner,
          leaseExpiresAt: { gt: now },
        },
        data: {
          status: "queued", progress: 0, ...(options.refundAttempt !== false ? { attemptCount: { decrement: 1 } } : {}), attemptId: null,
          leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null,
          nextAttemptAt: new Date(now.getTime() + WORKFLOW_RELEASE_GRACE_MS),
          nextPollAt: null, waitingSince: null, errorCode: null,
        },
      });
      if (changed.count === 0) return false;
      await this.settleAttemptChildren(tx, attempt, { requeue: true, errorCode: options.reason ?? "worker_shutdown" });
      if (attempt.stage === "dubbing") {
        const aggregate = await this.dubbingAggregate(tx, attempt);
        await tx.workflowRun.update({ where: { id: attempt.workflowRunId }, data: { succeededCount: aggregate.succeededCount } });
      }
      await this.appendEvent(tx, {
        ...attempt, status: "queued", progress: 0, errorCode: null, transition: "released",
      });
      return true;
  }

  async runAttempt<T>(
    attempt: WorkflowAttemptRef,
    handler: (context: WorkflowAttemptContext) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const execution = { settled: false, finished: false, settlement: undefined as Promise<unknown> | undefined };
    this.executions.set(attempt.attemptId, execution);
    const controller = new AbortController();
    let shutdownRelease: Promise<void> | undefined;
    const stopForWorkerShutdown = () => {
      controller.abort(options.signal?.reason);
      shutdownRelease ??= this.releaseAttempt(attempt).then(() => {}).catch(() => {
        console.warn(JSON.stringify({ level: "error", message: "workflow_shutdown_release_failed",
          workflowRunId: attempt.workflowRunId, attemptId: attempt.attemptId, stage: attempt.stage }));
      });
    };
    if (options.signal?.aborted) {
      stopForWorkerShutdown();
      await shutdownRelease;
      this.executions.delete(attempt.attemptId);
      controller.signal.throwIfAborted();
    }
    options.signal?.addEventListener("abort", stopForWorkerShutdown, { once: true });
    let ownershipError: WorkflowAttemptLost | null = null;
    let checkingOwnershipLoss = false;
    const confirmOwnershipLoss = async (error: WorkflowAttemptLost) => {
      if (checkingOwnershipLoss || execution.settled || execution.finished) return;
      checkingOwnershipLoss = true;
      try {
        // Settlement's fence decides authority while its transaction owns the
        // row. A rejected settlement cannot hide a genuine lease loss.
        await execution.settlement?.catch(() => undefined);
        if (execution.settled || execution.finished) return;
        ownershipError = error;
        controller.abort(error);
      } finally {
        checkingOwnershipLoss = false;
      }
    };
    let heartbeatInFlight = false;
    let lastHeartbeatAt = performance.now();
    const heartbeatTimer = setInterval(() => {
      if (controller.signal.aborted || ownershipError || execution.settled) return;
      // Check the lease even while a database request is still pending.
      if (performance.now() - lastHeartbeatAt >= this.leaseDurationMs) {
        void confirmOwnershipLoss(new WorkflowAttemptLost(attempt));
        return;
      }
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      const heartbeatStartedAt = performance.now();
      void this.heartbeat(attempt)
        .then(() => { lastHeartbeatAt = heartbeatStartedAt; })
        .catch(async (error: unknown) => {
          if (execution.settled || execution.finished) return;
          // A connection error is not evidence that another attempt owns
          // the run. Retry within the lease; durable writes remain fenced.
          if (error instanceof WorkflowAttemptLost || performance.now() - lastHeartbeatAt >= this.leaseDurationMs) {
            await confirmOwnershipLoss(error instanceof WorkflowAttemptLost ? error : new WorkflowAttemptLost(attempt));
            return;
          }
          console.warn(JSON.stringify({
            level: "warn",
            message: "workflow_heartbeat_failed",
            workflowRunId: attempt.workflowRunId,
            attemptId: attempt.attemptId,
            stage: attempt.stage,
          }));
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, this.heartbeatIntervalMs);

    try {
      const result = await handler({
        signal: controller.signal,
        reportProgress: (progress) => this.reportProgress(attempt, progress),
      });
      if (ownershipError) throw ownershipError;
      controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (ownershipError) throw ownershipError;
      throw error;
    } finally {
      execution.finished = true;
      this.executions.delete(attempt.attemptId);
      clearInterval(heartbeatTimer);
      options.signal?.removeEventListener("abort", stopForWorkerShutdown);
      if (options.signal?.aborted) {
        stopForWorkerShutdown();
        await shutdownRelease;
      }
    }
  }

  async claimDueWaitingTranscripts(
    batchSize: number,
    minPollIntervalMs: number,
  ): Promise<WaitingWorkflowAttempt[]> {
    const now = new Date();
    const candidates = await this.prisma.workflowRun.findMany({
      where: {
        stage: "stt",
        status: "waiting",
        nextPollAt: { lte: now },
        attemptId: { not: null },
        // A submission with no provider id yet is claimed too, so the worker can
        // fail it once its deadline passes.
        project: {
          transcript: {
            workflowAttemptId: { not: null },
            status: "processing",
          },
        },
      },
      orderBy: { nextPollAt: "asc" },
      take: batchSize,
      select: {
        id: true,
        deploymentEpoch: true,
        projectId: true,
        stage: true,
        progress: true,
        attemptId: true,
        attemptCount: true,
        waitingSince: true,
        project: {
          select: {
            sourceRevision: true,
            transcript: {
              select: {
                sourceAudioId: true,
                providerJobId: true,
                providerSubmissionDeadlineAt: true,
                workflowAttemptId: true,
                updatedAt: true,
              },
            },
          },
        },
      },
    });
    const claimed: WaitingWorkflowAttempt[] = [];
    for (const run of candidates) {
      const transcript = run.project.transcript;
      if (!run.attemptId || transcript?.workflowAttemptId !== run.attemptId) {
        continue;
      }
      const won = await this.prisma.workflowRun.updateMany({
        where: {
          id: run.id,
          status: "waiting",
          attemptId: run.attemptId,
          nextPollAt: { lte: now },
        },
        data: { nextPollAt: new Date(now.getTime() + minPollIntervalMs) },
      });
      if (won.count === 0) continue;
      claimed.push({
        workflowRunId: run.id,
        projectId: run.projectId,
        stage: "stt",
        attemptId: run.attemptId,
        deploymentEpoch: run.deploymentEpoch,
        sourceRevision: run.project.sourceRevision,
        sourceAudioId: transcript.sourceAudioId,
        attemptCount: run.attemptCount,
        progress: run.progress,
        providerJobId: transcript.providerJobId,
        submissionDeadlineAt: transcript.providerJobId
          ? null
          : transcript.providerSubmissionDeadlineAt,
        submittedAt: run.waitingSince ?? transcript.updatedAt,
      });
    }
    return claimed;
  }

  async reportProgress(attempt: WorkflowAttemptRef, progress: number) {
    await this.transaction(tx => this.reportProgressWithinTransaction(tx, attempt, progress));
  }

  async reportProgressWithinTransaction(tx: TransactionClient, attempt: WorkflowAttemptRef, progress: number): Promise<void> {
    const normalizedProgress = Math.max(0, Math.min(99, Math.round(progress)));
      const databaseNow = await this.databaseNow(tx);
      const run = await tx.workflowRun.findFirst({
        where: {
          ...this.ownedAttemptWhere(attempt, databaseNow),
        },
        select: { status: true },
      });
      if (!run) throw new WorkflowAttemptLost(attempt);
      const won = await tx.workflowRun.updateMany({
        where: {
          ...this.ownedAttemptWhere(attempt, databaseNow),
          status: run.status,
        },
        data: { progress: normalizedProgress },
      });
      if (won.count === 0) throw new WorkflowAttemptLost(attempt);

      await this.appendEvent(tx, {
        projectId: attempt.projectId,
        workflowRunId: attempt.workflowRunId,
        attemptId: attempt.attemptId,
        stage: attempt.stage,
        status: run.status as "running" | "waiting",
        progress: normalizedProgress,
        errorCode: null,
        transition: `progress:${normalizedProgress}`,
      });
  }

  /**
   * Durable intent for an asynchronous provider submission: the run is
   * `waiting` with no provider id and a deadline, before the POST leaves. A
   * crash between the POST and `recordProviderAcceptance` is then recovered by
   * the deadline (`expireUnconfirmedProviderSubmission`) instead of stalling.
   * No lease is held afterwards; callbacks and the worker act lease-free.
   */
  async beginProviderSubmission(attempt: WorkflowAttemptRef, input: { deadline: Date }) {
    if (attempt.stage !== "stt") throw new WorkflowAttemptLost(attempt);
    await this.settlementTransaction(attempt, tx => this.beginProviderSubmissionWithinTransaction(tx, attempt, input));
  }

  async beginProviderSubmissionWithinTransaction(tx: TransactionClient, attempt: WorkflowAttemptRef, input: { deadline: Date }): Promise<void> {
      const databaseNow = await this.databaseNow(tx);
      const won = await tx.workflowRun.updateMany({
        where: {
          ...this.ownedAttemptWhere(attempt, databaseNow),
          status: "running",
        },
        data: {
          status: "waiting",
          progress: 40,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          waitingSince: databaseNow,
          nextPollAt: input.deadline,
        },
      });
      if (won.count === 0) throw new WorkflowAttemptLost(attempt);
      await tx.transcript.updateMany({
        where: { projectId: attempt.projectId },
        data: {
          providerJobId: null,
          providerRequestId: null,
          providerSubmissionDeadlineAt: input.deadline,
          providerSubmittedAt: databaseNow,
          providerResultDeadlineAt: null,
          workflowAttemptId: attempt.attemptId,
          status: "processing",
        },
      });
      await this.appendEvent(tx, {
        projectId: attempt.projectId,
        workflowRunId: attempt.workflowRunId,
        attemptId: attempt.attemptId,
        stage: attempt.stage,
        status: "waiting",
        progress: 40,
        errorCode: null,
        transition: "provider-submission-begun",
      });
  }

  /** Compound STT control is never externally visible with a live generic owner. */
  async beginProviderControlWithinTransaction(tx: TransactionClient, ref: WorkflowExecutionReference, context: ExecutorMutationContext): Promise<ProviderSubmissionIntent> {
    if (ref.stage !== "stt") throw new Error("provider_control_stage_invalid");
    const generic = await tx.executionAttempt.findUniqueOrThrow({ where: { attemptToken: ref.attemptToken }, include: { dispatch: true } });
    if (generic.status !== "admitted" || generic.owner || generic.processStartedAt || generic.revokedAt || generic.functionName !== "stt" ||
      generic.dispatchId !== context.reference.dispatchId || generic.deploymentEpoch !== ref.deploymentEpoch || generic.generation !== ref.generation ||
      generic.inputHash !== context.reference.inputHash || generic.dispatch.subjectKind !== "workflow_run" || generic.dispatch.subjectId !== ref.id) throw new Error("provider_control_reference_lost");
    await this.bindExecutionWithinTransaction(tx, ref, context);
    await tx.executionAttempt.update({ where: { attemptToken: ref.attemptToken }, data: { owner: context.owner, leaseExpiresAt: context.leaseExpiresAt } });
    await this.startExecution(tx, ref, context);
    await tx.executionAttempt.update({ where: { attemptToken: ref.attemptToken }, data: { status: "running", processStartedAt: await this.databaseNow(tx) } });
    return this.beginProviderSubmissionExecution(tx, ref, context);
  }

  /** Resolves the frozen plan under the same domain locks as actual admission. */
  async completeTranscriptionPlanWithinTransaction(tx: TransactionClient, ref: WorkflowExecutionReference): Promise<
    { kind: "speech_to_text"; languageCode: string | null } | { kind: "completed"; dispatchIds: string[] }
  > {
    const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: ref.id } });
    if (run.stage !== "stt" || run.status !== "queued" || run.attemptId || run.leaseOwner || run.generation !== ref.generation || run.deploymentEpoch !== ref.deploymentEpoch) throw new Error("transcript_plan_reference_lost");
    const project = await tx.project.findUniqueOrThrow({ where: { id: run.projectId }, select: { sourceProbe: true, languageCode: true } });
    const pack = run.contentPackId ? await tx.contentPack.findFirst({ where: { id: run.contentPackId, projectId: run.projectId, draft: false } }) : null;
    if (run.contentPackId && !pack) throw new Error("workflow_configuration_missing");
    const probe = sourceProbeSchema.safeParse(project.sourceProbe);
    const plan = planTranscript({ captionedVideo: pack ? parseStoredContentPack(pack).captionedVideo : undefined, sourceProbe: probe.success ? probe.data : null });
    const languageCode = toProviderLanguageCode(project.languageCode);
    if (plan.kind === "speech_to_text") return { kind: "speech_to_text", languageCode };
    const durationSeconds = probe.success ? probe.data.durationSec : null;
    const utterances = plan.kind === "supplied" ? fitSuppliedUtterances(plan.utterances, durationSeconds ?? Infinity) : [];
    await tx.workflowRun.update({ where: { id: run.id }, data: { status: "waiting", attemptId: ref.attemptToken, leaseOwner: null, leaseExpiresAt: null } });
    await tx.transcript.upsert({ where: { projectId: run.projectId }, create: { projectId: run.projectId, workflowAttemptId: ref.attemptToken },
      update: { workflowAttemptId: ref.attemptToken } });
    const childDispatchId = await this.completeTranscriptWithin(tx, { workflowRunId: run.id, projectId: run.projectId, stage: "stt", attemptId: ref.attemptToken, attemptCount: run.attemptCount },
      { provider: plan.kind === "supplied" ? "supplied_captions" : "none", providerModel: null, providerJobId: null, languageCode,
        languageConfidence: null, text: utterances.map(utterance => utterance.text).join(" "), utterances, speakerCount: utterances.length ? 1 : 0, durationSeconds, rawStorageKey: null },
      { id: run.id, status: "waiting", attemptId: ref.attemptToken });
    const reference = (await this.dispatchRunWithinTransaction(tx, run.id)).reference;
    const wake = await this.appendStableExecutionWake(tx, reference, "execution_finished", await this.databaseNow(tx));
    return { kind: "completed", dispatchIds: [childDispatchId, wake.reference.dispatchId] };
  }

  /** Records intent and closes active TS ownership before the single provider POST. */
  async beginProviderSubmissionExecution(tx: TransactionClient, ref: WorkflowExecutionReference, context: ExecutorMutationContext): Promise<ProviderSubmissionIntent> {
    const identity = this.executionAttempt(ref, context);
    const state = await this.executionState(tx, context.reference, ref.attemptToken);
    if (state.kind === "terminal") throw new WorkflowAttemptLost(identity);
    const history = await tx.executionAttempt.findUniqueOrThrow({ where: { attemptToken: ref.attemptToken }, include: { dispatch: true } });
    if (history.dispatchId !== context.reference.dispatchId || history.deploymentEpoch !== ref.deploymentEpoch || history.generation !== ref.generation ||
      history.inputHash !== context.reference.inputHash || history.dispatch.subjectKind !== "workflow_run" || history.dispatch.subjectId !== ref.id || history.functionName !== "stt") throw new WorkflowAttemptLost(identity);
    if (state.run.status === "waiting") {
      if (history.status !== "completed" || !history.revokedAt) throw new Error("provider_wait_execution_not_closed");
      const prior = await tx.transcript.findUniqueOrThrow({ where: { projectId: ref.projectId } });
      if (!prior.providerSubmittedAt || !prior.sourceAudioId) throw new Error("provider_intent_missing");
      const obligations = await tx.executionDispatch.findMany({ where: { subjectKind: "workflow_run", subjectId: ref.id, deploymentEpoch: ref.deploymentEpoch,
        generation: ref.generation, OR: [{ deadlineKind: "provider_submission" }, { wakeKind: "provider_wait" }] }, select: { id: true, deadlineKind: true }, take: 3 });
      if (obligations.length !== 2) throw new Error("provider_intent_obligations_missing");
      obligations.sort((left, right) => Number(left.deadlineKind === null) - Number(right.deadlineKind === null));
      return { kind: "already_waiting", reference: { workflowRunId: ref.id, attemptId: ref.attemptToken, deploymentEpoch: ref.deploymentEpoch,
        sourceRevision: prior.sourceRevision, sourceAudioId: prior.sourceAudioId }, serverTime: prior.providerSubmittedAt,
        submissionDeadlineAt: prior.providerSubmissionDeadlineAt, providerAudioGrantExpiresAt: new Date(prior.providerSubmittedAt.getTime() + 4 * 60 * 60_000),
        dispatchIds: obligations.map(obligation => obligation.id) };
    }
    const { run, attempt, now } = await this.ownedExecution(tx, ref, context);
    if (ref.stage !== "stt") throw new WorkflowAttemptLost(attempt);
    const active = await tx.executionAttempt.findUniqueOrThrow({ where: { attemptToken: ref.attemptToken }, include: { dispatch: true } });
    if (active.dispatchId !== context.reference.dispatchId || active.deploymentEpoch !== ref.deploymentEpoch || active.generation !== ref.generation ||
      active.inputHash !== context.reference.inputHash || active.owner !== context.owner || active.status !== "running" || active.revokedAt || !active.processStartedAt ||
      !active.leaseExpiresAt || active.leaseExpiresAt <= now || active.operationDeadlineAt <= now ||
      active.dispatch.subjectKind !== "workflow_run" || active.dispatch.subjectId !== ref.id) throw new WorkflowAttemptLost(attempt);
    const transcript = await tx.transcript.findUniqueOrThrow({ where: { projectId: run.projectId }, select: { sourceAudioId: true, sourceRevision: true } });
    const project = await tx.project.findUniqueOrThrow({ where: { id: run.projectId }, select: { sourceRevision: true } });
    if (!transcript.sourceAudioId || transcript.sourceRevision !== project.sourceRevision) throw new Error("source_audio_pending");
    const sourceAudio = await tx.sourceAudio.findFirst({ where: { id: transcript.sourceAudioId, projectId: run.projectId, sourceRevision: transcript.sourceRevision } });
    if (!sourceAudio) throw new Error("source_audio_pending");
    const sourceArtifact = await tx.executionArtifact.findUnique({ where: { storageKey: sourceAudio.storageKey } });
    if (!sourceArtifact || sourceArtifact.role !== "source_audio" || !sourceArtifact.committedAt || sourceArtifact.etag !== sourceAudio.etag ||
      sourceArtifact.byteLength !== sourceAudio.byteLength || sourceArtifact.checksumSha256 !== sourceAudio.checksumSha256) throw new Error("source_audio_unverified");
    const reference: ProviderAttemptReference = { workflowRunId: run.id, attemptId: ref.attemptToken, deploymentEpoch: ref.deploymentEpoch,
      sourceRevision: transcript.sourceRevision, sourceAudioId: transcript.sourceAudioId };
    const submissionDeadlineAt = new Date(now.getTime() + 10 * 60_000);
    await this.executionOwner(context.owner).beginProviderSubmissionWithinTransaction(tx, attempt, { deadline: submissionDeadlineAt });
    await tx.executionAttempt.update({ where: { attemptToken: ref.attemptToken }, data: { status: "completed", revokedAt: now, finishedAt: now } });
    const deadline = await appendExecutionDispatch(tx, { deploymentEpoch: ref.deploymentEpoch, kind: "operation_driver", subject: { kind: "workflow_run", id: ref.id },
      generation: ref.generation, inputHash: context.reference.inputHash, dueAt: submissionDeadlineAt, deadlineKind: "provider_submission", observedDeadlineAt: submissionDeadlineAt });
    const wake = await appendExecutionDispatch(tx, { deploymentEpoch: ref.deploymentEpoch, kind: "operation_driver", subject: { kind: "workflow_run", id: ref.id },
      generation: ref.generation, inputHash: context.reference.inputHash, dueAt: now, wakeKind: "provider_wait" });
    const persisted = await tx.transcript.findUniqueOrThrow({ where: { projectId: ref.projectId }, select: { providerSubmittedAt: true } });
    if (!persisted.providerSubmittedAt) throw new Error("provider_intent_missing");
    const providerAudioGrantExpiresAt = new Date(persisted.providerSubmittedAt.getTime() + 4 * 60 * 60_000);
    await tx.executionArtifact.updateMany({ where: { id: sourceArtifact.id, grantExpiresAt: { lt: providerAudioGrantExpiresAt } }, data: { grantExpiresAt: providerAudioGrantExpiresAt } });
    return { kind: "begun", reference, serverTime: persisted.providerSubmittedAt, submissionDeadlineAt, providerAudioGrantExpiresAt,
      dispatchIds: [deadline.reference.dispatchId, wake.reference.dispatchId] };
  }

  /**
   * Records the provider's 202 (`providerJobId` = transcription id, never the
   * request id) and moves the poll to `nextPollAt`. Idempotent, and a no-op for
   * an attempt that is already terminal, superseded, or completed by a
   * callback that beat this write: it never resurrects a run.
   */
  async recordProviderAcceptance(
    key: ProviderAttemptReference,
    input: { requestId: string; transcriptionId: string; nextPollAt: Date },
  ): Promise<ProviderSettlementResult> {
    return this.transaction(async (tx) => {
      const lookup = await this.lockProviderAttempt(tx, key, "accept", {
        requestId: input.requestId,
        transcriptionId: input.transcriptionId,
      });
      if (lookup.kind !== "waiting") return { ...lookup, dispatchIds: await this.providerRecordedWakes(tx, key, "accept") };
      const { attempt } = lookup;
      if (!lookup.submittedAt) throw new Error("provider_intent_missing");
      const resultDeadlineAt = new Date(lookup.submittedAt.getTime() + 2 * 60 * 60_000);
      if (!Number.isFinite(input.nextPollAt.getTime())) throw new Error("provider_check_invalid");
      await tx.transcript.updateMany({
        where: { projectId: attempt.projectId, workflowAttemptId: attempt.attemptId },
        data: {
          providerJobId: input.transcriptionId,
          providerRequestId: input.requestId,
          providerSubmissionDeadlineAt: null,
          providerResultDeadlineAt: resultDeadlineAt,
          status: "processing",
        },
      });
      await tx.workflowRun.updateMany({
        where: { id: attempt.workflowRunId, attemptId: attempt.attemptId, status: "waiting" },
        data: { nextPollAt: new Date(Math.min(input.nextPollAt.getTime(), resultDeadlineAt.getTime())) },
      });
      await this.appendEvent(tx, {
        projectId: attempt.projectId,
        workflowRunId: attempt.workflowRunId,
        attemptId: attempt.attemptId,
        stage: attempt.stage,
        status: "waiting",
        progress: 40,
        errorCode: null,
        transition: "provider-waiting",
      });
      const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: key.workflowRunId } });
      const reference = (await this.dispatchRunWithinTransaction(tx, run.id)).reference;
      const deadline = await appendExecutionDispatch(tx, { deploymentEpoch: run.deploymentEpoch, kind: "operation_driver", subject: reference.subject,
        generation: run.generation, inputHash: reference.inputHash, dueAt: resultDeadlineAt, deadlineKind: "provider_result", observedDeadlineAt: resultDeadlineAt });
      const wake = await this.appendStableExecutionWake(tx, reference, "provider_accepted", await this.databaseNow(tx));
      return { kind: "applied", dispatchIds: [deadline.reference.dispatchId, wake.reference.dispatchId] } as const;
    });
  }

  /** Reads where a provider callback stands, without writing. The finalizer
   * uses it to learn the project before it stores anything. */
  async lookupProviderAttempt(
    key: ProviderAttemptReference,
    ids: ProviderIds = {},
  ): Promise<ProviderAttemptLookup> {
    return this.transaction(async tx => {
      const lookup = await this.classifyProviderAttempt(tx, key, "complete", ids);
      if (lookup.kind === "waiting") return lookup;
      const dispatchIds = await this.providerRecordedWakes(tx, key, "complete");
      return dispatchIds.length ? { ...lookup, dispatchIds } : lookup;
    });
  }

  /** Recovers a completed supplied/empty plan or provider receipt, without new work. */
  async readCompletedTranscriptionWakesWithinTransaction(tx: TransactionClient, reference: ExecutionDispatchReference): Promise<string[]> {
    const ledger = await readExecutionDispatch(tx, reference.dispatchId);
    if (!ledger || ledger.reference.deploymentEpoch !== reference.deploymentEpoch || ledger.reference.generation !== reference.generation ||
      ledger.reference.inputHash !== reference.inputHash || ledger.reference.kind !== reference.kind || reference.kind !== "operation_driver" ||
      ledger.reference.subject.kind !== reference.subject.kind || reference.subject.kind !== "workflow_run" || ledger.reference.subject.id !== reference.subject.id) return [];
    const run = await tx.workflowRun.findUnique({ where: { id: reference.subject.id } });
    if (!run || run.stage !== "stt" || run.status !== "completed" || run.generation !== reference.generation || run.deploymentEpoch !== reference.deploymentEpoch) return [];
    queueProjectProgressCatchup(tx, run.projectId);
    const history = run.attemptId ? await tx.executionAttempt.findUnique({ where: { attemptToken: run.attemptId } }) : null;
    const transcript = await tx.transcript.findUnique({ where: { projectId: run.projectId }, select: { sourceAudioId: true, sourceRevision: true } });
    if (history && run.attemptId && transcript) return this.providerRecordedWakes(tx, { workflowRunId: run.id, attemptId: run.attemptId,
      deploymentEpoch: run.deploymentEpoch, sourceAudioId: transcript.sourceAudioId, sourceRevision: transcript.sourceRevision }, "complete");
    const child = await tx.workflowRun.findUnique({ where: { projectId_idempotencyKey: { projectId: run.projectId, idempotencyKey: `${run.idempotencyKey}__moment_detection` } }, select: { id: true } });
    const records = await tx.executionDispatch.findMany({ where: { deploymentEpoch: reference.deploymentEpoch, OR: [
      { subjectKind: "workflow_run", subjectId: run.id, generation: run.generation, kind: "operation_driver", wakeKind: "execution_finished", inputHash: reference.inputHash },
      ...(child ? [{ subjectKind: "workflow_run", subjectId: child.id, generation: 1, kind: "operation_driver", wakeKind: null, deadlineKind: null }] : []),
    ] }, orderBy: { id: "asc" }, take: 3, select: { id: true } });
    return records.map(row => row.id);
  }

  /** Fresh lease-free provider state for one exact Workflow command. */
  async readProviderControl(key: ProviderAttemptReference): Promise<ProviderControlState> {
    return this.transaction(async tx => {
      const lookup = await this.lockProviderAttempt(tx, key, "fail", {});
      if (lookup.kind !== "waiting") {
        const dispatchIds = await this.providerRecordedWakes(tx, key, "complete");
        return dispatchIds.length ? { ...lookup, dispatchIds } : lookup;
      }
      const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: key.workflowRunId }, select: { nextPollAt: true } });
      return { ...lookup, serverTime: await this.databaseNow(tx), nextCheckAt: run.nextPollAt };
    });
  }

  /** A provider GET observation schedules the next bounded recovery read. */
  async observeProviderPending(key: ProviderAttemptReference, input: { observedCheckAt: Date; intervalMs: number }): Promise<ProviderDeadlineResult> {
    if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1_000 || input.intervalMs > 5 * 60_000 || !Number.isFinite(input.observedCheckAt.getTime())) throw new Error("provider_check_invalid");
    return this.transaction(async tx => {
      const lookup = await this.lockProviderAttempt(tx, key, "fail", {});
      if (lookup.kind !== "waiting") return { ...lookup, dispatchIds: await this.providerRecordedWakes(tx, key, "complete") };
      const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: key.workflowRunId } }), now = await this.databaseNow(tx);
      if (!lookup.providerJobId || !lookup.resultDeadlineAt || !run.nextPollAt) return { kind: "stale", reason: "submission_pending" };
      if (lookup.resultDeadlineAt <= now) {
        await this.failAttemptWithinTransaction(tx, lookup.attempt, new WorkflowFailure("elevenlabs_result_timeout", "retryable", "Transcription provider deadline expired"), {});
        return { kind: "applied", ...await this.providerTransitionWakes(tx, key) };
      }
      const dueAt = run.nextPollAt.getTime() !== input.observedCheckAt.getTime() || run.nextPollAt > now ? run.nextPollAt : new Date(Math.min(now.getTime() + input.intervalMs, lookup.resultDeadlineAt.getTime()));
      if (dueAt.getTime() !== run.nextPollAt.getTime()) await tx.workflowRun.update({ where: { id: run.id }, data: { nextPollAt: dueAt } });
      const reference = (await this.dispatchRunWithinTransaction(tx, run.id)).reference;
      const wake = await appendExecutionDispatch(tx, { deploymentEpoch: run.deploymentEpoch, kind: "operation_driver", subject: reference.subject,
        generation: run.generation, inputHash: reference.inputHash, dueAt, wakeKind: "provider_check", deadlineKind: "retry", observedDeadlineAt: dueAt });
      return { kind: "sleep", dueAt, dispatchIds: [wake.reference.dispatchId] };
    });
  }

  /**
   * Completes a waiting transcript by `(workflowRunId, attemptId)` from a
   * process that holds no lease (the webhook, or the worker's GET recovery).
   * Fenced by the run, the attempt, and the provider ids in `input`; an id the
   * delivery omits keeps its recorded value.
   */
  async completeProviderTranscript(
    key: ProviderAttemptReference,
    input: CompleteTranscriptInput,
  ): Promise<ProviderSettlementResult> {
    return this.transaction(async (tx) => {
      const lookup = await this.lockProviderAttempt(tx, key, "complete", {
        requestId: input.providerRequestId,
        transcriptionId: input.providerJobId,
      });
      if (lookup.kind !== "waiting") return { ...lookup, dispatchIds: await this.providerRecordedWakes(tx, key, "complete") };
      // The row is locked: ids recorded by an acceptance that raced this
      // completion survive a delivery that does not carry them.
      const childDispatchId = await this.completeTranscriptWithin(
        tx,
        lookup.attempt,
        {
          ...input,
          providerJobId: input.providerJobId ?? lookup.providerJobId,
          providerRequestId: input.providerRequestId ?? lookup.providerRequestId,
        },
        this.waitingAttemptWhere(lookup.attempt),
      );
      const wakes = await this.providerTransitionWakes(tx, key);
      return { kind: "applied", dispatchIds: [childDispatchId, ...wakes.dispatchIds] } as const;
    });
  }

  /** Fails a waiting provider attempt (a `webhook_error`, a permanent provider
   * result) with the normal retry policy: retryable failures requeue. */
  async failProviderAttempt(
    key: ProviderAttemptReference,
    failure: WorkflowFailure,
    ids: ProviderIds = {},
  ): Promise<ProviderSettlementResult> {
    return this.transaction(async (tx) => {
      const lookup = await this.lockProviderAttempt(tx, key, "fail", ids);
      if (lookup.kind !== "waiting") return { ...lookup, dispatchIds: await this.providerRecordedWakes(tx, key, "fail") };
      await this.failAttemptWithinTransaction(tx, lookup.attempt, failure, {});
      return { kind: "applied", ...await this.providerTransitionWakes(tx, key) } as const;
    });
  }

  private async providerTransitionWakes(tx: TransactionClient, key: ProviderAttemptReference): Promise<{ dispatchIds: string[] }> {
    const history = await tx.executionAttempt.findUniqueOrThrow({ where: { attemptToken: key.attemptId }, include: { dispatch: true } });
    const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: key.workflowRunId } });
    if (history.dispatch.subjectKind !== "workflow_run" || history.dispatch.subjectId !== run.id || history.deploymentEpoch !== key.deploymentEpoch ||
      run.deploymentEpoch !== key.deploymentEpoch || run.generation !== history.generation) throw new Error("provider_execution_lineage_lost");
    const own = await this.executionWakes(tx, { id: run.id, projectId: run.projectId, stage: "stt", deploymentEpoch: run.deploymentEpoch,
      generation: history.generation, attemptToken: key.attemptId }, history.inputHash, run.status === "queued");
    const capacity = await appendScribeCapacityWakesWithinTransaction(tx, { deploymentEpoch: key.deploymentEpoch, attemptId: key.attemptId });
    return { dispatchIds: [...own.dispatchIds, ...capacity.dispatchIds] };
  }

  /** Replays only immutable wake obligations; it grants no provider permission. */
  private async providerRecordedWakes(tx: TransactionClient, key: ProviderAttemptReference, intent: ProviderSettlementIntent): Promise<string[]> {
    if (!validProviderReference(key)) return [];
    const history = await tx.executionAttempt.findUnique({ where: { attemptToken: key.attemptId }, include: { dispatch: true } });
    const run = await tx.workflowRun.findUnique({ where: { id: key.workflowRunId } });
    const epoch = await tx.executionEpoch.findUnique({ where: { id: 1 } });
    if (!history || !run || epoch?.epoch !== key.deploymentEpoch || history.deploymentEpoch !== key.deploymentEpoch || run.deploymentEpoch !== key.deploymentEpoch ||
      history.functionName !== "stt" || history.dispatch.subjectKind !== "workflow_run" || history.dispatch.subjectId !== run.id) return [];
    // Historical receipt replay compares the frozen tuple itself. A newer
    // Transcript cannot erase delivery obligations already committed by it.
    const expectedHash = await workflowRunExecutionInputHash({ id: run.id, projectId: run.projectId, stage: run.stage, contentPackId: run.contentPackId,
      deploymentEpoch: history.deploymentEpoch, generation: history.generation, sourceAudioId: key.sourceAudioId, sourceRevision: key.sourceRevision });
    if (expectedHash !== history.inputHash) return [];
    queueProjectProgressCatchup(tx, run.projectId);
    const own = await tx.executionDispatch.findMany({ where: { deploymentEpoch: key.deploymentEpoch, subjectKind: "workflow_run", subjectId: run.id,
      generation: history.generation, ...(intent === "accept" ? { OR: [{ deadlineKind: "provider_result" }, { wakeKind: "provider_accepted" }] } : { wakeKind: "execution_finished" }) },
      orderBy: { id: "asc" }, take: 3 });
    const ids = own.map(row => row.id);
    if (intent === "accept" || !own.length) return ids;
    const next = await tx.executionDispatch.findFirst({ where: { deploymentEpoch: key.deploymentEpoch, subjectKind: "workflow_run", subjectId: run.id,
      generation: history.generation + 1, kind: "operation_driver", wakeKind: null, deadlineKind: null } });
    if (next) ids.push(next.id);
    {
      const child = await tx.workflowRun.findUnique({ where: { projectId_idempotencyKey: { projectId: run.projectId, idempotencyKey: `${run.idempotencyKey}__moment_detection` } } });
      if (child) {
        const first = await tx.executionDispatch.findFirst({ where: { deploymentEpoch: key.deploymentEpoch, subjectKind: "workflow_run", subjectId: child.id,
          generation: 1, kind: "operation_driver", wakeKind: null, deadlineKind: null } });
        if (first) ids.push(first.id);
      }
    }
    ids.push(...(await tx.executionDispatch.findMany({ where: { deploymentEpoch: key.deploymentEpoch,
      OR: [{ wakeKind: `cap_${key.attemptId.replaceAll("-", "")}` }, { wakeKind: `stt_${key.attemptId.replaceAll("-", "")}` }] },
      orderBy: { createdAt: "asc" }, take: 101, select: { id: true } })).map(row => row.id));
    return ids;
  }

  /** Provider deadlines are separate from the already-closed TS execution. */
  async expireProviderDeadline(key: ProviderAttemptReference, observation: { kind: "submission" | "result"; observedDeadlineAt: Date }): Promise<ProviderDeadlineResult> {
    return this.transaction(async tx => {
      const lookup = await this.lockProviderAttempt(tx, key, "fail", {});
      if (lookup.kind !== "waiting") return { ...lookup, dispatchIds: await this.providerRecordedWakes(tx, key, "fail") };
      if (observation.kind === "submission" && lookup.providerJobId) return { kind: "stale", reason: "submission_confirmed" };
      const dueAt = observation.kind === "submission" ? lookup.submissionDeadlineAt : lookup.resultDeadlineAt;
      if (!dueAt || !Number.isFinite(observation.observedDeadlineAt.getTime()) || observation.observedDeadlineAt.getTime() !== dueAt.getTime()) return { kind: "stale", reason: "submission_pending" };
      if (dueAt > await this.databaseNow(tx)) return { kind: "sleep", dueAt };
      const code = observation.kind === "submission" ? "elevenlabs_submission_unconfirmed" : "elevenlabs_result_timeout";
      await this.failAttemptWithinTransaction(tx, lookup.attempt, new WorkflowFailure(code, "retryable", "Transcription provider deadline expired"), {});
      return { kind: "applied", ...await this.providerTransitionWakes(tx, key) };
    });
  }

  /**
   * Fails a submission whose acceptance was never recorded once its deadline
   * has passed (`elevenlabs_submission_unconfirmed`, retryable). Not due, or
   * accepted in the meantime, is a no-op.
   */
  async expireUnconfirmedProviderSubmission(
    key: ProviderAttemptReference,
  ): Promise<ProviderSettlementResult> {
    return this.transaction(async (tx) => {
      const lookup = await this.lockProviderAttempt(tx, key, "fail", {});
      if (lookup.kind !== "waiting") return lookup;
      if (lookup.providerJobId) {
        return { kind: "stale", reason: "submission_confirmed" } as const;
      }
      const databaseNow = await this.databaseNow(tx);
      if (
        !lookup.submissionDeadlineAt ||
        lookup.submissionDeadlineAt.getTime() > databaseNow.getTime()
      ) {
        return { kind: "stale", reason: "submission_pending" } as const;
      }
      await this.failAttemptWithinTransaction(
        tx,
        lookup.attempt,
        new WorkflowFailure(
          "elevenlabs_submission_unconfirmed",
          "retryable",
          "The transcription request was not confirmed before its deadline",
        ),
        {},
      );
      return { kind: "applied", ...await this.providerTransitionWakes(tx, key) } as const;
    });
  }

  /** A waiting run needs no lease: this is `ownedAttemptWhere`'s waiting arm,
   * without widening that predicate for running work. */
  private waitingAttemptWhere(
    attempt: WorkflowAttemptRef,
  ): Prisma.WorkflowRunWhereInput {
    return {
      id: attempt.workflowRunId,
      projectId: attempt.projectId,
      stage: attempt.stage,
      attemptId: attempt.attemptId,
      status: "waiting",
    };
  }

  private async lockProviderAttempt(
    tx: TransactionClient,
    key: ProviderAttemptReference,
    intent: ProviderSettlementIntent,
    ids: ProviderIds,
  ): Promise<ProviderAttemptLookup> {
    if (!validProviderReference(key)) return { kind: "stale", reason: "invalid_reference" };
    const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id" = 1 FOR SHARE`;
    if (!epoch || epoch.epoch !== key.deploymentEpoch) return { kind: "stale", reason: "epoch_superseded" };
    const run = await tx.workflowRun.findUnique({ where: { id: key.workflowRunId }, include: { project: { select: { workspaceId: true } } } });
    if (!run) return { kind: "stale", reason: "run_missing" };
    await lockWorkspaceUsage(tx, run.project.workspaceId);
    await this.lockAdmissionProject(tx, run.projectId);
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${run.projectId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "WorkflowRun" WHERE "id" = ${key.workflowRunId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Transcript" WHERE "projectId" = ${run.projectId}::uuid FOR UPDATE`;
    return this.classifyProviderAttempt(tx, key, intent, ids);
  }

  private async classifyProviderAttempt(
    db: PrismaClient | TransactionClient,
    key: ProviderAttemptReference,
    intent: ProviderSettlementIntent,
    ids: ProviderIds,
  ): Promise<ProviderAttemptLookup> {
    if (!validProviderReference(key)) return { kind: "stale", reason: "invalid_reference" };
    const epoch = await db.executionEpoch.findUnique({ where: { id: 1 }, select: { epoch: true } });
    if (epoch?.epoch !== key.deploymentEpoch) return { kind: "stale", reason: "epoch_superseded" };
    const run = await db.workflowRun.findUnique({
      where: { id: key.workflowRunId },
      select: {
        id: true,
        deploymentEpoch: true,
        project: { select: { sourceRevision: true, ingestStatus: true } },
        projectId: true,
        stage: true,
        status: true,
        attemptId: true,
        attemptCount: true,
      },
    });
    if (!run || run.stage !== "stt") {
      return { kind: "stale", reason: "run_missing" };
    }
    if (run.deploymentEpoch !== key.deploymentEpoch) return { kind: "stale", reason: "epoch_superseded" };
    if (run.project.sourceRevision !== key.sourceRevision || run.project.ingestStatus === "failed") return { kind: "stale", reason: "source_superseded" };
    if (run.attemptId !== key.attemptId) {
      return { kind: "stale", reason: "attempt_superseded" };
    }
    const status = run.status as WorkflowStatus;
    const transcript = await db.transcript.findUnique({
      where: { projectId: run.projectId },
      select: {
        workflowAttemptId: true,
        sourceAudioId: true,
        sourceRevision: true,
        providerJobId: true,
        providerRequestId: true,
        providerSubmissionDeadlineAt: true,
        providerResultDeadlineAt: true,
        providerSubmittedAt: true,
      },
    });
    if (transcript && (transcript.sourceRevision !== key.sourceRevision || transcript.sourceAudioId !== key.sourceAudioId)) return { kind: "stale", reason: "source_superseded" };
    if (status === "queued" || status === "running") {
      return { kind: "stale", reason: "not_waiting" };
    }
    if (status !== "waiting") {
      // A completion that lands twice, or an acceptance recorded after the
      // callback completed the run, is a duplicate; anything else is terminal.
      return status === "completed" && intent !== "fail"
        ? { kind: "duplicate" }
        : { kind: "terminal", status };
    }
    if (transcript?.workflowAttemptId !== run.attemptId) {
      return { kind: "stale", reason: "attempt_superseded" };
    }
    const differs = (recorded: string | null, supplied: string | null | undefined) =>
      Boolean(recorded && supplied && recorded !== supplied);
    if (
      differs(transcript.providerJobId, ids.transcriptionId) ||
      differs(transcript.providerRequestId, ids.requestId)
    ) {
      return { kind: "stale", reason: "provider_job_mismatch" };
    }
    if (intent !== "fail") {
      const [clock] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
      const deadline = transcript.providerJobId ? transcript.providerResultDeadlineAt : transcript.providerSubmissionDeadlineAt;
      if (!clock || !deadline || deadline <= clock.now) return { kind: "stale", reason: "provider_deadline_expired" };
    }
    if (
      intent === "accept" &&
      transcript.providerJobId &&
      transcript.providerJobId === ids.transcriptionId
    ) {
      return { kind: "duplicate" };
    }
    return {
      kind: "waiting",
      attempt: {
        workflowRunId: run.id,
        projectId: run.projectId,
        stage: "stt",
        attemptId: run.attemptId,
        attemptCount: run.attemptCount,
      },
      providerJobId: transcript.providerJobId,
      providerRequestId: transcript.providerRequestId,
      submissionDeadlineAt: transcript.providerSubmissionDeadlineAt,
      resultDeadlineAt: transcript.providerResultDeadlineAt,
      submittedAt: transcript.providerSubmittedAt,
    };
  }

  async completeStage(attempt: WorkflowAttemptRef) {
    await this.settleSuccess(attempt, "completed", null);
  }

  async completeTranscript(
    attempt: WorkflowAttemptRef,
    input: CompleteTranscriptInput,
  ) {
    await this.settlementTransaction(attempt, async (tx) => {
      const databaseNow = await this.databaseNow(tx);
      await this.completeTranscriptWithin(
        tx,
        attempt,
        input,
        this.ownedAttemptWhere(attempt, databaseNow),
      );
    });
  }

  private async completeTranscriptWithin(
    tx: TransactionClient,
    attempt: WorkflowAttemptRef,
    input: CompleteTranscriptInput,
    owned: Prisma.WorkflowRunWhereInput,
  ) {
    const run = await tx.workflowRun.findFirst({
      where: { ...owned, stage: "stt" },
    });
    if (!run) throw new WorkflowAttemptLost(attempt);

    const currentTranscript = await tx.transcript.findUnique({
      where: { projectId: attempt.projectId },
      select: { workflowAttemptId: true, providerJobId: true },
    });
    if (
      currentTranscript?.workflowAttemptId !== attempt.attemptId ||
      (input.providerJobId &&
        currentTranscript.providerJobId &&
        currentTranscript.providerJobId !== input.providerJobId)
    ) {
      throw new WorkflowAttemptLost(attempt);
    }

    const completedAt = new Date();
    const completedFields = {
      status: "completed" as const,
      workflowAttemptId: attempt.attemptId,
      provider: input.provider,
      providerModel: input.providerModel,
      providerJobId: input.providerJobId,
      ...(input.providerRequestId !== undefined
        ? { providerRequestId: input.providerRequestId }
        : {}),
      providerSubmissionDeadlineAt: null,
      languageCode: input.languageCode,
      languageConfidence: input.languageConfidence,
      text: input.text,
      utterancesJson: input.utterances as Prisma.InputJsonValue,
      speakerCount: input.speakerCount,
      durationSeconds: input.durationSeconds,
      rawStorageKey: input.rawStorageKey,
      errorCode: null,
      completedAt,
    };
    await tx.transcript.upsert({
      where: { projectId: attempt.projectId },
      create: { projectId: attempt.projectId, ...completedFields },
      update: { ...completedFields, selectionGeneration: { increment: 1 } },
    });
    if (input.durationSeconds && input.durationSeconds > 0) {
      await tx.project.updateMany({
        where: { id: attempt.projectId, sourceDurationSeconds: null },
        data: { sourceDurationSeconds: input.durationSeconds },
      });
    }

    const childIdempotencyKey = `${run.idempotencyKey}__moment_detection`;
    const child = await tx.workflowRun.upsert({
      where: {
        projectId_idempotencyKey: {
          projectId: attempt.projectId,
          idempotencyKey: childIdempotencyKey,
        },
      },
      create: {
        deploymentEpoch: run.deploymentEpoch,
        projectId: attempt.projectId,
        idempotencyKey: childIdempotencyKey,
        stage: "moment_detection",
        status: "queued",
        progress: 0,
        contentPackId: run.contentPackId,
      },
      update: {},
      select: { id: true, attemptId: true },
    });

    const won = await tx.workflowRun.updateMany({
      where: { ...owned, id: run.id },
      data: {
        status: "completed",
        progress: 100,
        errorCode: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        nextPollAt: null,
      },
    });
    if (won.count === 0) throw new WorkflowAttemptLost(attempt);

    await this.appendEvent(tx, {
      projectId: attempt.projectId,
      workflowRunId: attempt.workflowRunId,
      attemptId: attempt.attemptId,
      stage: "stt",
      status: "completed",
      progress: 100,
      errorCode: null,
      transition: "terminal:completed",
      analyticsRequired: true,
    });
    await this.appendEvent(tx, {
      projectId: attempt.projectId,
      workflowRunId: child.id,
      attemptId: attempt.attemptId,
      stage: "moment_detection",
      status: "queued",
      progress: 0,
      errorCode: null,
      transition: `child:${child.id}:queued`,
    });
    return (await this.dispatchRunWithinTransaction(tx, child.id)).reference.dispatchId;
  }

  /**
   * Completes a moment-detection attempt. `admit` is the domain write the
   * completion cannot be separated from: a captioned video's export. It runs in
   * the same transaction, so the export becomes visible exactly when the run
   * is completed, and a crash or retry of detection leaves no export behind.
   * The export is frozen into the completion event.
   */
  async completeMomentDetection(
    attempt: WorkflowAttemptRef,
    options: { admit?: (tx: TransactionClient) => Promise<{ exportId: string; clipId: string }> } = {},
  ) {
    await this.settleSuccess(attempt, "completed", null, options.admit);
  }

  /** Verified private results become Clips, render obligations and one terminal event together. */
  async finalizeClipSelection(reference: ExecutionDispatchReference, prepared: PreparedClipSelectionFinalization | null): Promise<ClipSelectionFinalizationResult> {
    return this.transaction(async tx => {
      const state = await lockClipSelectionParent(tx, reference);
      if (!state) return { kind: "superseded", dispatchIds: [] };
      const { run, project, now, transcript } = state;
      queueProjectProgressCatchup(tx, project.id);
      await tx.$queryRaw`SELECT id FROM "ClipSelectionWindow" WHERE "workflowRunId" = ${run.id}::uuid AND "workflowGeneration" = ${run.generation} ORDER BY id FOR UPDATE`;
      const windows = await tx.clipSelectionWindow.findMany({ where: { workflowRunId: run.id, workflowGeneration: run.generation, deploymentEpoch: run.deploymentEpoch }, orderBy: { windowIndex: "asc" } });
      if (!windows.length) return { kind: "not_prepared", dispatchIds: [] };
      const first = windows[0]!;
      if (windows.length !== first.windowCount || windows.some((window, index) => window.windowIndex !== index || window.selectionHash !== first.selectionHash || window.transcriptId !== transcript.id ||
        window.transcriptGeneration !== transcript.selectionGeneration || window.transcriptAttemptId !== transcript.workflowAttemptId || window.sourceRevision !== transcript.sourceRevision || window.sourceAudioId !== transcript.sourceAudioId ||
        window.sourceAudioBindingHash !== (transcript.sourceAudio?.bindingHash ?? null) || window.transcriptContentHash !== first.transcriptContentHash) || first.transcriptContentHash !== await clipSelectionTranscriptHash(transcript)) return { kind: "superseded", dispatchIds: [] };
      // This stable UUID correlates events. It is never an executor token or a parent lease.
      const origin = { projectId: project.id, workflowRunId: run.id, eventId: first.id };
      const replayWakes = async () => {
        const handoff = await tx.workflowEvent.findFirst({ where: { workflowRunId: run.id, dedupeKey: { startsWith: `${run.id}:${origin.eventId}:render_handoff:` } }, orderBy: { seq: "desc" }, select: { payload: true } });
        if (!handoff) return [];
        const event = workflowStageUpdatedEventSchema.parse(handoff.payload);
        return event.followUpWorkflowRunId ? [(await this.dispatchRunWithinTransaction(tx, event.followUpWorkflowRunId)).reference.dispatchId] : [];
      };
      if (["completed", "failed", "cancelled"].includes(run.status)) return { kind: run.status as "completed" | "failed" | "cancelled", dispatchIds: await replayWakes() };
      const failed = windows.find(window => window.status === "failed" || window.status === "cancelled");
      if (!failed && windows.some(window => window.status !== "completed")) {
        const progress = 20 + Math.round(windows.filter(window => window.status === "completed").length / windows.length * 60);
        await tx.workflowRun.update({ where: { id: run.id }, data: { progress } });
        await this.appendEvent(tx, { projectId: project.id, workflowRunId: run.id, attemptId: origin.eventId, stage: "moment_detection", status: "waiting", progress,
          errorCode: null, transition: `selection_progress:${progress}` });
        const deadlines = windows.filter(window => window.status === "queued" || window.status === "running").map(window => window.leaseExpiresAt ?? (window.retryAt && window.retryAt > now ? window.retryAt : window.operationDeadlineAt));
        return { kind: "wait", dueAt: new Date(Math.min(...deadlines.map(deadline => deadline.getTime()))), dispatchIds: [] };
      }
      if (!failed) {
        if (!prepared) return { kind: "not_prepared", dispatchIds: [] };
        const { proof } = prepared;
        if (proof.selectionHash !== first.selectionHash || proof.windows.length !== windows.length || windows.some(window => {
          const result = proof.windows.find(candidate => candidate.id === window.id);
          return window.inputStorageKey !== proof.input.storageKey || window.inputEtag !== proof.input.etag || window.inputChecksumSha256 !== proof.input.sha256 || window.inputByteLength !== BigInt(proof.input.byteLength) ||
            !result || result.generation !== window.generation || result.windowIndex !== window.windowIndex || result.result.storageKey !== window.resultStorageKey || result.result.etag !== window.resultEtag ||
            result.result.sha256 !== window.resultHash || BigInt(result.result.byteLength) !== window.resultByteLength || result.tokensUsed !== window.tokensUsed || result.providerRequestId !== window.providerRequestId;
        })) throw new Error("selection_finalization_proof_conflict");
      }
      const failureCode = failed?.errorCode ?? (prepared?.outcome.kind === "failure" ? prepared.outcome.code : null);
      let generationExport: { exportId: string; clipId: string } | undefined;
      const dispatchIds: string[] = [];
      if (failed || failureCode) {
        dispatchIds.push(...await cancelClipSelectionWindowsWithinTransaction(tx, { projectId: project.id, workflowRunId: run.id, deploymentEpoch: run.deploymentEpoch,
          errorCode: failureCode ?? "selection_window_failed", now, cause: origin.eventId }));
      } else {
        if (!prepared || prepared.outcome.kind !== "clips" || !prepared.outcome.clips.length) throw new Error("selection_finalization_clips_missing");
        await this.replaceDetectedClipsWithinTransaction(tx, origin, prepared.outcome.clips);
        const pack = prepared.outcome.contentPack;
        let renders: RenderArtifactInput[] = [];
        if (pack.mode === "caption_only" && pack.captionedVideo) generationExport = await admitCaptionedExportWithinTransaction(tx, origin, pack.captionedVideo);
        else {
          const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: project.workspaceId }, select: { pricingTier: true } });
          const resolution = resolveClipExportOutput(resolvePricingTier(workspace.pricingTier), "1080p").granted.resolution;
          const clips = await tx.clip.findMany({ where: { projectId: project.id, workflowRunId: run.id }, orderBy: { index: "asc" }, select: { id: true } });
          renders = clips.map(clip => ({ clipId: clip.id, aspectRatio: clipAspectRatioToDb[pack.defaultAspectRatio], resolution, status: "pending" }));
        }
        const render = await this.admitAutoRenderWorkWithinTransaction(tx, origin, { idempotencyKey: `auto-render-${run.id}`, renders });
        dispatchIds.push((await this.dispatchRunWithinTransaction(tx, render.id)).reference.dispatchId);
      }
      const status = failed || failureCode ? "failed" : "completed";
      await tx.workflowRun.update({ where: { id: run.id }, data: { status, progress: 100, errorCode: status === "failed" ? failureCode ?? "selection_window_failed" : null,
        attemptId: null, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, nextAttemptAt: null, nextPollAt: null } });
      await this.appendEvent(tx, { projectId: project.id, workflowRunId: run.id, attemptId: origin.eventId, stage: "moment_detection", status, progress: 100,
        errorCode: status === "failed" ? failureCode ?? "selection_window_failed" : null, transition: `terminal:${status}`, analyticsRequired: true, ...(generationExport ? { generationExport } : {}) });
      await this.emitFinishedOperations(tx, { workflowRunId: run.id, projectId: project.id, stage: "moment_detection" });
      return { kind: status, dispatchIds };
    });
  }

  private async lockRenderRun(tx: TransactionClient, reference: ExecutionDispatchReference): Promise<
    { run: WorkflowRun; project: Project; now: Date } | null
  > {
    const parsed = executionDispatchReferenceSchema.safeParse(reference);
    if (!parsed.success || reference.kind !== "render_run" || !["workflow_run", "render_group"].includes(reference.subject.kind)) return null;
    const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id" = 1 FOR SHARE`;
    if (!epoch || reference.deploymentEpoch !== epoch.epoch) return null;
    const ledger = (await readExecutionDispatch(tx, reference.dispatchId))?.reference;
    if (!ledger || ledger.kind !== reference.kind || ledger.subject.kind !== reference.subject.kind || ledger.subject.id !== reference.subject.id ||
      ledger.deploymentEpoch !== reference.deploymentEpoch || ledger.generation !== reference.generation || ledger.inputHash !== reference.inputHash) return null;
    const initialGroup = reference.subject.kind === "render_group" ? await tx.renderGroup.findUnique({ where: { id: reference.subject.id } }) : null;
    const id = reference.subject.kind === "workflow_run" ? reference.subject.id : initialGroup?.workflowRunId;
    if (!id) return null;
    const initial = await tx.workflowRun.findUnique({ where: { id }, include: { project: { select: { workspaceId: true } } } });
    if (!initial) return null;
    await lockWorkspaceUsage(tx, initial.project.workspaceId);
    await this.lockAdmissionProject(tx, initial.projectId);
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${initial.projectId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "WorkflowRun" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (initialGroup) await tx.$queryRaw`SELECT "id" FROM "RenderGroup" WHERE "id" = ${initialGroup.id}::uuid FOR UPDATE`;
    const now = await this.databaseNow(tx);
    const run = await tx.workflowRun.findUniqueOrThrow({ where: { id } });
    const project = await tx.project.findFirst({ where: { id: run.projectId, ...accessibleProjectWhere(now), workspace: { status: "active" } } });
    if (!project || run.stage !== "clip_rendering" || run.deploymentEpoch !== epoch.epoch) return null;
    if (initialGroup) {
      const group = await tx.renderGroup.findUnique({ where: { id: initialGroup.id } });
      if (!group || group.workflowRunId !== run.id || group.workSetGeneration !== run.renderWorkSetGeneration ||
        group.generation !== reference.generation || group.deploymentEpoch !== reference.deploymentEpoch) return null;
    } else if (run.generation !== reference.generation) return null;
    return { run, project, now };
  }

  /** Short parent command: frozen membership and all child obligations commit together. */
  async prepareRenderRun(reference: ExecutionDispatchReference, configurations: readonly RenderGroupAdmission[]): Promise<RenderRunPreparation> {
    return this.transaction(async (tx) => {
      const state = await this.lockRenderRun(tx, reference);
      if (!state) return { kind: "superseded", dispatchIds: [] };
      queueProjectProgressCatchup(tx, state.run.projectId);
      const { run, project } = state;
      if (["completed", "partial", "failed", "cancelled"].includes(run.status)) return { kind: "terminal", dispatchIds: [] };
      if (project.ingestStatus !== "ready" || !project.sourceStorageKey) return { kind: "waiting_for_video", dispatchIds: [] };
      const workSet = await this.beginRenderWorkSetWithinTransaction(tx, { workflowRunId: run.id, projectId: run.projectId });
      const groups = await admitRenderGroupsWithinTransaction(tx, { workflowRunId: run.id, projectId: run.projectId, groups: configurations });
      await tx.workflowRun.update({ where: { id: run.id }, data: { status: "waiting", attemptId: null, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, nextAttemptAt: null } });
      const parent = await this.dispatchRunWithinTransaction(tx, run.id);
      const dispatchIds: string[] = [];
      for (const ref of groups) {
        const group = await tx.renderGroup.findUniqueOrThrow({ where: { id: ref.groupId }, include: { members: { select: { clipRenderId: true } } } });
        const configuration = configurations.find(candidate => candidate.configuration.clipId === group.clipId && renderGroupExportIdentity(candidate.configuration) === group.exportIdentity)?.configuration;
        if (!configuration) throw new Error("render_group_configuration_missing");
        if (!["queued", "running"].includes(group.status)) continue;
        const identity = { deploymentEpoch: group.deploymentEpoch, kind: "operation_driver" as const, subject: { kind: "render_group" as const, id: group.id }, generation: group.generation };
        const key = await executionDispatchIdentity(identity);
        const existing = await tx.executionDispatch.findUnique({ where: { deliveryKey: key.deliveryKey }, select: { dueAt: true } });
        const dispatch = await appendExecutionDispatch(tx, { ...identity,
          inputHash: await renderGroupExecutionInputHash({ ...ref, parentInputHash: parent.reference.inputHash, exportIdentity: group.exportIdentity,
            memberIds: group.members.map(member => member.clipRenderId), configuration }),
          dueAt: existing?.dueAt ?? group.nextAttemptAt ?? group.createdAt });
        dispatchIds.push(dispatch.reference.dispatchId);
      }
      return { kind: "prepared", workSet, groups, dispatchIds };
    });
  }

  /** Parent waits are durable Workflow waits; this command never acquires a SQL lease. */
  async settleRenderRun(reference: ExecutionDispatchReference): Promise<RenderRunSettlement> {
    return this.transaction(async (tx) => {
      const state = await this.lockRenderRun(tx, reference);
      if (!state) return { kind: "superseded", dispatchIds: [] };
      queueProjectProgressCatchup(tx, state.run.projectId);
      if (state.run.status === "cancelled") return { kind: "superseded", dispatchIds: [] };
      if (!state.run.renderWorkSetGeneration || !state.run.renderWorkSetFrozenAt) return { kind: "not_prepared", dispatchIds: [] };
      const outcome = await this.settleRenderWorkSetWithinTransaction(tx, { workflowRunId: state.run.id, projectId: state.run.projectId,
        // Correlation for event dedupe only. It is never persisted as an execution attempt.
        eventId: state.run.renderWorkSetGeneration });
      const dispatchIds = outcome.followUpWorkflowRunId ? [(await this.dispatchRunWithinTransaction(tx, outcome.followUpWorkflowRunId)).reference.dispatchId] : [];
      return { kind: "settled", outcome, dispatchIds };
    });
  }

  /** Interim worker wrapper delegates the same settlement body until removal. */
  async settleRenderWorkSet(attempt: WorkflowAttemptRef): Promise<RenderWorkSetOutcome> {
    if (attempt.stage !== "clip_rendering") throw new WorkflowAttemptLost(attempt);
    return this.settlementTransaction(attempt, async (tx) => {
      await this.lockAdmissionProject(tx, attempt.projectId);
      const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: attempt.workflowRunId }, select: { status: true, attemptId: true } });
      if (["completed", "partial", "failed"].includes(run.status)) {
        if (run.attemptId !== attempt.attemptId) throw new WorkflowAttemptLost(attempt);
      } else await this.fenceChildMutation(tx, attempt, "clip_rendering");
      return this.settleRenderWorkSetWithinTransaction(tx, { workflowRunId: attempt.workflowRunId, projectId: attempt.projectId, eventId: attempt.attemptId });
    });
  }

  private async settleRenderWorkSetWithinTransaction(tx: TransactionClient, ref: { workflowRunId: string; projectId: string; eventId: string }): Promise<RenderWorkSetOutcome> {
    const event = { workflowRunId: ref.workflowRunId, projectId: ref.projectId, stage: "clip_rendering" as const, attemptId: ref.eventId };
    const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: ref.workflowRunId } });
    if (["completed", "partial", "failed"].includes(run.status) && run.requestedCount !== null && run.succeededCount !== null && run.failedCount !== null) {
      const followUp = await tx.workflowRun.findUnique({ where: { projectId_idempotencyKey: { projectId: ref.projectId, idempotencyKey: `drain-${ref.workflowRunId}` } }, select: { id: true } });
      return { status: run.status as "completed" | "partial" | "failed", requested: run.requestedCount, succeeded: run.succeededCount, failed: run.failedCount,
        superseded: Math.max(0, run.requestedCount - run.succeededCount - run.failedCount), followUpWorkflowRunId: followUp?.id ?? null };
    }
    const decision = await renderGroupParentSettlement(tx, ref.workflowRunId);
    if (!decision.eligible) {
      const progress = decision.requested > 0 ? Math.min(95, Math.round(90 * (decision.succeeded + decision.failed + decision.superseded) / decision.requested)) : 0;
      await tx.workflowRun.update({ where: { id: ref.workflowRunId }, data: { progress, succeededCount: decision.succeeded, failedCount: decision.failed } });
      await this.appendEvent(tx, { ...event, status: run.status as WorkflowStatus, progress, errorCode: null, transition: `groups_progress:${decision.succeeded}:${decision.failed}:${decision.superseded}` });
      return { status: "pending", requested: run.requestedCount ?? 0, succeeded: decision.succeeded, failed: decision.failed, superseded: decision.superseded, followUpWorkflowRunId: null };
    }
    const members = await tx.renderGroupMember.findMany({ where: { workflowRunId: ref.workflowRunId, invalidatedAt: null }, select: { clipRenderId: true } });
    const variants = await tx.clipRender.findMany({ where: { id: { in: members.map(member => member.clipRenderId) }, workflowRunId: ref.workflowRunId }, select: { id: true, status: true, exportVariantId: true } });
    const terminal = await this.settleTerminalRenderLineage(tx, event, { requestedCount: decision.requested, variants, failureErrorCode: "render_work_set_failed" });
    await this.appendEvent(tx, { ...event, status: terminal.status, progress: 100, errorCode: terminal.errorCode, transition: `terminal:${terminal.status}`,
      analyticsRequired: true, notification: decision.notify ? terminal.notification : undefined });
    const followUpWorkflowRunId = await this.admitLateRenderFollowUp(tx, event);
    await this.emitFinishedOperations(tx, event);
    return { status: terminal.status, requested: terminal.requested, succeeded: terminal.succeeded, failed: terminal.failed, superseded: terminal.superseded, followUpWorkflowRunId };
  }

  private async dubbingAggregate(db: TransactionClient | PrismaClient, attempt: WorkflowAttemptRef): Promise<WorkflowAggregateResult> {
    const [run, completed, failedCount] = await Promise.all([
      db.workflowRun.findUniqueOrThrow({ where: { id: attempt.workflowRunId }, select: { succeededCount: true } }),
      db.clipDub.count({
        where: {
          projectId: attempt.projectId,
          workflowAttemptId: attempt.attemptId,
          status: "completed",
        },
      }),
      db.clipDub.count({
        where: {
          projectId: attempt.projectId,
          workflowAttemptId: attempt.attemptId,
          status: "failed",
        },
      }),
    ]);
    const succeededCount = (run.succeededCount ?? 0) + completed;
    return { requestedCount: succeededCount + failedCount, succeededCount, failedCount };
  }

  async completeDubbing(attempt: WorkflowAttemptRef) {
    const { requestedCount, succeededCount, failedCount } = await this.dubbingAggregate(this.prisma, attempt);
    const terminalCount = succeededCount + failedCount;
    if (terminalCount === 0) {
      await this.completeStage(attempt);
      return;
    }
    await this.completeAggregateStage(attempt, {
      requestedCount,
      succeededCount,
      failedCount,
    });
    if (failedCount === 0) return;
    // The run is terminal, so its failed dubs are known failures. A crash
    // here leaves them to the generation usage sweep.
    await this.prisma.$transaction((tx) =>
      releaseFailedDubUsage(tx, { projectId: attempt.projectId, attemptId: attempt.attemptId, reason: "dub_failed" }),
    );
  }

  async completeAggregateStage(
    attempt: WorkflowAttemptRef,
    result: WorkflowAggregateResult,
  ) {
    validateAggregate(result);
    const status = terminalStatusForAggregate(result);
    await this.settleSuccess(attempt, status, result);
  }

  private async settleSuccess(
    attempt: WorkflowAttemptRef,
    status: Extract<WorkflowStatus, "completed" | "partial" | "failed">,
    aggregate: WorkflowAggregateResult | null,
    admit?: (tx: TransactionClient) => Promise<{ exportId: string; clipId: string }>,
  ) {
    await this.settlementTransaction(attempt, async (tx) => {
      if (attempt.stage === "clip_rendering") {
        await this.lockAdmissionProject(tx, attempt.projectId);
        await this.fenceChildMutation(tx, attempt, "clip_rendering");
        throw new WorkflowAttemptLost(attempt);
      }
      const databaseNow = await this.databaseNow(tx);
      const won = await tx.workflowRun.updateMany({
        where: {
          ...this.ownedAttemptWhere(attempt, databaseNow),
        },
        data: {
          status,
          progress: 100,
          errorCode: status === "failed" ? "aggregate_failed" : null,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          nextPollAt: null,
          requestedCount: aggregate?.requestedCount ?? null,
          succeededCount: aggregate?.succeededCount ?? null,
          failedCount: aggregate?.failedCount ?? null,
        },
      });
      if (won.count === 0) throw new WorkflowAttemptLost(attempt);
      const generationExport = await admit?.(tx);
      await this.appendEvent(tx, {
        projectId: attempt.projectId,
        workflowRunId: attempt.workflowRunId,
        attemptId: attempt.attemptId,
        stage: attempt.stage,
        status,
        progress: 100,
        errorCode: status === "failed" ? "aggregate_failed" : null,
        transition: `terminal:${status}`,
        analyticsRequired: true,
        ...(generationExport ? { generationExport } : {}),
      });
      await this.emitFinishedOperations(tx, attempt);
    });
  }

  async failAttempt(
    attempt: WorkflowAttemptRef,
    failure: WorkflowFailure,
    options: { expiredLeaseOnly?: boolean } = {},
  ) {
    await this.settlementTransaction(attempt, (tx) =>
      this.failAttemptWithinTransaction(tx, attempt, failure, options),
    );
  }

  async failAttemptWithinTransaction(
    tx: TransactionClient,
    attempt: WorkflowAttemptRef,
    failure: WorkflowFailure,
    options: { expiredLeaseOnly?: boolean },
  ) {
    const databaseNow = await this.databaseNow(tx);
    if (attempt.stage === "clip_rendering") {
      await this.lockAdmissionProject(tx, attempt.projectId);
    }
    const run = await tx.workflowRun.findFirst({
      where: {
        id: attempt.workflowRunId,
        projectId: attempt.projectId,
        stage: attempt.stage,
        status: { in: ["running", "waiting"] },
        attemptId: attempt.attemptId,
      },
    });
    if (!run) throw new WorkflowAttemptLost(attempt);

    if (attempt.stage === "clip_rendering") {
      await tx.$queryRaw`SELECT "id" FROM "WorkflowRun" WHERE "id" = ${run.id}::uuid FOR UPDATE`;
      const now = await this.databaseNow(tx);
      const changed = await tx.workflowRun.updateMany({ where: options.expiredLeaseOnly
        ? { id: run.id, attemptId: attempt.attemptId, status: "running", leaseExpiresAt: { lte: now } }
        : this.ownedAttemptWhere(attempt, now),
        data: { status: "queued", attemptId: null, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null,
          nextAttemptAt: now, errorCode: null } });
      if (!changed.count) throw new WorkflowAttemptLost(attempt);
      await this.appendEvent(tx, { ...attempt, status: "queued", progress: run.progress, errorCode: null, transition: `coordinator_requeued:${attempt.attemptId}` });
      return;
    }
    const requeue =
      failure.disposition === "retryable" && run.attemptCount < WORKFLOW_MAX_ATTEMPTS;
    const status: WorkflowStatus = requeue ? "queued" : "failed";
    const errorCode = requeue
      ? null
      : failure.disposition === "retryable"
        ? WORKFLOW_RETRIES_EXHAUSTED_CODE
        : failure.code;
    const nextAttemptAt = requeue
      ? new Date(databaseNow.getTime() + retryBackoffMs(run.attemptCount))
      : null;

    const won = await tx.workflowRun.updateMany({
      where: options.expiredLeaseOnly
        ? {
            id: run.id,
            projectId: attempt.projectId,
            stage: attempt.stage,
            attemptId: attempt.attemptId,
            status: "running",
            leaseExpiresAt: { lte: databaseNow },
          }
        : {
            ...this.ownedAttemptWhere(attempt, databaseNow),
            id: run.id,
          },
      data: {
        status,
        progress: requeue ? 0 : 100,
        errorCode,
        attemptId: requeue ? null : attempt.attemptId,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        nextAttemptAt,
        nextPollAt: null,
        waitingSince: null,
      },
    });
    if (won.count === 0) throw new WorkflowAttemptLost(attempt);
      await this.settleAttemptChildren(tx, attempt, {
        requeue,
        errorCode: errorCode ?? failure.code,
      });
    let settledStatus: WorkflowStatus = status;
    let settledErrorCode = errorCode;
    if (attempt.stage === "dubbing") {
      const aggregate = await this.dubbingAggregate(tx, attempt);
      if (requeue) {
        await tx.workflowRun.update({ where: { id: run.id }, data: { succeededCount: aggregate.succeededCount } });
      } else {
        settledStatus = aggregate.requestedCount > 0 ? terminalStatusForAggregate(aggregate) : "failed";
        settledErrorCode = settledStatus === "failed" ? errorCode : null;
        await tx.workflowRun.update({ where: { id: run.id }, data: { ...aggregate, status: settledStatus, errorCode: settledErrorCode } });
      }
    }
    await this.appendEvent(tx, {
      projectId: attempt.projectId,
      workflowRunId: attempt.workflowRunId,
      attemptId: attempt.attemptId,
      stage: attempt.stage,
      status: settledStatus,
      progress: requeue ? 0 : 100,
      errorCode: settledErrorCode,
      transition: requeue
        ? `requeued:${run.attemptCount}`
        : `terminal:${settledStatus}`,
      analyticsRequired: !requeue,
    });
    if (!requeue) await this.emitFinishedOperations(tx, attempt);
  }

  private async settleTerminalRenderLineage(
    tx: TransactionClient,
    attempt: Pick<WorkflowAttemptRef, "workflowRunId" | "projectId">,
    input: {
      requestedCount: number | null;
      variants: readonly RenderLineageVariant[];
      failureErrorCode: string;
      unfinishedErrorCode?: string;
    },
  ): Promise<RenderTerminalSettlement> {
    const requested = Math.max(
      input.requestedCount ?? input.variants.length,
      input.variants.length,
    );
    const succeeded = input.variants.filter(
      (variant) => variant.status === "completed",
    ).length;
    const failed = input.variants.length - succeeded;
    const superseded = Math.max(0, requested - input.variants.length);
    const status: RenderTerminalSettlement["status"] =
      succeeded > 0 && failed > 0
        ? "partial"
        : succeeded > 0 || failed === 0
          ? "completed"
          : "failed";
    const errorCode = status === "failed" ? input.failureErrorCode : null;
    const unfinishedErrorCode =
      errorCode ?? input.unfinishedErrorCode ?? "render_variant_interrupted";
    const unfinished = input.variants.filter(
      (variant) => variant.status === "pending" || variant.status === "rendering",
    );
    if (unfinished.length > 0) {
      await tx.clipRender.updateMany({
        where: { id: { in: unfinished.map((variant) => variant.id) } },
        data: {
          status: "failed",
          errorCode: unfinishedErrorCode,
          failureDisposition: "retryable",
          completedAt: new Date(),
        },
      });
    }
    const failedExportVariantIds = unfinished.flatMap((variant) =>
      variant.exportVariantId
        ? [variant.exportVariantId]
        : [],
    );
    if (failedExportVariantIds.length > 0) {
      await tx.clipExportVariant.updateMany({
        where: { id: { in: failedExportVariantIds } },
        data: {
          status: "failed",
          errorCode: unfinishedErrorCode,
          completedAt: new Date(),
        },
      });
      await syncClipExportAggregates(tx, failedExportVariantIds);
    }
    const settledFailureExportIds = input.variants.flatMap((variant) =>
      variant.status === "failed" && variant.exportVariantId ? [variant.exportVariantId] : [],
    );
    if (settledFailureExportIds.length > 0) {
      await tx.clipExportVariant.updateMany({
        where: { id: { in: settledFailureExportIds }, status: { in: ["pending", "rendering"] } },
        data: { status: "failed", completedAt: new Date() },
      });
      await syncClipExportAggregates(tx, settledFailureExportIds);
    }
    await tx.workflowRun.update({
      where: { id: attempt.workflowRunId },
      data: {
        status,
        progress: 100,
        errorCode,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        nextAttemptAt: null,
        requestedCount: requested,
        succeededCount: succeeded,
        failedCount: failed,
      },
    });

    const supersededOnly = requested > 0 && input.variants.length === 0;
    const notification = supersededOnly
      ? undefined
      : {
          kind:
            status === "completed"
              ? ("clip_render.completed" as const)
              : status === "partial"
                ? ("clip_render.partial" as const)
                : ("clip_render.failed" as const),
          projectId: attempt.projectId,
          workflowRunId: attempt.workflowRunId,
          requested,
          succeeded,
          failed,
          superseded,
        };
    return {
      status,
      errorCode,
      requested,
      succeeded,
      failed,
      superseded,
      notification,
    };
  }

  private async admitLateRenderFollowUp(
    tx: TransactionClient,
    attempt: Pick<WorkflowAttemptRef, "workflowRunId" | "projectId">,
  ): Promise<string | null> {
    const lateVariant = await tx.clipRender.findFirst({
      where: {
        workflowRunId: null,
        status: "pending",
        clip: { projectId: attempt.projectId },
      },
      select: { id: true },
    });
    if (!lateVariant) return null;
    const followUp = await this.admitWithinTransaction(tx, {
      projectId: attempt.projectId,
      idempotencyKey: `drain-${attempt.workflowRunId}`,
      stage: "clip_rendering",
      contentPackId: null,
    });
    await this.dispatchRunWithinTransaction(tx, followUp.id);
    return followUp.id;
  }

  private async settleAttemptChildren(
    tx: TransactionClient,
    attempt: WorkflowAttemptRef,
    outcome: { requeue: boolean; errorCode: string },
  ) {
    if (attempt.stage === "dubbing") {
      await tx.clipDub.updateMany({
        where: {
          projectId: attempt.projectId,
          OR: [
            { workflowAttemptId: attempt.attemptId, status: { in: ["processing", "failed"] } },
            // Only one dubbing run may be live for a Project. A terminal
            // failure also owns queued siblings it never reached.
            ...(!outcome.requeue ? [{ workflowAttemptId: null, status: "queued" as const }] : []),
          ],
        },
        data: outcome.requeue
          ? {
              status: "queued",
              workflowAttemptId: null,
              errorCode: null,
              startedAt: null,
              completedAt: null,
            }
          : {
              status: "failed",
              workflowAttemptId: attempt.attemptId,
              errorCode: outcome.errorCode,
              completedAt: new Date(),
            },
      });
      // A requeued dub keeps its count; settle every known failure, including
      // siblings newly marked above, in this same terminal transaction.
      if (!outcome.requeue) {
        await releaseFailedDubUsage(tx, {
          projectId: attempt.projectId,
          attemptId: attempt.attemptId,
          reason: outcome.errorCode,
        });
      }
    }
    if (attempt.stage === "stt") {
      await tx.transcript.updateMany({
        where: {
          projectId: attempt.projectId,
          workflowAttemptId: attempt.attemptId,
        },
        data: outcome.requeue
          ? {
              status: "processing",
              workflowAttemptId: null,
              providerJobId: null,
              providerRequestId: null,
              providerSubmissionDeadlineAt: null,
              errorCode: null,
            }
          : {
              status: "failed",
              errorCode: outcome.errorCode,
              providerSubmissionDeadlineAt: null,
            },
      });
    }
  }

  async reapExpiredAttempts(): Promise<number> {
    const databaseClock = await this.prisma.$queryRaw<
      Array<{ databaseNow: Date }>
    >`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS "databaseNow"`;
    const now = databaseClock[0]?.databaseNow;
    if (!now) throw new Error("Database clock unavailable");
    const expired = await this.prisma.workflowRun.findMany({
      where: {
        status: "running",
        leaseExpiresAt: { lte: now },
      },
      select: {
        id: true,
        projectId: true,
        stage: true,
        attemptId: true,
        attemptCount: true,
      },
      take: 100,
    });
    let reaped = 0;
    for (const run of expired) {
      if (!run.attemptId) continue;
      const attempt: WorkflowAttemptRef = {
        workflowRunId: run.id,
        projectId: run.projectId,
        stage: run.stage as WorkflowStage,
        attemptId: run.attemptId,
        attemptCount: run.attemptCount,
      };
      try {
        await this.failAttempt(
          attempt,
          new WorkflowFailure("worker_stalled", "retryable", "Workflow lease expired"),
          { expiredLeaseOnly: true },
        );
        reaped += 1;
      } catch (error) {
        if (!(error instanceof WorkflowAttemptLost)) throw error;
      }
    }
    return reaped;
  }

  async dispatchEvents(batchSize = 100): Promise<number> {
    const now = new Date();
    const pendingChannels: Prisma.WorkflowEventWhereInput[] = [
      { progressRequired: true, progressPublishedAt: null },
      { analyticsRequired: true, analyticsPublishedAt: null },
      { notificationRequired: true, notificationDeliveredAt: null },
    ];
    const candidates = await this.prisma.workflowEvent.findMany({
      where: {
        deadLetteredAt: null,
        nextDeliveryAt: { lte: now },
        OR: [
          { deliveryLeaseExpiresAt: null },
          { deliveryLeaseExpiresAt: { lte: now } },
        ],
        AND: [{ OR: pendingChannels }],
      },
      orderBy: [{ projectId: "asc" }, { seq: "asc" }],
      take: batchSize,
    });

    let delivered = 0;
    for (const candidate of candidates) {
      const claimedAt = new Date();
      const claimOwner = randomUUID();
      const leaseExpiresAt = new Date(claimedAt.getTime() + EVENT_DELIVERY_LEASE_MS);
      const claimed = await this.prisma.workflowEvent.updateMany({
        where: {
          id: candidate.id,
          deadLetteredAt: null,
          nextDeliveryAt: { lte: claimedAt },
          OR: [
            { deliveryLeaseExpiresAt: null },
            { deliveryLeaseExpiresAt: { lte: claimedAt } },
          ],
          AND: [{ OR: pendingChannels }],
        },
        data: {
          deliveryLeaseOwner: claimOwner,
          deliveryLeaseExpiresAt: leaseExpiresAt,
          deliveryAttempts: { increment: 1 },
        },
      });
      if (claimed.count === 0) continue;
      // Discovery can precede another sender's acknowledgement. Execute only
      // the current claim's fresh channel checkpoints, not the candidate copy.
      const event = await this.prisma.workflowEvent.findFirst({ where: {
        id: candidate.id, deliveryLeaseOwner: claimOwner,
        deliveryLeaseExpiresAt: { gt: new Date() }, deadLetteredAt: null,
      } });
      if (!event) continue;
      const held = (): Prisma.WorkflowEventWhereInput => ({
        id: event.id, deliveryLeaseOwner: claimOwner,
        deliveryLeaseExpiresAt: { gt: new Date() }, deadLetteredAt: null,
      });
      const renew = async () => {
        const expiresAt = new Date(Date.now() + EVENT_DELIVERY_LEASE_MS);
        const updated = await this.prisma.workflowEvent.updateMany({
          where: held(), data: { deliveryLeaseExpiresAt: expiresAt },
        });
        return updated.count === 1 && expiresAt.getTime() > Date.now();
      };

      try {
        const parsed = workflowStageUpdatedEventSchema.parse(event.payload);
        if (event.progressRequired && !event.progressPublishedAt) {
          if (!(await renew())) continue;
          const published = await this.publishProgress(parsed);
          if (!published) {
            throw new Error("Workflow progress destination unavailable");
          }
          const acknowledged = await this.prisma.workflowEvent.updateMany({
            where: held(),
            data: { progressPublishedAt: new Date() },
          });
          if (acknowledged.count === 0) continue;
        }
        if (event.analyticsRequired && !event.analyticsPublishedAt) {
          if (!(await renew())) continue;
          if (this.publishAnalytics) {
            await this.publishAnalytics(parsed, event.dedupeKey);
          }
          const acknowledged = await this.prisma.workflowEvent.updateMany({
            where: held(),
            data: { analyticsPublishedAt: new Date() },
          });
          if (acknowledged.count === 0) continue;
        }
        if (event.notificationRequired && !event.notificationDeliveredAt) {
          if (!(await renew())) continue;
          const notification = parsed.notification;
          if (!notification) {
            throw new Error("Render notification payload unavailable");
          }
          await this.handoffNotification(notification);
          const acknowledged = await this.prisma.workflowEvent.updateMany({
            where: held(),
            data: { notificationDeliveredAt: new Date() },
          });
          if (acknowledged.count === 0) continue;
        }
        const released = await this.prisma.workflowEvent.updateMany({
          where: held(),
          data: {
            deliveryLeaseOwner: null,
            deliveryLeaseExpiresAt: null,
            lastDeliveryError: null,
          },
        });
        if (released.count > 0) delivered += 1;
      } catch (error) {
        const attempts = event.deliveryAttempts;
        await this.prisma.workflowEvent.updateMany({
          where: held(),
          data: {
            deliveryLeaseOwner: null,
            deliveryLeaseExpiresAt: null,
            nextDeliveryAt: new Date(Date.now() + eventBackoffMs(attempts)),
            lastDeliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
            deadLetteredAt:
              attempts >= EVENT_MAX_DELIVERY_ATTEMPTS ? new Date() : null,
          },
        });
      }
    }
    return delivered;
  }
}


export function getWorkflowRunLifecycle() {
  return new WorkflowRunLifecycle();
}

