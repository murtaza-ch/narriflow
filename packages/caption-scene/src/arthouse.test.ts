import { describe, expect, test } from "bun:test";
import { demoCues, parseDemoScript, sceneEdgeDemo } from "./demo";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { ARTHOUSE_DEMO, arthouseHash, arthouseProgram, arthouseSize } from "./templates/arthouse";
import { fakeMeasure, sceneInput } from "./test-support";

const COLOURS = { primary: "#FFFFFF", highlight: "#FF2B2B", accent: "#D9FF2E", shadow: "#000000" };
const build = (list: readonly SceneCue[], overrides = {}) =>
  arthouseProgram.build(sceneInput(list, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
const { cues } = demoCues(ARTHOUSE_DEMO);
const scene = build(cues);
const find = (list: readonly Piece[], id: string) => list.find((piece) => piece.id === `arthouse:${id}`);
const need = <T extends Piece>(piece: Piece | undefined) => {
  expect(piece).toBeDefined();
  return piece as T;
};

describe("Arthouse geometry", () => {
  test("size comes from the cue's characters: 196 to 16, 168 to 24, 148 above", () => {
    expect(arthouseSize(16)).toBe(196);
    expect(arthouseSize(17)).toBe(168);
    expect(arthouseSize(24)).toBe(168);
    expect(arthouseSize(25)).toBe(148);
    // "do it anyway" is 12 characters with spaces: 196. "the first year is chaos" is 24: 168 (hero at 1.08x).
    expect(need<TextPiece>(find(scene, "2:w0")).sizePx).toBe(196);
    // The fake face is wider than the real one, so this cue is fitted to its row: the hero stays 1.08x the caps.
    const caps = need<TextPiece>(find(scene, "1:w1"));
    expect(caps.sizePx).toBeLessThanOrEqual(168);
    expect(need<TextPiece>(find(scene, "1:w4")).sizePx).toBeCloseTo(caps.sizePx * 1.08, 6);
  });

  test("caps are upper-case Big Shoulders, the key word a red Shrikhand with its own tilt, over the caps", () => {
    const caps = need<TextPiece>(find(scene, "1:w1"));
    const hero = need<TextPiece>(find(scene, "1:w4"));
    expect(caps.text).toBe("FIRST");
    expect(caps.face).toBe("Big Shoulders Display Black");
    expect(hero.text).toBe("chaos");
    expect(hero.face).toBe("Shrikhand");
    expect(hero.fill).toBe("#FF2B2B");
    expect(hero.z).toBeGreaterThan(caps.z);
    // Settled on its landing it is tilted a little further than the card: card -9..-14 degrees plus its own -2..-5.
    const t = hero.fromMs + 1200;
    expect(evaluatePiece(hero, t).rz).toBeLessThan(evaluatePiece(caps, t).rz - 1);
  });

  test("words pivot about 70 % of their line box: the pivot sits below the baseline by the rest of the box", () => {
    const word = need<TextPiece>(find(scene, "2:w0"));
    // Line box 0.86 em, baseline 0.811 em in it, pivot 0.7 * 0.86 em = 0.602 em: 0.209 em above the baseline.
    expect(word.origin!.dy).toBeCloseTo(0.602 * 196 - 0.811 * 196, 3);
  });

  test("a red rule sits under the last row and wipes in with that row's first word", () => {
    const rule = need<ShapePiece>(find(scene, "2:rule"));
    expect(rule.fill!.colour).toBe("#FF2B2B");
    const last = cues[2]!.words[0]!;
    expect(rule.fromMs).toBeGreaterThanOrEqual(last.startMs - 60);
    const mid = evaluatePiece(rule, rule.fromMs + 100);
    const rest = evaluatePiece(rule, rule.fromMs + 700);
    expect(mid.sx).toBeLessThan(rest.sx);
    expect(rest.sx).toBeCloseTo(1, 0);
    const word = evaluatePiece(need<TextPiece>(find(scene, "2:w2")), rule.fromMs + 700);
    expect(rest.y).toBeGreaterThan(word.y);
  });
});

describe("Arthouse motion", () => {
  test("the card swings in from flat: the first cue's words are squeezed and shear, then settle on the card's tilt", () => {
    const word = need<TextPiece>(find(scene, "0:w0"));
    const early = evaluatePiece(word, word.fromMs + 30);
    const rest = evaluatePiece(word, word.fromMs + 900);
    // The swing starts at scale 0.72 about the card's centre: the word starts nearer the centre and a smaller.
    expect(early.sx).toBeLessThan(rest.sx);
    expect(Math.abs(early.ry)).toBeGreaterThan(0.5);
    expect(Math.abs(rest.ry)).toBeLessThan(0.01);
    // After the swing the card is tilted -9 to -14 degrees and the words carry it.
    expect(rest.rz).toBeLessThan(-6);
    expect(rest.rz).toBeGreaterThan(-16);
    expect(rest.sx).toBeCloseTo(1, 1);
  });

  test("each word is acid yellow while it is said and white 320 ms after it ends", () => {
    const cue = cues[0]!;
    const word = need<TextPiece>(find(scene, "0:w2"));
    const spoken = cue.words[2]!;
    expect(evaluatePiece(word, spoken.startMs).colour).toBe("#D9FF2E");
    expect(evaluatePiece(word, spoken.endMs + 40).colour).toBe("#D9FF2E");
    expect(evaluatePiece(word, spoken.endMs + 340).colour).toBe("#FFFFFF");
  });

  test("a word lands from 1.18x and the key word from 1.5x, fading in over 70 ms", () => {
    const word = need<TextPiece>(find(scene, "1:w1"));
    const hero = need<TextPiece>(find(scene, "1:w4"));
    const at = (piece: TextPiece, ms: number) => evaluatePiece(piece, ms);
    expect(at(word, word.fromMs + 2).o).toBeLessThan(0.1);
    expect(at(word, word.fromMs + 80).o).toBeGreaterThan(0.95);
    const settledWord = at(word, word.fromMs + 600);
    expect(at(word, word.fromMs + 10).sx / settledWord.sx).toBeGreaterThan(1.1);
    const settledHero = at(hero, hero.fromMs + 1000);
    expect(at(hero, hero.fromMs + 10).sx / settledHero.sx).toBeGreaterThan(1.35);
  });

  test("the colour fringe is two copies (cyan and magenta) that are wide at the swing and arrival and gone at rest", () => {
    const fringes = scene.filter((piece) => piece.id.startsWith("arthouse:0:f0"));
    expect(fringes.length).toBeGreaterThanOrEqual(4);
    const colours = new Set(fringes.map((piece) => (piece as TextPiece).fill));
    expect(colours).toEqual(new Set(["#00E5FF", "#FF2BD6"]));
    const early = fringes.find((piece) => piece.id.endsWith("0a"))!;
    expect(evaluatePiece(early, early.fromMs + 20).o).toBeGreaterThan(0.1);
    expect(early.toMs).toBeLessThan(cues[0]!.startMs + 1000);
    // The exit brings it back (the card leaves in colour).
    const exits = fringes.filter((piece) => piece.id.endsWith("b"));
    expect(exits.length).toBeGreaterThan(0);
  });

  test("the card drifts 12 px right and 6 px up over the cue, and swings out 140 ms before the cue ends", () => {
    const cue = cues[0]!;
    const word = need<TextPiece>(find(scene, "0:w2"));
    const a = evaluatePiece(word, cue.startMs + 600);
    const b = evaluatePiece(word, cue.startMs + 900);
    expect(b.x).toBeGreaterThan(a.x);
    expect(b.y).toBeLessThan(a.y);
    expect(word.toMs).toBe(cue.endMs - 80);
    const before = evaluatePiece(word, word.toMs - 150);
    const after = evaluatePiece(word, word.toMs - 5);
    expect(before.o).toBeGreaterThan(0.99);
    expect(after.o).toBeLessThan(0.15);
    expect(after.x - before.x).toBeGreaterThan(20);
  });
});

describe("Arthouse across a whole clip", () => {
  const long = (n: number, gap = 160) => {
    const lines = Array.from({ length: n }, (_, at) => (at % 3 === 1 ? "so:m this:b matters:h@500 most:b" : at % 3 === 2 ? "that's:m where:b it:m all:m gets:b built" : "Nobody:b tells:b you:m this"));
    return demoCues({ lines, options: { rate: 290, cueGap: gap, tail: 800, lead: 350 } }).cues;
  };

  test("every cue of a 24-cue clip keeps its rule, fringe, words and drift (no cue-indexed tables)", () => {
    const list = build(long(24));
    for (let n = 0; n < 24; n++) {
      expect(find(list, `${n}:rule`)).toBeDefined();
      expect(list.filter((piece) => piece.id.startsWith(`arthouse:${n}:f`)).length).toBeGreaterThanOrEqual(4);
      expect(list.filter((piece) => /^arthouse:\d+:w\d+$/.test(piece.id) && piece.id.split(":")[1] === String(n)).length).toBeGreaterThanOrEqual(4);
    }
    const last = need<TextPiece>(find(list, "23:w1"));
    const a = evaluatePiece(last, last.fromMs + 900);
    const b = evaluatePiece(last, last.fromMs + 1100);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(0.5);
  });

  test("the look varies cue to cue: swing side, tilt, rule width and place, hero tilt", () => {
    const list = build(long(24));
    const words = list.filter((piece): piece is TextPiece => piece.kind === "text" && /^arthouse:\d+:w1$/.test(piece.id));
    const sides = new Set(words.map((piece) => Math.sign(evaluatePiece(piece, piece.fromMs + 60).ry)));
    expect(sides).toEqual(new Set([1, -1]));
    const tilts = new Set(words.map((piece) => Math.round(evaluatePiece(piece, piece.fromMs + 700).rz)));
    expect(tilts.size).toBeGreaterThanOrEqual(5);
    const rules = list.filter((piece): piece is ShapePiece => piece.id.endsWith(":rule"));
    const widths = new Set(rules.map((piece) => Math.round(Math.max(...piece.path.flatMap((cmd) => (cmd[0] === "Z" ? [] : [cmd[1] as number]))))));
    expect(widths.size).toBeGreaterThanOrEqual(5);
    const places = new Set(rules.map((piece) => Math.round(evaluatePiece(piece, piece.fromMs + 700).x / 20)));
    expect(places.size).toBeGreaterThanOrEqual(3);
  });

  test("the hash is deterministic and spreads", () => {
    expect(arthouseHash(3, "so keep going")).toBe(arthouseHash(3, "so keep going"));
    expect(arthouseHash(3, "so keep going")).not.toBe(arthouseHash(4, "so keep going"));
    expect(arthouseHash(3, "a")).not.toBe(arthouseHash(3, "b"));
  });

  test("fast speech (60 ms between cues): every word is fully visible for 150 ms after it lands", () => {
    const fast = long(9, 60);
    const list = build(fast);
    for (const cue of fast) {
      cue.words.forEach((word, at) => {
        const piece = need<TextPiece>(find(list, `${cue.index}:w${at}`));
        const land = word.startMs - 60 + 70;
        for (let t = land + 2; t <= land + 150; t += 8) {
          const pose = evaluatePiece(piece, t);
          expect(pose.visible).toBe(true);
          expect(pose.o).toBeGreaterThan(0.9);
        }
      });
    }
  });

  test("the exit leaves no later than 60 ms into the next cue, even when it waited for a late word", () => {
    const tight: SceneCue[] = [
      { index: 0, startMs: 0, endMs: 600, speaker: 0, language: "en", words: [{ text: "go", startMs: 0, endMs: 200, role: "body", key: null }, { text: "late", startMs: 300, endMs: 580, role: "body", key: null }] },
    ];
    const late = need<TextPiece>(find(build(tight), "0:w1"));
    expect(evaluatePiece(late, 300 - 60 + 70 + 100).o).toBeGreaterThan(0.99);
    expect(late.toMs).toBeLessThanOrEqual(600 + 60);
  });
});

describe("Arthouse in other languages and frames", () => {
  test("a right-to-left cue runs right to left; letters stay whole and unspaced", () => {
    const list = build(sceneEdgeDemo("urdu").cues);
    const words = list.filter((piece): piece is TextPiece => piece.kind === "text" && /^arthouse:0:w\d$/.test(piece.id)).sort((a, b) => Number(a.id.slice(-1)) - Number(b.id.slice(-1)));
    expect(words.every((piece) => piece.letterSpacingEm === 0)).toBe(true);
    expect(words.map((piece) => piece.text)).toEqual(sceneEdgeDemo("urdu").cues[0]!.words.map((word) => word.text));
    const t = words[0]!.fromMs + 1500;
    // The first word of the cue is on the right of the second in the same row.
    expect(evaluatePiece(words[0]!, t).x).toBeGreaterThan(evaluatePiece(words[1]!, t).x);
  });

  test("cased scripts are upper-cased, others keep their letters", () => {
    const one = (text: string): SceneCue[] => [{ index: 0, startMs: 0, endMs: 1500, speaker: 0, language: null, words: [{ text, startMs: 0, endMs: 500, role: "body", key: null }] }];
    expect(need<TextPiece>(find(build(one("hello")), "0:w0")).text).toBe("HELLO");
    expect(need<TextPiece>(find(build(one("привет")), "0:w0")).text).toBe("ПРИВЕТ");
    expect(need<TextPiece>(find(build(one("你好")), "0:w0")).text).toBe("你好");
  });

  test("a long word shrinks the cue to fit; the edge demos and a 16:9 frame stay in the safe area", () => {
    const long = build(sceneEdgeDemo("long-word").cues);
    const sizes = long.filter((piece): piece is TextPiece => piece.kind === "text" && /:w\d$/.test(piece.id)).map((piece) => piece.sizePx);
    expect(Math.min(...sizes)).toBeLessThan(120);
    for (const kind of ["one-word", "nine-words", "long-word", "no-hero", "urdu"] as const) {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }, { width: 1080, height: 1080 }]) {
        const list = build(sceneEdgeDemo(kind).cues, { canvas, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } });
        for (let t = 0; t < 4000; t += 40) {
          const box = sceneBoundsAt(list, t, fakeMeasure);
          if (!box) continue;
          expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
          expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
          expect(box.y1).toBeGreaterThanOrEqual(0.05 * canvas.height - 1);
          expect(box.y2).toBeLessThanOrEqual(0.95 * canvas.height + 1);
        }
      }
    }
  });

  test("the demo parser still gives the sample's cues", () => {
    expect(parseDemoScript(ARTHOUSE_DEMO.lines, ARTHOUSE_DEMO.options).cues.map((cue) => cue.words.length)).toEqual([5, 5, 3, 3]);
  });
});
