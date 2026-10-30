import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { create } from "fontkit";
import { CAPTION_FALLBACK_FONTS, captionFallbackFontPath, fontFileCovers } from "./fallback-fonts";
import { captionCodePointLabel, captionUndrawableCodePoints } from "./glyph-coverage";

describe("caption glyph coverage", () => {
  test("ordinary text, other scripts, symbols and emoji are drawable", () => {
    expect(captionUndrawableCodePoints("Hello, world 123 — “quotes”")).toEqual([]);
    expect(captionUndrawableCodePoints("Привет مرحبا שלום हिन्दी สวัสดี 你好 こんにちは 안녕")).toEqual([]);
    expect(captionUndrawableCodePoints("★ 💰 👍🏽 ❤️ ‍\n")).toEqual([]);
  });

  test("code points no face draws are named once, in order", () => {
    expect(captionUndrawableCodePoints("a\u{13000}b\u{13001}\u{13000}")).toEqual(["U+13000", "U+13001"]);
    expect(captionCodePointLabel(0x41)).toBe("U+0041");
  });

  test("the table agrees with real font shaping for a sample of each face", () => {
    const chain = CAPTION_FALLBACK_FONTS.map(captionFallbackFontPath);
    for (const path of chain) {
      const face = create(readFileSync(path)) as unknown as { characterSet: number[] };
      const sample = face.characterSet.filter((_, index) => index % 97 === 0).slice(0, 60);
      for (const codePoint of sample) {
        const character = String.fromCodePoint(codePoint);
        if (character.trim() === "" || codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) continue;
        expect(chain.some((candidate) => fontFileCovers(candidate, character))).toBe(true);
        expect(captionUndrawableCodePoints(character)).toEqual([]);
      }
    }
    for (const codePoint of [0x13000, 0x10ffff, 0xe000]) {
      expect(chain.some((path) => fontFileCovers(path, String.fromCodePoint(codePoint)))).toBe(false);
      expect(captionUndrawableCodePoints(String.fromCodePoint(codePoint))).toHaveLength(1);
    }
  });
});
