import { describe, expect, test } from "bun:test";
import {
  billingStatusPresentation,
  billingViewChangesEntitlements,
  canStartBillingCheckout,
  shouldFocusBillingStatus,
  shouldShowSeatSyncStatus,
  upgradeBillingMode,
} from "./billing-view-model";

const base = {
  workspaceId: "018f5f6a-4c31-7c75-9a4f-8f74f977bc10",
  plan: "pro" as const,
  interval: "monthly" as const,
  status: "active" as const,
  workspaceAccessStatus: "active" as const,
  health: "current" as const,
  renewalOrEndAt: "2026-09-28T10:00:00.000Z",
  cancelAtPeriodEnd: false,
  planChange: null,
  graceDeadlineAt: null,
  lastSuccessfulSyncAt: "2026-08-28T10:00:00.000Z",
  desiredAdditionalSeats: 0,
  synchronizedAdditionalSeats: 0,
  actions: ["open_portal" as const],
};

describe("billing status presentation", () => {
  test("offers Checkout only when it is the single primary recovery path", () => {
    const free = { ...base, plan: "free" as const, actions: ["start_checkout" as const] };
    expect(
      canStartBillingCheckout({
        view: free,
        canManageBilling: true,
        isConfigured: true,
      }),
    ).toBe(true);
    expect(
      canStartBillingCheckout({
        view: { ...free, health: "retrying", actions: ["retry"] },
        canManageBilling: true,
        isConfigured: true,
      }),
    ).toBe(false);
    expect(
      canStartBillingCheckout({
        view: { ...free, health: "activating", actions: [] },
        canManageBilling: true,
        isConfigured: true,
      }),
    ).toBe(false);
    expect(
      canStartBillingCheckout({
        view: {
          ...free,
          workspaceAccessStatus: "restricted",
          actions: ["open_portal"],
        },
        canManageBilling: true,
        isConfigured: true,
      }),
    ).toBe(false);
  });

  test("uses durable health and access facts for recovery copy", () => {
    expect(
      billingStatusPresentation({ ...base, health: "activating" }),
    ).toMatchObject({
      headline: "Activating your plan",
      body: expect.stringContaining("leave this page"),
      live: "polite",
    });
    expect(
      billingStatusPresentation({ ...base, health: "retrying" }),
    ).toMatchObject({
      headline: "Billing sync delayed",
      body: expect.stringContaining("verified access is unchanged"),
    });
    expect(
      billingStatusPresentation({
        ...base,
        health: "payment_action_required",
        status: "payment_past_due",
        graceDeadlineAt: "2026-09-04T10:00:00.000Z",
      }),
    ).toMatchObject({
      headline: "Payment action required",
      dateLabel: "Recovery deadline",
      primaryAction: "open_portal",
    });
    expect(
      billingStatusPresentation({
        ...base,
        workspaceAccessStatus: "restricted",
        plan: "free",
      }),
    ).toMatchObject({
      headline: "Workspace access is restricted",
      body: expect.stringContaining("downloads and billing repair remain available"),
    });
    expect(
      billingStatusPresentation({ ...base, health: "attention_required" }),
    ).toMatchObject({
      headline: "Billing needs attention",
      body: expect.not.stringContaining("conflict"),
    });
  });

  test("limits paid-seat synchronization copy to Business owners", () => {
    const delayed = {
      ...base,
      plan: "business" as const,
      desiredAdditionalSeats: 2,
      synchronizedAdditionalSeats: 1,
    };
    expect(shouldShowSeatSyncStatus(delayed, "owner")).toBe(true);
    expect(
      shouldShowSeatSyncStatus({ ...delayed, plan: "pro" }, "owner"),
    ).toBe(false);
    expect(shouldShowSeatSyncStatus(delayed, "admin")).toBe(false);
  });

  test("moves focus only for activation completion or a new restriction", () => {
    expect(
      shouldFocusBillingStatus(
        { health: "activating", workspaceAccessStatus: "active" },
        { health: "current", workspaceAccessStatus: "active" },
      ),
    ).toBe(true);
    expect(
      shouldFocusBillingStatus(
        { health: "current", workspaceAccessStatus: "active" },
        { health: "current", workspaceAccessStatus: "restricted" },
      ),
    ).toBe(true);
    expect(
      shouldFocusBillingStatus(
        { health: "retrying", workspaceAccessStatus: "active" },
        { health: "retrying", workspaceAccessStatus: "active" },
      ),
    ).toBe(false);
  });
});

describe("upgradeBillingMode", () => {
  test("a first subscription chooses an interval for Checkout", () => {
    expect(upgradeBillingMode({ ...base, plan: "free", actions: ["start_checkout"] })).toBe("checkout");
  });

  test("a current paid subscription reviews a plan change in billing", () => {
    expect(upgradeBillingMode(base)).toBe("change_plan");
  });

  test("portal access for repair or recovery goes to the billing page", () => {
    expect(upgradeBillingMode({ ...base, plan: "free", workspaceAccessStatus: "restricted" })).toBe("billing");
    expect(upgradeBillingMode({ ...base, health: "attention_required", actions: ["open_portal", "contact_support"] })).toBe("billing");
    expect(upgradeBillingMode({ ...base, plan: "free" })).toBe("billing");
    expect(upgradeBillingMode({ ...base, health: "activating", actions: [] })).toBe("billing");
  });
});

describe("billingViewChangesEntitlements", () => {
  test("is false for the first view and for a view that only finished settling", () => {
    expect(billingViewChangesEntitlements(undefined, base)).toBe(false);
    expect(
      billingViewChangesEntitlements(
        { ...base, health: "activating" },
        { ...base, health: "current", lastSuccessfulSyncAt: "2026-08-29T10:00:00.000Z" },
      ),
    ).toBe(false);
  });

  test("is true when the verified plan, access, status or seats move", () => {
    expect(billingViewChangesEntitlements(base, { ...base, plan: "business" })).toBe(true);
    expect(billingViewChangesEntitlements(base, { ...base, interval: "annual" })).toBe(true);
    expect(billingViewChangesEntitlements(base, { ...base, workspaceAccessStatus: "restricted" })).toBe(true);
    expect(billingViewChangesEntitlements(base, { ...base, status: "payment_failed" })).toBe(true);
    expect(billingViewChangesEntitlements(base, { ...base, synchronizedAdditionalSeats: 2 })).toBe(true);
  });
});
