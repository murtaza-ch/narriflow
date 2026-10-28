import { ZoomError, type ZoomService } from "@narriflow/services";
import { createRouteApp } from "../../http/admission";
import { automationAdmission } from "./admission";

/** Dependencies of the Zoom webhook adapter. */
export interface AutomationWebhookDeps {
  zoomService: Pick<ZoomService, "acceptWebhook">;
}

/**
 * Zoom event delivery (`POST /api/webhooks/zoom`): signature-authenticated, outside the first-party
 * chain. The URL-validation challenge is answered from the signing secret alone, with no session
 * and no database; every other event is verified against the original bytes before it is stored.
 */
export function createAutomationWebhookRoutes(deps: AutomationWebhookDeps) {
  return createRouteApp(automationAdmission).post("/webhooks/zoom", async (c) => {
    try {
      const result = await deps.zoomService.acceptWebhook({
        rawBody: await c.req.text(),
        timestamp: c.req.header("x-zm-request-timestamp") ?? null,
        signature: c.req.header("x-zm-signature") ?? null,
      });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof ZoomError) {
        const status = error.code === "zoom_signature_invalid" ? 401 : error.code === "zoom_not_configured" ? 503 : 400;
        return c.json({ error: error.code }, status);
      }
      console.warn(JSON.stringify({ level: "error", message: "zoom_webhook_persistence_failed" }));
      return c.json({ error: "zoom_webhook_persistence_failed" }, 500);
    }
  });
}

export type AutomationWebhookRoutes = ReturnType<typeof createAutomationWebhookRoutes>;
