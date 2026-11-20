import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, lerp, prog } from "./ease";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece, mixColour, sceneBoundsAt } from "./scene";
import { BOOM_DEMO, BOOM_EXTRUDE_STEPS, BOOM_RIM_STEPS, boomBurstPoints, boomHalftone, boomProgram, boomRng, boomSupportBaseline } from "./templates/boom";
import { fakeMeasure, sceneInput } from "./test-support";

const { cues } = demoCues(BOOM_DEMO);
const COLOURS = { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FF3D7F", shadow: "#000000" };
const build = (list = cues, overrides = {}) => boomProgram.build(sceneInput(list, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
const scene = build();
const find = (list: readonly Piece[], id: string) => list.find((piece) => piece.id === `boom:${id}`);
const need = <T extends Piece>(piece: Piece | undefined) => {
  expect(piece).toBeDefined();
  return piece as T;
};
// Cue 1 is "so he obviously SMASHED it"; cue 0 has no hero.
const HERO_CUE = 1;

describe("Boom shapes", () => {
  test("the bursts are the sample's seeded polygons: 2 points per spike, tips out to 0.86..1 of the ellipse", () => {
    expect(boomRng(7)()).toBe(boomRng(7)());
    const points = boomBurstPoints(11, 400, 300, 16, 0.64);
    expect(points).toHaveLength(32);
    points.forEach(([x, y], at) => {
      const e = Math.sqrt((x / 400) ** 2 + (y / 300) ** 2);
      if (at % 2 === 0) expect(e).toBeGreaterThan(0.85);
      else expect(e).toBeLessThan(0.72);
    });
    // The same seed draws the same burst every time.
    expect(boomBurstPoints(11, 400, 300, 16, 0.64)).toEqual(points);
  });

  test("the halftone dots sit inside the reach and grow toward the bottom right", () => {
    const dots = boomHalftone(400, 300, 0.64);
    expect(dots.length).toBeGreaterThan(20);
    for (const dot of dots) expect((dot.x / 400) ** 2 + (dot.y / 300) ** 2).toBeLessThanOrEqual(0.64 ** 2 + 1e-9);
    const topLeft = dots.filter((dot) => dot.x < 0 && dot.y < 0).map((dot) => dot.r);
    const bottomRight = dots.filter((dot) => dot.x > 0 && dot.y > 0).map((dot) => dot.r);
    expect(Math.max(...bottomRight)).toBeGreaterThan(Math.max(...topLeft));
  });

  test("Lilita One's baseline is Chrome's rounded line-box baseline (94 of 110 px, 73 of 86 px)", () => {
    expect(boomSupportBaseline(110)).toBe(94);
    expect(boomSupportBaseline(86)).toBe(73);
  });
});

describe("Boom hero", () => {
  test("a hero cue: two bursts with dots, eight speed lines, the rim and pink stacks under a yellow face", () => {
    const ids = scene.filter((piece) => piece.id.startsWith(`boom:${HERO_CUE}:`)).map((piece) => piece.id.split(":")[2]!);
    expect(ids.filter((id) => id.startsWith("line"))).toHaveLength(8);
    for (const part of ["burst-back", "burst-front", "dots", "hero"]) expect(ids).toContain(part);
    const face = need<TextPiece>(find(scene, `${HERO_CUE}:hero`));
    const rims = BOOM_RIM_STEPS.map((step) => need<TextPiece>(find(scene, `${HERO_CUE}:rim${step}`)));
    const exts = BOOM_EXTRUDE_STEPS.map((step) => need<TextPiece>(find(scene, `${HERO_CUE}:ext${step}`)));
    expect(face).toMatchObject({ text: "SMASHED", face: "Luckiest Guy", fill: "#FFE600", stroke: { widthPx: 14, colour: "#000000" } });
    for (const rim of rims) expect(rim).toMatchObject({ fill: "#000000", fillAlpha: 0, stroke: { widthPx: 22, colour: "#000000" } });
    for (const ext of exts) expect(ext).toMatchObject({ fill: "#FF3D7F", stroke: { widthPx: 14, colour: "#FF3D7F" } });
    expect(Math.max(...rims.map((piece) => piece.z))).toBeLessThan(Math.min(...exts.map((piece) => piece.z)));
    expect(Math.max(...exts.map((piece) => piece.z))).toBeLessThan(face.z);
    // The burst's face is the extrusion's pink, lightened.
    expect(need<ShapePiece>(find(scene, `${HERO_CUE}:burst-front`)).fill!.colour).toBe(mixColour("#FF3D7F", "#FFFFFF", 0.4));
  });

  test("the hero is sized so its glyphs span 790 px, at most 230 px, the copies stepping 1.7 / 2.15 px toward the bottom right", () => {
    const face = need<TextPiece>(find(scene, `${HERO_CUE}:hero`));
    const probe = Math.round(fakeMeasure("SMASHED", "Luckiest Guy", 230, 0).advance);
    expect(face.sizePx).toBeCloseTo(Math.min(230, (230 * 790) / probe), 6);
    const deepest = need<TextPiece>(find(scene, `${HERO_CUE}:ext18`));
    expect(face.origin!.dx - deepest.origin!.dx).toBeCloseTo(1.7 * 18, 6);
    expect(face.origin!.dy - deepest.origin!.dy).toBeCloseTo(2.15 * 18, 6);
  });

  test("the hero pops with a spring: 0.3 to 1 and -18 to -6 degrees over 360 ms from 60 ms before its word", () => {
    const word = cues[HERO_CUE]!.words[3]!;
    const face = need<TextPiece>(find(scene, `${HERO_CUE}:hero`));
    const start = word.startMs - 60;
    for (const t of [start + 20, start + 90, start + 200, start + 359]) {
      const pose = evaluatePiece(face, t);
      const sp = EASES.spring(prog(t, start, 360));
      expect(pose.sx).toBeCloseTo(lerp(0.3, 1, sp), 2);
      expect(pose.rz).toBeCloseTo(lerp(-18, -6, sp), 1);
    }
    expect(face.fromMs).toBe(start);
  });

  test("the speed lines fly out for 220 ms from the hero's pop and fade in their last 45 %", () => {
    const word = cues[HERO_CUE]!.words[3]!;
    const line = need<ShapePiece>(find(scene, `${HERO_CUE}:line0`));
    expect(line.fromMs).toBe(word.startMs - 60);
    expect(line.toMs).toBe(word.startMs - 60 + 220);
    expect(evaluatePiece(line, word.startMs - 60 + 100).o).toBe(1);
    expect(evaluatePiece(line, word.startMs - 60 + 200).o).toBeLessThan(1);
    expect(line.fill!.colour).toBe("#000000");
  });

  test("the burst stamps in with a spring and turns 8 degrees a second", () => {
    const word = cues[HERO_CUE]!.words[3]!;
    const back = need<ShapePiece>(find(scene, `${HERO_CUE}:burst-back`));
    const b0 = word.startMs - 60;
    expect(evaluatePiece(back, b0 + 190).sx).toBeCloseTo(EASES.spring(0.5), 3);
    const a = evaluatePiece(back, b0 + 300).rz;
    const b = evaluatePiece(back, b0 + 800).rz;
    expect(b - a).toBeCloseTo(4, 3);
    // The big burst's back layer is turned 3 degrees further than its front.
    expect(evaluatePiece(back, b0 + 500).rz - evaluatePiece(need<ShapePiece>(find(scene, `${HERO_CUE}:burst-front`)), b0 + 500).rz).toBeCloseTo(3, 3);
  });
});

describe("Boom support words and exit", () => {
  test("support words: upper case Lilita One with a 0.233 em outline and a hard shadow, popping with alternating tilts", () => {
    const so = need<TextPiece>(find(scene, `${HERO_CUE}:w0`));
    const he = need<TextPiece>(find(scene, `${HERO_CUE}:w1`));
    expect(so).toMatchObject({ text: "SO", face: "Lilita One", sizePx: 86, fill: "#FFFFFF" });
    expect(so.stroke!.widthPx).toBeCloseTo(0.1165 * 86, 6);
    expect(so.shadows![0]).toMatchObject({ dx: 0.07 * 86, dy: 0.09 * 86, blur: 0 });
    const word = cues[HERO_CUE]!.words[0]!;
    expect(evaluatePiece(so, word.startMs - 60 + 400).rz).toBeCloseTo(-3, 3);
    expect(evaluatePiece(he, cues[HERO_CUE]!.words[1]!.startMs + 400).rz).toBeCloseTo(3, 3);
  });

  test("the lead sits ry - 6 above the hero's centre, the tail ry - 2 below, the block centred on y 1290", () => {
    const face = need<TextPiece>(find(scene, `${HERO_CUE}:hero`));
    const F = face.sizePx;
    const ry = F * 0.62 + 118;
    const leadOff = ry - 6;
    const tailOff = ry - 2;
    const hy = 1290 + (leadOff + 43 - (tailOff + 43)) / 2;
    const at = 3800;
    expect(evaluatePiece(face, at).y).toBeCloseTo(hy, 4);
    expect(evaluatePiece(need<TextPiece>(find(scene, `${HERO_CUE}:w0`)), at).y).toBeCloseTo(hy - leadOff, 4);
    expect(evaluatePiece(need<TextPiece>(find(scene, `${HERO_CUE}:w4`)), at).y).toBeCloseTo(hy + tailOff, 4);
  });

  test("a cue without a hero: bigger lettering in two rows and a small burst behind its last word, no speed lines", () => {
    const ids = scene.filter((piece) => piece.id.startsWith("boom:0:")).map((piece) => piece.id.split(":")[2]!);
    expect(ids.some((id) => id.startsWith("line") || id.startsWith("ext") || id === "hero")).toBe(false);
    expect(need<TextPiece>(find(scene, "0:w0")).sizePx).toBe(110);
    const last = need<TextPiece>(find(scene, "0:w4"));
    const burst = need<ShapePiece>(find(scene, "0:burst-front"));
    expect(evaluatePiece(burst, 2000).x).toBeCloseTo(evaluatePiece(last, 2000).x, 4);
  });

  test("the block shrinks to 0.85 about its centre and fades out over the 120 ms before end - 50 ms", () => {
    const cue = cues[HERO_CUE]!;
    const face = need<TextPiece>(find(scene, `${HERO_CUE}:hero`));
    const from = cue.endMs - 170;
    const t = from + 60;
    const e = lerp(1, 0.85, EASES.in(prog(t, from, 120)));
    expect(evaluatePiece(face, t).sx).toBeCloseTo(e, 3);
    expect(evaluatePiece(face, t).o).toBeCloseTo(1 - EASES.in(0.5), 3);
    expect(face.toMs).toBe(cue.endMs - 50);
    // A word above the centre moves toward it.
    const so = need<TextPiece>(find(scene, `${HERO_CUE}:w0`));
    expect(evaluatePiece(so, cue.endMs - 51).y).toBeGreaterThan(evaluatePiece(so, from).y);
  });

  test("rows too wide for the frame shrink so the pop's overshoot stays in the safe area", () => {
    const pieces = build(sceneEdgeDemo("nine-words").cues);
    for (let t = 0; t < 6000; t += 16) {
      const box = sceneBoundsAt(pieces, t, fakeMeasure);
      if (!box) continue;
      expect(box.x1).toBeGreaterThanOrEqual(0.05 * 1080 - 1);
      expect(box.x2).toBeLessThanOrEqual(0.95 * 1080 + 1);
    }
  });
});
