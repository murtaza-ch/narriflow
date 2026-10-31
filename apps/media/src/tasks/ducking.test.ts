import { describe, expect, test } from "bun:test";
import {
  DUCKING_DEFAULTS,
  duckingGainMultiplierAt,
  MAX_DUCKING_WINDOWS,
  type DuckingWindow,
} from "@narriflow/validators";
import {
  buildDuckingVolumeExpression,
  buildDuckingWindowSegments,
  gainFromWindowSegments,
} from "./ducking";

// `capDuckingWindows` and `extractSpeechWordIntervals` moved to
// packages/validators/src/studio-edits.test.ts (M1+M2, vizard-parity.md
// "Music/SFX library" — they're shared with the studio preview now, not
// worker-only) — see that suite instead of duplicating their tests here.

// Overall gain at time `t` across ALL windows, mirroring
// `duckingGainMultiplierAt`'s min-across-windows reduction, but built purely
// from `buildDuckingWindowSegments` + `gainFromWindowSegments` — the exact
// same segment list `buildDuckingVolumeExpression` turns into the ffmpeg
// string, so any divergence between the two proves a bug in the expression
// builder rather than in the shared window math.
function evaluateSegmentsAt(
  tSec: number,
  windows: DuckingWindow[],
  opts?: Parameters<typeof buildDuckingWindowSegments>[1],
): number {
  const perWindow = buildDuckingWindowSegments(windows, opts);
  return perWindow.reduce(
    (acc, segments) => Math.min(acc, gainFromWindowSegments(tSec, segments)),
    1,
  );
}

describe("buildDuckingWindowSegments / gainFromWindowSegments parity with duckingGainMultiplierAt", () => {
  test("single window: outside, plateau, attack ramp midpoint/edges, release ramp midpoint/edges all match exactly", () => {
    const windows: DuckingWindow[] = [{ startSec: 10, endSec: 12 }];
    const { attackSec, releaseSec, duckedGainFraction } = DUCKING_DEFAULTS;
    const samples = [
      0, // far outside
      10 - attackSec - 0.5, // before the attack ramp starts
      10 - attackSec, // attack ramp start edge (gain 1)
      10 - attackSec / 2, // attack ramp midpoint
      10, // window start edge (duckedGainFraction)
      11, // inside plateau
      12, // window end edge (duckedGainFraction)
      12 + releaseSec / 2, // release ramp midpoint
      12 + releaseSec, // release ramp end edge (gain 1)
      12 + releaseSec + 1, // after release ends
    ];
    for (const t of samples) {
      const expected = duckingGainMultiplierAt(t, windows);
      const actual = evaluateSegmentsAt(t, windows);
      expect(actual).toBeCloseTo(expected, 9);
    }

    // Explicit sign/direction check: the attack-ramp midpoint must be
    // STRICTLY BETWEEN duckedGainFraction and 1 (ramping DOWN toward the
    // window), and the release-ramp midpoint likewise strictly between —
    // a flipped ramp direction would push these outside this range (e.g.
    // clamp straight to 1 or to duckedGainFraction, or exceed 1).
    const attackMid = evaluateSegmentsAt(10 - attackSec / 2, windows);
    expect(attackMid).toBeGreaterThan(duckedGainFraction);
    expect(attackMid).toBeLessThan(1);
    expect(attackMid).toBeCloseTo(1 - 0.5 * (1 - duckedGainFraction), 9);

    const releaseMid = evaluateSegmentsAt(12 + releaseSec / 2, windows);
    expect(releaseMid).toBeGreaterThan(duckedGainFraction);
    expect(releaseMid).toBeLessThan(1);
    expect(releaseMid).toBeCloseTo(
      duckedGainFraction + 0.5 * (1 - duckedGainFraction),
      9,
    );
  });

  test("overlapping ramps from two close-but-unmerged windows take the minimum, matching duckingGainMultiplierAt", () => {
    // Two windows far enough apart that computeSpeechWindows would NOT merge
    // them (gap > mergeGapSec), but close enough that their attack/release
    // ramps overlap.
    const windows: DuckingWindow[] = [
      { startSec: 0, endSec: 1 },
      { startSec: 1.5, endSec: 2.5 },
    ];
    for (let t = -1; t <= 3.5; t += 0.05) {
      const expected = duckingGainMultiplierAt(t, windows);
      const actual = evaluateSegmentsAt(t, windows);
      expect(actual).toBeCloseTo(expected, 9);
    }
  });

  test("attackSec: 0 / releaseSec: 0 omit the corresponding ramp segment, matching duckingGainMultiplierAt's hard cut", () => {
    const windows: DuckingWindow[] = [{ startSec: 5, endSec: 6 }];
    const opts = { attackSec: 0, releaseSec: 0 };
    for (const t of [4.9, 5, 5.5, 6, 6.1]) {
      const expected = duckingGainMultiplierAt(t, windows, opts);
      const actual = evaluateSegmentsAt(t, windows, opts);
      expect(actual).toBeCloseTo(expected, 9);
    }
  });

  test("custom duckedGainFraction is honored inside the plateau and as the ramp endpoint", () => {
    const windows: DuckingWindow[] = [{ startSec: 2, endSec: 3 }];
    const opts = { duckedGainFraction: 0.1 };
    expect(evaluateSegmentsAt(2.5, windows, opts)).toBeCloseTo(0.1, 9);
    expect(evaluateSegmentsAt(2.5, windows, opts)).toBeCloseTo(
      duckingGainMultiplierAt(2.5, windows, opts),
      9,
    );
  });
});

describe("buildDuckingVolumeExpression", () => {
  test("returns null for no windows (caller must omit the filter entirely)", () => {
    expect(buildDuckingVolumeExpression([])).toBeNull();
  });

  test("emits the exact expected expression for one simple window with default opts", () => {
    const windows: DuckingWindow[] = [{ startSec: 10, endSec: 12 }];
    const { attackSec, releaseSec, duckedGainFraction } = DUCKING_DEFAULTS;
    const expr = buildDuckingVolumeExpression(windows);
    expect(expr).not.toBeNull();
    // Attack ramp clause: [10-attack, 10], 1 -> duckedGainFraction.
    expect(expr).toContain(
      `if(between(t,${(10 - attackSec).toFixed(4)},${(10).toFixed(4)}),(${(1).toFixed(4)}+(t-${(10 - attackSec).toFixed(4)})/${attackSec.toFixed(4)}*(${(duckedGainFraction - 1).toFixed(4)}))`,
    );
    // Plateau clause: [10,12], constant duckedGainFraction.
    expect(expr).toContain(
      `if(between(t,${(10).toFixed(4)},${(12).toFixed(4)}),${duckedGainFraction.toFixed(4)},`,
    );
    // Release ramp clause: [12, 12+release], duckedGainFraction -> 1.
    expect(expr).toContain(
      `if(between(t,${(12).toFixed(4)},${(12 + releaseSec).toFixed(4)}),(${duckedGainFraction.toFixed(4)}+(t-${(12).toFixed(4)})/${releaseSec.toFixed(4)}*(${(1 - duckedGainFraction).toFixed(4)}))`,
    );
    // Falls back to 1 outside every band. Three nested `if(...)` clauses
    // (attack, plateau, release) close with exactly three trailing parens
    // after the final "1" fallback.
    expect(expr!.endsWith("1)))")).toBe(true);
    expect(expr!.endsWith("1))))")).toBe(false);
  });

  test("nests a min(...) per additional window", () => {
    const windows: DuckingWindow[] = [
      { startSec: 0, endSec: 1 },
      { startSec: 5, endSec: 6 },
      { startSec: 10, endSec: 11 },
    ];
    const expr = buildDuckingVolumeExpression(windows)!;
    expect((expr.match(/min\(/g) ?? []).length).toBe(2);
  });

  test("caps window count before building the expression (bounded min() nesting)", () => {
    const windows: DuckingWindow[] = Array.from({ length: 60 }, (_, i) => ({
      startSec: i * 2,
      endSec: i * 2 + 0.3,
    }));
    const expr = buildDuckingVolumeExpression(windows)!;
    expect((expr.match(/min\(/g) ?? []).length).toBe(MAX_DUCKING_WINDOWS - 1);
  });

  test("the generated expression string never contains a single quote (safe to embed in volume='<expr>')", () => {
    const windows: DuckingWindow[] = [{ startSec: 1, endSec: 2 }];
    const expr = buildDuckingVolumeExpression(windows)!;
    expect(expr.includes("'")).toBe(false);
  });
});
