import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
  IngestJobType,
  IngestStatus as PrismaIngestStatus,
  Project,
  Transcript as PrismaTranscript,
  TranscriptStatus as PrismaTranscriptStatus,
  WorkflowRun as PrismaWorkflowRun,
} from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  ASSEMBLYAI_SPEECH_MODEL_CHAIN,
  completeMultipartUploadSchema,
  parseStoredContentPack,
  createProjectSchema,
  detectLinkProvider,
  generateProjectRequestSchema,
  isProcessingQuotaExceeded,
  linkIngestSchema,
  MAX_UPLOAD_LENGTH_SECONDS,
  MONTHLY_PROCESSING_MINUTE_LIMITS,
  processingMinutesFromSeconds,
  presignUploadSchema,
  resolvePricingTier,
  rssImportSchema,
  rssPreviewSchema,
  sourceLanguageCodeSchema,
  workflowStageUpdatedEventSchema,
  contentPackSchema,
  PLATFORM_PLAYBOOK_VERSION,
  type ContentPack,
  type CreateProjectInput,
  type GenerateProjectInput,
  type LinkIngestInput,
  type PricingTier,
  type PresignUploadInput,
  type CompleteMultipartUploadInput,
  type RssImportInput,
  type TranscriptExportFormat,
  type TranscriptSnapshot,
  type WorkflowStageUpdatedEvent,
} from "@narriflow/validators";
import {
  abortMultipartUpload,
  completeMultipartUpload as completeR2MultipartUpload,
  createMultipartUpload,
  deleteObject,
  headObject,
  isR2Configured,
  listUploadedParts,
  presignMultipartPartUrls,
} from "./r2-storage";
import { brandTemplateService } from "./brand-template.service";
import {
  autoTriggerIdempotencyKey,
  isUniqueConstraintError,
  selectActionablePack,
  type FinalizeSetupResult,
} from "./generation-sequencing";
import { fetchRssFeed, redactUrlForDisplay } from "./rss";
import {
  buildTranscriptSnapshot,
  exportTranscript,
} from "./transcript.service";
import {
  getLastWorkflowSeq,
  getWorkflowEventsSince,
  publishWorkflowStageUpdated,
} from "./workflow.service";
import {
  accessibleProjectWhere,
  ProjectExpiredError,
  projectRetentionService,
  type RetentionPolicyKey,
} from "./project-retention.service";
import {
  workspaceService,
  type WorkspaceCapability,
} from "./workspace.service";
import {
  currentWorkflowAttempt,
  getWorkflowRunLifecycle,
  WorkflowAttemptContextRequired,
  WorkflowFailure,
  WORKFLOW_LIFECYCLE_VERSION,
} from "./workflow-run-lifecycle";

interface ProjectSnapshot {
  id: string;
  userId: string;
  workspaceId: string | null;
  folderId?: string | null;
  title: string;
  sourceMediaUrl: string;
  sourceType: "upload" | "youtube" | "rss" | "link";
  sourceProvider: string | null;
  sourceInput: string | null;
  sourceStorageKey: string | null;
  sourceMimeType: string | null;
  sourceSizeBytes: number | null;
  sourceDurationSeconds: number | null;
  languageCode: string | null;
  ingestStatus: PrismaIngestStatus;
  ingestErrorCode: string | null;
  ingestCompletedAt: string | null;
  notifyOnComplete: boolean;
  retentionPolicyKey: RetentionPolicyKey | null;
  expiresAt: string | null;
  persisted: boolean;
  createdAt: string;
}

const MAX_CONCURRENT_RSS_INGESTS_PER_WORKSPACE = 5;

export interface ProjectListItem extends ProjectSnapshot {
  clipCount: number;
  avgViralityScore: number | null;
  transcript: {
    languageCode: string | null;
    speakerCount: number | null;
    durationSeconds: number | null;
    status: PrismaTranscriptStatus;
  } | null;
}

export type ProjectListStatusFilter =
  | "all"
  | "ready"
  | "processing"
  | "queued"
  | "failed";
export type ProjectListSourceFilter =
  | "all"
  | "youtube"
  | "link"
  | "upload"
  | "rss";
export type ProjectListSort = "newest" | "oldest" | "title" | "clips";

export interface ProjectListPage {
  items: ProjectListItem[];
  nextCursor: string | null;
  totalCount: number;
  statusCounts: Record<ProjectListStatusFilter, number>;
}

type ProjectAccessResult = "owned" | "forbidden" | "missing";

type IngestLifecycleStatus =
  | "queued"
  | "downloading"
  | "normalizing"
  | "ready"
  | "failed";

interface ClaimedIngestJob {
  id: string;
  projectId: string;
  jobType: IngestJobType;
  payload: Prisma.JsonValue;
  attemptCount: number;
}

interface ClaimedWorkflowRun {
  id: string;
  projectId: string;
  stage: string;
  status: string;
  progress: number;
  contentPackId: string | null;
  lifecycleVersion: number;
  attemptId: string | null;
  attemptCount: number;
  project: Pick<
    Project,
    | "id"
    | "title"
    | "sourceMediaUrl"
    | "sourceType"
    | "sourceInput"
    | "sourceStorageKey"
    | "sourceMimeType"
    | "sourceDurationSeconds"
    | "userId"
    | "workspaceId"
  >;
}

const projects = new Map<string, ProjectSnapshot>();
const idempotencyRuns = new Map<string, string>();

const UPLOAD_SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const STT_PROVIDER = "assemblyai";
const STT_PROVIDER_MODEL = ASSEMBLYAI_SPEECH_MODEL_CHAIN.join(",");
const DEFAULT_PROJECT_PAGE_SIZE = 50;
const MAX_PROJECT_PAGE_SIZE = 100;
// Defensive upper bound on how many persisted WorkflowEvent rows a single
// project page fetch will ever pull for the Activity tab; the client applies
// its own tighter display cap (PROJECT_EVENT_ROW_LIMIT) on top of this.
const WORKFLOW_HISTORY_FETCH_LIMIT = 200;

function clampProjectPageSize(limit?: number) {
  if (!Number.isFinite(limit ?? DEFAULT_PROJECT_PAGE_SIZE)) {
    return DEFAULT_PROJECT_PAGE_SIZE;
  }

  return Math.max(
    1,
    Math.min(MAX_PROJECT_PAGE_SIZE, Math.floor(limit ?? DEFAULT_PROJECT_PAGE_SIZE)),
  );
}

function encodeProjectCursor(offset: number) {
  return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

function decodeProjectCursor(cursor: string | null | undefined) {
  if (!cursor) return 0;

  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { offset?: unknown };

    return typeof parsed.offset === "number" &&
      Number.isSafeInteger(parsed.offset) &&
      parsed.offset >= 0
      ? parsed.offset
      : 0;
  } catch {
    return 0;
  }
}

function projectStatusWhere(
  status: ProjectListStatusFilter,
): Prisma.ProjectWhereInput {
  if (status === "all") return {};
  if (status === "processing") {
    return {
      ingestStatus: {
        in: ["pending", "uploading", "downloading", "normalizing"],
      },
    };
  }
  return { ingestStatus: status };
}

function projectListOrderBy(sort: ProjectListSort): Prisma.ProjectOrderByWithRelationInput[] {
  if (sort === "oldest") return [{ createdAt: "asc" }, { id: "asc" }];
  if (sort === "title") return [{ title: "asc" }, { id: "asc" }];
  if (sort === "clips") {
    return [{ clips: { _count: "desc" } }, { createdAt: "desc" }, { id: "desc" }];
  }
  return [{ createdAt: "desc" }, { id: "desc" }];
}

function emptyProjectStatusCounts(): Record<ProjectListStatusFilter, number> {
  return { all: 0, ready: 0, processing: 0, queued: 0, failed: 0 };
}

function getIdempotencyKey(projectId: string, idempotencyKey: string) {
  return `${projectId}:${idempotencyKey}`;
}

function hasDatabase() {
  return Boolean(getPrismaClient());
}

function sanitizeStorageFileName(fileName: string) {
  return fileName
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function providerErrorIdentifiers(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return { name: null, explicitCodes: [] as string[] };
  }

  const candidate = error as {
    name?: unknown;
    code?: unknown;
    Code?: unknown;
  };
  const explicitCodes = [candidate.code, candidate.Code].filter(
    (value): value is string => typeof value === "string",
  );

  return {
    name: typeof candidate.name === "string" ? candidate.name : null,
    explicitCodes,
  };
}

function hasExactProviderIdentifier(
  error: unknown,
  recognizedIdentifiers: readonly string[],
) {
  const { name, explicitCodes } = providerErrorIdentifiers(error);
  if (explicitCodes.length > 0) {
    return explicitCodes.every((code) =>
      recognizedIdentifiers.includes(code),
    );
  }
  return name !== null && recognizedIdentifiers.includes(name);
}

export function isMissingMultipartUploadError(error: unknown) {
  return hasExactProviderIdentifier(error, ["NoSuchUpload"]);
}

export function isMissingObjectError(error: unknown) {
  return hasExactProviderIdentifier(error, ["NoSuchKey", "NotFound"]);
}

export interface MultipartUploadPart {
  partNumber: number;
  etag: string;
}

export async function probeMultipartPartsForResume(
  listParts: () => Promise<readonly MultipartUploadPart[]>,
): Promise<
  | { kind: "found"; parts: readonly MultipartUploadPart[] }
  | { kind: "missing" }
> {
  try {
    return { kind: "found", parts: await listParts() };
  } catch (error) {
    if (isMissingMultipartUploadError(error)) {
      return { kind: "missing" };
    }
    throw error;
  }
}

export async function probeExactUploadObject(
  probe: () => Promise<unknown>,
): Promise<"present" | "missing"> {
  try {
    await probe();
    return "present";
  } catch (error) {
    if (isMissingObjectError(error)) {
      return "missing";
    }
    throw error;
  }
}

export function normalizeMultipartParts(
  parts: readonly MultipartUploadPart[],
  expectedPartCount: number,
  mode: "partial" | "complete",
): MultipartUploadPart[] | null {
  if (
    !Number.isInteger(expectedPartCount) ||
    expectedPartCount < 1 ||
    (mode === "complete" && parts.length !== expectedPartCount) ||
    parts.length > expectedPartCount
  ) {
    return null;
  }

  const byPartNumber = new Map<number, string>();
  for (const part of parts) {
    if (
      !part ||
      !Number.isInteger(part.partNumber) ||
      part.partNumber < 1 ||
      part.partNumber > expectedPartCount ||
      typeof part.etag !== "string" ||
      part.etag.trim().length === 0 ||
      byPartNumber.has(part.partNumber)
    ) {
      return null;
    }
    byPartNumber.set(part.partNumber, part.etag);
  }

  return Array.from(byPartNumber, ([partNumber, etag]) => ({
    partNumber,
    etag,
  })).sort((left, right) => left.partNumber - right.partNumber);
}

export type ExistingUploadSessionFacts = {
  projectId: string;
  fileName: string | null;
  partCount: number;
  status: "initiated" | "completed" | "aborted" | "expired";
  expiresAtMs: number;
};

export type ExistingUploadResumeResolution =
  | { kind: "completed"; projectId: string }
  | { kind: "active"; parts: MultipartUploadPart[] }
  | { kind: "unavailable"; shouldMarkExpired: boolean }
  | { kind: "reconciliation_required" };

export async function resolveExistingUploadResume(
  input: {
    session: ExistingUploadSessionFacts | null;
    requestedFileName: string;
    requestedPartCount: number;
    nowMs: number;
  },
  probes: {
    listParts(): Promise<
      | { kind: "found"; parts: readonly MultipartUploadPart[] }
      | { kind: "missing" }
    >;
    headObject(): Promise<"present" | "missing">;
  },
): Promise<ExistingUploadResumeResolution> {
  const session = input.session;
  if (
    !session ||
    session.fileName !== input.requestedFileName ||
    session.partCount !== input.requestedPartCount
  ) {
    return { kind: "unavailable", shouldMarkExpired: false };
  }

  if (session.status === "completed") {
    return { kind: "completed", projectId: session.projectId };
  }

  const isCurrent =
    session.status === "initiated" && session.expiresAtMs > input.nowMs;
  if (!isCurrent) {
    const objectState = await probes.headObject();
    if (objectState === "present") {
      return { kind: "reconciliation_required" };
    }
    return {
      kind: "unavailable",
      shouldMarkExpired: session.status === "initiated",
    };
  }

  const listed = await probes.listParts();
  if (listed.kind === "missing") {
    const objectState = await probes.headObject();
    return objectState === "present"
      ? { kind: "reconciliation_required" }
      : { kind: "unavailable", shouldMarkExpired: false };
  }

  const parts = normalizeMultipartParts(
    listed.parts,
    session.partCount,
    "partial",
  );
  return parts
    ? { kind: "active", parts }
    : { kind: "reconciliation_required" };
}

function bigintToNumber(value: bigint | number | null) {
  if (value === null) {
    return null;
  }

  return Number(value);
}

function buildR2Uri(key: string) {
  const bucket = process.env.R2_BUCKET ?? "unknown-bucket";
  return `r2://${bucket}/${key}`;
}

function toProjectSnapshot(row: Project): ProjectSnapshot {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    folderId: row.folderId,
    title: row.title,
    sourceMediaUrl: row.sourceMediaUrl,
    sourceType: row.sourceType,
    sourceProvider: row.sourceProvider,
    sourceInput: row.sourceInput,
    sourceStorageKey: row.sourceStorageKey,
    sourceMimeType: row.sourceMimeType,
    sourceSizeBytes: bigintToNumber(row.sourceSizeBytes),
    sourceDurationSeconds: row.sourceDurationSeconds,
    languageCode: row.languageCode,
    ingestStatus: row.ingestStatus,
    ingestErrorCode: row.ingestErrorCode,
    ingestCompletedAt: row.ingestCompletedAt
      ? row.ingestCompletedAt.toISOString()
      : null,
    notifyOnComplete: row.notifyOnComplete,
    retentionPolicyKey: row.retentionPolicyKey as RetentionPolicyKey | null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    persisted: true,
    createdAt: row.createdAt.toISOString(),
  };
}

function toWorkflowRunSnapshot(row: PrismaWorkflowRun) {
  return {
    workflowRunId: row.id,
    projectId: row.projectId,
    stage: row.stage,
    status: row.status,
    progress: row.progress,
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastSeq: 0,
  };
}

function toTranscriptSnapshot(row: PrismaTranscript): TranscriptSnapshot {
  return buildTranscriptSnapshot({
    projectId: row.projectId,
    status: row.status,
    provider: row.provider,
    providerModel: row.providerModel,
    providerJobId: row.providerJobId,
    languageCode: row.languageCode,
    languageConfidence: row.languageConfidence,
    text: row.text,
    utterancesJson: row.utterancesJson,
    speakerCount: row.speakerCount,
    durationSeconds: row.durationSeconds,
    errorCode: row.errorCode,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  });
}

function ingestToWorkflowStage(status: IngestLifecycleStatus) {
  if (status === "queued") {
    return "ingest_queued" as const;
  }

  if (status === "downloading") {
    return "ingest_downloading" as const;
  }

  if (status === "normalizing") {
    return "ingest_normalizing" as const;
  }

  if (status === "ready") {
    return "ingest_ready" as const;
  }

  return "ingest" as const;
}

function ingestProgress(status: IngestLifecycleStatus) {
  if (status === "queued") {
    return 5;
  }

  if (status === "downloading") {
    return 40;
  }

  if (status === "normalizing") {
    return 75;
  }

  return 100;
}

export class QuotaExceededError extends Error {
  code = "quota_exceeded";
  constructor(
    message: string,
    public readonly details: {
      tier: string;
      limitMinutes: number;
      usedMinutes: number;
      requestedMinutes: number;
    },
  ) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export class UploadTooLongError extends Error {
  code = "upload_too_long";
  constructor(
    message: string,
    public readonly details: { tier: string; maxSeconds: number; seconds: number },
  ) {
    super(message);
    this.name = "UploadTooLongError";
  }
}

export class UploadSessionUnavailableError extends Error {
  readonly code = "upload_session_unavailable";

  constructor() {
    super("The saved upload session is no longer available.");
    this.name = "UploadSessionUnavailableError";
  }
}

export class UploadCompletionReconciliationRequiredError extends Error {
  readonly code = "upload_completion_reconciliation_required";

  constructor() {
    super("The upload completion state needs to be reconciled.");
    this.name = "UploadCompletionReconciliationRequiredError";
  }
}

/** Total ingest attempts (original + retries) allowed per project before
 *  retryFailedIngest refuses and tells the user to start a new upload. */
export const MAX_INGEST_RETRY_ATTEMPTS = 5;

export class IngestRetryLimitExceededError extends Error {
  readonly code = "ingest_retry_limit_exceeded";

  constructor(public readonly maxAttempts: number) {
    super(
      `This upload has failed ${maxAttempts} times and can't be retried again automatically.`,
    );
    this.name = "IngestRetryLimitExceededError";
  }
}

export class IngestNotFailedError extends Error {
  readonly code = "ingest_not_failed";

  constructor() {
    super("This project's ingest isn't in a failed state.");
    this.name = "IngestNotFailedError";
  }
}

// ---------------------------------------------------------------------------
// Automatic job-level retry policy: requeue-with-backoff for IngestJob and
// WorkflowRun (stt/moment_detection/clip_rendering/dubbing), bounded by
// IngestJob.attemptCount / WorkflowRun.attemptCount (each incremented once
// per claim — see claimNextIngestJob / claimNextWorkflowRun below).
//
// This is the OUTER layer. apps/worker/src/tasks/{ingest,transcribe,
// detect-clips,render-clips,dubbing}.ts already retry a handful of their own
// sub-operations IN-PROCESS (a few seconds of jittered backoff, all within
// the SAME claimed attempt) before giving up and calling one of the
// fail*/reap* methods below with a terminal-looking error code. Before this
// policy existed, that call always meant permanent failure — verified in
// production: a Google Drive import died on "The socket connection was
// closed unexpectedly" with attemptCount: 1, and nothing ever retried it.
// This policy decides what happens instead: give the job/run a fresh, later
// attempt (a new claim, a new in-process retry budget, quite possibly a
// different worker process), or accept the failure as permanent.
//
// Distinct from the user-facing manual retry (retryFailedIngest /
// triggerGeneration / regenerateClips / triggerClipRendering): those always
// create a BRAND NEW IngestJob/WorkflowRun row with attemptCount back at 0,
// so they keep working unmodified once the caps below are exhausted on the
// old row. retryFailedIngest's own cap (MAX_INGEST_RETRY_ATTEMPTS, counted as
// IngestJob *rows* for the project) never even observes this layer's
// requeues, since a requeue reuses the same row instead of creating a new
// one — the two caps can't fight each other by construction.
// ---------------------------------------------------------------------------

/** How many times an ingest job / workflow run may be automatically requeued
 *  after a retryable failure (including a stalled-worker reap) before it is
 *  given up on for good. Deliberately smaller than, and independent of,
 *  MAX_INGEST_RETRY_ATTEMPTS above: these are "free", system-initiated
 *  attempts, while MAX_INGEST_RETRY_ATTEMPTS governs the separate,
 *  user-initiated "Retry ingest" budget. */
export const INGEST_AUTO_RETRY_MAX_ATTEMPTS = 3;
export const WORKFLOW_AUTO_RETRY_MAX_ATTEMPTS = 3;

/** Base delay for the exponential requeue backoff (doubles per attempt: 30s,
 *  60s, ...). See claimBackoffWhereClauses for how this is enforced without
 *  a `nextAttemptAt` column. */
const AUTO_RETRY_BASE_DELAY_MS = 30_000;

/** Terminal codes recorded once the caps above are reached on an
 *  otherwise-retryable failure — kept distinct from the original error code
 *  so the UI (userErrorMessage, packages/validators/src/error-messages.ts)
 *  can tell the user this was retried automatically rather than rejected
 *  outright. A permanent failure (PERMANENT_FAILURE_CODES) keeps its own
 *  specific code instead of either of these. */
export const INGEST_RETRIES_EXHAUSTED_CODE = "ingest_retries_exhausted";
export const WORKFLOW_RETRIES_EXHAUSTED_CODE = "workflow_retries_exhausted";

/**
 * Error codes that must never be auto-retried: the input, credentials, or
 * plan are the actual problem, so retrying changes nothing and only delays
 * the (identical) terminal failure the user needs to act on. Sourced by
 * reading every `throw new IngestWorkerError(...)` / `throw new
 * WorkflowWorkerError(...)` in apps/worker/src/tasks/{ingest,transcribe,
 * detect-clips,render-clips,dubbing}.ts (those files can't import this
 * policy, so keep this list in sync by hand if their codes change).
 *
 * Everything NOT listed here (including codes this list doesn't yet know
 * about) defaults to retryable in isAutoRetryableFailureCode below — bounded
 * by the attempt caps above, so the worst case for a permanent failure we
 * failed to enumerate is a couple of wasted, backed-off attempts before it
 * fails the same way anyway. That default is deliberate: it's what would
 * have caught the production incident this policy exists to fix.
 */
export const PERMANENT_FAILURE_CODES: ReadonlySet<string> = new Set([
  // SSRF-guard rejection / unsupported or invalid input URL
  // (packages/services/src/url-guard.ts, apps/worker/src/tasks/ingest.ts)
  "remote_url_unsafe",
  "link_unsupported_source",
  "link_missing_url",
  "link_download_missing_file",
  "rss_missing_enclosure",
  "youtube_missing_url", // legacy pre-unification codes, kept for old data
  "youtube_unsupported_source",
  // Unsupported / invalid / oversized media — the same file fails the same
  // way every time
  "remote_media_invalid_content_type",
  "remote_media_too_large",
  "media_duration_unavailable",
  "invalid_source_dimensions",
  "unsupported_aspect_ratio",
  // Plan / quota limits (won't change mid-retry)
  "ingest_max_duration_exceeded",
  "quota_exceeded",
  "requires_pro_plan",
  "requires_creator_plan",
  // Auth / environment configuration — retrying the job can't fix a missing
  // key or binary
  "assemblyai_api_key_missing",
  "openai_api_key_missing",
  "worker_command_missing",
  // Malformed job/payload: a bug, not a blip
  "worker_invalid_payload",
  "worker_unknown_job_type",
  "upload_finalize_missing_key",
  "storage_metadata_invalid",
  // Missing prerequisite data that this same job/run cannot itself create
  "workflow_source_missing",
  "source_storage_key_missing",
  "base_render_missing",
  "no_renderable_clips",
  "no_clips_detected",
  "transcript_not_ready",
  "transcript_processing_window_empty",
  "dub_transcript_empty",
  "broll_cutaways_empty",
]);

/**
 * Error codes explicitly confirmed retryable, called out even though they'd
 * hit the same default as any other unlisted code — worth being explicit
 * because each one looks like it should be permanent at first glance:
 *
 *  - remote_fetch_timeout / worker_command_timeout: apps/worker/src/tasks/
 *    ingest.ts deliberately excludes these from ITS OWN in-process retry
 *    (PERMANENT_INGEST_ERROR_CODES there) — but only because those calls
 *    already run with multi-minute-to-hour timeouts, so retrying
 *    immediately in-process would double an already-long single attempt.
 *    That's a cost decision, not a "this will never work" one; a fresh
 *    attempt later (this layer) is exactly the right place to retry them.
 *  - source_download_failed: render-clips.ts downloading our OWN R2 object,
 *    not a remote user URL — a failure here is an internal storage blip,
 *    not a bad input.
 *  - worker_stalled: assigned by the reapers below when a worker crashed
 *    mid-run. The job/run itself never got a chance to fail on its own
 *    merits, which makes this the single most retryable failure mode there
 *    is.
 */
export const TRANSIENT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "remote_fetch_timeout",
  "worker_command_timeout",
  "source_download_failed",
  "worker_stalled",
]);

function requireProtocolV1CompatibilityRun(run: {
  id: string;
  lifecycleVersion: number;
}) {
  if (run.lifecycleVersion !== 1) {
    throw new WorkflowAttemptContextRequired(run.id);
  }
}

export function isAutoRetryableFailureCode(errorCode: string): boolean {
  return !PERMANENT_FAILURE_CODES.has(errorCode);
}

export type AutoRetryDecision =
  | { outcome: "requeue" }
  | { outcome: "permanent"; terminalErrorCode: string };

/**
 * The single decision this whole policy boils down to, applied identically
 * to ingest jobs and workflow runs, and to both an explicit failure and a
 * reaped stall (reapStuckIngestJobs/reapStuckWorkflowRuns below call this
 * with errorCode "worker_stalled"): retry if the error looks transient AND
 * there's still budget, otherwise stop for good. `attemptCount` is the count
 * *as of this failure* (already incremented at claim time), so
 * `attemptCount < maxAttempts` reads as "this was attempt N of maxAttempts,
 * try again."
 */
export function decideAutoRetry(
  attemptCount: number,
  errorCode: string,
  maxAttempts: number,
  exhaustedErrorCode: string,
): AutoRetryDecision {
  if (isAutoRetryableFailureCode(errorCode) && attemptCount < maxAttempts) {
    return { outcome: "requeue" };
  }
  return {
    outcome: "permanent",
    terminalErrorCode: isAutoRetryableFailureCode(errorCode)
      ? exhaustedErrorCode
      : errorCode,
  };
}

/** Exponential backoff, doubling per attempt (attempt 1 -> base, attempt 2
 *  -> 2x base, ...). Only ever consulted for attemptCount >= 1 — see
 *  claimBackoffWhereClauses. */
export function autoRetryBackoffMs(
  attemptCount: number,
  baseDelayMs: number = AUTO_RETRY_BASE_DELAY_MS,
): number {
  return baseDelayMs * 2 ** Math.max(0, attemptCount - 1);
}

/**
 * Backoff without a schema migration. IngestJob/WorkflowRun have no
 * `nextAttemptAt` column, and this task is scoped to not add one, so
 * eligibility is expressed against the attemptCount + updatedAt columns that
 * already exist — Prisma bumps `updatedAt` on every write, including the
 * requeue writes in failIngestJob / fail*WorkflowRun / the reapers below. A
 * never-claimed row (attemptCount 0) is always eligible, exactly as today; a
 * requeued one becomes eligible again only once its own exponential-backoff
 * window has elapsed since the write that requeued it.
 *
 * Spread into the `OR` of claimNextIngestJob / claimNextWorkflowRun's
 * `where` alongside their other (AND-ed) conditions, e.g.
 * `{ status: "queued", OR: claimBackoffWhereClauses(CAP) }`.
 */
export function claimBackoffWhereClauses(
  maxAutoRetryAttempts: number,
  nowMs: number = Date.now(),
): Array<{ attemptCount: number; updatedAt?: { lt: Date } }> {
  const clauses: Array<{ attemptCount: number; updatedAt?: { lt: Date } }> = [
    { attemptCount: 0 },
  ];
  for (let attempt = 1; attempt < maxAutoRetryAttempts; attempt++) {
    clauses.push({
      attemptCount: attempt,
      updatedAt: { lt: new Date(nowMs - autoRetryBackoffMs(attempt)) },
    });
  }
  return clauses;
}

// ---------------------------------------------------------------------------
// Self-serve project deletion. Errors mirror the getProjectAccess three-way
// discriminator ("missing" -> 404, "forbidden" -> 403) plus two deletion-
// specific refusals. The orchestration itself (runProjectDeletion below) is a
// pure, dependency-injected function — same shape as resolveExistingUploadResume
// above — so its guarantees (ownership, the active-run guard, the "storage
// deletes before the DB row" ordering, and idempotent re-delete) have direct
// unit coverage without touching a real database or R2 bucket.
// ---------------------------------------------------------------------------

export class ProjectNotFoundError extends Error {
  readonly code = "project_not_found";

  constructor() {
    super("Project not found.");
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectAccessDeniedError extends Error {
  readonly code = "project_access_denied";

  constructor() {
    super("You don't have access to this project.");
    this.name = "ProjectAccessDeniedError";
  }
}

export class ProjectHasActiveWorkflowError extends Error {
  readonly code = "project_has_active_workflow";

  constructor() {
    super(
      "This project has a run in progress. Wait for it to finish, then try deleting again.",
    );
    this.name = "ProjectHasActiveWorkflowError";
  }
}

export class ProjectDeletionIncompleteError extends Error {
  readonly code = "project_deletion_incomplete";

  constructor(public readonly failedKeyCount: number) {
    super(
      "Some of this project's files couldn't be removed from storage. Please try deleting again.",
    );
    this.name = "ProjectDeletionIncompleteError";
  }
}

/**
 * Every storage-key-bearing row a project may own, already fetched — kept
 * separate from the Prisma query shape so the planning logic below has no
 * dependency on a live database.
 *
 * Deliberately excludes: `Clip.brollUrl` and `studioEdits.music.url` (these
 * are user-supplied public HTTP URLs validated by assertPublicHttpUrl
 * elsewhere, never R2 objects this project owns) and `BrandTemplate.
 * logoStorageKey` / anything inside `Project.brandSnapshot` (owned by the
 * user's brand template, which other projects may still reference — deleting
 * one project must never delete a shared template's logo).
 */
export interface ProjectStorageSnapshot {
  sourceStorageKey: string | null;
  transcriptRawStorageKey: string | null;
  uploadSessions: ReadonlyArray<{
    storageKey: string;
    providerUploadId: string;
    status: "initiated" | "completed" | "aborted" | "expired";
  }>;
  clipPreviewStorageKeys: ReadonlyArray<string | null>;
  clipRenderStorageKeys: ReadonlyArray<string | null>;
  clipDubStorageKeys: ReadonlyArray<string | null>;
}

export interface ProjectDeletionPlan {
  /** Deduped R2 object keys to DeleteObject. */
  objectKeysToDelete: string[];
  /** Multipart uploads still in-flight — AbortMultipartUpload, never
   *  DeleteObject, since no finished object exists yet for these. */
  multipartUploadsToAbort: Array<{ key: string; uploadId: string }>;
}

/**
 * Pure enumeration of everything a project deletion must touch in R2. Exported
 * and tested directly so "which tables get swept" has coverage independent of
 * the Prisma query that feeds it in ProjectService.deleteProject below.
 */
export function planProjectStorageDeletion(
  snapshot: ProjectStorageSnapshot,
): ProjectDeletionPlan {
  const keys = new Set<string>();
  const addKey = (key: string | null | undefined) => {
    if (key) keys.add(key);
  };

  addKey(snapshot.sourceStorageKey);
  addKey(snapshot.transcriptRawStorageKey);
  snapshot.clipPreviewStorageKeys.forEach(addKey);
  snapshot.clipRenderStorageKeys.forEach(addKey);
  snapshot.clipDubStorageKeys.forEach(addKey);

  const multipartUploadsToAbort: Array<{ key: string; uploadId: string }> = [];
  for (const session of snapshot.uploadSessions) {
    if (session.status === "initiated") {
      // An in-progress multipart upload has no finished object to
      // DeleteObject — AbortMultipartUpload is the correct cleanup call, and
      // this key must NOT also be queued as a DeleteObject target below.
      multipartUploadsToAbort.push({
        key: session.storageKey,
        uploadId: session.providerUploadId,
      });
      continue;
    }
    // A completed session's key is the same physical object already
    // captured via sourceStorageKey; add it defensively anyway (e.g. a
    // session whose project row was never reconciled) — the Set dedupes.
    addKey(session.storageKey);
  }

  return {
    objectKeysToDelete: Array.from(keys),
    multipartUploadsToAbort,
  };
}

export interface ProjectDeletionIo {
  deleteObject: (key: string) => Promise<unknown>;
  abortMultipartUpload: (input: {
    key: string;
    uploadId: string;
  }) => Promise<unknown>;
  isMissingObjectError: (error: unknown) => boolean;
}

export interface ProjectDeletionIoResult {
  /** Keys that failed for a reason OTHER than "already missing" — these
   *  block the DB row from being deleted so the objects stay reachable and
   *  retryable rather than orphaned forever. */
  failedKeys: string[];
}

/**
 * Executes a storage deletion plan resiliently: every key is attempted via
 * Promise.allSettled (one bad key can't stop the rest), and "already gone"
 * is treated as success exactly like purgeExpiredProjectSources does. Only
 * genuine failures are returned, since those are what must keep the DB row
 * alive for a retry.
 */
export async function deleteProjectStorageObjects(
  plan: ProjectDeletionPlan,
  io: ProjectDeletionIo,
): Promise<ProjectDeletionIoResult> {
  const results = await Promise.allSettled(
    plan.objectKeysToDelete.map((key) => io.deleteObject(key)),
  );

  const failedKeys: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "rejected" && !io.isMissingObjectError(result.reason)) {
      failedKeys.push(plan.objectKeysToDelete[index]!);
    }
  });

  // Best-effort only: aborting an in-progress multipart upload never blocks
  // deletion. A failure here just leaves a small amount of never-completed
  // part data in R2 until the bucket's lifecycle rules (or a future retry
  // once the session is stale) clear it.
  await Promise.allSettled(
    plan.multipartUploadsToAbort.map((upload) => io.abortMultipartUpload(upload)),
  );

  return { failedKeys };
}

export type ProjectDeletionOutcome =
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "active_workflow" }
  | { kind: "storage_incomplete"; failedKeys: string[] }
  | { kind: "deleted" }
  | { kind: "already_deleted" };

export interface ProjectDeletionRow {
  /** Whether any WorkflowRun for this project is still queued/running —
   *  same guard purgeExpiredProjectSources uses before touching a source. */
  hasActiveWorkflowRun: boolean;
  storage: ProjectStorageSnapshot;
}

export interface ProjectDeletionAccessResult {
  access: "missing" | "forbidden" | "owned";
  row: ProjectDeletionRow | null;
}

export interface ProjectDeletionDeps {
  getAccessAndRow: () => Promise<ProjectDeletionAccessResult>;
  deleteObject: (key: string) => Promise<unknown>;
  abortMultipartUpload: (input: {
    key: string;
    uploadId: string;
  }) => Promise<unknown>;
  isMissingObjectError: (error: unknown) => boolean;
  /** Conditioned delete (e.g. `deleteMany({ where: { id, userId } })`) so a
   *  row a concurrent call already removed resolves to count 0 instead of
   *  throwing — this is what makes repeated/racing calls safe. */
  deleteProjectRow: () => Promise<{ count: number }>;
}

/**
 * Pure orchestration for project deletion, fully dependency-injected (same
 * style as resolveExistingUploadResume) so every guarantee below has direct
 * test coverage without a live database or R2 bucket:
 *
 *  - ownership: "missing"/"forbidden" access short-circuits before any I/O.
 *  - the active-run guard: a queued/running WorkflowRun blocks deletion.
 *  - storage-first ordering: the DB row is only deleted once every storage
 *    key either deleted cleanly or was already gone; any other failure
 *    leaves the row intact so the objects stay reachable and retryable.
 *  - idempotent re-delete: deleteProjectRow resolving to count 0 (the row
 *    was already gone) is a success-shaped no-op, not a thrown error.
 */
export async function runProjectDeletion(
  deps: ProjectDeletionDeps,
): Promise<ProjectDeletionOutcome> {
  const { access, row } = await deps.getAccessAndRow();

  // Check the discriminator itself first: "forbidden" also carries a null
  // row (there's nothing to hand back for someone else's project), so a
  // combined "missing or no row" check here would misclassify it as
  // not_found instead of forbidden.
  if (access === "missing") {
    return { kind: "not_found" };
  }
  if (access === "forbidden") {
    return { kind: "forbidden" };
  }
  if (!row) {
    return { kind: "not_found" };
  }
  if (row.hasActiveWorkflowRun) {
    return { kind: "active_workflow" };
  }

  const plan = planProjectStorageDeletion(row.storage);
  const { failedKeys } = await deleteProjectStorageObjects(plan, {
    deleteObject: deps.deleteObject,
    abortMultipartUpload: deps.abortMultipartUpload,
    isMissingObjectError: deps.isMissingObjectError,
  });

  if (failedKeys.length > 0) {
    return { kind: "storage_incomplete", failedKeys };
  }

  const deleteResult = await deps.deleteProjectRow();
  return deleteResult.count > 0
    ? { kind: "deleted" }
    : { kind: "already_deleted" };
}

export class ProjectService {
  private requirePrisma() {
    const prisma = getPrismaClient();

    if (!prisma) {
      throw new Error("Database client unavailable");
    }

    return prisma;
  }

  private async resolveWriteOwnership(
    userId: string,
    workspaceId?: string,
    capability: WorkspaceCapability = "content.edit",
  ) {
    if (!hasDatabase()) {
      return {
        // In-memory development mode has no Workspace table. Reuse the actor
        // id as a deterministic synthetic scope so the return type remains
        // non-null and tests still exercise tenant separation.
        workspaceId: workspaceId ?? userId,
        actorUserId: userId,
        legacyOwnerUserId: userId,
      };
    }

    const ownership = await workspaceService.resolveLegacyOwnership(userId, workspaceId);
    await workspaceService.requireActor(userId, ownership.workspaceId, capability);
    return ownership;
  }

  private async resolveProjectScope(
    userId: string,
    workspaceId?: string,
    capability: "content.view" | "content.edit" = "content.view",
  ): Promise<Prisma.ProjectWhereInput> {
    if (!workspaceId) return { userId };

    const actor = await workspaceService.requireActor(userId, workspaceId, capability);
    return {
      OR: [
        { workspaceId: actor.workspaceId },
        // Compatibility for the short deployment window between adding the
        // nullable column and completing the production backfill.
        { workspaceId: null, userId: actor.workspaceOwnerUserId },
      ],
    };
  }

  async getProjectAccess(
    userId: string,
    projectId: string,
    workspaceId?: string,
  ): Promise<ProjectAccessResult> {
    const prisma = getPrismaClient();

    if (!prisma) {
      const project = projects.get(projectId);

      if (!project) {
        return "missing";
      }

      if (project.expiresAt && new Date(project.expiresAt).getTime() <= Date.now()) {
        return "missing";
      }
      return project.userId === userId ? "owned" : "forbidden";
    }

    const scope = await this.resolveProjectScope(userId, workspaceId);
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true, workspaceId: true, expiresAt: true, purgeStartedAt: true },
    });

    if (!project) {
      return "missing";
    }

    if (
      project.purgeStartedAt ||
      (project.expiresAt && project.expiresAt.getTime() <= Date.now())
    ) {
      return "missing";
    }
    const scopeMatch = await prisma.project.count({
      where: { id: projectId, AND: [scope] },
    });
    return scopeMatch > 0 ? "owned" : "forbidden";
  }

  /**
   * Self-serve, user-initiated project deletion — distinct from
   * purgeExpiredProjectSources's time-based retention sweep (that only ever
   * reclaims the source object once it has aged out; this deletes the whole
   * project and everything it owns, right now, on the user's request).
   *
   * Storage is deleted before the DB row, and the row is only removed once
   * every key deleted cleanly or was already gone — a partial storage
   * failure leaves the project row intact so a retry can find the same
   * (still-referenced) keys again rather than orphaning them. See
   * runProjectDeletion above for the guarantees this wires together.
   *
   * Storage-key-bearing tables covered: Project.sourceStorageKey,
   * Transcript.rawStorageKey, UploadSession.storageKey (completed sessions
   * dedupe against sourceStorageKey; still-"initiated" sessions get a
   * best-effort AbortMultipartUpload instead), Clip.previewStorageKey,
   * ClipRender.storageKey, ClipDub.audioStorageKey/renderStorageKey.
   * Deliberately NOT touched: BrandTemplate.logoStorageKey and any logo key
   * embedded in Project.brandSnapshot (owned by the user's brand template,
   * which other projects may still reference) and Clip.brollUrl /
   * studioEdits.music.url (external HTTP URLs, not objects this project
   * owns in R2).
   */
  async deleteProject(userId: string, projectId: string): Promise<void> {
    if (!hasDatabase()) {
      const existing = projects.get(projectId);
      if (!existing) {
        throw new ProjectNotFoundError();
      }
      if (existing.userId !== userId) {
        throw new ProjectAccessDeniedError();
      }
      projects.delete(projectId);
      return;
    }

    const prisma = this.requirePrisma();

    const outcome = await runProjectDeletion({
      getAccessAndRow: async () => {
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: {
            userId: true,
            sourceStorageKey: true,
            transcript: { select: { rawStorageKey: true } },
            uploadSessions: {
              select: {
                storageKey: true,
                providerUploadId: true,
                status: true,
              },
            },
            clips: {
              select: {
                previewStorageKey: true,
                renders: { select: { storageKey: true } },
                dubs: {
                  select: { audioStorageKey: true, renderStorageKey: true },
                },
              },
            },
            workflowRuns: {
              where: { status: { in: ["queued", "running", "waiting"] } },
              select: { id: true },
              take: 1,
            },
          },
        });

        if (!project) {
          return { access: "missing", row: null };
        }
        if (project.userId !== userId) {
          return { access: "forbidden", row: null };
        }

        return {
          access: "owned",
          row: {
            hasActiveWorkflowRun: project.workflowRuns.length > 0,
            storage: {
              sourceStorageKey: project.sourceStorageKey,
              transcriptRawStorageKey: project.transcript?.rawStorageKey ?? null,
              uploadSessions: project.uploadSessions,
              clipPreviewStorageKeys: project.clips.map(
                (clip) => clip.previewStorageKey,
              ),
              clipRenderStorageKeys: project.clips.flatMap((clip) =>
                clip.renders.map((render) => render.storageKey),
              ),
              clipDubStorageKeys: project.clips.flatMap((clip) =>
                clip.dubs.flatMap((dub) => [
                  dub.audioStorageKey,
                  dub.renderStorageKey,
                ]),
              ),
            },
          },
        };
      },
      deleteObject,
      abortMultipartUpload,
      isMissingObjectError,
      deleteProjectRow: async () => {
        const result = await prisma.project.deleteMany({
          where: { id: projectId, userId },
        });
        return { count: result.count };
      },
    });

    switch (outcome.kind) {
      case "not_found":
        throw new ProjectNotFoundError();
      case "forbidden":
        throw new ProjectAccessDeniedError();
      case "active_workflow":
        throw new ProjectHasActiveWorkflowError();
      case "storage_incomplete":
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "project_delete_storage_incomplete",
            projectId,
            failedKeyCount: outcome.failedKeys.length,
          }),
        );
        throw new ProjectDeletionIncompleteError(outcome.failedKeys.length);
      case "deleted":
      case "already_deleted":
        return;
    }
  }

  async listProjects(userId: string, workspaceId?: string) {
    const prisma = getPrismaClient();

    if (!prisma) {
      return Array.from(projects.values())
        .filter(
          (project) =>
            project.userId === userId &&
            (!project.expiresAt ||
              new Date(project.expiresAt).getTime() > Date.now()),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }

    const scope = await this.resolveProjectScope(userId, workspaceId);
    const rows = await prisma.project.findMany({
      where: { AND: [scope, accessibleProjectWhere()] },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return rows.map((row) => toProjectSnapshot(row));
  }

  async getDashboardStats(userId: string, workspaceId?: string): Promise<{
    total: number;
    processing: number;
    completed: number;
    tier: PricingTier;
    usedMinutes: number;
    limitMinutes: number;
  }> {
    const prisma = getPrismaClient();

    if (!prisma) {
      const owned = Array.from(projects.values()).filter(
        (project) =>
          project.userId === userId &&
          (!project.expiresAt ||
            new Date(project.expiresAt).getTime() > Date.now()),
      );
      return {
        total: owned.length,
        processing: 0,
        completed: 0,
        tier: "free",
        usedMinutes: 0,
        limitMinutes: MONTHLY_PROCESSING_MINUTE_LIMITS.free,
      };
    }

    const accessible = accessibleProjectWhere();
    const scope = await this.resolveProjectScope(userId, workspaceId);
    const workspace = workspaceId
      ? await this.requirePrisma().workspace.findUnique({
          where: { id: workspaceId },
          select: { pricingTier: true },
        })
      : null;
    const [total, processing, completed, tier, usedMinutes] = await Promise.all([
      prisma.project.count({ where: { AND: [scope, accessible] } }),
      // Active pipeline: ingest still moving, or a workflow run queued/running.
      prisma.project.count({
        where: {
          AND: [scope, accessible],
          OR: [
            {
              ingestStatus: {
                in: [
                  "pending",
                  "uploading",
                  "queued",
                  "downloading",
                  "normalizing",
                ],
              },
            },
            {
              workflowRuns: {
                some: { status: { in: ["queued", "running", "waiting"] } },
              },
            },
          ],
        },
      }),
      // Produced output: at least one detected clip.
      prisma.project.count({ where: { AND: [scope, accessible], clips: { some: {} } } }),
      workspace ? resolvePricingTier(workspace.pricingTier) : this.getUserPricingTier(userId),
      workspaceId
        ? this.getWorkspaceMonthlyUsageMinutes(workspaceId)
        : this.getMonthlyUsageMinutes(userId),
    ]);

    return {
      total,
      processing,
      completed,
      tier,
      usedMinutes,
      limitMinutes: MONTHLY_PROCESSING_MINUTE_LIMITS[tier],
    };
  }

  async listProjectsWithStatsPage(
    userId: string,
    options: {
      limit?: number;
      cursor?: string | null;
      workspaceId?: string;
      folderId?: string;
      query?: string;
      status?: ProjectListStatusFilter;
      source?: ProjectListSourceFilter;
      sort?: ProjectListSort;
    } = {},
  ): Promise<ProjectListPage> {
    const limit = clampProjectPageSize(options.limit);
    const offset = decodeProjectCursor(options.cursor);
    const query = options.query?.trim().slice(0, 200) ?? "";
    const status = options.status ?? "all";
    const source = options.source ?? "all";
    const sort = options.sort ?? "newest";
    const prisma = getPrismaClient();

    if (!prisma) {
      const baseFiltered = Array.from(projects.values())
        .filter(
          (project) =>
            project.userId === userId &&
            (!options.workspaceId || project.workspaceId === options.workspaceId) &&
            (!options.folderId || project.folderId === options.folderId) &&
            (source === "all" || project.sourceType === source) &&
            (!query ||
              [project.title, project.sourceMediaUrl, project.sourceInput ?? ""]
                .join(" ")
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase())) &&
            (!project.expiresAt ||
              new Date(project.expiresAt).getTime() > Date.now()),
        );
      const statusCounts = emptyProjectStatusCounts();
      for (const project of baseFiltered) {
        statusCounts.all += 1;
        if (project.ingestStatus === "ready") statusCounts.ready += 1;
        if (project.ingestStatus === "failed") statusCounts.failed += 1;
        if (project.ingestStatus === "queued") statusCounts.queued += 1;
        if (["pending", "uploading", "downloading", "normalizing"].includes(project.ingestStatus)) {
          statusCounts.processing += 1;
        }
      }
      const filtered = baseFiltered.filter((project) => {
        if (status === "all") return true;
        if (status === "processing") {
          return ["pending", "uploading", "downloading", "normalizing"].includes(
            project.ingestStatus,
          );
        }
        return project.ingestStatus === status;
      });
      filtered.sort((left, right) => {
        if (sort === "oldest") {
          return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
        }
        if (sort === "title") {
          return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
        }
        return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
      });
      const page = filtered.slice(offset, offset + limit);

      return {
        items: page.map((project) => ({
          ...project,
          clipCount: 0,
          avgViralityScore: null,
          transcript: null,
        })),
        nextCursor:
          offset + page.length < filtered.length && page.length > 0
            ? encodeProjectCursor(offset + page.length)
            : null,
        totalCount: filtered.length,
        statusCounts,
      };
    }

    const scope = await this.resolveProjectScope(userId, options.workspaceId);
    const folderWhere: Prisma.ProjectWhereInput = options.folderId
      ? { folderId: options.folderId }
      : {};
    const sourceWhere: Prisma.ProjectWhereInput = source === "all"
      ? {}
      : { sourceType: source };
    const queryWhere: Prisma.ProjectWhereInput = query
      ? {
          OR: [
            { title: { contains: query, mode: "insensitive" } },
            { sourceMediaUrl: { contains: query, mode: "insensitive" } },
            { sourceInput: { contains: query, mode: "insensitive" } },
          ],
        }
      : {};
    const baseWhere: Prisma.ProjectWhereInput = {
      AND: [scope, accessibleProjectWhere(), folderWhere, sourceWhere, queryWhere],
    };
    const filteredWhere: Prisma.ProjectWhereInput = {
      AND: [baseWhere, projectStatusWhere(status)],
    };

    const [rowsWithLookahead, totalCount, statusGroups] = await Promise.all([
      prisma.project.findMany({
        where: filteredWhere,
        orderBy: projectListOrderBy(sort),
        skip: offset,
        take: limit + 1,
      }),
      prisma.project.count({ where: filteredWhere }),
      prisma.project.groupBy({
        by: ["ingestStatus"],
        where: baseWhere,
        _count: { _all: true },
      }),
    ]);
    const statusCounts = emptyProjectStatusCounts();
    for (const group of statusGroups) {
      const count = group._count._all;
      statusCounts.all += count;
      if (group.ingestStatus === "ready") statusCounts.ready += count;
      if (group.ingestStatus === "failed") statusCounts.failed += count;
      if (group.ingestStatus === "queued") statusCounts.queued += count;
      if (["pending", "uploading", "downloading", "normalizing"].includes(group.ingestStatus)) {
        statusCounts.processing += count;
      }
    }

    const rows = rowsWithLookahead.slice(0, limit);

    if (rows.length === 0) {
      return { items: [], nextCursor: null, totalCount, statusCounts };
    }

    const projectIds = rows.map((row) => row.id);

    const [clipAggregates, transcripts] = await Promise.all([
      prisma.clip.groupBy({
        by: ["projectId"],
        where: { projectId: { in: projectIds } },
        _count: { _all: true },
        _avg: { viralityScore: true },
      }),
      prisma.transcript.findMany({
        where: { projectId: { in: projectIds } },
        select: {
          projectId: true,
          languageCode: true,
          speakerCount: true,
          durationSeconds: true,
          status: true,
        },
      }),
    ]);

    const clipMap = new Map(
      clipAggregates.map((entry) => [entry.projectId, entry] as const),
    );
    const transcriptMap = new Map(
      transcripts.map((entry) => [entry.projectId, entry] as const),
    );

    const items = rows.map((row) => {
      const clip = clipMap.get(row.id);
      const transcript = transcriptMap.get(row.id) ?? null;

      return {
        ...toProjectSnapshot(row),
        clipCount: clip?._count._all ?? 0,
        avgViralityScore: clip?._avg.viralityScore ?? null,
        transcript: transcript
          ? {
              languageCode: transcript.languageCode,
              speakerCount: transcript.speakerCount,
              durationSeconds: transcript.durationSeconds,
              status: transcript.status,
            }
          : null,
      };
    });

    return {
      items,
      nextCursor:
        rowsWithLookahead.length > limit && items.length > 0
          ? encodeProjectCursor(offset + items.length)
          : null,
      totalCount,
      statusCounts,
    };
  }

  async listProjectsWithStats(userId: string): Promise<ProjectListItem[]> {
    const page = await this.listProjectsWithStatsPage(userId);
    return page.items;
  }

  async createProject(userId: string, input: CreateProjectInput, workspaceId?: string) {
    const parsed = createProjectSchema.parse(input);
    const createdAt = new Date();
    const ownership = await this.resolveWriteOwnership(userId, workspaceId);
    const retention = ownership.workspaceId
      ? await projectRetentionService.assignmentForWorkspace(ownership.workspaceId, createdAt)
      : await projectRetentionService.assignmentForNewProject(ownership.legacyOwnerUserId, createdAt);

    if (!hasDatabase()) {
      const project: ProjectSnapshot = {
        id: randomUUID(),
        userId: ownership.legacyOwnerUserId,
        workspaceId: ownership.workspaceId,
        title: parsed.title,
        sourceMediaUrl: parsed.sourceMediaUrl,
        sourceType: "upload",
        sourceProvider: null,
        sourceInput: parsed.sourceMediaUrl,
        sourceStorageKey: null,
        sourceMimeType: null,
        sourceSizeBytes: null,
        sourceDurationSeconds: null,
        languageCode: parsed.languageCode ?? null,
        ingestStatus: "ready",
        ingestErrorCode: null,
        ingestCompletedAt: new Date().toISOString(),
        notifyOnComplete: true,
        retentionPolicyKey: retention?.retentionPolicyKey ?? null,
        expiresAt: retention?.expiresAt.toISOString() ?? null,
        persisted: false,
        createdAt: createdAt.toISOString(),
      };

      projects.set(project.id, project);
      return project;
    }

    const prisma = this.requirePrisma();
    const project = await prisma.project.create({
      data: {
        userId: ownership.legacyOwnerUserId,
        workspaceId: ownership.workspaceId,
        createdByUserId: ownership.actorUserId,
        updatedByUserId: ownership.actorUserId,
        title: parsed.title,
        sourceMediaUrl: parsed.sourceMediaUrl,
        sourceType: "upload",
        sourceInput: parsed.sourceMediaUrl,
        ingestStatus: "ready",
        ingestCompletedAt: new Date(),
        languageCode: parsed.languageCode ?? null,
        createdAt,
        retentionPolicyKey: retention?.retentionPolicyKey ?? null,
        expiresAt: retention?.expiresAt ?? null,
      },
    });

    return toProjectSnapshot(project);
  }

  async updateProjectLanguage(
    userId: string,
    projectId: string,
    languageCode: string | null,
  ) {
    if (!hasDatabase()) {
      const existing = projects.get(projectId);
      if (!existing || existing.userId !== userId) return;
      return;
    }
    const prisma = this.requirePrisma();
    await prisma.project.updateMany({
      where: { id: projectId, userId },
      data: { languageCode },
    });
  }

  async getProjectSnapshot(userId: string, projectId: string, workspaceId?: string) {
    const prisma = getPrismaClient();

    if (!prisma) {
      const inMemory = projects.get(projectId) ?? null;
      const project = inMemory?.userId === userId ? inMemory : null;
      return {
        project,
        activeRun: null,
        lastSeq: 0,
        ingestAttemptCount: 0,
      };
    }

    const scope = await this.resolveProjectScope(userId, workspaceId);
    const [row, latestRun, lastSeq, ingestAttemptCount] = await Promise.all([
      prisma.project.findFirst({
        where: { id: projectId, AND: [scope, accessibleProjectWhere()] },
      }),
      prisma.workflowRun.findFirst({
        where: { projectId },
        orderBy: { updatedAt: "desc" },
      }),
      getLastWorkflowSeq(projectId),
      // Total ingest attempts so far (original + retries) — lets the project
      // page decide whether "Retry ingest" is still allowed.
      prisma.ingestJob.count({ where: { projectId } }),
    ]);
    const project = row ? toProjectSnapshot(row) : null;

    return {
      project,
      activeRun: latestRun ? toWorkflowRunSnapshot(latestRun) : null,
      lastSeq,
      ingestAttemptCount,
    };
  }

  /**
   * Persisted WorkflowEvent history for the Activity tab's initial paint —
   * reuses getWorkflowEventsSince (the same durable-catch-up source the SSE
   * route already replays from) instead of a second query path, and bounds
   * the payload defensively; the client applies its own tighter display cap.
   */
  async getWorkflowHistory(
    userId: string,
    projectId: string,
  ): Promise<WorkflowStageUpdatedEvent[]> {
    const access = await this.getProjectAccess(userId, projectId);
    if (access !== "owned") {
      return [];
    }

    const events = await getWorkflowEventsSince(projectId, 0);
    const recent = events.slice(-WORKFLOW_HISTORY_FETCH_LIMIT);

    const validated: WorkflowStageUpdatedEvent[] = [];
    for (const event of recent) {
      const parsed = workflowStageUpdatedEventSchema.safeParse(event);
      if (parsed.success) {
        validated.push(parsed.data);
      }
    }
    return validated;
  }

  async getIngestSnapshot(userId: string, projectId: string) {
    const prisma = this.requirePrisma();
    const [row, latestRun, lastSeq] = await Promise.all([
      prisma.project.findFirst({
        where: { id: projectId, userId, ...accessibleProjectWhere() },
      }),
      prisma.workflowRun.findFirst({
        where: { projectId },
        orderBy: { updatedAt: "desc" },
      }),
      getLastWorkflowSeq(projectId),
    ]);

    if (!row) {
      return null;
    }

    return {
      project: toProjectSnapshot(row),
      activeRun: latestRun ? toWorkflowRunSnapshot(latestRun) : null,
      lastSeq,
    };
  }

  async getWorkflowRun(projectId: string, workflowRunId: string) {
    const prisma = this.requirePrisma();
    const [dbRun, lastSeq] = await Promise.all([
      // Scope by projectId so a run from another tenant's project can't be read
      // by passing a foreign workflowRunId to an owned project's route.
      prisma.workflowRun.findFirst({
        where: { id: workflowRunId, projectId },
      }),
      getLastWorkflowSeq(projectId),
    ]);

    return {
      run: dbRun ? toWorkflowRunSnapshot(dbRun) : null,
      lastSeq,
    };
  }

  async getTranscriptSnapshot(userId: string, projectId: string) {
    const prisma = this.requirePrisma();
    const row = await prisma.transcript.findFirst({
      where: {
        projectId,
        project: { userId, ...accessibleProjectWhere() },
      },
    });

    return row ? toTranscriptSnapshot(row) : null;
  }

  /**
   * Raw utterances for timeline/trim UIs. Deliberately skips the snapshot
   * zod-parse: utterances were schema-validated when persisted, and
   * re-validating ~8k word objects on every request added seconds of
   * latency to an endpoint whose consumer re-normalizes anyway.
   */
  async getTranscriptUtterancesRaw(userId: string, projectId: string) {
    const prisma = this.requirePrisma();
    const row = await prisma.transcript.findFirst({
      where: {
        projectId,
        project: { userId, ...accessibleProjectWhere() },
        status: "completed",
      },
      select: { utterancesJson: true },
    });

    return row ? (row.utterancesJson ?? []) : null;
  }

  async getTranscriptExport(
    userId: string,
    projectId: string,
    format: TranscriptExportFormat,
  ) {
    const transcript = await this.getTranscriptSnapshot(userId, projectId);

    if (!transcript) {
      throw new Error("transcript not found");
    }

    if (transcript.status !== "completed") {
      throw new Error("transcript is not ready");
    }

    const slug = (transcript.languageCode ?? "transcript").replace(
      /[^a-zA-Z0-9_-]/g,
      "-",
    );

    return {
      fileName: `${projectId}-${slug}.${format}`,
      body: exportTranscript(transcript, format),
      contentType:
        format === "txt"
          ? "text/plain; charset=utf-8"
          : format === "srt"
            ? "application/x-subrip; charset=utf-8"
            : "text/vtt; charset=utf-8",
    };
  }

  async getUserPricingTier(userId: string): Promise<PricingTier> {
    if (!hasDatabase()) return "free";
    const prisma = this.requirePrisma();
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { pricingTier: true },
    });
    return resolvePricingTier(user?.pricingTier ?? null);
  }

  /** Source minutes consumed this calendar month (the quota metric). */
  async getMonthlyUsageMinutes(userId: string): Promise<number> {
    if (!hasDatabase()) return 0;
    const prisma = this.requirePrisma();
    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);
    const agg = await prisma.project.aggregate({
      where: { userId, createdAt: { gte: startOfMonth } },
      _sum: { sourceDurationSeconds: true },
    });
    return processingMinutesFromSeconds(agg._sum.sourceDurationSeconds ?? 0);
  }

  async getWorkspaceMonthlyUsageMinutes(workspaceId: string): Promise<number> {
    if (!hasDatabase()) return 0;
    const prisma = this.requirePrisma();
    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);
    const agg = await prisma.project.aggregate({
      where: { workspaceId, createdAt: { gte: startOfMonth } },
      _sum: { sourceDurationSeconds: true },
    });
    return processingMinutesFromSeconds(agg._sum.sourceDurationSeconds ?? 0);
  }

  async getWorkspacePricingTier(workspaceId: string): Promise<PricingTier> {
    if (!hasDatabase()) return "free";
    const workspace = await this.requirePrisma().workspace.findUnique({
      where: { id: workspaceId },
      select: { pricingTier: true },
    });
    return resolvePricingTier(workspace?.pricingTier ?? null);
  }

  async assertWorkspaceWithinQuota(
    workspaceId: string,
    requestedSeconds = 0,
  ): Promise<void> {
    if (!hasDatabase()) return;
    const [tier, used] = await Promise.all([
      this.getWorkspacePricingTier(workspaceId),
      this.getWorkspaceMonthlyUsageMinutes(workspaceId),
    ]);
    const limit = MONTHLY_PROCESSING_MINUTE_LIMITS[tier];
    const requestedMinutes = processingMinutesFromSeconds(requestedSeconds);
    if (isProcessingQuotaExceeded({
      usedMinutes: used,
      requestedSeconds,
      limitMinutes: limit,
      blockAtLimitWithoutRequest: true,
    })) {
      throw new QuotaExceededError(
        `Monthly processing limit reached on the ${tier} plan (${limit} min/mo; ${used} min used). Upgrade the workspace to keep generating.`,
        { tier, limitMinutes: limit, usedMinutes: used, requestedMinutes },
      );
    }
  }

  /** Throws QuotaExceededError if the user is over their monthly plan allotment. */
  async assertWithinQuota(
    userId: string,
    requestedSeconds = 0,
  ): Promise<void> {
    if (!hasDatabase()) return;
    const tier = await this.getUserPricingTier(userId);
    const limit = MONTHLY_PROCESSING_MINUTE_LIMITS[tier];
    const used = await this.getMonthlyUsageMinutes(userId);
    const requestedMinutes = processingMinutesFromSeconds(requestedSeconds);
    if (
      isProcessingQuotaExceeded({
        usedMinutes: used,
        requestedSeconds,
        limitMinutes: limit,
        blockAtLimitWithoutRequest: true,
      })
    ) {
      throw new QuotaExceededError(
        `Monthly processing limit reached on the ${tier} plan (${limit} min/mo; ${used} min used). Upgrade your plan to keep generating.`,
        { tier, limitMinutes: limit, usedMinutes: used, requestedMinutes },
      );
    }
  }

  /**
   * Gate a project's generation on BOTH the monthly minute quota and the
   * per-upload length cap for the user's plan tier.
   */
  async assertProjectGenerationAllowed(
    userId: string,
    projectId: string,
    workspaceId?: string,
  ): Promise<void> {
    if (!hasDatabase()) return;
    const prisma = this.requirePrisma();
    const [tier, used, project] = await Promise.all([
      workspaceId
        ? this.getWorkspacePricingTier(workspaceId)
        : this.getUserPricingTier(userId),
      workspaceId
        ? this.getWorkspaceMonthlyUsageMinutes(workspaceId)
        : this.getMonthlyUsageMinutes(userId),
      prisma.project.findFirst({
        where: {
          id: projectId,
          ...(workspaceId ? { workspaceId } : { userId }),
        },
        select: { sourceDurationSeconds: true },
      }),
    ]);

    const minuteLimit = MONTHLY_PROCESSING_MINUTE_LIMITS[tier];
    if (used > minuteLimit) {
      throw new QuotaExceededError(
        `Monthly processing limit reached on the ${tier} plan (${minuteLimit} min/mo; ${used} min used). Upgrade your plan to keep generating.`,
        {
          tier,
          limitMinutes: minuteLimit,
          usedMinutes: used,
          requestedMinutes: processingMinutesFromSeconds(
            project?.sourceDurationSeconds ?? 0,
          ),
        },
      );
    }

    const seconds = project?.sourceDurationSeconds ?? 0;
    const maxSeconds = MAX_UPLOAD_LENGTH_SECONDS[tier];
    if (seconds > maxSeconds) {
      throw new UploadTooLongError(
        `This source is ${Math.round(seconds / 60)} min, over the ${Math.round(
          maxSeconds / 60,
        )}-min per-upload limit for the ${tier} plan. Upgrade for longer uploads.`,
        { tier, maxSeconds, seconds },
      );
    }
  }

  async triggerGeneration(
    userId: string,
    projectId: string,
    input: GenerateProjectInput,
    idempotencyKey: string,
    options?: {
      /**
       * Reuse this committed ContentPack instead of creating a new row, and
       * bind the run to it. Set by the link-first setup paths; the legacy
       * form/API paths still create their own pack.
       */
      existingContentPackId?: string;
      workspaceContext?: { workspaceId: string; actorUserId: string };
    },
  ) {
    const parsed = generateProjectRequestSchema.parse(input);

    if (options?.workspaceContext) {
      await workspaceService.requireActor(
        options.workspaceContext.actorUserId,
        options.workspaceContext.workspaceId,
        "processing.consume",
      );
    }

    // Enforce plan-tier processing-minute quota + per-upload length cap.
    await this.assertProjectGenerationAllowed(
      userId,
      projectId,
      options?.workspaceContext?.workspaceId,
    );

    if (!idempotencyKey) {
      throw new Error("idempotency key is required");
    }

    if (!hasDatabase()) {
      const project = projects.get(projectId);
      if (!project || project.userId !== userId) {
        throw new Error("project not found");
      }

      if (project.ingestStatus !== "ready") {
        throw new Error("project ingest is not ready");
      }
    } else {
      const prisma = this.requirePrisma();

      const project = await prisma.project.findFirst({
        where: {
          id: projectId,
          ...(options?.workspaceContext
            ? { workspaceId: options.workspaceContext.workspaceId }
            : { userId }),
        },
        select: {
          id: true,
          ingestStatus: true,
          transcript: {
            select: {
              status: true,
            },
          },
        },
      });

      if (!project) {
        throw new Error("project not found");
      }

      if (project.ingestStatus !== "ready") {
        throw new Error("project ingest is not ready");
      }

      if (!parsed.forceRegenerate) {
        const reusable = await getWorkflowRunLifecycle().findReusableGenerationRun(
          projectId,
          project.transcript?.status === "completed",
        );
        if (reusable) {
          return {
            workflowRunId: reusable.id,
            acceptedAt: reusable.updatedAt.toISOString(),
            initialSeq: await getLastWorkflowSeq(projectId),
          };
        }
      }
    }

    // Idempotency: prefer the durable DB unique constraint (survives restarts and
    // works across multiple instances); the in-memory map is only the no-DB path.
    if (!hasDatabase()) {
      const existingRunId = idempotencyRuns.get(
        getIdempotencyKey(projectId, idempotencyKey),
      );
      if (existingRunId) {
        return {
          workflowRunId: existingRunId,
          acceptedAt: new Date().toISOString(),
          initialSeq: await getLastWorkflowSeq(projectId),
        };
      }
    }

    let workflowRunId: string = randomUUID();
    idempotencyRuns.set(
      getIdempotencyKey(projectId, idempotencyKey),
      workflowRunId,
    );

    if (hasDatabase()) {
      const contentPackId = options?.existingContentPackId ?? null;
      const admitted = await getWorkflowRunLifecycle().admitTranscript({
        projectId,
        idempotencyKey,
        contentPackId,
        contentPack: contentPackId
          ? undefined
          : {
            outputTypes: parsed.contentPack.outputTypes,
            clipGenerationMode: parsed.contentPack.clipGenerationMode,
            clipCountTarget: parsed.contentPack.clipCountTarget,
            clipDurationSecTarget: parsed.contentPack.clipDurationSecTarget,
            minDurationSec: parsed.contentPack.minDurationSec,
            preferredMinDurationSec: parsed.contentPack.preferredMinDurationSec,
            preferredMaxDurationSec: parsed.contentPack.preferredMaxDurationSec,
            maxDurationSec: parsed.contentPack.maxDurationSec,
            platformTargets: parsed.contentPack.platformTargets,
            autoRenderClips: parsed.contentPack.autoRenderClips,
            toneConstraints: parsed.contentPack.toneConstraints,
            captionPreset: parsed.contentPack.captionPreset,
            platformPlaybookVersion: parsed.contentPack.platformPlaybookVersion,
            mode: parsed.contentPack.mode,
            autoHook: parsed.contentPack.autoHook,
            specificMoments: parsed.contentPack.specificMoments,
            processingStartSec: parsed.contentPack.processingStartSec,
            processingEndSec: parsed.contentPack.processingEndSec,
            clipLengthPreset: parsed.contentPack.clipLengthPreset,
            defaultAspectRatio: parsed.contentPack.defaultAspectRatio,
          },
        languageCode: parsed.languageCode,
        transcriptProvider: STT_PROVIDER,
        transcriptProviderModel: STT_PROVIDER_MODEL,
      });
      workflowRunId = admitted.id;
      idempotencyRuns.set(
        getIdempotencyKey(projectId, idempotencyKey),
        workflowRunId,
      );

      return {
        workflowRunId,
        acceptedAt: new Date().toISOString(),
        initialSeq: await getLastWorkflowSeq(projectId),
      };
    }

    const event = await this.publishWorkflowRunEvent({
      projectId,
      workflowRunId,
      stage: "stt",
      status: "queued",
      progress: 0,
      errorCode: null,
    });

    return {
      workflowRunId,
      acceptedAt: event?.emittedAt ?? new Date().toISOString(),
      initialSeq: event?.seq ?? 0,
    };
  }

  async presignMultipartUpload(userId: string, input: PresignUploadInput, workspaceId?: string) {
    const parsed = presignUploadSchema.parse(input);
    const prisma = this.requirePrisma();
    const ownership = await this.resolveWriteOwnership(
      userId,
      workspaceId,
      "processing.consume",
    );

    if (Boolean(parsed.projectId) !== Boolean(parsed.uploadId)) {
      throw new UploadSessionUnavailableError();
    }

    if (parsed.projectId && parsed.uploadId) {
      const session = await prisma.uploadSession.findFirst({
        where: {
          projectId: parsed.projectId,
          providerUploadId: parsed.uploadId,
          project: {
            workspaceId: ownership.workspaceId,
            ...accessibleProjectWhere(),
          },
        },
        include: { project: true },
      });
      const resolution = await resolveExistingUploadResume(
        {
          session: session
            ? {
                projectId: session.projectId,
                fileName: session.project.sourceInput,
                partCount: session.partCount,
                status: session.status,
                expiresAtMs: session.expiresAt.getTime(),
              }
            : null,
          requestedFileName: parsed.fileName,
          requestedPartCount: parsed.partCount,
          nowMs: Date.now(),
        },
        {
          listParts: async () => {
            if (!session || !isR2Configured()) {
              throw new Error("R2 configuration is missing");
            }
            return probeMultipartPartsForResume(() =>
              listUploadedParts({
                  key: session.storageKey,
                  uploadId: session.providerUploadId,
              }),
            );
          },
          headObject: async () => {
            if (!session || !isR2Configured()) {
              throw new Error("R2 configuration is missing");
            }
            return probeExactUploadObject(() =>
              headObject(session.storageKey),
            );
          },
        },
      );

      if (resolution.kind === "completed") {
        return {
          outcome: "completed" as const,
          projectId: resolution.projectId,
        };
      }
      if (resolution.kind === "unavailable") {
        if (resolution.shouldMarkExpired && session) {
          await prisma.uploadSession.update({
            where: { id: session.id },
            data: { status: "expired" },
          });
        }
        throw new UploadSessionUnavailableError();
      }
      if (resolution.kind === "reconciliation_required") {
        throw new UploadCompletionReconciliationRequiredError();
      }
      if (!session) {
        throw new UploadSessionUnavailableError();
      }

      const uploadedParts = resolution.parts;
      const uploadedNumbers = new Set(
        uploadedParts.map((part) => part.partNumber),
      );

      const partNumbers = Array.from(
        { length: session.partCount },
        (_, index) => index + 1,
      );
      const remaining = partNumbers.filter(
        (partNumber) => !uploadedNumbers.has(partNumber),
      );
      const uploadUrls =
        remaining.length > 0
          ? await presignMultipartPartUrls({
              key: session.storageKey,
              uploadId: session.providerUploadId,
              partNumbers: remaining,
            })
          : [];

      return {
        outcome: "active" as const,
        projectId: session.projectId,
        uploadId: session.providerUploadId,
        key: session.storageKey,
        partCount: session.partCount,
        uploadUrls,
        alreadyUploadedPartNumbers: Array.from(uploadedNumbers.values()).sort(
          (a, b) => a - b,
        ),
        alreadyUploadedParts: uploadedParts,
        expiresAt: session.expiresAt.toISOString(),
      };
    }

    if (!isR2Configured()) {
      throw new Error("R2 configuration is missing");
    }

    await this.assertWorkspaceWithinQuota(ownership.workspaceId);

    const brandResolved = await brandTemplateService.resolveSnapshotForUser(
      ownership.legacyOwnerUserId,
      parsed.brandTemplateId ?? null,
      { workspaceId: ownership.workspaceId, actorUserId: ownership.actorUserId },
    );

    const createdAt = new Date();
    const retention = await projectRetentionService.assignmentForWorkspace(
      ownership.workspaceId,
      createdAt,
    );

    const project = await prisma.project.create({
      data: {
        userId: ownership.legacyOwnerUserId,
        workspaceId: ownership.workspaceId,
        createdByUserId: ownership.actorUserId,
        updatedByUserId: ownership.actorUserId,
        title: parsed.title,
        sourceMediaUrl: "upload://pending",
        sourceType: "upload",
        sourceInput: parsed.fileName,
        ingestStatus: "uploading",
        brandTemplateId: brandResolved?.templateId ?? null,
        brandSnapshot: brandResolved
          ? (brandResolved.snapshot as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        createdAt,
        retentionPolicyKey: retention?.retentionPolicyKey ?? null,
        expiresAt: retention?.expiresAt ?? null,
      },
    });

    const safeName = sanitizeStorageFileName(parsed.fileName);
    const key = `workspaces/${ownership.workspaceId}/projects/${project.id}/${Date.now()}-${safeName || "source.bin"}`;
    const multipart = await createMultipartUpload({
      key,
      contentType: parsed.mimeType,
      metadata: {
        project_id: project.id,
        file_name: parsed.fileName,
      },
    });

    const expiresAt = new Date(Date.now() + UPLOAD_SESSION_EXPIRY_MS);
    await prisma.uploadSession.create({
      data: {
        projectId: project.id,
        providerUploadId: multipart.uploadId,
        storageKey: key,
        partCount: parsed.partCount,
        expiresAt,
        status: "initiated",
      },
    });

    const partNumbers = Array.from(
      { length: parsed.partCount },
      (_, index) => index + 1,
    );
    const uploadUrls = await presignMultipartPartUrls({
      key,
      uploadId: multipart.uploadId,
      partNumbers,
    });

    return {
      outcome: "active" as const,
      projectId: project.id,
      uploadId: multipart.uploadId,
      key,
      partCount: parsed.partCount,
      uploadUrls,
      alreadyUploadedPartNumbers: [] as number[],
      alreadyUploadedParts: [] as Array<{ partNumber: number; etag: string }>,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async completeMultipartUpload(
    userId: string,
    input: CompleteMultipartUploadInput,
    workspaceId?: string,
  ) {
    const parsed = completeMultipartUploadSchema.parse(input);
    const prisma = this.requirePrisma();
    const ownership = await this.resolveWriteOwnership(
      userId,
      workspaceId,
      "processing.consume",
    );

    const session = await prisma.uploadSession.findFirst({
      where: {
        projectId: parsed.projectId,
        providerUploadId: parsed.uploadId,
        storageKey: parsed.key,
        project: { workspaceId: ownership.workspaceId, ...accessibleProjectWhere() },
      },
      include: {
        project: true,
      },
    });

    if (!session) {
      throw new Error("upload session not found");
    }

    if (session.status !== "initiated") {
      throw new Error("upload session cannot be completed");
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      await prisma.uploadSession.update({
        where: { id: session.id },
        data: { status: "expired" },
      });
      throw new Error("upload session expired");
    }

    const completionParts = normalizeMultipartParts(
      parsed.etags,
      session.partCount,
      "complete",
    );
    if (!completionParts) {
      throw new Error("uploaded part set does not match the upload session");
    }

    await completeR2MultipartUpload({
      key: parsed.key,
      uploadId: parsed.uploadId,
      etags: completionParts,
    });

    const objectMeta = await headObject(parsed.key);

    const job = await prisma.$transaction(async (tx) => {
      await tx.uploadSession.update({
        where: { id: session.id },
        data: { status: "completed" },
      });

      await tx.project.update({
        where: { id: session.projectId },
        data: {
          sourceMediaUrl: buildR2Uri(parsed.key),
          sourceStorageKey: parsed.key,
          sourceInput: session.project.sourceInput ?? parsed.key,
          sourceMimeType: objectMeta.contentType,
          sourceSizeBytes: objectMeta.sizeBytes
            ? BigInt(objectMeta.sizeBytes)
            : undefined,
          ingestStatus: "queued",
          ingestErrorCode: null,
          ingestCompletedAt: null,
          ...(parsed.generationContext && {
            languageCode: parsed.generationContext.languageCode,
          }),
        },
      });

      if (parsed.generationContext) {
        const contentPack = parsed.generationContext.contentPack;
        await tx.contentPack.create({
          data: {
            projectId: session.projectId,
            outputTypes: contentPack.outputTypes,
            clipGenerationMode: contentPack.clipGenerationMode,
            clipCountTarget: contentPack.clipCountTarget,
            clipDurationSecTarget: contentPack.clipDurationSecTarget,
            minDurationSec: contentPack.minDurationSec,
            preferredMinDurationSec: contentPack.preferredMinDurationSec,
            preferredMaxDurationSec: contentPack.preferredMaxDurationSec,
            maxDurationSec: contentPack.maxDurationSec,
            platformTargets: contentPack.platformTargets,
            autoRenderClips: contentPack.autoRenderClips,
            toneConstraints: contentPack.toneConstraints,
            captionPreset: contentPack.captionPreset,
            platformPlaybookVersion: contentPack.platformPlaybookVersion,
            mode: contentPack.mode,
            autoHook: contentPack.autoHook,
            specificMoments: contentPack.specificMoments,
            processingStartSec: contentPack.processingStartSec,
            processingEndSec: contentPack.processingEndSec,
          },
        });
      }

      return tx.ingestJob.create({
        data: {
          projectId: session.projectId,
          jobType: "upload_finalize",
          payload: {
            storageKey: parsed.key,
            uploadId: parsed.uploadId,
          },
        },
      });
    });

    await this.publishIngestLifecycleEvent({
      projectId: session.projectId,
      workflowRunId: job.id,
      ingestStatus: "queued",
      eventStatus: "queued",
      errorCode: null,
    });

    return {
      projectId: session.projectId,
      uploadId: parsed.uploadId,
      key: parsed.key,
      partsCompleted: parsed.etags.length,
      queuedJobId: job.id,
      completedAt: new Date().toISOString(),
    };
  }

  async queueLinkIngest(userId: string, input: LinkIngestInput, workspaceId?: string) {
    const parsed = linkIngestSchema.parse(input);
    const prisma = this.requirePrisma();
    const ownership = await this.resolveWriteOwnership(
      userId,
      workspaceId,
      "processing.consume",
    );

    // Idempotent replay: the same commit token returns the already-created
    // project instead of importing twice (double-click, retried request).
    if (parsed.commitToken) {
      const existing = await prisma.project.findUnique({
        where: { commitToken: parsed.commitToken },
        include: { ingestJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
      });
      if (existing) {
        if (existing.workspaceId !== ownership.workspaceId) {
          throw new Error("project not found");
        }
        return {
          project: toProjectSnapshot(existing),
          queuedJobId: existing.ingestJobs[0]?.id ?? null,
        };
      }
    }

    await this.assertWorkspaceWithinQuota(ownership.workspaceId);

    const provider = detectLinkProvider(parsed.url);
    if (!provider) {
      throw new Error("link_unsupported_source");
    }
    const sourceType = provider === "youtube" ? "youtube" : "link";

    const brandResolved = await brandTemplateService.resolveSnapshotForUser(
      ownership.legacyOwnerUserId,
      parsed.brandTemplateId ?? null,
      { workspaceId: ownership.workspaceId, actorUserId: ownership.actorUserId },
    );
    const createdAt = new Date();
    const retention = await projectRetentionService.assignmentForWorkspace(
      ownership.workspaceId,
      createdAt,
    );

    // Step-1 draft pack: seeds language/mode/trim so a Step-2 refresh can
    // rehydrate. Never runnable — every claim path stops on draft rows.
    const draftPack = contentPackSchema.parse({
      outputTypes: ["short_clip"],
      clipCountTarget: 10,
      clipDurationSecTarget: 45,
      toneConstraints: [],
      platformPlaybookVersion: PLATFORM_PLAYBOOK_VERSION,
      mode: parsed.mode ?? "clip",
      processingStartSec: parsed.processingStartSec ?? null,
      processingEndSec: parsed.processingEndSec ?? null,
    });

    let project: Project;
    let jobId: string;
    try {
      const created = await prisma.$transaction(async (tx) => {
        const createdProject = await tx.project.create({
          data: {
            userId: ownership.legacyOwnerUserId,
            workspaceId: ownership.workspaceId,
            createdByUserId: ownership.actorUserId,
            updatedByUserId: ownership.actorUserId,
            title: parsed.title ?? "Link Import",
            sourceMediaUrl: parsed.url,
            sourceType,
            sourceProvider: provider,
            sourceInput: parsed.url,
            ingestStatus: "queued",
            languageCode: parsed.languageCode ?? null,
            commitToken: parsed.commitToken ?? null,
            brandTemplateId: brandResolved?.templateId ?? null,
            brandSnapshot: brandResolved
              ? (brandResolved.snapshot as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            createdAt,
            retentionPolicyKey: retention?.retentionPolicyKey ?? null,
            expiresAt: retention?.expiresAt ?? null,
          },
        });

        const createdJob = await tx.ingestJob.create({
          data: {
            projectId: createdProject.id,
            jobType: "link_import",
            payload: {
              url: parsed.url,
              provider,
              requestedTitle: parsed.title ?? null,
            },
          },
        });

        await tx.contentPack.create({
          data: {
            projectId: createdProject.id,
            outputTypes: draftPack.outputTypes,
            clipGenerationMode: draftPack.clipGenerationMode,
            clipCountTarget: draftPack.clipCountTarget,
            clipDurationSecTarget: draftPack.clipDurationSecTarget,
            minDurationSec: draftPack.minDurationSec,
            preferredMinDurationSec: draftPack.preferredMinDurationSec,
            preferredMaxDurationSec: draftPack.preferredMaxDurationSec,
            maxDurationSec: draftPack.maxDurationSec,
            platformTargets: draftPack.platformTargets,
            autoRenderClips: draftPack.autoRenderClips,
            toneConstraints: draftPack.toneConstraints,
            captionPreset: draftPack.captionPreset,
            platformPlaybookVersion: draftPack.platformPlaybookVersion,
            mode: draftPack.mode,
            autoHook: draftPack.autoHook,
            specificMoments: draftPack.specificMoments,
            processingStartSec: draftPack.processingStartSec,
            processingEndSec: draftPack.processingEndSec,
            clipLengthPreset: draftPack.clipLengthPreset,
            defaultAspectRatio: draftPack.defaultAspectRatio,
            draft: true,
          },
        });

        return { project: createdProject, jobId: createdJob.id };
      });
      project = created.project;
      jobId = created.jobId;
    } catch (error) {
      // Concurrent commit with the same token: return the winner's project.
      if (isUniqueConstraintError(error) && parsed.commitToken) {
        const winner = await prisma.project.findUnique({
          where: { commitToken: parsed.commitToken },
          include: { ingestJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
        });
        if (winner && winner.workspaceId === ownership.workspaceId) {
          return {
            project: toProjectSnapshot(winner),
            queuedJobId: winner.ingestJobs[0]?.id ?? null,
          };
        }
      }
      throw error;
    }

    await this.publishIngestLifecycleEvent({
      projectId: project.id,
      workflowRunId: jobId,
      ingestStatus: "queued",
      eventStatus: "queued",
      errorCode: null,
    });

    return {
      project: toProjectSnapshot(project),
      queuedJobId: jobId,
    };
  }

  async previewRssFeed(rssUrl: string) {
    const parsed = rssPreviewSchema.parse({ rssUrl });
    const feed = await fetchRssFeed(parsed.rssUrl);

    return {
      rssUrl: feed.finalUrl,
      title: feed.title,
      episodes: feed.episodes,
    };
  }

  async importFromRss(
    userId: string,
    input: RssImportInput,
    workspaceId?: string,
    generationContext?: { contentPack: ContentPack; languageCode: string | null },
  ) {
    const parsed = rssImportSchema.parse(input);
    // Authorize before performing remote network I/O. importResolvedRssEpisodes
    // repeats this check because it is also called directly by Autopilot.
    await this.resolveWriteOwnership(userId, workspaceId, "processing.consume");
    const feed = await fetchRssFeed(parsed.rssUrl);
    const episodesById = new Map(
      feed.episodes.map((episode) => [episode.id, episode]),
    );
    const episodes = parsed.episodeIds.map((episodeId) => {
      const episode = episodesById.get(episodeId);
      if (!episode) throw new Error("rss_episode_not_found");
      return episode;
    });

    return this.importResolvedRssEpisodes(
      userId,
      {
        rssUrl: feed.finalUrl,
        episodes,
        titlePrefix: parsed.titlePrefix,
        brandTemplateId: parsed.brandTemplateId,
        commitToken: parsed.commitToken,
      },
      workspaceId,
      { generationContext },
    );
  }

  /**
   * Internal authoritative RSS admission path. The caller must supply episodes
   * returned by fetchRssFeed; public/UI callers go through importFromRss,
   * which re-fetches and resolves client-submitted IDs server-side.
   */
  async importResolvedRssEpisodes(
    userId: string,
    input: {
      rssUrl: string;
      episodes: Array<{
        id: string;
        title: string;
        enclosureUrl: string;
        publishedAt?: string | null;
        durationSeconds?: number | null;
        mimeType?: string | null;
      }>;
      titlePrefix?: string;
      brandTemplateId?: string | null;
      commitToken?: string;
    },
    workspaceId?: string,
    options: {
      generationContext?: {
        contentPack: ContentPack;
        languageCode: string | null;
      };
      autopilotRuleId?: string;
    } = {},
  ) {
    if (input.episodes.length < 1 || input.episodes.length > 10) {
      throw new Error("rss_episode_count_invalid");
    }
    if (input.commitToken && input.episodes.length !== 1) {
      throw new Error("rss_commit_token_requires_single_episode");
    }

    const prisma = this.requirePrisma();
    const ownership = await this.resolveWriteOwnership(
      userId,
      workspaceId,
      "processing.consume",
    );

    if (options.autopilotRuleId && input.episodes.length === 1) {
      const existing = await prisma.autopilotEpisode.findUnique({
        where: {
          ruleId_episodeId: {
            ruleId: options.autopilotRuleId,
            episodeId: input.episodes[0]!.id,
          },
        },
      });
      if (existing?.projectId) return { count: 0, projects: [] };
    }
    if (input.commitToken) {
      const existing = await prisma.project.findUnique({
        where: { commitToken: input.commitToken },
        include: { ingestJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
      });
      if (existing) {
        if (existing.workspaceId !== ownership.workspaceId) {
          throw new Error("project not found");
        }
        const queuedJobId = existing.ingestJobs[0]?.id;
        if (!queuedJobId) throw new Error("rss_ingest_job_missing");
        return {
          count: 1,
          projects: [{ project: toProjectSnapshot(existing), queuedJobId }],
        };
      }
    }

    const activeRssIngests = await prisma.ingestJob.count({
      where: {
        jobType: "rss_import",
        status: { in: ["queued", "running"] },
        project: { workspaceId: ownership.workspaceId },
      },
    });
    if (activeRssIngests >= MAX_CONCURRENT_RSS_INGESTS_PER_WORKSPACE) {
      throw new Error("rss_concurrent_ingest_limit_reached");
    }

    const requestedSeconds = input.episodes.reduce(
      (total, episode) => total + (episode.durationSeconds ?? 0),
      0,
    );
    await this.assertWorkspaceWithinQuota(ownership.workspaceId, requestedSeconds);

    const brandResolved = await brandTemplateService.resolveSnapshotForUser(
      ownership.legacyOwnerUserId,
      input.brandTemplateId ?? null,
      { workspaceId: ownership.workspaceId, actorUserId: ownership.actorUserId },
    );

    const createdProjects: Array<{
      project: ProjectSnapshot;
      queuedJobId: string;
    }> = [];

    for (const episode of input.episodes) {
      const createdAt = new Date();
      const retention = await projectRetentionService.assignmentForWorkspace(
        ownership.workspaceId,
        createdAt,
      );
      let project: Project;
      let jobId: string;
      try {
        const created = await prisma.$transaction(async (tx) => {
          if (options.autopilotRuleId) {
            // This unique insert is the admission fence. Project, ingest job,
            // generation context, and dedup row commit or roll back together.
            await tx.autopilotEpisode.create({
              data: {
                ruleId: options.autopilotRuleId,
                episodeId: episode.id,
              },
            });
          }

          const createdProject = await tx.project.create({
            data: {
              userId: ownership.legacyOwnerUserId,
              workspaceId: ownership.workspaceId,
              createdByUserId: ownership.actorUserId,
              updatedByUserId: ownership.actorUserId,
              title: input.titlePrefix
                ? `${input.titlePrefix} - ${episode.title}`
                : episode.title,
              sourceMediaUrl: episode.enclosureUrl,
              sourceType: "rss",
              sourceInput: redactUrlForDisplay(input.rssUrl),
              ingestStatus: "queued",
              sourceMimeType: episode.mimeType ?? null,
              sourceDurationSeconds: episode.durationSeconds ?? null,
              languageCode: options.generationContext?.languageCode ?? null,
              commitToken: input.commitToken ?? null,
              brandTemplateId: brandResolved?.templateId ?? null,
              brandSnapshot: brandResolved
                ? (brandResolved.snapshot as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
              createdAt,
              retentionPolicyKey: retention?.retentionPolicyKey ?? null,
              expiresAt: retention?.expiresAt ?? null,
            },
          });

          const createdJob = await tx.ingestJob.create({
            data: {
              projectId: createdProject.id,
              jobType: "rss_import",
              payload: { rssUrl: input.rssUrl, episode },
            },
          });

          if (options.generationContext) {
            const contentPack = contentPackSchema.parse(
              options.generationContext.contentPack,
            );
            await tx.contentPack.create({
              data: {
                projectId: createdProject.id,
                outputTypes: contentPack.outputTypes,
                clipGenerationMode: contentPack.clipGenerationMode,
                clipCountTarget: contentPack.clipCountTarget,
                clipDurationSecTarget: contentPack.clipDurationSecTarget,
                minDurationSec: contentPack.minDurationSec,
                preferredMinDurationSec: contentPack.preferredMinDurationSec,
                preferredMaxDurationSec: contentPack.preferredMaxDurationSec,
                maxDurationSec: contentPack.maxDurationSec,
                platformTargets: contentPack.platformTargets,
                autoRenderClips: contentPack.autoRenderClips,
                toneConstraints: contentPack.toneConstraints,
                captionPreset: contentPack.captionPreset,
                platformPlaybookVersion: contentPack.platformPlaybookVersion,
                mode: contentPack.mode,
                autoHook: contentPack.autoHook,
                specificMoments: contentPack.specificMoments,
                processingStartSec: contentPack.processingStartSec,
                processingEndSec: contentPack.processingEndSec,
                clipLengthPreset: contentPack.clipLengthPreset,
                defaultAspectRatio: contentPack.defaultAspectRatio,
              },
            });
          }

          if (options.autopilotRuleId) {
            await tx.autopilotEpisode.update({
              where: {
                ruleId_episodeId: {
                  ruleId: options.autopilotRuleId,
                  episodeId: episode.id,
                },
              },
              data: { projectId: createdProject.id },
            });
          }

          return { project: createdProject, jobId: createdJob.id };
        });
        project = created.project;
        jobId = created.jobId;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          if (options.autopilotRuleId) {
            const winner = await prisma.autopilotEpisode.findUnique({
              where: {
                ruleId_episodeId: {
                  ruleId: options.autopilotRuleId,
                  episodeId: episode.id,
                },
              },
              include: { project: { include: { ingestJobs: { take: 1 } } } },
            });
            if (winner?.project) continue;
          }
          if (input.commitToken) {
            const winner = await prisma.project.findUnique({
              where: { commitToken: input.commitToken },
              include: { ingestJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
            });
            if (winner && winner.workspaceId === ownership.workspaceId) {
              const queuedJobId = winner.ingestJobs[0]?.id;
              if (!queuedJobId) throw new Error("rss_ingest_job_missing");
              createdProjects.push({
                project: toProjectSnapshot(winner),
                queuedJobId,
              });
              continue;
            }
          }
        }
        throw error;
      }

      createdProjects.push({
        project: toProjectSnapshot(project),
        queuedJobId: jobId,
      });

      await this.publishIngestLifecycleEvent({
        projectId: project.id,
        workflowRunId: jobId,
        ingestStatus: "queued",
        eventStatus: "queued",
        errorCode: null,
      });
    }

    return {
      count: createdProjects.length,
      projects: createdProjects,
    };
  }

  async claimNextWorkflowRun(
    stage:
      | "stt"
      | "moment_detection"
      | "clip_rendering"
      | "dubbing"
      | "output_pack_generation"
      | "export_bundle" = "stt",
  ): Promise<ClaimedWorkflowRun | null> {
    const prisma = this.requirePrisma();

    if (stage === "clip_rendering") {
      await this.ensurePendingClipRenderingRun();
    }

    const claimedV2 = await getWorkflowRunLifecycle().claim(stage);
    if (claimedV2) {
      return {
        id: claimedV2.workflowRunId,
        projectId: claimedV2.projectId,
        stage: claimedV2.stage,
        status: claimedV2.status,
        progress: claimedV2.progress,
        contentPackId: claimedV2.contentPackId,
        lifecycleVersion: WORKFLOW_LIFECYCLE_VERSION,
        attemptId: claimedV2.attemptId,
        attemptCount: claimedV2.attemptCount,
        project: claimedV2.project as ClaimedWorkflowRun["project"],
      };
    }

    // Bounded retry: under multi-worker contention the conditional update below
    // can lose the race (update.count === 0). Cap the retries and return null so
    // the poller simply tries again next tick, rather than recursing unbounded.
    for (let attempt = 0; attempt < 5; attempt++) {
      const queued = await prisma.workflowRun.findFirst({
        where: {
          lifecycleVersion: 1,
          stage,
          status: "queued",
          project: accessibleProjectWhere(),
          // Backoff gate for a requeued run (see claimBackoffWhereClauses):
          // a never-claimed run (attemptCount 0) is always eligible; a
          // previously-failed/stalled one waits out its exponential window.
          AND: [
            { OR: claimBackoffWhereClauses(WORKFLOW_AUTO_RETRY_MAX_ATTEMPTS) },
            {
              OR: [
                { project: { workspaceId: null } },
                { project: { workspace: { status: "active" } } },
              ],
            },
          ],
        },
        orderBy: { createdAt: "asc" },
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

      if (!queued) {
        return null;
      }

      const update = await prisma.workflowRun.updateMany({
        where: {
          id: queued.id,
          lifecycleVersion: 1,
          status: "queued",
          project: accessibleProjectWhere(),
          OR: [
            { project: { workspaceId: null } },
            { project: { workspace: { status: "active" } } },
          ],
        },
        data: {
          status: "running",
          progress: 10,
          // Incremented on every claim (fresh or requeued) so failure
          // handling below and the reapers can tell how many attempts a run
          // has already had — mirrors IngestJob.attemptCount, which this
          // column now finally matches (see the migration comment on the
          // WorkflowRun model).
          attemptCount: { increment: 1 },
        },
      });

      if (update.count === 0) {
        continue; // lost the race; try the next queued row
      }

      if (stage === "clip_rendering") {
        // Crash recovery: a ClipRender left in `rendering` is treated as the
        // orphan of a crashed/reaped earlier attempt. Without this reset the
        // variant is skipped forever: retries only ever select status=pending.
        // Caveat (accepted): a reaped-but-still-alive worker holds no fencing
        // token, so if its heartbeat gap exceeded the reap stall timeout it
        // may still be encoding these variants while the new claimant
        // re-renders them — bounded by the stale completion guards in
        // completeClipRenderingWorkflowRun/completeTranscriptWorkflowRun and
        // by per-attempt-unique output uploads elsewhere; a true per-run
        // lease is the clip-group-claiming follow-up in
        // docs/plans/pipeline-performance.md.
        const orphaned = await prisma.clipRender.updateMany({
          where: { status: "rendering", clip: { projectId: queued.projectId } },
          data: { status: "pending", startedAt: null, errorCode: null },
        });
        if (orphaned.count > 0) {
          console.warn(
            JSON.stringify({
              level: "warn",
              message: "orphaned_rendering_variants_reset",
              projectId: queued.projectId,
              workflowRunId: queued.id,
              count: orphaned.count,
            }),
          );
        }
      }

      if (stage === "stt") {
        await prisma.transcript.upsert({
          where: { projectId: queued.projectId },
          create: {
            projectId: queued.projectId,
            status: "processing",
            provider: STT_PROVIDER,
            providerModel: STT_PROVIDER_MODEL,
            providerJobId: null,
          },
          update: {
            status: "processing",
            provider: STT_PROVIDER,
            providerModel: STT_PROVIDER_MODEL,
            providerJobId: null,
            errorCode: null,
          },
        });
      }

      await this.publishWorkflowRunEvent({
        projectId: queued.projectId,
        workflowRunId: queued.id,
        stage,
        status: "running",
        progress: 10,
        errorCode: null,
      });

      return {
        id: queued.id,
        projectId: queued.projectId,
        stage,
        status: "running",
        progress: 10,
        contentPackId: queued.contentPackId ?? null,
        lifecycleVersion: queued.lifecycleVersion,
        attemptId: null,
        attemptCount: queued.attemptCount + 1,
        project: queued.project,
      };
    }

    return null;
  }

  /**
   * Repairs the narrow enqueue/completion race where a render is inserted
   * after a running worker took its snapshot but after that worker checked
   * for follow-up work. The pending ClipRender row is durable, so each render
   * poll ensures it has a live WorkflowRun before attempting a claim.
   * Multi-worker races collapse through the database's partial one-live-run
   * index; this is intentionally not dependent on Redis delivery.
   */
  async ensurePendingClipRenderingRun(): Promise<string | null> {
    const prisma = this.requirePrisma();
    const orphan = await prisma.clipRender.findFirst({
      where: {
        status: "pending",
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
      orderBy: { createdAt: "asc" },
      select: { clip: { select: { projectId: true } } },
    });
    if (!orphan) return null;

    const run = await getWorkflowRunLifecycle().admit({
      projectId: orphan.clip.projectId,
      idempotencyKey: `render-rescue:${randomUUID()}`,
      stage: "clip_rendering",
    });

    await prisma.clipExport.updateMany({
      where: {
        projectId: orphan.clip.projectId,
        status: { in: ["queued", "rendering"] },
      },
        data: { workflowRunId: run.id },
    });
    return run.id;
  }

  async claimNextIngestJob(): Promise<ClaimedIngestJob | null> {
    const prisma = this.requirePrisma();

    // Bounded retry: mirror claimNextWorkflowRun — cap contention retries and
    // return null so the poller retries next tick instead of recursing.
    for (let attempt = 0; attempt < 5; attempt++) {
      const queued = await prisma.ingestJob.findFirst({
        where: {
          status: "queued",
          project: accessibleProjectWhere(),
          // Backoff gate for a requeued job (see claimBackoffWhereClauses):
          // a never-claimed job (attemptCount 0) is always eligible; a
          // previously-failed/stalled one waits out its exponential window.
          AND: [
            { OR: claimBackoffWhereClauses(INGEST_AUTO_RETRY_MAX_ATTEMPTS) },
            {
              OR: [
                { project: { workspaceId: null } },
                { project: { workspace: { status: "active" } } },
              ],
            },
          ],
        },
        orderBy: { createdAt: "asc" },
      });

      if (!queued) {
        return null;
      }

      const update = await prisma.ingestJob.updateMany({
        where: {
          id: queued.id,
          status: "queued",
          project: accessibleProjectWhere(),
          OR: [
            { project: { workspaceId: null } },
            { project: { workspace: { status: "active" } } },
          ],
        },
        data: {
          status: "running",
          startedAt: new Date(),
          attemptCount: {
            increment: 1,
          },
        },
      });

      if (update.count === 0) {
        continue; // lost the race; try the next queued row
      }

      const claimed = await prisma.ingestJob.findUnique({
        where: { id: queued.id },
      });

      if (!claimed) {
        return null;
      }

      return {
        id: claimed.id,
        projectId: claimed.projectId,
        jobType: claimed.jobType,
        payload: claimed.payload,
        attemptCount: claimed.attemptCount,
      };
    }

    return null;
  }

  /** Submit-and-release STT: records the provider job id so the dedicated
   *  result-poll loop can take over and the IO loop's claim slot is freed the
   *  moment submission succeeds. claimNextWorkflowRun's stt branch resets
   *  providerJobId to null on every (re)claim, so a requeued run always
   *  resubmits instead of adopting a stale job. */
  async markTranscriptSubmitted(projectId: string, providerJobId: string) {
    const attempt = currentWorkflowAttempt();
    if (attempt?.projectId === projectId) {
      await getWorkflowRunLifecycle().waitForProvider(attempt, {
        providerJobId,
        nextPollAt: new Date(Date.now() + 5_000),
      });
      return;
    }
    const prisma = this.requirePrisma();
    const compatibilityRun = await prisma.workflowRun.findFirst({
      where: {
        projectId,
        lifecycleVersion: 1,
        stage: "stt",
        status: "running",
      },
      select: { id: true },
    });
    if (!compatibilityRun) {
      throw new WorkflowAttemptContextRequired(projectId);
    }
    await prisma.transcript.updateMany({
      where: { projectId },
      data: { providerJobId, status: "processing" },
    });
  }

  /**
   * STT result polling (submit-and-release): returns up to `batchSize` stt
   * runs whose provider job was submitted (Transcript.providerJobId set) and
   * whose last heartbeat is older than `minPollIntervalMs`. The conditional
   * update doubles as a per-tick lease — the write bumps updatedAt, so a
   * replica racing on the same run loses the updateMany and skips it. The
   * transcript's own updatedAt is returned as `submittedAt`: nothing touches
   * the Transcript row between submission and completion, so it anchors the
   * overall transcription timeout without a schema change.
   */
  async claimSubmittedTranscriptRunsForPolling(
    batchSize: number,
    minPollIntervalMs: number,
  ): Promise<
    Array<{
      id: string;
      projectId: string;
      progress: number;
      providerJobId: string;
      submittedAt: Date;
      stage: "stt";
      lifecycleVersion: number;
      attemptId: string | null;
      attemptCount: number;
    }>
  > {
    const prisma = this.requirePrisma();
    const waitingV2 = await getWorkflowRunLifecycle().claimDueWaitingTranscripts(
      batchSize,
      minPollIntervalMs,
    );
    if (waitingV2.length >= batchSize) {
      return waitingV2.map((run) => ({
        id: run.workflowRunId,
        projectId: run.projectId,
        progress: run.progress,
        providerJobId: run.providerJobId,
        submittedAt: run.submittedAt,
        stage: "stt" as const,
        lifecycleVersion: WORKFLOW_LIFECYCLE_VERSION,
        attemptId: run.attemptId,
        attemptCount: run.attemptCount,
      }));
    }
    const cutoff = new Date(Date.now() - minPollIntervalMs);

    const candidates = await prisma.workflowRun.findMany({
      where: {
        lifecycleVersion: 1,
        stage: "stt",
        status: "running",
        updatedAt: { lt: cutoff },
        project: {
          ...accessibleProjectWhere(),
          transcript: {
            providerJobId: { not: null },
            status: "processing",
          },
        },
      },
      orderBy: { updatedAt: "asc" },
      take: batchSize - waitingV2.length,
      select: {
        id: true,
        projectId: true,
        progress: true,
        attemptCount: true,
        project: {
          select: {
            transcript: {
              select: { providerJobId: true, updatedAt: true },
            },
          },
        },
      },
    });

    const claimed: Array<{
      id: string;
      projectId: string;
      progress: number;
      providerJobId: string;
      submittedAt: Date;
      stage: "stt";
      lifecycleVersion: number;
      attemptId: string | null;
      attemptCount: number;
    }> = [];

    for (const run of candidates) {
      const providerJobId = run.project.transcript?.providerJobId;
      const submittedAt = run.project.transcript?.updatedAt;
      if (!providerJobId || !submittedAt) continue;

      const won = await prisma.workflowRun.updateMany({
        where: {
          id: run.id,
          lifecycleVersion: 1,
          status: "running",
          updatedAt: { lt: cutoff },
        },
        data: { progress: run.progress },
      });
      if (won.count === 0) continue;

      claimed.push({
        id: run.id,
        projectId: run.projectId,
        progress: run.progress,
        providerJobId,
        submittedAt,
        stage: "stt",
        lifecycleVersion: 1,
        attemptId: null,
        attemptCount: run.attemptCount,
      });
    }

    return [
      ...waitingV2.map((run) => ({
        id: run.workflowRunId,
        projectId: run.projectId,
        progress: run.progress,
        providerJobId: run.providerJobId,
        submittedAt: run.submittedAt,
        stage: "stt" as const,
        lifecycleVersion: WORKFLOW_LIFECYCLE_VERSION,
        attemptId: run.attemptId,
        attemptCount: run.attemptCount,
      })),
      ...claimed,
    ];
  }

  async completeTranscriptWorkflowRun(
    workflowRunId: string,
    input: {
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
    },
    options?: {
      /** Stale-attempt fence for the submit-and-release result loop: the
       *  provider job id this finalizer polled. If the Transcript row now
       *  carries a different job id (the run was requeued and resubmitted),
       *  this result belongs to a dead attempt and must not overwrite the
       *  live one. */
      expectedProviderJobId?: string;
    },
  ) {
    const attempt = currentWorkflowAttempt(workflowRunId);
    if (attempt) {
      await getWorkflowRunLifecycle().completeTranscript(attempt, {
        ...input,
        utterances: input.utterances as Prisma.InputJsonValue,
      });
      return;
    }
    const prisma = this.requirePrisma();
    const run = await prisma.workflowRun.findUnique({
      where: { id: workflowRunId },
    });

    if (!run) {
      throw new Error("workflow run not found");
    }
    requireProtocolV1CompatibilityRun(run);

    if (run.status === "completed" || run.status === "failed") {
      return;
    }

    if (options?.expectedProviderJobId) {
      const currentTranscript = await prisma.transcript.findUnique({
        where: { projectId: run.projectId },
        select: { providerJobId: true },
      });
      if (
        currentTranscript?.providerJobId !== options.expectedProviderJobId
      ) {
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "transcript_stale_finalize_skipped",
            workflowRunId: run.id,
            projectId: run.projectId,
            expectedProviderJobId: options.expectedProviderJobId,
          }),
        );
        return;
      }
    }

    const completedAt = new Date();

    await prisma.transcript.upsert({
      where: { projectId: run.projectId },
      create: {
        projectId: run.projectId,
        status: "completed",
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

    // Backfill the project's source duration from the transcript when ingest
    // couldn't probe it (e.g. uploaded files) — this is the metric usage quotas
    // are enforced against.
    if (input.durationSeconds && input.durationSeconds > 0) {
      await prisma.project.updateMany({
        where: { id: run.projectId, sourceDurationSeconds: null },
        data: { sourceDurationSeconds: input.durationSeconds },
      });
    }

    // Auto-advance BEFORE marking the stt run completed: if this process dies
    // between the two writes, the stt run is still `running`, so the result
    // loop simply re-finalizes on its next tick (the transcript upsert above
    // is an idempotent rewrite and the create below collapses via the unique
    // (projectId, idempotencyKey)). The old order — complete first, then
    // create — left the pipeline permanently parked before moment detection
    // if the create failed, because a completed run is neither claimable nor
    // reapable.
    const mdIdempotencyKey = `${run.idempotencyKey}__moment_detection`;
    await getWorkflowRunLifecycle().admit({
      projectId: run.projectId,
      idempotencyKey: mdIdempotencyKey,
      stage: "moment_detection",
    });

    // Conditional on still-running: a requeued/settled run must not be
    // completed by a stale finalizer that lost the race.
    const won = await prisma.workflowRun.updateMany({
      where: { id: run.id, status: "running" },
      data: {
        stage: "stt",
        status: "completed",
        progress: 100,
        errorCode: null,
      },
    });

    if (won.count === 0) {
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "transcript_stale_completion_skipped",
          workflowRunId: run.id,
          projectId: run.projectId,
        }),
      );
      return;
    }

    await this.publishWorkflowRunEvent({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "stt",
      status: "completed",
      progress: 100,
      errorCode: null,
    });

  }

  async completeClipDetectionWorkflowRun(workflowRunId: string) {
    const attempt = currentWorkflowAttempt(workflowRunId);
    if (attempt) {
      await getWorkflowRunLifecycle().completeMomentDetection(attempt);
      return;
    }
    const prisma = this.requirePrisma();
    const run = await prisma.workflowRun.findUnique({
      where: { id: workflowRunId },
    });

    if (!run) {
      throw new Error("workflow run not found");
    }
    requireProtocolV1CompatibilityRun(run);

    await prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        stage: "moment_detection",
        status: "completed",
        progress: 100,
        errorCode: null,
      },
    });

    await this.publishWorkflowRunEvent({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "moment_detection",
      status: "completed",
      progress: 100,
      errorCode: null,
    });
  }

  /**
   * Shared failure handling for the 4 non-ingest workflow stages: decides
   * (via decideAutoRetry) whether to requeue the SAME run for a fresh, later
   * attempt or fail it permanently, performs the corresponding write, and
   * publishes the resulting event. Returns the decision so
   * failTranscriptWorkflowRun can apply the same outcome to the Transcript
   * row it additionally owns.
   *
   * The requeue write is a plain `update` (not a conditional `updateMany`):
   * only the worker that currently holds this "running" row ever calls a
   * fail* method for it, so there's no concurrent-claim race here — the
   * atomic step that needs to stay conditional is the CLAIM
   * (claimNextWorkflowRun's updateMany), which this doesn't touch.
   */
  private async settleFailedWorkflowRun(
    run: PrismaWorkflowRun,
    stage: "stt" | "moment_detection" | "clip_rendering" | "dubbing",
    errorCode: string,
  ): Promise<AutoRetryDecision> {
    const prisma = this.requirePrisma();
    const decision = decideAutoRetry(
      run.attemptCount,
      errorCode,
      WORKFLOW_AUTO_RETRY_MAX_ATTEMPTS,
      WORKFLOW_RETRIES_EXHAUSTED_CODE,
    );

    console.warn(
      JSON.stringify({
        level: "warn",
        message: "workflow_run_failure_decision",
        workflowRunId: run.id,
        projectId: run.projectId,
        stage,
        errorCode,
        attemptCount: run.attemptCount,
        maxAttempts: WORKFLOW_AUTO_RETRY_MAX_ATTEMPTS,
        outcome: decision.outcome,
      }),
    );

    if (decision.outcome === "requeue") {
      try {
        await prisma.workflowRun.update({
          where: { id: run.id },
          data: { stage, status: "queued", progress: 0, errorCode: null },
        });
      } catch (error) {
        // The one-live-clip_rendering-run partial index can reject a requeue:
        // if this run was reaped out from under a still-alive worker and a
        // newer live run was then legitimately created, flipping this one back
        // to queued would violate the index. The newer run owns the project's
        // pending work, so settle this one permanently instead of letting the
        // P2002 escape (it would otherwise wedge the caller — including the
        // reaper — on every subsequent cycle).
        if (!isUniqueConstraintError(error)) {
          throw error;
        }
        const superseded: AutoRetryDecision = {
          outcome: "permanent",
          terminalErrorCode: "superseded_duplicate_run",
        };
        await prisma.workflowRun.update({
          where: { id: run.id },
          data: {
            stage,
            status: "failed",
            progress: 100,
            errorCode: superseded.terminalErrorCode,
          },
        });
        await this.publishWorkflowRunEvent({
          projectId: run.projectId,
          workflowRunId: run.id,
          stage,
          status: "failed",
          progress: 100,
          errorCode: superseded.terminalErrorCode,
        });
        return superseded;
      }

      await this.publishWorkflowRunEvent({
        projectId: run.projectId,
        workflowRunId: run.id,
        stage,
        status: "queued",
        progress: 0,
        errorCode: null,
      });

      return decision;
    }

    await prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        stage,
        status: "failed",
        progress: 100,
        errorCode: decision.terminalErrorCode,
      },
    });

    await this.publishWorkflowRunEvent({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage,
      status: "failed",
      progress: 100,
      errorCode: decision.terminalErrorCode,
    });

    return decision;
  }

  async failClipDetectionWorkflowRun(
    workflowRunId: string,
    failure: WorkflowFailure,
  ) {
    const errorCode = failure.code;
    const attempt = currentWorkflowAttempt(workflowRunId);
    if (attempt) {
      await getWorkflowRunLifecycle().failAttempt(attempt, failure);
      return;
    }
    const prisma = this.requirePrisma();
    const run = await prisma.workflowRun.findUnique({
      where: { id: workflowRunId },
    });

    if (!run) {
      throw new Error("workflow run not found");
    }
    requireProtocolV1CompatibilityRun(run);

    await this.settleFailedWorkflowRun(run, "moment_detection", errorCode);
  }

  async completeClipRenderingWorkflowRun(
    workflowRunId: string,
    options?: { failedVariantCount?: number },
  ) {
    const attempt = currentWorkflowAttempt(workflowRunId);
    if (attempt) {
      await getWorkflowRunLifecycle().completeRendering(
        attempt,
        options?.failedVariantCount ?? 0,
      );
      return;
    }
    const prisma = this.requirePrisma();
    const run = await prisma.workflowRun.findUnique({
      where: { id: workflowRunId },
    });

    if (!run) {
      throw new Error("workflow run not found");
    }
    requireProtocolV1CompatibilityRun(run);

    // Partial failures still complete the run (per-variant status carries the
    // detail), but the run records that it wasn't a clean sweep instead of
    // reporting unqualified success.
    const errorCode =
      options?.failedVariantCount && options.failedVariantCount > 0
        ? "partial_render_failure"
        : null;

    // Conditional on still-running: a run this worker lost (reaped and
    // requeued/superseded while a stale attempt kept encoding) must not be
    // flipped to completed by that stale attempt.
    const won = await prisma.workflowRun.updateMany({
      where: { id: run.id, status: "running" },
      data: {
        stage: "clip_rendering",
        status: "completed",
        progress: 100,
        errorCode,
      },
    });

    if (won.count === 0) {
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "clip_rendering_stale_completion_skipped",
          workflowRunId: run.id,
          projectId: run.projectId,
          status: run.status,
        }),
      );
      return;
    }

    await this.publishWorkflowRunEvent({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "clip_rendering",
      status: "completed",
      progress: 100,
      errorCode,
    });
  }

  async failClipRenderingWorkflowRun(
    workflowRunId: string,
    failure: WorkflowFailure,
    options?: {
      /** The variants the failed attempt touched (all individually `failed`
       *  when every encode in the run failed). Passing them here lets the
       *  requeue-vs-permanent decision and the variant write happen together:
       *  on requeue they flip back to pending so the retry has work to pick
       *  up; on permanent they stay `failed` with their real per-variant
       *  error codes, so the UI settles instead of showing an active render
       *  forever. */
      retryVariantIds?: string[];
    },
  ) {
    const errorCode = failure.code;
    const attempt = currentWorkflowAttempt(workflowRunId);
    if (attempt) {
      await getWorkflowRunLifecycle().failAttempt(attempt, failure);
      return;
    }
    const prisma = this.requirePrisma();
    const run = await prisma.workflowRun.findUnique({
      where: { id: workflowRunId },
    });

    if (!run) {
      throw new Error("workflow run not found");
    }
    requireProtocolV1CompatibilityRun(run);

    const decision = await this.settleFailedWorkflowRun(
      run,
      "clip_rendering",
      errorCode,
    );

    if (decision.outcome === "requeue") {
      if (options?.retryVariantIds?.length) {
        const exportVariantIds = (
          await prisma.clipRender.findMany({
            where: { id: { in: options.retryVariantIds } },
            select: { exportVariantId: true },
          })
        )
          .map((render) => render.exportVariantId)
          .filter((id): id is string => Boolean(id));
        await prisma.clipRender.updateMany({
          where: { id: { in: options.retryVariantIds }, status: "failed" },
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
        if (exportVariantIds.length > 0) {
          await prisma.clipExportVariant.updateMany({
            where: { id: { in: exportVariantIds } },
            data: {
              status: "pending",
              errorCode: null,
              startedAt: null,
              completedAt: null,
            },
          });
        }
      }
      return;
    }

    await this.failOrphanedRenderingVariants(
      run.projectId,
      decision.terminalErrorCode,
    );
  }

  /** Terminal-failure cleanup: once no future clip_rendering claim will ever
   *  reset them (claim-time recovery only runs on a claim), variants still in
   *  `rendering` must settle to `failed` or the UI reports an active render
   *  forever. Requeue paths never call this — the next claim resets those. */
  private async failOrphanedRenderingVariants(
    projectId: string,
    errorCode: string,
  ) {
    const prisma = this.requirePrisma();
    const exportVariants = await prisma.clipRender.findMany({
      where: {
        status: "rendering",
        clip: { projectId },
        exportVariantId: { not: null },
      },
      select: { exportVariantId: true },
    });
    const orphaned = await prisma.clipRender.updateMany({
      where: { status: "rendering", clip: { projectId } },
      data: { status: "failed", errorCode },
    });
    const exportVariantIds = exportVariants
      .map((render) => render.exportVariantId)
      .filter((id): id is string => Boolean(id));
    if (exportVariantIds.length > 0) {
      await prisma.clipExportVariant.updateMany({
        where: { id: { in: exportVariantIds } },
        data: { status: "failed", errorCode },
      });
      const affected = await prisma.clipExportVariant.findMany({
        where: { id: { in: exportVariantIds } },
        select: { exportId: true },
      });
      for (const exportId of new Set(affected.map((variant) => variant.exportId))) {
        const variants = await prisma.clipExportVariant.findMany({
          where: { exportId },
          select: { status: true },
        });
        const completed = variants.filter((variant) => variant.status === "completed").length;
        const terminal = variants.every(
          (variant) => variant.status === "completed" || variant.status === "failed",
        );
        await prisma.clipExport.update({
          where: { id: exportId },
          data: {
            status: terminal
              ? completed > 0
                ? "partial_ready"
                : "failed"
              : "rendering",
            progress: terminal ? 100 : 95,
            errorCode: terminal && completed === 0 ? errorCode : null,
            completedAt: terminal ? new Date() : null,
          },
        });
      }
    }
    if (orphaned.count > 0) {
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "orphaned_rendering_variants_failed",
          projectId,
          count: orphaned.count,
          errorCode,
        }),
      );
    }
  }

  async completeDubbingWorkflowRun(workflowRunId: string) {
    const attempt = currentWorkflowAttempt(workflowRunId);
    if (attempt) {
      await getWorkflowRunLifecycle().completeDubbing(attempt);
      return;
    }
    const prisma = this.requirePrisma();
    const run = await prisma.workflowRun.findUnique({
      where: { id: workflowRunId },
    });

    if (!run) {
      throw new Error("workflow run not found");
    }
    requireProtocolV1CompatibilityRun(run);

    await prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        stage: "dubbing",
        status: "completed",
        progress: 100,
        errorCode: null,
      },
    });

    await this.publishWorkflowRunEvent({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "dubbing",
      status: "completed",
      progress: 100,
      errorCode: null,
    });
  }

  async failDubbingWorkflowRun(
    workflowRunId: string,
    failure: WorkflowFailure,
  ) {
    const errorCode = failure.code;
    const attempt = currentWorkflowAttempt(workflowRunId);
    if (attempt) {
      await getWorkflowRunLifecycle().failAttempt(attempt, failure);
      return;
    }
    const prisma = this.requirePrisma();
    const run = await prisma.workflowRun.findUnique({
      where: { id: workflowRunId },
    });

    if (!run) {
      throw new Error("workflow run not found");
    }
    requireProtocolV1CompatibilityRun(run);

    await this.settleFailedWorkflowRun(run, "dubbing", errorCode);
  }

  async failTranscriptWorkflowRun(
    workflowRunId: string,
    failure: WorkflowFailure,
  ) {
    const errorCode = failure.code;
    const attempt = currentWorkflowAttempt(workflowRunId);
    if (attempt) {
      await getWorkflowRunLifecycle().failAttempt(attempt, failure);
      return;
    }
    const prisma = this.requirePrisma();
    const run = await prisma.workflowRun.findUnique({
      where: { id: workflowRunId },
    });

    if (!run) {
      throw new Error("workflow run not found");
    }
    requireProtocolV1CompatibilityRun(run);

    const decision = await this.settleFailedWorkflowRun(run, "stt", errorCode);

    // Only touch the Transcript row once this is a genuinely terminal
    // failure. On a requeue, claimNextWorkflowRun's stt branch already
    // upserts Transcript back to status "processing" (clearing errorCode)
    // the moment the run is re-claimed, so leaving it alone here is not an
    // oversight — it just stays "processing" for the (short, backed-off)
    // time the run sits requeued, which is accurate: it is still being
    // processed, just not at this exact instant.
    if (decision.outcome === "permanent") {
      await prisma.transcript.upsert({
        where: { projectId: run.projectId },
        create: {
          projectId: run.projectId,
          status: "failed",
          provider: STT_PROVIDER,
          providerModel: STT_PROVIDER_MODEL,
          errorCode: decision.terminalErrorCode,
        },
        update: {
          status: "failed",
          provider: STT_PROVIDER,
          providerModel: STT_PROVIDER_MODEL,
          errorCode: decision.terminalErrorCode,
          completedAt: null,
        },
      });
    }
  }

  async markIngestJobDownloading(jobId: string) {
    return this.updateJobIngestLifecycle(jobId, "downloading");
  }

  async markIngestJobNormalizing(jobId: string) {
    return this.updateJobIngestLifecycle(jobId, "normalizing");
  }

  async completeIngestJob(
    jobId: string,
    input: {
      sourceStorageKey: string;
      sourceMediaUrl?: string;
      sourceInput?: string | null;
      sourceMimeType?: string | null;
      sourceSizeBytes?: number | null;
      sourceDurationSeconds?: number | null;
    },
  ) {
    const prisma = this.requirePrisma();

    const job = await prisma.ingestJob.findUnique({ where: { id: jobId } });

    if (!job) {
      throw new Error("ingest job not found");
    }

    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: job.projectId },
        data: {
          sourceStorageKey: input.sourceStorageKey,
          sourceMediaUrl:
            input.sourceMediaUrl ?? buildR2Uri(input.sourceStorageKey),
          sourceInput: input.sourceInput ?? undefined,
          sourceMimeType: input.sourceMimeType ?? undefined,
          sourceSizeBytes:
            typeof input.sourceSizeBytes === "number"
              ? BigInt(input.sourceSizeBytes)
              : undefined,
          sourceDurationSeconds: input.sourceDurationSeconds ?? undefined,
          ingestStatus: "ready",
          ingestErrorCode: null,
          ingestCompletedAt: new Date(),
        },
      });

      await tx.ingestJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          lastError: null,
          completedAt: new Date(),
        },
      });
    });

    await this.publishIngestLifecycleEvent({
      projectId: job.projectId,
      workflowRunId: job.id,
      ingestStatus: "ready",
      eventStatus: "completed",
      errorCode: null,
    });

    try {
      await this.triggerGenerationIfPending(job.projectId);
    } catch (error) {
      // The ingest itself succeeded (upload is "ready"); only the automatic
      // generation trigger failed. Recovery is the manual "AI Transcription"
      // retry action on the project page (queueTranscriptionFormAction →
      // triggerGeneration), so surface this loudly at error level rather than
      // swallowing it as a warning.
      console.error(
        JSON.stringify({
          level: "error",
          message: "trigger_generation_after_ingest_failed",
          projectId: job.projectId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async failIngestJob(jobId: string, errorCode: string, errorMessage: string) {
    const prisma = this.requirePrisma();

    const job = await prisma.ingestJob.findUnique({ where: { id: jobId } });

    if (!job) {
      throw new Error("ingest job not found");
    }

    const decision = decideAutoRetry(
      job.attemptCount,
      errorCode,
      INGEST_AUTO_RETRY_MAX_ATTEMPTS,
      INGEST_RETRIES_EXHAUSTED_CODE,
    );

    console.warn(
      JSON.stringify({
        level: "warn",
        message: "ingest_job_failure_decision",
        jobId: job.id,
        projectId: job.projectId,
        errorCode,
        attemptCount: job.attemptCount,
        maxAttempts: INGEST_AUTO_RETRY_MAX_ATTEMPTS,
        outcome: decision.outcome,
      }),
    );

    if (decision.outcome === "requeue") {
      await prisma.$transaction(async (tx) => {
        await tx.project.update({
          where: { id: job.projectId },
          data: {
            ingestStatus: "queued",
            ingestErrorCode: null,
          },
        });

        await tx.ingestJob.update({
          where: { id: job.id },
          data: {
            status: "queued",
            // Breadcrumb for ops (not user-facing — the project's
            // ingestErrorCode is cleared above so the UI doesn't show a
            // stale failure banner while this is quietly retrying).
            lastError: `${errorCode}: ${errorMessage} (auto-retry, attempt ${job.attemptCount} of ${INGEST_AUTO_RETRY_MAX_ATTEMPTS})`,
          },
        });
      });

      await this.publishIngestLifecycleEvent({
        projectId: job.projectId,
        workflowRunId: job.id,
        ingestStatus: "queued",
        eventStatus: "queued",
        errorCode: null,
      });
      return;
    }

    const terminalErrorCode = decision.terminalErrorCode;

    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: job.projectId },
        data: {
          ingestStatus: "failed",
          ingestErrorCode: terminalErrorCode,
        },
      });

      await tx.ingestJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          lastError: `${errorCode}: ${errorMessage}`,
          completedAt: new Date(),
        },
      });
    });

    await this.publishIngestLifecycleEvent({
      projectId: job.projectId,
      workflowRunId: job.id,
      ingestStatus: "failed",
      eventStatus: "failed",
      errorCode: terminalErrorCode,
    });
  }

  /**
   * Re-queues ingest for a project stuck in ingestStatus "failed": clones the
   * most recent IngestJob's jobType + payload into a brand-new job (a fresh
   * createdAt keeps it fair in claimNextIngestJob's global FIFO instead of
   * letting an old retry jump the queue) and flips the project back to
   * "queued". Bounded by MAX_INGEST_RETRY_ATTEMPTS (counting the original
   * attempt); once reached, callers must tell the user to start over.
   *
   * The failed -> queued transition is a conditional updateMany so a
   * double-click or a race with another retry can't enqueue two jobs.
   */
  async retryFailedIngest(
    userId: string,
    projectId: string,
    workspaceContext?: { workspaceId: string; actorUserId: string },
  ) {
    const prisma = this.requirePrisma();

    if (workspaceContext) {
      await workspaceService.requireActor(
        workspaceContext.actorUserId,
        workspaceContext.workspaceId,
        "processing.consume",
      );
    }

    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        ...(workspaceContext
          ? { workspaceId: workspaceContext.workspaceId }
          : { userId }),
      },
      select: { id: true, ingestStatus: true },
    });

    if (!project) {
      throw new Error("project not found");
    }

    if (project.ingestStatus !== "failed") {
      throw new IngestNotFailedError();
    }

    const [attemptCount, lastJob] = await Promise.all([
      prisma.ingestJob.count({ where: { projectId } }),
      prisma.ingestJob.findFirst({
        where: { projectId },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    if (!lastJob) {
      throw new Error("no prior ingest job found to retry");
    }

    if (attemptCount >= MAX_INGEST_RETRY_ATTEMPTS) {
      throw new IngestRetryLimitExceededError(MAX_INGEST_RETRY_ATTEMPTS);
    }

    const claim = await prisma.project.updateMany({
      where: {
        id: projectId,
        ingestStatus: "failed",
        ...(workspaceContext
          ? { workspaceId: workspaceContext.workspaceId }
          : { userId }),
      },
      data: { ingestStatus: "queued", ingestErrorCode: null },
    });

    if (claim.count === 0) {
      // Another retry (or the worker itself) already moved this project out
      // of "failed" between our read and this write.
      throw new IngestNotFailedError();
    }

    const job = await prisma.ingestJob.create({
      data: {
        projectId,
        jobType: lastJob.jobType,
        payload: lastJob.payload as unknown as Prisma.InputJsonValue,
      },
    });

    await this.publishIngestLifecycleEvent({
      projectId,
      workflowRunId: job.id,
      ingestStatus: "queued",
      eventStatus: "queued",
      errorCode: null,
    });

    return {
      queuedJobId: job.id,
      attemptsUsed: attemptCount + 1,
      maxAttempts: MAX_INGEST_RETRY_ATTEMPTS,
    };
  }

  private async updateJobIngestLifecycle(
    jobId: string,
    ingestStatus: Exclude<IngestLifecycleStatus, "ready" | "failed">,
  ) {
    const prisma = this.requirePrisma();

    const job = await prisma.ingestJob.findUnique({ where: { id: jobId } });

    if (!job) {
      throw new Error("ingest job not found");
    }

    const projectUpdate = await prisma.project.updateMany({
      where: { id: job.projectId, ...accessibleProjectWhere() },
      data: {
        ingestStatus,
        ingestErrorCode: null,
      },
    });
    if (projectUpdate.count === 0) throw new ProjectExpiredError();

    await prisma.ingestJob.updateMany({
      where: { id: job.id, status: "running" },
      data: { lastError: null },
    });

    await this.publishIngestLifecycleEvent({
      projectId: job.projectId,
      workflowRunId: job.id,
      ingestStatus,
      eventStatus: "running",
      errorCode: null,
    });
  }

  async getTranscriptForWorker(projectId: string) {
    const prisma = this.requirePrisma();
    return prisma.transcript.findUnique({
      where: { projectId },
    });
  }

  async getLatestContentPack(projectId: string) {
    const prisma = this.requirePrisma();
    return prisma.contentPack.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
  }

  async getProjectBrandSnapshot(projectId: string): Promise<unknown | null> {
    const prisma = this.requirePrisma();
    const row = await prisma.project.findUnique({
      where: { id: projectId },
      select: { brandSnapshot: true },
    });
    return row?.brandSnapshot ?? null;
  }

  async getProjectLanguageCode(projectId: string): Promise<string | null> {
    const prisma = this.requirePrisma();
    const row = await prisma.project.findUnique({
      where: { id: projectId },
      select: { languageCode: true },
    });
    return row?.languageCode ?? null;
  }

  async prepareGenerationContext(
    userId: string,
    projectId: string,
    contentPack: ContentPack,
    languageCode: string | null,
  ) {
    const prisma = this.requirePrisma();

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true, workspaceId: true, brandSnapshot: true, brandTemplateId: true },
    });

    if (!project) {
      throw new Error("project not found");
    }

    let brandSnapshotData: Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined;
    let brandTemplateIdData: string | null | undefined;
    if (!project.brandSnapshot) {
      const brandResolved = await brandTemplateService.resolveSnapshotForUser(
        userId,
        null,
        project.workspaceId
          ? { workspaceId: project.workspaceId, actorUserId: userId }
          : undefined,
      );
      if (brandResolved) {
        brandSnapshotData = brandResolved.snapshot as unknown as Prisma.InputJsonValue;
        brandTemplateIdData = brandResolved.templateId;
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: projectId },
        data: {
          languageCode,
          ...(brandSnapshotData !== undefined && { brandSnapshot: brandSnapshotData }),
          ...(brandTemplateIdData !== undefined && {
            brandTemplateId: brandTemplateIdData,
          }),
        },
      });

      await tx.contentPack.create({
        data: {
          projectId,
          outputTypes: contentPack.outputTypes,
          clipGenerationMode: contentPack.clipGenerationMode,
          clipCountTarget: contentPack.clipCountTarget,
          clipDurationSecTarget: contentPack.clipDurationSecTarget,
          minDurationSec: contentPack.minDurationSec,
          preferredMinDurationSec: contentPack.preferredMinDurationSec,
          preferredMaxDurationSec: contentPack.preferredMaxDurationSec,
          maxDurationSec: contentPack.maxDurationSec,
          platformTargets: contentPack.platformTargets,
          autoRenderClips: contentPack.autoRenderClips,
          toneConstraints: contentPack.toneConstraints,
          captionPreset: contentPack.captionPreset,
          platformPlaybookVersion: contentPack.platformPlaybookVersion,
          mode: contentPack.mode,
          autoHook: contentPack.autoHook,
          specificMoments: contentPack.specificMoments,
          processingStartSec: contentPack.processingStartSec,
          processingEndSec: contentPack.processingEndSec,
        },
      });
    });
  }

  async triggerGenerationIfPending(projectId: string): Promise<boolean> {
    const prisma = this.requirePrisma();

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        userId: true,
        ingestStatus: true,
        languageCode: true,
      },
    });

    if (!project || project.ingestStatus !== "ready") {
      return false;
    }

    const [latestRun, recentPacks] = await Promise.all([
      prisma.workflowRun.findFirst({
        where: { projectId },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.contentPack.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
    ]);

    if (latestRun) return false;

    // Latest pack overall; STOP if it is a draft (Step 2 not finished) —
    // never fall back to an older committed pack with stale settings.
    const actionablePack = selectActionablePack(recentPacks);
    if (!actionablePack) return false;

    const contentPack = parseStoredContentPack(actionablePack);
    const storedLanguageCode = sourceLanguageCodeSchema.safeParse(
      project.languageCode,
    );

    await this.triggerGeneration(
      project.userId,
      projectId,
      {
        contentPack,
        forceRegenerate: false,
        languageCode: storedLanguageCode.success
          ? storedLanguageCode.data
          : null,
      },
      autoTriggerIdempotencyKey(projectId, actionablePack.id),
      { existingContentPackId: actionablePack.id },
    );

    return true;
  }

  /**
   * Step 2 (Configure) commit for the link-first split. Persists the final
   * ContentPack — upserting the project's single draft row to committed —
   * then attempts the same idempotent run-claim the ingest worker uses.
   *
   * ORDERING INVARIANT: the pack commit lands BEFORE ingestStatus is read;
   * the ingest worker commits ingestStatus = ready BEFORE reading the pack.
   * At least one side therefore sees both facts, and the deterministic
   * idempotency key collapses a double-claim to one run.
   */
  async finalizeGenerationSetup(
    userId: string,
    projectId: string,
    contentPack: ContentPack,
    languageCode: string | null,
  ): Promise<FinalizeSetupResult> {
    const prisma = this.requirePrisma();

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true, ingestStatus: true },
    });
    if (!project) {
      throw new Error("project not found");
    }

    const existingRun = await prisma.workflowRun.findFirst({
      where: { projectId },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (existingRun) {
      // Re-invoked after a successful start (refresh, double-click, SSE
      // re-fire): idempotent success.
      return {
        started: true,
        ingestStatus: project.ingestStatus,
        workflowRunId: existingRun.id,
      };
    }

    const packData = {
      outputTypes: contentPack.outputTypes,
      clipGenerationMode: contentPack.clipGenerationMode,
      clipCountTarget: contentPack.clipCountTarget,
      clipDurationSecTarget: contentPack.clipDurationSecTarget,
      minDurationSec: contentPack.minDurationSec,
      preferredMinDurationSec: contentPack.preferredMinDurationSec,
      preferredMaxDurationSec: contentPack.preferredMaxDurationSec,
      maxDurationSec: contentPack.maxDurationSec,
      platformTargets: contentPack.platformTargets,
      autoRenderClips: contentPack.autoRenderClips,
      toneConstraints: contentPack.toneConstraints,
      captionPreset: contentPack.captionPreset,
      platformPlaybookVersion: contentPack.platformPlaybookVersion,
      mode: contentPack.mode,
      autoHook: contentPack.autoHook,
      specificMoments: contentPack.specificMoments,
      processingStartSec: contentPack.processingStartSec,
      processingEndSec: contentPack.processingEndSec,
      clipLengthPreset: contentPack.clipLengthPreset,
      defaultAspectRatio: contentPack.defaultAspectRatio,
      draft: false,
    };

    // Upsert-in-place: repeated Configure updates the same row, never
    // inserts. A pack already bound to a WorkflowRun is immutable — a
    // concurrent finalize that lost the claim race must not rewrite the
    // settings the running claim was made with.
    const committedPack = await prisma.$transaction(async (tx) => {
      const latest = await tx.contentPack.findFirst({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (latest) {
        const guarded = await tx.contentPack.updateMany({
          where: { id: latest.id, workflowRuns: { none: {} } },
          data: packData,
        });
        return guarded.count === 0 ? null : { id: latest.id };
      }
      return tx.contentPack.create({
        data: { projectId, ...packData },
        select: { id: true },
      });
    });

    if (!committedPack) {
      // The latest pack is already bound to a run (concurrent finalize won).
      const boundRun = await prisma.workflowRun.findFirst({
        where: { projectId },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
      return {
        started: true,
        ingestStatus: project.ingestStatus,
        workflowRunId: boundRun?.id,
      };
    }

    await prisma.project.update({
      where: { id: projectId },
      data: { languageCode },
    });

    // Pack committed — NOW read ingest state (the ordering invariant).
    const fresh = await prisma.project.findUnique({
      where: { id: projectId },
      select: { ingestStatus: true },
    });
    const ingestStatus = fresh?.ingestStatus ?? project.ingestStatus;

    if (ingestStatus !== "ready") {
      return { started: false, ingestStatus };
    }

    const parsedLanguage = sourceLanguageCodeSchema.safeParse(languageCode);
    const result = await this.triggerGeneration(
      userId,
      projectId,
      {
        contentPack,
        forceRegenerate: false,
        languageCode: parsedLanguage.success ? parsedLanguage.data : null,
      },
      autoTriggerIdempotencyKey(projectId, committedPack.id),
      { existingContentPackId: committedPack.id },
    );

    return {
      started: true,
      ingestStatus,
      workflowRunId: result.workflowRunId,
    };
  }

  /**
   * "Save settings and finish later": persist the user's Step-2 choices as
   * the project's draft pack without starting anything. No-op (returns
   * false) once a run exists — the settings already fed a claim.
   */
  async saveGenerationDraft(
    userId: string,
    projectId: string,
    contentPack: ContentPack,
    languageCode: string | null,
  ): Promise<boolean> {
    const prisma = this.requirePrisma();
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true },
    });
    if (!project) throw new Error("project not found");

    const existingRun = await prisma.workflowRun.findFirst({
      where: { projectId },
      select: { id: true },
    });
    if (existingRun) return false;

    const draftData = {
      outputTypes: contentPack.outputTypes,
      clipGenerationMode: contentPack.clipGenerationMode,
      clipCountTarget: contentPack.clipCountTarget,
      clipDurationSecTarget: contentPack.clipDurationSecTarget,
      minDurationSec: contentPack.minDurationSec,
      preferredMinDurationSec: contentPack.preferredMinDurationSec,
      preferredMaxDurationSec: contentPack.preferredMaxDurationSec,
      maxDurationSec: contentPack.maxDurationSec,
      platformTargets: contentPack.platformTargets,
      autoRenderClips: contentPack.autoRenderClips,
      toneConstraints: contentPack.toneConstraints,
      captionPreset: contentPack.captionPreset,
      platformPlaybookVersion: contentPack.platformPlaybookVersion,
      mode: contentPack.mode,
      autoHook: contentPack.autoHook,
      specificMoments: contentPack.specificMoments,
      processingStartSec: contentPack.processingStartSec,
      processingEndSec: contentPack.processingEndSec,
      clipLengthPreset: contentPack.clipLengthPreset,
      defaultAspectRatio: contentPack.defaultAspectRatio,
      draft: true,
    };

    await prisma.$transaction(async (tx) => {
      const latest = await tx.contentPack.findFirst({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (latest) {
        await tx.contentPack.updateMany({
          where: { id: latest.id, workflowRuns: { none: {} } },
          data: draftData,
        });
      } else {
        await tx.contentPack.create({ data: { projectId, ...draftData } });
      }
      await tx.project.update({
        where: { id: projectId },
        data: { languageCode },
      });
    });
    return true;
  }

  /**
   * The pack a worker task must use for a claimed run: the run's bound pack.
   * Falls back to the latest committed pack only for pre-split legacy runs
   * that carry no binding.
   */
  async getContentPackForRun(run: {
    id: string;
    projectId: string;
    contentPackId?: string | null;
  }) {
    const prisma = this.requirePrisma();
    if (run.contentPackId) {
      const bound = await prisma.contentPack.findUnique({
        where: { id: run.contentPackId },
      });
      if (bound) return bound;
    }
    return prisma.contentPack.findFirst({
      where: { projectId: run.projectId, draft: false },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Per-project "email me when clips are ready" preference. */
  async setProjectNotifyPreference(
    userId: string,
    projectId: string,
    notifyOnComplete: boolean,
  ): Promise<void> {
    const prisma = this.requirePrisma();
    const updated = await prisma.project.updateMany({
      where: { id: projectId, userId },
      data: { notifyOnComplete },
    });
    if (updated.count === 0) {
      throw new Error("project not found");
    }
  }

  /** Read-only usage summary for the import pre-flight UI. */
  async getUsageSummary(userId: string, workspaceId?: string): Promise<{
    tier: PricingTier;
    usedMinutes: number;
    limitMinutes: number;
    maxUploadSeconds: number;
  }> {
    const workspace = workspaceId
      ? await this.requirePrisma().workspace.findUnique({ where: { id: workspaceId }, select: { pricingTier: true } })
      : null;
    const tier = workspace ? resolvePricingTier(workspace.pricingTier) : await this.getUserPricingTier(userId);
    const usedMinutes = workspaceId
      ? await this.getWorkspaceMonthlyUsageMinutes(workspaceId)
      : await this.getMonthlyUsageMinutes(userId);
    return {
      tier,
      usedMinutes,
      limitMinutes: MONTHLY_PROCESSING_MINUTE_LIMITS[tier],
      maxUploadSeconds: MAX_UPLOAD_LENGTH_SECONDS[tier],
    };
  }

  async publishWorkflowProgress(input: {
    projectId: string;
    workflowRunId: string;
    stage:
      | "stt"
      | "moment_detection"
      | "clip_rendering"
      | "dubbing"
      | "output_pack_generation"
      | "export_bundle";
    status: "queued" | "running" | "completed" | "failed";
    progress: number;
    errorCode: string | null;
  }) {
    const attempt = currentWorkflowAttempt(input.workflowRunId);
    if (attempt) {
      await getWorkflowRunLifecycle().reportProgress(attempt, input.progress);
      return null;
    }
    // Heartbeat: bump the run row (updatedAt) while it is running so the reaper
    // can distinguish a live, progressing run from a worker that died mid-run.
    if (hasDatabase()) {
      try {
        const heartbeat = await this.requirePrisma().workflowRun.updateMany({
          where: {
            id: input.workflowRunId,
            lifecycleVersion: 1,
            status: "running",
            project: accessibleProjectWhere(),
          },
          data: { progress: input.progress },
        });
        if (heartbeat.count === 0) throw new ProjectExpiredError();
      } catch (error) {
        if (error instanceof ProjectExpiredError) throw error;
        // A failed heartbeat must not crash the worker, but it must be
        // visible: without it the reaper cannot tell a live, progressing run
        // from a worker that died mid-run.
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "workflow_heartbeat_failed",
            workflowRunId: input.workflowRunId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    return this.publishWorkflowRunEvent(input);
  }

  /**
   * Fails workflow runs that are still `running` but whose heartbeat
   * (`updatedAt`) is older than `stallTimeoutMs` — i.e. the worker that owned
   * them died. Without this a crash leaves a project spinning forever. Returns
   * the number of runs reaped.
   */
  async reapStuckWorkflowRuns(
    stallTimeoutMs = 30 * 60 * 1000,
  ): Promise<number> {
    if (!hasDatabase()) return 0;
    const prisma = this.requirePrisma();
    const reapedV2 = await getWorkflowRunLifecycle().reapExpiredAttempts();
    const cutoff = new Date(Date.now() - stallTimeoutMs);

    const stalled = await prisma.workflowRun.findMany({
      where: {
        lifecycleVersion: 1,
        status: "running",
        updatedAt: { lt: cutoff },
      },
      select: { id: true, projectId: true, stage: true, attemptCount: true },
    });

    let reaped = 0;
    for (const run of stalled) {
      // A worker crashing mid-run is the most retryable failure mode there
      // is — the run never got a chance to fail on its own merits — so this
      // goes through the exact same decideAutoRetry cap as an explicit
      // failure rather than always killing the run outright.
      const decision = decideAutoRetry(
        run.attemptCount,
        "worker_stalled",
        WORKFLOW_AUTO_RETRY_MAX_ATTEMPTS,
        WORKFLOW_RETRIES_EXHAUSTED_CODE,
      );

      const updated = await prisma.workflowRun.updateMany({
        where: { id: run.id, status: "running" },
        data:
          decision.outcome === "requeue"
            ? { status: "queued", progress: 0, errorCode: null }
            : { status: "failed", errorCode: decision.terminalErrorCode },
      });
      if (updated.count === 0) continue;
      reaped += 1;

      if (run.stage === "clip_rendering" && decision.outcome === "permanent") {
        await this.failOrphanedRenderingVariants(
          run.projectId,
          decision.terminalErrorCode,
        );
      }

      console.warn(
        JSON.stringify({
          level: "warn",
          message: "workflow_run_stall_decision",
          workflowRunId: run.id,
          projectId: run.projectId,
          stage: run.stage,
          attemptCount: run.attemptCount,
          maxAttempts: WORKFLOW_AUTO_RETRY_MAX_ATTEMPTS,
          outcome: decision.outcome,
        }),
      );

      await this.publishWorkflowRunEvent({
        projectId: run.projectId,
        workflowRunId: run.id,
        stage: run.stage as
          | "stt"
          | "moment_detection"
          | "clip_rendering"
          | "dubbing"
          | "output_pack_generation"
          | "export_bundle",
        status: decision.outcome === "requeue" ? "queued" : "failed",
        progress: decision.outcome === "requeue" ? 0 : 100,
        errorCode:
          decision.outcome === "requeue" ? null : decision.terminalErrorCode,
      }).catch(() => {});
    }
    return reaped + reapedV2;
  }

  /**
   * Fails ingest jobs left `running` by a crashed worker and moves the project
   * to a terminal ingest failure. Otherwise uploads/imports can spin forever
   * even though no worker owns the job anymore.
   */
  async reapStuckIngestJobs(
    stallTimeoutMs = 30 * 60 * 1000,
  ): Promise<number> {
    if (!hasDatabase()) return 0;
    const prisma = this.requirePrisma();
    const cutoff = new Date(Date.now() - stallTimeoutMs);

    const stalled = await prisma.ingestJob.findMany({
      where: {
        status: "running",
        OR: [
          { startedAt: { lt: cutoff } },
          { startedAt: null, updatedAt: { lt: cutoff } },
        ],
      },
      select: { id: true, projectId: true, attemptCount: true },
    });

    let reaped = 0;
    for (const job of stalled) {
      // A worker crashing mid-run is the most retryable failure mode there
      // is — the job never got a chance to fail on its own merits — so this
      // goes through the exact same decideAutoRetry cap as an explicit
      // failure rather than always killing the job outright.
      const decision = decideAutoRetry(
        job.attemptCount,
        "worker_stalled",
        INGEST_AUTO_RETRY_MAX_ATTEMPTS,
        INGEST_RETRIES_EXHAUSTED_CODE,
      );

      const updated = await prisma.ingestJob.updateMany({
        where: { id: job.id, status: "running" },
        data:
          decision.outcome === "requeue"
            ? {
                status: "queued",
                lastError: `worker_stalled: requeued (attempt ${job.attemptCount} of ${INGEST_AUTO_RETRY_MAX_ATTEMPTS})`,
              }
            : {
                status: "failed",
                lastError: "worker_stalled: ingest job heartbeat expired",
                completedAt: new Date(),
              },
      });
      if (updated.count === 0) continue;

      await prisma.project.updateMany({
        where: { id: job.projectId },
        data:
          decision.outcome === "requeue"
            ? { ingestStatus: "queued", ingestErrorCode: null }
            : {
                ingestStatus: "failed",
                ingestErrorCode: decision.terminalErrorCode,
              },
      });

      reaped += 1;
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "ingest_job_stall_decision",
          jobId: job.id,
          projectId: job.projectId,
          attemptCount: job.attemptCount,
          maxAttempts: INGEST_AUTO_RETRY_MAX_ATTEMPTS,
          outcome: decision.outcome,
        }),
      );
      await this.publishIngestLifecycleEvent({
        projectId: job.projectId,
        workflowRunId: job.id,
        ingestStatus: decision.outcome === "requeue" ? "queued" : "failed",
        eventStatus: decision.outcome === "requeue" ? "queued" : "failed",
        errorCode:
          decision.outcome === "requeue" ? null : decision.terminalErrorCode,
      }).catch(() => {});
    }

    return reaped;
  }

  private async publishWorkflowRunEvent(input: {
    projectId: string;
    workflowRunId: string;
    stage:
      | "stt"
      | "moment_detection"
      | "clip_rendering"
      | "dubbing"
      | "output_pack_generation"
      | "export_bundle";
    status: "queued" | "running" | "completed" | "failed";
    progress: number;
    errorCode: string | null;
  }) {
    return publishWorkflowStageUpdated({
      event: "workflow.stage.updated",
      projectId: input.projectId,
      workflowRunId: input.workflowRunId,
      stage: input.stage,
      status: input.status,
      progress: input.progress,
      errorCode: input.errorCode,
    });
  }

  private async publishIngestLifecycleEvent(input: {
    projectId: string;
    workflowRunId: string;
    ingestStatus: IngestLifecycleStatus;
    eventStatus: "queued" | "running" | "completed" | "failed";
    errorCode: string | null;
  }) {
    await publishWorkflowStageUpdated({
      event: "workflow.stage.updated",
      projectId: input.projectId,
      workflowRunId: input.workflowRunId,
      stage: ingestToWorkflowStage(input.ingestStatus),
      status: input.eventStatus,
      progress: ingestProgress(input.ingestStatus),
      errorCode: input.errorCode,
    });
  }
}

export const projectService = new ProjectService();

// ---------------------------------------------------------------------------
// Retention / storage-reclamation jobs (FIX 4). Standalone functions — not
// wired into apps/worker/src/index.ts here; the owner of that file adds the
// periodic reap tick and its own SOURCE_RETENTION_DAYS /
// WORKFLOW_EVENT_RETENTION_DAYS env var plumbing, mirroring how
// purgeOldWebhookDeliveryLogs is called today.
// ---------------------------------------------------------------------------

const DEFAULT_SOURCE_RETENTION_DAYS = 90;
const DEFAULT_WORKFLOW_EVENT_RETENTION_DAYS = 90;
// Per-tick cap on how many source objects purgeExpiredProjectSources will
// attempt to delete — each candidate costs a real R2 round trip, so this
// bounds a single reaper tick's worst-case latency; remaining candidates are
// simply picked up on the next tick.
const SOURCE_PURGE_BATCH_SIZE = 200;

/** Pure cutoff-date arithmetic shared by both retention jobs below, factored
 *  out so the date math has direct unit coverage independent of Prisma. */
export function retentionCutoffDate(retentionDays: number, nowMs = Date.now()): Date {
  return new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000);
}

export interface ProjectSourcePurgeCandidate {
  sourceStorageKey: string | null;
  ingestStatus: PrismaIngestStatus;
  ingestCompletedAt: Date | string | null;
  /** Whether any WorkflowRun for this project is still queued/running. */
  hasActiveWorkflowRun: boolean;
  /** Whether at least one ClipRender has already completed with an asset. */
  hasCompletedRender: boolean;
  /** Whether any clip still needs a preview proxy cut from this source.
   *  Proxies are generated lazily from the source, so purging first strands
   *  those clips on "Preview generating…" forever. */
  hasClipAwaitingPreview: boolean;
}

/**
 * Pure eligibility gate for reclaiming a project's R2 source object. A
 * project only qualifies once: ingest finished successfully, nothing is
 * still mid-flight against the source, at least one clip already has a
 * completed render (never delete a source before any output exists), and
 * the source has aged past the retention window. Exported and tested in
 * isolation so the "don't delete a source whose renders don't exist yet"
 * invariant has direct coverage, independent of the Prisma query that feeds
 * it in purgeExpiredProjectSources below.
 */
export function isProjectSourcePurgeEligible(
  project: ProjectSourcePurgeCandidate,
  options: { retentionDays: number; nowMs: number },
): boolean {
  if (!project.sourceStorageKey) return false;
  if (project.ingestStatus !== "ready") return false;
  if (project.hasActiveWorkflowRun) return false;
  if (!project.hasCompletedRender) return false;
  // Preview proxies are cut lazily from the source. Purging while a clip is
  // still waiting for one strands it on "Preview generating…" permanently,
  // because there is nothing left to cut from. Observed for real: three
  // projects were purged on a first worker boot before any proxy existed.
  if (project.hasClipAwaitingPreview) return false;
  if (!project.ingestCompletedAt) return false;

  const completedAtMs = new Date(project.ingestCompletedAt).getTime();
  if (Number.isNaN(completedAtMs)) return false;

  return (
    completedAtMs <
    retentionCutoffDate(options.retentionDays, options.nowMs).getTime()
  );
}

/**
 * Reclaims R2 storage for source media no longer needed by any pipeline
 * stage. Idempotent and safe under concurrent runners: deleteObject is
 * itself idempotent (a key that's already gone is treated as success), and
 * the DB write is conditioned on the exact key just deleted so a racing
 * purge or a fresh re-upload can never be clobbered. Nulls sourceStorageKey
 * so the app can render a "source expired" state instead of a broken link.
 *
 * Mirrors purgeOldWebhookDeliveryLogs's shape (retention-days param with a
 * sensible default, returns a plain count) — the eligibility decision itself
 * lives in isProjectSourcePurgeEligible above, this just feeds it real rows
 * in bounded batches and executes the deletes.
 */
export async function purgeExpiredProjectSources(
  retentionDays = DEFAULT_SOURCE_RETENTION_DAYS,
): Promise<number> {
  const prisma = getPrismaClient();
  if (!prisma) return 0;

  const candidates = await prisma.project.findMany({
    where: {
      sourceStorageKey: { not: null },
      ingestStatus: "ready",
    },
    select: {
      id: true,
      sourceStorageKey: true,
      ingestStatus: true,
      ingestCompletedAt: true,
      workflowRuns: {
        where: { status: { in: ["queued", "running", "waiting"] } },
        select: { id: true },
        take: 1,
      },
      clips: {
        where: {
          renders: {
            some: { status: "completed", storageKey: { not: null } },
          },
        },
        select: { id: true },
        take: 1,
      },
    },
    take: SOURCE_PURGE_BATCH_SIZE,
  });

  // One extra query for the whole batch rather than per candidate: which of
  // these projects still has a clip with no preview proxy cut yet.
  const projectIdsAwaitingPreview = new Set(
    (
      await prisma.clip.findMany({
        where: {
          projectId: { in: candidates.map((project) => project.id) },
          previewStorageKey: null,
        },
        select: { projectId: true },
        distinct: ["projectId"],
      })
    ).map((clip) => clip.projectId),
  );

  const nowMs = Date.now();
  let purged = 0;

  for (const project of candidates) {
    const key = project.sourceStorageKey;
    const eligible =
      key !== null &&
      isProjectSourcePurgeEligible(
        {
          sourceStorageKey: key,
          ingestStatus: project.ingestStatus,
          ingestCompletedAt: project.ingestCompletedAt,
          hasActiveWorkflowRun: project.workflowRuns.length > 0,
          hasCompletedRender: project.clips.length > 0,
          hasClipAwaitingPreview: projectIdsAwaitingPreview.has(project.id),
        },
        { retentionDays, nowMs },
      );

    if (!eligible || !key) continue;

    try {
      await deleteObject(key);
    } catch (error) {
      if (!isMissingObjectError(error)) {
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "source_purge_delete_failed",
            projectId: project.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        continue; // leave sourceStorageKey intact so a later tick retries
      }
      // Already gone from R2 (e.g. a previous run deleted it but crashed
      // before the DB write below) — fall through and reconcile the row.
    }

    // Conditioned on the exact key we just deleted: a concurrent purge run,
    // or a fresh re-upload that already changed sourceStorageKey, is left
    // alone rather than clobbered.
    const updated = await prisma.project.updateMany({
      where: { id: project.id, sourceStorageKey: key },
      data: { sourceStorageKey: null },
    });

    purged += updated.count;
  }

  return purged;
}

/** Deletes WorkflowEvent rows older than the retention window. Returns
 *  count. Same shape as purgeOldWebhookDeliveryLogs in webhook-log.service.ts. */
export async function purgeOldWorkflowEvents(
  olderThanDays = DEFAULT_WORKFLOW_EVENT_RETENTION_DAYS,
): Promise<number> {
  const prisma = getPrismaClient();
  if (!prisma) return 0;

  const res = await prisma.workflowEvent.deleteMany({
    where: {
      emittedAt: { lt: retentionCutoffDate(olderThanDays) },
      OR: [
        { notificationRequired: false },
        { notificationDeliveredAt: { not: null } },
      ],
    },
  });
  return res.count;
}
