import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece } from "./scene";
import { HEFT_DEMO, heftHash, heftProgram, heftSplitsIntoLetters, heftTyped } from "./templates/heft";
import { fakeMeasure, sceneInput } from "./test-support";

const COLOURS = { primary: "#FFFFFF", highlight: "#FFFFFF", accent: "#9BF03A", shadow: "#000000" };
const make = (list: readonly SceneCue[], overrides = {}) => sceneInput(list, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: COLOURS, ...overrides });
const build = (list: readonly SceneCue[], overrides = {}) => heftProgram.build(make(list, overrides)).pieces;
const { cues } = demoCues(HEFT_DEMO);
const scene = build(cues);
const find = (list: readonly Piece[], id: string) => list.find((piece) => piece.id === `heft:${id}`);
const need = <T extends Piece>(piece: Piece | undefined) => {
  expect(piece).toBeDefined();
  return piece as T;
};
const LIGHT_W = (text: string, size = 74) => fakeMeasure(text, "Lexend Exa Light", size, 0.01).advance + 0.01 * size;

describe("Heft geometry", () => {
  test("light words: 74 px capitals, baseline 68 px into a 1.12 line box, rows centred on x 540, wrapped at 760 px", () => {
    // Cue 0 has no key word: "stop waiting for permission", centred on y 1290.
    const first = need<TextPiece>(find(scene, "0:w0"));
    expect(first.text).toBe("STOP");
    expect(first.face).toBe("Lexend Exa Light");
    expect(first.sizePx).toBeCloseTo(74, 6);
    // The measure stand-in is narrow enough that three words share the first row, PERMISSION wraps.
    const widths = ["STOP", "WAITING", "FOR"].map((word) => LIGHT_W(word));
    const gap = 0.42 * 74;
    const rowW = widths[0]! + gap + widths[1]! + gap + widths[2]!;
    expect(evaluatePiece(first, 400).x).toBeCloseTo(540 - rowW / 2, 4);
    // Row pitch is the line box: 1.12 x 74.
    const waiting = need<TextPiece>(find(scene, "0:w1"));
    const forWord = need<TextPiece>(find(scene, "0:w3"));
    expect(evaluatePiece(waiting, 800).y).toBeCloseTo(evaluatePiece(first, 800).y, 6);
    expect(evaluatePiece(forWord, 1500).y - evaluatePiece(first, 1500).y).toBeCloseTo(1.12 * 74, 4);
  });

  test("the key word is capital Unbounded Black fitted to 880 px (at most 170 px), its stack 2.64 em tall, block centred on 1290", () => {
    const hero = need<TextPiece>(find(scene, "1:hero"));
    expect(hero.text).toBe("BUILD");
    expect(hero.face).toBe("Unbounded Black");
    expect(hero.sizePx).toBeCloseTo(170, 6);
    expect(hero.letterSpacingEm).toBe(-0.02);
    // One lead row ("just") of 82.88 px, 14 px, the stack of 2.64 x 170 px: the block is centred on 1290.
    const total = 1.12 * 74 + 14 + 2.64 * 170;
    const stackTop = 1290 - total / 2 + 1.12 * 74 + 14;
    // Baseline = pivot y - origin dy = stack top + 148 px.
    expect(evaluatePiece(hero, 3000).y - hero.origin!.dy).toBeCloseTo(stackTop + 148, 4);
  });

  test("the echoes sit one and two steps (0.84 em) under the word at 0.4 and 0.15, folding back on the exit", () => {
    const hero = need<TextPiece>(find(scene, "1:hero"));
    const cue = cues[1]!;
    const baseline = evaluatePiece(hero, 3000).y - hero.origin!.dy;
    for (const [i, opacity] of [[0, 0.4], [1, 0.15]] as const) {
      const echo = need<TextPiece>(find(scene, `1:echo${i}`));
      expect(echo.track.o![0]![1]).toBe(opacity);
      expect(evaluatePiece(echo, 3000).y).toBeCloseTo(baseline + (i + 1) * 0.84 * 170, 3);
      // Folded into the word and gone at the end of the exit.
      expect(evaluatePiece(echo, echo.toMs - 1).y).toBeLessThan(baseline + 0.5 * 170);
    }
    expect(cue.words[1]!.role).toBe("hero");
  });

  test("the asterisk is six round arms, spinning at the word's top corner for the whole hold", () => {
    const star = need<ShapePiece>(find(scene, "1:star"));
    expect(star.stroke!.colour).toBe("#9BF03A");
    const early = evaluatePiece(star, 2800).rz;
    const late = evaluatePiece(star, 3200).rz;
    expect(Math.abs(late - early)).toBeGreaterThan(8);
    // About 0.03 degrees a ms once popped (the rate carries a small seeded jitter).
    expect(Math.abs(late - early) / 400).toBeGreaterThan(0.023);
    expect(Math.abs(late - early) / 400).toBeLessThan(0.037);
  });
});

describe("Heft motion", () => {
  test("light words type one letter every 34 ms: the clip's right edge steps with the sample's letter count", () => {
    const word = cues[0]!.words[3]!;
    const piece = need<TextPiece>(find(scene, "0:w3"));
    const n = word.text.length;
    const left = evaluatePiece(piece, word.startMs).x;
    for (const t of [word.startMs - 40, word.startMs, word.startMs + 60, word.startMs + 150, word.startMs + 280]) {
      const shown = heftTyped(t, word.startMs, n);
      if (shown >= n || shown === 0) continue;
      const clip = evaluatePiece(piece, t).clip!;
      const edge = fakeMeasure(word.text.toUpperCase().slice(0, shown), "Lexend Exa Light", 74, 0.01).advance + 0.01 * 74;
      expect(clip.x2).toBeCloseTo(left + edge, 3);
    }
  });

  test("the key word's ghost rushes in 1.26x and blurred, then hard-cuts to the solid word at 160 ms", () => {
    const hero = cues[1]!.words[1]!;
    const ghost = need<TextPiece>(find(scene, "1:ghost"));
    const solid = need<TextPiece>(find(scene, "1:hero"));
    const g = (t: number) => EASES.out(prog(t, hero.startMs - 80, 240));
    for (const t of [hero.startMs - 40, hero.startMs, hero.startMs + 100]) {
      const pose = evaluatePiece(ghost, t);
      expect(pose.sx).toBeCloseTo(1.26 + (1 - 1.26) * g(t), 3);
      expect(pose.blur).toBeCloseTo(10 * (1 - g(t)), 2);
    }
    expect(ghost.toMs).toBe(hero.startMs + 160);
    expect(solid.fromMs).toBe(hero.startMs + 160);
    expect(evaluatePiece(solid, hero.startMs + 160).sx).toBeCloseTo(1.06, 3);
  });

  test("the cue leaves 140 ms before end - 80 ms: opacity falls and the block rises 24 px", () => {
    const cue = cues[1]!;
    const hero = need<TextPiece>(find(scene, "1:hero"));
    const from = cue.endMs - 80 - 140;
    const rest = evaluatePiece(hero, from - 10).y;
    for (const t of [from + 30, from + 90, from + 135]) {
      const out = EASES.in(prog(t, from, 140));
      expect(evaluatePiece(hero, t).o).toBeCloseTo(1 - out, 3);
      expect(evaluatePiece(hero, t).y).toBeCloseTo(rest - 24 * out, 2);
    }
    expect(hero.toMs).toBe(cue.endMs - 80);
  });
});

describe("Heft with real speech", () => {
  const fast = demoCues({ ...HEFT_DEMO, options: { ...HEFT_DEMO.options, cueGap: 60 } });
  const list = build(fast.cues);

  test("every word is fully visible (opacity above 0.9, inside its clip) for 150 ms after it lands", () => {
    const landed = list.filter((piece) => /:(w\d+r|hero)$/.test(piece.id));
    expect(landed.length).toBeGreaterThan(8);
    for (const piece of landed) {
      for (let t = piece.fromMs; t < piece.fromMs + 150; t += 10) {
        const pose = evaluatePiece(piece, t);
        expect(pose.visible).toBe(true);
        expect(pose.o).toBeGreaterThan(0.9);
        if (pose.clip) expect(pose.clip.x2).toBeGreaterThan(pose.x);
      }
    }
  });

  test("a word that lands late lengthens the cue instead of fading half typed", () => {
    const word = (text: string, startMs: number, endMs: number, role: "hero" | "body" = "body") => ({ text, startMs, endMs, role, key: null });
    const tight: SceneCue[] = [{ index: 0, startMs: 0, endMs: 520, speaker: 0, language: "en", words: [word("quick", 0, 150), word("EXTRAORDINARY", 160, 440, "hero")] }];
    const pieces = build(tight);
    const solid = need<TextPiece>(find(pieces, "0:hero"));
    for (let t = solid.fromMs; t < solid.fromMs + 150; t += 10) expect(evaluatePiece(solid, t).o).toBeGreaterThan(0.9);
    expect(solid.toMs).toBeGreaterThan(520 - 80);
  });

  test("the typing speed never leaves a word unfinished after its own end", () => {
    for (const piece of list) {
      if (!/:w\d+$/.test(piece.id) || piece.kind !== "text") continue;
      const index = Number(piece.id.split(":")[1]);
      const word = fast.cues[index]!.words[Number(piece.id.split(":w")[1])]!;
      expect(piece.toMs).toBeLessThanOrEqual(word.endMs + 1);
    }
  });
});

describe("Heft across a whole clip", () => {
  // The demo repeated: 24 cues, hero and plain cues alternating in the demo's own order.
  const long = (() => {
    const base = demoCues(HEFT_DEMO).cues;
    const span = base[base.length - 1]!.endMs - base[0]!.startMs;
    return Array.from({ length: 6 }, (_, round) =>
      base.map((cue) => ({ ...cue, index: cue.index + round * base.length, startMs: cue.startMs + round * span, endMs: cue.endMs + round * span, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + round * span, endMs: word.endMs + round * span })) })),
    ).flat();
  })();
  const list = build(long);

  test("every key-word cue gets its asterisk, every plain cue its brackets, for all 24 cues", () => {
    long.forEach((cue, at) => {
      const hero = cue.words.some((word) => word.role === "hero");
      expect(find(list, `${at}:star`) !== undefined).toBe(hero);
      expect(find(list, `${at}:brL`) !== undefined && find(list, `${at}:brR`) !== undefined).toBe(!hero);
    });
  });

  test("the decoration varies: the asterisk alternates corner and spin direction, the brackets alternate angle and square", () => {
    const stars = long.map((cue, at) => ({ cue, at })).filter(({ cue }) => cue.words.some((word) => word.role === "hero")).map(({ at }) => need<ShapePiece>(find(list, `${at}:star`)));
    const hero = (at: number) => need<TextPiece>(find(list, `${at}:hero`));
    const sides = stars.map((star) => Math.sign(evaluatePiece(star, star.toMs - 200).x - evaluatePiece(hero(Number(star.id.split(":")[1])), star.toMs - 200).x));
    expect(new Set(sides).size).toBe(2);
    expect(sides.slice(0, 4)).toEqual([sides[0], -sides[0]!, sides[0], -sides[0]!]);
    const spins = stars.map((star) => Math.sign(evaluatePiece(star, star.toMs - 100).rz - evaluatePiece(star, star.toMs - 300).rz));
    expect(new Set(spins).size).toBe(2);
    const shapes = long.map((cue, at) => ({ cue, at })).filter(({ cue }) => !cue.words.some((word) => word.role === "hero")).map(({ at }) => need<ShapePiece>(find(list, `${at}:brL`)).path.length);
    expect(new Set(shapes).size).toBe(2);
  });

  test("a long hold keeps the brackets breathing and the asterisk turning, bounded", () => {
    const word = (text: string, startMs: number, endMs: number, role: "hero" | "body" = "body") => ({ text, startMs, endMs, role, key: null });
    const slow: SceneCue[] = [{ index: 0, startMs: 0, endMs: 6400, speaker: 0, language: "en", words: [word("hold", 0, 300), word("this", 5800, 6100)] }];
    const bracket = need<ShapePiece>(find(build(slow), "0:brR"));
    const xs = Array.from({ length: 60 }, (_, k) => evaluatePiece(bracket, 800 + k * 90).x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(4);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(11);
  });

  test("the seeded hash is deterministic and spreads", () => {
    expect(heftHash("a", 1)).toBe(heftHash("a", 1));
    expect(heftHash("a", 1)).not.toBe(heftHash("a", 2));
    expect(heftHash("a")).toBeGreaterThanOrEqual(0);
    expect(heftHash("a")).toBeLessThan(1);
  });
});

describe("Heft edge cases", () => {
  test("scripts that join or have no letter boundaries are wiped, not typed letter by letter; Latin, Cyrillic and Greek type", () => {
    expect(heftSplitsIntoLetters("hello")).toBe(true);
    expect(heftSplitsIntoLetters("привет")).toBe(true);
    expect(heftSplitsIntoLetters("γειά")).toBe(true);
    expect(heftSplitsIntoLetters("اچھا")).toBe(false);
    expect(heftSplitsIntoLetters("नमस्ते")).toBe(false);
    expect(heftSplitsIntoLetters("你好")).toBe(false);
    const list = build(sceneEdgeDemo("urdu").cues);
    const typing = list.filter((piece): piece is TextPiece => piece.kind === "text" && /:w\d+$/.test(piece.id));
    expect(typing.length).toBeGreaterThan(0);
    // One straight wipe: two frames on the moving edge, not a step per letter.
    for (const piece of typing) {
      const moving = piece.clip!.x1.length > 1 ? piece.clip!.x1 : piece.clip!.x2;
      expect(moving.length).toBe(2);
    }
  });

  test("a right-to-left cue mirrors: rows run right to left and the asterisk sits at the word's left end", () => {
    const list = build(sceneEdgeDemo("urdu").cues);
    const star = need<ShapePiece>(find(list, "0:star"));
    const hero = need<TextPiece>(find(list, "0:hero"));
    expect(evaluatePiece(star, star.toMs - 100).x).toBeLessThan(evaluatePiece(hero, star.toMs - 100).x);
    const lead = ["0:w0", "0:w1"].map((id) => evaluatePiece(need<TextPiece>(find(list, id) ?? find(list, `${id}r`)), 500).x);
    expect(lead[0]).toBeGreaterThan(lead[1]!);
  });

  test("a word wider than the column shrinks the cue's light words; the key word keeps a floor, then fits the safe width", () => {
    const long = build(sceneEdgeDemo("long-word").cues);
    const light = long.filter((piece): piece is TextPiece => piece.kind === "text" && /:w\d+r?$/.test(piece.id) && piece.id.startsWith("heft:1:"));
    expect(Math.min(...light.map((piece) => piece.sizePx))).toBeLessThan(74);
    const hero = need<TextPiece>(find(long, "0:hero"));
    expect(hero.sizePx).toBeLessThanOrEqual(170);
    expect(hero.sizePx).toBeGreaterThanOrEqual(0.4 * 170);
  });

  test("16:9 keeps the words inside the safe area", () => {
    const wide = build(cues, { canvas: { width: 1920, height: 1080 }, anchor: { xPct: 50, yPct: 67 } });
    for (const piece of wide) {
      if (piece.bleed) continue;
      for (let t = piece.fromMs; t < piece.toMs; t += 50) {
        const pose = evaluatePiece(piece, t);
        expect(pose.y).toBeGreaterThan(0.05 * 1080 - 1);
        expect(pose.y).toBeLessThan(0.95 * 1080 + 1);
      }
    }
  });
});
