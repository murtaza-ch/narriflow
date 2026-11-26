import { describe, expect, test } from "bun:test";
import {
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  buildGenerationContentPack,
  buildGenerationContext,
  buildRecipeGenerationContext,
  clipLengthPresetRanges,
  contentPackSchema,
  generateProjectRequestSchema,
  generationSettingsSchema,
  mcpGenerateClipsSchema,
  mcpSubmitVideoSchema,
  mcpUploadVideoSchema,
  openUploadSessionSchema,
  parseStoredContentPack,
  recipeInputSchema,
  recipeSnapshotSchema,
  recipeUpdateSchema,
  regenerateClipsRequestSchema,
  restApiSchemas,
  type ClipLengthPreset,
} from ".";
import { generationSetupSchema, rssImportRequestSchema } from "./api/ingest";

const baseContentPack = {
  outputTypes: ["short_clip"],
  clipGenerationMode: "best",
  clipCountTarget: 10,
  platformTargets: ["tiktok", "youtube_shorts", "instagram_reels"],
  toneConstraints: ["concise"],
  captionPreset: BRAND_DEFAULT_CAPTION_PRESET_ID,
  platformPlaybookVersion: "platform-playbook-v1",
  mode: "clip",
  autoHook: true,
  specificMoments: "",
  processingStartSec: null,
  processingEndSec: null,
};

describe("contentPackSchema", () => {
  test("accepts every clip length preset range", () => {
    for (const [clipLengthPreset, range] of Object.entries(
      clipLengthPresetRanges,
    ) as Array<[ClipLengthPreset, typeof clipLengthPresetRanges[ClipLengthPreset]]>) {
      expect(
        contentPackSchema.safeParse({
          ...baseContentPack,
          ...range,
          clipLengthPreset,
        }).success,
      ).toBe(true);
    }
  });

  test("rejects processing windows whose end is not after start", () => {
    const parsed = contentPackSchema.safeParse({
      ...baseContentPack,
      ...clipLengthPresetRanges.auto,
      clipLengthPreset: "auto",
      processingStartSec: 10,
      processingEndSec: 10,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path[0] === "processingEndSec")).toBe(true);
    }
  });
});

describe("parseStoredContentPack", () => {
  test("rejects obsolete free-form caption presets instead of changing settings", () => {
    const stored = {
      ...baseContentPack,
      ...clipLengthPresetRanges.auto,
      captionPreset: '{"fontName":"Bebas Neue","primaryColor":"#FFFFFF"}',
    };

    expect(() => parseStoredContentPack(stored)).toThrow();
  });

  test("preserves a valid caption preset id", () => {
    const parsed = parseStoredContentPack({
      ...baseContentPack,
      ...clipLengthPresetRanges.auto,
      captionPreset: "karaoke",
    });
    expect(parsed.captionPreset).toBe("karaoke");
  });

  test("projects every setting losslessly while excluding storage metadata", () => {
    const settings = contentPackSchema.parse({
      ...baseContentPack,
      ...clipLengthPresetRanges["60_to_120s"],
      clipLengthPreset: "60_to_120s",
      defaultAspectRatio: "4:5",
      mode: "caption_only",
      autoHook: false,
      specificMoments: "Keep the closing answer",
      processingStartSec: 20,
      processingEndSec: 150,
    });
    const projected = parseStoredContentPack({
      ...settings, id: "pack-id", projectId: "project-id", draft: true,
      createdAt: new Date(),
    });
    expect(projected).toEqual(settings);
    expect(parseStoredContentPack(projected)).toEqual(settings);
    expect(Object.keys(projected).sort()).toEqual(Object.keys(settings).sort());
  });

  test("rejects incomplete and contradictory stored settings", () => {
    expect(() => parseStoredContentPack({})).toThrow();
    expect(() => parseStoredContentPack({
      ...baseContentPack, ...clipLengthPresetRanges.auto,
      processingStartSec: 50, processingEndSec: 20,
    })).toThrow();
  });
});

describe("addEmojis generation setting", () => {
  const WORKSPACE = "00000000-0000-4000-8000-0000000000c1";
  const KEY = "00000000-0000-4000-8000-0000000000f1";
  const PROJECT = "00000000-0000-4000-8000-0000000000a1";
  const FILE = { name: "a.mp4", sizeBytes: 10, contentType: "video/mp4" } as const;
  const SOURCE = { fileName: "a.mp4", sizeBytes: 10, contentType: "video/mp4", browserFingerprint: "f" } as const;
  const on = buildGenerationContentPack({ addEmojis: true });

  test("is off unless asked for, in a pack and in generation settings", () => {
    expect(contentPackSchema.parse({ ...baseContentPack, ...clipLengthPresetRanges.auto }).addEmojis).toBe(false);
    expect(generationSettingsSchema.parse({}).addEmojis).toBe(false);
    expect(buildGenerationContentPack().addEmojis).toBe(false);
    expect(generationSettingsSchema.safeParse({ addEmojis: "yes" }).success).toBe(false);
  });

  test("a pack with addEmojis on round-trips through every schema that carries one", () => {
    expect(on.addEmojis).toBe(true);
    expect(contentPackSchema.parse(on)).toEqual(on);
    expect(parseStoredContentPack({ ...on, id: "row", draft: false, createdAt: new Date() })).toEqual(on);
    expect(generateProjectRequestSchema.parse({ contentPack: on }).contentPack.addEmojis).toBe(true);
    expect(generationSetupSchema.parse({ contentPack: on, languageCode: null }).contentPack.addEmojis).toBe(true);
    expect(rssImportRequestSchema.parse({ rssUrl: "https://example.com/feed.xml", episodeIds: ["e1"], commitToken: KEY, contentPack: on, languageCode: null }).contentPack.addEmojis).toBe(true);
    expect(regenerateClipsRequestSchema.parse({ contentPack: on }).contentPack.addEmojis).toBe(true);
    expect(recipeInputSchema.parse({ name: "Show", contentPack: on }).contentPack.addEmojis).toBe(true);
    expect(recipeUpdateSchema.parse({ expectedRevision: 1, contentPack: on }).contentPack?.addEmojis).toBe(true);
    expect(openUploadSessionSchema.parse({ clientIdempotencyKey: KEY, title: "Upload", source: SOURCE, generationContext: { contentPack: on, languageCode: null } })
      .generationContext?.contentPack.addEmojis).toBe(true);
    expect(buildRecipeGenerationContext({ contentPack: on, languageCode: null, finishing: null }).contentPack.addEmojis).toBe(true);
  });

  test("REST and MCP generation settings carry it into the committed Content Pack", () => {
    const generation = { addEmojis: true };
    const rest = [
      restApiSchemas.submitVideoRequestSchema.parse({ url: "https://youtube.com/watch?v=abc", generation }).generation,
      restApiSchemas.openUploadRequestSchema.parse({ file: FILE, generation }).generation,
      restApiSchemas.generateClipsRequestSchema.parse({ generation }).generation,
    ];
    const base = { workspaceId: WORKSPACE, clientIdempotencyKey: KEY };
    const mcp = [
      mcpSubmitVideoSchema.parse({ ...base, url: "https://youtube.com/watch?v=abc", generation }).generation,
      mcpUploadVideoSchema.parse({ ...base, generation }).generation,
      mcpGenerateClipsSchema.parse({ ...base, projectId: PROJECT, generation }).generation,
    ];
    for (const settings of [...rest, ...mcp]) {
      expect(settings?.addEmojis).toBe(true);
      expect(buildGenerationContext(settings).contentPack.addEmojis).toBe(true);
    }
  });

  test("a Recipe stored before the setting existed reads with it off", () => {
    const { addEmojis: _, ...stored } = buildGenerationContentPack();
    expect("addEmojis" in stored).toBe(false);
    expect(recipeSnapshotSchema.parse({
      id: PROJECT, workspaceId: WORKSPACE, name: "Old", revision: 1, brandProfileId: null, languageCode: null, contentPack: stored, finishing: null, ruleCount: 0,
      createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    }).contentPack.addEmojis).toBe(false);
    expect(buildRecipeGenerationContext({ contentPack: stored, languageCode: null, finishing: null }).contentPack.addEmojis).toBe(false);
    expect(parseStoredContentPack(stored).addEmojis).toBe(false);
  });
});
