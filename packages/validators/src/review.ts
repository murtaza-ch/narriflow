import { z } from "zod";

export const reviewSelectedVariantIdsSchema = z.array(z.string().uuid()).min(1).max(4);

export const createReviewRoundSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  message: z.string().trim().max(2_000).nullable().default(null),
  passcode: z.string().min(6).max(128).nullable().default(null),
  expiresAt: z.string().datetime().nullable().default(null),
  allowDownloads: z.boolean().default(false),
  approvalRequired: z.boolean().default(true),
  recipientEmails: z.array(z.string().trim().email().max(254)).max(25).default([]),
  contextCommentIds: z.array(z.string().uuid()).max(100).default([]),
  items: z.array(z.strictObject({
    clipId: z.string().uuid(),
    exportId: z.string().uuid(),
    expectedEditorRevision: z.number().int().nonnegative(),
    variantIds: reviewSelectedVariantIdsSchema,
    required: z.boolean().default(true),
  })).min(1).max(100),
});

export const retryReviewNotificationSchema = z.strictObject({
  ledgerId: z.string().uuid(),
});

export const reviewGuestAccessSchema = z.strictObject({
  identity: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  passcode: z.string().min(1).max(128).nullable().default(null),
});

export const reviewCommentSchema = z.strictObject({
  itemId: z.string().uuid().nullable().default(null),
  parentId: z.string().uuid().nullable().default(null),
  body: z.string().trim().min(1).max(2_000),
  timestampSec: z.number().finite().nonnegative().max(60 * 60 * 12).nullable().default(null),
});

export const internalReviewCommentSchema = reviewCommentSchema.extend({
  mentionRecipients: z.array(z.string().trim().email().max(254)).max(25).default([]),
});

export const reviewCommentEditSchema = z.strictObject({
  body: z.string().trim().min(1).max(2_000),
});

export const reviewDecisionSchema = z.strictObject({
  decision: z.enum(["approved", "changes_requested"]),
  itemId: z.string().uuid().nullable().default(null),
  reason: z.string().trim().max(1_000).nullable().default(null),
});

export type CreateReviewRoundInput = z.infer<typeof createReviewRoundSchema>;
export type ReviewGuestAccessInput = z.infer<typeof reviewGuestAccessSchema>;
export type ReviewCommentInput = z.infer<typeof reviewCommentSchema>;
export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>;
export type InternalReviewCommentInput = z.infer<typeof internalReviewCommentSchema>;
export type RetryReviewNotificationInput = z.infer<typeof retryReviewNotificationSchema>;
