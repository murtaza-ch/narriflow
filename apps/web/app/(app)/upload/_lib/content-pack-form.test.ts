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
    removeSilences: false,
    removeFillerWords: false,
    addEmojis: false,
    specificMoments: "",
    processingStartSec: null,
    processingEndSec: null,
    captionPreset: BRAND_DEFAULT_CAPTION_PRESET_ID,
    brandTemplateId: null,
    clipCountTarget: 10,
    platformTargets: ["tiktok", "youtube_shorts", "instagram_reels"] as const,
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
          toneConstraints: "energetic, punchy",
        }),
      ),
    );

    expect(contentPack.clipCountTarget).toBe(22);
    expect(contentPack.platformTargets).toEqual(["tiktok"]);
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

test("local upload preserves aspect ratio and an explicitly disabled hook", () => {
  const context = buildUploadGenerationContext(baseInput({ defaultAspectRatio: "1:1", autoHook: false }));
  expect(context.contentPack.defaultAspectRatio).toBe("1:1");
  expect(context.contentPack.autoHook).toBe(false);
});

test("silence and filler-word removal default off and travel through the form", () => {
  expect(buildUploadGenerationContext(baseInput()).contentPack).toMatchObject({ removeSilences: false, removeFillerWords: false });
  const on = buildUploadGenerationContext(baseInput({ removeSilences: true, removeFillerWords: true }));
  expect(on.contentPack).toMatchObject({ removeSilences: true, removeFillerWords: true });
  expect(readContentPackFromForm(new FormData()).removeSilences).toBe(false);
});

test("Add emojis defaults off and travels through the form", () => {
  expect(buildUploadGenerationContext(baseInput()).contentPack.addEmojis).toBe(false);
  expect(buildUploadGenerationContext(baseInput({ addEmojis: true })).contentPack.addEmojis).toBe(true);
  expect(readContentPackFromForm(new FormData()).addEmojis).toBe(false);
  // The regenerate form posts the switch as a hidden "true"/"false" field.
  const regenerate = new FormData();
  regenerate.set("addEmojis", "true");
  expect(readContentPackFromForm(regenerate).addEmojis).toBe(true);
});
