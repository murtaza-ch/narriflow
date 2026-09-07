import { describe, expect, test } from "bun:test";
import { createStripeWebhookHttpRoutes } from "./stripe-webhook-http";

function request(body: string, signature?: string) {
  return new Request("http://localhost/webhooks/stripe", {
    method: "POST",
    body,
    headers: signature ? { "stripe-signature": signature } : undefined,
  });
}

describe("Stripe webhook HTTP boundary", () => {
  test("preserves the exact body and returns success for new and duplicate deliveries", async () => {
    const bodies: string[] = [];
    let calls = 0;
    const app = createStripeWebhookHttpRoutes({
      acceptDelivery: async (rawBody, signature) => {
        bodies.push(`${signature}:${rawBody}`);
        calls += 1;
        return {
          received: true,
          disposition: calls === 1 ? "accepted" : "duplicate",
        };
      },
    });
    const rawBody = '{"untouched": true}\n';

    const accepted = await app.request(request(rawBody, "sig_exact"));
    const duplicate = await app.request(request(rawBody, "sig_exact"));

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      received: true,
      disposition: "accepted",
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({
      received: true,
      disposition: "duplicate",
    });
    expect(bodies).toEqual([
      `sig_exact:${rawBody}`,
      `sig_exact:${rawBody}`,
    ]);
  });

  test("rejects missing and invalid signatures with stable client codes", async () => {
    const app = createStripeWebhookHttpRoutes({
      acceptDelivery: async () => {
        throw Object.assign(new Error("provider detail"), {
          code: "invalid_signature",
        });
      },
    });

    const missing = await app.request(request("{}"));
    const invalid = await app.request(request("{}", "sig_invalid"));

    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "missing_signature" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_signature" });
  });

  test("returns a server error when durable acceptance fails", async () => {
    const app = createStripeWebhookHttpRoutes({
      acceptDelivery: async () => {
        throw new Error("database unavailable");
      },
    });

    const response = await app.request(request("{}", "sig_valid"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "delivery_acceptance_failed",
    });
  });
});
