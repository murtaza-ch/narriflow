import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import { workflowStageUpdatedEventSchema } from "@narriflow/validators";
import type {
  ClipCategory,
  ContentPack,
  RenderTerminalNotificationPayload,
  WorkflowStage,
  WorkflowStageUpdatedEvent,
  WorkflowStatus,
} from "@narriflow/validators";
import { accessibleProjectWhere } from "./project-retention.service";
import {
  isWorkflowRedisDeliveryEnabled,
  publishPersistedWorkflowEvent,
} from "./workflow.service";
import { notificationService, type NotificationOutcome } from "./notification.service";
import { deriveClipExportAggregate } from "./clip-export-aggregate";
import {
  admitRetiredClipMediaCleanup,
} from "./media-cleanup";

export const WORKFLOW_LEASE_DURATION_MS = 2 * 60 * 1000;
export const WORKFLOW_HEARTBEAT_INTERVAL_MS = 30 * 1000;
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
    userId: string;
    workspaceId: string | null;
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
  providerJobId: string;
  submittedAt: Date;
}

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

export type RenderVariantFailureDisposition = "retryable" | "permanent";

export interface RenderWorkSetOutcome {
  status: "completed" | "partial" | "failed" | "requeued";
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
    payload: RenderTerminalNotificationPayload,
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
          payload.kind === "clip_render.failed"
            ? "generation_failed"
            : "clips_ready";
        await notificationService.handoff({
          projectId: payload.projectId,
          sourceId: payload.workflowRunId,
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
        return await this.prisma.$transaction(operation);
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
    const databaseClock = await tx.$queryRaw<Array<{ databaseNow: Date }>>`
      SELECT CURRENT_TIMESTAMP AS "databaseNow"
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

  private async appendEvent(
    tx: TransactionClient,
    input: {
      projectId: string;
      workflowRunId: string;
      attemptId: string;
      stage: WorkflowStage;
      status: WorkflowStatus;
      progress: number;
      errorCode: string | null;
      transition: string;
      analyticsRequired?: boolean;
      notification?: RenderTerminalNotificationPayload;
    },
  ) {
    const emittedAt = new Date();
    const dedupeKey = `${input.workflowRunId}:${input.attemptId}:${input.transition}`;
    const existing = await tx.workflowEvent.findUnique({
      where: { dedupeKey },
      select: { id: true },
    });
    if (existing) return;
    const projects = await tx.$queryRaw<Array<{ workflowEventSeq: number }>>`
      UPDATE "Project"
      SET "workflowEventSeq" = GREATEST(
        "workflowEventSeq",
        COALESCE(
          (
            SELECT MAX("seq")
            FROM "WorkflowEvent"
            WHERE "projectId" = ${input.projectId}::uuid
          ),
          0
        )
      ) + 1
      WHERE "id" = ${input.projectId}::uuid
      RETURNING "workflowEventSeq"
    `;
    const project = projects[0];
    if (!project) throw new Error("Workflow event project unavailable");
    const payload = {
      event: "workflow.stage.updated" as const,
      projectId: input.projectId,
      workflowRunId: input.workflowRunId,
      seq: project.workflowEventSeq,
      stage: input.stage,
      status: input.status,
      progress: input.progress,
      errorCode: input.errorCode,
      emittedAt: emittedAt.toISOString(),
      ...(input.notification ? { notification: input.notification } : {}),
    } satisfies WorkflowStageUpdatedEvent;

    await tx.workflowEvent.create({
      data: {
        projectId: input.projectId,
        workflowRunId: input.workflowRunId,
        seq: payload.seq,
        stage: input.stage,
        status: input.status,
        progress: input.progress,
        errorCode: input.errorCode,
        emittedAt,
        dedupeKey,
        eventType: payload.event,
        payload: payload as unknown as Prisma.InputJsonValue,
        availableAt: emittedAt,
        nextDeliveryAt: emittedAt,
        redisRequired: this.redisDeliveryRequired,
        analyticsRequired:
          (input.analyticsRequired ?? false) && Boolean(this.publishAnalytics),
        notificationRequired: Boolean(input.notification),
      },
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
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
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

  /** Admits a run and persists its domain handoff in the same transaction.
   * Workers can never claim a queued run whose required domain row is still
   * missing. The project advisory lock preserves the ordinary admission
   * serialization contract. */
  async admitWithHandoff<T>(
    input: AdmitWorkflowRunInput,
    handoff: (tx: TransactionClient, run: { id: string; created: boolean }) => Promise<T>,
  ): Promise<{ id: string; created: boolean; handoff: T }> {
    return this.transaction(async (tx) => {
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
        admitted = await this.admitWithinTransaction(tx, { ...input, contentPackId: input.contentPackId ?? null });
      }
      const value = await handoff(tx, admitted);
      return { ...admitted, handoff: value };
    });
  }

  async admitTranscript(
    input: AdmitTranscriptWorkflowRunInput,
  ): Promise<{ id: string; created: boolean }> {
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
          await this.requireCommittedContentPack(
            tx,
            input.projectId,
            contentPackId,
          );
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
      });
    } catch (error) {
      return this.recoverAdmissionConflict(
        { ...input, stage: "stt" },
        error,
      );
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

  async claim(stage: WorkflowStage): Promise<ClaimedWorkflowAttempt | null> {
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
        select: { id: true },
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
          progress: 10,
          attemptCount: { increment: 1 },
          attemptId,
          leaseOwner: this.leaseOwner,
          leaseExpiresAt,
          heartbeatAt: now,
          nextAttemptAt: null,
          nextPollAt: null,
          waitingSince: null,
          errorCode: null,
          requestedCount: null,
          succeededCount: null,
          failedCount: null,
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
              userId: true,
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
            provider: "assemblyai",
            providerJobId: null,
            workflowAttemptId: run.attemptId,
          },
          update: {
            status: "processing",
            providerJobId: null,
            workflowAttemptId: run.attemptId,
            errorCode: null,
          },
        });
      }

      if (stage === "clip_rendering") {
        await tx.clipRender.updateMany({
          where: {
            status: "rendering",
            clip: { projectId: run.projectId },
          },
          data: {
            status: "pending",
            workflowAttemptId: null,
            startedAt: null,
            errorCode: null,
          },
        });
      }

      await this.appendEvent(tx, {
        projectId: run.projectId,
        workflowRunId: run.id,
        attemptId: run.attemptId,
        stage: run.stage as WorkflowStage,
        status: "running",
        progress: run.progress,
        errorCode: null,
        transition: "claimed",
      });

      return {
        workflowRunId: run.id,
        projectId: run.projectId,
        stage: run.stage as WorkflowStage,
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

  async heartbeat(attempt: WorkflowAttemptRef): Promise<void> {
    const updated = await this.prisma.$executeRaw`
      UPDATE "WorkflowRun"
      SET
        "heartbeatAt" = CURRENT_TIMESTAMP,
        "leaseExpiresAt" = CURRENT_TIMESTAMP + (${this.leaseDurationMs} * INTERVAL '1 millisecond'),
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${attempt.workflowRunId}
        AND "projectId" = ${attempt.projectId}::uuid
        AND "stage" = ${attempt.stage}
        AND "status" = 'running'
        AND "attemptId" = ${attempt.attemptId}::uuid
        AND "leaseOwner" = ${this.leaseOwner}
        AND "leaseExpiresAt" > CURRENT_TIMESTAMP
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
            AND "leaseExpiresAt" > CURRENT_TIMESTAMP
          )
        )
      LIMIT 1
    `;
    if (owned.length === 0) throw new WorkflowAttemptLost(attempt);
  }

  /**
   * Runs a child-artifact mutation while holding the owning WorkflowRun row.
   * Reapers and takeover claims must acquire the same lock, so the attempt
   * cannot lose ownership between the fence check and its database writes.
   */
  async mutateOwnedAttempt<T>(
    attempt: WorkflowAttemptRef,
    operation: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (tx) => {
      await this.fenceChildMutation(tx, attempt, attempt.stage);
      return operation(tx);
    });
  }

  async beginRenderWorkSet(
    attempt: WorkflowAttemptRef,
  ): Promise<RenderWorkSet> {
    return this.transaction(async (tx) => {
      await this.fenceChildMutation(tx, attempt, "clip_rendering");
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
        AND "leaseExpiresAt" > CURRENT_TIMESTAMP
      FOR UPDATE
    `;
    if (owned.length === 0) throw new WorkflowAttemptLost(attempt);
  }

  private async fenceRenderAnalysisMutation(
    tx: TransactionClient,
    attempt: WorkflowAttemptRef,
    clipId: string,
  ): Promise<void> {
    await this.fenceChildMutation(tx, attempt, "clip_rendering");
    const ownedVariant = await tx.clipRender.findFirst({
      where: {
        clipId,
        status: "rendering",
        workflowRunId: attempt.workflowRunId,
        workflowAttemptId: attempt.attemptId,
        clip: { projectId: attempt.projectId },
      },
      select: { id: true },
    });
    if (!ownedVariant) throw new WorkflowAttemptLost(attempt);
  }

  private async syncClipExportAggregate(
    tx: TransactionClient,
    exportVariantId: string,
  ): Promise<void> {
    const variant = await tx.clipExportVariant.findUniqueOrThrow({
      where: { id: exportVariantId },
      select: { exportId: true },
    });
    // Serialize aggregate recomputation for siblings. Without locking the
    // parent first, two child completions can each observe the other child as
    // non-terminal and leave the export stuck below 100%.
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "ClipExport"
      WHERE "id" = ${variant.exportId}::uuid
      FOR UPDATE
    `;
    const variants = await tx.clipExportVariant.findMany({
      where: { exportId: variant.exportId },
      select: { status: true, errorCode: true },
    });
    const aggregate = deriveClipExportAggregate(
      variants.map((item) => item.status),
    );
    const firstError =
      variants.find((item) => item.errorCode)?.errorCode ?? null;
    await tx.clipExport.update({
      where: { id: variant.exportId },
      data: {
        status: aggregate.status,
        progress: aggregate.progress,
        errorCode: aggregate.status === "failed" ? firstError : null,
        completedAt: aggregate.terminal ? new Date() : null,
      },
    });
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

  async markClipRenderVariantRendering(
    attempt: WorkflowAttemptRef,
    clipRenderId: string,
  ) {
    return this.transaction(async (tx) => {
      await this.fenceChildMutation(tx, attempt, "clip_rendering");
      const render = await tx.clipRender.findFirst({
        where: { id: clipRenderId, clip: { projectId: attempt.projectId } },
        select: { exportVariantId: true },
      });
      if (!render) return false;
      const startedAt = new Date();
      const claim = await tx.clipRender.updateMany({
        where: {
          id: clipRenderId,
          status: "pending",
          workflowRunId: attempt.workflowRunId,
          clip: { projectId: attempt.projectId },
        },
        data: {
          status: "rendering",
          workflowAttemptId: attempt.attemptId,
          failureDisposition: null,
          startedAt,
          errorCode: null,
        },
      });
      if (claim.count === 0) return false;
      if (render.exportVariantId) {
        await tx.clipExportVariant.update({
          where: { id: render.exportVariantId },
          data: {
            status: "rendering",
            startedAt,
            errorCode: null,
          },
        });
        await this.syncClipExportAggregate(tx, render.exportVariantId);
      }
      return true;
    });
  }

  async completeClipRenderVariant(
    attempt: WorkflowAttemptRef,
    clipRenderId: string,
    input: {
      storageKey: string;
      sizeBytes: number;
      durationSec: number;
    },
  ) {
    return this.transaction(async (tx) => {
      await this.fenceChildMutation(tx, attempt, "clip_rendering");
      const render = await tx.clipRender.findFirst({
        where: { id: clipRenderId, clip: { projectId: attempt.projectId } },
        select: { exportVariantId: true },
      });
      if (!render) return false;
      const completedAt = new Date();
      const claim = await tx.clipRender.updateMany({
        where: {
          id: clipRenderId,
          status: "rendering",
          workflowAttemptId: attempt.attemptId,
          workflowRunId: attempt.workflowRunId,
          clip: { projectId: attempt.projectId },
        },
        data: {
          status: "completed",
          storageKey: input.storageKey,
          sizeBytes: BigInt(input.sizeBytes),
          durationSec: input.durationSec,
          errorCode: null,
          failureDisposition: null,
          completedAt,
        },
      });
      if (claim.count === 0) return false;
      if (render.exportVariantId) {
        await tx.clipExportVariant.update({
          where: { id: render.exportVariantId },
          data: {
            status: "completed",
            storageKey: input.storageKey,
            sizeBytes: BigInt(input.sizeBytes),
            durationSec: input.durationSec,
            errorCode: null,
            completedAt,
          },
        });
        await this.syncClipExportAggregate(tx, render.exportVariantId);
      }
      const run = await tx.workflowRun.findUniqueOrThrow({
        where: { id: attempt.workflowRunId },
        select: { progress: true },
      });
      await this.appendEvent(tx, {
        projectId: attempt.projectId,
        workflowRunId: attempt.workflowRunId,
        attemptId: attempt.attemptId,
        stage: "clip_rendering",
        status: "running",
        progress: run.progress,
        errorCode: null,
        transition: `child_completed:${clipRenderId}`,
      });
      return true;
    });
  }

  async failClipRenderVariant(
    attempt: WorkflowAttemptRef,
    clipRenderId: string,
    errorCode: string,
    disposition: RenderVariantFailureDisposition,
  ) {
    return this.transaction(async (tx) => {
      await this.fenceChildMutation(tx, attempt, "clip_rendering");
      const render = await tx.clipRender.findFirst({
        where: { id: clipRenderId, clip: { projectId: attempt.projectId } },
        select: { exportVariantId: true },
      });
      if (!render) return false;
      const claim = await tx.clipRender.updateMany({
        where: {
          id: clipRenderId,
          status: "rendering",
          workflowAttemptId: attempt.attemptId,
          workflowRunId: attempt.workflowRunId,
          clip: { projectId: attempt.projectId },
        },
        data: {
          status: "failed",
          errorCode,
          failureDisposition: disposition,
          completedAt: new Date(),
        },
      });
      if (claim.count === 0) return false;
      if (render.exportVariantId) {
        await tx.clipExportVariant.update({
          where: { id: render.exportVariantId },
          data: { status: "failed", errorCode },
        });
        await this.syncClipExportAggregate(tx, render.exportVariantId);
      }
      return true;
    });
  }

  async completeClipAutoLayoutAnalysis(
    attempt: WorkflowAttemptRef,
    input: {
      clipId: string;
      analysis: Prisma.InputJsonValue;
      editorRevision: number;
      previewStorageKey: string;
    },
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      await this.fenceRenderAnalysisMutation(tx, attempt, input.clipId);
      const claim = await tx.clip.updateMany({
        where: {
          id: input.clipId,
          projectId: attempt.projectId,
          editorRevision: input.editorRevision,
          previewStorageKey: input.previewStorageKey,
          autoLayoutAnalysis: { equals: Prisma.DbNull },
        },
        data: {
          autoLayoutAnalysis: input.analysis,
          autoLayoutStatus: "completed",
          autoLayoutClaimToken: null,
          autoLayoutLeaseExpiresAt: null,
        },
      });
      return claim.count === 1;
    });
  }

  async completeClipSplitLayoutAnalysis(
    attempt: WorkflowAttemptRef,
    input: {
      clipId: string;
      analysis: Prisma.InputJsonValue;
      editorRevision: number;
      previewStorageKey: string;
    },
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      await this.fenceRenderAnalysisMutation(tx, attempt, input.clipId);
      const claim = await tx.clip.updateMany({
        where: {
          id: input.clipId,
          projectId: attempt.projectId,
          editorRevision: input.editorRevision,
          previewStorageKey: input.previewStorageKey,
        },
        data: {
          splitLayoutAnalysis: input.analysis,
        },
      });
      return claim.count === 1;
    });
  }

  async completeClipSplitLayoutFailure(
    attempt: WorkflowAttemptRef,
    input: {
      clipId: string;
      failure: Prisma.InputJsonValue;
      editorRevision: number;
      previewStorageKey: string;
    },
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      await this.fenceRenderAnalysisMutation(tx, attempt, input.clipId);
      const claim = await tx.clip.updateMany({
        where: {
          id: input.clipId,
          projectId: attempt.projectId,
          editorRevision: input.editorRevision,
          previewStorageKey: input.previewStorageKey,
        },
        data: { splitLayoutAnalysis: input.failure },
      });
      return claim.count === 1;
    });
  }

  async setClipLayoutAnalysis(
    attempt: WorkflowAttemptRef,
    input: {
      clipId: string;
      analysis: Prisma.InputJsonValue;
      editorRevision: number;
      previewStorageKey: string;
    },
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      await this.fenceRenderAnalysisMutation(tx, attempt, input.clipId);
      const claim = await tx.clip.updateMany({
        where: {
          id: input.clipId,
          projectId: attempt.projectId,
          editorRevision: input.editorRevision,
          previewStorageKey: input.previewStorageKey,
        },
        data: { layoutAnalysis: input.analysis },
      });
      return claim.count === 1;
    });
  }

  async setClipLayoutAnalysisFailure(
    attempt: WorkflowAttemptRef,
    input: {
      clipId: string;
      failure: Prisma.InputJsonValue;
      editorRevision: number;
      previewStorageKey: string;
    },
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      await this.fenceRenderAnalysisMutation(tx, attempt, input.clipId);
      const claim = await tx.clip.updateMany({
        where: {
          id: input.clipId,
          projectId: attempt.projectId,
          editorRevision: input.editorRevision,
          previewStorageKey: input.previewStorageKey,
        },
        data: { layoutAnalysis: input.failure },
      });
      return claim.count === 1;
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
      // binds them to the render run, and markClipRenderVariantRendering binds
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
      if (existing) return { id: existing.id, created: false };

      const active = await tx.workflowRun.findFirst({
        where: {
          projectId: attempt.projectId,
          stage: "clip_rendering",
          status: { in: ["queued", "running", "waiting"] },
        },
        select: { id: true },
      });
      if (active) return { id: active.id, created: false };

      return this.admitWithinTransaction(tx, {
        projectId: attempt.projectId,
        idempotencyKey: input.idempotencyKey,
        stage: "clip_rendering",
        contentPackId: null,
      });
    });
  }

  async markDubProcessing(attempt: WorkflowAttemptRef, dubId: string) {
    return this.transaction(async (tx) => {
      await this.fenceChildMutation(tx, attempt, "dubbing");
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
      return tx.clipDub.updateMany({
        where: {
          id: dubId,
          projectId: attempt.projectId,
          status: "processing",
          workflowAttemptId: attempt.attemptId,
        },
        data,
      });
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

  async runAttempt<T>(
    attempt: WorkflowAttemptRef,
    handler: (context: WorkflowAttemptContext) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let ownershipError: WorkflowAttemptLost | null = null;
    let heartbeatInFlight = false;
    const heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight || ownershipError) return;
      heartbeatInFlight = true;
      void this.heartbeat(attempt)
        .catch(() => {
          ownershipError = new WorkflowAttemptLost(attempt);
          controller.abort(ownershipError);
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
      return result;
    } catch (error) {
      if (ownershipError) throw ownershipError;
      throw error;
    } finally {
      clearInterval(heartbeatTimer);
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
        project: {
          transcript: {
            providerJobId: { not: null },
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
      if (
        !run.attemptId ||
        !transcript?.providerJobId ||
        transcript.workflowAttemptId !== run.attemptId
      ) {
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
    await this.transaction(async (tx) => {
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

  async completeStage(attempt: WorkflowAttemptRef) {
    await this.settleSuccess(attempt, "completed", null);
  }

  async completeTranscript(
    attempt: WorkflowAttemptRef,
    input: CompleteTranscriptInput,
  ) {
    await this.transaction(async (tx) => {
      const databaseNow = await this.databaseNow(tx);
      const run = await tx.workflowRun.findFirst({
        where: {
          ...this.ownedAttemptWhere(attempt, databaseNow),
          stage: "stt",
        },
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
      await tx.transcript.upsert({
        where: { projectId: attempt.projectId },
        create: {
          projectId: attempt.projectId,
          status: "completed",
          workflowAttemptId: attempt.attemptId,
          provider: input.provider,
          providerModel: input.providerModel,
          providerJobId: input.providerJobId,
          languageCode: input.languageCode,
          languageConfidence: input.languageConfidence,
          text: input.text,
          utterancesJson: input.utterances as Prisma.InputJsonValue,
          speakerCount: input.speakerCount,
          durationSeconds: input.durationSeconds,
          rawStorageKey: input.rawStorageKey,
          errorCode: null,
          completedAt,
        },
        update: {
          status: "completed",
          workflowAttemptId: attempt.attemptId,
          provider: input.provider,
          providerModel: input.providerModel,
          providerJobId: input.providerJobId,
          languageCode: input.languageCode,
          languageConfidence: input.languageConfidence,
          text: input.text,
          utterancesJson: input.utterances as Prisma.InputJsonValue,
          speakerCount: input.speakerCount,
          durationSeconds: input.durationSeconds,
          rawStorageKey: input.rawStorageKey,
          errorCode: null,
          completedAt,
        },
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
        where: {
          ...this.ownedAttemptWhere(attempt, databaseNow),
          id: run.id,
        },
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
    });
  }

  async completeMomentDetection(attempt: WorkflowAttemptRef) {
    await this.completeStage(attempt);
  }

  /**
   * Settles the complete durable Render Work Set in one fenced transaction.
   * Callers never derive aggregate state or admit late work themselves.
   */
  async settleRenderWorkSet(
    attempt: WorkflowAttemptRef,
  ): Promise<RenderWorkSetOutcome> {
    if (attempt.stage !== "clip_rendering") throw new WorkflowAttemptLost(attempt);
    return this.transaction(async (tx) => {
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
        select: { requestedCount: true, attemptCount: true },
      });
      const variants = await tx.clipRender.findMany({
        where: { workflowRunId: attempt.workflowRunId },
        select: {
          id: true,
          status: true,
          failureDisposition: true,
          exportVariantId: true,
        },
      });
      const requested = Math.max(run.requestedCount ?? variants.length, variants.length);
      const succeeded = variants.filter((variant) => variant.status === "completed").length;
      const permanentFailed = variants.filter(
        (variant) =>
          variant.status === "failed" &&
          variant.failureDisposition === "permanent",
      );
      const settledFailed = variants.filter(
        (variant) =>
          variant.status === "failed" &&
          variant.failureDisposition !== "retryable",
      );
      const retryable = variants.filter(
        (variant) =>
          variant.status === "pending" ||
          variant.status === "rendering" ||
          (variant.status === "failed" &&
            variant.failureDisposition === "retryable"),
      );
      const superseded = Math.max(0, requested - variants.length);
      const shouldRequeue =
        succeeded === 0 &&
        retryable.length > 0 &&
        run.attemptCount < WORKFLOW_MAX_ATTEMPTS;

      if (shouldRequeue) {
        const settledFailedCount = settledFailed.length;
        const databaseNow = await this.databaseNow(tx);
        await tx.clipRender.updateMany({
          where: { id: { in: retryable.map((variant) => variant.id) } },
          data: {
            status: "pending",
            workflowAttemptId: null,
            failureDisposition: null,
            storageKey: null,
            sizeBytes: null,
            durationSec: null,
            errorCode: null,
            startedAt: null,
            completedAt: null,
          },
        });
        const exportVariantIds = retryable.flatMap((variant) =>
          variant.exportVariantId ? [variant.exportVariantId] : [],
        );
        if (exportVariantIds.length > 0) {
          await tx.clipExportVariant.updateMany({
            where: { id: { in: exportVariantIds } },
            data: {
              status: "pending",
              storageKey: null,
              sizeBytes: null,
              durationSec: null,
              errorCode: null,
              startedAt: null,
              completedAt: null,
            },
          });
        }
        await tx.workflowRun.update({
          where: { id: attempt.workflowRunId },
          data: {
            status: "queued",
            progress: 0,
            errorCode: null,
            attemptId: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            nextAttemptAt: new Date(
              databaseNow.getTime() + retryBackoffMs(run.attemptCount),
            ),
            requestedCount: requested,
            succeededCount: succeeded,
            failedCount: settledFailedCount,
          },
        });
        await this.appendEvent(tx, {
          projectId: attempt.projectId,
          workflowRunId: attempt.workflowRunId,
          attemptId: attempt.attemptId,
          stage: "clip_rendering",
          status: "queued",
          progress: 0,
          errorCode: null,
          transition: `requeued:${run.attemptCount}`,
        });
        return {
          status: "requeued",
          requested,
          succeeded,
          failed: settledFailedCount,
          superseded,
          followUpWorkflowRunId: null,
        };
      }

      const terminal = await this.settleTerminalRenderLineage(tx, attempt, {
        requestedCount: run.requestedCount,
        variants,
        failureErrorCode:
          retryable.length > 0 && run.attemptCount >= WORKFLOW_MAX_ATTEMPTS
            ? WORKFLOW_RETRIES_EXHAUSTED_CODE
            : permanentFailed[0]
              ? "render_work_set_failed"
              : "aggregate_failed",
      });
      await this.appendEvent(tx, {
        projectId: attempt.projectId,
        workflowRunId: attempt.workflowRunId,
        attemptId: attempt.attemptId,
        stage: "clip_rendering",
        status: terminal.status,
        progress: 100,
        errorCode: terminal.errorCode,
        transition: `terminal:${terminal.status}`,
        analyticsRequired: true,
        notification: terminal.notification,
      });
      const followUpWorkflowRunId = await this.admitLateRenderFollowUp(
        tx,
        attempt,
      );

      return {
        status: terminal.status,
        requested: terminal.requested,
        succeeded: terminal.succeeded,
        failed: terminal.failed,
        superseded: terminal.superseded,
        followUpWorkflowRunId,
      };
    });
  }

  async completeRendering(
    attempt: WorkflowAttemptRef,
    failedVariantCount = 0,
  ) {
    const [succeededCount, persistedFailedCount] = await Promise.all([
      this.prisma.clipRender.count({
        where: {
          clip: { projectId: attempt.projectId },
          workflowAttemptId: attempt.attemptId,
          status: "completed",
        },
      }),
      this.prisma.clipRender.count({
        where: {
          clip: { projectId: attempt.projectId },
          workflowAttemptId: attempt.attemptId,
          status: "failed",
        },
      }),
    ]);
    const failedCount = Math.max(failedVariantCount, persistedFailedCount);
    await this.completeAggregateStage(attempt, {
      requestedCount: succeededCount + failedCount,
      succeededCount,
      failedCount,
    });
  }

  async completeDubbing(attempt: WorkflowAttemptRef) {
    const [succeededCount, failedCount] = await Promise.all([
      this.prisma.clipDub.count({
        where: {
          projectId: attempt.projectId,
          workflowAttemptId: attempt.attemptId,
          status: "completed",
        },
      }),
      this.prisma.clipDub.count({
        where: {
          projectId: attempt.projectId,
          workflowAttemptId: attempt.attemptId,
          status: "failed",
        },
      }),
    ]);
    const terminalCount = succeededCount + failedCount;
    if (terminalCount === 0) {
      await this.completeStage(attempt);
      return;
    }
    await this.completeAggregateStage(attempt, {
      requestedCount: terminalCount,
      succeededCount,
      failedCount,
    });
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
  ) {
    await this.transaction(async (tx) => {
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
      });
    });
  }

  async failAttempt(
    attempt: WorkflowAttemptRef,
    failure: WorkflowFailure,
    options: { expiredLeaseOnly?: boolean } = {},
  ) {
    await this.transaction(async (tx) => {
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
      if (requeue || attempt.stage !== "clip_rendering") {
        await this.settleAttemptChildren(tx, attempt, {
          requeue,
          errorCode: errorCode ?? failure.code,
        });
      }
      let settledStatus: WorkflowStatus = status;
      let settledErrorCode = errorCode;
      let notification: RenderTerminalNotificationPayload | undefined;
      if (!requeue && attempt.stage === "clip_rendering") {
        const variants = await tx.clipRender.findMany({
          where: { workflowRunId: attempt.workflowRunId },
          select: { id: true, status: true, exportVariantId: true },
        });
        const terminal = await this.settleTerminalRenderLineage(tx, attempt, {
          requestedCount: run.requestedCount,
          variants,
          failureErrorCode: errorCode ?? failure.code,
          unfinishedErrorCode: errorCode ?? failure.code,
        });
        settledStatus = terminal.status;
        settledErrorCode = terminal.errorCode;
        notification = terminal.notification;
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
        notification,
      });
      if (!requeue && attempt.stage === "clip_rendering") {
        await this.admitLateRenderFollowUp(tx, attempt);
      }
    });
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
    if (attempt.stage === "clip_rendering") {
      const renderWhere: Prisma.ClipRenderWhereInput = {
        clip: { projectId: attempt.projectId },
        workflowAttemptId: attempt.attemptId,
        ...(outcome.requeue
          ? {
              OR: [
                { status: "rendering" as const },
                {
                  status: "failed" as const,
                  failureDisposition: "retryable",
                },
              ],
            }
          : {
              OR: [
                { status: "rendering" as const },
                {
                  status: "failed" as const,
                  failureDisposition: { not: "permanent" },
                },
              ],
            }),
      };
      const affectedRenders = await tx.clipRender.findMany({
        where: renderWhere,
        select: { id: true, exportVariantId: true },
      });
      await tx.clipRender.updateMany({
        where: { id: { in: affectedRenders.map((render) => render.id) } },
        data: outcome.requeue
          ? {
              status: "pending",
              workflowAttemptId: null,
              storageKey: null,
              sizeBytes: null,
              durationSec: null,
              errorCode: null,
              startedAt: null,
              completedAt: null,
              failureDisposition: null,
            }
          : {
              status: "failed",
              errorCode: outcome.errorCode,
              failureDisposition: "retryable",
              completedAt: new Date(),
            },
      });
      const exportVariantIds = affectedRenders.flatMap((render) =>
        render.exportVariantId ? [render.exportVariantId] : [],
      );
      if (exportVariantIds.length > 0) {
        await tx.clipExportVariant.updateMany({
          where: { id: { in: exportVariantIds } },
          data: outcome.requeue
            ? {
                status: "pending",
                storageKey: null,
                sizeBytes: null,
                durationSec: null,
                errorCode: null,
                startedAt: null,
                completedAt: null,
              }
            : {
                status: "failed",
                errorCode: outcome.errorCode,
                completedAt: new Date(),
              },
        });
      }
    }
    if (attempt.stage === "dubbing") {
      await tx.clipDub.updateMany({
        where: {
          projectId: attempt.projectId,
          workflowAttemptId: attempt.attemptId,
          status: { in: ["processing", "failed"] },
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
              errorCode: outcome.errorCode,
              completedAt: new Date(),
            },
      });
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
              errorCode: null,
            }
          : {
              status: "failed",
              errorCode: outcome.errorCode,
            },
      });
    }
  }

  async reapExpiredAttempts(): Promise<number> {
    const databaseClock = await this.prisma.$queryRaw<
      Array<{ databaseNow: Date }>
    >`SELECT CURRENT_TIMESTAMP AS "databaseNow"`;
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
    const candidates = await this.prisma.workflowEvent.findMany({
      where: {
        dedupeKey: { not: null },
        deadLetteredAt: null,
        nextDeliveryAt: { lte: now },
        OR: [
          { deliveryLeaseExpiresAt: null },
          { deliveryLeaseExpiresAt: { lte: now } },
        ],
        AND: [
          {
            OR: [
              { redisRequired: true, redisPublishedAt: null },
              { analyticsRequired: true, analyticsPublishedAt: null },
              {
                notificationRequired: true,
                notificationDeliveredAt: null,
              },
            ],
          },
        ],
      },
      orderBy: [{ projectId: "asc" }, { seq: "asc" }],
      take: batchSize,
    });

    let delivered = 0;
    for (const event of candidates) {
      const leaseExpiresAt = new Date(now.getTime() + EVENT_DELIVERY_LEASE_MS);
      const claimed = await this.prisma.workflowEvent.updateMany({
        where: {
          id: event.id,
          deadLetteredAt: null,
          OR: [
            { deliveryLeaseExpiresAt: null },
            { deliveryLeaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          deliveryLeaseOwner: this.leaseOwner,
          deliveryLeaseExpiresAt: leaseExpiresAt,
          deliveryAttempts: { increment: 1 },
        },
      });
      if (claimed.count === 0 || !event.dedupeKey) continue;

      try {
        const parsed = workflowStageUpdatedEventSchema.parse(event.payload);
        if (event.redisRequired && !event.redisPublishedAt) {
          const published = await this.publishRedis(parsed);
          if (!published) {
            throw new Error("Workflow Redis publisher unavailable");
          }
          const acknowledged = await this.prisma.workflowEvent.updateMany({
            where: {
              id: event.id,
              deliveryLeaseOwner: this.leaseOwner,
            },
            data: { redisPublishedAt: new Date() },
          });
          if (acknowledged.count === 0) continue;
        }
        if (event.analyticsRequired && !event.analyticsPublishedAt) {
          if (this.publishAnalytics) {
            await this.publishAnalytics(parsed, event.dedupeKey);
          }
          const acknowledged = await this.prisma.workflowEvent.updateMany({
            where: {
              id: event.id,
              deliveryLeaseOwner: this.leaseOwner,
            },
            data: { analyticsPublishedAt: new Date() },
          });
          if (acknowledged.count === 0) continue;
        }
        if (event.notificationRequired && !event.notificationDeliveredAt) {
          const notification = parsed.notification;
          if (!notification) {
            throw new Error("Render notification payload unavailable");
          }
          await this.handoffNotification(notification);
          const acknowledged = await this.prisma.workflowEvent.updateMany({
            where: {
              id: event.id,
              deliveryLeaseOwner: this.leaseOwner,
            },
            data: { notificationDeliveredAt: new Date() },
          });
          if (acknowledged.count === 0) continue;
        }
        const released = await this.prisma.workflowEvent.updateMany({
          where: {
            id: event.id,
            deliveryLeaseOwner: this.leaseOwner,
          },
          data: {
            deliveryLeaseOwner: null,
            deliveryLeaseExpiresAt: null,
            lastDeliveryError: null,
          },
        });
        if (released.count > 0) delivered += 1;
      } catch (error) {
        const attempts = event.deliveryAttempts + 1;
        await this.prisma.workflowEvent.updateMany({
          where: {
            id: event.id,
            deliveryLeaseOwner: this.leaseOwner,
          },
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
  return new WorkflowFailure(
    code,
    candidate.retryable === false ? "permanent" : "retryable",
    message,
    error instanceof Error ? { cause: error } : undefined,
  );
}

export function rethrowWorkflowAttemptLost(error: unknown): void {
  if (error instanceof WorkflowAttemptLost) throw error;
}
