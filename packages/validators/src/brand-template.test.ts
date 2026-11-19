import { describe, expect, test } from "bun:test";

import { applyBrandColorsToCaption, brandColorsFromCaption } from "./brand-template";
import { CAPTION_DYNAMIC_STYLES, captionStyleUsesAccent, type CaptionDynamicStyle } from "./caption-dynamic";
import { CAPTION_PRESETS, getCaptionPresetById, matchCaptionPreset } from "./caption-preset";

const headline = getCaptionPresetById("headline")!.preset;
const boldPop = getCaptionPresetById("bold-pop")!.preset;

describe("applyBrandColorsToCaption", () => {
  test("classic styles: primary is the text, secondary the highlight", () => {
    const branded = applyBrandColorsToCaption(boldPop, "#112233", "#445566");
    expect(branded.primaryColor).toBe("#112233");
    expect(branded.highlightColor).toBe("#445566");
    expect(branded.outlineColor).toBe(boldPop.outlineColor);
  });

  test("dynamic styles keep the support colour and put the primary on the hero", () => {
    const branded = applyBrandColorsToCaption(headline, "#112233", "#445566");
    expect(branded.primaryColor).toBe(headline.primaryColor);
    expect(branded.highlightColor).toBe("#112233");
    // Headline draws nothing in the accent slot, so the preset gains no accent.
    expect(branded.accentColor).toBeUndefined();
  });

  test("styles with an accent slot take the secondary as the accent", () => {
    const withAccent = CAPTION_PRESETS.find((named) => named.preset.dynamic && captionStyleUsesAccent(CAPTION_DYNAMIC_STYLES[named.preset.dynamic]));
    if (!withAccent) return;
    const branded = applyBrandColorsToCaption(withAccent.preset, "#112233", "#445566");
    expect(branded.primaryColor).toBe(withAccent.preset.primaryColor);
    expect(branded.highlightColor).toBe("#112233");
    expect(branded.accentColor).toBe("#445566");
  });

  test("a catalog look's own colours round-trip, so the look still matches the catalog", () => {
    for (const named of CAPTION_PRESETS) {
      const { primaryColor, secondaryColor } = brandColorsFromCaption(named.preset);
      const branded = applyBrandColorsToCaption(named.preset, primaryColor, secondaryColor);
      expect(matchCaptionPreset(branded)?.id).toBe(named.id);
    }
  });
});

describe("captionStyleUsesAccent", () => {
  const base: CaptionDynamicStyle = CAPTION_DYNAMIC_STYLES.headline;

  test("Headline has no accent slot", () => {
    expect(captionStyleUsesAccent(base)).toBe(false);
  });

  test("finds the accent in a role, a hero alternation or a tile fill", () => {
    expect(captionStyleUsesAccent({ ...base, roles: { ...base.roles, minor: { ...base.roles.minor, colour: "accent" } } })).toBe(true);
    expect(captionStyleUsesAccent({ ...base, heroColours: ["highlight", "accent"] })).toBe(true);
    expect(
      captionStyleUsesAccent({
        ...base,
        tile: { fill: { minor: "#F4B6D2", body: "accent", hero: "#16161A" }, tiltsDeg: [0], radiusEm: 0.05, padXEm: 0.12, padYEm: 0.08 },
      }),
    ).toBe(true);
  });
});
