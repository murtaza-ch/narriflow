import { readFileSync } from "node:fs";
import { create, type Font } from "fontkit";
import { captionFontFilePath } from "./paths";
import { fontShapesWithoutNotdef } from "./shaping";

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
  /**
   * Language-aware faces (Noto Sans JP, Noto Sans TC, Noto Nastaliq Urdu) draw
   * a script the default face of the chain already covers, in the style of
   * these canonical language codes. They are listed after the default faces so
   * the chain order is unchanged; the planner takes them first only for
   * their language. Absent for a script's single face.
   */
  readonly languages?: readonly string[];
}

export const CAPTION_FALLBACK_FONTS = [
  { file: "NotoSans-Regular.ttf", assName: "Noto Sans Regular", role: "script", letterSpacing: "preserved" },
  { file: "NotoSansArabic-Regular.ttf", assName: "Noto Sans Arabic Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansHebrew-Regular.ttf", assName: "Noto Sans Hebrew Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansDevanagari-Regular.ttf", assName: "Noto Sans Devanagari Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansThai-Regular.ttf", assName: "Noto Sans Thai Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansArmenian-Regular.ttf", assName: "Noto Sans Armenian Regular", role: "script", letterSpacing: "preserved" },
  { file: "NotoSansBengali-Regular.ttf", assName: "Noto Sans Bengali Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansGurmukhi-Regular.ttf", assName: "Noto Sans Gurmukhi Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansGujarati-Regular.ttf", assName: "Noto Sans Gujarati Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansOriya-Regular.ttf", assName: "Noto Sans Oriya Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansTamil-Regular.ttf", assName: "Noto Sans Tamil Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansTelugu-Regular.ttf", assName: "Noto Sans Telugu Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansKannada-Regular.ttf", assName: "Noto Sans Kannada Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansMalayalam-Regular.ttf", assName: "Noto Sans Malayalam Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansSinhala-Regular.ttf", assName: "Noto Sans Sinhala Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansLao-Regular.ttf", assName: "Noto Sans Lao Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansKhmer-Regular.ttf", assName: "Noto Sans Khmer Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansMyanmar-Regular.ttf", assName: "Noto Sans Myanmar Regular", role: "script", letterSpacing: "disabled" },
  { file: "NotoSansGeorgian-Regular.ttf", assName: "Noto Sans Georgian Regular", role: "script", letterSpacing: "preserved" },
  { file: "NotoSansEthiopic-Regular.ttf", assName: "Noto Sans Ethiopic Regular", role: "script", letterSpacing: "preserved" },
  { file: "NotoSansSC-Regular.otf", assName: "Noto Sans SC", role: "script", letterSpacing: "preserved" },
  { file: "NotoSansKR-Regular.otf", assName: "Noto Sans KR", role: "script", letterSpacing: "preserved" },
  { file: "NotoSansJP-Regular.otf", assName: "Noto Sans JP", role: "script", letterSpacing: "preserved", languages: ["ja"] },
  { file: "NotoSansTC-Regular.otf", assName: "Noto Sans TC", role: "script", letterSpacing: "preserved", languages: ["yue"] },
  { file: "NotoNastaliqUrdu-Regular.ttf", assName: "Noto Nastaliq Urdu Regular", role: "script", letterSpacing: "disabled", languages: ["ur"] },
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
 * check shapes the text with HarfBuzz (ligatures, conjuncts and joining forms),
 * so a `.notdef` box that a bare cmap lookup would miss still counts as missing.
 * fontkit only reads the cmap: it cannot lay out Nastaliq, Gurmukhi or Telugu.
 */
export function fontFileCovers(path: string, text: string): boolean {
  const key = `${path}\0${text}`;
  const cached = coverage.get(key);
  if (cached !== undefined) return cached;
  const font = openFont(path);
  const covered = [...text].every((character) => font.hasGlyphForCodePoint(character.codePointAt(0)!)) && fontShapesWithoutNotdef(path, text);
  coverage.set(key, covered);
  return covered;
}

/**
 * Win ascent and descent per em: libass sizes a font so their sum equals the
 * ASS font size, and lays a line out with the largest ascent and descent of
 * the faces on it (measured on libass 0.17.4: a Nastaliq line's baseline sits
 * at the Win metrics, not hhea).
 */
export function fontFileMetricsEm(path: string): { readonly ascentEm: number; readonly descentEm: number } {
  const font = openFont(path);
  const os2 = (font as unknown as { "OS/2"?: { winAscent: number; winDescent: number } })["OS/2"];
  return os2
    ? { ascentEm: os2.winAscent / font.unitsPerEm, descentEm: os2.winDescent / font.unitsPerEm }
    : { ascentEm: font.ascent / font.unitsPerEm, descentEm: -font.descent / font.unitsPerEm };
}

/** Win ascent + descent per em: the ASS font size that draws one em. */
export function fontFileLineHeightEm(path: string): number {
  const { ascentEm, descentEm } = fontFileMetricsEm(path);
  return ascentEm + descentEm;
}
