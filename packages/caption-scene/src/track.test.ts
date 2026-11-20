import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece } from "./scene";
import { pathBounds } from "./shapes";
import { sceneInput } from "./test-support";
import { TRACK_DEMO, trackMove, trackProgram, trackStamp } from "./templates/track";

const { cues } = demoCues(TRACK_DEMO);
const scene = trackProgram.build(sceneInput(cues, { colours: { primary: "#F5F7FA", highlight: "#6CF0FF", accent: "#FFFFFF", shadow: "#000000" } }));
const byId = (id: string): Piece => {
  const piece = scene.pieces.find((candidate) => candidate.id === id);
  if (!piece) throw new Error(`no piece ${id}`);
  return piece;
};
const wordPiece = (cue: number, word: number) => byId(`track:${cue}:w${word}`) as TextPiece;

// The sample's own numbers, written out again so the tests are not the implementation.
const PAD_X = 17;
const PAD_Y = 13;
const ARM = 30;
const CAP = 0.727;
const XH = 0.545;
const DESC = 0.205;
const TALL = /[A-Z0-9bdfhklt'’!?ij]/;
const LOW = /[gjpqy]/;
const sampleMv = (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.4 ? (0.75 * p) / 0.4 : 0.75 + (0.25 * (p - 0.4)) / 0.6);

/** The tracker box of a word at rest, read from where the word was laid out. */
function restBox(cue: number, word: number) {
  const piece = wordPiece(cue, word);
  const pose = evaluatePiece(piece, piece.fromMs);
  const hero = piece.sizePx > 100;
  const left = hero ? pose.x - (piece.origin?.dx ?? 0) : pose.x;
  const baseline = hero ? pose.y - (piece.origin?.dy ?? 0) : pose.y;
  const width = [...piece.text].length * (0.55 + piece.letterSpacingEm) * piece.sizePx;
  const top = baseline - (TALL.test(piece.text) ? CAP : XH) * piece.sizePx;
  const bottom = baseline + (LOW.test(piece.text) ? DESC * piece.sizePx : 0);
  return { l: left - PAD_X, r: left + width + PAD_X, t: top - PAD_Y, b: bottom + PAD_Y, left, baseline, size: piece.sizePx, text: piece.text };
}

const corner = (cue: number, name: "tl" | "tr" | "bl" | "br", t: number) => {
  const pose = evaluatePiece(byId(`track:${cue}:${name}`), t);
  return { x: pose.x, y: pose.y, o: pose.o, colour: pose.colour };
};

describe("Track", () => {
  test("a piece per word, four corners and a readout per cue; KEY and a scanline only with a hero", () => {
    const count = (prefix: string, cue: number) => scene.pieces.filter((piece) => new RegExp(`^track:${cue}:${prefix}\\d*$`).test(piece.id)).length;
    for (const cue of cues) {
      expect(count("w", cue.index)).toBe(cue.words.length);
      expect(count("tl", cue.index) + count("tr", cue.index) + count("bl", cue.index) + count("br", cue.index)).toBe(4);
      expect(count("chip", cue.index)).toBe(cue.words.length);
      expect(count("stamp", cue.index)).toBe(cue.words.length);
      const heroes = cue.words.filter((word) => word.role === "hero").length;
      expect(count("key", cue.index)).toBe(heroes);
      expect(count("keytext", cue.index)).toBe(heroes);
      expect(count("scan", cue.index)).toBe(heroes > 0 ? 1 : 0);
    }
  });

  test("body words are 84 px Inter SemiBold, the hero 134 px Inter ExtraBold, all in the primary colour", () => {
    expect(wordPiece(0, 0)).toMatchObject({ face: "Inter SemiBold", sizePx: 84, letterSpacingEm: -0.01, fill: "#F5F7FA" });
    expect(wordPiece(2, 2)).toMatchObject({ face: "Inter", sizePx: 134, letterSpacingEm: -0.02, fill: "#F5F7FA" });
  });

  test("upcoming words wait as ghosts, light up on their spoken start, and the hero settles from 1.08", () => {
    const cue = cues[2]!;
    const just = wordPiece(2, 1);
    const start = cue.words[1]!.startMs;
    expect(evaluatePiece(just, start - 100).o).toBeCloseTo(0.34, 6);
    expect(evaluatePiece(just, start - 20).o).toBeCloseTo(0.34, 6);
    expect(evaluatePiece(just, start + 40).o).toBeCloseTo(1, 6);
    // Halfway through the 60 ms light-up: 34 % + half of the rest.
    expect(evaluatePiece(just, start + 10).o).toBeCloseTo(0.34 + 0.66 * 0.5, 2);
    const predicts = wordPiece(2, 2);
    const heroStart = cue.words[2]!.startMs;
    expect(evaluatePiece(predicts, heroStart).sx).toBeCloseTo(1.08, 6);
    expect(evaluatePiece(predicts, heroStart + 140).sx).toBeCloseTo(1, 6);
    expect(evaluatePiece(just, start + 50).sx).toBe(1);
  });

  test("a cue fades out inside its last 200 ms", () => {
    const cue = cues[1]!;
    const last = wordPiece(1, cue.words.length - 1);
    expect(evaluatePiece(last, cue.endMs - 200).o).toBeCloseTo(1, 6);
    expect(evaluatePiece(last, cue.endMs - 140).o).toBeCloseTo(0.5, 2);
    expect(evaluatePiece(last, cue.endMs - 81).o).toBeLessThan(0.02);
  });

  test("a wide cue splits into two rows that are as even as they can be, a short one stays in one", () => {
    const rows = (cue: number) => new Set(cues[cue]!.words.map((_, word) => Math.round(evaluatePiece(wordPiece(cue, word), 1).y * 10)));
    expect(rows(0).size).toBe(2);
    expect(rows(1).size).toBe(2);
    expect(rows(3).size).toBe(1);
    // "thing about AI" is the second row of the first cue; "Here's the thing" would be the wider split.
    expect(wordPiece(0, 2).text).toBe("thing");
    expect(evaluatePiece(wordPiece(0, 2), 1).y).toBeGreaterThan(evaluatePiece(wordPiece(0, 1), 1).y + 40);
  });

  test("at rest the four corners sit on the word's ink box: 17 px across, 13 px down, 30 px arms", () => {
    for (const [cue, word] of [[0, 1], [0, 3], [1, 2], [3, 1]] as const) {
      const box = restBox(cue, word);
      const t = cues[cue]!.words[word]!.startMs + 200;
      const tl = corner(cue, "tl", t);
      const tr = corner(cue, "tr", t);
      const bl = corner(cue, "bl", t);
      const br = corner(cue, "br", t);
      expect(tl.x).toBeCloseTo(box.l, 1);
      expect(tl.y).toBeCloseTo(box.t, 1);
      expect(tr.x).toBeCloseTo(box.r - ARM, 1);
      expect(tr.y).toBeCloseTo(box.t, 1);
      expect(bl.x).toBeCloseTo(box.l, 1);
      expect(bl.y).toBeCloseTo(box.b - ARM, 1);
      expect(br.x).toBeCloseTo(box.r - ARM, 1);
      expect(br.y).toBeCloseTo(box.b - ARM, 1);
      expect(tl.o).toBeCloseTo(1, 6);
    }
  });

  test("the box travels from one word to the next in the sample's two-part move, 40 ms before the word", () => {
    // "thing" (second row) to "about" and back across rows: cue 0, words 1 -> 2 (the, thing).
    const from = restBox(0, 1);
    const to = restBox(0, 2);
    const start = cues[0]!.words[2]!.startMs;
    for (const ms of [0, 12, 24, 48, 72, 96, 120]) {
      const p = sampleMv(ms / 120);
      const t = start - 40 + ms;
      // Between 1 ms before the move and its end the hero is not in play (neither word is a hero).
      expect(corner(0, "tl", t).x).toBeCloseTo(from.l + (to.l - from.l) * p, 0);
      expect(corner(0, "tl", t).y).toBeCloseTo(from.t + (to.t - from.t) * p, 0);
      expect(corner(0, "br", t).x).toBeCloseTo(from.r - ARM + (to.r - from.r) * p, 0);
    }
    // The move is quick at first: 75 % of the way in the first 40 % of the time.
    expect(trackMove(0.4)).toBeCloseTo(0.75, 9);
    const mid = corner(0, "tl", start - 40 + 48);
    expect(Math.abs(mid.x - to.l)).toBeLessThan(0.26 * Math.abs(from.l - to.l) + 0.6);
  });

  test("the first word's box closes in from 50 px out while it fades in, the sample's entrance", () => {
    const first = restBox(0, 0);
    const start = cues[0]!.words[0]!.startMs;
    expect(corner(0, "tl", start - 120).o).toBe(0);
    expect(corner(0, "tl", start - 120 + 0.6 * 160).o).toBeCloseTo(1, 6);
    // Fully closed on the word 160 ms after it starts, wider before: the flare is the sample's 0.6 of the body size, here the whole of it.
    const wide = corner(0, "tl", start - 120 + 10);
    const closed = corner(0, "tl", start + 40);
    expect(closed.x).toBeCloseTo(first.l, 1);
    expect(wide.x).toBeLessThan(first.l - 20);
  });

  test("a hero's box swells by 0.08 of the body size as it locks, then settles", () => {
    const cue = cues[2]!;
    const from = restBox(2, 1);
    const to = restBox(2, 2);
    const start = cue.words[2]!.startMs;
    const swell = 84 * 0.08;
    // At start + 60 the swell is full (over = 1) and the move is 100/120 through.
    const p = sampleMv(100 / 120);
    expect(corner(2, "tl", start + 60).x).toBeCloseTo(from.l + (to.l - from.l) * p - swell, 0);
    expect(corner(2, "tl", start + 300).x).toBeCloseTo(to.l, 1);
  });

  test("the cue's box collapses onto its last word and fades in the last 140 ms", () => {
    const cue = cues[3]!;
    const last = restBox(3, cue.words.length - 1);
    const cx = (last.l + last.r) / 2;
    const cy = (last.t + last.b) / 2;
    const almost = cue.endMs - 0.01;
    expect(corner(3, "tl", cue.endMs - 140).o).toBeCloseTo(1, 6);
    expect(corner(3, "tl", cue.endMs - 70).o).toBeCloseTo(0.5, 2);
    expect(corner(3, "tl", almost).x).toBeCloseTo(cx - ARM, 0);
    expect(corner(3, "tr", almost).x).toBeCloseTo(cx, 0);
    expect(corner(3, "tl", almost).y).toBeCloseTo(cy - ARM, 0);
    expect(corner(3, "bl", almost).y).toBeCloseTo(cy, 0);
  });

  test("the corners flash white as a word locks 80 ms after it starts and settle back over 160 ms", () => {
    const start = cues[1]!.words[2]!.startMs;
    expect(corner(1, "tl", start + 79).colour).toBe("#6CF0FF");
    expect(corner(1, "tl", start + 80).colour).toBe("#FFFFFF");
    const half = corner(1, "tl", start + 80 + 80).colour;
    // Halfway through an ease-out: the white has mostly gone.
    expect(Number.parseInt(half.slice(1, 3), 16)).toBeLessThan(0xe0);
    expect(corner(1, "tl", start + 80 + 160).colour).toBe("#6CF0FF");
    expect(corner(1, "tl", start + 400).colour).toBe("#6CF0FF");
  });

  test("the readout is the word's real time in the clip, mm:ss.cc, and wipes in left to right 40 ms after the word starts", () => {
    expect(trackStamp(0)).toBe("00:00.00");
    expect(trackStamp(1033)).toBe("00:01.03");
    expect(trackStamp(83_456)).toBe("01:23.45");
    for (const cue of cues) {
      for (const [at, word] of cue.words.entries()) {
        const stamp = byId(`track:${cue.index}:stamp${at}`) as TextPiece;
        expect(stamp.text).toBe(trackStamp(word.startMs));
        expect(stamp).toMatchObject({ face: "JetBrains Mono Bold", sizePx: 27, letterSpacingEm: 0.04, fill: "#6CF0FF" });
        expect(stamp.fromMs).toBe(word.startMs + 40);
        // It stays until the next word's label takes over (or the cue ends).
        const next = cue.words[at + 1];
        expect(stamp.toMs).toBe(next ? next.startMs + 40 : cue.endMs);
      }
    }
    // The wipe: the visible part of the plate grows over 90 ms.
    const plate = byId("track:1:chip2") as ShapePiece;
    const width = pathBounds(plate.path).x2;
    const labelFrom = cues[1]!.words[2]!.startMs + 40;
    const visible = (t: number) => {
      const clip = evaluatePiece(plate, t).clip!;
      return clip.x2 - clip.x1;
    };
    expect(visible(labelFrom + 0.01)).toBeCloseTo(0, 1);
    expect(visible(labelFrom + 45)).toBeCloseTo(width / 2, 1);
    expect(visible(labelFrom + 90)).toBeCloseTo(width, 1);
    expect(visible(labelFrom + 200)).toBeCloseTo(width, 1);
  });

  test("the readout rides 8 px above the top-left corner and follows it between words", () => {
    const plate = byId("track:1:chip3") as ShapePiece;
    const from = cues[1]!.words[3]!.startMs + 40;
    for (const t of [from + 5, from + 50, from + 180]) {
      const pose = evaluatePiece(plate, t);
      expect(pose.x).toBeCloseTo(corner(1, "tl", t).x, 3);
      expect(pose.y).toBeCloseTo(corner(1, "tl", t).y - 8 - 37, 3);
      expect(pose.o).toBeCloseTo(corner(1, "tl", t).o, 6);
    }
    // 37 px tall: padding 5, a 27 px line, padding 5.
    expect(pathBounds(plate.path).y2).toBeCloseTo(37, 6);
  });

  test("a hero's readout carries a KEY tag in the highlight colour, inside a wider plate", () => {
    const plain = byId("track:2:chip1") as ShapePiece;
    const hero = byId("track:2:chip2") as ShapePiece;
    expect(pathBounds(hero.path).x2).toBeGreaterThan(pathBounds(plain.path).x2 + 50);
    const key = byId("track:2:key2") as ShapePiece;
    expect(key.fill?.colour).toBe("#6CF0FF");
    expect((byId("track:2:keytext2") as TextPiece).text).toBe("KEY");
    expect((byId("track:2:keytext2") as TextPiece).fill).toBe("#03141A");
  });

  test("the hero's scanline sweeps its ink top to bottom once, from 60 ms after the word to 240 ms", () => {
    const scan = byId("track:2:scan") as ShapePiece;
    const box = restBox(2, 2);
    const start = cues[2]!.words[2]!.startMs;
    expect(scan.fromMs).toBeGreaterThan(start + 60);
    expect(scan.toMs).toBe(start + 240);
    const top = box.baseline - CAP * box.size - 4;
    const bottom = box.baseline + DESC * box.size + 2;
    expect(evaluatePiece(scan, start + 61).y).toBeCloseTo(top + (bottom - top) / 180, 0);
    expect(evaluatePiece(scan, start + 150).y).toBeCloseTo((top + bottom) / 2, 0);
    expect(evaluatePiece(scan, start + 239).y).toBeCloseTo(bottom - (bottom - top) / 180, 0);
    // Faint at the ends, almost opaque in the middle.
    expect(evaluatePiece(scan, start + 150).o).toBeCloseTo(1, 1);
    expect(evaluatePiece(scan, start + 61).o).toBeLessThan(0.2);
    // It spans the ink 6 px beyond each side and glows in the highlight colour.
    expect(pathBounds(scan.path).x2).toBeCloseTo(box.r - box.l - 2 * PAD_X + 12, 1);
    expect(scan.shadows?.[0]).toMatchObject({ colour: "#6CF0FF", blur: 5, alpha: 1 });
  });

  test("the brackets are a drop-shadowed L of two 6 px bars; the chip has no shadow of its own", () => {
    const tl = byId("track:0:tl") as ShapePiece;
    expect(pathBounds(tl.path)).toEqual({ x1: 0, y1: 0, x2: 30, y2: 30 });
    expect(tl.shadows).toHaveLength(1);
    expect((byId("track:0:chip0") as ShapePiece).shadows).toBeUndefined();
  });

  test("a cue whose box would flare out of the safe area starts its flare inside it", () => {
    const { cues: wide } = sceneEdgeDemo("nine-words");
    const built = trackProgram.build(sceneInput(wide));
    for (const piece of built.pieces.filter((candidate) => /:(tl|tr|bl|br)$/.test(candidate.id))) {
      for (let t = piece.fromMs; t < piece.toMs; t += 20) {
        const pose = evaluatePiece(piece, t);
        if (pose.o <= 0) continue;
        expect(pose.x).toBeGreaterThanOrEqual(0.05 * 1080 - 1);
        expect(pose.x + 30).toBeLessThanOrEqual(0.95 * 1080 + 1);
      }
    }
  });
});
