import { isCjkPunctuationOnly, isNoSpaceScriptChar } from "./text-script";

/** Cost of an ordinary word, in characters: `wordsPerCue` such words fill a cue. */
const WORD_COST_CHARS = 2;

const MARK_RE = /\p{M}/u;

function captionTokenCost(text: string): number {
  if (isCjkPunctuationOnly(text)) return 0;
  let dense = 0;
  // Combining marks (Thai vowels and tone marks) ride on a base character.
  for (const char of text) if (isNoSpaceScriptChar(char) && !MARK_RE.test(char)) dense += 1;
  // A multi-character token in a no-space script is a whole word (Thai, or a
  // provider that returns lexical CJK words) and costs no more than one spaced
  // word; single CJK characters cost one, so two of them make a word.
  if (dense > 0) return Math.min(dense, WORD_COST_CHARS);
  return Array.from(text).some(isNoSpaceScriptChar) ? 1 : WORD_COST_CHARS;
}

/** A pause of at least this many edited seconds after a word is a soft cue break. */
export const CAPTION_SOFT_BREAK_GAP_SEC = 0.35;

/** Sentence or clause punctuation at the end of a token, before any closing quotes or brackets. */
const CLAUSE_END_RE = /[.!?…,;:—–۔؟،؛।॥。！？、，；：]["'”’)\]»」』]*$/u;

/**
 * Soft cue breaks for `groupCaptionTokens` (spec 5.4): entry i is true when
 * the raw transcript text of token i ends with sentence or clause punctuation,
 * or the edited-time gap from its end to the next token's start is 0.35 s or
 * more. `raw` is the text before punctuation stripping, so a break survives
 * the Punctuation toggle.
 */
export function captionSoftBreaks(
  tokens: readonly { readonly raw: string; readonly startSec: number; readonly endSec: number }[],
): boolean[] {
  return tokens.map((token, index) => {
    if (CLAUSE_END_RE.test(token.raw.trim())) return true;
    const next = tokens[index + 1];
    return next !== undefined && next.startSec - token.endSec >= CAPTION_SOFT_BREAK_GAP_SEC;
  });
}

/**
 * The one caption cue grouping, shared by the composition plan (burn-in,
 * subtitle files, Studio composition preview) and the Studio's caption
 * resolver. Cues fill a budget of `wordsPerCue * 2` characters: a word in a
 * spaced script costs 2, so ordinary text still gets `wordsPerCue` words per
 * cue; a single Chinese/Japanese character costs 1 (two make a word) and a
 * multi-character no-space token (a Thai, Lao, Khmer or Myanmar word) costs 2
 * like any other word.
 * CJK punctuation costs nothing, so it stays with the character before it.
 * Pure arithmetic on code points, never `Intl.Segmenter`: browser and Bun ICU
 * segment differently and the preview must match the export.
 *
 * `softBreakAfter` (from `captionSoftBreaks`) makes breaks phrase-aware: when
 * the next token would overflow the budget and the open cue holds a soft break
 * that leaves at least 2 tokens in the closed cue, the cue closes after the
 * latest such break and the tokens after it open the next cue. A soft break
 * never closes a cue that is not overflowing. Without it, cues close only on
 * the budget.
 *
 * `minor` (from `captionWordIsMinor`) keeps a cue from ending on a minor
 * (closed-class) word when the next token follows in the same sentence: when
 * a cue closes on the budget, its trailing run of minor tokens moves to the
 * start of the next cue ("week of content in / one hour" becomes "week of
 * content / in one hour"). The run stops at a soft break (sentence or clause
 * punctuation, or a pause of `CAPTION_SOFT_BREAK_GAP_SEC`), so nothing crosses
 * one, and at least one token stays behind; a cue made only of minor words
 * keeps them. The cue that takes the carried words may hold one word more
 * than the budget; past that it closes on the budget as usual. A token list
 * is one utterance or one dub segment, so nothing moves across those either.
 *
 * Returns half-open `[start, end)` index ranges covering every token.
 */
export function groupCaptionTokens(
  texts: readonly string[],
  wordsPerCue: number,
  softBreakAfter?: readonly boolean[],
  minor?: readonly boolean[],
): { start: number; end: number }[] {
  const budget = Math.max(1, Math.floor(wordsPerCue)) * WORD_COST_CHARS;
  const costs = texts.map(captionTokenCost);
  const groups: { start: number; end: number }[] = [];
  let start = 0;
  let used = 0;
  // Extra room in the open cue for the minor words it took over from the last one.
  let allowance = 0;
  for (let index = 0; index < texts.length; index += 1) {
    const cost = costs[index]!;
    while (index > start && used + cost > budget + allowance) {
      let end = index;
      if (softBreakAfter) {
        for (let at = index - 1; at > start; at -= 1) {
          if (softBreakAfter[at]) {
            end = at + 1;
            break;
          }
        }
      }
      allowance = 0;
      if (minor) {
        let cut = end;
        while (cut > start && minor[cut - 1] && !softBreakAfter?.[cut - 1]) cut -= 1;
        if (cut > start && cut < end) {
          end = cut;
          allowance = WORD_COST_CHARS;
        }
      }
      groups.push({ start, end });
      start = end;
      used = 0;
      for (let carried = start; carried < index; carried += 1) used += costs[carried]!;
    }
    used += cost;
  }
  if (texts.length > start) groups.push({ start, end: texts.length });
  return groups;
}
