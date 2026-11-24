import { describe, expect, test } from "bun:test";
import { demoCues } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import type { SceneCue, SceneWord } from "./input";
import { type Measure, type Piece, evaluatePiece, pieceLocalBox } from "./scene";
import { CROSSTAPE_DEMO, crosstapeProgram } from "./templates/crosstape";
import { sceneInput } from "./test-support";

/** Closer to Inter Tight than the shared 0.55 em stand-in: heavy capitals are wide. */
const measure: Measure = (text, face, sizePx, letterSpacingEm) => ({
  advance: [...text].length * ((face.includes("ExtraBold") ? 0.66 : 0.5) + letterSpacingEm) * sizePx - letterSpacingEm * sizePx,
  inkTop: -0.72 * sizePx,
  inkBottom: 0.2 * sizePx,
  ascent: 1.1 * sizePx,
  descent: 0.3 * sizePx,
});

type Point = readonly [number, number];
const word = ([text, startMs, endMs, role]: readonly [string, number, number, SceneWord["role"]]): SceneWord => ({ text, startMs, endMs, role, key: null });
let next = 0;
const cue = (startMs: number, endMs: number, words: readonly (readonly [string, number, number, SceneWord["role"]])[]): SceneCue =>
  ({ index: next++, startMs, endMs, speaker: null, language: "en", words: words.map(word) });

/** Real cues of the en-waveform clip as the planner cut them (the style takes 4 words), keeping each word's real timing. */
const REAL: readonly SceneCue[] = [
  cue(1890, 2690, [["Does", 1890, 2070, "minor"], ["the", 2070, 2150, "minor"], ["remote", 2150, 2430, "body"], ["even", 2430, 2590, "hero"]]),
  cue(3130, 4250, [["The", 3130, 3410, "minor"], ["remote", 3410, 3650, "body"], ["doesn't", 3650, 3970, "hero"], ["work.", 3970, 4170, "body"]]),
  cue(7530, 8350, [["It's", 7530, 7710, "minor"], ["been", 7710, 7890, "minor"], ["that", 7890, 8090, "minor"], ["long.", 8090, 8250, "hero"]]),
  cue(8490, 9690, [["of", 8490, 8610, "minor"], ["them", 8610, 8750, "minor"], ["are", 8750, 8870, "minor"], ["unplugged.", 8870, 9330, "hero"]]),
  cue(12150, 12790, [["We", 12150, 12370, "minor"], ["didn't", 12370, 12610, "hero"], ["want", 12610, 12750, "body"]]),
  cue(12790, 14190, [["anyone", 12790, 13030, "minor"], ["to", 13030, 13230, "minor"], ["accidentally", 13230, 13750, "hero"], ["open", 13750, 14030, "body"], ["them.", 14030, 14150, "minor"]]),
  cue(14190, 15250, [["Just", 14190, 14470, "body"], ["tear", 14470, 14710, "body"], ["it", 14710, 14870, "minor"], ["down.", 14870, 15210, "minor"]]),
  cue(19590, 21550, [["We've", 19590, 19810, "minor"], ["shot", 19810, 20470, "body"], ["384", 20470, 21210, "hero"], ["episodes", 21210, 21530, "hero"]]),
  cue(30570, 32030, [["out", 30570, 30750, "minor"], ["for", 30750, 30890, "minor"], ["Waveform", 30890, 31390, "hero"], ["Studio", 31390, 31710, "hero"], ["number", 31710, 31950, "body"]]),
];
/** A cue built alone is cue 0 of its scene. */
const alone = (real: SceneCue): SceneCue => ({ ...real, index: 0 });
const WE_DIDNT_WANT = alone(REAL[4]!);
const DOESNT_WORK = alone(REAL[1]!);
const UNPLUGGED = alone(REAL[3]!);
const ACCIDENTALLY = alone(REAL[5]!);

const colours = { primary: "#111113", highlight: "#F8BE0E", accent: "#DCDCDC", shadow: "#000000" };
const FACE = /^crosstape:(\d+):w(\d+)$/;
const TAPE = /^crosstape:(\d+):tape(\d+)$/;

const build = (cues: readonly SceneCue[]) => crosstapeProgram.build(sceneInput(cues, { measure, colours, fps: 30 })).pieces;

/** The four corners of the piece's drawn rectangle at `t`, `shrink` of its width and height trimmed off each side. */
function corners(piece: Piece, t: number, shrinkX = 0, shrinkY = 0): Point[] | null {
  const pose = evaluatePiece(piece, t);
  if (!pose.visible || pose.o < 0.9) return null;
  const box = pieceLocalBox(piece, measure);
  const dx = (box.x2 - box.x1) * shrinkX;
  const dy = (box.y2 - box.y1) * shrinkY;
  const origin = piece.origin ?? { dx: 0, dy: 0 };
  const a = pose.rz * Math.PI / 180;
  return ([[box.x1 + dx, box.y1 + dy], [box.x2 - dx, box.y1 + dy], [box.x2 - dx, box.y2 - dy], [box.x1 + dx, box.y2 - dy]] as const).map(([x, y]) => {
    const ux = (x - origin.dx) * pose.sx;
    const uy = (y - origin.dy) * pose.sy;
    return [pose.x + ux * Math.cos(a) - uy * Math.sin(a), pose.y + ux * Math.sin(a) + uy * Math.cos(a)] as const;
  });
}

/** Separating-axis test for two convex polygons. */
function meet(a: readonly Point[], b: readonly Point[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i]!;
      const [x2, y2] = poly[(i + 1) % poly.length]!;
      const nx = y2 - y1;
      const ny = x1 - x2;
      const project = (points: readonly Point[]) => points.map(([x, y]) => x * nx + y * ny);
      const pa = project(a);
      const pb = project(b);
      if (Math.max(...pa) <= Math.min(...pb) + 0.5 || Math.max(...pb) <= Math.min(...pa) + 0.5) return false;
    }
  }
  return true;
}

function inside(point: Point, poly: readonly Point[]): boolean {
  const sides = poly.map(([x1, y1], i) => {
    const [x2, y2] = poly[(i + 1) % poly.length]!;
    return (x2 - x1) * (point[1] - y1) - (y2 - y1) * (point[0] - x1);
  });
  return sides.every((side) => side >= -1) || sides.every((side) => side <= 1);
}

const ofCue = (pieces: readonly Piece[], index: number) => pieces.filter((piece) => Number(piece.id.split(":")[1]) === index);
const faceRow = (piece: Piece) => piece.z - 32;
const tapeRow = (piece: Piece) => piece.z - 2;

/** Every frame of the cue where a later row's tape lies over an earlier row's words, or two words meet. */
function coverage(pieces: readonly Piece[], target: SceneCue): string[] {
  const own = ofCue(pieces, target.index);
  const faces = own.filter((piece) => FACE.test(piece.id));
  const tapes = own.filter((piece) => TAPE.test(piece.id));
  const found = new Set<string>();
  for (const t of exportFrameTimes(target.startMs, target.endMs, 30)) {
    const ink = faces.flatMap((piece) => {
      const box = corners(piece, t, 0.06, 0.15);
      return box ? [{ piece, box }] : [];
    });
    for (const { piece, box } of ink) {
      for (const tape of tapes) {
        if (tapeRow(tape) <= faceRow(piece)) continue;
        const plate = corners(tape, t);
        if (plate && meet(box, plate)) found.add(`${tape.id} lies over ${piece.id}`);
      }
    }
    for (const [i, a] of ink.entries()) {
      for (const b of ink.slice(i + 1)) if (meet(a.box, b.box)) found.add(`${a.piece.id} and ${b.piece.id} overlap`);
    }
  }
  return [...found];
}

describe("Crosstape on real cues", () => {
  test("a later tape never covers a spoken word", () => {
    const pieces = build(REAL);
    for (const real of REAL) expect(coverage(pieces, real)).toEqual([]);
  });

  test('"We didn\'t want" (real cue, 12730 ms): the "want" tape stays clear of DIDN\'T', () => {
    const pieces = build([WE_DIDNT_WANT]);
    const own = ofCue(pieces, WE_DIDNT_WANT.index);
    const hero = own.find((piece) => piece.id.endsWith(":w1"))!;
    const wantTape = own.find((piece) => TAPE.test(piece.id) && tapeRow(piece) === 2)!;
    const ink = corners(hero, 12730, 0.06, 0.15)!;
    expect(ink).not.toBeNull();
    expect(meet(ink, corners(wantTape, 12730)!)).toBe(false);
    expect(coverage(pieces, WE_DIDNT_WANT)).toEqual([]);
  });

  test("a four-word cue with the hero inside stacks in reading order instead of piling", () => {
    const pieces = build([DOESNT_WORK]);
    const ys = new Map<number, number[]>();
    for (const piece of ofCue(pieces, DOESNT_WORK.index)) {
      if (FACE.test(piece.id)) ys.set(faceRow(piece), [...(ys.get(faceRow(piece)) ?? []), evaluatePiece(piece, 4100).y]);
    }
    // The remote / DOESN'T / work.: three rows, each centred well below the one before it (room for a tape between).
    const centres = [...ys.keys()].sort((x, y) => x - y).map((row) => ys.get(row)!.reduce((sum, y) => sum + y, 0) / ys.get(row)!.length);
    expect(centres).toHaveLength(3);
    expect(centres[1]!).toBeGreaterThan(centres[0]! + 60);
    expect(centres[2]!).toBeGreaterThan(centres[1]! + 60);
    expect(coverage(pieces, DOESNT_WORK)).toEqual([]);
  });

  test("a long hero keeps a legible size and its black strip grows around it", () => {
    for (const long of [UNPLUGGED, ACCIDENTALLY]) {
      const pieces = build([long]);
      const own = ofCue(pieces, long.index);
      const heroAt = long.words.findIndex((entry) => entry.role === "hero");
      const hero = own.find((piece) => piece.id.endsWith(`:w${heroAt}`) && piece.kind === "text")!;
      if (hero.kind !== "text") throw new Error("hero is text");
      // The sample's slot held a 222 px hero, which shrank UNPLUGGED. to 36 px; it now reads at body size or more.
      expect(hero.sizePx).toBeGreaterThanOrEqual(62);
      const t = long.words.at(-1)!.endMs - 20;
      const strip = corners(own.find((piece) => TAPE.test(piece.id) && tapeRow(piece) === faceRow(hero))!, t)!;
      for (const corner of corners(hero, t)!) expect(inside(corner, strip)).toBe(true);
      expect(coverage(pieces, long)).toEqual([]);
    }
  });

  test("every word sits on its own tape", () => {
    const pieces = build(REAL);
    for (const real of REAL) {
      const own = ofCue(pieces, real.index);
      const t = real.words.at(-1)!.endMs - 20;
      for (const face of own.filter((piece) => FACE.test(piece.id))) {
        const tape = own.find((piece) => TAPE.test(piece.id) && tapeRow(piece) === faceRow(face))!;
        const plate = corners(tape, t);
        expect(plate).not.toBeNull();
        for (const corner of corners(face, t, 0, 0.1)!) expect(inside(corner, plate!)).toBe(true);
      }
    }
  });
});

describe("Crosstape keeps the sample's look", () => {
  const { cues } = demoCues(CROSSTAPE_DEMO);
  const pieces = build(cues);

  test("two plain lines cross at opposite tilts and the hero lies on the end of the second", () => {
    const tilt = (suffix: string) => evaluatePiece(pieces.find((piece) => piece.id === `crosstape:0:${suffix}`)!, 1800).rz;
    expect(tilt("tape0")).toBe(11);
    expect(tilt("tape1")).toBe(-13);
    expect(tilt("tape2")).toBe(-13);
  });

  test("a lone line is a single gently tilted tape", () => {
    expect(evaluatePiece(pieces.find((piece) => piece.id === "crosstape:3:tape0")!, 5900).rz).toBe(-5);
  });

  test("the demo cues have no covered word", () => {
    for (const demo of cues) expect(coverage(pieces, demo)).toEqual([]);
  });
});
