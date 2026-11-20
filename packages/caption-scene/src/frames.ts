import type { Ease, Frames } from "./ease";

export interface SampleOptions {
  /** Sample `[from, to]` only: both ends are edges and edges outside are dropped. */
  readonly range?: readonly [from: number, to: number];
  /** Edges and split points are whole ms (a one-ms segment is a jump). */
  readonly wholeMs?: boolean;
  /** Drop frames on the line between their neighbours and answer a constant as one frame. */
  readonly simplify?: boolean;
  /** Deepest halving; 12 by default. */
  readonly maxDepth?: number;
}

/**
 * A track that is not one eased segment (a sum or product of eased windows, a value derived from several tracks) as
 * keyframes. `edges` are where any window starts or ends: between two of them `fn` is smooth, and a segment is split at its
 * middle until the straight line through its ends is within `tolerance` of `fn` at the segment's quarter points. The
 * templates' one sampler; Reveal's `stepFrames` was its first copy.
 */
export function sampleFrames(fn: (t: number) => number, edges: readonly number[], tolerance: number, options: SampleOptions = {}): Frames {
  const { range, wholeMs = false, simplify = false, maxDepth = 12 } = options;
  const all = range ? [range[0], range[1], ...edges.filter((edge) => edge > range[0] && edge < range[1])] : edges;
  const sorted = [...new Set(wholeMs ? all.map(Math.round) : all)].sort((a, b) => a - b);
  const frames: [number, number, Ease?][] = [[sorted[0]!, fn(sorted[0]!)]];
  // `fn` is pure, so the value at each end of a segment is computed once and handed down (a build asks for thousands of curves).
  const split = (a: number, fa: number, b: number, fb: number, depth: number) => {
    const at = (u: number) => a + (b - a) * u;
    const off = [0.25, 0.5, 0.75].some((u) => Math.abs(fn(at(u)) - (fa + (fb - fa) * u)) > tolerance);
    if (depth < maxDepth && b - a > 1 && off) {
      const mid = wholeMs ? Math.round(at(0.5)) : at(0.5);
      const fm = fn(mid);
      split(a, fa, mid, fm, depth + 1);
      split(mid, fm, b, fb, depth + 1);
    } else frames.push([b, fb]);
  };
  let previousValue = frames[0]![1];
  for (let at = 1; at < sorted.length; at++) {
    const end = sorted[at]!;
    const endValue = fn(end);
    split(sorted[at - 1]!, previousValue, end, endValue, 0);
    previousValue = endValue;
  }
  return simplify ? simplified(frames, tolerance / 20) : frames;
}

function simplified(frames: [number, number, Ease?][], tolerance: number): Frames {
  const kept: [number, number, Ease?][] = [frames[0]!];
  for (let at = 1; at < frames.length; at++) {
    const previous = kept[kept.length - 1]!;
    const next = frames[at + 1];
    const here = frames[at]!;
    if (next) {
      const along = (here[0] - previous[0]) / (next[0] - previous[0]);
      if (Math.abs(here[1] - (previous[1] + (next[1] - previous[1]) * along)) <= tolerance) continue;
    }
    kept.push(here);
  }
  const first = kept[0]!;
  return kept.every((frame) => Math.abs(frame[1] - first[1]) <= tolerance) ? [first] : kept;
}
