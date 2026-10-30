/**
 * The browser's glyph fallback chain behind every caption face, in the order
 * the worker's glyph planner tries them (packages/caption-fonts
 * fallback-fonts.ts, apps/worker/src/caption-glyphs.ts):
 *
 *   requested face -> the face for the cue's language -> script faces
 *   -> Noto Sans Symbols 2 -> Noto Emoji
 *
 * The faces themselves are @font-face rules in caption-script-fonts.css. Each
 * carries a unicode-range, so a browser downloads one only when a character in
 * that range gets past the faces before it. caption-script-fonts.test.ts holds
 * this table to the worker's.
 */

export interface CaptionScriptFace {
  /** The @font-face family: `family` in packages/caption-fonts/script-fonts.manifest.json. */
  readonly family: string;
  /** Vendored file name; the test matches it to the worker's fallback list. */
  readonly file: string;
  /** Complex and cursive scripts take no letter spacing and are never split letter by letter. */
  readonly letterSpacing: "preserved" | "disabled";
  /** Draws a script the chain's default face already covers, in the style of these languages. */
  readonly languages?: readonly string[];
}

export const CAPTION_SCRIPT_FACES: readonly CaptionScriptFace[] = [
  { family: "Noto Sans", file: "NotoSans-Regular.ttf", letterSpacing: "preserved" },
  { family: "Noto Sans Arabic", file: "NotoSansArabic-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Hebrew", file: "NotoSansHebrew-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Devanagari", file: "NotoSansDevanagari-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Thai", file: "NotoSansThai-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Armenian", file: "NotoSansArmenian-Regular.ttf", letterSpacing: "preserved" },
  { family: "Noto Sans Bengali", file: "NotoSansBengali-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Gurmukhi", file: "NotoSansGurmukhi-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Gujarati", file: "NotoSansGujarati-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Oriya", file: "NotoSansOriya-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Tamil", file: "NotoSansTamil-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Telugu", file: "NotoSansTelugu-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Kannada", file: "NotoSansKannada-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Malayalam", file: "NotoSansMalayalam-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Sinhala", file: "NotoSansSinhala-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Lao", file: "NotoSansLao-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Khmer", file: "NotoSansKhmer-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Myanmar", file: "NotoSansMyanmar-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Georgian", file: "NotoSansGeorgian-Regular.ttf", letterSpacing: "preserved" },
  { family: "Noto Sans Ethiopic", file: "NotoSansEthiopic-Regular.ttf", letterSpacing: "preserved" },
  { family: "Noto Sans SC", file: "NotoSansSC-Regular.otf", letterSpacing: "preserved" },
  { family: "Noto Sans KR", file: "NotoSansKR-Regular.otf", letterSpacing: "preserved" },
  { family: "Noto Sans JP", file: "NotoSansJP-Regular.otf", letterSpacing: "preserved", languages: ["ja"] },
  { family: "Noto Sans TC", file: "NotoSansTC-Regular.otf", letterSpacing: "preserved", languages: ["yue"] },
  { family: "Noto Nastaliq Urdu", file: "NotoNastaliqUrdu-Regular.ttf", letterSpacing: "disabled", languages: ["ur"] },
];

/** Drawn after every script face, as in the worker: symbols, then monochrome emoji. */
export const CAPTION_SYMBOL_FAMILIES = ["Noto Sans Symbols 2", "Noto Emoji"] as const;

/**
 * Fallback families for text in `language`: the language's own face first,
 * then the default faces in chain order. A language-aware face is skipped for
 * other languages (the default face before it always wins, as in the worker).
 */
export function captionFallbackFamilies(language?: string | null): string[] {
  const own = CAPTION_SCRIPT_FACES.filter((face) => language && face.languages?.includes(language));
  const defaults = CAPTION_SCRIPT_FACES.filter((face) => !face.languages);
  return [...own, ...defaults].map((face) => face.family).concat(CAPTION_SYMBOL_FAMILIES);
}

/** The CSS `font-family` for a caption face: the face, then its fallbacks for `language`. */
export function captionFontStack(face: string, language?: string | null): string {
  return [face, ...captionFallbackFamilies(language).map((family) => `"${family}"`), "sans-serif"].join(", ");
}

// Scripts whose faces disable letter spacing (CAPTION_SCRIPT_FACES, Arabic-script
// languages included): Hebrew, Arabic, and the Indic and Southeast Asian scripts.
const NO_LETTER_SPACING_RE =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Thai}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
// Digits, punctuation, spaces, joiners and combining marks take the run they sit in.
const RIDES_WITH_NEIGHBOUR_RE = /[\p{Script=Common}\p{Script=Inherited}]/u;

/** True when any character of `text` is in a script that takes no letter spacing. */
export function hasUnspacedScript(text: string): boolean {
  return NO_LETTER_SPACING_RE.test(text);
}

/**
 * Splits text into runs that take the cue's letter spacing and runs that must
 * not: the same per-face `\fsp0` the burn-in applies. Ordinary text is one run.
 */
export function captionLetterSpacingRuns(text: string): { text: string; spaced: boolean }[] {
  const runs: { text: string; spaced: boolean }[] = [];
  for (const char of text) {
    const spaced = NO_LETTER_SPACING_RE.test(char)
      ? false
      : RIDES_WITH_NEIGHBOUR_RE.test(char) && runs.length > 0
        ? runs[runs.length - 1]!.spaced
        : true;
    const last = runs[runs.length - 1];
    if (last && last.spaced === spaced) last.text += char;
    else runs.push({ text: char, spaced });
  }
  return runs;
}
