import { describe, expect, test } from "bun:test";
import { EASES, clamp, ease, kf, prog } from "./ease";
import { colourAt, evaluatePiece, mixColour, type TextPiece } from "./scene";

describe("eases and keyframes (the sample player's, exactly)", () => {
  test("every ease runs from 0 to 1", () => {
    for (const name of Object.keys(EASES) as (keyof typeof EASES)[]) {
      expect(ease(name, 0)).toBeCloseTo(0, 9);
      expect(ease(name, 1)).toBeCloseTo(1, 9);
    }
  });

  test("known values of each curve", () => {
    expect(EASES.out(0.5)).toBeCloseTo(0.875, 9);
    expect(EASES.outQuint(0.5)).toBeCloseTo(0.96875, 9);
    expect(EASES.outExpo(0.5)).toBeCloseTo(1 - 2 ** -5, 9);
    expect(EASES.in(0.5)).toBeCloseTo(0.125, 9);
    expect(EASES.inOut(0.25)).toBeCloseTo(4 * 0.25 ** 3, 9);
    expect(EASES.inOut(0.75)).toBeCloseTo(1 - (-2 * 0.75 + 2) ** 3 / 2, 9);
    expect(EASES.outBack(0.5)).toBeCloseTo(1 + 2.70158 * -0.125 + 1.70158 * 0.25, 9);
    expect(EASES.spring(0.3)).toBeCloseTo(1 - Math.exp(-2.1) * Math.cos(3.3), 9);
    expect(EASES.spring(0.3)).not.toBeCloseTo(EASES.linear(0.3), 2);
  });

  test("kf: the first value holds before, the last after, and a frame's ease shapes the segment arriving at it", () => {
    const frames = [[100, 10], [200, 20, "out"], [300, 0, "in"]] as const;
    expect(kf(0, frames)).toBe(10);
    expect(kf(100, frames)).toBe(10);
    expect(kf(150, frames)).toBeCloseTo(10 + 10 * EASES.out(0.5), 9);
    expect(kf(250, frames)).toBeCloseTo(20 + (0 - 20) * EASES.in(0.5), 9);
    expect(kf(999, frames)).toBe(0);
  });

  test("prog and clamp", () => {
    expect(prog(150, 100, 100)).toBe(0.5);
    expect(prog(50, 100, 100)).toBe(0);
    expect(prog(500, 100, 100)).toBe(1);
    expect(prog(100, 100, 0)).toBe(1);
    expect(clamp(5)).toBe(1);
  });
});

describe("evaluatePiece", () => {
  const piece: TextPiece = {
    id: "p",
    kind: "text",
    z: 1,
    fromMs: 1000,
    toMs: 2000,
    text: "x",
    face: "Inter Tight Bold",
    sizePx: 50,
    letterSpacingEm: 0,
    fill: "#112233",
    anchor: "baseline-left",
    track: {
      x: [[1000, 0], [2000, 100, "linear"]],
      y: [[1000, 5]],
      sx: [[1000, 1], [1500, 2, "outExpo"]],
      rz: [[1000, -10], [2000, 10]],
      o: [[1000, 0], [1200, 1]],
      colour: [[1000, "#000000"], [2000, "#FFFFFF"]],
    },
    clip: { x1: [[0, 10]], y1: [[0, 20]], x2: [[1000, 100], [2000, 200]], y2: [[0, 50]] },
  };

  test("reads every track, with rest values for absent ones", () => {
    const pose = evaluatePiece(piece, 1500);
    expect(pose.visible).toBe(true);
    expect(pose.x).toBeCloseTo(50, 9);
    expect(pose.y).toBe(5);
    expect(pose.sx).toBeCloseTo(2, 9);
    expect(pose.sy).toBe(1);
    expect(pose.rz).toBeCloseTo(0, 9);
    expect(pose.rx).toBe(0);
    expect(pose.o).toBe(1);
    expect(pose.blur).toBe(0);
    expect(pose.colour).toBe("#808080");
    expect(pose.clip).toEqual({ x1: 10, y1: 20, x2: 150, y2: 50, inverse: false });
  });

  test("visible on [fromMs, toMs)", () => {
    expect(evaluatePiece(piece, 999).visible).toBe(false);
    expect(evaluatePiece(piece, 1000).visible).toBe(true);
    expect(evaluatePiece(piece, 2000).visible).toBe(false);
  });

  test("a piece with no colour track draws its own fill", () => {
    expect(evaluatePiece({ ...piece, track: { x: [[0, 0]], y: [[0, 0]] } }, 1500).colour).toBe("#112233");
  });

  test("colours mix in sRGB with the segment's ease", () => {
    expect(mixColour("#000000", "#FF8000", 0.5)).toBe("#804000");
    expect(colourAt([[0, "#000000"], [100, "#FFFFFF", "in"]], 50)).toBe(mixColour("#000000", "#FFFFFF", 0.125));
  });
});
