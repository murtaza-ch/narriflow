import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { acceptTikTokPublicationWebhook, TikTokPublicationWebhookError } from "@narriflow/services";
import { Hono } from "hono";
import { createPublishingWebhookRoutes, type PublishingWebhookDeps } from "./webhooks";

const SECRET = "tiktok-client-secret";
const credentials = { clientKey: "client-key", clientSecret: SECRET };

function signed(rawBody: string, at = Math.floor(Date.now() / 1000), secret = SECRET) {
  const digest = createHmac("sha256", secret).update(`${at}.${rawBody}`).digest("hex");
  return `t=${at},s=${digest}`;
}

function appWith(overrides: Partial<PublishingWebhookDeps> = {}) {
  const deps: PublishingWebhookDeps = {
    acceptTikTokPublicationWebhook,
    isTikTokWebhookError: (error): error is TikTokPublicationWebhookError =>
      error instanceof TikTokPublicationWebhookError,
    tiktokCredentials: () => credentials,
    ...overrides,
  };
  // No session, no first-party middleware: the adapter stands on its signature alone.
  return new Hono().route("/api", createPublishingWebhookRoutes(deps));
}

const post = (app: Hono, body: string, signature: string | null) =>
  app.request("/api/webhooks/tiktok/publication", {
    method: "POST",
    headers: { "content-type": "application/json", ...(signature ? { "tiktok-signature": signature } : {}) },
    body,
  });

describe("TikTok publication webhook", () => {
  test("refuses with 503 while TikTok is not configured", async () => {
    const response = await post(appWith({ tiktokCredentials: () => null }), "{}", signed("{}"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "tiktok_webhook_not_configured" });
  });

  test("a missing, malformed, wrong-secret or stale signature is a 401 that never reaches the database", async () => {
    const body = JSON.stringify({ event: "post.publish.complete" });
    const stale = Math.floor(Date.now() / 1000) - 3_600;
    for (const signature of [null, "garbage", signed(body, undefined, "another-secret"), signed(body, stale)]) {
      const response = await post(appWith(), body, signature);
      expect(response.status).toBe(401);
      expect((await response.json()).error).toStartWith("tiktok_webhook_signature_");
    }
  });

  test("the signature covers the original bytes, so a re-serialised body no longer verifies", async () => {
    const original = '{"a":1,  "b":2}';
    const signature = signed(original);
    const reserialised = JSON.stringify(JSON.parse(original));
    expect((await post(appWith(), reserialised, signature)).status).toBe(401);
  });

  test("hands the exact raw body, header and credentials to the service", async () => {
    const seen: unknown[] = [];
    const body = '{ "spaced":   true }';
    const signature = signed(body);
    const app = appWith({
      acceptTikTokPublicationWebhook: (async (input: unknown) => {
        seen.push(input);
        return { kind: "settled" };
      }) as never,
    });
    const response = await post(app, body, signature);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "settled" });
    expect(seen).toEqual([{ rawBody: body, signature, ...credentials }]);
  });

  test("a verified but invalid payload is a 400", async () => {
    const body = "not json";
    const response = await post(appWith(), body, signed(body));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("tiktok_webhook_payload_invalid");
  });

  test("a persistence failure is a 500 that exposes no detail so TikTok retries", async () => {
    const app = appWith({
      acceptTikTokPublicationWebhook: (async () => {
        throw new Error("connection to db-host:5432 refused");
      }) as never,
    });
    const response = await post(app, "{}", signed("{}"));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe(JSON.stringify({ error: "tiktok_webhook_persistence_failed" }));
  });

  test("answers only POST", async () => {
    const response = await appWith().request("/api/webhooks/tiktok/publication");
    expect(response.status).toBe(404);
  });
});
