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

/** Default padding kept after speech ends, so a cut never clips the trailing
 *  sound of a word. */
export const SILENCE_DEFAULT_PAD_SEC = 0.15;

/** Extra padding kept before speech resumes, on top of `padSec`. Speech is
 *  audible before a word's transcript start more often than after its end:
 *  measured on a 68-minute Scribe v2 interview (2026-11-12), sound preceded
 *  the next word by p99 210 ms but trailed a word by only p99 120 ms. */
export const SILENCE_LEAD_IN_EXTRA_SEC = 0.1;

/** Shortest cut kept after intersecting with measured quiet audio. Shorter
 *  fragments are acoustic noise between transcript words, not pauses. */
export const SILENCE_MIN_GUARDED_CUT_SEC = 0.3;

/** Width given to a word whose transcript timing is a single instant, so it
 *  still splits the gap it sits in and gets padded like any other word. */
const ZERO_DURATION_WORD_SEC = 0.01;

/** Below this, a padded (or existing-deleted-trimmed) cut isn't worth
 *  making — too small to be perceptible, and risks being a sub-frame sliver
 *  once it reaches `buildEditedTimeMap`'s MIN_KEPT_SEGMENT_SEC bookkeeping. */
export const SILENCE_MIN_CUT_SEC = 0.05;

export interface DetectSilenceOptions {
  /** Minimum gap length (seconds) to qualify as silence. Applied to the
   *  ORIGINAL gap, before padding shrink. @default 1.0 */
  minSilenceSec?: number;
  /** Padding (seconds) kept after speech ends. Before speech resumes the
   *  cut keeps `padSec + SILENCE_LEAD_IN_EXTRA_SEC` (0 stays 0: no padding
   *  at all). @default 0.15 */
  padSec?: number;
  /** Already-deleted ranges (e.g. `doc.deletedRanges`) to subtract from
   *  detected candidates so silence detection never re-proposes a cut the
   *  user already made (or part of one). @default [] */
  existingDeleted?: SourceRange[];
  /** Intervals where the source audio is measured quiet (FFmpeg
   *  `silencedetect` on the transcription audio, same clock as the words).
   *  When given, a cut survives only where it overlaps a quiet interval, so
   *  music, laughter or applause between words is never cut. Pieces shorter
   *  than SILENCE_MIN_GUARDED_CUT_SEC are dropped. Omitted means the
   *  transcript alone decides. */
  quietRanges?: SourceRange[];
  /** Words that are being removed anyway (filler words), so the pause on
   *  either side of them is one gap rather than two. */
  skipWord?: (word: TranscriptUtterance["words"][number]) => boolean;
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

function isTimed(word: { startSec: number; endSec: number }): boolean {
  return Number.isFinite(word.startSec) && Number.isFinite(word.endSec) && word.endSec >= word.startSec;
}

/**
 * Merged "speech" intervals a cut must never touch. Per utterance: word-level
 * spans when every word has finite timing — which is what lets an inter-word
 * pause become a gap candidate. A word timed as a single instant (Scribe
 * emits a few) protects a ZERO_DURATION_WORD_SEC span at that instant rather
 * than the whole utterance. An utterance with no words or untimed words is
 * protected whole, so a cut is never carved out of speech of unknown timing.
 * `skipWord` leaves words out of coverage (filler words being removed).
 */
export function buildCoverageSpans(
  utterances: TranscriptUtterance[],
  window: ClipWindow,
  skipWord: (word: TranscriptUtterance["words"][number]) => boolean = () => false,
): SourceRange[] {
  const raw: SourceRange[] = [];
  for (const utterance of utterances) {
    const words = utterance.words;
    if (words.length > 0 && words.every(isTimed)) {
      for (const word of words) {
        if (skipWord(word)) continue;
        raw.push({ startSec: word.startSec, endSec: word.endSec > word.startSec ? word.endSec : word.startSec + ZERO_DURATION_WORD_SEC });
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

/** Padding kept before speech resumes for a given `padSec`. */
export function silenceLeadInSec(padSec: number): number {
  return padSec > 0 ? padSec + SILENCE_LEAD_IN_EXTRA_SEC : 0;
}

/** The parts of `ranges` that overlap `quiet`, each at least `minSec` long. */
function intersectWithQuiet(ranges: SourceRange[], quiet: SourceRange[], minSec: number): SourceRange[] {
  const sortedQuiet = [...quiet].sort((a, b) => a.startSec - b.startSec);
  const pieces: SourceRange[] = [];
  for (const range of ranges) {
    for (const q of sortedQuiet) {
      if (q.startSec >= range.endSec) break;
      const startSec = Math.max(range.startSec, q.startSec);
      const endSec = Math.min(range.endSec, q.endSec);
      if (endSec - startSec >= minSec - FLOAT_SLACK) pieces.push({ startSec: roundMs(startSec), endSec: roundMs(endSec) });
    }
  }
  return pieces;
}

/**
 * Detect silence ranges worth cutting: gaps with no word coverage (including
 * the leading/trailing edges of `window`) at least `minSilenceSec` long,
 * shrunk by `padSec` after speech and `padSec + SILENCE_LEAD_IN_EXTRA_SEC`
 * before speech, with any overlap against `existingDeleted` trimmed away and,
 * when `quietRanges` is given, kept only where the audio is measured quiet.
 * Output is normalized (sorted, merged, clamped to `window`) and
 * deterministic — safe to call on every slider tick for a live preview, with
 * no dispatch of its own.
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

  const coverage = buildCoverageSpans(utterances, window, opts.skipWord);
  const gaps = buildGaps(coverage, window);

  const candidates: SourceRange[] = [];
  for (const gap of gaps) {
    // The ≥minSilenceSec test applies to the ORIGINAL gap, before padding.
    if (gap.endSec - gap.startSec < minSilenceSec - FLOAT_SLACK) continue;

    const paddedStart = gap.padLeft ? gap.startSec + padSec : gap.startSec;
    const paddedEnd = gap.padRight ? gap.endSec - silenceLeadInSec(padSec) : gap.endSec;
    if (paddedEnd - paddedStart <= SILENCE_MIN_CUT_SEC + FLOAT_SLACK) continue;

    candidates.push({ startSec: roundMs(paddedStart), endSec: roundMs(paddedEnd) });
  }

  const trimmed = candidates.flatMap((candidate) =>
    subtractDeletedFromCandidate(candidate, existingDeleted).filter(
      (piece) => piece.endSec - piece.startSec > SILENCE_MIN_CUT_SEC + FLOAT_SLACK,
    ),
  );

  const guarded = opts.quietRanges
    ? intersectWithQuiet(trimmed, opts.quietRanges, SILENCE_MIN_GUARDED_CUT_SEC)
    : trimmed;

  return normalizeDeletedRanges(guarded, window);
}
