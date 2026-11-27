import { describe, expect, test } from "bun:test";
import { describeSpeechConformance, fastRun } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameAtOrAfter, exportFrameTimes } from "./frame-grid";
import type { SceneCue, SceneInput } from "./input";
import { type Box, evaluatePiece, type Piece, pieceBounds } from "./scene";
import { sketchProgram } from "./templates/sketch";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("sketch", sketchProgram, { anchorLineY: 1290 });

const colours = { primary: "#FFF1D2", highlight: "#FFC93C", accent: "#FFF1D2", shadow: "#000000" };
const anchor = { xPct: 50, yPct: (1290 / 1920) * 100 };

const build = (lines: string[], options: { language?: string; cueGap?: number; input?: Partial<SceneInput> } = {}) => {
  const { cues } = demoCues({ lines, language: options.language, options: { lead: 400, gap: 30, cueGap: options.cueGap ?? 140, tail: 800 } });
  return { cues, pieces: sketchProgram.build(sceneInput(cues, { fps: 30, colours, anchor, ...options.input })).pieces };
};

const FACE = /^sketch:(\d+):w(\d+)(?:l(\d+))?$/;
const isFace = (piece: Piece) => FACE.test(piece.id);
const cueOf = (piece: Piece) => Number(piece.id.split(":")[1]);
const wordOf = (piece: Piece) => Number(FACE.exec(piece.id)?.[2] ?? -1);
const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
/** The ink box less a margin, as the occlusion test reads a word. */
const core = (box: Box): Box => {
  const dx = (box.x2 - box.x1) * 0.06;
  const dy = (box.y2 - box.y1) * 0.18;
  return { x1: box.x1 + dx, x2: box.x2 - dx, y1: box.y1 + dy, y2: box.y2 - dy };
};
const readable = (piece: Piece, t: number) => {
  const pose = evaluatePiece(piece, t);
  return pose.visible && pose.o >= 0.5 && pieceBounds(piece, t, fakeMeasure) !== null;
};
/** The decoration's own word, from `loop3`, `loop3-1e`, `out3`, `seed3`. */
const ownWord = (piece: Piece) => Number(/:(?:loop|out|seed)(\d+)/.exec(piece.id)?.[1] ?? -1);

/** No decoration of a cue (opacity ≥ 0.2) ever meets another word's readable face of that cue, and words never meet. */
function expectNothingCovered(cues: readonly SceneCue[], pieces: readonly Piece[], label: string) {
  const end = Math.max(...pieces.map((piece) => piece.toMs));
  for (const t of exportFrameTimes(cues[0]!.startMs - 120, end, 30)) {
    const live = pieces.filter((piece) => pieceBounds(piece, t, fakeMeasure) !== null);
    const faces = live.filter((piece) => isFace(piece) && readable(piece, t));
    for (const [i, a] of faces.entries()) {
      for (const b of faces.slice(i + 1)) {
        if (cueOf(a) === cueOf(b) && wordOf(a) !== wordOf(b)) {
          expect(meets(core(pieceBounds(a, t, fakeMeasure)!), core(pieceBounds(b, t, fakeMeasure)!)), `${label}: ${a.id} meets ${b.id} at ${t}`).toBe(false);
        }
      }
    }
    for (const deco of live) {
      if (isFace(deco) || evaluatePiece(deco, t).o < 0.2) continue;
      const box = pieceBounds(deco, t, fakeMeasure)!;
      for (const face of faces) {
        if (cueOf(face) !== cueOf(deco) || ownWord(deco) === wordOf(face)) continue;
        expect(meets(box, core(pieceBounds(face, t, fakeMeasure)!)), `${label}: ${deco.id} is on ${face.id} at ${t}`).toBe(false);
      }
    }
  }
}

/** Every painted face of every cue inside the caption band (y 860..1650 of 1920 at the default anchor) and the safe area. */
function expectInsideBand(pieces: readonly Piece[], label: string, canvas = { width: 1080, height: 1920 }) {
  const natural = Math.min(canvas.width, canvas.height) / 1080;
  const ay = (anchor.yPct / 100) * canvas.height;
  const band = { y1: Math.max(0.05 * canvas.height, ay - 430 * natural) - 2, y2: Math.min(0.95 * canvas.height, ay + 360 * natural) + 2 };
  for (const piece of pieces) {
    for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
      const box = pieceBounds(piece, t, fakeMeasure);
      if (!box) continue;
      expect(box.y1, `${label}: ${piece.id} top at ${t}`).toBeGreaterThanOrEqual(band.y1);
      expect(box.y2, `${label}: ${piece.id} bottom at ${t}`).toBeLessThanOrEqual(band.y2);
      expect(box.x1, `${label}: ${piece.id} left at ${t}`).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
      expect(box.x2, `${label}: ${piece.id} right at ${t}`).toBeLessThanOrEqual(0.95 * canvas.width + 1);
    }
  }
}

/** A time every face of a short demo cue is settled and not yet leaving: well after its onset, before its exit. */
const settledAt = (piece: Piece) => Math.min(piece.fromMs + 400, piece.toMs - 200);
const restY = (piece: Piece) => evaluatePiece(piece, settledAt(piece)).y;
const restX = (piece: Piece) => evaluatePiece(piece, settledAt(piece)).x;

describe("sketch", () => {
  test("every word is one whole face (no letters), and each later word of a cue grows a loop and its echo first", () => {
    const { cues, pieces } = build(["most:b people:b never:m start:b", "you:m are:b unstoppable:h@720"]);
    for (const cue of cues) {
      for (const [at, word] of cue.words.entries()) {
        const face = pieces.find((piece) => piece.id === `sketch:${cue.index}:w${at}`)!;
        expect(face.kind === "text" && face.text).toBe(word.text);
        if (at === 0) continue;
        const loop = pieces.find((piece) => piece.id === `sketch:${cue.index}:loop${at}`)!;
        expect(loop, `cue ${cue.index} word ${at} loop`).toBeDefined();
        expect(pieces.some((piece) => piece.id === `sketch:${cue.index}:loop${at}e`)).toBe(true);
        expect(loop.kind === "shape" && loop.stroke && !loop.fill).toBeTruthy();
        // The loop is a passing state: gone before the word's own face is half visible.
        for (const t of exportFrameTimes(loop.fromMs, loop.toMs, 60)) {
          if (evaluatePiece(face, t).o >= 0.25) expect(evaluatePiece(loop, t).o, `${loop.id} at ${t}`).toBeLessThan(0.2);
        }
        expect(loop.toMs).toBeLessThanOrEqual(word.startMs);
      }
    }
  });

  test("the first word grows a loop when the cue's lead allows it", () => {
    const { pieces } = build(["most:b people:b", "keep:b going:h@520"], { cueGap: 400 });
    expect(pieces.some((piece) => piece.id === "sketch:0:loop0")).toBe(true);
    expect(pieces.some((piece) => piece.id === "sketch:1:loop0")).toBe(true);
  });

  test("the key word's gold loop grows wider than it rests, then contracts onto the word", () => {
    const { pieces } = build(["you:m are:b unstoppable:h@720"]);
    const loop = pieces.find((piece) => piece.id === "sketch:0:loop2")!;
    expect(loop.kind === "shape" && loop.stroke?.colour).toBe("#FFC93C");
    const widths = exportFrameTimes(loop.fromMs, loop.toMs, 60).map((t) => evaluatePiece(loop, t).sx);
    const peak = Math.max(...widths);
    expect(peak - widths.at(-1)!).toBeGreaterThan(0.03);
    const face = pieces.find((piece) => piece.id === "sketch:0:w2")!;
    expect(face.kind === "text" && face.fill).toBe("#FFC93C");
  });

  test("a spoken word never moves again: the key word's pose is final 35 ms after its onset", () => {
    const { cues, pieces } = build(["start:b before:b you're:m ready:h@560"]);
    const word = cues[0]!.words[3]!;
    const face = pieces.find((piece) => piece.id === "sketch:0:w3")!;
    const settled = evaluatePiece(face, word.startMs + 35);
    for (const t of exportFrameTimes(word.startMs + 35, face.toMs, 60)) {
      const pose = evaluatePiece(face, t);
      expect(pose.y).toBeCloseTo(settled.y, 5);
      expect(pose.sx).toBeCloseTo(settled.sx, 5);
    }
  });

  test("rows follow the staircase: words before the key word above it, each line stepping in (right for LTR, left for RTL)", () => {
    const { pieces } = build(["start:b before:b you're:m ready:h@560"]);
    const face = (at: number) => pieces.find((piece) => piece.id === `sketch:0:w${at}`)!;
    expect(restY(face(3))).toBeGreaterThan(restY(face(0)) + 60);
    const left = (piece: Piece) => pieceBounds(piece, settledAt(piece), fakeMeasure)!.x1;
    expect(left(face(3)) - left(face(0))).toBeGreaterThan(40);
    const urdu = build(["یہ:m بہت:b اچھا:h@600 ہے:m"], { language: "ur" }).pieces;
    const u = (at: number) => urdu.find((piece) => piece.id === `sketch:0:w${at}`)!;
    // Right to left: the second word reads to the left of the first; the key word's line steps left.
    expect(restX(u(1))).toBeLessThan(restX(u(0)));
    const right = (piece: Piece) => pieceBounds(piece, settledAt(piece), fakeMeasure)!.x2;
    expect(right(u(0)) - right(u(2))).toBeGreaterThan(40);
    expect(restY(u(2))).toBeGreaterThan(restY(u(0)) + 60);
    // The tilt mirrors: uphill in reading direction.
    expect(evaluatePiece(u(0), settledAt(u(0))).rz).toBeGreaterThan(0);
    expect(evaluatePiece(face(0), settledAt(face(0))).rz).toBeLessThan(0);
  });

  test("seeds travel to the next slot on ordinary speech, and every cue pops settle loops", () => {
    const run = fastRun(60);
    const pieces = sketchProgram.build(sceneInput(run, { fps: 30, colours, anchor })).pieces;
    const later = run.reduce((sum, cue) => sum + cue.words.length - 1, 0);
    const seeds = pieces.filter((piece) => /:seed\d+$/.test(piece.id));
    expect(seeds.length).toBeGreaterThanOrEqual(Math.floor(later * 0.6));
    for (const seed of seeds) {
      const start = evaluatePiece(seed, seed.fromMs);
      const end = evaluatePiece(seed, seed.toMs - 1);
      expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeGreaterThan(20);
    }
    const settled = new Set(pieces.filter((piece) => /:bub\d+-\d+$/.test(piece.id)).map(cueOf));
    expect(settled.size).toBeGreaterThanOrEqual(run.length - 1);
    expect(pieces.filter((piece) => /:loop\d+$/.test(piece.id)).length).toBeGreaterThanOrEqual(Math.floor(later * 0.9));
  });

  test("a long hold repeats the settle loops; the exit flashes the slots back to shrinking loops when there is room", () => {
    const long = build(["keep:b going:h@4200"], { cueGap: 600 });
    expect(new Set(long.pieces.filter((piece) => piece.id.includes(":bub")).map((piece) => piece.id.split(":bub")[1]![0])).size).toBeGreaterThan(1);
    const { cues, pieces } = build(["keep:b going:h@520", "and:m never:b stop:b"], { cueGap: 700 });
    const out = pieces.filter((piece) => /^sketch:0:out\d+$/.test(piece.id));
    expect(out.length).toBe(2);
    for (const piece of out) {
      expect(piece.fromMs).toBeGreaterThanOrEqual(cues[0]!.words.at(-1)!.endMs + 150);
      expect(evaluatePiece(piece, piece.toMs - 1).sx).toBeLessThan(evaluatePiece(piece, piece.fromMs).sx);
    }
  });

  test("no loop, seed or settle loop ever sits on another readable word; words never touch", () => {
    for (const [lines, language] of [
      [["most:b people:b never:m start:b", "start:b before:b you're:m ready:h@560", "courage:h@600 is:m quiet:b", "you:m are:b unstoppable:h@720", "keep:b going:h@520"], undefined],
      [["it's:b time:b to:m say:b goodbye:h@420", "does:b the:m remote:b even:b still:h@360", "the:m remote:b doesn't:h@360 work.:b"], undefined],
    ] as const) {
      const { cues, pieces } = build([...lines], { language });
      expectNothingCovered(cues, pieces, lines[0]!);
    }
  });

  describe("languages", () => {
    test("a Devanagari cue with a key word stays whole per word, inside the band, uncovered", () => {
      const { cues, pieces } = build(["और:m अगर:b इसे:m सीधा:h@500 देखो:b"], { language: "hi" });
      for (const [at, word] of cues[0]!.words.entries()) {
        const faces = pieces.filter((piece) => isFace(piece) && wordOf(piece) === at);
        expect(faces.length).toBe(1);
        expect(faces[0]!.kind === "text" && faces[0]!.text).toBe(word.text);
      }
      expectInsideBand(pieces, "hi");
      expectNothingCovered(cues, pieces, "hi");
    });

    test("an Urdu (RTL) cue with a key word reads right to left, inside the band, uncovered", () => {
      const { cues, pieces } = build(["یہ:m بہت:b اچھا:h@600 ہے:m", "میں نے آج سیکھا:b"], { language: "ur" });
      expectInsideBand(pieces, "ur");
      expectNothingCovered(cues, pieces, "ur");
    });

    test("a CJK cue with no spaces wraps into rows at a readable size, never shrinking below the floor", () => {
      const text = "我们今天要讨论的是人工智能在未来十年里的发展方向";
      const { cues, pieces } = build([`${text}:b@2400`], { language: "zh" });
      const parts = pieces.filter((piece) => /^sketch:0:w0l\d+$/.test(piece.id));
      expect(parts.length).toBeGreaterThanOrEqual(2);
      expect(parts.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(text);
      for (const piece of parts) expect(piece.kind === "text" && piece.sizePx).toBeGreaterThanOrEqual(96 * 0.88 - 0.5);
      expect(new Set(parts.map((piece) => Math.round(restY(piece)))).size).toBe(parts.length);
      expectInsideBand(pieces, "zh");
      expectNothingCovered(cues, pieces, "zh");
    });

    test("a mixed Latin and digits cue with accents stays in reading order, inside the band, uncovered", () => {
      const { cues, pieces } = build(["café:b crème:b 2026:h@500 déjà:m vu:b"], { language: "fr" });
      const face = (at: number) => pieces.find((piece) => piece.id === `sketch:0:w${at}`)!;
      expect(restX(face(1))).toBeGreaterThan(restX(face(0)));
      expect(face(2).kind === "text" && face(2).text).toBe("2026");
      expectInsideBand(pieces, "fr");
      expectNothingCovered(cues, pieces, "fr");
    });

    test("tall and long cues stay in the band at twice the size, portrait and landscape", () => {
      for (const edge of ["urdu", "nine-words", "long-word"] as const) {
        for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
          const { cues } = sceneEdgeDemo(edge);
          const pieces = sketchProgram.build(sceneInput(cues, { fps: 30, colours, anchor, scale: 2, canvas })).pieces;
          expectInsideBand(pieces, `${edge} ${canvas.width}x${canvas.height}`, canvas);
        }
      }
    });
  });

  test("a word wider than the column breaks into the fewest balanced rows at a readable size, without false spaces", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
      for (const word of ["CONTEMPORANEOUSNESS", "abdominohysterectomy", "pneumonoultramicroscopicsilicovolcanoconiosis"]) {
        const { pieces } = build([`${word}:h@1200`], { input: { canvas } });
        const parts = pieces.filter((piece) => /^sketch:0:w0(l\d+)?$/.test(piece.id)).map((piece) => (piece.kind === "text" ? piece : null)!);
        expect(parts.map((piece) => piece.text).join("")).toBe(word);
        for (const piece of parts) {
          expect(piece.sizePx).toBeGreaterThanOrEqual(119);
          expect(piece.text).not.toContain(" ");
        }
        if (parts.length > 1) {
          const lengths = parts.map((piece) => [...piece.text].length);
          expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  test("brand colours that vanish against the charcoal edge fall back to the defaults", () => {
    const { pieces } = build(["you:m are:b unstoppable:h@720"], { input: { colours: { primary: "#151311", highlight: "#2B2623", accent: "#000000", shadow: "#000000" } } });
    const fill = (id: string) => {
      const piece = pieces.find((p) => p.id === id)!;
      return piece.kind === "text" ? piece.fill : piece.stroke?.colour;
    };
    expect(fill("sketch:0:w0")).toBe("#FFF1D2");
    expect(fill("sketch:0:w2")).toBe("#FFC93C");
    const { pieces: branded } = build(["you:m are:b unstoppable:h@720"], { input: { colours: { primary: "#E8F4FF", highlight: "#7CF29A", accent: "#FFFFFF", shadow: "#000000" } } });
    expect(branded.find((p) => p.id === "sketch:0:w2")!.kind === "text" && (branded.find((p) => p.id === "sketch:0:w2") as { fill: string }).fill).toBe("#7CF29A");
  });

  test("the onset frame of every word paints the whole word at 24, 25, 30 and 60 fps", () => {
    for (const fps of [24, 25, 30, 60]) {
      const { cues, pieces } = build(["most:b people:b never:m start:b", "keep:b going:h@520"], { input: { fps } });
      for (const cue of cues) {
        for (const [at, word] of cue.words.entries()) {
          const face = pieces.find((piece) => piece.id === `sketch:${cue.index}:w${at}`)!;
          expect(evaluatePiece(face, exportFrameAtOrAfter(word.startMs, fps)).o).toBeGreaterThan(0.3);
        }
      }
    }
  });
});
