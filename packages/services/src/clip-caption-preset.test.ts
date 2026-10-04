import { describe, expect, test } from "bun:test";
import {
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  captionPresetSchema,
} from "@narriflow/validators";
import { resolveClipCaptionPresetForContentPack } from "./clip.service";

describe("resolveClipCaptionPresetForContentPack", () => {
  const templatePreset = captionPresetSchema.parse({
    fontName: "Template Font",
    highlightColor: "#123456",
  });

  test("uses brand template preset for brand default", () => {
    expect(
      resolveClipCaptionPresetForContentPack(
        BRAND_DEFAULT_CAPTION_PRESET_ID,
        templatePreset,
      ),
    ).toEqual(templatePreset);
  });

  test("falls back to the brand template preset for an unknown id", () => {
    expect(
      resolveClipCaptionPresetForContentPack(
        "not-a-preset",
        templatePreset,
      ),
    ).toEqual(templatePreset);
  });

  test("resolves named presets over brand template", () => {
    const resolved = resolveClipCaptionPresetForContentPack(
      "karaoke",
      templatePreset,
    );

    expect(resolved?.animation).toBe("karaoke");
    expect(resolved?.fontName).toBe("Bebas Neue");
  });
});
