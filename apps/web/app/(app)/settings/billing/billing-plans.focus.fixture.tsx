import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { WorkspaceBillingView } from "@narriflow/validators";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const browser = new Window({ url: "http://localhost:3000/settings/billing" });

mock.module("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined }),
}));

let BillingPlans: typeof import("./billing-plans").BillingPlans;
let ChakraProvider: typeof import("@chakra-ui/react").ChakraProvider;
let system: typeof import("@narriflow/ui/theme").system;
let root: Root | null = null;

const retryingView: WorkspaceBillingView = {
  workspaceId: "018f5f6a-4c31-7c75-9a4f-8f74f977bc10",
  plan: "pro",
  interval: "monthly",
  status: "active",
  workspaceAccessStatus: "active",
  health: "retrying",
  renewalOrEndAt: null,
  cancelAtPeriodEnd: false,
  graceDeadlineAt: null,
  lastSuccessfulSyncAt: null,
  desiredAdditionalSeats: 0,
  synchronizedAdditionalSeats: null,
  actions: ["retry"],
};

function installBrowserGlobals() {
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      browser.setTimeout(() => callback(browser.performance.now()), 0),
    cancelAnimationFrame: (handle: number) => browser.clearTimeout(handle),
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
}

async function renderBilling(initialView = retryingView) {
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLDivElement);
  await act(async () => {
    root?.render(
      <ChakraProvider value={system}>
        <BillingPlans
          initialView={initialView}
          availableTiers={["creator", "pro", "business"]}
          isConfigured
          canManageBilling
          checkoutReturnSessionId={null}
          checkoutCancelled={false}
        />
      </ChakraProvider>
    );
  });
  return container;
}

beforeAll(async () => {
  installBrowserGlobals();
  ({ BillingPlans } = await import("./billing-plans"));
  ({ ChakraProvider } = await import("@chakra-ui/react"));
  ({ system } = await import("@narriflow/ui/theme"));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  browser.document.body.replaceChildren();
});

afterAll(() => browser.close());

describe("BillingPlans focus recovery", () => {
  test("moves focus to the live status after recovery settles", async () => {
    const activatingView: WorkspaceBillingView = {
      ...retryingView,
      plan: "free",
      interval: null,
      health: "activating",
      workspaceAccessStatus: "pending_payment",
      status: "payment_pending",
      actions: [],
    };
    globalThis.fetch = mock(async () =>
      Response.json({
        view: { ...retryingView, health: "current", actions: ["open_portal"] },
      }),
    ) as unknown as typeof fetch;
    const container = await renderBilling(activatingView);

    await act(async () => {
      await browser.happyDOM.waitUntilComplete();
    });

    expect(browser.document.activeElement).toBe(
      container.querySelector('[role="status"]'),
    );
  });

  test("returns focus to the originating action after an inline failure", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ error: "provider_unavailable" }, { status: 503 }),
    ) as unknown as typeof fetch;
    const container = await renderBilling();
    const retry = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Retry sync"),
    );
    expect(retry).toBeDefined();
    retry?.focus();

    await act(async () => {
      retry?.click();
      await browser.happyDOM.waitUntilComplete();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Billing sync is still delayed",
    );
    expect(browser.document.activeElement).toBe(retry);
  });
});
