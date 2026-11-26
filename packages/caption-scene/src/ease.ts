/**
 * The sample player's eases and keyframe interpolation (`samples/harness.js`), copied exactly: the
 * templates were designed against these curves, so the evaluator that both renderers use must
 * produce the same numbers.
 */

export type Ease = "linear" | "out" | "outQuint" | "outExpo" | "in" | "inOut" | "outBack" | "spring";

export const clamp = (value: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, value));
export const lerp = (from: number, to: number, p: number): number => from + (to - from) * p;
/** Progress 0..1 of a window that starts at `start` and lasts `dur` ms. */
export const prog = (t: number, start: number, dur: number): number => (dur <= 0 ? (t >= start ? 1 : 0) : clamp((t - start) / dur));

export const EASES: Readonly<Record<Ease, (p: number) => number>> = {
  linear: (p) => p,
  out: (p) => 1 - (1 - p) ** 3,
  outQuint: (p) => 1 - (1 - p) ** 5,
  outExpo: (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p)),
  in: (p) => p ** 3,
  inOut: (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2),
  outBack: (p) => 1 + (1.70158 + 1) * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2,
  /** Overshoots once and settles: for slaps, stamps and jelly. */
  spring: (p) => (p >= 1 ? 1 : 1 - Math.exp(-7 * p) * Math.cos(11 * p)),
};

export const ease = (name: Ease | undefined, p: number): number => (EASES[name ?? "linear"] ?? EASES.linear)(p);

/** [atMs, value, ease of the segment arriving at this frame]: the harness's `kf` semantics. */
export type Frames = readonly (readonly [number, number, Ease?])[];

/**
 * Keyframes at `t`. The ease on a frame shapes the segment that arrives at it. Before the first
 * frame the first value holds, after the last the last.
 *
 * The hottest function of a scene build (every bounds sample of every piece lands here), so it
 * indexes the frames instead of destructuring them: V8 runs array destructuring through the
 * iterator protocol, which made this loop most of a heavy template's build time in Chrome.
 */
export function kf(t: number, frames: Frames): number {
  const count = frames.length;
  if (count === 0) throw new Error("kf needs at least one frame");
  let previous = frames[0]!;
  if (t <= previous[0]) return previous[1];
  for (let index = 1; index < count; index++) {
    const frame = frames[index]!;
    const at = frame[0];
    if (t <= at) {
      const previousAt = previous[0];
      return lerp(previous[1], frame[1], ease(frame[2], (t - previousAt) / (at - previousAt || 1)));
    }
    previous = frame;
  }
  return previous[1];
}
