import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece } from "./scene";
import { SPINE_DEMO, spineHeroOffset, spineProgram, spineRows } from "./templates/spine";
import { fakeMeasure, sceneInput } from "./test-support";

const { cues } = demoCues(SPINE_DEMO);
const COLOURS = { primary: "#0E0E0E", highlight: "#FF3B1F", accent: "#FFFFFF", shadow: "#000000" };
const build = (list: readonly SceneCue[], overrides = {}) => spineProgram.build(sceneInput(list, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
const scene = build(cues);
const find = (list: readonly Piece[], id: string) => list.find((piece) => piece.id === `spine:${id}`);
const need = <T extends Piece>(piece: Piece | undefined) => {
  expect(piece).toBeDefined();
  return piece as T;
};
const widthOf = (shape: ShapePiece) => Math.max(...shape.path.flatMap((cmd) => (cmd[0] === "Z" ? [] : [cmd[1] as number])));
/** The sample's plate width: the word's box (advance plus trailing letter spacing) padded 16 px each side, whole px. */
const plateWidth = (text: string, size: number) => Math.round(fakeMeasure(text, "Inter Tight Bold", size, -0.02).advance - 0.02 * size + 32);

describe("Spine geometry", () => {
  test("the column: counter, a 5 px rule from x 330 to 996 at y 1290, plates 16 px under it", () => {
    const rule = need<ShapePiece>(find(scene, "0:rule"));
    const pose = evaluatePiece(rule, 1500);
    expect(pose.x).toBeCloseTo(330, 6);
    expect(pose.y - rule.origin!.dy).toBeCloseTo(1290, 6);
    expect(widthOf(rule)).toBeCloseTo(666, 6);
    const counter = need<TextPiece>(find(scene, "0:counter"));
    expect(counter.text).toBe("01");
    expect(evaluatePiece(counter, 1500)).toMatchObject({ x: 330, y: 1270 });
    const plate = need<ShapePiece>(find(scene, "0:p0"));
    expect(evaluatePiece(plate, 1500).y).toBeCloseTo(1311, 6);
    // 9 + 58 + 13 px tall; the word's baseline 50 px into its 58 px line box.
    const height = Math.max(...plate.path.flatMap((cmd) => (cmd[0] === "Z" ? [] : [cmd[2] as number])));
    expect(height).toBeCloseTo(80, 6);
    expect(evaluatePiece(need<TextPiece>(find(scene, "0:t0")), 1500).y).toBeCloseTo(1311 + 9 + 0.862 * 58, 6);
  });

  test("plates pack into the fewest rows at the narrowest width that keeps that count, 8 px apart", () => {
    // Five 100 px plates in 330 px: two rows; the narrowest limit with two rows puts three on top.
    expect(spineRows([100, 100, 100, 100, 100], 330)).toEqual([[0, 1, 2], [3, 4]]);
    // A limit that fits everything keeps one row.
    expect(spineRows([100, 100], 666)).toEqual([[0, 1]]);
    // The demo's third cue ("Then break exactly one", hero RULE) wraps into two rows of two.
    const plates = ["2:p0", "2:p1", "2:p2", "2:p3"].map((id) => need<ShapePiece>(find(scene, id)));
    const ys = plates.map((plate) => evaluatePiece(plate, 5000).y);
    expect(ys[0]).toBeCloseTo(ys[1]!, 6);
    expect(ys[2]).toBeCloseTo(ys[3]!, 6);
    expect(ys[2]! - ys[0]!).toBeCloseTo(80 + 8, 6);
    expect(evaluatePiece(plates[1]!, 5000).x - (evaluatePiece(plates[0]!, 5000).x + widthOf(plates[0]!))).toBeCloseTo(8, 6);
    expect(widthOf(plates[0]!)).toBe(plateWidth("Then", 58));
  });

  test("a cue without a hero sets its column at x 96 with 72 px plates", () => {
    const rule = need<ShapePiece>(find(scene, "1:rule"));
    expect(evaluatePiece(rule, 3000).x).toBeCloseTo(96, 6);
    expect(widthOf(rule)).toBeCloseTo(900, 6);
    expect(need<TextPiece>(find(scene, "1:t0")).sizePx).toBe(72);
    expect(find(scene, "1:hero")).toBeUndefined();
  });

  test("the hero runs up the left edge: 660 px long (150 to 250 px), turned -90 degrees, its bottom end at y 1560", () => {
    const hero = need<TextPiece>(find(scene, "0:hero"));
    expect(hero.text).toBe("QUIET");
    expect(hero.face).toBe("Archivo Black");
    const at250 = Math.round(fakeMeasure("QUIET", "Archivo Black", 250, -0.01).advance - 0.01 * 250);
    const size = Math.min(250, Math.max(150, (250 * 660) / at250));
    expect(hero.sizePx).toBeCloseTo(size, 6);
    const rest = evaluatePiece(hero, 2080);
    expect(rest.rz).toBe(-90);
    expect(rest.y).toBeCloseTo(1560, 6);
    // Its baseline is 0.833 em across a line box whose left is 96 - 0.105 em, so the cap tops sit on x 96 + 0.04 em.
    expect(rest.x).toBeCloseTo(96 - 0.105 * size + 0.833 * size, 6);
    // The print offset is the same word 6 px right and down, under it.
    const offset = need<TextPiece>(find(scene, "0:offset"));
    expect(offset.fill).toBe("#141414");
    expect(offset.z).toBeLessThan(hero.z);
    expect(evaluatePiece(offset, 2080).x - rest.x).toBeCloseTo(6, 6);
    expect(evaluatePiece(offset, 2080).y - rest.y).toBeCloseTo(6, 6);
    expect(hero.fill).toBe("#FF3B1F");
  });

  test("the mask is the hero's footprint: its bottom 8 px under the edge, the hero rising through it", () => {
    const hero = need<TextPiece>(find(scene, "0:hero"));
    const clip = evaluatePiece(hero, 2200).clip!;
    const length = Math.round(fakeMeasure("QUIET", "Archivo Black", hero.sizePx, -0.01).advance - 0.01 * hero.sizePx);
    expect(clip.y2).toBeCloseTo(1568, 6);
    expect(clip.y1).toBeCloseTo(1560 - length, 6);
    expect(clip.x2 - clip.x1).toBeCloseTo(hero.sizePx + 10, 6);
  });
});

describe("Spine motion", () => {
  test("the hero rises out of the edge over 520 ms and keeps going out of the top as the cue ends", () => {
    const cue = cues[0]!;
    const word = cue.words[4]!;
    const hero = need<TextPiece>(find(scene, "0:hero"));
    const length = Math.round(fakeMeasure("QUIET", "Archivo Black", hero.sizePx, -0.01).advance - 0.01 * hero.sizePx);
    const travel = length + 6 + 4;
    for (const t of [word.startMs - 70, word.startMs, word.startMs + 150, word.startMs + 440, cue.endMs - 150, cue.endMs - 60, cue.endMs - 11]) {
      expect(evaluatePiece(hero, t).y).toBeCloseTo(1560 + spineHeroOffset(t, word.startMs, cue.endMs, travel), 1);
    }
    expect(hero.fromMs).toBeGreaterThanOrEqual(word.startMs - 80);
    expect(hero.toMs).toBe(cue.endMs - 10);
  });

  test("the rule draws in 360 ms, the counter ticks in over 300 ms, each plate wipes in from the left on its word", () => {
    const cue = cues[0]!;
    const rule = need<ShapePiece>(find(scene, "0:rule"));
    for (const t of [cue.startMs, cue.startMs + 100, cue.startMs + 320]) expect(evaluatePiece(rule, t).sx).toBeCloseTo(EASES.outExpo(prog(t, cue.startMs - 40, 360)), 3);
    const word = cue.words[1]!;
    const plate = need<ShapePiece>(find(scene, "0:p1"));
    const left = evaluatePiece(plate, 1500).x;
    const width = widthOf(plate);
    for (const t of [word.startMs - 60, word.startMs, word.startMs + 120]) {
      expect(evaluatePiece(plate, t).clip!.x2).toBeCloseTo(left + EASES.outExpo(prog(t, word.startMs - 70, 260)) * width, 1);
    }
    // The word on it shares the plate's clip.
    expect(evaluatePiece(need<TextPiece>(find(scene, "0:t1")), word.startMs).clip).toEqual(evaluatePiece(plate, word.startMs).clip);
  });

  test("the column wipes away left to right in the 120 ms before end - 70 ms", () => {
    const cue = cues[0]!;
    const rule = need<ShapePiece>(find(scene, "0:rule"));
    const from = cue.endMs - 190;
    for (const t of [from, from + 60, from + 110]) {
      expect(evaluatePiece(rule, t).clip!.x1).toBeCloseTo(330 - 12 + EASES.in(prog(t, from, 120)) * (996 - 330 + 24), 1);
    }
    expect(rule.toMs).toBe(cue.endMs - 70);
  });

  test("fast speech: a word that lands inside the exit never inverts its clip", () => {
    const word = (text: string, startMs: number, role: "hero" | "body" = "body") => ({ text, startMs, endMs: startMs + 200, role, key: null });
    const tight: SceneCue[] = [{ index: 0, startMs: 0, endMs: 700, speaker: 0, language: "en", words: [word("fast", 0), word("words", 120), word("LATE", 200, "hero"), word("end", 560)] }];
    const list = build(tight);
    for (const piece of list) {
      for (let t = piece.fromMs; t < piece.toMs; t += 5) {
        const clip = evaluatePiece(piece, t).clip;
        if (clip) expect(clip.x2).toBeGreaterThanOrEqual(clip.x1 - 0.01);
      }
    }
  });
});

describe("Spine edge cases", () => {
  test("a right-to-left cue runs its plates right to left, right-aligned, wiped from the right", () => {
    const list = build(sceneEdgeDemo("urdu").cues);
    const plates = list.filter((piece): piece is ShapePiece => piece.kind === "shape" && /:p\d+$/.test(piece.id));
    const firstRow = plates.filter((plate) => evaluatePiece(plate, 4000).y === evaluatePiece(plates[0]!, 4000).y);
    const rightEdge = Math.max(...firstRow.map((plate) => evaluatePiece(plate, 4000).x + widthOf(plate)));
    expect(rightEdge).toBeCloseTo(996, 4);
    // The first spoken word is the rightmost plate.
    const byIndex = (index: number) => plates.find((plate) => plate.id.endsWith(`:p${index}`));
    const first = byIndex(Math.min(...plates.map((plate) => Number(plate.id.split(":p")[1]))))!;
    expect(evaluatePiece(first, 4000).x + widthOf(first)).toBeCloseTo(996, 4);
  });

  test("on a short canvas the hero shrinks to the room above its edge", () => {
    // 16:9 at twice the sample's size: the edge sits at 540 + 270 * 2 px, so the 500 px EDIT has 1026 px of room.
    const wide = build(cues, { canvas: { width: 1920, height: 1080 }, anchor: { xPct: 50, yPct: 50 }, scale: 2 });
    const hero = need<TextPiece>(find(wide, "3:hero"));
    const length = fakeMeasure("EDIT", "Archivo Black", hero.sizePx, -0.01).advance - 0.01 * hero.sizePx;
    expect(length).toBeLessThanOrEqual(540 + 270 * 2 - 0.05 * 1080 + 1);
    expect(hero.sizePx).toBeLessThan(250 * 2);
  });

  test("a plate wider than the column shrinks the cue's plates", () => {
    const long = build(sceneEdgeDemo("long-word").cues);
    const sizes = long.filter((piece): piece is TextPiece => piece.kind === "text" && /:t\d+$/.test(piece.id)).map((piece) => piece.sizePx);
    expect(Math.min(...sizes)).toBeLessThan(58);
  });
});
