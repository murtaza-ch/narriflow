import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import type { SceneCue } from "./input";
import { type Box, evaluatePiece, pieceBounds } from "./scene";
import { rippleProgram } from "./templates/ripple";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("ripple", rippleProgram, { anchorLineY: 1290 });

const colours = { primary: "#FFFFFF", highlight: "#FF6FB8", accent: "#6EF2FF", shadow: "#000000" };

const build = (lines: string[], language: string | null = null) => {
  const { cues } = demoCues({ lines, language: language ?? undefined, options: { lead: 400, gap: 30, cueGap: 140, tail: 800 } });
  return { cues, pieces: rippleProgram.build(sceneInput(cues, { fps: 30, colours })).pieces };
};

describe("ripple", () => {
  test("draws no row of dots, and no shape is a small flat circle", () => {
    const { pieces } = build(["feel:b the:m wave:h@700", "just:m breathe:b"]);
    expect(pieces.some((piece) => piece.id.includes("dot"))).toBe(false);
    // The only shapes are the water rings: stroked outlines, never filled discs.
    for (const piece of pieces.filter((p) => p.kind === "shape")) {
      expect(piece.id).toMatch(/:ring\d-\d$/);
      expect(piece.kind === "shape" && piece.fill).toBeFalsy();
    }
  });

  test("the key word's letters wave left to right, each flashing cyan at the crest and settling in the key colour", () => {
    const { pieces } = build(["feel:b the:m wave:h@700"]);
    const letters = pieces.filter((piece) => /^ripple:0:w2l\d$/.test(piece.id));
    expect(letters.map((piece) => piece.kind === "text" && piece.text).join("")).toBe("wave");
    const starts = letters.map((piece) => piece.fromMs);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(new Set(starts).size).toBe(4);
    for (const piece of letters) {
      const rest = evaluatePiece(piece, piece.fromMs + 2000);
      const first = evaluatePiece(piece, piece.fromMs);
      expect(first.colour).toBe("#6EF2FF");
      expect(rest.colour).toBe("#FF6FB8");
      // Rises above its rest line during the wave.
      const lift = Math.min(...exportFrameTimes(piece.fromMs, piece.fromMs + 700, 60).map((t) => evaluatePiece(piece, t).y));
      expect(evaluatePiece(piece, piece.fromMs + 2000).y - lift).toBeGreaterThan(10);
    }
  });

  test("the wave is smooth: no frame to frame jump in a letter's height or scale", () => {
    const { pieces } = build(["so:m feel:b the:m wave:h@700"]);
    for (const piece of pieces.filter((p) => /^ripple:0:w3l\d$/.test(p.id))) {
      const ys = exportFrameTimes(piece.fromMs, piece.toMs, 60).map((t) => evaluatePiece(piece, t).y);
      const steps = ys.slice(1).map((y, i) => Math.abs(y - ys[i]!));
      // 60 fps: the crest moves a few px per frame, never a jump.
      expect(Math.max(...steps)).toBeLessThan(12);
    }
  });

  test("a script that cannot be split into letters waves as one whole word", () => {
    const { pieces } = build(["यह:b बहुत:h@700"], "hi");
    expect(pieces.filter((piece) => /^ripple:0:w1l\d$/.test(piece.id))).toHaveLength(0);
    const whole = pieces.find((piece) => piece.id === "ripple:0:w1")!;
    expect(whole).toBeDefined();
    const lift = Math.min(...exportFrameTimes(whole.fromMs, whole.fromMs + 700, 60).map((t) => evaluatePiece(whole, t).y));
    expect(evaluatePiece(whole, whole.fromMs + 2500).y - lift).toBeGreaterThan(10);
  });

  test("every cue spreads water rings, with or without a key word, and a key-less cue's last word rides its own small wave", () => {
    const { pieces } = build(["feel:b the:m wave:h@700", "it:m carries:b you:b", "just:m breathe:b"]);
    for (const index of [0, 1, 2]) {
      expect(pieces.filter((piece) => piece.id.startsWith(`ripple:${index}:ring0-`)).length).toBeGreaterThanOrEqual(2);
    }
    // No key word: the last word rides a small wave whole (never split into letters); the words before it stay whole too.
    expect(pieces.some((piece) => /^ripple:1:w2l\d$/.test(piece.id))).toBe(false);
    expect(pieces.some((piece) => piece.id === "ripple:1:w2")).toBe(true);
    expect(pieces.some((piece) => piece.id === "ripple:1:w0")).toBe(true);
  });

  test("the key word's wave reaches the words before it, which swell once and settle", () => {
    const { cues, pieces } = build(["feel:b the:m wave:h@700"]);
    const lead = pieces.find((piece) => piece.id === "ripple:0:w0")!;
    const heroStart = cues[0]!.words[2]!.startMs;
    const rest = evaluatePiece(lead, heroStart - 200).y;
    const swell = Math.min(...exportFrameTimes(heroStart, heroStart + 900, 60).map((t) => evaluatePiece(lead, t).y));
    expect(rest - swell).toBeGreaterThan(3);
    expect(evaluatePiece(lead, heroStart + 1400).y).toBeCloseTo(rest, -1);
  });

  test("rows follow speech: words before the key word sit above it, words after it below", () => {
    const { pieces } = build(["we:m didn't:h@700 want:b"]);
    const at = 700;
    const y = (id: string) => evaluatePiece(pieces.find((piece) => piece.id.startsWith(id))!, at + 1500).y;
    expect(y("ripple:0:w0")).toBeLessThan(y("ripple:0:w1"));
    expect(y("ripple:0:w1")).toBeLessThan(y("ripple:0:w2"));
  });

  test("a long hold keeps spreading rings, a short one does not", () => {
    const long = build(["hold:h@4200"]);
    const short = build(["hold:h@400"]);
    const bursts = (pieces: ReturnType<typeof build>["pieces"]) => new Set(pieces.filter((p) => p.id.includes(":ring")).map((p) => p.id.split(":ring")[1]![0]!)).size;
    expect(bursts(long.pieces)).toBeGreaterThan(bursts(short.pieces));
  });
});

const anchor = { xPct: 50, yPct: (1290 / 1920) * 100 };
const inkBox = (pieces: ReturnType<typeof build>["pieces"], cue: number, from: number, to: number, canvas: { width: number; height: number }, fps = 30) => {
  let box: Box | null = null;
  for (const t of exportFrameTimes(from, to, fps)) {
    for (const piece of pieces) {
      if (piece.kind !== "text" || !piece.id.startsWith(`ripple:${cue}:w`)) continue;
      const b = pieceBounds(piece, t, fakeMeasure);
      if (!b || evaluatePiece(piece, t).o < 0.5) continue;
      box = box ? { x1: Math.min(box.x1, b.x1), y1: Math.min(box.y1, b.y1), x2: Math.max(box.x2, b.x2), y2: Math.max(box.y2, b.y2) } : b;
    }
  }
  expect(box).not.toBeNull();
  expect(canvas.width).toBeGreaterThan(0);
  return box as unknown as Box;
};

describe("ripple review fixes", () => {
  test("a word wider than the column breaks across rows at a readable size", () => {
    const word = "pneumonoultramicroscopicsilicovolcanoconiosis";
    const { cues, pieces } = build([`${word}:h@900`]);
    const parts = pieces.filter((piece) => /^ripple:0:w0l\d$/.test(piece.id));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(word);
    for (const piece of parts) expect(piece.kind === "text" && piece.sizePx).toBeGreaterThanOrEqual(90);
    const rows = new Set(parts.map((piece) => Math.round(evaluatePiece(piece, cues[0]!.endMs - 300).y)));
    expect(rows.size).toBe(parts.length);
  });

  test("a cue stays inside the caption band at twice the size, portrait and landscape", () => {
    for (const edge of ["urdu", "nine-words", "long-word"] as const) {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
        const { cues } = sceneEdgeDemo(edge);
        const pieces = rippleProgram.build(sceneInput(cues, { fps: 30, colours, anchor, scale: 2, canvas })).pieces;
        const natural = Math.min(canvas.width, canvas.height) / 1080;
        const ay = (anchor.yPct / 100) * canvas.height;
        const y1 = Math.max(0.05 * canvas.height, ay - 430 * natural) - 2;
        const y2 = Math.min(0.95 * canvas.height, ay + 360 * natural) + 2;
        for (const cue of cues) {
          const box = inkBox(pieces, cue.index, cue.startMs, cue.endMs, canvas);
          // Ink at rest, not the crest's reach: the rows themselves sit in the band.
          expect(box.y2, `${edge} ${canvas.width}x${canvas.height} cue ${cue.index} bottom`).toBeLessThanOrEqual(y2 + 60 * natural);
          expect(box.y1, `${edge} ${canvas.width}x${canvas.height} cue ${cue.index} top`).toBeGreaterThanOrEqual(y1 - 60 * natural);
        }
      }
    }
  });

  test("two speakers' identical key words come out at comparable sizes", () => {
    const a = demoCues({ lines: ["extraordinary:b@300 responsibilities:b@300 really:h@1900 interdisciplinary:b@500 internationally:b@1100"] }).cues[0]!;
    const b = demoCues({ lines: ["really:h@2100"], options: { lead: 1200, tail: 500 } }).cues[0]!;
    const cues: SceneCue[] = [a, { ...b, index: 1 }];
    const canvas = { width: 1920, height: 1080 };
    const pieces = rippleProgram.build(sceneInput(cues, { fps: 30, colours, anchor, scale: 2, canvas })).pieces;
    const size = (cue: number, word: number) => {
      const piece = pieces.find((p) => new RegExp(`^ripple:${cue}:w${word}(l0)?$`).test(p.id))!;
      return piece.kind === "text" ? piece.sizePx : 0;
    };
    const ratio = size(1, 0) / size(0, 2);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.7);
  });

  test("a cue too fast to animate a ring still paints one, at every export frame rate", () => {
    const lines = Array.from({ length: 8 }, (_, i) => ["we:m@70 go:b@90", "extraordinary:h@70", "first:b@70 last:b@70", "extraordinary:h@120"][i % 4]!);
    for (const fps of [24, 25, 30, 60]) {
      const { cues } = demoCues({ lines, options: { gap: 0, cueGap: 0, lead: 401, tail: 180 } });
      const pieces = rippleProgram.build(sceneInput(cues, { fps, colours })).pieces;
      const missing = cues.filter((cue) => {
        const faces = pieces.filter((piece) => piece.id.startsWith(`ripple:${cue.index}:w`));
        const from = Math.min(...faces.map((piece) => piece.fromMs));
        const to = Math.max(...faces.map((piece) => piece.toMs));
        // A cue that paints on a single export frame cannot hold a two-frame decoration (the brief forbids one-frame motion).
        if (exportFrameTimes(from, to, fps).length < 2) return false;
        return !pieces.some((piece) => piece.id.startsWith(`ripple:${cue.index}:ring`) && exportFrameTimes(piece.fromMs, piece.toMs, fps).filter((t) => evaluatePiece(piece, t).o >= 0.2).length >= 2);
      });
      expect(missing.map((cue) => cue.index), `fps ${fps}`).toEqual([]);
    }
  });

  test("the rings sit below every word of the cue, never behind or through a glyph", () => {
    const { cues, pieces } = build(["it's:b time:b to:m say:b goodbye:h@900", "the:m remote:b doesn't:h@900 work:b", "just:m breathe:b"]);
    for (const cue of cues) {
      const t = cue.endMs - 250;
      const faces = pieces.filter((piece) => piece.kind === "text" && piece.id.startsWith(`ripple:${cue.index}:w`));
      const ink = Math.max(...faces.map((piece) => pieceBounds(piece, t, fakeMeasure)?.y2 ?? Number.NEGATIVE_INFINITY));
      const rings = pieces.filter((piece) => piece.id.startsWith(`ripple:${cue.index}:ring`));
      expect(rings.length).toBeGreaterThan(0);
      for (const ring of rings) {
        expect(ring.clip).toBeUndefined();
        for (const frame of exportFrameTimes(ring.fromMs, ring.toMs, 30).filter((f) => f > ring.fromMs + 300).slice(0, 3)) {
          const box = pieceBounds(ring, frame, fakeMeasure);
          if (box) expect(box.y1).toBeGreaterThanOrEqual(ink - 1);
        }
      }
    }
  });
});
