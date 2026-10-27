import { describe, expect, test } from "bun:test";
import type { PlanChangeQuote, WorkspaceBillingView } from "@narriflow/validators";
import { canChangePaidPlan, planChangeQuotePresentation, stripeInvoicePaymentUrl } from "./billing-plan-change";

const quote: PlanChangeQuote = {
  id: "018f5f6a-4c31-7c75-9a4f-8f74f977bc12",
  tier: "pro", interval: "monthly", kind: "immediate", amountDue: 745, currency: "usd",
  effectiveAt: "2026-10-27T12:00:00.000Z", expiresAt: "2026-10-27T12:10:00.000Z",
};
const paid: WorkspaceBillingView = {
  workspaceId: "018f5f6a-4c31-7c75-9a4f-8f74f977bc10",
  plan: "pro", interval: "monthly", status: "active", workspaceAccessStatus: "active", health: "current",
  renewalOrEndAt: null, cancelAtPeriodEnd: false, planChange: null, graceDeadlineAt: null,
  lastSuccessfulSyncAt: null, desiredAdditionalSeats: 0, synchronizedAdditionalSeats: null,
  actions: ["open_portal"],
};

describe("plan change review", () => {
  test("names the exact prorated charge before payment and preserves payment gating", () => {
    expect(planChangeQuotePresentation(quote)).toMatchObject({
      title: "Switch to Pro", due: "$7.45", action: "Pay $7.45 and upgrade now",
      body: expect.stringContaining("as soon as payment succeeds"),
    });
  });

  test("a downgrade promises retained access and no payment today", () => {
    expect(planChangeQuotePresentation({ ...quote, kind: "scheduled", amountDue: 0 })).toMatchObject({
      due: "$0", action: "Schedule plan change",
      body: expect.stringContaining("Your current plan stays active until Oct 27, 2026 UTC"),
    });
  });

  test("a change covered by unused time asks for nothing today", () => {
    expect(planChangeQuotePresentation({ ...quote, amountDue: 0 })).toMatchObject({
      due: "$0", action: "Upgrade now", body: expect.stringContaining("nothing is due today"),
    });
  });

  test("a new change says it replaces the one already scheduled", () => {
    const scheduled = { tier: "creator" as const, effectiveAt: "2027-10-27T00:00:00.000Z" };
    expect(planChangeQuotePresentation(quote, scheduled).body).toContain("This replaces your scheduled switch to Creator on Oct 27, 2027.");
    expect(planChangeQuotePresentation(quote).body).not.toContain("replaces");
  });

  test("only healthy paid owners can start changes, including a team restricted by its tier", () => {
    const input = { view: paid, canManageBilling: true, isConfigured: true };
    expect(canChangePaidPlan(input)).toBe(true);
    expect(canChangePaidPlan({ ...input, view: { ...paid, workspaceAccessStatus: "restricted" } })).toBe(true);
    expect(canChangePaidPlan({ ...input, canManageBilling: false })).toBe(false);
    expect(canChangePaidPlan({ ...input, isConfigured: false })).toBe(false);
    for (const view of [
      { ...paid, plan: "free" as const },
      { ...paid, health: "retrying" as const },
      { ...paid, health: "attention_required" as const },
      { ...paid, status: "payment_past_due" as const },
      { ...paid, cancelAtPeriodEnd: true },
      { ...paid, planChange: { state: "pending_payment" as const, tier: "business" as const, interval: "monthly" as const, effectiveAt: null } },
    ]) expect(canChangePaidPlan({ ...input, view })).toBe(false);
  });

  test("invoice recovery accepts the hosted Stripe invoice origin only", () => {
    expect(stripeInvoicePaymentUrl("https://invoice.stripe.com/i/acct_test/example")).toBe("https://invoice.stripe.com/i/acct_test/example");
    for (const url of ["javascript:alert(1)", "http://invoice.stripe.com/i/test", "https://invoice.stripe.com.evil.test/i/test", "https://stripe.com@evil.test", "https://evil@invoice.stripe.com/i/test"]) {
      expect(stripeInvoicePaymentUrl(url)).toBeNull();
    }
  });
});
