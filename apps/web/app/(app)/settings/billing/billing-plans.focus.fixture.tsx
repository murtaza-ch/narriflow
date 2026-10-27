import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import {
  formatUsdCents,
  PLAN_CATALOG,
  type BillingInterval,
  type WorkspaceBillingView,
} from "@narriflow/validators";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const browser = new Window({ url: "http://localhost:3000/settings/billing" });

mock.module("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined }),
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
  planChange: null,
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
    HTMLInputElement: browser.HTMLInputElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    KeyboardEvent: browser.KeyboardEvent,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      browser.setTimeout(() => callback(browser.performance.now()), 0),
    cancelAnimationFrame: (handle: number) => browser.clearTimeout(handle),
    getComputedStyle: browser.getComputedStyle.bind(browser),
    CSS: browser.CSS,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
}

function billingElement(initialView: WorkspaceBillingView, requestedInterval: BillingInterval | null = null) {
  return (
    <ChakraProvider value={system}>
      <BillingPlans
        initialView={initialView}
        availableTiers={["creator", "pro", "business"]}
        isConfigured
        canManageBilling
        checkoutReturnSessionId={null}
        checkoutCancelled={false}
        requestedInterval={requestedInterval}
      />
    </ChakraProvider>
  );
}

async function renderBilling(initialView = retryingView) {
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLDivElement);
  await act(async () => {
    root?.render(billingElement(initialView));
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

  test("follows a new requested interval when the same route re-renders", async () => {
    const freeView: WorkspaceBillingView = {
      ...retryingView,
      plan: "free",
      interval: null,
      health: "current",
      actions: ["start_checkout"],
    };
    const monthlyPrice = formatUsdCents(PLAN_CATALOG.pro.monthlyPriceCents);
    const annualPrice = formatUsdCents(Math.round(PLAN_CATALOG.pro.annualPriceCents / 12));
    const container = browser.document.createElement("div");
    browser.document.body.append(container);
    root = createRoot(container as unknown as HTMLDivElement);

    await act(async () => {
      root?.render(billingElement(freeView, "monthly"));
    });
    expect(container.textContent).toContain(monthlyPrice);
    expect(container.textContent).not.toContain(annualPrice);

    await act(async () => {
      root?.render(billingElement(freeView, "annual"));
    });
    expect(container.textContent).toContain(annualPrice);
    expect(container.textContent).not.toContain(monthlyPrice);
  });

  test("reviewing an upgrade shows the exact charge and sends no confirmation until the owner confirms", async () => {
    const calls: string[] = [];
    const paid = { ...retryingView, health: "current" as const, actions: ["open_portal" as const] };
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).endsWith("/preview")) return Response.json({ quote: {
        id: "018f5f6a-4c31-7c75-9a4f-8f74f977bc12", tier: "business", interval: "monthly", kind: "immediate",
        amountDue: 745, currency: "usd", effectiveAt: "2026-10-27T12:00:00.000Z", expiresAt: "2099-10-27T12:10:00.000Z",
      } });
      if (String(url).endsWith("/confirm")) return Response.json({ kind: "pending_payment", effectiveAt: null });
      return Response.json({ view: { ...paid, planChange: { state: "pending_payment", tier: "business", interval: "monthly", effectiveAt: null } } });
    }) as unknown as typeof fetch;
    const container = await renderBilling(paid);
    const review = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Review Business"));
    await act(async () => { review?.click(); await browser.happyDOM.waitUntilComplete(); });
    const dialog = browser.document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Pay $7.45 and upgrade now");
    expect(calls).toEqual(["/api/billing/plan-change/preview"]);

    const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("Pay $7.45"));
    await act(async () => { confirm?.click(); await browser.happyDOM.waitUntilComplete(); });
    expect(calls).toEqual(["/api/billing/plan-change/preview", "/api/billing/plan-change/confirm", "/api/billing/reconcile"]);
    expect(container.textContent).toContain("Your current plan remains active");
    expect(container.textContent).not.toContain("Review Business");
  });

  test("a failed confirmation keeps the quote open without applying a local upgrade", async () => {
    const paid = { ...retryingView, health: "current" as const, actions: ["open_portal" as const] };
    globalThis.fetch = mock(async (url: string | URL | Request) => String(url).endsWith("/preview")
      ? Response.json({ quote: {
        id: "018f5f6a-4c31-7c75-9a4f-8f74f977bc12", tier: "business", interval: "monthly", kind: "immediate",
        amountDue: 745, currency: "usd", effectiveAt: "2026-10-27T12:00:00.000Z", expiresAt: "2099-10-27T12:10:00.000Z",
      } })
      : Response.json({ error: "plan_change_quote_expired" }, { status: 409 })) as unknown as typeof fetch;
    const container = await renderBilling(paid);
    const review = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Review Business"));
    await act(async () => { review?.click(); await browser.happyDOM.waitUntilComplete(); });
    const dialog = browser.document.querySelector('[role="dialog"]');
    const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("Pay $7.45"));
    await act(async () => { confirm?.click(); await browser.happyDOM.waitUntilComplete(); });
    expect(browser.document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("quote expired");
    expect(container.textContent).toContain("Current plan");
    expect(container.textContent).toContain("Review Business");
  });
});
