import { createHash } from "node:crypto";
import type { BrandActorScope } from "./brand-ownership";
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

/**
 * The Workspace generation count. This module only admits `image` requests;
 * a dub reserves and finalizes the same ledger inside its Workflow Run
 * transactions, always as one unit (see `generated-media-usage-ledger.ts`).
 */
export interface GenerationUsageLedger {
  reserve(input: {
    kind: "image";
    jobId: string;
    workspaceId: string;
    actorUserId: string;
    pricingTier: string;
  }): Promise<{ reservationId: string }>;
  /** Images record the provider's delivered image count; a dub always counts one. */
  finalize(
    input: { jobId: string; reservationId: string } & ({ kind: "image"; images: number } | { kind: "dub" }),
  ): Promise<void>;
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

export type GeneratedMediaReconciliation =
  | { kind: "completed"; providerRef: string; usageImages?: number }
  | { kind: "failed" | "rejected" | "cancelled"; code: string }
  | { kind: "retry" };

const generatedMediaJobFailureCatalog = {
  generated_media_cancellation_pending: "conflict",
  generated_media_claim_lost: "conflict",
  generated_media_concurrency_limit_reached: "rate_limited",
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


export function sha256Fingerprint(value:string|Uint8Array){return createHash("sha256").update(value).digest("hex");}
