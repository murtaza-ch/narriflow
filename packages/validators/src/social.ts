import { z } from "zod";
import { clipAspectRatioSchema } from "./clip";

export const socialPlatformSchema = z.enum([
  "tiktok",
  "youtube_shorts",
  "instagram_reels",
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
  caption: z.string().trim().min(1).max(2200),
  aspectRatio: clipAspectRatioSchema,
  resolution: z.enum(["720p", "1080p"]),
  scheduledFor: z.string().datetime(),
  providerSettings: z.record(z.string(), z.unknown()).default({}),
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
});

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
