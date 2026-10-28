import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createMcpUploadHandoff, type NarriflowMcpPrincipal } from "@narriflow/mcp-core";
import { integrationUploadSessionKey, uploadSessionService, workspaceService, type WorkspaceActorContext } from "@narriflow/services";
import { loadApiConfig } from "../../config";
import { createIntegrationsRouteDeps, requireContinuationActor } from "./runtime";

const actorId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const keyId = "00000000-0000-4000-8000-000000000003";
const actor: WorkspaceActorContext = { actorUserId: actorId, workspaceId, workspaceName: "Signed Workspace", workspaceOwnerUserId: actorId, role: "owner", status: "active", pricingTier: "business", isPersonalWorkspace: false };
const principal: NarriflowMcpPrincipal = { kind: "api_key", apiKeyId: keyId, userId: actorId, workspaceId, clientId: `narriflow-api-key:${keyId}`, scopes: ["processing:write"] };
const config = loadApiConfig({ NODE_ENV: "test", API_ORIGIN: "https://api.test", WEB_ORIGIN: "https://web.test", CLERK_AUTHORIZED_PARTIES: "https://web.test", CLERK_SECRET_KEY: "inert", CLERK_PUBLISHABLE_KEY: "inert" });
const restores: Array<{ mockRestore(): void }> = [];
const previousSecret = process.env.MCP_CONTINUATION_SECRET;
afterEach(() => {
  for (const spy of restores.splice(0)) spy.mockRestore();
  if (previousSecret === undefined) delete process.env.MCP_CONTINUATION_SECRET;
  else process.env.MCP_CONTINUATION_SECRET = previousSecret;
});
function track<T extends { mockRestore(): void }>(spy: T) { restores.push(spy); return spy; }
function admitActor() {
  track(spyOn(workspaceService, "findActor").mockResolvedValue(actor));
  track(spyOn(workspaceService, "requireActor").mockResolvedValue(actor));
}
function expiredHandoff() {
  process.env.MCP_CONTINUATION_SECRET = "shared-test-continuation-secret-at-least-32-bytes";
  return createMcpUploadHandoff(principal, { workspaceId, clientIdempotencyKey: keyId }, { now: 0 }).token;
}

describe("MCP continuation runtime", () => {
  test("expired handoff resume goes through the service with the originating actor's stored key", async () => {
    admitActor();
    const lookup = track(spyOn(uploadSessionService, "hasOwnSessionByClientKey").mockResolvedValue(true));
    const token = expiredHandoff();
    const result = await createIntegrationsRouteDeps(config).uploadHandoff(actorId, token);
    expect(result).toMatchObject({ workspaceId, clientIdempotencyKey: keyId, resumeOnly: true, recipeName: null });
    expect(lookup).toHaveBeenCalledWith(actor, integrationUploadSessionKey(actorId, keyId));
    expect(result).not.toHaveProperty("oauthToken");
    expect(result).not.toHaveProperty("callerId");
    expect(JSON.stringify(result)).not.toContain(token);
  });
  test("expired handoff with no own session cannot become a fresh upload", async () => {
    admitActor();
    track(spyOn(uploadSessionService, "hasOwnSessionByClientKey").mockResolvedValue(false));
    await expect(createIntegrationsRouteDeps(config).uploadHandoff(actorId, expiredHandoff())).rejects.toMatchObject({ code: "mcp_upload_handoff_expired" });
  });
  test("the signed state rejects another actor before reading session ownership", async () => {
    const lookup = track(spyOn(uploadSessionService, "hasOwnSessionByClientKey").mockResolvedValue(true));
    await expect(createIntegrationsRouteDeps(config).uploadHandoff(keyId, expiredHandoff())).rejects.toMatchObject({ code: "mcp_upload_handoff_binding_mismatch" });
    expect(lookup).not.toHaveBeenCalled();
  });
  for (const [patch, reason] of [[{ role: "viewer" }, "role"], [{ pricingTier: "free" }, "plan"], [{ status: "past_due" }, "status"]] as const) {
    test(`current membership refusal preserves ${reason} recovery facts for the web UI`, async () => {
      track(spyOn(workspaceService, "findActor").mockResolvedValue({ ...actor, ...patch }));
      await expect(requireContinuationActor(actorId, workspaceId, "processing.consume")).rejects.toMatchObject({ code: "integration_access_unavailable", details: { reason, workspace: { workspaceId } } });
    });
  }
});
