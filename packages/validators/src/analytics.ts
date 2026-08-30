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
  "generated_asset_inserted",
]);

const SENSITIVE_ANALYTICS_KEY =
  /(transcript|prompt|comment|reviewer(?:email|identity)?|token|passcode|signed.?url)/i;

function findSensitiveMetadataPath(
  value: unknown,
  path: Array<string | number> = [],
): Array<string | number> | null {
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
    if (!sensitivePath) return;
    context.addIssue({
      code: "custom",
      message: "Analytics metadata contains a prohibited sensitive field",
      path: ["metadata", ...sensitivePath],
    });
  });

export type AnalyticsEventType = z.infer<typeof analyticsEventTypeSchema>;
export type AnalyticsSnapshot = z.infer<typeof analyticsSnapshotSchema>;
export type RecordAnalyticsEventInput = z.infer<typeof recordAnalyticsEventSchema>;
