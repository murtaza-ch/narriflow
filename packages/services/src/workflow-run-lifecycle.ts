import { randomUUID } from "node:crypto";
import { cancelRenderGroupsWithinTransaction, admitRenderGroupsWithinTransaction, renderGroupParentSettlement, type RenderGroupAdmission } from "./render-group-lifecycle";
import type { RenderGroupRef } from "./render-group-contract";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  SCRIBE_MODEL_ID,
  workflowStageUpdatedEventSchema,
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
import { isExpectedDomainFailure } from "./expected-domain-failure";
import {
  isWorkflowRedisDeliveryEnabled,
  publishPersistedWorkflowEvent,
} from "./workflow.service";
import { notificationService, type NotificationOutcome } from "./notification.service";
import { syncClipExportAggregates } from "./clip-export-aggregates";
import {
  admitRetiredClipMediaCleanup,
} from "./media-cleanup";
import { queueExportsFinishedByRun, queueFinishedGenerations } from "./operation-finished";
import { flushWorkspaceEvents } from "./workspace-event";
import { finalizeGenerationUsage, releaseFailedDubUsage } from "./generated-media-usage-ledger";
import { appendWorkflowEvent, type WorkflowEventInput } from "./workflow-event-append";

export const WORKFLOW_LEASE_DURATION_MS = 2 * 60 * 1000;
export const WORKFLOW_HEARTBEAT_INTERVAL_MS = 30 * 1000;
/** How long a stopping worker lets in-flight handlers finish
 * (`WORKER_SHUTDOWN_DRAIN_MS`, 30s by default). */
export function workerShutdownDrainMs(env: Record<string, string | undefined> = process.env): number {
  const configured = Number(env.WORKER_SHUTDOWN_DRAIN_MS ?? "30000");
  return Number.isFinite(configured) && configured > 0 ? configured : 30_000;
}
/** A released attempt's aborted handler may still be finishing an unfenced
 * provider call until the shutdown drain ends, so peers wait exactly that long
 * before claiming it. */
export const WORKFLOW_RELEASE_GRACE_MS = workerShutdownDrainMs();
export const WORKFLOW_MAX_ATTEMPTS = 3;
export const WORKFLOW_RETRIES_EXHAUSTED_CODE = "workflow_retries_exhausted";

const WORKFLOW_RETRY_BASE_DELAY_MS = 30_000;
const EVENT_DELIVERY_LEASE_MS = 30_000;
const EVENT_MAX_DELIVERY_ATTEMPTS = 20;
const EVENT_MAX_BACKOFF_MS = 5 * 60 * 1000;
const TRANSACTION_RETRY_LIMIT = 10;

type TransactionClient = Prisma.TransactionClient;

export interface WorkflowAttemptRef {
  workflowRunId: string;
  projectId: string;
  stage: WorkflowStage;
  attemptId: string;
  attemptCount: number;
}

export interface ClaimedWorkflowAttempt extends WorkflowAttemptRef {
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
    createdByUserId: string | null;
    workspaceId: string;
  };
}

export type WorkflowFailureDisposition = "retryable" | "permanent";

export function workflowHttpFailureDisposition(
  status: number,
): WorkflowFailureDisposition {
  return status === 408 || status === 425 || status === 429 || status >= 500
    ? "retryable"
    : "permanent";
}

export class WorkflowFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly disposition: WorkflowFailureDisposition,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkflowFailure";
  }
}

export class WorkflowAttemptLost extends Error {
  readonly code = "workflow_attempt_lost";

  constructor(public readonly attempt: WorkflowAttemptRef) {
    super(`Workflow attempt ${attempt.attemptId} no longer owns ${attempt.workflowRunId}`);
    this.name = "WorkflowAttemptLost";
  }
}

export interface WorkflowAttemptContext {
  signal: AbortSignal;
  reportProgress: (progress: number) => Promise<void>;
}

export interface WaitingWorkflowAttempt extends WorkflowAttemptRef {
  progress: number;
  /** Null while the submission is unconfirmed: the worker can only expire it. */
  providerJobId: string | null;
  /** Set with a null `providerJobId`; the instant the unconfirmed submission fails. */
  submissionDeadlineAt: Date | null;
  submittedAt: Date;
}

/** Identifies the attempt a provider callback belongs to. The webhook carries
 * only `webhook_metadata`, so the project is resolved from the run. */
export interface ProviderAttemptKey {
  workflowRunId: string;
  attemptId: string;
}

/** Provider ids a callback or recovery read supplies, to fence against a
 * different submission recorded for the same attempt. */
export interface ProviderIds {
  requestId?: string | null;
  transcriptionId?: string | null;
}

/** Outcome of a provider-driven settlement. Everything but `applied` is an
 * acknowledged no-op: nothing was written and nothing was resurrected. */
export type ProviderSettlementResult =
  | { kind: "applied" }
  /** The same completion or acceptance was already recorded. */
  | { kind: "duplicate" }
  /** A newer attempt owns the run, the provider ids disagree, or the run is not waiting yet. */
  | {
      kind: "stale";
      reason:
        | "run_missing"
        | "attempt_superseded"
        | "provider_job_mismatch"
        | "not_waiting"
        | "submission_pending"
        | "submission_confirmed";
    }
  /** The run already reached a terminal status (completed, failed, partial). */
  | { kind: "terminal"; status: WorkflowStatus };

type ProviderSettlementIntent = "accept" | "complete" | "fail";

export type ProviderAttemptLookup =
  | {
      kind: "waiting";
      attempt: WorkflowAttemptRef;
      providerJobId: string | null;
      providerRequestId: string | null;
      submissionDeadlineAt: Date | null;
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
  publishRedis?: (event: WorkflowStageUpdatedEvent) => Promise<boolean>;
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
  private readonly publishRedis: NonNullable<
    WorkflowLifecycleDependencies["publishRedis"]
  >;
  private readonly redisDeliveryRequired: boolean;
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
    this.publishRedis =
      dependencies.publishRedis ?? publishPersistedWorkflowEvent;
    this.redisDeliveryRequired =
      Boolean(dependencies.publishRedis) || isWorkflowRedisDeliveryEnabled();
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
        return await this.prisma.$transaction(async (tx) => {
          const result = await operation(tx);
          await flushWorkspaceEvents(tx);
          return result;
        });
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
      redisRequired: this.redisDeliveryRequired,
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
        "id", "projectId", "idempotencyKey", "stage", "status",
        "progress", "attemptCount", "contentPackId",
        "createdAt", "updatedAt"
      ) VALUES (
        ${workflowRunId}::uuid, ${input.projectId}::uuid,
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
    try {
      return await this.transaction(async (tx) => {
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
            stage: input.stage,
            status: { in: ["queued", "running", "waiting"] },
          },
          select: { id: true },
        });
        if (active) return { id: active.id, created: false };

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
        return this.admitWithinTransaction(tx, {
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
          stage: input.stage,
          contentPackId,
        });
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
      await this.lockAdmissionProject(tx, input.projectId);
      const existing = await tx.workflowRun.findUnique({
        where: { projectId_idempotencyKey: { projectId: input.projectId, idempotencyKey: input.idempotencyKey } },
        select: { id: true },
      });
      let admitted: { id: string; created: boolean };
      if (existing) {
        admitted = { id: existing.id, created: false };
      } else {
        const active = await tx.workflowRun.findFirst({
          where: { projectId: input.projectId, stage: input.stage, status: { in: ["queued", "running", "waiting"] } },
          select: { id: true },
        });
        if (active) throw new Error("workflow_stage_admission_busy");
        if (input.contentPackId) await this.requireCommittedContentPack(tx, input.projectId, input.contentPackId);
        admitted = await this.admitWithinTransaction(tx, { ...input, contentPackId: input.contentPackId ?? null });
      }
      const value = await handoff(tx, admitted);
      return { ...admitted, handoff: value };
    };
    return transactionClient ? admit(transactionClient) : this.transaction(admit);
  }

  async admitTranscript(
    input: AdmitTranscriptWorkflowRunInput,
    transactionClient?: TransactionClient,
  ): Promise<{ id: string; created: boolean }> {
    const admit = async (tx: TransactionClient) => {
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
      await tx.transcript.upsert({
        where: { projectId: input.projectId },
        create: {
          projectId: input.projectId,
          status: "queued",
          provider: input.transcriptProvider,
          providerModel: input.transcriptProviderModel,
          providerJobId: null,
          errorCode: null,
        },
        update: {
          status: "queued",
          provider: input.transcriptProvider,
          providerModel: input.transcriptProviderModel,
          providerJobId: null,
          workflowAttemptId: null,
          errorCode: null,
          completedAt: null,
        },
      });
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
              sourceMimeType: true,
              sourceDurationSeconds: true,
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

  /** Cancel the unclaimed part of this exact generation. Shared render runs
   * retain unrelated variants, and a running detection claim keeps authority. */
  async cancelQueuedGenerationOperation(input: { workspaceId: string; projectId: string; workflowRunId: string }): Promise<boolean> {
    return this.transaction(async (tx) => {
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
      // Admission fences detection before the Project lock. Keep that order.
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

  private async beginRenderWorkSetWithinTransaction(tx: TransactionClient, attempt: WorkflowAttemptRef): Promise<RenderWorkSet> {
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

  async replaceDetectedClips(
    attempt: WorkflowAttemptRef,
    clips: DetectedClipArtifactInput[],
  ) {
    await this.transaction(async (tx) => {
      await this.fenceChildMutation(tx, attempt, "moment_detection");
      await admitRetiredClipMediaCleanup(
        tx,
        "detected_clip_replacement",
        attempt.projectId,
      );
      await tx.clip.deleteMany({ where: { projectId: attempt.projectId } });
      if (clips.length > 0) {
        await tx.clip.createMany({
          data: clips.map((clip) => ({
            ...clip,
            projectId: attempt.projectId,
            workflowRunId: attempt.workflowRunId,
            brollCues:
              clip.brollCues === null || clip.brollCues === undefined
                ? Prisma.JsonNull
                : (clip.brollCues as Prisma.InputJsonValue),
          })),
        });
      }
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

  async admitAutoRenderWork(
    attempt: WorkflowAttemptRef,
    input: {
      idempotencyKey: string;
      renders: RenderArtifactInput[];
    },
  ) {
    return this.transaction(async (tx) => {
      await this.fenceChildMutation(tx, attempt, "moment_detection");
      if (input.renders.length > 0) {
        const projectClipCount = await tx.clip.count({
          where: {
            projectId: attempt.projectId,
            id: { in: input.renders.map((render) => render.clipId) },
          },
        });
        if (
          projectClipCount !==
          new Set(input.renders.map((render) => render.clipId)).size
        ) {
          throw new WorkflowAttemptLost(attempt);
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
      await this.lockAdmissionProject(tx, attempt.projectId);
      const existing = await tx.workflowRun.findUnique({
        where: {
          projectId_idempotencyKey: {
            projectId: attempt.projectId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: { id: true },
      });
      const active = await tx.workflowRun.findFirst({
        where: {
          projectId: attempt.projectId,
          stage: "clip_rendering",
          status: { in: ["queued", "running", "waiting"] },
        },
        select: { id: true },
      });
      const admitted = existing ? { id: existing.id, created: false } : active ? { id: active.id, created: false } : await this.admitWithinTransaction(tx, {
        projectId: attempt.projectId,
        idempotencyKey: input.idempotencyKey,
        stage: "clip_rendering",
        contentPackId: null,
      });
      const detection = await tx.workflowRun.findUniqueOrThrow({ where: { id: attempt.workflowRunId }, select: { progress: true } });
      const generationRenders = await tx.clipRender.findMany({ where: { exportVariantId: null,
        clip: { projectId: attempt.projectId, workflowRunId: attempt.workflowRunId },
        OR: input.renders.map((render) => ({ clipId: render.clipId, aspectRatio: render.aspectRatio as Prisma.ClipRenderWhereInput["aspectRatio"] })) },
        orderBy: { id: "asc" }, select: { id: true, clipId: true } });
      await this.appendEvent(tx, { projectId: attempt.projectId, workflowRunId: attempt.workflowRunId,
        attemptId: attempt.attemptId, stage: "moment_detection", status: "running", progress: detection.progress,
        errorCode: null, transition: `render_handoff:${admitted.id}`, followUpWorkflowRunId: admitted.id,
        generationRenders: generationRenders.map((render) => ({ renderId: render.id, clipId: render.clipId })) });
      return admitted;
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
    return this.transaction(async (tx) => {
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
    });
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
        projectId: true,
        stage: true,
        progress: true,
        attemptId: true,
        attemptCount: true,
        waitingSince: true,
        project: {
          select: {
            transcript: {
              select: {
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
    const normalizedProgress = Math.max(0, Math.min(99, Math.round(progress)));
    await this.transaction(async (tx) => {
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
    });
  }

  async waitForProvider(
    attempt: WorkflowAttemptRef,
    input: { providerJobId: string; nextPollAt: Date },
  ) {
    await this.settlementTransaction(attempt, async (tx) => {
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
          waitingSince: new Date(),
          nextPollAt: input.nextPollAt,
        },
      });
      if (won.count === 0) throw new WorkflowAttemptLost(attempt);
      await tx.transcript.updateMany({
        where: { projectId: attempt.projectId },
        data: {
          providerJobId: input.providerJobId,
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
        transition: "provider-waiting",
      });
    });
  }

  /**
   * Durable intent for an asynchronous provider submission: the run is
   * `waiting` with no provider id and a deadline, before the POST leaves. A
   * crash between the POST and `recordProviderAcceptance` is then recovered by
   * the deadline (`expireUnconfirmedProviderSubmission`) instead of stalling.
   * No lease is held afterwards; callbacks and the worker act lease-free.
   */
  async beginProviderSubmission(
    attempt: WorkflowAttemptRef,
    input: { deadline: Date },
  ) {
    if (attempt.stage !== "stt") throw new WorkflowAttemptLost(attempt);
    await this.settlementTransaction(attempt, async (tx) => {
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
          waitingSince: new Date(),
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
    });
  }

  /**
   * Records the provider's 202 (`providerJobId` = transcription id, never the
   * request id) and moves the poll to `nextPollAt`. Idempotent, and a no-op for
   * an attempt that is already terminal, superseded, or completed by a
   * callback that beat this write: it never resurrects a run.
   */
  async recordProviderAcceptance(
    key: ProviderAttemptKey,
    input: { requestId: string; transcriptionId: string; nextPollAt: Date },
  ): Promise<ProviderSettlementResult> {
    return this.transaction(async (tx) => {
      const lookup = await this.lockProviderAttempt(tx, key, "accept", {
        requestId: input.requestId,
        transcriptionId: input.transcriptionId,
      });
      if (lookup.kind !== "waiting") return lookup;
      const { attempt } = lookup;
      await tx.transcript.updateMany({
        where: { projectId: attempt.projectId, workflowAttemptId: attempt.attemptId },
        data: {
          providerJobId: input.transcriptionId,
          providerRequestId: input.requestId,
          providerSubmissionDeadlineAt: null,
          status: "processing",
        },
      });
      await tx.workflowRun.updateMany({
        where: { id: attempt.workflowRunId, attemptId: attempt.attemptId, status: "waiting" },
        data: { nextPollAt: input.nextPollAt },
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
      return { kind: "applied" } as const;
    });
  }

  /** Reads where a provider callback stands, without writing. The finalizer
   * uses it to learn the project before it stores anything. */
  async lookupProviderAttempt(
    key: ProviderAttemptKey,
    ids: ProviderIds = {},
  ): Promise<ProviderAttemptLookup> {
    return this.classifyProviderAttempt(this.prisma, key, "complete", ids);
  }

  /**
   * Completes a waiting transcript by `(workflowRunId, attemptId)` from a
   * process that holds no lease (the webhook, or the worker's GET recovery).
   * Fenced by the run, the attempt, and the provider ids in `input`.
   */
  async completeProviderTranscript(
    key: ProviderAttemptKey,
    input: CompleteTranscriptInput,
  ): Promise<ProviderSettlementResult> {
    return this.transaction(async (tx) => {
      const lookup = await this.lockProviderAttempt(tx, key, "complete", {
        requestId: input.providerRequestId,
        transcriptionId: input.providerJobId,
      });
      if (lookup.kind !== "waiting") return lookup;
      await this.completeTranscriptWithin(
        tx,
        lookup.attempt,
        input,
        this.waitingAttemptWhere(lookup.attempt),
      );
      return { kind: "applied" } as const;
    });
  }

  /** Fails a waiting provider attempt (a `webhook_error`, a permanent provider
   * result) with the normal retry policy: retryable failures requeue. */
  async failProviderAttempt(
    key: ProviderAttemptKey,
    failure: WorkflowFailure,
    ids: ProviderIds = {},
  ): Promise<ProviderSettlementResult> {
    return this.transaction(async (tx) => {
      const lookup = await this.lockProviderAttempt(tx, key, "fail", ids);
      if (lookup.kind !== "waiting") return lookup;
      await this.failAttemptWithin(tx, lookup.attempt, failure, {});
      return { kind: "applied" } as const;
    });
  }

  /**
   * Fails a submission whose acceptance was never recorded once its deadline
   * has passed (`elevenlabs_submission_unconfirmed`, retryable). Not due, or
   * accepted in the meantime, is a no-op.
   */
  async expireUnconfirmedProviderSubmission(
    key: ProviderAttemptKey,
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
      await this.failAttemptWithin(
        tx,
        lookup.attempt,
        new WorkflowFailure(
          "elevenlabs_submission_unconfirmed",
          "retryable",
          "The transcription request was not confirmed before its deadline",
        ),
        {},
      );
      return { kind: "applied" } as const;
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
    key: ProviderAttemptKey,
    intent: ProviderSettlementIntent,
    ids: ProviderIds,
  ): Promise<ProviderAttemptLookup> {
    await tx.$queryRaw`SELECT "id" FROM "WorkflowRun" WHERE "id" = ${key.workflowRunId}::uuid FOR UPDATE`;
    return this.classifyProviderAttempt(tx, key, intent, ids);
  }

  private async classifyProviderAttempt(
    db: PrismaClient | TransactionClient,
    key: ProviderAttemptKey,
    intent: ProviderSettlementIntent,
    ids: ProviderIds,
  ): Promise<ProviderAttemptLookup> {
    const run = await db.workflowRun.findUnique({
      where: { id: key.workflowRunId },
      select: {
        id: true,
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
    if (run.attemptId !== key.attemptId) {
      return { kind: "stale", reason: "attempt_superseded" };
    }
    const status = run.status as WorkflowStatus;
    const transcript = await db.transcript.findUnique({
      where: { projectId: run.projectId },
      select: {
        workflowAttemptId: true,
        providerJobId: true,
        providerRequestId: true,
        providerSubmissionDeadlineAt: true,
      },
    });
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
      update: completedFields,
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

  /**
   * Settles the complete durable Render Work Set in one fenced transaction.
   * Callers never derive aggregate state or admit late work themselves.
   */
  async settleRenderWorkSet(
    attempt: WorkflowAttemptRef,
  ): Promise<RenderWorkSetOutcome> {
    if (attempt.stage !== "clip_rendering") throw new WorkflowAttemptLost(attempt);
    return this.settlementTransaction(attempt, async (tx) => {
      await this.lockAdmissionProject(tx, attempt.projectId);
      const existingRun = await tx.workflowRun.findUniqueOrThrow({
        where: { id: attempt.workflowRunId },
        select: {
          status: true,
          attemptId: true,
          requestedCount: true,
          succeededCount: true,
          failedCount: true,
        },
      });
      if (
        existingRun.attemptId === attempt.attemptId &&
        (existingRun.status === "completed" ||
          existingRun.status === "partial" ||
          existingRun.status === "failed") &&
        existingRun.requestedCount !== null &&
        existingRun.succeededCount !== null &&
        existingRun.failedCount !== null
      ) {
        const followUp = await tx.workflowRun.findUnique({
          where: {
            projectId_idempotencyKey: {
              projectId: attempt.projectId,
              idempotencyKey: `drain-${attempt.workflowRunId}`,
            },
          },
          select: { id: true },
        });
        return {
          status: existingRun.status,
          requested: existingRun.requestedCount,
          succeeded: existingRun.succeededCount,
          failed: existingRun.failedCount,
          superseded: Math.max(
            0,
            existingRun.requestedCount -
              existingRun.succeededCount -
              existingRun.failedCount,
          ),
          followUpWorkflowRunId: followUp?.id ?? null,
        };
      }

      await this.fenceChildMutation(tx, attempt, "clip_rendering");
      const run = await tx.workflowRun.findUniqueOrThrow({
        where: { id: attempt.workflowRunId },
        select: { requestedCount: true, attemptCount: true, renderWorkSetGeneration: true },
      });
      {
        const decision = await renderGroupParentSettlement(tx, attempt.workflowRunId);
        if (!decision.eligible) {
          const progress = decision.requested > 0 ? Math.min(95, Math.round(90 * (decision.succeeded + decision.failed + decision.superseded) / decision.requested)) : 0;
          await tx.workflowRun.update({ where: { id: attempt.workflowRunId }, data: { progress, succeededCount: decision.succeeded, failedCount: decision.failed } });
          await this.appendEvent(tx, { ...attempt, status: "running", progress, errorCode: null, transition: `groups_progress:${decision.succeeded}:${decision.failed}:${decision.superseded}` });
          return { status: "pending" as const, requested: run.requestedCount ?? 0, succeeded: decision.succeeded,
            failed: decision.failed, superseded: decision.superseded, followUpWorkflowRunId: null };
        }
        const members = await tx.renderGroupMember.findMany({ where: { workflowRunId: attempt.workflowRunId, invalidatedAt: null }, select: { clipRenderId: true } });
        const variants = await tx.clipRender.findMany({ where: { id: { in: members.map((m) => m.clipRenderId) }, workflowRunId: attempt.workflowRunId }, select: { id: true, status: true, exportVariantId: true } });
        const terminal = await this.settleTerminalRenderLineage(tx, attempt, { requestedCount: decision.requested, variants, failureErrorCode: "render_work_set_failed" });
        await this.appendEvent(tx, { ...attempt, status: terminal.status, progress: 100, errorCode: terminal.errorCode,
          transition: `terminal:${terminal.status}`, analyticsRequired: true, notification: decision.notify ? terminal.notification : undefined });
        const followUpWorkflowRunId = await this.admitLateRenderFollowUp(tx, attempt);
        await this.emitFinishedOperations(tx, attempt);
        return { status: terminal.status, requested: terminal.requested, succeeded: terminal.succeeded,
          failed: terminal.failed, superseded: terminal.superseded, followUpWorkflowRunId };
      }
    });
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
      this.failAttemptWithin(tx, attempt, failure, options),
    );
  }

  private async failAttemptWithin(
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
    attempt: WorkflowAttemptRef,
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
    attempt: WorkflowAttemptRef,
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
      { redisRequired: true, redisPublishedAt: null },
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
        if (event.redisRequired && !event.redisPublishedAt) {
          if (!(await renew())) continue;
          const published = await this.publishRedis(parsed);
          if (!published) {
            throw new Error("Workflow Redis publisher unavailable");
          }
          const acknowledged = await this.prisma.workflowEvent.updateMany({
            where: held(),
            data: { redisPublishedAt: new Date() },
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

let singleton: WorkflowRunLifecycle | null = null;

export function getWorkflowRunLifecycle() {
  singleton ??= new WorkflowRunLifecycle();
  return singleton;
}

export function workflowFailureFromUnknown(error: unknown): WorkflowFailure {
  if (error instanceof WorkflowFailure) return error;
  const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : "workflow_unexpected_error";
  const message =
    typeof candidate.message === "string" ? candidate.message : "Unexpected workflow failure";
  const retryable = isExpectedDomainFailure(error)
    ? error.details?.retryable
    : candidate.retryable;
  return new WorkflowFailure(
    code,
    retryable === false ? "permanent" : "retryable",
    message,
    error instanceof Error ? { cause: error } : undefined,
  );
}

export function rethrowWorkflowAttemptLost(error: unknown): void {
  if (error instanceof WorkflowAttemptLost) throw error;
}
