import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { CURSOR_DEMO, cursorGrowth, cursorHash, cursorProgram } from "./templates/cursor";
import { fakeMeasure, sceneInput } from "./test-support";

const { cues } = demoCues(CURSOR_DEMO);
const COLOURS = { primary: "#FFFFFF", highlight: "#F5C518", accent: "#111111", shadow: "#000000" };
const build = (list: readonly SceneCue[], overrides = {}) => cursorProgram.build(sceneInput(list, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
const scene = build(cues);
const of = (list: readonly Piece[], cue: number) => list.filter((piece) => piece.id.startsWith(`cursor:${cue}:`));
const find = (list: readonly Piece[], id: string) => list.find((piece) => piece.id === `cursor:${id}`);
const need = <T extends Piece>(piece: Piece | undefined) => {
  expect(piece).toBeDefined();
  return piece as T;
};
const part = (piece: Piece) => piece.id.split(":")[2]!;

/** The card's box from its vertical band: x from the band's left minus the radius, to its right plus it. */
const cardBox = (list: readonly Piece[], cue: number, t: number) => {
  const v = need<ShapePiece>(find(list, `${cue}:card-v`));
  const pose = evaluatePiece(v, t);
  const w = Math.max(...v.path.flatMap((cmd) => (cmd[0] === "Z" ? [] : [cmd[1] as number])));
  return { x1: pose.x - 34, x2: pose.x + w * pose.sx + 34, y1: pose.y, y2: pose.y + Math.max(...v.path.flatMap((cmd) => (cmd[0] === "Z" ? [] : [cmd[2] as number]))) * pose.sy };
};

describe("Cursor card", () => {
  test("it is centred on x 540 and y 1290 and shrink-wraps its rows (cue 1: two rows, padded 58 / 50 / 40 / 50)", () => {
    const box = cardBox(scene, 1, 3900);
    expect((box.x1 + box.x2) / 2).toBeCloseTo(540, 0);
    expect((box.y1 + box.y2) / 2).toBeCloseTo(1290, 0);
    // Two rows: the 117 px hero row, 6 px, the 96 px row, plus 58 and 40 px of padding.
    expect(box.y2 - box.y1).toBeCloseTo(58 + 117.04 + 6 + 96 + 40, 0);
    expect(box.x2 - box.x1).toBeLessThanOrEqual(924);
  });

  test("it grows by the sample's steps: outExpo over 240 ms, one per word at start - 70 and per hero at start - 260", () => {
    const cue = cues[1]!;
    const steps = [
      { at: cue.words[0]!.startMs - 70 + 40, dw: 300, dh: 0 },
      { at: cue.words[2]!.startMs - 260, dw: 200, dh: 100 },
    ];
    for (const t of [steps[0]!.at + 50, steps[1]!.at + 100, steps[1]!.at + 400]) {
      const g = cursorGrowth(steps, 190, t);
      expect(g.width).toBeCloseTo(300 * EASES.outExpo(prog(t, steps[0]!.at, 240)) + 200 * EASES.outExpo(prog(t, steps[1]!.at, 240)), 6);
      expect(g.height).toBeCloseTo(190 + 100 * EASES.outExpo(prog(t, steps[1]!.at, 240)), 6);
    }
    // In the scene the card is narrower while the hero's chip is not yet opened, and wider after.
    const early = cardBox(scene, 1, cue.words[1]!.startMs);
    const late = cardBox(scene, 1, cue.words[3]!.startMs + 400);
    expect(late.x2).toBeGreaterThan(early.x2 + 100);
    expect(late.x1).toBeCloseTo(early.x1, 3);
  });

  test("cards alternate white and black, ink the other way, and the chip text stays dark", () => {
    const fill = (cue: number) => need<ShapePiece>(find(scene, `${cue}:card-v`)).fill!.colour;
    expect([0, 1, 2, 3].map(fill)).toEqual(["#FFFFFF", "#111111", "#FFFFFF", "#111111"]);
    expect(need<TextPiece>(find(scene, "0:w1")).fill).toBe("#111111");
    expect(need<TextPiece>(find(scene, "1:w1")).fill).toBe("#FFFFFF");
    expect(need<TextPiece>(find(scene, "1:hero")).fill).toBe("#111111");
    expect(need<ShapePiece>(find(scene, "1:chip-v")).fill!.colour).toBe("#F5C518");
  });

  test("the card's end stays rounded: a corner disc rides the right edge as it grows", () => {
    const cue = cues[1]!;
    const se = need<ShapePiece>(find(scene, "1:card-se"));
    const v = need<ShapePiece>(find(scene, "1:card-v"));
    for (const t of [cue.words[2]!.startMs - 200, cue.words[3]!.startMs]) {
      const vp = evaluatePiece(v, t);
      const w = Math.max(...v.path.flatMap((cmd) => (cmd[0] === "Z" ? [] : [cmd[1] as number])));
      expect(evaluatePiece(se, t).x).toBeCloseTo(vp.x + w * vp.sx, 0);
    }
  });
});

describe("Cursor words, hero and sticker", () => {
  test("words rise out of their slit over 360 ms (outExpo) from 70 ms before they are spoken, 150 % of their height", () => {
    const cue = cues[0]!;
    const word = cue.words[2]!;
    const piece = need<TextPiece>(find(scene, "0:w2"));
    const rest = evaluatePiece(piece, word.startMs + 800).y;
    for (const t of [word.startMs - 40, word.startMs + 20, word.startMs + 150]) {
      const p = EASES.outExpo(prog(t, word.startMs - 70, 360));
      if (t >= piece.fromMs) expect(evaluatePiece(piece, t).y).toBeCloseTo(rest + (1 - p) * 1.5 * 76, 1);
    }
    expect(piece.sizePx).toBe(76);
    expect(piece.face).toBe("Inter Tight ExtraBold");
  });

  test("the hero is Instrument Serif at 112 px; the pointer arrives, drags 240 ms, clicks, then leaves", () => {
    const hero = need<TextPiece>(find(scene, "1:hero"));
    expect(hero).toMatchObject({ text: "fewer", face: "Instrument Serif", sizePx: 112 });
    const hs = cues[1]!.words[2]!.startMs;
    const pointer = need<ShapePiece>(find(scene, "1:pointer"));
    expect(evaluatePiece(pointer, hs + 40).sx).toBeCloseTo(0.82, 2);
    expect(evaluatePiece(pointer, hs + 200).sx).toBe(1);
    const dragged = evaluatePiece(pointer, hs - 20).x - evaluatePiece(pointer, hs - 260).x;
    const boxW = evaluatePiece(need<ShapePiece>(find(scene, "1:chip-v")), hs + 300);
    expect(dragged).toBeGreaterThan(100);
    expect(boxW.o).toBe(1);
    expect(evaluatePiece(pointer, hs + 400).o).toBe(1);
    expect(evaluatePiece(pointer, hs + 800).o).toBeLessThan(0.5);
  });

  test("the sticker pops with a spring 140 ms after the hero from -32 to -8 degrees and the toggle turns on", () => {
    const hs = cues[1]!.words[2]!.startMs;
    const pill = need<ShapePiece>(find(scene, "1:pill"));
    expect(evaluatePiece(pill, hs + 140 + 5).sx).toBeLessThan(0.2);
    const settled = evaluatePiece(pill, hs + 140 + 440 + 100);
    expect(settled.sx).toBeCloseTo(1, 1);
    expect(settled.rz).toBeGreaterThan(-13);
    expect(settled.rz).toBeLessThan(-3);
    const knob0 = evaluatePiece(need<ShapePiece>(find(scene, "1:knob")), hs + 140 + 200).x;
    const knob1 = evaluatePiece(need<ShapePiece>(find(scene, "1:knob")), hs + 140 + 700).x;
    expect(knob1 - knob0).toBeGreaterThan(40);
  });

  test("no invented text: the only text pieces are the cue's own words", () => {
    for (const cue of [0, 1, 2, 3, 4]) {
      const texts = of(scene, cue).filter((piece): piece is TextPiece => piece.kind === "text").map((piece) => piece.text);
      expect(texts.sort()).toEqual(cues[cue]!.words.map((word) => word.text).sort());
    }
  });
});

describe("Cursor across a whole clip", () => {
  const word = (text: string, startMs: number, role: "hero" | "body" = "body") => ({ text, startMs, endMs: startMs + 260, role, key: null });
  const long: SceneCue[] = Array.from({ length: 24 }, (_, i) => {
    const start = i * 1500;
    const hero = i % 3 !== 2;
    return { index: i, startMs: start, endMs: start + 1500, speaker: 0, language: "en", words: [word("so", start), word("what", start + 290), hero ? word("matters", start + 580, "hero") : word("matters", start + 580), word("most", start + 870)] };
  });
  const list = build(long);

  test("every cue draws the card, the dots and a sticker, and the stickers alternate", () => {
    const stickerParts = (cue: number) => of(list, cue).map(part);
    for (let cue = 0; cue < long.length; cue++) {
      const parts = stickerParts(cue);
      expect(parts).toContain("card-v");
      expect(parts).toContain("dot0");
      expect(parts.includes("pill") || parts.includes("tile")).toBe(true);
    }
    const heroKinds = long.filter((_, i) => i % 3 !== 2).map((cue) => (stickerParts(cue.index).includes("pill") ? "toggle" : "tile"));
    expect(heroKinds.slice(0, 6)).toEqual(["toggle", "tile", "toggle", "tile", "toggle", "tile"]);
    expect(heroKinds.every((kind, at) => kind === (at % 2 === 0 ? "toggle" : "tile"))).toBe(true);
  });

  test("the sticker's tilt and nudge vary from cue to cue but are deterministic", () => {
    const tilt = (cue: number) => evaluatePiece(need<ShapePiece>(of(list, cue).find((piece) => ["pill", "tile"].includes(part(piece)))), long[cue]!.startMs + 1300).rz;
    const tilts = new Set([0, 3, 6, 9, 12, 15].map((cue) => tilt(cue).toFixed(2)));
    expect(tilts.size).toBeGreaterThan(3);
    expect(cursorHash("a|b")).toBe(cursorHash("a|b"));
    expect(build(long).map((piece) => piece.id)).toEqual(list.map((piece) => piece.id));
  });

  test("a cue without a hero (every third) still has a sticker, no chip, no pointer", () => {
    const parts = of(list, 2).map(part);
    expect(parts.some((p) => p.startsWith("chip") || p === "pointer")).toBe(false);
    expect(parts.includes("pill") || parts.includes("tile")).toBe(true);
  });
});

describe("Cursor with real speech", () => {
  test("with 60 ms between cues every word stays on screen, inside its clip, for 150 ms after it lands", () => {
    const fast = demoCues({ ...CURSOR_DEMO, options: { ...CURSOR_DEMO.options, cueGap: 60 } }).cues;
    const pieces = build(fast);
    fast.forEach((cue, number) => {
      const texts = of(pieces, number).filter((piece): piece is TextPiece => piece.kind === "text");
      for (const piece of texts) {
        const at = Number(part(piece).slice(part(piece).startsWith("hero") ? 4 : 1));
        const index = part(piece) === "hero" ? cue.words.findIndex((w) => w.role === "hero") : at;
        const w = cue.words[index]!;
        const hero = part(piece) === "hero";
        const landed = hero ? w.startMs - 60 + 0.432 * 420 : w.startMs - 70 + 0.432 * 360;
        for (let t = Math.ceil(landed); t <= landed + 150; t += 10) {
          const pose = evaluatePiece(piece, t);
          expect(piece.fromMs <= t && t < piece.toMs).toBe(true);
          expect(pose.o).toBeGreaterThan(0.9);
          const clip = pose.clip!;
          expect(clip.x2 - clip.x1).toBeGreaterThan(20);
          expect(clip.y2 - clip.y1).toBeGreaterThan(20);
        }
      }
    });
  });

  test("the card exit starts 155 ms before the cue ends when the words are long landed, and lasts 100 ms", () => {
    const cue = cues[0]!;
    const v = need<ShapePiece>(find(scene, "0:card-v"));
    const width = (t: number) => evaluatePiece(v, t).sx;
    expect(width(cue.endMs - 160)).toBeGreaterThan(0.99 * width(cue.endMs - 300));
    expect(width(cue.endMs - 100)).toBeLessThan(width(cue.endMs - 160));
  });
});

describe("Cursor edge cases", () => {
  test("a right-to-left cue grows from the right edge, with the dots at the top right and the sticker at the top left", () => {
    const list = build(sceneEdgeDemo("urdu").cues);
    const first = sceneEdgeDemo("urdu").cues[0]!;
    const box = cardBox(list, 0, first.words[2]!.startMs + 300);
    const word0 = need<TextPiece>(find(list, "0:w0"));
    const word1 = need<TextPiece>(find(list, "0:w1"));
    expect(evaluatePiece(word0, first.startMs + 900).x).toBeGreaterThan(evaluatePiece(word1, first.startMs + 900).x);
    const dot = evaluatePiece(need<ShapePiece>(find(list, "0:dot0")), first.startMs + 900);
    expect(dot.x).toBeGreaterThan((box.x1 + box.x2) / 2);
    const pill = need<ShapePiece>(of(list, 0).find((piece) => ["pill", "tile"].includes(part(piece))));
    expect(evaluatePiece(pill, first.words[2]!.startMs + 600).x).toBeLessThan((box.x1 + box.x2) / 2);
  });

  test("a word wider than a row shrinks the card's type to fit; nothing leaves the safe area on 9:16, 1:1 or 16:9", () => {
    for (const [canvas, anchor] of [
      [{ width: 1080, height: 1920 }, { xPct: 50, yPct: (1290 / 1920) * 100 }],
      [{ width: 1080, height: 1080 }, { xPct: 50, yPct: 70 }],
      [{ width: 1920, height: 1080 }, { xPct: 50, yPct: 70 }],
    ] as const) {
      for (const kind of ["long-word", "nine-words", "one-word"] as const) {
        const pieces = build(sceneEdgeDemo(kind).cues, { canvas, anchor });
        for (let t = 0; t < 6000; t += 25) {
          const box = sceneBoundsAt(pieces, t, fakeMeasure);
          if (!box) continue;
          expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
          expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
          expect(box.y1).toBeGreaterThanOrEqual(0.05 * canvas.height - 1);
          expect(box.y2).toBeLessThanOrEqual(0.95 * canvas.height + 1);
        }
      }
    }
    const long = build(sceneEdgeDemo("long-word").cues);
    expect(Math.min(...long.filter((p): p is TextPiece => p.kind === "text").map((p) => p.sizePx))).toBeLessThan(76);
  });
});
