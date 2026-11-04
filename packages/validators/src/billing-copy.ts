import { z } from "zod";
import { billingIntervalSchema, pricingTierSchema } from "./pricing";
import { billingPlanChangeSchema } from "./billing-plan-change";

export const billingHealthSchema = z.enum([
  "current",
  "activating",
  "payment_action_required",
  "retrying",
  "attention_required",
]);

export type BillingHealth = z.infer<typeof billingHealthSchema>;

export const workspaceBillingViewSchema = z.object({
  workspaceId: z.uuid(),
  plan: pricingTierSchema,
  interval: billingIntervalSchema.nullable(),
  status: z.enum([
    "active",
    "trial",
    "payment_pending",
    "payment_past_due",
    "payment_failed",
    "payment_expired",
    "paused",
    "canceled",
  ]),
  workspaceAccessStatus: z.enum(["active", "pending_payment", "restricted"]),
  health: billingHealthSchema,
  renewalOrEndAt: z.iso.datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  planChange: billingPlanChangeSchema.nullable(),
  graceDeadlineAt: z.iso.datetime().nullable(),
  lastSuccessfulSyncAt: z.iso.datetime().nullable(),
  desiredAdditionalSeats: z.number().int().nonnegative(),
  synchronizedAdditionalSeats: z.number().int().nonnegative().nullable(),
  actions: z.array(
    z.enum(["start_checkout", "open_portal", "retry", "contact_support"]),
  ),
});
export type WorkspaceBillingView = z.infer<typeof workspaceBillingViewSchema>;
