import { describe, expect, test } from "bun:test";
import type { ClipPreviewPeaks } from "@narriflow/services";
import {
  isClipPreviewPeaksShape,
  sampleAmplitudeAtSourceTime,
} from "./waveform-peaks";

function makePeaks(overrides: Partial<ClipPreviewPeaks> = {}): ClipPreviewPeaks {
  return {
    version: 1,
    sampleRateHz: null,
    peaksPerSec: 20,
    startSec: 10,
    durationSec: 5,
    peaks: [0, 10, 25, 50, 75, 100, 50, 25, 10, 0],
    ...overrides,
  };
}

describe("isClipPreviewPeaksShape", () => {
  test("accepts a well-formed payload", () => {
    expect(isClipPreviewPeaksShape(makePeaks())).toBe(true);
  });

  test("rejects null/undefined/non-object", () => {
    expect(isClipPreviewPeaksShape(null)).toBe(false);
    expect(isClipPreviewPeaksShape(undefined)).toBe(false);
    expect(isClipPreviewPeaksShape("not an object")).toBe(false);
    expect(isClipPreviewPeaksShape(42)).toBe(false);
  });

  test("rejects a wrong version", () => {
    expect(isClipPreviewPeaksShape({ ...makePeaks(), version: 2 })).toBe(false);
  });

  test("rejects a non-null sampleRateHz", () => {
    expect(
      isClipPreviewPeaksShape({ ...makePeaks(), sampleRateHz: 8000 }),
    ).toBe(false);
  });

  test("rejects peaksPerSec <= 0", () => {
    expect(isClipPreviewPeaksShape({ ...makePeaks(), peaksPerSec: 0 })).toBe(
      false,
    );
  });

  test("rejects a non-array peaks field", () => {
    expect(
      isClipPreviewPeaksShape({ ...makePeaks(), peaks: "not-an-array" }),
    ).toBe(false);
  });

  test("rejects a peaks array with non-number entries", () => {
    expect(
      isClipPreviewPeaksShape({ ...makePeaks(), peaks: [0, "1", 2] }),
    ).toBe(false);
  });

  test("accepts an empty peaks array (structurally valid, just no samples)", () => {
    expect(isClipPreviewPeaksShape({ ...makePeaks(), peaks: [] })).toBe(true);
  });
});

describe("sampleAmplitudeAtSourceTime", () => {
  test("returns 0 for an empty peaks array", () => {
    const peaks = makePeaks({ peaks: [] });
    expect(sampleAmplitudeAtSourceTime(peaks, 12)).toBe(0);
  });

  test("maps startSec to bin 0, normalized to 0..1", () => {
    const peaks = makePeaks();
    expect(sampleAmplitudeAtSourceTime(peaks, 10)).toBeCloseTo(0, 5);
  });

  test("maps a mid-window instant to the correct bin", () => {
    const peaks = makePeaks();
    // startSec=10, peaksPerSec=20 -> bin i is at 10 + i/20. Bin 5 is at 10.25s,
    // value 100 -> normalized 1.0.
    expect(sampleAmplitudeAtSourceTime(peaks, 10.25)).toBeCloseTo(1, 5);
  });

  test("rounds to the nearest bin rather than flooring", () => {
    const peaks = makePeaks();
    // 10 + 2.6/20 = 10.13s is closer to bin 3 (0.15s) than bin 2 (0.10s)
    // under round-to-nearest at 1/20s spacing; pick an unambiguous instant
    // instead: 10.024s -> 0.024*20 = 0.48 -> rounds to bin 0.
    expect(sampleAmplitudeAtSourceTime(peaks, 10.024)).toBeCloseTo(0, 5);
    // 10.03s -> 0.03*20 = 0.6 -> rounds to bin 1 (value 10 -> 0.10).
    expect(sampleAmplitudeAtSourceTime(peaks, 10.03)).toBeCloseTo(0.1, 5);
  });

  test("clamps before the window start to the first bin", () => {
    const peaks = makePeaks();
    expect(sampleAmplitudeAtSourceTime(peaks, 0)).toBeCloseTo(0, 5);
  });

  test("clamps past the window end to the last bin", () => {
    const peaks = makePeaks();
    expect(sampleAmplitudeAtSourceTime(peaks, 999)).toBeCloseTo(0, 5);
  });

  test("clamps an out-of-range stored value defensively", () => {
    const peaks = makePeaks({ peaks: [150, -20] });
    expect(sampleAmplitudeAtSourceTime(peaks, 10)).toBe(1);
    expect(sampleAmplitudeAtSourceTime(peaks, 10.05)).toBe(0);
  });
});
