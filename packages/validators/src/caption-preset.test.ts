import { describe, expect, test } from "bun:test";
import { captionPresetSchema, CAPTION_PRESETS, formatCaptionWord } from ".";

describe("captionPresetSchema defaults (preview == export)", () => {
  test("fills letterSpacing + textTransform to match the studio preview fallbacks", () => {
    // The studio preview falls back to 0.04 / "uppercase" when unset; the schema
    // must apply the same defaults so the burned export looks identical.
    const parsed = captionPresetSchema.parse({});
    expect(parsed.letterSpacing).toBe(0.04);
    expect(parsed.textTransform).toBe("uppercase");
  });

  test("every built-in preset sets both fields explicitly", () => {
    for (const { preset } of CAPTION_PRESETS) {
      expect(preset.letterSpacing).toBeDefined();
      expect(preset.textTransform).toBeDefined();
    }
  });

  test("visible and punctuation default to absent (shown / kept)", () => {
    const parsed = captionPresetSchema.parse({});
    expect(parsed.visible).toBeUndefined();
    expect(parsed.punctuation).toBeUndefined();
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
