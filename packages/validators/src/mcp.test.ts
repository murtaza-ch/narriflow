import { describe, expect, test } from "bun:test";
import { mcpSubmitVideoSchema, mcpListClipsSchema, mcpUploadHandoffSchema, mcpPrepareSocialPostSchema, buildMcpContentPack } from "./mcp";

describe("MCP public clip workflow contracts", () => {
  test("link intake requires an explicit workspace and retry identity", () => {
    expect(mcpSubmitVideoSchema.safeParse({ url: "https://youtu.be/example" }).success).toBe(false);
    expect(mcpSubmitVideoSchema.safeParse({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      clientIdempotencyKey: "00000000-0000-4000-8000-000000000002",
      url: "https://youtu.be/example", providerToken: "must-not-be-accepted",
    }).success).toBe(false);
  });

  test("clip discovery defaults to twenty and caps a page at fifty", () => {
    const input = { projectId: "00000000-0000-4000-8000-000000000001" };
    expect(mcpListClipsSchema.parse(input).limit).toBe(20);
    expect(mcpListClipsSchema.safeParse({ ...input, limit: 51 }).success).toBe(false);
    expect(mcpListClipsSchema.parse(input).includeTranscriptExcerpt).toBe(false);
  });

  test("generation settings use the canonical duration ranges and playbook", () => {
    const pack = buildMcpContentPack({ clipLengthPreset: "under_30s", clipCountTarget: 6 });
    expect(pack).toMatchObject({ clipCountTarget: 6, clipDurationSecTarget: 25, minDurationSec: 10,
      preferredMinDurationSec: 15, preferredMaxDurationSec: 30, maxDurationSec: 35,
      platformPlaybookVersion: "platform-playbook-v1", defaultAspectRatio: "9:16" });
  });

  test("signed handoff links support bounded continuation state without increasing intake URL limits", () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const handoffUrl = `https://narriflow.test/integrations/mcp/upload?intent=${"a".repeat(8_000)}`;
    expect(mcpUploadHandoffSchema.safeParse({ workspaceId, status: "awaiting_file", handoffUrl,
      localUploadCommand: "bun run mcp:upload --file <path> --workspace <workspaceId> --key <clientIdempotencyKey>",
      confirmationExpiresAt: "2026-10-05T00:00:00.000Z" }).success).toBe(true);
    expect(mcpSubmitVideoSchema.safeParse({ workspaceId, clientIdempotencyKey: workspaceId, url: handoffUrl }).success).toBe(false);
  });

  test("publication intent rejects hidden media, timing shortcuts, and review overrides", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const intent = { workspaceId: id, projectId: id, clientIdempotencyKey: id, clipId: id, accountId: id, clipExportId: id,
      clipExportVariantId: id, expectedEditorRevision: 0, platform: "youtube_shorts", aspectRatio: "9:16", resolution: "1080p",
      caption: "Exact description", scheduledFor: "2026-10-06T12:00:00.000Z" };
    expect(mcpPrepareSocialPostSchema.safeParse(intent).success).toBe(true);
    for (const field of ["thumbnail", "assistedCopyVariantId", "immediate", "reviewOverrideReason"]) {
      expect(mcpPrepareSocialPostSchema.safeParse({ ...intent, [field]: field === "immediate" ? true : id }).success).toBe(false);
    }
  });
});
