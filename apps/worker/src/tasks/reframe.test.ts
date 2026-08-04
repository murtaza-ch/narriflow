import { describe, expect, test } from "bun:test";
import {
  buildReframeSendcmdScript,
  cropXForCenter,
  remapFaceSamplesForCutPlan,
  smoothFacePath,
} from "./reframe";
import { buildClipCutPlan } from "./cut-plan";

describe("smoothFacePath", () => {
  test("returns empty when no frame ever had a face", () => {
    const out = smoothFacePath([
      { t: 0, cx: null },
      { t: 0.5, cx: null },
    ]);
    expect(out).toEqual([]);
  });

  test("carries the last known center across gaps and eases toward it", () => {
    const out = smoothFacePath(
      [
        { t: 0, cx: 0.2 },
        { t: 0.5, cx: null }, // gap — holds
        { t: 1.0, cx: 0.8 }, // big move
        { t: 1.5, cx: 0.8 },
        { t: 2.0, cx: 0.8 },
      ],
      { smoothing: 0.5, deadZone: 0.04 },
    );
    expect(out).toHaveLength(5);
    // Starts at the first face center, then eases toward 0.8 (never overshoots).
    expect(out[0]!.cx).toBeCloseTo(0.2, 5);
    expect(out[4]!.cx).toBeGreaterThan(out[0]!.cx);
    expect(out[4]!.cx).toBeLessThanOrEqual(0.8);
    // Monotonic easing toward the new target.
    expect(out[4]!.cx).toBeGreaterThan(out[2]!.cx);
  });

  test("dead-zone holds the crop still on sub-threshold jitter", () => {
    const out = smoothFacePath(
      [
        { t: 0, cx: 0.5 },
        { t: 0.1, cx: 0.51 },
        { t: 0.2, cx: 0.49 },
        { t: 0.3, cx: 0.5 },
      ],
      { smoothing: 0.5, deadZone: 0.05 },
    );
    // Jitter under the dead-zone never moves the target, so it stays at 0.5.
    for (const sample of out) expect(sample.cx).toBeCloseTo(0.5, 5);
  });
});

describe("cropXForCenter", () => {
  test("clamps the crop window inside the frame", () => {
    // 1920 wide, 608-wide crop (9:16 of 1080 height).
    expect(cropXForCenter(0, 1920, 608)).toBe(0);
    expect(cropXForCenter(1, 1920, 608)).toBe(1920 - 608);
    // Centered face -> centered crop.
    expect(cropXForCenter(0.5, 1920, 608)).toBe(Math.round(960 - 304));
  });
});

describe("buildReframeSendcmdScript", () => {
  test("emits sendcmd lines for the named crop and collapses duplicate x", () => {
    const script = buildReframeSendcmdScript(
      [
        { t: 0, cx: 0.5 },
        { t: 0.25, cx: 0.5 }, // same crop x -> collapsed
        { t: 0.5, cx: 0.1 }, // moves -> new line
      ],
      1920,
      608,
      "crop@reframe",
    );
    const lines = script.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith("0.000 crop@reframe x ")).toBe(true);
    expect(lines[1]!.startsWith("0.500 crop@reframe x ")).toBe(true);
  });

  test("returns empty string for no samples", () => {
    expect(buildReframeSendcmdScript([], 1920, 608)).toBe("");
  });
});

describe("remapFaceSamplesForCutPlan (fix #3: raw samples are elapsed-uncut-source time, the crop runs post-concat)", () => {
  // 30s clip window [0,30), one mid-clip deletion [10,15) -> kept segments
  // [0,10) and [15,30), 25s edited duration.
  const window = { startSec: 0, endSec: 30 };
  const cutPlan = buildClipCutPlan([{ startSec: 10, endSec: 15 }], window);
  const clipStartSec = 0;

  test("is a single-group passthrough when the clip is uncut", () => {
    const uncutPlan = buildClipCutPlan([], window);
    const samples = [{ t: 0, cx: 0.5 }, { t: 12, cx: 0.6 }];
    expect(remapFaceSamplesForCutPlan(samples, uncutPlan, clipStartSec)).toEqual([
      samples,
    ]);
  });

  test("a sample before any cut lands in the first group unchanged", () => {
    const groups = remapFaceSamplesForCutPlan(
      [{ t: 4, cx: 0.5 }],
      cutPlan,
      clipStartSec,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual([{ t: 4, cx: 0.5 }]);
    expect(groups[1]).toEqual([]);
  });

  test("a sample after a cut gets the edited timestamp, in the second group", () => {
    // t=20 (elapsed uncut-source) -> source 20 -> second kept segment
    // (source [15,30) -> edited [10,25)) -> edited 10 + (20-15) = 15.
    const groups = remapFaceSamplesForCutPlan(
      [{ t: 20, cx: 0.7 }],
      cutPlan,
      clipStartSec,
    );
    expect(groups[1]).toEqual([{ t: 15, cx: 0.7 }]);
  });

  test("a sample inside a cut is dropped from every group", () => {
    const groups = remapFaceSamplesForCutPlan(
      [
        { t: 4, cx: 0.5 }, // kept, first segment
        { t: 12, cx: 0.55 }, // inside the deleted [10,15) range -> dropped
        { t: 20, cx: 0.7 }, // kept, second segment, shifted
      ],
      cutPlan,
      clipStartSec,
    );
    expect(groups).toEqual([
      [{ t: 4, cx: 0.5 }],
      [{ t: 15, cx: 0.7 }],
    ]);
  });

  test("script-generation level: a sample after a cut produces a sendcmd line at the edited timestamp, not the raw one", () => {
    const groups = remapFaceSamplesForCutPlan(
      [
        { t: 2, cx: 0.2 },
        { t: 20, cx: 0.8 }, // raw 20 -> edited 15
      ],
      cutPlan,
      clipStartSec,
    );
    const smoothed = groups.flatMap((group) => smoothFacePath(group));
    const script = buildReframeSendcmdScript(smoothed, 1920, 608);
    // The raw (wrong) elapsed-source timestamp never appears...
    expect(script).not.toContain("20.000");
    // ...the edited (correct) post-concat timestamp does.
    expect(script).toContain("15.000");
  });

  test("smoothing resets at the kept-segment boundary instead of drifting across the cut", () => {
    // A big, sudden face jump exactly at the cut: last pre-cut sample near
    // 0.1, first post-cut sample far away at 0.9. Smoothing WITHOUT a reset
    // (one flat smoothFacePath call across the concatenated raw list) would
    // ease slowly toward 0.9 over several samples; grouping by segment must
    // instead seed a fresh EMA at the new segment's own first face center.
    const preCut = [
      { t: 1, cx: 0.1 },
      { t: 2, cx: 0.1 },
      { t: 3, cx: 0.1 },
    ];
    const postCut = [
      { t: 16, cx: 0.9 }, // source 16 -> edited 11
      { t: 17, cx: 0.9 },
    ];
    const groups = remapFaceSamplesForCutPlan(
      [...preCut, ...postCut],
      cutPlan,
      clipStartSec,
    );
    const perSegmentSmoothed = groups.flatMap((group) =>
      smoothFacePath(group, { smoothing: 0.3, deadZone: 0.04 }),
    );
    // The first post-cut sample is the boundary reset — it doesn't inherit
    // any EMA inertia from the pre-cut group, so it must be seeded exactly at
    // its own group's first raw face center, not eased partway from 0.1.
    const firstPostCutSmoothed = perSegmentSmoothed[preCut.length]!;
    expect(firstPostCutSmoothed.cx).toBeCloseTo(0.9, 5);

    // Contrast: smoothing the same samples as ONE flat list (no per-segment
    // reset) would still be easing away from 0.1 at that same index.
    const flatSmoothed = smoothFacePath(
      groups.flat(),
      { smoothing: 0.3, deadZone: 0.04 },
    );
    expect(flatSmoothed[preCut.length]!.cx).toBeLessThan(0.9);
  });
});
