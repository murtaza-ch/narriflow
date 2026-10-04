import { describe, expect, test } from "bun:test";
import { OAuthErrorCode } from "@modelcontextprotocol/server";
import { createNarriflowTokenVerifier, McpAuthUnavailableError } from "./mcp-auth";

const resource = "https://app.narriflow.com/mcp";
const claims = {
  object: "clerk_idp_oauth_access_token", id: "oat_0123456789abcdef0123456789abcdef",
  client_id: "client_123", subject: "user_123", scopes: ["projects:read"], aud: [resource],
  revoked: false, revocation_reason: null, expired: false, expiration: 2_000_000_000,
  created_at: 1, updated_at: 1,
};
function verifier(body: unknown = claims, status = 200) {
  return createNarriflowTokenVerifier({
    resourceUrl: () => resource, secretKey: () => "test-secret", now: () => 1_900_000_000_000,
    fetch: async () => Response.json(body, { status, headers: { "Retry-After": "17" } }),
    findUser: async () => ({ id: "app-user" }), authenticateApiKey: async () => null,
  });
}

describe("online MCP credential verification", () => {
  test("uses verified audience and application scopes", async () => {
    const result = await verifier().verifyAccessToken("access-token");
    expect(result.scopes).toEqual(["projects:read"]);
    expect(result.extra?.narriflowPrincipal).toMatchObject({ userId: "app-user", kind: "oauth" });
  });
  for (const patch of [
    { aud: undefined }, { aud: ["https://another.example/mcp"] }, { revoked: true },
    { expired: true }, { expiration: 1_800_000_000 }, { expiration: null },
  ]) {
    test(`rejects inactive or incorrectly bound token ${JSON.stringify(patch)}`, async () => {
      await expect(verifier({ ...claims, ...patch }).verifyAccessToken("token"))
        .rejects.toMatchObject({ code: OAuthErrorCode.InvalidToken });
    });
  }
  test("rejects explicit inactive response", async () => {
    await expect(verifier({ active: false }).verifyAccessToken("token"))
      .rejects.toMatchObject({ code: OAuthErrorCode.InvalidToken });
  });
  test("malformed verification is an upstream availability failure", async () => {
    await expect(verifier({ ...claims, scopes: "projects:read" }).verifyAccessToken("token"))
      .rejects.toBeInstanceOf(McpAuthUnavailableError);
  });
  for (const status of [429, 500, 503]) {
    test(`upstream ${status} remains retryable`, async () => {
      await expect(verifier({}, status).verifyAccessToken("token"))
        .rejects.toMatchObject({ retryAfterSeconds: 17 });
    });
  }
  test("invalid token response remains an authentication failure", async () => {
    await expect(verifier({}, 400).verifyAccessToken("token"))
      .rejects.toMatchObject({ code: OAuthErrorCode.InvalidToken });
  });
  test("API keys are reverified rather than cached", async () => {
    let active = true;
    const checked = createNarriflowTokenVerifier({
      resourceUrl: () => resource, secretKey: () => "secret", findUser: async () => null,
      authenticateApiKey: async () => active ? {
        apiKeyId: "key", userId: "user", workspaceId: "workspace", scopes: ["projects:read"],
      } : null,
    });
    await expect(checked.verifyAccessToken("nf_secret")).resolves.toMatchObject({ scopes: ["projects:read"] });
    active = false;
    await expect(checked.verifyAccessToken("nf_secret")).rejects.toMatchObject({ code: OAuthErrorCode.InvalidToken });
  });
});
