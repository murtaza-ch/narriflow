import { describe, expect, mock, test } from "bun:test";
import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import { ExpectedDomainFailureError } from "@narriflow/services";
import type { PlanChangeQuote, WorkspaceBillingView } from "@narriflow/validators";
import { createRequestPolicyRuntime } from "../../http/request-policy-runtime";
import { billingAdmission } from "./admission";
import { type BillingRouteDeps, createBillingRoutes } from "./routes";
import { createBillingTestApp } from "./test-support";

const WEB = "http://localhost:3000";
const WORKSPACE_ID = "018f5f6a-4c31-7c75-9a4f-8f74f977bc10";
const user = { id: "user-owner", clerkId: "clerk-1" } as AppUser;

const view: WorkspaceBillingView = {
  workspaceId: WORKSPACE_ID,
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

function context(role: WorkspaceActorContext["role"]): WorkspaceActorContext {
  return {
    userId: user.id,
    workspaceId: WORKSPACE_ID,
    workspaceName: "Workspace",
    workspaceOwnerUserId: user.id,
    role,
    status: "active",
    pricingTier: "free",
    isPersonal: false,
    workspaceSelectionChanged: false,
  } as WorkspaceActorContext;
}

function policyRuntime(role: WorkspaceActorContext["role"] = "owner") {
  return createRequestPolicyRuntime({
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer good"
        ? ({ status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never)
        : ({ status: "unauthenticated", reason: "missing_credential" } as const),
    loadAppUser: async () => user,
    resolveScopedWorkspace: async (_user, hint) => (hint === WORKSPACE_ID ? context(role) : null),
    staffAllowlist: new Set(),
    policy: {
      resolveProject: async () => ({ kind: "inaccessible" }) as never,
      rateLimit: async () => ({ allowed: true }),
      now: () => 1_000,
    },
  });
}

const headers = {
  authorization: "Bearer good",
  "x-workspace-id": WORKSPACE_ID,
  origin: WEB,
  "content-type": "application/json",
};

function service(overrides: Record<string, unknown> = {}) {
  return {
    startCheckout: mock(async () => ({ kind: "checkout" as const, url: "https://checkout.test", expiresAt: "x" })),
    observeCheckoutReturn: mock(async () => ({
      kind: "activating" as const,
      retryAfterSeconds: 3,
      view: { ...view, health: "activating" as const },
    })),
    openPortal: mock(async () => ({ url: "https://billing.test" })),
    previewPlanChange: mock(async () => ({ quote })),
    confirmPlanChange: mock(async () => ({ kind: "applied" as const, effectiveAt: quote.effectiveAt })),
    cancelScheduledPlanChange: mock(async () => ({ kind: "unchanged" as const, effectiveAt: null })),
    readPendingPlanChangePayment: mock(async () => ({ url: null })),
    readBillingState: mock(async () => view),
    reconcileCurrentState: mock(async () => ({ kind: "reconciled" as const, view })),
    startBusinessWorkspaceCheckout: mock(async () => ({
      workspaceId: "ws-new",
      workspaceName: "Acme",
      interval: "annual" as const,
      checkoutIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc20",
      checkoutUrl: "https://checkout.test/business",
    })),
    configuredTiers: () => ["creator", "pro"] as ("creator" | "pro")[],
    isConfigured: () => true,
    ...overrides,
  };
}

function appFor(billing: ReturnType<typeof service>, role: WorkspaceActorContext["role"] = "owner") {
  const deps = { billingService: billing, webOrigin: WEB } as unknown as BillingRouteDeps;
  return createBillingTestApp({ policyRuntime: policyRuntime(role), routes: createBillingRoutes(deps) });
}

function post(path: string, body?: unknown, extra: Record<string, string> = {}) {
  return {
    path: `/api${path}`,
    init: {
      method: "POST",
      headers: { ...headers, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  };
}

describe("billing admission", () => {
  test("declares the nine controls, the New-Workspace checkout and Stripe's delivery", () => {
    expect(Object.keys(billingAdmission).sort()).toEqual(
      [
        "GET /billing/state",
        "POST /billing/checkout",
        "POST /billing/checkout/return",
        "POST /billing/plan-change/cancel",
        "POST /billing/plan-change/confirm",
        "POST /billing/plan-change/payment",
        "POST /billing/plan-change/preview",
        "POST /billing/portal",
        "POST /billing/reconcile",
        "POST /webhooks/stripe",
        "POST /workspaces/business-checkout",
      ].sort(),
    );
    expect(billingAdmission["POST /webhooks/stripe"]).toEqual({ trust: "provider_signature" });
    expect(billingAdmission["POST /workspaces/business-checkout"]).toEqual({ kind: "signed_in" });
    expect(billingAdmission["GET /billing/state"]).toMatchObject({ capability: "content.view" });
  });

  test("a signed-out caller reaches no service", async () => {
    const billing = service();
    const app = appFor(billing);
    for (const path of [
      "/billing/checkout",
      "/billing/portal",
      "/billing/reconcile",
      "/billing/plan-change/cancel",
      "/workspaces/business-checkout",
    ]) {
      const response = await app.request(`/api${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: WEB },
        body: "{}",
      });
      expect(response.status).toBe(401);
    }
    expect((await app.request("/api/billing/state", { headers: { origin: WEB } })).status).toBe(401);
    expect(billing.startCheckout).not.toHaveBeenCalled();
    expect(billing.openPortal).not.toHaveBeenCalled();
    expect(billing.reconcileCurrentState).not.toHaveBeenCalled();
    expect(billing.cancelScheduledPlanChange).not.toHaveBeenCalled();
    expect(billing.startBusinessWorkspaceCheckout).not.toHaveBeenCalled();
  });

  test("a member without billing.manage can read the state but cannot change the subscription", async () => {
    const billing = service();
    const app = appFor(billing, "editor");
    expect((await app.request("/api/billing/state", { headers })).status).toBe(200);

    const attempts = [
      post("/billing/checkout", {
        clientIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc11",
        tier: "creator",
        interval: "monthly",
      }),
      post("/billing/portal"),
      post("/billing/reconcile"),
      post("/billing/plan-change/preview", {
        clientIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc13",
        tier: "pro",
        interval: "monthly",
      }),
      post("/billing/plan-change/confirm", { quoteId: quote.id }),
      post("/billing/plan-change/payment"),
      post("/billing/plan-change/cancel"),
    ];
    for (const attempt of attempts) {
      const response = await app.request(attempt.path, attempt.init);
      expect(response.status).toBe(403);
    }
    for (const fn of [
      billing.startCheckout,
      billing.openPortal,
      billing.reconcileCurrentState,
      billing.previewPlanChange,
      billing.confirmPlanChange,
      billing.readPendingPlanChangePayment,
      billing.cancelScheduledPlanChange,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  test("a removed Workspace selection is refused before any billing call", async () => {
    const billing = service();
    const app = appFor(billing);
    const response = await app.request("/api/billing/portal", {
      method: "POST",
      headers: { ...headers, "x-workspace-id": "someone-elses-workspace" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "workspace_selection_changed" });
    expect(billing.openPortal).not.toHaveBeenCalled();
  });
});

describe("Workspace checkout, portal and state", () => {
  test("checkout validates input after admission and returns the service result", async () => {
    const billing = service();
    const app = appFor(billing);
    const malformed = post("/billing/checkout", { tier: "creator", interval: "weekly", extra: true });
    const refused = await app.request(malformed.path, malformed.init);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_input" });
    expect(billing.startCheckout).not.toHaveBeenCalled();

    const request = {
      clientIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc11",
      tier: "creator",
      interval: "monthly",
    };
    const ok = post("/billing/checkout", request);
    const response = await app.request(ok.path, ok.init);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "checkout", url: "https://checkout.test" });
    expect(billing.startCheckout.mock.calls[0]?.[0]).toEqual({
      userId: user.id,
      workspaceId: WORKSPACE_ID,
      clientIdempotencyKey: request.clientIdempotencyKey,
      tier: "creator",
      interval: "monthly",
      returnDestination: `${WEB}/settings/billing`,
    });
  });

  test("return and portal destinations come from configuration, never the request", async () => {
    const billing = service();
    const app = appFor(billing);
    const hostile = {
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
      host: "evil.example",
      origin: WEB,
    };
    const portal = post("/billing/portal", undefined, hostile);
    expect((await app.request(portal.path, portal.init)).status).toBe(200);
    expect(billing.openPortal.mock.calls[0]?.[0]).toEqual({
      userId: user.id,
      workspaceId: WORKSPACE_ID,
      returnUrl: `${WEB}/settings/billing`,
    });
  });

  test("checkout return maps activating and terminal results to their polling contracts", async () => {
    const billing = service();
    const app = appFor(billing);
    const request = post("/billing/checkout/return", { sessionId: "cs_workspace_return" });
    const pending = await app.request(request.path, request.init);
    expect(pending.status).toBe(202);
    expect(pending.headers.get("retry-after")).toBe("3");
    expect(billing.observeCheckoutReturn.mock.calls[0]?.[0]).toEqual({
      userId: user.id,
      workspaceId: WORKSPACE_ID,
      sessionId: "cs_workspace_return",
    });

    const terminal = service({
      observeCheckoutReturn: mock(async () => ({
        kind: "terminal" as const,
        reason: "expired" as const,
        view: { ...view, status: "payment_expired" as const },
      })),
    });
    const expired = await appFor(terminal).request(request.path, request.init);
    expect(expired.status).toBe(200);
    expect(expired.headers.get("retry-after")).toBeNull();

    const empty = post("/billing/checkout/return", { sessionId: "" });
    expect((await app.request(empty.path, empty.init)).status).toBe(400);
  });

  test("the state carries the safe checkout configuration and asks for a quick re-read while activating", async () => {
    const billing = service();
    const current = await appFor(billing).request("/api/billing/state", { headers });
    expect(current.status).toBe(200);
    expect(current.headers.get("retry-after")).toBeNull();
    expect(current.headers.get("x-workspace-id")).toBe(WORKSPACE_ID);
    expect(await current.json()).toEqual({ view, availableTiers: ["creator", "pro"], isConfigured: true });
    expect(billing.readBillingState.mock.calls[0]?.[0]).toBe(WORKSPACE_ID);

    const activating = service({
      readBillingState: mock(async () => ({ ...view, health: "activating" as const })),
      configuredTiers: () => [],
      isConfigured: () => false,
    });
    const response = await appFor(activating).request("/api/billing/state", { headers });
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await response.json()).toMatchObject({ availableTiers: [], isConfigured: false });
  });

  test("reconcile asks for another read only while the state is still settling", async () => {
    const run = async (health: WorkspaceBillingView["health"]) => {
      const billing = service({
        reconcileCurrentState: mock(async () => ({
          kind: "unresolved" as const,
          reason: "x",
          view: { ...view, health },
        })),
      });
      const request = post("/billing/reconcile");
      return appFor(billing).request(request.path, request.init);
    };
    expect((await run("activating")).headers.get("retry-after")).toBe("2");
    expect((await run("retrying")).headers.get("retry-after")).toBe("2");
    expect((await run("current")).headers.get("retry-after")).toBeNull();
  });
});

describe("plan changes", () => {
  const preview = {
    clientIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc13",
    tier: "pro",
    interval: "monthly",
  };

  test("a preview accepts only a catalog choice and uses the admitted actor and Workspace", async () => {
    const billing = service();
    const app = appFor(billing);
    const ok = post("/billing/plan-change/preview", preview);
    const response = await app.request(ok.path, ok.init);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ quote });
    expect(billing.previewPlanChange.mock.calls[0]?.[0]).toEqual({
      ...preview,
      userId: user.id,
      workspaceId: WORKSPACE_ID,
    });

    for (const invalid of [
      { ...preview, priceId: "price_untrusted" },
      { ...preview, workspaceId: "another-workspace" },
      { ...preview, interval: "weekly" },
      { ...preview, tier: "free" },
      { ...preview, clientIdempotencyKey: "not-a-uuid" },
    ]) {
      const request = post("/billing/plan-change/preview", invalid);
      expect((await app.request(request.path, request.init)).status).toBe(400);
    }
    expect(billing.previewPlanChange).toHaveBeenCalledTimes(1);
  });

  test("a confirmation passes only the persisted quote identity", async () => {
    const billing = service({
      confirmPlanChange: mock(async () => ({
        kind: "pending_payment" as const,
        paymentUrl: "https://invoice.stripe.com/i/test",
        effectiveAt: null,
      })),
    });
    const app = appFor(billing);
    const ok = post("/billing/plan-change/confirm", { quoteId: quote.id });
    const response = await app.request(ok.path, ok.init);
    expect(response.status).toBe(200);
    expect((await response.json()).kind).toBe("pending_payment");
    expect(billing.confirmPlanChange.mock.calls[0]?.[0]).toEqual({
      quoteId: quote.id,
      userId: user.id,
      workspaceId: WORKSPACE_ID,
    });
    const tampered = post("/billing/plan-change/confirm", { quoteId: quote.id, amountDue: 0 });
    expect((await app.request(tampered.path, tampered.init)).status).toBe(400);
  });

  test("cancelling and reading the pending payment stay in the admitted Workspace", async () => {
    const billing = service();
    const app = appFor(billing);
    const cancel = post("/billing/plan-change/cancel", { workspaceId: "untrusted" });
    expect((await app.request(cancel.path, cancel.init)).status).toBe(200);
    expect(billing.cancelScheduledPlanChange.mock.calls[0]?.[0]).toEqual({
      userId: user.id,
      workspaceId: WORKSPACE_ID,
    });
    const payment = post("/billing/plan-change/payment");
    expect((await app.request(payment.path, payment.init)).status).toBe(200);
    expect(billing.readPendingPlanChangePayment.mock.calls[0]?.[0]).toEqual({
      userId: user.id,
      workspaceId: WORKSPACE_ID,
    });
  });

  test("a billing refusal keeps its stable code and recovery status", async () => {
    const billing = service({
      confirmPlanChange: mock(async () => {
        throw new ExpectedDomainFailureError({
          code: "plan_change_quote_expired",
          kind: "conflict",
          message: "This quote expired. Review a fresh quote before continuing",
        });
      }),
    });
    const request = post("/billing/plan-change/confirm", { quoteId: quote.id });
    const response = await appFor(billing).request(request.path, request.init);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "plan_change_quote_expired" });
  });
});

describe("New-Workspace checkout", () => {
  const body = { name: "Acme", interval: "annual" };

  test("needs only a signed-in identity, never a Workspace selection", async () => {
    const billing = service();
    const app = appFor(billing, "viewer");
    const request = {
      method: "POST",
      headers: { authorization: "Bearer good", origin: WEB, "content-type": "application/json" },
      body: JSON.stringify(body),
    };
    const response = await app.request("/api/workspaces/business-checkout", request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      checkoutUrl: "https://checkout.test/business",
      checkoutIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc20",
      interval: "annual",
      selection: { workspaceId: "ws-new", workspaceName: "Acme" },
    });
    expect(billing.startBusinessWorkspaceCheckout.mock.calls[0]?.[0]).toEqual({
      actorUserId: user.id,
      name: "Acme",
      interval: "annual",
      returnDestination: `${WEB}/settings/billing`,
    });
  });

  test("resumes a pending Workspace with its preserved Checkout key", async () => {
    const billing = service();
    const recovery = {
      workspaceId: "ws-pending",
      interval: "monthly",
      checkoutIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc21",
    };
    const request = post("/workspaces/business-checkout", recovery);
    const response = await appFor(billing).request(request.path, request.init);
    expect(response.status).toBe(200);
    expect(billing.startBusinessWorkspaceCheckout.mock.calls[0]?.[0]).toEqual({
      actorUserId: user.id,
      ...recovery,
      returnDestination: `${WEB}/settings/billing`,
    });
  });

  test("refuses a bad name, interval or unknown field before the service", async () => {
    const billing = service();
    const app = appFor(billing);
    for (const invalid of [
      {},
      { interval: "annual" },
      { name: "", interval: "annual" },
      { name: "Acme", interval: "forged" },
      { name: "Acme", interval: "annual", ownerUserId: "someone" },
      { name: "Acme", workspaceId: "ws", interval: "annual", extra: 1 },
    ]) {
      const request = post("/workspaces/business-checkout", invalid);
      const response = await app.request(request.path, request.init);
      expect(response.status).toBe(400);
    }
    expect(billing.startBusinessWorkspaceCheckout).not.toHaveBeenCalled();
  });

  test("a failure after the Workspace exists carries the recovery facts for the form", async () => {
    const recovery = {
      workspaceId: "ws-pending",
      workspaceName: "Acme",
      interval: "annual",
      checkoutIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc22",
    };
    const billing = service({
      startBusinessWorkspaceCheckout: mock(async () => {
        throw new ExpectedDomainFailureError({
          code: "checkout_in_progress",
          kind: "conflict",
          message: "Another Checkout for this workspace is already in progress",
          details: { recovery },
        });
      }),
    });
    const request = post("/workspaces/business-checkout", body);
    const response = await appFor(billing).request(request.path, request.init);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "checkout_in_progress",
      details: { recovery },
    });
  });
});
