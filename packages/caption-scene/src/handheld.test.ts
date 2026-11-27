import { describe, expect, test } from "bun:test";
import { describeSpeechConformance, fastRun, staccatoRun } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameAfter, exportFrameAtOrAfter, exportFrameTimes } from "./frame-grid";
import type { SceneCue, SceneInput } from "./input";
import { captionColourContrast } from "@narriflow/validators";
import { type Box, type Measure, type Piece, type ShapePiece, type TextPiece, evaluatePiece, mixColour, pieceBounds } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";
import { HANDHELD_DEMO, handheldProgram } from "./templates/handheld";

describeSpeechConformance("handheld", handheldProgram, { anchorLineY: 1290 });

/** Devanagari and Arabic ink reaches higher and lower than Latin; CJK is square. */
const scriptMeasure: Measure = (text, face, size, spacing) => {
  const base = fakeMeasure(text, face, size, spacing);
  if (/\p{Script=Devanagari}/u.test(text)) return { ...base, inkTop: -0.98 * size, inkBottom: 0.34 * size };
  if (/\p{Script=Arabic}/u.test(text)) return { ...base, inkTop: -0.9 * size, inkBottom: 0.45 * size };
  if (/\p{Script=Han}/u.test(text)) return { ...base, advance: [...text].length * size, inkTop: -0.86 * size, inkBottom: 0.1 * size };
  return base;
};

const COLOURS = { primary: "#2B4220", highlight: "#223719", accent: "#B8D18B", shadow: "#000000" };
const input = (cues: readonly SceneCue[], overrides: Partial<SceneInput> = {}) =>
  sceneInput(cues, { fps: 30, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, measure: scriptMeasure, colours: COLOURS, ...overrides });
const build = (lines: readonly string[], language?: string, overrides: Partial<SceneInput> = {}) => {
  const { cues } = demoCues({ lines, ...(language ? { language } : {}), options: { lead: 400, gap: 30, cueGap: 120, tail: 500 } });
  return { cues, pieces: handheldProgram.build(input(cues, overrides)).pieces };
};
const cueOf = (piece: Piece) => Number(piece.id.split(":")[1]);
const faceRe = /^handheld:(\d+):w(\d+)(?:l(\d+))?$/;
const isFace = (piece: Piece): piece is TextPiece => piece.kind === "text" && faceRe.test(piece.id);
const faces = (pieces: readonly Piece[], cue: number) => pieces.filter((piece): piece is TextPiece => isFace(piece) && cueOf(piece) === cue);
const box = (piece: Piece, t: number, measure: Measure = scriptMeasure) => (evaluatePiece(piece, t).visible ? pieceBounds(piece, t, measure) : null);
const unclipped = (piece: Piece, t: number, measure: Measure = scriptMeasure) => box({ ...piece, clip: undefined }, t, measure);
const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
const inside = (a: Box, b: Box) => a.x1 >= b.x1 - 0.5 && a.x2 <= b.x2 + 0.5 && a.y1 >= b.y1 - 0.5 && a.y2 <= b.y2 + 0.5;
const settled = (cue: SceneCue) => Math.max(...cue.words.map((word) => word.endMs)) - 10;
const centre = (b: Box) => ({ x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 });
/** The glass live at `t` (whichever cue of the stretch draws it). */
const glassAt = (pieces: readonly Piece[], t: number, measure: Measure = scriptMeasure) =>
  pieces.flatMap((piece) => (/:lcd$/.test(piece.id) ? (box(piece, t, measure) ?? []) : []));

/** Every word of a cue whole inside the glass, apart from every other word and from the cursor, pips and the band edges. */
function checkCue(pieces: readonly Piece[], cue: SceneCue, safe: Box = { x1: 54, y1: 96, x2: 1026, y2: 1824 }, measure: Measure = scriptMeasure) {
  const t = settled(cue);
  const own = pieces.filter((piece) => cueOf(piece) === cue.index);
  const words = faces(own, cue.index);
  expect(words.length).toBeGreaterThan(0);
  const glasses = glassAt(pieces, t, measure);
  expect(glasses.length, `one glass behind cue ${cue.index}`).toBe(1);
  const glass = glasses[0]!;
  const inks = words.map((piece) => ({ piece, b: box(piece, t, measure)!, whole: unclipped(piece, t, measure)! }));
  for (const [i, a] of inks.entries()) {
    expect(a.b, `${a.piece.id} drawn`).not.toBeNull();
    expect(inside(a.whole, glass), `${a.piece.id} "${a.piece.text}" inside the glass`).toBe(true);
    expect(a.b.x2 - a.b.x1, `${a.piece.id} not clipped`).toBeCloseTo(a.whole.x2 - a.whole.x1, 1);
    for (const b of inks.slice(i + 1)) expect(meets(a.b, b.b), `${a.piece.id} meets ${b.piece.id}`).toBe(false);
    for (const other of own) {
      if (other.kind === "text" || /:lcd|:scan/.test(other.id)) continue;
      const ob = box(other, t, measure);
      if (ob) expect(meets(a.b, ob), `${other.id} over ${a.piece.id}`).toBe(false);
    }
  }
  for (const piece of pieces) {
    const b = box(piece, t, measure);
    if (b) expect(inside(b, safe), `${piece.id} in the safe area`).toBe(true);
  }
}

describe("handheld layout", () => {
  test("one window holds still through a run of cues: same box on every cue, nothing of two cues on the glass at once", () => {
    const { cues } = demoCues({ ...HANDHELD_DEMO, options: { ...HANDHELD_DEMO.options, cueGap: 60 } });
    const pieces = handheldProgram.build(input(cues, { measure: fakeMeasure })).pieces;
    const boxes = cues.map((cue) => glassAt(pieces, settled(cue), fakeMeasure));
    for (const b of boxes) expect(b).toEqual(boxes[0]!);
    for (const t of exportFrameTimes(cues[0]!.startMs, cues.at(-1)!.endMs, 30)) {
      const live = new Set(pieces.filter((piece) => isFace(piece) && box(piece, t, fakeMeasure)).map(cueOf));
      expect(live.size, `cues on the glass at ${t}`).toBeLessThanOrEqual(1);
      expect(glassAt(pieces, t, fakeMeasure).length, `glasses at ${t}`).toBeLessThanOrEqual(1);
    }
    for (const cue of cues) checkCue(pieces, cue, undefined, fakeMeasure);
  });

  test("a key word takes its own row in reading order, with the cursor after it and the ghost behind it", () => {
    const { cues, pieces } = build(["you:m only:b get:b one:m life:h@520", "level:h@540 up:b today:b", "it:m was:m insane:h@500 honestly:b"]);
    for (const cue of cues) checkCue(pieces, cue);
    const y = (cue: number, word: number) => centre(box(pieces.find((piece) => piece.id === `handheld:${cue}:w${word}`)!, settled(cues[cue]!))!).y;
    expect(y(0, 4)).toBeGreaterThan(y(0, 3));
    expect(y(1, 0)).toBeLessThan(y(1, 1));
    expect(y(2, 2)).toBeGreaterThan(y(2, 1));
    expect(y(2, 3)).toBeGreaterThan(y(2, 2));
    const cursor = pieces.find((piece) => piece.id === "handheld:2:w2cursor")!;
    const hero = box(pieces.find((piece) => piece.id === "handheld:2:w2")!, cursor.fromMs)!;
    expect(box(cursor, cursor.fromMs)!.x1).toBeGreaterThan(hero.x2);
    const ghost = pieces.find((piece) => piece.id === "handheld:2:w2ghost")!;
    expect(ghost.z).toBeLessThan(pieces.find((piece) => piece.id === "handheld:2:w2")!.z);
  });

  test("the window grows to the tallest cue of the clip and stays that size", () => {
    const short = build(["press:b start:h@560"]).pieces;
    const tall = build(["press:b start:h@560", "और:m अगर:b इसे:m सीधा:h@400 देखें:b तो:m"], "hi").pieces;
    const h = (pieces: readonly Piece[]) => {
      const g = glassAt(pieces, 600)[0]!;
      return g.y2 - g.y1;
    };
    expect(h(short)).toBeGreaterThanOrEqual(340);
    expect(h(tall)).toBeGreaterThan(h(short) + 40);
    // The same height on every cue of the tall clip, the short one included.
    const { cues } = demoCues({ lines: ["press:b start:h@560", "और:m अगर:b इसे:m सीधा:h@400 देखें:b तो:m"], language: "hi", options: { lead: 400, gap: 30, cueGap: 120, tail: 500 } });
    const g = cues.map((cue) => glassAt(tall, settled(cue))[0]!);
    expect(g[0]!.y2 - g[0]!.y1).toBeCloseTo(g[1]!.y2 - g[1]!.y1, 3);
  });

  test("a word too wide for the column breaks into even pieces at the floor; a joined script shrinks instead", () => {
    const { cues, pieces } = build(["pneumonoultramicroscopicsilicovolcanoconiosis:b@1400"]);
    const parts = faces(pieces, 0);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((piece) => piece.text).join("")).toBe("PNEUMONOULTRAMICROSCOPICSILICOVOLCANOCONIOSIS");
    for (const part of parts) expect(part.sizePx).toBeGreaterThanOrEqual(64 - 0.01);
    checkCue(pieces, cues[0]!);
  });

  test("CONTEMPORANEOUSNESS keeps the floor at 9:16 and 1:1; a 90-character CJK token wraps above the floor", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }]) {
      const { cues, pieces } = build(["contemporaneousness:h@900 matters:b"], undefined, { canvas });
      for (const part of faces(pieces, 0)) expect(part.sizePx).toBeGreaterThanOrEqual(64 - 0.01);
      checkCue(pieces, cues[0]!, { x1: 54, y1: 0.05 * canvas.height, x2: 1026, y2: 0.95 * canvas.height });
    }
    const token = "我们今天要讨论的是一个非常重要的问题".repeat(5);
    const { cues, pieces } = build([`${token}:b@3000`], "zh");
    const parts = faces(pieces, 0);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.length).toBeLessThan(150);
    for (const part of parts) expect(part.sizePx).toBeGreaterThanOrEqual(64 - 0.01);
    checkCue(pieces, cues[0]!);
  });

  test("a pathological token stays bounded and still shows all of its text", () => {
    const token = "a".repeat(600);
    const { pieces } = build([`${token}:b@3000`]);
    const parts = faces(pieces, 0);
    expect(parts.length).toBeLessThanOrEqual(150);
    expect(parts.map((piece) => piece.text).join("")).toBe(token.toUpperCase());
  });

  test("Devanagari: rows take their height from the measured ink and the cue stays in the glass", () => {
    const { cues, pieces } = build(["display:b glare:b बहुत:h@420", "और:m अगर:b इसे:m सीधा:h@400"], "hi");
    for (const cue of cues) checkCue(pieces, cue);
    expect(faces(pieces, 1).find((piece) => piece.text === "अगर")!.sizePx).toBeGreaterThan(70);
  });

  test("Urdu runs right to left: the first word is rightmost, words enter from the left edge, the cursor sits left of the key word", () => {
    const { cues, pieces } = build(["یہ:m بہت:b اچھا:h@600 ہے:m", "میں:m نے:m آج:b سیکھا:b"], "ur");
    for (const cue of cues) checkCue(pieces, cue);
    const t = settled(cues[1]!);
    const x = (word: number) => centre(box(pieces.find((piece) => piece.id === `handheld:1:w${word}`)!, t)!).x;
    expect(x(0)).toBeGreaterThan(x(1));
    const word = pieces.find((piece) => piece.id === "handheld:1:w2")!;
    expect(evaluatePiece(word, word.fromMs).x).toBeLessThan(x(2));
    const cursor = pieces.find((piece) => piece.id === "handheld:0:w2cursor")!;
    const hero = box(pieces.find((piece) => piece.id === "handheld:0:w2")!, cursor.fromMs)!;
    expect(box(cursor, cursor.fromMs)!.x2).toBeLessThan(hero.x1);
  });

  test("mixed Latin and digits, accented Latin and the edge demos stay inside the glass without overlap", () => {
    const { cues, pieces } = build(["we:m shipped:b 384:b episodes:h@420", "café:b crème:b brûlée:h@400 déjà:b"]);
    for (const cue of cues) checkCue(pieces, cue);
    expect(faces(pieces, 1).map((piece) => piece.text)).toEqual(["CAFÉ", "CRÈME", "BRÛLÉE", "DÉJÀ"]);
    for (const edge of ["long-word", "nine-words", "urdu", "one-word", "no-hero"] as const) {
      const demo = sceneEdgeDemo(edge);
      const built = handheldProgram.build(input(demo.cues)).pieces;
      for (const cue of demo.cues) checkCue(built, cue);
    }
  });

  test("16:9 at twice the size keeps the window and every word in the safe area", () => {
    const canvas = { width: 1920, height: 1080 };
    const { cues } = demoCues(HANDHELD_DEMO);
    const built = handheldProgram.build(input(cues, { canvas, scale: 2 })).pieces;
    for (const cue of cues) checkCue(built, cue, { x1: 96, y1: 54, x2: 1824, y2: 1026 });
  });

  test("two overlapping speakers at 2x on 16:9: each gets its own window, every word inside it, nothing left behind", () => {
    const canvas = { width: 1920, height: 1080 };
    const { cues } = demoCues({ lines: ["first:b@300 late:b@300 words:h@300", "other:b@300 speaker:b@300 talks:b@300"], options: { lead: 357, gap: 0, cueGap: 0 } });
    const run: SceneCue[] = cues.map((cue, i) => {
      const by = [357, 500][i]! - cue.startMs;
      return { ...cue, speaker: i, startMs: cue.startMs + by, endMs: cue.endMs + by, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + by, endMs: word.endMs + by })) };
    });
    const pieces = handheldProgram.build(input(run, { canvas, scale: 2, measure: fakeMeasure })).pieces;
    const t = 1150;
    const glasses = pieces.filter((piece) => /:lcd$/.test(piece.id)).map((piece) => ({ cue: cueOf(piece), b: box(piece, t, fakeMeasure)! }));
    expect(glasses.length).toBe(2);
    expect(meets(glasses[0]!.b, glasses[1]!.b)).toBe(false);
    for (const piece of pieces) {
      const b = box(piece, t, fakeMeasure);
      if (!b || /:lcd/.test(piece.id)) continue;
      const own = glasses.find((glass) => glass.cue === cueOf(piece))!;
      expect(inside(b, own.b), `${piece.id} moves with its window`).toBe(true);
      expect(piece.kind === "text" ? piece.sizePx : 40).toBeGreaterThan(30);
    }
  });
});

describe("handheld motion", () => {
  const { cues } = demoCues(HANDHELD_DEMO);
  const pieces = handheldProgram.build(input(cues, { measure: fakeMeasure })).pieces;
  const at = (id: string) => pieces.find((piece) => piece.id === id)!;

  test("a body word peeks at the glass's right edge and steps into its slot in hard frames by its onset", () => {
    const word = cues[0]!.words[1]!;
    const face = at("handheld:0:w1");
    const xs = exportFrameTimes(face.fromMs, word.startMs + 1, 30).map((t) => evaluatePiece(face, t).x);
    expect(new Set(xs.map((x) => x.toFixed(1))).size).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeLessThanOrEqual(xs[i - 1]! + 0.01);
    const glass = glassAt(pieces, face.fromMs, fakeMeasure)[0]!;
    const first = box(face, face.fromMs, fakeMeasure)!;
    expect(first.x2).toBeCloseTo(glass.x2 - 6, 0);
    expect(face.fromMs).toBeGreaterThanOrEqual(word.startMs - 100);
    const landed = evaluatePiece(face, word.startMs).x;
    expect(evaluatePiece(face, word.startMs + 300).x).toBeCloseTo(landed, 3);
  });

  test("entrance poses never touch another word: the key word's drop stays clear of the row above", () => {
    for (const cue of cues) {
      const words = faces(pieces, cue.index);
      for (const t of exportFrameTimes(cue.startMs - 100, settled(cue), 30)) {
        const live = words.flatMap((piece) => {
          const b = box(piece, t, fakeMeasure);
          return b ? [{ piece, b }] : [];
        });
        for (const [i, a] of live.entries()) for (const b of live.slice(i + 1)) expect(meets(a.b, b.b), `${a.piece.id} meets ${b.piece.id} at ${t}`).toBe(false);
      }
    }
  });

  test("the cue clears in two hard steps on the frames before the next cue's first ink", () => {
    const face = at("handheld:1:w0");
    const lastPaint = exportFrameTimes(face.fromMs, face.toMs, 30).at(-1)!;
    const next = Math.min(...faces(pieces, 2).map((piece) => exportFrameAtOrAfter(piece.fromMs, 30)));
    expect(exportFrameAfter(lastPaint, 30)).toBe(next);
    const frames = exportFrameTimes(face.toMs - 120, face.toMs, 30);
    const xs = frames.map((t) => evaluatePiece(face, t).x);
    expect(xs.at(-1)!).toBeLessThan(xs.at(-2)!);
    expect(xs.at(-2)!).toBeLessThan(xs[0]!);
  });

  test("a one-frame word keeps its window: at 25 fps every painted frame of a face has the glass behind it", () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const run of [staccatoRun(0), staccatoRun(60), fastRun(0)]) {
        const built = handheldProgram.build(input(run, { fps, measure: fakeMeasure })).pieces;
        for (const face of built.filter(isFace)) {
          for (const t of exportFrameTimes(face.fromMs, face.toMs, fps)) {
            const ink = box(face, t, fakeMeasure);
            if (!ink) continue;
            const glass = glassAt(built, t, fakeMeasure);
            expect(glass.length, `${face.id} at ${t} (${fps} fps) has one glass`).toBe(1);
            expect(inside(ink, glass[0]!), `${face.id} at ${t} (${fps} fps) on the glass`).toBe(true);
          }
        }
      }
    }
  });

  test("the window powers on with the first ink and off with the last clear step; it stays lit across a short pause", () => {
    const glass = pieces.filter((piece) => /:lcd$/.test(piece.id));
    const firstPaint = (piece: Piece) => exportFrameAtOrAfter(piece.fromMs, 30);
    const lastPaint = (piece: Piece) => exportFrameTimes(piece.fromMs, piece.toMs, 30).at(-1)!;
    expect(Math.min(...glass.map(firstPaint))).toBe(Math.min(...faces(pieces, 0).map(firstPaint)));
    expect(Math.max(...glass.map(lastPaint))).toBe(Math.max(...pieces.filter(isFace).map(lastPaint)));
    // Real cue ends (a 650 ms tail) and pauses long enough for a readable rest: the glass powers off between all three cues.
    const paused = demoCues({ lines: ["stop:b waiting:b", "press:b start:h@500", "now:b"], options: { lead: 400, gap: 30, cueGap: 1600, tail: 300 } }).cues
      .map((cue, i, all) => ({ ...cue, endMs: Math.min(Math.max(...cue.words.map((word) => word.endMs)) + 650, all[i + 1]?.startMs ?? Number.POSITIVE_INFINITY) }));
    const apart = handheldProgram.build(input(paused, { measure: fakeMeasure })).pieces;
    expect(apart.filter((piece) => /:lcd$/.test(piece.id)).length).toBe(3);
    // A short pause keeps one lit glass across both cues.
    const close = demoCues({ lines: ["stop:b waiting:b", "press:b start:h@500"], options: { lead: 400, gap: 30, cueGap: 400, tail: 300 } }).cues;
    const bridged = handheldProgram.build(input(close, { measure: fakeMeasure })).pieces.filter((piece) => /:lcd$/.test(piece.id));
    expect(bridged.length).toBe(1);
  });

  test("the scan band and the status pips come back on every cue of a long clip; the cursor and ghost on every key-word cue", () => {
    const run = fastRun(60);
    const long = [...run, ...run.map((cue) => ({ ...cue, index: cue.index + run.length, startMs: cue.startMs + 9000, endMs: cue.endMs + 9000, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + 9000, endMs: word.endMs + 9000 })) }))];
    const built = handheldProgram.build(input(long, { measure: fakeMeasure })).pieces;
    const cuesWith = (re: RegExp) => new Set(built.filter((piece) => re.test(piece.id)).map(cueOf));
    expect(cuesWith(/:scan$/).size).toBeGreaterThanOrEqual(long.length - 4);
    expect(cuesWith(/:pip0$/).size).toBeGreaterThanOrEqual(long.length - 4);
    const heroCues = long.filter((cue) => cue.words.some((word) => word.role === "hero")).length;
    expect(cuesWith(/ghost$/).size).toBeGreaterThanOrEqual(heroCues - 2);
    // Each pip lights with its word and stays inside the glass, clear of every word.
    for (const piece of built.filter((p) => /:pip\d$/.test(p.id))) {
      const t = piece.toMs - 1;
      const b = box(piece, t, fakeMeasure);
      if (!b) continue;
      expect(inside(b, glassAt(built, t, fakeMeasure)[0]!)).toBe(true);
      for (const face of built.filter((p) => isFace(p) && cueOf(p) === cueOf(piece))) {
        const ink = box(face, t, fakeMeasure);
        if (ink) expect(meets(b, ink), `${piece.id} over ${face.id}`).toBe(false);
      }
    }
  });
});

describe("handheld colours", () => {
  test("ink that cannot read on the glass falls back to the style's own colours (#858585 and #666666 do not, #333333 does)", () => {
    const grey = build(["it:m starts:b now:h@400"], undefined, { colours: { ...COLOURS, primary: "#858585" } }).pieces;
    expect(faces(grey, 0)[0]!.fill).toBe("#2B4220");
    const dark = build(["it:m starts:b now:h@400"], undefined, { colours: { ...COLOURS, primary: "#333333", highlight: "#222222" } }).pieces;
    expect(faces(dark, 0)[0]!.fill).toBe("#333333");
    const lcd = dark.find((piece) => piece.id === "handheld:0:lcd")!;
    expect(lcd.kind === "shape" && lcd.fill?.colour).toBe("#B8D18B");
  });

  test("a brand glass colour that the ink reads on is used, with its inner border derived from it", () => {
    const { pieces } = build(["it:m starts:b now:h@400"], undefined, { colours: { ...COLOURS, accent: "#E8D9A8" } });
    const lcd = pieces.find((piece) => piece.id === "handheld:0:lcd")!;
    expect(lcd.kind === "shape" && lcd.fill?.colour).toBe("#E8D9A8");
    const ring = pieces.find((piece) => piece.id === "handheld:0:lcdring")!;
    expect(ring.kind === "shape" && ring.stroke?.colour).not.toBe("#93AE66");
  });
});

describe("handheld: review round 1", () => {
  /** Cue ends as the product makes them: a 650 ms tail after the last word, or the next cue's start when that comes first. */
  const realEnds = (cues: readonly SceneCue[]): SceneCue[] =>
    cues.map((cue, i) => {
      const last = Math.max(...cue.words.map((word) => word.endMs));
      return { ...cue, endMs: Math.min(last + 650, cues[i + 1]?.startMs ?? Number.POSITIVE_INFINITY) };
    });
  const lcds = (pieces: readonly Piece[]) => pieces.filter((piece) => /:lcd$/.test(piece.id));
  const lit = (pieces: readonly Piece[], t: number, measure: Measure = fakeMeasure) => lcds(pieces).some((piece) => box(piece, t, measure));
  const inked = (pieces: readonly Piece[], t: number, measure: Measure = fakeMeasure) => pieces.some((piece) => isFace(piece) && box(piece, t, measure));

  test("the glass is never lit without ink: every lit frame shows a word, at every gap and frame rate", () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const cueGap of [0, 60, 360, 690, 900, 1240, 2000]) {
        const cues = realEnds(demoCues({ ...HANDHELD_DEMO, options: { ...HANDHELD_DEMO.options, cueGap } }).cues);
        const pieces = handheldProgram.build(input(cues, { fps, measure: fakeMeasure })).pieces;
        for (const t of exportFrameTimes(0, cues.at(-1)!.endMs + 200, fps)) {
          if (lit(pieces, t)) expect(inked(pieces, t), `bare glass at ${t} (gap ${cueGap}, ${fps} fps)`).toBe(true);
        }
      }
    }
  });

  test("a long spoken pause powers the glass off and the next run opens on its first ink frame; a short one keeps it lit", () => {
    const lines = ["stop:b waiting:b for:m it", "press:b start:h@500"];
    const pause = realEnds(demoCues({ lines, options: { lead: 400, gap: 30, cueGap: 1240, tail: 400 } }).cues);
    const pieces = handheldProgram.build(input(pause, { measure: fakeMeasure })).pieces;
    const frames = exportFrameTimes(pause[0]!.words.at(-1)!.endMs, pause[1]!.startMs, 30);
    expect(frames.some((t) => !lit(pieces, t)), "a dark frame in the pause").toBe(true);
    const opening = exportFrameAtOrAfter(Math.min(...lcds(pieces).filter((piece) => cueOf(piece) === 1).map((piece) => piece.fromMs)), 30);
    expect(faces(pieces, 1).some((piece) => box(piece, opening, fakeMeasure)), `ink on the opening frame ${opening}`).toBe(true);
    const short = realEnds(demoCues({ lines, options: { lead: 400, gap: 30, cueGap: 600, tail: 400 } }).cues);
    const kept = handheldProgram.build(input(short, { measure: fakeMeasure })).pieces;
    for (const t of exportFrameTimes(Math.min(...kept.filter(isFace).map((piece) => exportFrameAtOrAfter(piece.fromMs, 30))), short[1]!.words[0]!.startMs, 30)) {
      expect(lit(kept, t), `lit at ${t}`).toBe(true);
    }
  });

  test("an outlier cue gets a taller window for its own time only, top edge fixed; another run keeps its own height", () => {
    // Four rows: taller than the run's three-row window, short enough to keep its top edge.
    const token = "我们今天要讨论的是一个非常重要的问题".repeat(2);
    const { cues } = demoCues({ lines: ["press:b start:h@560", `${token}:h@3000`, "是的:b@400", "好的:b@400"], language: "zh", options: { lead: 400, gap: 30, cueGap: 60, tail: 500 } });
    const run = realEnds(cues).map((cue, i) => (i === 3 ? shiftCue(cue, 3000) : cue));
    const pieces = handheldProgram.build(input(run)).pieces;
    const g = run.map((cue) => glassAt(pieces, settled(cue))[0]!);
    const h = g.map((b) => b.y2 - b.y1);
    expect(h[1]!).toBeGreaterThan(h[0]! + 100);
    expect(h[2]!).toBeCloseTo(h[0]!, 3);
    expect(g[1]!.y1).toBeCloseTo(g[0]!.y1, 3);
    expect(h[3]!).toBeCloseTo(340, 0);
    // Inside a cue the window never moves or resizes (apart from the one-frame power slits at a run's first and last frame).
    for (const cue of run) {
      const own = faces(pieces, cue.index);
      const from = Math.min(...own.map((piece) => exportFrameAtOrAfter(piece.fromMs, 30)));
      const until = Math.max(...own.map((piece) => piece.toMs));
      const first = glassAt(pieces, settled(cue))[0]!;
      for (const t of exportFrameTimes(from, until, 30).slice(1, -1)) {
        const now = glassAt(pieces, t);
        if (now.length) expect(now[0]!, `window of cue ${cue.index} at ${t}`).toEqual(first);
      }
    }
  });

  test("accepted colours keep 3:1 on the glass, the grid and the grid under the scan; others fall back", () => {
    const { cues } = demoCues(HANDHELD_DEMO);
    for (const [colours, kept] of [
      [{ ...COLOURS, primary: "#666666" }, false],
      [{ ...COLOURS, highlight: "#666666" }, false],
      [{ ...COLOURS, primary: "#333333", highlight: "#222222" }, true],
      [COLOURS, true],
    ] as const) {
      const pieces = handheldProgram.build(input(cues, { colours, measure: fakeMeasure })).pieces;
      const words = pieces.filter(isFace);
      if (!kept) expect(words.every((piece) => piece.fill === COLOURS.primary || piece.fill === COLOURS.highlight)).toBe(true);
      const lcd = pieces.find((piece) => /:lcd$/.test(piece.id)) as ShapePiece;
      const grid = pieces.find((piece) => /:lcdgrid$/.test(piece.id)) as ShapePiece;
      const scan = pieces.find((piece) => /:scan$/.test(piece.id)) as ShapePiece;
      const under = mixColour(lcd.fill!.colour, grid.fill!.colour, grid.fill!.alpha ?? 1);
      const scanned = mixColour(under, scan.fill!.colour, scan.fill!.alpha ?? 1);
      for (const word of words) for (const backing of [lcd.fill!.colour, under, scanned]) expect(captionColourContrast(word.fill, backing), `${word.fill} on ${backing}`).toBeGreaterThanOrEqual(3);
      // The scan really crosses words.
      const crossing = exportFrameTimes(scan.fromMs, scan.toMs, 30).some((t) => {
        const b = box(scan, t, fakeMeasure);
        return b !== null && words.some((word) => {
          const ink = box(word, t, fakeMeasure);
          return ink !== null && meets(b, ink);
        });
      });
      expect(crossing).toBe(true);
    }
  });

  test("long key words take two rows at the floor at 9:16, 1:1 and 16:9 (the cursor counted at the size tried, on its own row)", () => {
    // Silkscreen's real width: about 0.875 em a letter (CONTEMPORA at 80 px is 700 px).
    const wide: Measure = (text, face, size, spacing) => ({ ...fakeMeasure(text, face, size, spacing), advance: [...text].length * (face === "Silkscreen Bold" ? 0.875 : 0.6) * size });
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      for (const word of ["contemporaneousness", "abdominohysterectomy"]) {
        const { cues, pieces } = build([`${word}:h@900`], undefined, { canvas, measure: wide });
        const parts = faces(pieces, 0);
        expect(parts.map((piece) => piece.text), `${word} on ${canvas.width}x${canvas.height}`).toHaveLength(2);
        for (const part of parts) expect(part.sizePx).toBeGreaterThanOrEqual(80 - 0.01);
        checkCue(pieces, cues[0]!, { x1: 0.05 * canvas.width, y1: 0.05 * canvas.height, x2: 0.95 * canvas.width, y2: 0.95 * canvas.height }, wide);
      }
    }
  });

  test("NFC and NFD spell the same layout; a mark with no precomposed form stays on its letter", () => {
    const nfc = "désinstitutionnalisation".normalize("NFC");
    const shapeOf = (word: string) => faces(build([`${word}:h@900`], "fr").pieces, 0).map((piece) => `${piece.text}@${piece.sizePx.toFixed(2)}`);
    expect(shapeOf(nfc).length).toBeGreaterThanOrEqual(2);
    expect(shapeOf(nfc.normalize("NFD"))).toEqual(shapeOf(nfc));
    const parts = faces(build([`${"x\u0303".repeat(40)}:b@900`]).pieces, 0);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const part of parts) expect(part.text.startsWith("\u0303")).toBe(false);
  });

  test("at most 150 layers a cue, shadows counted, with every word kept: nine short words and a 600-letter key word", () => {
    const token = "a".repeat(600);
    const { pieces } = build([`so:m the:m real:b reason:b most:b people:b never:b get:b there:m ${token}:h@3000`]);
    const layers = pieces.filter((piece) => cueOf(piece) === 0).reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0) + (piece.kind === "shape" && piece.fill && piece.stroke ? 1 : 0), 0);
    expect(layers).toBeLessThanOrEqual(150);
    const own = faces(pieces, 0);
    for (let word = 0; word < 10; word++) expect(own.some((piece) => faceRe.exec(piece.id)![2] === String(word))).toBe(true);
    expect(own.filter((piece) => piece.id.startsWith("handheld:0:w9")).map((piece) => piece.text).join("")).toBe(token.toUpperCase());
  });

  test("short cues keep a compact scan and a still cursor: staccato speech at 25 fps", () => {
    const run = staccatoRun(0);
    const pieces = handheldProgram.build(input(run, { fps: 25, measure: fakeMeasure })).pieces;
    const paints = (re: RegExp, cue: number) => pieces.some((piece) => re.test(piece.id) && cueOf(piece) === cue && exportFrameTimes(piece.fromMs, piece.toMs, 25).filter((t) => box(piece, t, fakeMeasure)).length >= 2);
    const scanned = run.filter((cue) => paints(/:scan$/, cue.index)).length;
    const heroCues = run.filter((cue) => cue.words.some((word) => word.role === "hero"));
    const cursors = heroCues.filter((cue) => paints(/cursor$/, cue.index)).length;
    expect(scanned).toBeGreaterThanOrEqual(run.length - 1);
    expect(cursors).toBe(heroCues.length);
  });
});

function shiftCue(cue: SceneCue, by: number): SceneCue {
  return { ...cue, startMs: cue.startMs + by, endMs: cue.endMs + by, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + by, endMs: word.endMs + by })) };
}

describe("handheld: review round 2", () => {
  const realEnds = (cues: readonly SceneCue[]): SceneCue[] =>
    cues.map((cue, i) => ({ ...cue, endMs: Math.min(Math.max(...cue.words.map((word) => word.endMs)) + 650, cues[i + 1]?.startMs ?? Number.POSITIVE_INFINITY) }));
  const lcds = (pieces: readonly Piece[]) => pieces.filter((piece) => /:lcd$/.test(piece.id));

  test("a power cycle leaves a readable rest (eight dark frames) or none: the real English gaps 740, 760, 820 and 1,240 ms", () => {
    const lines = ["it's:m been:b that:m long", "all:b of:m them:b are:m", "the:m remote:b doesn't:h@360 work", "is:m it:m dead?:h@380", "oh:b right"];
    const gaps = [740, 760, 820, 1240];
    let t = 400;
    const cues: SceneCue[] = lines.map((line, i) => {
      const cue = demoCues({ lines: [line], options: { lead: 0, gap: 0, cueGap: 0, tail: 0 } }).cues[0]!;
      const shifted = shiftCue({ ...cue, index: i }, t - cue.startMs);
      t = Math.max(...shifted.words.map((word) => word.endMs)) + (gaps[i] ?? 0);
      return shifted;
    });
    const run = realEnds(cues);
    for (const fps of [24, 25, 30, 60]) {
      const pieces = handheldProgram.build(input(run, { fps, measure: fakeMeasure })).pieces;
      const frames = exportFrameTimes(run[0]!.startMs - 100, run.at(-1)!.endMs, fps);
      const lit = frames.map((at) => lcds(pieces).some((piece) => box(piece, at, fakeMeasure)));
      const first = lit.indexOf(true);
      const last = lit.lastIndexOf(true);
      let dark = 0;
      for (let i = first; i <= last; i++) {
        if (!lit[i]) dark++;
        else {
          expect(dark === 0 || dark >= 8, `${dark} dark frames before ${frames[i]} at ${fps} fps`).toBe(true);
          dark = 0;
        }
      }
      // The 1,240 ms pause is a real rest; the glass powers off there at every frame rate.
      const pause = exportFrameTimes(Math.max(...run[3]!.words.map((word) => word.endMs)), run[4]!.startMs, fps);
      expect(pause.some((at) => !lcds(pieces).some((piece) => box(piece, at, fakeMeasure))), `rest at ${fps} fps`).toBe(true);
    }
  });

  test("everything a cue draws stays inside the glass as drawn, the opening slit included: a short key word opens the clip at 25 fps", () => {
    const run = demoCues({ lines: ["now:h@80", "listen:b@300 to:m me"], options: { lead: 0, gap: 0, cueGap: 0, tail: 400 } }).cues;
    for (const fps of [24, 25, 30]) {
      const pieces = handheldProgram.build(input(run, { fps, measure: fakeMeasure })).pieces;
      for (const at of exportFrameTimes(0, run.at(-1)!.endMs, fps)) {
        const glass = lcds(pieces).flatMap((piece) => box(piece, at, fakeMeasure) ?? []);
        for (const piece of pieces) {
          if (/:lcd/.test(piece.id)) continue;
          const b = box(piece, at, fakeMeasure);
          if (b) expect(glass.some((g) => inside(b, g)), `${piece.id} outside the glass at ${at} (${fps} fps)`).toBe(true);
        }
      }
    }
  });

  test("a long key word takes the adjacent cut when the cursor makes the balanced one too wide (COUNTERREVO / LUTIONARIES)", () => {
    // Silkscreen-like widths: I is narrow.
    const silk: Measure = (text, face, size, spacing) => ({
      ...fakeMeasure(text, face, size, spacing),
      advance: [...text].reduce((sum, ch) => sum + (face === "Silkscreen Bold" ? (ch === "I" ? 0.4 : 0.875) : 0.6), 0) * size,
    });
    const { cues, pieces } = build(["counterrevolutionaries:h@900"], undefined, { measure: silk });
    const parts = faces(pieces, 0);
    expect(parts.map((piece) => piece.text)).toEqual(["COUNTERREVO", "LUTIONARIES"]);
    for (const part of parts) expect(part.sizePx).toBeGreaterThanOrEqual(80 - 0.01);
    checkCue(pieces, cues[0]!, undefined, silk);
  });

  test("the layer limiter acts on a crowded cue: at most 150 layers with shadows, every word kept", () => {
    const words = Array.from({ length: 90 }, (_, i) => `w${i}:b@100`).join(" ");
    const { pieces } = build([words]);
    const own = pieces.filter((piece) => cueOf(piece) === 0);
    const layers = own.reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0) + (piece.kind === "shape" && piece.fill && piece.stroke ? 1 : 0), 0);
    expect(layers).toBeLessThanOrEqual(150);
    expect(faces(pieces, 0).length).toBe(90);
    expect(own.some((piece) => /:pip\d$|:scan$/.test(piece.id))).toBe(false);
  });
});

