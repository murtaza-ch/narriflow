import { describe, expect, test } from "bun:test";
import { describeSpeechConformance, fastRun } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameAtOrAfter, exportFrameAtOrBefore, exportFrameTimes } from "./frame-grid";
import type { SceneCue } from "./input";
import { type Box, evaluatePiece, type Piece, pieceBounds } from "./scene";
import { pentoolChipLabel, pentoolProgram } from "./templates/pentool";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("pentool", pentoolProgram, { anchorLineY: 1290 });

const colours = { primary: "#FFFFFF", highlight: "#FF6B57", accent: "#C3C8D2", shadow: "#000000" };
const anchor = { xPct: 50, yPct: (1290 / 1920) * 100 };

const build = (cues: readonly SceneCue[], overrides: Parameters<typeof sceneInput>[1] = {}) =>
  pentoolProgram.build(sceneInput(cues, { fps: 30, colours, anchor, ...overrides })).pieces;
const script = (lines: string[], language?: string, options: Record<string, number> = {}) =>
  demoCues({ lines, language, options: { lead: 400, gap: 30, cueGap: 140, tail: 700, ...options } }).cues;

const FACE = /^pentool:(\d+):w(\d+)(?:l\d+)?$/;
const isFace = (piece: Piece) => FACE.test(piece.id);
const cueOf = (piece: Piece) => Number(piece.id.split(":")[1]);
const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
const safe = (canvas = { width: 1080, height: 1920 }): Box => ({ x1: 0.05 * canvas.width - 1, y1: 0.05 * canvas.height - 1, x2: 0.95 * canvas.width + 1, y2: 0.95 * canvas.height + 1 });
const inside = (box: Box, area: Box) => box.x1 >= area.x1 && box.y1 >= area.y1 && box.x2 <= area.x2 && box.y2 <= area.y2;
/** Decorations are the shapes and the chip label, everything a cue draws that is not a word or its preview copy. */
const isDeco = (piece: Piece) => !isFace(piece) && !/:w\d+g\d+$/.test(piece.id);

/** On every painted frame: no two words of a cue overlap, no decoration of a cue overlaps one of its words, all inside the safe area. */
function expectClean(pieces: readonly Piece[], canvas = { width: 1080, height: 1920 }): void {
  const area = safe(canvas);
  const to = Math.max(...pieces.map((piece) => piece.toMs));
  for (const t of exportFrameTimes(0, to, 30)) {
    const live = pieces.flatMap((piece) => {
      const box = pieceBounds(piece, t, fakeMeasure);
      return box ? [{ piece, box }] : [];
    });
    for (const { piece, box } of live) {
      if (!piece.bleed) expect(inside(box, area), `${piece.id} at ${t}: ${JSON.stringify(box)}`).toBe(true);
    }
    const faces = live.filter(({ piece }) => isFace(piece));
    for (const [i, a] of faces.entries()) {
      for (const b of faces.slice(i + 1)) {
        if (cueOf(a.piece) === cueOf(b.piece) && FACE.exec(a.piece.id)![2] !== FACE.exec(b.piece.id)![2]) {
          expect(meets(a.box, b.box), `${a.piece.id} meets ${b.piece.id} at ${t}`).toBe(false);
        }
      }
      for (const other of live) {
        if (!isDeco(other.piece) || cueOf(other.piece) !== cueOf(a.piece) || /:caret$/.test(other.piece.id)) continue;
        expect(meets(a.box, other.box), `${other.piece.id} meets ${a.piece.id} at ${t}`).toBe(false);
      }
    }
  }
}

describe("pentool", () => {
  test("a word types in grey a beat early, never more than 100 ms, and the white face starts on its spoken start", () => {
    const cues = script(["stop:b waiting:b for:m motivation:h@520"]);
    const pieces = build(cues);
    for (const [w, word] of cues[0]!.words.entries()) {
      const grey = pieces.find((piece) => piece.id === `pentool:0:w${w}g0`)!;
      const face = pieces.find((piece) => piece.id === `pentool:0:w${w}`)!;
      expect(grey.fromMs).toBeGreaterThanOrEqual(word.startMs - 100);
      expect(grey.fromMs).toBeLessThan(word.startMs);
      expect(face.fromMs).toBe(exportFrameAtOrAfter(word.startMs, 30));
      // The grey word is whole by the spoken start, so every glyph reads on the onset frame.
      const onset = exportFrameAtOrAfter(word.startMs, 30);
      const greyAt = pieceBounds(grey, onset, fakeMeasure)!;
      const whole = pieceBounds({ ...grey, clip: undefined }, onset, fakeMeasure)!;
      expect(greyAt.x2).toBeGreaterThanOrEqual(whole.x2 - 0.5);
      // The white face starts partly typed and is whole before the word ends.
      const last = exportFrameAtOrBefore(word.endMs - 1, 30);
      const faceWhole = pieceBounds({ ...face, clip: undefined }, last, fakeMeasure)!;
      expect(pieceBounds(face, last, fakeMeasure)!.x2).toBeGreaterThanOrEqual(faceWhole.x2 - 0.5);
      expect(pieceBounds(face, onset, fakeMeasure)!.x2).toBeLessThan(faceWhole.x2 - 1);
    }
  });

  test("letters step on painted frames: the white clip edge only changes on export frames", () => {
    const pieces = build(script(["motivation:h@520"]));
    const face = pieces.find((piece) => piece.id === "pentool:0:w0")!;
    const frames = new Set(exportFrameTimes(0, 5000, 30));
    for (const [at] of face.clip!.x2) expect(frames.has(at) || frames.has(at + 1)).toBe(true);
  });

  test("continuous speech hands the second cue no lead: its grey word appears whole on the onset and the white pass still types over it", () => {
    const cues = script(["it's:b time:b to:m say:b", "goodbye:h@420 to:m the:m waveform:b"], "en", { cueGap: 0, gap: 0 });
    const pieces = build(cues);
    const word = cues[1]!.words[0]!;
    const grey = pieces.find((piece) => piece.id === "pentool:1:w0g0")!;
    expect(grey.fromMs).toBe(exportFrameAtOrAfter(word.startMs, 30));
    const box = pieceBounds(grey, grey.fromMs, fakeMeasure)!;
    expect(box.x2).toBeGreaterThanOrEqual(pieceBounds({ ...grey, clip: undefined }, grey.fromMs, fakeMeasure)!.x2 - 0.5);
    expect(pieces.find((piece) => piece.id === "pentool:1:w0")!.clip).toBeDefined();
  });

  test("every key-word cue of a long clip draws the pen decoration; chips cycle three colours and pin on the spoken key word", () => {
    const cues = [...fastRun(60), ...fastRun(60).map((cue) => ({ ...cue, index: cue.index + 12, startMs: cue.startMs + 12000, endMs: cue.endMs + 12000, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + 12000, endMs: word.endMs + 12000 })) }))].map((cue, i) => ({ ...cue, index: i }));
    const pieces = build(cues);
    const fills: string[] = [];
    for (const cue of cues) {
      const hero = cue.words.find((word) => word.role === "hero");
      const own = pieces.filter((piece) => cueOf(piece) === cue.index);
      if (!hero) {
        expect(own.some((piece) => /:chip$/.test(piece.id)), `cue ${cue.index}`).toBe(false);
        continue;
      }
      const chip = own.find((piece) => /:chip$/.test(piece.id));
      expect(chip, `cue ${cue.index} has a chip`).toBeDefined();
      expect(own.some((piece) => /:curve$/.test(piece.id)), `cue ${cue.index} has a curve`).toBe(true);
      expect(own.filter((piece) => /:anchor[AB]$/.test(piece.id))).toHaveLength(2);
      expect(chip!.fromMs).toBeGreaterThanOrEqual(hero.startMs);
      const label = own.find((piece) => /:chiptext$/.test(piece.id))!;
      expect(label.kind === "text" && label.text).toBe(pentoolChipLabel(hero, cue.language));
      fills.push(chip!.kind === "shape" ? chip!.fill!.colour : "");
    }
    expect(fills.length).toBeGreaterThan(8);
    expect(new Set(fills).size).toBe(3);
    expect(fills[0]).not.toBe(fills[1]);
    expectClean(pieces);
  });

  test("ordinary speech fires the two extra beats on most cues: selection handles at the start and a closing path at the end", () => {
    const cues = fastRun(60);
    const pieces = build(cues);
    const handles = cues.filter((cue) => pieces.some((piece) => new RegExp(`^pentool:${cue.index}:handle(TL|TR|BL|BR)$`).test(piece.id))).length;
    const paths = cues.filter((cue) => pieces.some((piece) => piece.id === `pentool:${cue.index}:path`)).length;
    expect(handles).toBeGreaterThanOrEqual(cues.length - 1);
    expect(paths).toBeGreaterThanOrEqual(cues.length - 1);
  });

  test("a staccato key word still gets a compact pose of the decoration", () => {
    const cues = script(["we@100 stop:h@120"], "en", { lead: 311, gap: 0, tail: 260 });
    const pieces = build(cues);
    expect(pieces.some((piece) => /:chip$/.test(piece.id))).toBe(true);
    expect(pieces.some((piece) => /:curve$/.test(piece.id))).toBe(true);
  });

  test("the chip label is # plus the key word, lower-cased for cased scripts, punctuation and apostrophes dropped", () => {
    const word = (text: string) => ({ text, startMs: 0, endMs: 100, role: "hero" as const, key: null });
    expect(pentoolChipLabel(word("Motivation."), "en")).toBe("#motivation");
    expect(pentoolChipLabel(word("DOESN'T"), "en")).toBe("#doesnt");
    expect(pentoolChipLabel(word("İSTANBUL"), "tr")).toBe("#istanbul");
    expect(pentoolChipLabel(word("बहुत"), "hi")).toBe("#बहुत");
    expect(pentoolChipLabel(word("اچھا"), "ur")).toBe("#اچھا");
  });

  test("Devanagari with a key word: whole words (no letter clips), rows in the band, nothing covers a word", () => {
    const cues = script(["और:m अगर:b इसे:m सीधा:h@420", "देखो:b तो:m इतना:h@380"], "hi");
    const pieces = build(cues);
    for (const piece of pieces.filter((item) => /:w\d+(g\d+)?$/.test(item.id))) expect(piece.clip, piece.id).toBeUndefined();
    expect(pieces.some((piece) => /:chiptext$/.test(piece.id))).toBe(true);
    expectClean(pieces);
  });

  test("Urdu (RTL) with a key word: words run right to left, whole words, the caret at the reading end", () => {
    const cues = script(["یہ:m بہت:b اچھا:h@600 ہے:m"], "ur");
    const pieces = build(cues);
    const at = cues[0]!.words.at(-1)!.endMs + 50;
    const xs = cues[0]!.words.map((_, w) => {
      const box = pieceBounds(pieces.find((piece) => piece.id === `pentool:0:w${w}`)!, at, fakeMeasure)!;
      return { x: (box.x1 + box.x2) / 2, y: box.y1 };
    });
    for (let w = 1; w < xs.length; w++) {
      if (Math.abs(xs[w]!.y - xs[w - 1]!.y) < 1) expect(xs[w]!.x).toBeLessThan(xs[w - 1]!.x);
    }
    for (const piece of pieces.filter((item) => /:w\d+(g\d+)?$/.test(item.id))) expect(piece.clip, piece.id).toBeUndefined();
    expectClean(pieces);
    expectClean(build(sceneEdgeDemo("urdu").cues));
  });

  test("a CJK cue with no spaces wraps into rows at a readable size instead of shrinking", () => {
    const cues = script(["我们今天学习了很多关于人工智能和机器学习的东西:b@1400"], "zh");
    const pieces = build(cues);
    const parts = pieces.filter((piece) => /^pentool:0:w0l\d+$/.test(piece.id));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const part of parts) expect(part.kind === "text" && part.sizePx).toBeGreaterThanOrEqual(92 * 0.64 - 0.01);
    expectClean(pieces);
    // A 24-character key word keeps the path and anchors; its tag would be too small to read, so there is no chip.
    const hero = build(script(["我们今天学习了很多关于人工智能和机器学习的东西:h@1600"], "zh"));
    expect(hero.some((piece) => /:curve$/.test(piece.id))).toBe(true);
    expect(hero.some((piece) => /:chip$/.test(piece.id))).toBe(false);
  });

  test("an overlong Latin word breaks into even rows at the floor size or larger; long-word and nine-words edge demos stay clean", () => {
    const pieces = build(sceneEdgeDemo("long-word").cues);
    const parts = pieces.filter((piece) => /^pentool:1:w0l\d+$/.test(piece.id));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const part of parts) expect(part.kind === "text" && part.sizePx).toBeGreaterThanOrEqual(92 * 0.64 - 0.01);
    expectClean(pieces);
    expectClean(build(sceneEdgeDemo("nine-words").cues));
  });

  test("mixed Latin and digits: rows in the band, every row inside the safe area at 9:16, 1:1 and 16:9", () => {
    const cues = script(["stop:b waiting:b for:m 2026:h@500", "only:b 24/7:b and:m $1,000:b"]);
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      expectClean(build(cues, { canvas }), canvas);
    }
  });

  test("two overlapping speakers at 2x on 16:9 get two lanes of readable text", () => {
    const { cues } = demoCues({ lines: ["A> some:b fairly:b long:b words:h@300 collide:b", "B> other:b fairly:b long:b words:h@300 interrupt:b"], options: { lead: 400, gap: 0, cueGap: 0 } });
    const run = cues.map((cue, i) => {
      const by = [400, 500][i]! - cue.startMs;
      return { ...cue, speaker: i, startMs: cue.startMs + by, endMs: cue.endMs + by, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + by, endMs: word.endMs + by })) };
    });
    const canvas = { width: 1920, height: 1080 };
    const pieces = build(run, { canvas, scale: 2 });
    const sizes = pieces.filter(isFace).map((piece) => (piece.kind === "text" ? piece.sizePx : 0));
    expect(Math.min(...sizes)).toBeGreaterThan(0.5 * Math.max(...sizes));
    expect(Math.min(...sizes)).toBeGreaterThan(50);
    const area = safe(canvas);
    for (const piece of pieces) {
      for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
        const box = pieceBounds(piece, t, fakeMeasure);
        if (box) expect(inside(box, area), `${piece.id} at ${t}`).toBe(true);
      }
    }
  });

  test("colours as received: a face, chip or preview that cannot read on the ink falls back to the style's own", () => {
    const cues = script(["trust:b the:m process:h@460"]);
    const pieces = build(cues, { colours: { primary: "#101010", highlight: "#1A1030", accent: "#000000", shadow: "#000000" } });
    const face = pieces.find((piece) => piece.id === "pentool:0:w0")!;
    expect(face.kind === "text" && face.fill).toBe("#FFFFFF");
    const chip = pieces.find((piece) => /:chip$/.test(piece.id))!;
    expect(chip.kind === "shape" && chip.fill!.colour).toBe("#FF6B57");
    const grey = pieces.find((piece) => piece.id === "pentool:0:w0g0")!;
    expect(grey.kind === "text" && grey.fill).toBe("#C3C8D2");
    const branded = build(cues, { colours: { ...colours, primary: "#FFE14A", highlight: "#2FD4FF" } });
    expect(evaluatePiece(branded.find((piece) => piece.id === "pentool:0:w0")!, 2000).colour).toBe("#FFE14A");
    expect(branded.find((piece) => /:chip$/.test(piece.id))!.kind === "shape").toBe(true);
  });

  test("the pen never outlives its cue and every decoration ends with its cue", () => {
    const cues = fastRun(0);
    const pieces = build(cues);
    for (const piece of pieces) {
      const cue = cues[cueOf(piece)]!;
      expect(piece.toMs, piece.id).toBeLessThanOrEqual(Math.max(cue.endMs, ...cue.words.map((word) => word.endMs)) + 200);
    }
  });
});
