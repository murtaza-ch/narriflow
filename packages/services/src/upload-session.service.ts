import { randomUUID } from "node:crypto";
import { Prisma, type UploadSession as PrismaUploadSession } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  contentPackSchema,
  discardUploadSessionSchema,
  isProcessingQuotaExceeded,
  MONTHLY_PROCESSING_MINUTE_LIMITS,
  finalizeUploadSessionSchema,
  grantUploadPartsSchema,
  openUploadSessionSchema,
  readUploadSessionSchema,
  processingMinutesFromSeconds,
  resolvePricingTier,
  uploadCompletionIntentSchema,
  uploadMimeTypes,
  type OpenUploadSessionInput as ValidatedOpenUploadSessionInput,
  type ReadUploadSessionInput as ValidatedReadUploadSessionInput,
  type DiscardUploadSessionInput as ValidatedDiscardUploadSessionInput,
  type FinalizeUploadSessionInput as ValidatedFinalizeUploadSessionInput,
  type GrantUploadPartsInput as ValidatedGrantUploadPartsInput,
} from "@narriflow/validators";
import { brandTemplateService } from "./brand-template.service";
import { brandProfileService } from "./brand-profile.service";
import { projectRetentionService } from "./project-retention.service";
import {
  abortMultipartUpload,
  classifyR2StorageError,
  completeMultipartUpload,
  createMultipartUpload,
  deleteObject,
  headObject,
  InvalidMultipartUploadIdentityError,
  listExactKeyMultipartUploads,
  listUploadedParts,
  presignMultipartPartUrls,
  presignSingleUploadUrl,
} from "./r2-storage";
import { isWorkflowRedisDeliveryEnabled } from "./workflow.service";
import { workspaceService } from "./workspace.service";

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

export type UploadTransferKind = "single" | "multipart";
export type UploadSessionStatus =
  | "initiating"
  | "uploading"
  | "finalizing"
  | "reconciling"
  | "compensating"
  | "queued_for_ingest"
  | "aborted"
  | "expired"
  | "failed";

export interface UploadSessionConfig {
  readonly maximumSourceBytes: number;
  readonly smallFileThresholdBytes: number;
  readonly multipartPartSizeBytes: number;
  readonly multipartConcurrency: number;
  readonly maximumMultipartParts: number;
  readonly maximumGrantParts: number;
  readonly uploadGrantTtlSeconds: number;
  readonly sessionIdleMs: number;
  readonly sessionHardLifetimeMs: number;
  readonly reconciliationBatchSize: number;
  readonly reconciliationConcurrency: number;
  readonly reconciliationLeaseMs: number;
  readonly reconciliationOperationDeadlineMs: number;
  readonly reconciliationMaximumAttempts: number;
  readonly reconciliationProviderCallBudget: number;
  readonly reconciliationBackoffBaseMs: number;
  readonly reconciliationBackoffCeilingMs: number;
}

export function defaultUploadSessionConfig(
  overrides: Partial<UploadSessionConfig> = {},
): UploadSessionConfig {
  const config = {
    maximumSourceBytes: 5 * GIBIBYTE,
    smallFileThresholdBytes: 100 * MEBIBYTE,
    multipartPartSizeBytes: 16 * MEBIBYTE,
    multipartConcurrency: 4,
    maximumMultipartParts: 10_000,
    maximumGrantParts: 16,
    uploadGrantTtlSeconds: 15 * 60,
    sessionIdleMs: 24 * 60 * 60 * 1000,
    sessionHardLifetimeMs: 6 * 24 * 60 * 60 * 1000,
    reconciliationBatchSize: 25,
    reconciliationConcurrency: 4,
    reconciliationLeaseMs: 60_000,
    reconciliationOperationDeadlineMs: 10_000,
    reconciliationMaximumAttempts: 8,
    reconciliationProviderCallBudget: 20,
    reconciliationBackoffBaseMs: 5_000,
    reconciliationBackoffCeilingMs: 15 * 60 * 1_000,
    ...overrides,
  };

  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Invalid Upload Session configuration: ${name}`);
    }
  }
  if (config.smallFileThresholdBytes > config.maximumSourceBytes) {
    throw new Error(
      "Invalid Upload Session configuration: smallFileThresholdBytes",
    );
  }
  if (
    config.multipartPartSizeBytes < 5 * MEBIBYTE ||
    config.multipartPartSizeBytes > 5 * GIBIBYTE ||
    config.maximumMultipartParts > 10_000 ||
    config.maximumGrantParts > 16 ||
    config.multipartConcurrency > 16
  ) {
    throw new Error("Invalid Upload Session multipart configuration");
  }
  if (config.sessionIdleMs >= config.sessionHardLifetimeMs) {
    throw new Error("Invalid Upload Session configuration: sessionHardLifetimeMs");
  }
  if (
    config.reconciliationConcurrency > config.reconciliationBatchSize ||
    config.reconciliationMaximumAttempts > 32 ||
    config.reconciliationProviderCallBudget > 64 ||
    config.reconciliationBackoffBaseMs > config.reconciliationBackoffCeilingMs ||
    config.reconciliationLeaseMs < config.reconciliationOperationDeadlineMs * 3
  ) {
    throw new Error("Invalid Upload Session reconciliation configuration");
  }
  return Object.freeze(config);
}

export function assertUploadProviderLifecyclePrerequisite(
  env: NodeJS.ProcessEnv,
  hardLifetimeMs = defaultUploadSessionConfig().sessionHardLifetimeMs,
) {
  const name = "R2_INCOMPLETE_MULTIPART_LIFECYCLE_DAYS";
  const raw = env[name]?.trim();
  if (!raw) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        `${name} must confirm the deployed bucket's incomplete-multipart lifecycle rule.`,
      );
    }
    return;
  }
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < 1 || days > 7) {
    throw new Error(`${name} must be an integer from 1 through 7.`);
  }
  if (days * 24 * 60 * 60 * 1_000 <= hardLifetimeMs) {
    throw new Error(
      `${name} must be longer than the Upload Session hard lifetime.`,
    );
  }
}

export interface UploadSessionRecord {
  id: string;
  workspaceId: string;
  actorUserId: string;
  legacyOwnerUserId: string;
  clientIdempotencyKey: string;
  immutableInputFingerprint: string;
  preallocatedProjectId: string;
  title: string;
  fileName: string;
  fileSizeBytes: number;
  contentType: string;
  browserFingerprint: string;
  brandTemplateId: string | null;
  brandSnapshot: unknown;
  brandProfileId: string | null;
  brandProfileSnapshot: unknown;
  generation: unknown;
  transferKind: UploadTransferKind;
  partSizeBytes: number | null;
  partCount: number;
  storageKey: string;
  providerUploadId: string | null;
  admissionAttemptId: string | null;
  admissionClaimExpiresAt: Date | null;
  admissionPreparedAt: Date | null;
  completionParts: Array<{ partNumber: number; etag: string }> | null;
  completionIntentMalformed: boolean;
  queuedJobId: string | null;
  failureCode: string | null;
  cleanupRetryAt: Date | null;
  reconcileAt: Date | null;
  reconciliationAttemptId: string | null;
  reconciliationLeaseExpiresAt: Date | null;
  reconciliationAttemptCount: number;
  status: UploadSessionStatus;
  expiresAt: Date;
  hardExpiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface UploadSessionPersistence {
  findByClientKey(input: {
    workspaceId: string;
    clientIdempotencyKey: string;
  }): Promise<UploadSessionRecord | null>;
  reserve(record: UploadSessionRecord): Promise<{
    created: boolean;
    session: UploadSessionRecord;
  }>;
  claimAdmission(input: {
    sessionId: string;
    admissionAttemptId: string;
    claimExpiresAt: Date;
    updatedAt: Date;
  }): Promise<{ claimed: boolean; session: UploadSessionRecord }>;
  prepareAdmission(input: {
    sessionId: string;
    admissionAttemptId: string;
    brandTemplateId: string | null;
    brandSnapshot: unknown;
    brandProfileId: string | null;
    brandProfileSnapshot: unknown;
    updatedAt: Date;
  }): Promise<UploadSessionRecord>;
  waitForAdmission(sessionId: string): Promise<UploadSessionRecord>;
  bindMultipartProvider(input: {
    sessionId: string;
    admissionAttemptId: string;
    providerUploadId: string;
    updatedAt: Date;
  }): Promise<UploadSessionRecord>;
  markSingleReady(input: {
    sessionId: string;
    admissionAttemptId: string;
    updatedAt: Date;
  }): Promise<UploadSessionRecord>;
  releaseAdmissionClaim(input: {
    sessionId: string;
    admissionAttemptId: string;
    updatedAt: Date;
  }): Promise<void>;
  findByIdForWorkspace(input: {
    sessionId: string;
    workspaceId: string;
  }): Promise<UploadSessionRecord | null>;
  renewTransferActivity(input: {
    sessionId: string;
    expiresAt: Date;
    updatedAt: Date;
  }): Promise<UploadSessionRecord>;
  expireTransfer(input: {
    sessionId: string;
    expiredAt: Date;
  }): Promise<UploadSessionRecord>;
  beginFinalization(input: {
    sessionId: string;
    parts: Array<{ partNumber: number; etag: string }>;
    reconcileAt: Date;
    updatedAt: Date;
  }): Promise<{ claimed: boolean; session: UploadSessionRecord }>;
  handoff(input: {
    sessionId: string;
    queuedJobId: string;
    verifiedSizeBytes: number;
    verifiedContentType: string;
    reconciliationAttemptId?: string;
    updatedAt: Date;
  }): Promise<UploadSessionRecord>;
  recordFailure(input: {
    sessionId: string;
    admissionAttemptId?: string;
    status: "compensating" | "failed";
    failureCode: string;
    cleanupRetryAt?: Date | null;
    updatedAt: Date;
  }): Promise<UploadSessionRecord>;
  recordCleanupRetry(input: {
    sessionId: string;
    failureCode: string | null;
    cleanupRetryAt: Date | null;
    reconciliationAttemptId?: string;
    updatedAt: Date;
  }): Promise<UploadSessionRecord>;
  markReconciling(input: {
    sessionId: string;
    failureCode: string;
    reconcileAt: Date;
    reconciliationAttemptId?: string;
    updatedAt: Date;
  }): Promise<UploadSessionRecord>;
  findDueReconciliation(input: {
    now: Date;
    limit: number;
  }): Promise<UploadSessionRecord[]>;
  claimReconciliation(input: {
    sessionId: string;
    reconciliationAttemptId: string;
    leaseExpiresAt: Date;
    updatedAt: Date;
  }): Promise<{ claimed: boolean; session: UploadSessionRecord }>;
  renewReconciliationClaim(input: {
    sessionId: string;
    reconciliationAttemptId: string;
    leaseExpiresAt: Date;
    updatedAt: Date;
  }): Promise<UploadSessionRecord>;
  beginDiscard(input: {
    sessionId: string;
    reconciliationAttemptId: string;
    leaseExpiresAt: Date;
    updatedAt: Date;
  }): Promise<{ claimed: boolean; session: UploadSessionRecord }>;
  releaseReconciliation(input: {
    sessionId: string;
    reconciliationAttemptId: string;
    updatedAt: Date;
  }): Promise<UploadSessionRecord>;
  beginCompensation(input: {
    sessionId: string;
    reconciliationAttemptId: string;
    failureCode: string;
    updatedAt: Date;
  }): Promise<UploadSessionRecord>;
  settleTerminal(input: {
    sessionId: string;
    reconciliationAttemptId: string;
    status: "expired" | "aborted" | "failed";
    failureCode: string;
    updatedAt: Date;
  }): Promise<UploadSessionRecord>;
  deferReconciliation(input: {
    sessionId: string;
    reconciliationAttemptId: string;
    failureCode: string;
    reconcileAt: Date;
    updatedAt: Date;
  }): Promise<UploadSessionRecord>;
}

export interface UploadSessionStorage {
  grantSinglePut(input: {
    storageKey: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<{ url: string }>;
  createMultipart(input: {
    storageKey: string;
    contentType: string;
    metadata: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<{ providerUploadId: string }>;
  grantMultipartParts(input: {
    storageKey: string;
    providerUploadId: string;
    partNumbers: number[];
    expiresInSeconds: number;
  }): Promise<Array<{ partNumber: number; url: string }>>;
  completeMultipart(input: {
    storageKey: string;
    providerUploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
    signal?: AbortSignal;
  }): Promise<void>;
  listMultipartParts(input: {
    storageKey: string;
    providerUploadId: string;
    signal?: AbortSignal;
    onProviderCall?: () => void;
  }): Promise<Array<{ partNumber: number; etag: string }>>;
  headExactObject(storageKey: string, signal?: AbortSignal): Promise<{
    sizeBytes: number;
    contentType: string | null;
  }>;
  headExactObjectIfExists(storageKey: string, signal?: AbortSignal): Promise<{
    sizeBytes: number;
    contentType: string | null;
  } | null>;
  listExactKeyMultipartUploads(
    storageKey: string,
    signal?: AbortSignal,
    onProviderCall?: () => void,
  ): Promise<
    Array<{ providerUploadId: string; initiatedAt: Date | null }>
  >;
  abortMultipart(input: {
    storageKey: string;
    providerUploadId: string;
    signal?: AbortSignal;
  }): Promise<void>;
  deleteExactObject(storageKey: string, signal?: AbortSignal): Promise<void>;
}

export interface UploadSessionAdmission {
  assertQuota(workspaceId: string): Promise<void>;
  resolveBrand(input: {
    workspaceId: string;
    actorUserId: string;
    legacyOwnerUserId: string;
    brandTemplateId: string | null;
    brandProfileId: string | null;
  }): Promise<{
    templateId: string | null;
    snapshot: unknown;
    profileId: string | null;
    profileSnapshot: unknown;
  } | null>;
}

export interface UploadSessionModuleDependencies {
  config: UploadSessionConfig;
  persistence: UploadSessionPersistence;
  storage: UploadSessionStorage;
  admission: UploadSessionAdmission;
  now(): Date;
  createId(): string;
  random?(): number;
  diagnose?(event: UploadSessionDiagnosticEvent): void;
}

export interface UploadSessionDiagnosticEvent {
  phase:
    | "reservation"
    | "provider_creation"
    | "provider_bind"
    | "adoption"
    | "duplicate_abort"
    | "compensation"
    | "reconciliation";
  disposition: "started" | "succeeded" | "failed";
  sessionId: string;
  state?: UploadSessionStatus;
  providerOperation?: "head" | "complete" | "abort" | "delete" | "list";
  providerCallCount?: number;
  failureCode?: string;
  declaredAbandonedBytes?: number;
  declaredAbandonedAgeMs?: number;
  durationMs?: number;
  nextRetryAt?: string;
  takeover?: boolean;
  replay?: boolean;
}

export function uploadSessionDiagnosticRecord(
  event: UploadSessionDiagnosticEvent,
) {
  return {
    level: event.disposition === "failed" ? "warn" : "info",
    message: "upload_session_transition",
    uploadSessionId: event.sessionId,
    phase: event.phase,
    disposition: event.disposition,
    ...(event.state === undefined ? {} : { state: event.state }),
    ...(event.providerOperation === undefined
      ? {}
      : { providerOperation: event.providerOperation }),
    ...(event.providerCallCount === undefined
      ? {}
      : { providerCallCount: event.providerCallCount }),
    ...(event.failureCode === undefined
      ? {}
      : { failureCode: event.failureCode }),
    ...(event.declaredAbandonedBytes === undefined
      ? {}
      : { declaredAbandonedBytes: event.declaredAbandonedBytes }),
    ...(event.declaredAbandonedAgeMs === undefined
      ? {}
      : { declaredAbandonedAgeMs: event.declaredAbandonedAgeMs }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.nextRetryAt === undefined
      ? {}
      : { nextRetryAt: event.nextRetryAt }),
    ...(event.takeover === undefined ? {} : { takeover: event.takeover }),
    ...(event.replay === undefined ? {} : { replay: event.replay }),
  } as const;
}

export interface OpenUploadSessionInput {
  actorUserId: string;
  workspaceId: string;
  legacyOwnerUserId: string;
  clientIdempotencyKey: string;
  title: string;
  source: {
    fileName: string;
    sizeBytes: number;
    contentType: string;
    browserFingerprint: string;
  };
  brandTemplateId: string | null;
  brandProfileId: string | null;
  generation: unknown;
}

export interface ReadUploadSessionInput {
  actorUserId: string;
  workspaceId: string;
  clientIdempotencyKey: string;
  sessionId: string | null;
  browserFingerprint: string;
}

export interface DiscardUploadSessionInput {
  actorUserId: string;
  workspaceId: string;
  sessionId: string;
}

export type DiscardUploadSessionOutcome =
  | { outcome: "discarded"; sessionId: string }
  | {
      outcome: "compensating";
      sessionId: string;
      retryAfterSeconds: number;
    };

export type OpenUploadSessionOutcome =
  | {
      outcome: "queued_for_ingest";
      sessionId: string;
      projectId: string;
      queuedJobId: string;
    }
  | {
      outcome: "reconciling";
      sessionId: string;
      projectId: string;
      retryAfterSeconds: number;
    }
  | {
      outcome: "uploading";
      sessionId: string;
      projectId: string;
      expiresAt: string;
      transfer:
    | {
        kind: "single";
        contentType: string;
        grant: { url: string; contentType: string };
      }
    | {
        kind: "multipart";
        partSizeBytes: number;
        partCount: number;
        concurrency: number;
        grants: Array<{ partNumber: number; url: string }>;
        grantExpiresAt: string;
        completedParts: Array<{ partNumber: number; etag: string }>;
        };
    };

export type ReadUploadSessionOutcome =
  | OpenUploadSessionOutcome
  | {
      outcome: "terminal";
      sessionId: string;
      state: "aborted" | "expired" | "failed";
      failureCode: string | null;
      freshUploadAllowed: boolean;
    };

export interface FinalizeUploadSessionInput {
  actorUserId: string;
  workspaceId: string;
  sessionId: string;
  parts: Array<{ partNumber: number; etag: string }>;
}

export interface GrantUploadPartsInput {
  actorUserId: string;
  workspaceId: string;
  sessionId: string;
  partNumbers: number[];
}

export type GrantUploadPartsOutcome = {
  outcome: "granted";
  sessionId: string;
  expiresAt: string;
  grants: Array<{ partNumber: number; url: string }>;
};

export type QueuedUploadHandoffOutcome = {
  outcome: "queued_for_ingest";
  sessionId: string;
  projectId: string;
  queuedJobId: string;
};

export type FinalizeUploadSessionOutcome =
  | QueuedUploadHandoffOutcome
  | {
      outcome: "reconciling";
      sessionId: string;
      retryAfterSeconds: number;
    };

export class UploadSessionIdempotencyConflictError extends Error {
  readonly code = "upload_session_idempotency_conflict";

  constructor() {
    super("This upload key is already bound to different upload settings.");
    this.name = "UploadSessionIdempotencyConflictError";
  }
}

export class UploadSessionNotFoundError extends Error {
  readonly code = "upload_session_not_found";

  constructor() {
    super("Upload Session not found.");
    this.name = "UploadSessionNotFoundError";
  }
}

export class UploadSessionInvalidStateError extends Error {
  readonly code = "upload_session_invalid_state";

  constructor(message = "The Upload Session cannot accept that operation.") {
    super(message);
    this.name = "UploadSessionInvalidStateError";
  }
}

export class UploadSessionIntegrityError extends Error {
  readonly code = "upload_session_integrity_failed";

  constructor(message: string) {
    super(message);
    this.name = "UploadSessionIntegrityError";
  }
}

export class UploadSessionStorageProbeError extends Error {
  constructor(
    readonly disposition:
      | "missing"
      | "access_denied"
      | "invalid_metadata"
      | "unavailable",
  ) {
    super(`Upload Session storage probe ${disposition}`);
    this.name = "UploadSessionStorageProbeError";
  }
}

export class UploadSessionAdmissionClaimLostError extends Error {
  constructor() {
    super("Upload Session admission claim was superseded.");
    this.name = "UploadSessionAdmissionClaimLostError";
  }
}

export class UploadSessionReconciliationClaimLostError extends Error {
  constructor() {
    super("Upload Session reconciliation claim was superseded.");
    this.name = "UploadSessionReconciliationClaimLostError";
  }
}

class UploadSessionProviderIdentityError extends Error {
  constructor() {
    super("Storage provider returned a malformed upload identity.");
    this.name = "UploadSessionProviderIdentityError";
  }
}

function assertOpaqueProviderIdentity(value: string) {
  if (!value || value.length > 2_048) {
    throw new UploadSessionProviderIdentityError();
  }
  return value;
}

function sanitizeFileName(fileName: string) {
  return (
    fileName
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "source.bin"
  );
}

function immutableInputFingerprint(input: OpenUploadSessionInput) {
  return JSON.stringify({
    title: input.title,
    source: input.source,
    brandTemplateId: input.brandTemplateId,
    brandProfileId: input.brandProfileId,
    generation: input.generation,
  });
}

function terminalFreshUploadAllowed(session: UploadSessionRecord) {
  if (session.status === "aborted" || session.status === "expired") return true;
  if (session.status !== "failed") return false;
  switch (session.failureCode) {
    case "quota_exceeded":
    case "upload_admission_failed":
    case "unsupported_media_type":
    case "provider_creation_failed":
    case "upload_object_size_mismatch":
    case "upload_object_content_type_mismatch":
    case "upload_object_missing":
    case "multipart_upload_missing":
    case "multipart_completion_bucket_missing":
    case "upload_cleanup_bucket_missing":
      return true;
    case "completion_intent_malformed":
    case "multipart_completion_invalid_parts":
      return (
        session.transferKind === "multipart" &&
        Boolean(session.providerUploadId)
      );
    default:
      return false;
  }
}

export function planUploadTransfer(
  sizeBytes: number,
  config: UploadSessionConfig,
): {
  kind: UploadTransferKind;
  partSizeBytes: number | null;
  partCount: number;
} {
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > config.maximumSourceBytes
  ) {
    throw new Error("Unsupported upload source size");
  }
  if (sizeBytes <= config.smallFileThresholdBytes) {
    return { kind: "single", partSizeBytes: null, partCount: 1 };
  }
  const partSizeBytes = Math.max(
    config.multipartPartSizeBytes,
    Math.ceil(sizeBytes / config.maximumMultipartParts),
  );
  const partCount = Math.ceil(sizeBytes / partSizeBytes);
  if (partCount > config.maximumMultipartParts) {
    throw new Error("Upload source exceeds multipart provider limits");
  }
  return { kind: "multipart", partSizeBytes, partCount };
}

function normalizeCompletionParts(
  parts: Array<{ partNumber: number; etag: string }>,
  expectedPartCount: number,
) {
  if (parts.length !== expectedPartCount) return null;
  const normalized = new Map<number, string>();
  for (const part of parts) {
    if (
      !Number.isInteger(part.partNumber) ||
      part.partNumber < 1 ||
      part.partNumber > expectedPartCount ||
      typeof part.etag !== "string" ||
      part.etag.trim().length === 0 ||
      normalized.has(part.partNumber)
    ) {
      return null;
    }
    normalized.set(part.partNumber, part.etag);
  }
  return Array.from(normalized, ([partNumber, etag]) => ({
    partNumber,
    etag,
  })).sort((left, right) => left.partNumber - right.partNumber);
}

function normalizeProviderPartInventory(
  parts: Array<{ partNumber: number; etag: string }>,
  expectedPartCount: number,
) {
  const normalized = new Map<number, string>();
  for (const part of parts) {
    if (
      !Number.isInteger(part.partNumber) ||
      part.partNumber < 1 ||
      part.partNumber > expectedPartCount ||
      typeof part.etag !== "string" ||
      part.etag.trim().length === 0 ||
      normalized.has(part.partNumber)
    ) {
      throw new UploadSessionIntegrityError(
        "Stored multipart inventory does not match the Upload Session.",
      );
    }
    normalized.set(part.partNumber, part.etag);
  }
  return Array.from(normalized, ([partNumber, etag]) => ({
    partNumber,
    etag,
  })).sort((left, right) => left.partNumber - right.partNumber);
}

function normalizeUploadContentType(value: string | null) {
  if (!value) return null;
  const base = value.split(";", 1)[0]!.trim().toLowerCase();
  const normalized = base === "audio/x-wav" ? "audio/wav" : base;
  return uploadMimeTypes.includes(
    normalized as (typeof uploadMimeTypes)[number],
  )
    ? normalized
    : null;
}

function isAmbiguousProviderFailure(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const identity = [candidate.name, candidate.code]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const status = candidate.$metadata?.httpStatusCode;
  return (
    /timeout|timedout|network|connection|socket|requesttimeout/i.test(identity) ||
    (typeof status === "number" && (status === 408 || status === 429 || status >= 500))
  );
}

export function createUploadSessionModule(
  dependencies: UploadSessionModuleDependencies,
) {
  type ResolvedBrand = Awaited<
    ReturnType<UploadSessionAdmission["resolveBrand"]>
  >;
  const admissionPreflights = new Map<string, Promise<ResolvedBrand>>();
  const preflightInitialAdmission = (input: OpenUploadSessionInput) => {
    const key = `${input.workspaceId}:${input.clientIdempotencyKey}`;
    const existing = admissionPreflights.get(key);
    if (existing) return existing;
    const preflight = (async () => {
      await dependencies.admission.assertQuota(input.workspaceId);
      return dependencies.admission.resolveBrand({
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        legacyOwnerUserId: input.legacyOwnerUserId,
        brandTemplateId: input.brandTemplateId,
        brandProfileId: input.brandProfileId,
      });
    })();
    admissionPreflights.set(key, preflight);
    const release = () => {
      if (admissionPreflights.get(key) === preflight) {
        admissionPreflights.delete(key);
      }
    };
    void preflight.then(release, release);
    return preflight;
  };
  const diagnose = (
    sessionId: string,
    phase: Parameters<NonNullable<typeof dependencies.diagnose>>[0]["phase"],
    disposition: Parameters<
      NonNullable<typeof dependencies.diagnose>
    >[0]["disposition"],
    context: Omit<
      Parameters<NonNullable<typeof dependencies.diagnose>>[0],
      "sessionId" | "phase" | "disposition"
    > = {},
  ) => dependencies.diagnose?.({ sessionId, phase, disposition, ...context });

  const withReconciliationDeadline = async <Result>(
    operation: (signal?: AbortSignal) => Promise<Result>,
    timeoutMs = dependencies.config.reconciliationOperationDeadlineMs,
  ) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            const error = new Error("Upload Session provider operation timed out");
            error.name = "TimeoutError";
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const reconciliationRetryDelayMs = (attemptCount: number) => {
    const exponential = Math.min(
      dependencies.config.reconciliationBackoffCeilingMs,
      dependencies.config.reconciliationBackoffBaseMs *
        2 ** Math.max(0, attemptCount - 1),
    );
    return Math.max(
      1,
      Math.min(
        dependencies.config.reconciliationBackoffCeilingMs,
        Math.floor(
          exponential * (0.5 + (dependencies.random?.() ?? Math.random())),
        ),
      ),
    );
  };

  const markInlineReconciliation = async (
    session: UploadSessionRecord,
    failureCode: string,
  ): Promise<FinalizeUploadSessionOutcome> => {
    try {
      await dependencies.persistence.markReconciling({
        sessionId: session.id,
        failureCode,
        reconcileAt: new Date(dependencies.now().getTime() + 5_000),
        updatedAt: dependencies.now(),
      });
    } catch (error) {
      if (error instanceof UploadSessionReconciliationClaimLostError) {
        return settledInlineWinner(session);
      }
      throw error;
    }
    return {
      outcome: "reconciling",
      sessionId: session.id,
      retryAfterSeconds: 5,
    };
  };

  const settledInlineWinner = async (
    session: UploadSessionRecord,
  ): Promise<FinalizeUploadSessionOutcome> => {
    const latest = await dependencies.persistence.findByIdForWorkspace({
      sessionId: session.id,
      workspaceId: session.workspaceId,
    });
    if (!latest) throw new UploadSessionNotFoundError();
    return settledFinalizationOutcome(latest);
  };

  const failInlineFinalization = async (
    session: UploadSessionRecord,
    failureCode: string,
    message: string,
  ): Promise<FinalizeUploadSessionOutcome> => {
    try {
      await dependencies.persistence.recordFailure({
        sessionId: session.id,
        status: "failed",
        failureCode,
        updatedAt: dependencies.now(),
      });
    } catch (error) {
      if (error instanceof UploadSessionReconciliationClaimLostError) {
        return settledInlineWinner(session);
      }
      throw error;
    }
    throw new UploadSessionIntegrityError(message);
  };

  const compensateInlineMultipartFailure = async (
    session: UploadSessionRecord,
    failureCode: string,
    message: string,
  ): Promise<FinalizeUploadSessionOutcome> => {
    try {
      await dependencies.persistence.recordFailure({
        sessionId: session.id,
        status: "compensating",
        failureCode,
        updatedAt: dependencies.now(),
      });
      await withReconciliationDeadline((signal) =>
        dependencies.storage.abortMultipart({
          storageKey: session.storageKey,
          providerUploadId: session.providerUploadId!,
          signal,
        }),
      );
      await dependencies.persistence.recordFailure({
        sessionId: session.id,
        status: "failed",
        failureCode,
        cleanupRetryAt: null,
        updatedAt: dependencies.now(),
      });
    } catch (error) {
      if (error instanceof UploadSessionReconciliationClaimLostError) {
        return settledInlineWinner(session);
      }
      try {
        await dependencies.persistence.recordFailure({
          sessionId: session.id,
          status: "compensating",
          failureCode,
          cleanupRetryAt: new Date(dependencies.now().getTime() + 60_000),
          updatedAt: dependencies.now(),
        });
      } catch (settlementError) {
        if (
          settlementError instanceof UploadSessionReconciliationClaimLostError
        ) {
          return settledInlineWinner(session);
        }
        throw settlementError;
      }
    }
    throw new UploadSessionIntegrityError(message);
  };

  const handoffInline = async (
    session: UploadSessionRecord,
    object: { sizeBytes: number; contentType: string | null },
  ) => {
    try {
      return await handoffVerifiedObject(
        session,
        object,
        undefined,
        (operation) => withReconciliationDeadline(operation),
      );
    } catch (error) {
      if (error instanceof UploadSessionIntegrityError) throw error;
      if (error instanceof UploadSessionReconciliationClaimLostError) {
        return settledInlineWinner(session);
      }
      return markInlineReconciliation(session, "upload_handoff_ambiguous");
    }
  };

  const admissionAttemptIdFor = (session: UploadSessionRecord) => {
    if (!session.admissionAttemptId) {
      throw new UploadSessionAdmissionClaimLostError();
    }
    return session.admissionAttemptId;
  };

  async function failMalformedProviderIdentity(
    session: UploadSessionRecord,
    admissionAttemptId: string,
  ) {
    await dependencies.persistence.recordFailure({
      sessionId: session.id,
      admissionAttemptId,
      status: "failed",
      failureCode: "provider_identity_invalid",
      updatedAt: dependencies.now(),
    });
    diagnose(session.id, "provider_creation", "failed");
  }

  async function compensateObject(
    session: UploadSessionRecord,
    failureCode: string,
    runProviderOperation?: <Result>(
      operation: (signal?: AbortSignal) => Promise<Result>,
    ) => Promise<Result>,
  ) {
    diagnose(session.id, "compensation", "started");
    await dependencies.persistence.recordFailure({
      sessionId: session.id,
      status: "compensating",
      failureCode,
      updatedAt: dependencies.now(),
    });
    try {
      if (runProviderOperation) {
        await runProviderOperation((signal) =>
          dependencies.storage.deleteExactObject(session.storageKey, signal),
        );
      } else {
        await dependencies.storage.deleteExactObject(session.storageKey);
      }
      await dependencies.persistence.recordFailure({
        sessionId: session.id,
        status: "failed",
        failureCode,
        cleanupRetryAt: null,
        updatedAt: dependencies.now(),
      });
      diagnose(session.id, "compensation", "succeeded");
    } catch {
      await dependencies.persistence.recordFailure({
        sessionId: session.id,
        status: "compensating",
        failureCode,
        cleanupRetryAt: new Date(dependencies.now().getTime() + 60_000),
        updatedAt: dependencies.now(),
      });
      diagnose(session.id, "compensation", "failed");
    }
  }

  async function handoffVerifiedObject(
    session: UploadSessionRecord,
    object: { sizeBytes: number; contentType: string | null },
    reconciliationAttemptId?: string,
    runProviderOperation?: <Result>(
      operation: (signal?: AbortSignal) => Promise<Result>,
      operationChargesProviderCalls?: boolean,
    ) => Promise<Result>,
    onIntegrityCleanup?: () => void,
  ): Promise<QueuedUploadHandoffOutcome> {
    const compensateIntegrityFailure = async (failureCode: string) => {
      if (!reconciliationAttemptId) {
        await compensateObject(session, failureCode, runProviderOperation);
        return;
      }
      await dependencies.persistence.beginCompensation({
        sessionId: session.id,
        reconciliationAttemptId,
        failureCode,
        updatedAt: dependencies.now(),
      });
      onIntegrityCleanup?.();
      if (runProviderOperation) {
        await runProviderOperation((signal) =>
          dependencies.storage.deleteExactObject(session.storageKey, signal),
        );
      } else {
        await dependencies.storage.deleteExactObject(session.storageKey);
      }
      await dependencies.persistence.settleTerminal({
        sessionId: session.id,
        reconciliationAttemptId,
        status: "failed",
        failureCode,
        updatedAt: dependencies.now(),
      });
    };
    if (object.sizeBytes !== session.fileSizeBytes) {
      await compensateIntegrityFailure("upload_object_size_mismatch");
      throw new UploadSessionIntegrityError(
        "Uploaded object size does not match the declared source.",
      );
    }
    const declaredContentType = normalizeUploadContentType(session.contentType);
    const verifiedContentType = normalizeUploadContentType(object.contentType);
    if (
      !declaredContentType ||
      !verifiedContentType ||
      declaredContentType !== verifiedContentType
    ) {
      await compensateIntegrityFailure("upload_object_content_type_mismatch");
      throw new UploadSessionIntegrityError(
        "Uploaded object content type does not match the declared source.",
      );
    }
    const queued = await dependencies.persistence.handoff({
      sessionId: session.id,
      queuedJobId: dependencies.createId(),
      verifiedSizeBytes: object.sizeBytes,
      verifiedContentType,
      reconciliationAttemptId,
      updatedAt: dependencies.now(),
    });
    return {
      outcome: "queued_for_ingest",
      sessionId: queued.id,
      projectId: queued.preallocatedProjectId,
      queuedJobId: queued.queuedJobId!,
    };
  }

  function settledFinalizationOutcome(settled: UploadSessionRecord) {
    if (settled.status === "queued_for_ingest" && settled.queuedJobId) {
      return {
        outcome: "queued_for_ingest" as const,
        sessionId: settled.id,
        projectId: settled.preallocatedProjectId,
        queuedJobId: settled.queuedJobId,
      };
    }
    if (
      settled.status === "finalizing" ||
      settled.status === "reconciling"
    ) {
      return {
        outcome: "reconciling" as const,
        sessionId: settled.id,
        retryAfterSeconds: 5,
      };
    }
    throw new UploadSessionInvalidStateError(
      `Upload Session finalization settled as ${settled.status}.`,
    );
  }

  const expireTransfer = async (session: UploadSessionRecord, expiredAt: Date) => {
    const expired = await dependencies.persistence.expireTransfer({
      sessionId: session.id,
      expiredAt,
    });
    throw new UploadSessionInvalidStateError(
      expired.status === "compensating"
        ? "The Upload Session has expired and is being cleaned up."
        : `Upload Session is ${expired.status}.`,
    );
  };

  const assertTransferActive = async (session: UploadSessionRecord) => {
    const activityAt = dependencies.now();
    if (
      session.expiresAt.getTime() <= activityAt.getTime() ||
      session.hardExpiresAt.getTime() <= activityAt.getTime()
    ) {
      return expireTransfer(session, activityAt);
    }
    try {
      return await dependencies.persistence.renewTransferActivity({
        sessionId: session.id,
        expiresAt: new Date(
          Math.min(
            activityAt.getTime() + dependencies.config.sessionIdleMs,
            session.hardExpiresAt.getTime(),
          ),
        ),
        updatedAt: activityAt,
      });
    } catch (error) {
      if (error instanceof UploadSessionInvalidStateError) {
        return expireTransfer(session, dependencies.now());
      }
      throw error;
    }
  };

  async function cleanupMultipartDuplicates(
    session: UploadSessionRecord,
    knownCandidates?: Array<{
      providerUploadId: string;
      initiatedAt: Date | null;
    }>,
    runProviderOperation: <Result>(
      operation: (signal?: AbortSignal) => Promise<Result>,
      operationChargesProviderCalls?: boolean,
    ) => Promise<Result> =
      (operation) => operation(),
    reconciliationAttemptId?: string,
    onProviderCall?: () => void,
  ) {
    if (!session.providerUploadId) {
      throw new Error("Upload Session provider binding is incomplete");
    }
    const candidates =
      knownCandidates ??
      (await runProviderOperation((signal) =>
        dependencies.storage.listExactKeyMultipartUploads(
          session.storageKey,
          signal,
          onProviderCall,
        ),
        Boolean(onProviderCall),
      ));
    const losingProviderIds = new Set(
      candidates
        .map((candidate) => candidate.providerUploadId)
        .filter((providerUploadId) => providerUploadId !== session.providerUploadId),
    );
    let cleanupFailed = false;
    for (const providerUploadId of losingProviderIds) {
      try {
        await runProviderOperation((signal) =>
          dependencies.storage.abortMultipart({
            storageKey: session.storageKey,
            providerUploadId,
            signal,
          }),
        );
        diagnose(session.id, "duplicate_abort", "succeeded");
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      await dependencies.persistence.recordCleanupRetry({
        sessionId: session.id,
        failureCode: "duplicate_upload_cleanup_failed",
        cleanupRetryAt: new Date(dependencies.now().getTime() + 60_000),
        reconciliationAttemptId,
        updatedAt: dependencies.now(),
      });
      diagnose(session.id, "duplicate_abort", "failed");
      throw new UploadSessionInvalidStateError(
        "Upload Session storage cleanup must be retried.",
      );
    }
    if (session.cleanupRetryAt || losingProviderIds.size > 0) {
      await dependencies.persistence.recordCleanupRetry({
        sessionId: session.id,
        failureCode: null,
        cleanupRetryAt: null,
        reconciliationAttemptId,
        updatedAt: dependencies.now(),
      });
    }
  }

  async function convergeAfterLostAdmissionClaim(
    session: UploadSessionRecord,
  ) {
    const settled = await dependencies.persistence.waitForAdmission(session.id);
    if (
      settled.status !== "uploading" ||
      settled.transferKind !== "multipart" ||
      !settled.providerUploadId
    ) {
      throw new UploadSessionInvalidStateError(
        "Upload Session admission is still in progress.",
      );
    }
    return settled;
  }
  async function uploadingOutcome(
    session: UploadSessionRecord,
    knownCompletedParts?: Array<{ partNumber: number; etag: string }>,
  ): Promise<OpenUploadSessionOutcome> {
    let activeSession = await assertTransferActive(session);
    if (session.transferKind === "single") {
      const grant = await dependencies.storage.grantSinglePut({
        storageKey: activeSession.storageKey,
        contentType: activeSession.contentType,
        expiresInSeconds: dependencies.config.uploadGrantTtlSeconds,
      });
      return {
        outcome: "uploading",
        sessionId: session.id,
        projectId: session.preallocatedProjectId,
        expiresAt: activeSession.expiresAt.toISOString(),
        transfer: {
          kind: "single",
          contentType: activeSession.contentType,
          grant: { url: grant.url, contentType: activeSession.contentType },
        },
      };
    }
    if (!activeSession.providerUploadId) {
      throw new Error("Upload Session provider binding is incomplete");
    }
    const completedParts = normalizeProviderPartInventory(
      knownCompletedParts ??
        (await dependencies.storage.listMultipartParts({
          storageKey: session.storageKey,
          providerUploadId: activeSession.providerUploadId,
        })),
      session.partCount,
    );
    const completedPartNumbers = new Set(
      completedParts.map((part) => part.partNumber),
    );
    const partNumbers = Array.from(
      { length: session.partCount },
      (_, index) => index + 1,
    ).filter((partNumber) => !completedPartNumbers.has(partNumber));
    const grantPartNumbers = partNumbers.slice(
      0,
      dependencies.config.maximumGrantParts,
    );
    activeSession = await assertTransferActive(activeSession);
    const grants = await dependencies.storage.grantMultipartParts({
      storageKey: activeSession.storageKey,
      providerUploadId: activeSession.providerUploadId!,
      partNumbers: grantPartNumbers,
      expiresInSeconds: dependencies.config.uploadGrantTtlSeconds,
    });
    const grantExpiresAt = new Date(
      dependencies.now().getTime() +
        dependencies.config.uploadGrantTtlSeconds * 1_000,
    ).toISOString();
    return {
      outcome: "uploading",
      sessionId: session.id,
      projectId: session.preallocatedProjectId,
      expiresAt: activeSession.expiresAt.toISOString(),
      transfer: {
        kind: "multipart",
        partSizeBytes: session.partSizeBytes!,
        partCount: session.partCount,
        concurrency: dependencies.config.multipartConcurrency,
        grants,
        grantExpiresAt,
        completedParts,
      },
    };
  }

  async function recoverInitiatingSession(
    session: UploadSessionRecord,
    runProviderOperation: <Result>(
      operation: (signal?: AbortSignal) => Promise<Result>,
      operationChargesProviderCalls?: boolean,
    ) => Promise<Result> =
      (operation) => operation(),
    reconciliationAttemptId?: string,
    onProviderCall?: () => void,
  ) {
    let prepared = session;
    const admissionAttemptId = admissionAttemptIdFor(prepared);
    if (!prepared.admissionPreparedAt) {
      try {
        await dependencies.admission.assertQuota(prepared.workspaceId);
        prepared = await dependencies.persistence.prepareAdmission({
          sessionId: prepared.id,
          admissionAttemptId,
          brandTemplateId: prepared.brandTemplateId,
          brandSnapshot: prepared.brandSnapshot,
          brandProfileId: prepared.brandProfileId,
          brandProfileSnapshot: prepared.brandProfileSnapshot,
          updatedAt: dependencies.now(),
        });
      } catch (error) {
        if (error instanceof UploadSessionAdmissionClaimLostError) {
          throw new UploadSessionInvalidStateError(
            "Upload Session admission was superseded.",
          );
        }
        await dependencies.persistence.recordFailure({
          sessionId: prepared.id,
          admissionAttemptId,
          status: "failed",
          failureCode:
            error instanceof UploadSessionQuotaRefusedError
              ? "quota_exceeded"
              : "upload_admission_failed",
          updatedAt: dependencies.now(),
        });
        throw error;
      }
    }
    if (prepared.transferKind === "single") {
      return dependencies.persistence.markSingleReady({
        sessionId: prepared.id,
        admissionAttemptId,
        updatedAt: dependencies.now(),
      });
    }
    let candidates: Array<{
      providerUploadId: string;
      initiatedAt: Date | null;
    }>;
    try {
      candidates = await runProviderOperation((signal) =>
        dependencies.storage.listExactKeyMultipartUploads(
          prepared.storageKey,
          signal,
          onProviderCall,
        ),
        Boolean(onProviderCall),
      );
    } catch (error) {
      if (error instanceof UploadSessionProviderIdentityError) {
        await failMalformedProviderIdentity(prepared, admissionAttemptId);
      }
      throw error;
    }
    try {
      for (const candidate of candidates) {
        assertOpaqueProviderIdentity(candidate.providerUploadId);
      }
    } catch (error) {
      if (error instanceof UploadSessionProviderIdentityError) {
        await failMalformedProviderIdentity(prepared, admissionAttemptId);
      }
      throw error;
    }
    const ordered = candidates.slice().sort((left, right) => {
      const time =
        (left.initiatedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (right.initiatedAt?.getTime() ?? Number.MAX_SAFE_INTEGER);
      return time || left.providerUploadId.localeCompare(right.providerUploadId);
    });
    let adopted = ordered[0];
    if (!adopted) {
      diagnose(prepared.id, "provider_creation", "started");
      const created = await runProviderOperation((signal) =>
        dependencies.storage.createMultipart({
          storageKey: prepared.storageKey,
          contentType: prepared.contentType,
          metadata: {
            upload_session_id: prepared.id,
            file_name: prepared.fileName,
          },
          signal,
        }),
      );
      try {
        adopted = {
          providerUploadId: assertOpaqueProviderIdentity(
            created.providerUploadId,
          ),
          initiatedAt: dependencies.now(),
        };
      } catch (error) {
        if (error instanceof UploadSessionProviderIdentityError) {
          await failMalformedProviderIdentity(prepared, admissionAttemptId);
        }
        throw error;
      }
      diagnose(prepared.id, "provider_creation", "succeeded");
    } else {
      assertOpaqueProviderIdentity(adopted.providerUploadId);
      diagnose(prepared.id, "adoption", "succeeded");
    }
    diagnose(prepared.id, "provider_bind", "started");
    let bound: UploadSessionRecord;
    try {
      bound = await dependencies.persistence.bindMultipartProvider({
        sessionId: prepared.id,
        admissionAttemptId,
        providerUploadId: adopted.providerUploadId,
        updatedAt: dependencies.now(),
      });
    } catch (error) {
      if (error instanceof UploadSessionAdmissionClaimLostError) {
        bound = await convergeAfterLostAdmissionClaim(prepared);
      } else {
      await dependencies.persistence
        .releaseAdmissionClaim({
          sessionId: prepared.id,
          admissionAttemptId,
          updatedAt: dependencies.now(),
        })
        .catch(() => {});
      diagnose(prepared.id, "provider_bind", "failed");
      throw error;
      }
    }
    diagnose(prepared.id, "provider_bind", "succeeded");
    await cleanupMultipartDuplicates(
      bound,
      [
        ...ordered,
        ...(ordered.some(
          (candidate) => candidate.providerUploadId === adopted.providerUploadId,
        )
          ? []
          : [adopted]),
      ],
      runProviderOperation,
      reconciliationAttemptId,
      onProviderCall,
    );
    return bound;
  }

  return {
    async open(input: OpenUploadSessionInput): Promise<OpenUploadSessionOutcome> {
      const fingerprint = immutableInputFingerprint(input);
      const resumeExisting = async (existing: UploadSessionRecord) => {
        if (existing.actorUserId !== input.actorUserId) {
          throw new UploadSessionNotFoundError();
        }
        if (existing.immutableInputFingerprint !== fingerprint) {
          throw new UploadSessionIdempotencyConflictError();
        }
        if (existing.status === "queued_for_ingest" && existing.queuedJobId) {
          return {
            outcome: "queued_for_ingest" as const,
            sessionId: existing.id,
            projectId: existing.preallocatedProjectId,
            queuedJobId: existing.queuedJobId,
          };
        }
        if (
          existing.status === "finalizing" ||
          existing.status === "reconciling"
        ) {
          return {
            outcome: "reconciling" as const,
            sessionId: existing.id,
            projectId: existing.preallocatedProjectId,
            retryAfterSeconds: Math.max(
              1,
              Math.ceil(
                ((existing.reconcileAt?.getTime() ??
                  dependencies.now().getTime() + 5_000) -
                  dependencies.now().getTime()) /
                  1_000,
              ),
            ),
          };
        }
        let settled = existing;
        const admissionClaimIsLive =
          settled.status === "initiating" &&
          settled.admissionClaimExpiresAt &&
          settled.admissionClaimExpiresAt.getTime() >
            dependencies.now().getTime();
        if (admissionClaimIsLive) {
          settled = await dependencies.persistence.waitForAdmission(settled.id);
        }
        let active = settled;
        if (settled.status === "initiating") {
          const claimStartedAt = dependencies.now();
          const claim = await dependencies.persistence.claimAdmission({
            sessionId: settled.id,
            admissionAttemptId: dependencies.createId(),
            claimExpiresAt: new Date(claimStartedAt.getTime() + 30_000),
            updatedAt: claimStartedAt,
          });
          if (claim.claimed) {
            active = await recoverInitiatingSession(claim.session);
          } else {
            active = await dependencies.persistence.waitForAdmission(
              settled.id,
            );
            if (active.status === "initiating") {
              throw new UploadSessionInvalidStateError(
                "Upload Session admission is still in progress.",
              );
            }
          }
        }
        if (active.status !== "uploading") {
          throw new UploadSessionInvalidStateError(
            `Upload Session is ${active.status}.`,
          );
        }
        const activityAt = dependencies.now();
        if (
          active.expiresAt.getTime() <= activityAt.getTime() ||
          active.hardExpiresAt.getTime() <= activityAt.getTime()
        ) {
          return expireTransfer(active, activityAt);
        }
        if (active.transferKind === "multipart" && active.cleanupRetryAt) {
          await cleanupMultipartDuplicates(active);
        }
        if (active.transferKind === "single") {
          const object = await dependencies.storage.headExactObjectIfExists(
            active.storageKey,
          );
          if (object) {
            const finalization =
              await dependencies.persistence.beginFinalization({
                sessionId: active.id,
                parts: [],
                reconcileAt: new Date(dependencies.now().getTime() + 5_000),
                updatedAt: dependencies.now(),
              });
            if (!finalization.claimed) {
              const handoff = settledFinalizationOutcome(finalization.session);
              return handoff.outcome === "reconciling"
                ? { ...handoff, projectId: active.preallocatedProjectId }
                : handoff;
            }
            const handoff = await handoffInline(finalization.session, object);
            return handoff.outcome === "reconciling"
              ? { ...handoff, projectId: active.preallocatedProjectId }
              : handoff;
          }
        }
        return uploadingOutcome(active);
      };
      const existing = await dependencies.persistence.findByClientKey({
        workspaceId: input.workspaceId,
        clientIdempotencyKey: input.clientIdempotencyKey,
      });
      if (existing) {
        diagnose(existing.id, "reservation", "succeeded", {
          state: existing.status,
          replay: true,
        });
        return resumeExisting(existing);
      }

      const now = dependencies.now();
      const sessionId = dependencies.createId();
      const projectId = dependencies.createId();
      const transfer = planUploadTransfer(
        input.source.sizeBytes,
        dependencies.config,
      );
      const storageKey = `workspaces/${input.workspaceId}/upload-sessions/${sessionId}/${sanitizeFileName(input.source.fileName)}`;
      const reservationRecord = (brand: ResolvedBrand): UploadSessionRecord => ({
        id: sessionId,
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        legacyOwnerUserId: input.legacyOwnerUserId,
        clientIdempotencyKey: input.clientIdempotencyKey,
        immutableInputFingerprint: fingerprint,
        preallocatedProjectId: projectId,
        title: input.title,
        fileName: input.source.fileName,
        fileSizeBytes: input.source.sizeBytes,
        contentType: input.source.contentType,
        browserFingerprint: input.source.browserFingerprint,
        brandTemplateId: brand?.templateId ?? null,
        brandSnapshot: brand?.snapshot ?? null,
        brandProfileId: brand?.profileId ?? null,
        brandProfileSnapshot: brand?.profileSnapshot ?? null,
        generation: input.generation,
        transferKind: transfer.kind,
        partSizeBytes: transfer.partSizeBytes,
        partCount: transfer.partCount,
        storageKey,
        providerUploadId: null,
        admissionAttemptId: dependencies.createId(),
        admissionClaimExpiresAt: new Date(now.getTime() + 30_000),
        admissionPreparedAt: null,
        completionParts: null,
        completionIntentMalformed: false,
        queuedJobId: null,
        failureCode: null,
        cleanupRetryAt: null,
        reconcileAt: null,
        reconciliationAttemptId: null,
        reconciliationLeaseExpiresAt: null,
        reconciliationAttemptCount: 0,
        status: "initiating",
        expiresAt: new Date(now.getTime() + dependencies.config.sessionIdleMs),
        hardExpiresAt: new Date(
          now.getTime() + dependencies.config.sessionHardLifetimeMs,
        ),
        createdAt: now,
        updatedAt: now,
      });
      if (!normalizeUploadContentType(input.source.contentType)) {
        const invalid = await dependencies.persistence.reserve(
          reservationRecord(null),
        );
        if (invalid.created) {
          await dependencies.persistence.recordFailure({
            sessionId: invalid.session.id,
            admissionAttemptId: admissionAttemptIdFor(invalid.session),
            status: "failed",
            failureCode: "unsupported_media_type",
            updatedAt: dependencies.now(),
          });
        }
        throw new Error("Unsupported upload content type");
      }

      let brand: ResolvedBrand;
      try {
        brand = await preflightInitialAdmission(input);
      } catch (error) {
        const refused = await dependencies.persistence.reserve(
          reservationRecord(null),
        );
        if (refused.created) {
          await dependencies.persistence.recordFailure({
            sessionId: refused.session.id,
            admissionAttemptId: admissionAttemptIdFor(refused.session),
            status: "failed",
            failureCode:
              error instanceof UploadSessionQuotaRefusedError
                ? "quota_exceeded"
                : "upload_admission_failed",
            updatedAt: dependencies.now(),
          });
        }
        throw error;
      }

      const reservation = await dependencies.persistence.reserve(
        reservationRecord(brand),
      );
      if (!reservation.created) {
        diagnose(reservation.session.id, "reservation", "succeeded", {
          state: reservation.session.status,
          replay: true,
        });
        return resumeExisting(reservation.session);
      }
      diagnose(reservation.session.id, "reservation", "succeeded", {
        state: reservation.session.status,
        replay: false,
      });

      let prepared: UploadSessionRecord;
      const admissionAttemptId = admissionAttemptIdFor(reservation.session);
      try {
        prepared = await dependencies.persistence.prepareAdmission({
          sessionId: reservation.session.id,
          admissionAttemptId,
          brandTemplateId: reservation.session.brandTemplateId,
          brandSnapshot: reservation.session.brandSnapshot,
          brandProfileId: reservation.session.brandProfileId,
          brandProfileSnapshot: reservation.session.brandProfileSnapshot,
          updatedAt: dependencies.now(),
        });
      } catch (error) {
        if (error instanceof UploadSessionAdmissionClaimLostError) {
          throw new UploadSessionInvalidStateError(
            "Upload Session admission was superseded.",
          );
        }
        await dependencies.persistence.recordFailure({
          sessionId: reservation.session.id,
          admissionAttemptId,
          status: "failed",
          failureCode: "upload_admission_failed",
          updatedAt: dependencies.now(),
        });
        throw error;
      }

      if (prepared.transferKind === "single") {
        const session = await dependencies.persistence.markSingleReady({
          sessionId: prepared.id,
          admissionAttemptId,
          updatedAt: dependencies.now(),
        });
        return uploadingOutcome(session, []);
      }

      diagnose(prepared.id, "provider_creation", "started");
      let provider: { providerUploadId: string };
      try {
        provider = await dependencies.storage.createMultipart({
          storageKey: prepared.storageKey,
          contentType: prepared.contentType,
          metadata: {
            upload_session_id: prepared.id,
            file_name: prepared.fileName,
          },
        });
        assertOpaqueProviderIdentity(provider.providerUploadId);
        diagnose(prepared.id, "provider_creation", "succeeded");
      } catch (error) {
        diagnose(prepared.id, "provider_creation", "failed");
        if (error instanceof UploadSessionProviderIdentityError) {
          await failMalformedProviderIdentity(prepared, admissionAttemptId);
          throw error;
        }
        try {
          const candidates =
            await dependencies.storage.listExactKeyMultipartUploads(
              prepared.storageKey,
            );
          if (candidates.length > 0) {
            const recovered = await recoverInitiatingSession(prepared);
            return uploadingOutcome(recovered);
          }
          await dependencies.persistence.recordFailure({
            sessionId: prepared.id,
            admissionAttemptId,
            status: "failed",
            failureCode: "provider_creation_failed",
            updatedAt: dependencies.now(),
          });
        } catch {
          // Discovery failure is ambiguous: retain the durable initiating row
          // so the exact-key recovery path can safely retry later.
          await dependencies.persistence
            .releaseAdmissionClaim({
              sessionId: prepared.id,
              admissionAttemptId,
              updatedAt: dependencies.now(),
            })
            .catch(() => {});
        }
        throw error;
      }
      diagnose(prepared.id, "provider_bind", "started");
      let session: UploadSessionRecord;
      try {
        session = await dependencies.persistence.bindMultipartProvider({
          sessionId: prepared.id,
          admissionAttemptId,
          providerUploadId: provider.providerUploadId,
          updatedAt: dependencies.now(),
        });
      } catch (error) {
        if (error instanceof UploadSessionAdmissionClaimLostError) {
          session = await convergeAfterLostAdmissionClaim(prepared);
        } else {
        await dependencies.persistence
          .releaseAdmissionClaim({
            sessionId: prepared.id,
            admissionAttemptId,
            updatedAt: dependencies.now(),
          })
          .catch(() => {});
        diagnose(prepared.id, "provider_bind", "failed");
        throw error;
        }
      }
      diagnose(prepared.id, "provider_bind", "succeeded");
      if (session.providerUploadId !== provider.providerUploadId) {
        await cleanupMultipartDuplicates(session, [
          {
            providerUploadId: provider.providerUploadId,
            initiatedAt: dependencies.now(),
          },
        ]);
      }
      return uploadingOutcome(session, []);
    },

    async status(
      input: ReadUploadSessionInput,
    ): Promise<ReadUploadSessionOutcome> {
      let session = await dependencies.persistence.findByClientKey({
        workspaceId: input.workspaceId,
        clientIdempotencyKey: input.clientIdempotencyKey,
      });
      if (
        !session ||
        session.actorUserId !== input.actorUserId ||
        (input.sessionId !== null && session.id !== input.sessionId) ||
        session.browserFingerprint !== input.browserFingerprint
      ) {
        throw new UploadSessionNotFoundError();
      }
      if (session.status === "queued_for_ingest" && session.queuedJobId) {
        return {
          outcome: "queued_for_ingest",
          sessionId: session.id,
          projectId: session.preallocatedProjectId,
          queuedJobId: session.queuedJobId,
        };
      }
      if (
        session.status === "finalizing" ||
        session.status === "reconciling" ||
        session.status === "compensating"
      ) {
        return {
          outcome: "reconciling",
          sessionId: session.id,
          projectId: session.preallocatedProjectId,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(
              ((session.reconcileAt?.getTime() ??
                dependencies.now().getTime() + 5_000) -
                dependencies.now().getTime()) /
                1_000,
            ),
          ),
        };
      }
      if (session.status !== "uploading") {
        if (
          session.status === "aborted" ||
          session.status === "expired" ||
          session.status === "failed"
        ) {
          return {
            outcome: "terminal",
            sessionId: session.id,
            state: session.status,
            failureCode: session.failureCode,
            freshUploadAllowed: terminalFreshUploadAllowed(session),
          };
        }
        throw new UploadSessionInvalidStateError(`Upload Session is ${session.status}.`);
      }
      const activityAt = dependencies.now();
      if (
        session.expiresAt.getTime() <= activityAt.getTime() ||
        session.hardExpiresAt.getTime() <= activityAt.getTime()
      ) {
        session = await dependencies.persistence.expireTransfer({
          sessionId: session.id,
          expiredAt: activityAt,
        });
        if (session.status === "compensating") {
          return {
            outcome: "reconciling",
            sessionId: session.id,
            projectId: session.preallocatedProjectId,
            retryAfterSeconds: 1,
          };
        }
        if (session.status === "expired") {
          return {
            outcome: "terminal",
            sessionId: session.id,
            state: "expired",
            failureCode: session.failureCode,
            freshUploadAllowed: true,
          };
        }
        throw new UploadSessionInvalidStateError(
          `Upload Session is ${session.status}.`,
        );
      }
      return uploadingOutcome(session);
    },

    async discard(
      input: DiscardUploadSessionInput,
    ): Promise<DiscardUploadSessionOutcome> {
      const current = await dependencies.persistence.findByIdForWorkspace({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
      });
      if (!current || current.actorUserId !== input.actorUserId) {
        throw new UploadSessionNotFoundError();
      }
      if (current.status === "aborted" && current.failureCode === "user_discarded") {
        return { outcome: "discarded", sessionId: current.id };
      }
      if (
        current.status === "compensating" &&
        current.failureCode === "user_discarded"
      ) {
        return {
          outcome: "compensating",
          sessionId: current.id,
          retryAfterSeconds: 5,
        };
      }
      if (current.status !== "uploading") {
        throw new UploadSessionInvalidStateError(
          "This Upload Session can no longer be discarded.",
        );
      }

      const startedAt = dependencies.now();
      const reconciliationAttemptId = dependencies.createId();
      const claim = await dependencies.persistence.beginDiscard({
        sessionId: current.id,
        reconciliationAttemptId,
        leaseExpiresAt: new Date(
          startedAt.getTime() + dependencies.config.reconciliationLeaseMs,
        ),
        updatedAt: startedAt,
      });
      if (!claim.claimed) {
        if (
          claim.session.status === "aborted" &&
          claim.session.failureCode === "user_discarded"
        ) {
          return { outcome: "discarded", sessionId: claim.session.id };
        }
        if (
          claim.session.status === "compensating" &&
          claim.session.failureCode === "user_discarded"
        ) {
          return {
            outcome: "compensating",
            sessionId: claim.session.id,
            retryAfterSeconds: 5,
          };
        }
        throw new UploadSessionInvalidStateError(
          "This Upload Session can no longer be discarded.",
        );
      }

      diagnose(current.id, "compensation", "started", {
        state: "compensating",
        declaredAbandonedBytes: current.fileSizeBytes,
        declaredAbandonedAgeMs: Math.max(
          0,
          startedAt.getTime() - current.updatedAt.getTime(),
        ),
      });
      try {
        if (claim.session.transferKind === "multipart") {
          if (!claim.session.providerUploadId) {
            throw new Error("Upload Session provider binding is incomplete");
          }
          await withReconciliationDeadline((signal) =>
            dependencies.storage.abortMultipart({
              storageKey: claim.session.storageKey,
              providerUploadId: claim.session.providerUploadId!,
              signal,
            }),
          );
        } else {
          await withReconciliationDeadline((signal) =>
            dependencies.storage.deleteExactObject(
              claim.session.storageKey,
              signal,
            ),
          );
        }
        await dependencies.persistence.settleTerminal({
          sessionId: claim.session.id,
          reconciliationAttemptId,
          status: "aborted",
          failureCode: "user_discarded",
          updatedAt: dependencies.now(),
        });
        diagnose(current.id, "compensation", "succeeded", {
          state: "aborted",
          declaredAbandonedBytes: current.fileSizeBytes,
          declaredAbandonedAgeMs: Math.max(
            0,
            dependencies.now().getTime() - current.updatedAt.getTime(),
          ),
        });
        return { outcome: "discarded", sessionId: current.id };
      } catch (error) {
        if (error instanceof UploadSessionReconciliationClaimLostError) {
          const winner = await dependencies.persistence.findByIdForWorkspace({
            sessionId: current.id,
            workspaceId: current.workspaceId,
          });
          if (
            winner?.status === "aborted" &&
            winner.failureCode === "user_discarded"
          ) {
            return { outcome: "discarded", sessionId: current.id };
          }
          throw new UploadSessionInvalidStateError(
            "This Upload Session can no longer be discarded.",
          );
        }
        await dependencies.persistence.deferReconciliation({
          sessionId: claim.session.id,
          reconciliationAttemptId,
          failureCode: "user_discarded",
          reconcileAt: new Date(dependencies.now().getTime() + 5_000),
          updatedAt: dependencies.now(),
        });
        diagnose(current.id, "compensation", "failed", {
          state: "compensating",
          failureCode: "upload_cleanup_retry_scheduled",
          declaredAbandonedBytes: current.fileSizeBytes,
          declaredAbandonedAgeMs: Math.max(
            0,
            dependencies.now().getTime() - current.updatedAt.getTime(),
          ),
        });
        return {
          outcome: "compensating",
          sessionId: current.id,
          retryAfterSeconds: 5,
        };
      }
    },

    async grant(input: GrantUploadPartsInput): Promise<GrantUploadPartsOutcome> {
      const session = await dependencies.persistence.findByIdForWorkspace({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
      });
      if (!session || session.actorUserId !== input.actorUserId) {
        throw new UploadSessionNotFoundError();
      }
      if (
        session.status !== "uploading" ||
        session.transferKind !== "multipart" ||
        !session.providerUploadId
      ) {
        throw new UploadSessionInvalidStateError();
      }
      const activityAt = dependencies.now();
      if (
        session.expiresAt.getTime() <= activityAt.getTime() ||
        session.hardExpiresAt.getTime() <= activityAt.getTime()
      ) {
        return expireTransfer(session, activityAt);
      }
      const uniquePartNumbers = new Set(input.partNumbers);
      if (
        input.partNumbers.length < 1 ||
        input.partNumbers.length > dependencies.config.maximumGrantParts ||
        uniquePartNumbers.size !== input.partNumbers.length ||
        input.partNumbers.some(
          (partNumber) =>
            !Number.isInteger(partNumber) ||
            partNumber < 1 ||
            partNumber > session.partCount,
        )
      ) {
        throw new UploadSessionInvalidStateError(
          "Requested upload parts are outside the session transfer plan.",
        );
      }
      let activeSession: UploadSessionRecord;
      try {
        activeSession = await dependencies.persistence.renewTransferActivity({
          sessionId: session.id,
          expiresAt: new Date(
            Math.min(
              activityAt.getTime() + dependencies.config.sessionIdleMs,
              session.hardExpiresAt.getTime(),
            ),
          ),
          updatedAt: activityAt,
        });
      } catch (error) {
        if (error instanceof UploadSessionInvalidStateError) {
          return expireTransfer(session, dependencies.now());
        }
        throw error;
      }
      const grants = await dependencies.storage.grantMultipartParts({
        storageKey: activeSession.storageKey,
        providerUploadId: activeSession.providerUploadId!,
        partNumbers: input.partNumbers,
        expiresInSeconds: dependencies.config.uploadGrantTtlSeconds,
      });
      return {
        outcome: "granted",
        sessionId: session.id,
        expiresAt: new Date(
          dependencies.now().getTime() +
            dependencies.config.uploadGrantTtlSeconds * 1_000,
        ).toISOString(),
        grants,
      };
    },

    async finalize(
      input: FinalizeUploadSessionInput,
    ): Promise<FinalizeUploadSessionOutcome> {
      const current = await dependencies.persistence.findByIdForWorkspace({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
      });
      if (!current || current.actorUserId !== input.actorUserId) {
        throw new UploadSessionNotFoundError();
      }
      if (current.status === "queued_for_ingest" && current.queuedJobId) {
        return {
          outcome: "queued_for_ingest",
          sessionId: current.id,
          projectId: current.preallocatedProjectId,
          queuedJobId: current.queuedJobId,
        };
      }
      if (current.status === "finalizing") {
        return settledFinalizationOutcome(current);
      }
      if (current.status === "reconciling") {
        return {
          outcome: "reconciling",
          sessionId: current.id,
          retryAfterSeconds: 5,
        };
      }
      if (current.status !== "uploading") {
        throw new UploadSessionInvalidStateError();
      }
      const finalizationAcceptedAt = dependencies.now();
      if (
        current.expiresAt.getTime() <= finalizationAcceptedAt.getTime() ||
        current.hardExpiresAt.getTime() <= finalizationAcceptedAt.getTime()
      ) {
        return expireTransfer(current, finalizationAcceptedAt);
      }
      const parts =
        current.transferKind === "single"
          ? input.parts.length === 0
            ? []
            : null
          : normalizeCompletionParts(input.parts, current.partCount);
      if (!parts) {
        throw new UploadSessionInvalidStateError(
          "Uploaded part set does not match the Upload Session.",
        );
      }
      const finalization = await dependencies.persistence.beginFinalization({
        sessionId: current.id,
        parts,
        reconcileAt: new Date(finalizationAcceptedAt.getTime() + 5_000),
        updatedAt: finalizationAcceptedAt,
      });
      if (!finalization.claimed) {
        if (
          finalization.session.status === "uploading" &&
          (finalization.session.expiresAt.getTime() <=
            finalizationAcceptedAt.getTime() ||
            finalization.session.hardExpiresAt.getTime() <=
              finalizationAcceptedAt.getTime())
        ) {
          return expireTransfer(finalization.session, finalizationAcceptedAt);
        }
        return settledFinalizationOutcome(finalization.session);
      }
      const finalizing = finalization.session;
      if (finalizing.transferKind === "multipart") {
        if (!finalizing.providerUploadId) {
          throw new Error("Upload Session provider binding is incomplete");
        }
        try {
          await withReconciliationDeadline((signal) =>
            dependencies.storage.completeMultipart({
              storageKey: finalizing.storageKey,
              providerUploadId: finalizing.providerUploadId!,
              parts,
              signal,
            }),
          );
        } catch (error) {
          if (isAmbiguousProviderFailure(error)) {
            return markInlineReconciliation(
              finalizing,
              "multipart_completion_ambiguous",
            );
          }
          if (isMissingMultipartUpload(error)) {
            let exactObject: {
              sizeBytes: number;
              contentType: string | null;
            } | null;
            try {
              exactObject = await withReconciliationDeadline((signal) =>
                dependencies.storage.headExactObjectIfExists(
                  finalizing.storageKey,
                  signal,
                ),
              );
            } catch (probeError) {
              if (
                !(probeError instanceof UploadSessionStorageProbeError) ||
                probeError.disposition === "unavailable"
              ) {
                return markInlineReconciliation(
                  finalizing,
                  "upload_object_probe_unavailable",
                );
              }
              const failureCode =
                probeError.disposition === "access_denied"
                  ? "upload_object_access_denied"
                  : "upload_object_metadata_invalid";
              return failInlineFinalization(
                finalizing,
                failureCode,
                "Uploaded object could not be verified.",
              );
            }
            if (exactObject) {
              return handoffInline(finalizing, exactObject);
            }
            return markInlineReconciliation(
              finalizing,
              "multipart_upload_missing",
            );
          }
          const failureCode = permanentMultipartCompletionFailure(error);
          if (failureCode) {
            if (failureCode === "multipart_completion_invalid_parts") {
              return compensateInlineMultipartFailure(
                finalizing,
                failureCode,
                "The storage provider rejected multipart completion.",
              );
            }
            return failInlineFinalization(
              finalizing,
              failureCode,
              "The storage provider rejected multipart completion.",
            );
          }
          throw error;
        }
      }
      let object: { sizeBytes: number; contentType: string | null };
      try {
        object = await withReconciliationDeadline((signal) =>
          dependencies.storage.headExactObject(finalizing.storageKey, signal),
        );
      } catch (error) {
        const failureCode =
          error instanceof UploadSessionStorageProbeError
            ? {
                missing: "upload_object_missing",
                access_denied: "upload_object_access_denied",
                invalid_metadata: "upload_object_metadata_invalid",
                unavailable: "upload_object_probe_unavailable",
              }[error.disposition]
            : "upload_object_probe_unavailable";
        if (
          !(error instanceof UploadSessionStorageProbeError) ||
          error.disposition === "missing" ||
          error.disposition === "unavailable"
        ) {
          return markInlineReconciliation(finalizing, failureCode);
        }
        return failInlineFinalization(
          finalizing,
          failureCode,
          "Uploaded object could not be verified.",
        );
      }
      return handoffInline(finalizing, object);
    },

    async reconcileDueSessions() {
      const selectionNow = dependencies.now();
      const due = await dependencies.persistence.findDueReconciliation({
        now: selectionNow,
        limit: dependencies.config.reconciliationBatchSize,
      });
      let claimed = 0;
      let settled = 0;
      let deferred = 0;
      const processCandidate = async (candidate: UploadSessionRecord) => {
        const claimStartedAt = dependencies.now();
        const candidateUpdatedAtMs = candidate.updatedAt.getTime();
        const reconciliationAttemptId = dependencies.createId();
        const claim = await dependencies.persistence.claimReconciliation({
          sessionId: candidate.id,
          reconciliationAttemptId,
          leaseExpiresAt: new Date(
            claimStartedAt.getTime() + dependencies.config.reconciliationLeaseMs,
          ),
          updatedAt: claimStartedAt,
        });
        if (!claim.claimed) return;
        claimed += 1;
        const session = claim.session;
        const attemptStartedAtMs = dependencies.now().getTime();
        let providerOperation:
          | "head"
          | "complete"
          | "abort"
          | "delete"
          | "list"
          | undefined;
        let recoveryAdmissionAttemptId: string | undefined;
        let compensationStarted = session.status === "compensating";
        let providerCallCount = 0;
        const attemptWallDeadlineMs =
          Date.now() +
          dependencies.config.reconciliationLeaseMs -
          dependencies.config.reconciliationOperationDeadlineMs;
        const chargeProviderCall = () => {
          if (
            providerCallCount >=
            dependencies.config.reconciliationProviderCallBudget
          ) {
            throw new Error("Upload Session provider call budget exhausted");
          }
          providerCallCount += 1;
        };
        const runProviderOperation = async <Result>(
          operation: (signal?: AbortSignal) => Promise<Result>,
          operationChargesProviderCalls = false,
        ) => {
          if (!operationChargesProviderCalls) chargeProviderCall();
          let remainingAttemptMs = attemptWallDeadlineMs - Date.now();
          if (remainingAttemptMs <= 0) {
            throw new Error("Upload Session reconciliation lease budget exhausted");
          }
          const renewalAt = dependencies.now();
          await withReconciliationDeadline(
            () =>
              dependencies.persistence.renewReconciliationClaim({
                sessionId: session.id,
                reconciliationAttemptId,
                leaseExpiresAt: new Date(
                  renewalAt.getTime() +
                    dependencies.config.reconciliationLeaseMs,
                ),
                updatedAt: renewalAt,
              }),
            Math.min(
              dependencies.config.reconciliationOperationDeadlineMs,
              remainingAttemptMs,
            ),
          );
          remainingAttemptMs = attemptWallDeadlineMs - Date.now();
          if (remainingAttemptMs <= 0) {
            throw new Error("Upload Session reconciliation lease budget exhausted");
          }
          return withReconciliationDeadline(
            operation,
            Math.min(
              dependencies.config.reconciliationOperationDeadlineMs,
              remainingAttemptMs,
            ),
          );
        };
        diagnose(session.id, "reconciliation", "started", {
          state: session.status,
          takeover: session.reconciliationAttemptCount > 1,
        });
        try {
          if (
            session.status === "uploading" &&
            session.cleanupRetryAt &&
            session.cleanupRetryAt.getTime() <= claimStartedAt.getTime() &&
            session.expiresAt.getTime() > claimStartedAt.getTime()
          ) {
            if (!session.providerUploadId) {
              throw new Error("Upload Session provider binding is incomplete");
            }
            providerOperation = "list";
            const candidates = await runProviderOperation((signal) =>
              dependencies.storage.listExactKeyMultipartUploads(
                session.storageKey,
                signal,
                chargeProviderCall,
              ),
              true,
            );
            for (const candidate of candidates) {
              if (candidate.providerUploadId === session.providerUploadId) continue;
              providerOperation = "abort";
              await runProviderOperation((signal) =>
                dependencies.storage.abortMultipart({
                  storageKey: session.storageKey,
                  providerUploadId: candidate.providerUploadId,
                  signal,
                }),
              );
            }
            await dependencies.persistence.recordCleanupRetry({
              sessionId: session.id,
              failureCode: null,
              cleanupRetryAt: null,
              reconciliationAttemptId,
              updatedAt: dependencies.now(),
            });
            await dependencies.persistence.releaseReconciliation({
              sessionId: session.id,
              reconciliationAttemptId,
              updatedAt: dependencies.now(),
            });
            settled += 1;
            diagnose(session.id, "reconciliation", "succeeded", {
              state: session.status,
              providerOperation,
              providerCallCount,
              durationMs: dependencies.now().getTime() - attemptStartedAtMs,
            });
            return;
          }
          if (
            ((session.status === "initiating" ||
              session.status === "uploading") &&
              session.expiresAt.getTime() <= claimStartedAt.getTime()) ||
            session.status === "compensating"
          ) {
            const compensating =
              session.status === "compensating"
                ? session
                : await dependencies.persistence.beginCompensation({
                    sessionId: session.id,
                    reconciliationAttemptId,
                    failureCode: "upload_session_expired",
                    updatedAt: dependencies.now(),
                  });
            compensationStarted = true;
            if (
              compensating.transferKind === "multipart" &&
              compensating.providerUploadId
            ) {
              providerOperation = "abort";
              await runProviderOperation((signal) =>
                dependencies.storage.abortMultipart({
                  storageKey: compensating.storageKey,
                  providerUploadId: compensating.providerUploadId!,
                  signal,
                }),
              );
            } else if (compensating.transferKind === "multipart") {
              providerOperation = "list";
              const unfinished = await runProviderOperation((signal) =>
                dependencies.storage.listExactKeyMultipartUploads(
                  compensating.storageKey,
                  signal,
                  chargeProviderCall,
                ),
                true,
              );
              for (const upload of unfinished) {
                providerOperation = "abort";
                await runProviderOperation((signal) =>
                  dependencies.storage.abortMultipart({
                    storageKey: compensating.storageKey,
                    providerUploadId: upload.providerUploadId,
                    signal,
                  }),
                );
              }
            } else {
              providerOperation = "delete";
              await runProviderOperation((signal) =>
                dependencies.storage.deleteExactObject(
                  compensating.storageKey,
                  signal,
                ),
              );
            }
            await dependencies.persistence.settleTerminal({
              sessionId: compensating.id,
              reconciliationAttemptId,
              status:
                compensating.failureCode === "upload_session_expired" ||
                session.status === "uploading"
                  ? "expired"
                  : compensating.failureCode === "user_discarded"
                    ? "aborted"
                  : "failed",
              failureCode:
                compensating.failureCode ?? "upload_compensation_completed",
              updatedAt: dependencies.now(),
            });
            settled += 1;
            diagnose(session.id, "reconciliation", "succeeded", {
              state: session.status,
              providerOperation,
              providerCallCount,
              failureCode: compensating.failureCode ?? undefined,
              declaredAbandonedBytes: compensating.fileSizeBytes,
              declaredAbandonedAgeMs: Math.max(
                0,
                claimStartedAt.getTime() - candidateUpdatedAtMs,
              ),
              durationMs: dependencies.now().getTime() - attemptStartedAtMs,
            });
            return;
          }
          if (session.status === "initiating") {
            const admissionAttemptId = dependencies.createId();
            recoveryAdmissionAttemptId = admissionAttemptId;
            const admissionClaim = await dependencies.persistence.claimAdmission({
              sessionId: session.id,
              admissionAttemptId,
              claimExpiresAt: new Date(
                dependencies.now().getTime() +
                  dependencies.config.reconciliationLeaseMs,
              ),
              updatedAt: dependencies.now(),
            });
            if (!admissionClaim.claimed) {
              throw new UploadSessionInvalidStateError(
                "Upload Session admission recovery was superseded.",
              );
            }
            await recoverInitiatingSession(
              admissionClaim.session,
              runProviderOperation,
              reconciliationAttemptId,
              chargeProviderCall,
            );
            await dependencies.persistence.releaseReconciliation({
              sessionId: session.id,
              reconciliationAttemptId,
              updatedAt: dependencies.now(),
            });
            settled += 1;
            diagnose(session.id, "reconciliation", "succeeded", {
              state: session.status,
              providerOperation: "list",
              providerCallCount,
              durationMs: dependencies.now().getTime() - attemptStartedAtMs,
            });
            return;
          }
          providerOperation = "head";
          const existingObject = await runProviderOperation((signal) =>
            dependencies.storage.headExactObjectIfExists(
              session.storageKey,
              signal,
            ),
          );
          if (existingObject) {
            await handoffVerifiedObject(
              session,
              existingObject,
              reconciliationAttemptId,
              runProviderOperation,
              () => {
                compensationStarted = true;
                providerOperation = "delete";
              },
            );
            settled += 1;
            diagnose(session.id, "reconciliation", "succeeded", {
              state: session.status,
              providerOperation,
              providerCallCount,
              durationMs: dependencies.now().getTime() - attemptStartedAtMs,
            });
            return;
          }
          if (session.completionIntentMalformed) {
            const compensating =
              await dependencies.persistence.beginCompensation({
                sessionId: session.id,
                reconciliationAttemptId,
                failureCode: "completion_intent_malformed",
                updatedAt: dependencies.now(),
              });
            compensationStarted = true;
            if (compensating.providerUploadId) {
              providerOperation = "abort";
              await runProviderOperation((signal) =>
                dependencies.storage.abortMultipart({
                  storageKey: compensating.storageKey,
                  providerUploadId: compensating.providerUploadId!,
                  signal,
                }),
              );
            }
            await dependencies.persistence.settleTerminal({
              sessionId: session.id,
              reconciliationAttemptId,
              status: "failed",
              failureCode: "completion_intent_malformed",
              updatedAt: dependencies.now(),
            });
            settled += 1;
            diagnose(session.id, "reconciliation", "succeeded", {
              state: session.status,
              providerOperation,
              providerCallCount,
              failureCode: "completion_intent_malformed",
              durationMs: dependencies.now().getTime() - attemptStartedAtMs,
            });
            return;
          }
          if (
            session.transferKind === "multipart" &&
            session.providerUploadId &&
            session.completionParts
          ) {
            providerOperation = "complete";
            await runProviderOperation((signal) =>
              dependencies.storage.completeMultipart({
                storageKey: session.storageKey,
                providerUploadId: session.providerUploadId!,
                parts: session.completionParts!,
                signal,
              }),
            );
            const object = await runProviderOperation((signal) =>
              dependencies.storage.headExactObject(session.storageKey, signal),
            );
            await handoffVerifiedObject(
              session,
              object,
              reconciliationAttemptId,
              runProviderOperation,
              () => {
                compensationStarted = true;
                providerOperation = "delete";
              },
            );
            settled += 1;
            diagnose(session.id, "reconciliation", "succeeded", {
              state: session.status,
              providerOperation,
              providerCallCount,
              durationMs: dependencies.now().getTime() - attemptStartedAtMs,
            });
            return;
          }
          throw new UploadSessionStorageProbeError("missing");
        } catch (error) {
          if (error instanceof UploadSessionReconciliationClaimLostError) return;
          if (recoveryAdmissionAttemptId) {
            await dependencies.persistence.releaseAdmissionClaim({
              sessionId: session.id,
              admissionAttemptId: recoveryAdmissionAttemptId,
              updatedAt: dependencies.now(),
            });
          }
          if (error instanceof UploadSessionIntegrityError) {
            settled += 1;
            diagnose(session.id, "reconciliation", "succeeded", {
              state: session.status,
              providerOperation,
              providerCallCount,
              failureCode: "upload_object_integrity_failed",
              durationMs: dependencies.now().getTime() - attemptStartedAtMs,
            });
            return;
          }
          const permanentFailureCode =
            (providerOperation === "complete"
              ? permanentMultipartCompletionFailure(error) ??
                (isMissingMultipartUpload(error)
                  ? "multipart_upload_missing"
                  : null)
              : providerOperation === "abort" ||
                  providerOperation === "delete" ||
                  providerOperation === "list"
                ? permanentCleanupFailure(error)
                : null) ??
            (error instanceof UploadSessionStorageProbeError &&
                  error.disposition === "missing"
                ? session.transferKind === "single"
                  ? "upload_object_missing"
                  : "multipart_upload_missing"
                : error instanceof UploadSessionStorageProbeError &&
                    error.disposition === "access_denied"
                  ? "upload_object_access_denied"
                  : error instanceof UploadSessionStorageProbeError &&
                      error.disposition === "invalid_metadata"
                    ? "upload_object_metadata_invalid"
                    : session.reconciliationAttemptCount >=
                        dependencies.config.reconciliationMaximumAttempts
                      ? "upload_reconciliation_exhausted"
                      : null);
          if (permanentFailureCode) {
            try {
              if (compensationStarted) {
                await dependencies.persistence.settleTerminal({
                  sessionId: session.id,
                  reconciliationAttemptId,
                  status: "failed",
                  failureCode: permanentFailureCode,
                  updatedAt: dependencies.now(),
                });
                settled += 1;
                diagnose(session.id, "reconciliation", "failed", {
                  state: session.status,
                  providerOperation,
                  providerCallCount,
                  failureCode: permanentFailureCode,
                  durationMs: dependencies.now().getTime() - attemptStartedAtMs,
                });
                return;
              }
              const compensating = await dependencies.persistence.beginCompensation({
                sessionId: session.id,
                reconciliationAttemptId,
                failureCode: permanentFailureCode,
                updatedAt: dependencies.now(),
              });
              compensationStarted = true;
              if (
                (permanentFailureCode ===
                  "multipart_completion_invalid_parts" ||
                  permanentFailureCode ===
                    "upload_reconciliation_exhausted") &&
                compensating.providerUploadId
              ) {
                providerOperation = "abort";
                await runProviderOperation((signal) =>
                  dependencies.storage.abortMultipart({
                    storageKey: compensating.storageKey,
                    providerUploadId: compensating.providerUploadId!,
                    signal,
                  }),
                );
              } else if (compensating.transferKind === "single") {
                providerOperation = "delete";
                await runProviderOperation((signal) =>
                  dependencies.storage.deleteExactObject(
                    compensating.storageKey,
                    signal,
                  ),
                );
              }
              await dependencies.persistence.settleTerminal({
                sessionId: session.id,
                reconciliationAttemptId,
                status: "failed",
                failureCode: permanentFailureCode,
                updatedAt: dependencies.now(),
              });
              settled += 1;
              diagnose(session.id, "reconciliation", "failed", {
                state: session.status,
                providerOperation,
                providerCallCount,
                failureCode: permanentFailureCode,
                durationMs: dependencies.now().getTime() - attemptStartedAtMs,
              });
              return;
            } catch (settlementError) {
              if (
                settlementError instanceof
                UploadSessionReconciliationClaimLostError
              ) {
                return;
              }
            }
          }
          const retryDelayMs = reconciliationRetryDelayMs(
            session.reconciliationAttemptCount,
          );
          const nextRetryAt = new Date(
            dependencies.now().getTime() + retryDelayMs,
          );
          if (session.status === "uploading" && session.cleanupRetryAt) {
            await dependencies.persistence.recordCleanupRetry({
              sessionId: session.id,
              failureCode: "duplicate_upload_cleanup_failed",
              cleanupRetryAt: nextRetryAt,
              reconciliationAttemptId,
              updatedAt: dependencies.now(),
            });
          }
          try {
            const deferredFailureCode =
              session.status === "uploading" && session.cleanupRetryAt
                ? "duplicate_upload_cleanup_failed"
                : "upload_reconciliation_deferred";
            await dependencies.persistence.deferReconciliation({
              sessionId: session.id,
              failureCode: deferredFailureCode,
              reconcileAt: nextRetryAt,
              reconciliationAttemptId,
              updatedAt: dependencies.now(),
            });
          } catch (deferError) {
            if (
              deferError instanceof UploadSessionReconciliationClaimLostError
            ) {
              return;
            }
            throw deferError;
          }
          deferred += 1;
          diagnose(session.id, "reconciliation", "failed", {
            state: session.status,
            providerOperation,
            providerCallCount,
            failureCode:
              session.status === "uploading" && session.cleanupRetryAt
                ? "duplicate_upload_cleanup_failed"
                : "upload_reconciliation_deferred",
            durationMs: dependencies.now().getTime() - attemptStartedAtMs,
            nextRetryAt: nextRetryAt.toISOString(),
          });
        }
      };
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const candidate = due[cursor];
          cursor += 1;
          if (!candidate) return;
          await processCandidate(candidate);
        }
      };
      await Promise.all(
        Array.from(
          {
            length: Math.min(
              dependencies.config.reconciliationConcurrency,
              due.length,
            ),
          },
          () => worker(),
        ),
      );
      return { claimed, settled, deferred };
    },
  };
}

function configuredInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  limits: { minimum: number; maximum: number },
) {
  const raw = env[name]?.trim();
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < limits.minimum ||
    value > limits.maximum
  ) {
    throw new Error(
      `${name} must be an integer between ${limits.minimum} and ${limits.maximum}`,
    );
  }
  return value;
}

export function uploadSessionConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): UploadSessionConfig {
  const maximumSourceBytes = 5 * GIBIBYTE;
  return defaultUploadSessionConfig({
    maximumSourceBytes,
    smallFileThresholdBytes: configuredInteger(
      env,
      "UPLOAD_SINGLE_PUT_THRESHOLD_BYTES",
      100 * MEBIBYTE,
      { minimum: 1, maximum: maximumSourceBytes },
    ),
    multipartPartSizeBytes: configuredInteger(
      env,
      "UPLOAD_MULTIPART_PART_SIZE_BYTES",
      16 * MEBIBYTE,
      { minimum: 5 * MEBIBYTE, maximum: maximumSourceBytes },
    ),
    multipartConcurrency: configuredInteger(
      env,
      "UPLOAD_MULTIPART_CONCURRENCY",
      4,
      { minimum: 1, maximum: 16 },
    ),
    maximumMultipartParts: configuredInteger(
      env,
      "UPLOAD_MAXIMUM_MULTIPART_PARTS",
      10_000,
      { minimum: 1, maximum: 10_000 },
    ),
    maximumGrantParts: configuredInteger(
      env,
      "UPLOAD_MAXIMUM_GRANT_PARTS",
      16,
      { minimum: 1, maximum: 16 },
    ),
    uploadGrantTtlSeconds: configuredInteger(
      env,
      "UPLOAD_GRANT_TTL_SECONDS",
      15 * 60,
      { minimum: 60, maximum: 60 * 60 },
    ),
    sessionIdleMs: configuredInteger(
      env,
      "UPLOAD_SESSION_IDLE_MS",
      24 * 60 * 60 * 1_000,
      { minimum: 60_000, maximum: 6 * 24 * 60 * 60 * 1_000 },
    ),
    sessionHardLifetimeMs: configuredInteger(
      env,
      "UPLOAD_SESSION_HARD_LIFETIME_MS",
      6 * 24 * 60 * 60 * 1_000,
      { minimum: 60 * 60 * 1_000, maximum: 6 * 24 * 60 * 60 * 1_000 },
    ),
    reconciliationBatchSize: configuredInteger(
      env,
      "UPLOAD_RECONCILIATION_BATCH_SIZE",
      25,
      { minimum: 1, maximum: 100 },
    ),
    reconciliationConcurrency: configuredInteger(
      env,
      "UPLOAD_RECONCILIATION_CONCURRENCY",
      4,
      { minimum: 1, maximum: 16 },
    ),
    reconciliationLeaseMs: configuredInteger(
      env,
      "UPLOAD_RECONCILIATION_LEASE_MS",
      60_000,
      { minimum: 10_000, maximum: 5 * 60 * 1_000 },
    ),
    reconciliationOperationDeadlineMs: configuredInteger(
      env,
      "UPLOAD_RECONCILIATION_OPERATION_DEADLINE_MS",
      10_000,
      { minimum: 1_000, maximum: 60_000 },
    ),
    reconciliationMaximumAttempts: configuredInteger(
      env,
      "UPLOAD_RECONCILIATION_MAX_ATTEMPTS",
      8,
      { minimum: 1, maximum: 32 },
    ),
    reconciliationProviderCallBudget: configuredInteger(
      env,
      "UPLOAD_RECONCILIATION_PROVIDER_CALL_BUDGET",
      20,
      { minimum: 1, maximum: 64 },
    ),
    reconciliationBackoffBaseMs: configuredInteger(
      env,
      "UPLOAD_RECONCILIATION_BACKOFF_BASE_MS",
      5_000,
      { minimum: 1_000, maximum: 60_000 },
    ),
    reconciliationBackoffCeilingMs: configuredInteger(
      env,
      "UPLOAD_RECONCILIATION_BACKOFF_CEILING_MS",
      15 * 60 * 1_000,
      { minimum: 5_000, maximum: 60 * 60 * 1_000 },
    ),
  });
}

export class UploadSessionQuotaRefusedError extends Error {
  readonly code = "quota_exceeded";

  constructor(
    public readonly details: {
      tier: string;
      limitMinutes: number;
      usedMinutes: number;
      requestedMinutes: number;
    },
  ) {
    super(
      `Monthly processing limit reached on the ${details.tier} plan (${details.limitMinutes} min/mo; ${details.usedMinutes} min used). Upgrade the workspace to keep generating.`,
    );
    this.name = "UploadSessionQuotaRefusedError";
  }
}

function requiredPrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

function completionPartsFromJson(value: Prisma.JsonValue | null) {
  const parsed = uploadCompletionIntentSchema.safeParse(value);
  return {
    parts: parsed.success ? parsed.data.parts : null,
    malformed: value !== null && !parsed.success,
  };
}

function fromPrismaUploadSession(row: PrismaUploadSession): UploadSessionRecord {
  const completionIntent = completionPartsFromJson(row.completionParts);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    actorUserId: row.actorUserId,
    legacyOwnerUserId: row.legacyOwnerUserId,
    clientIdempotencyKey: row.clientIdempotencyKey,
    immutableInputFingerprint: row.immutableInputFingerprint,
    preallocatedProjectId: row.preallocatedProjectId,
    title: row.title,
    fileName: row.fileName,
    fileSizeBytes: Number(row.fileSizeBytes),
    contentType: row.contentType,
    browserFingerprint: row.browserFingerprint,
    brandTemplateId: row.brandTemplateId,
    brandSnapshot: row.brandSnapshot,
    brandProfileId: row.brandProfileId,
    brandProfileSnapshot: row.brandProfileSnapshot,
    generation: row.generationSettings,
    transferKind: row.transferKind,
    partSizeBytes: row.partSizeBytes,
    partCount: row.partCount,
    storageKey: row.storageKey,
    providerUploadId: row.providerUploadId,
    admissionAttemptId: row.admissionAttemptId,
    admissionClaimExpiresAt: row.admissionClaimExpiresAt,
    admissionPreparedAt: row.admissionPreparedAt,
    completionParts: completionIntent.parts,
    completionIntentMalformed: completionIntent.malformed,
    queuedJobId: row.queuedJobId,
    failureCode: row.failureCode,
    cleanupRetryAt: row.cleanupRetryAt,
    reconcileAt: row.reconcileAt,
    reconciliationAttemptId: row.reconciliationAttemptId,
    reconciliationLeaseExpiresAt: row.reconciliationLeaseExpiresAt,
    reconciliationAttemptCount: row.reconciliationAttemptCount,
    status: row.status,
    expiresAt: row.expiresAt,
    hardExpiresAt: row.hardExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function waitForSessionState(
  sessionId: string,
  isSettled: (session: UploadSessionRecord) => boolean,
) {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    const session = fromPrismaUploadSession(row);
    if (isSettled(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const row = await requiredPrisma().uploadSession.findUnique({
    where: { id: sessionId },
  });
  if (!row) throw new Error("Upload Session not found");
  return fromPrismaUploadSession(row);
}

export const prismaUploadSessionPersistence: UploadSessionPersistence = {
  async findByClientKey({ workspaceId, clientIdempotencyKey }) {
    const row = await requiredPrisma().uploadSession.findUnique({
      where: {
        workspaceId_clientIdempotencyKey: {
          workspaceId,
          clientIdempotencyKey,
        },
      },
    });
    return row ? fromPrismaUploadSession(row) : null;
  },
  async reserve(record) {
    try {
      const row = await requiredPrisma().uploadSession.create({
        data: {
          id: record.id,
          workspaceId: record.workspaceId,
          actorUserId: record.actorUserId,
          legacyOwnerUserId: record.legacyOwnerUserId,
          clientIdempotencyKey: record.clientIdempotencyKey,
          immutableInputFingerprint: record.immutableInputFingerprint,
          preallocatedProjectId: record.preallocatedProjectId,
          title: record.title,
          fileName: record.fileName,
          fileSizeBytes: BigInt(record.fileSizeBytes),
          contentType: record.contentType,
          browserFingerprint: record.browserFingerprint,
          brandTemplateId: record.brandTemplateId,
          brandSnapshot:
            record.brandSnapshot === null
              ? Prisma.JsonNull
              : (record.brandSnapshot as Prisma.InputJsonValue),
          brandProfileId: record.brandProfileId,
          brandProfileSnapshot:
            record.brandProfileSnapshot === null
              ? Prisma.JsonNull
              : (record.brandProfileSnapshot as Prisma.InputJsonValue),
          generationSettings: record.generation as Prisma.InputJsonValue,
          transferKind: record.transferKind,
          partSizeBytes: record.partSizeBytes,
          partCount: record.partCount,
          storageKey: record.storageKey,
          status: "initiating",
          admissionAttemptId: record.admissionAttemptId,
          admissionClaimExpiresAt: new Date(record.createdAt.getTime() + 30_000),
          expiresAt: record.expiresAt,
          hardExpiresAt: record.hardExpiresAt,
          createdAt: record.createdAt,
        },
      });
      return { created: true, session: fromPrismaUploadSession(row) };
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      ) {
        throw error;
      }
      const row = await requiredPrisma().uploadSession.findUnique({
        where: {
          workspaceId_clientIdempotencyKey: {
            workspaceId: record.workspaceId,
            clientIdempotencyKey: record.clientIdempotencyKey,
          },
        },
      });
      if (!row) throw error;
      return { created: false, session: fromPrismaUploadSession(row) };
    }
  },
  async claimAdmission({
    sessionId,
    admissionAttemptId,
    claimExpiresAt,
    updatedAt,
  }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: {
        id: sessionId,
        status: "initiating",
        providerUploadId: null,
        OR: [
          { admissionClaimExpiresAt: null },
          { admissionClaimExpiresAt: { lte: updatedAt } },
        ],
      },
      data: {
        admissionAttemptId,
        admissionClaimExpiresAt: claimExpiresAt,
        updatedAt,
      },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    return {
      claimed: updated.count === 1,
      session: fromPrismaUploadSession(row),
    };
  },
  async prepareAdmission({
    sessionId,
    admissionAttemptId,
    brandTemplateId,
    brandSnapshot,
    brandProfileId,
    brandProfileSnapshot,
    updatedAt,
  }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: { id: sessionId, status: "initiating", admissionAttemptId },
      data: {
        brandTemplateId,
        brandSnapshot:
          brandSnapshot === null
            ? Prisma.JsonNull
            : (brandSnapshot as Prisma.InputJsonValue),
        brandProfileId,
        brandProfileSnapshot:
          brandProfileSnapshot === null
            ? Prisma.JsonNull
            : (brandProfileSnapshot as Prisma.InputJsonValue),
        admissionPreparedAt: updatedAt,
        updatedAt,
      },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    if (updated.count !== 1) throw new UploadSessionAdmissionClaimLostError();
    return fromPrismaUploadSession(row);
  },
  async waitForAdmission(sessionId) {
    return waitForSessionState(
      sessionId,
      (session) => session.status !== "initiating" || !!session.providerUploadId,
    );
  },
  async bindMultipartProvider({
    sessionId,
    admissionAttemptId,
    providerUploadId,
    updatedAt,
  }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: {
        id: sessionId,
        status: "initiating",
        providerUploadId: null,
        admissionAttemptId,
      },
      data: {
        providerUploadId,
        providerInitiatedAt: updatedAt,
        status: "uploading",
        admissionAttemptId: null,
        admissionClaimExpiresAt: null,
        updatedAt,
      },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    if (updated.count === 0 && !row.providerUploadId) {
      throw new UploadSessionAdmissionClaimLostError();
    }
    return fromPrismaUploadSession(row);
  },
  async markSingleReady({ sessionId, admissionAttemptId, updatedAt }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: { id: sessionId, status: "initiating", admissionAttemptId },
      data: {
        status: "uploading",
        admissionAttemptId: null,
        admissionClaimExpiresAt: null,
        updatedAt,
      },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    if (updated.count !== 1) throw new UploadSessionAdmissionClaimLostError();
    return fromPrismaUploadSession(row);
  },
  async releaseAdmissionClaim({ sessionId, admissionAttemptId, updatedAt }) {
    await requiredPrisma().uploadSession.updateMany({
      where: {
        id: sessionId,
        status: "initiating",
        admissionAttemptId,
      },
      data: {
        admissionAttemptId: null,
        admissionClaimExpiresAt: updatedAt,
        updatedAt,
      },
    });
  },
  async findByIdForWorkspace({ sessionId, workspaceId }) {
    const row = await requiredPrisma().uploadSession.findFirst({
      where: { id: sessionId, workspaceId },
    });
    return row ? fromPrismaUploadSession(row) : null;
  },
  async renewTransferActivity({ sessionId, expiresAt, updatedAt }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: {
        id: sessionId,
        status: "uploading",
        expiresAt: { gt: updatedAt },
        hardExpiresAt: { gt: updatedAt },
        reconciliationAttemptId: null,
      },
      data: { expiresAt, updatedAt },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    if (updated.count !== 1) throw new UploadSessionInvalidStateError();
    return fromPrismaUploadSession(row);
  },
  async expireTransfer({ sessionId, expiredAt }) {
    await requiredPrisma().uploadSession.updateMany({
      where: {
        id: sessionId,
        status: "uploading",
        reconciliationAttemptId: null,
        OR: [
          { expiresAt: { lte: expiredAt } },
          { hardExpiresAt: { lte: expiredAt } },
        ],
      },
      data: {
        status: "compensating",
        failureCode: "upload_session_expired",
        reconcileAt: expiredAt,
        updatedAt: expiredAt,
      },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    return fromPrismaUploadSession(row);
  },
  async beginFinalization({ sessionId, parts, reconcileAt, updatedAt }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: {
        id: sessionId,
        status: "uploading",
        expiresAt: { gt: updatedAt },
        hardExpiresAt: { gt: updatedAt },
        reconciliationAttemptId: null,
      },
      data: {
        status: "finalizing",
        completionParts: {
          version: 1,
          parts,
        } satisfies Prisma.InputJsonValue,
        reconcileAt,
        updatedAt,
      },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    return {
      claimed: updated.count === 1,
      session: fromPrismaUploadSession(row),
    };
  },
  async handoff({
    sessionId,
    queuedJobId,
    verifiedSizeBytes,
    verifiedContentType,
    reconciliationAttemptId,
    updatedAt,
  }) {
    const initial = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!initial) throw new Error("Upload Session not found");
    if (initial.status === "queued_for_ingest") {
      return fromPrismaUploadSession(initial);
    }
    const generation = initial.generationSettings as {
      languageCode?: unknown;
      contentPack?: unknown;
    };
    const languageCode = String(generation.languageCode ?? "auto");
    const contentPack = contentPackSchema.parse(generation.contentPack);
    const [retention, workspace] = await Promise.all([
      projectRetentionService.assignmentForWorkspace(
        initial.workspaceId,
        initial.createdAt,
      ),
      requiredPrisma().workspace.findUnique({
        where: { id: initial.workspaceId },
        select: { pricingTier: true },
      }),
    ]);

    try {
      const settled = await requiredPrisma().$transaction(async (tx) => {
        const current = await tx.uploadSession.findUnique({
          where: { id: sessionId },
        });
        if (!current) throw new Error("Upload Session not found");
        if (current.status === "queued_for_ingest") return current;
        if (
          (current.status !== "finalizing" && current.status !== "reconciling") ||
          (reconciliationAttemptId &&
            current.reconciliationAttemptId !== reconciliationAttemptId) ||
          (!reconciliationAttemptId &&
            current.reconciliationAttemptId !== null)
        ) {
          if (reconciliationAttemptId) {
            throw new UploadSessionReconciliationClaimLostError();
          }
          throw new Error("Upload Session is not ready for handoff");
        }
        await tx.project.create({
          data: {
            id: current.preallocatedProjectId,
            userId: current.legacyOwnerUserId,
            workspaceId: current.workspaceId,
            createdByUserId: current.actorUserId,
            updatedByUserId: current.actorUserId,
            title: current.title,
            sourceMediaUrl: `r2://${process.env.R2_BUCKET ?? "unknown-bucket"}/${current.storageKey}`,
            sourceType: "upload",
            sourceInput: current.fileName,
            sourceStorageKey: current.storageKey,
            sourceMimeType: verifiedContentType,
            sourceSizeBytes: BigInt(verifiedSizeBytes),
            languageCode,
            ingestStatus: "queued",
            brandTemplateId: current.brandTemplateId,
            brandSnapshot: current.brandSnapshot ?? Prisma.JsonNull,
            brandProfileId: current.brandProfileId,
            brandProfileSnapshot: current.brandProfileSnapshot ?? Prisma.JsonNull,
            retentionPolicyKey: retention?.retentionPolicyKey ?? null,
            expiresAt: retention?.expiresAt ?? null,
            workflowEventSeq: 1,
            createdAt: current.createdAt,
          },
        });
        if (current.brandProfileId && workspace) {
          const profileSnapshot = current.brandProfileSnapshot as {
            style?: { templateId?: unknown } | null;
          } | null;
          const templateId =
            typeof profileSnapshot?.style?.templateId === "string"
              ? profileSnapshot.style.templateId
              : null;
          await tx.programAnalyticsEvent.create({
            data: {
              workspaceId: current.workspaceId,
              actorUserId: current.actorUserId,
              projectId: current.preallocatedProjectId,
              type: "brand_profile_applied",
              metadata: {
                profileId: current.brandProfileId,
                ...(templateId ? { templateId } : {}),
                assetKind: "profile",
                planTier: resolvePricingTier(workspace.pricingTier),
                outcome: "succeeded",
              },
            },
          });
        }
        await tx.contentPack.create({
          data: {
            projectId: current.preallocatedProjectId,
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
        await tx.ingestJob.create({
          data: {
            id: queuedJobId,
            projectId: current.preallocatedProjectId,
            uploadSessionId: current.id,
            jobType: "upload_finalize",
            payload: {
              storageKey: current.storageKey,
              verifiedSizeBytes,
              verifiedContentType,
              uploadSessionId: current.id,
            },
          },
        });
        const emittedAt = updatedAt;
        await tx.workflowEvent.create({
          data: {
            projectId: current.preallocatedProjectId,
            workflowRunId: queuedJobId,
            seq: 1,
            stage: "ingest_queued",
            status: "queued",
            progress: 5,
            errorCode: null,
            emittedAt,
            dedupeKey: `upload-session:${current.id}:queued`,
            payload: {
              event: "workflow.stage.updated",
              projectId: current.preallocatedProjectId,
              workflowRunId: queuedJobId,
              seq: 1,
              stage: "ingest_queued",
              status: "queued",
              progress: 5,
              errorCode: null,
              emittedAt: emittedAt.toISOString(),
            },
            redisRequired: isWorkflowRedisDeliveryEnabled(),
            nextDeliveryAt: emittedAt,
          },
        });
        const handoff = await tx.uploadSession.updateMany({
          where: {
            id: current.id,
            status: current.status,
            reconciliationAttemptId: reconciliationAttemptId ?? null,
          },
          data: {
            status: "queued_for_ingest",
            verifiedSizeBytes: BigInt(verifiedSizeBytes),
            verifiedContentType,
            queuedJobId,
            queuedAt: updatedAt,
            reconcileAt: null,
            reconciliationAttemptId: null,
            reconciliationLeaseExpiresAt: null,
            updatedAt,
          },
        });
        if (handoff.count !== 1) {
          throw new UploadSessionReconciliationClaimLostError();
        }
        return tx.uploadSession.findUniqueOrThrow({
          where: { id: current.id },
        });
      });
      return fromPrismaUploadSession(settled);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const replay = await requiredPrisma().uploadSession.findUnique({
          where: { id: sessionId },
        });
        if (replay?.status === "queued_for_ingest") {
          return fromPrismaUploadSession(replay);
        }
      }
      throw error;
    }
  },
  async recordFailure({
    sessionId,
    admissionAttemptId,
    status,
    failureCode,
    cleanupRetryAt,
    updatedAt,
  }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: {
        id: sessionId,
        ...(admissionAttemptId
          ? { admissionAttemptId, status: "initiating" as const }
          : {
              reconciliationAttemptId: null,
              status: { in: ["finalizing", "compensating"] },
            }),
      },
      data: {
        status,
        failureCode,
        cleanupRetryAt,
        admissionAttemptId: null,
        admissionClaimExpiresAt: null,
        updatedAt,
      },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    if (updated.count !== 1) {
      if (admissionAttemptId) throw new UploadSessionAdmissionClaimLostError();
      throw new UploadSessionReconciliationClaimLostError();
    }
    return fromPrismaUploadSession(row);
  },
  async recordCleanupRetry({
    sessionId,
    failureCode,
    cleanupRetryAt,
    reconciliationAttemptId,
    updatedAt,
  }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: {
        id: sessionId,
        reconciliationAttemptId: reconciliationAttemptId ?? null,
      },
      data: { failureCode, cleanupRetryAt, updatedAt },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    if (updated.count !== 1) {
      throw new UploadSessionReconciliationClaimLostError();
    }
    return fromPrismaUploadSession(row);
  },
  async markReconciling({
    sessionId,
    failureCode,
    reconcileAt,
    reconciliationAttemptId,
    updatedAt,
  }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: {
        id: sessionId,
        status: { in: ["finalizing", "reconciling"] },
        reconciliationAttemptId: reconciliationAttemptId ?? null,
      },
      data: {
        status: "reconciling",
        failureCode,
        reconcileAt,
        reconciliationAttemptId: null,
        reconciliationLeaseExpiresAt: null,
        updatedAt,
      },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    if (updated.count !== 1) {
      throw new UploadSessionReconciliationClaimLostError();
    }
    return fromPrismaUploadSession(row);
  },
  async findDueReconciliation({ now, limit }) {
    const rows = await requiredPrisma().uploadSession.findMany({
      where: {
        OR: [
          {
            status: "uploading",
            OR: [
              { expiresAt: { lte: now } },
              { cleanupRetryAt: { lte: now } },
            ],
          },
          {
            status: "initiating",
            admissionClaimExpiresAt: { lte: now },
            OR: [{ reconcileAt: null }, { reconcileAt: { lte: now } }],
          },
          {
            status: { in: ["finalizing", "reconciling", "compensating"] },
            OR: [{ reconcileAt: null }, { reconcileAt: { lte: now } }],
          },
        ],
        AND: [
          {
            OR: [
              { reconciliationLeaseExpiresAt: null },
              { reconciliationLeaseExpiresAt: { lte: now } },
            ],
          },
        ],
      },
      orderBy: [{ reconcileAt: "asc" }, { updatedAt: "asc" }, { id: "asc" }],
      take: limit,
    });
    return rows.map(fromPrismaUploadSession);
  },
  async claimReconciliation({
    sessionId,
    reconciliationAttemptId,
    leaseExpiresAt,
    updatedAt,
  }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: {
        id: sessionId,
        OR: [
          {
            status: "initiating",
            admissionClaimExpiresAt: { lte: updatedAt },
            OR: [
              { reconcileAt: null },
              { reconcileAt: { lte: updatedAt } },
            ],
          },
          {
            status: "uploading",
            OR: [
              { expiresAt: { lte: updatedAt } },
              { cleanupRetryAt: { lte: updatedAt } },
            ],
          },
          {
            status: { in: ["finalizing", "reconciling", "compensating"] },
            OR: [{ reconcileAt: null }, { reconcileAt: { lte: updatedAt } }],
          },
        ],
        AND: [
          {
            OR: [
              { reconciliationLeaseExpiresAt: null },
              { reconciliationLeaseExpiresAt: { lte: updatedAt } },
            ],
          },
        ],
      },
      data: {
        reconciliationAttemptId,
        reconciliationLeaseExpiresAt: leaseExpiresAt,
        reconciliationAttemptCount: { increment: 1 },
        updatedAt,
      },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    return {
      claimed: updated.count === 1,
      session: fromPrismaUploadSession(row),
    };
  },
  async renewReconciliationClaim({
    sessionId,
    reconciliationAttemptId,
    leaseExpiresAt,
    updatedAt,
  }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: { id: sessionId, reconciliationAttemptId },
      data: {
        reconciliationLeaseExpiresAt: leaseExpiresAt,
        updatedAt,
      },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    if (updated.count !== 1) {
      throw new UploadSessionReconciliationClaimLostError();
    }
    return fromPrismaUploadSession(row);
  },
  async beginDiscard({
    sessionId,
    reconciliationAttemptId,
    leaseExpiresAt,
    updatedAt,
  }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: {
        id: sessionId,
        status: "uploading",
        reconciliationAttemptId: null,
      },
      data: {
        status: "compensating",
        failureCode: "user_discarded",
        reconcileAt: updatedAt,
        reconciliationAttemptId,
        reconciliationLeaseExpiresAt: leaseExpiresAt,
        reconciliationAttemptCount: { increment: 1 },
        updatedAt,
      },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    return {
      claimed: updated.count === 1,
      session: fromPrismaUploadSession(row),
    };
  },
  async releaseReconciliation({
    sessionId,
    reconciliationAttemptId,
    updatedAt,
  }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: { id: sessionId, reconciliationAttemptId },
      data: {
        reconcileAt: null,
        reconciliationAttemptId: null,
        reconciliationLeaseExpiresAt: null,
        updatedAt,
      },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    if (updated.count !== 1) {
      throw new UploadSessionReconciliationClaimLostError();
    }
    return fromPrismaUploadSession(row);
  },
  async beginCompensation({
    sessionId,
    reconciliationAttemptId,
    failureCode,
    updatedAt,
  }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: {
        id: sessionId,
        status: {
          in: ["initiating", "uploading", "finalizing", "reconciling"],
        },
        reconciliationAttemptId,
      },
      data: { status: "compensating", failureCode, updatedAt },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    if (updated.count !== 1) {
      throw new UploadSessionReconciliationClaimLostError();
    }
    return fromPrismaUploadSession(row);
  },
  async settleTerminal({
    sessionId,
    reconciliationAttemptId,
    status,
    failureCode,
    updatedAt,
  }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: { id: sessionId, status: "compensating", reconciliationAttemptId },
      data: {
        status,
        failureCode,
        reconcileAt: null,
        cleanupRetryAt: null,
        reconciliationAttemptId: null,
        reconciliationLeaseExpiresAt: null,
        updatedAt,
      },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    if (updated.count !== 1) {
      throw new UploadSessionReconciliationClaimLostError();
    }
    return fromPrismaUploadSession(row);
  },
  async deferReconciliation({
    sessionId,
    reconciliationAttemptId,
    failureCode,
    reconcileAt,
    updatedAt,
  }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: { id: sessionId, reconciliationAttemptId },
      data: {
        failureCode,
        reconcileAt,
        reconciliationAttemptId: null,
        reconciliationLeaseExpiresAt: null,
        updatedAt,
      },
    });
    const row = await requiredPrisma().uploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new Error("Upload Session not found");
    if (updated.count !== 1) {
      throw new UploadSessionReconciliationClaimLostError();
    }
    return fromPrismaUploadSession(row);
  },
};

function isMissingMultipartUpload(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown; Code?: unknown };
  return [candidate.name, candidate.code, candidate.Code].some(
    (value) => value === "NoSuchUpload",
  );
}

function permanentMultipartCompletionFailure(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const identity = [candidate.name, candidate.code, candidate.Code]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const status = candidate.$metadata?.httpStatusCode;
  if (/invalidpart|invalidpartorder|entitytoosmall/i.test(identity)) {
    return "multipart_completion_invalid_parts";
  }
  if (/nosuchbucket/i.test(identity)) {
    return "multipart_completion_bucket_missing";
  }
  if (status === 403 || /accessdenied|forbidden/i.test(identity)) {
    return "multipart_completion_access_denied";
  }
  if (status === 404 || /(^|\s)notfound($|\s)/i.test(identity)) {
    return "multipart_completion_unknown_not_found";
  }
  return null;
}

function permanentCleanupFailure(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const identity = [candidate.name, candidate.code, candidate.Code]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (
    candidate.$metadata?.httpStatusCode === 403 ||
    /accessdenied|forbidden/i.test(identity)
  ) {
    return "upload_cleanup_access_denied";
  }
  if (/nosuchbucket/i.test(identity)) {
    return "upload_cleanup_bucket_missing";
  }
  return null;
}

const r2UploadSessionStorage: UploadSessionStorage = {
  async grantSinglePut({ storageKey, contentType, expiresInSeconds }) {
    return {
      url: await presignSingleUploadUrl({
        key: storageKey,
        contentType,
        expiresIn: expiresInSeconds,
      }),
    };
  },
  async createMultipart({ storageKey, contentType, metadata, signal }) {
    const created = await createMultipartUpload({
      key: storageKey,
      contentType,
      metadata,
      signal,
    });
    return { providerUploadId: created.uploadId };
  },
  async grantMultipartParts({
    storageKey,
    providerUploadId,
    partNumbers,
    expiresInSeconds,
  }) {
    return presignMultipartPartUrls({
      key: storageKey,
      uploadId: providerUploadId,
      partNumbers,
      expiresIn: expiresInSeconds,
    });
  },
  async completeMultipart({ storageKey, providerUploadId, parts, signal }) {
    await completeMultipartUpload({
      key: storageKey,
      uploadId: providerUploadId,
      etags: parts,
      signal,
    });
  },
  async listMultipartParts({
    storageKey,
    providerUploadId,
    signal,
    onProviderCall,
  }) {
    return listUploadedParts({
      key: storageKey,
      uploadId: providerUploadId,
      signal,
      onProviderCall,
    });
  },
  async headExactObject(storageKey, signal) {
    try {
      const object = await headObject(storageKey, { signal });
      if (object.sizeBytes === null) {
        throw new UploadSessionStorageProbeError("invalid_metadata");
      }
      return {
        sizeBytes: object.sizeBytes,
        contentType: object.contentType,
      };
    } catch (error) {
      if (error instanceof UploadSessionStorageProbeError) throw error;
      const disposition = classifyR2StorageError(error);
      throw new UploadSessionStorageProbeError(
        disposition === "storage_object_missing"
          ? "missing"
          : disposition === "storage_access_denied"
            ? "access_denied"
            : "unavailable",
      );
    }
  },
  async headExactObjectIfExists(storageKey, signal) {
    try {
      return await this.headExactObject(storageKey, signal);
    } catch (error) {
      if (
        error instanceof UploadSessionStorageProbeError &&
        error.disposition === "missing"
      ) {
        return null;
      }
      throw error;
    }
  },
  async listExactKeyMultipartUploads(storageKey, signal, onProviderCall) {
    try {
      return (await listExactKeyMultipartUploads({
        key: storageKey,
        signal,
        onProviderCall,
      })).map(
        (upload) => ({
          providerUploadId: upload.uploadId,
          initiatedAt: upload.initiatedAt,
        }),
      );
    } catch (error) {
      if (error instanceof InvalidMultipartUploadIdentityError) {
        throw new UploadSessionProviderIdentityError();
      }
      throw error;
    }
  },
  async abortMultipart({ storageKey, providerUploadId, signal }) {
    try {
      await abortMultipartUpload({
        key: storageKey,
        uploadId: providerUploadId,
        signal,
      });
    } catch (error) {
      if (!isMissingMultipartUpload(error)) throw error;
    }
  },
  async deleteExactObject(storageKey, signal) {
    await deleteObject(storageKey, { signal });
  },
};

async function assertWorkspaceUploadQuota(workspaceId: string) {
  const prisma = requiredPrisma();
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);
  const [workspace, usage] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { pricingTier: true },
    }),
    prisma.project.aggregate({
      where: { workspaceId, createdAt: { gte: startOfMonth } },
      _sum: { sourceDurationSeconds: true },
    }),
  ]);
  if (!workspace) throw new Error("Workspace not found");
  const tier = resolvePricingTier(workspace.pricingTier);
  const usedMinutes = processingMinutesFromSeconds(
    usage._sum.sourceDurationSeconds ?? 0,
  );
  const limitMinutes = MONTHLY_PROCESSING_MINUTE_LIMITS[tier];
  if (
    isProcessingQuotaExceeded({
      usedMinutes,
      requestedSeconds: 0,
      limitMinutes,
      blockAtLimitWithoutRequest: true,
    })
  ) {
    throw new UploadSessionQuotaRefusedError({
      tier,
      limitMinutes,
      usedMinutes,
      requestedMinutes: 0,
    });
  }
}

const productionUploadSessionModule = createUploadSessionModule({
  config: uploadSessionConfigFromEnv(),
  persistence: prismaUploadSessionPersistence,
  storage: r2UploadSessionStorage,
  admission: {
    assertQuota: assertWorkspaceUploadQuota,
    async resolveBrand(input) {
      if (input.brandProfileId) {
        const [actor, workspace] = await Promise.all([
          workspaceService.requireActor(input.actorUserId, input.workspaceId, "content.view"),
          requiredPrisma().workspace.findUnique({ where: { id: input.workspaceId }, select: { personalOwnerUserId: true } }),
        ]);
        const resolved = await brandProfileService.resolveForProject({
          actorUserId: input.actorUserId,
          workspaceId: input.workspaceId,
          workspaceOwnerUserId: actor.workspaceOwnerUserId,
          role: actor.role,
          status: actor.status,
          pricingTier: actor.pricingTier,
          isPersonalWorkspace: workspace?.personalOwnerUserId !== null,
        }, {
          profileId: input.brandProfileId,
          templateId: input.brandTemplateId,
        });
        return {
          templateId: resolved.templateId,
          snapshot: resolved.templateSnapshot,
          profileId: resolved.profileId,
          profileSnapshot: resolved.profileSnapshot,
        };
      }
      const legacy = await brandTemplateService.resolveSnapshotForUser(
        input.legacyOwnerUserId,
        input.brandTemplateId,
        { workspaceId: input.workspaceId, actorUserId: input.actorUserId },
      );
      return legacy
        ? { templateId: legacy.templateId, snapshot: legacy.snapshot, profileId: null, profileSnapshot: null }
        : null;
    },
  },
  now: () => new Date(),
  createId: randomUUID,
  diagnose(event) {
    console.warn(JSON.stringify(uploadSessionDiagnosticRecord(event)));
  },
});

export class UploadSessionService {
  async open(
    actorUserId: string,
    input: ValidatedOpenUploadSessionInput,
    workspaceId?: string,
  ) {
    const startedAt = performance.now();
    const parsed = openUploadSessionSchema.parse(input);
    const ownership = await workspaceService.resolveLegacyOwnership(
      actorUserId,
      workspaceId,
    );
    await workspaceService.requireActor(
      actorUserId,
      ownership.workspaceId,
      "processing.consume",
    );
    const result = await productionUploadSessionModule.open({
      actorUserId,
      workspaceId: ownership.workspaceId,
      legacyOwnerUserId: ownership.legacyOwnerUserId,
      clientIdempotencyKey: parsed.clientIdempotencyKey,
      title: parsed.title,
      source: parsed.source,
      brandTemplateId: parsed.brandTemplateId ?? null,
      brandProfileId: parsed.brandProfileId ?? null,
      generation: parsed.generationContext,
    });
    console.warn(
      JSON.stringify({
        level: "info",
        message: "upload_session_opened",
        uploadSessionId: result.sessionId,
        workspaceId: ownership.workspaceId,
        state: result.outcome,
        transferKind:
          result.outcome === "uploading" ? result.transfer.kind : null,
        partCount:
          result.outcome === "uploading" && result.transfer.kind === "multipart"
            ? result.transfer.partCount
            : 1,
        expectedProviderOperations:
          result.outcome !== "uploading"
            ? null
            : result.transfer.kind === "single"
              ? { putObject: 1, headObject: 1 }
              : {
                  createMultipartUpload: 1,
                  uploadPart: result.transfer.partCount,
                  completeMultipartUpload: 1,
                  headObject: 1,
                },
        firstGrantLatencyMs: Math.round(performance.now() - startedAt),
        terminalOutcome:
          result.outcome === "queued_for_ingest" ? "queued_for_ingest" : null,
      }),
    );
    return result;
  }

  async finalize(
    actorUserId: string,
    input: ValidatedFinalizeUploadSessionInput,
    workspaceId?: string,
  ) {
    const startedAt = performance.now();
    const parsed = finalizeUploadSessionSchema.parse(input);
    const ownership = await workspaceService.resolveLegacyOwnership(
      actorUserId,
      workspaceId,
    );
    await workspaceService.requireActor(
      actorUserId,
      ownership.workspaceId,
      "processing.consume",
    );
    const result = await productionUploadSessionModule.finalize({
      actorUserId,
      workspaceId: ownership.workspaceId,
      sessionId: parsed.sessionId,
      parts: parsed.parts,
    });
    console.warn(
      JSON.stringify({
        level: "info",
        message: "upload_session_finalized",
        uploadSessionId: result.sessionId,
        workspaceId: ownership.workspaceId,
        state: result.outcome,
        finalizeDurationMs: Math.round(performance.now() - startedAt),
        completionPartCount: parsed.parts.length,
        terminalOutcome:
          result.outcome === "queued_for_ingest" ? "queued_for_ingest" : null,
      }),
    );
    return result;
  }

  async grant(
    actorUserId: string,
    input: ValidatedGrantUploadPartsInput,
    workspaceId?: string,
  ) {
    const parsed = grantUploadPartsSchema.parse(input);
    const ownership = await workspaceService.resolveLegacyOwnership(
      actorUserId,
      workspaceId,
    );
    await workspaceService.requireActor(
      actorUserId,
      ownership.workspaceId,
      "processing.consume",
    );
    const startedAt = performance.now();
    const result = await productionUploadSessionModule.grant({
      actorUserId,
      workspaceId: ownership.workspaceId,
      sessionId: parsed.sessionId,
      partNumbers: parsed.partNumbers,
    });
    console.warn(
      JSON.stringify({
        level: "info",
        message: "upload_session_grant_issued",
        uploadSessionId: result.sessionId,
        workspaceId: ownership.workspaceId,
        grantedPartCount: result.grants.length,
        providerOperationClass: "upload_part",
        plannedProviderCallCount: result.grants.length,
        grantLatencyMs: Math.round(performance.now() - startedAt),
      }),
    );
    return result;
  }

  async status(
    actorUserId: string,
    input: ValidatedReadUploadSessionInput,
    workspaceId?: string,
  ) {
    const parsed = readUploadSessionSchema.parse(input);
    const ownership = await workspaceService.resolveLegacyOwnership(
      actorUserId,
      workspaceId,
    );
    await workspaceService.requireActor(
      actorUserId,
      ownership.workspaceId,
      "processing.consume",
    );
    const result = await productionUploadSessionModule.status({
      actorUserId,
      workspaceId: ownership.workspaceId,
      clientIdempotencyKey: parsed.clientIdempotencyKey,
      sessionId: parsed.sessionId,
      browserFingerprint: parsed.browserFingerprint,
    });
    console.warn(
      JSON.stringify({
        level: "info",
        message: "upload_session_resumed",
        uploadSessionId: result.sessionId,
        workspaceId: ownership.workspaceId,
        state: result.outcome,
        terminalOutcome:
          result.outcome === "terminal"
            ? result.state
            : result.outcome === "queued_for_ingest"
              ? "queued_for_ingest"
              : null,
      }),
    );
    return result;
  }

  async discard(
    actorUserId: string,
    input: ValidatedDiscardUploadSessionInput,
    workspaceId?: string,
  ) {
    const parsed = discardUploadSessionSchema.parse(input);
    const ownership = await workspaceService.resolveLegacyOwnership(
      actorUserId,
      workspaceId,
    );
    await workspaceService.requireActor(
      actorUserId,
      ownership.workspaceId,
      "processing.consume",
    );
    const result = await productionUploadSessionModule.discard({
      actorUserId,
      workspaceId: ownership.workspaceId,
      sessionId: parsed.sessionId,
    });
    console.warn(
      JSON.stringify({
        level: "info",
        message: "upload_session_discarded",
        uploadSessionId: result.sessionId,
        workspaceId: ownership.workspaceId,
        state: result.outcome,
        terminalOutcome: result.outcome === "discarded" ? "aborted" : null,
      }),
    );
    return result;
  }

  async reconcileDueSessions() {
    return productionUploadSessionModule.reconcileDueSessions();
  }
}

export const uploadSessionService = new UploadSessionService();
