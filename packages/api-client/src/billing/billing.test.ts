import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import type { WorkspaceBillingView } from "@narriflow/validators";
import { isApiError } from "../core";
import { createApiRuntime } from "../core/runtime";
import {
  errorResponse,
  fakeFetch,
  jsonResponse,
  USER,
  WORKSPACE_A,
  WORKSPACE_B,
} from "../core/test-helpers";
import {
  billingKeys,
  billingStateQueryOptions,
  createBillingActions,
  invalidateBillingDependents,
  readBillingState,
  startBusinessWorkspaceCheckout,
} from ".";

const view: WorkspaceBillingView = {
  workspaceId: WORKSPACE_A,
  plan: "pro",
  interval: "monthly",
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
  actions: ["open_portal"],
};
const WORKSPACE = { "X-Workspace-Id": WORKSPACE_A };

function setup(...handlers: Parameters<typeof fakeFetch>) {
  const { fetch, calls } = fakeFetch(...handlers);
  const runtime = createApiRuntime({
    baseUrl: "https://api.example.test",
    getToken: async () => "session-token",
    fetch,
  });
  runtime.setIdentity(USER);
  runtime.selectWorkspace(WORKSPACE_A);
  return { runtime, calls, scope: { userId: USER, workspaceId: WORKSPACE_A } };
}

describe("billing state", () => {
  test("reads the typed state with the Bearer token, the Workspace header and the pacing hint", async () => {
    const { runtime, calls, scope } = setup(() =>
      jsonResponse(
        { view: { ...view, health: "activating" }, availableTiers: ["creator", "pro"], isConfigured: true },
        { headers: { ...WORKSPACE, "Retry-After": "3" } },
      ),
    );
    const state = await readBillingState(runtime.transport, scope);
    expect(state.view.health).toBe("activating");
    expect(state.availableTiers).toEqual(["creator", "pro"]);
    expect(state.retryAfterSeconds).toBe(3);
    expect(calls[0]?.url).toBe("https://api.example.test/api/billing/state");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer session-token");
    expect(calls[0]?.headers.get("x-workspace-id")).toBe(WORKSPACE_A);
    expect(calls[0]?.init.credentials).toBe("omit");
  });

  test("the query key carries identity and Workspace, and the query always re-reads", async () => {
    const { runtime, scope } = setup(() =>
      jsonResponse({ view, availableTiers: [], isConfigured: false }, { headers: WORKSPACE }),
    );
    const options = billingStateQueryOptions({ transport: runtime.transport, scope });
    expect(options.queryKey).toEqual(["nf", USER, WORKSPACE_A, "billing", "state"]);
    expect(options.staleTime).toBe(0);
    const state = await runtime.queryClient.fetchQuery(options);
    expect(state.isConfigured).toBe(false);
    expect(state.retryAfterSeconds).toBeUndefined();
  });

  test("a malformed state is refused instead of rendered", async () => {
    const { runtime, scope } = setup(() => jsonResponse({ view: { plan: "pro" } }, { headers: WORKSPACE }));
    await expect(readBillingState(runtime.transport, scope)).rejects.toThrow();
  });
});

describe("billing commands", () => {
  const checkout = {
    clientIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc11",
    tier: "creator" as const,
    interval: "monthly" as const,
  };

  test("checkout posts the native key in the body and returns only the hosted URL", async () => {
    const { runtime, calls, scope } = setup(() =>
      jsonResponse({ kind: "checkout", url: "https://checkout.stripe.test/c/1", expiresAt: "x" }, { headers: WORKSPACE }),
    );
    const url = await createBillingActions(runtime.transport, scope).startCheckout(checkout);
    expect(url).toBe("https://checkout.stripe.test/c/1");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(checkout);
    // Checkout's identity is the body key; no second header key is minted.
    expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
  });

  test("a refusal keeps its stable code for the screen to branch on", async () => {
    const { runtime, scope } = setup(() => errorResponse(409, "checkout_in_progress"));
    const error = await createBillingActions(runtime.transport, scope)
      .startCheckout(checkout)
      .catch((caught: unknown) => caught);
    expect(isApiError(error) && error.code).toBe("checkout_in_progress");
    expect(isApiError(error) && error.status).toBe(409);
  });

  test("an activating return and an expired return keep their distinct shapes", async () => {
    const activating = setup(() =>
      jsonResponse(
        { kind: "activating", retryAfterSeconds: 3, view: { ...view, health: "activating" } },
        { status: 202, headers: { ...WORKSPACE, "Retry-After": "3" } },
      ),
    );
    const pending = await createBillingActions(activating.runtime.transport, activating.scope).observeCheckoutReturn(
      "cs_1",
    );
    expect(pending).toMatchObject({ kind: "activating", retryAfterSeconds: 3 });
    expect(JSON.parse(String(activating.calls[0]?.init.body))).toEqual({ sessionId: "cs_1" });

    const expired = setup(() =>
      jsonResponse(
        { kind: "terminal", reason: "expired", view: { ...view, status: "payment_expired" } },
        { headers: WORKSPACE },
      ),
    );
    const terminal = await createBillingActions(expired.runtime.transport, expired.scope).observeCheckoutReturn("cs_1");
    expect(terminal).toMatchObject({ kind: "terminal", reason: "expired" });
  });

  test("plan changes validate what the API sends back", async () => {
    const quote = {
      id: "018f5f6a-4c31-7c75-9a4f-8f74f977bc12",
      tier: "pro",
      interval: "monthly",
      kind: "immediate",
      amountDue: 700,
      currency: "usd",
      effectiveAt: "2026-10-27T12:00:00.000Z",
      expiresAt: "2026-10-27T12:10:00.000Z",
    };
    const { runtime, calls, scope } = setup(
      () => jsonResponse({ quote }, { headers: WORKSPACE }),
      () => jsonResponse({ kind: "applied", effectiveAt: quote.effectiveAt }, { headers: WORKSPACE }),
      () => jsonResponse({ url: null }, { headers: WORKSPACE }),
      () => jsonResponse({ kind: "reconciled", view }, { headers: WORKSPACE }),
    );
    const actions = createBillingActions(runtime.transport, scope);
    expect(
      (await actions.previewPlanChange({ clientIdempotencyKey: checkout.clientIdempotencyKey, tier: "pro", interval: "monthly" })).id,
    ).toBe(quote.id);
    expect((await actions.confirmPlanChange(quote.id)).kind).toBe("applied");
    expect(await actions.pendingPaymentUrl()).toBeNull();
    expect((await actions.reconcile()).kind).toBe("reconciled");
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/billing/plan-change/preview",
      "/api/billing/plan-change/confirm",
      "/api/billing/plan-change/payment",
      "/api/billing/reconcile",
    ]);
  });

  test("a command bound to a Workspace the user left is refused locally", async () => {
    const { runtime, calls, scope } = setup(() => jsonResponse({ url: "https://billing.stripe.test" }));
    const actions = createBillingActions(runtime.transport, scope);
    runtime.selectWorkspace(WORKSPACE_B);
    const error = await actions.openPortal().catch((caught: unknown) => caught);
    expect(isApiError(error) && error.code).toBe("scope_changed");
    expect(calls).toHaveLength(0);
  });
});

describe("New-Workspace checkout", () => {
  test("is identity-only: no Workspace header, and the selection comes back explicitly", async () => {
    const response = {
      checkoutUrl: "https://checkout.stripe.test/b/1",
      checkoutIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc20",
      interval: "annual",
      selection: { workspaceId: "ws-new", workspaceName: "Acme" },
    };
    const { runtime, calls } = setup(() => jsonResponse(response));
    const result = await startBusinessWorkspaceCheckout(runtime.transport, { userId: USER }, {
      name: "Acme",
      interval: "annual",
    });
    expect(result).toEqual(response as typeof result);
    expect(calls[0]?.url).toBe("https://api.example.test/api/workspaces/business-checkout");
    expect(calls[0]?.headers.get("x-workspace-id")).toBeNull();
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer session-token");
  });

  test("a failed attempt exposes the recovery facts to resubmit against the pending Workspace", async () => {
    const recovery = {
      workspaceId: "ws-pending",
      workspaceName: "Acme",
      interval: "annual",
      checkoutIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc22",
    };
    const { runtime } = setup(() => errorResponse(503, "checkout_not_configured", { details: { recovery } }));
    const error = await startBusinessWorkspaceCheckout(runtime.transport, { userId: USER }, {
      name: "Acme",
      interval: "annual",
    }).catch((caught: unknown) => caught);
    expect(isApiError(error) && error.details).toEqual({ recovery });
  });
});

describe("invalidation after observed billing state", () => {
  test("refreshes the billing, Workspace and membership reads of this Workspace only", async () => {
    const queryClient = new QueryClient();
    const scope = { userId: USER, workspaceId: WORKSPACE_A };
    const other = { userId: USER, workspaceId: WORKSPACE_B };
    const keys = {
      billing: billingKeys.state(scope),
      workspace: ["nf", USER, WORKSPACE_A, "workspace", "usage"],
      session: ["nf", USER, "session", "bootstrap"],
      otherWorkspace: billingKeys.state(other),
      projects: ["nf", USER, WORKSPACE_A, "projects", "list"],
    };
    for (const key of Object.values(keys)) queryClient.setQueryData([...key], { ok: true });
    await invalidateBillingDependents(queryClient, scope);
    const stale = (key: readonly unknown[]) => queryClient.getQueryState([...key])?.isInvalidated;
    expect(stale(keys.billing)).toBe(true);
    expect(stale(keys.workspace)).toBe(true);
    expect(stale(keys.session)).toBe(true);
    expect(stale(keys.otherWorkspace)).toBe(false);
    expect(stale(keys.projects)).toBe(false);
  });
});
