import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { captionPresetSchema, editorDocumentSchema, studioEditsSchema } from "@narriflow/validators";
import { clipExportService } from "./clip-export.service";
import { encodeClipEditorDocumentForStorage } from "./clip-editor-document-persistence";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { workspaceService } from "./workspace.service";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000002";
const EXPORT = "00000000-0000-4000-8000-000000000003";
const scope = { actorUserId: "00000000-0000-4000-8000-000000000004", workspaceId: WORKSPACE };
const snapshot = {
  ...encodeClipEditorDocumentForStorage(editorDocumentSchema.parse({
    version: 1, clipStartSec: 0, clipEndSec: 12, captionPreset: captionPresetSchema.parse({ textTransform: "none" }),
    transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "Speaker 1", confidence: 0.9, startSec: 1, endSec: 2, text: "Hello there",
      words: [{ word: "Hello", startSec: 1, endSec: 1.4, confidence: 0.9 }, { word: "there", startSec: 1.5, endSec: 2, confidence: 0.9 }] }],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }), brollUrl: null, deletedRanges: [],
  }), { durationSec: 600, wholeSource: false }),
  llmModel: "test",
};
function variant(id: string, status: string, storageKey: string | null) {
  return { id, aspectRatio: "ratio_9_16", resolution: "720p", watermark: true, status, storageKey, sizeBytes: BigInt(1234), render: { clipSnapshot: snapshot } };
}
let row: unknown;
const fakePrisma = {
  clipExport: { findFirst: async () => row },
  project: { findUnique: async () => ({ expiresAt: null, purgeStartedAt: null }) },
} as unknown as PrismaClient;

const globals = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
const previousPrisma = globals.narriflowPrismaClient;
const previousEnv = { ...process.env };
beforeAll(() => {
  globals.narriflowPrismaClient = fakePrisma;
  // getPrismaClient returns the stand-in only when a database is configured.
  Object.assign(process.env, { DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unused.test/db", R2_ACCOUNT_ID: "account", R2_ACCESS_KEY_ID: "access", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "bucket" });
});
afterAll(() => {
  globals.narriflowPrismaClient = previousPrisma;
  for (const key of ["DATABASE_URL", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) {
    if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key];
  }
});

describe("Download Grants", () => {
  test("grant fresh, expiring URLs only for completed variants with files, with subtitles and a URL-free audit log", async () => {
    row = { id: EXPORT, projectId: PROJECT, clipId: "00000000-0000-4000-8000-000000000005", editorRevision: 4,
      clip: { title: "Big Idea", hookText: "Hook" }, project: { sourceDurationSeconds: 600 },
      variants: [variant("00000000-0000-4000-8000-00000000000a", "completed", `projects/${PROJECT}/exports/${EXPORT}/a.mp4`),
        variant("00000000-0000-4000-8000-00000000000b", "failed", null),
        variant("00000000-0000-4000-8000-00000000000c", "completed", null)] };
    const actor = spyOn(workspaceService, "requireActor").mockResolvedValue({} as never);
    const logs: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((line: unknown) => { logs.push(String(line)); });
    try {
      const before = Date.now();
      const first = await clipExportService.issueDownloadGrants(scope, EXPORT, { credentialKind: "oauth" });
      expect(actor).toHaveBeenCalledWith(scope.actorUserId, WORKSPACE, "content.download");
      expect(first.variants.map((item) => item.variantId)).toEqual(["00000000-0000-4000-8000-00000000000a"]);
      expect(first.variants[0]).toMatchObject({ aspectRatio: "9:16", resolution: "720p", watermark: true, fileName: "Big-Idea-9x16-720p-v4.mp4", sizeBytes: 1234 });
      const expiresAt = Date.parse(first.variants[0]!.expiresAt);
      expect(expiresAt - before).toBeGreaterThanOrEqual(15 * 60 * 1000 - 1000);
      expect(expiresAt - before).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
      expect(new URL(first.variants[0]!.downloadUrl).searchParams.get("X-Amz-Expires")).toBe("900");
      expect(first.subtitles.map((file) => file.fileName)).toEqual(["Big-Idea-v4.srt", "Big-Idea-v4.vtt"]);
      expect(first.subtitles[0]!.content).toContain("Hello there");
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const second = await clipExportService.issueDownloadGrants(scope, EXPORT, { credentialKind: "api_key" });
      expect(second.variants[0]!.downloadUrl).not.toBe(first.variants[0]!.downloadUrl);
      const audit = logs.map((line) => JSON.parse(line)).filter((entry) => entry.message === "export_download_granted");
      expect(audit).toHaveLength(2);
      expect(audit[1]).toMatchObject({ exportId: EXPORT, actorUserId: scope.actorUserId, credentialKind: "api_key", variantIds: ["00000000-0000-4000-8000-00000000000a"] });
      expect(logs.join("\n")).not.toContain("X-Amz");
      expect(logs.join("\n")).not.toContain("https://");
    } finally { actor.mockRestore(); warn.mockRestore(); }
  });

  test("refuses a missing variant, an export with no finished file, and a member without download access", async () => {
    const actor = spyOn(workspaceService, "requireActor").mockResolvedValue({} as never);
    try {
      row = { id: EXPORT, projectId: PROJECT, clipId: "00000000-0000-4000-8000-000000000005", editorRevision: 1,
        clip: { title: null, hookText: "Hook" }, project: { sourceDurationSeconds: 600 }, variants: [variant("00000000-0000-4000-8000-00000000000b", "rendering", null)] };
      await expect(clipExportService.issueDownloadGrants(scope, EXPORT, { credentialKind: "oauth" })).rejects.toMatchObject({ code: "export_not_ready" });
      await expect(clipExportService.issueDownloadGrants(scope, EXPORT, { variantId: "00000000-0000-4000-8000-0000000000ff", credentialKind: "oauth" })).rejects.toMatchObject({ code: "export_not_found" });
      row = null;
      await expect(clipExportService.issueDownloadGrants(scope, EXPORT, { credentialKind: "oauth" })).rejects.toMatchObject({ code: "export_not_found" });
      actor.mockRejectedValue(new ExpectedDomainFailureError({ code: "workspace_access_denied", kind: "forbidden", message: "Download access required" }));
      await expect(clipExportService.issueDownloadGrants(scope, EXPORT, { credentialKind: "oauth" })).rejects.toMatchObject({ code: "workspace_access_denied" });
    } finally { actor.mockRestore(); }
  });
});
