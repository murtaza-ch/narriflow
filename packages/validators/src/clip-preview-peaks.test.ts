import { describe, expect, test } from "bun:test";
import { type ClipPreviewPeaks, isClipPreviewPeaks } from "./clip-preview-peaks";

const valid: ClipPreviewPeaks = {
  version: 1,
  sampleRateHz: null,
  peaksPerSec: 20,
  startSec: 12.5,
  durationSec: 4,
  peaks: [0, 50, 100],
};

describe("isClipPreviewPeaks", () => {
  test("accepts the worker's artifact shape", () => {
    expect(isClipPreviewPeaks(valid)).toBe(true);
  });

  test.each([
    ["not an object", "peaks"],
    ["an array", []],
    ["null", null],
    ["another version", { ...valid, version: 2 }],
    ["a PCM sample rate", { ...valid, sampleRateHz: 8000 }],
    ["a zero bin rate", { ...valid, peaksPerSec: 0 }],
    ["a non-finite start", { ...valid, startSec: Number.POSITIVE_INFINITY }],
    ["a zero duration", { ...valid, durationSec: 0 }],
    ["an out-of-range peak", { ...valid, peaks: [101] }],
    ["a fractional peak", { ...valid, peaks: [1.5] }],
    ["too many bins", { ...valid, peaks: new Array(20_001).fill(0) }],
  ])("refuses %s", (_name, value) => {
    expect(isClipPreviewPeaks(value)).toBe(false);
  });
});
