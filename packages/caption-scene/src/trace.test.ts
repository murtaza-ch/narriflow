import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues } from "./demo";
import { type Piece, type ShapePiece, evaluatePiece } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";
import { TRACE_DEMO, traceProgram } from "./templates/trace";

describeSpeechConformance("trace", traceProgram, { anchorLineY: 1290 });

/** Devanagari ink hangs below the baseline (matras, tails) far past a Latin face's line box. */
const hindiMeasure: typeof fakeMeasure = (text, face, size, spacing) => {
  const base = fakeMeasure(text, face, size, spacing);
  return /[ऀ-ॿ]/.test(text) ? { ...base, inkTop: -0.9 * size, inkBottom: 0.45 * size } : base;
};
const build = (lines: string[], language: string, measure = fakeMeasure) =>
  traceProgram.build(sceneInput(demoCues({ lines, options: TRACE_DEMO.options, language }).cues, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, measure })).pieces;
const need = (pieces: readonly Piece[], id: string) => {
  const piece = pieces.find((candidate) => candidate.id === id);
  expect(piece).toBeDefined();
  return piece as ShapePiece;
};

describe("Trace", () => {
  test("the hero badge clears the row above's Devanagari ink and moves out beside the hero", () => {
    const hi = ["और:m अगर:b इसे:m सीधा:h"];
    const { cues } = demoCues({ lines: hi, options: TRACE_DEMO.options, language: "hi" });
    const t = cues[0]!.endMs - 60;
    // Distance from the badge centre down to the lowest measured ink of the body row above the hero.
    const clearance = (measure: typeof fakeMeasure) => {
      const pieces = build(hi, "hi", measure);
      const ink = pieces.filter((piece) => /^trace:0:w[012]$/.test(piece.id)).map((piece) => {
        const text = piece as { text: string; face: string; sizePx: number; letterSpacingEm: number };
        return evaluatePiece(piece, t).y + measure(text.text, text.face, text.sizePx, text.letterSpacingEm).inkBottom;
      });
      const badge = need(pieces, "trace:0:badge3");
      const star = need(pieces, "trace:0:star3");
      expect(evaluatePiece(star, t).y).toBe(evaluatePiece(badge, t).y);
      return { gap: evaluatePiece(badge, t).y - Math.max(...ink), x: evaluatePiece(badge, t).x };
    };
    const latin = clearance(fakeMeasure);
    const devanagari = clearance(hindiMeasure);
    // The badge (42 px radius at this scale) must hang entirely below that ink; without the overhang drop it would not (the 0.25 em, 150 px body, is the overhang).
    expect(devanagari.gap).toBeGreaterThanOrEqual(42);
    expect(devanagari.gap - 0.25 * 150).toBeLessThan(42);
    // The badge then sits beside the hero, not over its first letters.
    expect(devanagari.x).toBeGreaterThan(latin.x);
  });

  test("Latin ink leaves the badge on the hero's corner", () => {
    const lines = ["most:b rules:b are:m just:m fear:h"];
    expect(JSON.stringify(build(lines, "en", hindiMeasure))).toBe(JSON.stringify(build(lines, "en")));
  });
});
