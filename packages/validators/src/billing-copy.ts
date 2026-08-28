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
} as const;

export type BillingHealth = keyof typeof BILLING_HEALTH_COPY;
