import { describe, expect, test } from "bun:test";
import { createMcpConfirmation, verifyMcpPreparation, acceptMcpConfirmation, verifyMcpConfirmation } from "./mcp-confirmation";

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
