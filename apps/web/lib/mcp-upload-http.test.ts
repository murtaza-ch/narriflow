import { describe, expect, test } from "bun:test";
import { ExpectedDomainFailureError, type ActorScope, type UploadSessionService } from "@narriflow/services";
import { buildMcpContentPack } from "@narriflow/validators";
import { createMcpUploadHttpHandler } from "./mcp-upload-http";
import { mcpIntegrationAuthenticationFailure, mcpIntegrationMutationGuard } from "./mcp-integration-admission";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";

const workspaceId = "b6558e07-d826-46a2-a919-4c9a4e7c4c62";
const input = { clientIdempotencyKey: "6d27d010-f52c-4e5c-9ea3-012c0bf7d921", title: "Video", source: { fileName: "video.mp4", sizeBytes: 12, contentType: "video/mp4", browserFingerprint: "exact-file" }, generationContext: { contentPack: buildMcpContentPack(), languageCode: null } };
const actor = { actorUserId: "actor", workspaceId } as ActorScope;
const unavailable = () => { throw new ExpectedDomainFailureError({ code: "mcp_mutations_unavailable", kind: "unavailable", message: "New mutations are paused" }); };
function fixture(existing: boolean) {
  let opens = 0;
  const service = {
    async open() { opens++; return { outcome: "queued_for_ingest", sessionId: "session", projectId: "project", queuedJobId: "job" }; },
    async status() {
      if (!existing) throw new ExpectedDomainFailureError({ code: "upload_session_not_found", kind: "missing", message: "Upload not found" });
      return { outcome: "queued_for_ingest", sessionId: "session", projectId: "project", queuedJobId: "job" };
    },
  } as unknown as UploadSessionService;
  return { count: () => opens, handler: createMcpUploadHttpHandler({ service, admit: async () => ({ actor, beforeAccept: unavailable }), authenticationFailure: () => null }) };
}
function request() { return new Request(`https://narriflow.test/mcp/integrations/${workspaceId}/upload-sessions/open`, { method: "POST", body: JSON.stringify(input), headers: { "Content-Type": "application/json" } }); }
describe("authenticated integration uploads", () => {
  test("retains the authenticated request budget for every transfer action", async () => {
    let calls = 0;
    const handler = createMcpUploadHttpHandler({
      service: { open: async () => { calls++; }, status: async () => { calls++; }, grant: async () => { calls++; }, finalize: async () => { calls++; }, discard: async () => { calls++; } } as unknown as UploadSessionService,
      admit: async () => ({ actor, beforeAccept: mcpIntegrationMutationGuard({ allowed: false, availability: "available", remaining: 0, limit: 300 }) }),
      authenticationFailure: (error) => mcpIntegrationAuthenticationFailure(error, "https://narriflow.test/.well-known/oauth-protected-resource/mcp"),
    });
    for (const action of ["open", "status", "grants", "finalize", "discard"]) {
      const response = await handler(new Request(`https://narriflow.test/mcp/integrations/${workspaceId}/upload-sessions/${action}`, { method: "POST", body: "{}" }), workspaceId);
      expect(response.status).toBe(429);
      expect((await response.json()).error).toBe("mcp_request_limit_exceeded");
      expect(response.headers.get("Retry-After")).toBe("60");
    }
    expect(calls).toBe(0);
  });
  test("reserves OAuth challenges for authentication failures and preserves domain admission failures", async () => {
    const handler = createMcpUploadHttpHandler({
      service: {} as UploadSessionService,
      admit: async () => { throw new ExpectedDomainFailureError({ code: "mcp_scope_required", kind: "forbidden", message: "Explicit processing consent is required" }); },
      authenticationFailure: (error) => mcpIntegrationAuthenticationFailure(error, "https://narriflow.test/.well-known/oauth-protected-resource/mcp"),
    });
    const response = await handler(request(), workspaceId);
    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain('scope="processing:write"');
    expect(mcpIntegrationAuthenticationFailure(new OAuthError(OAuthErrorCode.InvalidToken, "Revoked"), "https://narriflow.test/metadata")?.status).toBe(401);
  });
  test("pauses a new intake when the limiter is unavailable", async () => {
    const { handler, count } = fixture(false);
    const response = await handler(request(), workspaceId);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("mcp_mutations_unavailable");
    expect(count()).toBe(0);
  });
  test("replays an already accepted intake during a limiter outage", async () => {
    const { handler, count } = fixture(true);
    const response = await handler(request(), workspaceId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "queued_for_ingest", queuedJobId: "job" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(count()).toBe(1);
  });
});
