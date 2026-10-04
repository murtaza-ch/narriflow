import { describe, expect, test } from "bun:test";
import {
  activeAutoLayoutSegment,
  resetSpeakerLayerTransform,
} from "./auto-layout-preview";

describe("automatic speaker scene editing", () => {
  test("selects the final segment at the exact clip end", () => {
    expect(activeAutoLayoutSegment([
      { startSec: 0, endSec: 10, layout: "single", cxNorm: 0.5, cyNorm: 0.5, zoom: 1 },
    ], 10)?.layout).toBe("single");
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
