import { describe, expect, test } from "bun:test";
import type { PlanChangeQuote, WorkspaceBillingView } from "@narriflow/validators";
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
  planChange: null,
  graceDeadlineAt: null,
  lastSuccessfulSyncAt: null,
  desiredAdditionalSeats: 0,
  synchronizedAdditionalSeats: null,
  actions: ["start_checkout"],
};
const quote: PlanChangeQuote = {
  id: "018f5f6a-4c31-7c75-9a4f-8f74f977bc12",
  tier: "pro",
  interval: "monthly",
  kind: "immediate",
  amountDue: 700,
  currency: "usd",
  effectiveAt: "2026-10-27T12:00:00.000Z",
  expiresAt: "2026-10-27T12:10:00.000Z",
};

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    resolveAppOrigin: (requestUrl: string) => new URL(requestUrl).origin,
    getActor: async () => ({
      actorUserId: "user-owner",
      workspaceId: view.workspaceId,
    }),
    startCheckout: async () => ({ kind: "checkout", url: "https://checkout.test",
    }),
    observeCheckoutReturn: async () => ({
      kind: "activating" as const,
      retryAfterSeconds: 3,
      view: { ...view, health: "activating" as const },
    }),
    openPortal: async () => ({ url: "https://billing.test" }),
    previewPlanChange: async () => ({ quote }),
    confirmPlanChange: async () => ({ kind: "applied" as const, effectiveAt: quote.effectiveAt }),
    cancelScheduledPlanChange: async () => ({ kind: "unchanged" as const, effectiveAt: null }),
    readBillingState: async () => view,
    reconcileCurrentState: async () => ({ kind: "reconciled" as const, view }),
    ...overrides,
  };
}

describe("Workspace Billing HTTP routes", () => {
  test("rejects malformed Checkout requests", async () => {
    const app = createWorkspaceBillingHttpRoutes(dependencies());
    const malformed = await app.request("/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "creator", interval: "weekly", extra: true,
      }),
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
    expect(destination).toBe("https://canonical.narriflow.test/settings/billing",
    );
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

  test("plan previews accept only a catalog choice and use the admitted actor", async () => {
    let seen: unknown;
    const app = createWorkspaceBillingHttpRoutes(dependencies({
      previewPlanChange: async (input: unknown) => {
        seen = input;
        return { quote };
      },
    }));
    const request = {
      clientIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc13",
      tier: "pro",
      interval: "monthly",
    };
    const response = await app.request("/plan-change/preview", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ quote });
    expect(seen).toEqual({ ...request, userId: "user-owner", workspaceId: view.workspaceId });

    for (const invalid of [
      { ...request, priceId: "price_untrusted" },
      { ...request, workspaceId: "another-workspace" },
      { ...request, interval: "weekly" },
      { ...request, tier: "free" },
      { ...request, clientIdempotencyKey: "not-a-uuid" },
    ]) {
      expect((await app.request("/plan-change/preview", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(invalid),
      })).status).toBe(400);
    }
  });

  test("plan confirmation passes only the persisted quote identity", async () => {
    let seen: unknown;
    const app = createWorkspaceBillingHttpRoutes(dependencies({
      confirmPlanChange: async (input: unknown) => {
        seen = input;
        return { kind: "pending_payment" as const, paymentUrl: "https://invoice.stripe.com/i/test", effectiveAt: null };
      },
    }));
    const response = await app.request("/plan-change/confirm", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteId: quote.id }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).kind).toBe("pending_payment");
    expect(seen).toEqual({ quoteId: quote.id, userId: "user-owner", workspaceId: view.workspaceId });
    expect((await app.request("/plan-change/confirm", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteId: quote.id, amountDue: 0 }),
    })).status).toBe(400);
  });

  test("all plan-change mutations stop before the service when actor admission fails", async () => {
    let calls = 0;
    const app = createWorkspaceBillingHttpRoutes(dependencies({
      getActor: async () => { throw new Error("actor_admission_denied"); },
      previewPlanChange: async () => { calls += 1; return { quote }; },
      confirmPlanChange: async () => { calls += 1; return { kind: "applied" as const, effectiveAt: null }; },
      cancelScheduledPlanChange: async () => { calls += 1; return { kind: "unchanged" as const, effectiveAt: null }; },
    }));
    app.onError((_error, c) => c.json({ error: "billing_forbidden" }, 403));
    for (const path of ["preview", "confirm", "cancel"]) {
      expect((await app.request(`/plan-change/${path}`, { method: "POST" })).status).toBe(403);
    }
    expect(calls).toBe(0);
  });

  test("removing a scheduled plan change stays in the admitted workspace", async () => {
    let seen: unknown;
    const app = createWorkspaceBillingHttpRoutes(dependencies({
      cancelScheduledPlanChange: async (input: unknown) => {
        seen = input;
        return { kind: "unchanged" as const, effectiveAt: null };
      },
    }));
    const response = await app.request("/plan-change/cancel", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "untrusted" }),
    });
    expect(response.status).toBe(200);
    expect(seen).toEqual({ userId: "user-owner", workspaceId: view.workspaceId });
  });

});
