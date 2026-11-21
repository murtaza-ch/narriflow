import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece } from "./scene";
import { AURA_DEMO, auraCoverage, auraLower, auraProgram, auraSpacesLetters, auraTiming } from "./templates/aura";
import { fakeMeasure, sceneInput } from "./test-support";

const { cues } = demoCues(AURA_DEMO);
const COLOURS = { primary: "#22123C", highlight: "#FF8ADB", accent: "#8B9BFF", shadow: "#000000" };
const build = (list: readonly SceneCue[], overrides = {}) => auraProgram.build(sceneInput(list, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
const scene = build(cues);
const texts = (list: readonly Piece[]) => list.filter((piece): piece is TextPiece => piece.kind === "text");
const orbs = (list: readonly Piece[]) => list.filter((piece): piece is ShapePiece => piece.kind === "shape");
const wordPieces = (list: readonly Piece[], cue: number, word: number) => texts(list).filter((piece) => piece.id.startsWith(`aura:${cue}:w${word}`));
/** The word's opacity at a time: the piece that is on screen then. */
const opacityOf = (list: readonly Piece[], cue: number, word: number, ms: number) => {
  const piece = wordPieces(list, cue, word).find((p) => ms >= p.fromMs && ms < p.toMs);
  return piece ? evaluatePiece(piece, ms).o : 0;
};
const repeat = (count: number): SceneCue[] => {
  const span = cues[cues.length - 1]!.endMs;
  return Array.from({ length: count }, (_, n) => {
    const source = cues[n % cues.length]!;
    const shift = Math.floor(n / cues.length) * span;
    return { ...source, index: n, startMs: source.startMs + shift, endMs: source.endMs + shift, words: source.words.map((word) => ({ ...word, startMs: word.startMs + shift, endMs: word.endMs + shift })) };
  });
};
/** The same words with `gap` ms between a cue's last word and the next cue's first (real speech has about 60); a cue ends where the next starts. */
const withGap = (gap: number): SceneCue[] => {
  const moved: SceneCue[] = [];
  let previousEnd = 0;
  cues.forEach((cue, n) => {
    const shift = n === 0 ? 0 : previousEnd + gap - cue.words[0]!.startMs;
    const words = cue.words.map((word) => ({ ...word, startMs: word.startMs + shift, endMs: word.endMs + shift }));
    previousEnd = words.at(-1)!.endMs;
    moved.push({ ...cue, startMs: words[0]!.startMs, endMs: previousEnd + 650, words });
  });
  return moved.map((cue, n) => ({ ...cue, endMs: moved[n + 1] ? moved[n + 1]!.startMs : cue.endMs }));
};

describe("Aura text", () => {
  test("a hero cue: the hero is Instrument Serif at 210 px, the support words Inter Tight 58 px, all lower case, ink plum", () => {
    const hero = wordPieces(scene, 1, 2).at(-1)!;
    expect(hero.face).toBe("Instrument Serif Regular");
    expect(hero.text).toBe("time");
    expect(hero.sizePx).toBe(210);
    expect(hero.fill).toBe("#22123C");
    const lead = wordPieces(scene, 1, 0).at(-1)!;
    expect(lead.face).toBe("Inter Tight Medium");
    expect(lead.sizePx).toBe(58);
    // The hero sits below its lead row and above nothing (no tail).
    expect(evaluatePiece(hero, 4000).y).toBeGreaterThan(evaluatePiece(lead, 4000).y);
  });

  test("a cue without a hero is two rows of 74 px words by count, 1.22 em apart, centred on the anchor line", () => {
    const first = wordPieces(scene, 0, 0).at(-1)!;
    const third = wordPieces(scene, 0, 3).at(-1)!;
    expect(first.sizePx).toBe(74);
    expect(evaluatePiece(third, 2000).y - evaluatePiece(first, 2000).y).toBeCloseTo(74 * 1.22, 6);
    const middle = (evaluatePiece(first, 2000).y + evaluatePiece(third, 2000).y) / 2;
    // The rows' centre lines straddle y 1290 (the baseline is 0.362 em below a row's centre).
    expect(middle - 0.362 * 74).toBeCloseTo(1290, 4);
  });

  test("a word wider than the safe width shrinks the cue; rows wider than it wrap", () => {
    const long = build(sceneEdgeDemo("long-word").cues);
    for (const piece of texts(long)) expect(piece.sizePx).toBeGreaterThan(8);
    const widest = Math.max(...texts(long).filter((piece) => piece.toMs - piece.fromMs > 600).map((piece) => fakeMeasure(piece.text, piece.face, piece.sizePx, piece.letterSpacingEm).advance));
    expect(widest).toBeLessThanOrEqual(0.9 * 1080 + 0.5);
    const nine = build(sceneEdgeDemo("nine-words").cues);
    const rows = new Set(texts(nine).filter((piece) => piece.id.startsWith("aura:0:")).map((piece) => Math.round(evaluatePiece(piece, 3000).y)));
    expect(rows.size).toBeGreaterThanOrEqual(3);
  });

  test("lower case only for cased scripts; letters are spaced out only where that is harmless", () => {
    expect(auraLower("HELLO", "en")).toBe("hello");
    expect(auraLower("ISTANBUL", "tr")).toBe("ıstanbul");
    expect(auraLower("Привет", "ru")).toBe("привет");
    expect(auraLower("اچھا", "ur")).toBe("اچھا");
    expect(auraLower("今日は", "ja")).toBe("今日は");
    expect(auraSpacesLetters("breathe")).toBe(true);
    expect(auraSpacesLetters("اچھا")).toBe(false);
    expect(auraSpacesLetters("नमस्ते")).toBe(false);
    expect(auraSpacesLetters("今日は")).toBe(false);
    const urdu = texts(build(sceneEdgeDemo("urdu").cues));
    // One piece per word, never stepped letter spacing.
    expect(urdu.every((piece) => piece.letterSpacingEm === -0.008 || piece.letterSpacingEm === -0.012)).toBe(true);
    expect(urdu.filter((piece) => piece.id.startsWith("aura:0:w0")).length).toBe(1);
  });

  test("a word comes into focus: blur 14 to 0, opacity 0 to 1, letter spacing 0.08 em to rest, in 420 ms (out)", () => {
    const pieces = wordPieces(scene, 1, 0);
    expect(pieces.length).toBe(4);
    const start = cues[1]!.words[0]!.startMs - 150;
    expect(evaluatePiece(pieces[0]!, start).o).toBeCloseTo(0, 6);
    expect(evaluatePiece(pieces[0]!, start).blur).toBeCloseTo(14, 6);
    expect(pieces[0]!.letterSpacingEm).toBeGreaterThan(0.04);
    expect(pieces.at(-1)!.letterSpacingEm).toBeCloseTo(-0.008, 9);
    const mid = start + 210;
    const p = 1 - (1 - 0.5) ** 3;
    const at = pieces.find((piece) => mid >= piece.fromMs && mid < piece.toMs)!;
    expect(evaluatePiece(at, mid).o).toBeCloseTo(p, 1);
    expect(evaluatePiece(at, mid).blur).toBeCloseTo(14 * (1 - p), 0);
    expect(evaluatePiece(pieces.at(-1)!, start + 420).o).toBeCloseTo(1, 6);
    expect(evaluatePiece(pieces.at(-1)!, start + 420).blur).toBeCloseTo(0, 6);
  });
});

describe("Aura real speech", () => {
  test("with 60 ms between cues every word is fully visible for 150 ms after it lands", () => {
    const fast = withGap(60);
    const list = build(fast);
    fast.forEach((cue, c) => {
      const timing = auraTiming(cue, cue.words.map((_, k) => k));
      cue.words.forEach((_, k) => {
        const lands = timing.from[k]! + timing.focus[k]!;
        for (let ms = lands + 1; ms <= lands + 150; ms += 5) expect(opacityOf(list, c, k, ms)).toBeGreaterThan(0.9);
      });
      expect(timing.exitFrom).toBeGreaterThanOrEqual(Math.max(...cue.words.map((_, k) => timing.from[k]! + timing.focus[k]!)) + 150);
    });
  });

  test("a short last word gets a shorter focus (never under 150 ms) instead of an early exit", () => {
    const fast = withGap(60);
    const last = fast[0]!;
    const timing = auraTiming(last, last.words.map((_, k) => k));
    expect(timing.focus.at(-1)!).toBeLessThan(420);
    expect(timing.focus.at(-1)!).toBeGreaterThanOrEqual(150);
    expect(timing.focus[0]!).toBe(420);
  });
});

describe("Aura orbs", () => {
  test("three orbs per stretch of speech, under every cue, bleeding past the safe area on purpose", () => {
    const list = orbs(scene);
    expect(list.map((piece) => piece.id)).toEqual(["aura:orb0:0", "aura:orb0:1", "aura:orb0:2"]);
    expect(list.every((piece) => piece.bleed === true && piece.z < Math.min(...texts(scene).map((t) => t.z)))).toBe(true);
    expect(list.map((piece) => piece.fill?.colour)).toEqual(["#FF8ADB", "#8B9BFF", "#FFC27A"]);
    expect(list.map((piece) => piece.track.blur![0]![1])).toEqual([25, 25, 25]);
  });

  test("they fade and grow in 200 ms before the first word and leave with the last cue", () => {
    const orb = orbs(scene)[0]!;
    expect(orb.fromMs).toBe(cues[0]!.startMs - 200);
    expect(evaluatePiece(orb, orb.fromMs).o).toBeCloseTo(0, 6);
    expect(evaluatePiece(orb, orb.fromMs + 400).o).toBeCloseTo(1, 6);
    expect(evaluatePiece(orb, orb.toMs).o).toBeCloseTo(0, 6);
    expect(orb.toMs).toBe(cues[cues.length - 1]!.endMs - 200 + 380);
  });

  test("the hero draws the orbs together behind it and warms the biggest one toward peach", () => {
    const [a, b] = orbs(scene);
    const hero = cues[1]!.words[2]!;
    const at = (piece: ShapePiece, ms: number) => evaluatePiece(piece, ms);
    const spread = (ms: number) => Math.abs(at(a!, ms).x - at(b!, ms).x) + Math.abs(at(a!, ms).y - at(b!, ms).y);
    expect(spread(hero.startMs + 200)).toBeLessThan(spread(hero.startMs - 600));
    expect(at(a!, hero.startMs - 10).colour).toBe("#FF8ADB");
    expect(at(a!, hero.endMs).colour).not.toBe("#FF8ADB");
  });

  test("no jump at a cue change: no orb ever moves more than 8 px between two milliseconds", () => {
    for (const piece of orbs(build(repeat(24)))) {
      let previous = evaluatePiece(piece, piece.fromMs);
      for (let ms = piece.fromMs + 1; ms < piece.toMs; ms += 2) {
        const now = evaluatePiece(piece, ms);
        expect(Math.hypot(now.x - previous.x, now.y - previous.y)).toBeLessThan(8);
        previous = now;
      }
    }
  });

  test("every word sits on the orbs' lit cores, in the demo, nine words and a 16:9 frame", () => {
    const check = (list: readonly Piece[], width: number) => {
      const discs = orbs(list);
      for (const word of texts(list)) {
        const ms = word.toMs - 30 - 160;
        const pose = evaluatePiece(word, ms);
        if (!pose.visible) continue;
        const m = fakeMeasure(word.text, word.face, word.sizePx, word.letterSpacingEm);
        const lit = auraCoverage(
          discs.map((disc) => {
            const p = evaluatePiece(disc, ms);
            return { x: p.x, y: p.y, r: 240 * p.sx };
          }),
          25,
          pose.x,
          pose.y - 0.3 * word.sizePx,
        );
        expect(lit).toBeGreaterThan(0.7);
        expect(m.advance).toBeLessThan(0.9 * width + 1);
      }
    };
    check(scene, 1080);
    check(build(sceneEdgeDemo("nine-words").cues), 1080);
    check(build(cues, { canvas: { width: 1920, height: 1080 } }), 1920);
  });

  test("a long clip keeps the orbs moving: the layout changes on every cue and cycles through three arrangements", () => {
    const long = build(repeat(24));
    const piece = orbs(long)[0]!;
    // The orb's resting x, read just before each cue's first word (the move began 250 ms earlier and takes 750).
    const rests = repeat(24).map((cue) => evaluatePiece(piece, cue.startMs + 500).x);
    for (let n = 1; n < rests.length; n++) expect(Math.abs(rests[n]! - rests[n - 1]!)).toBeGreaterThan(5);
    const side = (n: number) => Math.sign(rests[n]! - 540);
    expect(new Set(rests.map((_, n) => side(n))).size).toBeGreaterThan(1);
    // Every cue past the demo's four still has text and was built without a cue index table.
    expect(texts(long).filter((t) => t.id.startsWith("aura:23:")).length).toBeGreaterThan(0);
    expect(new Set(orbs(long).map((o) => o.id.split(":")[1])).size).toBe(1);
  });

  test("a silence longer than 600 ms between cues ends the orbs and a new group starts them again", () => {
    const apart = repeat(2).map((cue, n) => (n === 1 ? { ...cue, startMs: cue.startMs + 20000, endMs: cue.endMs + 20000, words: cue.words.map((w) => ({ ...w, startMs: w.startMs + 20000, endMs: w.endMs + 20000 })) } : cue));
    apart[0] = { ...apart[0]!, endMs: apart[0]!.words.at(-1)!.endMs + 650 };
    const ids = orbs(build(apart)).map((piece) => piece.id);
    expect(ids).toEqual(["aura:orb0:0", "aura:orb0:1", "aura:orb0:2", "aura:orb1:0", "aura:orb1:1", "aura:orb1:2"]);
  });
});
