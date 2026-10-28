import { describe, expect, test } from "bun:test";
import { createMcpUploadHandoff, verifyMcpUploadHandoff, MCP_CONTINUATION_TTL_MS, type NarriflowMcpPrincipal } from "@narriflow/mcp-core";
import { buildGenerationContentPack, buildGenerationContext, generationSettingsSchema } from "@narriflow/validators";
import type { ActorScope } from "@narriflow/services";
import { admitMcpUploadHandoff, type McpUploadHandoffDependencies } from "./mcp-upload-handoff";

const secret = "a-shared-secret-of-at-least-32-bytes-long";
const userId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const key = "00000000-0000-4000-8000-000000000003";
const sessionId = "00000000-0000-4000-8000-000000000004";
const brandProfileId = "00000000-0000-4000-8000-000000000005";
const assistant: NarriflowMcpPrincipal = { kind: "oauth", userId, clientId: "assistant", scopes: ["processing:write"], oauthAccessToken: "test-oauth-access-token" };
const actor = { actorUserId: userId, workspaceId } as ActorScope;

function harness(now: number, overrides: Partial<McpUploadHandoffDependencies> = {}) {
  const calls: string[] = [];
  const deps: McpUploadHandoffDependencies = {
    verify: (token, options) => verifyMcpUploadHandoff(token, { ...options, secret, now }),
    admitContinuation: async () => { calls.push("assistant"); return assistant; },
    requireToolWorkspace: async () => actor,
    requireOwnerActor: async () => { calls.push("owner"); return actor; },
    findOwnedSession: async (input) => input.sessionId === sessionId && input.userId === userId && input.clientIdempotencyKey === key,
    principalGuard: async () => () => {},
    ownerGuard: async () => () => {},
    ...overrides,
  };
  return { deps, calls };
}
const token = createMcpUploadHandoff(assistant, { workspaceId, clientIdempotencyKey: key, brandProfileId }, { secret, now: 0 }).token;
function request(action: string, body: unknown) {
  return new Request(`https://narriflow.test/mcp/integrations/${workspaceId}/upload-sessions/${action}`, { method: "POST", body: JSON.stringify(body) });
}
const opening = { clientIdempotencyKey: key, title: "talk.mp4", brandProfileId, brandTemplateId: null,
  source: { fileName: "talk.mp4", sizeBytes: 1_000_000, contentType: "video/mp4", browserFingerprint: "f".repeat(64) },
  generationContext: { contentPack: buildGenerationContentPack(), languageCode: null } };
const admit = (action: string, body: unknown, h: ReturnType<typeof harness>) => admitMcpUploadHandoff(request(action, body), { workspaceId, token, userId }, h.deps);

describe("assistant upload handoff authority", () => {
  test("an unexpired handoff opens under the assistant's signed grant", async () => {
    const h = harness(1);
    await expect(admit("open", opening, h)).resolves.toMatchObject({ authority: "assistant" });
    expect(h.calls).toEqual(["assistant"]);
  });
  test("a new open is refused after expiry or revocation", async () => {
    await expect(admit("open", opening, harness(MCP_CONTINUATION_TTL_MS))).rejects.toMatchObject({ code: "mcp_upload_handoff_expired" });
    const revoked = harness(1, { admitContinuation: async () => { throw Object.assign(new Error("revoked"), { code: "mcp_continuation_revoked" }); } });
    await expect(admit("open", opening, revoked)).rejects.toMatchObject({ code: "mcp_continuation_revoked" });
  });
  test("open settings must match the signed intent, including the Brand Profile", async () => {
    await expect(admit("open", { ...opening, brandProfileId: null }, harness(1))).rejects.toMatchObject({ code: "mcp_upload_handoff_conflict" });
    await expect(admit("open", { ...opening, brandTemplateId: brandProfileId }, harness(1))).rejects.toMatchObject({ code: "mcp_upload_handoff_conflict" });
    // An omitted profile stays omitted so admission applies the Workspace default.
    const unbranded = createMcpUploadHandoff(assistant, { workspaceId, clientIdempotencyKey: key }, { secret, now: 0 }).token;
    const { brandProfileId: _chosen, ...omitted } = opening;
    const h = harness(1);
    await expect(admitMcpUploadHandoff(request("open", omitted), { workspaceId, token: unbranded, userId }, h.deps)).resolves.toMatchObject({ authority: "assistant" });
    await expect(admitMcpUploadHandoff(request("open", { ...omitted, brandProfileId: null }), { workspaceId, token: unbranded, userId }, h.deps)).rejects.toMatchObject({ code: "mcp_upload_handoff_conflict" });
  });
  test("a handoff that names a Recipe opens with the Recipe alone, which admission reads once", async () => {
    const recipeId = "00000000-0000-4000-8000-0000000000e1";
    const recipeToken = createMcpUploadHandoff(assistant, { workspaceId, clientIdempotencyKey: key, recipeId }, { secret, now: 0 }).token;
    const open = (body: unknown, h = harness(1)) => admitMcpUploadHandoff(request("open", body), { workspaceId, token: recipeToken, userId }, h.deps);
    const { generationContext: _settings, brandProfileId: _profile, brandTemplateId: _template, ...bare } = opening;
    const named = { ...bare, recipeId };
    // The credential is handed on, so admission can check the Recipe's finishing against its scopes.
    await expect(open(named)).resolves.toMatchObject({ authority: "assistant", credential: assistant });
    // Explicit settings, another Recipe, or none at all are not what the person approved.
    await expect(open({ ...named, recipeId: "00000000-0000-4000-8000-0000000000e2" })).rejects.toMatchObject({ code: "mcp_upload_handoff_conflict" });
    await expect(open({ ...named, recipeId: undefined })).rejects.toMatchObject({ code: "mcp_upload_request_invalid" });
    await expect(open({ ...named, generationContext: opening.generationContext })).rejects.toMatchObject({ code: "mcp_upload_request_invalid" });
    // An explicit-settings handoff refuses an opening that swaps in a Recipe.
    await expect(admit("open", named, harness(1))).rejects.toMatchObject({ code: "mcp_upload_handoff_conflict" });
  });
  test("finishing the assistant asked for is signed into the handoff and must reach the Upload Session unchanged", async () => {
    const finishing = { topClips: 3, copyPlatforms: ["tiktok" as const] };
    const finishingToken = createMcpUploadHandoff(assistant, { workspaceId, clientIdempotencyKey: key, brandProfileId, finishing }, { secret, now: 0 }).token;
    const open = (body: unknown) => admitMcpUploadHandoff(request("open", body), { workspaceId, token: finishingToken, userId }, harness(1).deps);
    const frozen = buildGenerationContext(generationSettingsSchema.parse({}), finishing);
    await expect(open({ ...opening, generationContext: frozen })).resolves.toMatchObject({ authority: "assistant" });
    // Dropping or changing it is a different intent than the one the person approved.
    await expect(open(opening)).rejects.toMatchObject({ code: "mcp_upload_handoff_conflict" });
    await expect(open({ ...opening, generationContext: buildGenerationContext(generationSettingsSchema.parse({}), { topClips: 9 }) })).rejects.toMatchObject({ code: "mcp_upload_handoff_conflict" });
    // And a handoff without finishing refuses an opening that adds it.
    await expect(admit("open", { ...opening, generationContext: frozen }, harness(1))).rejects.toMatchObject({ code: "mcp_upload_handoff_conflict" });
  });
  for (const action of ["grants", "finalize", "discard"]) {
    test(`${action} after expiry or revocation runs only under the signed-in person's own authority`, async () => {
      const h = harness(MCP_CONTINUATION_TTL_MS * 10, { admitContinuation: async () => { throw new Error("assistant credential must not be consulted"); } });
      await expect(admit(action, { sessionId }, h)).resolves.toMatchObject({ authority: "owner", actor });
      expect(h.calls).toEqual(["owner"]);
      await expect(admit(action, { sessionId: "00000000-0000-4000-8000-000000000099" }, h)).rejects.toMatchObject({ code: "mcp_upload_handoff_binding_mismatch" });
    });
  }
  test("the person's current membership and plan access still decide continuation", async () => {
    const removed = harness(1, { requireOwnerActor: async () => { throw Object.assign(new Error("removed"), { code: "workspace_access_denied" }); } });
    await expect(admit("grants", { sessionId }, removed)).rejects.toMatchObject({ code: "workspace_access_denied" });
    await expect(admit("status", { clientIdempotencyKey: key }, removed)).rejects.toMatchObject({ code: "workspace_access_denied" });
  });
  test("status is bound to the handoff's own request key", async () => {
    await expect(admit("status", { clientIdempotencyKey: sessionId }, harness(1))).rejects.toMatchObject({ code: "mcp_upload_handoff_binding_mismatch" });
    await expect(admit("status", { clientIdempotencyKey: key }, harness(MCP_CONTINUATION_TTL_MS * 10))).resolves.toMatchObject({ authority: "owner" });
  });
});
