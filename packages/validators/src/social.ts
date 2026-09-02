import { z } from "zod";
import { clipAspectRatioSchema } from "./clip";
import { SOCIAL_PROVIDER_CAPABILITIES } from "./social-provider-capabilities";

export const socialPlatformSchema = z.enum([
  "tiktok",
  "youtube_shorts",
  "instagram_reels",
  "facebook_reels",
  "linkedin",
  "x",
]);

export const socialPostStatusSchema = z.enum([
  "draft",
  "preparing_video",
  "scheduled",
  "publishing",
  "processing",
  "reconciling",
  "posted",
  "failed",
  "needs_attention",
  "cancelled",
]);

export const publicationFailureDispositionSchema = z.enum([
  "safe_retry",
  "permanent",
  "attention",
]);

export const socialPublicationActionSchema = z.enum([
  "cancel",
  "recheck",
  "confirm_published",
  "publish_again",
  "reconnect_account",
  "schedule_again",
]);

export const publicationEvidenceKindSchema = z.enum([
  "provider_reference",
  "platform_url",
  "manual_unvalidated",
]);

export const recheckSocialPublicationSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});

export const confirmSocialPublicationSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
  evidenceKind: publicationEvidenceKindSchema,
  providerReference: z.string().trim().min(1).max(500).nullable().optional(),
  externalUrl: z.string().url().max(2_048).nullable().optional(),
}).superRefine((value, context) => {
  if (value.evidenceKind === "platform_url" && !value.externalUrl) {
    context.addIssue({
      code: "custom",
      path: ["externalUrl"],
      message: "A platform URL is required for platform URL evidence",
    });
  }
  if (value.evidenceKind === "provider_reference" && !value.providerReference) {
    context.addIssue({
      code: "custom",
      path: ["providerReference"],
      message: "A provider reference is required for provider reference evidence",
    });
  }
});

export const republishSocialPublicationSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
  duplicateRiskAcknowledged: z.literal(true),
});

export const socialAccountStatusSchema = z.enum([
  "active",
  "expired",
  "revoked",
]);

export const scheduleSocialPostSchema = z.object({
  clientIdempotencyKey: z.string().uuid(),
  clipId: z.string().uuid(),
  expectedEditorRevision: z.number().int().nonnegative(),
  accountId: z.string().uuid().nullable(),
  platform: socialPlatformSchema,
  caption: z.string().trim().min(1).max(5_000),
  aspectRatio: clipAspectRatioSchema,
  resolution: z.enum(["720p", "1080p"]),
  scheduledFor: z.string().datetime(),
  providerSettings: z.record(z.string(), z.unknown()).default({}),
	reviewOverrideReason: z.string().trim().min(1).max(500).nullable().optional(),
}).strict().superRefine((value, context) => {
  const capability = SOCIAL_PROVIDER_CAPABILITIES[value.platform];
  if (!capability.aspectRatios.some((ratio) => ratio === value.aspectRatio)) {
    context.addIssue({ code: "custom", path: ["aspectRatio"], message: "Aspect ratio is not supported by this provider" });
  }
  if (value.caption.length > capability.textLimit) {
    context.addIssue({ code: "custom", path: ["caption"], message: `Caption exceeds the ${capability.textLimit}-character provider limit` });
  }
  const thumbnailType = value.providerSettings.thumbnailType;
  if (typeof thumbnailType === "string" && !capability.thumbnailTypes.some((candidate) => candidate === thumbnailType)) {
    context.addIssue({ code: "custom", path: ["providerSettings", "thumbnailType"], message: "Thumbnail type is not supported by this provider" });
  }
});

export const socialPostMetricsSchema = z.object({
  views: z.number().int().nonnegative().default(0),
  likes: z.number().int().nonnegative().default(0),
  comments: z.number().int().nonnegative().default(0),
  shares: z.number().int().nonnegative().default(0),
  saves: z.number().int().nonnegative().default(0),
  watchTimeSeconds: z.number().int().nonnegative().nullable().optional(),
  capturedAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const socialAccountSnapshotSchema = z.object({
  id: z.string().uuid(),
  platform: socialPlatformSchema,
  providerAccountId: z.string(),
  displayName: z.string(),
  handle: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  scopes: z.array(z.string()),
  expiresAt: z.string().datetime().nullable(),
  status: socialAccountStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const socialPostMetricsSnapshotSchema = z.object({
  views: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  shares: z.number().int().nonnegative(),
  saves: z.number().int().nonnegative(),
  watchTimeSeconds: z.number().int().nonnegative().nullable(),
  capturedAt: z.string().datetime(),
});

export const socialPostSnapshotSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  clipId: z.string().uuid().nullable(),
  accountId: z.string().uuid().nullable(),
  accountDisplayName: z.string().nullable(),
  accountHandle: z.string().nullable(),
  platform: socialPlatformSchema,
  status: socialPostStatusSchema,
  caption: z.string(),
  aspectRatio: clipAspectRatioSchema.nullable(),
  scheduledFor: z.string().datetime().nullable(),
  postedAt: z.string().datetime().nullable(),
  externalUrl: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorDisposition: publicationFailureDispositionSchema.nullable(),
  nextAttemptAt: z.string().datetime().nullable(),
  providerProcessingStatus: z.enum(["processing", "succeeded", "failed", "unknown"]).nullable(),
  providerProcessingFailureCode: z.string().nullable(),
  providerVisibility: z.string().nullable(),
  allowedActions: z.array(socialPublicationActionSchema).default([]),
  latestMetrics: socialPostMetricsSnapshotSchema.nullable(),
  createdAt: z.string().datetime(),
});

export type SocialPlatform = z.infer<typeof socialPlatformSchema>;
export type SocialPostStatus = z.infer<typeof socialPostStatusSchema>;
export type SocialAccountStatus = z.infer<typeof socialAccountStatusSchema>;
export type ScheduleSocialPostInput = z.infer<typeof scheduleSocialPostSchema>;
export type SocialAccountSnapshot = z.infer<typeof socialAccountSnapshotSchema>;
export type SocialPostMetricsInput = z.infer<typeof socialPostMetricsSchema>;
export type SocialPostSnapshot = z.infer<typeof socialPostSnapshotSchema>;
export type SocialPublicationAction = z.infer<typeof socialPublicationActionSchema>;
export type PublicationEvidenceKind = z.infer<typeof publicationEvidenceKindSchema>;
export type RecheckSocialPublicationInput = z.infer<typeof recheckSocialPublicationSchema>;
export type ConfirmSocialPublicationInput = z.infer<typeof confirmSocialPublicationSchema>;
export type RepublishSocialPublicationInput = z.infer<typeof republishSocialPublicationSchema>;
