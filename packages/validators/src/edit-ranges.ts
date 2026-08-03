import { z } from "zod";

// Foundation for text-based ripple editing (docs/plans/vizard-parity.md §5):
// deleted ranges live in ABSOLUTE SOURCE seconds, and every consumer of clip
// time (captions, text layers, transitions, music, preview clock, burn-in)
// converts through one shared source↔edited mapping so cuts can never drift
// between the preview and the render.

export const sourceRangeSchema = z.object({
  startSec: z.number().min(0),
  endSec: z.number().min(0),
});

export const deletedRangesSchema = z.array(sourceRangeSchema).max(500).default([]);

export type SourceRange = z.infer<typeof sourceRangeSchema>;

export interface ClipWindow {
  startSec: number;
  endSec: number;
}

export interface EditedSegment {
  sourceStartSec: number;
  sourceEndSec: number;
  editedStartSec: number;
}

export interface EditedTimeMap {
  clipStartSec: number;
  clipEndSec: number;
  /** Kept source segments in source order; contiguous on the edited timeline. */
  segments: EditedSegment[];
  editedDurationSec: number;
}

// Two cuts closer than this merge into one; degenerate ranges are dropped.
// 1ms matches the timing precision used across clip-timing.
export const EDIT_RANGE_EPSILON_SEC = 0.001;

// Slack for float comparisons at exactly the epsilon boundary (0.001 is not
// representable in binary, so 20.001 - 20 > 0.001 without it).
const FLOAT_SLACK = 1e-9;

function roundMs(value: number) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Clamp to the clip window, drop degenerate/inverted ranges, sort, and merge
 * overlapping or near-adjacent ranges. Output is the canonical persisted form.
 */
export function normalizeDeletedRanges(
  ranges: SourceRange[],
  window: ClipWindow,
): SourceRange[] {
  const clamped = ranges
    .map((range) => ({
      startSec: roundMs(Math.max(range.startSec, window.startSec)),
      endSec: roundMs(Math.min(range.endSec, window.endSec)),
    }))
    .filter(
      (range) =>
        range.endSec - range.startSec >= EDIT_RANGE_EPSILON_SEC - FLOAT_SLACK,
    )
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

  const merged: SourceRange[] = [];
  for (const range of clamped) {
    const last = merged[merged.length - 1];
    if (last && range.startSec - last.endSec <= EDIT_RANGE_EPSILON_SEC + FLOAT_SLACK) {
      last.endSec = Math.max(last.endSec, range.endSec);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Build the kept-segment map for a clip window minus its deleted ranges.
 * Deleting everything yields zero segments and zero duration — callers must
 * guard against persisting that state.
 */
export function buildEditedTimeMap(
  deletedRanges: SourceRange[],
  window: ClipWindow,
): EditedTimeMap {
  const deleted = normalizeDeletedRanges(deletedRanges, window);
  const segments: EditedSegment[] = [];
  let cursor = window.startSec;
  let editedCursor = 0;

  const pushKept = (sourceStartSec: number, sourceEndSec: number) => {
    if (sourceEndSec - sourceStartSec < EDIT_RANGE_EPSILON_SEC) return;
    segments.push({
      sourceStartSec: roundMs(sourceStartSec),
      sourceEndSec: roundMs(sourceEndSec),
      editedStartSec: roundMs(editedCursor),
    });
    editedCursor += sourceEndSec - sourceStartSec;
  };

  for (const range of deleted) {
    pushKept(cursor, range.startSec);
    cursor = Math.max(cursor, range.endSec);
  }
  pushKept(cursor, window.endSec);

  return {
    clipStartSec: window.startSec,
    clipEndSec: window.endSec,
    segments,
    editedDurationSec: roundMs(editedCursor),
  };
}

export function isSourceTimeDeleted(map: EditedTimeMap, sourceSec: number): boolean {
  if (sourceSec < map.clipStartSec || sourceSec > map.clipEndSec) return true;
  return !map.segments.some(
    (segment) =>
      sourceSec >= segment.sourceStartSec && sourceSec <= segment.sourceEndSec,
  );
}

/**
 * Source → edited seconds. Instants inside a cut collapse forward onto the
 * edited time of the cut point (the same instant the next kept frame plays),
 * which is what timed overlays and cues need.
 */
export function sourceToEdited(map: EditedTimeMap, sourceSec: number): number {
  if (map.segments.length === 0) return 0;
  for (const segment of map.segments) {
    if (sourceSec < segment.sourceStartSec) return segment.editedStartSec;
    if (sourceSec <= segment.sourceEndSec) {
      return roundMs(segment.editedStartSec + (sourceSec - segment.sourceStartSec));
    }
  }
  return map.editedDurationSec;
}

/**
 * Edited → source seconds. Input clamps into [0, editedDurationSec].
 * Segment intervals are half-open on the edited timeline: an edited instant
 * that lands exactly on a cut maps to the source frame that actually plays
 * next (the start of the following kept segment), matching playback/seeking.
 */
export function editedToSource(map: EditedTimeMap, editedSec: number): number {
  const first = map.segments[0];
  if (!first) return map.clipStartSec;
  if (editedSec <= 0) return first.sourceStartSec;

  for (let i = 0; i < map.segments.length; i += 1) {
    const segment = map.segments[i]!;
    const isLast = i === map.segments.length - 1;
    const length = segment.sourceEndSec - segment.sourceStartSec;
    const offset = editedSec - segment.editedStartSec;
    if (offset < length || (isLast && offset <= length)) {
      return roundMs(segment.sourceStartSec + Math.max(0, Math.min(offset, length)));
    }
  }
  const last = map.segments[map.segments.length - 1]!;
  return last.sourceEndSec;
}

/**
 * Map a source range onto the edited timeline. Returns null when the range is
 * entirely inside cuts (the overlay/cue should not render at all).
 */
export function sourceRangeToEdited(
  map: EditedTimeMap,
  range: SourceRange,
): SourceRange | null {
  const startSec = sourceToEdited(map, range.startSec);
  const endSec = sourceToEdited(map, range.endSec);
  if (endSec - startSec < EDIT_RANGE_EPSILON_SEC) return null;
  return { startSec, endSec };
}
