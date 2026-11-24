import { describe, expect, test } from "bun:test";
import { captionColourContrast } from "@narriflow/validators";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo, SCENE_EDGE_DEMOS } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import type { SceneInput } from "./input";
import { evaluatePiece, type Piece, pieceBounds, SCENE_PIECE_BUDGET } from "./scene";
import { STRIKE_DEMO, strikeProgram } from "./templates/strike";
import { fakeMeasure, sceneInput } from "./test-support";

const colours = { primary: "#FFFFFF", highlight: "#3A2BE0", accent: "#FF3B4E", shadow: "#000000" };
const inputOverrides = { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours };

describeSpeechConformance("strike", strikeProgram, { anchorLineY: 1290, leadMs: 80 });

function build(lines: readonly string[], language: string = "en", overrides: Partial<SceneInput> = {}) {
  const { cues } = demoCues({ lines, language });
  const { pieces } = strikeProgram.build(sceneInput(cues, { ...inputOverrides, ...overrides }));
  const piece = (name: string): Piece => pieces.find(({ id }) => id === `strike:${name}`)!;
  return { cues, pieces, piece };
}

describe("Strike", () => {
  test("a shorter incoming lead preserves the outgoing reading hold", () => {
    const { cues } = demoCues({ lines: ["one@650", "two@350"], options: { lead: 350, cueGap: 200 } });
    const { pieces } = strikeProgram.build(sceneInput(cues, inputOverrides));
    expect(pieces.find(({ id }) => id === "strike:0:w0")!.toMs).toBe(1150);
    expect(pieces.find(({ id }) => id === "strike:1:w0")!.fromMs).toBe(1150);
  });

  test("future words wait as ghosts and light in place, with an expo wipe on the hero holder", () => {
    const { cues, piece } = build(STRIKE_DEMO.lines);
    const word = cues[0]!.words[3]!;
    const ghost = piece("0:w3ghost");
    const face = piece("0:w3");
    const hero = piece("0:w3box");
    const waiting = evaluatePiece(ghost, word.startMs - 150);
    expect(waiting.visible).toBe(true);
    expect(waiting.o).toBeCloseTo(0.34);
    expect(evaluatePiece(face, word.startMs - 150).visible).toBe(false);
    expect(evaluatePiece(face, face.fromMs)).toMatchObject({ x: waiting.x, y: waiting.y, o: waiting.o });
    expect(evaluatePiece(face, word.startMs).o).toBeGreaterThan(waiting.o);
    expect(evaluatePiece(face, word.startMs + 70).o).toBe(1);
    const tint = evaluatePiece(hero, word.startMs + 35);
    expect(tint.sx).toBeGreaterThan(0.9);
    expect(tint.o).toBeCloseTo(0.42);
    expect(evaluatePiece(hero, word.startMs + 190)).toMatchObject({ sx: 1, o: 1 });

    const progress = piece("0:progress");
    expect(evaluatePiece(progress, (cues[0]!.startMs + word.endMs) / 2).sy).toBeCloseTo(0.5, 1);
  });

  test("only English negations trigger a strike and an opaque, dimmer word", () => {
    const { cues, piece, pieces } = build(["it “DOESN’T,”@500 show nothingness again"], "eng");
    const spoken = cues[0]!.words[1]!;
    const face = piece("0:w1");
    const strike = piece("0:w1strike");
    expect(strike.fromMs).toBe(spoken.startMs);
    expect(evaluatePiece(strike, spoken.startMs + 80).sx).toBeGreaterThan(evaluatePiece(strike, spoken.startMs).sx);
    expect(evaluatePiece(strike, spoken.startMs + 250)).toMatchObject({ colour: colours.accent, sx: 1 });
    const dimmed = evaluatePiece(face, spoken.startMs + 280);
    expect(dimmed.colour).not.toBe(colours.primary);
    expect(dimmed.o).toBe(1);
    expect(pieces.filter(({ id }) => id.endsWith("strike")).map(({ id }) => id)).toEqual(["strike:0:w1strike"]);

    for (const language of ["es", "it", "ur", "auto"]) {
      expect(build(["no never not"], language).pieces.some(({ id }) => id.endsWith("strike"))).toBe(false);
    }
  });

  test("cycles the hero colours despite interleaved plain cues and keeps both rail beats recurring", () => {
    const lines = Array.from({ length: 27 }, (_, index) => (index % 2 === 0 ? "one spoken hero:h@500" : "we just speak"));
    const { cues, pieces, piece } = build(lines);
    expect(build(lines).pieces).toEqual(pieces);
    const boxes = pieces.filter(({ id }) => id.endsWith("box"));
    const palette = [colours.highlight, "#F59A1B", "#E8176B"];
    expect(boxes.map((box) => evaluatePiece(box, box.fromMs).colour)).toEqual(boxes.map((_, index) => palette[index % palette.length]!));
    for (const cue of cues) {
      const cuePieces = pieces.filter(({ id }) => id.startsWith(`strike:${cue.index}:`));
      const gate = piece(`${cue.index}:gate`);
      const pulse = piece(`${cue.index}:pulse0`);
      for (const beat of [gate, pulse]) {
        const times = exportFrameTimes(beat.fromMs, beat.toMs, 30);
        expect(times.length).toBeGreaterThanOrEqual(2);
        expect(evaluatePiece(beat, times.at(-1)!).sx).toBeGreaterThan(evaluatePiece(beat, times[0]!).sx);
      }
      expect(cuePieces.reduce((cost, item) => cost + 1 + (item.shadows?.length ?? 0), 0)).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
    }
    expect(evaluatePiece(piece("0:gate"), 400).y).toBeLessThan(evaluatePiece(piece("2:gate"), 3000).y);
  });

  test("rechecks the knockout against a branded box after the tint lands", () => {
    const { cues, piece } = build(["focus:h@500"], "en", { colours: { ...colours, primary: "#777777", highlight: "#85649A" } });
    const spoken = cues[0]!.words[0]!;
    const box = evaluatePiece(piece("0:w0box"), spoken.startMs + 210);
    const face = evaluatePiece(piece("0:w0"), spoken.startMs + 210);
    expect(box.colour).toBe("#85649A");
    expect(face.colour).toBe("#FFFFFF");
    expect(captionColourContrast(box.colour, face.colour)).toBeGreaterThanOrEqual(3);
  });

  test("the orange hero switches ink during the tint and stays readable on short words", () => {
    for (const duration of [100, 500]) {
      const { cues, piece } = build(["one:h@450", `two:h@${duration}`]);
      const word = cues[1]!.words[0]!;
      const painted = exportFrameTimes(word.startMs, word.endMs, 24);
      const at = duration === 100 ? painted.at(-1)! : word.startMs + 100;
      const face = evaluatePiece(piece("1:w0"), at);
      const box = evaluatePiece(piece("1:w0box"), at);
      expect(face.colour).toBe("#161008");
      expect(box.sx).toBeGreaterThan(0.96);
      expect(box.o).toBeGreaterThan(0.75);
    }
  });

  test("keeps each Urdu word whole, with the rail and box wipe mirrored", () => {
    const { cues } = sceneEdgeDemo("urdu");
    const { pieces } = strikeProgram.build(sceneInput(cues, inputOverrides));
    const face = (i: number) => pieces.find(({ id }) => id === `strike:0:w${i}`)!;
    const position = (p: Piece) => evaluatePiece(p, 500).x;
    expect(cues[0]!.words.map(({ text }, i) => {
      const piece = face(i);
      expect(piece).toMatchObject({ kind: "text", text, language: "ur", letterSpacingEm: 0 });
      return position(piece);
    })).toEqual([0, 1, 2, 3].map((i) => position(face(i))).sort((a, b) => b - a));
    const rail = pieces.find(({ id }) => id === "strike:0:rail")!;
    expect(position(rail)).toBeGreaterThan(position(face(0)));
    const box = pieces.find(({ id }) => id === "strike:0:w2box")!;
    const leftAt = (t: number) => pieceBounds(box, t, fakeMeasure)!.x1;
    expect(leftAt(box.fromMs + 130)).toBeLessThan(leftAt(box.fromMs));
  });

  test("all edge demos keep their ink and decorations inside the safe area", () => {
    for (const kind of SCENE_EDGE_DEMOS) {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
        const { cues } = sceneEdgeDemo(kind);
        const { pieces } = strikeProgram.build(sceneInput(cues, { ...inputOverrides, canvas }));
        for (const piece of pieces) {
          for (const frame of exportFrameTimes(piece.fromMs, piece.toMs)) {
            const bounds = pieceBounds(piece, frame, fakeMeasure);
            if (!bounds) continue;
            expect(bounds.x1, piece.id).toBeGreaterThanOrEqual(canvas.width * 0.05 - 1);
            expect(bounds.y1, piece.id).toBeGreaterThanOrEqual(canvas.height * 0.05 - 1);
            expect(bounds.x2, piece.id).toBeLessThanOrEqual(canvas.width * 0.95 + 1);
            expect(bounds.y2, piece.id).toBeLessThanOrEqual(canvas.height * 0.95 + 1);
          }
        }
      }
    }
  });
});
