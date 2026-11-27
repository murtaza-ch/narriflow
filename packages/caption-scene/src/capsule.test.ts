import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues } from "./demo";
import type { SceneCue } from "./input";
import { type Box, evaluatePiece, type Piece, pieceBounds } from "./scene";
import { pathBounds } from "./shapes";
import { capsuleProgram } from "./templates/capsule";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("capsule", capsuleProgram, { anchorLineY: 1290 });

const colours = { primary: "#16286E", highlight: "#F2472F", accent: "#FFD42E", shadow: "#000000" };
const anchor = { xPct: 50, yPct: (1290 / 1920) * 100 };

const build = (lines: string[], options: { language?: string; canvas?: { width: number; height: number }; colours?: typeof colours; cueGap?: number } = {}) => {
  const { cues } = demoCues({ lines, language: options.language, options: { lead: 400, gap: 30, cueGap: options.cueGap ?? 300, tail: 800 } });
  const pieces = capsuleProgram.build(sceneInput(cues, { fps: 30, anchor, colours: options.colours ?? colours, ...(options.canvas ? { canvas: options.canvas } : {}) })).pieces;
  return { cues, pieces };
};
const own = (pieces: readonly Piece[], cue: number) => pieces.filter((piece) => piece.id.startsWith(`capsule:${cue}:`));
const isFace = (piece: Piece) => /:w\d+(l\d+)?$/.test(piece.id);
const meets = (a: Box, b: Box) => a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5;
const safe = (canvas = { width: 1080, height: 1920 }): Box => ({ x1: 0.05 * canvas.width - 1, y1: 0.05 * canvas.height - 1, x2: 0.95 * canvas.width + 1, y2: 0.95 * canvas.height + 1 });
const within = (box: Box, room: Box) => box.x1 >= room.x1 && box.y1 >= room.y1 && box.x2 <= room.x2 && box.y2 <= room.y2;

/** The settled frame of a cue: after its last word, before it leaves. */
const settledAt = (cue: SceneCue) => cue.words.at(-1)!.endMs + 60;

/** Every painted frame of a cue: words inside the safe area, never touching each other or a decoration of their cue. */
function expectClean(pieces: readonly Piece[], cue: SceneCue, canvas?: { width: number; height: number }) {
  const mine = own(pieces, cue.index);
  for (let t = cue.words[0]!.startMs; t < settledAt(cue); t += 33) {
    const live = mine.flatMap((piece) => {
      const box = pieceBounds(piece, t, fakeMeasure);
      return box ? [{ piece, box }] : [];
    });
    for (const { piece, box } of live) {
      expect(within(box, safe(canvas)), `${piece.id} at ${t} leaves the safe area ${JSON.stringify(box)}`).toBe(true);
      if (!isFace(piece)) continue;
      for (const other of live) {
        // The key word rides its own capsule, and its burst is drawn behind that opaque capsule; anything else stays off a word.
        const word = piece.id.replace(/l\d+$/, "");
        if (other.piece === piece || other.piece.id === `${word}cap` || other.piece.id === `${word}burst` || other.piece.id.startsWith(`${word}l`)) continue;
        // A burst is round: its points stay inside the circle of its pose's scale.
        if (/burst$/.test(other.piece.id) && other.piece.kind === "shape") {
          const pose = evaluatePiece(other.piece, t);
          const r = pathBounds(other.piece.path).x2 * pose.sx;
          const dx = Math.max(0, box.x1 - pose.x, pose.x - box.x2);
          const dy = Math.max(0, box.y1 - pose.y, pose.y - box.y2);
          expect(Math.hypot(dx, dy), `${other.piece.id} reaches ${piece.id} at ${t}`).toBeGreaterThanOrEqual(r);
          continue;
        }
        expect(meets(box, other.box), `${other.piece.id} meets ${piece.id} at ${t}`).toBe(false);
      }
    }
  }
}

describe("capsule", () => {
  test("plain words are navy with a white keyline, the key word is white on its own capsule, one capsule per key-word cue", () => {
    const { cues, pieces } = build(["so:m build:b it:m now:h@480", "not:m someday:b"]);
    const t = settledAt(cues[0]!);
    for (const w of [0, 1, 2]) {
      const face = pieces.find((piece) => piece.id === `capsule:0:w${w}`)!;
      expect(face.kind === "text" && face.fill).toBe("#16286E");
      expect(face.kind === "text" && face.stroke?.colour).toBe("#FFFFFF");
      expect(evaluatePiece(face, t).o).toBe(1);
    }
    const label = pieces.find((piece) => piece.id === "capsule:0:w3")!;
    const capsule = pieces.find((piece) => piece.id === "capsule:0:w3cap")!;
    expect(label.kind === "text" && label.fill).toBe("#FFFFFF");
    expect(label.z).toBeGreaterThan(capsule.z);
    // The word rides the capsule: one pivot, one pose.
    expect(label.track).toEqual(capsule.track);
    expect(own(pieces, 1).some((piece) => /cap$/.test(piece.id))).toBe(false);
    expect(own(pieces, 1).filter((piece) => /:spark$/.test(piece.id))).toHaveLength(1);
  });

  test("the capsule swings up from near vertical about its near end, overshoots past level and settles tilted 4-8 degrees", () => {
    const { cues, pieces } = build(["so:m build:b it:m now:h@480"]);
    const capsule = pieces.find((piece) => piece.id === "capsule:0:w3cap")!;
    const s = cues[0]!.words[3]!.startMs;
    const first = evaluatePiece(capsule, capsule.fromMs).rz;
    expect(first).toBeGreaterThan(60);
    const angles = Array.from({ length: 40 }, (_, k) => evaluatePiece(capsule, s - 80 + k * 20).rz);
    expect(Math.min(...angles)).toBeLessThan(-10);
    const settled = evaluatePiece(capsule, s + 900).rz;
    expect(settled).toBeLessThanOrEqual(-4);
    expect(settled).toBeGreaterThanOrEqual(-8);
    // The hinge never moves.
    expect(capsule.track.x).toHaveLength(1);
    expect(capsule.track.y).toHaveLength(1);
  });

  test("the burst, smiley and sparkles recur on every key-word cue and the capsule colours cycle", () => {
    const lines = Array.from({ length: 8 }, (_, k) => (k % 2 ? "and:m it:m works:b" : `you:m have:b to:m go${k}:h@420`));
    const { cues, pieces } = build(lines);
    const fills = new Set<string>();
    for (const cue of cues) {
      const mine = own(pieces, cue.index);
      const hero = cue.words.findIndex((word) => word.role === "hero");
      if (hero < 0) {
        expect(mine.some((piece) => /:spark$/.test(piece.id)), `cue ${cue.index}`).toBe(true);
        continue;
      }
      for (const part of ["cap", "burst", "smile", "eyes", "mouth", "spark0", "spark1"]) {
        expect(mine.some((piece) => piece.id === `capsule:${cue.index}:w${hero}${part}`), `cue ${cue.index} ${part}`).toBe(true);
      }
      const cap = mine.find((piece) => /cap$/.test(piece.id))!;
      fills.add(cap.kind === "shape" ? cap.fill!.colour : "");
    }
    expect(fills.size).toBe(2);
  });

  test("the extra beats (speed dashes, a navy blob) fire on most cues of a long run of ordinary speech", () => {
    const lines = Array.from({ length: 24 }, (_, k) => [
      "so:m here:b is:m the:m thing:h@300", "nobody:b tells:b you:m this", "you:m have:b to:m start:h@300", "before:b you:m feel:b ready",
    ][k % 4]!.replace(/^(\w+)/, (word) => `${word}${k}`));
    const { cues, pieces } = build(lines, { cueGap: 60 });
    const dashes = cues.filter((cue) => own(pieces, cue.index).some((piece) => /:dash$/.test(piece.id))).length;
    const blobs = cues.filter((cue) => own(pieces, cue.index).some((piece) => /:blob$/.test(piece.id))).length;
    expect(dashes).toBeGreaterThanOrEqual(20);
    expect(blobs).toBeGreaterThanOrEqual(18);
  });

  test("words before the key word sit above the capsule, words after it below, in reading order, never crossed by the swing", () => {
    const { cues, pieces } = build(["we:b didn't:b want:h@200 to:m go:b", "the:m remote:b doesn't:h@120 work.:b"]);
    for (const cue of cues) {
      const hero = cue.words.findIndex((word) => word.role === "hero");
      const t = settledAt(cue);
      const y = (w: number) => pieceBounds(pieces.find((piece) => piece.id === `capsule:${cue.index}:w${w}`)!, t, fakeMeasure)!;
      const hinge = evaluatePiece(pieces.find((piece) => piece.id === `capsule:${cue.index}:w${hero}cap`)!, t).y;
      for (let w = 0; w < hero; w++) expect(y(w).y2).toBeLessThan(hinge);
      for (let w = hero + 1; w < cue.words.length; w++) expect(y(w).y1).toBeGreaterThan(hinge);
      expectClean(pieces, cue);
    }
  });

  test("Hindi: a Devanagari cue with a key word keeps its words whole, inside the band, uncovered", () => {
    const { cues, pieces } = build(["यह:b बहुत:h@400 अच्छा:b है:m", "मुझे:b यह:m पसंद:b है:m"], { language: "hi" });
    for (const cue of cues) {
      expect(own(pieces, cue.index).filter(isFace).every((piece) => !/l\d+$/.test(piece.id))).toBe(true);
      expectClean(pieces, cue);
    }
  });

  test("Urdu (RTL): rows run right to left and the capsule hinges on its right end, swinging the mirrored way", () => {
    const { cues, pieces } = build(["یہ:m بہت:b اچھا:h@600 ہے:m"], { language: "ur" });
    const cue = cues[0]!;
    const t = settledAt(cue);
    const x = (w: number) => evaluatePiece(pieces.find((piece) => piece.id === `capsule:0:w${w}`)!, t).x;
    expect(x(0)).toBeGreaterThan(x(1));
    const cap = pieces.find((piece) => piece.id === "capsule:0:w2cap")!;
    const box = pieceBounds(cap, t, fakeMeasure)!;
    // The pivot (hinge) is at the right end, the capsule reaches left of it; the hang turns the other way.
    expect(evaluatePiece(cap, t).x).toBeGreaterThan((box.x1 + box.x2) / 2);
    expect(evaluatePiece(cap, cap.fromMs).rz).toBeLessThan(-60);
    expect(evaluatePiece(cap, t + 300).rz).toBeGreaterThanOrEqual(4);
    expectClean(pieces, cue);
  });

  test("CJK: one long token with no spaces wraps into even rows, never below the size floor", () => {
    const token = "我们今天要学习如何做一个很好吃的蛋糕然后分享给我们的朋友们一起吃";
    const { cues, pieces } = build([`${token}:b@1600`], { language: "zh" });
    const parts = own(pieces, 0).filter((piece) => /:w0l\d+$/.test(piece.id));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(token);
    for (const piece of parts) expect(piece.kind === "text" && piece.sizePx).toBeGreaterThanOrEqual(114 * 0.62 - 0.01);
    expectClean(pieces, cues[0]!);
  });

  test("mixed Latin and digits: a cue with numbers and a key word stays inside the band, uncovered", () => {
    const { cues, pieces } = build(["we've:b shot:b 384:h@500 episodes:b", "since:m 2019:b"]);
    for (const cue of cues) expectClean(pieces, cue);
  });

  test("an overlong key word breaks into a two-line capsule instead of shrinking below its floor", () => {
    const { pieces } = build(["it's:m extraordinarily:h@900 hard:b"]);
    const lines = pieces.filter((piece) => /^capsule:0:w1l\d$/.test(piece.id));
    expect(lines.length).toBe(2);
    for (const line of lines) expect(line.kind === "text" && line.sizePx).toBeGreaterThanOrEqual(106 * 0.7 - 0.01);
  });

  test("16:9: the hang starts shallower so the whole swing stays inside the band without shrinking the caption", () => {
    const canvas = { width: 1920, height: 1080 };
    const { cues, pieces } = build(["so:m build:b it:m everything:h@500"], { canvas });
    const cap = pieces.find((piece) => piece.id === "capsule:0:w3cap")!;
    expect(evaluatePiece(cap, cap.fromMs).rz).toBeLessThan(80);
    const label = pieces.find((piece) => piece.id === "capsule:0:w3")!;
    expect(label.kind === "text" && label.sizePx).toBeGreaterThan(80);
    expectClean(pieces, cues[0]!, canvas);
  });

  test("a brand colour that cannot carry white text falls back to the style's navy and coral", () => {
    const { pieces } = build(["so:m build:b it:m now:h@480"], { colours: { ...colours, primary: "#FFF27A", highlight: "#FFE0E0" } });
    const face = pieces.find((piece) => piece.id === "capsule:0:w0")!;
    expect(face.kind === "text" && face.fill).toBe("#16286E");
    const cap = pieces.find((piece) => piece.id === "capsule:0:w3cap")!;
    expect(cap.kind === "shape" && cap.fill?.colour).toBe("#16286E");
  });
});
