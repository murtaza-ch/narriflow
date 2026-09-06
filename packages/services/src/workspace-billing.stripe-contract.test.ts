import { describe, expect, test } from "bun:test";
import Stripe from "stripe";
import {
  WORKSPACE_BILLING_STRIPE_API_VERSION,
} from "./billing.service";
import { createWorkspaceBillingStripeContractHarness } from "./workspace-billing.stripe-test-support";
import {
  createBillingCatalog,
  WORKSPACE_BILLING_WAKE_EVENT_TYPES,
} from "./workspace-billing.service";

const webhookSecret = "whsec_workspace_billing_contract_fixture";
const stripe = new Stripe("sk_test_workspace_billing_contract_fixture", {
  apiVersion: WORKSPACE_BILLING_STRIPE_API_VERSION,
  maxNetworkRetries: 0,
});
const signatureTimestamp = Math.floor(Date.now() / 1_000);

function fixture(type: (typeof WORKSPACE_BILLING_WAKE_EVENT_TYPES)[number]) {
  const object = type.startsWith("checkout.session")
    ? {
        id: "cs_contract",
        customer: "cus_contract",
        status: "complete",
        payment_status:
          type === "checkout.session.async_payment_failed" ? "unpaid" : "paid",
        client_reference_id: "11111111-1111-4111-8111-111111111111",
        metadata: { workspaceId: "11111111-1111-4111-8111-111111111111" },
      }
    : type.startsWith("customer.subscription")
      ? {
          id: "sub_contract",
          customer: "cus_contract",
          metadata: { workspaceId: "11111111-1111-4111-8111-111111111111" },
        }
      : type.startsWith("invoice.")
        ? {
            id: "in_contract",
            customer: "cus_contract",
            parent: {
              subscription_details: { subscription: "sub_contract" },
            },
            metadata: {},
          }
        : {
            id: "cus_contract",
            metadata: { workspaceId: "11111111-1111-4111-8111-111111111111" },
          };
  return JSON.stringify({
    id: `evt_${type.replaceAll(".", "_")}`,
    object: "event",
    api_version: WORKSPACE_BILLING_STRIPE_API_VERSION,
    created: 1_787_900_000,
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
  });
}

describe("Workspace Billing Stripe adapter contracts", () => {
  test("paginates the complete subscription collection and normalizes every status", async () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const statuses = [
      "incomplete",
      "incomplete_expired",
      "trialing",
      "active",
      "past_due",
      "canceled",
      "unpaid",
      "paused",
    ] as const;
    const subscriptions = statuses.map((status, index) => ({
      id: `sub_${status}`,
      status,
      metadata: { workspaceId },
      items: {
        data: [
          {
            id: `si_${index}`,
            current_period_start: 1_787_900_000,
            current_period_end: 1_790_492_800,
            price: { id: "price_creator_monthly" },
            quantity: 1,
          },
        ],
      },
      latest_invoice: null,
      created: 1_787_900_000,
      trial_start: status === "trialing" ? 1_787_900_000 : null,
      trial_end: status === "trialing" ? 1_788_000_000 : null,
      ended_at: status === "canceled" ? 1_788_000_000 : null,
      canceled_at: status === "canceled" ? 1_788_000_000 : null,
      cancel_at_period_end: false,
    }));
    let pages = 0;
    const fakeStripe = {
      customers: {
        retrieve: async () => ({
          id: "cus_contract",
          deleted: false,
          metadata: { workspaceId },
        }),
      },
      subscriptions: {
        list: async (input: { starting_after?: string }) => {
          pages += 1;
          return input.starting_after
            ? { data: subscriptions.slice(4), has_more: false }
            : { data: subscriptions.slice(0, 4), has_more: true };
        },
      },
    } as unknown as Stripe;
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
    const adapter = createWorkspaceBillingStripeContractHarness().providerWith({
      stripe: fakeStripe,
      catalog,
    });

    const current = await adapter.retrieveCurrentState("cus_contract");

    expect(pages).toBe(2);
    expect(current.ownership).toEqual({ kind: "verified", workspaceId });
    expect(current.subscriptions.map((subscription) => subscription.status))
      .toEqual(statuses);
  });

  test("normalizes a completed delayed-payment Checkout through the production adapter", async () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const attemptId = "22222222-2222-4222-8222-222222222222";
    const fakeStripe = {
      checkout: {
        sessions: {
          retrieve: async () => ({
            id: "cs_delayed_contract",
            url: null,
            expires_at: 1_788_000_000,
            status: "complete",
            payment_status: "unpaid",
            client_reference_id: workspaceId,
            metadata: { workspaceId, attemptId },
          }),
        },
      },
    } as unknown as Stripe;
    const adapter = createWorkspaceBillingStripeContractHarness().providerWith({
      stripe: fakeStripe,
      catalog: createBillingCatalog({
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
      }),
    });

    expect(await adapter.retrieveCheckoutSession!("cs_delayed_contract"))
      .toEqual({
        sessionId: "cs_delayed_contract",
        url: null,
        expiresAt: new Date(1_788_000_000 * 1000),
        status: "complete",
        paymentStatus: "unpaid",
        workspaceId,
        attemptId,
      });
  });

  test("resolves delayed Checkout failure from the current invoice payment", async () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const fakeStripe = {
      checkout: {
        sessions: {
          retrieve: async () => ({
            id: "cs_failed_contract",
            url: null,
            expires_at: 1_788_000_000,
            status: "complete",
            payment_status: "unpaid",
            invoice: "in_failed_contract",
            client_reference_id: workspaceId,
            metadata: { workspaceId },
          }),
        },
      },
      invoicePayments: {
        list: async () => ({
          data: [
            {
              id: "inpay_failed_contract",
              status: "open",
              payment: {
                type: "payment_intent",
                payment_intent: {
                  id: "pi_failed_contract",
                  status: "requires_payment_method",
                },
              },
            },
          ],
          has_more: false,
        }),
      },
    } as unknown as Stripe;
    const adapter = createWorkspaceBillingStripeContractHarness().providerWith({
      stripe: fakeStripe,
      catalog: createBillingCatalog({
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
      }),
    });

    expect(await adapter.retrieveCheckoutSession!("cs_failed_contract"))
      .toMatchObject({
        sessionId: "cs_failed_contract",
        status: "complete",
        paymentStatus: "failed",
        workspaceId,
      });
  });

  test("verifies the exact raw body under the pinned API version", async () => {
    const rawBody = `${fixture("checkout.session.completed")}\n`;
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload: rawBody,
      secret: webhookSecret,
      timestamp: signatureTimestamp,
    });
    const service = createWorkspaceBillingStripeContractHarness();

    expect(
      await service.verifyDelivery(rawBody, signature, {
        stripe,
        webhookSecret,
      }),
    ).toMatchObject({
      eventType: "checkout.session.completed",
      liveMode: false,
      apiVersion: WORKSPACE_BILLING_STRIPE_API_VERSION,
      customerId: "cus_contract",
      checkoutSessionId: "cs_contract",
      workspaceHint: "11111111-1111-4111-8111-111111111111",
    });
    await expect(
      service.verifyDelivery(`${rawBody} `, signature, {
        stripe,
        webhookSecret,
      }),
    ).rejects.toThrow("The billing signature is invalid");
  });

  test("normalizes every registered delivery fixture without reading entitlement state", async () => {
    const service = createWorkspaceBillingStripeContractHarness();
    for (const type of WORKSPACE_BILLING_WAKE_EVENT_TYPES) {
      const rawBody = fixture(type);
      const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
        payload: rawBody,
        secret: webhookSecret,
        timestamp: signatureTimestamp,
      });
      const delivery = await service.verifyDelivery(rawBody, signature, {
        stripe,
        webhookSecret,
      });
      expect(delivery.eventType).toBe(type);
      expect(delivery.liveMode).toBe(false);
      expect(delivery.apiVersion).toBe(WORKSPACE_BILLING_STRIPE_API_VERSION);
      expect(delivery.customerId).toBe("cus_contract");
      expect(delivery.subscriptionId).toBe(
        type.startsWith("customer.subscription") || type.startsWith("invoice.")
          ? "sub_contract"
          : null,
      );
    }
  });
});
