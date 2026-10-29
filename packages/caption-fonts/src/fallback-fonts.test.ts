import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { create } from "fontkit";
import { CAPTION_FALLBACK_FONTS, captionFallbackFontPath, fontFileCovers, fontFileLineHeightEm } from "./fallback-fonts";

const lock = JSON.parse(readFileSync(new URL("../../../apps/worker/runtime-lock.json", import.meta.url), "utf8")) as {
  fallbackFonts: { sha256: Record<string, string> };
};

describe("pinned glyph fallback fonts", () => {
  test("every file exists, is pinned by the runtime lock, and carries the name libass matches", () => {
    expect(Object.keys(lock.fallbackFonts.sha256).sort()).toEqual(CAPTION_FALLBACK_FONTS.map((font) => font.file).sort());
    for (const font of CAPTION_FALLBACK_FONTS) {
      const path = captionFallbackFontPath(font);
      expect(existsSync(path)).toBe(true);
      expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(lock.fallbackFonts.sha256[font.file]!);
      const face = create(readFileSync(path)) as { fullName: string };
      expect(face.fullName).toBe(font.assName);
      expect(fontFileLineHeightEm(path)).toBeGreaterThan(1);
    }
  });

  test("the chain covers RTL, Indic, Thai, CJK, symbols and monochrome emoji by real shaping", () => {
    const chain = CAPTION_FALLBACK_FONTS.map(captionFallbackFontPath);
    const covered = (text: string) => chain.some((path) => fontFileCovers(path, text));
    for (const text of ["Привет", "Ελλάδα", "مرحبا بكم", "שלום", "हिन्दी", "สวัสดี", "你好世界", "こんにちは", "안녕하세요", "★", "💰", "👍🏽", "🇵"]) {
      expect(covered(text)).toBe(true);
    }
    // Egyptian hieroglyphs are in none of the pinned faces.
    expect(covered("\u{13000}")).toBe(false);
  });
});
