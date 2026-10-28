import { Hono } from "hono";
import type { acceptTikTokPublicationWebhook, TikTokPublicationWebhookError } from "@narriflow/services";
import type { ApiEnv } from "../../http/env";

export interface PublishingWebhookDeps {
  acceptTikTokPublicationWebhook: typeof acceptTikTokPublicationWebhook;
  isTikTokWebhookError(error: unknown): error is TikTokPublicationWebhookError;
  /** TikTok app credentials, or null when the app is not configured. */
  tiktokCredentials(): { clientKey: string; clientSecret: string } | null;
}

/**
 * Provider-signature adapters of the publishing domain, mounted at `/api`
 * outside the first-party chain: no session, no CORS, original bytes preserved.
 */
export function createPublishingWebhookRoutes(deps: PublishingWebhookDeps) {
  return new Hono<ApiEnv>().post("/webhooks/tiktok/publication", async (c) => {
    const credentials = deps.tiktokCredentials();
    if (!credentials) {
      return c.json({ error: "tiktok_webhook_not_configured" }, 503);
    }
    const rawBody = await c.req.text();
    try {
      const result = await deps.acceptTikTokPublicationWebhook({
        rawBody,
        signature: c.req.header("TikTok-Signature") ?? null,
        clientKey: credentials.clientKey,
        clientSecret: credentials.clientSecret,
      });
      console.warn(
        JSON.stringify({
          level: "info",
          message: "social_publication_tiktok_webhook_accepted",
          outcome: result.kind,
        }),
      );
      return c.json(result, 200);
    } catch (error) {
      if (deps.isTikTokWebhookError(error)) {
        const status = error.code === "tiktok_webhook_payload_invalid" ? 400 : 401;
        return c.json({ error: error.code }, status);
      }
      console.warn(
        JSON.stringify({
          level: "error",
          message: "social_publication_tiktok_webhook_failed",
          errorCode: "tiktok_webhook_persistence_failed",
        }),
      );
      return c.json({ error: "tiktok_webhook_persistence_failed" }, 500);
    }
  });
}

export type PublishingWebhookRoutes = ReturnType<typeof createPublishingWebhookRoutes>;
