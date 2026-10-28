import { billingService } from "@narriflow/services";
import type { ApiConfig } from "../../config";
import type { BillingRouteDeps } from "./routes";
import type { BillingWebhookDeps } from "./webhooks";

/** Production wiring of the billing routes. */
export function createBillingRouteDeps(config: ApiConfig): BillingRouteDeps {
  return { billingService, webOrigin: config.webOrigin };
}

/** Production wiring of the Stripe webhook adapter. */
export function createBillingWebhookDeps(): BillingWebhookDeps {
  return {
    acceptDelivery: (rawBody, signature) => billingService.handleWebhook(rawBody, signature),
  };
}
