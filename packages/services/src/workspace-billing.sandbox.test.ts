import { randomUUID } from "node:crypto";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import Stripe from "stripe";
import {
  BUSINESS_ADDITIONAL_SEAT_PRICE_CENTS,
  PLAN_CATALOG,
} from "@narriflow/validators";
import {
  WORKSPACE_BILLING_STRIPE_API_VERSION,
} from "./billing.service";
import { createWorkspaceBillingStripeContractHarness } from "./workspace-billing.stripe-test-support";
import { BILLING_INTERVALS, PAID_PRICING_TIERS } from "./workspace-billing.service";

const enabled = process.env.RUN_STRIPE_SANDBOX_CONTRACTS === "1";
const sandboxDescribe = enabled ? describe : describe.skip;
setDefaultTimeout(120_000);

sandboxDescribe("Workspace Billing Stripe sandbox", () => {
  test("configured prices and portal match the plan catalog (read-only)", async () => {
    const key = process.env.STRIPE_SECRET_KEY ?? "";
    if (!key.startsWith("sk_test_")) {
      throw new Error("Workspace Billing sandbox contracts require an sk_test_ key");
    }
    const stripe = new Stripe(key, {
      apiVersion: WORKSPACE_BILLING_STRIPE_API_VERSION,
      maxNetworkRetries: 0,
      timeout: 10_000,
    });
    const stripeInterval = { monthly: "month", annual: "year" } as const;
    const planProducts = new Set<string>();
    for (const tier of PAID_PRICING_TIERS) {
      for (const interval of BILLING_INTERVALS) {
        const priceId =
          process.env[`STRIPE_PRICE_${tier.toUpperCase()}_${interval.toUpperCase()}`];
        if (!priceId) throw new Error(`Missing ${tier}/${interval} price`);
        const price = await stripe.prices.retrieve(priceId);
        expect({
          active: price.active,
          currency: price.currency,
          unitAmount: price.unit_amount,
          interval: price.recurring?.interval,
          usageType: price.recurring?.usage_type,
        }).toEqual({
          active: true,
          currency: "usd",
          unitAmount:
            interval === "monthly"
              ? PLAN_CATALOG[tier].monthlyPriceCents
              : PLAN_CATALOG[tier].annualPriceCents,
          interval: stripeInterval[interval],
          usageType: "licensed",
        });
        planProducts.add(typeof price.product === "string" ? price.product : price.product.id);
      }
    }
    // One plans product, so the portal can schedule every downgrade.
    expect(planProducts.size).toBe(1);
    for (const interval of BILLING_INTERVALS) {
      const priceId = process.env[`STRIPE_PRICE_BUSINESS_SEAT_${interval.toUpperCase()}`];
      if (!priceId) throw new Error(`Missing seat/${interval} price`);
      const price = await stripe.prices.retrieve(priceId);
      expect(price.unit_amount).toBe(BUSINESS_ADDITIONAL_SEAT_PRICE_CENTS[interval]);
      expect(price.recurring?.interval).toBe(stripeInterval[interval]);
      expect(planProducts.has(
        typeof price.product === "string" ? price.product : price.product.id,
      )).toBe(false);
    }

    const portalId = process.env.STRIPE_PORTAL_CONFIGURATION_ID;
    if (!portalId?.startsWith("bpc_")) {
      throw new Error("STRIPE_PORTAL_CONFIGURATION_ID is required");
    }
    const portal = await stripe.billingPortal.configurations.retrieve(portalId);
    const update = portal.features.subscription_update;
    expect(portal.active).toBe(true);
    expect(update.enabled).toBe(true);
    expect(update.proration_behavior).toBe("always_invoice");
    expect(update.default_allowed_updates).not.toContain("quantity");
    expect(
      update.schedule_at_period_end.conditions.map((condition) => condition.type).sort(),
    ).toEqual(["decreasing_item_amount", "shortening_interval"]);
    expect((update.products ?? []).map((product) => product.product)).toEqual([
      ...planProducts,
    ]);
    expect(portal.features.subscription_cancel.mode).toBe("at_period_end");
  });

  test("replays customer and Checkout operations and exercises portal and seat contracts", async () => {
    const key = process.env.STRIPE_SECRET_KEY ?? "";
    if (!key.startsWith("sk_test_")) {
      throw new Error("Workspace Billing sandbox contracts require an sk_test_ key");
    }
    const portalConfiguration = process.env.STRIPE_PORTAL_CONFIGURATION_ID;
    if (!portalConfiguration?.startsWith("bpc_")) {
      throw new Error("STRIPE_PORTAL_CONFIGURATION_ID is required");
    }
    const basePrice = process.env.STRIPE_PRICE_BUSINESS_MONTHLY;
    const checkoutPrice = process.env.STRIPE_PRICE_CREATOR_MONTHLY;
    const seatPrice = process.env.STRIPE_PRICE_BUSINESS_SEAT_MONTHLY;
    if (!basePrice || !checkoutPrice || !seatPrice) {
      throw new Error("The monthly Workspace Billing catalog is required");
    }

    const stripe = new Stripe(key, {
      apiVersion: WORKSPACE_BILLING_STRIPE_API_VERSION,
      maxNetworkRetries: 0,
      timeout: 10_000,
    });
    const service = createWorkspaceBillingStripeContractHarness();
    const adapter = service.provider("web");
    const workspaceId = randomUUID();
    const fixturePrefix = `narriflow_workspace_billing_contract_${randomUUID()}`;
    const customerKey = `${fixturePrefix}_customer`;
    const checkoutKey = `${fixturePrefix}_checkout`;
    let customerId: string | null = null;
    let checkoutSessionId: string | null = null;
    let subscriptionId: string | null = null;
    let seatItemId: string | null = null;
    const transientCustomerIds: string[] = [];

    try {
      const firstCustomer = await adapter.createCustomer!(
        { workspaceId, actorUserId: fixturePrefix },
        customerKey,
      );
      const replayedCustomer = await adapter.createCustomer!(
        { workspaceId, actorUserId: fixturePrefix },
        customerKey,
      );
      customerId = firstCustomer.customerId;
      expect(replayedCustomer).toEqual(firstCustomer);
      let recoveredCustomers: Array<{ customerId: string }> = [];
      for (let attempt = 0; attempt < 40 && recoveredCustomers.length === 0; attempt += 1) {
        recoveredCustomers = await adapter.findCustomersByWorkspace!(workspaceId);
        if (recoveredCustomers.length === 0) {
          await Bun.sleep(500);
        }
      }
      expect(recoveredCustomers).toEqual([firstCustomer]);

      const checkoutInput = {
        attemptId: randomUUID(),
        workspaceId,
        actorUserId: fixturePrefix,
        customerId,
        priceId: checkoutPrice,
        successUrl: "https://app.narriflow.test/settings/billing?checkout=return",
        cancelUrl: "https://app.narriflow.test/settings/billing?checkout=cancelled",
        expiresAt: new Date(Math.floor(Date.now() / 1000) * 1000 + 31 * 60_000),
      };
      const firstCheckout = await adapter.createCheckoutSession!(
        checkoutInput,
        checkoutKey,
      );
      const replayedCheckout = await adapter.createCheckoutSession!(
        checkoutInput,
        checkoutKey,
      );
      checkoutSessionId = firstCheckout.sessionId;
      expect(replayedCheckout.sessionId).toBe(firstCheckout.sessionId);
      expect(firstCheckout).toMatchObject({
        status: "open",
        paymentStatus: "unpaid",
        workspaceId,
        attemptId: checkoutInput.attemptId,
        expiresAt: checkoutInput.expiresAt,
      });
      expect(
        await adapter.findCheckoutSessionsByAttempt!({
          attemptId: checkoutInput.attemptId,
          customerId,
        }),
      ).toHaveLength(1);
      await stripe.checkout.sessions.expire(checkoutSessionId);
      expect(
        await adapter.retrieveCheckoutSession!(checkoutSessionId),
      ).toMatchObject({ status: "expired", paymentStatus: "unpaid" });

      const portalConfig = await stripe.billingPortal.configurations.retrieve(
        portalConfiguration,
        { expand: ["features.subscription_update.products"] },
      );
      expect(portalConfig).toMatchObject({
        active: true,
        features: {
          payment_method_update: { enabled: true },
          subscription_cancel: { enabled: true, mode: "at_period_end" },
          subscription_update: {
            enabled: true,
            default_allowed_updates: ["price"],
            proration_behavior: "create_prorations",
          },
        },
      });
      const expectedPortalPrices = [
        process.env.STRIPE_PRICE_CREATOR_MONTHLY,
        process.env.STRIPE_PRICE_CREATOR_ANNUAL,
        process.env.STRIPE_PRICE_PRO_MONTHLY,
        process.env.STRIPE_PRICE_PRO_ANNUAL,
        process.env.STRIPE_PRICE_BUSINESS_MONTHLY,
        process.env.STRIPE_PRICE_BUSINESS_ANNUAL,
      ].filter((price): price is string => Boolean(price)).sort();
      const portalProducts = portalConfig.features.subscription_update.products;
      expect(portalProducts).toBeDefined();
      expect(portalProducts?.flatMap((product) => product.prices).sort())
        .toEqual(expectedPortalPrices);
      expect(expectedPortalPrices).not.toContain(seatPrice);
      const portal = await adapter.createPortalSession!({
        customerId,
        returnUrl: "https://app.narriflow.test/settings/billing",
      });
      expect(portal.url).toStartWith("https://billing.stripe.com/");

      const annualPrice = process.env.STRIPE_PRICE_CREATOR_ANNUAL;
      if (!annualPrice) throw new Error("The annual Creator price is required");
      const trialCustomer = await stripe.customers.create({
        metadata: { workspaceId, fixturePrefix },
      });
      transientCustomerIds.push(trialCustomer.id);
      await stripe.subscriptions.create({
        customer: trialCustomer.id,
        items: [{ price: annualPrice, quantity: 1 }],
        trial_period_days: 1,
        metadata: { workspaceId, fixturePrefix },
      });
      expect(
        (await adapter.retrieveCurrentState(trialCustomer.id)).subscriptions[0],
      ).toMatchObject({
        status: "trialing",
        items: [expect.objectContaining({ priceId: annualPrice })],
      });

      const incompleteCustomer = await stripe.customers.create({
        metadata: { workspaceId, fixturePrefix },
      });
      transientCustomerIds.push(incompleteCustomer.id);
      await stripe.subscriptions.create({
        customer: incompleteCustomer.id,
        items: [{ price: checkoutPrice, quantity: 1 }],
        payment_behavior: "default_incomplete",
        metadata: { workspaceId, fixturePrefix },
      });
      expect(
        (await adapter.retrieveCurrentState(incompleteCustomer.id)).subscriptions[0],
      ).toMatchObject({ status: "incomplete" });

      const paymentMethod = await stripe.paymentMethods.create({
        type: "card",
        card: { token: "tok_visa" },
      });
      await stripe.paymentMethods.attach(paymentMethod.id, { customer: customerId });
      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: basePrice, quantity: 1 }],
        metadata: { workspaceId, fixturePrefix },
        default_payment_method: paymentMethod.id,
        payment_behavior: "error_if_incomplete",
      });
      subscriptionId = subscription.id;
      const baseItemId = subscription.items.data[0]?.id;
      const annualBusinessPrice = process.env.STRIPE_PRICE_BUSINESS_ANNUAL;
      if (!baseItemId || !annualBusinessPrice) {
        throw new Error("The annual Business portal contract is required");
      }
      expect(subscription.livemode).toBe(false);
      const current = await adapter.retrieveCurrentState(customerId);
      expect(current.ownership).toEqual({ kind: "verified", workspaceId });
      expect(current.subscriptions).toHaveLength(1);
      expect(current.subscriptions[0]).toMatchObject({
        status: "active",
        cancelAtPeriodEnd: false,
      });
      await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
      });
      expect(
        (await adapter.retrieveCurrentState(customerId)).subscriptions[0],
      ).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
      await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: false,
      });
      await stripe.subscriptionItems.update(baseItemId, {
        price: annualBusinessPrice,
        proration_behavior: "create_prorations",
      });
      expect(
        (await adapter.retrieveCurrentState(customerId)).subscriptions[0]?.items,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ priceId: annualBusinessPrice, quantity: 1 }),
        ]),
      );
      await stripe.subscriptionItems.update(baseItemId, {
        price: basePrice,
        proration_behavior: "create_prorations",
      });

      const seatOperationKey = `${fixturePrefix}_seat_create`;
      const seat = await adapter.createSeatItem!(
        {
          subscriptionId,
          priceId: seatPrice,
          quantity: 2,
          prorationBehavior: "create_prorations",
        },
        seatOperationKey,
      );
      seatItemId = seat.itemId;
      expect(
        await adapter.createSeatItem!(
          {
            subscriptionId,
            priceId: seatPrice,
            quantity: 2,
            prorationBehavior: "create_prorations",
          },
          seatOperationKey,
        ),
      ).toEqual(seat);
      await adapter.updateSeatItem!(
        {
          itemId: seatItemId,
          quantity: 3,
          prorationBehavior: "create_prorations",
        },
        `${fixturePrefix}_seat_update`,
      );
      expect(
        (await adapter.retrieveCurrentState(customerId)).subscriptions[0]?.items,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ priceId: seatPrice, quantity: 3 }),
        ]),
      );
      await adapter.deleteSeatItem!(
        { itemId: seatItemId, prorationBehavior: "create_prorations" },
        `${fixturePrefix}_seat_delete`,
      );
      seatItemId = null;
      expect(
        (await adapter.retrieveCurrentState(customerId)).subscriptions[0]?.items,
      ).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ priceId: seatPrice })]),
      );
    } finally {
      for (const transientCustomerId of transientCustomerIds) {
        await stripe.customers.del(transientCustomerId).catch(() => undefined);
      }
      if (seatItemId) {
        await stripe.subscriptionItems.del(seatItemId).catch(() => undefined);
      }
      if (subscriptionId) {
        await stripe.subscriptions.cancel(subscriptionId).catch(() => undefined);
      }
      if (checkoutSessionId) {
        const session = await stripe.checkout.sessions
          .retrieve(checkoutSessionId)
          .catch(() => null);
        if (session?.status === "open") {
          await stripe.checkout.sessions.expire(checkoutSessionId).catch(() => undefined);
        }
      }
      if (customerId) {
        await stripe.customers.del(customerId).catch(() => undefined);
      }
    }
  });
});
