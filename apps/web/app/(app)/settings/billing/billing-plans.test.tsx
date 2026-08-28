import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import type { WorkspaceBillingView } from "@narriflow/validators";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined }),
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
  graceDeadlineAt: null,
  lastSuccessfulSyncAt: null,
  desiredAdditionalSeats: 0,
  synchronizedAdditionalSeats: null,
  actions: ["start_checkout"],
};

function render(view: WorkspaceBillingView, canManageBilling = true) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <BillingPlans
        initialView={view}
        availableTiers={["creator", "pro", "business"]}
        isConfigured
        canManageBilling={canManageBilling}
        checkoutReturnSessionId={null}
        checkoutCancelled={false}
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

  test("keeps non-owner billing read-only", () => {
    const markup = render(current, false);
    expect(markup).toContain("Only the workspace owner can change");
    expect(markup).not.toContain("Continue with Creator");
    expect(markup).not.toContain("Open billing portal");
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
});
