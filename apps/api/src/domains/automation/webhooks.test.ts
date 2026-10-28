import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { ZoomError, ZoomService } from "@narriflow/services";
import { Hono } from "hono";
import { createAutomationWebhookRoutes } from "./webhooks";

const SECRET = "zoom-webhook-secret";
const config = { clientId: "client", clientSecret: "secret", webhookSecret: SECRET, encryptionKey: "key" };

function appWith(zoomService: { acceptWebhook: ZoomService["acceptWebhook"] }) {
  // No session and no first-party middleware: the adapter stands on its signature alone.
  return new Hono().route("/api", createAutomationWebhookRoutes({ zoomService }));
}

describe("Zoom webhook", () => {
  test("receives the untouched body and headers", async () => {
    const received: unknown[] = [];
    const app = appWith({ acceptWebhook: async (input) => { received.push(input); return { accepted: true }; } });
    const body = '{ "event": "recording.completed" }';
    const response = await app.request("/api/webhooks/zoom", {
      method: "POST",
      headers: { "x-zm-request-timestamp": "1658940994", "x-zm-signature": "signature" },
      body,
    });
    expect(response.status).toBe(200);
    expect(received).toEqual([{ rawBody: body, timestamp: "1658940994", signature: "signature" }]);
  });

  test("a bad signature is a 401, an unconfigured Zoom a 503, a bad payload a 400, a storage failure a generic 500", async () => {
    const failing = (error: unknown) => appWith({ acceptWebhook: async () => { throw error; } });
    const post = (app: Hono) => app.request("/api/webhooks/zoom", { method: "POST", body: "{}" });
    const signature = await post(failing(new ZoomError("zoom_signature_invalid")));
    expect(signature.status).toBe(401);
    expect(await signature.json()).toEqual({ error: "zoom_signature_invalid" });
    expect((await post(failing(new ZoomError("zoom_not_configured")))).status).toBe(503);
    expect((await post(failing(new ZoomError("zoom_payload_invalid")))).status).toBe(400);
    const stored = await post(failing(new Error("connection string leaked")));
    expect(stored.status).toBe(500);
    expect(await stored.json()).toEqual({ error: "zoom_webhook_persistence_failed" });
  });

  test("the URL-validation challenge is answered from the secret alone, without a session or database", async () => {
    const app = appWith(new ZoomService({ config: () => config }));
    const plainToken = "qgg8vlvZRS6UYooatFL8Aw";
    const response = await app.request("/api/webhooks/zoom", {
      method: "POST",
      body: JSON.stringify({ event: "endpoint.url_validation", payload: { plainToken } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      plainToken,
      encryptedToken: createHmac("sha256", SECRET).update(plainToken).digest("hex"),
    });
  });

  test("an unsigned event never reaches storage", async () => {
    const app = appWith(new ZoomService({ config: () => config }));
    const response = await app.request("/api/webhooks/zoom", { method: "POST", body: JSON.stringify({ event: "recording.completed" }) });
    expect(response.status).toBe(401);
  });
});
