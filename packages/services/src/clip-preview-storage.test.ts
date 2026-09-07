import { describe, expect, test } from "bun:test";
import {
  derivePeaksStorageKey,
  isClipPreviewPeaks,
} from "./clip-preview-storage";

describe("derivePeaksStorageKey", () => {
  test("swaps the trailing .mp4 for .peaks.json", () => {
    expect(
      derivePeaksStorageKey(
        "projects/proj_1/previews/clip_1/attempt-uuid.mp4",
      ),
    ).toBe("projects/proj_1/previews/clip_1/attempt-uuid.peaks.json");
  });

  test("only touches the trailing extension, not earlier path segments", () => {
    // A pathological key with ".mp4" embedded mid-path must not have that
    // occurrence swapped — only the actual trailing extension.
    expect(
      derivePeaksStorageKey("projects/proj.mp4-ish/previews/c1/a1.mp4"),
    ).toBe("projects/proj.mp4-ish/previews/c1/a1.peaks.json");
  });

  test("throws when the key does not end in .mp4", () => {
    expect(() =>
      derivePeaksStorageKey("projects/proj_1/previews/clip_1/attempt.json"),
    ).toThrow(/does not end in \.mp4|doesn't end in \.mp4/);
  });

  test("throws on an empty string", () => {
    expect(() => derivePeaksStorageKey("")).toThrow();
  });
});

describe("isClipPreviewPeaks", () => {
  const valid = {
    version: 1,
    sampleRateHz: null,
    peaksPerSec: 20,
    startSec: 10,
    durationSec: 5,
    peaks: [0, 50, 100],
  } as const;

  test("accepts the worker's bounded v1 payload", () => {
    expect(isClipPreviewPeaks(valid)).toBe(true);
  });

  test("rejects non-finite timing and out-of-contract peak values", () => {
    expect(isClipPreviewPeaks({ ...valid, startSec: Number.NaN })).toBe(false);
    expect(isClipPreviewPeaks({ ...valid, peaks: [101] })).toBe(false);
    expect(isClipPreviewPeaks({ ...valid, peaks: [0.5] })).toBe(false);
  });
});
