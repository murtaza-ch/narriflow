import { describe, expect, test } from "bun:test";
import {
  buildReframeSendcmdScript,
  cropXForCenter,
  smoothFacePath,
} from "./reframe";

describe("smoothFacePath", () => {
  test("returns empty when no frame ever had a face", () => {
    const out = smoothFacePath([
      { t: 0, cx: null },
      { t: 0.5, cx: null },
    ]);
    expect(out).toEqual([]);
  });

  test("carries the last known center across gaps and eases toward it", () => {
    const out = smoothFacePath(
      [
        { t: 0, cx: 0.2 },
        { t: 0.5, cx: null }, // gap — holds
        { t: 1.0, cx: 0.8 }, // big move
        { t: 1.5, cx: 0.8 },
        { t: 2.0, cx: 0.8 },
      ],
      { smoothing: 0.5, deadZone: 0.04 },
    );
    expect(out).toHaveLength(5);
    // Starts at the first face center, then eases toward 0.8 (never overshoots).
    expect(out[0]!.cx).toBeCloseTo(0.2, 5);
    expect(out[4]!.cx).toBeGreaterThan(out[0]!.cx);
    expect(out[4]!.cx).toBeLessThanOrEqual(0.8);
    // Monotonic easing toward the new target.
    expect(out[4]!.cx).toBeGreaterThan(out[2]!.cx);
  });

  test("dead-zone holds the crop still on sub-threshold jitter", () => {
    const out = smoothFacePath(
      [
        { t: 0, cx: 0.5 },
        { t: 0.1, cx: 0.51 },
        { t: 0.2, cx: 0.49 },
        { t: 0.3, cx: 0.5 },
      ],
      { smoothing: 0.5, deadZone: 0.05 },
    );
    // Jitter under the dead-zone never moves the target, so it stays at 0.5.
    for (const sample of out) expect(sample.cx).toBeCloseTo(0.5, 5);
  });
});

describe("cropXForCenter", () => {
  test("clamps the crop window inside the frame", () => {
    // 1920 wide, 608-wide crop (9:16 of 1080 height).
    expect(cropXForCenter(0, 1920, 608)).toBe(0);
    expect(cropXForCenter(1, 1920, 608)).toBe(1920 - 608);
    // Centered face -> centered crop.
    expect(cropXForCenter(0.5, 1920, 608)).toBe(Math.round(960 - 304));
  });
});

describe("buildReframeSendcmdScript", () => {
  test("emits sendcmd lines for the named crop and collapses duplicate x", () => {
    const script = buildReframeSendcmdScript(
      [
        { t: 0, cx: 0.5 },
        { t: 0.25, cx: 0.5 }, // same crop x -> collapsed
        { t: 0.5, cx: 0.1 }, // moves -> new line
      ],
      1920,
      608,
      "crop@reframe",
    );
    const lines = script.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith("0.000 crop@reframe x ")).toBe(true);
    expect(lines[1]!.startsWith("0.500 crop@reframe x ")).toBe(true);
  });

  test("returns empty string for no samples", () => {
    expect(buildReframeSendcmdScript([], 1920, 608)).toBe("");
  });
});
