import { describe, expect, test } from "bun:test";
import {
  buildClipPreviewArgs,
  clipPreviewStorageKey,
  computeClipPreviewWindow,
  previewTimeToSourceTime,
  sourceTimeToPreviewTime,
} from "./clip-preview";

describe("computeClipPreviewWindow (padding + clamping)", () => {
  test("pads a mid-source clip symmetrically on both sides", () => {
    const window = computeClipPreviewWindow(100, 130, 600, 4);
    expect(window.startSec).toBe(96);
    expect(window.endSec).toBe(134);
    expect(window.durationSec).toBe(38);
  });

  test("clamps the lower bound to 0 near the start of the source", () => {
    const window = computeClipPreviewWindow(2, 20, 600, 4);
    expect(window.startSec).toBe(0);
    expect(window.endSec).toBe(24);
    expect(window.durationSec).toBe(24);
  });

  test("clamps the upper bound to sourceDurationSec near the end of the source", () => {
    const window = computeClipPreviewWindow(580, 598, 600, 4);
    expect(window.startSec).toBe(576);
    expect(window.endSec).toBe(600);
    expect(window.durationSec).toBe(24);
  });

  test("clamps both bounds when the whole source is shorter than the padded window", () => {
    const window = computeClipPreviewWindow(1, 9, 10, 4);
    expect(window.startSec).toBe(0);
    expect(window.endSec).toBe(10);
    expect(window.durationSec).toBe(10);
  });

  test("only clamps the lower bound when sourceDurationSec is unknown", () => {
    const window = computeClipPreviewWindow(1, 30, null, 4);
    expect(window.startSec).toBe(0);
    expect(window.endSec).toBe(34);
    expect(window.durationSec).toBe(34);
  });

  test("never inverts into a negative duration for a degenerate clip", () => {
    const window = computeClipPreviewWindow(5, 5, 10, 4);
    expect(window.durationSec).toBeGreaterThanOrEqual(0);
    expect(window.endSec).toBeGreaterThanOrEqual(window.startSec);
  });

  test("defaults padding from the module's own default when omitted", () => {
    const withDefault = computeClipPreviewWindow(100, 130, 600);
    const withExplicit4 = computeClipPreviewWindow(100, 130, 600, 4);
    expect(withDefault).toEqual(withExplicit4);
  });
});

describe("source-time <-> preview-time mapping", () => {
  test("sourceTimeToPreviewTime subtracts previewStartSec", () => {
    expect(sourceTimeToPreviewTime(100, 96)).toBe(4);
    expect(sourceTimeToPreviewTime(96, 96)).toBe(0);
  });

  test("previewTimeToSourceTime is the exact inverse", () => {
    expect(previewTimeToSourceTime(4, 96)).toBe(100);
    expect(previewTimeToSourceTime(0, 96)).toBe(96);
  });

  test("round-trips for arbitrary values", () => {
    const previewStartSec = 217.35;
    const sourceTimeSec = 260.1;
    const previewTimeSec = sourceTimeToPreviewTime(sourceTimeSec, previewStartSec);
    expect(previewTimeToSourceTime(previewTimeSec, previewStartSec)).toBeCloseTo(
      sourceTimeSec,
      9,
    );
  });

  test("an off-by-previewStartSec bug would desync by exactly previewStartSec", () => {
    // Guards the exact failure mode called out in the task: forgetting the
    // offset entirely (i.e. treating proxy time as source time) is off by
    // precisely previewStartSec, never by some other amount.
    const previewStartSec = 96;
    const sourceTimeSec = 100;
    const correct = sourceTimeToPreviewTime(sourceTimeSec, previewStartSec);
    const buggy = sourceTimeSec; // the bug: forgetting to subtract the offset
    expect(buggy - correct).toBe(previewStartSec);
  });
});

describe("clipPreviewStorageKey", () => {
  test("mirrors the projects/<id>/<namespace>/<clipId>/... convention", () => {
    expect(clipPreviewStorageKey("proj-1", "clip-1")).toBe(
      "projects/proj-1/previews/clip-1/preview.mp4",
    );
  });
});

describe("buildClipPreviewArgs", () => {
  const base = {
    sourcePath: "/tmp/source.mp4",
    outputPath: "/tmp/out.mp4",
    windowStartSec: 96,
    windowDurationSec: 38,
    hasAudio: true,
  };

  test("seeks with -ss before -i (fast input seek, never reorder)", () => {
    const args = buildClipPreviewArgs(base);
    const ssIndex = args.indexOf("-ss");
    const iIndex = args.indexOf("-i");
    expect(ssIndex).toBeGreaterThanOrEqual(0);
    expect(iIndex).toBeGreaterThan(ssIndex);
    expect(args[ssIndex + 1]).toBe("96");
    expect(args[iIndex + 1]).toBe(base.sourcePath);
  });

  test("scales to the configured max height preserving aspect via -2 width", () => {
    const args = buildClipPreviewArgs({ ...base, maxHeight: 540 });
    const vfIndex = args.indexOf("-vf");
    expect(args[vfIndex + 1]).toBe("scale=-2:540");
  });

  test("encodes H.264 with faststart for immediate playback", () => {
    const args = buildClipPreviewArgs(base);
    expect(args).toContain("libx264");
    expect(args).toContain("+faststart");
  });

  test("includes mono AAC audio at the configured bitrate when the source has audio", () => {
    const args = buildClipPreviewArgs({ ...base, hasAudio: true, audioBitrate: "64k" });
    expect(args).toContain("aac");
    const acIndex = args.indexOf("-ac");
    expect(args[acIndex + 1]).toBe("1");
    const bitrateIndex = args.indexOf("-b:a");
    expect(args[bitrateIndex + 1]).toBe("64k");
  });

  test("drops audio entirely with -an when the source has none", () => {
    const args = buildClipPreviewArgs({ ...base, hasAudio: false });
    expect(args).toContain("-an");
    expect(args).not.toContain("aac");
  });

  test("bounds the output duration explicitly at the end of the args", () => {
    const args = buildClipPreviewArgs(base);
    const outputPathIndex = args.indexOf(base.outputPath);
    const lastTIndex = args.lastIndexOf("-t");
    expect(args[lastTIndex + 1]).toBe("38.000");
    expect(outputPathIndex).toBe(args.length - 1);
  });

  test("honors explicit preset/CRF overrides over the env-driven defaults", () => {
    const args = buildClipPreviewArgs({
      ...base,
      x264Preset: "ultrafast",
      x264Crf: "32",
    });
    const presetIndex = args.indexOf("-preset");
    const crfIndex = args.indexOf("-crf");
    expect(args[presetIndex + 1]).toBe("ultrafast");
    expect(args[crfIndex + 1]).toBe("32");
  });
});
