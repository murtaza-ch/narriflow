import { describe, expect, test } from "bun:test";
import {
  createBillingCatalog,
  createInMemoryWorkspaceBillingStore,
  createWorkspaceBillingModule,
  type WorkspaceBillingProvider,
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
    });
    const unknownResult = await unknown.reconcileCurrentState("unknown");
    expect(unknownResult).toMatchObject({
      kind: "unresolved",
      reason: "unmapped_price",
      view: { plan: "pro", health: "attention_required" },
    });

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
    });
    const outageResult = await outage.reconcileCurrentState("outage");
    expect(outageResult).toMatchObject({
      kind: "unresolved",
      reason: "retryable_provider",
      view: { plan: "pro", health: "retrying" },
    });
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
    const store = createInMemoryWorkspaceBillingStore([
      {
        workspaceId: "workspace-conflict",
        personal: false,
        hasNonOwnerMembers: true,
        pricingTier: "pro",
        status: "active",
        providerCustomerId: "cus_conflict",
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
  });

  test("past-due grace starts once, expires exactly at seven days, and clears on recovery", async () => {
    let now = new Date("2026-08-28T10:00:00.000Z");
    let status = "past_due";
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
    });

    expect(await billing.acceptStripeDelivery('{"untouched": true}\n', "sig_1"))
      .toEqual({ kind: "accepted", workspaceId: "workspace-a" });
    expect(await billing.acceptStripeDelivery('{"untouched": true}\n', "sig_1"))
      .toEqual({ kind: "duplicate", workspaceId: "workspace-a" });
    expect(verifiedBodies).toEqual([
      { rawBody: '{"untouched": true}\n', signature: "sig_1" },
      { rawBody: '{"untouched": true}\n', signature: "sig_1" },
    ]);
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
        health: "current",
        renewalOrEndAt: "2026-09-01T00:00:00.000Z",
        cancelAtPeriodEnd: false,
        graceDeadlineAt: null,
        lastSuccessfulSyncAt: now.toISOString(),
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
