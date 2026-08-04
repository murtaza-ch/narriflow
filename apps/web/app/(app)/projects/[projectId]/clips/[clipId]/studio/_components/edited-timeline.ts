import {
  buildEditedTimeMap,
  normalizeDeletedRanges,
  sourceRangeToEdited,
  sourceToEdited,
  type ClipWindow,
  type EditedSegment,
  type EditedTimeMap,
  type SourceRange,
} from "@narriflow/validators";

// Vizard-parity Phase B steps 8-9 (docs/plans/vizard-parity.md §4): the
// studio's edited-timeline model sits directly on top of the shared
// `buildEditedTimeMap` helper (packages/validators/src/edit-ranges.ts)
// rather than reimplementing range math, and mirrors the RENDER-specific
// sliver policy from apps/worker/src/tasks/cut-plan.ts's
// `buildClipCutPlan` — worker code isn't importable from web, so that
// policy is duplicated here (not re-exported) rather than shared. Keeping
// the two in lockstep matters: if the studio's displayed/played duration
// disagreed with what the worker actually renders (e.g. by counting a
// sub-50ms sliver the worker would drop), the preview and the export would
// silently diverge — see cut-plan.ts's own doc comment for why the
// threshold exists.

/** Mirrors `MIN_KEPT_SEGMENT_SEC` in apps/worker/src/tasks/cut-plan.ts. Keep
 *  these two values equal by hand — worker code can't be imported here. */
export const STUDIO_MIN_KEPT_SEGMENT_SEC = 0.05;

export interface StudioCutPlan {
  /** Kept source segments, source-order, each >= STUDIO_MIN_KEPT_SEGMENT_SEC,
   *  with edited-timeline offsets recomputed after any sliver was dropped. */
  segments: EditedSegment[];
  editedDurationSec: number;
  /** Pass this (not a hand-rolled map) to `sourceToEdited`/`editedToSource`/
   *  `sourceRangeToEdited`/`isSourceTimeDeleted` so a dropped sliver can't
   *  disagree between what's displayed/played and what the worker renders. */
  map: EditedTimeMap;
  /** True when there is nothing left to play — deleting the clip down to
   *  this must be blocked client-side before it's ever dispatched (mirrors
   *  the worker's render-time guard). */
  isEmpty: boolean;
  /** True when `deletedRanges` produced no actual cut — the identity/fast
   *  path: `map` is then a single segment spanning the whole window and
   *  `editedDurationSec` equals `window.endSec - window.startSec` exactly,
   *  so existing (pre-ripple) behavior is byte-for-byte unchanged. */
  isUncut: boolean;
  /** Count of kept segments dropped for being under
   *  STUDIO_MIN_KEPT_SEGMENT_SEC — surfaced for parity with the worker's
   *  structured logging; the studio itself doesn't currently log this. */
  droppedSliverCount: number;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Builds the studio's edited-timeline plan for a clip: the ordered kept
 * source segments and edited-timeline duration implied by `deletedRanges`
 * within the clip's own `[startSec, endSec)` window, after dropping any
 * sub-50ms sliver segments — mirrors
 * apps/worker/src/tasks/cut-plan.ts's `buildClipCutPlan`.
 */
export function buildStudioCutPlan(
  deletedRanges: SourceRange[],
  window: ClipWindow,
): StudioCutPlan {
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
    (segment) =>
      segment.sourceEndSec - segment.sourceStartSec >= STUDIO_MIN_KEPT_SEGMENT_SEC,
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

/**
 * Projects a client-only timeline segment — stored clip-relative-to-source
 * (`startSec`/`endSec` are seconds since `clipStartSec`, the convention
 * `buildSegmentsFromUtterances` in studio/page.tsx has always used) — onto
 * the edited timeline for rendering. Returns null when the segment's source
 * range is now entirely inside a cut (it collapsed to nothing and should not
 * be drawn as a block at all — see the "collapsed + cut markers" decision in
 * the Phase B step 9 report).
 */
export function projectSegmentToEdited<T extends { startSec: number; endSec: number }>(
  segment: T,
  clipStartSec: number,
  map: EditedTimeMap,
): (T & { startSec: number; endSec: number }) | null {
  const edited = sourceRangeToEdited(map, {
    startSec: clipStartSec + segment.startSec,
    endSec: clipStartSec + segment.endSec,
  });
  if (!edited) return null;
  return { ...segment, startSec: edited.startSec, endSec: edited.endSec };
}

export interface CutMarker {
  id: string;
  /** Edited-timeline second the cut collapsed to — where kept content
   *  before and after the deletion now meet. */
  editedSec: number;
  /** The absolute-source-seconds range this marker reverts (Revert
   *  dispatches `revertRange` with exactly this range). */
  range: SourceRange;
  durationSec: number;
}

/**
 * One marker per (already-normalized) deleted range, positioned at the
 * edited second the cut collapsed to. The "collapsed" timeline convention
 * (see report) means deleted spans never occupy width on the ruler — this is
 * the only remaining visual trace of a deletion, and its Revert affordance
 * is the recoverability Vizard's delete model relies on.
 */
export function deletedRangesToCutMarkers(
  deletedRanges: SourceRange[],
  map: EditedTimeMap,
): CutMarker[] {
  return deletedRanges.map((range, i) => ({
    id: `cut-${i}-${range.startSec}`,
    editedSec: sourceToEdited(map, range.startSec),
    range,
    durationSec: roundMs(range.endSec - range.startSec),
  }));
}
