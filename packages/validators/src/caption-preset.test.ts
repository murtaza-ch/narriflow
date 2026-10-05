import { describe, expect, test } from "bun:test";
import {
  CAPTION_PRESET_GROUPS,
  CAPTION_PRESETS,
  DEFAULT_CAPTION_PRESET,
  applyCaptionPresetLook,
  applyCaptionTextTransform,
  captionPresetIdSchema,
  captionPresetSchema,
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
  test("has 24 presets with unique ids and names in every group", () => {
    expect(CAPTION_PRESETS).toHaveLength(24);
    expect(new Set(CAPTION_PRESETS.map((named) => named.id)).size).toBe(24);
    expect(new Set(CAPTION_PRESETS.map((named) => named.name)).size).toBe(24);
    for (const group of CAPTION_PRESET_GROUPS) {
      expect(CAPTION_PRESETS.filter((named) => named.group === group)).toHaveLength(6);
    }
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
