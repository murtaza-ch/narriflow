import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import type { SceneCue } from "./input";
import { EASES, clamp, prog } from "./ease";
import { evaluatePiece, pieceBounds, type Piece, type ShapePiece, type TextPiece } from "./scene";
import { pathBounds } from "./shapes";
import { fakeMeasure, sceneInput } from "./test-support";
import { DIALOGUE_DEMO, THREAD_BREAK_MS, dialogueProgram } from "./templates/dialogue";

const { cues } = demoCues(DIALOGUE_DEMO);
const input = sceneInput(cues, { anchor: { xPct: 50, yPct: (1560 / 1920) * 100 } });
const scene = dialogueProgram.build(input);
const piecesOf = (number: number, part: RegExp, all: readonly Piece[] = scene.pieces) => all.filter((piece) => piece.id.startsWith(`dialogue:${number}:`) && part.test(piece.id.split(":")[2]!));
const one = (number: number, part: string, all: readonly Piece[] = scene.pieces) => piecesOf(number, new RegExp(`^${part}$`), all)[0]!;
const heightOf = (piece: Piece) => {
  const b = pathBounds((piece as ShapePiece).path);
  return b.y2 - b.y1;
};
const widthOf = (piece: Piece) => {
  const b = pathBounds((piece as ShapePiece).path);
  return b.x2 - b.x1;
};

/** The sample's own `update(t)` for bubble `i`, written straight from `31-dialogue.js` (u = 1). */
const heights = cues.map((_, k) => heightOf(one(k, "body")));
function sample(t: number, i: number, c: readonly SceneCue[] = cues) {
  const lastEnd = (cue: SceneCue) => cue.words[cue.words.length - 1]!.endMs;
  const typingFrom = (k: number) => (c[k]!.startMs - (k ? lastEnd(c[k - 1]!) : 0) > 500 ? Math.max(k ? lastEnd(c[k - 1]!) + 140 : 140, c[k]!.startMs - 2000) : null);
  const arrival = (k: number) => typingFrom(k) ?? c[k]!.startMs - 60;
  const pop = (at: number) => {
    const p = prog(t, at, 380);
    return { s: 0.6 + 0.4 * EASES.spring(p), y: 40 * (1 - EASES.outExpo(p)), o: clamp(p / 0.22) };
  };
  let lift = 0;
  let age = 0;
  for (let j = i + 1; j < c.length; j++) {
    const a = EASES.outExpo(prog(t, arrival(j), 320));
    age += a;
    lift += typingFrom(j) !== null ? (112 + 16) * a + (heights[j]! - 112) * EASES.outExpo(prog(t, c[j]!.startMs - 60, 320)) : (heights[j]! + 16) * a;
  }
  const step = clamp(age);
  const gone = clamp(age - 1);
  lift += 70 * gone;
  const at = c[i]!.startMs - 60;
  const clear = EASES.in(prog(t, lastEnd(c[c.length - 1]!) + 650 - 200, 200));
  const opacity = (t < at ? 0 : (typingFrom(i) !== null ? 1 : pop(at).o) * (1 - gone)) * (1 - clear);
  return { y: 1560 + pop(at).y - lift + 24 * clear, s: pop(at).s * (1 - 0.06 * step), o: opacity, dim: 1 - 0.4 * step, step, gone };
}

describe("Dialogue", () => {
  test("a bubble per cue: body, tail, a word each and a marker behind each hero; a typing bubble only after a pause over 500 ms", () => {
    for (const cue of cues) {
      expect(piecesOf(cue.index, /^w\d+$/)).toHaveLength(cue.words.length);
      expect(piecesOf(cue.index, /^mark\d+$/)).toHaveLength(cue.words.filter((word) => word.role === "hero").length);
      expect(piecesOf(cue.index, /^body$/)).toHaveLength(1);
      expect(piecesOf(cue.index, /^tail$/)).toHaveLength(1);
    }
    // Only "Honestly?" follows a pause (900 ms plus the cue gap).
    expect(scene.pieces.filter((piece) => piece.id.split(":")[2]!.startsWith("ty-")).map((piece) => piece.id)).toEqual([
      "dialogue:3:ty-body",
      "dialogue:3:ty-tail",
      "dialogue:3:ty-dot0",
      "dialogue:3:ty-dot1",
      "dialogue:3:ty-dot2",
    ]);
  });

  test("speaker A sits on the left in grey with dark text, speaker B on the right in the accent with white text", () => {
    const a = one(0, "body") as ShapePiece;
    const b = one(1, "body") as ShapePiece;
    expect(a.fill).toEqual({ colour: "#F2F2F4" });
    expect(b.fill).toEqual({ colour: "#FFFFFF" }); // the test input's accent
    expect(evaluatePiece(a, 2000).x).toBe(84);
    expect(evaluatePiece(b, 3500).x).toBe(996);
    expect(pathBounds(a.path).x1).toBe(0);
    expect(pathBounds(b.path).x2).toBe(0);
    expect((one(0, "w1") as TextPiece).fill).toBe("#FFFFFF"); // primary of the test input
    expect((one(1, "w0") as TextPiece).fill).toBe("#FFFFFF");
    const accented = dialogueProgram.build(sceneInput(cues, { anchor: input.anchor, colours: { primary: "#111111", highlight: "#FFE14A", accent: "#2F6BFF", shadow: "#000000" } }));
    expect((one(1, "body", accented.pieces) as ShapePiece).fill).toEqual({ colour: "#2F6BFF" });
    expect((one(0, "w1", accented.pieces) as TextPiece).fill).toBe("#111111");
    expect((one(0, "mark2", accented.pieces) as ShapePiece).fill).toEqual({ colour: "#FFE14A" });
    expect((one(2, "mark2", accented.pieces) as ShapePiece).fill).toEqual({ colour: "#FFFFFF", alpha: 0.25 });
  });

  test("the first speaker seen is side A whoever it is, other speakers are B and an unknown one is A", () => {
    const make = (speaker: number | null, index: number): SceneCue => ({ index, startMs: index * 1500, endMs: index * 1500 + 1400, speaker, language: "en", words: [{ text: "hi", startMs: index * 1500, endMs: index * 1500 + 300, role: "body", key: null }] });
    const built = dialogueProgram.build(sceneInput([make(7, 0), make(3, 1), make(null, 2), make(7, 3), make(9, 4)]));
    const xs = [0, 1, 2, 3, 4].map((number) => evaluatePiece(one(number, "body", built.pieces), number * 1500 + 1000).x);
    expect(xs).toEqual([84, 996, 84, 84, 996]);
  });

  test("a bubble is its longest balanced row plus 40 px each side, 26 above and 30 below, rows 1.2 em apart", () => {
    // fakeMeasure: 0.55 em a character; the sample's letter spacing is -0.012 em, a CSS box adds it after every character.
    const size = 58;
    const box = (text: string) => [...text].length * (0.55 - 0.012) * size;
    const space = box(" ");
    // "Wait, for real?" fits one row.
    const wait = one(1, "body");
    expect(heightOf(wait)).toBeCloseTo(56 + 1.2 * size, 6);
    const row = ["Wait,", "for", "real?"].map(box).reduce((sum, w) => sum + w, 0) + 2 * space;
    expect(widthOf(wait)).toBe(Math.ceil(80 + row + 1));
    // "Honestly? Best decision ever." wraps into two rows.
    const two = one(3, "body");
    expect(heightOf(two)).toBeCloseTo(56 + 2 * 1.2 * size, 6);
    const ys = new Set(piecesOf(3, /^w\d+$/).map((piece) => (evaluatePiece(piece, 6500).y - (piece as TextPiece).origin!.dy).toFixed(3)));
    expect(ys.size).toBe(2);
    const [upper, lower] = [...ys].map(Number).sort((a, b) => a - b);
    expect(lower! - upper!).toBeCloseTo(1.2 * size, 2);
    // The longest row hugs the bubble: the bubble is no wider than its longest row plus the padding.
    expect(widthOf(two)).toBeLessThanOrEqual(760);
  });

  test("the newest bubble rests with its bottom edge on the anchor line, its words baseline above the padding", () => {
    const body = one(4, "body");
    const pose = evaluatePiece(body, 8000);
    expect(pose.y).toBeCloseTo(1560, 6);
    expect(pose.sx).toBeCloseTo(1, 6);
    const word = one(4, "w0") as TextPiece;
    // pivot is the bubble corner; the baseline sits at origin.dy below... above it
    expect(-word.origin!.dy).toBeCloseTo(-(30 + (14.59 / 58) * 58), 6);
    expect(-word.origin!.dx + evaluatePiece(word, 8000).x).toBeCloseTo(996 - widthOf(body) + 40, 6);
  });

  test("each bubble follows the sample's pop, lift, step back and fade, to the frame", () => {
    for (let i = 0; i < cues.length; i++) {
      const body = one(i, "body");
      let checked = 0;
      for (let t = body.fromMs; t < body.toMs; t += 13) {
        const expected = sample(t, i);
        const pose = evaluatePiece(body, t);
        if (expected.o > 0.004) {
          expect(Math.abs(pose.y - expected.y)).toBeLessThan(0.7);
          expect(Math.abs(pose.sx - expected.s)).toBeLessThan(0.003);
          expect(Math.abs(pose.o - expected.o)).toBeLessThan(0.01);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(30);
      // The sample hides it once it is gone: nothing is drawn after the piece's window.
      expect(sample(body.toMs + 1, i).o).toBeLessThan(0.01);
    }
  });

  test("older bubbles step back: scale 0.94 and words at 0.6, then the one before fades out", () => {
    const first = one(0, "body");
    const word = one(0, "w1") as TextPiece;
    // Cue 1 has arrived and settled, cue 2 has not started.
    const t = 2900;
    expect(evaluatePiece(first, t).sx).toBeCloseTo(0.94, 2);
    expect(evaluatePiece(word, t).o).toBeCloseTo(0.6, 2);
    // Cue 2 arrives (3069): cue 0 is gone by 3069 + 320.
    expect(evaluatePiece(first, 3069 + 100).o).toBeLessThan(0.7);
    expect(first.toMs).toBeCloseTo(3069 + 320, 6);
    expect(evaluatePiece(first, first.toMs - 1).o).toBeLessThan(0.01);
  });

  test("words light up at their spoken start: 0.3 to 1 over 120 ms", () => {
    const word = one(0, "w2") as TextPiece; // "quit" starts at 717
    expect(evaluatePiece(word, 717 - 60).o).toBeCloseTo(0.3, 2);
    expect(evaluatePiece(word, 717).o).toBeCloseTo(0.3 + 0.7 * 0.5, 2);
    expect(evaluatePiece(word, 717 + 60).o).toBeCloseTo(1, 2);
  });

  test("the hero word is weight 800 and a marker wipes in left to right over the word", () => {
    const hero = one(0, "w2") as TextPiece;
    expect(hero.face).toBe("Inter");
    expect((one(0, "w1") as TextPiece).face).toBe("Inter SemiBold");
    const mark = one(0, "mark2") as ShapePiece;
    const bounds = pathBounds(mark.path);
    const width = bounds.x2 - bounds.x1;
    // quit: 717 to 1187, wipe from 697 over 470 ms with the sample's `out`.
    for (const t of [700, 760, 850, 1000, 1180, 1500]) {
      const pose = evaluatePiece(mark, t);
      const fraction = EASES.out(prog(t, 697, 470));
      if (fraction === 0) continue;
      expect(pose.clip!.x1).toBeCloseTo(84 + pose.sx * bounds.x1, 1);
      expect((pose.clip!.x2 - pose.clip!.x1) / (pose.sx * width)).toBeCloseTo(fraction, 2);
    }
    // The marker takes the word's opacity with it.
    expect(evaluatePiece(mark, 800).o).toBeCloseTo(evaluatePiece(hero, 800).o, 6);
  });

  test("the tail goes from an older bubble when the next one of the same side arrives", () => {
    // Cues 1 and 2 are both B: cue 1 loses its tail from 3069 over 160 ms; cue 0 and cue 2 keep theirs.
    const tail = one(1, "tail");
    const body = one(1, "body");
    expect(evaluatePiece(tail, 3000).o).toBeCloseTo(evaluatePiece(body, 3000).o, 3);
    expect(evaluatePiece(tail, 3069 + 80).o).toBeCloseTo(0.5 * evaluatePiece(body, 3069 + 80).o, 2);
    expect(evaluatePiece(tail, 3069 + 160).o).toBeLessThan(0.01);
    expect(evaluatePiece(body, 3069 + 160).o).toBeGreaterThan(0.9);
    expect(evaluatePiece(one(2, "tail"), 4000).o).toBe(1);
    expect(evaluatePiece(one(0, "tail"), 2500).o).toBeGreaterThan(0.9); // the next bubble is B, so A keeps its tail
  });

  test("a pause over 500 ms shows the next speaker typing from 140 ms after the last word until the bubble replaces it", () => {
    const ty = one(3, "ty-body");
    expect(ty.fromMs).toBe(4431 + 140);
    expect(ty.toMs).toBe(5451 + 40);
    // It pops in like a bubble and is opaque within 22 % of the pop.
    expect(evaluatePiece(ty, ty.fromMs).o).toBe(0);
    expect(evaluatePiece(ty, ty.fromMs + 100).o).toBe(1);
    expect(evaluatePiece(ty, ty.fromMs + 380).sx).toBeCloseTo(1, 6);
    expect(pathBounds((ty as ShapePiece).path)).toMatchObject({ x1: 0, x2: 176, y1: -112, y2: 0 });
    // The real bubble is drawn over it from 60 ms before its first word.
    expect(one(3, "body").fromMs).toBe(5451 - 60);
    expect(one(3, "body").z).toBeGreaterThan(ty.z);
  });

  test("the three typing dots hop in turn: 900 ms cycle, 150 ms apart, 11 px, resting at half opacity", () => {
    const from = 4431 + 140;
    const dots = [0, 1, 2].map((k) => one(3, `ty-dot${k}`));
    const hop = (t: number, k: number) => {
      const phase = ((((t - from - k * 150) % 900) + 900) % 900) / 900;
      return phase < 0.42 ? Math.sin((Math.PI * phase) / 0.42) : 0;
    };
    const rest = evaluatePiece(dots[0]!, from + 700).y; // dot 0 is still at 700 ms (the pause lasts 920 ms)
    for (const t of [from + 400, from + 450, from + 500, from + 560, from + 640, from + 700, from + 800, from + 905]) {
      for (const [k, dot] of dots.entries()) {
        const pose = evaluatePiece(dot, t);
        expect(Math.abs(pose.y - (rest - 11 * hop(t, k)))).toBeLessThan(0.6);
        expect(Math.abs(pose.o - (0.5 + 0.5 * hop(t, k)))).toBeLessThan(0.02);
      }
    }
    // Dots are 20 px circles 33 px apart.
    const b0 = pathBounds((dots[0] as ShapePiece).path);
    const b1 = pathBounds((dots[1] as ShapePiece).path);
    expect(b0.x2 - b0.x1).toBeCloseTo(20, 6);
    expect(b1.x1 - b0.x1).toBeCloseTo(33, 6);
  });

  test("the thread clears in the last cue's final 200 ms and nothing is drawn after the last cue", () => {
    const end = cues[4]!.endMs;
    const body = one(4, "body");
    expect(body.toMs).toBe(end);
    expect(evaluatePiece(body, end - 200).o).toBeCloseTo(1, 6);
    expect(evaluatePiece(body, end - 1).o).toBeLessThan(0.02);
    expect(evaluatePiece(body, end - 100).y - 1560).toBeCloseTo(24 * EASES.in(0.5), 1);
    expect(Math.max(...scene.pieces.map((piece) => piece.toMs))).toBeLessThanOrEqual(end);
  });

  test("a silence longer than three seconds ends the thread: the next cue starts a fresh one and does not push the old one", () => {
    const make = (index: number, startMs: number): SceneCue => ({ index, startMs, endMs: startMs + 1000, speaker: index % 2, language: "en", words: [{ text: "hey", startMs, endMs: startMs + 400, role: "body", key: null }, { text: "there", startMs: startMs + 430, endMs: startMs + 800, role: "body", key: null }] });
    const gap = THREAD_BREAK_MS + 500;
    const split = dialogueProgram.build(sceneInput([make(0, 1000), make(1, 1000 + 400 + gap)]));
    const first = one(0, "body", split.pieces);
    // The first thread clears at its own end, 650 ms after its last word, before the typing bubble of the next appears.
    expect(first.toMs).toBe(1000 + 1000);
    expect(evaluatePiece(first, 1800).sy).toBeCloseTo(1, 3);
    const typing = one(1, "ty-body", split.pieces);
    expect(typing.fromMs).toBeGreaterThan(first.toMs);
    // A long silence shows typing for at most two seconds.
    expect(typing.toMs - typing.fromMs).toBeLessThanOrEqual(2040);
    // A shorter silence keeps the thread.
    const joined = dialogueProgram.build(sceneInput([make(0, 1000), make(1, 1000 + 400 + 2000)]));
    expect(one(0, "body", joined.pieces).toMs).toBeGreaterThan(3000);
  });

  test("a word wider than the bubble shrinks the text and the bubble stays inside the safe area", () => {
    const { cues: long } = sceneEdgeDemo("long-word");
    const built = dialogueProgram.build(sceneInput(long, { anchor: input.anchor }));
    const body = one(1, "body", built.pieces);
    expect(widthOf(body)).toBeLessThanOrEqual(900);
    const word = built.pieces.find((piece) => piece.id === "dialogue:1:w0") as TextPiece;
    expect(word.sizePx).toBeLessThan(58);
    for (const piece of built.pieces) for (let t = piece.fromMs; t < piece.toMs; t += 50) {
      const box = pieceBounds(piece, t, fakeMeasure);
      if (box) expect(box.x1).toBeGreaterThanOrEqual(0.05 * 1080 - 1);
    }
  });

  test("a right-to-left cue puts its first word on the right edge of its row", () => {
    const { cues: urdu } = sceneEdgeDemo("urdu");
    const built = dialogueProgram.build(sceneInput(urdu, { anchor: input.anchor }));
    const words = (piecesOf(0, /^w\d+$/, built.pieces) as TextPiece[]).sort((a, b) => Number(a.id.split(":w")[1]) - Number(b.id.split(":w")[1]));
    const at = (piece: TextPiece) => -piece.origin!.dx;
    expect(words).toHaveLength(4);
    // Logical order runs right to left: each word sits left of the one before it.
    for (let k = 1; k < words.length; k++) expect(at(words[k]!)).toBeLessThan(at(words[k - 1]!));
  });

  test("a 16:9 canvas keeps the chat column in the middle and every bubble inside the safe area", () => {
    const wide = dialogueProgram.build(sceneInput(cues, { canvas: { width: 1920, height: 1080 }, anchor: { xPct: 50, yPct: (1560 / 1920) * 100 } }));
    expect(evaluatePiece(one(0, "body", wide.pieces), 2000).x).toBe(960 + (84 - 540));
    expect(evaluatePiece(one(1, "body", wide.pieces), 3500).x).toBe(960 + (996 - 540));
  });

  test("scaling the size scales the bubble about the anchor", () => {
    const big = dialogueProgram.build(sceneInput(cues, { scale: 1.2, anchor: input.anchor }));
    expect(heightOf(one(0, "body", big.pieces))).toBeCloseTo(1.2 * heightOf(one(0, "body")), 0);
    expect(evaluatePiece(one(4, "body", big.pieces), 8000).y).toBeCloseTo(1560, 6);
  });
});
