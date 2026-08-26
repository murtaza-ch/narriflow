import { describe, expect, test } from "bun:test";
import {
  clipLayoutAnalysisSchema,
  clipLayoutAnalysisFailureSchema,
  parseClipLayoutAnalysis,
  parseClipLayoutAnalysisFailure,
  type ClipLayoutAnalysis,
  type ClipLayoutAnalysisV2,
} from "./clip-layout-analysis";

const validWithRect: ClipLayoutAnalysisV2 = {
  version: 2,
  engine: "screen-layout-v1",
  sourceIdentity: "source:0123456789abcdef",
  inputFingerprint: "0123456789abcdef",
  sourceWidth: 1920,
  sourceHeight: 1080,
  deletedRanges: [],
  faceBandSegments: [
    {
      startSec: 0,
      endSec: 30,
      layout: "single",
      cxNorm: 0.72,
      cyNorm: 0.5,
      zoom: 1,
    },
  ],
  analyzedAtISO: "2026-08-06T09:00:00.000Z",
  sourceStartSec: 12.5,
  sourceDurationSec: 30,
  clipStartSec: 12.5,
  clipEndSec: 42.5,
  movingPxFrac: 0.04,
  insufficientSamples: false,
  pipRect: { x: 0.62, y: 0.55, w: 0.3, h: 0.35 },
  pipUsable: true,
};

// pipUsable false alongside a non-null pipRect: the clip-level decidePipUsage
// gate rejected this analysis pass's rect (e.g. face_not_in_rect) — the raw
// rect is still kept (see the schema's own doc comment on why), just not
// usable.
const validRectNotUsable: ClipLayoutAnalysis = {
  ...validWithRect,
  pipUsable: false,
};

const validNoRect: ClipLayoutAnalysis = {
  ...validWithRect,
  sourceStartSec: 0,
  sourceDurationSec: 20,
  clipStartSec: 0,
  clipEndSec: 20,
  movingPxFrac: 0.42,
  insufficientSamples: false,
  pipRect: null,
  pipUsable: false,
  faceBandSegments: null,
};

const validInsufficientSamples: ClipLayoutAnalysis = {
  ...validWithRect,
  sourceStartSec: 5,
  sourceDurationSec: 2,
  clipStartSec: 5,
  clipEndSec: 7,
  movingPxFrac: null,
  insufficientSamples: true,
  pipRect: null,
  pipUsable: false,
  faceBandSegments: null,
};

const validV2 = validWithRect;

describe("clipLayoutAnalysisSchema", () => {
  test("round-trips identity-complete screencast-with-PiP evidence", () => {
    const parsed = clipLayoutAnalysisSchema.parse(
      JSON.parse(JSON.stringify(validWithRect)),
    );
    expect(parsed).toEqual(validWithRect);
  });

  test("round-trips identity-complete v2 Screen composition evidence", () => {
    expect(clipLayoutAnalysisSchema.parse(validV2)).toEqual(validV2);
  });

  test("parses identity-bound Screen failures without treating them as analysis", () => {
    const failure = clipLayoutAnalysisFailureSchema.parse({
      version: 2,
      engine: "screen-layout-v1",
      state: "failed",
      sourceIdentity: "source:0123456789abcdef",
      inputFingerprint: "0123456789abcdef",
      analyzedAtISO: "2026-08-27T00:00:00.000Z",
      reason: "analysis_unavailable",
    });
    expect(parseClipLayoutAnalysisFailure(failure)).toEqual(failure);
    expect(parseClipLayoutAnalysis(failure)).toBeNull();
  });

  test("rejects malformed v2 identity, dimensions, and face-band evidence", () => {
    expect(
      clipLayoutAnalysisSchema.safeParse({
        ...validV2,
        inputFingerprint: "not-a-fingerprint",
      }).success,
    ).toBe(false);
    expect(
      clipLayoutAnalysisSchema.safeParse({ ...validV2, sourceWidth: 0 }).success,
    ).toBe(false);
    expect(
      clipLayoutAnalysisSchema.safeParse({
        ...validV2,
        faceBandSegments: [],
      }).success,
    ).toBe(false);
  });

  test("round-trips an analyzed-but-no-qualifying-rect envelope (pipRect null, movingPxFrac non-null)", () => {
    const parsed = clipLayoutAnalysisSchema.parse(
      JSON.parse(JSON.stringify(validNoRect)),
    );
    expect(parsed).toEqual(validNoRect);
    expect(parsed.pipRect).toBeNull();
    expect(parsed.movingPxFrac).not.toBeNull();
  });

  test("round-trips an insufficient-samples envelope (movingPxFrac null)", () => {
    const parsed = clipLayoutAnalysisSchema.parse(
      JSON.parse(JSON.stringify(validInsufficientSamples)),
    );
    expect(parsed).toEqual(validInsufficientSamples);
  });

  test("rejects a malformed pipRect", () => {
    const result = clipLayoutAnalysisSchema.safeParse({
      ...validWithRect,
      pipRect: { x: 0.1, y: 0.1, w: "wide", h: 0.2 },
    });
    expect(result.success).toBe(false);
  });

  // C1 (adversarial review): pipUsable false alongside a non-null pipRect —
  // the "measured a rect, but this render's decidePipUsage gate rejected it"
  // state a preview must be able to tell apart from a confirmed-usable one.
  test("round-trips a non-null pipRect with pipUsable false (gate-rejected analysis)", () => {
    const parsed = clipLayoutAnalysisSchema.parse(
      JSON.parse(JSON.stringify(validRectNotUsable)),
    );
    expect(parsed).toEqual(validRectNotUsable);
    expect(parsed.pipRect).not.toBeNull();
    expect(parsed.pipUsable).toBe(false);
  });

  // C1: pipUsable is REQUIRED — an envelope written before this field
  // existed must fail parse outright (self-heals to "never analyzed" via
  // parseClipLayoutAnalysis, not silently treated as usable or unusable).
  test("rejects an envelope missing pipUsable (pre-C1 write)", () => {
    const incomplete: Record<string, unknown> = { ...validWithRect };
    delete incomplete.pipUsable;
    const result = clipLayoutAnalysisSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  // L5 (adversarial review): out-of-range/non-finite numeric fields are
  // rejected, not silently accepted — a stored envelope is trusted data at
  // read time, so bogus values here would otherwise flow straight into
  // render/preview crop math.
  describe("L5: bounded numeric fields", () => {
    test("pipRect x/y must stay within [0, 1]", () => {
      expect(
        clipLayoutAnalysisSchema.safeParse({
          ...validWithRect,
          pipRect: { ...validWithRect.pipRect, x: -0.01 },
        }).success,
      ).toBe(false);
      expect(
        clipLayoutAnalysisSchema.safeParse({
          ...validWithRect,
          pipRect: { ...validWithRect.pipRect, y: 1.01 },
        }).success,
      ).toBe(false);
    });

    test("pipRect w/h must be > 0 and <= 1", () => {
      expect(
        clipLayoutAnalysisSchema.safeParse({
          ...validWithRect,
          pipRect: { ...validWithRect.pipRect, w: 0 },
        }).success,
      ).toBe(false);
      expect(
        clipLayoutAnalysisSchema.safeParse({
          ...validWithRect,
          pipRect: { ...validWithRect.pipRect, h: 1.5 },
        }).success,
      ).toBe(false);
    });

    test("movingPxFrac must stay within [0, 1] when non-null", () => {
      expect(
        clipLayoutAnalysisSchema.safeParse({
          ...validWithRect,
          movingPxFrac: 1.2,
        }).success,
      ).toBe(false);
      expect(
        clipLayoutAnalysisSchema.safeParse({
          ...validWithRect,
          movingPxFrac: -0.1,
        }).success,
      ).toBe(false);
      // null still allowed (insufficientSamples case).
      expect(
        clipLayoutAnalysisSchema.safeParse({
          ...validInsufficientSamples,
        }).success,
      ).toBe(true);
    });

    test("non-finite values (Infinity/NaN) are rejected", () => {
      expect(
        clipLayoutAnalysisSchema.safeParse({
          ...validWithRect,
          sourceDurationSec: Number.POSITIVE_INFINITY,
        }).success,
      ).toBe(false);
      expect(
        clipLayoutAnalysisSchema.safeParse({
          ...validWithRect,
          movingPxFrac: Number.NaN,
        }).success,
      ).toBe(false);
    });

    test("sourceDurationSec must be > 0; sourceStartSec must be >= 0", () => {
      expect(
        clipLayoutAnalysisSchema.safeParse({
          ...validWithRect,
          sourceDurationSec: 0,
        }).success,
      ).toBe(false);
      expect(
        clipLayoutAnalysisSchema.safeParse({
          ...validWithRect,
          sourceStartSec: -1,
        }).success,
      ).toBe(false);
    });
  });
});

describe("parseClipLayoutAnalysis", () => {
  test("returns the parsed envelope for valid identity-complete evidence", () => {
    expect(parseClipLayoutAnalysis(validWithRect)).toEqual(validWithRect);
  });

  test("returns null for a null/undefined column value (never analyzed)", () => {
    expect(parseClipLayoutAnalysis(null)).toBeNull();
    expect(parseClipLayoutAnalysis(undefined)).toBeNull();
  });

  test("reads the current version and treats other versions as absent", () => {
    expect(parseClipLayoutAnalysis(validV2)).toEqual(validV2);
    const futureVersion = { ...validWithRect, version: 3 };
    expect(parseClipLayoutAnalysis(futureVersion)).toBeNull();

    const noVersion: Record<string, unknown> = { ...validWithRect };
    delete noVersion.version;
    expect(parseClipLayoutAnalysis(noVersion)).toBeNull();
  });

  test("returns null for structurally invalid JSON blobs", () => {
    expect(parseClipLayoutAnalysis({ foo: "bar" })).toBeNull();
    expect(parseClipLayoutAnalysis("not an object")).toBeNull();
    expect(parseClipLayoutAnalysis(42)).toBeNull();
  });
});
