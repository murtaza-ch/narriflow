import { describe, expect, test } from "bun:test";
import { isStandardFrameRate, sourceProbeSchema, standardFrameRate } from "./source-probe";

describe("standardFrameRate", () => {
  test.each([
    [24000 / 1001, 24000, 1001],
    [23.98, 24000, 1001],
    [24, 24, 1],
    [25, 25, 1],
    [30000 / 1001, 30000, 1001],
    [29.97, 30000, 1001],
    [30, 30, 1],
    [47.952, 48000, 1001],
    [48, 48, 1],
    [50, 50, 1],
    [60000 / 1001, 60000, 1001],
    [59.94, 60000, 1001],
    [60, 60, 1],
  ])("%d fps is %i/%i", (fps, numerator, denominator) => {
    expect(standardFrameRate(fps)).toEqual({ numerator, denominator });
  });

  test("rates that match no standard are not rounded to one", () => {
    for (const fps of [12.5, 14.9, 15, 29.4, 29.98, 90000, 120, 0.2]) expect(standardFrameRate(fps)).toBeNull();
  });

  test("an unreadable rate matches nothing", () => {
    expect(standardFrameRate(Number.NaN)).toBeNull();
    expect(standardFrameRate(0)).toBeNull();
    expect(standardFrameRate(-30)).toBeNull();
  });
});

describe("isStandardFrameRate", () => {
  test("accepts the exact fractions, reduced or not", () => {
    expect(isStandardFrameRate({ numerator: 30000, denominator: 1001 })).toBe(true);
    expect(isStandardFrameRate({ numerator: 60000, denominator: 2002 })).toBe(true);
    expect(isStandardFrameRate({ numerator: 25, denominator: 1 })).toBe(true);
  });

  test("refuses anything else, including a close decimal", () => {
    expect(isStandardFrameRate({ numerator: 2997, denominator: 100 })).toBe(false);
    expect(isStandardFrameRate({ numerator: 25, denominator: 2 })).toBe(false);
    expect(isStandardFrameRate({ numerator: 90000, denominator: 1 })).toBe(false);
  });
});

describe("sourceProbeSchema", () => {
  const probe = {
    durationSec: 12.5,
    video: { width: 1920, height: 1080, frameRate: { numerator: 30000, denominator: 1001 }, startTimecode: "01:00:00;00" },
    audio: { sampleRate: 48000, channels: 2 },
  };

  test("accepts video with audio and audio-only sources", () => {
    expect(sourceProbeSchema.parse(probe)).toEqual(probe);
    expect(sourceProbeSchema.parse({ ...probe, video: null }).video).toBeNull();
    expect(sourceProbeSchema.parse({ ...probe, video: { ...probe.video, startTimecode: null } }).video?.startTimecode).toBeNull();
  });

  test("keeps a measured rate that is not standard", () => {
    const odd = { ...probe, video: { ...probe.video, frameRate: { numerator: 25, denominator: 2 } } };
    expect(sourceProbeSchema.parse(odd).video?.frameRate).toEqual({ numerator: 25, denominator: 2 });
  });

  test("refuses facts that cannot describe a file", () => {
    expect(sourceProbeSchema.safeParse({ ...probe, durationSec: 0 }).success).toBe(false);
    expect(sourceProbeSchema.safeParse({ ...probe, video: { ...probe.video, frameRate: { numerator: 30, denominator: 0 } } }).success).toBe(false);
    expect(sourceProbeSchema.safeParse({ ...probe, video: { ...probe.video, startTimecode: "1:00" } }).success).toBe(false);
    expect(sourceProbeSchema.safeParse(null).success).toBe(false);
  });
});
