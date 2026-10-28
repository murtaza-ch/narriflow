import { Hono } from "hono";
import type { ApiEnv } from "../../http/env";

/** Dependencies of the Stripe webhook adapter. The billing owner replaces this with the billing service. */
export type BillingWebhookDeps = Record<string, never>;

/** Stripe delivery (`POST /api/webhooks/stripe`): signature-authenticated, outside the first-party chain. */
export function createBillingWebhookRoutes(_deps: BillingWebhookDeps) {
  return new Hono<ApiEnv>();
}

export type BillingWebhookRoutes = ReturnType<typeof createBillingWebhookRoutes>;
