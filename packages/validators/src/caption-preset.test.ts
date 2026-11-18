import { describe, expect, test } from "bun:test";
import {
  CAPTION_DYNAMIC_STYLES,
  CAPTION_PRESET_GROUPS,
  CAPTION_PRESETS,
  DEFAULT_CAPTION_PRESET,
  applyCaptionPresetLook,
  applyCaptionTextTransform,
  captionBlockAnimation,
  captionPresetIdSchema,
  captionPresetSchema,
  captionPresetsEqual,
  formatCaptionWord,
  matchCaptionPreset,
} from ".";

describe("captionPresetSchema defaults", () => {
  test("the schema defaults are the Bold Pop preset", () => {
    const boldPop = CAPTION_PRESETS.find((named) => named.id === "bold-pop")!;
    expect(captionPresetSchema.parse({})).toEqual(boldPop.preset);
    expect(DEFAULT_CAPTION_PRESET).toEqual(boldPop.preset);
  });

  test("visible and punctuation default to absent (shown / kept)", () => {
    const parsed = captionPresetSchema.parse({});
    expect(parsed.visible).toBeUndefined();
    expect(parsed.punctuation).toBeUndefined();
  });

  test("rejects fonts outside the vendored catalog and retired shapes", () => {
    expect(captionPresetSchema.safeParse({ fontName: "Impact" }).success).toBe(false);
    expect(captionPresetSchema.safeParse({ shadow: 1 }).success).toBe(false);
    expect(captionPresetSchema.safeParse({ animation: "word-by-word" }).success).toBe(false);
  });
});

describe("caption preset catalog", () => {
  test("has 25 presets with unique ids and names, the Dynamic group first", () => {
    expect(CAPTION_PRESETS).toHaveLength(25);
    expect(new Set(CAPTION_PRESETS.map((named) => named.id)).size).toBe(25);
    expect(new Set(CAPTION_PRESETS.map((named) => named.name)).size).toBe(25);
    expect(CAPTION_PRESET_GROUPS[0]).toBe("Dynamic");
    expect(CAPTION_PRESETS[0]!.group).toBe("Dynamic");
    for (const group of CAPTION_PRESET_GROUPS.filter((name) => name !== "Dynamic")) {
      expect(CAPTION_PRESETS.filter((named) => named.group === group)).toHaveLength(6);
    }
  });

  test("Dynamic group presets, and only they, set a Dynamic Style", () => {
    const dynamic = CAPTION_PRESETS.filter((named) => named.group === "Dynamic");
    expect(dynamic.map((named) => named.id)).toEqual(["headline"]);
    for (const named of CAPTION_PRESETS) {
      expect(named.preset.dynamic !== undefined).toBe(named.group === "Dynamic");
    }
    for (const named of dynamic) {
      const style = CAPTION_DYNAMIC_STYLES[named.preset.dynamic!];
      // The catalog motion drives the block itself rather than falling back.
      expect(captionBlockAnimation(named.preset, style)).toBe(named.preset.animation);
      expect(named.preset.wordsPerCue).toBeGreaterThanOrEqual(2);
      expect(named.preset.wordsPerCue).toBeLessThanOrEqual(5);
    }
  });

  test("Headline follows the section 6 catalog row", () => {
    const headline = CAPTION_PRESETS.find((named) => named.id === "headline")!.preset;
    expect(headline).toMatchObject({
      dynamic: "headline", fontName: "Inter SemiBold", fontSize: 80, textTransform: "none",
      primaryColor: "#FFFFFF", highlightColor: "#36B780", outlineWidth: 0, shadow: "soft", animation: "slide", wordsPerCue: 4,
    });
    const style = CAPTION_DYNAMIC_STYLES.headline;
    expect(style.roles.minor.sizeEm).toBe(style.roles.body.sizeEm);
    expect(style.heroFill).toEqual({ widthFraction: 0.8, minEm: 2.2, maxEm: 3.4 });
    expect(style.roles.hero).toMatchObject({ font: "hero", letterSpacing: -0.03, transform: "none", colour: "highlight" });
    expect(style.heroFontName).toBe("Inter");
    expect(style.rowGapEm).toBe(0.06);
    expect(style.softShadow).toEqual({ offsetYEm: 0.025, blurEm: 0.0375, opacity: 0.65 });
  });

  test("dynamic preset fields are optional and range-checked", () => {
    const parsed = captionPresetSchema.parse({});
    for (const key of ["dynamic", "heroFontName", "accentColor", "emphasisScale", "curve", "heroBehind"] as const) {
      expect(parsed[key]).toBeUndefined();
    }
    expect(captionPresetSchema.safeParse({ dynamic: "headline", heroFontName: "Anton", accentColor: "#112233", emphasisScale: 1.2, curve: -0.5, heroBehind: true }).success).toBe(true);
    expect(captionPresetSchema.safeParse({ dynamic: "nope" }).success).toBe(false);
    expect(captionPresetSchema.safeParse({ heroFontName: "Impact" }).success).toBe(false);
    expect(captionPresetSchema.safeParse({ emphasisScale: 0.6 }).success).toBe(false);
    expect(captionPresetSchema.safeParse({ emphasisScale: 1.5 }).success).toBe(false);
    expect(captionPresetSchema.safeParse({ curve: 1.1 }).success).toBe(false);
    expect(captionPresetSchema.safeParse({ accentColor: "red" }).success).toBe(false);
  });

  test("equality and matching see the dynamic fields", () => {
    const headline = CAPTION_PRESETS.find((named) => named.id === "headline")!;
    expect(captionPresetsEqual(headline.preset, { ...headline.preset })).toBe(true);
    expect(captionPresetsEqual(headline.preset, { ...headline.preset, heroFontName: "Anton" })).toBe(false);
    expect(captionPresetsEqual(headline.preset, { ...headline.preset, curve: 0.3 })).toBe(false);
    expect(matchCaptionPreset({ ...headline.preset, positionY: 40 })?.id).toBe("headline");
    expect(matchCaptionPreset({ ...headline.preset, emphasisScale: 1.2 })).toBeUndefined();
    expect(matchCaptionPreset({ ...headline.preset, dynamic: undefined })).toBeUndefined();
    const boldPop = CAPTION_PRESETS.find((named) => named.id === "bold-pop")!;
    expect(applyCaptionPresetLook({ ...headline.preset, positionY: 40 }, boldPop)).toEqual({ ...boldPop.preset, positionY: 40 });
  });

  test("keeps the classic presets by id so stored references stay valid", () => {
    for (const id of ["karaoke", "highlighter", "frosted-glass", "street", "electric"]) {
      expect(captionPresetIdSchema.safeParse(id).success).toBe(true);
    }
  });

  test("every preset is in canonical parsed form", () => {
    for (const named of CAPTION_PRESETS) {
      expect(captionPresetSchema.parse(named.preset)).toEqual(named.preset);
    }
  });

  test("matchCaptionPreset recognises each preset and ignores placement", () => {
    for (const named of CAPTION_PRESETS) {
      expect(matchCaptionPreset(named.preset)?.id).toBe(named.id);
      const placed = { ...named.preset, position: "top" as const, positionX: 30, positionY: 40, emojis: true };
      expect(matchCaptionPreset(placed)?.id).toBe(named.id);
    }
  });

  test("matchCaptionPreset stops matching once the look is edited", () => {
    const boldPop = CAPTION_PRESETS.find((named) => named.id === "bold-pop")!;
    expect(matchCaptionPreset({ ...boldPop.preset, fontSize: 90 })).toBeUndefined();
    expect(matchCaptionPreset({ ...boldPop.preset, glowColor: "#FF00FF" })).toBeUndefined();
  });

  test("applyCaptionPresetLook replaces the look and keeps placement and toggles", () => {
    const neon = CAPTION_PRESETS.find((named) => named.id === "neon")!;
    const current = { ...DEFAULT_CAPTION_PRESET, position: "top" as const, positionX: 41, positionY: 19, visible: false, punctuation: false };
    const applied = applyCaptionPresetLook(current, neon);
    expect(matchCaptionPreset(applied)?.id).toBe("neon");
    expect(applied).toMatchObject({ position: "top", positionX: 41, positionY: 19, visible: false, punctuation: false });
  });
});

describe("applyCaptionTextTransform", () => {
  test("capitalizes word starts without capitalizing after apostrophes", () => {
    expect(applyCaptionTextTransform("don't", "capitalize")).toBe("Don't");
    expect(applyCaptionTextTransform("state-of-the-art", "capitalize")).toBe("State-Of-The-Art");
    expect(applyCaptionTextTransform("élan", "capitalize")).toBe("Élan");
  });

  test("upper, lower and none", () => {
    expect(applyCaptionTextTransform("Make It", "uppercase")).toBe("MAKE IT");
    expect(applyCaptionTextTransform("Make It", "lowercase")).toBe("make it");
    expect(applyCaptionTextTransform("Make It", "none")).toBe("Make It");
  });
});

describe("formatCaptionWord (vizard-parity Phase C — punctuation on/off)", () => {
  test("passes the word through unchanged when punctuation is on", () => {
    expect(formatCaptionWord("don't,", { punctuation: true })).toBe("don't,");
    expect(formatCaptionWord("...", { punctuation: true })).toBe("...");
  });

  test("strips trailing punctuation but preserves an intra-word apostrophe", () => {
    expect(formatCaptionWord("don't,", { punctuation: false })).toBe("don't");
  });

  test("strips a trailing period but preserves intra-word hyphens", () => {
    expect(formatCaptionWord("state-of-the-art.", { punctuation: false })).toBe(
      "state-of-the-art",
    );
  });

  test("strips leading and trailing quotes", () => {
    expect(formatCaptionWord('"Hello"', { punctuation: false })).toBe("Hello");
    expect(formatCaptionWord("“Hello”", { punctuation: false })).toBe("Hello");
    expect(formatCaptionWord("'Hello'", { punctuation: false })).toBe("Hello");
  });

  test("collapses a pure-punctuation token to empty string", () => {
    expect(formatCaptionWord("...", { punctuation: false })).toBe("");
    expect(formatCaptionWord("—", { punctuation: false })).toBe("");
    expect(formatCaptionWord("!?", { punctuation: false })).toBe("");
  });

  test("strips a trailing unicode ellipsis", () => {
    expect(formatCaptionWord("wait…", { punctuation: false })).toBe("wait");
  });

  test("strips surrounding em-dashes", () => {
    expect(formatCaptionWord("—wait—", { punctuation: false })).toBe("wait");
  });

  test("leaves an ordinary word untouched", () => {
    expect(formatCaptionWord("hello", { punctuation: false })).toBe("hello");
  });

  test("preserves a mid-word apostrophe with no edge punctuation", () => {
    expect(formatCaptionWord("y'all", { punctuation: false })).toBe("y'all");
  });
});
