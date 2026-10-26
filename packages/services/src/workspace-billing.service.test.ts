import { describe, expect, test } from "bun:test";
import {
  workspaceAllowsCapability,
  type PaidPricingTier,
  type PricingTier,
} from "@narriflow/validators";
import {
  createBillingCatalog,
  createInMemoryWorkspaceBillingStore,
  createWorkspaceBillingModule,
  projectWorkspaceAccessStatus,
  type ProviderCheckoutSession,
  type ProviderSubscription,
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

/** Verified provider state with no subscription, as Checkout admission sees it. */
function noSubscriptions(customerId: string, workspaceId: string) {
  return async () => ({
    customerId,
    ownership: { kind: "verified" as const, workspaceId },
    subscriptions: [],
  });
}

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
        retrieveCurrentState: noSubscriptions("cus_checkout", "workspace-checkout"),
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
        retrieveCurrentState: noSubscriptions("cus_return", "workspace-return"),
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

  test("does not let a stale return regress a paid Checkout outcome", async () => {
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-paid-return-race",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "free",
        status: "active",
        providerCustomerId: null,
        ownerUserId: "owner-paid-return-race",
      },
    ]);
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: noSubscriptions("cus_paid_return_race", "workspace-paid-return-race"),
        findCustomersByWorkspace: async () => [],
        createCustomer: async () => ({ customerId: "cus_paid_return_race" }),
        createCheckoutSession: async (input) => ({
          sessionId: "cs_paid_return_race",
          url: "https://checkout.stripe.test/paid-return-race",
          expiresAt: new Date("2026-08-28T11:00:00.000Z"),
          status: "open",
          paymentStatus: "unpaid",
          workspaceId: input.workspaceId,
          attemptId: input.attemptId,
        }),
        retrieveCheckoutSession: async () => {
          throw new Error("not used");
        },
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });
    await billing.startCheckout({
      workspaceId: "workspace-paid-return-race",
      actorUserId: "owner-paid-return-race",
      clientIdempotencyKey: "paid-return-race-key",
      targetTier: "creator",
      interval: "monthly",
      returnDestination: "/settings/billing",
    });

    await store.recordCheckoutState({
      workspaceId: "workspace-paid-return-race",
      sessionId: "cs_paid_return_race",
      status: "complete",
      paymentStatus: "paid",
      source: "reconciliation",
      wakeReconciliation: false,
      now: new Date("2026-08-28T10:00:01.000Z"),
    });
    await store.recordCheckoutState({
      workspaceId: "workspace-paid-return-race",
      sessionId: "cs_paid_return_race",
      status: "complete",
      paymentStatus: "unpaid",
      source: "return",
      wakeReconciliation: true,
      now: new Date("2026-08-28T10:00:02.000Z"),
    });
    await store.recordCheckoutState({
      workspaceId: "workspace-paid-return-race",
      sessionId: "cs_paid_return_race",
      status: "complete",
      paymentStatus: "failed",
      source: "return",
      wakeReconciliation: true,
      now: new Date("2026-08-28T10:00:03.000Z"),
    });

    expect(await store.readProjection("workspace-paid-return-race")).toMatchObject({
      health: "current",
      latestCheckout: {
        status: "complete",
        paymentStatus: "paid",
      },
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
        retrieveCurrentState: noSubscriptions("cus_expired_return", "workspace-expired-return"),
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
    let checkoutPaymentStatus = "unpaid";
    let deliveryType:
      | "checkout.session.async_payment_failed"
      | "checkout.session.completed" =
      "checkout.session.async_payment_failed";
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
        verifyDelivery: () => ({
          eventId: `evt_${deliveryType.replaceAll(".", "_")}`,
          eventType: deliveryType,
          providerCreatedAt: new Date("2026-08-28T09:59:00.000Z"),
          liveMode: false,
          apiVersion: "2026-07-29.dahlia",
          customerId: "cus_zero_subscription",
          subscriptionId: null,
          checkoutSessionId: "cs_zero_subscription",
          workspaceHint: "workspace-zero-subscription",
        }),
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
          paymentStatus: checkoutPaymentStatus,
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

    checkoutPaymentStatus = "failed";
    expect(await billing.acceptStripeDelivery("async-failed", "sig"))
      .toEqual({
        kind: "accepted",
        workspaceId: "workspace-zero-subscription",
      });
    expect(await billing.readBillingState("workspace-zero-subscription"))
      .toMatchObject({
        status: "payment_pending",
        health: "activating",
        actions: [],
      });
    expect(await billing.reconcileCurrentState("workspace-zero-subscription"))
      .toMatchObject({
        view: {
          status: "payment_failed",
          health: "current",
          actions: ["start_checkout"],
        },
      });

    deliveryType = "checkout.session.completed";
    expect(await billing.acceptStripeDelivery("delayed-completed", "sig"))
      .toEqual({
        kind: "accepted",
        workspaceId: "workspace-zero-subscription",
      });
    expect(
      await billing.observeCheckoutReturn({
        workspaceId: "workspace-zero-subscription",
        actorUserId: "owner-zero-subscription",
        sessionId: "cs_zero_subscription",
      }),
    ).toMatchObject({ view: { status: "payment_failed" } });
    expect(await billing.reconcileCurrentState("workspace-zero-subscription"))
      .toMatchObject({
        view: {
          status: "payment_failed",
          health: "current",
          actions: ["start_checkout"],
        },
      });

    checkoutStatus = "expired";
    checkoutPaymentStatus = "unpaid";
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
        key: "workspace-seat-workspace-seats-sub_seats-monthly-1",
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

  test("a returning customer's new subscription replaces the canceled canonical one", async () => {
    const oldSubscription = {
      id: "sub_old",
      status: "active",
      items: [{ priceId: "price_creator_annual", quantity: 1 }],
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      effectiveAt: new Date("2026-07-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2027-07-01T00:00:00.000Z"),
      trialEnd: null,
      cancelAtPeriodEnd: false,
    };
    let subscriptions = [oldSubscription];
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-return",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "free",
        status: "active",
        providerCustomerId: "cus_return",
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
          customerId: "cus_return",
          ownership: { kind: "verified", workspaceId: "workspace-return" },
          subscriptions,
        }),
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });

    expect((await billing.reconcileCurrentState("workspace-return")).view.plan).toBe(
      "creator",
    );
    subscriptions = [{ ...oldSubscription, status: "canceled" }];
    expect((await billing.reconcileCurrentState("workspace-return")).view.plan).toBe(
      "free",
    );
    subscriptions = [
      {
        ...oldSubscription,
        id: "sub_new",
        createdAt: new Date("2026-08-20T00:00:00.000Z"),
        effectiveAt: new Date("2026-08-20T00:00:00.000Z"),
      },
      { ...oldSubscription, status: "canceled" },
    ];
    const resubscribed = await billing.reconcileCurrentState("workspace-return");
    expect(resubscribed.view).toMatchObject({ plan: "creator", status: "active" });
  });

  test("an incomplete upgrade leaves an existing Free Workspace usable", async () => {
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-upgrading",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "free",
        status: "active",
        providerCustomerId: "cus_upgrading",
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
          customerId: "cus_upgrading",
          ownership: { kind: "verified", workspaceId: "workspace-upgrading" },
          subscriptions: [
            {
              id: "sub_upgrading",
              status: "incomplete",
              items: [{ priceId: "price_creator_annual", quantity: 1 }],
              createdAt: new Date("2026-08-28T09:00:00.000Z"),
              effectiveAt: new Date("2026-08-28T09:00:00.000Z"),
              currentPeriodEnd: null,
              trialEnd: null,
              cancelAtPeriodEnd: false,
            },
          ],
        }),
      },
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });

    await billing.reconcileCurrentState("workspace-upgrading");
    expect((await store.readProjection("workspace-upgrading"))?.status).toBe(
      "active",
    );
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

function subscription(
  input: Partial<ProviderSubscription> & Pick<ProviderSubscription, "id" | "status">,
): ProviderSubscription {
  return {
    items: [{ id: `si_${input.id}`, priceId: "price_pro_monthly", quantity: 1 }],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    effectiveAt: new Date("2026-09-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
    trialEnd: null,
    cancelAtPeriodEnd: false,
    ...input,
  };
}

/** One Workspace with a Stripe-like Checkout provider that honors idempotency. */
function checkoutWorld(options: {
  workspaceId: string;
  providerCustomerId?: string | null;
  subscriptions?: ProviderSubscription[];
  wrapStore?: (store: WorkspaceBillingStore) => WorkspaceBillingStore;
}) {
  const workspaceId = options.workspaceId;
  const ownerUserId = `owner-${workspaceId}`;
  const customerId = options.providerCustomerId ?? `cus_${workspaceId}`;
  let now = new Date("2026-10-26T10:00:00.000Z");
  const provider = {
    subscriptions: options.subscriptions ?? [],
    sessions: new Map<string, ProviderCheckoutSession>(),
    created: [] as Array<{ attemptId: string; priceId: string; key: string }>,
    failNextCreate: false,
  };
  const baseStore = createInMemoryWorkspaceBillingStore([
    {
      workspaceId,
      personal: true,
      hasNonOwnerMembers: false,
      pricingTier: "free",
      status: "active",
      providerCustomerId: options.providerCustomerId ?? null,
      ownerUserId,
    },
  ]);
  const store = options.wrapStore?.(baseStore) ?? baseStore;
  const adapter: WorkspaceBillingProvider = {
    verifyDelivery: () => {
      throw new Error("not used");
    },
    retrieveCurrentState: async () => ({
      customerId,
      ownership: { kind: "verified", workspaceId },
      subscriptions: provider.subscriptions,
    }),
    findCustomersByWorkspace: async () => [],
    createCustomer: async () => ({ customerId }),
    findCheckoutSessionsByAttempt: async ({ attemptId }) =>
      [...provider.sessions.values()].filter(
        (session) => session.attemptId === attemptId,
      ),
    createCheckoutSession: async (input, key) => {
      if (provider.failNextCreate) {
        provider.failNextCreate = false;
        throw new Error("provider timeout");
      }
      const replay = [...provider.sessions.values()].find(
        (session) => session.attemptId === input.attemptId,
      );
      if (replay) return { ...replay };
      provider.created.push({ attemptId: input.attemptId, priceId: input.priceId, key });
      const session: ProviderCheckoutSession = {
        sessionId: `cs_${provider.created.length}`,
        url: `https://checkout.stripe.test/${provider.created.length}`,
        expiresAt: input.expiresAt,
        status: "open",
        paymentStatus: "unpaid",
        workspaceId,
        attemptId: input.attemptId,
      };
      provider.sessions.set(session.sessionId, session);
      return { ...session };
    },
    retrieveCheckoutSession: async (sessionId) => {
      const session = provider.sessions.get(sessionId);
      if (!session) throw new Error("unknown session");
      return { ...session };
    },
  };
  const billing = createWorkspaceBillingModule({
    catalog,
    store,
    provider: adapter,
    clock: { now: () => now },
    diagnostics: { record: () => undefined },
  });
  return {
    billing,
    provider,
    start: (
      clientIdempotencyKey: string,
      targetTier: PaidPricingTier = "pro",
      interval: "monthly" | "annual" = "monthly",
    ) =>
      billing.startCheckout({
        workspaceId,
        actorUserId: ownerUserId,
        clientIdempotencyKey,
        targetTier,
        interval,
        returnDestination: "/settings/billing",
      }),
    observeReturn: (sessionId: string) =>
      billing.observeCheckoutReturn({ workspaceId, actorUserId: ownerUserId, sessionId }),
    updateSession: (sessionId: string, patch: Partial<ProviderCheckoutSession>) => {
      const session = provider.sessions.get(sessionId)!;
      provider.sessions.set(sessionId, { ...session, ...patch });
    },
    advance: (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

describe("Workspace Billing Checkout admission", () => {
  test("two tabs with different keys share one open session for the same choice", async () => {
    const world = checkoutWorld({ workspaceId: "workspace-two-tabs" });

    const [first, second] = await Promise.all([
      world.start("tab-a"),
      world.start("tab-b"),
    ]);
    const third = await world.start("tab-c");

    expect(first).toEqual(second);
    expect(third).toEqual(first);
    expect(world.provider.created).toHaveLength(1);
  });

  test("a different concurrent choice is refused with a typed conflict", async () => {
    const world = checkoutWorld({ workspaceId: "workspace-other-tier" });
    await world.start("pro-tab", "pro");

    await expect(world.start("business-tab", "business")).rejects.toMatchObject({
      code: "checkout_in_progress",
      kind: "conflict",
      details: {
        tier: "pro",
        interval: "monthly",
        // Short sessions bound how long an abandoned Checkout blocks another choice.
        expiresAt: "2026-10-26T10:31:00.000Z",
      },
    });
    await expect(world.start("annual-tab", "pro", "annual")).rejects.toMatchObject({
      code: "checkout_in_progress",
    });
    expect(world.provider.created).toHaveLength(1);
  });

  test("a crash after provider session creation resumes that session, never a second", async () => {
    let crashBind = true;
    const world = checkoutWorld({
      workspaceId: "workspace-crash",
      wrapStore: (store) => ({
        ...store,
        bindCheckoutSession: async (input) => {
          if (crashBind) {
            crashBind = false;
            throw new Error("process crashed before bind");
          }
          return store.bindCheckoutSession(input);
        },
      }),
    });

    await expect(world.start("crash-tab")).rejects.toThrow("process crashed");
    expect(world.provider.sessions.size).toBe(1);
    const resumed = await world.start("second-tab");
    const replayed = await world.start("crash-tab");

    expect(resumed).toMatchObject({ url: "https://checkout.stripe.test/1" });
    expect(replayed).toEqual(resumed);
    expect(world.provider.created).toHaveLength(1);
  });

  test("an abandoned unbound preparation frees the slot after the preparation window", async () => {
    const world = checkoutWorld({ workspaceId: "workspace-abandoned" });
    world.provider.failNextCreate = true;
    await expect(world.start("stalled-tab", "pro")).rejects.toThrow("provider timeout");

    await expect(world.start("business-tab", "business")).rejects.toMatchObject({
      code: "checkout_in_progress",
    });
    world.advance(3 * 60_000);
    expect(await world.start("business-tab", "business")).toMatchObject({
      kind: "checkout",
    });
    await expect(world.start("stalled-tab", "pro")).rejects.toMatchObject({
      code: "checkout_attempt_terminal",
    });
    expect(world.provider.created.map((entry) => entry.priceId)).toEqual([
      "price_business_monthly",
    ]);
  });

  test("a stale abandoned-preparation release cannot free a slot bound meanwhile", async () => {
    let beforeRelease: (() => Promise<void>) | null = null;
    const world = checkoutWorld({
      workspaceId: "workspace-release-race",
      wrapStore: (store) => ({
        ...store,
        releaseCheckoutSlot: async (input) => {
          const interleave = beforeRelease;
          beforeRelease = null;
          if (interleave) await interleave();
          return store.releaseCheckoutSlot(input);
        },
      }),
    });
    world.provider.failNextCreate = true;
    await expect(world.start("pro-tab", "pro")).rejects.toThrow("provider timeout");
    world.advance(3 * 60_000);

    // The Business request decides the Pro preparation is abandoned; before
    // its release lands, the Pro retry binds a session and returns its URL.
    let proUrl: string | undefined;
    beforeRelease = async () => {
      proUrl = (await world.start("pro-tab", "pro")).url;
    };
    await expect(world.start("business-tab", "business")).rejects.toMatchObject({
      code: "checkout_in_progress",
      details: { tier: "pro" },
    });

    expect(proUrl).toBe("https://checkout.stripe.test/1");
    expect(world.provider.created.map((entry) => entry.priceId)).toEqual([
      "price_pro_monthly",
    ]);
    expect(await world.start("pro-tab", "pro")).toMatchObject({ url: proUrl });
  });

  test("a completed Checkout awaiting reconciliation is not replaced", async () => {
    const world = checkoutWorld({ workspaceId: "workspace-completed" });
    await world.start("paid-tab", "creator");
    world.updateSession("cs_1", { status: "complete", paymentStatus: "paid", url: null });
    world.provider.subscriptions = [
      subscription({
        id: "sub_completed",
        status: "active",
        items: [{ id: "si_creator", priceId: "price_creator_monthly", quantity: 1 }],
      }),
    ];

    // Before the return is observed the provider already shows the live subscription.
    await expect(world.start("other-tab", "pro")).rejects.toMatchObject({
      code: "billing_portal_required",
    });
    await world.observeReturn("cs_1");
    await expect(world.start("late-tab", "pro")).rejects.toMatchObject({
      code: "checkout_in_progress",
    });
    await expect(world.start("paid-tab", "creator")).rejects.toMatchObject({
      code: "checkout_in_progress",
    });
    expect(world.provider.created).toHaveLength(1);
  });

  test("an abandoned open session blocks another choice only until Stripe expires it", async () => {
    const world = checkoutWorld({ workspaceId: "workspace-abandoned-open" });
    expect(await world.start("pro-tab", "pro")).toMatchObject({
      expiresAt: "2026-10-26T10:31:00.000Z",
    });
    world.advance(30 * 60_000);
    await expect(world.start("business-tab", "business")).rejects.toMatchObject({
      code: "checkout_in_progress",
    });

    // Stripe expires it at expires_at; the verified expiry frees the slot.
    world.advance(2 * 60_000);
    world.updateSession("cs_1", { status: "expired", url: null });
    expect(await world.start("business-tab", "business")).toMatchObject({
      kind: "checkout",
      url: "https://checkout.stripe.test/2",
      expiresAt: "2026-10-26T11:03:00.000Z",
    });
  });

  test("a verified expired session is replaced by a new choice, and its key is spent", async () => {
    const world = checkoutWorld({ workspaceId: "workspace-expired-slot" });
    await world.start("first-tab", "pro");
    world.updateSession("cs_1", { status: "expired", url: null });

    expect(await world.start("second-tab", "business")).toMatchObject({
      kind: "checkout",
      url: "https://checkout.stripe.test/2",
    });
    await expect(world.start("first-tab", "pro")).rejects.toMatchObject({
      code: "checkout_attempt_terminal",
    });
    expect(world.provider.created.map((entry) => entry.priceId)).toEqual([
      "price_pro_monthly",
      "price_business_monthly",
    ]);
  });

  test("a failed Checkout payment frees the slot once its subscription has ended", async () => {
    const world = checkoutWorld({ workspaceId: "workspace-failed-slot" });
    await world.start("first-tab", "pro");
    world.updateSession("cs_1", { status: "complete", paymentStatus: "failed", url: null });
    world.provider.subscriptions = [
      subscription({ id: "sub_failed", status: "incomplete" }),
    ];

    // The incomplete subscription can still be paid, so it is recovered, not replaced.
    await expect(world.start("second-tab", "pro")).rejects.toMatchObject({
      code: "billing_portal_required",
    });
    world.provider.subscriptions = [
      subscription({ id: "sub_failed", status: "incomplete_expired" }),
    ];
    expect(await world.start("third-tab", "pro")).toMatchObject({ kind: "checkout" });
    expect(world.provider.created).toHaveLength(2);
  });

  test("any subscription that can still bill routes to the portal despite a Free projection", async () => {
    for (const status of ["past_due", "unpaid", "paused", "incomplete", "active", "trialing"]) {
      const world = checkoutWorld({
        workspaceId: `workspace-recoverable-${status}`,
        providerCustomerId: `cus_recoverable_${status}`,
        subscriptions: [subscription({ id: `sub_${status}`, status })],
      });
      await expect(world.start(`key-${status}`)).rejects.toMatchObject({
        code: "billing_portal_required",
      });
      expect(world.provider.created).toHaveLength(0);
      // The refused attempt does not hold the slot for a later choice.
      world.provider.subscriptions = [];
      expect(await world.start(`retry-${status}`, "business")).toMatchObject({
        kind: "checkout",
      });
    }
  });

  test("past-due after grace keeps the Free projection but offers only the portal", async () => {
    let now = new Date("2026-10-01T00:00:00.000Z");
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-past-due-grace",
        personal: true,
        hasNonOwnerMembers: false,
        pricingTier: "pro",
        status: "active",
        providerCustomerId: "cus_past_due_grace",
        ownerUserId: "owner-past-due-grace",
      },
    ]);
    let checkoutCreates = 0;
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => ({
          customerId: "cus_past_due_grace",
          ownership: { kind: "verified", workspaceId: "workspace-past-due-grace" },
          subscriptions: [subscription({ id: "sub_past_due", status: "past_due" })],
        }),
        findCustomersByWorkspace: async () => [],
        createCustomer: async () => ({ customerId: "cus_past_due_grace" }),
        createCheckoutSession: async () => {
          checkoutCreates += 1;
          throw new Error("must not create a second subscription Checkout");
        },
        retrieveCheckoutSession: async () => {
          throw new Error("not used");
        },
      },
      clock: { now: () => now },
      diagnostics: { record: () => undefined },
    });

    await billing.reconcileCurrentState("workspace-past-due-grace");
    now = new Date("2026-10-08T00:00:01.000Z");
    expect(await billing.reconcileCurrentState("workspace-past-due-grace")).toMatchObject({
      view: { plan: "free", status: "payment_past_due", actions: ["open_portal"] },
    });
    await expect(
      billing.startCheckout({
        workspaceId: "workspace-past-due-grace",
        actorUserId: "owner-past-due-grace",
        clientIdempotencyKey: "after-grace",
        targetTier: "pro",
        interval: "monthly",
        returnDestination: "/settings/billing",
      }),
    ).rejects.toMatchObject({ code: "billing_portal_required" });
    expect(checkoutCreates).toBe(0);
  });

  test("a returning customer with only ended subscriptions may start Checkout", async () => {
    const world = checkoutWorld({
      workspaceId: "workspace-returning",
      providerCustomerId: "cus_returning",
      subscriptions: [
        subscription({ id: "sub_old", status: "canceled" }),
        subscription({ id: "sub_abandoned", status: "incomplete_expired" }),
      ],
    });

    expect(await world.start("returning-tab", "business")).toMatchObject({
      kind: "checkout",
    });
    expect(world.provider.created).toHaveLength(1);
  });
});

describe("Workspace Billing terminal access and seats", () => {
  function seatWorld(input: {
    workspaceId: string;
    status: string;
    desiredAdditionalSeats: number;
    hasNonOwnerMembers: boolean;
    pricingTier?: PricingTier;
  }) {
    let now = new Date("2026-10-01T00:00:00.000Z");
    const seatCalls: string[] = [];
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: input.workspaceId,
        personal: false,
        hasNonOwnerMembers: input.hasNonOwnerMembers,
        pricingTier: input.pricingTier ?? "business",
        status: "active",
        providerCustomerId: `cus_${input.workspaceId}`,
        desiredAdditionalSeats: input.desiredAdditionalSeats,
      },
    ]);
    const rejectSeatMutation = async () => {
      seatCalls.push("mutation");
      throw new Error("Stripe rejects this seat mutation");
    };
    const billing = createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => ({
          customerId: `cus_${input.workspaceId}`,
          ownership: { kind: "verified", workspaceId: input.workspaceId },
          subscriptions: [
            subscription({
              id: `sub_${input.workspaceId}`,
              status: input.status,
              items: [
                { id: "si_base", priceId: "price_business_monthly", quantity: 1 },
                { id: "si_seat", priceId: "price_business_seat_monthly", quantity: 1 },
              ],
            }),
          ],
        }),
        createSeatItem: rejectSeatMutation,
        updateSeatItem: rejectSeatMutation,
        deleteSeatItem: rejectSeatMutation,
      },
      clock: { now: () => now },
      diagnostics: { record: () => undefined },
    });
    return {
      billing,
      seatCalls,
      at: (iso: string) => {
        now = new Date(iso);
      },
    };
  }

  test("cancellation with a pending seat removal commits Free without touching seats", async () => {
    for (const status of ["canceled", "unpaid", "paused", "incomplete_expired"]) {
      const world = seatWorld({
        workspaceId: `workspace-ended-${status}`,
        status,
        desiredAdditionalSeats: 0,
        hasNonOwnerMembers: false,
      });

      expect(await world.billing.reconcileCurrentState(`workspace-ended-${status}`))
        .toMatchObject({
          kind: "reconciled",
          view: { plan: "free", workspaceAccessStatus: "active", health: "current" },
        });
      expect(world.seatCalls).toEqual([]);
    }
  });

  test("a seat failure on a past-due subscription cannot retain access after grace", async () => {
    const world = seatWorld({
      workspaceId: "workspace-past-due-seats",
      status: "past_due",
      desiredAdditionalSeats: 2,
      hasNonOwnerMembers: true,
    });

    // Within grace the subscription can still bill, so seats try to converge;
    // the rejected seat change still lets the grace origin commit durably.
    expect(await world.billing.reconcileCurrentState("workspace-past-due-seats"))
      .toMatchObject({
        kind: "reconciled",
        view: {
          plan: "business",
          health: "payment_action_required",
          graceDeadlineAt: "2026-10-08T00:00:00.000Z",
          desiredAdditionalSeats: 2,
          synchronizedAdditionalSeats: 1,
        },
      });
    expect(world.seatCalls).toEqual(["mutation"]);
    world.at("2026-10-08T00:00:01.000Z");
    expect(await world.billing.reconcileCurrentState("workspace-past-due-seats"))
      .toMatchObject({
        kind: "reconciled",
        view: { plan: "free", workspaceAccessStatus: "restricted" },
      });
    expect(world.seatCalls).toEqual(["mutation", "mutation"]);
  });
});

describe("Workspace Billing below-Business member restriction", () => {
  function downgradeWorld(input: {
    workspaceId: string;
    personal: boolean;
    hasNonOwnerMembers: boolean;
    priceId: string;
  }) {
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: input.workspaceId,
        personal: input.personal,
        hasNonOwnerMembers: input.hasNonOwnerMembers,
        pricingTier: "business",
        status: "active",
        providerCustomerId: `cus_${input.workspaceId}`,
      },
    ]);
    return createWorkspaceBillingModule({
      catalog,
      store,
      provider: {
        verifyDelivery: () => {
          throw new Error("not used");
        },
        retrieveCurrentState: async () => ({
          customerId: `cus_${input.workspaceId}`,
          ownership: { kind: "verified", workspaceId: input.workspaceId },
          subscriptions: [
            subscription({
              id: `sub_${input.workspaceId}`,
              status: "active",
              items: [{ id: "si_base", priceId: input.priceId, quantity: 1 }],
            }),
          ],
        }),
      },
      clock: { now: () => new Date("2026-10-26T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });
  }

  test("Business to Pro or Creator with members restricts to owner recovery", async () => {
    for (const priceId of ["price_pro_monthly", "price_creator_annual"]) {
      const billing = downgradeWorld({
        workspaceId: `workspace-team-${priceId}`,
        personal: false,
        hasNonOwnerMembers: true,
        priceId,
      });

      const result = await billing.reconcileCurrentState(`workspace-team-${priceId}`);

      expect(result).toMatchObject({
        kind: "reconciled",
        view: { workspaceAccessStatus: "restricted", actions: ["open_portal"] },
      });
      const owner = { role: "owner" as const, status: result.view.workspaceAccessStatus };
      for (const capability of [
        "billing.manage",
        "content.view",
        "content.download",
        "members.invite",
      ] as const) {
        expect(workspaceAllowsCapability(owner, capability)).toBe(true);
      }
      for (const capability of [
        "content.edit",
        "processing.consume",
        "publishing.manage",
        "api.manage",
      ] as const) {
        expect(workspaceAllowsCapability(owner, capability)).toBe(false);
      }
      expect(
        workspaceAllowsCapability(
          { role: "editor", status: result.view.workspaceAccessStatus },
          "content.edit",
        ),
      ).toBe(false);
    }
  });

  test("Workspaces without non-owner members and Business teams stay active", async () => {
    for (const [workspaceId, personal, hasNonOwnerMembers, priceId] of [
      ["workspace-personal-pro", true, false, "price_pro_monthly"],
      ["workspace-solo-team-pro", false, false, "price_pro_monthly"],
      ["workspace-business-team", false, true, "price_business_monthly"],
    ] as const) {
      const billing = downgradeWorld({ workspaceId, personal, hasNonOwnerMembers, priceId });
      expect(await billing.reconcileCurrentState(workspaceId)).toMatchObject({
        view: { workspaceAccessStatus: "active" },
      });
    }
  });

  test("the projection rule restricts only member-holding Workspaces below Business", () => {
    for (const tier of ["free", "creator", "pro", "business"] as const) {
      expect(
        projectWorkspaceAccessStatus({
          tier,
          hasNonOwnerMembers: false,
          awaitingFirstPayment: false,
        }),
      ).toBe("active");
      expect(
        projectWorkspaceAccessStatus({
          tier,
          hasNonOwnerMembers: true,
          awaitingFirstPayment: false,
        }),
      ).toBe(tier === "business" ? "active" : "restricted");
    }
    expect(
      projectWorkspaceAccessStatus({
        tier: "free",
        hasNonOwnerMembers: true,
        awaitingFirstPayment: true,
      }),
    ).toBe("pending_payment");
  });
});
