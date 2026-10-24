import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZoomError, ZOOM_WEBHOOK_MAX_BYTES, type ZoomService } from "@narriflow/services";
import type { BrowserActorScope } from "@/lib/authenticated-request-policy.server";
import type { Context } from "hono";

export function createZoomHttpRoutes(deps: {
  zoom: Pick<ZoomService, "acceptWebhook" | "createAuthorizationUrl" | "handleCallback" | "listConnections" | "disconnect">;
  getActor(c: Context): BrowserActorScope;
  getOrigin(url: string): string;
}) {
  const app = new Hono();
  app.post("/webhooks/zoom", bodyLimit({ maxSize: ZOOM_WEBHOOK_MAX_BYTES, onError: (c) => c.json({ error: "zoom_payload_invalid" }, 413) }), async (c) => {
    try {
      const result = await deps.zoom.acceptWebhook({ rawBody: await c.req.text(), timestamp: c.req.header("x-zm-request-timestamp") ?? null, signature: c.req.header("x-zm-signature") ?? null });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof ZoomError) return c.json({ error: error.code }, error.code === "zoom_signature_invalid" ? 401 : error.code === "zoom_not_configured" ? 503 : 400);
      console.warn(JSON.stringify({ level: "error", message: "zoom_webhook_persistence_failed" }));
      return c.json({ error: "zoom_webhook_persistence_failed" }, 500);
    }
  });
  app.get("/zoom/connections", async (c) => c.json({ connections: await deps.zoom.listConnections(deps.getActor(c)) }));
  app.delete("/zoom/connections/:connectionId", async (c) => {
    await deps.zoom.disconnect(deps.getActor(c), c.req.param("connectionId"));
    return c.json({ disconnected: true });
  });
  app.get("/zoom/oauth/start", async (c) => c.redirect(await deps.zoom.createAuthorizationUrl(deps.getActor(c), deps.getOrigin(c.req.url)), 302));
  app.get("/zoom/oauth/callback", async (c) => {
    const origin = deps.getOrigin(c.req.url);
    const redirect = new URL("/autopilot", origin);
    try {
      const state = c.req.query("state"), code = c.req.query("code");
      if (!state || !code || c.req.query("error")) throw new ZoomError("zoom_oauth_failed");
      await deps.zoom.handleCallback(deps.getActor(c), { state, code, origin });
      redirect.searchParams.set("zoom", "connected");
    } catch (error) {
      redirect.searchParams.set("zoom", error instanceof ZoomError ? error.code : "zoom_oauth_failed");
    }
    return c.redirect(redirect.href, 302);
  });
  return app;
}
