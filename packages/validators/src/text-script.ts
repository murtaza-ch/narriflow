/**
 * Script-aware text helpers shared by transcripts, caption cues, subtitle
 * exports and the Studio. Preview and export must join, case and orient text
 * identically, so there is exactly one implementation here.
 */

export type TextDirection = "ltr" | "rtl";

// Scripts written without spaces between words. Scribe returns zh/ja as one
// token per character; Thai, Lao, Khmer and Myanmar put spaces between phrases
// only, so the provider's explicit `spaceBefore` wins whenever it is present.
const NO_SPACE_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}ー]/u;
// Han and kana abut Arabic digits without a space (`2026年`); Thai and the
// others space their numerals.
const IDEOGRAPH_OR_KANA_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
const CJK_PUNCTUATION_RE = /[　-〿＀-￯]/u;
// CJK punctuation that attaches to the word before it / after it.
const CJK_CLOSING_RE =
  /^[、。，．！？：；）」』】〉》〕］｝〗〙〛]/u;
const CJK_OPENING_RE = /[（「『【〈《〔［｛〖〘〚]$/u;

/** True for a character in a script that is written without inter-word spaces. */
export function isNoSpaceScriptChar(char: string): boolean {
  return NO_SPACE_SCRIPT_RE.test(char);
}

function isNoSpaceOrCjkPunctuation(char: string): boolean {
  return NO_SPACE_SCRIPT_RE.test(char) || CJK_PUNCTUATION_RE.test(char);
}

function lastChar(text: string): string {
  return Array.from(text).at(-1) ?? "";
}

function firstChar(text: string): string {
  return Array.from(text)[0] ?? "";
}

function needsSpaceBetween(previous: string, next: string): boolean {
  const left = lastChar(previous);
  const right = firstChar(next);
  if (CJK_CLOSING_RE.test(next) || CJK_OPENING_RE.test(previous)) return false;
  if (isNoSpaceOrCjkPunctuation(left) && isNoSpaceOrCjkPunctuation(right)) {
    return false;
  }
  if (
    (IDEOGRAPH_OR_KANA_RE.test(left) && /\p{Nd}/u.test(right)) ||
    (/\p{Nd}/u.test(left) && IDEOGRAPH_OR_KANA_RE.test(right))
  ) {
    return false;
  }
  return true;
}

/**
 * Joins timed words into display text. A word's `spaceBefore` (set from the
 * provider's spacing) decides when present; otherwise no space goes between two
 * words whose boundary characters are both in no-space scripts or CJK
 * punctuation, between CJK closing/opening punctuation and its neighbour, or
 * between Han/kana and an adjoining digit. Latin next to Han/kana gets a space
 * unless `spaceBefore` says otherwise.
 */
export function joinTranscriptWords(
  words: readonly { word: string; spaceBefore?: boolean }[],
): string {
  let text = "";
  for (const entry of words) {
    const word = entry.word.trim();
    if (!word) continue;
    if (text) {
      const space = entry.spaceBefore ?? needsSpaceBetween(text, word);
      if (space) text += " ";
    }
    text += word;
  }
  return text;
}

// Strong right-to-left letters: Hebrew, Arabic and its supplements/forms,
// Syriac, Thaana, N'Ko, Samaritan, Mandaic, and the RTL supplementary planes.
function isRtlCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0590 && codePoint <= 0x08ff) ||
    (codePoint >= 0xfb1d && codePoint <= 0xfdff) ||
    (codePoint >= 0xfe70 && codePoint <= 0xfeff) ||
    (codePoint >= 0x10800 && codePoint <= 0x10fff) ||
    (codePoint >= 0x1e800 && codePoint <= 0x1efff)
  );
}

/** Direction of the first strong (letter) character; `fallback` when there is none. */
export function textDirection(
  text: string,
  fallback: TextDirection = "ltr",
): TextDirection {
  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue;
    return isRtlCodePoint(char.codePointAt(0)!) ? "rtl" : "ltr";
  }
  return fallback;
}

const NON_GEORGIAN_RUN_RE = /[^\p{Script=Georgian}]+/gu;

/**
 * Upper-cases caption text for a language: locale rules (Turkish dotted İ,
 * Lithuanian), a no-op for caseless scripts (Han, Arabic, Indic, ...), and
 * Georgian left alone, because `toUpperCase` would turn Mkhedruli into
 * Mtavruli, which the vendored Georgian faces do not carry.
 */
export function toCaptionUpperCase(
  text: string,
  languageCode?: string | null,
): string {
  const upper = (segment: string) => {
    if (!languageCode) return segment.toUpperCase();
    try {
      return segment.toLocaleUpperCase(languageCode);
    } catch {
      return segment.toUpperCase();
    }
  };
  return text.replace(NON_GEORGIAN_RUN_RE, upper);
}

/**
 * Punctuation, quotes, brackets and dashes stripped from a caption word's
 * edges (never its middle) when punctuation display is off. Covers ASCII, the
 * curly/guillemet quotes, CJK and fullwidth forms, and the sentence marks of
 * Arabic-script, Indic, Armenian, Ethiopic, Greek, Khmer, Myanmar and Tibetan.
 * `%`, `#`, `@`, `&` and currency stay: they are content.
 */
export const CAPTION_EDGE_PUNCTUATION_CHARS =
  ".,!?;:…\"'“”‘’„‟‚‹›«»()[\\]{}<>—–‐‑‒―_~`*¡¿" +
  "、。，．！？：；（）「」『』【】〈〉《》〔〕［］｛｝・" +
  "،؛؟۔٫٬" +
  "।॥" +
  "։՜՝՞" +
  "።፡፣፤፥፦፧" +
  "\u037E\u0387" +
  "។៕៖" +
  "၊။" +
  "།༎" +
  // Last, so it can never form a range.
  "-";

const LEADING_EDGE_PUNCTUATION_RE = new RegExp(
  `^[${CAPTION_EDGE_PUNCTUATION_CHARS}]+`,
  "u",
);
const TRAILING_EDGE_PUNCTUATION_RE = new RegExp(
  `[${CAPTION_EDGE_PUNCTUATION_CHARS}]+$`,
  "u",
);

export function stripCaptionEdgePunctuation(word: string): string {
  return word
    .replace(LEADING_EDGE_PUNCTUATION_RE, "")
    .replace(TRAILING_EDGE_PUNCTUATION_RE, "");
}
