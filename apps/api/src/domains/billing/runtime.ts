import type { ApiConfig } from "../../config";
import type { BillingWebhookDeps } from "./webhooks";
import type { BillingRouteDeps } from "./routes";

/** Production wiring of the billing routes. */
export function createBillingRouteDeps(_config: ApiConfig): BillingRouteDeps {
  return {};
}

/** Production wiring of the Stripe webhook adapter. */
export function createBillingWebhookDeps(): BillingWebhookDeps {
  return {};
}
