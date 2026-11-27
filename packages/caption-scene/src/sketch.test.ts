import { describe, expect, test } from "bun:test";
import { describeSpeechConformance, fastRun, staccatoRun } from "./conformance-support";
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
    // Most travel; a window too short to travel holds the seed still on the way.
    const travelled = seeds.filter((seed) => {
      const start = evaluatePiece(seed, seed.fromMs);
      const end = evaluatePiece(seed, seed.toMs - 1);
      return Math.hypot(end.x - start.x, end.y - start.y) > 20;
    });
    expect(travelled.length).toBeGreaterThanOrEqual(Math.floor(seeds.length / 2));
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

    test("tall and long cues stay in the band at the sample size, and at twice the size keep their floor inside the lane", () => {
      for (const edge of ["urdu", "nine-words", "long-word"] as const) {
        for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
          const { cues } = sceneEdgeDemo(edge);
          const natural = sketchProgram.build(sceneInput(cues, { fps: 30, colours, anchor, canvas })).pieces;
          expectInsideBand(natural, `${edge} ${canvas.width}x${canvas.height}`, canvas);
          // At 2x a cue that cannot keep its floor inside the band may use the whole lane (the safe area).
          const big = sketchProgram.build(sceneInput(cues, { fps: 30, colours, anchor, scale: 2, canvas })).pieces;
          const unit = Math.min(canvas.width, canvas.height) / 1080;
          for (const piece of big) {
            if (piece.kind === "text") expect(piece.sizePx, `${edge} ${canvas.width}x${canvas.height} ${piece.id}`).toBeGreaterThanOrEqual(96 * 0.88 * unit - 0.5);
          }
        }
      }
    });
  });

  test("a word wider than the column breaks into the fewest rows that fit at the floor, balanced, without false spaces", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      for (const word of ["CONTEMPORANEOUSNESS", "abdominohysterectomy", "pneumonoultramicroscopicsilicovolcanoconiosis", "WW日miAMiWQy日WMMQiMmiQmmyWQAmWMA日iQ"]) {
        const { pieces } = build([`${word}:h@1200`], { input: { canvas } });
        const parts = pieces.filter((piece) => /^sketch:0:w0(l\d+)?$/.test(piece.id)).map((piece) => (piece.kind === "text" ? piece : null)!);
        expect(parts.map((piece) => piece.text).join("")).toBe(word);
        const unit = Math.min(canvas.width, canvas.height) / 1080;
        for (const piece of parts) {
          expect(piece.sizePx, `${word} ${canvas.width}x${canvas.height}`).toBeGreaterThanOrEqual(120 * 0.88 * unit - 0.5);
          expect(piece.text).not.toContain(" ");
        }
        // The fake measure gives every character 0.55 em: the fewest rows at the 120 px floor in the 840 px column (98%).
        const perRow = Math.floor((840 * 0.98) / (0.55 * 120));
        expect(parts.length, `${word} ${canvas.width}x${canvas.height}`).toBeLessThanOrEqual(Math.max(1, Math.ceil([...word].length / perRow)));
        const lengths = parts.map((piece) => [...piece.text].length);
        expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
      }
    }
  });

  test("with real-looking widths, a long token takes the smallest row count that fits (the greedy even split skipped it)", () => {
    // Additive per-glyph widths, like Sol's measured mixed token: wide W, M and 日, narrow i.
    const em = (ch: string) => (/[WM日]/.test(ch) ? 0.95 : /[iy]/.test(ch) ? 0.3 : 0.6);
    const measure: typeof fakeMeasure = (text, _face, sizePx) => ({
      advance: [...text].reduce((sum, ch) => sum + em(ch), 0) * sizePx,
      inkTop: -0.72 * sizePx,
      inkBottom: 0.2 * sizePx,
      ascent: 1.1 * sizePx,
      descent: 0.3 * sizePx,
    });
    for (const word of ["日ayMbyaaaaMbbbiiyb日MiiyaiyWMbW日ba日iiMbM日iM", "WiaMibiybbMaMyaWb日yMbyiy日aiiaiWWayaiabM日ia日M", "aWWyMWMbyiayyWba日bMMi日baW日日ib"]) {
      const { pieces } = build([`${word}:h@1200`], { input: { measure } });
      const parts = pieces.filter((piece) => /^sketch:0:w0(l\d+)?$/.test(piece.id)).map((piece) => (piece.kind === "text" ? piece : null)!);
      expect(parts.map((piece) => piece.text).join("")).toBe(word);
      // The fewest rows any split at the 120 px floor fits the 840 px column (98%) in: greedy longest rows is optimal.
      const limit = (840 * 0.98) / 120;
      let rows = 1;
      let run = 0;
      for (const ch of word) {
        if (run > 0 && run + em(ch) > limit) {
          rows++;
          run = 0;
        }
        run += em(ch);
      }
      expect(parts.length, word).toBe(rows);
      for (const piece of parts) expect(piece.sizePx).toBeGreaterThanOrEqual(119.5);
    }
  });

  test("CJK rows never start with closing punctuation, and a 90-character token keeps its floor inside the lane", () => {
    const quote = "他说「我们今天要讨论的是人工智能在未来十年里的发展方向」：这是我们这一代人最重要的问题之一";
    const { pieces } = build([`${quote}:h@3000`], { language: "zh" });
    const rows = pieces.filter((piece) => /^sketch:0:w0l\d+$/.test(piece.id)).map((piece) => (piece.kind === "text" ? piece.text : ""));
    expect(rows.join("")).toBe(quote);
    for (const row of rows.slice(1)) expect(row, row).not.toMatch(/^[\p{Pe}\p{Pf}\p{Po}]/u);
    for (const row of rows) expect(row, row).not.toMatch(/[\p{Ps}\p{Pi}]$/u);
    const long = "我们今天要讨论的是人工智能在未来十年里的发展方向".repeat(4).slice(0, 90);
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }]) {
      for (const role of ["b", "h"] as const) {
        const built = build([`${long}:${role}@4000`], { language: "zh", input: { canvas } }).pieces;
        const unit = Math.min(canvas.width, canvas.height) / 1080;
        for (const piece of built) {
          // A key word that long keeps the key-word floor where the lane holds its rows (9:16) and the body floor on 1:1.
          const floor = role === "h" && canvas.height > canvas.width ? 120 : 96;
          if (piece.kind === "text") expect(piece.sizePx, `${role} ${canvas.width}x${canvas.height}`).toBeGreaterThanOrEqual(floor * unit - 0.5);
        }
        expect(built.length).toBeLessThanOrEqual(150);
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

  test("every face and its keyline are fully opaque on their first spoken frame, also when the lead is consumed", () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const run of [fastRun(0), fastRun(60), staccatoRun(0), staccatoRun(60), demoCues({ lines: ["most:b people:b never:m start:b", "keep:b going:h@520"] }).cues]) {
        for (const grey of [false, true]) {
          const input = grey ? { colours: { primary: "#777777", highlight: "#777777", accent: "#777777", shadow: "#000000" } } : {};
          const pieces = sketchProgram.build(sceneInput(run, { fps, colours, anchor, ...input })).pieces;
          for (const cue of run) {
            for (const [at, word] of cue.words.entries()) {
              const face = pieces.find((piece) => piece.id === `sketch:${cue.index}:w${at}`)!;
              const onset = exportFrameAtOrAfter(word.startMs, fps);
              expect(evaluatePiece(face, onset).o, `${face.id} at ${onset} (${fps} fps)`).toBeGreaterThanOrEqual(0.999);
            }
          }
        }
      }
    }
  });

  test("a contour (loop, echo, seed, exit loop) never paints a near-invisible frame and has at least two clear ones", () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const run of [staccatoRun(0), staccatoRun(60), fastRun(0), fastRun(60)]) {
        const pieces = sketchProgram.build(sceneInput(run, { fps, colours, anchor })).pieces;
        for (const piece of pieces.filter((p) => /:(?:loop|out|seed)\d+/.test(p.id))) {
          const painted = exportFrameTimes(piece.fromMs, piece.toMs, fps).filter((t) => pieceBounds(piece, t, fakeMeasure));
          expect(painted.length, `${piece.id} (${fps} fps)`).toBeGreaterThanOrEqual(2);
          for (const t of painted) expect(evaluatePiece(piece, t).o, `${piece.id} at ${t} (${fps} fps)`).toBeGreaterThanOrEqual(0.35);
        }
      }
    }
  });

  test("an entrance contour ends on the export frame before its word first paints", () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const run of [staccatoRun(0), fastRun(0), fastRun(60), demoCues({ lines: ["start:b before:b you're:m ready:h@560", "courage:h@600 is:m quiet:b"], options: { rate: 205, gap: 30, cueGap: 240, lead: 300 } }).cues]) {
        const pieces = sketchProgram.build(sceneInput(run, { fps, colours, anchor })).pieces;
        for (const loop of pieces.filter((p) => /:loop\d+(-\d+)?e?$/.test(p.id))) {
          const [, cue, word] = /^sketch:(\d+):loop(\d+)/.exec(loop.id)!;
          const faces = pieces.filter((p) => new RegExp(`^sketch:${cue}:w${word}(l\\d+)?$`).test(p.id));
          const firstFace = Math.min(...faces.map((face) => exportFrameTimes(face.fromMs, face.toMs, fps).find((t) => pieceBounds(face, t, fakeMeasure)) ?? Number.POSITIVE_INFINITY));
          const lastLoop = Math.max(...exportFrameTimes(loop.fromMs, loop.toMs, fps).filter((t) => pieceBounds(loop, t, fakeMeasure)));
          expect(lastLoop, `${loop.id} (${fps} fps)`).toBeLessThan(firstFace);
        }
      }
    }
  });

  test("the exit fades the word before its slot loop returns, and settle loops end before the exit starts", () => {
    const { pieces } = build(["keep:b going:h@520", "and:m never:b stop:b"], { cueGap: 700 });
    const out = pieces.filter((piece) => /^sketch:0:out\d+e?$/.test(piece.id));
    expect(out.length).toBeGreaterThan(0);
    for (const loop of out) {
      const word = /out(\d+)/.exec(loop.id)![1];
      const face = pieces.find((piece) => piece.id === `sketch:0:w${word}`)!;
      for (const t of exportFrameTimes(loop.fromMs, loop.toMs, 30)) {
        if (pieceBounds(loop, t, fakeMeasure)) expect(evaluatePiece(face, t).o, `${face.id} at ${t}`).toBeLessThan(0.01);
      }
    }
    for (const lines of [["keep:b going:h@520", "and:m never:b stop:b"], ["keep:b going:h@4200", "and:m never:b stop:b"]]) {
      const built = build(lines, { cueGap: 700 }).pieces;
      const faces = built.filter((piece) => /^sketch:0:w\d+$/.test(piece.id));
      const exitStart = Math.min(...faces.map((face) => {
        const o = face.track.o!;
        const peak = o.findIndex((frame) => frame[1] >= 1);
        const fall = o.findIndex((frame, i) => i > peak && frame[1] < 1);
        return fall < 0 ? Number.POSITIVE_INFINITY : o[fall - 1]![0];
      }));
      for (const settle of built.filter((piece) => /^sketch:0:bub/.test(piece.id))) {
        expect(settle.toMs, settle.id).toBeLessThanOrEqual(exitStart + 0.5);
      }
    }
  });

  test("settle loops are loose word-style pencil loops, large enough to read at phone size", () => {
    const { pieces } = build(["keep:b going:h@900"]);
    const settle = pieces.filter((piece) => /:bub\d+-\d+$/.test(piece.id));
    expect(settle.length).toBeGreaterThan(1);
    for (const piece of settle) {
      const box = pieceBounds({ ...piece, track: {} }, piece.fromMs, fakeMeasure)!;
      expect(box.x2 - box.x1).toBeGreaterThanOrEqual(40);
      expect(box.x2 - box.x1).toBeGreaterThan(box.y2 - box.y1);
    }
  });
  test("every frame of a loop-to-word hand-off carries ink, and a face never paints nearly invisible (60 fps grid hits included)", () => {
    const shifted = (cues: readonly SceneCue[], by: number): SceneCue[] =>
      cues.map((cue) => ({ ...cue, startMs: cue.startMs + by, endMs: cue.endMs + by, words: cue.words.map((w) => ({ ...w, startMs: w.startMs + by, endMs: w.endMs + by })) }));
    const demo = demoCues({ lines: ["most:b people:b never:m start:b", "oh.:b", "and,:b we:m didn't:h@300 want:b"], options: { lead: 300, gap: 30, cueGap: 240 } }).cues;
    for (const fps of [60, 30, 25, 24]) {
      for (let by = 0; by < 17; by++) {
        for (const base of [demo, fastRun(60), staccatoRun(60)]) {
          const run = shifted(base, by);
          const pieces = sketchProgram.build(sceneInput(run, { fps, colours, anchor })).pieces;
          for (const cue of run) {
            for (const [at, word] of cue.words.entries()) {
              const face = pieces.find((piece) => piece.id === `sketch:${cue.index}:w${at}`)!;
              const firstFace = exportFrameTimes(face.fromMs, face.toMs, fps).find((t) => pieceBounds(face, t, fakeMeasure))!;
              expect(evaluatePiece(face, firstFace).o, `${face.id} first frame ${firstFace} (${fps} fps, +${by})`).toBeGreaterThanOrEqual(0.3);
              const loop = pieces.find((piece) => piece.id === `sketch:${cue.index}:loop${at}`);
              if (!loop) continue;
              const onset = exportFrameAtOrAfter(word.startMs, fps);
              for (const t of exportFrameTimes(loop.fromMs, onset + 1, fps)) {
                const inked = [loop, face].some((piece) => pieceBounds(piece, t, fakeMeasure) && evaluatePiece(piece, t).o >= 0.3);
                expect(inked, `${cue.index}:${at} blank at ${t} (${fps} fps, +${by})`).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  test("every face is in its slot at its settled scale on its first spoken frame, also a key word with no lead", () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const run of [fastRun(0), staccatoRun(0), demoCues({ lines: ["it's:b been:b that:b long.:h@300", "all:h@300 right"], options: { lead: 300, gap: 0, cueGap: 0 } }).cues]) {
        const pieces = sketchProgram.build(sceneInput(run, { fps, colours, anchor })).pieces;
        for (const cue of run) {
          for (const [at, word] of cue.words.entries()) {
            const face = pieces.find((piece) => piece.id === `sketch:${cue.index}:w${at}`)!;
            const onset = exportFrameAtOrAfter(word.startMs, fps);
            const pose = evaluatePiece(face, onset);
            const settled = face.track.y!.at(-1)![1];
            expect(pose.y, `${face.id} y at ${onset} (${fps} fps)`).toBeCloseTo(settled, 3);
            expect(pose.sx, `${face.id} scale at ${onset} (${fps} fps)`).toBeCloseTo(1, 4);
          }
        }
      }
    }
  });

  test("a cue stays within 150 pieces with every shadow layer counted, keeping all its text", () => {
    // Real CJK advances are about one em: a long key word takes several rows.
    const measure: typeof fakeMeasure = (text, _face, sizePx) => ({
      advance: [...text].reduce((sum, ch) => sum + (/\p{Script=Han}/u.test(ch) ? 1 : 0.55), 0) * sizePx,
      inkTop: -0.72 * sizePx,
      inkBottom: 0.2 * sizePx,
      ascent: 1.1 * sizePx,
      descent: 0.3 * sizePx,
    });
    const token = "我们今天要讨论的是人工智能在未来十年里的发展方向我";
    for (const lines of [[`a very long word can make the caption wrap ${token}:h@7200`], ["a very long word can make the caption wrap", `${token}:h@7200`]]) {
      const { cues, pieces } = build(lines, { language: "zh", input: { measure } });
      for (const cue of cues) {
        const own = pieces.filter((piece) => cueOf(piece) === cue.index);
        const cost = own.reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0), 0);
        expect(cost, `cue ${cue.index}`).toBeLessThanOrEqual(150);
        for (const [at] of cue.words.entries()) expect(own.some((piece) => isFace(piece) && wordOf(piece) === at)).toBe(true);
      }
    }
  });
});
