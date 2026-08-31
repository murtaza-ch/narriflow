import { z } from "zod";

export const reviewIdempotencyKeySchema = z.string().uuid();

export const reviewNotificationKindSchema = z.enum([
  "round_sent",
  "round_resent",
  "first_changes_requested",
  "all_approved",
  "mention",
]);

export const reviewSelectedVariantIdsSchema = z.array(z.string().uuid()).min(1).max(4);

export const createReviewRoundSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  message: z.string().trim().max(2_000).nullable().default(null),
  passcode: z.string().min(6).max(128).nullable().default(null),
  expiresAt: z.string().datetime().nullable().default(null),
  allowDownloads: z.boolean().default(false),
  approvalRequired: z.boolean().optional(),
  recipientEmails: z.array(z.string().trim().email().max(254)).max(50).default([]),
  sourceRoundId: z.string().uuid().nullable().default(null),
  items: z.array(z.strictObject({
    clipId: z.string().uuid(),
    exportId: z.string().uuid(),
    expectedEditorRevision: z.number().int().nonnegative(),
    variantIds: reviewSelectedVariantIdsSchema,
    required: z.boolean().default(true),
  })).min(1).max(100),
});

export const createReviewRoundAutomationSchema = createReviewRoundSchema
  .extend({ idempotencyKey: reviewIdempotencyKeySchema })
  .strict();

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

export const reviewCommentEditSchema = z.strictObject({
  body: z.string().trim().min(1).max(2_000),
});

export const reviewDecisionSchema = z.strictObject({
  decision: z.enum(["approved", "changes_requested"]),
  itemId: z.string().uuid().nullable().default(null),
  reason: z.string().trim().max(1_000).nullable().default(null),
});

export const internalReviewCommentSchema = reviewCommentSchema.extend({
  mentionRecipientIds: z.array(z.string().uuid()).max(10).default([]),
}).strict();

export const reviewNotificationRetrySchema = z.strictObject({
  idempotencyKey: reviewIdempotencyKeySchema,
});

export const reviewApprovalOverrideSchema = z.strictObject({
  idempotencyKey: z.string().uuid(),
  exportIds: z.array(z.string().uuid()).min(1).max(100),
  reason: z.string().trim().min(1).max(500),
});

export const reviewNotificationDeliveryResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.enum(["pending", "failed"]),
      notificationId: z.string().uuid(),
      failureCode: z.string().trim().min(1).max(160),
    }),
    z.strictObject({
      status: z.enum(["sent", "already_claimed", "not_found", "disabled"]),
      notificationId: z.string().uuid(),
      failureCode: z.null(),
    }),
  ],
);

export const reviewRoundCreateResponseSchema = z
  .strictObject({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    path: z.string().max(160),
    notificationIds: z.array(z.string().uuid()).max(50),
    replayed: z.boolean(),
    delivery: z.array(reviewNotificationDeliveryResponseSchema).max(50),
  })
  .superRefine((value, context) => {
    const notificationIds = new Set(value.notificationIds);
    const deliveryIds = new Set(
      value.delivery.map((entry) => entry.notificationId),
    );
    if (
      value.path !== `/review/${value.token}` ||
      notificationIds.size !== value.notificationIds.length ||
      deliveryIds.size !== value.delivery.length ||
      value.delivery.length !== value.notificationIds.length ||
      value.delivery.some(
        (entry) => !notificationIds.has(entry.notificationId),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Review-round path and notification delivery must match the created round",
      });
    }
  });

export type CreateReviewRoundInput = z.infer<typeof createReviewRoundSchema>;
export type ReviewNotificationKind = z.infer<
  typeof reviewNotificationKindSchema
>;
export type CreateReviewRoundAutomationInput = z.infer<
  typeof createReviewRoundAutomationSchema
>;
export type ReviewGuestAccessInput = z.infer<typeof reviewGuestAccessSchema>;
export type ReviewCommentInput = z.infer<typeof reviewCommentSchema>;
export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>;
export type InternalReviewCommentInput = z.infer<typeof internalReviewCommentSchema>;
export type ReviewApprovalOverrideInput = z.infer<typeof reviewApprovalOverrideSchema>;
export type ReviewRoundCreateResponse = z.infer<
  typeof reviewRoundCreateResponseSchema
>;
