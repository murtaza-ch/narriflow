import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import {
  formatUsdCents,
  PLAN_CATALOG,
  type BillingInterval,
  type PaidPricingTier,
  type WorkspaceBillingView,
} from "@narriflow/validators";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined }),
}));

const { BillingPlans } = await import("./billing-plans");

const current: WorkspaceBillingView = {
  workspaceId: "018f5f6a-4c31-7c75-9a4f-8f74f977bc10",
  plan: "free",
  interval: null,
  status: "active",
  workspaceAccessStatus: "active",
  health: "current",
  renewalOrEndAt: null,
  cancelAtPeriodEnd: false,
  planChange: null,
  graceDeadlineAt: null,
  lastSuccessfulSyncAt: null,
  desiredAdditionalSeats: 0,
  synchronizedAdditionalSeats: null,
  actions: ["start_checkout"],
};

function render(
  view: WorkspaceBillingView,
  canManageBilling = true,
  extra: { focusTier?: PaidPricingTier | null; requestedInterval?: BillingInterval | null } = {},
) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <BillingPlans
        initialView={view}
        availableTiers={["creator", "pro", "business"]}
        isConfigured
        canManageBilling={canManageBilling}
        checkoutReturnSessionId={null}
        checkoutCancelled={false}
        {...extra}
      />
    </ChakraProvider>,
  );
}

describe("BillingPlans", () => {
  test("renders first-subscription choices for a current Free owner", () => {
    const markup = render(current);
    expect(markup).toContain("Choose a plan");
    expect(markup).toContain("Continue with Creator");
    expect(markup).not.toContain("Retry sync");
  });

  test("renders one retry action and no competing Checkout actions", () => {
    const markup = render({ ...current, health: "retrying", actions: ["retry"] });
    expect(markup).toContain("Retry sync");
    expect(markup).not.toContain("Choose a plan");
    expect(markup).not.toContain("Continue with Creator");
    expect(markup).toContain('aria-live="polite"');
  });

  test("shows activation progress without allowing another payment", () => {
    const markup = render({ ...current, health: "activating", actions: [] });
    expect(markup).toContain("Activating your plan");
    expect(markup).not.toContain("Continue with Creator");
  });

  test("keeps non-owner billing read-only", () => {
    const markup = render(current, false);
    expect(markup).toContain("Only the workspace owner can change");
    expect(markup).not.toContain("Continue with Creator");
    expect(markup).not.toContain("Open billing portal");
  });

  test("renders portal repair without a competing Checkout in restricted state", () => {
    const markup = render({
      ...current,
      workspaceAccessStatus: "restricted",
      actions: ["open_portal"],
    });
    expect(markup).toContain("Open billing portal");
    expect(markup).not.toContain("Continue with Creator");
  });

  test("shows verified Business seat facts without raw provider state", () => {
    const markup = render({
      ...current,
      plan: "business",
      interval: "monthly",
      desiredAdditionalSeats: 2,
      synchronizedAdditionalSeats: 1,
      actions: ["open_portal"],
    });
    expect(markup).toContain("Owner seat included. Viewers are free.");
    expect(markup).toContain("Updating in the background");
    expect(markup).toContain("Open billing portal");
  });

  test("marks the plan an upgrade prompt asked for as selected", () => {
    const markup = render(current, true, { focusTier: "business" });
    expect(markup).toContain("Selected");
    // Pro keeps its own recommendation; only the requested plan is "Selected".
    expect(markup).toContain("Recommended");
    expect(markup).toContain("Continue with Business");
  });

  test("keeps Recommended on Pro when no plan was requested or the request is not offered", () => {
    expect(render(current)).toContain("Recommended");
    expect(render(current)).not.toContain("Selected");
    const markup = renderToStaticMarkup(
      <ChakraProvider value={system}>
        <BillingPlans
          initialView={current}
          availableTiers={["creator", "pro"]}
          isConfigured
          canManageBilling
          checkoutReturnSessionId={null}
          checkoutCancelled={false}
          focusTier="business"
        />
      </ChakraProvider>,
    );
    expect(markup).not.toContain("Selected");
    expect(markup).toContain("Recommended");
  });

  test("prices every plan at the interval the prompt showed", () => {
    const monthly = render(current, true, { requestedInterval: "monthly" });
    const annual = render(current, true, { requestedInterval: "annual" });
    const monthlyPrice = formatUsdCents(PLAN_CATALOG.pro.monthlyPriceCents);
    const annualPerMonth = formatUsdCents(Math.round(PLAN_CATALOG.pro.annualPriceCents / 12));
    expect(monthly).toContain(monthlyPrice);
    expect(monthly).not.toContain(annualPerMonth);
    expect(annual).toContain(annualPerMonth);
    expect(annual).not.toContain(monthlyPrice);
  });

  test("a requested interval wins over the subscription's own interval", () => {
    const view = { ...current, interval: "monthly" as const };
    const markup = render(view, true, { requestedInterval: "annual" });
    expect(markup).toContain(formatUsdCents(Math.round(PLAN_CATALOG.pro.annualPriceCents / 12)));
  });

  describe("paid workspace changing plan", () => {
    const paid: WorkspaceBillingView = {
      ...current,
      plan: "pro",
      interval: "monthly",
      actions: ["open_portal"],
    };

    test("offers a review of every paid plan without opening another Checkout", () => {
      const markup = render(paid, true, { focusTier: "business" });
      expect(markup).toContain("Review Business");
      expect(markup).toContain("Review Creator");
      expect(markup).toContain("Current plan");
      expect(markup).toContain("Change plan");
      expect(markup).not.toContain("Choose a plan");
      expect(markup).not.toContain("Continue with Business");
    });

    test("paid owners can choose without an upgrade prompt while non-owners stay read-only", () => {
      expect(render(paid)).toContain("Review Business");
      expect(render(paid, true, { focusTier: "pro" })).toContain("Current plan");
      expect(render(paid, false, { focusTier: "business" })).not.toContain("Review Business");
    });

    test("billing repair keeps its recovery instead of a plan switch", () => {
      const restricted: WorkspaceBillingView = { ...paid, plan: "free", workspaceAccessStatus: "restricted" };
      const attention: WorkspaceBillingView = {
        ...paid,
        health: "attention_required",
        actions: ["open_portal", "contact_support"],
      };
      expect(render(restricted, true, { focusTier: "business" })).not.toContain("Review Business");
      expect(render(attention, true, { focusTier: "business" })).not.toContain("Review Business");
    });

    test("a paid team restricted by its tier can upgrade to restore team access", () => {
      expect(render({ ...paid, workspaceAccessStatus: "restricted" })).toContain("Review Business");
    });

    test("shows the scheduled target and a way to keep the current plan", () => {
      const scheduled: WorkspaceBillingView = {
        ...paid,
        planChange: { state: "scheduled", tier: "creator", interval: "monthly", effectiveAt: "2026-11-27T12:00:00.000Z" },
      };
      const markup = render(scheduled);
      expect(markup).toContain("Switching to Creator");
      expect(markup).toContain("Nov 27, 2026 UTC");
      expect(markup).toContain("Keep current plan");
      expect(render(scheduled, false)).not.toContain("Keep current plan");
    });

    test("a pending upgrade preserves the current plan and blocks another change", () => {
      const markup = render({
        ...paid,
        planChange: { state: "pending_payment", tier: "business", interval: "monthly", effectiveAt: null },
      });
      expect(markup).toContain("switch to Business is awaiting payment");
      expect(markup).toContain("Your current plan remains active");
      expect(markup).not.toContain("Review Business");
    });
  });
});
