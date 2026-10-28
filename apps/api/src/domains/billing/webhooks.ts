import { createRouteApp } from "../../http/admission";
import { billingAdmission } from "./admission";

export interface BillingWebhookDeps {
  /**
   * Verifies the Stripe signature over the original bytes and durably accepts
   * the delivery; every billing decision stays behind this interface.
   */
  acceptDelivery(
    rawBody: string,
    signature: string,
  ): Promise<{ received: true; disposition: "accepted" | "duplicate" | "ignored" }>;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

/**
 * Stripe delivery (`POST /api/webhooks/stripe`): signature-authenticated, outside
 * the first-party chain. It reads the body once as text so the signed bytes
 * reach the verifier unchanged, and answers a duplicate delivery with success so
 * Stripe stops retrying.
 */
export function createBillingWebhookRoutes(deps: BillingWebhookDeps) {
  return createRouteApp(billingAdmission).post("/webhooks/stripe", async (c) => {
    const signature = c.req.header("stripe-signature")?.trim();
    if (!signature) return c.json({ error: "missing_signature" }, 400);

    const rawBody = await c.req.text();
    try {
      return c.json(await deps.acceptDelivery(rawBody, signature), 200);
    } catch (error) {
      if (errorCode(error) === "invalid_signature") {
        return c.json({ error: "invalid_signature" }, 400);
      }
      console.warn(
        JSON.stringify({
          level: "error",
          message: "stripe_delivery_acceptance_failed",
          errorCode: errorCode(error) ?? "unknown",
        }),
      );
      return c.json({ error: "delivery_acceptance_failed" }, 500);
    }
  });
}

export type BillingWebhookRoutes = ReturnType<typeof createBillingWebhookRoutes>;
