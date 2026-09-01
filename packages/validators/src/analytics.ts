import { z } from "zod";
import { socialPlatformSchema } from "./social";

export const analyticsEventTypeSchema = z.enum([
  "render_completed",
  "download_opened",
  "social_scheduled",
  "social_cancelled",
  "social_posted",
  "social_failed",
  "dub_completed",
  "dub_download_opened",
  "clips_ready",
  "campaign_operation_started",
  "campaign_operation_completed",
  "review_sent",
  "review_opened",
  "review_changes_requested",
  "campaign_approved",
  "campaign_scheduled",
  "generated_asset_completed",
  "generated_asset_settled",
  "generated_asset_inserted",
  "brand_profile_created",
  "brand_profile_applied",
  "visual_asset_upload_succeeded",
  "visual_asset_upload_failed",
  "brand_font_upload_succeeded",
  "brand_font_upload_failed",
  "scene_template_used",
  "brand_premium_mutation_blocked",
]);

const SENSITIVE_ANALYTICS_KEY =
  /(transcript|prompt|comment|reviewer(?:email|identity)?|token|passcode|signed.?url)/i;

const ALLOWED_ANALYTICS_METADATA_KEYS = new Set([
  "aspectRatio",
  "asset",
  "assetId",
  "assetKind",
  "approvalOverrides",
  "campaignOperationId",
  "durationBucket",
  "featureVersion",
  "fontId",
  "generatedMediaJobId",
  "guardrails",
  "languageCode",
  "latencyBucket",
  "lifecycleStatus",
  "modelAlias",
  "moderationOutcome",
  "outcome",
  "planTier",
  "providerAlias",
  "platform",
  "profileId",
  "projectId",
  "revisionCount",
  "retryCount",
  "reviewRoundId",
  "sceneTemplateId",
  "selectedCount",
  "templateId",
  "voice",
  "usageUnits",
  "workspaceId",
]);

function findSensitiveMetadataPath(
  value: unknown,
  path: Array<string | number> = [],
): Array<string | number> | null {
	if (typeof value === "string" && /(?:https?|s3|r2):\/\//i.test(value)) {
		return path;
	}
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSensitiveMetadataPath(item, [...path, index]);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_ANALYTICS_KEY.test(key)) return [...path, key];
    const found = findSensitiveMetadataPath(nested, [...path, key]);
    if (found) return found;
  }
  return null;
}

function findUnknownMetadataPath(
  value: unknown,
  path: Array<string | number> = [],
): Array<string | number> | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findUnknownMetadataPath(item, [...path, index]);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    if (!ALLOWED_ANALYTICS_METADATA_KEYS.has(key)) return [...path, key];
    const found = findUnknownMetadataPath(nested, [...path, key]);
    if (found) return found;
  }
  return null;
}

export const analyticsSnapshotSchema = z.object({
  projectId: z.string().uuid(),
  totals: z.object({
    rendersCompleted: z.number().int().nonnegative(),
    downloadsOpened: z.number().int().nonnegative(),
    socialScheduled: z.number().int().nonnegative(),
    socialPosted: z.number().int().nonnegative(),
    socialFailed: z.number().int().nonnegative(),
    dubsCompleted: z.number().int().nonnegative(),
    dubDownloadsOpened: z.number().int().nonnegative(),
  }),
  byClip: z.array(
    z.object({
      clipId: z.string().uuid(),
      rendersCompleted: z.number().int().nonnegative(),
      downloadsOpened: z.number().int().nonnegative(),
      socialScheduled: z.number().int().nonnegative(),
      socialPosted: z.number().int().nonnegative(),
      socialFailed: z.number().int().nonnegative(),
      dubsCompleted: z.number().int().nonnegative(),
      dubDownloadsOpened: z.number().int().nonnegative(),
    }),
  ),
});

export const recordAnalyticsEventSchema = z
  .object({
    type: analyticsEventTypeSchema,
    clipId: z.string().uuid().nullable().optional(),
    platform: socialPlatformSchema.nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const sensitivePath = findSensitiveMetadataPath(value.metadata);
    if (sensitivePath) {
      context.addIssue({
        code: "custom",
        message: "Analytics metadata contains a prohibited sensitive field",
        path: ["metadata", ...sensitivePath],
      });
      return;
    }
    const unknownPath = findUnknownMetadataPath(value.metadata);
    if (unknownPath) {
      context.addIssue({
        code: "custom",
        message: "Analytics metadata contains a field outside the approved allowlist",
        path: ["metadata", ...unknownPath],
      });
    }
  });

export const brandProgramAnalyticsEventSchema = z
  .object({
    type: z.enum([
      "brand_profile_created",
      "brand_profile_applied",
      "visual_asset_upload_succeeded",
      "visual_asset_upload_failed",
      "brand_font_upload_succeeded",
      "brand_font_upload_failed",
      "scene_template_used",
      "brand_premium_mutation_blocked",
      "generated_asset_completed",
      "generated_asset_settled",
      "generated_asset_inserted",
    ]),
    workspaceId: z.string().uuid(),
    actorUserId: z.string().uuid(),
    projectId: z.string().uuid().nullable().optional(),
    metadata: z
      .object({
        profileId: z.string().uuid().optional(),
        assetId: z.string().uuid().optional(),
        fontId: z.string().uuid().optional(),
        templateId: z.string().uuid().optional(),
        sceneTemplateId: z.string().uuid().optional(),
        generatedMediaJobId: z.string().uuid().optional(),
        aspectRatio: z.enum(["9:16", "16:9", "1:1"]).optional(),
        assetKind: z.enum(["image", "video", "font", "profile", "scene"]).optional(),
        planTier: z.enum(["free", "creator", "pro", "business"]).optional(),
        outcome: z.enum(["succeeded", "failed", "blocked"]).optional(),
        providerAlias: z.string().min(1).max(40).optional(),
        modelAlias: z.string().min(1).max(80).optional(),
        lifecycleStatus: z.enum(["completed", "failed", "rejected", "cancelled"]).optional(),
        latencyBucket: z.enum(["under_10s", "10_to_30s", "30_to_90s", "over_90s"]).optional(),
        retryCount: z.number().int().nonnegative().max(20).optional(),
        moderationOutcome: z.enum(["pending", "approved", "rejected"]).optional(),
        usageUnits: z.number().int().nonnegative().max(100).optional(),
      })
      .strict(),
  })
  .strict();

export type AnalyticsEventType = z.infer<typeof analyticsEventTypeSchema>;
export type AnalyticsSnapshot = z.infer<typeof analyticsSnapshotSchema>;
export type RecordAnalyticsEventInput = z.infer<typeof recordAnalyticsEventSchema>;
export type BrandProgramAnalyticsEventInput = z.infer<typeof brandProgramAnalyticsEventSchema>;
