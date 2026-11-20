import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece, mixColour } from "./scene";
import { FLAP_DEMO, flapProgram } from "./templates/flap";
import { fakeMeasure, sceneInput } from "./test-support";

const { cues } = demoCues(FLAP_DEMO);
const COLOURS = { primary: "#F4F1E6", highlight: "#FFB000", accent: "#16181C", shadow: "#000000" };
const build = (list: readonly SceneCue[], overrides = {}) => flapProgram.build(sceneInput(list, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
const scene = build(cues);

const partOf = (piece: Piece) => piece.id.split(":")[3]!;
const cardOf = (piece: Piece) => piece.id.split(":")[2]!;
const find = (list: readonly Piece[], cue: number, word: number, part: string) => list.find((piece) => piece.id === `flap:${cue}:c${word}:${part}`);
const need = <T extends Piece>(piece: Piece | undefined) => {
  expect(piece).toBeDefined();
  return piece as T;
};
const alive = (piece: Piece, t: number) => t >= piece.fromMs && t < piece.toMs;

// Cue 2 of the demo is "for only $340 return"; $340 is its hero.
const HERO_CUE = 2;
const BODY = 92;
const HERO = 156;
const cardWidth = (text: string, size: number) => Math.round(fakeMeasure(text.toUpperCase(), "Oswald", size, 0.02).advance + 0.02 * size + 0.46 * size);
const cardHeight = (size: number) => Math.round(0.72 * size * 1.62);

describe("Flap geometry", () => {
  test("a card is its word plus 0.46 em wide and 1.62 cap heights tall; the hero is the bigger card", () => {
    const row = (word: number, size: number) => {
      const card = need<ShapePiece>(find(scene, HERO_CUE, word, "card"));
      const x = card.path.filter((c) => c[0] !== "Z").map((c) => c[1] as number);
      const y = card.path.filter((c) => c[0] !== "Z").map((c) => c[c.length - 1] as number);
      return { width: Math.max(...x) - Math.min(...x), height: Math.max(...y) - Math.min(...y), size };
    };
    const only = row(1, BODY);
    const hero = row(2, HERO);
    expect(only.width).toBeCloseTo(cardWidth("only", BODY), 6);
    expect(only.height).toBeCloseTo(cardHeight(BODY), 6);
    expect(hero.width).toBeCloseTo(cardWidth("$340", HERO), 6);
    expect(hero.height).toBeCloseTo(cardHeight(HERO), 6);
    expect(hero.height).toBeGreaterThan(only.height * 1.6);
  });

  test("the lead, the hero and the tail are their own centred rows with a 10 px gap, the block centred on the anchor line", () => {
    const at = (word: number) => {
      const card = need<ShapePiece>(find(scene, HERO_CUE, word, "card"));
      return { x: evaluatePiece(card, 4600).x, y: evaluatePiece(card, 4600).y };
    };
    const lead = { for: at(0), only: at(1) };
    const hero = at(2);
    const tail = at(3);
    // The two lead cards share a row, centred about x 540 with 10 px between them.
    expect(lead.for.y).toBeCloseTo(lead.only.y, 6);
    const gap = lead.only.x - cardWidth("only", BODY) / 2 - (lead.for.x + cardWidth("for", BODY) / 2);
    expect(gap).toBeCloseTo(10, 6);
    expect((lead.for.x - cardWidth("for", BODY) / 2 + lead.only.x + cardWidth("only", BODY) / 2) / 2).toBeCloseTo(540, 6);
    expect(hero.x).toBeCloseTo(540, 6);
    expect(tail.x).toBeCloseTo(540, 6);
    // Rows stack with a 10 px gap (centres are on the split lines): lead, hero, tail.
    expect(hero.y - lead.for.y).toBeCloseTo(cardHeight(BODY) / 2 + 10 + cardHeight(HERO) / 2, 6);
    expect(tail.y - hero.y).toBeCloseTo(cardHeight(HERO) / 2 + 10 + cardHeight(BODY) / 2, 6);
    // And the whole block's middle is the anchor line.
    const top = lead.for.y - cardHeight(BODY) / 2;
    const bottom = tail.y + cardHeight(BODY) / 2;
    expect((top + bottom) / 2).toBeCloseTo(1290, 6);
  });

  test("caps are centred on the split line: the baseline sits half a cap height below it", () => {
    const top = need<TextPiece>(find(scene, 0, 0, "top"));
    const card = need<ShapePiece>(find(scene, 0, 0, "card"));
    const splitY = evaluatePiece(card, 1000).y;
    expect(evaluatePiece(top, 1000).y).toBeCloseTo(splitY + (0.72 * BODY) / 2, 6);
    expect(top.text).toBe("I");
    expect(need<TextPiece>(find(scene, 0, 1, "top")).text).toBe("BOOKED");
    expect(top).toMatchObject({ face: "Oswald", sizePx: BODY, letterSpacingEm: 0.02, fill: "#F4F1E6" });
  });

  test("each half is the word clipped to its half; the split line sits between them", () => {
    const top = need<TextPiece>(find(scene, 0, 1, "top"));
    const bottom = need<TextPiece>(find(scene, 0, 1, "bottom"));
    const card = need<ShapePiece>(find(scene, 0, 1, "card"));
    const splitY = evaluatePiece(card, 1000).y;
    const a = evaluatePiece(top, 1000).clip!;
    const b = evaluatePiece(bottom, 1500).clip!;
    expect(a.y2).toBeCloseTo(splitY, 6);
    expect(b.y1).toBeCloseTo(splitY, 6);
    expect(a.y2 - a.y1).toBeCloseTo(cardHeight(BODY) / 2, 6);
    expect(b.y2 - b.y1).toBeCloseTo(cardHeight(BODY) / 2, 6);
    expect(a.x2 - a.x1).toBeCloseTo(cardWidth("booked", BODY), 6);
  });

  test("a card has a blurred shadow strip under its bottom edge, and the hero's face is the highlight colour", () => {
    const body = need<ShapePiece>(find(scene, 0, 0, "card"));
    const hero = need<ShapePiece>(find(scene, HERO_CUE, 2, "card"));
    const shadow = need<ShapePiece>(find(scene, 0, 0, "shadow"));
    expect(shadow.z).toBeLessThan(body.z);
    expect(shadow.fill).toEqual({ colour: "#000000", alpha: 0.6 });
    expect(evaluatePiece(shadow, 1000).blur).toBe(5);
    // It sits under the card's lower edge: its bottom is past the card's.
    const bottom = Math.max(...shadow.path.filter((c) => c[0] !== "Z").map((c) => c[c.length - 1] as number));
    expect(bottom).toBeGreaterThan(cardHeight(BODY) / 2);
    expect(need<ShapePiece>(find(scene, 0, 0, "lower")).fill!.colour).toBe("#16181C");
    expect(need<ShapePiece>(find(scene, HERO_CUE, 2, "lower")).fill!.colour).toBe("#FFB000");
    expect(hero.fill!.colour).not.toBe(body.fill!.colour);
  });
});

describe("Flap motion", () => {
  const word = cues[0]!.words[1]!; // "booked"
  const s = word.startMs - 70;
  const flap = need<ShapePiece>(find(scene, 0, 1, "flap-word"));
  const flapText = need<TextPiece>(find(scene, 0, 1, "flap-text"));

  test("the flap swings down over 220 ms, out-eased, with the sample's own foreshortening", () => {
    expect(flap.fromMs).toBe(s);
    expect(flap.toMs).toBe(s + 220);
    // Under perspective(1100px) the sample's flap (half height d, angle a) draws its far edge at
    // d cos(a) / (1 - d sin(a) / 1100) of height and 1 / (1 - d sin(a) / 1100) of width; ours is the same through a 326 px camera.
    const half = cardHeight(BODY) / 2;
    const project = (sy: number, rxDeg: number) => {
      const rx = (rxDeg * Math.PI) / 180;
      const depth = half * sy * Math.sin(rx);
      const factor = 326 / (326 - depth);
      return { height: half * sy * Math.cos(rx) * factor, width: factor };
    };
    for (const t of [s, s + 20, s + 55, s + 110, s + 165, s + 215]) {
      const a = (Math.PI / 2) * (1 - EASES.out(prog(t, s, 220)));
      const factor = 1 / (1 - (half * Math.sin(a)) / 1100);
      const pose = evaluatePiece(flap, t);
      const mine = project(pose.sy, pose.rx);
      expect(Math.abs(mine.height - half * Math.cos(a) * factor)).toBeLessThan(0.4);
      expect(Math.abs(mine.width - factor)).toBeLessThan(0.002);
      const text = evaluatePiece(flapText, t);
      expect(Math.abs(text.sy - pose.sy)).toBeLessThan(0.006);
      expect(Math.abs(text.rx - pose.rx)).toBeLessThan(0.3);
    }
    // It starts edge-on and lands flat.
    expect(evaluatePiece(flap, s).rx).toBeCloseTo(90, 3);
    expect(evaluatePiece(flap, s + 219).rx).toBeLessThan(0.5);
    expect(evaluatePiece(flap, s + 219).sy).toBeCloseTo(1, 2);
  });

  test("the falling flap is lit and settles to the face colour; the half under it darkens and recovers", () => {
    const flash = evaluatePiece(flap, s).colour;
    expect(flash).toBe(mixColour("#16181C", "#FFFFFF", 0.165));
    expect(evaluatePiece(flap, s + 0.8 * 220).colour).toBe("#16181C");
    const bottom = need<ShapePiece>(find(scene, 0, 1, "lower"));
    expect(evaluatePiece(bottom, s - 50).colour).toBe("#16181C");
    const dark = evaluatePiece(bottom, s + 220 / 1.1 / 2).colour;
    expect(dark).toBe(mixColour("#16181C", "#000000", 0.35));
    expect(evaluatePiece(bottom, s + 220).colour).toBe("#16181C");
  });

  test("the top half shows the word at once, the bottom half once the flap has landed", () => {
    const top = need<TextPiece>(find(scene, 0, 1, "top"));
    const bottom = need<TextPiece>(find(scene, 0, 1, "bottom"));
    expect(alive(top, s - 1)).toBe(false);
    expect(alive(top, s)).toBe(true);
    expect(alive(bottom, s + 219)).toBe(false);
    expect(alive(bottom, s + 220)).toBe(true);
    expect(alive(flapText, s + 100)).toBe(true);
    expect(alive(flapText, s + 220)).toBe(false);
  });

  test("the hero clatters twice: a blank flap 150 ms before its word, then the word", () => {
    const hero = cues[HERO_CUE]!.words[2]!;
    const start = hero.startMs - 70;
    const blank = need<ShapePiece>(find(scene, HERO_CUE, 2, "flap-blank"));
    const wordFlap = need<ShapePiece>(find(scene, HERO_CUE, 2, "flap-word"));
    expect(blank.fromMs).toBe(start - 150);
    expect(blank.toMs).toBe(start - 20);
    expect(wordFlap.fromMs).toBe(start);
    expect(wordFlap.toMs).toBe(start + 220);
    expect(find(scene, HERO_CUE, 2, "flap-text")).toBeDefined();
    // The blank flap is the hero's amber, lit.
    expect(evaluatePiece(blank, blank.fromMs).colour).toBe(mixColour("#FFB000", "#FFFFFF", 0.43));
    // A body card has no blank clatter.
    expect(find(scene, HERO_CUE, 1, "flap-blank")).toBeUndefined();
    expect(find(scene, HERO_CUE, 1, "flap-text")).toBeDefined();
  });

  test("the board settles in over 110 ms: 0.96 to 1 about its centre while it fades in", () => {
    const card = need<ShapePiece>(find(scene, 0, 1, "card"));
    const light = need<ShapePiece>(find(scene, 0, 1, "light"));
    const from = card.fromMs;
    // It enters 110 ms before its first flap.
    expect(from).toBe(cues[0]!.words[0]!.startMs - 70 - 110);
    expect(evaluatePiece(card, from).sx).toBeCloseTo(0.96, 6);
    expect(evaluatePiece(card, from).o).toBe(0);
    expect(evaluatePiece(card, from + 110).sx).toBeCloseTo(1, 6);
    expect(evaluatePiece(card, from + 110).o).toBe(1);
    expect(evaluatePiece(card, from + 55).sx).toBeCloseTo(0.96 + 0.04 * EASES.outExpo(0.5), 6);
    expect(evaluatePiece(card, from + 55).o).toBe(1);
    expect(evaluatePiece(light, from + 200).sx).toBe(1);
    // About the board's centre: a card left of it starts nearer to it.
    const rest = evaluatePiece(card, from + 110).x;
    expect(evaluatePiece(card, from).x - 540).toBeCloseTo(0.96 * (rest - 540), 6);
  });

  test("the cards flip back to blank one after another, 25 ms apart, inside the board's last 180 ms", () => {
    // Cue 0 has five cards; the next board enters at its own boardIn.
    const next = find(scene, 1, 0, "card")!.fromMs;
    const tops = cues[0]!.words.map((_, at) => need<TextPiece>(find(scene, 0, at, "top")));
    const ends = tops.map((piece) => piece.toMs);
    // 80 / (n - 1) for five cards is 20 ms (the 25 ms cap applies to short cues).
    for (let at = 1; at < ends.length; at++) expect(ends[at]! - ends[at - 1]!).toBeCloseTo(20, 6);
    expect(ends[0]).toBe(next - 180);
    // The bottom half stays until a blank flap has fallen over it, 80 ms.
    const bottoms = cues[0]!.words.map((_, at) => need<TextPiece>(find(scene, 0, at, "bottom")));
    for (const [at, piece] of bottoms.entries()) expect(piece.toMs).toBe(ends[at]! + 80);
    const blank = need<ShapePiece>(find(scene, 0, 0, "flap-exit"));
    expect(blank.fromMs).toBe(ends[0]!);
    expect(blank.toMs).toBe(ends[0]! + 80);
    // Short cues cap the stagger at 25 ms.
    const two = build(demoCues({ lines: ["a:b b:b", "c:b"], options: { cueGap: 2000 } }).cues);
    const [first, second] = [need<TextPiece>(find(two, 0, 0, "top")), need<TextPiece>(find(two, 0, 1, "top"))];
    expect(second.toMs - first.toMs).toBe(25);
  });

  test("fast speech: every word lands and is read before its board leaves; the next board waits", () => {
    // Real speech leaves no gap between cues: the next board would enter 180 ms before its first word, inside the last word's flap.
    const tight = demoCues({ lines: ["a:b b:b@200", "c:b d:b"], options: { cueGap: 0, lead: 400 } }).cues;
    const list = build(tight);
    const last = tight[0]!.words[1]!;
    const landed = last.startMs - 70 + 220;
    const boardEnd = find(list, 0, 1, "card")!.toMs;
    expect(tight[1]!.words[0]!.startMs - 70 - 110).toBeLessThan(landed);
    // The board stays until the last word has landed and been read for 150 ms; the next board enters as it leaves.
    expect(boardEnd).toBe(landed + 150);
    expect(find(list, 1, 0, "card")!.fromMs).toBe(boardEnd);
    // The word's flap runs whole and its halves hold until the board cuts: there is no room to flip back.
    expect(need<ShapePiece>(find(list, 0, 1, "flap-word")).toMs).toBe(landed);
    expect(need<TextPiece>(find(list, 0, 1, "top")).toMs).toBe(boardEnd);
    expect(need<TextPiece>(find(list, 0, 1, "bottom"))).toMatchObject({ fromMs: landed, toMs: boardEnd });
    expect(find(list, 0, 1, "flap-exit")).toBeUndefined();
    // No card flips back when the last one cannot: the first card holds its word too.
    expect(find(list, 0, 0, "flap-exit")).toBeUndefined();
    expect(need<TextPiece>(find(list, 0, 0, "top")).toMs).toBe(boardEnd);
    // The next board's first word, already due, flaps as its board appears.
    expect(need<ShapePiece>(find(list, 1, 0, "flap-word")).fromMs).toBe(boardEnd);
  });

  test("fast speech: a late hero first on its board drops its blank clatter rather than its word's timing", () => {
    const tight = demoCues({ lines: ["a:b b:b@200", "c:h d:b"], options: { cueGap: 0, lead: 400 } }).cues;
    const list = build(tight);
    const boardIn = find(list, 1, 0, "card")!.fromMs;
    expect(boardIn).toBeGreaterThan(tight[1]!.words[0]!.startMs - 70 - 150 - 110);
    expect(find(list, 1, 0, "flap-blank")).toBeUndefined();
    expect(need<ShapePiece>(find(list, 1, 0, "flap-word")).fromMs).toBe(Math.max(tight[1]!.words[0]!.startMs - 70, boardIn));
  });

  test("a card flips back only once its word has been read for 150 ms", () => {
    // Room for the flip but not for the sample's slot: the last card flips back as late as the board allows.
    const list = build([
      { index: 0, startMs: 0, endMs: 900, speaker: 0, language: "en", words: [{ text: "a", startMs: 300, endMs: 400, role: "body", key: null }, { text: "b", startMs: 400, endMs: 600, role: "body", key: null }] },
      { index: 1, startMs: 900, endMs: 2000, speaker: 0, language: "en", words: [{ text: "c", startMs: 1000, endMs: 1300, role: "body", key: null }] },
    ]);
    const boardEnd = find(list, 0, 1, "card")!.toMs;
    expect(boardEnd).toBe(1000 - 70 - 110);
    const exit = need<ShapePiece>(find(list, 0, 1, "flap-exit"));
    expect(exit.fromMs).toBe(Math.min(Math.max(boardEnd - 180 + 25, 400 - 70 + 220 + 150), boardEnd - 80));
    expect(exit.fromMs).toBeGreaterThanOrEqual(400 - 70 + 220 + 150);
    expect(exit.toMs).toBe(exit.fromMs + 80);
  });
});

describe("Flap edge cases", () => {
  test("a cue is its own board: it ends where the next one starts", () => {
    const ends = new Map<number, number>();
    const starts = new Map<number, number>();
    for (const piece of scene) {
      const cue = Number(piece.id.split(":")[1]);
      ends.set(cue, Math.max(ends.get(cue) ?? 0, piece.toMs));
      starts.set(cue, Math.min(starts.get(cue) ?? Number.POSITIVE_INFINITY, piece.fromMs));
    }
    expect(ends.get(0)).toBe(starts.get(1));
    expect(ends.get(1)).toBe(starts.get(2));
    expect(ends.get(3)).toBe(cues[3]!.endMs);
  });

  test("a hero first in its cue pulls its board in 150 ms earlier", () => {
    expect(find(scene, 1, 0, "card")!.fromMs).toBe(cues[1]!.words[0]!.startMs - 70 - 150 - 110);
  });

  test("a word wider than a row shrinks the whole group to fit", () => {
    const list = build(sceneEdgeDemo("long-word").cues);
    const wide = need<TextPiece>(find(list, 1, 0, "top"));
    expect(wide.sizePx).toBeLessThan(BODY / 1.8);
    const card = need<ShapePiece>(find(list, 1, 0, "card"));
    const xs = card.path.filter((c) => c[0] !== "Z").map((c) => c[1] as number);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(920 + 1);
  });

  test("a later hero keeps its size and the row stays on one split line", () => {
    const list = build(demoCues({ lines: ["it:b big:h@500 and:b huge:h@500"] }).cues);
    const big = need<ShapePiece>(find(list, 0, 1, "card"));
    const huge = need<ShapePiece>(find(list, 0, 3, "card"));
    const and = need<ShapePiece>(find(list, 0, 2, "card"));
    expect(need<TextPiece>(find(list, 0, 3, "top")).sizePx).toBe(HERO);
    expect(evaluatePiece(huge, 5000).y).toBeCloseTo(evaluatePiece(and, 5000).y, 6);
    expect(evaluatePiece(big, 5000).y).not.toBeCloseTo(evaluatePiece(and, 5000).y, 1);
  });

  test("a right-to-left cue runs its cards right to left", () => {
    const list = build(sceneEdgeDemo("urdu").cues);
    const x = (word: number) => evaluatePiece(need<ShapePiece>(find(list, 0, word, "card")), 4000).x;
    // یہ بہت [اچھا] ہے: the first spoken word is the rightmost card of its row.
    expect(x(0)).toBeGreaterThan(x(1));
  });

  test("the hero's near-black type turns light on a dark highlight; brand colours drive faces and type", () => {
    const dark = build(cues, { colours: { primary: "#ABCDEF", highlight: "#101820", accent: "#223344", shadow: "#000000" } });
    expect(need<TextPiece>(find(dark, HERO_CUE, 2, "top")).fill).toBe("#ABCDEF");
    expect(need<TextPiece>(find(scene, HERO_CUE, 2, "top")).fill).toBe("#17130A");
    expect(need<ShapePiece>(find(dark, 0, 0, "lower")).fill!.colour).toBe("#223344");
    expect(need<ShapePiece>(find(dark, HERO_CUE, 2, "lower")).fill!.colour).toBe("#101820");
  });

  test("a one-word cue is a single hero card", () => {
    const list = build(sceneEdgeDemo("one-word").cues);
    expect(new Set(list.filter((p) => p.id.startsWith("flap:0:")).map(cardOf))).toEqual(new Set(["c0"]));
    expect(need<TextPiece>(find(list, 0, 0, "top")).sizePx).toBe(HERO);
  });

  test("each piece id names its card and part (the budget test groups by cue)", () => {
    for (const piece of scene) expect(partOf(piece)).toMatch(/^(shadow|card|lower|light|top|bottom|split|flap-blank|flap-word|flap-exit|flap-text)$/);
  });

  test("a board leaves at its cue's end, not when the next board enters, so a long pause is not captioned with a frozen board", () => {
    // Real speech (a podcast clip): "create today?" ends at 26.2 s, the next words come at 33 s. `cue.endMs` is the scene cue tail (650 ms).
    const word = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs, role: "body" as const, key: null });
    const real: SceneCue[] = [
      { index: 0, startMs: 25610, endMs: 26860, speaker: 0, language: "en", words: [word("create", 25610, 25900), word("today?", 25900, 26210)] },
      { index: 1, startMs: 33000, endMs: 34000, speaker: 0, language: "en", words: [word("before", 33000, 33300), word("we", 33300, 33500)] },
    ];
    const list = build(real);
    const first = list.filter((piece) => piece.id.startsWith("flap:0:"));
    expect(Math.max(...first.map((piece) => piece.toMs))).toBeLessThanOrEqual(26860);
    // Contiguous cues are unchanged: the board still leaves as the next one enters.
    const contiguous = build(cues);
    const firstOfDemo = contiguous.filter((piece) => piece.id.startsWith("flap:0:"));
    const secondIn = Math.min(...contiguous.filter((piece) => piece.id.startsWith("flap:1:")).map((piece) => piece.fromMs));
    expect(Math.max(...firstOfDemo.map((piece) => piece.toMs))).toBeLessThanOrEqual(secondIn);
  });
});
