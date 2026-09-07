import { Hono } from "hono";

export interface StripeWebhookHttpDependencies {
  acceptDelivery(
    rawBody: string,
    signature: string,
  ): Promise<{
    received: true;
    disposition: "accepted" | "duplicate" | "ignored";
  }>;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

/**
 * Owns only Stripe's HTTP delivery contract. Signature verification and every
 * billing decision stay behind the injected Workspace Billing interface.
 */
export function createStripeWebhookHttpRoutes(
  dependencies: StripeWebhookHttpDependencies,
) {
  const routes = new Hono();

  routes.post("/webhooks/stripe", async (c) => {
    const signature = c.req.header("stripe-signature")?.trim();
    if (!signature) {
      return c.json({ error: "missing_signature" }, 400);
    }

    const rawBody = await c.req.text();
    try {
      const result = await dependencies.acceptDelivery(rawBody, signature);
      return c.json(result, 200);
    } catch (error) {
      if (errorCode(error) === "invalid_signature") {
        return c.json({ error: "invalid_signature" }, 400);
      }
      return c.json({ error: "delivery_acceptance_failed" }, 500);
    }
  });

  return routes;
}
