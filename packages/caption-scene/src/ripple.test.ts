import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { evaluatePiece } from "./scene";
import { rippleProgram } from "./templates/ripple";
import { sceneInput } from "./test-support";

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
    // No key word: the last word is split into letters that wave; the words before it stay whole.
    expect(pieces.some((piece) => /^ripple:1:w2l\d$/.test(piece.id))).toBe(true);
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

  test("rings are cut out around the words after the key word, so they never run through them", () => {
    const { pieces } = build(["the:m remote:b doesn't:h@700 work:b", "just:m breathe:b"]);
    const ring = pieces.find((piece) => piece.id === "ripple:0:ring0-0")!;
    expect(ring.clip?.inverse).toBe(true);
    const tail = pieces.find((piece) => piece.id === "ripple:0:w3")!;
    const y = evaluatePiece(tail, tail.fromMs + 1500).y;
    const clip = evaluatePiece(ring, ring.fromMs).clip!;
    expect(clip.y1).toBeLessThan(y);
    expect(clip.y2).toBeGreaterThan(y);
    // A cue with nothing after the key word, or no key word, has nothing to cut out.
    expect(pieces.find((piece) => piece.id === "ripple:1:ring0-0")!.clip).toBeUndefined();
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
