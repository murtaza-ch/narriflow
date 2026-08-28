import { randomUUID } from "node:crypto";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import Stripe from "stripe";
import {
  BillingService,
  WORKSPACE_BILLING_STRIPE_API_VERSION,
} from "./billing.service";

const enabled = process.env.RUN_STRIPE_SANDBOX_CONTRACTS === "1";
const sandboxDescribe = enabled ? describe : describe.skip;
setDefaultTimeout(120_000);

sandboxDescribe("Workspace Billing Stripe sandbox", () => {
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
    const service = new BillingService();
    service.validateConfiguration({ surface: "web" });
    const adapter = service.stripeProviderAdapter();
    const workspaceId = randomUUID();
    const fixturePrefix = `narriflow_workspace_billing_contract_${randomUUID()}`;
    const customerKey = `${fixturePrefix}_customer`;
    const checkoutKey = `${fixturePrefix}_checkout`;
    let customerId: string | null = null;
    let checkoutSessionId: string | null = null;
    let subscriptionId: string | null = null;
    let seatItemId: string | null = null;

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
      const portal = await adapter.createPortalSession!({
        customerId,
        returnUrl: "https://app.narriflow.test/settings/billing",
      });
      expect(portal.url).toStartWith("https://billing.stripe.com/");

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
      expect(subscription.livemode).toBe(false);
      const current = await adapter.retrieveCurrentState(customerId);
      expect(current.ownership).toEqual({ kind: "verified", workspaceId });
      expect(current.subscriptions).toHaveLength(1);
      expect(current.subscriptions[0]).toMatchObject({
        status: "active",
        cancelAtPeriodEnd: false,
      });

      const seat = await adapter.createSeatItem!(
        {
          subscriptionId,
          priceId: seatPrice,
          quantity: 2,
          prorationBehavior: "create_prorations",
        },
        `${fixturePrefix}_seat_create`,
      );
      seatItemId = seat.itemId;
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
