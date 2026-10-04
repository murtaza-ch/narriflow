import { describe, expect, test } from "bun:test";
import {
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  clipLengthPresetRanges,
  contentPackSchema,
  parseStoredContentPack,
  type ClipLengthPreset,
} from ".";

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
