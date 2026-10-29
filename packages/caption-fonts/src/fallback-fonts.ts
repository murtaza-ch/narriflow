import { readFileSync } from "node:fs";
import { create, type Font } from "fontkit";
import { captionFontFilePath } from "./paths";

/**
 * The pinned glyph fallback chain behind every caption face, in lookup order:
 * script faces, then Noto Sans Symbols 2, then monochrome Noto Emoji. The
 * requested face and the saved built-in face come first (see the worker's
 * caption-glyphs.ts). Every file is vendored, so the glyphs an export shows
 * never depend on which fonts the host happens to have installed.
 *
 * `assName` is the name libass matches in the fonts directory.
 */
export interface CaptionFallbackFont {
  readonly file: string;
  readonly assName: string;
  readonly role: "script" | "symbols" | "monochrome-emoji";
  /**
   * Cursive and complex scripts must not take caption letter spacing: libass
   * stops joining and bidi-reordering a line with non-zero `\fsp` (browsers
   * likewise ignore CSS letter-spacing for cursive scripts).
   */
  readonly letterSpacing: "preserved" | "disabled";
}

export const CAPTION_FALLBACK_FONTS = [
  { file: "NotoSans-Regular.ttf", assName: "Noto Sans Regular", role: "script", letterSpacing: "preserved" },
  { file: "NotoSansArabic-Regular.ttf", assName: "Noto Sans Arabic Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansHebrew-Regular.ttf", assName: "Noto Sans Hebrew Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansDevanagari-Regular.ttf", assName: "Noto Sans Devanagari Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansThai-Regular.ttf", assName: "Noto Sans Thai Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansSC-Regular.otf", assName: "Noto Sans SC", role: "script", letterSpacing: "preserved" },
  { file: "NotoSansKR-Regular.otf", assName: "Noto Sans KR", role: "script", letterSpacing: "preserved" },
  { file: "NotoSansSymbols2-Regular.ttf", assName: "Noto Sans Symbols 2 Regular", role: "symbols", letterSpacing: "preserved" },
  { file: "NotoEmoji-Regular.ttf", assName: "Noto Emoji Regular", role: "monochrome-emoji", letterSpacing: "preserved" },
] as const satisfies readonly CaptionFallbackFont[];

export function captionFallbackFontPath(font: CaptionFallbackFont): string {
  return captionFontFilePath(font.file);
}

const fonts = new Map<string, Font>();

function openFont(path: string): Font {
  const cached = fonts.get(path);
  if (cached) return cached;
  const font = create(readFileSync(path));
  if (!("layout" in font)) throw new Error(`Caption fallback font ${path} is a collection`);
  fonts.set(path, font);
  return font;
}

const coverage = new Map<string, boolean>();

/**
 * True when the font draws every character of `text` with a real glyph. The
 * check shapes the text (fontkit lays out ligatures and joining forms), so a
 * `.notdef` box that a bare cmap lookup would miss still counts as missing.
 */
export function fontFileCovers(path: string, text: string): boolean {
  const key = `${path}\0${text}`;
  const cached = coverage.get(key);
  if (cached !== undefined) return cached;
  const font = openFont(path);
  const covered =
    [...text].every((character) => font.hasGlyphForCodePoint(character.codePointAt(0)!)) &&
    font.layout(text).glyphs.every((glyph) => glyph.id !== 0);
  coverage.set(key, covered);
  return covered;
}

/** Shaped advance of `text` in em of the font that draws it. */
export function fontFileAdvanceEm(path: string, text: string): number {
  const font = openFont(path);
  return font.layout(text).advanceWidth / font.unitsPerEm;
}

/**
 * Win ascent + descent per em, the sum libass divides the ASS font size by.
 * A fallback run uses it to render at the same em size as the requested face.
 */
export function fontFileLineHeightEm(path: string): number {
  const font = openFont(path);
  const os2 = (font as unknown as { "OS/2"?: { winAscent: number; winDescent: number } })["OS/2"];
  return os2 ? (os2.winAscent + os2.winDescent) / font.unitsPerEm : (font.ascent - font.descent) / font.unitsPerEm;
}
