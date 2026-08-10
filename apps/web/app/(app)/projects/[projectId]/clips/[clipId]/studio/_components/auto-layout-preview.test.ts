import { describe, expect, test } from "bun:test";
import type { ClipAutoLayoutAnalysis } from "@narriflow/validators";
import {
  activeAutoLayoutSegment,
  autoLayoutCropRect,
  autoLayoutSegmentsForAspect,
  autoLayoutSupportsTwoUp,
  resetSpeakerLayerTransform,
  speakerLayerCropRect,
} from "./auto-layout-preview";

const analysis: ClipAutoLayoutAnalysis = {
  version: 1,
  engine: "shot-layout-v1",
  analyzedAtISO: "2026-08-10T00:00:00.000Z",
  clipStartSec: 10,
  clipEndSec: 20,
  deletedRanges: [],
  editedDurationSec: 10,
  sourceWidth: 1920,
  sourceHeight: 1080,
  segments: [
    {
      startSec: 0,
      endSec: 10,
      layout: "two-up",
      topCxNorm: 0.25,
      bottomCxNorm: 0.75,
      topCyNorm: 0.45,
      bottomCyNorm: 0.45,
      topZoom: 1,
      bottomZoom: 1,
    },
  ],
  noSplitSegments: [
    { startSec: 0, endSec: 10, layout: "single", cxNorm: 0.5, cyNorm: 0.5, zoom: 1 },
  ],
  shotCount: 1,
  soloShotCount: 0,
  multiShotCount: 1,
  twoUpSegmentCount: 1,
  speakerCount: 2,
  mappedSpeakerCount: 0,
};

describe("auto layout preview parity", () => {
  test("uses two-up only when the output can crop distinct lateral seats", () => {
    expect(autoLayoutSupportsTwoUp("9:16", { width: 1920, height: 1080 })).toBe(true);
    expect(autoLayoutSupportsTwoUp("1:1", { width: 1920, height: 1080 })).toBe(false);
    expect(autoLayoutSegmentsForAspect(analysis, "9:16", { width: 1920, height: 1080 })[0]?.layout).toBe("two-up");
    expect(autoLayoutSegmentsForAspect(analysis, "1:1", { width: 1920, height: 1080 })[0]?.layout).toBe("single");
  });

  test("selects the final segment at the exact clip end", () => {
    expect(activeAutoLayoutSegment(analysis.segments, 10)?.layout).toBe("two-up");
  });

  test("builds source-normalized crops with the exact output tile aspect", () => {
    const segment = analysis.segments[0]!;
    const top = autoLayoutCropRect(segment, "top", "9:16", {
      width: 1920,
      height: 1080,
    });
    expect(top).not.toBeNull();
    const pixelRatio = (top!.w * 1920) / (top!.h * 1080);
    expect(pixelRatio).toBeCloseTo((9 / 16) * 2, 6);
    expect(top!.x).toBe(0);
  });

  test("derives an editable layer crop from its resized output frame", () => {
    const crop = speakerLayerCropRect(
      {
        role: "top",
        frameX: 0.1,
        frameY: 0.1,
        frameWidth: 0.8,
        frameHeight: 0.3,
        rotationDeg: 0,
        cropCxNorm: 0.5,
        cropCyNorm: 0.5,
        cropZoom: 1.5,
      },
      "9:16",
      { width: 1920, height: 1080 },
    );
    expect(crop).not.toBeNull();
    const pixelRatio = (crop!.w * 1920) / (crop!.h * 1080);
    expect(pixelRatio).toBeCloseTo((9 * 0.8) / (16 * 0.3), 6);
    expect(crop!.w).toBeLessThan(1);
    expect(crop!.h).toBeLessThan(1);
  });

  test("resets only the requested speaker layer", () => {
    const defaults = [
      {
        role: "top" as const,
        frameX: 0,
        frameY: 0,
        frameWidth: 1,
        frameHeight: 0.5,
        rotationDeg: 0,
        cropCxNorm: 0.25,
        cropCyNorm: 0.5,
        cropZoom: 1,
      },
      {
        role: "bottom" as const,
        frameX: 0,
        frameY: 0.5,
        frameWidth: 1,
        frameHeight: 0.5,
        rotationDeg: 0,
        cropCxNorm: 0.75,
        cropCyNorm: 0.5,
        cropZoom: 1,
      },
    ];
    const edited = [
      { ...defaults[0]!, cropZoom: 1.4 },
      { ...defaults[1]!, cropZoom: 1.7, rotationDeg: 12 },
    ];

    const resetTop = resetSpeakerLayerTransform(edited, defaults, "top");
    expect(resetTop.changed).toBe(true);
    expect(resetTop.isFullyReset).toBe(false);
    expect(resetTop.layers[0]).toEqual(defaults[0]);
    expect(resetTop.layers[1]).toEqual(edited[1]);

    const resetBottom = resetSpeakerLayerTransform(
      resetTop.layers,
      defaults,
      "bottom",
    );
    expect(resetBottom.changed).toBe(true);
    expect(resetBottom.isFullyReset).toBe(true);
    expect(resetBottom.layers).toEqual(defaults);
  });
});
