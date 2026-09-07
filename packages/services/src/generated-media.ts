import { createHash } from "node:crypto";
import { generationAccessForTier } from "./generation-usage";
import type { BrandActorScope } from "./brand-ownership";
import { workspaceAllowsCapability } from "@narriflow/validators";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

export type GeneratedMediaJobStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled";
export type GeneratedMediaUsageStatus = "reserved" | "finalized" | "released";
export type GeneratedMediaPromptOrigin = "transcript_selection" | "broll_cue" | "manual";
export type GeneratedImageAspectRatio = "9:16" | "16:9" | "1:1";
export type GeneratedImageStyle = "editorial" | "cinematic" | "photoreal" | "illustration";

export interface GeneratedMediaAsset {
  id: string;
  title: string;
  kind: "image";
  contentType: "image/png" | "image/jpeg" | "image/webp";
  sizeBytes: number;
  width: number;
  height: number;
  durationSec: null;
  fingerprint: string;
  provenance: "generated";
  accessUrl: string | null;
  replayed: boolean;
  createdAt: string;
}

export interface CreateGeneratedMediaInput {
  projectId: string;
  clipId?: string | null;
  idempotencyKey: string;
  prompt: string;
  promptOrigin: GeneratedMediaPromptOrigin;
  aspectRatio: GeneratedImageAspectRatio;
  style: GeneratedImageStyle;
  sourceStartSec?: number | null;
  sourceEndSec?: number | null;
  sourceCueAtSec?: number | null;
}

export type GeneratedImageProviderOutcome =
  | { kind: "waiting"; providerRef: string }
  | {
      kind: "completed";
      providerRef: string;
      usage: { images: number };
      result?: {
        contentType: "image/png" | "image/jpeg" | "image/webp";
        bytes?: Uint8Array;
        url?: string;
      };
    }
  | { kind: "rejected"; code: string }
  | { kind: "failed"; code: string; retryable: boolean; retryAfterMs?: number }
  | { kind: "cancelled" };

export interface GeneratedImageProvider {
  readonly name?: string;
  readonly modelAlias?: string;
  submit(input: {
    requestId: string;
    prompt: string;
    aspectRatio: GeneratedImageAspectRatio;
    style: GeneratedImageStyle;
  }): Promise<GeneratedImageProviderOutcome>;
  poll(providerRef: string): Promise<GeneratedImageProviderOutcome>;
  cancel(providerRef: string): Promise<{ kind: "cancelled" } | { kind: "waiting" }>;
  result(providerRef: string): Promise<{
    contentType: "image/png" | "image/jpeg" | "image/webp";
    bytes?: Uint8Array;
    url?: string;
  }>;
}

export interface GeneratedMediaPublisher {
  publish(input: {
    jobId: string;
    attempt: number;
    scope: BrandActorScope;
    title: string;
    result?: Awaited<ReturnType<GeneratedImageProvider["result"]>>;
    resultContentType: GeneratedMediaAsset["contentType"];
  }): Promise<GeneratedMediaAsset>;
}

export interface GenerationUsageLedger {
  reserve(input: {
    jobId: string;
    workspaceId: string;
    actorUserId: string;
    policy: "trial_metered" | "metered";
    pricingTier: string;
  }): Promise<{ reservationId: string }>;
  finalize(input: { jobId: string; reservationId: string; images: number }): Promise<void>;
  release(input: { jobId: string; reservationId: string; reason: string }): Promise<void>;
}

export interface GeneratedMediaPromptProtection {
  protect(value: string): string;
  reveal(value: string): string;
  fingerprint(value: string): string;
}

export interface GeneratedMediaJobRecord {
  id: string;
  scope: BrandActorScope;
  projectId: string;
  clipId: string | null;
  mediaKind: "image";
  idempotencyKey: string;
  requestFingerprint: string;
  protectedPrompt: string;
  promptFingerprint: string;
  promptOrigin: GeneratedMediaPromptOrigin;
  sourceStartSec: number | null;
  sourceEndSec: number | null;
  sourceCueAtSec: number | null;
  aspectRatio: GeneratedImageAspectRatio;
  style: GeneratedImageStyle;
  title: string;
  status: GeneratedMediaJobStatus;
  moderationStatus: "pending" | "approved" | "rejected";
  usageStatus: GeneratedMediaUsageStatus;
  usageReservationId: string;
  provider: string;
  providerModel: string;
  providerRef: string | null;
  providerUsageImages: number | null;
  providerResultContentType: GeneratedMediaAsset["contentType"] | null;
  resultAsset: GeneratedMediaAsset | null;
  attempt: number;
  retryAt: Date | null;
  claimId: string | null;
  claimExpiresAt: Date | null;
  errorCode: string | null;
  outcomeUnknown: boolean;
  insertedAt: Date | null;
  brandSavedAt: Date | null;
  promptExpiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface GeneratedMediaStore {
  findByIdempotency(workspaceId: string, idempotencyKey: string): Promise<GeneratedMediaJobRecord | null>;
  create(record: GeneratedMediaJobRecord): Promise<GeneratedMediaJobRecord>;
  get(id: string): Promise<GeneratedMediaJobRecord | null>;
  list(workspaceId: string, projectId: string, clipId?: string): Promise<GeneratedMediaJobRecord[]>;
  update(id: string, patch: Partial<GeneratedMediaJobRecord>): Promise<GeneratedMediaJobRecord>;
  updateClaimed(id: string, claimId: string, patch: Partial<GeneratedMediaJobRecord>): Promise<GeneratedMediaJobRecord>;
  renew(id: string, claimId: string, now: Date, leaseMs: number): Promise<boolean>;
  claim(id: string, claimId: string, now: Date, leaseMs: number): Promise<GeneratedMediaJobRecord | null>;
  due(now: Date, limit: number): Promise<string[]>;
}

export type GeneratedMediaReconciliation =
  | { kind: "completed"; providerRef: string; usageImages?: number }
  | { kind: "failed" | "rejected" | "cancelled"; code: string }
  | { kind: "retry" };

const generatedMediaJobFailureCatalog = {
  generated_media_cancellation_pending: "conflict",
  generated_media_claim_lost: "conflict",
  generated_media_concurrency_limit_reached: "rate_limited",
  generated_media_daily_limit_reached: "rate_limited",
  generated_media_entitlement_required: "forbidden",
  generated_media_forbidden: "forbidden",
  generated_media_idempotency_conflict: "conflict",
  generated_media_idempotency_invalid: "invalid",
  generated_media_job_not_found: "missing",
  generated_media_origin_not_found: "missing",
  generated_media_prompt_invalid: "invalid",
  generated_media_provider_result_unavailable: "unavailable",
  generated_media_reconciliation_not_required: "conflict",
  generated_media_reconciliation_required: "conflict",
  generated_media_source_cue_invalid: "unprocessable",
  generated_media_source_range_invalid: "unprocessable",
  generated_media_trial_limit_reached: "rate_limited",
  generated_media_result_not_found: "missing",
  generated_media_usage_reconciliation_required: "conflict",
} as const satisfies ExpectedDomainFailureCatalog<string>;

type GeneratedMediaJobFailureCode = keyof typeof generatedMediaJobFailureCatalog;

export class GeneratedMediaJobError extends ExpectedDomainFailureError<GeneratedMediaJobFailureCode> {
  constructor(code: GeneratedMediaJobFailureCode) {
    super({ code, kind: generatedMediaJobFailureCatalog[code], message: "The generated media request could not be completed" });
    this.name = "GeneratedMediaJobError";
  }
}

const generatedMediaProviderFailureCatalog = {
  generated_media_provider_malformed_output: "unavailable",
  generated_media_provider_not_configured: "unavailable",
  generated_media_provider_outcome_unknown: "unavailable",
  generated_media_provider_output_too_large: "unavailable",
  generated_media_provider_rate_limited: "rate_limited",
  generated_media_provider_result_unavailable: "unavailable",
  generated_media_provider_unavailable: "unavailable",
  generated_media_provider_validation: "unprocessable",
  generated_media_safety_rejected: "unprocessable",
  provider_outcome_unknown: "unavailable",
} as const satisfies ExpectedDomainFailureCatalog<string>;

type GeneratedMediaProviderFailureCode = keyof typeof generatedMediaProviderFailureCatalog;

export class GeneratedMediaProviderError extends ExpectedDomainFailureError<
  GeneratedMediaProviderFailureCode,
  { outcomeUnknown: boolean; retryable: boolean }
> {
  constructor(
    code: GeneratedMediaProviderFailureCode,
    options: { outcomeUnknown?: boolean; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super({
      code,
      kind: generatedMediaProviderFailureCatalog[code],
      message: "Image generation is temporarily unavailable",
      details: {
        outcomeUnknown: options.outcomeUnknown ?? false,
        retryable: options.retryable ?? false,
      },
      retryAfterSeconds: options.retryAfterMs ? options.retryAfterMs / 1_000 : undefined,
    });
    this.name = "GeneratedMediaProviderError";
  }
}

function requestFingerprint(input: CreateGeneratedMediaInput, protection: GeneratedMediaPromptProtection) {
  return protection.fingerprint(JSON.stringify({
    projectId: input.projectId,
    clipId: input.clipId ?? null,
    prompt: input.prompt,
    promptOrigin: input.promptOrigin,
    aspectRatio: input.aspectRatio,
    style: input.style,
    sourceStartSec: input.sourceStartSec ?? null,
    sourceEndSec: input.sourceEndSec ?? null,
    sourceCueAtSec: input.sourceCueAtSec ?? null,
  }));
}

export function generatedMediaPublicJob(record: GeneratedMediaJobRecord, replayed = false) {
  return {
    id: record.id,
    projectId: record.projectId,
    clipId: record.clipId,
    mediaKind: record.mediaKind,
    idempotencyKey: record.idempotencyKey,
    promptOrigin: record.promptOrigin,
    promptFingerprint: record.promptFingerprint,
    aspectRatio: record.aspectRatio,
    style: record.style,
    title: record.title,
    status: record.status,
    moderationStatus: record.moderationStatus,
    usageStatus: record.usageStatus,
    provider: record.provider,
    providerModel: record.providerModel,
    providerRef: record.providerRef,
    resultAsset: record.resultAsset,
    attempt: record.attempt,
    retryAt: record.retryAt?.toISOString() ?? null,
    errorCode: record.errorCode,
    outcomeUnknown: record.outcomeUnknown,
    inserted: record.insertedAt !== null,
    brandSaved: record.brandSavedAt !== null,
    replayed,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function createInMemoryGeneratedMediaStore(): GeneratedMediaStore {
  const rows = new Map<string, GeneratedMediaJobRecord>();
  return {
    async findByIdempotency(workspaceId, idempotencyKey) {
      return [...rows.values()].find((row) => row.scope.workspaceId === workspaceId && row.idempotencyKey === idempotencyKey) ?? null;
    },
    async create(record) {
      rows.set(record.id, structuredClone(record));
      return structuredClone(record);
    },
    async get(id) {
      const row = rows.get(id);
      return row ? structuredClone(row) : null;
    },
    async list(workspaceId, projectId, clipId) {
      return [...rows.values()]
        .filter((row) =>
          row.scope.workspaceId === workspaceId &&
          row.projectId === projectId &&
          (!clipId || row.clipId === clipId),
        )
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .map((row) => structuredClone(row));
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) throw new GeneratedMediaJobError("generated_media_job_not_found");
      const updated = { ...row, ...structuredClone(patch) };
      rows.set(id, updated);
      return structuredClone(updated);
    },
    async updateClaimed(id, claimId, patch) {
      const row = rows.get(id);
      if (!row || row.claimId !== claimId) throw new GeneratedMediaJobError("generated_media_claim_lost");
      const updated = { ...row, ...structuredClone(patch) };
      rows.set(id, updated);
      return structuredClone(updated);
    },
    async renew(id, claimId, now, leaseMs) {
      const row = rows.get(id);
      if (!row || row.claimId !== claimId || !row.claimExpiresAt || row.claimExpiresAt <= now) return false;
      rows.set(id, { ...row, claimExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now });
      return true;
    },
    async claim(id, claimId, now, leaseMs) {
      const row = rows.get(id);
      if (!row || ["completed", "failed", "rejected", "cancelled"].includes(row.status)) return null;
      if (row.retryAt && row.retryAt.getTime() > now.getTime()) return null;
      if (row.claimExpiresAt && row.claimExpiresAt.getTime() > now.getTime()) return null;
      const updated = {
        ...row,
        claimId,
        claimExpiresAt: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      };
      rows.set(id, updated);
      return structuredClone(updated);
    },
    async due(now, limit) {
      return [...rows.values()]
        .filter((row) =>
          !["completed", "failed", "rejected", "cancelled"].includes(row.status) &&
          (!row.retryAt || row.retryAt.getTime() <= now.getTime()) &&
          (!row.claimExpiresAt || row.claimExpiresAt.getTime() <= now.getTime()) &&
          !row.outcomeUnknown,
        )
        .slice(0, limit)
        .map((row) => row.id);
    },
  };
}

interface GeneratedMediaModuleDependencies {
  store: GeneratedMediaStore;
  provider: GeneratedImageProvider;
  publisher: GeneratedMediaPublisher;
  usage: GenerationUsageLedger;
  promptProtection: GeneratedMediaPromptProtection;
  authorizeOrigin?: (scope: BrandActorScope, input: CreateGeneratedMediaInput) => Promise<void>;
  authorizeAccess?: (scope: BrandActorScope) => Promise<void>;
  recordCompleted?: (input: {
    jobId: string;
    scope: BrandActorScope;
    assetId: string;
    aspectRatio: GeneratedImageAspectRatio;
  }) => Promise<void>;
  recordSettled?: (input: {
    jobId: string;
    scope: BrandActorScope;
    projectId: string;
    aspectRatio: GeneratedImageAspectRatio;
    status: "completed" | "failed" | "rejected" | "cancelled";
    providerAlias: string;
    modelAlias: string;
    latencyBucket: "under_10s" | "10_to_30s" | "30_to_90s" | "over_90s";
    retryCount: number;
    moderationOutcome: "pending" | "approved" | "rejected";
    usageUnits: number;
  }) => Promise<void>;
  ids?: () => string;
  now?: () => Date;
  maxAttempts?: number;
  maxPromptCharacters?: number;
}

function validateCreate(input: CreateGeneratedMediaInput, maxPromptCharacters: number) {
  if (input.idempotencyKey.trim().length < 8 || input.idempotencyKey.length > 160) {
    throw new GeneratedMediaJobError("generated_media_idempotency_invalid");
  }
  if (input.prompt.trim().length < 3 || input.prompt.length > maxPromptCharacters) {
    throw new GeneratedMediaJobError("generated_media_prompt_invalid");
  }
  if (
    input.promptOrigin === "transcript_selection" &&
    !(input.sourceStartSec != null && input.sourceEndSec != null && input.sourceEndSec > input.sourceStartSec)
  ) {
    throw new GeneratedMediaJobError("generated_media_source_range_invalid");
  }
  if (input.promptOrigin === "broll_cue" && input.sourceCueAtSec == null) {
    throw new GeneratedMediaJobError("generated_media_source_cue_invalid");
  }
}

export function createGeneratedMediaModule(dependencies: GeneratedMediaModuleDependencies) {
  const ids = dependencies.ids ?? (() => crypto.randomUUID());
  const now = dependencies.now ?? (() => new Date());
  const providerName = dependencies.provider.name ?? "openai";
  const providerModel = dependencies.provider.modelAlias ?? "configured";
  const maxAttempts = Number.isSafeInteger(dependencies.maxAttempts) && dependencies.maxAttempts! >= 1
    ? Math.min(10, dependencies.maxAttempts!)
    : 4;
  const maxPromptCharacters = Number.isSafeInteger(dependencies.maxPromptCharacters) && dependencies.maxPromptCharacters! >= 64
    ? Math.min(20_000, dependencies.maxPromptCharacters!)
    : 4_000;

  function latencyBucket(record: GeneratedMediaJobRecord) {
    const elapsedMs = Math.max(0, now().getTime() - record.createdAt.getTime());
    if (elapsedMs < 10_000) return "under_10s" as const;
    if (elapsedMs < 30_000) return "10_to_30s" as const;
    if (elapsedMs < 90_000) return "30_to_90s" as const;
    return "over_90s" as const;
  }

  async function recordSettled(record: GeneratedMediaJobRecord) {
    if (!dependencies.recordSettled || !["completed", "failed", "rejected", "cancelled"].includes(record.status)) {
      return;
    }
    await dependencies.recordSettled({
      jobId: record.id,
      scope: record.scope,
      projectId: record.projectId,
      aspectRatio: record.aspectRatio,
      status: record.status as "completed" | "failed" | "rejected" | "cancelled",
      providerAlias: record.provider,
      modelAlias: record.providerModel,
      latencyBucket: latencyBucket(record),
      retryCount: Math.max(0, record.attempt - 1),
      moderationOutcome: record.moderationStatus,
      usageUnits: record.providerUsageImages ?? 0,
    }).catch(() => undefined);
  }

  async function owned(id: string, scope?: BrandActorScope) {
    const record = await dependencies.store.get(id);
    if (!record || (scope && record.scope.workspaceId !== scope.workspaceId)) {
      throw new GeneratedMediaJobError("generated_media_job_not_found");
    }
    return record;
  }

  function persist(record: GeneratedMediaJobRecord, patch: Partial<GeneratedMediaJobRecord>) {
    return record.claimId
      ? dependencies.store.updateClaimed(record.id, record.claimId, patch)
      : dependencies.store.update(record.id, patch);
  }

  async function release(record: GeneratedMediaJobRecord, status: "failed" | "rejected" | "cancelled", code: string) {
    if (record.usageStatus === "reserved") {
      try {
        await dependencies.usage.release({
          jobId: record.id,
          reservationId: record.usageReservationId,
          reason: code,
        });
      } catch {
        return persist(record, {
          status: "waiting",
          outcomeUnknown: true,
          errorCode: "generated_media_usage_reconciliation_required",
          retryAt: null,
          updatedAt: now(),
        });
      }
    }
    const settled = await persist(record, {
      status,
      moderationStatus: status === "rejected" || code === "generated_media_safety_rejected"
        ? "rejected"
        : record.moderationStatus,
      usageStatus: "released",
      errorCode: code,
      outcomeUnknown: false,
      promptExpiresAt: new Date(now().getTime() + 30 * 24 * 60 * 60 * 1_000),
      updatedAt: now(),
    });
    await recordSettled(settled);
    return settled;
  }

  async function complete(record: GeneratedMediaJobRecord, outcome: Extract<GeneratedImageProviderOutcome, { kind: "completed" }>) {
    let current = record;
    if (!current.resultAsset) {
      let asset: GeneratedMediaAsset;
      let result = outcome.result;
      try {
        if (!result && !current.providerResultContentType) {
          result = await dependencies.provider.result(outcome.providerRef);
        }
        const resultContentType = result?.contentType ?? current.providerResultContentType;
        if (!resultContentType) {
          throw new GeneratedMediaJobError("generated_media_provider_result_unavailable");
        }
        current = await persist(current, {
          providerRef: outcome.providerRef,
          providerUsageImages: outcome.usage.images,
          providerResultContentType: resultContentType,
          updatedAt: now(),
        });
        asset = await dependencies.publisher.publish({
          jobId: current.id,
          attempt: current.attempt,
          scope: current.scope,
          title: current.title,
          result,
          resultContentType,
        });
      } catch (error) {
        const attemptUnavailable = (error as { code?: string }).code === "generated_media_attempt_unavailable";
        return persist(current, {
          status: attemptUnavailable ? "waiting" : "queued",
          providerRef: outcome.providerRef,
          providerUsageImages: outcome.usage.images,
          errorCode: attemptUnavailable
            ? "generated_media_publication_reconciliation_required"
            : "generated_media_publication_retrying",
          outcomeUnknown: attemptUnavailable,
          retryAt: attemptUnavailable ? null : new Date(now().getTime() + 5_000),
          updatedAt: now(),
        });
      }
      current = await persist(current, {
        providerRef: outcome.providerRef,
        providerUsageImages: outcome.usage.images,
        resultAsset: asset,
        updatedAt: now(),
      });
    }
    if (current.usageStatus === "reserved") {
      try {
        await dependencies.usage.finalize({
          jobId: current.id,
          reservationId: current.usageReservationId,
          images: current.providerUsageImages ?? outcome.usage.images,
        });
      } catch {
        return persist(current, {
          status: "waiting",
          outcomeUnknown: true,
          errorCode: "generated_media_usage_reconciliation_required",
          retryAt: null,
          updatedAt: now(),
        });
      }
      current = await persist(current, {
        usageStatus: "finalized",
        updatedAt: now(),
      });
    }
    const completed = await persist(current, {
      status: "completed",
      moderationStatus: "approved",
      errorCode: null,
      outcomeUnknown: false,
      promptExpiresAt: new Date(now().getTime() + 30 * 24 * 60 * 60 * 1_000),
      updatedAt: now(),
    });
    if (dependencies.recordCompleted && completed.resultAsset) {
      await dependencies.recordCompleted({
        jobId: completed.id,
        scope: completed.scope,
        assetId: completed.resultAsset.id,
        aspectRatio: completed.aspectRatio,
      }).catch(() => undefined);
    }
    await recordSettled(completed);
    return completed;
  }

  async function applyOutcome(
    record: GeneratedMediaJobRecord,
    outcome: GeneratedImageProviderOutcome,
    source: "submit" | "poll",
  ) {
    if (outcome.kind === "completed") return complete(record, outcome);
    if (outcome.kind === "rejected") return release(record, "rejected", outcome.code);
    if (outcome.kind === "cancelled") return release(record, "cancelled", "provider_cancelled");
    if (outcome.kind === "failed" && !outcome.retryable) return release(record, "failed", outcome.code);
    if (outcome.kind === "failed") {
      const nextAttempt = source === "poll" ? record.attempt + 1 : record.attempt;
      if (nextAttempt >= maxAttempts) {
        return release(record, "failed", "generated_media_retry_exhausted");
      }
      return persist(record, {
        status: source === "poll" ? "waiting" : "queued",
        attempt: nextAttempt,
        retryAt: new Date(now().getTime() + (outcome.retryAfterMs ?? 5_000)),
        errorCode: outcome.code,
        updatedAt: now(),
      });
    }
    return persist(record, {
      status: "waiting",
      providerRef: outcome.providerRef,
      retryAt: null,
      errorCode: null,
      updatedAt: now(),
    });
  }

  return {
    async create(scope: BrandActorScope, input: CreateGeneratedMediaInput) {
      validateCreate(input, maxPromptCharacters);
      if (!workspaceAllowsCapability({ role: scope.role, status: scope.status }, "content.edit")) {
        throw new GeneratedMediaJobError("generated_media_forbidden");
      }
      await dependencies.authorizeAccess?.(scope);
      const access = generationAccessForTier(scope.pricingTier, "image");
      if (!access.entitled) throw new GeneratedMediaJobError("generated_media_entitlement_required");
      await dependencies.authorizeOrigin?.(scope, input);
      const fingerprint = requestFingerprint(input, dependencies.promptProtection);
      const existing = await dependencies.store.findByIdempotency(scope.workspaceId, input.idempotencyKey);
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new GeneratedMediaJobError("generated_media_idempotency_conflict");
        }
        return generatedMediaPublicJob(existing, true);
      }

      const id = ids();
      const reservation = await dependencies.usage.reserve({
        jobId: id,
        workspaceId: scope.workspaceId,
        actorUserId: scope.actorUserId,
        policy: access.usage,
        pricingTier: scope.pricingTier,
      });
      const timestamp = now();
      let reservationReleased = false;
      try {
        const record = await dependencies.store.create({
          id,
          scope: structuredClone(scope),
          projectId: input.projectId,
          clipId: input.clipId ?? null,
          mediaKind: "image",
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          protectedPrompt: dependencies.promptProtection.protect(input.prompt.trim()),
          promptFingerprint: dependencies.promptProtection.fingerprint(input.prompt.trim()),
          promptOrigin: input.promptOrigin,
          sourceStartSec: input.sourceStartSec ?? null,
          sourceEndSec: input.sourceEndSec ?? null,
          sourceCueAtSec: input.sourceCueAtSec ?? null,
          aspectRatio: input.aspectRatio,
          style: input.style,
          title: `Generated ${input.style} frame`,
          status: "queued",
          moderationStatus: "pending",
          usageStatus: "reserved",
          usageReservationId: reservation.reservationId,
          provider: providerName,
          providerModel,
          providerRef: null,
          providerUsageImages: null,
          providerResultContentType: null,
          resultAsset: null,
          attempt: 0,
          retryAt: null,
          claimId: null,
          claimExpiresAt: null,
          errorCode: null,
          outcomeUnknown: false,
          insertedAt: null,
          brandSavedAt: null,
          promptExpiresAt: new Date(timestamp.getTime() + 30 * 24 * 60 * 60 * 1_000),
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        if (record.id !== id) {
          await dependencies.usage.release({
            jobId: id,
            reservationId: reservation.reservationId,
            reason: "generated_media_idempotency_race_lost",
          });
          reservationReleased = true;
          if (record.requestFingerprint !== fingerprint) {
            throw new GeneratedMediaJobError("generated_media_idempotency_conflict");
          }
          return generatedMediaPublicJob(record, true);
        }
        return generatedMediaPublicJob(record);
      } catch (error) {
        if (!reservationReleased) {
          await dependencies.usage.release({
            jobId: id,
            reservationId: reservation.reservationId,
            reason: "generated_media_admission_failed",
          });
        }
        throw error;
      }
    },

    async get(scope: BrandActorScope, id: string) {
      return generatedMediaPublicJob(await owned(id, scope));
    },

    async list(scope: BrandActorScope, projectId: string, clipId?: string) {
      return Promise.all((await dependencies.store.list(scope.workspaceId, projectId, clipId)).map((record) => generatedMediaPublicJob(record)));
    },

    async process(id: string) {
      let record = await owned(id);
      if (["failed", "rejected", "cancelled"].includes(record.status)) return generatedMediaPublicJob(record);
      if (record.status === "completed") return generatedMediaPublicJob(record);
      if (record.outcomeUnknown) return generatedMediaPublicJob(record);
      if (record.retryAt && record.retryAt.getTime() > now().getTime()) return generatedMediaPublicJob(record);

      const claimId = ids();
      const leaseMs = 5 * 60_000;
      const claimed = await dependencies.store.claim(id, claimId, now(), leaseMs);
      if (!claimed) return generatedMediaPublicJob(await owned(id));
      record = claimed;
      const heartbeat = setInterval(() => {
        void dependencies.store.renew(id, claimId, now(), leaseMs).catch(() => false);
      }, 60_000);

      try {
        if (record.resultAsset && record.usageStatus === "reserved") {
          const next = await complete(record, {
            kind: "completed",
            providerRef: record.providerRef ?? "published",
            usage: { images: record.providerUsageImages ?? 1 },
          });
          return generatedMediaPublicJob(await dependencies.store.updateClaimed(next.id, claimId, {
            claimId: null,
            claimExpiresAt: null,
            updatedAt: now(),
          }));
        }
        if (
          !record.resultAsset &&
          record.providerRef &&
          record.providerUsageImages != null &&
          record.providerResultContentType
        ) {
          const next = await complete(record, {
            kind: "completed",
            providerRef: record.providerRef,
            usage: { images: record.providerUsageImages },
          });
          return generatedMediaPublicJob(await dependencies.store.updateClaimed(next.id, claimId, {
            claimId: null,
            claimExpiresAt: null,
            updatedAt: now(),
          }));
        }
        if (record.status === "waiting" && record.providerRef) {
          const next = await applyOutcome(record, await dependencies.provider.poll(record.providerRef), "poll");
          return generatedMediaPublicJob(await dependencies.store.updateClaimed(next.id, claimId, { claimId: null, claimExpiresAt: null, updatedAt: now() }));
        }
        record = await dependencies.store.updateClaimed(record.id, claimId, {
          status: "running",
          attempt: record.attempt + 1,
          errorCode: null,
          updatedAt: now(),
        });
        const prompt = dependencies.promptProtection.reveal(record.protectedPrompt);
        const next = await applyOutcome(record, await dependencies.provider.submit({
          requestId: record.id,
          prompt,
          aspectRatio: record.aspectRatio,
          style: record.style,
        }), "submit");
        return generatedMediaPublicJob(await dependencies.store.updateClaimed(next.id, claimId, { claimId: null, claimExpiresAt: null, updatedAt: now() }));
      } catch (error) {
        if (error instanceof GeneratedMediaProviderError) {
          if (error.details?.outcomeUnknown) {
            return generatedMediaPublicJob(await dependencies.store.updateClaimed(record.id, claimId, {
              status: "waiting",
              outcomeUnknown: true,
              errorCode: error.code,
              claimId: null,
              claimExpiresAt: null,
              updatedAt: now(),
            }));
          }
          if (error.details?.retryable) {
            if (record.attempt >= maxAttempts) {
              const exhausted = await release(record, "failed", "generated_media_retry_exhausted");
              return generatedMediaPublicJob(await dependencies.store.updateClaimed(exhausted.id, claimId, {
                claimId: null,
                claimExpiresAt: null,
                updatedAt: now(),
              }));
            }
            return generatedMediaPublicJob(await dependencies.store.updateClaimed(record.id, claimId, {
              status: "queued",
              retryAt: new Date(
                now().getTime() + (error.retryAfterSeconds ?? 5) * 1_000,
              ),
              errorCode: error.code,
              claimId: null,
              claimExpiresAt: null,
              updatedAt: now(),
            }));
          }
          const terminalStatus = error.code === "generated_media_safety_rejected" ? "rejected" : "failed";
          const failed = await release(record, terminalStatus, error.code);
          return generatedMediaPublicJob(await dependencies.store.updateClaimed(failed.id, claimId, { claimId: null, claimExpiresAt: null, updatedAt: now() }));
        }
        throw error;
      } finally {
        clearInterval(heartbeat);
      }
    },

    async processDue(limit = 4) {
      const idsDue = await dependencies.store.due(now(), Math.max(1, Math.min(limit, 20)));
      return Promise.all(idsDue.map((id) => this.process(id)));
    },

    async reconcile(id: string, decision: GeneratedMediaReconciliation) {
      const record = await owned(id);
      if (!record.outcomeUnknown) {
        throw new GeneratedMediaJobError("generated_media_reconciliation_not_required");
      }
      if (decision.kind === "retry") {
        return generatedMediaPublicJob(await dependencies.store.update(id, {
          status: "queued",
          providerRef: null,
          providerUsageImages: null,
          providerResultContentType: null,
          outcomeUnknown: false,
          errorCode: null,
          retryAt: now(),
          updatedAt: now(),
        }));
      }
      if (decision.kind === "completed") {
        const ready = await dependencies.store.update(id, {
          status: "waiting",
          providerRef: decision.providerRef,
          providerUsageImages: decision.usageImages ?? 1,
          providerResultContentType: "image/png",
          outcomeUnknown: false,
          errorCode: null,
          updatedAt: now(),
        });
        return generatedMediaPublicJob(await complete(ready, {
          kind: "completed",
          providerRef: decision.providerRef,
          usage: { images: decision.usageImages ?? 1 },
        }));
      }
      return generatedMediaPublicJob(await release(
        record,
        decision.kind,
        decision.code,
      ));
    },

    async cancel(scope: BrandActorScope, id: string) {
      const record = await owned(id, scope);
      if (["completed", "failed", "rejected", "cancelled"].includes(record.status)) return generatedMediaPublicJob(record);
      if (record.outcomeUnknown) {
        throw new GeneratedMediaJobError("generated_media_reconciliation_required");
      }
      if (record.status === "running" || record.claimId) {
        throw new GeneratedMediaJobError("generated_media_cancellation_pending");
      }
      if (record.providerRef) {
        const outcome = await dependencies.provider.cancel(record.providerRef);
        if (outcome.kind === "waiting") return generatedMediaPublicJob(record);
      }
      return generatedMediaPublicJob(await release(record, "cancelled", "user_cancelled"));
    },
  };
}

export function sha256Fingerprint(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
