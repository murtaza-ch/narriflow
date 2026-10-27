import { z } from "zod";
import { billingIntervalSchema, paidPricingTierSchema } from "./pricing";

export const billingPlanChangeSchema = z.object({
  state: z.enum(["pending_payment", "scheduled"]),
  tier: paidPricingTierSchema,
  interval: billingIntervalSchema,
  effectiveAt: z.iso.datetime().nullable(),
});
export type BillingPlanChange = z.infer<typeof billingPlanChangeSchema>;

export const planChangePreviewRequestSchema = z.object({
  clientIdempotencyKey: z.uuid(),
  tier: paidPricingTierSchema,
  interval: billingIntervalSchema,
}).strict();
export const planChangeConfirmRequestSchema = z.object({ quoteId: z.uuid() }).strict();
export const planChangeQuoteSchema = z.object({
  id: z.uuid(),
  tier: paidPricingTierSchema,
  interval: billingIntervalSchema,
  kind: z.enum(["immediate", "scheduled"]),
  amountDue: z.number().int(),
  currency: z.literal("usd"),
  effectiveAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type PlanChangeQuote = z.infer<typeof planChangeQuoteSchema>;
export const planChangeResultSchema = z.object({
  kind: z.enum(["applied", "pending_payment", "scheduled", "unchanged"]),
  paymentUrl: z.url().optional(),
  effectiveAt: z.iso.datetime().nullable(),
});
export type PlanChangeResult = z.infer<typeof planChangeResultSchema>;
