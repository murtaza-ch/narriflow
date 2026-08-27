import { randomUUID } from "node:crypto";
import { Prisma, type UploadSession as PrismaUploadSession } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  contentPackSchema,
  isProcessingQuotaExceeded,
  MONTHLY_PROCESSING_MINUTE_LIMITS,
  finalizeUploadSessionSchema,
  openUploadSessionSchema,
  processingMinutesFromSeconds,
  resolvePricingTier,
  uploadMimeTypes,
  type OpenUploadSessionInput as ValidatedOpenUploadSessionInput,
  type FinalizeUploadSessionInput as ValidatedFinalizeUploadSessionInput,
} from "@narriflow/validators";
import { brandTemplateService } from "./brand-template.service";
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
  readonly uploadGrantTtlSeconds: number;
  readonly sessionIdleMs: number;
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
    uploadGrantTtlSeconds: 15 * 60,
    sessionIdleMs: 24 * 60 * 60 * 1000,
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
  return Object.freeze(config);
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
  queuedJobId: string | null;
  failureCode: string | null;
  cleanupRetryAt: Date | null;
  status: UploadSessionStatus;
  expiresAt: Date;
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
  beginFinalization(input: {
    sessionId: string;
    parts: Array<{ partNumber: number; etag: string }>;
    updatedAt: Date;
  }): Promise<{ claimed: boolean; session: UploadSessionRecord }>;
  waitForFinalization(sessionId: string): Promise<UploadSessionRecord>;
  handoff(input: {
    sessionId: string;
    queuedJobId: string;
    verifiedSizeBytes: number;
    verifiedContentType: string;
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
  }): Promise<void>;
  listMultipartParts(input: {
    storageKey: string;
    providerUploadId: string;
  }): Promise<Array<{ partNumber: number; etag: string }>>;
  headExactObject(storageKey: string): Promise<{
    sizeBytes: number;
    contentType: string | null;
  }>;
  headExactObjectIfExists(storageKey: string): Promise<{
    sizeBytes: number;
    contentType: string | null;
  } | null>;
  listExactKeyMultipartUploads(storageKey: string): Promise<
    Array<{ providerUploadId: string; initiatedAt: Date | null }>
  >;
  abortMultipart(input: {
    storageKey: string;
    providerUploadId: string;
  }): Promise<void>;
  deleteExactObject(storageKey: string): Promise<void>;
}

export interface UploadSessionAdmission {
  assertQuota(workspaceId: string): Promise<void>;
  resolveBrand(input: {
    workspaceId: string;
    actorUserId: string;
    legacyOwnerUserId: string;
    brandTemplateId: string | null;
  }): Promise<{ templateId: string; snapshot: unknown } | null>;
}

export interface UploadSessionModuleDependencies {
  config: UploadSessionConfig;
  persistence: UploadSessionPersistence;
  storage: UploadSessionStorage;
  admission: UploadSessionAdmission;
  now(): Date;
  createId(): string;
  diagnose?(event: {
    phase:
      | "reservation"
      | "provider_creation"
      | "provider_bind"
      | "adoption"
      | "duplicate_abort"
      | "compensation";
    disposition: "started" | "succeeded" | "failed";
    sessionId: string;
  }): void;
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
  generation: unknown;
}

export type OpenUploadSessionOutcome =
  | {
      outcome: "queued_for_ingest";
      sessionId: string;
      projectId: string;
      queuedJobId: string;
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
        completedParts: Array<{ partNumber: number; etag: string }>;
        };
    };

export interface FinalizeUploadSessionInput {
  actorUserId: string;
  workspaceId: string;
  sessionId: string;
  parts: Array<{ partNumber: number; etag: string }>;
}

export type FinalizeUploadSessionOutcome = {
  outcome: "queued_for_ingest";
  sessionId: string;
  projectId: string;
  queuedJobId: string;
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
    generation: input.generation,
  });
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

export function createUploadSessionModule(
  dependencies: UploadSessionModuleDependencies,
) {
  const diagnose = (
    sessionId: string,
    phase: Parameters<NonNullable<typeof dependencies.diagnose>>[0]["phase"],
    disposition: Parameters<
      NonNullable<typeof dependencies.diagnose>
    >[0]["disposition"],
  ) => dependencies.diagnose?.({ sessionId, phase, disposition });

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
  ) {
    diagnose(session.id, "compensation", "started");
    await dependencies.persistence.recordFailure({
      sessionId: session.id,
      status: "compensating",
      failureCode,
      updatedAt: dependencies.now(),
    });
    try {
      await dependencies.storage.deleteExactObject(session.storageKey);
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
  ): Promise<FinalizeUploadSessionOutcome> {
    if (object.sizeBytes !== session.fileSizeBytes) {
      await compensateObject(session, "upload_object_size_mismatch");
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
      await compensateObject(session, "upload_object_content_type_mismatch");
      throw new UploadSessionIntegrityError(
        "Uploaded object content type does not match the declared source.",
      );
    }
    const queued = await dependencies.persistence.handoff({
      sessionId: session.id,
      queuedJobId: dependencies.createId(),
      verifiedSizeBytes: object.sizeBytes,
      verifiedContentType,
      updatedAt: dependencies.now(),
    });
    return {
      outcome: "queued_for_ingest",
      sessionId: queued.id,
      projectId: queued.preallocatedProjectId,
      queuedJobId: queued.queuedJobId!,
    };
  }

  async function waitForQueuedHandoff(sessionId: string) {
    const settled = await dependencies.persistence.waitForFinalization(sessionId);
    if (settled.status === "queued_for_ingest" && settled.queuedJobId) {
      return {
        outcome: "queued_for_ingest" as const,
        sessionId: settled.id,
        projectId: settled.preallocatedProjectId,
        queuedJobId: settled.queuedJobId,
      };
    }
    throw new UploadSessionInvalidStateError(
      "Upload Session finalization is still reconciling.",
    );
  }

  async function cleanupMultipartDuplicates(
    session: UploadSessionRecord,
    knownCandidates?: Array<{
      providerUploadId: string;
      initiatedAt: Date | null;
    }>,
  ) {
    if (!session.providerUploadId) {
      throw new Error("Upload Session provider binding is incomplete");
    }
    const candidates =
      knownCandidates ??
      (await dependencies.storage.listExactKeyMultipartUploads(
        session.storageKey,
      ));
    const losingProviderIds = new Set(
      candidates
        .map((candidate) => candidate.providerUploadId)
        .filter((providerUploadId) => providerUploadId !== session.providerUploadId),
    );
    const aborts = await Promise.allSettled(
      Array.from(losingProviderIds).map(async (providerUploadId) => {
        await dependencies.storage.abortMultipart({
          storageKey: session.storageKey,
          providerUploadId,
        });
        diagnose(session.id, "duplicate_abort", "succeeded");
      }),
    );
    if (aborts.some((abort) => abort.status === "rejected")) {
      await dependencies.persistence.recordCleanupRetry({
        sessionId: session.id,
        failureCode: "duplicate_upload_cleanup_failed",
        cleanupRetryAt: new Date(dependencies.now().getTime() + 60_000),
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
    if (session.transferKind === "single") {
      const grant = await dependencies.storage.grantSinglePut({
        storageKey: session.storageKey,
        contentType: session.contentType,
        expiresInSeconds: dependencies.config.uploadGrantTtlSeconds,
      });
      return {
        outcome: "uploading",
        sessionId: session.id,
        projectId: session.preallocatedProjectId,
        expiresAt: session.expiresAt.toISOString(),
        transfer: {
          kind: "single",
          contentType: session.contentType,
          grant: { url: grant.url, contentType: session.contentType },
        },
      };
    }
    if (!session.providerUploadId) {
      throw new Error("Upload Session provider binding is incomplete");
    }
    const completedParts =
      knownCompletedParts ??
      (await dependencies.storage.listMultipartParts({
        storageKey: session.storageKey,
        providerUploadId: session.providerUploadId,
      }));
    const completedPartNumbers = new Set(
      completedParts.map((part) => part.partNumber),
    );
    const partNumbers = Array.from(
      { length: session.partCount },
      (_, index) => index + 1,
    ).filter((partNumber) => !completedPartNumbers.has(partNumber));
    const grants = await dependencies.storage.grantMultipartParts({
      storageKey: session.storageKey,
      providerUploadId: session.providerUploadId,
      partNumbers,
      expiresInSeconds: dependencies.config.uploadGrantTtlSeconds,
    });
    return {
      outcome: "uploading",
      sessionId: session.id,
      projectId: session.preallocatedProjectId,
      expiresAt: session.expiresAt.toISOString(),
      transfer: {
        kind: "multipart",
        partSizeBytes: session.partSizeBytes!,
        partCount: session.partCount,
        concurrency: dependencies.config.multipartConcurrency,
        grants,
        completedParts,
      },
    };
  }

  async function recoverInitiatingSession(session: UploadSessionRecord) {
    let prepared = session;
    const admissionAttemptId = admissionAttemptIdFor(prepared);
    if (!prepared.admissionPreparedAt) {
      try {
        await dependencies.admission.assertQuota(prepared.workspaceId);
        const brand = await dependencies.admission.resolveBrand({
          workspaceId: prepared.workspaceId,
          actorUserId: prepared.actorUserId,
          legacyOwnerUserId: prepared.legacyOwnerUserId,
          brandTemplateId: prepared.brandTemplateId,
        });
        prepared = await dependencies.persistence.prepareAdmission({
          sessionId: prepared.id,
          admissionAttemptId,
          brandTemplateId: brand?.templateId ?? null,
          brandSnapshot: brand?.snapshot ?? null,
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
      candidates =
        await dependencies.storage.listExactKeyMultipartUploads(
          prepared.storageKey,
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
      const created = await dependencies.storage.createMultipart({
        storageKey: prepared.storageKey,
        contentType: prepared.contentType,
        metadata: {
          upload_session_id: prepared.id,
          file_name: prepared.fileName,
        },
      });
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
    await cleanupMultipartDuplicates(bound, [
      ...ordered,
      ...(ordered.some(
        (candidate) => candidate.providerUploadId === adopted.providerUploadId,
      )
        ? []
        : [adopted]),
    ]);
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
                updatedAt: dependencies.now(),
              });
            if (!finalization.claimed) {
              return waitForQueuedHandoff(active.id);
            }
            return handoffVerifiedObject(finalization.session, object);
          }
        }
        return uploadingOutcome(active);
      };
      const existing = await dependencies.persistence.findByClientKey({
        workspaceId: input.workspaceId,
        clientIdempotencyKey: input.clientIdempotencyKey,
      });
      if (existing) {
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
      const reservation = await dependencies.persistence.reserve({
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
        brandTemplateId: input.brandTemplateId,
        brandSnapshot: null,
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
        queuedJobId: null,
        failureCode: null,
        cleanupRetryAt: null,
        status: "initiating",
        expiresAt: new Date(now.getTime() + dependencies.config.sessionIdleMs),
        createdAt: now,
        updatedAt: now,
      });
      if (!reservation.created) {
        return resumeExisting(reservation.session);
      }
      diagnose(reservation.session.id, "reservation", "succeeded");

      if (!normalizeUploadContentType(input.source.contentType)) {
        await dependencies.persistence.recordFailure({
          sessionId: reservation.session.id,
          admissionAttemptId: admissionAttemptIdFor(reservation.session),
          status: "failed",
          failureCode: "unsupported_media_type",
          updatedAt: dependencies.now(),
        });
        throw new Error("Unsupported upload content type");
      }

      let prepared: UploadSessionRecord;
      const admissionAttemptId = admissionAttemptIdFor(reservation.session);
      try {
        await dependencies.admission.assertQuota(input.workspaceId);
        const brand = await dependencies.admission.resolveBrand({
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          legacyOwnerUserId: input.legacyOwnerUserId,
          brandTemplateId: input.brandTemplateId,
        });
        prepared = await dependencies.persistence.prepareAdmission({
          sessionId: reservation.session.id,
          admissionAttemptId,
          brandTemplateId: brand?.templateId ?? null,
          brandSnapshot: brand?.snapshot ?? null,
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
          failureCode:
            error instanceof UploadSessionQuotaRefusedError
              ? "quota_exceeded"
              : "upload_admission_failed",
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
        return waitForQueuedHandoff(current.id);
      }
      if (current.status !== "uploading") {
        throw new UploadSessionInvalidStateError();
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
        updatedAt: dependencies.now(),
      });
      if (!finalization.claimed) {
        return waitForQueuedHandoff(current.id);
      }
      const finalizing = finalization.session;
      if (finalizing.transferKind === "multipart") {
        if (!finalizing.providerUploadId) {
          throw new Error("Upload Session provider binding is incomplete");
        }
        await dependencies.storage.completeMultipart({
          storageKey: finalizing.storageKey,
          providerUploadId: finalizing.providerUploadId,
          parts,
        });
      }
      let object: { sizeBytes: number; contentType: string | null };
      try {
        object = await dependencies.storage.headExactObject(
          finalizing.storageKey,
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
        await dependencies.persistence.recordFailure({
          sessionId: finalizing.id,
          status: "failed",
          failureCode,
          updatedAt: dependencies.now(),
        });
        throw new UploadSessionIntegrityError(
          "Uploaded object could not be verified.",
        );
      }
      return handoffVerifiedObject(finalizing, object);
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
    uploadGrantTtlSeconds: configuredInteger(
      env,
      "UPLOAD_GRANT_TTL_SECONDS",
      15 * 60,
      { minimum: 60, maximum: 60 * 60 },
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
  if (!Array.isArray(value)) return null;
  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.partNumber !== "number" ||
      typeof item.etag !== "string"
    ) {
      return null;
    }
    parts.push({ partNumber: item.partNumber, etag: item.etag });
  }
  return parts;
}

function fromPrismaUploadSession(row: PrismaUploadSession): UploadSessionRecord {
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
    generation: row.generationSettings,
    transferKind: row.transferKind,
    partSizeBytes: row.partSizeBytes,
    partCount: row.partCount,
    storageKey: row.storageKey,
    providerUploadId: row.providerUploadId,
    admissionAttemptId: row.admissionAttemptId,
    admissionClaimExpiresAt: row.admissionClaimExpiresAt,
    admissionPreparedAt: row.admissionPreparedAt,
    completionParts: completionPartsFromJson(row.completionParts),
    queuedJobId: row.queuedJobId,
    failureCode: row.failureCode,
    cleanupRetryAt: row.cleanupRetryAt,
    status: row.status,
    expiresAt: row.expiresAt,
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
          brandSnapshot: Prisma.JsonNull,
          generationSettings: record.generation as Prisma.InputJsonValue,
          transferKind: record.transferKind,
          partSizeBytes: record.partSizeBytes,
          partCount: record.partCount,
          storageKey: record.storageKey,
          status: "initiating",
          admissionAttemptId: record.admissionAttemptId,
          admissionClaimExpiresAt: new Date(record.createdAt.getTime() + 30_000),
          expiresAt: record.expiresAt,
          hardExpiresAt: new Date(
            record.createdAt.getTime() + 6 * 24 * 60 * 60 * 1000,
          ),
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
  async beginFinalization({ sessionId, parts, updatedAt }) {
    const updated = await requiredPrisma().uploadSession.updateMany({
      where: { id: sessionId, status: "uploading" },
      data: {
        status: "finalizing",
        completionParts: parts as Prisma.InputJsonValue,
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
  async waitForFinalization(sessionId) {
    return waitForSessionState(
      sessionId,
      (session) => session.status !== "finalizing",
    );
  },
  async handoff({
    sessionId,
    queuedJobId,
    verifiedSizeBytes,
    verifiedContentType,
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
    const retention = await projectRetentionService.assignmentForWorkspace(
      initial.workspaceId,
      initial.createdAt,
    );

    try {
      const settled = await requiredPrisma().$transaction(async (tx) => {
        const current = await tx.uploadSession.findUnique({
          where: { id: sessionId },
        });
        if (!current) throw new Error("Upload Session not found");
        if (current.status === "queued_for_ingest") return current;
        if (current.status !== "finalizing") {
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
            retentionPolicyKey: retention?.retentionPolicyKey ?? null,
            expiresAt: retention?.expiresAt ?? null,
            workflowEventSeq: 1,
            createdAt: current.createdAt,
          },
        });
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
        return tx.uploadSession.update({
          where: { id: current.id },
          data: {
            status: "queued_for_ingest",
            verifiedSizeBytes: BigInt(verifiedSizeBytes),
            verifiedContentType,
            queuedJobId,
            queuedAt: updatedAt,
            updatedAt,
          },
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
        ...(admissionAttemptId ? { admissionAttemptId } : {}),
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
    if (updated.count !== 1 && admissionAttemptId) {
      throw new UploadSessionAdmissionClaimLostError();
    }
    return fromPrismaUploadSession(row);
  },
  async recordCleanupRetry({
    sessionId,
    failureCode,
    cleanupRetryAt,
    updatedAt,
  }) {
    const row = await requiredPrisma().uploadSession.update({
      where: { id: sessionId },
      data: { failureCode, cleanupRetryAt, updatedAt },
    });
    return fromPrismaUploadSession(row);
  },
};

function isMissingMultipartUpload(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown; Code?: unknown };
  return [candidate.name, candidate.code, candidate.Code].some(
    (value) => value === "NoSuchUpload" || value === "NotFound",
  );
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
  async createMultipart({ storageKey, contentType, metadata }) {
    const created = await createMultipartUpload({
      key: storageKey,
      contentType,
      metadata,
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
  async completeMultipart({ storageKey, providerUploadId, parts }) {
    await completeMultipartUpload({
      key: storageKey,
      uploadId: providerUploadId,
      etags: parts,
    });
  },
  async listMultipartParts({ storageKey, providerUploadId }) {
    return listUploadedParts({
      key: storageKey,
      uploadId: providerUploadId,
    });
  },
  async headExactObject(storageKey) {
    try {
      const object = await headObject(storageKey);
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
  async headExactObjectIfExists(storageKey) {
    try {
      return await this.headExactObject(storageKey);
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
  async listExactKeyMultipartUploads(storageKey) {
    try {
      return (await listExactKeyMultipartUploads({ key: storageKey })).map(
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
  async abortMultipart({ storageKey, providerUploadId }) {
    try {
      await abortMultipartUpload({
        key: storageKey,
        uploadId: providerUploadId,
      });
    } catch (error) {
      if (!isMissingMultipartUpload(error)) throw error;
    }
  },
  async deleteExactObject(storageKey) {
    await deleteObject(storageKey);
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
  const tier = resolvePricingTier(workspace?.pricingTier ?? null);
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
      return brandTemplateService.resolveSnapshotForUser(
        input.legacyOwnerUserId,
        input.brandTemplateId,
        {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
        },
      );
    },
  },
  now: () => new Date(),
  createId: randomUUID,
  diagnose(event) {
    console.warn(
      JSON.stringify({
        level: event.disposition === "failed" ? "warn" : "info",
        message: "upload_session_transition",
        uploadSessionId: event.sessionId,
        phase: event.phase,
        disposition: event.disposition,
      }),
    );
  },
});

export class UploadSessionService {
  async open(
    actorUserId: string,
    input: ValidatedOpenUploadSessionInput,
    workspaceId?: string,
  ) {
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
      }),
    );
    return result;
  }

  async finalize(
    actorUserId: string,
    input: ValidatedFinalizeUploadSessionInput,
    workspaceId?: string,
  ) {
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
      }),
    );
    return result;
  }
}

export const uploadSessionService = new UploadSessionService();
