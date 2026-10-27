import { describe, expect, test } from "bun:test";
import {
  captionPresetSchema,
  captionPresetsEqual,
  applyCaptionPresetLook,
  CAPTION_PRESETS,
  matchCaptionPreset,
} from "./caption-preset";
import {
  studioTextLayerSchema,
  studioEditsSchema,
  studioEditsEqual,
} from "./studio-edits";

const studioTextLayersEqual = (left: unknown[], right: unknown[]) =>
  studioEditsEqual(
    studioEditsSchema.parse({ textLayers: left }),
    studioEditsSchema.parse({ textLayers: right }),
  );

const fontAsset = {
  kind: "brand_font" as const,
  id: "3dcd9143-9f5b-467f-b839-f635845e3b6c",
  fingerprint: "a".repeat(64),
};

describe("uploaded font document references", () => {
  test("captions retain the uploaded face and built-in fallback through serialization", () => {
    const preset = captionPresetSchema.parse({ fontAsset });
    expect(preset.fontName).toBe("Montserrat");
    expect(
      captionPresetsEqual(
        preset,
        captionPresetSchema.parse(JSON.parse(JSON.stringify(preset))),
      ),
    ).toBe(true);
    expect(captionPresetsEqual(preset, captionPresetSchema.parse({}))).toBe(
      false,
    );
    expect(
      captionPresetsEqual(preset, {
        ...preset,
        fontAsset: { ...fontAsset, fingerprint: "b".repeat(64) },
      }),
    ).toBe(false);
    expect(matchCaptionPreset({ ...CAPTION_PRESETS[0]!.preset, fontAsset: null })?.id).toBe(CAPTION_PRESETS[0]!.id);
    expect(
      applyCaptionPresetLook(preset, CAPTION_PRESETS[0]!).fontAsset,
    ).toBeUndefined();
  });
  test("text-layer equality notices uploaded face changes without depending on object identity", () => {
    const layer = studioTextLayerSchema.parse({
      id: "title",
      text: "Hello",
      fontAsset,
    });
    expect(
      studioTextLayersEqual(
        [layer],
        [studioTextLayerSchema.parse(JSON.parse(JSON.stringify(layer)))],
      ),
    ).toBe(true);
    expect(
      studioTextLayersEqual([layer], [{ ...layer, fontAsset: null }]),
    ).toBe(false);
    expect(
      studioTextLayersEqual(
        [layer],
        [
          {
            ...layer,
            fontAsset: {
              ...fontAsset,
              id: "16cd9143-9f5b-467f-b839-f635845e3b6c",
            },
          },
        ],
      ),
    ).toBe(false);
  });
  test("invalid references are refused in captions and text layers", () => {
    expect(
      captionPresetSchema.safeParse({
        fontAsset: { ...fontAsset, id: "other" },
      }).success,
    ).toBe(false);
    expect(
      studioTextLayerSchema.safeParse({
        id: "title",
        text: "Hello",
        fontAsset: { ...fontAsset, fingerprint: "invalid" },
      }).success,
    ).toBe(false);
  });
});
