import { describe, expect, test } from "bun:test";
import {
  createBillingCatalog,
  createInMemoryWorkspaceBillingStore,
  createWorkspaceBillingModule,
  type WorkspaceBillingProvider,
  type WorkspaceBillingStore,
} from "./workspace-billing.service";

const catalog = createBillingCatalog({
  basePrices: [
    { priceId: "price_creator_monthly", tier: "creator", interval: "monthly" },
    { priceId: "price_creator_annual", tier: "creator", interval: "annual" },
    { priceId: "price_pro_monthly", tier: "pro", interval: "monthly" },
    { priceId: "price_pro_annual", tier: "pro", interval: "annual" },
    { priceId: "price_business_monthly", tier: "business", interval: "monthly" },
    { priceId: "price_business_annual", tier: "business", interval: "annual" },
  ],
  seatPrices: [
    { priceId: "price_business_seat_monthly", interval: "monthly" },
    { priceId: "price_business_seat_annual", interval: "annual" },
  ],
  worker: {
    batchSize: 25,
    concurrency: 4,
    leaseMs: 60_000,
    providerDeadlineMs: 10_000,
    providerCallBudget: 4,
  },
});

describe("Workspace Billing", () => {
  test("replays one durable Checkout attempt and rejects changed immutable input", async () => {
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-checkout",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "free",
        status: "active",
        providerCustomerId: null,
        ownerUserId: "owner-checkout",
      },
    ]);
    let customerCreates = 0;
    let checkoutCreates = 0;
    let createdAttemptId = "";
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => {
          throw new Error("not used");
        },
        findCustomersByWorkspace: async () => [],
        createCustomer: async ({ workspaceId }, idempotencyKey) => {
          customerCreates += 1;
          expect(workspaceId).toBe("workspace-checkout");
          expect(idempotencyKey).toBeTruthy();
          return { customerId: "cus_checkout" };
        },
        createCheckoutSession: async (input, idempotencyKey) => {
          checkoutCreates += 1;
          createdAttemptId = input.attemptId;
          expect(input).toMatchObject({
            workspaceId: "workspace-checkout",
            customerId: "cus_checkout",
            priceId: "price_pro_annual",
          });
          expect(idempotencyKey).toBeTruthy();
          return {
            sessionId: "cs_checkout",
            url: "https://checkout.stripe.test/session",
            expiresAt: new Date("2026-08-28T11:00:00.000Z"),
            status: "open",
            paymentStatus: "unpaid",
          };
        },
        retrieveCheckoutSession: async () => ({
          sessionId: "cs_checkout",
          url: "https://checkout.stripe.test/session",
          expiresAt: new Date("2026-08-28T11:00:00.000Z"),
          status: "open",
          paymentStatus: "unpaid",
          workspaceId: "workspace-checkout",
          attemptId: createdAttemptId,
        }),
        createPortalSession: async () => {
          throw new Error("not used");
        },
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });
    const input = {
      workspaceId: "workspace-checkout",
      actorUserId: "owner-checkout",
      clientIdempotencyKey: "checkout-key-1",
      targetTier: "pro" as const,
      interval: "annual" as const,
      returnDestination: "/settings/billing",
    };

    const first = await billing.startCheckout(input);
    const replay = await billing.startCheckout(input);

    expect(first).toEqual({
      kind: "checkout",
      url: "https://checkout.stripe.test/session",
      expiresAt: "2026-08-28T11:00:00.000Z",
    });
    expect(replay).toEqual(first);
    expect(customerCreates).toBe(1);
    expect(checkoutCreates).toBe(1);
    await expect(
      billing.startCheckout({ ...input, targetTier: "creator" }),
    ).rejects.toMatchObject({ code: "checkout_attempt_conflict" });
  });

  test("observes Checkout return without granting access and wakes activation", async () => {
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-return",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "free",
        status: "active",
        providerCustomerId: null,
        ownerUserId: "owner-return",
      },
    ]);
    let sessionWorkspaceId = "workspace-return";
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => {
          throw new Error("worker reconciliation is deliberately not run");
        },
        findCustomersByWorkspace: async () => [],
        createCustomer: async () => ({ customerId: "cus_return" }),
        createCheckoutSession: async (input) => ({
          sessionId: "cs_return",
          url: "https://checkout.stripe.test/return",
          expiresAt: new Date("2026-08-28T11:00:00.000Z"),
          status: "open",
          paymentStatus: "unpaid",
          workspaceId: input.workspaceId,
          attemptId: input.attemptId,
        }),
        retrieveCheckoutSession: async () => ({
          sessionId: "cs_return",
          url: null,
          expiresAt: new Date("2026-08-28T11:00:00.000Z"),
          status: "complete",
          paymentStatus: "paid",
          workspaceId: sessionWorkspaceId,
        }),
        createPortalSession: async () => {
          throw new Error("not used");
        },
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });
    await billing.startCheckout({
      workspaceId: "workspace-return",
      actorUserId: "owner-return",
      clientIdempotencyKey: "return-key",
      targetTier: "creator",
      interval: "monthly",
      returnDestination: "/settings/billing",
    });

    sessionWorkspaceId = "another-workspace";
    await expect(
      billing.observeCheckoutReturn({
        workspaceId: "workspace-return",
        actorUserId: "owner-return",
        sessionId: "cs_return",
      }),
    ).rejects.toMatchObject({ code: "checkout_session_conflict" });

    sessionWorkspaceId = "workspace-return";
    const result = await billing.observeCheckoutReturn({
      workspaceId: "workspace-return",
      actorUserId: "owner-return",
      sessionId: "cs_return",
    });

    expect(result).toMatchObject({
      kind: "activating",
      retryAfterSeconds: 2,
      view: { plan: "free", health: "activating" },
    });
    expect(await store.readProjection("workspace-return")).toMatchObject({
      pricingTier: "free",
      canonicalSubscriptionId: null,
      health: "activating",
    });
  });

  test("records an expired Checkout as terminal without waking activation", async () => {
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-expired-return",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "free",
        status: "active",
        providerCustomerId: null,
        ownerUserId: "owner-expired-return",
      },
    ]);
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => {
          throw new Error("not used");
        },
        findCustomersByWorkspace: async () => [],
        createCustomer: async () => ({ customerId: "cus_expired_return" }),
        createCheckoutSession: async (input) => ({
          sessionId: "cs_expired_return",
          url: "https://checkout.stripe.test/expired",
          expiresAt: new Date("2026-08-28T11:00:00.000Z"),
          status: "open",
          paymentStatus: "unpaid",
          workspaceId: input.workspaceId,
          attemptId: input.attemptId,
        }),
        retrieveCheckoutSession: async () => ({
          sessionId: "cs_expired_return",
          url: null,
          expiresAt: new Date("2026-08-28T09:00:00.000Z"),
          status: "expired",
          paymentStatus: "unpaid",
          workspaceId: "workspace-expired-return",
        }),
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });
    await billing.startCheckout({
      workspaceId: "workspace-expired-return",
      actorUserId: "owner-expired-return",
      clientIdempotencyKey: "expired-return-key",
      targetTier: "creator",
      interval: "monthly",
      returnDestination: "/settings/billing",
    });

    expect(
      await billing.observeCheckoutReturn({
        workspaceId: "workspace-expired-return",
        actorUserId: "owner-expired-return",
        sessionId: "cs_expired_return",
      }),
    ).toMatchObject({
      kind: "terminal",
      reason: "expired",
      view: { plan: "free", status: "payment_expired", health: "current" },
    });
    expect(await store.readProjection("workspace-expired-return")).toMatchObject({
      pricingTier: "free",
      canonicalSubscriptionId: null,
      health: "current",
    });
  });

  test("settles ordinary Free accounts without a customer and keeps Checkout available", async () => {
    let providerCalls = 0;
    const metricNames: string[] = [];
    const queueAgeAttributes: Array<Record<string, unknown>> = [];
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-free-no-customer",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "free",
        status: "active",
        providerCustomerId: null,
      },
    ]);
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => {
          providerCalls += 1;
          throw new Error("must not retrieve without a customer");
        },
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
      metrics: {
        observe: (name, _value, attributes) => {
          metricNames.push(name);
          if (name === "workspace_billing_queue_age_ms") {
            queueAgeAttributes.push(attributes);
          }
        },
      },
    });

    expect(await billing.reconcileCurrentState("workspace-free-no-customer"))
      .toMatchObject({
        kind: "reconciled",
        view: { health: "current", actions: ["start_checkout"] },
      });
    expect(providerCalls).toBe(0);
    expect(metricNames).toEqual(
      expect.arrayContaining([
        "workspace_billing_claims_total",
        "workspace_billing_queue_age_ms",
        "workspace_billing_operation_duration_ms",
      ]),
    );
    expect(queueAgeAttributes).toEqual([{}]);
  });

  test("keeps a collaborative Free workspace restricted without a customer", async () => {
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-collaborative-free",
        personal: false,
        hasNonOwnerMembers: true,
        pricingTier: "free",
        status: "restricted",
        providerCustomerId: null,
      },
    ]);
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => {
          throw new Error("must not retrieve without a customer");
        },
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });

    expect(await billing.reconcileCurrentState("workspace-collaborative-free"))
      .toMatchObject({
        kind: "reconciled",
        view: {
          plan: "free",
          workspaceAccessStatus: "restricted",
          actions: ["contact_support"],
        },
      });
    expect(await store.readProjection("workspace-collaborative-free"))
      .toMatchObject({ pricingTier: "free", status: "restricted" });
  });

  test("keeps an abandoned Business setup pending and replayable", async () => {
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-pending-business",
        personal: false,
        hasNonOwnerMembers: false,
        pricingTier: "free",
        status: "pending_payment",
        providerCustomerId: null,
      },
    ]);
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => {
          throw new Error("must not retrieve without a customer");
        },
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });

    expect(await billing.reconcileCurrentState("workspace-pending-business"))
      .toMatchObject({
        kind: "reconciled",
        view: {
          plan: "free",
          workspaceAccessStatus: "pending_payment",
          actions: ["start_checkout"],
        },
      });
  });

  test("keeps zero-subscription Checkout activation recoverable and expires safely", async () => {
    let checkoutStatus: "complete" | "expired" = "complete";
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-zero-subscription",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "free",
        status: "active",
        providerCustomerId: null,
        ownerUserId: "owner-zero-subscription",
      },
    ]);
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => ({
          customerId: "cus_zero_subscription",
          ownership: {
            kind: "verified",
            workspaceId: "workspace-zero-subscription",
          },
          subscriptions: [],
        }),
        findCustomersByWorkspace: async () => [],
        createCustomer: async () => ({ customerId: "cus_zero_subscription" }),
        createCheckoutSession: async (input) => ({
          sessionId: "cs_zero_subscription",
          url: "https://checkout.stripe.test/zero-subscription",
          expiresAt: new Date("2026-08-28T11:00:00.000Z"),
          status: "open",
          paymentStatus: "unpaid",
          workspaceId: input.workspaceId,
          attemptId: input.attemptId,
        }),
        retrieveCheckoutSession: async () => ({
          sessionId: "cs_zero_subscription",
          url: null,
          expiresAt: new Date("2026-08-28T11:00:00.000Z"),
          status: checkoutStatus,
          paymentStatus: "unpaid",
          workspaceId: "workspace-zero-subscription",
        }),
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });
    await billing.startCheckout({
      workspaceId: "workspace-zero-subscription",
      actorUserId: "owner-zero-subscription",
      clientIdempotencyKey: "zero-subscription-key",
      targetTier: "creator",
      interval: "monthly",
      returnDestination: "/settings/billing",
    });
    await billing.observeCheckoutReturn({
      workspaceId: "workspace-zero-subscription",
      actorUserId: "owner-zero-subscription",
      sessionId: "cs_zero_subscription",
    });
    expect(await billing.reconcileCurrentState("workspace-zero-subscription"))
      .toMatchObject({
        view: { health: "activating", actions: [] },
      });

    checkoutStatus = "expired";
    await billing.observeCheckoutReturn({
      workspaceId: "workspace-zero-subscription",
      actorUserId: "owner-zero-subscription",
      sessionId: "cs_zero_subscription",
    });
    expect(await billing.reconcileCurrentState("workspace-zero-subscription"))
      .toMatchObject({
        view: {
          status: "payment_expired",
          health: "current",
          actions: ["start_checkout"],
        },
      });
  });

  test("routes an existing paid Workspace to the hosted portal", async () => {
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-portal",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "pro",
        status: "active",
        providerCustomerId: "cus_portal",
        ownerUserId: "owner-portal",
      },
    ]);
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => {
          throw new Error("not used");
        },
        createPortalSession: async (input) => {
          expect(input).toEqual({
            customerId: "cus_portal",
            returnUrl: "https://app.test/settings/billing",
          });
          return { url: "https://billing.stripe.test/portal" };
        },
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });

    expect(
      await billing.openPortal({
        workspaceId: "workspace-portal",
        actorUserId: "owner-portal",
        returnUrl: "https://app.test/settings/billing",
      }),
    ).toEqual({ url: "https://billing.stripe.test/portal" });
    await expect(
      billing.startCheckout({
        workspaceId: "workspace-portal",
        actorUserId: "owner-portal",
        clientIdempotencyKey: "paid-checkout",
        targetTier: "business",
        interval: "monthly",
        returnDestination: "/settings/billing",
      }),
    ).rejects.toMatchObject({ code: "billing_portal_required" });
  });

  test("inspects normalized local and provider state without provider identifiers", async () => {
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-inspect",
        personal: false,
        hasNonOwnerMembers: true,
        pricingTier: "business",
        status: "active",
        providerCustomerId: "cus_private",
        desiredAdditionalSeats: 2,
      },
    ]);
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => ({
          customerId: "cus_private",
          ownership: { kind: "verified", workspaceId: "workspace-inspect" },
          subscriptions: [
            {
              id: "sub_private",
              status: "active",
              items: [
                { id: "si_base_private", priceId: "price_business_monthly", quantity: 1 },
                { id: "si_seat_private", priceId: "price_business_seat_monthly", quantity: 2 },
              ],
              createdAt: new Date("2026-08-01T00:00:00.000Z"),
              effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
              currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
              trialEnd: null,
              cancelAtPeriodEnd: false,
            },
          ],
        }),
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });

    const inspection = await billing.inspectAccount("workspace-inspect");

    expect(inspection).toMatchObject({
      workspaceId: "workspace-inspect",
      local: {
        plan: "business",
        health: "current",
        desiredAdditionalSeats: 2,
        hasProviderCustomer: true,
      },
      provider: {
        ownership: "verified",
        subscriptionCount: 1,
        subscriptions: [
          {
            status: "active",
            basePlan: "business/monthly",
            additionalSeats: 2,
          },
        ],
      },
    });
    expect(JSON.stringify(inspection)).not.toContain("cus_private");
    expect(JSON.stringify(inspection)).not.toContain("sub_private");
    expect(JSON.stringify(inspection)).not.toContain("si_base_private");
  });

  test("converges Business seats from the latest committed membership count", async () => {
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-seats",
        personal: false,
        hasNonOwnerMembers: true,
        pricingTier: "business",
        status: "active",
        providerCustomerId: "cus_seats",
        desiredAdditionalSeats: 2,
      },
    ]);
    const updates: Array<{ itemId: string; quantity: number; key: string }> = [];
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => ({
          customerId: "cus_seats",
          ownership: { kind: "verified", workspaceId: "workspace-seats" },
          subscriptions: [
            {
              id: "sub_seats",
              status: "active",
              items: [
                { id: "si_base", priceId: "price_business_monthly", quantity: 1 },
                { id: "si_seat", priceId: "price_business_seat_monthly", quantity: 1 },
              ],
              createdAt: new Date("2026-08-01T00:00:00.000Z"),
              effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
              currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
              trialEnd: null,
              cancelAtPeriodEnd: false,
            },
          ],
        }),
        updateSeatItem: async (input, idempotencyKey) => {
          updates.push({
            itemId: input.itemId,
            quantity: input.quantity,
            key: idempotencyKey,
          });
        },
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });

    const result = await billing.reconcileCurrentState("workspace-seats");

    expect(updates).toEqual([
      {
        itemId: "si_seat",
        quantity: 2,
        key: "workspace-seat-workspace-seats-1",
      },
    ]);
    expect(result.view).toMatchObject({
      desiredAdditionalSeats: 2,
      synchronizedAdditionalSeats: 2,
    });
  });

  test("period-end cancellation keeps paid access and clears after reactivation", async () => {
    let cancelAtPeriodEnd = true;
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-cancel",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "creator",
        status: "active",
        providerCustomerId: "cus_cancel",
      },
    ]);
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => ({
          customerId: "cus_cancel",
          ownership: { kind: "verified", workspaceId: "workspace-cancel" },
          subscriptions: [
            {
              id: "sub_cancel",
              status: "active",
              items: [{ priceId: "price_creator_annual", quantity: 1 }],
              createdAt: new Date("2026-08-01T00:00:00.000Z"),
              effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
              currentPeriodEnd: new Date("2027-08-01T00:00:00.000Z"),
              trialEnd: null,
              cancelAtPeriodEnd,
            },
          ],
        }),
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });

    const canceled = await billing.reconcileCurrentState("workspace-cancel");
    expect(canceled.view).toMatchObject({
      plan: "creator",
      interval: "annual",
      cancelAtPeriodEnd: true,
      renewalOrEndAt: "2027-08-01T00:00:00.000Z",
    });
    cancelAtPeriodEnd = false;
    const reactivated = await billing.reconcileCurrentState("workspace-cancel");
    expect(reactivated.view.cancelAtPeriodEnd).toBe(false);
  });

  test("unknown catalog state and provider outages preserve verified access", async () => {
    const metricEvents: Array<{
      name: string;
      value: number;
      attributes: Record<string, string | number | boolean | null>;
    }> = [];
    const makeStore = (workspaceId: string) =>
      createInMemoryWorkspaceBillingStore([
        {
          workspaceId,
          personal: true,
          hasNonOwnerMembers: false,
          pricingTier: "pro",
          status: "active",
          providerCustomerId: `cus_${workspaceId}`,
        },
      ]);
    const unknownStore = makeStore("unknown");
    const unknown = createWorkspaceBillingModule({
      catalog,
      store: unknownStore,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => ({
          customerId: "cus_unknown",
          ownership: { kind: "verified", workspaceId: "unknown" },
          subscriptions: [
            {
              id: "sub_unknown",
              status: "active",
              items: [{ priceId: "price_not_in_catalog", quantity: 1 }],
              createdAt: new Date("2026-08-01T00:00:00.000Z"),
              effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
              currentPeriodEnd: null,
              trialEnd: null,
              cancelAtPeriodEnd: false,
            },
          ],
        }),
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
      metrics: {
        observe: (name, value, attributes) =>
          metricEvents.push({ name, value, attributes }),
      },
    });
    const unknownResult = await unknown.reconcileCurrentState("unknown");
    expect(unknownResult).toMatchObject({
      kind: "unresolved",
      reason: "unmapped_price",
      view: { plan: "pro", health: "attention_required" },
    });
    expect(metricEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "workspace_billing_transitions_total",
          attributes: expect.objectContaining({
            transition: "conflict",
            reason: "unmapped_price",
          }),
        }),
      ]),
    );

    const outageStore = makeStore("outage");
    const outage = createWorkspaceBillingModule({
      catalog,
      store: outageStore,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => {
          throw new Error("Stripe timeout");
        },
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
      metrics: {
        observe: (name, value, attributes) =>
          metricEvents.push({ name, value, attributes }),
      },
    });
    const outageResult = await outage.reconcileCurrentState("outage");
    expect(outageResult).toMatchObject({
      kind: "unresolved",
      reason: "retryable_provider",
      view: { plan: "pro", health: "retrying" },
    });
    expect(metricEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "workspace_billing_provider_calls_total",
          attributes: { operation: "retrieve_current_state", outcome: "failure" },
        }),
        expect.objectContaining({
          name: "workspace_billing_retry_delay_ms",
          value: 60_000,
          attributes: expect.objectContaining({ retryBand: "first" }),
        }),
      ]),
    );
  });

  test("missing or mismatched provider ownership cannot be adopted", async () => {
    for (const ownership of [
      { kind: "missing_metadata" as const },
      { kind: "workspace_mismatch" as const },
      { kind: "verified" as const, workspaceId: "another-workspace" },
    ]) {
      const store = createInMemoryWorkspaceBillingStore([
        {
          workspaceId: "workspace-owned",
          personal: true,
          hasNonOwnerMembers: false,
          pricingTier: "pro",
          status: "active",
          providerCustomerId: "cus_owned",
        },
      ]);
      const billing = createWorkspaceBillingModule({
        catalog,
        store,
        provider: {
          verifyDelivery: () => {
            throw new Error("not used");
          },
          retrieveCurrentState: async () => ({
            customerId: "cus_owned",
            ownership,
            subscriptions: [
              {
                id: "sub_foreign",
                status: "active",
                items: [{ priceId: "price_business_monthly", quantity: 1 }],
                createdAt: new Date("2026-08-01T00:00:00.000Z"),
                effectiveAt: new Date("2026-08-28T09:00:00.000Z"),
                currentPeriodEnd: new Date("2026-09-28T09:00:00.000Z"),
                trialEnd: null,
                cancelAtPeriodEnd: false,
              },
            ],
          }),
        },
        clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
        diagnostics: { record: () => undefined },
      });

      const result = await billing.reconcileCurrentState("workspace-owned");
      expect(result).toMatchObject({
        kind: "unresolved",
        view: { plan: "pro", health: "attention_required" },
      });
      expect(await store.readProjection("workspace-owned")).toMatchObject({
        pricingTier: "pro",
        canonicalSubscriptionId: null,
      });
    }
  });

  test("unknown and duplicate seat items preserve the last verified entitlement", async () => {
    for (const [workspaceId, items, reason] of [
      [
        "unknown-extra",
        [
          { priceId: "price_business_monthly", quantity: 1 },
          { priceId: "price_unknown", quantity: 1 },
        ],
        "unmapped_price",
      ],
      [
        "duplicate-seat",
        [
          { priceId: "price_business_monthly", quantity: 1 },
          { priceId: "price_business_seat_monthly", quantity: 2 },
          { priceId: "price_business_seat_monthly", quantity: 1 },
        ],
        "invalid_seat_items",
      ],
    ] as const) {
      const store = createInMemoryWorkspaceBillingStore([
        {
          workspaceId,
          personal: false,
          hasNonOwnerMembers: true,
          pricingTier: "business",
          status: "active",
          providerCustomerId: `cus_${workspaceId}`,
        },
      ]);
      const billing = createWorkspaceBillingModule({
        catalog,
        store,
        provider: {
          verifyDelivery: () => {
            throw new Error("not used");
          },
          retrieveCurrentState: async () => ({
            customerId: `cus_${workspaceId}`,
            ownership: { kind: "verified", workspaceId },
            subscriptions: [
              {
                id: `sub_${workspaceId}`,
                status: "active",
                items: [...items],
                createdAt: new Date("2026-08-01T00:00:00.000Z"),
                effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
                currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
                trialEnd: null,
                cancelAtPeriodEnd: false,
              },
            ],
          }),
        },
        clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
        diagnostics: { record: () => undefined },
      });

      expect(await billing.reconcileCurrentState(workspaceId)).toMatchObject({
        kind: "unresolved",
        reason,
        view: { plan: "business", health: "attention_required" },
      });
    }
  });

  test("multiple paid subscriptions preserve the highest entitlement and require attention", async () => {
    let seatCreates = 0;
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-conflict",
        personal: false,
        hasNonOwnerMembers: true,
        pricingTier: "pro",
        status: "active",
        providerCustomerId: "cus_conflict",
        desiredAdditionalSeats: 1,
      },
    ]);
    const subscription = (id: string, priceId: string) => ({
      id,
      status: "active",
      items: [{ priceId, quantity: 1 }],
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
      trialEnd: null,
      cancelAtPeriodEnd: false,
    });
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => ({
          customerId: "cus_conflict",
          ownership: { kind: "verified", workspaceId: "workspace-conflict" },
          subscriptions: [
            subscription("sub_creator", "price_creator_monthly"),
            subscription("sub_business", "price_business_monthly"),
          ],
        }),
        createSeatItem: async () => {
          seatCreates += 1;
          return { itemId: "si_must_not_be_created" };
        },
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });

    const result = await billing.reconcileCurrentState("workspace-conflict");

    expect(result).toMatchObject({
      kind: "reconciled",
      view: {
        plan: "business",
        health: "attention_required",
        actions: ["open_portal", "contact_support"],
      },
    });
    expect(await store.readProjection("workspace-conflict")).toMatchObject({
      pricingTier: "business",
      attentionReason: "multiple_entitlement_subscriptions",
    });
    expect(seatCreates).toBe(0);
  });

  test("past-due grace starts once, expires exactly at seven days, and clears on recovery", async () => {
    let now = new Date("2026-08-28T10:00:00.000Z");
    let status = "past_due";
    const transitions: string[] = [];
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-grace",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "pro",
        status: "active",
        providerCustomerId: "cus_grace",
      },
    ]);
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => ({
          customerId: "cus_grace",
          ownership: { kind: "verified", workspaceId: "workspace-grace" },
          subscriptions: [
            {
              id: "sub_grace",
              status,
              items: [{ priceId: "price_pro_monthly", quantity: 1 }],
              createdAt: new Date("2026-08-01T00:00:00.000Z"),
              effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
              currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
              trialEnd: null,
              cancelAtPeriodEnd: false,
            },
          ],
        }),
      },
      clock: { now: () => now },
      diagnostics: { record: () => undefined },
      metrics: {
        observe: (name, _value, attributes) => {
          if (name === "workspace_billing_transitions_total") {
            transitions.push(String(attributes.transition));
          }
        },
      },
    });

    const entered = await billing.reconcileCurrentState("workspace-grace");
    expect(entered.view.graceDeadlineAt).toBe("2026-09-04T10:00:00.000Z");
    now = new Date("2026-09-03T10:00:00.000Z");
    const repeated = await billing.reconcileCurrentState("workspace-grace");
    expect(repeated.view.graceDeadlineAt).toBe(entered.view.graceDeadlineAt);
    expect(repeated.view.plan).toBe("pro");
    now = new Date("2026-09-04T10:00:00.000Z");
    const expired = await billing.reconcileCurrentState("workspace-grace");
    expect(expired.view.plan).toBe("free");
    status = "active";
    const recovered = await billing.reconcileCurrentState("workspace-grace");
    expect(recovered.view).toMatchObject({
      plan: "pro",
      health: "current",
      graceDeadlineAt: null,
    });
    expect(transitions).toEqual(
      expect.arrayContaining(["grace_entered", "grace_recovered"]),
    );
  });

  test("applies the documented subscription health matrix", async () => {
    const cases = [
      { status: "active", viewStatus: "active", plan: "creator", workspaceStatus: "active", health: "current" },
      { status: "trialing", viewStatus: "trial", plan: "creator", workspaceStatus: "active", health: "current" },
      { status: "incomplete", viewStatus: "payment_pending", plan: "free", workspaceStatus: "pending_payment", health: "activating" },
      { status: "past_due", viewStatus: "payment_past_due", plan: "pro", workspaceStatus: "active", health: "payment_action_required" },
      { status: "unpaid", viewStatus: "payment_failed", plan: "free", workspaceStatus: "active", health: "current" },
      { status: "paused", viewStatus: "paused", plan: "free", workspaceStatus: "active", health: "current" },
      { status: "incomplete_expired", viewStatus: "payment_expired", plan: "free", workspaceStatus: "active", health: "current" },
      { status: "canceled", viewStatus: "canceled", plan: "free", workspaceStatus: "active", health: "current" },
    ] as const;
    for (const expected of cases) {
      const store = createInMemoryWorkspaceBillingStore([
        {
          workspaceId: `workspace-${expected.status}`,
          personal: true,
          hasNonOwnerMembers: false,
          pricingTier: expected.status === "past_due" ? "pro" : "free",
          status: expected.status === "incomplete" ? "pending_payment" : "active",
          providerCustomerId: `cus_${expected.status}`,
        },
      ]);
      const billing = createWorkspaceBillingModule({
        catalog,
        store,
        provider: {
          verifyDelivery: () => {
            throw new Error("not used");
          },
          retrieveCurrentState: async () => ({
            customerId: `cus_${expected.status}`,
            ownership: {
              kind: "verified",
              workspaceId: `workspace-${expected.status}`,
            },
            subscriptions: [
              {
                id: `sub_${expected.status}`,
                status: expected.status,
                items: [{ priceId: "price_creator_monthly", quantity: 1 }],
                createdAt: new Date("2026-08-01T00:00:00.000Z"),
                effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
                currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
                trialEnd:
                  expected.status === "trialing"
                    ? new Date("2026-09-01T00:00:00.000Z")
                    : null,
                cancelAtPeriodEnd: false,
              },
            ],
          }),
        },
        clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
        diagnostics: { record: () => undefined },
      });

      const result = await billing.reconcileCurrentState(
        `workspace-${expected.status}`,
      );
      expect(result.kind).toBe("reconciled");
      expect(result.view).toMatchObject({
        plan: expected.plan,
        status: expected.viewStatus,
        health: expected.health,
      });
      expect(await store.readProjection(`workspace-${expected.status}`)).toMatchObject({
        pricingTier: expected.plan,
        status: expected.workspaceStatus,
      });
    }
  });

  test("rechecks activating accounts on the short recovery cadence", async () => {
    let now = new Date("2026-08-28T10:00:00.000Z");
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-activating-cadence",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "free",
        status: "pending_payment",
        providerCustomerId: "cus_activating_cadence",
      },
    ]);
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => ({
          customerId: "cus_activating_cadence",
          ownership: {
            kind: "verified",
            workspaceId: "workspace-activating-cadence",
          },
          subscriptions: [
            {
              id: "sub_activating_cadence",
              status: "incomplete",
              items: [{ priceId: "price_creator_monthly", quantity: 1 }],
              createdAt: now,
              effectiveAt: now,
              currentPeriodEnd: null,
              trialEnd: null,
              cancelAtPeriodEnd: false,
            },
          ],
        }),
      },
      clock: { now: () => now },
      diagnostics: { record: () => undefined },
    });

    expect(await billing.reconcileCurrentState("workspace-activating-cadence"))
      .toMatchObject({ view: { health: "activating" } });
    now = new Date(now.getTime() + 29_999);
    expect(await billing.reconcileDueAccounts()).toMatchObject({ claimed: 0 });
    now = new Date(now.getTime() + 1);
    expect(await billing.reconcileDueAccounts()).toMatchObject({ claimed: 1 });
  });

  test("an expired claimant cannot replace a newer reconciliation", async () => {
    let now = new Date("2026-08-28T10:00:00.000Z");
    let releaseFirst!: (state: Awaited<ReturnType<WorkspaceBillingProvider["retrieveCurrentState"]>>) => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const delayedState = new Promise<
      Awaited<ReturnType<WorkspaceBillingProvider["retrieveCurrentState"]>>
    >((resolve) => {
      releaseFirst = resolve;
    });
    let providerCalls = 0;
    const subscriptionState = (priceId: string) => ({
      customerId: "cus_a",
      ownership: { kind: "verified" as const, workspaceId: "workspace-a" },
      subscriptions: [
        {
          id: "sub_a",
          status: "active",
          items: [{ priceId, quantity: 1 }],
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
          effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
          currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
          trialEnd: null,
          cancelAtPeriodEnd: false,
        },
      ],
    });
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-a",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "free",
        status: "active",
        providerCustomerId: "cus_a",
      },
    ]);
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => {
          providerCalls += 1;
          if (providerCalls === 1) {
            markFirstStarted();
            return delayedState;
          }
          return subscriptionState("price_pro_monthly");
        },
      },
      clock: { now: () => now },
      diagnostics: { record: () => undefined },
    });

    const staleRun = billing.reconcileDueAccounts();
    await firstStarted;
    now = new Date(now.getTime() + 60_001);
    const takeover = await billing.reconcileDueAccounts();
    releaseFirst(subscriptionState("price_creator_monthly"));
    const stale = await staleRun;

    expect(takeover.reconciled).toBe(1);
    expect(stale.staleSettlements).toBe(1);
    expect(await store.readProjection("workspace-a")).toMatchObject({
      pricingTier: "pro",
      canonicalSubscriptionId: "sub_a",
    });
  });

  test("a stale seat mutation wakes verification of the latest membership revision", async () => {
    let now = new Date("2026-08-28T10:00:00.000Z");
    let desired = 1;
    let revision = 1;
    let providerQuantity = 0;
    let releaseOldCreate!: () => void;
    let markOldCreateStarted!: () => void;
    const oldCreateStarted = new Promise<void>((resolve) => {
      markOldCreateStarted = resolve;
    });
    const oldCreateReleased = new Promise<void>((resolve) => {
      releaseOldCreate = resolve;
    });
    const baseStore = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-seat-fence",
        personal: false,
        hasNonOwnerMembers: true,
        pricingTier: "business",
        status: "active",
        providerCustomerId: "cus_seat_fence",
        desiredAdditionalSeats: 1,
      },
    ]);
    const store: WorkspaceBillingStore = {
      ...baseStore,
      readDesiredSeatState: async () => ({ desired, revision }),
    };
    const providerState = () => ({
      customerId: "cus_seat_fence",
      ownership: {
        kind: "verified" as const,
        workspaceId: "workspace-seat-fence",
      },
      subscriptions: [
        {
          id: "sub_seat_fence",
          status: "active",
          items: [
            { priceId: "price_business_monthly", quantity: 1 },
            ...(providerQuantity > 0
              ? [
                  {
                    id: "si_seat_fence",
                    priceId: "price_business_seat_monthly",
                    quantity: providerQuantity,
                  },
                ]
              : []),
          ],
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
          effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
          currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
          trialEnd: null,
          cancelAtPeriodEnd: false,
        },
      ],
    });
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => providerState(),
        createSeatItem: async (input, key) => {
          if (key.endsWith("-1")) {
            markOldCreateStarted();
            await oldCreateReleased;
          }
          providerQuantity = input.quantity;
          return { itemId: "si_seat_fence" };
        },
        updateSeatItem: async (input) => {
          providerQuantity = input.quantity;
        },
      },
      clock: { now: () => now },
      diagnostics: { record: () => undefined },
    });

    const staleRun = billing.reconcileDueAccounts();
    await oldCreateStarted;
    desired = 2;
    revision = 2;
    now = new Date(now.getTime() + catalog.worker.leaseMs + 1);
    expect(await billing.reconcileDueAccounts()).toMatchObject({ reconciled: 1 });
    expect(providerQuantity).toBe(2);

    releaseOldCreate();
    expect(await staleRun).toMatchObject({ staleSettlements: 1 });
    expect(providerQuantity).toBe(1);

    expect(await billing.reconcileDueAccounts()).toMatchObject({
      claimed: 1,
      reconciled: 1,
    });
    expect(providerQuantity).toBe(2);
  });

  test("an expired claimant cannot schedule retry ahead of takeover", async () => {
    let now = new Date("2026-08-28T10:00:00.000Z");
    let rejectFirst!: (error: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const delayedFailure = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let calls = 0;
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-retry-fence",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "free",
        status: "active",
        providerCustomerId: "cus_retry_fence",
      },
    ]);
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => {
          calls += 1;
          if (calls === 1) {
            markStarted();
            return delayedFailure;
          }
          return {
            customerId: "cus_retry_fence",
            ownership: {
              kind: "verified",
              workspaceId: "workspace-retry-fence",
            },
            subscriptions: [
              {
                id: "sub_retry_fence",
                status: "active",
                items: [{ priceId: "price_creator_monthly", quantity: 1 }],
                createdAt: new Date("2026-08-01T00:00:00.000Z"),
                effectiveAt: new Date("2026-08-28T09:00:00.000Z"),
                currentPeriodEnd: new Date("2026-09-28T09:00:00.000Z"),
                trialEnd: null,
                cancelAtPeriodEnd: false,
              },
            ],
          };
        },
      },
      clock: { now: () => now },
      diagnostics: { record: () => undefined },
    });

    const staleRun = billing.reconcileDueAccounts();
    await started;
    now = new Date(now.getTime() + catalog.worker.leaseMs + 1);
    rejectFirst(new Error("provider failed after lease expiry"));
    expect(await staleRun).toMatchObject({ staleSettlements: 1, retried: 0 });

    expect(await billing.reconcileDueAccounts()).toMatchObject({
      claimed: 1,
      reconciled: 1,
    });
  });

  test("uses provider-effective payment time and the fixed grace deadline", async () => {
    let now = new Date("2026-08-28T10:00:00.000Z");
    let status = "active";
    const effectiveTimes: Date[] = [];
    const baseStore = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-effective",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "free",
        status: "active",
        providerCustomerId: "cus_effective",
      },
    ]);
    const store = {
      ...baseStore,
      async commitVerifiedState(
        input: Parameters<typeof baseStore.commitVerifiedState>[0],
      ) {
        effectiveTimes.push(input.effectiveAt);
        return baseStore.commitVerifiedState(input);
      },
    };
    const paidAt = new Date("2026-08-28T09:42:00.000Z");
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => ({
          customerId: "cus_effective",
          ownership: { kind: "verified", workspaceId: "workspace-effective" },
          subscriptions: [
            {
              id: "sub_effective",
              status,
              items: [{ priceId: "price_pro_monthly", quantity: 1 }],
              createdAt: new Date("2026-08-01T00:00:00.000Z"),
              effectiveAt: paidAt,
              currentPeriodEnd: new Date("2026-09-28T09:42:00.000Z"),
              trialEnd: null,
              cancelAtPeriodEnd: false,
            },
          ],
        }),
      },
      clock: { now: () => now },
      diagnostics: { record: () => undefined },
    });

    await billing.reconcileCurrentState("workspace-effective");
    expect(effectiveTimes.at(-1)).toEqual(paidAt);
    status = "past_due";
    await billing.reconcileCurrentState("workspace-effective");
    const graceDeadline = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    now = graceDeadline;
    await billing.reconcileCurrentState("workspace-effective");
    expect(effectiveTimes.at(-1)).toEqual(graceDeadline);
  });

  test("accepts one signed delivery and treats exact redelivery as a duplicate", async () => {
    const verifiedBodies: Array<{ rawBody: string; signature: string }> = [];
    const deliveryLatencies: number[] = [];
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-a",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "free",
        status: "active",
        providerCustomerId: "cus_a",
      },
    ]);
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: (rawBody, signature) => {
          verifiedBodies.push({ rawBody, signature });
          return {
            eventId: "evt_1",
            eventType: "customer.subscription.updated",
            providerCreatedAt: new Date("2026-08-28T09:59:00.000Z"),
            liveMode: false,
            apiVersion: "2026-08-27.basil",
            customerId: "cus_a",
            subscriptionId: "sub_a",
            checkoutSessionId: null,
            workspaceHint: "workspace-a",
          };
        },
        retrieveCurrentState: async () => {
          throw new Error("delivery acceptance must not retrieve Stripe state");
        },
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
      metrics: {
        observe: (name, value) => {
          if (name === "workspace_billing_delivery_latency_ms") {
            deliveryLatencies.push(value);
          }
        },
      },
    });

    expect(await billing.acceptStripeDelivery('{"untouched": true}\n', "sig_1"))
      .toEqual({ kind: "accepted", workspaceId: "workspace-a" });
    expect(await billing.acceptStripeDelivery('{"untouched": true}\n', "sig_1"))
      .toEqual({ kind: "duplicate", workspaceId: "workspace-a" });
    expect(verifiedBodies).toEqual([
      { rawBody: '{"untouched": true}\n', signature: "sig_1" },
      { rawBody: '{"untouched": true}\n', signature: "sig_1" },
    ]);
    expect(deliveryLatencies).toEqual([60_000, 60_000]);
  });

  test("acknowledges unrelated signed events without making billing due", async () => {
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-ignored",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "free",
        status: "active",
        providerCustomerId: "cus_ignored",
      },
    ]);
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => ({
          eventId: "evt_ignored",
          eventType: "payment_method.attached",
          providerCreatedAt: new Date("2026-08-28T09:59:00.000Z"),
          liveMode: false,
          apiVersion: null,
          customerId: "cus_ignored",
          subscriptionId: null,
          checkoutSessionId: null,
          workspaceHint: null,
        }),
        retrieveCurrentState: async () => {
          throw new Error("ignored delivery must not retrieve provider state");
        },
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });

    expect(await billing.acceptStripeDelivery("{}", "sig")).toEqual({
      kind: "ignored",
      workspaceId: "workspace-ignored",
    });
  });

  test("rejects a price id mapped to more than one billing role", () => {
    expect(() =>
      createBillingCatalog({
        ...catalog,
        basePrices: [
          ...catalog.basePrices,
          {
            priceId: "price_business_seat_monthly",
            tier: "creator",
            interval: "monthly",
          },
        ],
      }),
    ).toThrow("price_business_seat_monthly is mapped more than once");
  });

  test("rejects incomplete catalogs and unsafe worker limits", () => {
    expect(() =>
      createBillingCatalog({
        ...catalog,
        basePrices: catalog.basePrices.slice(1),
      }),
    ).toThrow("Missing base price for creator/monthly");
    expect(() =>
      createBillingCatalog({
        ...catalog,
        worker: { ...catalog.worker, concurrency: Number.POSITIVE_INFINITY },
      }),
    ).toThrow("worker.concurrency must be a finite integer between 1 and 32");
  });

  test("reconciles one active monthly subscription into the Workspace projection", async () => {
    const now = new Date("2026-08-28T10:00:00.000Z");
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-a",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "free",
        status: "active",
        providerCustomerId: "cus_a",
      },
    ]);
    const provider: WorkspaceBillingProvider = {
      verifyDelivery: () => {
        throw new Error("not used");
      },
      retrieveCurrentState: async () => ({
        customerId: "cus_a",
        ownership: { kind: "verified", workspaceId: "workspace-a" },
        subscriptions: [
          {
            id: "sub_a",
            status: "active",
            items: [{ priceId: "price_creator_monthly", quantity: 1 }],
            createdAt: new Date("2026-08-01T00:00:00.000Z"),
            effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
            currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
            trialEnd: null,
            cancelAtPeriodEnd: false,
          },
        ],
      }),
    };
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider,
      clock: { now: () => now },
      diagnostics: { record: () => undefined },
    });

    const result = await billing.reconcileCurrentState("workspace-a");

    expect(result).toEqual({
      kind: "reconciled",
      view: {
        workspaceId: "workspace-a",
        plan: "creator",
        interval: "monthly",
        status: "active",
        workspaceAccessStatus: "active",
        health: "current",
        renewalOrEndAt: "2026-09-01T00:00:00.000Z",
        cancelAtPeriodEnd: false,
        graceDeadlineAt: null,
        lastSuccessfulSyncAt: now.toISOString(),
        desiredAdditionalSeats: 0,
        synchronizedAdditionalSeats: null,
        actions: ["open_portal"],
      },
    });
    expect(await store.readProjection("workspace-a")).toMatchObject({
      pricingTier: "creator",
      status: "active",
      canonicalSubscriptionId: "sub_a",
    });
  });
});
