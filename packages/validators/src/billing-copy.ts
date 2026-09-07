import { z } from "zod";
import { billingIntervalSchema, pricingTierSchema } from "./pricing";

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
  graceDeadlineAt: z.iso.datetime().nullable(),
  lastSuccessfulSyncAt: z.iso.datetime().nullable(),
  desiredAdditionalSeats: z.number().int().nonnegative(),
  synchronizedAdditionalSeats: z.number().int().nonnegative().nullable(),
  actions: z.array(
    z.enum(["start_checkout", "open_portal", "retry", "contact_support"]),
  ),
});
export type WorkspaceBillingView = z.infer<typeof workspaceBillingViewSchema>;

export const BILLING_HEALTH_COPY = {
  current: {
    label: "Current",
    description: "Your verified plan and access are up to date.",
  },
  activating: {
    label: "Activating your plan",
    description: "Payment was received. Access will update after verification.",
  },
  payment_action_required: {
    label: "Payment action required",
    description: "Update payment details before the displayed grace deadline.",
  },
  retrying: {
    label: "Sync delayed",
    description: "Current verified access is unchanged while billing retries.",
  },
  attention_required: {
    label: "Billing needs attention",
    description: "Open the billing portal or contact support to resolve this account.",
  },
} as const satisfies Record<
  BillingHealth,
  { label: string; description: string }
>;
