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

/**
 * The confirmation copy for a quote. A new change replaces any change already
 * scheduled, so the owner is told before confirming rather than finding out later.
 */
export function planChangeQuotePresentation(
  quote: PlanChangeQuote,
  scheduled?: { tier: WorkspaceBillingView["plan"]; effectiveAt: string | null } | null,
) {
  const name = PLAN_CATALOG[quote.tier].name;
  const replaces = scheduled
    ? ` This replaces your scheduled switch to ${PLAN_CATALOG[scheduled.tier].name}${scheduled.effectiveAt ? ` on ${formatBillingChangeDate(scheduled.effectiveAt)}` : ""}.`
    : "";
  if (quote.kind === "scheduled") {
    return {
      title: `Switch to ${name}`,
      body: `Your current plan stays active until ${formatBillingChangeDate(quote.effectiveAt)} UTC. The new plan starts then. No payment is collected today.${replaces}`,
      action: "Schedule plan change",
      due: formatUsdCents(0),
    };
  }
  // Stripe never asks for a negative amount: unused-time credit beyond the
  // upgrade's cost goes to the account balance, so nothing is due today.
  const due = Math.max(0, quote.amountDue);
  return {
    title: `Switch to ${name}`,
    body: (due > 0
      ? "Stripe credits your unused time and charges the difference now. The new plan starts as soon as payment succeeds."
      : "Your unused time covers the change, so nothing is due today. The new plan starts as soon as Stripe confirms it.") + replaces,
    action: due > 0 ? `Pay ${formatUsdCents(due)} and upgrade now` : "Upgrade now",
    due: formatUsdCents(due),
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
