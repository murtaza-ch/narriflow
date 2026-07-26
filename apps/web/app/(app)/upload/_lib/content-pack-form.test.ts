import { describe, expect, test } from "bun:test";
import {
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  type ClipLengthPreset,
} from "@narriflow/validators";
import {
  buildUploadGenerationContext,
  buildUploadSettingsFormData,
  readContentPackFromForm,
} from "./content-pack-form";

function baseInput(overrides: Partial<Parameters<typeof buildUploadSettingsFormData>[0]> = {}) {
  return {
    languageCode: "auto",
    mode: "clip" as const,
    clipLengthPreset: "auto" as ClipLengthPreset,
    autoHook: true,
    specificMoments: "",
    processingStartSec: null,
    processingEndSec: null,
    captionPreset: BRAND_DEFAULT_CAPTION_PRESET_ID,
    brandTemplateId: null,
    clipCountTarget: 10,
    platformTargets: ["tiktok", "youtube_shorts", "instagram_reels"] as const,
    autoRenderClips: false,
    toneConstraints: "concise, conversational",
    ...overrides,
  };
}

describe("content pack form parsing", () => {
  test("missing timeframe fields parse as null", () => {
    const contentPack = readContentPackFromForm(new FormData());

    expect(contentPack.processingStartSec).toBeNull();
    expect(contentPack.processingEndSec).toBeNull();
  });

  test("unknown-duration upload settings do not create a one-second window", () => {
    const formData = buildUploadSettingsFormData(baseInput());
    const contentPack = readContentPackFromForm(formData);

    expect(formData.has("processingStartSec")).toBe(false);
    expect(formData.has("processingEndSec")).toBe(false);
    expect(contentPack.processingStartSec).toBeNull();
    expect(contentPack.processingEndSec).toBeNull();
  });

  test("selected caption preset id is preserved", () => {
    const contentPack = readContentPackFromForm(
      buildUploadSettingsFormData(baseInput({ captionPreset: "karaoke" })),
    );

    expect(contentPack.captionPreset).toBe("karaoke");
  });

  test("advanced controls round-trip from upload UI state", () => {
    const contentPack = readContentPackFromForm(
      buildUploadSettingsFormData(
        baseInput({
          clipCountTarget: 22,
          platformTargets: ["tiktok"],
          autoRenderClips: true,
          toneConstraints: "energetic, punchy",
        }),
      ),
    );

    expect(contentPack.clipCountTarget).toBe(22);
    expect(contentPack.platformTargets).toEqual(["tiktok"]);
    expect(contentPack.autoRenderClips).toBe(true);
    expect(contentPack.toneConstraints).toEqual(["energetic", "punchy"]);
  });

  test("maps Auto language mode to null and preserves official manual codes", () => {
    expect(buildUploadGenerationContext(baseInput()).languageCode).toBeNull();
    expect(
      buildUploadGenerationContext(baseInput({ languageCode: "ur" }))
        .languageCode,
    ).toBe("ur");
  });

  test("rejects language codes outside the provider enum", () => {
    expect(() =>
      buildUploadGenerationContext(baseInput({ languageCode: "en-US" })),
    ).toThrow();
  });
});
