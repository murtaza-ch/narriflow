import { describe, expect, test } from "bun:test";
import type { TranscriptUtterance } from "@narriflow/validators";
import { buildClipCutPlan } from "./cut-plan";
import {
  assignSpeakersToClusters,
  buildSplitLayoutPlan,
  classifyShotSamples,
  clusterFaceTracks,
  deriveSingleFaceSamplesFromMulti,
  remapMultiFaceSamplesForCutPlan,
  splitTilesAreDistinct,
  type MultiFaceSample,
  type ShotKind,
  type SplitLayoutSegment,
} from "./two-up";

function face(cx: number, cy = 0.3, w = 0.1, h = 0.2, score = 0.9) {
  return { cx, cy, w, h, score };
}

function utterance(
  speakerLabel: string,
  startSec: number,
  endSec: number,
  index = 0,
): TranscriptUtterance {
  return {
    index,
    speaker: null,
    speakerLabel,
    startSec,
    endSec,
    text: "hello",
    confidence: 0.9,
    words: [],
  };
}

describe("clusterFaceTracks", () => {
  test("splits two stable side-by-side faces into left/right clusters", () => {
    const samples: MultiFaceSample[] = [];
    for (let i = 0; i < 10; i++) {
      samples.push({ t: i * 0.25, faces: [face(0.42), face(0.68)] });
    }
    const result = clusterFaceTracks(samples);
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters[0]!.meanCx).toBeCloseTo(0.42, 2);
    expect(result.clusters[1]!.meanCx).toBeCloseTo(0.68, 2);
    expect(result.clusters[0]!.sampleCount).toBe(10);
    expect(result.clusters[1]!.sampleCount).toBe(10);
  });

  test("assigns a single-face sample to its nearest cluster within threshold", () => {
    const samples: MultiFaceSample[] = [
      { t: 0, faces: [face(0.4), face(0.7)] },
      { t: 0.25, faces: [face(0.4), face(0.7)] },
      { t: 0.5, faces: [face(0.41)] }, // solo close-up of the left seat
    ];
    const result = clusterFaceTracks(samples);
    const soloSample = result.samples[2]!;
    expect(soloSample.assignments).toHaveLength(1);
    expect(soloSample.assignments[0]!.clusterIndex).toBe(0);
  });

  test("leaves a face unassigned when it's beyond maxAssignDistance of both clusters", () => {
    const samples: MultiFaceSample[] = [
      { t: 0, faces: [face(0.4), face(0.7)] },
      { t: 0.25, faces: [face(0.4), face(0.7)] },
      { t: 0.5, faces: [face(0.9)] }, // far from both seats
    ];
    const result = clusterFaceTracks(samples, { maxAssignDistance: 0.15 });
    expect(result.samples[2]!.assignments).toHaveLength(0);
  });

  test("handles a 3-face false-positive sample via greedy nearest-distance matching", () => {
    const samples: MultiFaceSample[] = [
      { t: 0, faces: [face(0.4), face(0.7)] },
      { t: 0.25, faces: [face(0.4), face(0.7)] },
      { t: 0.5, faces: [face(0.4), face(0.5), face(0.7)] }, // extra face near the midpoint
    ];
    const result = clusterFaceTracks(samples);
    const threeFaceSample = result.samples[2]!;
    // At most one face per cluster this sample; the two real seats win
    // (closest distance), the extra midpoint face is left unassigned.
    expect(threeFaceSample.assignments).toHaveLength(2);
    const clusterIndexes = threeFaceSample.assignments.map((a) => a.clusterIndex).sort();
    expect(clusterIndexes).toEqual([0, 1]);
  });

  test("returns no clusters when there is no multi-face evidence at all", () => {
    const result = clusterFaceTracks([
      { t: 0, faces: [] },
      { t: 0.25, faces: [] },
    ]);
    expect(result.clusters).toHaveLength(0);
    expect(result.samples.every((s) => s.assignments.length === 0)).toBe(true);
  });

  test("falls back to a single degenerate cluster when every face shares one position", () => {
    const result = clusterFaceTracks([
      { t: 0, faces: [face(0.5)] },
      { t: 0.25, faces: [face(0.5)] },
    ]);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.meanCx).toBeCloseTo(0.5, 5);
  });
});

describe("classifyShotSamples", () => {
  function samplesWithFaces(pattern: Array<"two" | "left" | "right" | "none">): MultiFaceSample[] {
    return pattern.map((kind, i) => {
      const t = i * 0.25;
      if (kind === "two") return { t, faces: [face(0.4), face(0.7)] };
      if (kind === "left") return { t, faces: [face(0.4)] };
      if (kind === "right") return { t, faces: [face(0.7)] };
      return { t, faces: [] };
    });
  }

  test("classifies two-shot / single / none per sample", () => {
    const clustering = clusterFaceTracks(
      samplesWithFaces(["two", "two", "two", "left", "left", "left", "none", "none"]),
    );
    const result = classifyShotSamples(clustering, { smoothingWindowSamples: 1 });
    const kinds = result.perSample.map((s) => s.kind);
    expect(kinds).toEqual(["two-shot", "two-shot", "two-shot", "single:0", "single:0", "single:0", "none", "none"]);
  });

  test("smooths a single-sample flap without disturbing a stable run", () => {
    const pattern: Array<"two" | "left" | "right" | "none"> = [
      "two", "two", "two", "two", "left", "two", "two", "two", "two",
    ];
    const clustering = clusterFaceTracks(samplesWithFaces(pattern));
    const result = classifyShotSamples(clustering, { smoothingWindowSamples: 5, minSegmentDurationSec: 0 });
    // The lone "left" flap at index 4 is outvoted by its two-shot neighbors.
    expect(result.perSample[4]!.rawKind).toBe("single:0");
    expect(result.perSample[4]!.kind).toBe("two-shot");
  });

  test("collapses smoothed samples into contiguous segments", () => {
    const pattern: Array<"two" | "left" | "right" | "none"> = [
      "two", "two", "two", "two", "left", "left", "left", "left",
    ];
    const clustering = clusterFaceTracks(samplesWithFaces(pattern));
    const result = classifyShotSamples(clustering, { smoothingWindowSamples: 1, minSegmentDurationSec: 0 });
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]!.kind).toBe("two-shot");
    expect(result.segments[0]!.startSec).toBe(0);
    expect(result.segments[0]!.endSec).toBe(1.0);
    expect(result.segments[1]!.kind).toBe("single:0");
    expect(result.segments[1]!.startSec).toBe(1.0);
  });

  test("merges a micro-segment into its longer neighbor", () => {
    // 8 samples at 0.25s spacing: two-shot(0-0.75), one lone "left" blip at
    // t=1.0 (would be its own 0.25s segment), two-shot again (1.25-1.75).
    // Use a wide-enough smoothing window of 1 (no smoothing) so the blip
    // survives raw classification, then verify duration-based merging
    // absorbs it into the (longer) surrounding two-shot run.
    const pattern: Array<"two" | "left" | "right" | "none"> = [
      "two", "two", "two", "left", "two", "two", "two",
    ];
    const clustering = clusterFaceTracks(samplesWithFaces(pattern));
    const result = classifyShotSamples(clustering, {
      smoothingWindowSamples: 1,
      minSegmentDurationSec: 1.0,
    });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]!.kind).toBe("two-shot");
  });

  test("re-coalesces when a merge leaves two adjacent same-kind segments (jensen-0-90.mp4 t=42-44s case)", () => {
    // two-shot(0.75s) | single:0(0.5s, a real but sub-threshold dip) | two-shot(0.75s)
    // The middle segment merges into whichever neighbor is longer (a tie here,
    // so it merges forward into the second two-shot run) — that merged run is
    // then directly adjacent to the FIRST two-shot run and must collapse into
    // it too, leaving one single two-shot segment, not two adjacent ones.
    const pattern: Array<"two" | "left" | "right" | "none"> = [
      "two", "two", "two", "left", "two", "two", "two",
    ];
    const clustering = clusterFaceTracks(samplesWithFaces(pattern));
    const result = classifyShotSamples(clustering, {
      smoothingWindowSamples: 1,
      minSegmentDurationSec: 0.6,
    });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]!.kind).toBe("two-shot");
    expect(result.segments[0]!.startSec).toBe(0);
  });
});

describe("assignSpeakersToClusters", () => {
  test("assigns each speaker to the cluster visible during their single-shot turns", () => {
    // Speaker 1 talks 0-1s while cluster 0 is solo on screen; Speaker 2 talks
    // 1-2s while cluster 1 is solo on screen.
    const perSample = [
      { t: 0.1, rawKind: "single:0" as ShotKind, kind: "single:0" as ShotKind },
      { t: 0.4, rawKind: "single:0" as ShotKind, kind: "single:0" as ShotKind },
      { t: 0.7, rawKind: "single:0" as ShotKind, kind: "single:0" as ShotKind },
      { t: 1.2, rawKind: "single:1" as ShotKind, kind: "single:1" as ShotKind },
      { t: 1.5, rawKind: "single:1" as ShotKind, kind: "single:1" as ShotKind },
      { t: 1.8, rawKind: "single:1" as ShotKind, kind: "single:1" as ShotKind },
    ];
    const utterances = [utterance("Speaker 1", 0, 1, 0), utterance("Speaker 2", 1, 2, 1)];
    const assignments = assignSpeakersToClusters(utterances, { perSample, segments: [] });

    const bySpeaker = Object.fromEntries(assignments.map((a) => [a.speakerLabel, a]));
    expect(bySpeaker["Speaker 1"]!.clusterIndex).toBe(0);
    expect(bySpeaker["Speaker 1"]!.confidence).toBe(1);
    expect(bySpeaker["Speaker 2"]!.clusterIndex).toBe(1);
    expect(bySpeaker["Speaker 2"]!.confidence).toBe(1);
  });

  test("reports null/zero confidence when there is no single-shot evidence for a speaker", () => {
    const perSample = [{ t: 0.1, rawKind: "two-shot" as ShotKind, kind: "two-shot" as ShotKind }];
    const utterances = [utterance("Speaker 1", 0, 1, 0)];
    const assignments = assignSpeakersToClusters(utterances, { perSample, segments: [] });
    expect(assignments[0]!.clusterIndex).toBeNull();
    expect(assignments[0]!.confidence).toBe(0);
    expect(assignments[0]!.evidenceSampleCount).toBe(0);
  });

  test("picks the majority cluster and reports a fractional confidence on mixed evidence", () => {
    const perSample = [
      { t: 0.1, rawKind: "single:0" as ShotKind, kind: "single:0" as ShotKind },
      { t: 0.3, rawKind: "single:0" as ShotKind, kind: "single:0" as ShotKind },
      { t: 0.5, rawKind: "single:0" as ShotKind, kind: "single:0" as ShotKind },
      { t: 0.7, rawKind: "single:1" as ShotKind, kind: "single:1" as ShotKind },
    ];
    const utterances = [utterance("Speaker 1", 0, 1, 0)];
    const assignments = assignSpeakersToClusters(utterances, { perSample, segments: [] });
    expect(assignments[0]!.clusterIndex).toBe(0);
    expect(assignments[0]!.confidence).toBe(0.75);
    expect(assignments[0]!.evidenceSampleCount).toBe(4);
  });

  test("aggregates evidence across a speaker's multiple turns", () => {
    const perSample = [
      { t: 0.1, rawKind: "single:0" as ShotKind, kind: "single:0" as ShotKind },
      { t: 2.1, rawKind: "single:0" as ShotKind, kind: "single:0" as ShotKind },
    ];
    const utterances = [
      utterance("Speaker 1", 0, 1, 0),
      utterance("Speaker 2", 1, 2, 1),
      utterance("Speaker 1", 2, 3, 2),
    ];
    const assignments = assignSpeakersToClusters(utterances, { perSample, segments: [] });
    const speaker1 = assignments.find((a) => a.speakerLabel === "Speaker 1")!;
    expect(speaker1.evidenceSampleCount).toBe(2);
    expect(speaker1.clusterIndex).toBe(0);
  });
});

describe("remapMultiFaceSamplesForCutPlan (split packet B — multi-face sibling of reframe.ts's remapFaceSamplesForCutPlan)", () => {
  // 30s clip window [0,30), one mid-clip deletion [10,15) -> kept segments
  // [0,10) and [15,30), 25s edited duration.
  const window = { startSec: 0, endSec: 30 };
  const cutPlan = buildClipCutPlan([{ startSec: 10, endSec: 15 }], window);
  const clipStartSec = 0;

  test("is a passthrough (same array) when the clip is uncut", () => {
    const uncutPlan = buildClipCutPlan([], window);
    const samples: MultiFaceSample[] = [{ t: 0, faces: [face(0.5)] }, { t: 12, faces: [] }];
    expect(remapMultiFaceSamplesForCutPlan(samples, uncutPlan, clipStartSec)).toEqual(samples);
  });

  test("drops a sample inside the cut and remaps a kept sample onto the edited timeline", () => {
    // t=4 (before the cut) stays at edited 4; t=20 (after the cut, source 20)
    // -> edited 10 + (20-15) = 15; t=12 falls inside the deleted [10,15) and
    // is dropped entirely.
    const out = remapMultiFaceSamplesForCutPlan(
      [
        { t: 4, faces: [face(0.3)] },
        { t: 12, faces: [face(0.9)] },
        { t: 20, faces: [face(0.6)] },
      ],
      cutPlan,
      clipStartSec,
    );
    expect(out).toEqual([
      { t: 4, faces: [face(0.3)] },
      { t: 15, faces: [face(0.6)] },
    ]);
  });

  test("returns samples sorted by edited-timeline t even if the raw list wasn't", () => {
    const out = remapMultiFaceSamplesForCutPlan(
      [
        { t: 20, faces: [face(0.6)] }, // -> edited 15
        { t: 4, faces: [face(0.3)] }, // -> edited 4
      ],
      cutPlan,
      clipStartSec,
    );
    expect(out.map((s) => s.t)).toEqual([4, 15]);
  });
});

describe("buildSplitLayoutPlan (split packet B — plan computation)", () => {
  test("returns an empty plan when there's fewer than 2 clusters (no usable 2-up evidence)", () => {
    const samples: MultiFaceSample[] = [
      { t: 0, faces: [face(0.5)] },
      { t: 0.25, faces: [face(0.5)] },
    ];
    const plan = buildSplitLayoutPlan(samples, 0.5);
    expect(plan.segments).toEqual([]);
    expect(plan.clusterCount).toBeLessThan(2);
    expect(plan.cappedFromSegmentCount).toBeNull();
  });

  test("uses PER-SEGMENT means for two-up crop centers, not the clip-global cluster mean", () => {
    const samples: MultiFaceSample[] = [];
    let idx = 0;
    const pushTwoShot = (leftCx: number, rightCx: number, count: number) => {
      for (let i = 0; i < count; i++) {
        samples.push({ t: idx * 0.25, faces: [face(leftCx), face(rightCx)] });
        idx++;
      }
    };
    const pushSingle = (cx: number, count: number) => {
      for (let i = 0; i < count; i++) {
        samples.push({ t: idx * 0.25, faces: [face(cx)] });
        idx++;
      }
    };
    pushTwoShot(0.2, 0.8, 8); // first two-shot run: seats at 0.2 / 0.8
    pushSingle(0.2, 4); // a single-shot blip separates the two runs
    pushTwoShot(0.35, 0.9, 8); // second two-shot run: seats shifted to 0.35 / 0.9

    const clipDurationSec = idx * 0.25;
    const plan = buildSplitLayoutPlan(samples, clipDurationSec, {
      classifyOptions: { smoothingWindowSamples: 1, minSegmentDurationSec: 0.6 },
    });

    expect(plan.clusterCount).toBe(2);
    const twoUp = plan.segments.filter(
      (s): s is Extract<SplitLayoutSegment, { layout: "two-up" }> => s.layout === "two-up",
    );
    expect(twoUp).toHaveLength(2);
    expect(twoUp[0]!.topCxNorm).toBeCloseTo(0.2, 2);
    expect(twoUp[0]!.bottomCxNorm).toBeCloseTo(0.8, 2);
    expect(twoUp[1]!.topCxNorm).toBeCloseTo(0.35, 2);
    expect(twoUp[1]!.bottomCxNorm).toBeCloseTo(0.9, 2);
    // The two two-up segments must disagree — proves this isn't reusing one
    // clip-wide mean for every segment (the spike's finding 1).
    expect(twoUp[0]!.topCxNorm).not.toBeCloseTo(twoUp[1]!.topCxNorm, 2);
  });

  test("a 'none' segment (no usable face evidence — b-roll/title) renders as a plain center crop", () => {
    const samples: MultiFaceSample[] = [];
    let idx = 0;
    for (let i = 0; i < 8; i++) {
      samples.push({ t: idx * 0.25, faces: [face(0.3), face(0.7)] });
      idx++;
    }
    for (let i = 0; i < 6; i++) {
      samples.push({ t: idx * 0.25, faces: [] });
      idx++;
    }
    const clipDurationSec = idx * 0.25;
    const plan = buildSplitLayoutPlan(samples, clipDurationSec, {
      classifyOptions: { smoothingWindowSamples: 1, minSegmentDurationSec: 0.6 },
    });
    const last = plan.segments[plan.segments.length - 1]!;
    expect(last.layout).toBe("single");
    expect((last as Extract<SplitLayoutSegment, { layout: "single" }>).cxNorm).toBe(0.5);
  });

  test("snaps the first/last segment boundaries exactly to the clip window", () => {
    const samples: MultiFaceSample[] = [
      { t: 0.1, faces: [face(0.3), face(0.7)] },
      { t: 0.35, faces: [face(0.3), face(0.7)] },
      { t: 0.6, faces: [face(0.3), face(0.7)] },
    ];
    const plan = buildSplitLayoutPlan(samples, 1.0);
    expect(plan.segments[0]!.startSec).toBe(0);
    expect(plan.segments[plan.segments.length - 1]!.endSec).toBe(1.0);
  });

  test("caps an excessive segment count by merging the shortest segments first, and reports the pre-cap count", () => {
    const samples: MultiFaceSample[] = [];
    let idx = 0;
    const push = (faces: ReturnType<typeof face>[], count: number) => {
      for (let i = 0; i < count; i++) {
        samples.push({ t: idx * 0.25, faces });
        idx++;
      }
    };
    push([face(0.2), face(0.8)], 2); // two-shot
    push([face(0.2)], 2); // single:0
    push([face(0.2), face(0.8)], 2); // two-shot
    push([face(0.8)], 2); // single:1
    push([face(0.2), face(0.8)], 2); // two-shot
    push([face(0.2)], 2); // single:0
    const clipDurationSec = idx * 0.25;

    const uncapped = buildSplitLayoutPlan(samples, clipDurationSec, {
      classifyOptions: { smoothingWindowSamples: 1, minSegmentDurationSec: 0 },
    });
    expect(uncapped.segments).toHaveLength(6);
    expect(uncapped.cappedFromSegmentCount).toBeNull();

    const capped = buildSplitLayoutPlan(samples, clipDurationSec, {
      maxSegments: 3,
      classifyOptions: { smoothingWindowSamples: 1, minSegmentDurationSec: 0 },
    });
    expect(capped.segments.length).toBeLessThanOrEqual(3);
    expect(capped.cappedFromSegmentCount).toBe(6);
    // The capped plan still spans the whole clip with no gaps.
    expect(capped.segments[0]!.startSec).toBe(0);
    expect(capped.segments[capped.segments.length - 1]!.endSec).toBe(clipDurationSec);
  });
});

describe("splitTilesAreDistinct (H1 — per-output tile-distinctness gate)", () => {
  test("a 1920x1080 landscape source falls back for 1:1 (tile crop consumes full source width)", () => {
    // Tile ratio for 1:1 is 1080 / (1080/2) = 2.0; src ratio 1920/1080 =
    // 1.778 < 2.0, so cropW = srcWidth = 1920 -> x forced to 0 for both
    // tiles regardless of cx -> identical crops.
    expect(splitTilesAreDistinct("1:1", { width: 1920, height: 1080 })).toBe(false);
  });

  test("the same 1920x1080 source does NOT fall back for 9:16 (plenty of lateral room)", () => {
    // Tile ratio for 9:16 is 1080 / 960 = 1.125; src ratio 1.778 >= 1.125,
    // so cropW = round(1080 * 1.125) = 1215 < 1920 -> distinct x positions
    // are possible.
    expect(splitTilesAreDistinct("9:16", { width: 1920, height: 1080 })).toBe(true);
  });

  test("a portrait source falls back even for 9:16 (no lateral room left at all)", () => {
    expect(splitTilesAreDistinct("9:16", { width: 1080, height: 1920 })).toBe(false);
  });

  test("false for an unsupported aspect ratio rather than throwing", () => {
    // @ts-expect-error deliberately invalid for this test
    expect(splitTilesAreDistinct("3:2", { width: 1920, height: 1080 })).toBe(false);
  });
});

describe("deriveSingleFaceSamplesFromMulti (M2 — reuse multi-face detection instead of re-detecting)", () => {
  test("picks the largest (by area) face per sample", () => {
    const samples: MultiFaceSample[] = [
      { t: 0, faces: [face(0.3, 0.3, 0.1, 0.1), face(0.7, 0.3, 0.3, 0.3)] },
    ];
    const out = deriveSingleFaceSamplesFromMulti(samples);
    expect(out).toEqual([{ t: 0, cx: 0.7 }]);
  });

  test("maps a zero-face sample to cx: null (smoothFacePath's own gap-fill contract)", () => {
    const samples: MultiFaceSample[] = [{ t: 0, faces: [] }];
    expect(deriveSingleFaceSamplesFromMulti(samples)).toEqual([{ t: 0, cx: null }]);
  });

  test("preserves sample order/count", () => {
    const samples: MultiFaceSample[] = [
      { t: 0, faces: [face(0.2)] },
      { t: 0.25, faces: [] },
      { t: 0.5, faces: [face(0.4), face(0.6, 0.3, 0.3, 0.3)] },
    ];
    const out = deriveSingleFaceSamplesFromMulti(samples);
    expect(out.map((s) => s.t)).toEqual([0, 0.25, 0.5]);
    // The 0.6 face is strictly bigger (0.3x0.3 vs the default 0.1x0.2) -> wins.
    expect(out[2]!.cx).toBe(0.6);
  });
});
