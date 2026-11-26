import { describe, expect, test } from "bun:test";
import { buildGenerationContentPack } from "@narriflow/validators";
import { recipeFormSettings } from "./recipe-settings";
import { buildLinkContentPack, DEFAULT_LINK_CONFIGURE_STATE, linkConfigureStateFromContentPack, type LinkConfigureState } from "./link-content-pack";

const fresh: LinkConfigureState = { ...DEFAULT_LINK_CONFIGURE_STATE, mode: "clip", processingStartSec: null, processingEndSec: null };

describe("link import Configure state", () => {
  test("Add emojis starts off and reaches the Content Pack the step submits", () => {
    expect(fresh.addEmojis).toBe(false);
    expect(buildLinkContentPack(fresh).addEmojis).toBe(false);
    expect(buildLinkContentPack({ ...fresh, addEmojis: true }).addEmojis).toBe(true);
  });

  test("a resumed import reopens with the settings it saved, Add emojis included", () => {
    const saved = buildLinkContentPack({ ...fresh, addEmojis: true, removeFillerWords: true, captionPreset: "karaoke", processingStartSec: 5, processingEndSec: 65 });
    const resumed = linkConfigureStateFromContentPack(saved);
    expect(resumed).toEqual({ ...fresh, addEmojis: true, removeFillerWords: true, captionPreset: "karaoke", processingStartSec: 5, processingEndSec: 65 });
    expect(buildLinkContentPack(resumed)).toEqual(saved);
  });

  test("applying a Recipe fills Add emojis into the step", () => {
    const { clip } = recipeFormSettings({ languageCode: null, brandProfileId: null, contentPack: buildGenerationContentPack({ addEmojis: true }) });
    expect(buildLinkContentPack({ ...fresh, ...clip }).addEmojis).toBe(true);
  });
});
