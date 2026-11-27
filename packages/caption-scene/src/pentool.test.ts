import { describe, expect, test } from "bun:test";
import { describeSpeechConformance, fastRun, staccatoRun } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameAtOrAfter, exportFrameAtOrBefore, exportFrameTimes } from "./frame-grid";
import type { SceneCue } from "./input";
import { type Box, evaluatePiece, type Measure, type Piece, pieceBounds } from "./scene";
import { pentoolChipLabel, pentoolProgram } from "./templates/pentool";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("pentool", pentoolProgram, { anchorLineY: 1290 });

/** The real faces draw a CJK character about 1 em wide (the shared fake measure uses 0.55 em for every character). */
const cjkMeasure: Measure = (text, face, size, spacing) => {
  const m = fakeMeasure(text, face, size, spacing);
  const wide = [...text].filter((char) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)).length;
  return { ...m, advance: m.advance + 0.45 * wide * size };
};

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
    // 24 cues of ordinary speech: 180 ms words, 400 ms key words, 60 ms between cues.
    const lines = fastRun(60).map((cue) => cue.words.map((word) => `${word.text}:${word.role === "hero" ? "h@400" : word.role === "minor" ? "m@180" : "b@180"}`).join(" "));
    const cues = script([...lines, ...lines], "en", { gap: 0, cueGap: 60, tail: 500 });
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

  test("a key word that ends its cue too soon for the chip to be read keeps the curve and anchors but no chip", () => {
    const cues = script(["so:m here:b is:m the:m thing:h@100", "nobody:b tells:b you:m this"], "en", { gap: 0, cueGap: 60 });
    const own = build(cues).filter((piece) => cueOf(piece) === 0);
    expect(own.some((piece) => /:curve$/.test(piece.id))).toBe(true);
    expect(own.filter((piece) => /:anchor[AB]$/.test(piece.id))).toHaveLength(2);
    expect(own.some((piece) => /:chip$/.test(piece.id))).toBe(false);
    // The still pose: no pen draws to an empty pin.
    expect(own.some((piece) => /:pen$/.test(piece.id))).toBe(false);
  });

  test("the chip pins inside its key word's spoken window, never before it, at 24, 25, 30 and 60 fps", () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const lines of [["goodbye:h@260 to:m the:m waveform:b"], ["it's:b time:b to:m say:h@420"], ["right@90 now:h@300 ok@200"], ["we@100 stop:h@180"]]) {
        for (const shift of [0, 7, 13, 23]) {
          const cues = script(lines, "en", { lead: 400 + shift, gap: 0, tail: 500 });
          const hero = cues[0]!.words.find((word) => word.role === "hero")!;
          const pieces = build(cues, { fps });
          const chip = pieces.find((piece) => /:chip$/.test(piece.id));
          const label = pieces.find((piece) => /:chiptext$/.test(piece.id));
          if (!chip) continue;
          for (const piece of [chip, label!]) {
            const first = exportFrameTimes(piece.fromMs, piece.toMs, fps).find((t) => pieceBounds(piece, t, fakeMeasure));
            expect(first!, `${lines[0]} at ${fps} fps`).toBeGreaterThanOrEqual(hero.startMs);
            expect(first!, `${lines[0]} at ${fps} fps`).toBeLessThan(hero.endMs);
          }
        }
      }
    }
  });

  test("in runs of real-paced speech every chip that shows first paints inside its key word's spoken window", () => {
    const handoff = script(["it's:b time:b to:m say:b", "goodbye:h@260 to:m the:m waveform:b", "nobody:b tells:b you:m this"], "en", { lead: 311, gap: 0, cueGap: 0, tail: 400 });
    let chips = 0;
    for (const fps of [24, 25, 30, 60]) {
      for (const run of [handoff, staccatoRun(0), staccatoRun(60), fastRun(0), script(["right@90 now:h@100"], "en", { lead: 423, gap: 0, tail: 150 }), script(["right@90 now:h@300"], "en", { lead: 423, gap: 0, tail: 400 })]) {
        const pieces = build(run, { fps });
        for (const label of pieces.filter((piece) => /:chiptext$/.test(piece.id))) {
          const hero = run[cueOf(label)]!.words.find((word) => word.role === "hero")!;
          const first = exportFrameTimes(label.fromMs, label.toMs, fps).find((t) => pieceBounds(label, t, fakeMeasure));
          expect(first!, `${label.id} at ${fps} fps`).toBeGreaterThanOrEqual(hero.startMs);
          expect(first!, `${label.id} at ${fps} fps`).toBeLessThan(hero.endMs);
          chips++;
        }
      }
    }
    expect(chips).toBeGreaterThanOrEqual(8);
  });

  test("a key word at the start of its cue still pins inside its own time: the pen draws a short path from the cue's lead", () => {
    const cues = script(["goodbye:h@260 to:m the:m waveform:b"], "en", { lead: 400, gap: 0, tail: 500 });
    const pieces = build(cues);
    expect(pieces.some((piece) => /:pen$/.test(piece.id))).toBe(true);
    const chip = pieces.find((piece) => /:chip$/.test(piece.id))!;
    expect(chip.fromMs).toBeLessThan(cues[0]!.words[0]!.endMs);
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

  test("everything the pen draws moves with the cue: after a lane or safe-area shift each anchor sits on its curve end and handle line", () => {
    const { cues } = demoCues({ lines: ["A> some:b fairly:b long:b words:h@300 collide:b", "B> other:b fairly:b long:b words:h@300 interrupt:b"], options: { lead: 400, gap: 0, cueGap: 0 } });
    const lanes = cues.map((cue, i) => {
      const by = [400, 500][i]! - cue.startMs;
      return { ...cue, speaker: i, startMs: cue.startMs + by, endMs: cue.endMs + by, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + by, endMs: word.endMs + by })) };
    });
    const cases = [
      { cues: lanes, canvas: { width: 1920, height: 1080 }, scale: 2 },
      { cues: script(["我们今天学习了很多关于人工智能和机器学习的东西:h@1600", "这个:b 真的:b 很重要:h@500"], "zh"), canvas: { width: 1080, height: 1920 }, scale: 1 },
      { cues: script(["stop:b waiting:b for:m motivation:h@520"]), canvas: { width: 1080, height: 1080 }, scale: 2 },
    ];
    let checked = 0;
    for (const { cues: run, canvas, scale } of cases) {
      const pieces = build(run, { canvas, scale });
      for (const cue of run) {
        const get = (name: string) => pieces.find((piece) => piece.id === `pentool:${cue.index}:${name}`);
        const curve = get("curve");
        if (!curve || curve.kind !== "shape") continue;
        const t = curve.toMs - 1;
        const at = (piece: Piece) => evaluatePiece(piece, t);
        const start = curve.path[0]!;
        const end = curve.path[1]!;
        const offset = at(curve);
        const ends = { anchorA: [start[1] as number, start[2] as number], anchorB: [end[5] as number, end[6] as number] };
        for (const [name, [x, y]] of Object.entries(ends)) {
          const square = at(get(name)!);
          expect(square.x, `${name} x, cue ${cue.index}`).toBeCloseTo(x! + offset.x, 3);
          expect(square.y, `${name} y, cue ${cue.index}`).toBeCloseTo(y! + offset.y, 3);
        }
        for (const name of ["handleA", "handleB"]) {
          const line = get(name)!;
          const tip = at(get(`${name}tip`)!);
          if (line.kind !== "shape") continue;
          const far = line.path[1]!;
          expect(tip.x).toBeCloseTo((far[1] as number) + at(line).x, 3);
          expect(tip.y).toBeCloseTo((far[2] as number) + at(line).y, 3);
        }
        // The curve's wipe and pieces carry explicit position tracks, so the shared shift moves them with their anchors.
        for (const name of ["curve", "curvek", "handleA", "handleAk", "handleB", "handleBk", "path"]) {
          const piece = get(name);
          if (piece) expect(piece.track.x && piece.track.y, `${piece.id} has position tracks`).toBeTruthy();
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  test("a wrapped word is whole on its first spoken frame: every row of a long CJK token shows (grey or white) at the onset", () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const [lines, language] of [
        [["我们今天学习了很多关于人工智能和机器学习的东西而且写"], "zh"],
        [["我们今天学习了很多关于人工智能和机器学习的东西而且写:b@70"], "zh"],
        [["我们今天学习了很多关于人工智能和机器学习的东西而:b@93"], "zh"],
        [["这个:b 我们今天学习了很多关于人工智能和机器学习的东西而且写代码:h@900"], "zh"],
        [["it's:m pneumonoultramicroscopicsilicovolcanoconiosis:h@1400"], "en"],
      ] as const) {
        for (const lead of [429, 400, 407, 411, 437]) {
          const cues = script([...lines], language, { lead, gap: 0, tail: 500 });
          const pieces = build(cues, { fps, measure: cjkMeasure });
          for (const [w, word] of cues[0]!.words.entries()) {
            const onset = exportFrameAtOrAfter(word.startMs, fps);
            const parts = pieces.filter((piece) => new RegExp(`^pentool:0:w${w}(l\\d+)?$`).test(piece.id));
            for (const part of parts) {
              const whole = pieceBounds({ ...part, clip: undefined, fromMs: -1e9, toMs: 1e9 }, onset, cjkMeasure)!;
              const grey = pieces.find((piece) => piece.id === part.id.replace(/(w\d+)(?:l(\d+))?$/, (_, head: string, n?: string) => `${head}g${n ?? 0}`));
              const shown = [part, ...(grey ? [grey] : [])].map((piece) => pieceBounds(piece, onset, cjkMeasure)).filter((box): box is Box => box !== null);
              const right = Math.max(...shown.map((box) => box.x2), Number.NEGATIVE_INFINITY);
              const left = Math.min(...shown.map((box) => box.x1), Number.POSITIVE_INFINITY);
              expect(shown.length, `${part.id} at ${onset} (${fps} fps, lead ${lead})`).toBeGreaterThan(0);
              expect(right, `${part.id} right edge at ${onset} (${fps} fps, lead ${lead})`).toBeGreaterThanOrEqual(whole.x2 - 0.5);
              expect(left).toBeLessThanOrEqual(whole.x1 + 0.5);
            }
          }
        }
      }
    }
  });

  test("the grey and white words have a solid outline, so the 3:1 guard holds against the ink as drawn", () => {
    const pieces = build(script(["stop:b waiting:b for:m motivation:h@520"]), { colours: { ...colours, primary: "#666666", accent: "#858585" } });
    const words = pieces.filter((piece) => /:w\d+(g\d+)?$/.test(piece.id));
    expect(words.length).toBeGreaterThan(4);
    for (const piece of words) {
      expect(piece.kind === "text" && piece.stroke?.colour).toBe("#15121F");
      expect(piece.kind === "text" && (piece.stroke?.alpha ?? 1)).toBe(1);
    }
  });

  test("long tokens are budgeted: the floor holds for CONTEMPORANEOUSNESS and a 90-character CJK token; a pathological token is capped in rows and pieces", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }]) {
      for (const [line, language] of [["CONTEMPORANEOUSNESS:h@1200", "en"], [`${"我们今天学习了很多关于人工智能和机器学习的东西".repeat(4).slice(0, 90)}:b@3000`, "zh"]] as const) {
        const pieces = build(script([line], language), { canvas });
        const u = Math.min(canvas.width, canvas.height) / 1080;
        for (const piece of pieces.filter(isFace)) expect(piece.kind === "text" && piece.sizePx, `${piece.id} on ${canvas.width}x${canvas.height}`).toBeGreaterThanOrEqual(92 * 0.64 * u - 0.01);
        expectClean(pieces, canvas);
      }
    }
    const paragraph = "我们今天学习了很多关于人工智能和机器学习的东西".repeat(10).slice(0, 232);
    for (const canvas of [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }]) {
      const pieces = build(script([`${paragraph}:h@6000`], "zh"), { canvas });
      expect(pieces.filter(isFace).length).toBeLessThanOrEqual(8);
      const counted = pieces.reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0), 0);
      expect(counted).toBeLessThanOrEqual(150);
      expect(pieces.filter(isFace).map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(paragraph);
    }
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
