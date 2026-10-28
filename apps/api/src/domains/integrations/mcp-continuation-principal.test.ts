import { describe, expect, test } from "bun:test";
import { admitMcpContinuation } from "./mcp-continuation-principal";
import { createMcpConfirmation, createMcpUploadHandoff, verifyMcpPreparation, verifyMcpUploadHandoff } from "@narriflow/mcp-core";
import { createNarriflowTokenVerifier, principalFromMcpAuth } from "@narriflow/mcp-core/auth";

const userId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const keyId = "00000000-0000-4000-8000-000000000003";
const oauth = (scopes: string[]) => ({ callerId: `oauth:client:${userId}`, actorUserId: userId, workspaceId, principalKind: "oauth" as const, scopes });
const apiKey = (scopes: string[]) => ({ callerId: `api_key:${keyId}:${userId}`, actorUserId: userId, workspaceId, principalKind: "api_key" as const, scopes });
const activeKey = (scopes: string[]) => async () => ({ createdByUserId: userId, userId, scopes });

async function withOAuthContinuations(run: (h: {
  claims: { revoked: boolean; expired: boolean; scopes: string[]; client_id: string; aud: string[] };
  upstream: { status: number };
  upload: ReturnType<typeof verifyMcpUploadHandoff>;
  publication: ReturnType<typeof verifyMcpPreparation>;
  recheck: (token: string) => Promise<ReturnType<typeof principalFromMcpAuth>>;
}) => Promise<void>) {
  const previous = process.env.MCP_CONTINUATION_SECRET;
  process.env.MCP_CONTINUATION_SECRET = "a-test-continuation-secret-of-at-least-32-bytes";
  try {
    const claims = { revoked: false, expired: false, scopes: ["processing:write", "publishing:write"], client_id: "client", aud: ["https://app.narriflow.test/mcp"] };
    const upstream = { status: 200 };
    const verifier = createNarriflowTokenVerifier({
      resourceUrl: () => "https://app.narriflow.test/mcp", secretKey: () => "test-secret",
      authenticateApiKey: async () => null, findUser: async () => ({ id: userId }),
      fetch: async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ access_token: "originating-oauth-token" });
        return Response.json({ object: "clerk_idp_oauth_access_token", id: "oat_test", subject: "clerk-user", ...claims, revocation_reason: null,
          expiration: Date.now() / 1000 + 3600, created_at: 1, updated_at: 1 }, { status: upstream.status });
      },
    });
    const principal = principalFromMcpAuth(await verifier.verifyAccessToken("originating-oauth-token"));
    const upload = verifyMcpUploadHandoff(createMcpUploadHandoff(principal, { workspaceId, clientIdempotencyKey: keyId }).token);
    const publication = verifyMcpPreparation(createMcpConfirmation(principal, {
      workspaceId, clientIdempotencyKey: keyId, projectId: workspaceId, clipId: keyId, accountId: keyId,
      clipExportId: keyId, clipExportVariantId: keyId, expectedEditorRevision: 0, platform: "youtube_shorts", aspectRatio: "9:16",
      resolution: "1080p", caption: "Caption", scheduledFor: "2026-12-01T12:00:00.000Z", providerSettings: {},
    }).token);
    const recheck = async (token: string) => principalFromMcpAuth(await verifier.verifyAccessToken(token));
    await run({ claims, upstream, upload, publication, recheck });
  } finally {
    if (previous === undefined) delete process.env.MCP_CONTINUATION_SECRET;
    else process.env.MCP_CONTINUATION_SECRET = previous;
  }
}

describe("signed continuation admission", () => {
  test("OAuth upload and publication continuations recheck the originating token before admitting a write", async () => {
    await withOAuthContinuations(async ({ claims, upload, publication, recheck }) => {
      await expect(admitMcpContinuation(upload, "processing:write", undefined, recheck)).resolves.toMatchObject({ kind: "oauth" });
      await expect(admitMcpContinuation(publication, "publishing:write", undefined, recheck)).resolves.toMatchObject({ kind: "oauth" });
      claims.revoked = true;
      await expect(admitMcpContinuation(upload, "processing:write", undefined, recheck)).rejects.toMatchObject({ code: "mcp_continuation_revoked" });
      await expect(admitMcpContinuation(publication, "publishing:write", undefined, recheck)).rejects.toMatchObject({ code: "mcp_continuation_revoked" });
    });
  });
  test("OAuth continuations use the intersection of the signed and current scopes", async () => {
    await withOAuthContinuations(async ({ claims, upload, publication, recheck }) => {
      claims.scopes = ["processing:write", "exports:write"];
      await expect(admitMcpContinuation(upload, "processing:write", undefined, recheck)).resolves.toMatchObject({ scopes: ["processing:write"] });
      await expect(admitMcpContinuation(publication, "publishing:write", undefined, recheck)).rejects.toMatchObject({ code: "scope_required" });
      claims.scopes = ["publishing:write"];
      await expect(admitMcpContinuation(upload, "processing:write", undefined, recheck)).rejects.toMatchObject({ code: "scope_required" });
    });
  });
  test("expired, wrongly bound, and unverifiable OAuth credentials cannot continue", async () => {
    await withOAuthContinuations(async ({ claims, upstream, upload, recheck }) => {
      upstream.status = 503;
      await expect(admitMcpContinuation(upload, "processing:write", undefined, recheck)).rejects.toMatchObject({ code: "mcp_continuation_unavailable", kind: "unavailable" });
      upstream.status = 200;
      claims.expired = true;
      await expect(admitMcpContinuation(upload, "processing:write", undefined, recheck)).rejects.toMatchObject({ code: "mcp_continuation_revoked" });
      claims.expired = false;
      claims.client_id = "different-client";
      await expect(admitMcpContinuation(upload, "processing:write", undefined, recheck)).rejects.toMatchObject({ code: "mcp_continuation_revoked" });
      claims.client_id = "client";
      claims.aud = ["https://another.test/mcp"];
      await expect(admitMcpContinuation(upload, "processing:write", undefined, recheck)).rejects.toMatchObject({ code: "mcp_continuation_revoked" });
    });
  });
  test("an OAuth continuation signed with read scopes only is refused for writes", async () => {
    await expect(admitMcpContinuation(oauth(["projects:read"]), "publishing:write")).rejects.toMatchObject({ code: "scope_required" });
    await expect(admitMcpContinuation(oauth(["projects:read"]), "processing:write")).rejects.toMatchObject({ code: "scope_required" });
    await expect(admitMcpContinuation(oauth(["projects:read", "publishing:write"]), "publishing:write")).rejects.toThrow();
  });
  test("an API-key continuation needs the signed scope, an active key, and the key's current grant", async () => {
    await expect(admitMcpContinuation(apiKey(["projects:read"]), "processing:write", activeKey(["processing:write"]))).rejects.toMatchObject({ code: "scope_required" });
    await expect(admitMcpContinuation(apiKey(["processing:write"]), "processing:write", async () => null)).rejects.toMatchObject({ code: "mcp_continuation_revoked" });
    await expect(admitMcpContinuation(apiKey(["processing:write"]), "processing:write", async () => ({ createdByUserId: "someone-else", userId, scopes: ["processing:write"] }))).rejects.toMatchObject({ code: "mcp_continuation_revoked" });
    await expect(admitMcpContinuation(apiKey(["processing:write"]), "processing:write", activeKey(["projects:read"]))).rejects.toMatchObject({ code: "scope_required" });
    await expect(admitMcpContinuation(apiKey(["processing:write", "projects:read"]), "processing:write", activeKey(["processing:write", "exports:read"]))).resolves.toMatchObject({ kind: "api_key", apiKeyId: keyId, scopes: ["processing:write"] });
  });
  test("caller identity must match the signed credential kind", async () => {
    await expect(admitMcpContinuation({ ...oauth(["publishing:write"]), principalKind: "api_key" }, "publishing:write", activeKey(["publishing:write"]))).rejects.toThrow("Invalid signed caller identity");
  });
});
