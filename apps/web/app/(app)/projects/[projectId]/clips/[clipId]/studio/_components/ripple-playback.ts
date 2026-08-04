import {
  editedToSource,
  isSourceTimeDeleted,
  sourceToEdited,
  type EditedTimeMap,
} from "@narriflow/validators";

// Vizard-parity Phase B step 8 (docs/plans/vizard-parity.md §4): ripple
// preview playback. The `<video>` element always decodes SOURCE time
// continuously — it has no concept of `deletedRanges` — so during playback
// the clock (which reports EDITED time; see playback-clock.ts) must detect
// the moment source playback crosses into a cut and force the video forward
// to the next kept segment. `stepRipple` is that decision, kept pure and
// side-effect-free so it's unit-testable without a real <video> element;
// playback-clock.ts is the only caller.

/** Matches the pre-ripple end-of-clip slack playback-clock.ts always used
 *  (`mediaTime >= clipEndSec - 0.02`), so the identity (no-deletions) case
 *  behaves byte-for-byte like before ripple existed. */
export const RIPPLE_END_EPSILON_SEC = 0.02;

export interface RippleStep {
  /** Edited-timeline seconds the clock should report right now. Continuous
   *  across a cut by construction — `sourceToEdited` collapses any source
   *  instant inside a deleted range forward onto the edited second where
   *  the next kept frame plays, so the scrubber never jumps. */
  editedTime: number;
  /** Set when `sourceTimeSec` has drifted into a deleted range: the caller
   *  must force the video's OWN currentTime to this SOURCE second (via
   *  whichever file/offset is actually playing) before the next tick, or
   *  the deleted footage keeps rendering on screen even though the clock
   *  already reports the correct (post-cut) edited time. */
  skipToSourceSec?: number;
  /** True when there's nothing left to play: either genuine end-of-clip, or
   *  the drift landed inside a tail cut with no kept segment left to skip
   *  to. Callers must pause/stop playback on this. */
  atEnd: boolean;
}

/**
 * Given the clip's edited-time map and the CURRENT absolute source second
 * the video element has decoded, decides what the clock should report next
 * and whether the video needs to be forced forward past a cut.
 */
export function stepRipple(map: EditedTimeMap, sourceTimeSec: number): RippleStep {
  if (map.segments.length === 0) {
    return { editedTime: 0, atEnd: true };
  }

  if (sourceTimeSec >= map.clipEndSec - RIPPLE_END_EPSILON_SEC) {
    return { editedTime: map.editedDurationSec, atEnd: true };
  }

  if (!isSourceTimeDeleted(map, sourceTimeSec)) {
    return { editedTime: sourceToEdited(map, sourceTimeSec), atEnd: false };
  }

  // Inside a cut (or in the dead zone before the clip's own start, which
  // isSourceTimeDeleted also treats as "deleted") — jump forward to the
  // next kept segment's start.
  const next = map.segments.find((segment) => segment.sourceStartSec >= sourceTimeSec);
  if (!next) {
    // Tail cut: nothing kept remains after this point.
    return { editedTime: map.editedDurationSec, atEnd: true };
  }
  return {
    editedTime: next.editedStartSec,
    skipToSourceSec: next.sourceStartSec,
    atEnd: false,
  };
}

/**
 * Where an explicit seek (not continuous playback drift) should land in
 * source time. `editedToSource` is already collision-free — it only ever
 * returns seconds inside a kept segment — so this is a thin, purpose-named
 * wrapper for call-site clarity rather than new logic.
 */
export function rippleSeekSourceSec(map: EditedTimeMap, editedTimeSec: number): number {
  return editedToSource(map, editedTimeSec);
}
