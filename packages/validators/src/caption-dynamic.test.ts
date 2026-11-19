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
  captionTileWordLength,
  fnv1a32,
  getCaptionPresetById,
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
    expect(captionRoleLook(preset, headline, "body", 0, "word")).toEqual({
      font: "text", fontName: "Poppins", transform: "uppercase", letterSpacing: 0.02, color: "#EEEEEE", tileColor: null,
    });
    expect(captionRoleLook(preset, headline, "minor", 0, "word").fontName).toBe("Poppins");
  });

  test("hero-slot roles take case and spacing from the style, the face from heroFontName or the style", () => {
    expect(captionRoleLook(preset, headline, "hero", 0, "word")).toEqual({
      font: "hero", fontName: "Inter", transform: "none", letterSpacing: -0.03, color: "#36B780", tileColor: null,
    });
    expect(captionRoleLook({ ...preset, heroFontName: "Anton" }, headline, "hero", 0, "word").fontName).toBe("Anton");
  });

  test("hero colours alternate by seed; accent falls back to the style, then the highlight", () => {
    const alternating: CaptionDynamicStyle = { ...headline, heroColours: ["highlight", "accent"], accentColor: "#EF8DB9" };
    expect(captionRoleLook(preset, alternating, "hero", 2, "word").color).toBe("#36B780");
    expect(captionRoleLook(preset, alternating, "hero", 3, "word").color).toBe("#EF8DB9");
    expect(captionRoleLook({ ...preset, accentColor: "#123456" }, alternating, "hero", 3, "word").color).toBe("#123456");
    expect(captionRoleLook(preset, { ...alternating, accentColor: undefined }, "hero", 3, "word").color).toBe("#36B780");
  });

  test("Marker's hero alternates yellow and pink by seed", () => {
    const marker = captionPresetSchema.parse({ ...getCaptionPresetById("marker")!.preset });
    expect(captionRoleLook(marker, CAPTION_DYNAMIC_STYLES.marker, "hero", 0, "word").color).toBe("#FFD248");
    expect(captionRoleLook(marker, CAPTION_DYNAMIC_STYLES.marker, "hero", 1, "word").color).toBe("#EF8DB9");
    expect(captionRoleLook(marker, CAPTION_DYNAMIC_STYLES.marker, "body", 1, "word").color).toBe("#FFFFFF");
  });

  test("Cutout's tiles follow letter count: dark tiles with the text colour, accent tiles with dark ink for 1 or 2 letters", () => {
    const cutout = captionPresetSchema.parse({ ...getCaptionPresetById("cutout")!.preset });
    const style = CAPTION_DYNAMIC_STYLES.cutout;
    expect(captionRoleLook(cutout, style, "body", 0, "KEEP")).toMatchObject({ color: "#F5923E", tileColor: "#16161A", fontName: "Anton" });
    // Role does not matter: a 3-letter minor word gets a dark tile, a 2-letter body word a pink one.
    expect(captionRoleLook(cutout, style, "minor", 0, "THE")).toMatchObject({ color: "#F5923E", tileColor: "#16161A" });
    expect(captionRoleLook(cutout, style, "body", 0, "AI")).toMatchObject({ color: "#16161A", tileColor: "#F4B6D2" });
    expect(captionRoleLook(cutout, style, "minor", 0, "IT'S")).toMatchObject({ tileColor: "#16161A" });
    expect(captionRoleLook(cutout, style, "minor", 0, "I")).toMatchObject({ tileColor: "#F4B6D2" });
    expect(captionRoleLook(cutout, style, "body", 0, "50%")).toMatchObject({ tileColor: "#F4B6D2" });
    // The accent follows the user's colour; the literal ink and tile colours are style constants.
    expect(captionRoleLook({ ...cutout, accentColor: "#00FF00", primaryColor: "#FFFFFF" }, style, "minor", 0, "SO")).toMatchObject({ color: "#16161A", tileColor: "#00FF00" });
    expect(captionRoleLook({ ...cutout, primaryColor: "#FFFFFF" }, style, "body", 0, "SHORT").color).toBe("#FFFFFF");
  });

  test("captionTileWordLength counts letters and digits only", () => {
    expect(["SO", "IT'S", "50%", "a", "—", "क़", "今天"].map(captionTileWordLength)).toEqual([2, 3, 2, 1, 0, 1, 2]);
  });

  test("Editorial's body words use the serif hero face in lowercase; minor words the preset's sans", () => {
    const editorial = captionPresetSchema.parse({ ...getCaptionPresetById("editorial")!.preset });
    const style = CAPTION_DYNAMIC_STYLES.editorial;
    expect(captionRoleLook(editorial, style, "body", 0, "word")).toMatchObject({ font: "hero", fontName: "Instrument Serif", transform: "lowercase" });
    expect(captionRoleLook(editorial, style, "minor", 0, "word")).toMatchObject({ font: "text", fontName: "Inter SemiBold" });
  });
});
