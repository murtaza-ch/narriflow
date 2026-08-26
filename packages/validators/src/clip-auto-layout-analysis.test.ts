import { describe, expect, test } from "bun:test";
import {
  clipAutoLayoutAnalysisSchema,
  parseClipSplitLayoutAnalysis,
  clipAutoLayoutMatchesInputs,
  parseClipAutoLayoutAnalysis,
  type ClipAutoLayoutAnalysis,
} from "./clip-auto-layout-analysis";

const valid: ClipAutoLayoutAnalysis = {
  version: 1,
  engine: "shot-layout-v1",
  analyzedAtISO: "2026-08-10T12:00:00.000Z",
  clipStartSec: 10,
  clipEndSec: 30,
  deletedRanges: [{ startSec: 18, endSec: 20 }],
  editedDurationSec: 18,
  sourceWidth: 1920,
  sourceHeight: 1080,
  segments: [
    { startSec: 0, endSec: 8, layout: "single", cxNorm: 0.3, cyNorm: 0.45, zoom: 1.2 },
    {
      startSec: 8,
      endSec: 18,
      layout: "two-up",
      topCxNorm: 0.3,
      bottomCxNorm: 0.72,
      topCyNorm: 0.45,
      bottomCyNorm: 0.46,
      topZoom: 1.1,
      bottomZoom: 1.1,
    },
  ],
  noSplitSegments: [
    { startSec: 0, endSec: 18, layout: "single", cxNorm: 0.5, cyNorm: 0.5, zoom: 1 },
  ],
  shotCount: 2,
  soloShotCount: 1,
  multiShotCount: 1,
  twoUpSegmentCount: 1,
  speakerCount: 2,
  mappedSpeakerCount: 2,
};

describe("clipAutoLayoutAnalysisSchema", () => {
  test("round-trips a contiguous full and no-split plan", () => {
    expect(clipAutoLayoutAnalysisSchema.parse(valid)).toEqual(valid);
  });

  test("keeps explicit Split evidence distinguishable from Automatic evidence", () => {
    const explicitSplit = { ...valid, engine: "explicit-split-v1" as const };
    expect(clipAutoLayoutAnalysisSchema.parse(explicitSplit)).toEqual(
      explicitSplit,
    );
    expect(
      clipAutoLayoutAnalysisSchema.safeParse({
        ...valid,
        engine: "future-layout-v2",
      }).success,
    ).toBe(false);
    expect(parseClipSplitLayoutAnalysis(explicitSplit)).toEqual(explicitSplit);
    expect(parseClipSplitLayoutAnalysis(valid)).toBeNull();
  });

  test("rejects gaps, overlap, and incomplete duration coverage", () => {
    const gap = structuredClone(valid);
    gap.segments[1]!.startSec = 8.5;
    expect(clipAutoLayoutAnalysisSchema.safeParse(gap).success).toBe(false);

    const short = structuredClone(valid);
    short.noSplitSegments[0]!.endSec = 17;
    expect(clipAutoLayoutAnalysisSchema.safeParse(short).success).toBe(false);
  });

  test("rejects invalid coordinates and future versions", () => {
    expect(
      clipAutoLayoutAnalysisSchema.safeParse({
        ...valid,
        segments: [{ ...valid.segments[0], cxNorm: 1.2 }],
      }).success,
    ).toBe(false);
    expect(parseClipAutoLayoutAnalysis({ ...valid, version: 2 })).toBeNull();
  });
});

describe("clipAutoLayoutMatchesInputs", () => {
  test("matches the exact analysis fingerprint within timestamp tolerance", () => {
    expect(
      clipAutoLayoutMatchesInputs(valid, {
        clipStartSec: 10.02,
        clipEndSec: 29.98,
        deletedRanges: [{ startSec: 18.01, endSec: 20.01 }],
      }),
    ).toBe(true);
  });

  test("invalidates a trim or deleted-range edit", () => {
    expect(
      clipAutoLayoutMatchesInputs(valid, {
        clipStartSec: 11,
        clipEndSec: 30,
        deletedRanges: valid.deletedRanges,
      }),
    ).toBe(false);
    expect(
      clipAutoLayoutMatchesInputs(valid, {
        clipStartSec: 10,
        clipEndSec: 30,
        deletedRanges: [{ startSec: 18, endSec: 21 }],
      }),
    ).toBe(false);
  });
});
