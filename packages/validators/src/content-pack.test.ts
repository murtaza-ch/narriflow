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
  autoRenderClips: false,
  toneConstraints: ["concise"],
  captionPreset: BRAND_DEFAULT_CAPTION_PRESET_ID,
  platformPlaybookVersion: "2026.2",
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

describe("parseStoredContentPack (legacy DB rows)", () => {
  test("falls back to brand default for legacy free-form caption presets", () => {
    // Older rows stored a JSON-stringified preset or a display name instead of
    // a fixed preset id; these must not throw when read.
    const legacy = {
      ...baseContentPack,
      ...clipLengthPresetRanges.auto,
      captionPreset: '{"fontName":"Bebas Neue","primaryColor":"#FFFFFF"}',
    };

    const parsed = parseStoredContentPack(legacy);
    expect(parsed.captionPreset).toBe(BRAND_DEFAULT_CAPTION_PRESET_ID);
  });

  test("preserves a valid caption preset id", () => {
    const parsed = parseStoredContentPack({
      ...baseContentPack,
      ...clipLengthPresetRanges.auto,
      captionPreset: "karaoke",
    });
    expect(parsed.captionPreset).toBe("karaoke");
  });
});
