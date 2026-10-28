import { describe, expect, test } from "bun:test";
import { createBillingTestApp } from "./test-support";
import { createBillingRoutes } from "./routes";
import { createRequestPolicyRuntime } from "../../http/request-policy-runtime";
import { createBillingWebhookRoutes } from "./webhooks";

/** `mount` is `/api` in the composed app and empty on the bare adapter. */
function request(body: string, signature?: string, mount = "") {
  return new Request(`http://localhost:4000${mount}/webhooks/stripe`, {
    method: "POST",
    body,
    headers: signature ? { "stripe-signature": signature } : undefined,
  });
}

describe("Stripe webhook adapter", () => {
  test("hands the exact bytes to the verifier and acknowledges new and duplicate deliveries", async () => {
    const seen: string[] = [];
    let calls = 0;
    const app = createBillingWebhookRoutes({
      acceptDelivery: async (rawBody, signature) => {
        seen.push(`${signature}:${rawBody}`);
        calls += 1;
        return { received: true, disposition: calls === 1 ? "accepted" : "duplicate" };
      },
    });
    // Whitespace, key order and a trailing newline must reach the signature check untouched.
    const rawBody = '{"b":  1,\n "a": "é"}\n';

    const accepted = await app.request(request(rawBody, "sig_exact"));
    const duplicate = await app.request(request(rawBody, " sig_exact "));

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ received: true, disposition: "accepted" });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ received: true, disposition: "duplicate" });
    expect(seen).toEqual([`sig_exact:${rawBody}`, `sig_exact:${rawBody}`]);
  });

  test("rejects missing and invalid signatures with stable client codes", async () => {
    let calls = 0;
    const app = createBillingWebhookRoutes({
      acceptDelivery: async () => {
        calls += 1;
        throw Object.assign(new Error("provider detail"), { code: "invalid_signature" });
      },
    });

    const missing = await app.request(request("{}"));
    const invalid = await app.request(request("{}", "sig_invalid"));

    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "missing_signature" });
    // Only the delivery that carried a signature reached the verifier.
    expect(calls).toBe(1);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_signature" });
  });

  test("a durable acceptance failure is a retryable 500 that hides the cause", async () => {
    const app = createBillingWebhookRoutes({
      acceptDelivery: async () => {
        throw new Error("database unavailable at 10.0.0.5");
      },
    });
    const response = await app.request(request("{}", "sig_valid"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "delivery_acceptance_failed" });
  });
});

describe("Stripe webhook mounting", () => {
  test("the composition answers Stripe without a session, ahead of the first-party chain", async () => {
    const seen: string[] = [];
    const policyRuntime = createRequestPolicyRuntime({
      authenticate: async () => ({ status: "unauthenticated", reason: "missing_credential" }),
      loadAppUser: async () => {
        throw new Error("a webhook never loads a user");
      },
      resolveScopedWorkspace: async () => null,
      staffAllowlist: new Set(),
      policy: {
        resolveProject: async () => ({ kind: "inaccessible" }) as never,
        rateLimit: async () => ({ allowed: true }),
        now: Date.now,
      },
    });
    const app = createBillingTestApp({
      policyRuntime,
      routes: createBillingRoutes({ billingService: {} as never, webOrigin: "http://localhost:3000" }),
      webhook: createBillingWebhookRoutes({
        acceptDelivery: async (rawBody, signature) => {
          seen.push(`${signature}:${rawBody}`);
          return { received: true, disposition: "accepted" };
        },
      }),
    });
    // No Bearer and no Workspace: only the signature decides, never a 401 from the session policy.
    const missing = await app.request(request("{}", undefined, "/api"));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "missing_signature" });

    const raw = '{"id":"evt_1",  "x":1}';
    const accepted = await app.request(request(raw, "t=1,v1=abc", "/api"));
    expect(accepted.status).toBe(200);
    expect(seen).toEqual([`t=1,v1=abc:${raw}`]);
  });
});
