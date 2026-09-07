import type { SourceRange } from "@narriflow/validators";

// Pure selection/classification logic for transcript-panel.tsx's Vizard-parity
// word-Correct + selection-Delete/Revert UX (docs/plans/vizard-parity.md
// Phase B steps 10-11). Kept DOM-free and unit-testable on purpose: the panel
// resolves a raw browser Selection down to per-utterance char offsets (see
// `resolveSelectionEndpoint` there), then hands off to `collectSelectedWords`
// below for the actual word-mapping policy.

export interface SelectableWord {
  utteranceIndex: number;
  wordIndex: number;
  startSec: number;
  endSec: number;
}

interface CharRange {
  charStart: number;
  charEnd: number;
}

/**
 * Per-word character ranges for a SINGLE utterance's word list, assuming the
 * exact rendering convention transcript-panel.tsx uses: every word is joined
 * by a single space, with zero characters contributed by pause indicators
 * (they render no text) — identical to how the reducer rebuilds
 * `utterance.text` in `updateWordText` (`words.join(" ")`). The panel's own
 * DOM text must stay byte-for-byte consistent with this, which is why pause
 * indicators are rendered as separate non-text nodes rather than eating the
 * joining space around them.
 */
export function wordCharRanges(words: { word: string }[]): CharRange[] {
  const ranges: CharRange[] = [];
  let cursor = 0;
  for (const w of words) {
    const charStart = cursor;
    const charEnd = charStart + w.word.length;
    ranges.push({ charStart, charEnd });
    cursor = charEnd + 1; // single joining space
  }
  return ranges;
}

export interface SelectionEndpoint {
  utteranceIndex: number;
  /** Character offset into that utterance's own rendered word text (see
   *  `wordCharRanges`) — NOT a global/document-wide offset. */
  charOffset: number;
}

export interface UtteranceWordSource {
  utteranceIndex: number;
  words: { word: string; startSec: number; endSec: number }[];
}

/** Selection endpoints (anchor/focus) can arrive in either document order —
 *  the user can drag right-to-left just as easily as left-to-right. Orders
 *  by utterance first, then char offset within it. */
function orderEndpoints(
  a: SelectionEndpoint,
  b: SelectionEndpoint,
): [SelectionEndpoint, SelectionEndpoint] {
  if (a.utteranceIndex !== b.utteranceIndex) {
    return a.utteranceIndex < b.utteranceIndex ? [a, b] : [b, a];
  }
  return a.charOffset <= b.charOffset ? [a, b] : [b, a];
}

/**
 * Maps a transcript text selection (expressed as per-utterance char offsets)
 * onto the words it touches. Partial-word-overlap policy: a word counts as
 * selected iff its char span has non-zero overlap with the selection's char
 * span — so a selection that starts or ends mid-word still selects that
 * whole word (words are the atomic editable/deletable unit, there's no
 * character-level delete). Utterances strictly between the (ordered) start
 * and end endpoints are selected in full; selections may span any number of
 * utterances.
 */
export function collectSelectedWords(
  utterances: UtteranceWordSource[],
  a: SelectionEndpoint,
  b: SelectionEndpoint,
): SelectableWord[] {
  const [start, end] = orderEndpoints(a, b);
  const result: SelectableWord[] = [];

  for (const u of utterances) {
    if (u.utteranceIndex < start.utteranceIndex || u.utteranceIndex > end.utteranceIndex) {
      continue;
    }
    const ranges = wordCharRanges(u.words);
    const selStart = u.utteranceIndex === start.utteranceIndex ? start.charOffset : 0;
    const selEnd =
      u.utteranceIndex === end.utteranceIndex ? end.charOffset : Number.POSITIVE_INFINITY;

    u.words.forEach((w, wordIndex) => {
      const r = ranges[wordIndex]!;
      if (r.charStart < selEnd && selStart < r.charEnd) {
        result.push({
          utteranceIndex: u.utteranceIndex,
          wordIndex,
          startSec: w.startSec,
          endSec: w.endSec,
        });
      }
    });
  }

  return result;
}

/** Absolute source-second span covering every selected word, or null for an
 *  empty selection. This is the range `deleteRange`/`revertRange` dispatch
 *  against (see studio-shell.tsx's `deleteSourceRange`). */
export function selectedWordsToSourceRange(words: SelectableWord[]): SourceRange | null {
  if (words.length === 0) return null;
  let startSec = Number.POSITIVE_INFINITY;
  let endSec = Number.NEGATIVE_INFINITY;
  for (const w of words) {
    startSec = Math.min(startSec, w.startSec);
    endSec = Math.max(endSec, w.endSec);
  }
  return { startSec, endSec };
}

function rangesOverlap(a: { startSec: number; endSec: number }, b: SourceRange): boolean {
  return a.startSec < b.endSec && b.startSec < a.endSec;
}

/** True when `word`'s source span overlaps any deleted range at all — the
 *  same "any overlap counts" policy as the selection mapping above, so a
 *  word whose boundary a cut lands mid-way through still renders struck. */
export function isWordDeleted(
  word: { startSec: number; endSec: number },
  deletedRanges: SourceRange[],
): boolean {
  return deletedRanges.some((r) => rangesOverlap(word, r));
}

/**
 * When a selection lies ENTIRELY inside already-deleted range(s), the
 * toolbar collapses to a single Revert instead of Delete/Copy (Vizard
 * parity). Returns the range to pass to `revertRange` — the selection's own
 * covering span — or null when the selection has any non-deleted word (in
 * which case Delete is still the right action; deleting an already-deleted
 * sub-span is a normalize()-level no-op the reducer already absorbs).
 */
export function computeRevertCoveringRange(
  selectedWords: SelectableWord[],
  deletedRanges: SourceRange[],
): SourceRange | null {
  if (selectedWords.length === 0) return null;
  if (!selectedWords.every((w) => isWordDeleted(w, deletedRanges))) return null;
  return selectedWordsToSourceRange(selectedWords);
}
