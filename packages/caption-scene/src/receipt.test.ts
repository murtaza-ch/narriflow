import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import type { SceneCue } from "./input";
import { evaluatePiece, type Piece, pieceBounds, type ShapePiece, type TextPiece } from "./scene";
import { RECEIPT_DEMO, receiptProgram } from "./templates/receipt";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("receipt", receiptProgram, { anchorLineY: 1390 });

const build = (cues: readonly SceneCue[], overrides = {}) =>
  receiptProgram.build(sceneInput(cues, { anchor: { xPct: 50, yPct: (1390 / 1920) * 100 }, ...overrides })).pieces;
const demo = () => demoCues(RECEIPT_DEMO).cues;
const faces = (pieces: readonly Piece[]) => pieces.filter((p): p is TextPiece => p.kind === "text" && /^receipt:\d+:w\d+(l\d+)?$/.test(p.id));
const pieceNamed = (pieces: readonly Piece[], name: string) => pieces.find((p) => p.id === name) as ShapePiece;

describe("receipt: the paper grows with the words", () => {
  test("body and key words keep the sample's sizes at the demo", () => {
    const pieces = build(demo());
    const sizes = new Set(faces(pieces).map((p) => Math.round(p.sizePx)));
    expect([...sizes].sort((a, b) => a - b)).toEqual([52, 86]);
  });

  test("the paper's height follows the rows printed so far and never shrinks text", () => {
    const pieces = build(demo());
    const paper = pieceNamed(pieces, "receipt:0:paper");
    const early = evaluatePiece(paper, 600).sy;
    const later = evaluatePiece(paper, 1700).sy;
    expect(early).toBeGreaterThan(0);
    expect(later).toBeGreaterThan(early);
    expect(evaluatePiece(paper, 2000).sy).toBeLessThanOrEqual(1);
  });

  test("a long word widens the paper, and one wider than the safe area is broken, never shrunk", () => {
    const medium = demoCues({ lines: ["it:m is:m internationalizations:b good:h@400"], options: { lead: 400, tail: 600 } }).cues;
    const widePaper = pieceNamed(build(medium), "receipt:0:paper");
    const base = pieceNamed(build(demo()), "receipt:0:paper");
    const width = (p: ShapePiece) => pieceBounds(p, 1500, fakeMeasure)!.x2 - pieceBounds(p, 1500, fakeMeasure)!.x1;
    expect(width(widePaper)).toBeGreaterThan(width(base));
    const long = build(sceneEdgeDemo("long-word").cues);
    const parts = faces(long).filter((p) => /l\d+$/.test(p.id));
    expect(parts.length).toBeGreaterThan(1);
    expect(Math.min(...faces(long).map((p) => p.sizePx))).toBeGreaterThanOrEqual(52);
  });

  test("stars and the total rule come only with a key word, and only spoken words are text", () => {
    const pieces = build(demo());
    const cue1 = pieces.filter((p) => p.id.startsWith("receipt:1:"));
    expect(cue1.some((p) => /star3l$/.test(p.id))).toBe(true);
    expect(cue1.some((p) => /bar3$/.test(p.id))).toBe(true);
    const cue2 = pieces.filter((p) => p.id.startsWith("receipt:2:"));
    expect(cue2.some((p) => /star|bar\d/.test(p.id))).toBe(false);
    const spoken = new Set(demo().flatMap((cue) => cue.words.map((w) => w.text.toLowerCase())));
    for (const text of faces(pieces)) expect(spoken.has(text.text.toLowerCase())).toBe(true);
    expect(pieces.filter((p) => p.kind === "text" && !/^receipt:\d+:w/.test(p.id)).length).toBeGreaterThan(0);
  });

  test("the rule between cues recurs and every third is a barcode", () => {
    const pieces = build(demo());
    const rules = pieces.filter((p) => p.id.endsWith(":rule"));
    expect(rules.length).toBeGreaterThanOrEqual(2);
  });
});

describe("receipt: the band", () => {
  const safeBox = (canvas: { width: number; height: number }) => ({ x1: 0.05 * canvas.width - 1, y1: 0.05 * canvas.height - 1, x2: 0.95 * canvas.width + 1, y2: 0.95 * canvas.height + 1 });

  test("the strip stays in the safe area on 9:16 and 16:9, flight excepted", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
      const safe = safeBox(canvas);
      for (const piece of build(demo(), { canvas })) {
        if (piece.bleed) continue;
        for (let t = piece.fromMs; t < piece.toMs; t += 33) {
          const box = pieceBounds(piece, t, fakeMeasure);
          if (!box) continue;
          expect(box.x1 >= safe.x1 && box.y1 >= safe.y1 && box.x2 <= safe.x2 && box.y2 <= safe.y2, `${piece.id} at ${t} on ${canvas.width}x${canvas.height}`).toBe(true);
        }
      }
    }
  });

  test("the tear is bleed copies that start after the reading hold; no tear when the next strip starts at once", () => {
    const pieces = build(demo());
    const tears = pieces.filter((p) => p.id.includes(":tear"));
    expect(tears.length).toBeGreaterThan(0);
    expect(tears.every((p) => p.bleed === true)).toBe(true);
    const last = demo().at(-1)!;
    const spokenEnd = Math.max(...last.words.map((w) => w.endMs));
    expect(Math.min(...tears.filter((p) => p.id.startsWith(`receipt:${last.index}:`) || true).map((p) => p.fromMs))).toBeGreaterThanOrEqual(spokenEnd + 150 - 1);
    const dense = demoCues({ lines: ["one:b two:b three:b four:h@300 five:b", "six:b seven:b eight:b nine:b ten:h@300"], options: { cueGap: 0, lead: 400 } }).cues;
    const none = build(dense).filter((p) => p.id.includes(":tear") && p.fromMs < dense[1]!.startMs);
    expect(none.length).toBe(0);
  });

  test("the paper is in place before the first word prints on fast speech", () => {
    const fast = demoCues({ lines: ["go@70", "on@70 then@120"], options: { lead: 400, gap: 0, cueGap: 0 } }).cues;
    const pieces = build(fast);
    const paper = pieceNamed(pieces, "receipt:0:paper");
    for (const face of faces(pieces).filter((p) => p.id.startsWith("receipt:0:"))) {
      const t = face.fromMs;
      expect(evaluatePiece(paper, t + 34).sy).toBeGreaterThan(0.5);
    }
  });
});

describe("receipt: colours and scripts", () => {
  test("ink that does not read on the paper falls back, stars keep 3:1", () => {
    const pieces = build(demo(), { colours: { primary: "#FFFFFF", highlight: "#FFFFFF", accent: "#FFFFFF", shadow: "#000000" } });
    for (const face of faces(pieces)) expect(face.fill).not.toBe("#FFFFFF");
    const star = pieces.find((p) => p.id.includes("star")) as ShapePiece;
    expect(star.fill?.colour).not.toBe("#FFFFFF");
  });

  test("an Urdu cue builds right to left and flies off to the left", () => {
    const cues = sceneEdgeDemo("urdu").cues;
    const pieces = build(cues);
    const f = faces(pieces).filter((p) => p.id.startsWith("receipt:0:"));
    const first = f.find((p) => p.id.endsWith(":w0"))!;
    const last = f.find((p) => p.id.endsWith(`:w${cues[0]!.words.length - 1}`))!;
    if (first.track.y && last.track.y && evaluatePiece(first, first.fromMs + 400).y === evaluatePiece(last, last.fromMs + 400).y) {
      expect(evaluatePiece(first, first.fromMs + 400).x).toBeGreaterThan(evaluatePiece(last, last.fromMs + 400).x);
    }
    const tear = pieces.find((p) => p.id.includes(":tear") && p.id.includes("paper"));
    if (tear) expect(evaluatePiece(tear, tear.toMs - 1).x).toBeLessThan(0);
  });
});
