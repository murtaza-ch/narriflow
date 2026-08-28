import { describe, expect, test } from "bun:test";
import { BillingError } from "@narriflow/services";
import type { WorkspaceBillingView } from "@narriflow/validators";
import { createWorkspaceBillingHttpRoutes } from "./workspace-billing-routes";

const view: WorkspaceBillingView = {
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

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    resolveAppOrigin: (requestUrl: string) => new URL(requestUrl).origin,
    getCurrentActor: async () => ({
      actorUserId: "user-owner",
      workspaceId: view.workspaceId,
    }),
    startCheckout: async () => ({ kind: "checkout", url: "https://checkout.test" }),
    observeCheckoutReturn: async () => ({
      kind: "activating" as const,
      retryAfterSeconds: 3,
      view: { ...view, health: "activating" as const },
    }),
    openPortal: async () => ({ url: "https://billing.test" }),
    readBillingState: async () => view,
    requireBillingManager: async () => undefined,
    reconcileCurrentState: async () => ({ kind: "reconciled" as const, view }),
    ...overrides,
  };
}

describe("Workspace Billing HTTP routes", () => {
  test("rejects unauthenticated and malformed Checkout requests", async () => {
    const unauthenticated = createWorkspaceBillingHttpRoutes(
      dependencies({ getCurrentActor: async () => null }),
    );
    expect((await unauthenticated.request("/checkout", { method: "POST" })).status)
      .toBe(401);

    const app = createWorkspaceBillingHttpRoutes(dependencies());
    const malformed = await app.request("/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "creator", interval: "weekly", extra: true }),
    });
    expect(malformed.status).toBe(400);
  });

  test("uses the canonical configured origin for safe return destinations", async () => {
    let destination = "";
    const app = createWorkspaceBillingHttpRoutes(
      dependencies({
        resolveAppOrigin: () => "https://canonical.narriflow.test",
        startCheckout: async (input: { returnDestination: string }) => {
          destination = input.returnDestination;
          return { kind: "checkout", url: "https://checkout.test" };
        },
      }),
    );
    const response = await app.request("https://app.narriflow.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc11",
        tier: "creator",
        interval: "monthly",
      }),
    });
    expect(response.status).toBe(200);
    expect(destination).toBe("https://canonical.narriflow.test/settings/billing");
  });

  test("maps activating and terminal returns with distinct polling contracts", async () => {
    const activating = createWorkspaceBillingHttpRoutes(dependencies());
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "cs_workspace_return" }),
    };
    const pending = await activating.request("/checkout/return", request);
    expect(pending.status).toBe(202);
    expect(pending.headers.get("retry-after")).toBe("3");

    const terminal = createWorkspaceBillingHttpRoutes(
      dependencies({
        observeCheckoutReturn: async () => ({
          kind: "terminal" as const,
          reason: "expired" as const,
          view: { ...view, status: "payment_expired" as const },
        }),
      }),
    );
    const expired = await terminal.request("/checkout/return", request);
    expect(expired.status).toBe(200);
    expect(expired.headers.get("retry-after")).toBeNull();
  });

  test("keeps owner authorization and provider failures typed", async () => {
    const forbidden = createWorkspaceBillingHttpRoutes(
      dependencies({
        requireBillingManager: async () => {
          throw new BillingError("billing_forbidden", "private detail");
        },
        openPortal: async () => {
          throw new BillingError("billing_customer_missing", "private detail");
        },
      }),
    );
    expect((await forbidden.request("/reconcile", { method: "POST" })).status)
      .toBe(403);
    const portal = await forbidden.request("/portal", { method: "POST" });
    expect(portal.status).toBe(409);
    expect(await portal.json()).toEqual({
      error: "billing_customer_missing",
      message: "No billing customer is available for this workspace.",
    });
  });
});
