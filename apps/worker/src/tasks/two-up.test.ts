import { describe, expect, test } from "bun:test";
import type { TranscriptUtterance } from "@narriflow/validators";
import {
  assignSpeakersToClusters,
  buildTwoUpFilterChain,
  classifyShotSamples,
  clusterFaceTracks,
  TWO_UP_BOTTOM_CROP_NAME,
  TWO_UP_TOP_CROP_NAME,
  type MultiFaceSample,
  type ShotKind,
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

describe("buildTwoUpFilterChain", () => {
  const probe = { width: 640, height: 360 };

  test("splits, crops each region to a W x H/2 tile, scales, and vstacks to [outv]", () => {
    const parts = buildTwoUpFilterChain({
      aspectRatio: "9:16",
      probe,
      top: { cx: 0.4 },
      bottom: { cx: 0.7 },
    });
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("[0:v]split=2[twoup_top_src][twoup_bot_src]");
    // Tile is 1080x960 -> tileRatio 1.125; src is 640x360 (ratio 1.778 >= 1.125)
    // so crop is full height, width = round(360 * 1.125) = 405.
    // Region cx=0.4 -> centerPx=256, x = round(256 - 405/2) = round(53.5) = 54.
    expect(parts[1]).toBe("[twoup_top_src]crop=405:360:54:0,scale=1080:960[twoup_top]");
    expect(parts[2]).toBe("[twoup_bot_src]crop=405:360:235:0,scale=1080:960[twoup_bot]");
    expect(parts[3]).toBe("[twoup_top][twoup_bot]vstack=inputs=2,format=yuv420p[outv]");
  });

  test("appends a trailing chain (captions) before the output label", () => {
    const parts = buildTwoUpFilterChain({
      aspectRatio: "9:16",
      probe,
      top: { cx: 0.4 },
      bottom: { cx: 0.7 },
      trailingChain: "subtitles='/tmp/x.srt'",
    });
    expect(parts[3]).toBe(
      "[twoup_top][twoup_bot]vstack=inputs=2,format=yuv420p,subtitles='/tmp/x.srt'[outv]",
    );
  });

  test("respects a custom videoInputLabel/outputLabel (outvbase contract)", () => {
    const parts = buildTwoUpFilterChain({
      aspectRatio: "9:16",
      probe,
      top: { cx: 0.4 },
      bottom: { cx: 0.7 },
      videoInputLabel: "[cat:v]",
      outputLabel: "[outvbase]",
    });
    expect(parts[0]).toBe("[cat:v]split=2[twoup_top_src][twoup_bot_src]");
    expect(parts[3]).toContain("[outvbase]");
  });

  test("labelSuffix keeps two calls' internal labels from colliding", () => {
    const a = buildTwoUpFilterChain({
      aspectRatio: "9:16",
      probe,
      top: { cx: 0.4 },
      bottom: { cx: 0.7 },
      labelSuffix: "_seg0",
    });
    const b = buildTwoUpFilterChain({
      aspectRatio: "9:16",
      probe,
      top: { cx: 0.4 },
      bottom: { cx: 0.7 },
      labelSuffix: "_seg1",
    });
    expect(a[0]).toContain("twoup_top_src_seg0");
    expect(b[0]).toContain("twoup_top_src_seg1");
    expect(a[0]).not.toContain("_seg1");
  });

  test("drives crop x via distinct-named sendcmd scripts per region (no label collision)", () => {
    const parts = buildTwoUpFilterChain({
      aspectRatio: "9:16",
      probe,
      top: { cx: 0.4, reframe: { scriptPath: "/tmp/top.txt", cropName: TWO_UP_TOP_CROP_NAME } },
      bottom: { cx: 0.7, reframe: { scriptPath: "/tmp/bot.txt", cropName: TWO_UP_BOTTOM_CROP_NAME } },
    });
    expect(parts[1]).toContain("sendcmd=f='/tmp/top.txt'");
    expect(parts[1]).toContain(`${TWO_UP_TOP_CROP_NAME}=w=`);
    expect(parts[2]).toContain("sendcmd=f='/tmp/bot.txt'");
    expect(parts[2]).toContain(`${TWO_UP_BOTTOM_CROP_NAME}=w=`);
    // The two crop instance names must differ, or a sendcmd targeting one
    // would also drive the other (see the function's doc comment).
    expect(TWO_UP_TOP_CROP_NAME).not.toBe(TWO_UP_BOTTOM_CROP_NAME);
  });

  test("throws on an unsupported aspect ratio", () => {
    expect(() =>
      buildTwoUpFilterChain({
        // @ts-expect-error deliberately invalid for this test
        aspectRatio: "3:2",
        probe,
        top: { cx: 0.4 },
        bottom: { cx: 0.7 },
      }),
    ).toThrow();
  });
});
