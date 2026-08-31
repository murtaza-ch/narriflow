import { createHash, randomUUID } from "node:crypto";
import {
  SOCIAL_PROVIDER_CAPABILITIES,
  type SocialProviderCapabilityPlatform,
} from "@narriflow/validators";

export interface ThumbnailExtractionScope {
  actorUserId: string;
  workspaceId: string;
  projectId: string;
}

export interface ThumbnailExportVariant {
  id: string;
  workspaceId: string;
  projectId: string;
  status: "pending" | "rendering" | "completed" | "failed";
  storageKey: string | null;
  durationSec: number | null;
  objectAvailable: boolean;
}

export interface ExtractedThumbnailAsset {
  id: string;
  workspaceId: string;
  createdByUserId: string;
  title: string;
  kind: "image";
  storageKey: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  sizeBytes: number;
  width: number;
  height: number;
  fingerprint: string;
  provenance: "extracted";
  sourceExportVariantId: string;
  sourceTimeMs: number;
  deletedAt: Date | null;
  createdAt: Date;
}

export type ThumbnailExtractionStatus = "queued" | "processing" | "completed" | "failed";

export interface ThumbnailExtractionRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  actorUserId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  platform: SocialProviderCapabilityPlatform;
  exportVariantId: string;
  sourceStorageKey: string;
  sourceTimeMs: number;
  title: string;
  status: ThumbnailExtractionStatus;
  attempts: number;
  claimId: string | null;
  claimExpiresAt: Date | null;
  assetId: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ThumbnailExtractionStore {
  readVariant(input: ThumbnailExtractionScope & { exportVariantId: string }): Promise<ThumbnailExportVariant | null>;
  reserve(record: ThumbnailExtractionRecord): Promise<{ record: ThumbnailExtractionRecord; created: boolean }>;
  claimNext(input: { now: Date }): Promise<ThumbnailExtractionRecord | null>;
  prepareOutput(input: {
    jobId: string;
    claimId: string;
    claimExpiresAt: Date;
    destinationStorageKey: string;
    now: Date;
  }): Promise<void>;
  complete(input: {
    jobId: string;
    claimId: string;
    asset: ExtractedThumbnailAsset;
    now: Date;
  }): Promise<ThumbnailExtractionRecord>;
  fail(input: {
    jobId: string;
    claimId: string;
    destinationStorageKey: string;
    errorCode: string;
    now: Date;
  }): Promise<ThumbnailExtractionRecord>;
  read(input: ThumbnailExtractionScope & { id: string }): Promise<{
    record: ThumbnailExtractionRecord;
    asset: ExtractedThumbnailAsset | null;
  } | null>;
  listLatest(input: ThumbnailExtractionScope & {
    platform: SocialProviderCapabilityPlatform;
    exportVariantIds: string[];
  }): Promise<Array<{
    record: ThumbnailExtractionRecord;
    asset: ExtractedThumbnailAsset | null;
  }>>;
  retry(input: ThumbnailExtractionScope & { id: string; now: Date }): Promise<ThumbnailExtractionRecord | null>;
}

export interface ThumbnailFrameProcessorResult {
  storageKey: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  sizeBytes: number;
  width: number;
  height: number;
  fingerprint: string;
}

export interface ThumbnailFrameProcessor {
  extract(input: {
    jobId: string;
    sourceStorageKey: string;
    sourceTimeSec: number;
    destinationStorageKey: string;
  }): Promise<ThumbnailFrameProcessorResult>;
}

export interface ThumbnailExtractionView {
  id: string;
  status: ThumbnailExtractionStatus;
  attempts: number;
  platform: SocialProviderCapabilityPlatform;
  exportVariantId: string;
  sourceTimeMs: number;
  errorCode: string | null;
  asset: Omit<ExtractedThumbnailAsset, "storageKey" | "deletedAt"> | null;
  replayed: boolean;
}

export class ThumbnailExtractionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ThumbnailExtractionError";
  }
}

export function thumbnailOutputStorageKey(
  job: Pick<ThumbnailExtractionRecord, "workspaceId" | "id" | "attempts">,
) {
  return `visual-assets/extracted/${job.workspaceId}/${job.id}/attempt-${job.attempts}.jpg`;
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function publicAsset(asset: ExtractedThumbnailAsset | null) {
  if (!asset) return null;
  const { storageKey: _storageKey, deletedAt: _deletedAt, ...safe } = asset;
  return safe;
}

function view(
  record: ThumbnailExtractionRecord,
  asset: ExtractedThumbnailAsset | null,
  replayed = false,
): ThumbnailExtractionView {
  if (record.assetId && (!asset || asset.deletedAt)) {
    throw new ThumbnailExtractionError(
      "thumbnail_asset_deleted",
      "The extracted thumbnail asset is no longer available",
    );
  }
  return {
    id: record.id,
    status: record.status,
    attempts: record.attempts,
    platform: record.platform,
    exportVariantId: record.exportVariantId,
    sourceTimeMs: record.sourceTimeMs,
    errorCode: record.errorCode,
    asset: publicAsset(asset),
    replayed,
  };
}

export function createThumbnailExtractionService(dependencies: {
  store: ThumbnailExtractionStore;
  processor: ThumbnailFrameProcessor;
  authorize(scope: ThumbnailExtractionScope): Promise<void>;
  authorizeRead?(scope: ThumbnailExtractionScope): Promise<void>;
  diagnostics?: (event: Record<string, unknown>) => void;
  createId?: () => string;
  now?: () => Date;
}) {
  const createId = dependencies.createId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());
  const diagnostics = dependencies.diagnostics ?? (() => undefined);

  return {
    async request(
      scope: ThumbnailExtractionScope,
      input: {
        idempotencyKey: string;
        platform: SocialProviderCapabilityPlatform;
        exportVariantId: string;
        sourceTimeSec: number;
        title: string;
      },
    ) {
      await dependencies.authorize(scope);
      const capability = SOCIAL_PROVIDER_CAPABILITIES[input.platform];
      if (!(capability.thumbnailTypes as readonly string[]).includes("video_frame")) {
        throw new ThumbnailExtractionError(
          "thumbnail_source_unsupported",
          "This destination does not accept a selected video frame",
        );
      }
      const variant = await dependencies.store.readVariant({
        ...scope,
        exportVariantId: input.exportVariantId,
      });
      if (!variant || variant.status !== "completed" || !variant.storageKey) {
        throw new ThumbnailExtractionError(
          "thumbnail_export_unavailable",
          "The immutable export is not ready for frame extraction",
        );
      }
      if (!variant.objectAvailable) {
        throw new ThumbnailExtractionError(
          "thumbnail_source_object_missing",
          "The immutable export object is missing",
        );
      }
      const sourceTimeMs = Math.round(input.sourceTimeSec * 1_000);
      if (
        !Number.isSafeInteger(sourceTimeMs) ||
        sourceTimeMs < 0 ||
        variant.durationSec === null ||
        sourceTimeMs >= Math.floor(variant.durationSec * 1_000)
      ) {
        throw new ThumbnailExtractionError(
          "thumbnail_frame_time_invalid",
          "Choose a frame inside the immutable export duration",
        );
      }
      const title = input.title.trim();
      if (!title || title.length > 160) {
        throw new ThumbnailExtractionError(
          "thumbnail_title_invalid",
          "Thumbnail titles must be between 1 and 160 characters",
        );
      }
      const requestFingerprint = fingerprint({
        contract: "thumbnail-extraction-v1",
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        platform: input.platform,
        exportVariantId: input.exportVariantId,
        sourceTimeMs,
        title,
      });
      const timestamp = now();
      const reservation = await dependencies.store.reserve({
        id: createId(),
        ...scope,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        platform: input.platform,
        exportVariantId: input.exportVariantId,
        sourceStorageKey: variant.storageKey,
        sourceTimeMs,
        title,
        status: "queued",
        attempts: 0,
        claimId: null,
        claimExpiresAt: null,
        assetId: null,
        errorCode: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      if (!reservation.created && reservation.record.requestFingerprint !== requestFingerprint) {
        throw new ThumbnailExtractionError(
          "thumbnail_idempotency_conflict",
          "The idempotency key was already used with different extraction inputs",
        );
      }
      const resolved = await dependencies.store.read({ ...scope, id: reservation.record.id });
      if (!resolved) throw new Error("Reserved thumbnail extraction could not be read");
      return view(resolved.record, resolved.asset, !reservation.created);
    },

    async processNext(): Promise<ThumbnailExtractionView | null> {
      const claimed = await dependencies.store.claimNext({ now: now() });
      if (!claimed) return null;
      const destinationStorageKey = thumbnailOutputStorageKey(claimed);
      try {
        if (!claimed.claimId || !claimed.claimExpiresAt) {
          throw new ThumbnailExtractionError(
            "thumbnail_claim_lost",
            "Thumbnail extraction ownership was lost",
          );
        }
        await dependencies.store.prepareOutput({
          jobId: claimed.id,
          claimId: claimed.claimId,
          claimExpiresAt: claimed.claimExpiresAt,
          destinationStorageKey,
          now: now(),
        });
        const output = await dependencies.processor.extract({
          jobId: claimed.id,
          sourceStorageKey: claimed.sourceStorageKey,
          sourceTimeSec: claimed.sourceTimeMs / 1_000,
          destinationStorageKey,
        });
        if (
          output.storageKey !== destinationStorageKey ||
          output.contentType !== "image/jpeg" ||
          output.width <= 0 ||
          output.height <= 0 ||
          output.sizeBytes <= 0 ||
          !/^[a-f0-9]{64}$/.test(output.fingerprint)
        ) {
          throw new ThumbnailExtractionError(
            "thumbnail_output_invalid",
            "The extracted thumbnail failed integrity checks",
          );
        }
        const settledAt = now();
        const completed = await dependencies.store.complete({
          jobId: claimed.id,
          claimId: claimed.claimId!,
          asset: {
            id: createId(),
            workspaceId: claimed.workspaceId,
            createdByUserId: claimed.actorUserId,
            title: claimed.title,
            kind: "image",
            ...output,
            provenance: "extracted",
            sourceExportVariantId: claimed.exportVariantId,
            sourceTimeMs: claimed.sourceTimeMs,
            deletedAt: null,
            createdAt: settledAt,
          },
          now: settledAt,
        });
        diagnostics({
          event: "thumbnail_extraction_completed",
          workspaceId: claimed.workspaceId,
          projectId: claimed.projectId,
          jobId: claimed.id,
          assetId: completed.assetId,
          platform: claimed.platform,
          attempts: completed.attempts,
        });
        const resolved = await dependencies.store.read({
          actorUserId: claimed.actorUserId,
          workspaceId: claimed.workspaceId,
          projectId: claimed.projectId,
          id: claimed.id,
        });
        if (!resolved) throw new Error("Completed thumbnail extraction could not be read");
        return view(resolved.record, resolved.asset);
      } catch (error) {
        const code =
          error instanceof ThumbnailExtractionError
            ? error.code
            : "thumbnail_extract_failed";
        const failed = await dependencies.store.fail({
          jobId: claimed.id,
          claimId: claimed.claimId!,
          destinationStorageKey,
          errorCode: code,
          now: now(),
        });
        diagnostics({
          event: "thumbnail_extraction_failed",
          workspaceId: claimed.workspaceId,
          projectId: claimed.projectId,
          jobId: claimed.id,
          platform: claimed.platform,
          attempts: failed.attempts,
          errorCode: code,
        });
        return view(failed, null);
      }
    },

    async retry(scope: ThumbnailExtractionScope, id: string) {
      await dependencies.authorize(scope);
      const record = await dependencies.store.retry({ ...scope, id, now: now() });
      if (!record) {
        throw new ThumbnailExtractionError(
          "thumbnail_retry_unavailable",
          "Only a failed thumbnail extraction can be retried",
        );
      }
      return view(record, null);
    },

    async get(scope: ThumbnailExtractionScope, id: string) {
      await (dependencies.authorizeRead ?? dependencies.authorize)(scope);
      const result = await dependencies.store.read({ ...scope, id });
      if (!result) {
        throw new ThumbnailExtractionError(
          "thumbnail_extraction_not_found",
          "The thumbnail extraction is unavailable",
        );
      }
      return view(result.record, result.asset);
    },

    async listLatest(
      scope: ThumbnailExtractionScope,
      input: {
        platform: SocialProviderCapabilityPlatform;
        exportVariantIds: string[];
      },
    ) {
      await (dependencies.authorizeRead ?? dependencies.authorize)(scope);
      const exportVariantIds = [...new Set(input.exportVariantIds)];
      if (exportVariantIds.length === 0 || exportVariantIds.length > 100) {
        throw new ThumbnailExtractionError(
          "thumbnail_extraction_query_invalid",
          "Choose between 1 and 100 exact exports",
        );
      }
      const results = await dependencies.store.listLatest({
        ...scope,
        platform: input.platform,
        exportVariantIds,
      });
      return results.map((result) => view(result.record, result.asset));
    },
  };
}

export function createInMemoryThumbnailExtractionStore(input: {
  variants: Array<Omit<ThumbnailExportVariant, "objectAvailable"> & { objectAvailable?: boolean }>;
}) {
  const variants = new Map(
    input.variants.map((variant) => [
      variant.id,
      { ...variant, objectAvailable: variant.objectAvailable ?? true },
    ]),
  );
  const jobs = new Map<string, ThumbnailExtractionRecord>();
  const unique = new Map<string, string>();
  const assets = new Map<string, ExtractedThumbnailAsset>();
  const outputObligations = new Map<
    string,
    {
      objectKey: string;
      claimId: string | null;
      claimExpiresAt: Date | null;
      status: "held" | "released" | "adopted";
    }
  >();
  const keyFor = (row: Pick<ThumbnailExtractionRecord, "workspaceId" | "projectId" | "idempotencyKey">) =>
    `${row.workspaceId}:${row.projectId}:${row.idempotencyKey}`;

  const store: ThumbnailExtractionStore & {
    setObjectAvailable(id: string, available: boolean): void;
    deleteAsset(id: string): void;
    outputObligations(): Array<{
      objectKey: string;
      claimId: string | null;
      claimExpiresAt: Date | null;
      status: "held" | "released" | "adopted";
    }>;
  } = {
    setObjectAvailable(id, available) {
      const variant = variants.get(id);
      if (variant) variants.set(id, { ...variant, objectAvailable: available });
    },
    deleteAsset(id) {
      const asset = assets.get(id);
      if (asset) assets.set(id, { ...asset, deletedAt: new Date() });
    },
    outputObligations() {
      return [...outputObligations.values()].map((entry) => structuredClone(entry));
    },
    async readVariant(query) {
      const variant = variants.get(query.exportVariantId);
      return variant &&
        variant.workspaceId === query.workspaceId &&
        variant.projectId === query.projectId
        ? structuredClone(variant)
        : null;
    },
    async reserve(record) {
      const key = keyFor(record);
      const existingId = unique.get(key);
      if (existingId) {
        const existing = jobs.get(existingId);
        if (!existing) throw new Error("Thumbnail in-memory store is inconsistent");
        return { record: structuredClone(existing), created: false };
      }
      jobs.set(record.id, structuredClone(record));
      unique.set(key, record.id);
      return { record: structuredClone(record), created: true };
    },
    async claimNext(claim) {
      for (const current of jobs.values()) {
        if (
          current.status !== "processing" ||
          !current.claimExpiresAt ||
          current.claimExpiresAt > claim.now
        ) {
          continue;
        }
        for (const [key, obligation] of outputObligations) {
          if (obligation.claimId === current.claimId && obligation.status === "held") {
            outputObligations.set(key, {
              ...obligation,
              claimId: null,
              claimExpiresAt: null,
              status: "released",
            });
          }
        }
        jobs.set(current.id, {
          ...current,
          status: current.attempts >= 3 ? "failed" : "queued",
          claimId: null,
          claimExpiresAt: null,
          errorCode: "thumbnail_claim_expired",
          updatedAt: claim.now,
        });
      }
      const candidate = [...jobs.values()]
        .filter((job) => job.status === "queued")
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0];
      if (!candidate) return null;
      const next = {
        ...candidate,
        status: "processing" as const,
        attempts: candidate.attempts + 1,
        claimId: randomUUID(),
        claimExpiresAt: new Date(claim.now.getTime() + 2 * 60_000),
        updatedAt: claim.now,
      };
      jobs.set(next.id, next);
      return structuredClone(next);
    },
    async prepareOutput(input) {
      const current = jobs.get(input.jobId);
      if (
        !current ||
        current.status !== "processing" ||
        current.claimId !== input.claimId ||
        !current.claimExpiresAt ||
        current.claimExpiresAt <= input.now ||
        current.claimExpiresAt.getTime() !== input.claimExpiresAt.getTime()
      ) {
        throw new ThumbnailExtractionError(
          "thumbnail_claim_lost",
          "Thumbnail extraction ownership was lost",
        );
      }
      const existing = outputObligations.get(input.destinationStorageKey);
      if (existing && existing.status !== "released" && existing.claimId !== input.claimId) {
        throw new ThumbnailExtractionError(
          "thumbnail_output_ownership_lost",
          "Thumbnail output cleanup ownership was lost",
        );
      }
      outputObligations.set(input.destinationStorageKey, {
        objectKey: input.destinationStorageKey,
        claimId: input.claimId,
        claimExpiresAt: input.claimExpiresAt,
        status: "held",
      });
    },
    async complete(update) {
      const current = jobs.get(update.jobId);
      if (!current || current.status !== "processing" || current.claimId !== update.claimId) {
        throw new ThumbnailExtractionError(
          "thumbnail_claim_lost",
          "Thumbnail extraction ownership was lost",
        );
      }
      const obligation = outputObligations.get(update.asset.storageKey);
      if (
        !obligation ||
        obligation.status !== "held" ||
        obligation.claimId !== update.claimId ||
        !obligation.claimExpiresAt ||
        obligation.claimExpiresAt <= update.now
      ) {
        throw new ThumbnailExtractionError(
          "thumbnail_output_ownership_lost",
          "Thumbnail output cleanup ownership was lost",
        );
      }
      assets.set(update.asset.id, structuredClone(update.asset));
      const next: ThumbnailExtractionRecord = {
        ...current,
        status: "completed",
        claimId: null,
        claimExpiresAt: null,
        assetId: update.asset.id,
        errorCode: null,
        updatedAt: update.now,
      };
      jobs.set(next.id, next);
      outputObligations.set(update.asset.storageKey, {
        ...obligation,
        claimId: null,
        claimExpiresAt: null,
        status: "adopted",
      });
      return structuredClone(next);
    },
    async fail(update) {
      const current = jobs.get(update.jobId);
      if (!current || current.status !== "processing" || current.claimId !== update.claimId) {
        throw new ThumbnailExtractionError(
          "thumbnail_claim_lost",
          "Thumbnail extraction ownership was lost",
        );
      }
      const next: ThumbnailExtractionRecord = {
        ...current,
        status: "failed",
        claimId: null,
        claimExpiresAt: null,
        errorCode: update.errorCode,
        updatedAt: update.now,
      };
      jobs.set(next.id, next);
      const obligation = outputObligations.get(update.destinationStorageKey);
      if (obligation?.claimId === update.claimId && obligation.status === "held") {
        outputObligations.set(update.destinationStorageKey, {
          ...obligation,
          claimId: null,
          claimExpiresAt: null,
          status: "released",
        });
      }
      return structuredClone(next);
    },
    async read(query) {
      const record = jobs.get(query.id);
      if (
        !record ||
        record.workspaceId !== query.workspaceId ||
        record.projectId !== query.projectId
      ) {
        return null;
      }
      const asset = record.assetId ? assets.get(record.assetId) ?? null : null;
      return {
        record: structuredClone(record),
        asset: asset ? structuredClone(asset) : null,
      };
    },
    async listLatest(query) {
      const requested = new Set(query.exportVariantIds);
      const latest = new Map<
        string,
        {
          record: ThumbnailExtractionRecord;
          asset: ExtractedThumbnailAsset | null;
        }
      >();
      for (const record of [...jobs.values()].sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          right.id.localeCompare(left.id),
      )) {
        if (
          record.workspaceId !== query.workspaceId ||
          record.projectId !== query.projectId ||
          record.platform !== query.platform ||
          !requested.has(record.exportVariantId) ||
          latest.has(record.exportVariantId)
        ) {
          continue;
        }
        const asset = record.assetId ? assets.get(record.assetId) ?? null : null;
        latest.set(record.exportVariantId, {
          record: structuredClone(record),
          asset: asset ? structuredClone(asset) : null,
        });
      }
      return [...latest.values()];
    },
    async retry(update) {
      const current = jobs.get(update.id);
      if (
        !current ||
        current.workspaceId !== update.workspaceId ||
        current.projectId !== update.projectId ||
        current.status !== "failed" ||
        current.attempts >= 3
      ) {
        return null;
      }
      const next: ThumbnailExtractionRecord = {
        ...current,
        status: "queued",
        claimId: null,
        claimExpiresAt: null,
        errorCode: null,
        updatedAt: update.now,
      };
      jobs.set(next.id, next);
      return structuredClone(next);
    },
  };
  return store;
}
