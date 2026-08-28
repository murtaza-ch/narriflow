import { z } from "zod";

export const billingHealthSchema = z.enum([
  "current",
  "activating",
  "payment_action_required",
  "retrying",
  "attention_required",
]);

export type BillingHealth = z.infer<typeof billingHealthSchema>;

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
