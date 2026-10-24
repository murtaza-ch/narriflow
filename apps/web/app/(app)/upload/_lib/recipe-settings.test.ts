import { describe, expect, test } from "bun:test";
import { buildGenerationContentPack } from "@narriflow/validators";
import { buildUploadGenerationContext } from "./content-pack-form";
import { recipeFormSettings } from "./recipe-settings";

const BRAND_PROFILE_ID = "00000000-0000-4000-8000-0000000000b1";

describe("filling the setup form from a Recipe", () => {
  test("maps the Recipe's language, Brand Profile, and clip settings onto the form's fields", () => {
    const contentPack = buildGenerationContentPack({ clipCountTarget: 6, clipLengthPreset: "under_30s", defaultAspectRatio: "1:1", autoHook: false, specificMoments: "the demo", mode: "caption_only" });
    const settings = recipeFormSettings({ languageCode: "es", brandProfileId: BRAND_PROFILE_ID, contentPack: { ...contentPack, toneConstraints: ["punchy", "warm"] } });
    expect(settings).toEqual({
      languageCode: "es",
      brandProfileId: BRAND_PROFILE_ID,
      clip: {
        mode: "caption_only", clipLengthPreset: "under_30s", captionPreset: "brand_default", defaultAspectRatio: "1:1", autoHook: false,
        specificMoments: "the demo", platformTargets: ["tiktok", "youtube_shorts", "instagram_reels"], clipCountTarget: 6, toneConstraints: "punchy, warm",
      },
    });
  });

  test("an undetected language fills as auto, and no Recipe reference or source-specific range travels with the form", () => {
    const settings = recipeFormSettings({ languageCode: null, brandProfileId: null, contentPack: buildGenerationContentPack() });
    expect(settings.languageCode).toBe("auto");
    expect(settings.brandProfileId).toBeNull();
    expect(JSON.stringify(settings)).not.toMatch(/recipe|processingStartSec|processingEndSec/i);
  });

  test("the submitted settings are the explicit ones the form builds, so they equal the Recipe's when untouched", () => {
    const contentPack = buildGenerationContentPack({ clipCountTarget: 8, clipLengthPreset: "30_to_60s", autoHook: false });
    const filled = recipeFormSettings({ languageCode: "en", brandProfileId: null, contentPack: { ...contentPack, toneConstraints: ["concise", "conversational"] } });
    const submitted = buildUploadGenerationContext({
      languageCode: filled.languageCode, mode: filled.clip.mode, clipLengthPreset: filled.clip.clipLengthPreset, autoHook: filled.clip.autoHook, specificMoments: filled.clip.specificMoments,
      processingStartSec: null, processingEndSec: null, captionPreset: filled.clip.captionPreset, brandTemplateId: null, brandProfileId: filled.brandProfileId,
      defaultAspectRatio: filled.clip.defaultAspectRatio, clipCountTarget: filled.clip.clipCountTarget, platformTargets: filled.clip.platformTargets, toneConstraints: filled.clip.toneConstraints,
    });
    expect(submitted.languageCode).toBe("en");
    expect(submitted.contentPack).toMatchObject({ clipCountTarget: 8, clipLengthPreset: "30_to_60s", autoHook: false, defaultAspectRatio: "9:16" });
  });
});
