/**
 * Auto-ducking v1 render support (docs/plans/vizard-parity.md "Music/SFX
 * library"). The window/gain MATH (`computeSpeechWindows`,
 * `duckingGainMultiplierAt`, `DUCKING_DEFAULTS`) AND the shared
 * extraction/capping pipeline (`extractSpeechWordIntervals`,
 * `capDuckingWindows`, `MAX_DUCKING_WINDOWS`) live in `@narriflow/validators`
 * (`studio-edits.ts`) so the studio preview's gain node and this worker can
 * never fork on "how much is music ducked at time t" (M1+M2: before this
 * move, the worker capped window count and the preview didn't, and the
 * preview's own inline word extraction had no word-less-utterance fallback
 * the worker's copy had — two independent forks in the same math). This
 * module is the worker-only remainder: turning those shared windows into an
 * ffmpeg `volume` filter expression that reproduces `duckingGainMultiplierAt`
 * exactly.
 */
import {
  capDuckingWindows,
  DUCKING_DEFAULTS,
  type DuckingOptions,
  type DuckingWindow,
} from "@narriflow/validators";

/** One linear ramp/plateau piece of a single window's gain curve. Gain is
 *  `startGain` at `startSec`, `endGain` at `endSec`, linearly interpolated
 *  between (constant when `startGain === endGain`). */
export interface DuckingSegment {
  startSec: number;
  endSec: number;
  startGain: number;
  endGain: number;
}

/**
 * Per-window ramp/plateau segments — the single source of truth both
 * `buildDuckingVolumeExpression` (the ffmpeg string) and
 * `gainFromWindowSegments` (a plain-JS evaluator used only by tests, to
 * check the expression's numbers against `duckingGainMultiplierAt`) are
 * built from. A sign/direction bug in the ramp math can't exist in the
 * ffmpeg expression without also showing up in the JS evaluator, since both
 * read the exact same `startGain`/`endGain` pairs.
 *
 * Mirrors `duckingGainMultiplierAt`'s three bands exactly: attack ramp
 * `[start-attackSec, start]` (1 -> duckedGainFraction), plateau
 * `[start, end]` (duckedGainFraction, constant), release ramp
 * `[end, end+releaseSec]` (duckedGainFraction -> 1). A ramp segment is
 * omitted entirely when its duration is <= 0, same as the `attackSec > 0` /
 * `releaseSec > 0` guards there. One inner array per window, in the same
 * order as `windows`.
 */
export function buildDuckingWindowSegments(
  windows: DuckingWindow[],
  opts?: DuckingOptions,
): DuckingSegment[][] {
  const { duckedGainFraction, attackSec, releaseSec } = {
    ...DUCKING_DEFAULTS,
    ...opts,
  };
  return windows.map((window) => {
    const segments: DuckingSegment[] = [];
    if (attackSec > 0) {
      segments.push({
        startSec: window.startSec - attackSec,
        endSec: window.startSec,
        startGain: 1,
        endGain: duckedGainFraction,
      });
    }
    segments.push({
      startSec: window.startSec,
      endSec: window.endSec,
      startGain: duckedGainFraction,
      endGain: duckedGainFraction,
    });
    if (releaseSec > 0) {
      segments.push({
        startSec: window.endSec,
        endSec: window.endSec + releaseSec,
        startGain: duckedGainFraction,
        endGain: 1,
      });
    }
    return segments;
  });
}

/**
 * Plain-JS evaluator over ONE window's segment list (test-only sibling of
 * the ffmpeg expression clause `buildDuckingVolumeExpression` emits for the
 * same window): linear interpolation within whichever segment covers `t`
 * (a window's own segments never overlap each other), `1` outside all of
 * them.
 */
export function gainFromWindowSegments(
  tSec: number,
  segments: DuckingSegment[],
): number {
  for (const segment of segments) {
    if (tSec >= segment.startSec && tSec <= segment.endSec) {
      if (segment.endSec === segment.startSec) return segment.endGain;
      const progress =
        (tSec - segment.startSec) / (segment.endSec - segment.startSec);
      return segment.startGain + progress * (segment.endGain - segment.startGain);
    }
  }
  return 1;
}

function fmt(n: number): string {
  return n.toFixed(4);
}

/**
 * ffmpeg `volume` filter expression (used as `volume='<expr>':eval=frame`,
 * single-quoted the same way `enable='between(t,...)'` already is elsewhere
 * in this file — ffmpeg's filtergraph parser would otherwise choke on the
 * commas inside `if(...)`/`between(...)` as filter-chain separators)
 * reproducing `duckingGainMultiplierAt` exactly for these windows. See
 * `buildDuckingWindowSegments`'s doc comment for why the expression and its
 * test-side evaluator can't silently diverge. Caps to `MAX_DUCKING_WINDOWS`
 * first (`capDuckingWindows`) — each window adds one `min(...)` nesting
 * level. Returns `null` for no windows; callers must omit the `volume=`
 * filter stage entirely in that case rather than emit a no-op `volume='1'`.
 */
export function buildDuckingVolumeExpression(
  windows: DuckingWindow[],
  opts?: DuckingOptions,
): string | null {
  if (windows.length === 0) return null;
  const capped = capDuckingWindows(windows);
  const perWindowSegments = buildDuckingWindowSegments(capped, opts);

  const windowExprs = perWindowSegments.map((segments) => {
    // Build innermost-first (the outer, i.e. last-applied, `if` wraps the
    // one before it as its "else"), so the final string nests as
    // `if(cond1, gain1, if(cond2, gain2, ... 1))`. Segments within one
    // window never overlap, so the order they're checked in doesn't affect
    // the VALUE — only the readability of the nested string.
    let expr = "1";
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i]!;
      const gainExpr =
        segment.startGain === segment.endGain
          ? fmt(segment.startGain)
          : `(${fmt(segment.startGain)}+(t-${fmt(segment.startSec)})/${fmt(segment.endSec - segment.startSec)}*(${fmt(segment.endGain - segment.startGain)}))`;
      expr = `if(between(t,${fmt(segment.startSec)},${fmt(segment.endSec)}),${gainExpr},${expr})`;
    }
    return expr;
  });

  // Overlapping ramp regions from adjacent (unmerged, since computeSpeechWindows
  // only merges within mergeGapSec) windows take the MINIMUM — same as
  // duckingGainMultiplierAt's `multiplier = Math.min(multiplier, windowMultiplier)`
  // reduction over windows.
  return windowExprs.reduce(
    (acc, expr) => (acc === "" ? expr : `min(${acc},${expr})`),
    "",
  );
}
