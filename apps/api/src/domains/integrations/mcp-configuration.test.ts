import { describe, expect, test } from "bun:test";
import { inspectMcpConfiguration } from "./mcp-configuration";

const base = { resourceUrl: "https://narriflow.test/mcp", issuerUrl: "https://issuer.clerk.test", hasVerificationSecret: true, hasConfirmationSecret: true };
function discovery(scopes: string[]) {
  return (async () => Response.json({ issuer: "https://issuer.clerk.test", authorization_endpoint: "https://issuer.clerk.test/oauth/authorize", token_endpoint: "https://issuer.clerk.test/oauth/token", code_challenge_methods_supported: ["S256"], scopes_supported: scopes })) as typeof fetch;
}
describe("MCP configuration status", () => {
  test("does not mark identity-only OAuth discovery as ready", async () => {
    const result = await inspectMcpConfiguration({ ...base, fetch: discovery(["openid", "profile", "email"]) });
    expect(result.label).toBe("OAuth scopes missing");
    expect(result.verified).toBe(false);
  });
  test("verifies application scopes while keeping client acceptance explicit", async () => {
    const result = await inspectMcpConfiguration({ ...base, fetch: discovery(["projects:read", "exports:read", "usage:read", "autopilot:read", "autopilot:write", "publishing:read", "publishing:write", "processing:write", "exports:write"]) });
    expect(result.label).toBe("Discovery verified");
    expect(result.description).toContain("verify resource binding");
  });
  test("reports discovery outages as unverified", async () => {
    const result = await inspectMcpConfiguration({ ...base, fetch: async () => new Response(null, { status: 503 }) });
    expect(result.label).toBe("Verification unavailable");
    expect(result.verified).toBe(false);
  });
});
