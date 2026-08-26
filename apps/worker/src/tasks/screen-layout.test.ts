import { describe, expect, test } from "bun:test";
import type { FaceSample } from "./reframe";
import {
  classifyScreencast,
  confirmsFaceInRect,
  selectPipRect,
  type PipCandidate,
} from "./screen-layout";

function faceSample(cx: number | null): FaceSample {
  return { t: 0, cx };
}

describe("classifyScreencast — motion-fraction classification gate", () => {
  // H1 (adversarial review): default recalibrated to 0.12 — the geometric
  // mean of the PROXY-domain boundary values (worst-case screencast fixture
  // ~0.051, worst-case jensen control ~0.273) — see
  // `classifyScreencast`'s own doc comment and
  // `docs/plans/vizard-parity.md`'s landed note for the full table.
  test("below the default threshold (0.12): screencast-like", () => {
    expect(classifyScreencast(0.0)).toBe(true);
    expect(classifyScreencast(0.05)).toBe(true);
    expect(classifyScreencast(0.11)).toBe(true);
  });

  test("at/above the default threshold: NOT screencast-like", () => {
    expect(classifyScreencast(0.12)).toBe(false);
    expect(classifyScreencast(0.27)).toBe(false);
    expect(classifyScreencast(1.0)).toBe(false);
  });

  test("an explicit startup-frozen threshold overrides the default", () => {
    expect(classifyScreencast(0.3, 0.5)).toBe(true);
    expect(classifyScreencast(0.6, 0.5)).toBe(false);
  });
});

describe("selectPipRect — corner-adjacent + compact + dense structural prior", () => {
  // The spike's headline measured failure: a large, non-corner-adjacent
  // "embedded video-in-video" blob has the biggest area/motion of any
  // candidate — a naive "pick the largest/most-moving blob" selector would
  // choose it (IoU 0.000 against the real facecam in the spike). The
  // corner-adjacent gate must reject it outright, regardless of its size.
  test("rejects a large, non-corner-adjacent blob even when it's the biggest/most-moving candidate (naive-largest failure mode)", () => {
    const embeddedVideo: PipCandidate = {
      x: 0.1,
      y: 0.1,
      w: 0.4,
      h: 0.4,
      areaFrac: 0.16, // biggest by far — outside the 0.5%-15% acceptance window AND not corner-adjacent
      fillFrac: 0.9,
      cornerAdjacent: false,
      medianDiffMean: 20,
    };
    const facecam: PipCandidate = {
      x: 0.79,
      y: 0.78,
      w: 0.2,
      h: 0.2,
      areaFrac: 0.04,
      fillFrac: 0.9,
      cornerAdjacent: true,
      medianDiffMean: 4.6,
    };
    const naiveLargest = [embeddedVideo, facecam].reduce((a, b) =>
      b.areaFrac > a.areaFrac ? b : a,
    );
    expect(naiveLargest).toBe(embeddedVideo); // documents the naive failure mode
    expect(selectPipRect([embeddedVideo, facecam])).toEqual({
      x: 0.79,
      y: 0.78,
      w: 0.2,
      h: 0.2,
    });
  });

  test("rejects a corner-adjacent candidate whose area is below the acceptance window (noise speck)", () => {
    const speck: PipCandidate = {
      x: 0.01,
      y: 0.01,
      w: 0.02,
      h: 0.02,
      areaFrac: 0.0004,
      fillFrac: 0.9,
      cornerAdjacent: true,
      medianDiffMean: 50,
    };
    expect(selectPipRect([speck])).toBeNull();
  });

  test("rejects a corner-adjacent candidate whose area is above the acceptance window (too big to be an overlay)", () => {
    const huge: PipCandidate = {
      x: 0,
      y: 0,
      w: 0.5,
      h: 0.5,
      areaFrac: 0.25,
      fillFrac: 0.9,
      cornerAdjacent: true,
      medianDiffMean: 10,
    };
    expect(selectPipRect([huge])).toBeNull();
  });

  test("rejects a compact but non-corner-adjacent candidate (a hand gesture mid-frame, not an overlay)", () => {
    const midFrameBlob: PipCandidate = {
      x: 0.4,
      y: 0.4,
      w: 0.1,
      h: 0.1,
      areaFrac: 0.01,
      fillFrac: 0.9,
      cornerAdjacent: false,
      medianDiffMean: 8,
    };
    expect(selectPipRect([midFrameBlob])).toBeNull();
  });

  // M1 (adversarial review): a candidate can be corner-adjacent and the
  // right size, yet still not be trustworthy as a facecam if the actual
  // thresholded pixels only sparsely fill their own bounding box (e.g. an
  // L-shaped scatter formed by disjoint bits of motion sharing one bbox).
  test("rejects a corner-adjacent, in-bounds-area candidate whose fillFrac is below the density gate", () => {
    const sparse: PipCandidate = {
      x: 0.8,
      y: 0.8,
      w: 0.15,
      h: 0.15,
      areaFrac: 0.0225,
      fillFrac: 0.2, // below the default 0.35 gate
      cornerAdjacent: true,
      medianDiffMean: 10,
    };
    expect(selectPipRect([sparse])).toBeNull();
    expect(selectPipRect([sparse], { minFillFrac: 0.1 })).toEqual({
      x: 0.8,
      y: 0.8,
      w: 0.15,
      h: 0.15,
    });
  });

  test("returns null for an empty candidate list", () => {
    expect(selectPipRect([])).toBeNull();
  });

  test("custom area bounds override the defaults", () => {
    const candidate: PipCandidate = {
      x: 0.8,
      y: 0.8,
      w: 0.3,
      h: 0.3,
      areaFrac: 0.09,
      fillFrac: 0.9,
      cornerAdjacent: true,
      medianDiffMean: 3,
    };
    expect(selectPipRect([candidate], { maxAreaFrac: 0.05 })).toBeNull();
    expect(selectPipRect([candidate], { maxAreaFrac: 0.1 })).toEqual({
      x: 0.8,
      y: 0.8,
      w: 0.3,
      h: 0.3,
    });
  });

  // M1 (adversarial review): a real facecam frequently thresholds into more
  // than one connected component (e.g. a bright face + a dimmer shoulder/
  // bezel edge separated by a thin gap the morphological close didn't fully
  // bridge) — those must be treated as ONE region, not compete as two
  // independent (and individually weaker) candidates.
  test("merges two adjacent (gap < 2% of frame) corner-qualifying candidates into their bbox union", () => {
    const a: PipCandidate = {
      x: 0.78,
      y: 0.78,
      w: 0.1,
      h: 0.1,
      areaFrac: 0.01,
      fillFrac: 0.8,
      cornerAdjacent: true,
      medianDiffMean: 6,
    };
    const b: PipCandidate = {
      // Starts 0.015 (< the 0.02 merge-gap threshold) past `a`'s right edge
      // (0.88), same y-span — no bbox overlap, but close enough to merge.
      x: 0.895,
      y: 0.78,
      w: 0.08,
      h: 0.1,
      areaFrac: 0.008,
      fillFrac: 0.5,
      cornerAdjacent: true,
      medianDiffMean: 6,
    };
    const merged = selectPipRect([a, b]);
    expect(merged?.x).toBeCloseTo(0.78, 6);
    expect(merged?.y).toBeCloseTo(0.78, 6);
    expect(merged?.w).toBeCloseTo(0.195, 6); // union: [0.78, 0.975]
    expect(merged?.h).toBeCloseTo(0.1, 6);
  });

  test("does NOT merge two qualifying candidates that are far apart (gap >= 2% of frame) — they compete instead", () => {
    // Well-separated (top-left vs. bottom-right), so no merge; the
    // bottom-right one has the higher pixel-area-weighted medianDiffMean
    // despite being much smaller — see the "highest medianDiffMean" test
    // below for that selection rule specifically.
    const topLeft: PipCandidate = {
      x: 0.02,
      y: 0.02,
      w: 0.1,
      h: 0.1,
      areaFrac: 0.01,
      fillFrac: 0.5,
      cornerAdjacent: true,
      medianDiffMean: 3,
    };
    const bottomRight: PipCandidate = {
      x: 0.85,
      y: 0.85,
      w: 0.1,
      h: 0.1,
      areaFrac: 0.01,
      fillFrac: 0.5,
      cornerAdjacent: true,
      medianDiffMean: 3,
    };
    // Same medianDiffMean, same size — with no merge, either could win on a
    // tie; the point of this test is just that the RESULT is one of the two
    // untouched candidates, not some merged hybrid (which would indicate a
    // merge incorrectly fired across the whole frame).
    const result = selectPipRect([topLeft, bottomRight]);
    expect([topLeft, bottomRight].some((c) => result?.x === c.x && result?.y === c.y)).toBe(true);
  });

  // M1 (adversarial review): the OLD policy picked the smallest qualifying
  // candidate outright — that was never spike-validated (the spike
  // validated the corner-adjacent + compact-size prior, not "prefer
  // smallest among several qualifiers") and has an obvious failure mode: a
  // tiny noise-adjacent fragment could beat a much more clearly
  // motion-dense region purely by being smaller. Current policy selects the
  // HIGHEST pixel-area-weighted `medianDiffMean` instead.
  test("selects the candidate with the highest (pixel-area-weighted) medianDiffMean, NOT the smallest", () => {
    const big: PipCandidate = {
      x: 0.02,
      y: 0.02,
      w: 0.3,
      h: 0.3,
      areaFrac: 0.09,
      fillFrac: 0.5,
      cornerAdjacent: true,
      medianDiffMean: 3, // low motion strength
    };
    const small: PipCandidate = {
      x: 0.85,
      y: 0.85,
      w: 0.1,
      h: 0.1,
      areaFrac: 0.01,
      fillFrac: 0.5,
      cornerAdjacent: true,
      medianDiffMean: 8, // high motion strength, wins despite being 9x smaller
    };
    expect(selectPipRect([big, small])).toEqual({ x: 0.85, y: 0.85, w: 0.1, h: 0.1 });
  });

  test("ties on medianDiffMean break toward the SMALLER (tighter) bbox", () => {
    const bigger: PipCandidate = {
      x: 0.02,
      y: 0.02,
      w: 0.25,
      h: 0.25,
      areaFrac: 0.0625,
      fillFrac: 0.5,
      cornerAdjacent: true,
      medianDiffMean: 4,
    };
    const smaller: PipCandidate = {
      x: 0.85,
      y: 0.75,
      w: 0.125,
      h: 0.25,
      areaFrac: 0.03125,
      fillFrac: 0.5,
      cornerAdjacent: true,
      medianDiffMean: 4,
    };
    expect(selectPipRect([bigger, smaller])).toEqual({
      x: 0.85,
      y: 0.75,
      w: 0.125,
      h: 0.25,
    });
  });
});

describe("confirmsFaceInRect — H2 (face-confirmation guard against motion-only false positives)", () => {
  const pipRect = { x: 0.7, y: 0.7, w: 0.2, h: 0.2 };

  test("confirms when faces are found in enough samples AND mostly fall inside the rect", () => {
    const samples: FaceSample[] = [
      faceSample(0.75),
      faceSample(0.8),
      faceSample(0.78),
      faceSample(null),
    ];
    expect(confirmsFaceInRect(samples, pipRect)).toBe(true);
  });

  test("rejects when too few samples carry a detected face at all (below the 25% sample-share gate)", () => {
    // Only 1/5 samples has a face — even though it's inside the rect, the
    // sample count itself is too sparse to trust.
    const samples: FaceSample[] = [
      faceSample(0.75),
      faceSample(null),
      faceSample(null),
      faceSample(null),
      faceSample(null),
    ];
    expect(confirmsFaceInRect(samples, pipRect)).toBe(false);
  });

  // H2's actual motivating scenario: motion segmentation's measured false
  // positive on real talking-head footage (a hand gesture near the frame
  // edge reads as a corner-adjacent, compact, dense motion blob) — the
  // detected FACE, when it's found at all, is NOT inside that "PiP" rect
  // (the face is centered, the false-positive rect is off in a corner).
  test("rejects when faces are found often enough but mostly OUTSIDE the rect (the measured hand-gesture false positive)", () => {
    const samples: FaceSample[] = [
      faceSample(0.5),
      faceSample(0.48),
      faceSample(0.52),
      faceSample(0.5),
    ];
    expect(confirmsFaceInRect(samples, pipRect)).toBe(false);
  });

  test("null samples/rect are never confirmed", () => {
    expect(confirmsFaceInRect(null, pipRect)).toBe(false);
    expect(confirmsFaceInRect([], pipRect)).toBe(false);
    expect(confirmsFaceInRect([faceSample(0.75)], null)).toBe(false);
  });

  test("custom thresholds override the defaults", () => {
    const samples: FaceSample[] = [faceSample(0.75), faceSample(null), faceSample(null)];
    // 1/3 face-bearing share (0.33) clears a lowered 0.2 gate, and its lone
    // sample is inside the rect (100% >= any inside-share threshold).
    expect(confirmsFaceInRect(samples, pipRect, { minSampleShare: 0.2 })).toBe(true);
    expect(confirmsFaceInRect(samples, pipRect, { minSampleShare: 0.5 })).toBe(false);
  });
});
