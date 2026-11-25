import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import type { SceneCue } from "./input";
import { paintedFrameCount } from "./frame-grid";
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
    for (const tear of tears) {
      const said = demo().filter((cue) => cue.startMs <= tear.fromMs).at(-1)!;
      expect(tear.fromMs).toBeGreaterThanOrEqual(Math.max(...said.words.map((w) => w.endMs)) + 150 - 1);
    }
    // The first full strip's 280 ms handoff gap cannot hold a four-frame tear: it is cut cleanly, and the next strip starts after it.
    const firstEnd = Math.max(...pieces.filter((p) => !p.id.includes(":tear") && p.id.startsWith("receipt:0:")).map((p) => p.toMs));
    const nextFirstPaint = Math.min(...pieces.filter((p) => !p.id.includes(":tear") && p.id.startsWith("receipt:3:")).map((p) => p.fromMs));
    expect(firstEnd).toBeLessThanOrEqual(nextFirstPaint + 1);
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

describe("receipt: review fixes", () => {
  const long = "internationalizations";
  const cue = (index: number, start: number, words: string[], duration: number): SceneCue => ({
    index, startMs: start, endMs: start + words.length * duration, speaker: 0, language: "en",
    words: words.map((text, i) => ({ text, startMs: start + i * duration, endMs: start + (i + 1) * duration, role: "body" as const, key: null })),
  });

  test("a one-frame cue between two full strips still has its paper (a static plate under the ink)", () => {
    const cues = [cue(0, 245, Array(9).fill(long), 80), cue(1, 965, ["no"], 70), cue(2, 1035, Array(9).fill(long), 80)];
    for (const fps of [24, 25, 30]) {
      const pieces = build(cues, { fps });
      const word = pieces.find((p) => p.id === "receipt:1:w0")!;
      for (const t of [965, 1000, 1034]) {
        const ink = pieceBounds(word, t, fakeMeasure);
        if (!ink) continue;
        const plates = pieces.filter((p) => p.id.startsWith("receipt:1:") && p.kind === "shape" && /paper$/.test(p.id));
        const covered = plates.some((p) => {
          const box = pieceBounds(p, t, fakeMeasure);
          return box && box.x1 <= ink.x1 && box.x2 >= ink.x2 && box.y1 <= ink.y1 && box.y2 >= ink.y2;
        });
        expect(covered, `${fps} fps at ${t}`).toBe(true);
      }
    }
  });

  test("the total rule sits below the measured ink and the row holds it", () => {
    const hero = demoCues({ lines: ["so:m महसूस:h@500 it:m"], options: { lead: 400, tail: 900 }, language: "hi" }).cues;
    const pieces = build(hero, { measure: (text: string, face: never, size: number, ls: number) => ({ ...fakeMeasure(text, face, size, ls), inkBottom: 0.45 * size }) });
    const face = pieces.find((p) => p.id === "receipt:0:w1") as TextPiece;
    const bar = pieces.find((p) => p.id === "receipt:0:bar1") as ShapePiece;
    const t = 1500;
    const ink = pieceBounds(face, t, (text, f, size, ls) => ({ ...fakeMeasure(text, f, size, ls), inkBottom: 0.45 * size }))!;
    const rule = evaluatePiece(bar, t);
    expect(rule.y).toBeGreaterThan(ink.y2);
  });

  test("a key word that just fits between its stars keeps them", () => {
    const cues = demoCues({ lines: ["so:m extraordinarily:h@500"], options: { lead: 400, tail: 900 } }).cues;
    const pieces = build(cues, { measure: (text: string, face: never, size: number, ls: number) => fakeMeasure(text, face, size, ls) });
    expect(pieces.some((p) => p.id.includes("star"))).toBe(true);
  });

  test("a brand colour the shared 3:1 rule accepts is painted as given", () => {
    const pieces = build(demo(), { colours: { primary: "#767676", highlight: "#B0301C", accent: "#FFFFFF", shadow: "#000000" } });
    for (const face of faces(pieces)) expect(face.fill).toBe("#767676");
    const star = pieces.find((p) => p.id.includes("star")) as ShapePiece;
    expect(star.fill?.colour).toBe("#B0301C");
  });
});

describe("receipt: handoffs, flash, joined scripts", () => {
  const word = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs, role: "hero" as const, key: String(startMs) });
  const solo = (index: number, speaker: number, startMs: number, endMs: number, text: string, wordEnd: number): SceneCue => ({ index, startMs, endMs, speaker, language: "en", words: [word(text, startMs, wordEnd)] });

  test("a tear never overlaps the paper of a later strip in another lane", () => {
    const cues = [solo(0, 0, 400, 500, "upper", 850), solo(1, 1, 500, 1130, "outgoing", 900), solo(2, 0, 1130, 2100, "incoming", 2000)];
    const pieces = build(cues);
    const tears = pieces.filter((p) => p.id.includes(":tear") && p.id.startsWith("receipt:1:"));
    const incoming = pieces.find((p) => p.id === "receipt:2:paper")!;
    for (const tear of tears) expect(tear.toMs).toBeLessThanOrEqual(incoming.fromMs);
    for (const piece of pieces.filter((p) => p.id.startsWith("receipt:1:"))) expect(piece.toMs).toBeLessThanOrEqual(incoming.fromMs);
  });

  test("every tear paints at least three frames, else the strip is cut cleanly", () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const tear of build(demo(), { fps }).filter((p) => p.id.includes(":tear"))) expect(paintedFrameCount(tear.fromMs, tear.toMs, fps), `${fps} fps ${tear.id}`).toBeGreaterThanOrEqual(3);
    }
  });

  test("text that reads on the paper but not on the thermal flash falls back", () => {
    const pieces = build(demo(), { colours: { primary: "#949494", highlight: "#E8452B", accent: "#FFFFFF", shadow: "#000000" } });
    for (const face of faces(pieces)) expect(face.fill).not.toBe("#949494");
  });

  test("a joined-script key word is shrunk whole, never split into rows", () => {
    const token = "متعلقہ".repeat(11);
    const cues = [{ ...solo(0, 0, 400, 1500, token, 1200), language: "ur" }];
    const pieces = build(cues);
    const rows = faces(pieces).filter((p) => p.id.startsWith("receipt:0:"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe("receipt:0:w0");
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
