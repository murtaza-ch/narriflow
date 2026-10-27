import { randomUUID } from "node:crypto";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import Stripe from "stripe";
import { createBillingCatalog, BILLING_INTERVALS, PAID_PRICING_TIERS } from "./workspace-billing.service";
import { createStripePlanChangeProvider } from "./workspace-plan-change-stripe";

const sandbox = process.env.RUN_STRIPE_SANDBOX_CONTRACTS === "1" ? describe : describe.skip;
setDefaultTimeout(180_000);

sandbox("Workspace plan changes Stripe sandbox", () => {
  function setup() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key?.startsWith("sk_test_")) throw new Error("Stripe test key required");
    const stripe = new Stripe(key, { apiVersion: "2026-07-29.dahlia", maxNetworkRetries: 0, timeout: 15_000 });
    const catalog = createBillingCatalog({ basePrices: PAID_PRICING_TIERS.flatMap((tier) => BILLING_INTERVALS.map((interval) => ({ tier, interval, priceId: process.env[`STRIPE_PRICE_${tier.toUpperCase()}_${interval.toUpperCase()}`]! }))), seatPrices: BILLING_INTERVALS.map((interval) => ({ interval, priceId: process.env[`STRIPE_PRICE_BUSINESS_SEAT_${interval.toUpperCase()}`]! })), worker: { batchSize: 1, concurrency: 1, leaseMs: 120_000, providerDeadlineMs: 15_000, providerCallBudget: 10 } });
    return { stripe, catalog, provider: createStripePlanChangeProvider(stripe, catalog) };
  }
  async function fixture(stripe: Stripe, price: string, clock = false, seats?: string) {
    const workspaceId = randomUUID();
    const testClock = clock ? await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: "Narriflow disposable plan-change test" }) : null;
    const customer = await stripe.customers.create({ metadata: { workspaceId, app: "narriflow_plan_change_contract" }, ...(testClock ? { test_clock: testClock.id } : {}) });
    let subscription: Stripe.Subscription | null = null;
    try {
      const method = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
      await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: method.id } });
      subscription = await stripe.subscriptions.create({ customer: customer.id, default_payment_method: method.id, items: [{ price, quantity: 1 }, ...(seats ? [{ price: seats, quantity: 2 }] : [])], metadata: { workspaceId, app: "narriflow_plan_change_contract" }, expand: ["latest_invoice", "schedule"] });
      expect(subscription.status).toBe("active");
      return { customer, subscription, workspaceId, testClock, method, cleanup: async () => {
        const current = await stripe.subscriptions.retrieve(subscription!.id, { expand: ["schedule"] }).catch(() => null);
        if (current?.schedule && typeof current.schedule !== "string" && current.schedule.status === "active") await stripe.subscriptionSchedules.release(current.schedule.id).catch(() => undefined);
        await stripe.subscriptions.cancel(subscription!.id).catch(() => undefined);
        await stripe.customers.del(customer.id).catch(() => undefined);
        if (testClock) await stripe.testHelpers.testClocks.del(testClock.id).catch(() => undefined);
      } };
    } catch (error) {
      if (subscription) await stripe.subscriptions.cancel(subscription.id).catch(() => undefined);
      await stripe.customers.del(customer.id).catch(() => undefined);
      if (testClock) await stripe.testHelpers.testClocks.del(testClock.id).catch(() => undefined);
      throw error;
    }
  }

  async function advanceClock(stripe: Stripe, clockId: string, target: number) {
    let current = await stripe.testHelpers.testClocks.retrieve(clockId);
    while (current.frozen_time < target) {
      await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: Math.min(target, current.frozen_time + 45 * 86400) });
      for (let pass = 0; pass < 60; pass++) {
        current = await stripe.testHelpers.testClocks.retrieve(clockId);
        if (current.status === "ready") break;
        await Bun.sleep(500);
      }
      if (current.status !== "ready") throw new Error("Stripe test clock did not settle");
    }
  }

  test("reviews and applies one paid upgrade with stable replay", async () => {
    const { stripe, provider } = setup();
    const f = await fixture(stripe, process.env.STRIPE_PRICE_CREATOR_MONTHLY!);
    try {
      const source = await provider.retrievePlanChangeSubscription!(f.subscription.id);
      const items = [{ id: source.items[0]!.id, priceId: process.env.STRIPE_PRICE_PRO_MONTHLY!, quantity: 1 }];
      const prorationDate = Math.floor(Date.now() / 1000);
      const preview = await provider.previewPlanChange!({ subscriptionId: source.id, customerId: f.customer.id, items, prorationDate });
      expect(preview.currency).toBe("usd");
      expect(preview.amountDue).toBeGreaterThan(0);
      expect((await stripe.subscriptions.retrieve(source.id)).items.data[0]?.price.id).toBe(process.env.STRIPE_PRICE_CREATOR_MONTHLY);
      const input = { workspaceId: f.workspaceId, subscription: source, items, kind: "immediate" as const, prorationDate, quoteId: randomUUID() };
      expect((await provider.applyPlanChange!(input)).kind).toBe("applied");
      expect((await provider.applyPlanChange!(input)).kind).toBe("unchanged");
      const current = await stripe.subscriptions.retrieve(source.id, { expand: ["latest_invoice"] });
      expect(current.items.data[0]?.price.id).toBe(process.env.STRIPE_PRICE_PRO_MONTHLY);
      expect(typeof current.latest_invoice === "object" && current.latest_invoice?.status).toBe("paid");
      expect(typeof current.latest_invoice === "object" && current.latest_invoice?.amount_due).toBe(preview.amountDue);
    } finally { await f.cleanup(); }
  });

  for (const methodId of ["pm_card_chargeCustomerFail", "pm_card_threeDSecure2Required"]) {
    test(`${methodId} retains old items until pending payment succeeds`, async () => {
      const { stripe, provider } = setup();
      const f = await fixture(stripe, process.env.STRIPE_PRICE_CREATOR_MONTHLY!);
      try {
        const method = await stripe.paymentMethods.attach(methodId, { customer: f.customer.id });
        await stripe.subscriptions.update(f.subscription.id, { default_payment_method: method.id });
        const source = await provider.retrievePlanChangeSubscription!(f.subscription.id);
        const result = await provider.applyPlanChange!({ workspaceId: f.workspaceId, subscription: source, items: [{ id: source.items[0]!.id, priceId: process.env.STRIPE_PRICE_PRO_MONTHLY!, quantity: 1 }], kind: "immediate", prorationDate: Math.floor(Date.now() / 1000), quoteId: randomUUID() });
        expect(result.kind).toBe("pending_payment");
        expect(result.paymentUrl).toStartWith("https://invoice.stripe.com/");
        const current = await stripe.subscriptions.retrieve(source.id);
        expect(current.pending_update).not.toBeNull();
        expect(current.items.data[0]?.price.id).toBe(process.env.STRIPE_PRICE_CREATOR_MONTHLY);
        const invoice = typeof current.latest_invoice === "string" ? current.latest_invoice : current.latest_invoice!.id;
        await stripe.invoices.pay(invoice, { payment_method: f.method.id });
        const paid = await stripe.subscriptions.retrieve(source.id);
        expect(paid.pending_update).toBeNull();
        expect(paid.items.data[0]?.price.id).toBe(process.env.STRIPE_PRICE_PRO_MONTHLY);
      } finally { await f.cleanup(); }
    });
  }

  test("keeping the current plan voids a declined upgrade's invoice and discards the pending update", async () => {
    const { stripe, provider } = setup();
    const f = await fixture(stripe, process.env.STRIPE_PRICE_CREATOR_MONTHLY!);
    try {
      const method = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: f.customer.id });
      await stripe.subscriptions.update(f.subscription.id, { default_payment_method: method.id });
      const source = await provider.retrievePlanChangeSubscription!(f.subscription.id);
      const result = await provider.applyPlanChange!({ workspaceId: f.workspaceId, subscription: source, items: [{ id: source.items[0]!.id, priceId: process.env.STRIPE_PRICE_PRO_MONTHLY!, quantity: 1 }], kind: "immediate", prorationDate: Math.floor(Date.now() / 1000), quoteId: randomUUID() });
      expect(result.kind).toBe("pending_payment");
      const pending = await provider.retrievePlanChangeSubscription!(f.subscription.id);
      expect(pending.pending).not.toBeNull();
      const invoiceId = (await stripe.subscriptions.retrieve(f.subscription.id)).latest_invoice as string;
      await provider.cancelPendingPlanChange!({ workspaceId: f.workspaceId, subscription: pending });
      const after = await stripe.subscriptions.retrieve(f.subscription.id);
      expect(after.pending_update).toBeNull();
      expect(after.status).toBe("active");
      expect(after.items.data[0]?.price.id).toBe(process.env.STRIPE_PRICE_CREATOR_MONTHLY);
      expect((await stripe.invoices.retrieve(invoiceId)).status).toBe("void");
      // With nothing outstanding, a new plan change is allowed again.
      await expect(provider.retrievePlanChangeSubscription!(f.subscription.id)).resolves.toMatchObject({ pending: null });
    } finally { await f.cleanup(); }
  });

  test("Business interval changes preserve seats and removed seats cannot return at renewal", async () => {
    const { stripe, provider } = setup();
    const f = await fixture(stripe, process.env.STRIPE_PRICE_BUSINESS_MONTHLY!, true, process.env.STRIPE_PRICE_BUSINESS_SEAT_MONTHLY!);
    try {
      const source = await provider.retrievePlanChangeSubscription!(f.subscription.id);
      const base = source.items.find((item) => item.priceId === process.env.STRIPE_PRICE_BUSINESS_MONTHLY)!;
      const seat = source.items.find((item) => item.priceId === process.env.STRIPE_PRICE_BUSINESS_SEAT_MONTHLY)!;
      const annualItems = [{ id: base.id, priceId: process.env.STRIPE_PRICE_BUSINESS_ANNUAL!, quantity: 1 }, { id: seat.id, priceId: process.env.STRIPE_PRICE_BUSINESS_SEAT_ANNUAL!, quantity: 2 }];
      const preview = await provider.previewPlanChange!({ subscriptionId: source.id, customerId: f.customer.id, items: annualItems, prorationDate: source.periodStart });
      expect((await provider.applyPlanChange!({ workspaceId: f.workspaceId, subscription: source, items: annualItems, kind: "immediate", prorationDate: source.periodStart, quoteId: randomUUID() })).kind).toBe("applied");
      const paid = await stripe.subscriptions.retrieve(source.id, { expand: ["latest_invoice"] });
      expect(paid.items.data.find((item) => item.price.id === process.env.STRIPE_PRICE_BUSINESS_SEAT_ANNUAL)?.quantity).toBe(2);
      expect(typeof paid.latest_invoice === "object" && paid.latest_invoice?.amount_due).toBe(preview.amountDue);
      const annual = await provider.retrievePlanChangeSubscription!(source.id);
      const monthlyItems = annual.items.map((item) => ({ ...item, priceId: item.priceId === process.env.STRIPE_PRICE_BUSINESS_ANNUAL ? process.env.STRIPE_PRICE_BUSINESS_MONTHLY! : process.env.STRIPE_PRICE_BUSINESS_SEAT_MONTHLY! }));
      await provider.applyPlanChange!({ workspaceId: f.workspaceId, subscription: annual, items: monthlyItems, kind: "scheduled", prorationDate: annual.periodStart, quoteId: randomUUID() });
      await provider.synchronizeScheduledSeats!({ workspaceId: f.workspaceId, subscriptionId: source.id, desired: 0, revision: 1 });
      const planned = await provider.retrievePlanChangeSubscription!(source.id);
      expect(planned.items).toHaveLength(1);
      expect(planned.schedule?.items).toHaveLength(1);
      await advanceClock(stripe, f.testClock!.id, annual.periodEnd + 5);
      const renewed = await stripe.subscriptions.retrieve(source.id);
      expect(renewed.items.data).toHaveLength(1);
      expect(renewed.items.data[0]?.price.id).toBe(process.env.STRIPE_PRICE_BUSINESS_MONTHLY);
      await provider.finalizeCompletedPlanChangeSchedule!({ workspaceId: f.workspaceId, subscriptionId: source.id });
      expect((await stripe.subscriptions.retrieve(source.id)).schedule).toBeNull();
    } finally { await f.cleanup(); }
  });

  test("a scheduled downgrade keeps Pro until renewal and supports undo", async () => {
    const { stripe, provider } = setup();
    const f = await fixture(stripe, process.env.STRIPE_PRICE_PRO_MONTHLY!, true);
    try {
      const source = await provider.retrievePlanChangeSubscription!(f.subscription.id);
      const input = { workspaceId: f.workspaceId, subscription: source, items: [{ id: source.items[0]!.id, priceId: process.env.STRIPE_PRICE_CREATOR_MONTHLY!, quantity: 1 }], kind: "scheduled" as const, prorationDate: Math.floor(Date.now() / 1000), quoteId: randomUUID() };
      expect((await provider.applyPlanChange!(input)).kind).toBe("scheduled");
      const scheduled = await provider.retrievePlanChangeSubscription!(source.id);
      expect(scheduled.items[0]?.priceId).toBe(process.env.STRIPE_PRICE_PRO_MONTHLY);
      expect(scheduled.schedule?.items[0]?.priceId).toBe(process.env.STRIPE_PRICE_CREATOR_MONTHLY);
      await provider.cancelScheduledPlanChange!({ workspaceId: f.workspaceId, subscription: scheduled });
      expect((await provider.retrievePlanChangeSubscription!(source.id)).schedule).toBeNull();
      await provider.applyPlanChange!({ ...input, subscription: await provider.retrievePlanChangeSubscription!(source.id), quoteId: randomUUID() });
      await advanceClock(stripe, f.testClock!.id, source.periodEnd + 5);
      const advanced = await stripe.subscriptions.retrieve(source.id);
      expect(advanced.items.data[0]?.price.id).toBe(process.env.STRIPE_PRICE_CREATOR_MONTHLY);
      expect(advanced.status).toBe("active");
      await provider.finalizeCompletedPlanChangeSchedule!({ workspaceId: f.workspaceId, subscriptionId: source.id });
      expect((await stripe.subscriptions.retrieve(source.id)).schedule).toBeNull();
    } finally { await f.cleanup(); }
  });
});
