import { describe, expect, test } from "bun:test";
import { type DemoScript, demoCues, sceneEdgeDemo } from "./demo";
import { detectPunchlines } from "./detect";
import { EASES, clamp, lerp, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Measure, type Piece, type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt, sceneRange } from "./scene";
import { pathBounds } from "./shapes";
import {
  PUNCHLINE_DEMO,
  burstScale,
  burstTurn,
  dotGone,
  dotPop,
  dotPulse,
  kickAt,
  lineBaseline,
  punchHash,
  punchStarPoints,
  punchlineProgram,
  ringProgress,
  slamWordScale,
  stickerOpacity,
  stickerScale,
  stickerTilt,
} from "./templates/punchline";
import { sceneInput } from "./test-support";

/** Lilita One is about half an em per character: close enough to place rows (the sample's rows are 416 and 455 wide at 120 px). */
const lilita: Measure = (text, _face, sizePx) => ({ advance: [...text].length * 0.5 * sizePx, inkTop: -0.75 * sizePx, inkBottom: 0.2 * sizePx, ascent: 0.923 * sizePx, descent: 0.22 * sizePx });
const input = (cues: readonly SceneCue[], overrides = {}) =>
  sceneInput(cues, { measure: lilita, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: { primary: "#FFFFFF", highlight: "#FF4FA3", accent: "#FFD400", shadow: "#000000" }, ...overrides });
const build = (cues: readonly SceneCue[], overrides = {}) => punchlineProgram.build(input(cues, overrides)).pieces;
const script = (lines: readonly string[], options: DemoScript["options"] = {}) => demoCues({ lines, options }).cues;

const { cues } = demoCues(PUNCHLINE_DEMO);
const pieces = build(cues);
const cueNumber = (piece: Piece) => Number(piece.id.split(":")[1]);
const piecesOf = (cue: number) => pieces.filter((piece) => cueNumber(piece) === cue);
const word = (cue: number, index: number) => pieces.find((piece) => piece.id === `punchline:${cue}:w${index}`) as TextPiece;
const shape = (cue: number, name: string) => pieces.find((piece) => piece.id === `punchline:${cue}:${name}`) as ShapePiece;
const at = (piece: Piece, t: number) => evaluatePiece(piece, t);
const near = (value: number, expected: number, tolerance: number) => expect(Math.abs(value - expected)).toBeLessThanOrEqual(tolerance);

describe("Punchline: the sample's own numbers", () => {
  test("a Lilita One box's baseline is where Chrome puts it (probe of 52-punchline.js)", () => {
    expect(lineBaseline(80)).toBe(70);
    expect(lineBaseline(112)).toBe(98);
    expect(lineBaseline(120)).toBe(106);
  });

  test("the tilt and the starburst come from the sample's hash", () => {
    // Verbatim from the sample.
    const hash = (n: number) => {
      const x = Math.sin(n * 91.7 + 17.3) * 43758.5453;
      return x - Math.floor(x);
    };
    for (const n of [0, 1, 7, 13, 26, 99.5]) expect(punchHash(n)).toBe(hash(n));
    const sample = (rx: number, ry: number, seed: number) => {
      const pts: [number, number][] = [];
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2 - Math.PI / 2 + (hash(seed + i) - 0.5) * 0.07;
        const outer = i % 2 === 0;
        const k = outer ? 0.92 + hash(seed + i * 3) * 0.16 : 0.76 + hash(seed + i * 5) * 0.05;
        pts.push([Number((Math.cos(a) * rx * k).toFixed(1)), Number((Math.sin(a) * ry * k).toFixed(1))]);
      }
      return pts;
    };
    for (const seed of [3, 10, 17]) expect(punchStarPoints(385, 249, seed)).toEqual(sample(385, 249, seed));
    expect(punchStarPoints(385, 249, 17)).toHaveLength(24);
    expect(stickerTilt(1, 4)).toBeCloseTo((hash(1 * 13 + 4) - 0.5) * 6, 10);
    for (let cue = 0; cue < 5; cue++) for (let index = 0; index < 6; index++) expect(Math.abs(stickerTilt(cue, index))).toBeLessThanOrEqual(3);
  });
});

describe("Punchline: ordinary lines are stickers", () => {
  test("Lilita One, white, a 0.09 em outline and a hard 0.075 em shadow; the hero is 1.4 times the size in the highlight colour", () => {
    const so = word(0, 0);
    expect(so).toMatchObject({ face: "Lilita One", sizePx: 80, fill: "#FFFFFF", letterSpacingEm: 0, anchor: "baseline-left" });
    expect(so.stroke).toEqual({ widthPx: 0.09 * 80, colour: "#1B0B2E" });
    expect(so.shadows).toEqual([{ dx: 0, dy: 0.075 * 80, blur: 0, colour: "#1B0B2E", alpha: 1 }]);
    expect(word(1, 4)).toMatchObject({ text: "week", sizePx: 112, fill: "#FF4FA3" });
    expect(word(1, 3)).toMatchObject({ text: "whole", sizePx: 80, fill: "#FFFFFF" });
  });

  test("the block is centred on the anchor line: baselines match the probe (cue 0: 1274.2 and 1361, cue 1: 1257.24 and 1372.04, cue 3: 1317.6)", () => {
    const baseline = (piece: TextPiece) => at(piece, piece.fromMs).y - piece.origin!.dy;
    near(baseline(word(0, 0)), 1274.2, 0.3);
    near(baseline(word(0, 3)), 1361, 0.3);
    near(baseline(word(1, 0)), 1257.24, 0.3);
    near(baseline(word(1, 3)), 1372.04, 0.3);
    near(baseline(word(1, 4)), 1372.04, 0.3);
    near(baseline(word(3, 0)), 1317.6, 0.3);
    // Words of a row share a baseline, rows are centred on x = 540.
    const row = [0, 1, 2].map((index) => word(0, index));
    const left = (piece: TextPiece) => at(piece, piece.fromMs).x - piece.origin!.dx;
    const right = (piece: TextPiece) => left(piece) + lilita(piece.text, piece.face, piece.sizePx, 0).advance;
    near((left(row[0]!) + right(row[2]!)) / 2, 540, 0.01);
  });

  test("each word pops on its start, as the sample's formula, and the cue shrinks out in its last 120 ms", () => {
    const cue = cues[0]!;
    const end = cue.endMs;
    for (const index of [0, 2, 5]) {
      const piece = word(0, index);
      const start = cue.words[index]!.startMs;
      for (const t of [start - 40, start - 20, start, start + 30, start + 60, start + 90, start + 130, start + 200, end - 150, end - 100, end - 60, end - 20]) {
        near(at(piece, t).sx, stickerScale(t, start, end), 0.005);
        near(at(piece, t).sy, stickerScale(t, start, end), 0.005);
        near(at(piece, t).o, stickerOpacity(t, start, end), 0.01);
        near(at(piece, t).rz, stickerTilt(0, index), 1e-9);
      }
    }
    // The formula's landmarks: 0.6 at the start, 1.08 at 100 ms, settled at 170 ms, 0.75 at the end.
    expect(stickerScale(cue.words[0]!.startMs - 40, cue.words[0]!.startMs, end)).toBeCloseTo(0.6, 10);
    expect(stickerScale(cue.words[0]!.startMs + 60, cue.words[0]!.startMs, end)).toBeCloseTo(1.08, 10);
    expect(stickerScale(cue.words[0]!.startMs + 130, cue.words[0]!.startMs, end)).toBeCloseTo(1, 10);
    expect(stickerScale(end, cue.words[0]!.startMs, end)).toBeCloseTo(0.75, 10);
    // Not visible before its own start (the cue's later words wait for their time).
    expect(at(word(0, 5), cue.words[5]!.startMs - 60).visible).toBe(false);
  });

  test("a line followed by a punchline leaves 170 ms after its last word, to give the drumroll the stage", () => {
    const early = cues[1]!.words[4]!.endMs + 170;
    expect(early).toBeLessThan(cues[1]!.endMs);
    for (const piece of piecesOf(1).filter((p) => p.id.includes(":w"))) expect(piece.toMs).toBe(early);
    for (const piece of piecesOf(0)) expect(piece.toMs).toBe(cues[0]!.endMs);
  });

  test("a stamp whose exit starts before its entrance has ended is the product of both windows", () => {
    // A one-word cue of 80 ms: the exit (120 ms) starts while the word is still settling.
    const short = script(["go:b@80"], { tail: 100 });
    const piece = build(short)[0] as TextPiece;
    const start = short[0]!.words[0]!.startMs;
    const end = short[0]!.endMs;
    for (let t = start - 40; t < end; t += 10) {
      near(at(piece, t).sx, stickerScale(t, start, end), 0.006);
      near(at(piece, t).o, stickerOpacity(t, start, end), 0.012);
    }
  });
});

describe("Punchline: the detector hears comic timing", () => {
  test("the demo: only the line after the 900 ms pause is a punchline", () => {
    expect(detectPunchlines(cues).map((entry) => entry.punch)).toEqual([false, false, true, false]);
    expect(detectPunchlines(cues)[2]!.gapBeforeMs).toBe(900);
    expect(shape(2, "star")).toBeDefined();
    expect(shape(2, "ring")).toBeDefined();
    for (const cue of [0, 1, 3]) expect(piecesOf(cue).filter((piece) => piece.kind === "shape")).toHaveLength(0);
  });

  test("no pause, no drumroll: a clip without a real gap never draws a burst, a ring or a dot", () => {
    const flat = script(["so:m I:m tried:b it", "and:m it:m worked.:b", "really:b well.:b"], { cueGap: 140 });
    const scene = build(flat);
    expect(scene.every((piece) => piece.kind === "text")).toBe(true);
    expect(detectPunchlines(flat).some((entry) => entry.punch)).toBe(false);
    // A gap just under 550 ms is still not one; at 550 it is.
    const gap = (ms: number) => detectPunchlines(script(["so:m I:m tried:b it", `done.:b+${ms - 140}`]))[1]!;
    expect(gap(549).punch).toBe(false);
    expect(gap(549).gapBeforeMs).toBe(549);
    expect(gap(550).punch).toBe(true);
  });

  test("a pause before a long line, or before a line that neither ends a sentence nor is followed by a pause, is not a punchline", () => {
    const long = script(["so:m I:m tried:b it", "and:b+900 then:m it:m worked:b well."]);
    expect(detectPunchlines(long)[1]!.punch).toBe(false);
    const open = script(["so:m I:m tried:b it", "and:b+900 worked:b", "well:b"]);
    expect(detectPunchlines(open)[1]!.punch).toBe(false);
    const followed = script(["so:m I:m tried:b it", "and:b+900 worked:b", "well:b+600"]);
    expect(detectPunchlines(followed)[1]!.punch).toBe(true);
  });

  test("several pauses: every punchline has its own drumroll in its own gap", () => {
    const many = script(["it:m started:b fine", "then:m+900 it:m broke.:b", "I:m fixed:b it", "and:m+1700 it:m broke.:b", "again:b+700 and:m again.:b"]);
    const punch = detectPunchlines(many);
    const punchCues = punch.flatMap((entry, index) => (entry.punch ? [index] : []));
    expect(punchCues).toEqual([1, 3, 4]);
    const scene = build(many);
    for (const index of punchCues) {
      const cue = many[index]!;
      const gapStart = cue.startMs - punch[index]!.gapBeforeMs;
      const dots = scene.filter((piece) => piece.id.startsWith(`punchline:${index}:dot`) && !piece.id.endsWith(":face"));
      expect(dots).toHaveLength(3);
      dots.forEach((dot, k) => {
        // Dot k appears at gapStart + 150 + 180 k and is gone as the punchline lands (cs - 40).
        expect(dot.fromMs).toBe(gapStart + 150 + k * 180);
        expect(dot.toMs).toBe(cue.startMs - 40);
      });
      expect(scene.filter((piece) => piece.id === `punchline:${index}:star`)).toHaveLength(1);
    }
    // Each line before a punchline leaves early.
    for (const index of punchCues) {
      const before = punch[index - 1]!;
      expect(before.showUntilMs).toBe(many[index - 1]!.words.at(-1)!.endMs + 170);
    }
    // No dots outside the gaps of punchlines.
    const owners = new Set(scene.filter((piece) => piece.id.includes(":dot")).map(cueNumber));
    expect([...owners].sort()).toEqual(punchCues);
  });
});

describe("Punchline: the drumroll", () => {
  const cs = cues[2]!.startMs;
  const gapStart = cs - 900;
  const dot = (k: number, face = false) => shape(2, `dot${k}${face ? ":face" : ""}`);

  test("three dots pop one by one (scale 0 → 1.2 → 1), hold, and shrink away before the line lands", () => {
    for (let k = 0; k < 3; k++) {
      const start = gapStart + 150 + k * 180;
      for (const t of [start + 10, start + 45, start + 90, start + 120, start + 150, cs - 130, cs - 110, cs - 90, cs - 70, cs - 50]) {
        const expected = Math.max(0.02, dotPop(t, start) * (1 - dotGone(t, cs)));
        near(at(dot(k), t).sx, expected, 0.01);
        near(at(dot(k), t).o, 1, 1e-9);
      }
      expect(dotPop(start + 90, start)).toBeCloseTo(1.2, 10);
      expect(dotPop(start + 150, start)).toBeCloseTo(1, 10);
    }
  });

  test("the dots sit 1.6 diameters apart at the block centre; the outline is 8 px and the shadow 7 px down", () => {
    const xs = [0, 1, 2].map((k) => at(dot(k), cs - 300).x);
    near(xs[1]! - xs[0]!, 56 * 1.6, 1e-9);
    near(xs[2]! - xs[1]!, 56 * 1.6, 1e-9);
    // The cue is shifted as one into the safe area, by a pixel or two at most.
    near(xs[1]!, 540, 3);
    near(at(dot(1), cs - 300).y, 1290, 3);
    const bounds = pathBounds(dot(1).path);
    // The ring is 56 across; the hard shadow reaches 7 px below it.
    // (A path's bounds here are its control points', a little wider than the curve.)
    near(bounds.x2 - bounds.x1, 56, 2.5);
    near(bounds.y1, -28, 1.5);
    near(bounds.y2, 28 + 7, 2.5);
    // The face is the inside of the 8 px border.
    const face = pathBounds(dot(1, true).path);
    near(face.x2 - face.x1, 2 * 20 + 1, 1.5);
    expect(dot(1, true).fill?.colour).toBe("#FFFFFF");
    expect(dot(1).fill?.colour).toBe("#1B0B2E");
  });

  test("a gap over 1500 ms holds the dots and pulses them 100 → 60 → 100 % every 600 ms", () => {
    const longClip = script(["it:m started:b fine", "then:m+1800 nothing.:b"]);
    const piece = build(longClip).find((candidate) => candidate.id === "punchline:1:dot0") as ShapePiece;
    const start = longClip[1]!.startMs - 1800 - 140 + 150;
    expect(detectPunchlines(longClip)[1]!.gapBeforeMs).toBe(1800 + 140);
    for (const t of [start + 400, start + 600, start + 750, start + 900, start + 1050, start + 1200, start + 1500]) {
      near(at(piece, t).o, dotPulse(t, start), 0.011);
    }
    near(at(piece, start + 900).o, 0.6, 0.011);
    // The 900 ms gap of the demo does not pulse.
    for (let t = gapStart + 700; t < cs - 120; t += 50) expect(at(dot(0), t).o).toBe(1);
  });
});

describe("Punchline: the slam", () => {
  const cue = cues[2]!;
  const cs = cue.startMs;
  const end = cue.endMs;
  const star = () => shape(2, "star");
  const ring = () => shape(2, "ring");

  test("the starburst: a 24-point polygon from the sample's seed, 7 px ink outline, yellow, with a hard shadow", () => {
    expect(star().path.filter((command) => command[0] === "L")).toHaveLength(23);
    expect(star().fill?.colour).toBe("#FFD400");
    expect(star().stroke).toEqual({ widthPx: 7, colour: "#1B0B2E" });
    // 14 px down, plus half the outline the writer's fill-only shadow lacks.
    expect(star().shadows).toEqual([{ dx: 0, dy: 17.5, blur: 0, colour: "#1B0B2E", alpha: 1 }]);
    expect(ring().stroke).toEqual({ widthPx: 9, colour: "#FFD400" });
    expect(ring().fill).toBeUndefined();
    // Sized by the sample's rule: 0.74 of the block's width + 48, at most 480; 0.62 of that high, or the block's height.
    const bounds = pathBounds(star().path);
    expect(bounds.x2 - bounds.x1).toBeLessThanOrEqual(2 * 480 * 1.08 + 1);
    expect(bounds.y2 - bounds.y1).toBeLessThanOrEqual(2 * 320 * 1.08 + 1);
  });

  test("scale 0 → 1.18 → 1, turn -25° → 0 → +6°, ring 1 → 1.45 fading out, group kick: the sample's formulas", () => {
    const base = (t: number) => Math.max(0.02, burstScale(t, cs) * (1 - EASES.in(prog(t, end - 120, 120))));
    const exit = (t: number) => 1 - EASES.in(prog(t, end - 120, 120));
    for (const t of [cs - 55, cs - 30, cs, cs + 40, cs + 90, cs + 120, cs + 150, cs + 179, cs + 230, cs + 600, end - 150, end - 80, end - 20]) {
      near(at(star(), t).sx, base(t), 0.006);
      near(at(star(), t).rz, burstTurn(t, cs, end) + kickAt(t, cs), 0.06);
    }
    for (const t of [cs + 25, cs + 60, cs + 120, cs + 200, cs + 270]) {
      near(at(ring(), t).sx, Math.max(0.02, lerp(1, 1.45, ringProgress(t, cs)) * exit(t)), 0.006);
      near(at(ring(), t).o, 1 - ringProgress(t, cs), 0.011);
      near(at(ring(), t).rz, burstTurn(t, cs, end) + kickAt(t, cs), 0.06);
    }
    expect(burstScale(cs + 90, cs)).toBeCloseTo(1.18, 10);
    expect(burstScale(cs + 180, cs)).toBeCloseTo(1, 10);
    expect(burstTurn(cs - 60, cs, end)).toBeCloseTo(-25, 10);
    expect(burstTurn(cs + 180, cs, end)).toBeCloseTo(0, 10);
    expect(burstTurn(end, cs, end)).toBeCloseTo(6, 10);
    expect(kickAt(cs + 150, cs)).toBeCloseTo(-2, 10);
    expect(kickAt(cs + 190, cs)).toBeCloseTo(1.5, 10);
    expect(kickAt(cs + 230, cs)).toBeCloseTo(0, 10);
    // The ring is not there before cs + 20, and is gone by cs + 280.
    expect(at(ring(), cs + 10).visible).toBe(false);
    expect(at(ring(), cs + 280).visible).toBe(false);
  });

  test("the words stamp on (1.6 → 0.95 → 1, fading in over 30 ms) and the whole group kicks about the burst's centre", () => {
    for (const index of [0, 1, 2]) {
      const piece = word(2, index);
      const start = cue.words[index]!.startMs;
      for (const t of [start - 40, start - 30, start, start + 50, start + 90, start + 120, start + 160, cs + 140, cs + 170, cs + 200, cs + 220, end - 100, end - 40]) {
        if (t < start - 40) continue;
        const group = 1 - EASES.in(prog(t, end - 120, 120));
        near(at(piece, t).sx, Math.max(0.02, slamWordScale(t, start) * group), 0.006);
        near(at(piece, t).o, clamp((t - (start - 40)) / 30), 0.011);
        near(at(piece, t).rz, kickAt(t, cs), 0.06);
      }
      // At rest (t = cs + 400) the word is where the stack puts it: centred on the block.
      const rest = at(piece, cs + 700);
      expect(rest.rz).toBe(0);
      near(rest.sx, 1, 0.001);
    }
    // The kick moves a word about the centre: at the kick's lowest the word's centre is the rest centre turned by -2°.
    const piece = word(2, 0);
    const rest = at(piece, cs + 700);
    const kicked = at(piece, cs + 150);
    const pivot = at(star(), cs + 700);
    const dx = rest.x - pivot.x;
    const dy = rest.y - pivot.y;
    const angle = (-2 * Math.PI) / 180;
    near(kicked.x, pivot.x + dx * Math.cos(angle) - dy * Math.sin(angle), 0.3);
    near(kicked.y, pivot.y + dx * Math.sin(angle) + dy * Math.cos(angle), 0.3);
  });

  test("the punchline's words are 1.5 times the body, in ink, with no outline or shadow, in rows of 0 gap", () => {
    for (const index of [0, 1, 2]) {
      const piece = word(2, index);
      expect(piece).toMatchObject({ sizePx: 120, fill: "#1B0B2E", face: "Lilita One" });
      expect(piece.stroke).toBeUndefined();
      expect(piece.shadows).toBeUndefined();
    }
    const baseline = (piece: TextPiece) => at(piece, cs + 700).y - piece.origin!.dy;
    near(baseline(word(2, 0)), 1268.81, 0.3);
    near(baseline(word(2, 2)), 1396, 0.3);
  });

  test("the burst and its ring follow the cue's colours: the accent paints the star and the ring", () => {
    const custom = build(cues, { colours: { primary: "#EEEEEE", highlight: "#00FF00", accent: "#112233", shadow: "#000000" } });
    const star = custom.find((piece) => piece.id === "punchline:2:star") as ShapePiece;
    const ringPiece = custom.find((piece) => piece.id === "punchline:2:ring") as ShapePiece;
    expect(star.fill?.colour).toBe("#112233");
    expect(ringPiece.stroke?.colour).toBe("#112233");
    expect((custom.find((piece) => piece.id === "punchline:1:w4") as TextPiece).fill).toBe("#00FF00");
    expect((custom.find((piece) => piece.id === "punchline:2:dot0:face") as ShapePiece).fill?.colour).toBe("#EEEEEE");
  });
});

describe("Punchline: edge cases", () => {
  const SAFE = 0.05;
  const inside = (scene: readonly Piece[], canvas: { width: number; height: number }) => {
    const { fromMs, toMs } = sceneRange({ pieces: scene });
    for (let t = fromMs; t < toMs; t += 10) {
      const box = sceneBoundsAt(scene, t, lilita);
      if (!box) continue;
      expect(box.x1).toBeGreaterThanOrEqual(SAFE * canvas.width - 1);
      expect(box.x2).toBeLessThanOrEqual((1 - SAFE) * canvas.width + 1);
      expect(box.y1).toBeGreaterThanOrEqual(SAFE * canvas.height - 1);
      expect(box.y2).toBeLessThanOrEqual((1 - SAFE) * canvas.height + 1);
    }
  };

  test("every edge demo stays in the safe area on 9:16 and 16:9, with the stamp's 1.6x pop and the slam's 1.18x", () => {
    for (const kind of ["one-word", "nine-words", "long-word", "no-hero", "urdu", "two-speakers"] as const) {
      const demo = sceneEdgeDemo(kind).cues;
      inside(build(demo), { width: 1080, height: 1920 });
      inside(build(demo, { canvas: { width: 1920, height: 1080 } }), { width: 1920, height: 1080 });
    }
  });

  test("the shock ring is cut at the safe area, where it grows past the frame", () => {
    const pieceRing = shape(2, "ring");
    const clip = at(pieceRing, cues[2]!.startMs + 150).clip!;
    expect(clip).toMatchObject({ x1: 54, x2: 1026, y1: 96, y2: 1824, inverse: false });
    // Unclipped it would reach well beyond the frame at 1.45 times.
    const bounds = pathBounds(pieceRing.path);
    expect((bounds.x2 - bounds.x1) * 1.45).toBeGreaterThan(1026 - 54);
  });

  test("a wide punchline wraps inside the burst instead of hanging its letters over the edge", () => {
    const wide = script(["so:m it:m ended", "Honestly:b+900 best:h decision:b ever.:b"]);
    expect(detectPunchlines(wide)[1]!.punch).toBe(true);
    const scene = build(wide);
    const words = scene.filter((piece): piece is TextPiece => piece.kind === "text" && cueNumber(piece) === 1);
    const rows = new Set(words.map((piece) => Math.round(at(piece, piece.toMs - 300).y - piece.origin!.dy)));
    expect(rows.size).toBeGreaterThanOrEqual(3);
    // Row widths stay inside the star's inner points.
    const star = pathBounds((scene.find((piece) => piece.id === "punchline:1:star") as ShapePiece).path);
    for (const piece of words) {
      const half = lilita(piece.text, piece.face, piece.sizePx, 0).advance / 2;
      expect(half).toBeLessThan(0.76 * ((star.x2 - star.x1) / 2.16) * 1.3);
    }
    expect(words.every((piece) => piece.fill === "#1B0B2E")).toBe(true);
  });

  test("a word wider than the safe area shrinks the cue, ordinary or punchline", () => {
    const longClip = script(["so:m this:m is", "pneumonoultramicroscopicsilicovolcanoconiosis:b+900."]);
    const scene = build(longClip);
    const huge = scene.find((piece) => piece.id === "punchline:1:w0") as TextPiece;
    expect(huge.sizePx).toBeLessThan(120);
    inside(scene, { width: 1080, height: 1920 });
  });

  test("right-to-left cues run right to left, with the sample's pops intact", () => {
    const urdu = sceneEdgeDemo("urdu").cues;
    const scene = build(urdu);
    const first = scene.find((piece) => piece.id === "punchline:0:w0") as TextPiece;
    const last = scene.find((piece) => piece.id === "punchline:0:w3") as TextPiece;
    expect(at(first, first.fromMs + 200).x).toBeGreaterThan(at(last, last.fromMs + 200).x);
  });

  test("the user's size scale scales the whole template", () => {
    const bigger = build(cues, { scale: 1.25 }).find((piece) => piece.id === "punchline:3:w0") as TextPiece;
    expect(bigger.sizePx).toBeCloseTo(word(3, 0).sizePx * 1.25, 6);
    // Twice the size no longer fits the rows: the cue shrinks to the safe area instead of leaving it.
    const huge = build(cues, { scale: 2 }).find((piece) => piece.id === "punchline:0:w0") as TextPiece;
    expect(huge.sizePx).toBeLessThan(160);
    inside(build(cues, { scale: 2 }), { width: 1080, height: 1920 });
  });
});
