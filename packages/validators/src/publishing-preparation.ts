import { z } from "zod";

import { clipAspectRatioSchema } from "./clip";
import { socialPlatformSchema } from "./social";

export const assistedCopyContentSchema = z
  .strictObject({
    caption: z.string().trim().min(1).max(5_000),
    hashtags: z
      .array(z.string().trim().min(1).max(100))
      .max(30)
      .transform((tags) => tags.map((tag) => tag.replace(/^#/, ""))),
    title: z.string().trim().min(1).max(300).nullable(),
  });

export const assistedCopyViewSchema = z
  .strictObject({
    id: z.string().uuid(),
    clipId: z.string().uuid(),
    platform: socialPlatformSchema,
    sourceDraftId: z.string().uuid().nullable(),
    status: z.enum(["generating", "completed", "rejected", "failed", "unknown"]),
    revision: z.number().int().positive(),
    content: assistedCopyContentSchema.nullable(),
    confirmed: z.boolean(),
    moderationOutcome: z.enum(["pending", "accepted", "rejected", "unknown"]),
    modelAlias: z.string().trim().min(1).max(160).nullable(),
    promptVersion: z.string().trim().min(1).max(100),
    guidanceSkipped: z.boolean(),
    errorCode: z.string().trim().min(1).max(160).nullable(),
    replayed: z.boolean(),
  })
  .superRefine((value, context) => {
    if (
      value.status === "completed" &&
      (value.content === null ||
        value.moderationOutcome !== "accepted" ||
        value.errorCode !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Completed assisted copy needs accepted, reviewable content",
      });
    }
    if (value.status !== "completed" && value.content !== null) {
      context.addIssue({
        code: "custom",
        message: "Unsettled or failed assisted copy cannot contain reviewable content",
      });
    }
  });

export const generateAssistedCopySchema = z.strictObject({
  idempotencyKey: z.string().uuid(),
  clipId: z.string().uuid(),
  platform: socialPlatformSchema,
  campaignNote: z.string().trim().min(1).max(2_000),
  lockedTerms: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  sourceDraftId: z.string().uuid().optional(),
});

export const confirmAssistedCopySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  content: assistedCopyContentSchema,
});

export const listAssistedCopySchema = z.strictObject({
  platform: socialPlatformSchema,
});

export const requestThumbnailExtractionSchema = z.strictObject({
  idempotencyKey: z.string().uuid(),
  platform: socialPlatformSchema,
  exportVariantId: z.string().uuid(),
  sourceTimeSec: z.number().finite().nonnegative().max(24 * 60 * 60),
  title: z.string().trim().min(1).max(160),
});

const extractedThumbnailAssetViewSchema = z.strictObject({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  createdByUserId: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  kind: z.literal("image"),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  sizeBytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  provenance: z.literal("extracted"),
  sourceExportVariantId: z.string().uuid(),
  sourceTimeMs: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export const thumbnailExtractionViewSchema = z
  .strictObject({
    id: z.string().uuid(),
    status: z.enum(["queued", "processing", "completed", "failed"]),
    attempts: z.number().int().nonnegative(),
    platform: socialPlatformSchema,
    exportVariantId: z.string().uuid(),
    sourceTimeMs: z.number().int().nonnegative(),
    errorCode: z.string().trim().min(1).max(160).nullable(),
    asset: extractedThumbnailAssetViewSchema.nullable(),
    replayed: z.boolean(),
  })
  .superRefine((value, context) => {
    const completed = value.status === "completed";
    const failed = value.status === "failed";
    if (
      (completed && (value.asset === null || value.errorCode !== null)) ||
      (failed && (value.asset !== null || value.errorCode === null)) ||
      (!completed && !failed &&
        (value.asset !== null || value.errorCode !== null)) ||
      (value.asset !== null &&
        (value.asset.sourceExportVariantId !== value.exportVariantId ||
          value.asset.sourceTimeMs !== value.sourceTimeMs))
    ) {
      context.addIssue({
        code: "custom",
        message: "Thumbnail extraction state must match its exact asset and export",
      });
    }
  });

export const listThumbnailExtractionsSchema = z.strictObject({
  platform: socialPlatformSchema,
  exportVariantIds: z
    .string()
    .trim()
    .min(1)
    .max(4_000)
    .transform((value) => [
      ...new Set(
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(z.string().uuid()).min(1).max(100)),
});

export const bulkScheduleItemSchema = z.strictObject({
  itemKey: z.string().uuid(),
  occurrenceIndex: z.number().int().min(0).max(99),
  clipId: z.string().uuid(),
  expectedEditorRevision: z.number().int().nonnegative(),
  exportVariantId: z.string().uuid(),
  accountId: z.string().uuid(),
  platform: socialPlatformSchema,
  assistedCopyDraftId: z.string().uuid(),
  assistedCopyRevision: z.number().int().positive(),
  aspectRatio: clipAspectRatioSchema,
  resolution: z.enum(["720p", "1080p"]),
	durationSec: z.number().finite().positive(),
  thumbnailAssetId: z.string().uuid().nullable(),
  approvalOverrideReason: z.string().trim().min(1).max(500).nullable().optional(),
});

function requireUniqueBulkScheduleItems(
  items: ReadonlyArray<{ itemKey: string; occurrenceIndex: number }>,
  context: z.RefinementCtx,
) {
  if (
    new Set(items.map((item) => item.itemKey)).size !== items.length ||
    new Set(items.map((item) => item.occurrenceIndex)).size !== items.length
  ) {
    context.addIssue({
      code: "custom",
      message: "Bulk scheduling item keys and occurrences must be unique",
    });
  }
}

export const bulkScheduleSchema = z.strictObject({
  idempotencyKey: z.string().uuid(),
  timezone: z.string().trim().min(1).max(100),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  postingWindow: z.strictObject({
    startTime: z.string().regex(/^\d{2}:\d{2}$/),
    endTime: z.string().regex(/^\d{2}:\d{2}$/),
    frequencyMinutes: z.number().int().min(5).max(1_440),
  }),
  items: z
    .array(bulkScheduleItemSchema)
    .min(1)
    .max(100)
    .superRefine(requireUniqueBulkScheduleItems),
});

export const bulkScheduleItemResultSchema = z
  .strictObject({
    itemKey: z.string().uuid(),
    clipId: z.string().uuid(),
    accountId: z.string().uuid(),
    status: z.enum(["scheduled", "failed"]),
    postId: z.string().uuid().nullable(),
    scheduledFor: z.string().datetime().nullable(),
    errorCode: z.string().trim().min(1).max(160).nullable(),
  })
  .superRefine((value, context) => {
    if (
      value.status === "scheduled" &&
      (value.postId === null ||
        value.scheduledFor === null ||
        value.errorCode !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Scheduled items need a post, a slot, and no error",
      });
    }
    if (
      value.status === "failed" &&
      (value.postId !== null || value.errorCode === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Failed items need an error and cannot claim a Social Post",
      });
    }
  });

export const bulkScheduleResultSchema = z
  .strictObject({
    operationId: z.string().uuid(),
    status: z.enum(["completed", "partial", "failed"]),
    counts: z.strictObject({
      scheduled: z.number().int().nonnegative().max(100),
      failed: z.number().int().nonnegative().max(100),
    }),
    items: z.array(bulkScheduleItemResultSchema).min(1).max(100),
    replayed: z.boolean(),
  })
  .superRefine((value, context) => {
    const scheduled = value.items.filter(
      (item) => item.status === "scheduled",
    ).length;
    const failed = value.items.length - scheduled;
    const status =
      failed === 0 ? "completed" : scheduled === 0 ? "failed" : "partial";
    if (
      value.counts.scheduled !== scheduled ||
      value.counts.failed !== failed ||
      value.status !== status ||
      new Set(value.items.map((item) => item.itemKey)).size !== value.items.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Bulk scheduling result counts, status, and item keys must agree",
      });
    }
  });

export const bulkScheduleAutomationItemSchema = bulkScheduleItemSchema.omit({
  approvalOverrideReason: true,
});

export const bulkScheduleAutomationSchema = bulkScheduleSchema.extend({
  items: z
    .array(bulkScheduleAutomationItemSchema)
    .min(1)
    .max(100)
    .superRefine(requireUniqueBulkScheduleItems),
});

export type AssistedCopyContentInput = z.infer<typeof assistedCopyContentSchema>;
export type AssistedCopyView = z.infer<typeof assistedCopyViewSchema>;
export type GenerateAssistedCopyRequest = z.infer<typeof generateAssistedCopySchema>;
export type ConfirmAssistedCopyRequest = z.infer<typeof confirmAssistedCopySchema>;
export type ListAssistedCopyRequest = z.infer<typeof listAssistedCopySchema>;
export type RequestThumbnailExtractionInput = z.infer<typeof requestThumbnailExtractionSchema>;
export type ThumbnailExtractionView = z.infer<
  typeof thumbnailExtractionViewSchema
>;
export type ListThumbnailExtractionsInput = z.infer<
  typeof listThumbnailExtractionsSchema
>;
export type BulkScheduleRequest = z.infer<typeof bulkScheduleSchema>;
export type BulkScheduleResult = z.infer<typeof bulkScheduleResultSchema>;
export type BulkScheduleAutomationRequest = z.infer<
  typeof bulkScheduleAutomationSchema
>;
