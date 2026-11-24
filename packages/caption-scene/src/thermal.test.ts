import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import type { SceneInput } from "./input";
import { SCENE_PIECE_BUDGET, type ShapePiece, type TextPiece, evaluatePiece, pieceBounds } from "./scene";
import { thermalProgram } from "./templates/thermal";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("thermal", thermalProgram, { anchorLineY: 1290 });

const colours = { primary: "#FFFFFF", highlight: "#FF6A1A", accent: "#4C5BFF", shadow: "#000000" };

function build(lines: string[], overrides?: Partial<SceneInput>) {
  const { cues } = demoCues({ lines });
  return thermalProgram.build(sceneInput(cues, { colours, ...overrides })).pieces;
}

describe("Thermal", () => {
  test("blue heat warms before the white core lands and a hero keeps a hotter halo", () => {
    const pieces = build(["turn:b@240 heat:h@520"]);
    const body = pieces.find((piece) => piece.id === "thermal:0:w0")!;
    const cold = pieces.find((piece) => piece.id === "thermal:0:w0:halo")!;
    const hot = pieces.find((piece) => piece.id === "thermal:0:w1l0:halo")!;
    const letters = pieces.filter((piece): piece is TextPiece => piece.kind === "text" && /^thermal:0:w1l\d+$/.test(piece.id));
    expect(evaluatePiece(cold, cold.fromMs).colour).toBe(colours.accent);
    expect(cold.track.colour?.some(([, colour]) => colour === colours.highlight)).toBe(true);
    expect(cold.fromMs).toBeLessThan(body.fromMs);
    expect(evaluatePiece(cold, cold.fromMs).blur).toBeGreaterThan(evaluatePiece(cold, cold.fromMs + 150).blur);
    expect(evaluatePiece(body, 450)).toMatchObject({ colour: colours.primary, o: 1, blur: 0 });
    expect(letters.map((piece) => piece.text).join("")).toBe("heat");
    expect(letters.at(-1)!.fromMs).toBeGreaterThan(letters[0]!.fromMs);
    expect(evaluatePiece(hot, 1050)).toMatchObject({ colour: "#FF7F26", visible: true });
    expect(evaluatePiece(cold, 1050)).toMatchObject({ colour: colours.accent, o: 0.38 });
  });

  test("joined words stay whole and the sweep mirrors for a Latin hero in RTL speech", () => {
    const { cues } = demoCues({ lines: ["یہ:m بہت:b اچھا:h@600 ہے:m", "آگ:b Heat:h@600 میں:m"], language: "ur" });
    const { pieces } = thermalProgram.build(sceneInput(cues, { colours }));
    const whole = pieces.find((piece) => piece.kind === "text" && piece.id === "thermal:0:w2");
    expect(whole).toMatchObject({ text: "اچھا", language: "ur", letterSpacingEm: 0 });
    const mirror = pieces.filter((piece): piece is TextPiece => piece.kind === "text" && /^thermal:1:w1l\d+$/.test(piece.id));
    expect(mirror.map((piece) => piece.text)).toEqual(["t", "a", "e", "H"]);
    expect(evaluatePiece(mirror[0]!, mirror[0]!.fromMs).x).toBeGreaterThan(evaluatePiece(mirror.at(-1)!, mirror.at(-1)!.fromMs).x);
    const otherScripts = build(["夜景:h", "नमस्ते:h", "١٢٣:h", "👩‍💻:h"]);
    for (const [at, text] of ["夜景", "नमस्ते", "١٢٣", "👩‍💻"].entries()) {
      expect(otherScripts.find((piece) => piece.id === `thermal:${at}:w0`)).toMatchObject({ text, letterSpacingEm: 0 });
    }
  });

  test("both accents recur on two dozen cues with separate variants for hero and body cues", () => {
    const lines = Array.from({ length: 24 }, (_, at) => at % 2 ? "stay:b@210 cool:b@400" : "turn:b@210 heat:h@400");
    const pieces = build(lines);
    expect(pieces.filter((piece) => piece.id.endsWith(":ignition"))).toHaveLength(lines.length);
    expect(pieces.filter((piece) => piece.id.endsWith(":ember"))).toHaveLength(lines.length);
    const embers = pieces.filter((piece): piece is ShapePiece => piece.kind === "shape" && piece.id.endsWith(":ember"));
    expect(embers.slice(0, 5).map((piece) => piece.fill?.colour)).toEqual(["#FFC24A", "#FFC24A", colours.highlight, colours.highlight, "#FFC24A"]);
    const starts = embers.slice(0, 5).map((piece) => evaluatePiece(piece, piece.fromMs).x);
    expect(new Set(starts).size).toBeGreaterThan(2);
    expect(build(lines)).toEqual(pieces);
  });

  test("150 ms words with 60 ms gaps animate and a long final tail has room to cool", () => {
    for (const fps of [24, 25, 30, 60]) {
      const { cues } = demoCues({ lines: ["warm:b@150", "up:b@150 heat:h@100"], options: { lead: 357, gap: 0, cueGap: 60 } });
      const { pieces } = thermalProgram.build(sceneInput(cues, { fps, colours }));
      const first = pieces.find((piece) => piece.id === "thermal:0:w0")!;
      const next = pieces.find((piece) => piece.id === "thermal:1:w0")!;
      for (const piece of [first, next]) {
        const frames = exportFrameTimes(piece.fromMs, piece.toMs, fps);
        expect(evaluatePiece(piece, frames[0]!).blur).toBeGreaterThan(evaluatePiece(piece, frames[1]!).blur);
      }
      const last = cues[1]!;
      expect(evaluatePiece(next, last.endMs - 150).o).toBe(1);
      expect(evaluatePiece(next, last.endMs - 30).o).toBeLessThan(0.5);
    }
  });

  test("a long split hero keeps every character without spending a layer per letter", () => {
    const text = "extraordinarily".repeat(10);
    const pieces = build([`stay:b ${text}:h@900 cool:b`]);
    const parts = pieces.filter((piece): piece is TextPiece => piece.kind === "text" && /^thermal:0:w1l\d+$/.test(piece.id));
    expect(parts.map((piece) => piece.text).join("")).toBe(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThan(text.length);
    expect(pieces.length).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
  });

  test("the accents fit between words when the cue mixes directions", () => {
    const pieces = build(["stay:b@240 cool:b@240 بہت:b@240", "آگ:b@240 بہت:b@240 bright:b@240", "זה:b@240 מדליק:b@240 light:b@240"]);
    const faces = pieces.filter((piece) => /^thermal:\d+:w\d+$/.test(piece.id));
    for (const accent of pieces.filter((piece) => piece.kind === "shape")) {
      for (const time of exportFrameTimes(accent.fromMs, accent.toMs)) {
        const shape = pieceBounds(accent, time, fakeMeasure);
        if (!shape) continue;
        for (const face of faces) {
          const ink = pieceBounds(face, time, fakeMeasure);
          if (!ink) continue;
          expect(ink.x2 <= shape.x1 || shape.x2 <= ink.x1 || ink.y2 <= shape.y1 || shape.y2 <= ink.y1).toBe(true);
        }
      }
    }
  });
});
