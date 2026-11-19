import { describe, expect, test } from "bun:test";
import {
  CAPTION_DYNAMIC_NAMES,
  CAPTION_DYNAMIC_STYLES,
  CAPTION_MOTIONS,
  type CaptionDynamicStyle,
  captionBlockAnimation,
  captionBlockRows,
  captionBlockSeed,
  captionBlockWordsPerCue,
  captionClassicAnimation,
  captionPresetSchema,
  captionRoleLook,
  fnv1a32,
} from ".";

const headline = CAPTION_DYNAMIC_STYLES.headline;
const rowStyle: CaptionDynamicStyle = { ...headline, layout: "row" };

describe("captionBlockRows", () => {
  test("stack: lead row, the hero alone, tail row, in spoken order", () => {
    expect(captionBlockRows(["minor", "hero", "body"], [1, 1], headline)).toEqual([[0], [1], [2]]);
    expect(captionBlockRows(["minor", "body", "hero", "hero"], [2, 3], headline)).toEqual([[0, 1], [2, 3]]);
  });

  test("stack drops empty lead and tail rows", () => {
    expect(captionBlockRows(["hero", "body", "minor"], [0, 0], headline)).toEqual([[0], [1, 2]]);
    expect(captionBlockRows(["body", "hero"], [1, 1], headline)).toEqual([[0], [1]]);
    expect(captionBlockRows(["hero"], [0, 0], headline)).toEqual([[0]]);
  });

  test("a cue without a hero, and the row layout, are one row", () => {
    expect(captionBlockRows(["body", "minor", "body"], null, headline)).toEqual([[0, 1, 2]]);
    expect(captionBlockRows(["minor", "hero", "body"], [1, 1], rowStyle)).toEqual([[0, 1, 2]]);
    expect(captionBlockRows([], null, headline)).toEqual([]);
  });
});

describe("captionBlockSeed", () => {
  test("is FNV-1a of the first word's key, else of the cue index", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(captionBlockSeed("12340", 7)).toBe(fnv1a32("12340"));
    expect(captionBlockSeed(null, 7)).toBe(fnv1a32("7"));
  });

  test("depends only on the first word's key, so cuts elsewhere never reshuffle a cue", () => {
    expect(captionBlockSeed("12340", 0)).toBe(captionBlockSeed("12340", 9));
    expect(captionBlockSeed("12340", 0)).not.toBe(captionBlockSeed("12341", 0));
  });
});

describe("captionClassicAnimation", () => {
  test("a classic preset draws dynamic-only motions as fade and keeps every other motion", () => {
    expect(captionClassicAnimation({ animation: "slide" })).toBe("fade");
    for (const name of Object.keys(CAPTION_MOTIONS) as (keyof typeof CAPTION_MOTIONS)[]) {
      const motion = CAPTION_MOTIONS[name] as (typeof CAPTION_MOTIONS)[keyof typeof CAPTION_MOTIONS] & { hero?: unknown };
      const dynamicOnly = motion.hero !== undefined || motion.word.some((frame) => "offsetXEm" in frame || "rotateZDeg" in frame);
      expect(captionClassicAnimation({ animation: name })).toBe(dynamicOnly ? "fade" : name);
    }
  });
});

describe("captionBlockAnimation", () => {
  test("keeps word-reveal motions without an effect", () => {
    for (const name of ["slide", "rise", "blur", "punch", "bounce", "flip", "fade"] as const) {
      expect(captionBlockAnimation({ animation: name }, headline)).toBe(name);
    }
  });

  test("falls back to the style's motion for cue reveals, effects and jelly", () => {
    for (const name of ["pop", "none", "focus", "karaoke", "neon", "glitch", "typewriter", "jelly"] as const) {
      expect(captionBlockAnimation({ animation: name }, headline)).toBe(headline.defaultMotion);
    }
  });

  test("every style's default motion can drive a block", () => {
    for (const name of CAPTION_DYNAMIC_NAMES) {
      const style = CAPTION_DYNAMIC_STYLES[name];
      const motion = CAPTION_MOTIONS[style.defaultMotion];
      expect(motion.reveal).toBe("word");
      expect(captionBlockAnimation({ animation: style.defaultMotion }, style)).toBe(style.defaultMotion);
    }
  });
});

test("captionBlockWordsPerCue clamps to 2..5", () => {
  expect([1, 2, 4, 5].map(captionBlockWordsPerCue)).toEqual([2, 2, 4, 5]);
});

describe("captionRoleLook", () => {
  const preset = captionPresetSchema.parse({
    dynamic: "headline", fontName: "Poppins", textTransform: "uppercase", letterSpacing: 0.02,
    primaryColor: "#EEEEEE", highlightColor: "#36B780",
  });

  test("text-slot roles inherit the preset's face, case and spacing", () => {
    expect(captionRoleLook(preset, headline, "body", 0)).toEqual({
      font: "text", fontName: "Poppins", transform: "uppercase", letterSpacing: 0.02, color: "#EEEEEE",
    });
    expect(captionRoleLook(preset, headline, "minor", 0).fontName).toBe("Poppins");
  });

  test("hero-slot roles take case and spacing from the style, the face from heroFontName or the style", () => {
    expect(captionRoleLook(preset, headline, "hero", 0)).toEqual({
      font: "hero", fontName: "Inter", transform: "none", letterSpacing: -0.03, color: "#36B780",
    });
    expect(captionRoleLook({ ...preset, heroFontName: "Anton" }, headline, "hero", 0).fontName).toBe("Anton");
  });

  test("hero colours alternate by seed; accent falls back to the style, then the highlight", () => {
    const alternating: CaptionDynamicStyle = { ...headline, heroColours: ["highlight", "accent"], accentColor: "#EF8DB9" };
    expect(captionRoleLook(preset, alternating, "hero", 2).color).toBe("#36B780");
    expect(captionRoleLook(preset, alternating, "hero", 3).color).toBe("#EF8DB9");
    expect(captionRoleLook({ ...preset, accentColor: "#123456" }, alternating, "hero", 3).color).toBe("#123456");
    expect(captionRoleLook(preset, { ...alternating, accentColor: undefined }, "hero", 3).color).toBe("#36B780");
  });
});
