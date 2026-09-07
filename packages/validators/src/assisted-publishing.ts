import { z } from "zod";
import { clipAspectRatioSchema, clipRenderResolutionSchema } from "./clip";
import { socialPlatformSchema, socialThumbnailSelectionSchema } from "./social";

const idSchema = z.string().uuid();
const hashtagSchema = z.string().trim().regex(/^#[^\s#]{1,99}$/u);

export const generateAssistedCopySchema = z.strictObject({
  clipId: idSchema,
  idempotencyKey: idSchema,
  platforms: z.array(socialPlatformSchema).min(1).max(6),
  campaignNote: z.string().trim().min(1).max(2_000),
  revisionInstruction: z.string().trim().max(1_000).optional(),
  lockedPhrases: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  lockedHashtags: z.array(hashtagSchema).max(50).default([]),
}).superRefine((value, context) => {
  if (new Set(value.platforms).size !== value.platforms.length) {
    context.addIssue({ code: "custom", path: ["platforms"], message: "Platforms must be unique" });
  }
});

export const confirmAssistedCopySchema = z.strictObject({
  caption: z.string().trim().min(1).max(5_000),
  hashtags: z.array(hashtagSchema).max(30),
  title: z.string().trim().min(1).max(100).nullable(),
});

export const thumbnailSelectionSchema = socialThumbnailSelectionSchema;

export const requestThumbnailFrameSchema = z.strictObject({
  clipId: idSchema,
  exportVariantId: idSchema,
  sourceTimeMs: z.number().int().nonnegative(),
  idempotencyKey: idSchema,
});

const bulkCopySchema = z.strictObject({
  variantId: idSchema,
  caption: z.string().trim().min(1).max(5_000),
  hashtags: z.array(hashtagSchema).max(30),
  title: z.string().trim().min(1).max(100).nullable(),
	providerSettings: z.record(z.string(), z.unknown()).default({}),
});

export const bulkSocialScheduleSchema = z.strictObject({
  idempotencyKey: idSchema,
  accounts: z.array(z.strictObject({
    accountId: idSchema,
    platform: socialPlatformSchema,
  })).min(1).max(20),
  clips: z.array(z.strictObject({
    clipId: idSchema,
    expectedEditorRevision: z.number().int().nonnegative(),
		exportId: idSchema,
		exportVariantId: idSchema,
    aspectRatio: clipAspectRatioSchema,
    resolution: clipRenderResolutionSchema,
    copyByPlatform: z.partialRecord(socialPlatformSchema, bulkCopySchema),
    thumbnailByPlatform: z.partialRecord(socialPlatformSchema, thumbnailSelectionSchema.nullable()),
  })).min(1).max(100),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeZone: z.string().trim().min(1).max(100),
  postingWindow: z.strictObject({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  }),
  frequency: z.discriminatedUnion("unit", [
    z.strictObject({ unit: z.literal("hours"), value: z.number().int().min(1).max(24) }),
    z.strictObject({ unit: z.literal("days"), value: z.number().int().min(1).max(30) }),
  ]),
  dstDisambiguation: z.enum(["earlier", "later"]).nullable().default(null),
	reviewOverrideReason: z.string().trim().min(1).max(500).nullable().optional(),
}).superRefine((value, context) => {
  if (new Set(value.accounts.map((account) => account.accountId)).size !== value.accounts.length) {
    context.addIssue({ code: "custom", path: ["accounts"], message: "Accounts must be unique" });
  }
  if (new Set(value.clips.map((clip) => clip.clipId)).size !== value.clips.length) {
    context.addIssue({ code: "custom", path: ["clips"], message: "Clips must be unique" });
  }
  if (value.clips.length * value.accounts.length > 500) {
    context.addIssue({ code: "custom", path: ["clips"], message: "A bulk schedule can contain at most 500 items" });
  }
});

export type GenerateAssistedCopyRequest = z.infer<typeof generateAssistedCopySchema>;
export type ConfirmAssistedCopyRequest = z.infer<typeof confirmAssistedCopySchema>;
export type ThumbnailSelectionInput = z.infer<typeof thumbnailSelectionSchema>;
export type RequestThumbnailFrameInput = z.infer<typeof requestThumbnailFrameSchema>;
export type BulkSocialScheduleRequest = z.infer<typeof bulkSocialScheduleSchema>;
