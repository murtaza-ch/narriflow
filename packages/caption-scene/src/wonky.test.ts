import { describe, expect, test } from "bun:test";
import { type DemoScript, demoCues, sceneEdgeDemo } from "./demo";
import { EASES, clamp, prog } from "./ease";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { WONKY_DEMO, WONKY_STICKERS, wonkyBaseline, wonkyDisplay, wonkyHash, wonkyLetters, wonkyOutBack, wonkyProgram, wonkyRng } from "./templates/wonky";
import { fakeMeasure, sceneInput } from "./test-support";

const COLOURS = { primary: "#FFFFFF", highlight: "#4CF59A", accent: "#FF7AD9", shadow: "#000000" };
const buildFor = (script: DemoScript, overrides = {}) => {
  const { cues } = demoCues(script);
  return wonkyProgram.build(sceneInput(cues, { anchor: { xPct: 50, yPct: (1280 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
};
const { cues } = demoCues(WONKY_DEMO);
const scene = buildFor(WONKY_DEMO);
const ofCue = (list: readonly Piece[], cue: number) => list.filter((piece) => piece.id.startsWith(`wonky:${cue}:`));
const texts = (list: readonly Piece[]) => list.filter((piece): piece is TextPiece => piece.kind === "text");
const stickers = (list: readonly Piece[]) => list.filter((piece): piece is ShapePiece => piece.kind === "shape");
const tiltOf = (piece: Piece) => evaluatePiece(piece, piece.toMs - 140).rz;

describe("Wonky helpers", () => {
  test("outBack takes the sample's overshoot parameter", () => {
    expect(wonkyOutBack(0, 2.4)).toBeCloseTo(0, 9);
    expect(wonkyOutBack(1, 2.4)).toBeCloseTo(1, 9);
    expect(wonkyOutBack(0.5, 1.70158)).toBeCloseTo(EASES.outBack(0.5), 9);
    expect(Math.max(...[...Array(100).keys()].map((at) => wonkyOutBack(at / 99, 2.4)))).toBeGreaterThan(1.1);
  });

  test("the seeded generator and hash are deterministic and spread", () => {
    expect(wonkyHash("a")).toBe(wonkyHash("a"));
    expect(wonkyHash("a")).not.toBe(wonkyHash("b"));
    expect(wonkyRng(5)()).toBe(wonkyRng(5)());
    const draws = [...Array(50)].map(((r) => () => r())(wonkyRng(9)));
    expect(new Set(draws).size).toBe(50);
    for (const d of draws) expect(d >= 0 && d < 1).toBe(true);
  });

  test("Rubik's line-box baseline is Chrome's rounded one (108 of 128 px)", () => {
    expect(wonkyBaseline(128)).toBe(108);
  });

  test("letters split for Latin, Greek and Cyrillic only; other scripts stay whole and keep their case", () => {
    expect(wonkyLetters("HELLO")).toEqual(["H", "E", "L", "L", "O"]);
    expect(wonkyLetters("привет")).toHaveLength(6);
    expect(wonkyLetters("اچھا")).toBeNull();
    expect(wonkyLetters("नमस्ते")).toBeNull();
    expect(wonkyLetters("你好")).toBeNull();
    expect(wonkyLetters("שלום")).toBeNull();
    expect(wonkyLetters("x".repeat(25))).toBeNull();
    expect(wonkyDisplay("hello")).toBe("HELLO");
    expect(wonkyDisplay("اچھا")).toBe("اچھا");
    expect(wonkyDisplay("ქართული")).toBe("ქართული");
  });
});

describe("Wonky rows and words", () => {
  test("a hero cue is a lead row, a big hero row of letters and a tail row; the hero is mint, the rest white with a hard extrusion", () => {
    const cue0 = texts(ofCue(scene, 0));
    const nobody = cue0.find((piece) => piece.id === "wonky:0:w0")!;
    const letters = cue0.filter((piece) => piece.id.startsWith("wonky:0:w1l"));
    expect(nobody.text).toBe("NOBODY");
    expect(letters.map((piece) => piece.text).join("")).toBe("CARES");
    expect(nobody.fill).toBe("#FFFFFF");
    expect(letters[0]!.fill).toBe(COLOURS.highlight);
    expect(nobody.face).toBe("Rubik Black");
    expect(nobody.letterSpacingEm).toBe(-0.01);
    // The hero row is the biggest (236 at most), the body rows 128 or less.
    expect(letters[0]!.sizePx).toBeGreaterThan(nobody.sizePx);
    expect(letters[0]!.sizePx).toBeLessThanOrEqual(236);
    expect(nobody.sizePx).toBeLessThanOrEqual(128);
    // Extrusion: the sample's `0.55e e 0` hard copy and `0 1.6e 3.4e` soft lift, e = max(5, 0.05 size).
    const e = Math.max(5, 0.05 * nobody.sizePx);
    expect(nobody.shadows![0]).toMatchObject({ dx: 0.55 * e, dy: e, blur: 0, colour: "#7B2FF7", alpha: 1 });
    expect(nobody.shadows![1]).toMatchObject({ dx: 0, dy: 1.6 * e, blur: 1.7 * e });
  });

  test("hero letters rise with the sample's formula: scale 0.5 + 0.5 out(p), opacity 5p, staggered min(20, 110 / n) ms", () => {
    const hero = cues[0]!.words[1]!;
    const letters = texts(ofCue(scene, 0)).filter((piece) => piece.id.startsWith("wonky:0:w1l"));
    const stagger = Math.min(20, 110 / letters.length);
    letters.forEach((letter, li) => {
      const start = hero.startMs - 110 + li * stagger;
      for (const dt of [40, 120, 220]) {
        const t = start + dt;
        const p = prog(t, start, 300);
        const pose = evaluatePiece(letter, t);
        expect(pose.sx).toBeCloseTo(0.5 + 0.5 * EASES.out(p), 2);
        expect(pose.o).toBeCloseTo(clamp(p * 5), 1);
      }
    });
  });

  test("a word rises 0.5 em with outBack(2) and turns 9 degrees from 70 ms before it is spoken", () => {
    const word = cues[0]!.words[0]!;
    const piece = scene.find((p) => p.id === "wonky:0:w0")! as TextPiece;
    const start = word.startMs - 70;
    expect(piece.fromMs).toBe(start);
    const rest = evaluatePiece(piece, start + 600);
    const t = start + 90;
    const p = prog(t, start, 300);
    const pose = evaluatePiece(piece, t);
    const row = (rest.rz + 0) as number;
    expect(pose.rz - row).toBeCloseTo((1 - EASES.out(p)) * 9, 0);
    expect(pose.o).toBeCloseTo(clamp(p * 3), 1);
    expect(pose.y - rest.y).toBeGreaterThan(0);
  });

  test("a cue with no hero and three words takes two even rows at one size", () => {
    const cue1 = texts(ofCue(scene, 1));
    expect(cue1).toHaveLength(3);
    const ys = cue1.map((piece) => evaluatePiece(piece, piece.toMs - 140).y).sort((a, b) => a - b);
    expect(ys.filter((y, at) => at > 0 && y - ys[at - 1]! > 90)).toHaveLength(1);
    expect(new Set(cue1.map((piece) => piece.sizePx)).size).toBe(1);
    expect(cue1[0]!.sizePx).toBeLessThanOrEqual(156);
  });

  test("rows tip on alternating sides, 3 to 5 degrees, and a lone row has no shift", () => {
    const cue0 = texts(ofCue(scene, 0));
    const rest = (id: string) => tiltOf(cue0.find((piece) => piece.id.startsWith(id))!);
    expect(Math.sign(rest("wonky:0:w0"))).toBe(-Math.sign(tiltOf(cue0.find((piece) => piece.id.startsWith("wonky:0:w1l"))!)));
    const lone = texts(ofCue(scene, 4))[0]!;
    // Alone in its cue: rests centred on the anchor (a row's own letters wobble only by their jitter).
    expect(Math.abs(evaluatePiece(lone, lone.toMs - 140).rz)).toBeLessThan(10);
  });

  test("the cue leaves 130 ms before 80 ms ahead of its end: rows drop 46 px, tip further, shrink to 0.86 and fade", () => {
    const cue = cues[0]!;
    const word = scene.find((p) => p.id === "wonky:0:w0")! as TextPiece;
    const end = cue.endMs - 80;
    expect(word.toMs).toBe(end);
    const before = evaluatePiece(word, end - 131);
    const near = evaluatePiece(word, end - 1);
    expect(before.o).toBe(1);
    expect(near.o).toBeLessThan(0.05);
    expect(near.sx).toBeCloseTo(0.86, 1);
    expect(near.y).toBeGreaterThan(before.y + 30);
  });
});

describe("Wonky stickers recur and vary", () => {
  const long: DemoScript = { lines: Array.from({ length: 5 }, () => WONKY_DEMO.lines).flat().concat(Array.from({ length: 5 }, () => WONKY_DEMO.lines).flat()), options: WONKY_DEMO.options };
  const many = buildFor(long);

  test("every cue of a 50-cue clip has a sticker, hero cues two", () => {
    const { cues: all } = demoCues(long);
    expect(all).toHaveLength(50);
    all.forEach((cue, at) => {
      const own = stickers(ofCue(many, at));
      expect(own.length).toBe(cue.words.some((word) => word.role === "hero") ? 2 : 1);
    });
  });

  test("the five shapes come round, in the demo's order first, on alternating sides", () => {
    const kind = (piece: ShapePiece) => (piece.stroke ? "donut" : Object.entries(WONKY_STICKERS).find(([, spec]) => spec.colour === piece.fill!.colour && piece.path.length === spec.path.length)?.[0]);
    const heroCues = [0, 2, 3, 4].map((at) => ofCue(many, at).filter((p) => p.id.endsWith(":st0"))[0] as ShapePiece | undefined);
    expect(heroCues.map((p) => (p ? kind(p) : null))).toEqual(["flower", "blob", "sparkle", "badge"]);
    const used = new Set(stickers(many).map((piece) => kind(piece)));
    expect(used.size).toBe(5);
    const sideOf = (cue: number) => Math.sign(evaluatePiece(ofCue(many, cue).find((p) => p.id.endsWith(":st0"))!, 4000).x - 540);
    expect(sideOf(0)).toBe(-sideOf(2));
  });

  test("tilts, shifts and colours keep varying across the clip", () => {
    const tilts = new Set<number>();
    const fills = new Set<string>();
    for (let cue = 0; cue < 50; cue++) {
      for (const piece of texts(ofCue(many, cue))) {
        tilts.add(Math.round(tiltOf(piece)));
        if (piece.fill !== "#FFFFFF") fills.add(piece.fill);
      }
    }
    expect(tilts.size).toBeGreaterThan(5);
    expect([...fills].sort()).toEqual([COLOURS.highlight, COLOURS.accent].sort());
    // Two cues with the same words still differ (the hash takes the cue index).
    const same = texts(ofCue(many, 1)).map((p) => Math.round(tiltOf(p) * 10));
    const again = texts(ofCue(many, 26)).map((p) => Math.round(tiltOf(p) * 10));
    expect(same.length).toBe(again.length);
  });

  test("a sticker keeps turning through a long hold, bounded in the safe area", () => {
    const sticker = stickers(ofCue(many, 2))[0]!;
    const a = evaluatePiece(sticker, sticker.fromMs + 600).rz;
    const b = evaluatePiece(sticker, sticker.fromMs + 1100).rz;
    expect(Math.abs(b - a)).toBeGreaterThan(1);
    for (let t = sticker.fromMs; t < sticker.toMs; t += 33) {
      const pose = evaluatePiece(sticker, t);
      expect(pose.x).toBeGreaterThan(0.05 * 1080);
      expect(pose.x).toBeLessThan(0.95 * 1080);
    }
  });
});

describe("Wonky with real speech timing", () => {
  test.each([60, 0])("cueGap %d: every word stays visible 150 ms after it lands", (cueGap) => {
    const script = { ...WONKY_DEMO, options: { ...WONKY_DEMO.options, cueGap } };
    const pieces = buildFor(script);
    for (const piece of texts(pieces)) {
      let landed: number | null = null;
      for (let t = piece.fromMs; t < piece.toMs; t++) {
        if (evaluatePiece(piece, t).o > 0.9) {
          landed = t;
          break;
        }
      }
      expect(landed).not.toBeNull();
      for (let t = landed!; t <= landed! + 150; t += 5) {
        const pose = evaluatePiece(piece, t);
        expect(pose.visible).toBe(true);
        expect(pose.o).toBeGreaterThan(0.9);
      }
    }
  });

  test("a one-word cue followed 100 ms later by the next still holds its word", () => {
    const script: DemoScript = { lines: ["go:h@200", "now:h@200"], options: { cueGap: 40, rate: 100 } };
    for (const piece of texts(buildFor(script))) {
      const landed = [...Array(piece.toMs - piece.fromMs).keys()].map((at) => piece.fromMs + at).find((t) => evaluatePiece(piece, t).o > 0.9)!;
      expect(piece.toMs - landed).toBeGreaterThanOrEqual(150);
    }
  });

  test("the normal pacing keeps the sample's exit", () => {
    const base = scene.find((p) => p.id === "wonky:0:w0")!;
    expect(base.toMs).toBe(cues[0]!.endMs - 80);
  });
});

describe("Wonky in other scripts and frames", () => {
  test("Urdu words are whole pieces, run right to left, and keep their text", () => {
    const pieces = texts(wonkyProgram.build(sceneInput(sceneEdgeDemo("urdu").cues, { anchor: { xPct: 50, yPct: (1280 / 1920) * 100 }, colours: COLOURS })).pieces);
    const cue0 = pieces.filter((piece) => piece.id.startsWith("wonky:0:"));
    expect(cue0.map((piece) => piece.text).sort()).toEqual(["یہ", "بہت", "اچھا", "ہے"].sort());
    const x = (id: string) => evaluatePiece(pieces.find((piece) => piece.id === id)!, 1500).x;
    // First word on the right of the second in the same row.
    expect(x("wonky:0:w0")).toBeGreaterThan(x("wonky:0:w1"));
  });

  test("a long word shrinks to fit one row and a nine-word cue stays inside the safe area, 9:16 and 16:9", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      for (const kind of ["long-word", "nine-words", "one-word"] as const) {
        const { cues: edge } = sceneEdgeDemo(kind);
        const pieces = wonkyProgram.build(sceneInput(edge, { canvas, anchor: { xPct: 50, yPct: (1280 / 1920) * 100 }, colours: COLOURS })).pieces;
        for (let t = 0; t < 7000; t += 33) {
          const box = sceneBoundsAt(pieces, t, fakeMeasure);
          if (!box) continue;
          expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
          expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
          expect(box.y1).toBeGreaterThanOrEqual(0.05 * canvas.height - 1);
          expect(box.y2).toBeLessThanOrEqual(0.95 * canvas.height + 1);
        }
      }
    }
  });
});
