import { z } from "zod";
export {
  createReviewRoundSchema, internalReviewCommentSchema, inviteReviewersSchema,
  retryReviewNotificationSchema, reviewGuestAccessSchema, reviewCommentSchema,
  reviewCommentEditSchema, reviewDecisionSchema,
} from "../review";

export const reviewTokenParamsSchema = z.object({ token: z.string().min(1).max(2048) });
export const reviewCommentParamsSchema = reviewTokenParamsSchema.extend({ commentId: z.string().uuid() });
export const reviewMediaParamsSchema = reviewTokenParamsSchema.extend({ itemId: z.string().uuid(), variantId: z.string().uuid() });
export const reviewOptOutSchema = z.object({ token: z.string().min(1).max(4096) });
export const reviewSessionSchema = z.object({ sessionToken: z.string(), expiresAt: z.string().datetime() });
export const reviewMediaGrantSchema = z.object({ url: z.string().url(), expiresAt: z.string().datetime() });
export type ReviewSession = z.infer<typeof reviewSessionSchema>;
export type ReviewMediaGrant = z.infer<typeof reviewMediaGrantSchema>;
