import {
  SOCIAL_PROVIDER_CAPABILITIES,
  type SocialPlatform,
} from "@narriflow/validators";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
  type ExpectedDomainFailureDetails,
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

const THUMBNAIL_PREPARATION_FAILURES = {
  thumbnail_asset_publication_claim_lost: "conflict",
  thumbnail_asset_publication_in_progress: "conflict",
  thumbnail_asset_deleted: "missing",
  thumbnail_asset_unavailable: "missing",
  thumbnail_claim_lost: "conflict",
  thumbnail_export_changed: "conflict",
  thumbnail_export_mismatch: "conflict",
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
  thumbnail_scheduling_unavailable: "unavailable",
  thumbnail_retry_exhausted: "conflict",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type ThumbnailPreparationErrorCode = keyof typeof THUMBNAIL_PREPARATION_FAILURES;

export class ThumbnailPreparationError extends ExpectedDomainFailureError<ThumbnailPreparationErrorCode> {
  constructor(code: ThumbnailPreparationErrorCode, message: string = code, details?: ExpectedDomainFailureDetails) {
    super({ code, kind: THUMBNAIL_PREPARATION_FAILURES[code], message, details });
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
