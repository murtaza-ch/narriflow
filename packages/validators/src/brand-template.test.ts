import { describe, expect, test } from "bun:test";

import { applyBrandColorsToCaption, brandColorsFromCaption } from "./brand-template";
import { CAPTION_DYNAMIC_STYLES, captionStyleDrawsHero, captionStyleUsesAccent, type CaptionDynamicStyle } from "./caption-dynamic";
import { CAPTION_PRESETS, getCaptionPresetById, matchCaptionPreset } from "./caption-preset";
import { CAPTION_SCENES, CAPTION_SCENE_NAMES, type CaptionSceneName, captionColourContrast } from "./caption-scene";
import { captionPresetSchema } from "./clip";

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
    const withAccent = CAPTION_PRESETS.find((named) => named.preset.dynamic && captionStyleUsesAccent(CAPTION_DYNAMIC_STYLES[named.preset.dynamic]) && captionStyleDrawsHero(CAPTION_DYNAMIC_STYLES[named.preset.dynamic]));
    if (!withAccent) return;
    const branded = applyBrandColorsToCaption(withAccent.preset, "#112233", "#445566");
    expect(branded.primaryColor).toBe(withAccent.preset.primaryColor);
    expect(branded.highlightColor).toBe("#112233");
    expect(branded.accentColor).toBe("#445566");
  });

  test("a style without a hero (Cutout) takes the primary as its text colour, not the unused hero colour", () => {
    const cutout = getCaptionPresetById("cutout")!.preset;
    expect(captionStyleDrawsHero(CAPTION_DYNAMIC_STYLES.cutout)).toBe(false);
    const branded = applyBrandColorsToCaption(cutout, "#112233", "#445566");
    expect(branded.primaryColor).toBe("#112233");
    expect(branded.highlightColor).toBe(cutout.highlightColor);
    expect(branded.accentColor).toBe("#445566");
    expect(brandColorsFromCaption(branded)).toEqual({ primaryColor: "#112233", secondaryColor: "#445566" });
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
        tile: { fill: "accent", tiltsDeg: [0], radiusEm: 0.05, padXEm: 0.12, padYEm: 0.08, gapEm: 0.08, shadowEm: 0 },
      }),
    ).toBe(true);
    expect(
      captionStyleUsesAccent({
        ...base,
        tile: { fill: "#16161A", short: { maxLetters: 2, fill: "accent", ink: "#16161A" }, tiltsDeg: [0], radiusEm: 0.05, padXEm: 0.12, padYEm: 0.08, gapEm: 0.08, shadowEm: 0 },
      }),
    ).toBe(true);
  });
});

describe("Scene Styles take brand colours through their own colour meaning", () => {
  type Preset = ReturnType<typeof getCaptionPresetById> extends infer T ? NonNullable<T>["preset"] : never;
  const WHITE = "#FFFFFF";
  /** The fixed plate (or ink on a plate) behind each text a Scene Style draws on a plate of its own: [ink, plate]. */
  const plates: Partial<Record<CaptionSceneName, (preset: Preset) => [string, string][]>> = {
    // Dialogue: dark ink on the light bubble and on the highlight marker; white text on the accent bubble.
    dialogue: (p) => [[p.primaryColor, "#F2F2F4"], [p.primaryColor, p.highlightColor], [WHITE, p.accentColor!]],
    // Dossier: ink on the paper and the stamp's colour on the paper.
    dossier: (p) => [[p.primaryColor, p.accentColor!], [p.highlightColor, p.accentColor!]],
    // Bulletin: the accent is the ink of a plain plate, and the white ink of the hero and tail plates.
    bulletin: (p) => [[p.accentColor!, p.primaryColor], [WHITE, p.highlightColor], [WHITE, p.accentColor!]],
    ticker: (p) => [[p.accentColor!, p.highlightColor]],
    flap: (p) => [[p.primaryColor, p.accentColor!]],
    // Spine: ink on the white plates.
    spine: (p) => [[p.primaryColor, p.accentColor!]],
    index: (p) => [[p.primaryColor, p.accentColor!], [p.accentColor!, p.highlightColor], [p.highlightColor, p.accentColor!]],
    velocity: (p) => [[p.accentColor!, p.highlightColor]],
  };
  const scenePresets = CAPTION_SCENE_NAMES.map((name) => ({ name, preset: getCaptionPresetById(name)!.preset }));

  test("every Scene Style states what its brand colours colour, and ink on a fixed plate is never a target", () => {
    for (const name of CAPTION_SCENE_NAMES) {
      const { brand } = CAPTION_SCENES[name];
      for (const target of [brand.primary, brand.secondary]) {
        if (target?.slot) expect(["primaryColor", "highlightColor", "accentColor"]).toContain(target.slot);
      }
      // The two brand colours go to two different slots.
      if (brand.primary && brand.secondary) expect(brand.primary.slot).not.toBe(brand.secondary.slot);
    }
    // Dialogue's and Dossier's primary slot is ink on a fixed light plate: no brand colour reaches it.
    expect(CAPTION_SCENES.dialogue.brand.primary?.slot).not.toBe("primaryColor");
    expect(CAPTION_SCENES.dossier.brand.primary).toBeNull();
    expect(CAPTION_SCENES.dossier.brand.secondary?.slot).not.toBe("primaryColor");
  });

  test.each(scenePresets)("$name: the catalog look reads on its own plates", ({ name, preset }) => {
    for (const [ink, plate] of plates[name]?.(preset) ?? []) expect(captionColourContrast(ink, plate)).toBeGreaterThanOrEqual(3);
  });

  for (const [label, primary, secondary] of [["white and bright green", "#FFFFFF", "#00FF88"], ["black and red", "#000000", "#FF0000"], ["navy and orange", "#10243E", "#FF8A00"]] as const) {
    test.each(scenePresets)(`$name: ${label} brand colours leave its text readable on its plates`, ({ name, preset }) => {
      const branded = applyBrandColorsToCaption(preset, primary, secondary);
      for (const [ink, plate] of plates[name]?.(branded) ?? []) expect(captionColourContrast(ink, plate)).toBeGreaterThanOrEqual(3);
      // Only the colours the style names change.
      const { brand } = CAPTION_SCENES[name];
      const slots = new Set([brand.primary?.slot, brand.secondary?.slot]);
      for (const slot of ["primaryColor", "highlightColor", "accentColor"] as const) {
        if (!slots.has(slot)) expect(branded[slot]).toBe(preset[slot]);
      }
      expect(captionPresetSchema.parse(branded).scene).toBe(name);
    });
  }

  test("Dialogue and Dossier keep their dark ink under a white brand, and take a colour that reads", () => {
    const dialogue = getCaptionPresetById("dialogue")!.preset;
    const white = applyBrandColorsToCaption(dialogue, "#FFFFFF", "#00FF88");
    expect(white.primaryColor).toBe(dialogue.primaryColor);
    // White would draw the bubble's white text on a white bubble: the accent stays blue.
    expect(white.accentColor).toBe(dialogue.accentColor);
    // Bright green marks under dark ink.
    expect(white.highlightColor).toBe("#00FF88");
    const navy = applyBrandColorsToCaption(dialogue, "#10243E", "#FF8A00");
    expect(navy.accentColor).toBe("#10243E");
    const dossier = getCaptionPresetById("dossier")!.preset;
    const stamped = applyBrandColorsToCaption(dossier, "#FFFFFF", "#00FF88");
    expect(stamped.primaryColor).toBe(dossier.primaryColor);
    // Bright green on cream paper does not read: the red stamp stays.
    expect(stamped.highlightColor).toBe(dossier.highlightColor);
    expect(applyBrandColorsToCaption(dossier, "#FFFFFF", "#7A0019").highlightColor).toBe("#7A0019");
  });

  test("a Scene Style's own colours round-trip, so the look still matches the catalog", () => {
    for (const { name, preset } of scenePresets) {
      const { primaryColor, secondaryColor } = brandColorsFromCaption(preset);
      expect(applyBrandColorsToCaption(preset, primaryColor, secondaryColor)).toEqual(preset);
      expect(matchCaptionPreset(applyBrandColorsToCaption(preset, primaryColor, secondaryColor))?.id).toBe(name);
    }
  });

  test("the brand colours of a branded look read back", () => {
    const lyrics = applyBrandColorsToCaption(getCaptionPresetById("lyrics")!.preset, "#FFFFFF", "#00FF88");
    expect(brandColorsFromCaption(lyrics)).toEqual({ primaryColor: "#FFFFFF", secondaryColor: "#00FF88" });
  });
});
