import { createHash } from "node:crypto";
import {
  SOCIAL_PROVIDER_CAPABILITIES,
  type SocialPlatform,
} from "@narriflow/validators";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

export type ThumbnailSourceKind = "uploaded" | "generated" | "extracted_frame";

export type ThumbnailSelection = {
  assetId: string;
  fingerprint: string;
  source: ThumbnailSourceKind;
  sourceTimeMs: number | null;
};

export type PreparedThumbnailSettings = {
  thumbnailType: "custom_image" | "video_frame";
  thumbnailAssetId: string;
  thumbnailFingerprint: string;
  thumbnailSource: ThumbnailSourceKind;
  videoCoverTimestampMs?: number;
};

export type ThumbnailFrameAsset = {
  id: string;
  fingerprint: string;
  deleted: boolean;
};

export type ThumbnailFrameRecord = {
  id: string;
  actorUserId: string;
  workspaceId: string;
  projectId: string;
  clipId: string;
  exportVariantId: string;
  sourceTimeMs: number;
  idempotencyKey: string;
  requestFingerprint: string;
  exportFingerprint: string;
  status: "queued" | "processing" | "completed" | "failed";
  attempt: number;
  claimId: string | null;
  claimExpiresAt: Date | null;
  errorCode: string | null;
  asset: ThumbnailFrameAsset | null;
  createdAt: Date;
  completedAt: Date | null;
};

export interface ThumbnailFrameStore {
  open(input: {
    workspaceId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    exportVariantId: string;
    sourceTimeMs: number;
    create(): ThumbnailFrameRecord;
  }): Promise<{ record: ThumbnailFrameRecord; replayed: boolean }>;
  get(id: string): Promise<ThumbnailFrameRecord | null>;
  claim(id: string, claimId: string, now: Date, leaseMs: number): Promise<ThumbnailFrameRecord | null>;
	settle(
		id: string,
		claimId: string,
		patch: Partial<ThumbnailFrameRecord>,
	): Promise<ThumbnailFrameRecord>;
	requeue(id: string): Promise<ThumbnailFrameRecord>;
}

const THUMBNAIL_PREPARATION_FAILURES = {
  thumbnail_asset_publication_claim_lost: "conflict",
  thumbnail_asset_publication_in_progress: "conflict",
  thumbnail_asset_deleted: "missing",
  thumbnail_asset_unavailable: "missing",
  thumbnail_claim_lost: "conflict",
  thumbnail_export_changed: "conflict",
  thumbnail_export_mismatch: "conflict",
  thumbnail_entitlement_required: "forbidden",
  thumbnail_extraction_failed: "unavailable",
  thumbnail_extraction_invalid: "unprocessable",
  thumbnail_fingerprint_invalid: "invalid",
  thumbnail_frame_time_invalid: "invalid",
  thumbnail_idempotency_conflict: "conflict",
  thumbnail_operation_in_progress: "conflict",
  thumbnail_operation_not_found: "missing",
  thumbnail_provider_constraint: "unprocessable",
  thumbnail_source_missing: "missing",
  thumbnail_source_unsupported: "unprocessable",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type ThumbnailPreparationErrorCode = keyof typeof THUMBNAIL_PREPARATION_FAILURES;

export class ThumbnailPreparationError extends ExpectedDomainFailureError<ThumbnailPreparationErrorCode> {
  constructor(code: ThumbnailPreparationErrorCode, message: string = code) {
    super({ code, kind: THUMBNAIL_PREPARATION_FAILURES[code], message });
    this.name = "ThumbnailPreparationError";
  }
}

export function validateThumbnailSelection(input: {
  platform: SocialPlatform;
  selection: ThumbnailSelection;
}): PreparedThumbnailSettings {
  const capability = SOCIAL_PROVIDER_CAPABILITIES[input.platform];
  if (!capability.thumbnailSources.some((source) => source === input.selection.source)) {
    throw new ThumbnailPreparationError(
      "thumbnail_source_unsupported",
      "This destination does not accept the selected thumbnail source",
    );
  }
  if (!/^[a-f0-9]{64}$/i.test(input.selection.fingerprint)) {
    throw new ThumbnailPreparationError("thumbnail_fingerprint_invalid");
  }
  if (input.selection.source === "extracted_frame") {
    if (
      input.selection.sourceTimeMs === null ||
      !Number.isSafeInteger(input.selection.sourceTimeMs) ||
      input.selection.sourceTimeMs < 0
    ) {
      throw new ThumbnailPreparationError("thumbnail_frame_time_invalid");
    }
    if (capability.thumbnailTypes.some((type) => type === "video_frame")) {
      return {
        thumbnailType: "video_frame",
        thumbnailAssetId: input.selection.assetId,
        thumbnailFingerprint: input.selection.fingerprint,
        thumbnailSource: input.selection.source,
        videoCoverTimestampMs: input.selection.sourceTimeMs,
      };
    }
  }
  if (!capability.thumbnailTypes.some((type) => type === "custom_image")) {
    throw new ThumbnailPreparationError("thumbnail_source_unsupported");
  }
  return {
    thumbnailType: "custom_image",
    thumbnailAssetId: input.selection.assetId,
    thumbnailFingerprint: input.selection.fingerprint,
    thumbnailSource: input.selection.source,
  };
}

export function validateProviderThumbnailAsset(input: {
  platform: SocialPlatform;
  contentType: string;
  sizeBytes: bigint;
}) {
  if (
    input.platform === "youtube_shorts" &&
    (!(["image/jpeg", "image/png"] as const).some(
      (contentType) => contentType === input.contentType,
    ) || input.sizeBytes > 2_000_000n)
  ) {
    throw new ThumbnailPreparationError(
      "thumbnail_provider_constraint",
      "YouTube thumbnails must be JPEG or PNG files no larger than 2 MB",
    );
  }
}

function requestFingerprint(input: {
  workspaceId: string;
  projectId: string;
  clipId: string;
  exportVariantId: string;
  sourceTimeMs: number;
}) {
  return createHash("sha256")
    .update(JSON.stringify({ contract: "thumbnail-frame-v1", ...input }))
    .digest("hex");
}

function publicRecord(record: ThumbnailFrameRecord, replayed = false) {
  if (record.status === "completed" && record.asset?.deleted) {
    throw new ThumbnailPreparationError(
      "thumbnail_asset_deleted",
      "The prepared thumbnail was deleted. Choose or prepare another image.",
    );
  }
  const {
    requestFingerprint: _requestFingerprint,
    claimId: _claimId,
    claimExpiresAt: _claimExpiresAt,
    ...result
  } = record;
  return { ...result, replayed };
}

export function createThumbnailFramePreparation(dependencies: {
  store: ThumbnailFrameStore;
  authorize(input: {
    actorUserId: string;
    workspaceId: string;
    permission: "publishing.manage";
  }): Promise<void>;
  resolveSource(input: {
    workspaceId: string;
    projectId: string;
    clipId: string;
    exportVariantId: string;
  }): Promise<{
    storageKey: string;
    durationMs: number;
    exportFingerprint: string;
    width: number;
    height: number;
  } | null>;
  extract(input: {
    storageKey: string;
    sourceTimeMs: number;
  }): Promise<{
    bytes: Uint8Array;
    contentType: "image/jpeg" | "image/png" | "image/webp";
    width: number;
    height: number;
  }>;
  publish(input: {
    record: ThumbnailFrameRecord;
    bytes: Uint8Array;
    contentType: "image/jpeg" | "image/png" | "image/webp";
    width: number;
    height: number;
    fingerprint: string;
  }): Promise<ThumbnailFrameAsset>;
  createId(): string;
  now(): Date;
}) {
  return {
    async request(input: {
      actorUserId: string;
      workspaceId: string;
      projectId: string;
      clipId: string;
      exportVariantId: string;
      sourceTimeMs: number;
      idempotencyKey: string;
    }) {
      await dependencies.authorize({
        actorUserId: input.actorUserId,
        workspaceId: input.workspaceId,
        permission: "publishing.manage",
      });
      if (!Number.isSafeInteger(input.sourceTimeMs) || input.sourceTimeMs < 0) {
        throw new ThumbnailPreparationError("thumbnail_frame_time_invalid");
      }
      const source = await dependencies.resolveSource(input);
      if (!source) {
        throw new ThumbnailPreparationError(
          "thumbnail_source_missing",
          "The selected export is not available",
        );
      }
      if (input.sourceTimeMs >= source.durationMs) {
        throw new ThumbnailPreparationError(
          "thumbnail_frame_time_invalid",
          "Choose a frame inside the exported video",
        );
      }
      const fingerprint = requestFingerprint(input);
      const opened = await dependencies.store.open({
        workspaceId: input.workspaceId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        exportVariantId: input.exportVariantId,
        sourceTimeMs: input.sourceTimeMs,
        create: () => ({
          id: dependencies.createId(),
          actorUserId: input.actorUserId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          clipId: input.clipId,
          exportVariantId: input.exportVariantId,
          sourceTimeMs: input.sourceTimeMs,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          exportFingerprint: source.exportFingerprint,
          status: "queued",
          attempt: 0,
          claimId: null,
          claimExpiresAt: null,
          errorCode: null,
          asset: null,
          createdAt: dependencies.now(),
          completedAt: null,
        }),
      });
      if (
        opened.replayed &&
        opened.record.idempotencyKey === input.idempotencyKey &&
        opened.record.requestFingerprint !== fingerprint
      ) {
        throw new ThumbnailPreparationError("thumbnail_idempotency_conflict");
      }
      return publicRecord(opened.record, opened.replayed);
    },

    async get(workspaceId: string, projectId: string, id: string) {
      const record = await dependencies.store.get(id);
      if (!record || record.workspaceId !== workspaceId || record.projectId !== projectId) {
        throw new ThumbnailPreparationError("thumbnail_operation_not_found");
      }
      return publicRecord(record);
    },

    async process(id: string) {
      const record = await dependencies.store.get(id);
      if (!record) throw new ThumbnailPreparationError("thumbnail_operation_not_found");
      if (record.status === "completed") return publicRecord(record, true);
      const claimId = dependencies.createId();
      const processing = await dependencies.store.claim(
        id,
        claimId,
        dependencies.now(),
        10 * 60_000,
      );
      if (!processing) {
        throw new ThumbnailPreparationError("thumbnail_operation_in_progress");
      }
      try {
        const source = await dependencies.resolveSource(processing);
        if (!source) throw new ThumbnailPreparationError("thumbnail_source_missing");
        if (source.exportFingerprint !== processing.exportFingerprint) {
          throw new ThumbnailPreparationError("thumbnail_export_changed");
        }
        if (processing.sourceTimeMs >= source.durationMs) {
          throw new ThumbnailPreparationError("thumbnail_frame_time_invalid");
        }
        const output = await dependencies.extract({
          storageKey: source.storageKey,
          sourceTimeMs: processing.sourceTimeMs,
        });
        if (output.bytes.byteLength === 0 || output.width <= 0 || output.height <= 0) {
          throw new ThumbnailPreparationError("thumbnail_extraction_invalid");
        }
        const fingerprint = createHash("sha256").update(output.bytes).digest("hex");
        const asset = await dependencies.publish({
          record: processing,
          ...output,
          fingerprint,
        });
        const completed = await dependencies.store.settle(id, claimId, {
          status: "completed",
          asset,
          errorCode: null,
          completedAt: dependencies.now(),
          claimId: null,
          claimExpiresAt: null,
        });
        return publicRecord(completed);
      } catch (error) {
        const code = error instanceof ThumbnailPreparationError
          ? error.code
          : "thumbnail_extraction_failed";
        await dependencies.store.settle(id, claimId, {
          status: "failed",
          errorCode: code,
          claimId: null,
          claimExpiresAt: null,
        });
        throw new ThumbnailPreparationError(code);
      }
    },
  };
}

function cloneRecord(record: ThumbnailFrameRecord): ThumbnailFrameRecord {
  return {
    ...record,
    asset: record.asset,
    createdAt: new Date(record.createdAt),
    completedAt: record.completedAt ? new Date(record.completedAt) : null,
    claimExpiresAt: record.claimExpiresAt ? new Date(record.claimExpiresAt) : null,
  };
}

export function createInMemoryThumbnailFrameStore(): ThumbnailFrameStore {
  const records = new Map<string, ThumbnailFrameRecord>();
  return {
    async open(input) {
      const byKey = [...records.values()].find(
        (record) => record.workspaceId === input.workspaceId && record.idempotencyKey === input.idempotencyKey,
      );
      if (byKey) return { record: cloneRecord(byKey), replayed: true };
      const byFrame = [...records.values()].find(
        (record) => record.exportVariantId === input.exportVariantId && record.sourceTimeMs === input.sourceTimeMs,
      );
      if (byFrame) return { record: cloneRecord(byFrame), replayed: true };
      const created = input.create();
      records.set(created.id, cloneRecord(created));
      return { record: cloneRecord(created), replayed: false };
    },
    async get(id) {
      const record = records.get(id);
      return record ? cloneRecord(record) : null;
    },
    async claim(id, claimId, now, leaseMs) {
      const current = records.get(id);
      if (!current || current.status === "completed") return null;
      if (
        current.status === "processing" &&
        current.claimExpiresAt &&
        current.claimExpiresAt > now
      ) return null;
      const claimed: ThumbnailFrameRecord = {
        ...current,
        status: "processing",
        attempt: current.attempt + 1,
        errorCode: null,
        claimId,
        claimExpiresAt: new Date(now.getTime() + leaseMs),
      };
      records.set(id, cloneRecord(claimed));
      return cloneRecord(claimed);
    },
    async settle(id, claimId, patch) {
      const current = records.get(id);
      if (!current) throw new ThumbnailPreparationError("thumbnail_operation_not_found");
			if (current.status !== "processing" || current.claimId !== claimId) {
				throw new ThumbnailPreparationError("thumbnail_claim_lost");
			}
      const updated = { ...current, ...patch };
      records.set(id, cloneRecord(updated));
      return cloneRecord(updated);
    },
		async requeue(id) {
			const current = records.get(id);
			if (!current) throw new ThumbnailPreparationError("thumbnail_operation_not_found");
			if (current.status !== "failed") return cloneRecord(current);
			const queued: ThumbnailFrameRecord = {
				...current,
				status: "queued",
				errorCode: null,
				claimId: null,
				claimExpiresAt: null,
				completedAt: null,
			};
			records.set(id, cloneRecord(queued));
			return cloneRecord(queued);
		},
  };
}
