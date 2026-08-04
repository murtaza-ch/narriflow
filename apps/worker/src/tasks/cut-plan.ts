import {
  buildEditedTimeMap,
  normalizeDeletedRanges,
  type ClipWindow,
  type EditedSegment,
  type EditedTimeMap,
  type SourceRange,
} from "@narriflow/validators";

// Vizard-parity Phase B step 7 (docs/plans/vizard-parity.md §4): the worker's
// cut-plan sits directly on top of the shared `buildEditedTimeMap` helper
// (packages/validators/src/edit-ranges.ts) rather than reimplementing range
// math — this module only adds the render-specific policy `buildEditedTimeMap`
// doesn't own: dropping kept segments too short to encode/concat sanely, and
// classifying the plan so callers can pick the right ffmpeg strategy (today's
// untouched single-segment path / cut-concat / a hard "cannot render" guard).

/**
 * Below this, a "kept" segment between two cuts (or at a clip edge) isn't
 * worth its own trim+concat stage: ffmpeg's `concat` filter needs every
 * segment to actually decode at least one full frame, and a few-millisecond
 * sliver is inaudible/invisible but can make `concat` stall or error on
 * some codecs. Dropped slivers are logged and folded out of the edited
 * timeline (the surrounding gap simply gets larger).
 */
export const MIN_KEPT_SEGMENT_SEC = 0.05;

export interface ClipCutPlan {
  /** Kept source segments, source-order, each >= MIN_KEPT_SEGMENT_SEC, with
   *  edited-timeline offsets recomputed after any sliver was dropped. Empty
   *  when nothing is left to render — see `isEmpty`. */
  segments: EditedSegment[];
  /** Total duration of the concatenated edited timeline. 0 when `isEmpty`. */
  editedDurationSec: number;
  /** The same shape `packages/validators`'s `sourceToEdited` /
   *  `sourceRangeToEdited` / `isSourceTimeDeleted` expect, built from the
   *  FINAL (post sliver-drop) segment list — pass this, not a hand-rolled
   *  map, to retime anything through the shared source↔edited helpers so a
   *  dropped sliver can't disagree between the cut-concat filter graph and
   *  caption/overlay retiming. */
  map: EditedTimeMap;
  /** True when there is nothing renderable left: either every source second
   *  in the clip window was deleted, or every kept segment was a sub-50ms
   *  sliver. Callers must never attempt an encode in this state — there is
   *  no valid non-zero-duration output. */
  isEmpty: boolean;
  /** True when `deletedRanges` produced no actual cut (normalizes to zero
   *  ranges within the clip window): exactly one segment spanning the whole
   *  window. Callers MUST take the existing single-segment ffmpeg path
   *  unchanged in this case — no filter-graph changes, byte-identical to
   *  pre-cut-concat renders. */
  isUncut: boolean;
  /** Count of kept segments dropped for being under MIN_KEPT_SEGMENT_SEC,
   *  for structured logging. */
  droppedSliverCount: number;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Builds the render-time cut plan for a clip: the ordered kept source
 * segments and edited-timeline duration implied by `deletedRanges` within
 * the clip's own `[startSec, endSec)` window, after dropping any
 * sub-50ms sliver segments.
 */
export function buildClipCutPlan(
  deletedRanges: SourceRange[],
  window: ClipWindow,
): ClipCutPlan {
  const isUncut = normalizeDeletedRanges(deletedRanges, window).length === 0;

  if (isUncut) {
    const map = buildEditedTimeMap([], window);
    return {
      segments: map.segments,
      editedDurationSec: map.editedDurationSec,
      map,
      isEmpty: map.segments.length === 0,
      isUncut: true,
      droppedSliverCount: 0,
    };
  }

  const rawMap = buildEditedTimeMap(deletedRanges, window);
  const kept = rawMap.segments.filter(
    (segment) => segment.sourceEndSec - segment.sourceStartSec >= MIN_KEPT_SEGMENT_SEC,
  );
  const droppedSliverCount = rawMap.segments.length - kept.length;

  let cursor = 0;
  const segments: EditedSegment[] = kept.map((segment) => {
    const rebuilt: EditedSegment = {
      sourceStartSec: segment.sourceStartSec,
      sourceEndSec: segment.sourceEndSec,
      editedStartSec: roundMs(cursor),
    };
    cursor += segment.sourceEndSec - segment.sourceStartSec;
    return rebuilt;
  });
  const editedDurationSec = roundMs(cursor);

  const map: EditedTimeMap = {
    clipStartSec: window.startSec,
    clipEndSec: window.endSec,
    segments,
    editedDurationSec,
  };

  return {
    segments,
    editedDurationSec,
    map,
    isEmpty: segments.length === 0,
    isUncut: false,
    droppedSliverCount,
  };
}
