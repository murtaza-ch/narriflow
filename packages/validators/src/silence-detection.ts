import {
  FLOAT_SLACK,
  normalizeDeletedRanges,
  type ClipWindow,
  type SourceRange,
} from "./edit-ranges";
import type { TranscriptUtterance } from "./transcript";

// Vizard-parity Phase B step 12 (docs/plans/vizard-parity.md §4): pure
// silence-gap detector feeding the timeline's "Remove silence" affordance.
// Output is just more `SourceRange`s in the SAME absolute-source-second
// model as manual deletes (edit-ranges.ts) — the caller unions the result
// with `doc.deletedRanges` and dispatches ONE `setDeletedRanges` action, so
// undo/redo, the render-invalidation policy, and the isEmpty guard all fall
// out of machinery that already exists. Nothing here mutates or dispatches.

/** Default minimum gap length to count as "silence" worth cutting. */
export const SILENCE_DEFAULT_MIN_SILENCE_SEC = 1.0;

/** Default padding kept on each side of a cut that touches speech, so a cut
 *  never clips the leading/trailing consonant of a word. */
export const SILENCE_DEFAULT_PAD_SEC = 0.15;

/** Below this, a padded (or existing-deleted-trimmed) cut isn't worth
 *  making — too small to be perceptible, and risks being a sub-frame sliver
 *  once it reaches `buildEditedTimeMap`'s MIN_KEPT_SEGMENT_SEC bookkeeping. */
export const SILENCE_MIN_CUT_SEC = 0.05;

export interface DetectSilenceOptions {
  /** Minimum gap length (seconds) to qualify as silence. Applied to the
   *  ORIGINAL gap, before padding shrink. @default 1.0 */
  minSilenceSec?: number;
  /** Padding (seconds) kept on each side of a cut that touches speech.
   *  @default 0.15 */
  padSec?: number;
  /** Already-deleted ranges (e.g. `doc.deletedRanges`) to subtract from
   *  detected candidates so silence detection never re-proposes a cut the
   *  user already made (or part of one). @default [] */
  existingDeleted?: SourceRange[];
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

interface Gap {
  startSec: number;
  endSec: number;
  /** Left edge borders speech (pad it) vs. the window boundary (don't). */
  padLeft: boolean;
  /** Right edge borders speech (pad it) vs. the window boundary (don't). */
  padRight: boolean;
}

/**
 * Merged "speech" intervals a cut must never touch. Per utterance: word-level
 * spans when every word has real (positive-duration) timing — which is what
 * lets an inter-word pause become a gap candidate — otherwise the whole
 * utterance's own start/end, conservatively, so a transcript with zero or
 * missing word timings can never have a cut carved out of it.
 */
function buildCoverageSpans(
  utterances: TranscriptUtterance[],
  window: ClipWindow,
): SourceRange[] {
  const raw: SourceRange[] = [];
  for (const utterance of utterances) {
    const words = utterance.words;
    const allWordsTimed = words.length > 0 && words.every((w) => w.endSec > w.startSec);
    if (allWordsTimed) {
      for (const word of words) {
        raw.push({ startSec: word.startSec, endSec: word.endSec });
      }
    } else {
      raw.push({ startSec: utterance.startSec, endSec: utterance.endSec });
    }
  }

  const clamped = raw
    .map((span) => ({
      startSec: Math.max(window.startSec, span.startSec),
      endSec: Math.min(window.endSec, span.endSec),
    }))
    .filter((span) => span.endSec - span.startSec > FLOAT_SLACK)
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

  const merged: SourceRange[] = [];
  for (const span of clamped) {
    const last = merged[merged.length - 1];
    if (last && span.startSec <= last.endSec + FLOAT_SLACK) {
      last.endSec = Math.max(last.endSec, span.endSec);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * Candidate gaps: the complement of `coverage` inside `window`, including
 * the leading gap (window start -> first word) and trailing gap (last word
 * -> window end) — Vizard removes those too. Edge treatment is encoded per
 * gap via `padLeft`/`padRight`: an edge that borders the window boundary
 * (not speech) is never padded, only edges that border actual coverage are.
 */
function buildGaps(coverage: SourceRange[], window: ClipWindow): Gap[] {
  if (coverage.length === 0) {
    if (window.endSec - window.startSec <= FLOAT_SLACK) return [];
    return [{ startSec: window.startSec, endSec: window.endSec, padLeft: false, padRight: false }];
  }

  const gaps: Gap[] = [];
  const first = coverage[0]!;
  if (first.startSec - window.startSec > FLOAT_SLACK) {
    gaps.push({ startSec: window.startSec, endSec: first.startSec, padLeft: false, padRight: true });
  }

  for (let i = 0; i < coverage.length - 1; i += 1) {
    const current = coverage[i]!;
    const next = coverage[i + 1]!;
    if (next.startSec - current.endSec > FLOAT_SLACK) {
      gaps.push({ startSec: current.endSec, endSec: next.startSec, padLeft: true, padRight: true });
    }
  }

  const last = coverage[coverage.length - 1]!;
  if (window.endSec - last.endSec > FLOAT_SLACK) {
    gaps.push({ startSec: last.endSec, endSec: window.endSec, padLeft: true, padRight: false });
  }

  return gaps;
}

/**
 * Subtract `deleted` from `candidate`, returning the (zero or more)
 * un-deleted remainder pieces. A candidate fully covered by `deleted` yields
 * no pieces; a partial overlap is trimmed rather than dropped wholesale.
 * Pieces at or below `SILENCE_MIN_CUT_SEC` are filtered out by the caller,
 * matching the "not worth a cut" floor applied to fresh candidates.
 */
function subtractDeletedFromCandidate(
  candidate: SourceRange,
  deleted: SourceRange[],
): SourceRange[] {
  const relevant = deleted
    .filter((d) => d.endSec > candidate.startSec && d.startSec < candidate.endSec)
    .sort((a, b) => a.startSec - b.startSec);

  const pieces: SourceRange[] = [];
  let cursor = candidate.startSec;
  for (const d of relevant) {
    if (d.startSec > cursor) {
      pieces.push({ startSec: cursor, endSec: Math.min(d.startSec, candidate.endSec) });
    }
    cursor = Math.max(cursor, d.endSec);
    if (cursor >= candidate.endSec) break;
  }
  if (candidate.endSec - cursor > FLOAT_SLACK) {
    pieces.push({ startSec: cursor, endSec: candidate.endSec });
  }
  return pieces;
}

/**
 * Detect silence ranges worth cutting: gaps with no word coverage (including
 * the leading/trailing edges of `window`) at least `minSilenceSec` long,
 * shrunk by `padSec` on whichever side(s) border actual speech, with any
 * overlap against `existingDeleted` trimmed away. Output is normalized
 * (sorted, merged, clamped to `window`) and deterministic — safe to call on
 * every slider tick for a live preview, with no dispatch of its own.
 */
export function detectSilenceRanges(
  utterances: TranscriptUtterance[],
  window: ClipWindow,
  opts: DetectSilenceOptions = {},
): SourceRange[] {
  const minSilenceSec = opts.minSilenceSec ?? SILENCE_DEFAULT_MIN_SILENCE_SEC;
  const padSec = opts.padSec ?? SILENCE_DEFAULT_PAD_SEC;
  const existingDeleted = opts.existingDeleted ?? [];

  if (window.endSec - window.startSec <= FLOAT_SLACK) return [];

  const coverage = buildCoverageSpans(utterances, window);
  const gaps = buildGaps(coverage, window);

  const candidates: SourceRange[] = [];
  for (const gap of gaps) {
    // The ≥minSilenceSec test applies to the ORIGINAL gap, before padding.
    if (gap.endSec - gap.startSec < minSilenceSec - FLOAT_SLACK) continue;

    const paddedStart = gap.padLeft ? gap.startSec + padSec : gap.startSec;
    const paddedEnd = gap.padRight ? gap.endSec - padSec : gap.endSec;
    if (paddedEnd - paddedStart <= SILENCE_MIN_CUT_SEC + FLOAT_SLACK) continue;

    candidates.push({ startSec: roundMs(paddedStart), endSec: roundMs(paddedEnd) });
  }

  const trimmed = candidates.flatMap((candidate) =>
    subtractDeletedFromCandidate(candidate, existingDeleted).filter(
      (piece) => piece.endSec - piece.startSec > SILENCE_MIN_CUT_SEC + FLOAT_SLACK,
    ),
  );

  return normalizeDeletedRanges(trimmed, window);
}
