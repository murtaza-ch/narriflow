import { describe, expect, test } from "bun:test";
import { buildCaptionedVideoContentPack, buildGenerationContentPack } from "./integration";
import { mcpGenerateClipsSchema, mcpSubmitVideoSchema, mcpUploadVideoSchema } from "./mcp";
import { recipeInputSchema, recipeUpdateSchema } from "./recipe";
import { generateClipsRequestSchema, openUploadRequestSchema, submitVideoRequestSchema } from "./rest-api";
import { openUploadSessionSchema } from "./upload";

const ID = "00000000-0000-4000-8000-0000000000e1";
const KEY = "00000000-0000-4000-8000-0000000000f1";
const WORKSPACE = "00000000-0000-4000-8000-0000000000c1";
const FILE = { name: "a.mp4", sizeBytes: 10, contentType: "video/mp4" } as const;
const SOURCE = { fileName: "a.mp4", sizeBytes: 10, contentType: "video/mp4", browserFingerprint: "f" } as const;

describe("Recipe schemas", () => {
  test("a Recipe holds generation settings and optional finishing, never a captioned video", () => {
    const pack = buildGenerationContentPack();
    expect(recipeInputSchema.parse({ name: " Weekly ", contentPack: pack })).toMatchObject({ name: "Weekly" });
    const captioned = buildCaptionedVideoContentPack({ framing: "fit", aspectRatios: ["9:16"], resolution: "1080p", captions: { source: "auto" } } as never);
    expect(recipeInputSchema.safeParse({ name: "Captions", contentPack: captioned }).success).toBe(false);
    expect(recipeInputSchema.safeParse({ name: "", contentPack: pack }).success).toBe(false);
    expect(recipeInputSchema.safeParse({ name: "Show", contentPack: pack, unknown: true }).success).toBe(false);
  });

  test("an edit names the revision it was made on and sends only what changed", () => {
    expect(recipeUpdateSchema.parse({ expectedRevision: 3, name: "Renamed" })).toEqual({ expectedRevision: 3, name: "Renamed" });
    expect(recipeUpdateSchema.safeParse({ name: "Renamed" }).success).toBe(false);
    expect(recipeUpdateSchema.safeParse({ expectedRevision: 0 }).success).toBe(false);
  });
});

describe("a Recipe replaces inline settings, never joins them", () => {
  test("REST accepts recipeId alone and refuses it beside brandProfileId, generation, or finishing", () => {
    const link = { url: "https://youtube.com/watch?v=abc" };
    expect(submitVideoRequestSchema.safeParse({ ...link, recipeId: ID }).success).toBe(true);
    expect(submitVideoRequestSchema.safeParse({ ...link, generation: { clipCountTarget: 5 } }).success).toBe(true);
    for (const inline of [{ brandProfileId: ID }, { generation: {} }, { finishing: { topClips: 2 } }]) {
      const result = submitVideoRequestSchema.safeParse({ ...link, recipeId: ID, ...inline });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain("Send recipeId or those settings, not both");
    }
    expect(generateClipsRequestSchema.safeParse({ recipeId: ID }).success).toBe(true);
    expect(generateClipsRequestSchema.safeParse({ recipeId: ID, generation: {} }).success).toBe(false);
    expect(openUploadRequestSchema.safeParse({ file: FILE, recipeId: ID }).success).toBe(true);
    expect(openUploadRequestSchema.safeParse({ file: FILE, recipeId: ID, brandProfileId: ID }).success).toBe(false);
  });

  test("MCP tools refuse the same combinations, and an omitted generation stays omitted", () => {
    const base = { workspaceId: WORKSPACE, clientIdempotencyKey: KEY };
    const submit = { ...base, url: "https://youtube.com/watch?v=abc" };
    expect(mcpSubmitVideoSchema.parse({ ...submit, recipeId: ID }).generation).toBeUndefined();
    expect(mcpSubmitVideoSchema.safeParse({ ...submit, recipeId: ID, finishing: { topClips: 2 } }).success).toBe(false);
    expect(mcpUploadVideoSchema.safeParse({ ...base, recipeId: ID, generation: {} }).success).toBe(false);
    expect(mcpGenerateClipsSchema.safeParse({ ...base, projectId: ID, recipeId: ID }).success).toBe(true);
    expect(mcpGenerateClipsSchema.safeParse({ ...base, projectId: ID, recipeId: ID, generation: {} }).success).toBe(false);
  });

  test("an Upload Session opens with explicit settings or a Recipe, exactly one", () => {
    const open = { clientIdempotencyKey: KEY, title: "Upload", source: SOURCE };
    const generationContext = { contentPack: buildGenerationContentPack(), languageCode: null };
    expect(openUploadSessionSchema.safeParse({ ...open, generationContext }).success).toBe(true);
    expect(openUploadSessionSchema.safeParse({ ...open, recipeId: ID }).success).toBe(true);
    expect(openUploadSessionSchema.safeParse(open).success).toBe(false);
    expect(openUploadSessionSchema.safeParse({ ...open, recipeId: ID, generationContext }).success).toBe(false);
    expect(openUploadSessionSchema.safeParse({ ...open, recipeId: ID, brandProfileId: null }).success).toBe(false);
    expect(openUploadSessionSchema.safeParse({ ...open, recipeId: ID, brandTemplateId: ID }).success).toBe(false);
  });
});
