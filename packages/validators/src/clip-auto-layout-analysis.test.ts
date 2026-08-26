import { describe, expect, test } from "bun:test";
import {
  clipAutoLayoutAnalysisSchema,
  clipSplitLayoutAnalysisSchema,
  clipSplitLayoutFailureSchema,
  parseClipSplitLayoutAnalysis,
  parseClipSplitLayoutFailure,
  clipAutoLayoutMatchesInputs,
  parseClipAutoLayoutAnalysis,
  type ClipAutoLayoutAnalysis,
} from "./clip-auto-layout-analysis";

const valid: ClipAutoLayoutAnalysis = {
  version: 1,
  engine: "shot-layout-v1",
  sourceIdentity: "source:project-1",
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

  test("enforces isolated Automatic and Split evidence schemas", () => {
    const explicitSplit = { ...valid, engine: "explicit-split-v1" as const };
    expect(clipAutoLayoutAnalysisSchema.safeParse(explicitSplit).success).toBe(false);
    expect(clipSplitLayoutAnalysisSchema.parse(explicitSplit)).toEqual(
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

  test("parses identity-bound Split failures without treating them as analysis", () => {
    const failure = clipSplitLayoutFailureSchema.parse({
      version: 1,
      engine: "explicit-split-v1",
      state: "failed",
      sourceIdentity: "source:project-1",
      inputFingerprint: "0123456789abcdef",
      analyzedAtISO: "2026-08-27T00:00:00.000Z",
      reason: "detection_unavailable",
    });
    expect(parseClipSplitLayoutFailure(failure)).toEqual(failure);
    expect(parseClipSplitLayoutAnalysis(failure)).toBeNull();
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
    const identityless: Record<string, unknown> = { ...valid };
    delete identityless.sourceIdentity;
    expect(parseClipAutoLayoutAnalysis(identityless)).toBeNull();
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
