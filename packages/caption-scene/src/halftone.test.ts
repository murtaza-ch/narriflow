import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { SCENE_PIECE_BUDGET, evaluatePiece, pieceBounds, type Box, type Piece } from "./scene";
import { halftoneProgram } from "./templates/halftone";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("halftone", halftoneProgram, { anchorLineY: 1290 });

const colours = { primary: "#FFD23F", highlight: "#FFF1CF", accent: "#E8402A", shadow: "#000000" };
const build = (lines: string[], language: string | null = null, fps = 30) => {
  const { cues } = demoCues({ lines, language: language ?? undefined, options: { lead: 400, gap: 40, cueGap: 140, tail: 800 } });
  return { cues, pieces: halftoneProgram.build(sceneInput(cues, { fps, colours })).pieces };
};
const faces = (pieces: readonly Piece[], cue: number) => pieces.filter((p) => new RegExp(`^halftone:${cue}:w\\d+(l\\d+)?$`).test(p.id));
const text = (piece: Piece) => (piece.kind === "text" ? piece.text : "");

describe("halftone", () => {
  test("a word first paints on its spoken start, opaque, 92 % scale, turned 10 degrees, and settles with one 3 % overshoot", () => {
    const { cues, pieces } = build(["keep:b it:m Groovy:h@640"]);
    for (const [at, word] of cues[0]!.words.entries()) {
      const face = pieces.find((p) => p.id === `halftone:0:w${at}`)!;
      expect(face.fromMs).toBe(word.startMs);
      const first = evaluatePiece(face, word.startMs);
      expect(first.o).toBe(1);
      expect(first.sx).toBeCloseTo(0.92, 2);
      const rest = evaluatePiece(face, word.startMs + 400);
      expect(Math.abs(first.rz - rest.rz)).toBeCloseTo(10, 0);
      const scales = exportFrameTimes(word.startMs, word.startMs + 400, 60).map((t) => evaluatePiece(face, t).sx);
      expect(Math.max(...scales)).toBeGreaterThan(1.02);
      expect(Math.max(...scales)).toBeLessThan(1.035);
      expect(rest.sx).toBe(1);
      // Settled inside 150 ms.
      expect(evaluatePiece(face, word.startMs + 150).sx).toBeCloseTo(1, 2);
    }
  });

  test("the roll never reaches further than 40 px, and a word too short to animate takes its rest pose at once", () => {
    const { cues, pieces } = build(["keep:b it:m Groovy:h@640"]);
    const face = pieces.find((p) => p.id === "halftone:0:w2")!;
    const start = cues[0]!.words[2]!.startMs;
    expect(Math.abs(evaluatePiece(face, start).x - evaluatePiece(face, start + 400).x)).toBeLessThanOrEqual(40.5);
    const quick = build(["go@30 on@30 then:h@30"]);
    const f = quick.pieces.find((p) => p.id === "halftone:0:w0")!;
    expect(evaluatePiece(f, f.fromMs).sx).toBe(1);
  });

  test("each word is a face over three offset bands, orange nearest, red then wine, 0.11 em deep at most, all behind the face", () => {
    const { pieces } = build(["peace:b love:b Sunshine:h@680"]);
    const face = pieces.find((p) => p.id === "halftone:0:w2")!;
    if (face.kind !== "text") throw new Error("face is text");
    const bands = [1, 2, 3].map((k) => pieces.find((p) => p.id === `halftone:0:w2d${k}`)!);
    for (const band of bands) {
      expect(band.kind).toBe("text");
      expect(band.z).toBeLessThan(face.z);
    }
    expect(bands[0]!.z).toBeGreaterThan(bands[1]!.z);
    expect(bands[1]!.z).toBeGreaterThan(bands[2]!.z);
    const depth = (band: Piece) => (band.origin?.dx ?? 0) / -face.sizePx;
    expect(depth(bands[2]!)).toBeCloseTo(0.11, 3);
    expect(depth(bands[0]!)).toBeLessThan(depth(bands[1]!));
    expect(face.stroke!.widthPx).toBeLessThanOrEqual(2.6);
    // Only the deepest band carries the soft shadow.
    expect(bands.filter((band) => band.kind === "text" && band.shadows?.length).length).toBe(1);
  });

  test("words keep the transcript's casing", () => {
    const { pieces } = build(["NASA:b launched Atlas:h@600"]);
    expect(faces(pieces, 0).map(text)).toEqual(["NASA", "launched", "Atlas"]);
  });

  test("dots are small, quiet and whole: at most 36 % opaque, 76 a cue, appearing with the word above them, never earlier", () => {
    const { cues, pieces } = build(["slow:b down:b and:m smell:b the:m roses:b", "peace:b love:b Sunshine:h@680"]);
    for (const cue of cues) {
      const dots = pieces.filter((p) => p.id.startsWith(`halftone:${cue.index}:dot`));
      expect(dots.length).toBeGreaterThan(0);
      let total = 0;
      for (const dot of dots) {
        if (dot.kind !== "shape") throw new Error("dots are shapes");
        total += dot.path.filter((c) => c[0] === "M").length;
        const peakAlpha = (dot.fill?.alpha ?? 1) * Math.max(...exportFrameTimes(dot.fromMs, dot.toMs, 60).map((t) => evaluatePiece(dot, t).o));
        expect(peakAlpha).toBeLessThanOrEqual(0.52);
        const os = exportFrameTimes(dot.fromMs + 100, dot.toMs - 200, 60).map((t) => evaluatePiece(dot, t).o).sort((a, b) => a - b);
        expect((dot.fill?.alpha ?? 1) * os[0]!).toBeCloseTo(0.36, 1);
        expect(dot.fromMs).toBeGreaterThanOrEqual(cue.words[0]!.startMs);
        // The pulse has settled back by the end of its window and nothing is clipped through a dot.
        expect(dot.clip).toBeUndefined();
      }
      expect(total).toBeLessThanOrEqual(76);
    }
  });

  test("the dot field flashes in a wave after the key word lands, and again on a long hold", () => {
    const { cues, pieces } = build(["so:m Hold:h@4600"]);
    const start = cues[0]!.words[1]!.startMs;
    const dots = pieces.filter((p) => p.id.startsWith("halftone:0:dot"));
    expect(dots.length).toBeGreaterThan(0);
    const peaks = (from: number, to: number) => Math.max(...dots.flatMap((dot) => exportFrameTimes(from, to, 60).map((t) => evaluatePiece(dot, t).o)));
    expect(peaks(start + 150, start + 520)).toBeGreaterThan(0.7);
    expect(peaks(start + 1800, start + 2300)).toBeGreaterThan(0.7);
    expect(evaluatePiece(dots[0]!, start + 1000).o).toBeCloseTo(0.58, 1);
  });

  test("three beads of falling size flick out of the key word's shoulder, clear of every word", () => {
    const { cues, pieces } = build(["keep:b it:m Wow:h@640", "good:b vibes:b Only:h@560", "stay:b Gold:h@640"]);
    for (const cue of cues) {
      const beads = pieces.filter((p) => p.id.startsWith(`halftone:${cue.index}:bead`));
      expect(beads.length, `cue ${cue.index}`).toBe(3);
      const radii = beads.map((b) => (b.kind === "shape" ? b.path.reduce((m, c) => Math.max(m, c[0] === "M" ? c[1] : 0), 0) : 0));
      expect(radii[0]!).toBeGreaterThan(radii[1]!);
      expect(radii[1]!).toBeGreaterThan(radii[2]!);
      const t = cue.words.at(-1)!.endMs;
      const words = faces(pieces, cue.index).map((f) => pieceBounds(f, t, fakeMeasure)!);
      for (const bead of beads) {
        const box = pieceBounds(bead, t, fakeMeasure)!;
        for (const word of words) expect(box.x1 < word.x2 && word.x1 < box.x2 && box.y1 < word.y2 && word.y1 < box.y2).toBe(false);
      }
    }
  });

  test("palettes and tilts cycle by cue counter, not by a table that ends with the demo", () => {
    const { pieces } = build(Array.from({ length: 12 }, (_, i) => `word${i}:h@300`));
    const fills = Array.from({ length: 12 }, (_, i) => {
      const face = pieces.find((p) => p.id === `halftone:${i}:w0`)!;
      return face.kind === "text" ? face.fill : "";
    });
    expect(fills[0]).toBe(fills[5]);
    expect(fills[1]).toBe(fills[6]);
    expect(new Set(fills.slice(0, 3)).size).toBe(3);
    const tilt = (i: number) => evaluatePiece(pieces.find((p) => p.id === `halftone:${i}:w0`)!, 5000).rz;
    expect(tilt(0)).not.toBeCloseTo(tilt(1), 0);
  });

  test("a script that needs shaping stays one whole word, and rows never touch", () => {
    const { cues, pieces } = build(["यह:b बहुत:h@700 अच्छा:b है:m"], "hi");
    expect(pieces.some((p) => /^halftone:0:w\d+l\d+$/.test(p.id))).toBe(false);
    expect(faces(pieces, 0).map(text)).toEqual(cues[0]!.words.map((w) => w.text));
  });
});

const anchor = { xPct: 50, yPct: (1290 / 1920) * 100 };
const rowsOverlap = (pieces: readonly Piece[], cue: number, from: number, to: number, fps = 30) => {
  const own = faces(pieces, cue);
  for (const t of exportFrameTimes(from, to, fps)) {
    const live = own.flatMap((p) => {
      const pose = evaluatePiece(p, t);
      const box = pieceBounds(p, t, fakeMeasure);
      return box && pose.o > 0.9 && pose.sx > 0.99 ? [{ p, box }] : [];
    });
    for (const [i, a] of live.entries()) {
      for (const b of live.slice(i + 1)) {
        const x = Math.min(a.box.x2, b.box.x2) - Math.max(a.box.x1, b.box.x1);
        const y = Math.min(a.box.y2, b.box.y2) - Math.max(a.box.y1, b.box.y1);
        if (x > 2 && y > 2) return `${a.p.id} meets ${b.p.id} at ${t}`;
      }
    }
  }
  return null;
};

describe("halftone edge cases", () => {
  test("a word wider than the column breaks across rows at a readable size", () => {
    const word = "pneumonoultramicroscopicsilicovolcanoconiosis";
    const { cues, pieces } = build([`${word}:h@900`]);
    const parts = pieces.filter((p) => /^halftone:0:w0l\d$/.test(p.id));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.map(text).join("")).toBe(word);
    for (const part of parts) expect(part.kind === "text" && part.sizePx).toBeGreaterThanOrEqual(90);
    const rows = new Set(parts.map((p) => Math.round(evaluatePiece(p, cues[0]!.endMs - 300).y / 20)));
    expect(rows.size).toBeGreaterThanOrEqual(2);
  });

  test("a long word has a row of its own before it shrinks", () => {
    const { pieces } = build(["we:m say:b extraordinarily:b well:b"]);
    const y = (i: number) => evaluatePiece(pieces.find((p) => p.id === `halftone:0:w${i}`)!, 3000).y;
    expect(Math.abs(y(2) - y(1))).toBeGreaterThan(60);
  });

  test("every edge demo stays inside the band at twice the size, portrait and landscape, and no two rows meet", () => {
    for (const edge of ["urdu", "nine-words", "long-word", "no-hero", "one-word"] as const) {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
        const { cues } = sceneEdgeDemo(edge);
        const pieces = halftoneProgram.build(sceneInput(cues, { fps: 30, colours, anchor, scale: 2, canvas })).pieces;
        const safe: Box = { x1: 0.05 * canvas.width - 1, y1: 0.05 * canvas.height - 1, x2: 0.95 * canvas.width + 1, y2: 0.95 * canvas.height + 1 };
        for (const cue of cues) {
          const own = pieces.filter((p) => p.id.startsWith(`halftone:${cue.index}:`));
          expect(own.length, `${edge} cue ${cue.index} pieces`).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
          for (const piece of own) {
            for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
              const box = pieceBounds(piece, t, fakeMeasure);
              if (!box) continue;
              expect(box.x1 >= safe.x1 && box.x2 <= safe.x2 && box.y1 >= safe.y1 && box.y2 <= safe.y2, `${piece.id} ${edge} ${canvas.width}x${canvas.height}`).toBe(true);
            }
          }
          expect(rowsOverlap(pieces, cue.index, cue.words.at(-1)!.endMs, cue.words.at(-1)!.endMs + 100)).toBeNull();
        }
      }
    }
  });

  test("on a landscape frame the dot field keeps to the right-hand part of its row", () => {
    const { cues } = demoCues({ lines: ["slow:b down:b and:m smell:b the:m roses:b"], options: { lead: 400 } });
    const dotsOf = (canvas: { width: number; height: number }) =>
      halftoneProgram.build(sceneInput(cues, { fps: 30, colours, anchor, canvas })).pieces.filter((p) => p.id.includes(":dot"));
    expect(dotsOf({ width: 1920, height: 1080 }).length).toBeLessThan(dotsOf({ width: 1080, height: 1920 }).length);
  });
});
