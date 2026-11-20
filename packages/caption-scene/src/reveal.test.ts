import { describe, expect, test } from "bun:test";
import { demoCues } from "./demo";
import { REVEAL_DEMO, revealProgram, revealRisePercent } from "./templates/reveal";
import { evaluatePiece, type TextPiece } from "./scene";
import { sceneInput } from "./test-support";

const { cues } = demoCues(REVEAL_DEMO);
const scene = revealProgram.build(sceneInput(cues));
const texts = scene.pieces.filter((piece): piece is TextPiece => piece.kind === "text");
const cueOf = (piece: { id: string }) => cues[Number(piece.id.split(":")[1])]!;

describe("Reveal", () => {
  test("a word per piece and nothing else: no hairline between the lead and the hero", () => {
    expect(texts).toHaveLength(cues.reduce((sum, cue) => sum + cue.words.length, 0));
    expect(scene.pieces).toHaveLength(texts.length);
  });

  test("the hero is the big italic serif in the highlight colour, body words the semibold sans", () => {
    const talent = texts.find((piece) => piece.text === "talent")!;
    const about = texts.find((piece) => piece.text === "about" && piece.id.startsWith("reveal:1"))!;
    expect(talent).toMatchObject({ face: "Instrument Serif", fill: "#FFE9A8", sizePx: 236, letterSpacingEm: -0.02 });
    expect(about).toMatchObject({ face: "Inter Tight SemiBold", fill: "#FFFFFF", sizePx: 72, letterSpacingEm: -0.015 });
    // A cue without a hero is one larger row.
    expect(texts.find((piece) => piece.text === "think")!.sizePx).toBe(96);
  });

  test("each word rises with the sample's own curve: 150 % of its height below the slit, out through the top", () => {
    for (const piece of texts) {
      const cue = cueOf(piece);
      const word = cue.words[Number(piece.id.split(":w")[1])]!;
      const size = piece.sizePx;
      const hero = piece.sizePx > 200;
      // The rest position is whatever remains once the sample's rise is taken out at any one time.
      const rest = evaluatePiece(piece, word.startMs).y - (revealRisePercent(word.startMs, word.startMs, hero, cue.endMs) / 100) * size;
      for (const t of [word.startMs - 70, word.startMs, word.startMs + 150, word.startMs + 300, cue.endMs - 190, cue.endMs - 100, cue.endMs - 10]) {
        const y = evaluatePiece(piece, t).y;
        const expected = rest + (revealRisePercent(t, word.startMs, hero, cue.endMs) / 100) * size;
        // Overlapping enter and exit windows add; the rest position is read where neither moves.
        expect(Math.abs(y - expected)).toBeLessThan(0.51);
      }
    }
  });

  test("the hero tips five degrees as it rises and lands upright", () => {
    const talent = texts.find((piece) => piece.text === "talent")!;
    expect(evaluatePiece(talent, 2446 - 70).rz).toBeCloseTo(5, 6);
    expect(evaluatePiece(talent, 2446 - 70 + 620).rz).toBeCloseTo(0, 6);
    expect(texts.find((piece) => piece.text === "about")!.track.rz).toBeUndefined();
  });

  test("a word shows only through its fixed slit: a clip in canvas px that does not move", () => {
    for (const piece of texts) {
      const a = evaluatePiece(piece, piece.fromMs + 10).clip!;
      const b = evaluatePiece(piece, piece.toMs - 10).clip!;
      expect(a).toEqual(b);
      expect(a.x2 - a.x1).toBeGreaterThan(piece.sizePx * 0.24);
      expect(a.y2 - a.y1).toBeGreaterThan(piece.sizePx * 1.2);
    }
  });

  test("the hero row sits straight under the lead row, where the sample's rule (10 px gap + 3 px) was", () => {
    const talent = texts.find((piece) => piece.text === "talent")!;
    const lead = texts.find((piece) => piece.text === "about" && piece.id.startsWith("reveal:1"))!;
    // With the rule the baselines were 165.72 px apart (fake measure); the 13 px it took are gone, the block still centred.
    expect(evaluatePiece(talent, 3000).y - evaluatePiece(lead, 3000).y).toBeCloseTo(165.72 - 13, 1);
  });

  test("a longer cue wraps its lead evenly and a very long hero shrinks to fit, never leaving the canvas", () => {
    const long = demoCues({ lines: ["so:m the:m real:b reason:b most:b people:b never:b get:b there:b antidisestablishmentarianism:h@900"] }).cues;
    const wide = revealProgram.build(sceneInput(long));
    const sizes = new Set(wide.pieces.filter((piece): piece is TextPiece => piece.kind === "text").map((piece) => piece.sizePx));
    expect(Math.min(...sizes)).toBeLessThanOrEqual(72);
    expect(Math.max(...sizes)).toBeLessThan(236);
    const ys = new Set(wide.pieces.filter((piece): piece is TextPiece => piece.kind === "text" && piece.sizePx <= 72).map((piece) => Math.round(evaluatePiece(piece, 1500).y)));
    expect(ys.size).toBeGreaterThan(1);
  });
});
