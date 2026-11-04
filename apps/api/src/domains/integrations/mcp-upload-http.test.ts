import { describe, expect, spyOn, test } from "bun:test";
import { ExpectedDomainFailureError } from "@narriflow/services/expected-domain-failure";
import { integrationUploadSessionKey, integrationUploadSessions } from "@narriflow/services/integration-commands";
import { type ActorScope } from "@narriflow/services/actor-scope";
import { type UploadSessionService } from "@narriflow/services/upload-session.service";
import { buildGenerationContentPack } from "@narriflow/validators";
import { createMcpUploadHttpHandler } from "./mcp-upload-http";
import { mcpIntegrationAuthenticationFailure, mcpIntegrationMutationGuard } from "./mcp-integration-admission";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";

const workspaceId = "b6558e07-d826-46a2-a919-4c9a4e7c4c62";
const input = { clientIdempotencyKey: "6d27d010-f52c-4e5c-9ea3-012c0bf7d921", title: "Video", source: { fileName: "video.mp4", sizeBytes: 12, contentType: "video/mp4", browserFingerprint: "exact-file" }, generationContext: { contentPack: buildGenerationContentPack(), languageCode: null } };
const actor = { actorUserId: "actor", workspaceId } as ActorScope;
const unavailable = () => { throw new ExpectedDomainFailureError({ code: "mutations_unavailable", kind: "unavailable", message: "New mutations are paused" }); };
function fixture(existing: boolean) {
  let opens = 0;
  const service = {
    async open(_actor: ActorScope, opening: { clientIdempotencyKey: string }) {
      // Integration callers name sessions by their own key; the session stores the per-user derivation.
      expect(opening.clientIdempotencyKey).toBe(integrationUploadSessionKey(actor.actorUserId, input.clientIdempotencyKey));
      opens++; return { outcome: "queued_for_ingest", sessionId: "session", projectId: "project", queuedJobId: "job" }; },
    async statusByClientKey() {
      if (!existing) throw new ExpectedDomainFailureError({ code: "upload_session_not_found", kind: "missing", message: "Upload not found" });
      return { outcome: "queued_for_ingest", sessionId: "session", projectId: "project", queuedJobId: "job" };
    },
  } as unknown as UploadSessionService;
  return { count: () => opens, handler: createMcpUploadHttpHandler({ service: integrationUploadSessions(service), admit: async () => ({ actor, beforeAccept: unavailable }), authenticationFailure: () => null, authFailureThrottle: unthrottled }) };
}
const unthrottled = () => ({ exhausted: async () => false, recordFailure: async () => {}, retryAfterSeconds: 60 });
function request() { return new Request(`https://narriflow.test/mcp/integrations/${workspaceId}/upload-sessions/open`, { method: "POST", body: JSON.stringify(input), headers: { "Content-Type": "application/json" } }); }
describe("authenticated integration uploads", () => {
  test("retains the authenticated request budget for every transfer action", async () => {
    let calls = 0;
    const handler = createMcpUploadHttpHandler({
      service: integrationUploadSessions({ open: async () => { calls++; }, status: async () => { calls++; }, grant: async () => { calls++; }, finalize: async () => { calls++; }, discard: async () => { calls++; } } as unknown as UploadSessionService),
      admit: async () => ({ actor, beforeAccept: mcpIntegrationMutationGuard({ allowed: false, availability: "available", remaining: 0, limit: 300 }) }),
      authenticationFailure: (error) => mcpIntegrationAuthenticationFailure(error, "https://narriflow.test/.well-known/oauth-protected-resource/mcp"),
      authFailureThrottle: unthrottled,
    });
    for (const action of ["open", "status", "grants", "finalize", "discard"]) {
      const response = await handler(new Request(`https://narriflow.test/mcp/integrations/${workspaceId}/upload-sessions/${action}`, { method: "POST", body: "{}" }), workspaceId);
      expect(response.status).toBe(429);
      expect((await response.json()).error).toBe("request_limit_exceeded");
      expect(response.headers.get("Retry-After")).toBe("60");
    }
    expect(calls).toBe(0);
  });
  test("reserves OAuth challenges for authentication failures and preserves domain admission failures", async () => {
    const handler = createMcpUploadHttpHandler({
      service: integrationUploadSessions({} as UploadSessionService),
      admit: async () => { throw new ExpectedDomainFailureError({ code: "scope_required", kind: "forbidden", message: "Explicit processing consent is required" }); },
      authenticationFailure: (error) => mcpIntegrationAuthenticationFailure(error, "https://narriflow.test/.well-known/oauth-protected-resource/mcp"),
      authFailureThrottle: unthrottled,
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
    expect((await response.json()).error).toBe("mutations_unavailable");
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
  test("refuses an address over its failed-authentication budget before any credential lookup, and counts a rejected credential", async () => {
    const metadata = "https://narriflow.test/.well-known/oauth-protected-resource/mcp";
    let admits = 0, recorded = 0, exhausted = true;
    const handler = createMcpUploadHttpHandler({
      service: integrationUploadSessions({} as UploadSessionService),
      admit: async () => { admits++; throw new OAuthError(OAuthErrorCode.InvalidToken, "Revoked"); },
      authenticationFailure: (error) => mcpIntegrationAuthenticationFailure(error, metadata),
      authFailureThrottle: () => ({ exhausted: async () => exhausted, recordFailure: async () => { recorded++; }, retryAfterSeconds: 60 }),
    });
    const blocked = await handler(request(), workspaceId);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(admits).toBe(0);
    exhausted = false;
    expect((await handler(request(), workspaceId)).status).toBe(401);
    expect({ admits, recorded }).toEqual({ admits: 1, recorded: 1 });
  });
  test("answers an internal defect with a logged, non-retryable 500 rather than a retryable 503", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const handler = createMcpUploadHttpHandler({
        service: integrationUploadSessions({} as UploadSessionService),
        admit: async () => { throw new TypeError("cannot read properties of undefined"); },
        authenticationFailure: () => null,
        authFailureThrottle: unthrottled,
      });
      const response = await handler(request(), workspaceId);
      expect(response.status).toBe(500);
      expect(response.headers.get("Retry-After")).toBeNull();
      expect(await response.json()).toMatchObject({ error: "internal_error" });
      const line = warn.mock.calls.map(([text]) => JSON.parse(String(text))).find((entry) => entry.message === "mcp_upload_request_failed");
      expect(line.error).toMatchObject({ name: "TypeError", message: "cannot read properties of undefined" });
    } finally { warn.mockRestore(); }
  });
});
