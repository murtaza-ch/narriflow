import { describe, expect, test } from "bun:test";
import { createNarriflowTokenVerifier } from "@narriflow/mcp-core/auth";
import { createNarriflowMcpHttpHandler } from "@narriflow/mcp-core/http";
import { Hono } from "hono";
import { loadApiConfig } from "../../config";
import { createMcpAuth } from "./mcp-auth";
import { createMcpTransportRoutes } from "./mcp";

const apiOrigin = "https://api.narriflow.test";
const webOrigin = "https://app.narriflow.test";
const issuerUrl = "https://clerk.narriflow.test";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const config = loadApiConfig({ NODE_ENV: "test", API_ORIGIN: apiOrigin, WEB_ORIGIN: webOrigin, CLERK_AUTHORIZED_PARTIES: webOrigin, CLERK_SECRET_KEY: "inert", CLERK_PUBLISHABLE_KEY: "inert" });

function request(app: Hono, url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Host", new URL(url).host);
  return app.request(url, { ...init, headers });
}

function harness() {
  const auth = createMcpAuth(config, { CLERK_OAUTH_ISSUER: issuerUrl });
  let discoveryCalls = 0;
  let uploadCalls = 0;
  let authenticationCalls = 0;
  let now = 0;
  const mcp = createMcpTransportRoutes({
    ...auth, now: () => now,
    handleMcp: createNarriflowMcpHttpHandler({
      verifier: { verifyAccessToken: async () => { authenticationCalls++; throw new Error("Must not authenticate"); } },
      allowedHosts: () => auth.allowedHosts, allowedOrigins: () => auth.allowedOrigins, resourceMetadataUrl: () => auth.metadataUrl,
      checkRateLimit: async () => { throw new Error("Must not limit"); }, buildServer: () => { throw new Error("Must not build"); }, diagnostic: () => {},
    }),
    handleUpload: async (request) => { uploadCalls++; return Response.json({ action: new URL(request.url).pathname.split("/").at(-1) }); },
    fetch: async (_url, init) => { discoveryCalls++; expect(init).not.toHaveProperty("next"); return Response.json({ issuer: issuerUrl, authorization_endpoint: `${issuerUrl}/authorize` }); },
  });
  // Same mount order as createApiApp. The browser chain must not see MCP.
  const app = new Hono().route("/", mcp).use("*", (c) => c.json({ error: "browser_cors_rejected" }, 403));
  return { app, counts: () => ({ discoveryCalls, uploadCalls, authenticationCalls }), advance: () => { now += 3_600_001; } };
}

describe("API MCP transport", () => {
  test("non-production accepts each loopback host without widening the canonical resource", async () => {
    const auth = createMcpAuth(config, { CLERK_OAUTH_ISSUER: issuerUrl });
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) expect(auth.allowedHosts).toContain(host);
    expect(auth.resourceUrl).toBe(`${apiOrigin}/mcp`);
    const production = createMcpAuth({ ...config, nodeEnv: "production" }, { CLERK_OAUTH_ISSUER: issuerUrl });
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) expect(production.allowedHosts).not.toContain(host);
  });
  test("missing issuer refuses protected-resource discovery with public CORS", async () => {
    const auth = createMcpAuth(config, {});
    const app = createMcpTransportRoutes({ ...auth, handleMcp: async () => new Response(), handleUpload: async () => new Response() });
    const response = await request(app, `${apiOrigin}/.well-known/oauth-protected-resource`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "protected_resource_metadata_unavailable" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
  test("both protected-resource paths advertise exactly A/mcp and keep Clerk's issuer", async () => {
    const h = harness();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await request(h.app, `${apiOrigin}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ resource: `${apiOrigin}/mcp`, authorization_servers: [issuerUrl] });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
  });
  test("authorization discovery caches for an hour without rewriting its issuer", async () => {
    const h = harness();
    const url = `${apiOrigin}/.well-known/oauth-authorization-server`;
    expect(await (await request(h.app, url)).json()).toMatchObject({ issuer: issuerUrl });
    await request(h.app, url);
    expect(h.counts().discoveryCalls).toBe(1);
    h.advance();
    await request(h.app, url);
    expect(h.counts().discoveryCalls).toBe(2);
  });
  test("discovery outage is safe and carries public CORS", async () => {
    const auth = createMcpAuth(config, {});
    const app = createMcpTransportRoutes({ ...auth, handleMcp: async () => new Response(), handleUpload: async () => new Response() });
    const response = await request(app, `${apiOrigin}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(502);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
  for (const path of ["/mcp", `/mcp/integrations/${workspaceId}/upload-sessions/open`]) {
    test(`${path} rejects host and origin before credential checks`, async () => {
      const h = harness();
      expect((await request(h.app, `https://evil.test${path}`, { method: "POST" })).status).toBe(403);
      expect((await request(h.app, `${apiOrigin}${path}`, { method: "POST", headers: { Origin: "https://evil.test" } })).status).toBe(403);
      expect(h.counts()).toMatchObject({ authenticationCalls: 0, uploadCalls: 0 });
    });
  }
  test("MCP preflight handles the signed upload header before the browser chain", async () => {
    const h = harness();
    const response = await request(h.app, `${apiOrigin}/mcp/integrations/${workspaceId}/upload-sessions/open`, { method: "OPTIONS", headers: { Origin: webOrigin, "Access-Control-Request-Headers": "authorization,x-narriflow-upload-intent" } });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("X-Narriflow-Upload-Intent");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
  test("all five POST paths dispatch while chunked oversized bodies stop before admission", async () => {
    const h = harness();
    for (const action of ["open", "finalize", "grants", "status", "discard"]) {
      const response = await request(h.app, `${apiOrigin}/mcp/integrations/${workspaceId}/upload-sessions/${action}`, { method: "POST", body: "{}" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ action });
    }
    const response = await request(h.app, `${apiOrigin}/mcp/integrations/${workspaceId}/upload-sessions/open`, { method: "POST", body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1_048_577)); controller.close(); } }) });
    expect(response.status).toBe(413);
    expect(h.counts().uploadCalls).toBe(5);
  });
  test("an otherwise valid OAuth token for W/mcp is refused by the API transport", async () => {
    const auth = createMcpAuth(config, { CLERK_OAUTH_ISSUER: issuerUrl });
    const verifier = createNarriflowTokenVerifier({ resourceUrl: () => auth.resourceUrl, secretKey: () => "inert", authenticateApiKey: async () => null, findUser: async () => ({ id: "user" }),
      fetch: async () => Response.json({ object: "clerk_idp_oauth_access_token", id: "oat_test", subject: "user", client_id: "client", scopes: ["projects:read"], aud: [`${webOrigin}/mcp`], revoked: false, expired: false, revocation_reason: null, expiration: 2_000_000_000, created_at: 1, updated_at: 1 }),
    });
    const handle = createNarriflowMcpHttpHandler({ verifier, allowedHosts: () => auth.allowedHosts, allowedOrigins: () => auth.allowedOrigins, resourceMetadataUrl: () => auth.metadataUrl, diagnostic: () => {}, checkRateLimit: async () => { throw new Error("Must not limit"); }, buildServer: () => { throw new Error("Must not build"); } });
    const response = await handle(new Request(`${apiOrigin}/mcp`, { method: "POST", headers: { Host: new URL(apiOrigin).host, Authorization: "Bearer originating-token" }, body: "{}" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(auth.metadataUrl);
  });
});
