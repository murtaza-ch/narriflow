import { isCjkPunctuationOnly, isNoSpaceScriptChar } from "./text-script";

/** Cost of an ordinary word, in characters: `wordsPerCue` such words fill a cue. */
const WORD_COST_CHARS = 2;

const MARK_RE = /\p{M}/u;

function captionTokenCost(text: string): number {
  if (isCjkPunctuationOnly(text)) return 0;
  let dense = 0;
  // Combining marks (Thai vowels and tone marks) ride on a base character.
  for (const char of text) if (isNoSpaceScriptChar(char) && !MARK_RE.test(char)) dense += 1;
  if (dense > 0) return dense;
  return Array.from(text).some(isNoSpaceScriptChar) ? 1 : WORD_COST_CHARS;
}

/**
 * The one caption cue grouping, shared by the composition plan (burn-in,
 * subtitle files, Studio composition preview) and the Studio's caption
 * resolver. Cues fill a budget of `wordsPerCue * 2` characters: a word in a
 * spaced script costs 2, so ordinary text still gets `wordsPerCue` words per
 * cue, while per-character tokens (Chinese, Japanese) and syllable runs (Thai,
 * Lao, Khmer, Myanmar) cost one per character and fill the cue by length.
 * CJK punctuation costs nothing, so it stays with the character before it.
 * Pure arithmetic on code points, never `Intl.Segmenter`: browser and Bun ICU
 * segment differently and the preview must match the export.
 *
 * Returns half-open `[start, end)` index ranges covering every token.
 */
export function groupCaptionTokens(
  texts: readonly string[],
  wordsPerCue: number,
): { start: number; end: number }[] {
  const budget = Math.max(1, Math.floor(wordsPerCue)) * WORD_COST_CHARS;
  const groups: { start: number; end: number }[] = [];
  let start = 0;
  let used = 0;
  for (let index = 0; index < texts.length; index += 1) {
    const cost = captionTokenCost(texts[index]!);
    if (index > start && used + cost > budget) {
      groups.push({ start, end: index });
      start = index;
      used = 0;
    }
    used += cost;
  }
  if (texts.length > start) groups.push({ start, end: texts.length });
  return groups;
}
