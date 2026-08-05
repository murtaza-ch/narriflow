import { describe, expect, test } from "bun:test";
import { applyCaptionPresetToAllSchema } from "./clip";
import { DEFAULT_CAPTION_PRESET } from "./caption-preset";

describe("applyCaptionPresetToAllSchema (vizard-parity Phase C — apply-to-all self-conflict fix)", () => {
  test("accepts a preset without excludeClipId", () => {
    const parsed = applyCaptionPresetToAllSchema.parse({
      captionPreset: DEFAULT_CAPTION_PRESET,
    });
    expect(parsed.excludeClipId).toBeUndefined();
  });

  test("accepts a preset with a well-formed excludeClipId", () => {
    const parsed = applyCaptionPresetToAllSchema.parse({
      captionPreset: DEFAULT_CAPTION_PRESET,
      excludeClipId: "3f3e3d3c-3b3a-4939-8837-363534333231",
    });
    expect(parsed.excludeClipId).toBe("3f3e3d3c-3b3a-4939-8837-363534333231");
  });

  test("rejects a null captionPreset — bulk apply always applies an actual preset", () => {
    expect(() =>
      applyCaptionPresetToAllSchema.parse({ captionPreset: null }),
    ).toThrow();
  });

  test("rejects a non-uuid excludeClipId", () => {
    expect(() =>
      applyCaptionPresetToAllSchema.parse({
        captionPreset: DEFAULT_CAPTION_PRESET,
        excludeClipId: "not-a-uuid",
      }),
    ).toThrow();
  });
});
