import { describe, expect, test } from "bun:test";
import { admitMcpContinuation } from "./mcp-continuation-principal";

const userId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const keyId = "00000000-0000-4000-8000-000000000003";
const oauth = (scopes: string[]) => ({ callerId: `oauth:client:${userId}`, actorUserId: userId, workspaceId, principalKind: "oauth" as const, scopes });
const apiKey = (scopes: string[]) => ({ callerId: `api_key:${keyId}:${userId}`, actorUserId: userId, workspaceId, principalKind: "api_key" as const, scopes });
const activeKey = (scopes: string[]) => async () => ({ createdByUserId: userId, userId, scopes });

describe("signed continuation admission", () => {
  test("an OAuth continuation signed with read scopes only is refused for writes", async () => {
    await expect(admitMcpContinuation(oauth(["projects:read"]), "publishing:write")).rejects.toMatchObject({ code: "scope_required" });
    await expect(admitMcpContinuation(oauth(["projects:read"]), "processing:write")).rejects.toMatchObject({ code: "scope_required" });
    await expect(admitMcpContinuation(oauth(["projects:read", "publishing:write"]), "publishing:write")).resolves.toMatchObject({ kind: "oauth", clientId: "client", scopes: ["projects:read", "publishing:write"] });
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
