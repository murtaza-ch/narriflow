import {
  editedToSource,
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

/** Fix 5 (Phase B hardening): tolerance for treating a pending forced-skip
 *  target as "the same skip already in flight" — see `shouldIssueRippleSkip`. */
export const RIPPLE_SKIP_EPSILON_SEC = 0.05;

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
 * Fix 7 (Phase B hardening): whether `sourceSec` is inside a kept segment
 * for CONTINUOUS PLAYBACK specifically — distinct from the shared
 * `isSourceTimeDeleted`, which treats a kept segment's `sourceEndSec` as
 * still kept (a closed interval). That's the right call for instantaneous
 * lookups (captions, overlays, the fix-3 reconciliation effect — landing
 * exactly on a cut boundary should still resolve to "the frame right
 * there"), but wrong for a video element DECODING forward through time:
 * ffmpeg's own trim/concat is half-open on the end, so the source frame at
 * exactly `sourceEndSec` is really the first DELETED frame, not the last
 * kept one. Treating it as kept let one deleted frame flash before the
 * skip fired. Ownership is half-open on every segment's trailing edge,
 * including the last kept segment when a tail cut follows it. The raw clip
 * end is handled by `stepRipple`'s epsilon check before this predicate.
 */
function isKeptForContinuousPlayback(map: EditedTimeMap, sourceSec: number): boolean {
  return map.segments.some((segment) => {
    if (sourceSec < segment.sourceStartSec) return false;
    return sourceSec < segment.sourceEndSec;
  });
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

  if (isKeptForContinuousPlayback(map, sourceTimeSec)) {
    return { editedTime: sourceToEdited(map, sourceTimeSec), atEnd: false };
  }

  // Inside a cut (or in the dead zone before the clip's own start, or
  // exactly on a kept segment's half-open trailing edge — see
  // `isKeptForContinuousPlayback`) — jump forward to the next kept
  // segment's start.
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
 * Fix 5 (Phase B hardening): whether playback-clock.ts should (re)issue a
 * `video.currentTime = target` assignment for a forced ripple skip.
 * `updateFromMediaTime` runs every rVFC/timeupdate tick, and while a seek is
 * still resolving the video's own `currentTime`/`mediaTime` hasn't caught up
 * yet — without this guard, `stepRipple` keeps returning the SAME
 * `skipToSourceSec` every tick, and the caller kept reissuing the identical
 * assignment, which can restart/stutter an in-flight seek on some browsers
 * instead of letting it complete once. Pure so the de-dupe decision is
 * unit-testable without a real `<video>` element; playback-clock.ts is the
 * only caller.
 */
export function shouldIssueRippleSkip(
  targetSourceSec: number,
  pendingTargetSourceSec: number | null,
  isSeeking: boolean,
): boolean {
  if (isSeeking) return false;
  if (pendingTargetSourceSec === null) return true;
  return Math.abs(pendingTargetSourceSec - targetSourceSec) >= RIPPLE_SKIP_EPSILON_SEC;
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
