import { billingService, BillingError } from "@narriflow/services";

// Stripe signature verification needs the raw, unparsed request body — a
// dedicated route handler (not the Hono catch-all) gives us `req.text()` raw.
export const runtime = "nodejs";

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return json({ error: "missing_signature" }, 400);
  }

  const rawBody = await req.text();

  try {
    const result = await billingService.handleWebhook(rawBody, signature);
    return json(result, 200);
  } catch (error) {
    // A bad signature is the client's fault (400); anything else is a 500 so
    // Stripe retries the delivery.
    const status =
      error instanceof BillingError && error.code === "invalid_signature"
        ? 400
        : 500;
    const message = error instanceof Error ? error.message : "webhook_error";
    return json({ error: message }, status);
  }
}
