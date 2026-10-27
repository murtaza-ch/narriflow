import {
  formatUsdCents,
  PLAN_CATALOG,
  type PlanChangeQuote,
  type WorkspaceBillingView,
} from "@narriflow/validators";

export function canChangePaidPlan(input: {
  view: WorkspaceBillingView;
  canManageBilling: boolean;
  isConfigured: boolean;
}): boolean {
  return input.canManageBilling && input.isConfigured &&
    input.view.plan !== "free" && input.view.status === "active" &&
    input.view.health === "current" && !input.view.cancelAtPeriodEnd &&
    input.view.planChange?.state !== "pending_payment";
}

export function formatBillingChangeDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  }).format(new Date(value));
}

export function planChangeQuotePresentation(quote: PlanChangeQuote) {
  const name = PLAN_CATALOG[quote.tier].name;
  if (quote.kind === "scheduled") {
    return {
      title: `Switch to ${name}`,
      body: `Your current plan stays active until ${formatBillingChangeDate(quote.effectiveAt)} UTC. The new plan starts then. No payment is collected today.`,
      action: "Schedule plan change",
      due: formatUsdCents(0),
    };
  }
  return {
    title: `Switch to ${name}`,
    body: quote.amountDue < 0
      ? `A credit of ${formatUsdCents(-quote.amountDue)} will be applied to your billing balance. Your plan changes after Stripe confirms the update.`
      : "Stripe applies unused-time credits and any prorated charges. The new plan starts after payment succeeds.",
    action: quote.amountDue > 0 ? `Pay ${formatUsdCents(quote.amountDue)} and upgrade now` : "Confirm plan change",
    due: formatUsdCents(Math.max(0, quote.amountDue)),
  };
}

/** A hosted Stripe invoice can collect payment without accepting arbitrary redirects. */
export function stripeInvoicePaymentUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "invoice.stripe.com" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
