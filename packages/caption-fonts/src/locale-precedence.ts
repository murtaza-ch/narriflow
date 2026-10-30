/**
 * Which language-aware fallback face draws a run of a script (spec D11).
 *
 * Pure: no filesystem, fontkit or HarfBuzz import, so the Studio (ticket 11)
 * orders its CSS font stack with the very function the worker's planner uses.
 *
 * Noto Sans SC is the generic Han face and Noto Sans Arabic the generic Arabic
 * face. Three faces draw the same script in a language's own style and are
 * therefore listed behind the generic ones in `CAPTION_FALLBACK_FONTS`
 * (`languages` on the entry); for their language they come first, but only for
 * the runs of the script they lead:
 *
 *   ja  -> Noto Sans JP            Han, Hiragana, Katakana
 *   yue -> Noto Sans TC            Han
 *   ur  -> Noto Nastaliq Urdu      Arabic script
 *
 * Mandarin (zh) keeps the default order, which already starts with Noto Sans
 * SC. A requested or brand face that covers the glyphs is tried before any of
 * these (the caller's chain puts it first), so a deliberate font is never
 * replaced.
 */

export type CaptionRunScript = "han" | "kana" | "arabic" | "other";

/** Scripts each language-aware face leads, by canonical language code. */
export const LOCALE_LEAD_SCRIPTS: Readonly<Record<string, readonly CaptionRunScript[]>> = {
  ja: ["han", "kana"],
  yue: ["han"],
  ur: ["arabic"],
};

const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
const ARABIC = /\p{Script=Arabic}/u;
const NEUTRAL = /^[\p{Z}\p{P}\p{N}\p{M}\p{Cf}]$/u;

/** Script class of a cluster or run: that of its first letter-like character. */
export function captionRunScript(text: string): CaptionRunScript {
  for (const character of text) {
    if (NEUTRAL.test(character)) continue;
    if (HAN.test(character)) return "han";
    if (KANA.test(character)) return "kana";
    if (ARABIC.test(character)) return "arabic";
    return "other";
  }
  return "other";
}

/** `ja-JP`, `JA`, `yue_HK` -> `ja`, `ja`, `yue`; null for no language. */
export function canonicalCaptionLanguage(language: string | null | undefined): string | null {
  const primary = language?.trim().toLowerCase().split(/[-_]/u)[0];
  return primary ? primary : null;
}

/**
 * `faces` with the faces that lead `text` for `language` moved to the front.
 * Faces keep their relative order; with no language, a language without a
 * face, or text in another script, the list comes back unchanged.
 */
export function orderCaptionFallbackFaces<T extends { readonly languages?: readonly string[] }>(
  faces: readonly T[],
  language: string | null | undefined,
  text: string,
): T[] {
  const code = canonicalCaptionLanguage(language);
  const leads = code ? LOCALE_LEAD_SCRIPTS[code] : undefined;
  if (!code || !leads?.includes(captionRunScript(text))) return [...faces];
  const leading = faces.filter((face) => face.languages?.includes(code));
  return [...leading, ...faces.filter((face) => !leading.includes(face))];
}

/**
 * Scripts whose letters join, reorder or stack (Arabic and the other cursive scripts, the Indic and
 * Southeast Asian abugidas, Hebrew, Mongolian...). Letter spacing and a tag placed between two of their
 * characters unjoin them or break their conjuncts, whatever face draws them.
 */
const SHAPING_SENSITIVE =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Mongolian}\p{Script=Phags_Pa}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}\p{Script=Javanese}\p{Script=Balinese}\p{Script=Sundanese}\p{Script=Cham}\p{Script=Tai_Tham}\p{Script=Tai_Viet}]/u;

/**
 * How `text` takes letter spacing and mid-word tags (the typewriter's per-letter reveal):
 *  - `sensitive`: some character is in a joining or complex script; spacing is 0 and the text is revealed whole;
 *  - `plain`: letters of other scripts only;
 *  - `neutral`: only spaces, punctuation, digits, marks and format characters; the run it sits in decides.
 * Pure, so the Studio applies the very rule the worker burns the captions with, for built-in and uploaded faces alike.
 */
export function captionShapingSensitivity(text: string): "sensitive" | "plain" | "neutral" {
  let plain = false;
  for (const character of text) {
    if (SHAPING_SENSITIVE.test(character)) return "sensitive";
    if (!NEUTRAL.test(character)) plain = true;
  }
  return plain ? "plain" : "neutral";
}

/** True when `text` holds any character of a joining or complex script (see `captionShapingSensitivity`). */
export function isShapingSensitiveText(text: string): boolean {
  return captionShapingSensitivity(text) === "sensitive";
}
