import { describe, expect, test } from "bun:test";
import { describeSpeechConformance, fastRun } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import type { SceneCue, SceneInput } from "./input";
import { type Box, type Measure, type Piece, type TextPiece, evaluatePiece, pieceBounds } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";
import { KEYCAP_DEMO, keycapProgram } from "./templates/keycap";

describeSpeechConformance("keycap", keycapProgram, { anchorLineY: 1290 });

/** Devanagari and Arabic ink reaches higher and lower than Latin; CJK is square. */
const scriptMeasure: Measure = (text, face, size, spacing) => {
  const base = fakeMeasure(text, face, size, spacing);
  if (/\p{Script=Devanagari}/u.test(text)) return { ...base, inkTop: -0.98 * size, inkBottom: 0.34 * size };
  if (/\p{Script=Arabic}/u.test(text)) return { ...base, inkTop: -0.9 * size, inkBottom: 0.45 * size };
  if (/\p{Script=Han}/u.test(text)) return { ...base, advance: [...text].length * size, inkTop: -0.86 * size, inkBottom: 0.1 * size };
  return base;
};

const input = (cues: readonly SceneCue[], overrides: Partial<SceneInput> = {}) =>
  sceneInput(cues, { fps: 30, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, measure: scriptMeasure, colours: { primary: "#17171C", highlight: "#FF5A12", accent: "#F6F1E4", shadow: "#000000" }, ...overrides });
const build = (lines: readonly string[], language?: string, overrides: Partial<SceneInput> = {}) => {
  const { cues } = demoCues({ lines, ...(language ? { language } : {}), options: { lead: 400, gap: 30, cueGap: 120, tail: 500 } });
  return { cues, pieces: keycapProgram.build(input(cues, overrides)).pieces };
};
const cueOf = (piece: Piece) => Number(piece.id.split(":")[1]);
const faceRe = /^keycap:(\d+):w(\d+)(?:l(\d+))?$/;
const faces = (pieces: readonly Piece[], cue: number) => pieces.filter((piece): piece is TextPiece => piece.kind === "text" && faceRe.test(piece.id) && cueOf(piece) === cue);
const box = (piece: Piece, t: number, measure: Measure = scriptMeasure) => (evaluatePiece(piece, t).visible ? pieceBounds(piece, t, measure) : null);
const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
const settled = (cue: SceneCue) => Math.max(...cue.words.map((word) => word.endMs)) - 10;
const centre = (b: Box) => ({ x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 });

/** Every key of a cue apart from every other, its legend inside its own face, and nothing outside the band. */
function checkCue(pieces: readonly Piece[], cue: SceneCue, safe: Box = { x1: 54, y1: 96, x2: 1026, y2: 1824 }) {
  const t = settled(cue);
  const own = pieces.filter((piece) => cueOf(piece) === cue.index);
  const sockets = own.filter((piece) => piece.id.endsWith("socket")).map((piece) => ({ id: piece.id, b: box(piece, t)! }));
  for (const [i, a] of sockets.entries()) for (const b of sockets.slice(i + 1)) expect(meets(a.b, b.b), `${a.id} meets ${b.id}`).toBe(false);
  for (const text of faces(own, cue.index)) {
    const ink = box(text, t)!;
    const face = own.find((piece) => piece.id === `${text.id}face`)!;
    const plate = box(face, t)!;
    expect(ink.x1 >= plate.x1 - 0.5 && ink.x2 <= plate.x2 + 0.5 && ink.y1 >= plate.y1 - 0.5 && ink.y2 <= plate.y2 + 0.5, `${text.id} "${text.text}" inside its face`).toBe(true);
    // No other key's piece and no click mark sits on a legend.
    for (const other of own) {
      if (other === text || other.id.startsWith(text.id)) continue;
      const b = box(other, t);
      if (b && !other.id.endsWith("socket")) expect(meets(ink, b), `${other.id} over ${text.id}`).toBe(false);
    }
  }
  for (const piece of own) {
    const b = box(piece, t);
    if (b) expect(b.x1 >= safe.x1 - 1 && b.x2 <= safe.x2 + 1 && b.y1 >= safe.y1 - 1 && b.y2 <= safe.y2 + 1, `${piece.id} in the safe area`).toBe(true);
  }
}

describe("keycap layout", () => {
  test("rows follow reading order: a key word that opens the cue is the top row, one that closes it the bottom row", () => {
    const { cues, pieces } = build(["consistency:h@500 beats:b talent:b", "it:m starts:b when:m you:m press:h@480"]);
    const at = (cue: number, word: number) => centre(box(faces(pieces, cue).find((piece) => piece.id === `keycap:${cue}:w${word}`)!, settled(cues[cue]!))!);
    expect(at(0, 0).y).toBeLessThan(at(0, 1).y);
    expect(at(1, 4).y).toBeGreaterThan(at(1, 3).y);
    for (const cue of cues) checkCue(pieces, cue);
  });

  test("the key word is a Return key with its arrow; every key word of a cue is honoured", () => {
    const { pieces } = build(["we've:m shot:b 384:h episodes:h@420"]);
    expect(pieces.filter((piece) => piece.id.endsWith("arrow")).map((piece) => piece.id)).toEqual(["keycap:0:w2arrow", "keycap:0:w3arrow"]);
  });

  test("a word too wide for the column breaks into even keys that keep the floor size; a joined script shrinks instead", () => {
    const { cues, pieces } = build(["pneumonoultramicroscopicsilicovolcanoconiosis:b@1400"]);
    const parts = faces(pieces, 0);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((piece) => piece.text).join("")).toBe("pneumonoultramicroscopicsilicovolcanoconiosis");
    for (const part of parts) expect(part.sizePx).toBeGreaterThanOrEqual(50 - 0.01);
    const widths = parts.map((piece) => piece.text.length);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    checkCue(pieces, cues[0]!);
  });

  test("CJK with no spaces wraps into keys, never below the floor", () => {
    const { cues, pieces } = build(["我们今天要讨论的是一个非常重要的问题:b@1400"], "zh");
    const parts = faces(pieces, 0);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.sizePx).toBeGreaterThanOrEqual(50 - 0.01);
    checkCue(pieces, cues[0]!);
  });

  test("Devanagari: keys grow to the measured ink and the cue stays in the band", () => {
    const { cues, pieces } = build(["display:b glare:b बहुत:h@420", "और:m अगर:b इसे:m सीधा:h@400"], "hi");
    for (const cue of cues) checkCue(pieces, cue);
    const hindi = faces(pieces, 1).find((piece) => piece.text === "अगर")!;
    expect(hindi.sizePx).toBeGreaterThan(60);
  });

  test("Urdu runs right to left: the first word is rightmost and the Return arrow sits left of its word", () => {
    const { cues, pieces } = build(["یہ:m بہت:b اچھا:h@600 ہے:m"], "ur");
    checkCue(pieces, cues[0]!);
    const t = settled(cues[0]!);
    const x = (word: number) => centre(box(pieces.find((piece) => piece.id === `keycap:0:w${word}`)!, t)!).x;
    expect(x(0)).toBeGreaterThan(x(1));
    const arrow = centre(box(pieces.find((piece) => piece.id === "keycap:0:w2arrow")!, t)!).x;
    expect(arrow).toBeLessThan(x(2));
  });

  test("mixed Latin and digits, accented Latin and the edge demos stay inside the band without overlap", () => {
    const { cues, pieces } = build(["we:m shipped:b 384:b episodes:h@420", "café:b crème:b brûlée:h@400 déjà:b"]);
    for (const cue of cues) checkCue(pieces, cue);
    for (const edge of ["long-word", "nine-words", "urdu", "one-word"] as const) {
      const demo = sceneEdgeDemo(edge);
      const built = keycapProgram.build(input(demo.cues)).pieces;
      for (const cue of demo.cues) checkCue(built, cue);
    }
  });

  test("16:9 at twice the size keeps every key in the safe area", () => {
    const canvas = { width: 1920, height: 1080 };
    const { cues } = demoCues(KEYCAP_DEMO);
    const built = keycapProgram.build(input(cues, { canvas, scale: 2 })).pieces;
    for (const cue of cues) checkCue(built, cue, { x1: 96, y1: 54, x2: 1824, y2: 1026 });
  });
});

describe("keycap motion", () => {
  const { cues } = demoCues(KEYCAP_DEMO);
  const { pieces } = keycapProgram.build(input(cues));
  const yAt = (id: string, t: number) => evaluatePiece(pieces.find((piece) => piece.id === id)!, t).y;

  test("the press sinks the face against a fixed socket, the key word deeper and longer", () => {
    const press = cues[1]!.words[4]!;
    const s0 = press.startMs;
    const faceDrop = yAt("keycap:1:w4face", s0 + 150) - yAt("keycap:1:w4face", s0 + 700);
    const socketDrop = yAt("keycap:1:w4socket", s0 + 150) - yAt("keycap:1:w4socket", s0 + 700);
    expect(faceDrop).toBeCloseTo(0.23 * 96, 0);
    expect(Math.abs(socketDrop)).toBeLessThan(0.01);
    const word = cues[0]!.words[1]!;
    const bodyDrop = yAt("keycap:0:w1face", word.startMs + 40) - yAt("keycap:0:w1face", word.startMs + 500);
    expect(bodyDrop).toBeGreaterThan(0.16 * 72 * 0.95);
    expect(bodyDrop).toBeLessThan(faceDrop);
  });

  test("a neighbour dips with a press (the deck flexes)", () => {
    const word = cues[0]!.words[1]!;
    const dip = yAt("keycap:0:w0face", word.startMs + 40) - yAt("keycap:0:w0face", word.startMs + 500);
    expect(dip).toBeGreaterThan(2);
  });

  test("keys are opaque from their first frame and drop away in reading order on exit", () => {
    for (const cue of cues) {
      for (const face of faces(pieces, cue.index)) expect(evaluatePiece(face, face.fromMs).o).toBe(1);
    }
    const paused = demoCues({ lines: ["stop:b waiting:b for:m motivation:b", "now:h@400"], options: { lead: 400, gap: 30, cueGap: 900, tail: 500 } }).cues;
    const cue = paused[0]!;
    const sockets = keycapProgram.build(input(paused)).pieces.filter((piece) => cueOf(piece) === 0 && piece.id.endsWith("socket"));
    expect(sockets.length).toBe(4);
    const fadeStart = (piece: Piece) => piece.track.o!.find(([, o], i, all) => i > 0 && o < all[i - 1]![1])![0];
    const starts = sockets.map((piece) => fadeStart(piece));
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(Math.min(...starts)).toBeGreaterThanOrEqual(Math.max(...cue.words.map((word) => word.endMs)) + 150 - 80);
  });

  test("the click mark comes back on every cue of a long clip, clear of every other key", () => {
    const run = fastRun(60);
    const long = [...run, ...run.map((cue) => ({ ...cue, index: cue.index + run.length, startMs: cue.startMs + 9000, endMs: cue.endMs + 9000, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + 9000, endMs: word.endMs + 9000 })) }))];
    const built = keycapProgram.build(input(long, { measure: fakeMeasure })).pieces;
    const withMark = new Set(built.filter((piece) => /click$/.test(piece.id)).map(cueOf));
    expect(withMark.size).toBeGreaterThanOrEqual(long.length - 4);
    for (const mark of built.filter((piece) => /click$/.test(piece.id))) {
      const cue = cueOf(mark);
      const t = (mark.fromMs + mark.toMs) / 2;
      const b = box(mark, t, fakeMeasure);
      if (!b) continue;
      for (const other of built.filter((piece) => cueOf(piece) === cue && piece.id.endsWith("socket"))) {
        const ob = box(other, t, fakeMeasure);
        if (ob) expect(meets(b, ob), `${mark.id} over ${other.id}`).toBe(false);
      }
    }
  });
});

describe("keycap colours", () => {
  test("ink that cannot read on the key falls back to the style's own colours", () => {
    const { pieces } = build(["it:m starts:b now:h@400"], undefined, { colours: { primary: "#F0F0F0", highlight: "#FFFFFF", accent: "#FFFFFF", shadow: "#000000" } });
    const text = faces(pieces, 0)[0]!;
    expect(text.fill).toBe("#17171C");
    const ret = pieces.find((piece) => piece.id === "keycap:0:w2face")!;
    expect(ret.kind === "shape" && ret.fill?.colour).toBe("#FF5A12");
  });

  test("a brand Return key that reads with the ink is used as it is", () => {
    const { pieces } = build(["it:m starts:b now:h@400"], undefined, { colours: { primary: "#17171C", highlight: "#2EC4B6", accent: "#F6F1E4", shadow: "#000000" } });
    const ret = pieces.find((piece) => piece.id === "keycap:0:w2face")!;
    expect(ret.kind === "shape" && ret.fill?.colour).toBe("#2EC4B6");
  });
});
