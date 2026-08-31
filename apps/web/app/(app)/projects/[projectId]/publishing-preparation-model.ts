import {
  type BulkScheduleResult,
  SOCIAL_PROVIDER_CAPABILITIES,
  clipAspectRatioFromDb,
	socialProviderAcceptsCustomThumbnail,
	socialProviderAcceptsMedia,
  type ClipAspectRatio,
  type ClipRenderResolution,
  type SocialPlatform,
} from "@narriflow/validators";

export type PublishingPreparationClip = {
  id: string;
  editorRevision: number;
  index: number;
};

export type PublishingExportCandidate = {
  id: string;
  clipId: string;
  editorRevision: number;
  variants: Array<{
    id: string;
    aspectRatio: string;
    resolution: string;
    durationSec: number | null;
    status: string;
  }>;
};

export type PublishingExportResolution =
  | {
      kind: "ready";
      exportId: string;
      exportVariantId: string;
      aspectRatio: ClipAspectRatio;
      resolution: ClipRenderResolution;
      durationSec: number | null;
    }
  | {
      kind: "attention";
      code:
        | "export_required"
        | "export_revision_stale"
        | "export_variant_unsupported";
    };

export type PublishingBulkScheduleResult = BulkScheduleResult;

export function buildPublishingSelection<T extends PublishingPreparationClip>(
  clips: readonly T[],
  selectedIds: ReadonlySet<string>,
): T[] {
  return clips.filter((clip) => selectedIds.has(clip.id));
}

function normalizedAspectRatio(value: string): ClipAspectRatio | null {
  if (value in clipAspectRatioFromDb) {
    return clipAspectRatioFromDb[value as keyof typeof clipAspectRatioFromDb];
  }
  return (["9:16", "1:1", "16:9", "4:5"] as const).find(
    (candidate) => candidate === value,
  ) ?? null;
}

export function resolvePublishingExport(input: {
  clip: PublishingPreparationClip;
  candidates: readonly PublishingExportCandidate[];
  platform: SocialPlatform;
}): PublishingExportResolution {
  const candidate = input.candidates.find(
    (item) => item.clipId === input.clip.id,
  );
  if (!candidate) return { kind: "attention", code: "export_required" };
  if (candidate.editorRevision !== input.clip.editorRevision) {
    return { kind: "attention", code: "export_revision_stale" };
  }
  const supported = SOCIAL_PROVIDER_CAPABILITIES[input.platform]
    .aspectRatios as readonly string[];
  for (const variant of candidate.variants) {
    const aspectRatio = normalizedAspectRatio(variant.aspectRatio);
    if (
      variant.status === "completed" &&
      aspectRatio &&
      supported.includes(aspectRatio) &&
			variant.durationSec !== null &&
			socialProviderAcceptsMedia({
				platform: input.platform,
				aspectRatio,
				durationSec: variant.durationSec,
			}) &&
      (variant.resolution === "720p" || variant.resolution === "1080p")
    ) {
      return {
        kind: "ready",
        exportId: candidate.id,
        exportVariantId: variant.id,
        aspectRatio,
        resolution: variant.resolution,
        durationSec: variant.durationSec,
      };
    }
  }
  return { kind: "attention", code: "export_variant_unsupported" };
}

export function thumbnailControlForPlatform(
  platform: SocialPlatform,
): "custom_image" | "video_frame" | null {
  const types = SOCIAL_PROVIDER_CAPABILITIES[platform]
    .thumbnailTypes as readonly string[];
  if (types.includes("custom_image")) return "custom_image";
  if (types.includes("video_frame")) return "video_frame";
  return null;
}

export function thumbnailAssetEligibleForPlatform(
  platform: SocialPlatform,
  asset: { kind: "image" | "video"; contentType: string; sizeBytes: number },
) {
  return asset.kind === "image" &&
    socialProviderAcceptsCustomThumbnail({
      platform,
      contentType: asset.contentType,
      sizeBytes: asset.sizeBytes,
    });
}

export function campaignScheduleIdempotencyKey(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  projectId: string,
  intent: unknown,
  createId: () => string,
): string {
  const key = campaignScheduleStorageKey(projectId);
  const fingerprint = JSON.stringify(intent);
  try {
    const stored = JSON.parse(storage.getItem(key) ?? "null") as {
      fingerprint?: unknown;
      idempotencyKey?: unknown;
    } | null;
    if (
      stored?.fingerprint === fingerprint &&
      typeof stored.idempotencyKey === "string"
    ) {
      return stored.idempotencyKey;
    }
  } catch {
    storage.removeItem(key);
  }
  const idempotencyKey = createId();
  storage.setItem(key, JSON.stringify({ fingerprint, idempotencyKey }));
  return idempotencyKey;
}

function campaignScheduleStorageKey(projectId: string) {
  return `narriflow:bulk-schedule-intent:v1:${projectId}`;
}

export function releaseCampaignScheduleIdempotencyKey(
  storage: Pick<Storage, "removeItem">,
  projectId: string,
) {
  storage.removeItem(campaignScheduleStorageKey(projectId));
}

export function mergePublishingBulkScheduleResult(
  previous: PublishingBulkScheduleResult | null,
  next: PublishingBulkScheduleResult,
): PublishingBulkScheduleResult {
  if (!previous) return next;
  const retried = new Map(next.items.map((item) => [item.itemKey, item]));
  const priorKeys = new Set(previous.items.map((item) => item.itemKey));
  const items = [
    ...previous.items.map((item) => retried.get(item.itemKey) ?? item),
    ...next.items.filter((item) => !priorKeys.has(item.itemKey)),
  ];
  const scheduled = items.filter((item) => item.status === "scheduled").length;
  const failed = items.length - scheduled;
  return {
    ...next,
    status: failed === 0 ? "completed" : scheduled === 0 ? "failed" : "partial",
    counts: { scheduled, failed },
    items,
  };
}

const BULK_ITEM_ERROR_LABELS: Record<string, string> = {
  bulk_schedule_account_expired: "Reconnect account",
  bulk_schedule_account_invalid: "Choose an active account",
  bulk_schedule_aspect_ratio_unsupported: "Export ratio unsupported",
  bulk_schedule_copy_unconfirmed: "Confirm current copy",
  bulk_schedule_export_invalid: "Prepare the current export",
  bulk_schedule_text_invalid: "Shorten confirmed copy",
  bulk_schedule_thumbnail_export_mismatch: "Extract a frame from this export",
  bulk_schedule_thumbnail_missing: "Choose an available thumbnail",
  bulk_schedule_thumbnail_unsupported: "Thumbnail source unsupported",
  publication_account_schedule_conflict: "Account slot unavailable",
  publication_schedule_in_past: "Choose a future window",
  review_approval_missing: "Review approval required",
  review_approval_required: "Review approval required",
};

export function publishingBulkItemLabel(
  status: "scheduled" | "failed",
  errorCode: string | null,
) {
  if (status === "scheduled") return "Scheduled";
  if (!errorCode) return "Could not schedule";
  return (
    BULK_ITEM_ERROR_LABELS[errorCode] ??
    errorCode
      .replace(/^(bulk_schedule|publication|review)_/, "")
      .replaceAll("_", " ")
      .replace(/^./, (character) => character.toUpperCase())
  );
}
