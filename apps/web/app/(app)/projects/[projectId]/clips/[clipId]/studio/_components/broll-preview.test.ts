import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BROLL_PREVIEW_DURATION_SEC,
  brollPreviewLocalTime,
  isBrollPreviewActive,
  manualBrollPreviewWindow,
} from "./broll-preview";

describe("manualBrollPreviewWindow", () => {
  test("shows the renderer's normal 3.5s placement while metadata is unknown", () => {
    const window = manualBrollPreviewWindow(53.3, null);
    expect(window).toEqual({ startSec: 14.92, endSec: 18.42 });
    expect(window!.endSec - window!.startSec).toBeCloseTo(
      DEFAULT_BROLL_PREVIEW_DURATION_SEC,
    );
  });

  test("shrinks to a short asset's real duration", () => {
    expect(manualBrollPreviewWindow(40, 2)).toEqual({
      startSec: 11.2,
      endSec: 13.2,
    });
  });

  test("does not invent a placement for clips below the renderer threshold", () => {
    expect(manualBrollPreviewWindow(8, 20)).toBeNull();
  });
});

describe("B-roll preview timing", () => {
  const window = { startSec: 10, endSec: 13.5 };

  test("uses a half-open active window", () => {
    expect(isBrollPreviewActive(9.99, window)).toBe(false);
    expect(isBrollPreviewActive(10, window)).toBe(true);
    expect(isBrollPreviewActive(13.49, window)).toBe(true);
    expect(isBrollPreviewActive(13.5, window)).toBe(false);
  });

  test("maps edited time to the selected asset from zero", () => {
    expect(brollPreviewLocalTime(12.25, window)).toBe(2.25);
    expect(brollPreviewLocalTime(9, window)).toBe(0);
  });
});
