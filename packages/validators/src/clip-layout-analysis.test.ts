import { describe, expect, test } from "bun:test";
import {
  clipLayoutAnalysisSchema,
  parseClipLayoutAnalysis,
  type ClipLayoutAnalysis,
} from "./clip-layout-analysis";

const validWithRect: ClipLayoutAnalysis = {
  version: 1,
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
  version: 1,
  analyzedAtISO: "2026-08-06T09:00:00.000Z",
  sourceStartSec: 0,
  sourceDurationSec: 20,
  clipStartSec: 0,
  clipEndSec: 20,
  movingPxFrac: 0.42,
  insufficientSamples: false,
  pipRect: null,
  pipUsable: false,
};

const validInsufficientSamples: ClipLayoutAnalysis = {
  version: 1,
  analyzedAtISO: "2026-08-06T09:00:00.000Z",
  sourceStartSec: 5,
  sourceDurationSec: 2,
  clipStartSec: 5,
  clipEndSec: 7,
  movingPxFrac: null,
  insufficientSamples: true,
  pipRect: null,
  pipUsable: false,
};

describe("clipLayoutAnalysisSchema", () => {
  test("round-trips a screencast-with-PiP envelope", () => {
    const parsed = clipLayoutAnalysisSchema.parse(
      JSON.parse(JSON.stringify(validWithRect)),
    );
    expect(parsed).toEqual(validWithRect);
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
    const legacy: Record<string, unknown> = { ...validWithRect };
    delete legacy.pipUsable;
    const result = clipLayoutAnalysisSchema.safeParse(legacy);
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
  test("returns the parsed envelope for a valid v1 value", () => {
    expect(parseClipLayoutAnalysis(validWithRect)).toEqual(validWithRect);
  });

  test("returns null for a null/undefined column value (never analyzed)", () => {
    expect(parseClipLayoutAnalysis(null)).toBeNull();
    expect(parseClipLayoutAnalysis(undefined)).toBeNull();
  });

  test("treats an unrecognized version as absent rather than guessing at its shape", () => {
    const futureVersion = { ...validWithRect, version: 2 };
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
