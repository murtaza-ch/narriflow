import { describe, expect, test } from "bun:test";
import { createMcpConfirmation, verifyMcpPreparation, acceptMcpConfirmation, verifyMcpConfirmation, createMcpUploadHandoff, verifyMcpUploadHandoff, MCP_CONTINUATION_TTL_MS } from "./mcp-confirmation";

const principal = { kind: "oauth" as const, userId: "00000000-0000-4000-8000-000000000001", clientId: "test-client", scopes: ["publishing:write"] };
const intent = { workspaceId: "00000000-0000-4000-8000-000000000002", clientIdempotencyKey: "00000000-0000-4000-8000-000000000003", projectId: "00000000-0000-4000-8000-000000000004", clipId: "00000000-0000-4000-8000-000000000005", accountId: "00000000-0000-4000-8000-000000000006", clipExportId: "00000000-0000-4000-8000-000000000007", clipExportVariantId: "00000000-0000-4000-8000-000000000008", expectedEditorRevision: 3, platform: "youtube_shorts" as const, aspectRatio: "9:16" as const, resolution: "1080p" as const, caption: "The exact caption", scheduledFor: "2026-10-06T12:00:00.000Z", providerSettings: {} };
const options = { secret: "a-shared-secret-of-at-least-32-bytes-long", now: 1_000_000 };
describe("Exact publication confirmation", () => {
  test("preparation alone cannot schedule and approval covers the exact immutable intent", () => {
    const prepared = createMcpConfirmation(principal, intent, options);
    expect(verifyMcpPreparation(prepared.token, { ...options, principal }).intent.caption).toBe("The exact caption");
    expect(() => verifyMcpConfirmation(prepared.token, prepared.token, principal, intent.workspaceId, intent.clientIdempotencyKey, options)).toThrow();
    const receipt = acceptMcpConfirmation(prepared.token, { ...options, actorUserId: principal.userId, accepted: true });
    expect(verifyMcpConfirmation(prepared.token, receipt, principal, intent.workspaceId, intent.clientIdempotencyKey, options).intent.expectedEditorRevision).toBe(3);
  });
  test("declined, expired, tampered, foreign caller and changed retry identity are rejected", () => {
    const prepared = createMcpConfirmation(principal, intent, options);
    expect(() => acceptMcpConfirmation(prepared.token, { ...options, actorUserId: principal.userId, accepted: false })).toThrow();
    expect(() => verifyMcpPreparation(`${prepared.token.slice(0, -2)}xx`, { ...options, principal })).toThrow();
    expect(() => verifyMcpPreparation(prepared.token, { ...options, now: options.now + 600_000, principal })).toThrow();
    expect(() => verifyMcpPreparation(prepared.token, { ...options, principal: { ...principal, clientId: "other" } })).toThrow();
    const receipt = acceptMcpConfirmation(prepared.token, { ...options, actorUserId: principal.userId, accepted: true });
    expect(() => verifyMcpConfirmation(prepared.token, receipt, principal, intent.workspaceId, "changed-key", options)).toThrow();
    const changed = createMcpConfirmation(principal, { ...intent, caption: "Changed caption" }, options);
    expect(() => verifyMcpConfirmation(changed.token, receipt, principal, intent.workspaceId, intent.clientIdempotencyKey, options)).toThrow();
  });
});

function tamper(token: string, patch: Record<string, unknown>) {
  const [payload, mac] = token.split(".");
  const state = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
  return `${Buffer.from(JSON.stringify({ ...state, ...patch })).toString("base64url")}.${mac}`;
}
describe("Signed continuation grants", () => {
  const upload = { workspaceId: intent.workspaceId, clientIdempotencyKey: intent.clientIdempotencyKey };
  test("states carry the originating credential kind and its granted scopes, never synthesized ones", () => {
    const readOnly = { ...principal, scopes: ["projects:read"] };
    expect(verifyMcpPreparation(createMcpConfirmation(readOnly, intent, options).token, options)).toMatchObject({ principalKind: "oauth", scopes: ["projects:read"] });
    const key = { kind: "api_key" as const, userId: principal.userId, clientId: "narriflow-api-key:key", apiKeyId: "00000000-0000-4000-8000-000000000009", workspaceId: intent.workspaceId, scopes: ["processing:write"] };
    expect(verifyMcpUploadHandoff(createMcpUploadHandoff(key, upload, options).token, options)).toMatchObject({ principalKind: "api_key", scopes: ["processing:write"] });
  });
  test("OAuth continuations expire at the earlier of ten minutes and the access token expiration", () => {
    const shortLived = { ...principal, expiresAt: (options.now + 120_000) / 1000 };
    const prepared = createMcpConfirmation(shortLived, intent, options);
    expect(prepared.expiresAt).toBe(new Date(options.now + 120_000).toISOString());
    expect(() => verifyMcpPreparation(prepared.token, { ...options, now: options.now + 120_000 })).toThrow(expect.objectContaining({ code: "mcp_confirmation_expired" }));
    const handoff = createMcpUploadHandoff(shortLived, upload, options);
    expect(() => verifyMcpUploadHandoff(handoff.token, { ...options, now: options.now + 120_000 })).toThrow(expect.objectContaining({ code: "mcp_upload_handoff_expired" }));
    expect(createMcpConfirmation({ ...principal, expiresAt: (options.now + 3_600_000) / 1000 }, intent, options).expiresAt).toBe(new Date(options.now + MCP_CONTINUATION_TTL_MS).toISOString());
  });
  test("tampered scope lists or credential kinds are refused", () => {
    const prepared = createMcpConfirmation({ ...principal, scopes: ["projects:read"] }, intent, options);
    expect(() => verifyMcpPreparation(tamper(prepared.token, { scopes: ["publishing:write"] }), options)).toThrow(expect.objectContaining({ code: "mcp_confirmation_invalid" }));
    const handoff = createMcpUploadHandoff({ ...principal, scopes: ["projects:read"] }, upload, options);
    expect(() => verifyMcpUploadHandoff(tamper(handoff.token, { scopes: ["processing:write"] }), options)).toThrow(expect.objectContaining({ code: "mcp_upload_handoff_invalid" }));
    expect(() => verifyMcpUploadHandoff(tamper(handoff.token, { principalKind: "api_key" }), options)).toThrow(expect.objectContaining({ code: "mcp_upload_handoff_invalid" }));
  });
  test("expired upload handoffs still identify their session only when explicitly allowed", () => {
    const handoff = createMcpUploadHandoff(principal, upload, options);
    const later = { ...options, now: options.now + MCP_CONTINUATION_TTL_MS };
    expect(() => verifyMcpUploadHandoff(handoff.token, later)).toThrow(expect.objectContaining({ code: "mcp_upload_handoff_expired" }));
    expect(verifyMcpUploadHandoff(handoff.token, { ...later, allowExpired: true }).intent.clientIdempotencyKey).toBe(upload.clientIdempotencyKey);
  });
});
