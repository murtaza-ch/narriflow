import { describe, expect, test } from "bun:test";
import { demoCues } from "./demo";
import type { SceneCue } from "./input";
import { EASES, prog } from "./ease";
import { evaluatePiece, pieceBounds, type TextPiece } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";
import { HOLLOW_DEMO, hollowEchoLift, hollowProgram, hollowWordScale } from "./templates/hollow";

const { cues } = demoCues(HOLLOW_DEMO);
const input = sceneInput(cues, { colours: { primary: "#FFFFFF", highlight: "#D7FF3E", accent: "#D7FF3E", shadow: "#000000" }, anchor: { xPct: 50, yPct: (1268 / 1920) * 100 } });
const scene = hollowProgram.build(input);
const texts = scene.pieces.filter((piece): piece is TextPiece => piece.kind === "text");
const of = (cue: number, word: number, part: string) => texts.find((piece) => piece.id === `hollow:${cue}:w${word}:${part}`)!;
const cueOf = (piece: { id: string }) => cues[Number(piece.id.split(":")[1])]!;
const CAP = 0.72; // the fake measure's cap height, share of the size

describe("Hollow", () => {
  test("a word is a shade, an outline and a fill; the hero has three echoes under them", () => {
    const parts = (cue: number) => texts.filter((piece) => piece.id.startsWith(`hollow:${cue}:`)).map((piece) => piece.id.split(":")[3]);
    expect(parts(3).sort()).toEqual(["fill", "fill", "outline", "outline", "shade", "shade"]); // zero excuses: no hero
    expect(parts(1).filter((part) => part?.startsWith("echo"))).toEqual(["echo0", "echo1", "echo2"]);
    expect(parts(0).some((part) => part?.startsWith("echo"))).toBe(false);
    expect(texts.every((piece) => piece.face === "Anton" && piece.letterSpacingEm === 0.012)).toBe(true);
    expect(of(1, 2, "fill").text).toBe("DISCIPLINE");
  });

  test("a no-hero cue is two rows justified to one width, within the sample's size range", () => {
    // you don't need / motivation: character count 12 | 10 split after "need"; the sample's justification formula.
    const width = (text: string, size: number) => fakeMeasure(text, "Anton", size, 0.012).advance + 0.012 * size;
    const first = [0, 1, 2].reduce((sum, at) => sum + width(["YOU", "DON'T", "NEED"][at]!, 156), 0) + 156 * 0.2 * 2;
    const second = width("MOTIVATION", 156);
    const target = Math.min(860, Math.max(first, second));
    const sizes = [(156 * target) / first, (156 * target) / second].map((size) => Math.min(156 * 1.4, Math.max(156 * 0.8, size)));
    expect(of(0, 0, "fill").sizePx).toBeCloseTo(sizes[0]!, 6);
    expect(of(0, 2, "fill").sizePx).toBeCloseTo(sizes[0]!, 6);
    expect(of(0, 3, "fill").sizePx).toBeCloseTo(sizes[1]!, 6);
    // Two rows, the second under the first.
    expect(evaluatePiece(of(0, 3, "fill"), 1500).y).toBeGreaterThan(evaluatePiece(of(0, 0, "fill"), 1500).y);
  });

  test("a hero cue: body rows at 124 px, the hero fitted to 84 % of the frame inside 200 to 340, stacked lead, hero, tail", () => {
    const you = of(4, 0, "fill");
    const champions = of(4, 2, "fill");
    const are = of(4, 3, "fill");
    expect(you.sizePx).toBe(124);
    expect(are.sizePx).toBe(124);
    // 84 % of the frame inside 200 to 340, and never wider than a row once its pulse and outline are counted.
    const unit = fakeMeasure("CHAMPIONS", "Anton", 100, 0.012).advance + 0.012 * 100;
    const fit = Math.min(Math.min(340, Math.max(200, (0.84 * 1080 * 100) / unit)), (((0.9 * 1080) / 1.06 - 8) * 100) / unit);
    expect(champions.sizePx).toBeCloseTo(fit, 6);
    const rest = 7000;
    const yLead = evaluatePiece(you, rest).y;
    const yHero = evaluatePiece(champions, rest).y;
    const yTail = evaluatePiece(are, rest).y;
    expect(yLead).toBeLessThan(yHero);
    expect(yHero).toBeLessThan(yTail);
    // Rows nearly touch: hero to tail pivots are half a hero and half a tail cap height plus the 20 px gap apart (the pivot sits 55 % down a box).
    const heroH = champions.sizePx * CAP;
    const tailH = are.sizePx * CAP;
    expect(yTail - yHero).toBeCloseTo(20 + (1 - 0.55) * heroH + 0.55 * tailH, 3);
  });

  test("the hero fills in the highlight colour, body words in the primary; echoes are lime outlines", () => {
    const hero = of(1, 2, "fill");
    expect(hero.fill).toBe("#D7FF3E");
    expect(hero.stroke).toMatchObject({ colour: "#D7FF3E" });
    expect(of(1, 1, "fill").fill).toBe("#FFFFFF");
    for (const echo of [0, 1, 2]) {
      const piece = of(1, 2, `echo${echo}`);
      expect(piece.fillAlpha).toBe(0);
      expect(piece.stroke?.colour).toBe("#D7FF3E");
    }
    expect(of(1, 1, "outline").fillAlpha).toBe(0);
    expect(of(1, 1, "outline").stroke?.colour).toBe("#FFFFFF");
    // Brand colours reach the template.
    const branded = hollowProgram.build({ ...input, colours: { ...input.colours, primary: "#112233", highlight: "#445566" } }).pieces.filter((piece): piece is TextPiece => piece.kind === "text");
    expect(branded.find((piece) => piece.id === "hollow:1:w2:fill")!.fill).toBe("#445566");
    expect(branded.find((piece) => piece.id === "hollow:1:w1:outline")!.stroke?.colour).toBe("#112233");
  });

  test("the fill snaps in over 90 ms from 20 ms before the word, and the outline goes the moment it is solid", () => {
    const word = cues[1]!.words[1]!;
    const fill = of(1, 1, "fill");
    const outline = of(1, 1, "outline");
    expect(fill.fromMs).toBe(word.startMs - 20);
    for (const [t, f] of [[word.startMs - 20, 0], [word.startMs + 25, 0.5], [word.startMs + 70, 1], [word.startMs + 200, 1]] as const) {
      expect(evaluatePiece(fill, t).o).toBeCloseTo(f, 2);
    }
    expect(evaluatePiece(outline, word.startMs + 60).o).toBe(1);
    expect(evaluatePiece(outline, word.startMs + 90).o).toBe(0);
    expect(evaluatePiece(outline, word.startMs - 100).o).toBeGreaterThan(0.99);
  });

  test("a word's box pulses 1 to 1.06 to 1 and settles in from 0.93, with the sample's own formula", () => {
    for (const piece of [of(1, 1, "fill"), of(1, 1, "outline"), of(1, 2, "echo1")]) {
      const cue = cueOf(piece);
      const word = cue.words[Number(piece.id.split(":w")[1]!.split(":")[0])]!;
      for (const t of [piece.fromMs + 5, cue.startMs, cue.startMs + 60, word.startMs - 20, word.startMs + 30, word.startMs + 80, word.startMs + 180, word.startMs + 280, cue.endMs - 110, cue.endMs - 60]) {
        if (t < piece.fromMs || t >= piece.toMs) continue;
        expect(Math.abs(evaluatePiece(piece, t).sx - hollowWordScale(t, word.startMs, cue.startMs, cue.endMs))).toBeLessThan(0.002);
      }
    }
    expect(evaluatePiece(of(1, 2, "fill"), cues[1]!.words[2]!.startMs + 80).sx).toBeCloseTo(1.06, 2);
    // The dark halo does not pulse: a blurred layer that is re-drawn every frame costs more than the 6 % shows.
    expect(of(1, 1, "shade").track.sx).toBeUndefined();
    expect(of(1, 1, "outline").toMs).toBe(cues[1]!.words[1]!.startMs + 70);
  });

  test("the echoes eject 60 ms apart with outExpo over 260 ms to 0.4, 0.8 and 1.2 hero heights and collapse in the last 200 ms", () => {
    const cue = cues[1]!;
    const hero = cue.words[2]!;
    const fill = of(1, 2, "fill");
    const heroH = fill.sizePx * CAP;
    for (const echo of [0, 1, 2]) {
      const piece = of(1, 2, `echo${echo}`);
      expect(piece.fromMs).toBe(hero.startMs + echo * 60);
      for (const t of [piece.fromMs + 20, piece.fromMs + 90, piece.fromMs + 160, piece.fromMs + 260, cue.endMs - 190, cue.endMs - 120, cue.endMs - 60]) {
        if (t >= piece.toMs) continue;
        const s = evaluatePiece(fill, t).sx;
        const lift = (evaluatePiece(fill, t).y - evaluatePiece(piece, t).y) / s;
        expect(Math.abs(lift - hollowEchoLift(t, hero.startMs, echo, cue.endMs) * heroH)).toBeLessThan(0.6);
      }
    }
    // At rest the three sit at 0.4, 0.8 and 1.2 of the hero's height.
    const rest = hero.startMs + 2 * 60 + 400;
    const y = (echo: number) => (evaluatePiece(fill, rest).y - evaluatePiece(of(1, 2, `echo${echo}`), rest).y) / heroH;
    expect([y(0), y(1), y(2)].map((value) => Math.round(value * 100) / 100)).toEqual([0.4, 0.8, 1.2]);
    // Opacities 0.85, 0.55, 0.28 at rest, and each echo shows only the band above the copy in front of it.
    expect([0, 1, 2].map((echo) => Math.round(evaluatePiece(of(1, 2, `echo${echo}`), rest).o * 100) / 100)).toEqual([0.85, 0.55, 0.28]);
    const echo0 = evaluatePiece(of(1, 2, "echo0"), rest).clip!;
    const echo1 = evaluatePiece(of(1, 2, "echo1"), rest).clip!;
    const boxTop = evaluatePiece(fill, rest).y - 0.55 * heroH;
    expect(echo0.y2).toBeCloseTo(boxTop - 7, 1);
    expect(echo1.y2).toBeCloseTo(boxTop - 0.4 * heroH - 7, 1);
    // Collapsed into the hero at the cue's end: nothing of an echo is left to show.
    expect(evaluatePiece(of(1, 2, "echo2"), cue.endMs - 31).o).toBe(0);
  });

  test("the lead row rides up on top of the echo stack, and sits still when the cue has no hero", () => {
    const cue = cues[1]!;
    const hero = cue.words[2]!;
    const lead = of(1, 0, "fill");
    const heroH = of(1, 2, "fill").sizePx * CAP;
    const before = evaluatePiece(lead, hero.startMs - 40).y;
    const rest = evaluatePiece(lead, hero.startMs + 2 * 60 + 400).y;
    expect(before - rest).toBeCloseTo(1.2 * heroH, 1);
    const plain = of(0, 0, "fill");
    expect(plain.track.y).toHaveLength(1);
    // The body row between lead and hero (cue 2: every single | day) moves with the lead.
    expect(of(2, 1, "fill").track.y!.length).toBeGreaterThan(1);
  });

  test("the whole cue arrives together (opacity over 60 ms from 80 ms early) and leaves in its last 110 ms", () => {
    const cue = cues[2]!;
    const shade = of(2, 0, "shade");
    expect(shade.fromMs).toBe(cue.startMs - 80);
    expect(shade.toMs).toBe(cue.endMs - 30);
    expect(evaluatePiece(shade, cue.startMs - 80).o).toBe(0);
    expect(evaluatePiece(shade, cue.startMs - 20).o).toBeCloseTo(0.42, 3);
    expect(evaluatePiece(shade, cue.endMs - 110).o).toBeCloseTo(0.42, 3);
    expect(evaluatePiece(shade, cue.endMs - 31).o).toBeLessThan(0.02);
    const gone = (t: number) => EASES.in(prog(t, cue.endMs - 110, 80));
    expect(evaluatePiece(of(2, 0, "outline"), cue.endMs - 70).o).toBeCloseTo((1 - gone(cue.endMs - 70)) * 0, 2); // the outline is long gone
    expect(evaluatePiece(of(2, 0, "fill"), cue.endMs - 70).o).toBeCloseTo(1 - gone(cue.endMs - 70), 2);
  });

  test("the block is centred on the anchor line with the stack's reach below the zone's top", () => {
    const heroH = of(1, 2, "fill").sizePx * CAP;
    const lead = evaluatePiece(of(1, 0, "fill"), cues[1]!.words[2]!.startMs + 600);
    expect(lead.y).toBeGreaterThan(878 + 32); // the sample's zone top, moved with the anchor line (1300 against 1268 here)
    const hero = evaluatePiece(of(1, 2, "fill"), cues[1]!.words[2]!.startMs + 600).y;
    expect(hero + 0.45 * heroH).toBeLessThan(1636 + 32 + 1); // the hero's bottom edge is inside the zone
  });

  test("a cue that starts on its hero keeps the echoes inside the zone as well", () => {
    const cue: SceneCue = { index: 0, startMs: 0, endMs: 1200, speaker: 0, language: "en", words: [{ text: "wait", startMs: 100, endMs: 500, role: "hero", key: null }] };
    const built = hollowProgram.build(sceneInput([cue], { anchor: { xPct: 50, yPct: (1268 / 1920) * 100 } })).pieces.filter((piece): piece is TextPiece => piece.kind === "text");
    const top = Math.min(...[0, 1, 2].flatMap((echo) => [300, 500, 700].map((t) => pieceBounds(built.find((piece) => piece.id === `hollow:0:w0:echo${echo}`)!, t, fakeMeasure)?.y1 ?? Number.POSITIVE_INFINITY)));
    expect(top).toBeGreaterThanOrEqual(878 - 4 - 1); // the zone top less the outline band
  });

  test("a word wider than a row shrinks to fit, with its strokes, and nothing wraps below it", () => {
    const cue: SceneCue = {
      index: 0,
      startMs: 0,
      endMs: 2000,
      speaker: 0,
      language: "en",
      words: [{ text: "pneumonoultramicroscopicsilicovolcanoconiosis", startMs: 100, endMs: 1500, role: "body", key: null }],
    };
    const built = hollowProgram.build(sceneInput([cue])).pieces.filter((piece): piece is TextPiece => piece.kind === "text");
    const fill = built.find((piece) => piece.id.endsWith(":fill"))!;
    expect(fill.sizePx).toBeLessThan(124);
    const box = pieceBounds(fill, 1000, fakeMeasure)!;
    expect(box.x1).toBeGreaterThanOrEqual(0.05 * 1080 - 1);
    expect(box.x2).toBeLessThanOrEqual(0.95 * 1080 + 1);
    // Strokes thin out with the size but never vanish.
    expect(fill.stroke!.widthPx).toBeLessThan(2);
    expect(fill.stroke!.widthPx).toBeGreaterThanOrEqual(1.2);
  });

  test("a long lead wraps into rows instead of running off the frame", () => {
    const words = ["so", "the", "real", "reason", "most", "people", "never", "get", "there"].map((text, at) => ({ text, startMs: 100 + at * 250, endMs: 300 + at * 250, role: at === 5 ? ("hero" as const) : ("body" as const), key: null }));
    const cue: SceneCue = { index: 0, startMs: 0, endMs: 3200, speaker: 0, language: "en", words };
    const built = hollowProgram.build(sceneInput([cue])).pieces.filter((piece): piece is TextPiece => piece.kind === "text");
    const rowsY = new Set(built.filter((piece) => piece.id.endsWith(":fill") && !piece.id.includes("w5")).map((piece) => Math.round(evaluatePiece(piece, 3000).y)));
    expect(rowsY.size).toBeGreaterThanOrEqual(3); // two lead rows, one tail row
    for (const piece of built) {
      const box = pieceBounds(piece, 2500, fakeMeasure);
      if (box) {
        expect(box.x1).toBeGreaterThanOrEqual(0.05 * 1080 - 1);
        expect(box.x2).toBeLessThanOrEqual(0.95 * 1080 + 1);
      }
    }
  });

  test("an Urdu cue runs its rows right to left", () => {
    const words = ["یہ", "بہت", "اچھا", "ہے"].map((text, at) => ({ text, startMs: 100 + at * 300, endMs: 350 + at * 300, role: at === 2 ? ("hero" as const) : ("body" as const), key: null }));
    const cue: SceneCue = { index: 0, startMs: 0, endMs: 1800, speaker: 0, language: "ur", words };
    const built = hollowProgram.build(sceneInput([cue])).pieces.filter((piece): piece is TextPiece => piece.kind === "text" && piece.id.endsWith(":fill"));
    const x = (word: number) => evaluatePiece(built.find((piece) => piece.id.includes(`w${word}:`))!, 1500).x;
    expect(x(0)).toBeGreaterThan(x(1)); // the first word of the lead row is on the right
  });

  test("a piece never has a non-positive window, and every piece's text is upper case", () => {
    for (const piece of texts) {
      expect(piece.toMs).toBeGreaterThan(piece.fromMs);
      expect(piece.text).toBe(piece.text.toUpperCase());
    }
  });
});
