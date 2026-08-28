import { describe, expect, test } from "bun:test";
import Stripe from "stripe";
import {
  WORKSPACE_BILLING_STRIPE_API_VERSION,
} from "./billing.service";
import { WorkspaceBillingStripeContractHarness } from "./workspace-billing.stripe-test-support";
import { WORKSPACE_BILLING_WAKE_EVENT_TYPES } from "./workspace-billing.service";

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
  test("verifies the exact raw body under the pinned API version", async () => {
    const rawBody = `${fixture("checkout.session.completed")}\n`;
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload: rawBody,
      secret: webhookSecret,
      timestamp: signatureTimestamp,
    });
    const service = new WorkspaceBillingStripeContractHarness();

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
    ).rejects.toThrow("signature verification failed");
  });

  test("normalizes every registered delivery fixture without reading entitlement state", async () => {
    const service = new WorkspaceBillingStripeContractHarness();
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
