import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ZoomError } from "@narriflow/services";
import { createZoomHttpRoutes } from "./zoom-http";

describe("Zoom HTTP boundary", () => {
  function fixture() {
    const received: unknown[] = [];
    const app = new Hono().route("/api", createZoomHttpRoutes({
      getActor: () => ({ actorUserId: "member", workspaceId: "workspace" } as never),
      getOrigin: () => "https://narriflow.test",
      zoom: {
        acceptWebhook: async (input) => { received.push(input); if (input.signature === "bad") throw new ZoomError("zoom_signature_invalid"); return { accepted: true }; },
        listConnections: async () => [], disconnect: async () => {},
        createAuthorizationUrl: async () => "https://zoom.us/oauth/authorize?state=opaque",
        handleCallback: async (scope, input) => { received.push({ scope, input }); },
      },
    }));
    return { app, received };
  }
  test("webhook verification receives the untouched body and headers", async () => {
    const { app, received } = fixture();
    const body = '{ "event": "recording.completed" }';
    const response = await app.request("/api/webhooks/zoom", { method: "POST", headers: { "x-zm-request-timestamp": "1658940994", "x-zm-signature": "signature" }, body });
    expect(response.status).toBe(200);
    expect(received).toEqual([{ rawBody: body, timestamp: "1658940994", signature: "signature" }]);
  });
  test("bad signatures fail with 401 and oversized requests never reach persistence", async () => {
    const { app, received } = fixture();
    const bad = await app.request("/api/webhooks/zoom", { method: "POST", headers: { "x-zm-signature": "bad" }, body: "{}" });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "zoom_signature_invalid" });
    const tooLarge = await app.request("/api/webhooks/zoom", { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
    expect(tooLarge.status).toBe(413);
    expect(received).toHaveLength(1);
  });
  test("OAuth callback uses the admitted actor and redirects only to Autopilot", async () => {
    const { app, received } = fixture();
    const response = await app.request("/api/zoom/oauth/callback?state=opaque&code=private-code&redirect=https://evil.test/");
    expect(received).toEqual([{ scope: { actorUserId: "member", workspaceId: "workspace" }, input: { state: "opaque", code: "private-code", origin: "https://narriflow.test" } }]);
    expect(response.headers.get("location")).toBe("https://narriflow.test/autopilot?zoom=connected");
    const denied = await app.request("/api/zoom/oauth/callback?error=arbitrary-private-provider-response");
    expect(denied.headers.get("location")).toBe("https://narriflow.test/autopilot?zoom=zoom_oauth_failed");
  });
});
