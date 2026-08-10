import {
  sourceRangeToEdited,
  type EditedTimeMap,
  type TranscriptUtterance,
} from "@narriflow/validators";

// Vizard-parity Phase B step 15 (docs/plans/vizard-parity.md §1.5): word-level
// chips on the subtitle/video track, plus "fit to sentence" / "fit to word"
// zoom presets. Pure, DOM-free helpers only — timed words are already loaded
// by the transcript panel's own `useStudio()` data, so none of this needs a
// new fetch; it's cheap by construction (no I/O, O(words) at worst, most
// paths O(log n)). Rendering + the imperative active-word paint live in
// timeline.tsx, which is the sole consumer.

/** Mirrors timeline.tsx's own `TIMELINE_PX_PER_SEC = 80 * timelineZoom`.
 *  Duplicated (not imported) so this module has zero dependency on the
 *  component file and stays trivially unit-testable. */
export const TIMELINE_BASE_PX_PER_SEC = 80;

export const TIMELINE_ZOOM_MIN = 0.05;
export const TIMELINE_ZOOM_MAX = 8;

/** Below this many px per word, individual chips would be illegible —
 *  nothing renders and the segment label (already drawn) carries the low-
 *  zoom view instead. */
export const WORD_CHIP_MIN_PX_PER_WORD = 28;

/** Fit-to-word preset target: comfortably legible without wasting space. */
export const FIT_WORD_TARGET_PX_PER_WORD = 100;

/** Vizard's word preset sits at roughly 500px/s in the audited clip. */
export const FIT_WORD_TARGET_PX_PER_SEC = 500;

function clampZoom(zoom: number): number {
  return Math.max(TIMELINE_ZOOM_MIN, Math.min(TIMELINE_ZOOM_MAX, zoom));
}

/** px-per-word at a given zoom, given the average word duration in seconds. */
export function pxPerWordForZoom(zoom: number, avgWordDurationSec: number): number {
  return TIMELINE_BASE_PX_PER_SEC * zoom * avgWordDurationSec;
}

export function shouldRenderWordChips(pxPerWord: number): boolean {
  return pxPerWord >= WORD_CHIP_MIN_PX_PER_WORD;
}

/** Mean word duration across every utterance's words — the basis for both
 *  the legibility threshold and the fit-to-word preset. Falls back to a
 *  typical spoken-word duration when there are no timed words yet (e.g.
 *  transcript still loading), so callers never divide by zero. */
export function averageWordDurationSec(utterances: TranscriptUtterance[]): number {
  let count = 0;
  let total = 0;
  for (const utterance of utterances) {
    for (const word of utterance.words) {
      const dur = word.endSec - word.startSec;
      if (dur <= 0) continue;
      total += dur;
      count += 1;
    }
  }
  return count > 0 ? total / count : 0.3;
}

/** Mean utterance duration — the basis for fit-to-sentence. */
export function averageUtteranceDurationSec(utterances: TranscriptUtterance[]): number {
  let count = 0;
  let total = 0;
  for (const utterance of utterances) {
    const dur = utterance.endSec - utterance.startSec;
    if (dur <= 0) continue;
    total += dur;
    count += 1;
  }
  return count > 0 ? total / count : 2.5;
}

/** Zoom level (clamped to the timeline's 0.5-4 range) whose px-per-word is
 *  closest to `FIT_WORD_TARGET_PX_PER_WORD`. One-shot preset — the caller
 *  passes the result straight to `setTimelineZoom`; the slider stays free
 *  afterwards. */
export function zoomForFitToWord(utterances: TranscriptUtterance[]): number {
  // Keep the parameter for call-site/API stability and for the no-transcript
  // fallback, but target a stable time scale rather than the clip's average
  // speaking rate. A fast speaker should not make word blocks less readable.
  if (utterances.length === 0) return clampZoom(1);
  return clampZoom(FIT_WORD_TARGET_PX_PER_SEC / TIMELINE_BASE_PX_PER_SEC);
}

/** Zoom level that fits the complete edited clip inside the visible strip. */
export function zoomForFitToSentence(durationSec: number, viewportPx: number): number {
  if (durationSec <= 0 || viewportPx <= 0) return clampZoom(1);
  return clampZoom(viewportPx / (TIMELINE_BASE_PX_PER_SEC * durationSec));
}

// ─── Word projection + windowing ───────────────────────────────────────────

export interface WordChipDatum {
  /** Stable id (`${utteranceIndex}-${wordIndex}`), unique across the whole
   *  clip — used as the React key and the imperative active-word DOM
   *  lookup key. */
  id: string;
  text: string;
  /** Absolute source seconds (the word's own, unprojected, boundaries) —
   *  kept alongside the edited projection so the active-word check can
   *  compare directly against the playback clock's source-relative time,
   *  the same way WaveformCanvas/pause-markers already do above in
   *  timeline.tsx, without a reverse edited->source lookup per word. */
  sourceStartSec: number;
  sourceEndSec: number;
  editedStartSec: number;
  editedEndSec: number;
}

/**
 * Projects every timed word across all utterances onto the edited timeline.
 * A word entirely inside a deleted range collapses to null via
 * `sourceRangeToEdited` and is skipped outright — consistent with the
 * "collapsed" timeline convention segments/cut-markers already use (see
 * edited-timeline.ts's `projectSegmentToEdited`): a struck word occupies no
 * width, so there is nothing to draw (and nothing to dim/strike).
 *
 * Words are gathered and sorted by their own `startSec` before projecting
 * (mirrors WaveformCanvas's defensive sort a few hundred lines up in
 * timeline.tsx) rather than assumed to already be chronological — utterance
 * order isn't guaranteed strictly monotonic (overlapping speaker turns).
 * The output is therefore guaranteed sorted by both `sourceStartSec` and
 * `editedStartSec` (projection preserves order), which is what makes the
 * binary searches below valid.
 */
export function projectWordsToEdited(
  utterances: TranscriptUtterance[],
  map: EditedTimeMap,
): WordChipDatum[] {
  const raw: { id: string; text: string; startSec: number; endSec: number }[] = [];
  for (let u = 0; u < utterances.length; u++) {
    const utterance = utterances[u]!;
    for (let w = 0; w < utterance.words.length; w++) {
      const word = utterance.words[w]!;
      raw.push({ id: `${u}-${w}`, text: word.word, startSec: word.startSec, endSec: word.endSec });
    }
  }
  raw.sort((a, b) => a.startSec - b.startSec);

  const chips: WordChipDatum[] = [];
  for (const word of raw) {
    const edited = sourceRangeToEdited(map, { startSec: word.startSec, endSec: word.endSec });
    if (!edited) continue;
    chips.push({
      id: word.id,
      text: word.text,
      sourceStartSec: word.startSec,
      sourceEndSec: word.endSec,
      editedStartSec: edited.startSec,
      editedEndSec: edited.endSec,
    });
  }
  return chips;
}

/**
 * Binary-search window selection over `words` (must be sorted ascending by
 * `editedStartSec` — guaranteed by `projectWordsToEdited`). Returns every
 * chip whose span intersects `[range.startSec, range.endSec]`, matching the
 * inclusive/overscan-padded windowing the timeline's segment/cut-marker/
 * pause-marker lists already use elsewhere in timeline.tsx. O(log n + k)
 * instead of those simpler lists' `.filter()` — matters here because a
 * 2-minute clip at 4x zoom can carry ~500-600 words versus a few dozen
 * segments, and this runs on every scroll/resize tick.
 */
export function selectVisibleWordChips(
  words: WordChipDatum[],
  range: { startSec: number; endSec: number },
): WordChipDatum[] {
  if (words.length === 0 || range.endSec < range.startSec) return [];

  // First index whose editedStartSec >= range.startSec.
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (words[mid]!.editedStartSec < range.startSec) lo = mid + 1;
    else hi = mid;
  }
  // Word spans don't overlap and are sorted by editedStartSec, but a chip
  // can have zero width (a fully-collapsed word — see projectWordsToEdited's
  // `sourceRangeToEdited` skip — never reaches this list, though a word
  // clamped to near-zero width by `sourceRangeToEdited` can still share its
  // neighbor's editedStartSec), so more than one preceding chip can share
  // (or sit within FLOAT_SLACK of) the same boundary. Scan back past every
  // chip whose span still straddles the window's left edge, not just the
  // immediately preceding one.
  let start = lo;
  while (start > 0 && words[start - 1]!.editedEndSec >= range.startSec) start -= 1;

  const result: WordChipDatum[] = [];
  for (let i = start; i < words.length; i++) {
    const chip = words[i]!;
    if (chip.editedStartSec > range.endSec) break;
    result.push(chip);
  }
  return result;
}

/**
 * Finds the word whose SOURCE span contains `sourceTimeSec` (the playback
 * clock's current source-relative time — see timeline.tsx's own
 * `editedToSource(editedTimeMap, playbackClock.getSnapshot())` pattern).
 * Binary search over `words` (sorted by `sourceStartSec`, per
 * `projectWordsToEdited`'s contract) instead of a linear scan, since this
 * is meant to run on every playback-clock tick (see the imperative-paint
 * contract on TrimHandle above in timeline.tsx — recomputing "what's
 * active" per animation frame must not force a React re-render of every
 * chip). Returns null when the playhead sits in a gap between words (a
 * pause, or a word this list doesn't currently have mounted).
 */
export function findActiveWordId(words: WordChipDatum[], sourceTimeSec: number): string | null {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (words[mid]!.sourceStartSec <= sourceTimeSec) lo = mid + 1;
    else hi = mid;
  }
  const candidate = words[lo - 1];
  if (candidate && sourceTimeSec >= candidate.sourceStartSec && sourceTimeSec <= candidate.sourceEndSec) {
    return candidate.id;
  }
  return null;
}
