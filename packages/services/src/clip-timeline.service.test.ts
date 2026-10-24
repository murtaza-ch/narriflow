import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { captionPresetSchema, editorDocumentSchema, studioEditsSchema } from "@narriflow/validators";
import { encodeClipEditorDocumentForStorage } from "./clip-editor-document-persistence";
import { clipTimelineService } from "./clip-timeline.service";
import { workspaceService } from "./workspace.service";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000002";
const CLIP = "00000000-0000-4000-8000-000000000005";
const scope = { actorUserId: "00000000-0000-4000-8000-000000000004", workspaceId: WORKSPACE };
const probe = { durationSec: 600, video: { width: 1920, height: 1080, frameRate: { numerator: 30000, denominator: 1001 }, startTimecode: null }, audio: { sampleRate: 48_000, channels: 2 } };

const stored = encodeClipEditorDocumentForStorage(editorDocumentSchema.parse({
  version: 1, clipStartSec: 0, clipEndSec: 12, captionPreset: captionPresetSchema.parse({ textTransform: "none" }),
  transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "Speaker 1", confidence: 0.9, startSec: 1, endSec: 2, text: "Hello there",
    words: [{ word: "Hello", startSec: 1, endSec: 1.4, confidence: 0.9 }, { word: "there", startSec: 1.5, endSec: 2, confidence: 0.9 }] }],
  studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }), brollUrl: null, deletedRanges: [{ startSec: 4, endSec: 6 }],
}), { durationSec: 600, wholeSource: false });

let row: unknown;
let lookup: unknown;
const fakePrisma = {
  clip: { findFirst: async (query: unknown) => { lookup = query; return row; } },
  project: { findUnique: async () => ({ expiresAt: null, purgeStartedAt: null }) },
} as unknown as PrismaClient;

const globals = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
const previousPrisma = globals.narriflowPrismaClient;
const previousEnv = { ...process.env };
beforeAll(() => {
  globals.narriflowPrismaClient = fakePrisma;
  Object.assign(process.env, { DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unused.test/db", R2_ACCOUNT_ID: "account", R2_ACCESS_KEY_ID: "access", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "bucket" });
});
afterAll(() => {
  globals.narriflowPrismaClient = previousPrisma;
  for (const key of ["DATABASE_URL", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) {
    if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key];
  }
});

function clipRow(project: Record<string, unknown> = {}) {
  return { ...stored, id: CLIP, projectId: PROJECT, llmModel: "test", title: "Big Idea", hookText: "Hook", editorRevision: 4,
    project: { title: "Quarterly Talk", sourceStorageKey: `projects/${PROJECT}/upload/source.mp4`, sourceSizeBytes: BigInt(52_428_800), sourceDurationSeconds: 600, sourceProbe: probe, ...project } };
}

describe("clip timelines", () => {
  test("export returns the timeline text, SRT, and an expiring source grant under the name the timeline uses, with a URL-free audit log", async () => {
    row = clipRow();
    const actor = spyOn(workspaceService, "requireActor").mockResolvedValue({} as never);
    const logs: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((line: unknown) => { logs.push(String(line)); });
    try {
      const before = Date.now();
      const result = await clipTimelineService.export(scope, PROJECT, CLIP, "fcpxml", { credentialKind: "api_key" });
      expect(actor).toHaveBeenCalledWith(scope.actorUserId, WORKSPACE, "content.download");
      expect(lookup).toMatchObject({ where: { id: CLIP, projectId: PROJECT, project: { workspaceId: WORKSPACE } } });
      expect(result).toMatchObject({ projectId: PROJECT, clipId: CLIP, editorRevision: 4, format: "fcpxml",
        timeline: { fileName: "Big-Idea-v4.fcpxml" }, subtitles: { format: "srt", fileName: "Big-Idea-v4.srt" } });
      expect(result.timeline.content).toContain('<media-rep kind="original-media" src="Quarterly-Talk-source.mp4"/>');
      expect(result.timeline.content).toContain('<fcpxml version="1.11">');
      expect(result.subtitles.content).toContain("Hello there");
      expect(result.source).toMatchObject({ fileName: "Quarterly-Talk-source.mp4", sizeBytes: 52_428_800 });
      const url = new URL(result.source.downloadUrl);
      expect(url.pathname).toContain(`projects/${PROJECT}/upload/source.mp4`);
      expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
      expect(url.searchParams.get("response-content-disposition")).toContain("Quarterly-Talk-source.mp4");
      const expiresAt = Date.parse(result.source.expiresAt);
      expect(expiresAt - before).toBeGreaterThanOrEqual(15 * 60 * 1000 - 1000);
      expect(expiresAt - before).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
      const audit = logs.map((line) => JSON.parse(line)).filter((entry) => entry.message === "timeline_source_granted");
      expect(audit).toEqual([expect.objectContaining({ level: "info", projectId: PROJECT, clipId: CLIP, actorUserId: scope.actorUserId, workspaceId: WORKSPACE, credentialKind: "api_key" })]);
      expect(logs.join("\n")).not.toContain("X-Amz");
      expect(logs.join("\n")).not.toContain("https://");
    } finally { actor.mockRestore(); warn.mockRestore(); }
  });

  test("archive is a ZIP of the timeline and the SRT; the source is not in it", async () => {
    row = clipRow();
    const actor = spyOn(workspaceService, "requireActor").mockResolvedValue({} as never);
    try {
      const archive = await clipTimelineService.archive(scope, PROJECT, CLIP, "edl");
      expect(archive.fileName).toBe("Big-Idea-v4-edl.zip");
      expect(archive.editorRevision).toBe(4);
      const text = new TextDecoder().decode(archive.bytes);
      expect(text.startsWith("PK")).toBe(true);
      expect(text).toContain("Big-Idea-v4.edl");
      expect(text).toContain("Big-Idea-v4.srt");
      expect(text).toContain("FCM: NON-DROP FRAME");
      expect(archive.bytes.length).toBeLessThan(5_000);
    } finally { actor.mockRestore(); }
  });

  test("issues the source grant alone for the web page's separate download", async () => {
    row = clipRow({ sourceProbe: null });
    const actor = spyOn(workspaceService, "requireActor").mockResolvedValue({} as never);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const source = await clipTimelineService.issueSourceGrant(scope, PROJECT, CLIP, { credentialKind: "session" });
      expect(source.fileName).toBe("Quarterly-Talk-source.mp4");
      expect(new URL(source.downloadUrl).searchParams.get("X-Amz-Expires")).toBe("900");
    } finally { actor.mockRestore(); warn.mockRestore(); }
  });

  test("refuses a missing clip, a purged source, an unmeasured source, and a member without download access", async () => {
    const actor = spyOn(workspaceService, "requireActor").mockResolvedValue({} as never);
    try {
      row = null;
      await expect(clipTimelineService.export(scope, PROJECT, CLIP, "edl", { credentialKind: "api_key" })).rejects.toMatchObject({ code: "clip_not_found", kind: "missing" });
      row = clipRow({ sourceStorageKey: null });
      await expect(clipTimelineService.export(scope, PROJECT, CLIP, "edl", { credentialKind: "api_key" })).rejects.toMatchObject({ code: "timeline_source_unavailable" });
      await expect(clipTimelineService.issueSourceGrant(scope, PROJECT, CLIP, { credentialKind: "session" })).rejects.toMatchObject({ code: "timeline_source_unavailable" });
      row = clipRow({ sourceProbe: null });
      await expect(clipTimelineService.archive(scope, PROJECT, CLIP, "xmeml")).rejects.toMatchObject({ code: "timeline_source_unmeasured" });

      actor.mockRejectedValue(new Error("forbidden"));
      row = clipRow();
      await expect(clipTimelineService.export(scope, PROJECT, CLIP, "edl", { credentialKind: "api_key" })).rejects.toThrow("forbidden");
    } finally { actor.mockRestore(); }
  });
});
