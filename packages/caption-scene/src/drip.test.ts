import { describe, expect, test } from "bun:test";
import { captionColourContrast } from "@narriflow/validators";
import { describeSpeechConformance, fastRun, staccatoRun } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameAtOrAfter, exportFrameAtOrBefore, exportFrameTimes } from "./frame-grid";
import type { SceneCue } from "./input";
import { kf } from "./ease";
import { type Box, evaluatePiece, type Piece, pieceBounds, SCENE_PIECE_BUDGET } from "./scene";
import { DRIP_DEMO, dripProgram } from "./templates/drip";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("drip", dripProgram, { anchorLineY: 1290 });

const colours = { primary: "#FFFFFF", highlight: "#1FE6B4", accent: "#FF3B4E", shadow: "#000000" };
const anchor = { xPct: 50, yPct: (1290 / 1920) * 100 };
const INK = "#16090D";

const build = (cues: readonly SceneCue[], overrides: Parameters<typeof sceneInput>[1] = {}) =>
  dripProgram.build(sceneInput(cues, { fps: 30, colours, anchor, ...overrides })).pieces;
const script = (lines: string[], language?: string, options: Record<string, number> = {}) =>
  demoCues({ lines, language, options: { lead: 400, gap: 30, cueGap: 140, tail: 700, ...options } }).cues;
const shifted = (cues: readonly SceneCue[], by: number, from = 0): SceneCue[] =>
  cues.map((cue, i) => ({ ...cue, index: from + i, startMs: cue.startMs + by, endMs: cue.endMs + by, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + by, endMs: word.endMs + by })) }));
/** 24 cues of ordinary speech. */
const longRun = () => [...fastRun(60), ...shifted(fastRun(60), 12000, 12)];

const FACE = /^drip:(\d+):w(\d+)(?:l\d+)?$/;
const isFace = (piece: Piece) => FACE.test(piece.id);
const cueOf = (piece: Piece) => Number(piece.id.split(":")[1]);
const wordOf = (piece: Piece) => Number(FACE.exec(piece.id)?.[2] ?? -1);
const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
const safe = (canvas = { width: 1080, height: 1920 }): Box => ({ x1: 0.05 * canvas.width - 1, y1: 0.05 * canvas.height - 1, x2: 0.95 * canvas.width + 1, y2: 0.95 * canvas.height + 1 });
const inside = (box: Box, area: Box) => box.x1 >= area.x1 && box.y1 >= area.y1 && box.x2 <= area.x2 && box.y2 <= area.y2;
const whole = (piece: Piece, t: number) => pieceBounds({ ...piece, clip: undefined }, t, fakeMeasure);
const heroOf = (cue: SceneCue) => cue.words.findIndex((word) => word.role === "hero");

/**
 * On every painted frame: no two words of a cue overlap, no decoration of a cue overlaps one of its words (the underline
 * may sit behind its own key word's descenders, a brush tip rides its own word's edge), all inside the safe area.
 */
function expectClean(pieces: readonly Piece[], cues: readonly SceneCue[], canvas = { width: 1080, height: 1920 }): void {
  const area = safe(canvas);
  const to = Math.max(...pieces.map((piece) => piece.toMs));
  for (const t of exportFrameTimes(0, to, 30)) {
    const live = pieces.flatMap((piece) => {
      const box = pieceBounds(piece, t, fakeMeasure);
      return box ? [{ piece, box }] : [];
    });
    for (const { piece, box } of live) expect(inside(box, area), `${piece.id} at ${t}: ${JSON.stringify(box)}`).toBe(true);
    const faces = live.filter(({ piece }) => isFace(piece));
    for (const [i, a] of faces.entries()) {
      for (const b of faces.slice(i + 1)) {
        if (cueOf(a.piece) === cueOf(b.piece) && wordOf(a.piece) !== wordOf(b.piece)) expect(meets(a.box, b.box), `${a.piece.id} meets ${b.piece.id} at ${t}`).toBe(false);
      }
      for (const other of live) {
        if (isFace(other.piece) || cueOf(other.piece) !== cueOf(a.piece)) continue;
        const rest = other.piece.id.split(":")[2]!;
        if (rest === "under" && wordOf(a.piece) === heroOf(cues[cueOf(a.piece)]!)) continue;
        if (rest.startsWith(`tip${wordOf(a.piece)}`) && /^tip\d+(p\d+)?$/.test(rest)) continue;
        expect(meets(a.box, other.box), `${other.piece.id} meets ${a.piece.id} at ${t}`).toBe(false);
      }
    }
  }
}

describe("drip", () => {
  test("a word writes on in reading direction: at most 100 ms early, nearly whole on its onset, whole by its last frame, the edge on export frames", () => {
    const cues = script(["stop:b waiting:b for:m permission:h@660"]);
    const pieces = build(cues);
    const frames = new Set(exportFrameTimes(0, 5000, 30));
    for (const [w, word] of cues[0]!.words.entries()) {
      const face = pieces.find((piece) => piece.id === `drip:0:w${w}`)!;
      expect(face.clip, face.id).toBeDefined();
      expect(face.fromMs).toBeGreaterThanOrEqual(word.startMs - 100);
      expect(face.fromMs).toBeLessThan(word.startMs);
      const onset = exportFrameAtOrAfter(word.startMs, 30);
      const full = whole(face, onset)!;
      const shown = pieceBounds(face, onset, fakeMeasure)!;
      expect(shown, face.id).toEqual(full);
      const last = exportFrameAtOrBefore(word.endMs - 1, 30);
      expect(pieceBounds(face, last, fakeMeasure)!.x2).toBeGreaterThanOrEqual(whole(face, last)!.x2 - 0.5);
      for (const [at] of face.clip!.x2) expect(frames.has(at), `${face.id} edge at ${at}`).toBe(true);
    }
  });

  test("a word with no time before its onset prints whole there (continuous speech), and a 70 ms word is whole by its last frame", () => {
    const cues = script(["it's:b time:b to:m say:b", "goodbye:h@420 to:m the:m waveform:b"], "en", { cueGap: 0, gap: 0 });
    const pieces = build(cues);
    const face = pieces.find((piece) => piece.id === "drip:1:w0")!;
    expect(face.clip).toBeUndefined();
    expect(face.fromMs).toBe(exportFrameAtOrAfter(cues[1]!.words[0]!.startMs, 30));
    const quick = script(["we@70 go@70 now@70"], "en", { gap: 0 });
    const built = build(quick);
    for (const [w, word] of quick[0]!.words.entries()) {
      const piece = built.find((item) => item.id === `drip:0:w${w}`)!;
      const last = exportFrameAtOrBefore(word.endMs - 1, 30);
      expect(pieceBounds(piece, last, fakeMeasure)!.x2).toBeGreaterThanOrEqual(whole(piece, last)!.x2 - 0.5);
    }
  });

  test("no drips: nothing of a key-word cue hangs more than a small underline's depth below the key word's ink", () => {
    const cues = [...longRun(), ...shifted(demoCues(DRIP_DEMO).cues, 26000, 24)];
    for (const fps of [24, 30, 60]) {
      const pieces = dripProgram.build(sceneInput(cues, { fps, colours, anchor })).pieces;
      for (const cue of cues) {
        const hero = heroOf(cue);
        if (hero < 0) continue;
        const own = pieces.filter((piece) => cueOf(piece) === cue.index);
        const heroFaces = own.filter((piece) => isFace(piece) && wordOf(piece) === hero);
        const size = Math.max(...heroFaces.map((piece) => (piece.kind === "text" ? piece.sizePx : 0)));
        for (const piece of own) {
          if (isFace(piece)) continue;
          // Words after the key word sit on the rows under it; their own brush tips and spatter belong to them.
          const tipOf = /:tip(\d+)/.exec(piece.id);
          if (tipOf && Number(tipOf[1]) > hero) continue;
          if (/:fleck\d$/.test(piece.id) && cue.words.length - 1 > hero) continue;
          for (const t of exportFrameTimes(piece.fromMs, piece.toMs, fps)) {
            const box = pieceBounds(piece, t, fakeMeasure);
            if (!box) continue;
            const ink = Math.max(...heroFaces.map((face) => whole(face, Math.max(face.fromMs, t))?.y2 ?? Number.NEGATIVE_INFINITY));
            expect(box.y2, `${piece.id} at ${t} reaches ${box.y2}, the key word's ink ends at ${ink}`).toBeLessThanOrEqual(ink + 0.25 * size);
            // Nothing below the key word's ink is a tall thin run (a drip): it is wider than it is tall, or small.
            if (box.y2 > ink) expect(box.y2 - box.y1 <= Math.max(box.x2 - box.x1, 0.3 * size), `${piece.id} is a vertical run`).toBe(true);
          }
        }
      }
    }
  });

  test("every key-word cue gets its underline, the three strokes cycle, the key-word colour alternates turquoise and lime", () => {
    const cues = longRun();
    const pieces = build(cues);
    const paths: string[] = [];
    const fills: string[] = [];
    for (const cue of cues) {
      const hero = heroOf(cue);
      const under = pieces.find((piece) => piece.id === `drip:${cue.index}:under`);
      if (hero < 0) {
        expect(under, `cue ${cue.index}`).toBeUndefined();
        continue;
      }
      expect(under, `cue ${cue.index} has an underline`).toBeDefined();
      expect(under!.fromMs).toBeGreaterThanOrEqual(exportFrameAtOrAfter(cue.words[hero]!.startMs, 30) - 34);
      const subpaths = under!.kind === "shape" ? under!.path.filter((cmd) => cmd[0] === "M").length : 0;
      paths.push(`${subpaths}`);
      const face = pieces.find((piece) => piece.id === `drip:${cue.index}:w${hero}`)!;
      fills.push(face.kind === "text" ? face.fill : "");
    }
    expect(paths.length).toBeGreaterThan(8);
    expect(new Set(paths)).toEqual(new Set(["1", "2"]));
    expect(new Set(fills)).toEqual(new Set(["#1FE6B4", "#C6F23A"]));
    expect(fills[0]).not.toBe(fills[1]);
    expectClean(pieces, cues);
  });

  test("ordinary speech fires the extra beats: a brush tip on the words that write on and spatter on most cues", () => {
    const cues = longRun();
    const pieces = build(cues);
    const spattered = cues.filter((cue) => pieces.filter((piece) => new RegExp(`^drip:${cue.index}:fleck\\d$`).test(piece.id)).length >= 2).length;
    expect(spattered / cues.length).toBeGreaterThanOrEqual(0.75);
    const written = pieces.filter((piece) => isFace(piece) && piece.clip);
    const tipped = written.filter((face) => pieces.some((piece) => piece.id === `drip:${cueOf(face)}:tip${wordOf(face)}`));
    expect(written.length).toBeGreaterThan(40);
    expect(tipped.length / written.length).toBeGreaterThanOrEqual(0.9);
  });

  test("a brush tip is gone on the frame before its word is whole, and a leaning word never reaches its neighbour", () => {
    const cues = longRun();
    const pieces = build(cues);
    for (const tip of pieces.filter((piece) => /:tip\d+$/.test(piece.id))) {
      const face = pieces.find((piece) => piece.id === `drip:${cueOf(tip)}:w${tip.id.split(":tip")[1]}`)!;
      const readableFrom = exportFrameTimes(face.fromMs, face.toMs, 30).find((t) => pieceBounds(face, t, fakeMeasure)!.x2 >= whole(face, t)!.x2 - 0.5)!;
      expect(tip.toMs, tip.id).toBeLessThanOrEqual(readableFrom);
    }
    // The shear leans the visible part forward by at most tan(lean) x its ink height: still short of the next word.
    for (const face of pieces.filter((piece) => isFace(piece) && piece.track.skx)) {
      const next = pieces.find((piece) => piece.id === `drip:${cueOf(face)}:w${wordOf(face) + 1}`);
      if (!next) continue;
      for (const [t, lean] of face.track.skx!) {
        const box = pieceBounds(face, t, fakeMeasure);
        const other = pieceBounds(next, Math.max(t, next.fromMs), fakeMeasure) ?? whole(next, next.fromMs);
        if (!box || !other || Math.abs(box.y1 - other.y1) > 0.5 * (box.y2 - box.y1)) continue;
        expect(box.x2 + Math.tan((Math.abs(lean) * Math.PI) / 180) * (box.y2 - box.y1)).toBeLessThan(other.x1);
      }
    }
  });

  test("Devanagari with a key word: whole words, rows in the band, nothing covers a word", () => {
    const cues = script(["और:m अगर:b इसे:m सीधा:h@420", "देखो:b तो:m इतना:h@380 है।:b"], "hi");
    const pieces = build(cues);
    for (const cue of cues) for (const [w] of cue.words.entries()) expect(pieces.some((piece) => piece.id === `drip:${cue.index}:w${w}`)).toBe(true);
    expect(pieces.filter((piece) => /:under$/.test(piece.id))).toHaveLength(2);
    expectClean(pieces, cues);
  });

  test("Urdu (RTL) with a key word: words run right to left, the wipe and the underline run right to left", () => {
    const cues = script(["یہ:m بہت:b اچھا:h@600 ہے:m"], "ur");
    const pieces = build(cues);
    const at = cues[0]!.words.at(-1)!.endMs + 50;
    const boxes = cues[0]!.words.map((_, w) => pieceBounds(pieces.find((piece) => piece.id === `drip:0:w${w}`)!, at, fakeMeasure)!);
    for (let w = 1; w < boxes.length; w++) {
      if (Math.abs(boxes[w]!.y1 - boxes[w - 1]!.y1) < 1) expect(boxes[w]!.x1).toBeLessThan(boxes[w - 1]!.x1);
    }
    for (const face of pieces.filter((piece) => isFace(piece) && piece.clip)) {
      const edge = face.clip!.x1.map(([, x]) => x);
      expect(edge.length).toBeGreaterThan(1);
      for (let i = 1; i < edge.length; i++) expect(edge[i]!).toBeLessThanOrEqual(edge[i - 1]!);
    }
    const under = pieces.find((piece) => /:under$/.test(piece.id))!;
    if (under.clip) expect(under.clip.x1.at(-1)![1]).toBeLessThan(under.clip.x1[0]![1]);
    expectClean(pieces, cues);
    const urdu = sceneEdgeDemo("urdu").cues;
    expectClean(build(urdu), urdu);
  });

  test("a CJK cue with no spaces wraps into rows at a readable size instead of shrinking", () => {
    const cues = script(["我们今天学习了很多关于人工智能和机器学习的东西:b@1400"], "zh");
    const pieces = build(cues);
    const parts = pieces.filter((piece) => /^drip:0:w0l\d+$/.test(piece.id));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const part of parts) expect(part.kind === "text" && part.sizePx).toBeGreaterThanOrEqual(124 * 0.62 - 0.5);
    expectClean(pieces, cues);
  });

  test("long tokens hold the floor after the fit (9:16 and 1:1, a 90-character CJK token); a pathological one stays bounded and whole", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }]) {
      for (const [line, floor] of [["contemporaneousness:b@900", 124 * 0.62], ["it's:m contemporaneousness:h@900", 104]] as const) {
        const cues = script([line]);
        const pieces = build(cues, { canvas });
        const w = cues[0]!.words.length - 1;
        const parts = pieces.filter((piece) => new RegExp(`^drip:0:w${w}(l\\d+)?$`).test(piece.id));
        expect(parts.map((part) => (part.kind === "text" ? part.text : "")).join("")).toBe("contemporaneousness");
        for (const part of parts) expect(part.kind === "text" && part.sizePx, `${line} ${canvas.height}`).toBeGreaterThanOrEqual(floor - 0.5);
        expectClean(pieces, cues, canvas);
      }
    }
    const cjk = "我们今天要讨论的是一个非常重要而且非常有意思的问题".repeat(4).slice(0, 90);
    const long = script([`${cjk}:b@3000`], "zh");
    const pieces = build(long);
    const parts = pieces.filter((piece) => /^drip:0:w0l\d+$/.test(piece.id));
    expect(parts.map((part) => (part.kind === "text" ? part.text : "")).join("")).toBe(cjk);
    for (const part of parts) expect(part.kind === "text" && part.sizePx).toBeGreaterThanOrEqual(124 * 0.62 - 0.5);
    expectClean(pieces, long);
    const absurd = "x".repeat(400);
    const built = build(script([`${absurd}:b@3000`, "ok:b"]));
    expect(built.filter((piece) => piece.id.startsWith("drip:0:")).length).toBeLessThanOrEqual(150);
    expect(built.filter((piece) => /^drip:0:w0l\d+$/.test(piece.id)).map((part) => (part.kind === "text" ? part.text : "")).join("")).toBe(absurd);
  });

  test("an overlong word breaks into even rows; long-word and nine-words edge demos stay clean; mixed Latin and digits fit every frame shape", () => {
    const long = sceneEdgeDemo("long-word").cues;
    const pieces = build(long);
    expect(pieces.filter((piece) => /^drip:1:w0l\d+$/.test(piece.id)).length).toBeGreaterThanOrEqual(2);
    expectClean(pieces, long);
    const nine = sceneEdgeDemo("nine-words").cues;
    expectClean(build(nine), nine);
    const cues = script(["stop:b waiting:b for:m 2026:h@500", "only:b 24/7:b and:m $1,000:b", "Ünïcödé:b café:h@420 naïve:b"]);
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) expectClean(build(cues, { canvas }), cues, canvas);
  });

  test("two overlapping speakers at 2x on 16:9: readable lanes, and every clip, offset, tip, underline and fleck moves with its own cue", () => {
    const { cues } = demoCues({ lines: ["A> some:b fairly:b long:b words:h@300 collide:b", "B> other:b fairly:b long:b words:h@300 interrupt:b"], options: { lead: 400, gap: 0, cueGap: 0 } });
    const run = cues.map((cue, i) => {
      const by = [400, 500][i]! - cue.startMs;
      return { ...shifted([cue], by, i)[0]!, speaker: i };
    });
    const canvas = { width: 1920, height: 1080 };
    const pieces = build(run, { canvas, scale: 2 });
    const sizes = pieces.filter(isFace).map((piece) => (piece.kind === "text" ? piece.sizePx : 0));
    expect(Math.min(...sizes)).toBeGreaterThan(50);
    const area = safe(canvas);
    for (const own of [0, 1]) {
      const faces = pieces.filter((piece) => isFace(piece) && cueOf(piece) === own);
      const span = {
        y1: Math.min(...faces.map((face) => whole(face, face.toMs - 1)!.y1)),
        y2: Math.max(...faces.map((face) => whole(face, face.toMs - 1)!.y2)),
      };
      for (const piece of pieces.filter((item) => cueOf(item) === own)) {
        for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
          const box = pieceBounds(piece, t, fakeMeasure);
          if (!box) continue;
          expect(inside(box, area), `${piece.id} at ${t}`).toBe(true);
          if (!isFace(piece)) expect(box.y1 >= span.y1 - 60 && box.y2 <= span.y2 + 60, `${piece.id} at ${t} left its cue`).toBe(true);
        }
        // A word's wipe is cut where the word is: its first frame shows part of it, its last frame all of it.
        if (isFace(piece) && piece.clip) {
          expect(pieceBounds(piece, piece.fromMs, fakeMeasure), piece.id).not.toBeNull();
          expect(pieceBounds(piece, piece.toMs - 1, fakeMeasure)!.x2).toBeGreaterThanOrEqual(whole(piece, piece.toMs - 1)!.x2 - 0.5);
        }
      }
    }
    const other = pieces.filter((piece) => cueOf(piece) === 1);
    for (const face of pieces.filter((piece) => isFace(piece) && cueOf(piece) === 0)) {
      const word = run[0]!.words[wordOf(face)]!;
      const t = exportFrameAtOrBefore(word.endMs - 1, 30);
      const box = pieceBounds(face, t, fakeMeasure)!;
      for (const piece of other) {
        const b = pieceBounds(piece, t, fakeMeasure);
        if (b) expect(meets(box, b), `${piece.id} covers ${face.id} at ${t}`).toBe(false);
      }
    }
  });

  test("colours as received keep 3:1 against the keyline; a brand key-word colour is used on every key word", () => {
    const cues = script(["trust:b the:m process:h@460", "keep:b going:h@460"]);
    for (const primary of ["#101010", "#858585", "#666666", "#FFE14A"]) {
      const pieces = build(cues, { colours: { ...colours, primary, highlight: "#1A1030" } });
      for (const face of pieces.filter(isFace)) {
        const fill = face.kind === "text" ? face.fill : "";
        expect(captionColourContrast(fill, INK), `${primary} drew ${fill}`).toBeGreaterThanOrEqual(3);
      }
      const hero = pieces.find((piece) => piece.id === "drip:0:w2")!;
      expect(hero.kind === "text" && hero.fill).toBe("#1FE6B4");
    }
    const branded = build(cues, { colours: { ...colours, highlight: "#FF8A00" } });
    expect(evaluatePiece(branded.find((piece) => piece.id === "drip:0:w2")!, 3000).colour).toBe("#FF8A00");
    expect(evaluatePiece(branded.find((piece) => piece.id === "drip:1:w1")!, 3000).colour).toBe("#FF8A00");
    // An offset the same colour as the face would vanish: it falls back to coral.
    const flat = build(cues, { colours: { ...colours, accent: "#FFFFFF" } });
    const word = flat.find((piece) => piece.id === "drip:0:w0")!;
    expect(word.kind === "text" && word.shadows![0]!.colour).toBe("#FF3B4E");
  });

  test("the cue leaves with a short fade ending at its window; one-word cues in continuous speech hand off without a blank frame", () => {
    const cues = script(["this:b is:m it:b", "next:b"], "en", { cueGap: 600 });
    const pieces = build(cues);
    const face = pieces.find((piece) => piece.id === "drip:0:w0")!;
    const fade = face.track.o!;
    expect(fade.at(-1)![1]).toBe(0);
    expect(fade.at(-1)![0]).toBe(face.toMs);
    expect(fade.at(-1)![0] - fade.at(-2)![0]).toBeLessThanOrEqual(105);
    const quick = script(["go@150", "on@150", "then@150", "stop:h@150", "now@150"], "en", { cueGap: 0, gap: 0 });
    const built = build(quick);
    const faces = built.filter(isFace);
    for (const t of exportFrameTimes(quick[0]!.words[0]!.startMs, quick.at(-1)!.words[0]!.endMs, 30)) {
      expect(faces.some((piece) => pieceBounds(piece, t, fakeMeasure)), `blank at ${t}`).toBe(true);
    }
  });

  test("a staccato key word still gets a compact underline", () => {
    const cues = script(["we@100 stop:h@120"], "en", { lead: 311, gap: 0, tail: 260 });
    expect(build(cues).some((piece) => /:under$/.test(piece.id))).toBe(true);
  });

  test("review r1: every word is whole and upright on its first spoken frame (24/25/30/60 fps, sub-frame phases, gaps 0 and 60)", () => {
    const runs = [fastRun(0), fastRun(60), staccatoRun(0), script(["it's:b time:b to:m say:b", "goodbye:h@420 to:m the:m waveform:b", "I:m still:b remember:h@300 the:m"], "en", { cueGap: 0, gap: 0 })];
    for (const fps of [24, 25, 30, 60]) {
      for (const by of [0, 7, 13, 23, 31]) {
        for (const run of runs) {
          const cues = shifted(run, by);
          const pieces = dripProgram.build(sceneInput(cues, { fps, colours, anchor })).pieces;
          for (const face of pieces.filter((piece) => isFace(piece) && piece.kind === "text")) {
            const word = cues[cueOf(face)]!.words[wordOf(face)]!;
            const onset = exportFrameAtOrAfter(word.startMs, fps);
            expect(pieceBounds(face, onset, fakeMeasure), `${face.id} at ${onset} (${fps} fps, +${by})`).toEqual(whole(face, onset));
            if (face.track.skx) expect(kf(onset, face.track.skx), `${face.id} leans at ${onset}`).toBe(0);
            // A word that writes on shows it on two painted frames before the onset, each a larger part.
            if (face.clip) expect(exportFrameTimes(face.fromMs, onset, fps).length, face.id).toBeGreaterThanOrEqual(2);
          }
        }
      }
    }
  });

  test("review r1: the wipe moves one edge only; the others clear any fallback ink and the coral offset", () => {
    const cues = script(["ہم:m studio:b دیکھیں:b گے:m", "देखो:b तो:m इतना:h@380"], "ur");
    const canvas = { width: 1080, height: 1920 };
    const pieces = build(cues);
    const clipped = pieces.filter((piece) => isFace(piece) && piece.clip);
    expect(clipped.length).toBeGreaterThan(0);
    for (const face of clipped) {
      const clip = face.clip!;
      for (const track of [clip.y1, clip.y2]) expect(track.length, face.id).toBe(1);
      expect(clip.y1[0]![1]).toBeLessThanOrEqual(0);
      expect(clip.y2[0]![1]).toBeGreaterThanOrEqual(canvas.height);
      const fixed = clip.x1.length === 1 ? clip.x1 : clip.x2;
      expect(fixed.length).toBe(1);
      expect(fixed[0]![1] <= 0 || fixed[0]![1] >= canvas.width, face.id).toBe(true);
    }
  });

  test("review r1: mid-grey faces keep 3:1 against an opaque keyline as drawn", () => {
    const cues = script(["trust:b the:m process:h@460"]);
    for (const grey of ["#858585", "#666666", "#4A4A4A", "#101010"]) {
      for (const which of ["primary", "highlight"] as const) {
        const pieces = build(cues, { colours: { ...colours, [which]: grey } });
        for (const face of pieces.filter((piece) => isFace(piece) && piece.kind === "text")) {
          if (face.kind !== "text") continue;
          expect(face.stroke!.alpha ?? 1, face.id).toBe(1);
          expect(captionColourContrast(face.fill, face.stroke!.colour), `${which} ${grey} drew ${face.fill}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  test("review r1: a key word that paints on one frame keeps its underline on that frame", () => {
    let oneFrame = 0;
    for (const fps of [24, 25]) {
      for (const by of [0, 3, 7, 11, 17, 23, 29, 37]) {
        for (const ms of [60, 70, 80, 90, 100]) {
          const cues = shifted(script([`we@${ms}`, `stop:h@${ms}`, `now@${ms}`], "en", { lead: 333, gap: 0, cueGap: 0, tail: 300 }), by);
          const pieces = dripProgram.build(sceneInput(cues, { fps, colours, anchor })).pieces;
          const hero = pieces.find((piece) => piece.id === "drip:1:w0");
          if (!hero) continue;
          const frames = exportFrameTimes(hero.fromMs, hero.toMs, fps).filter((t) => pieceBounds(hero, t, fakeMeasure));
          if (frames.length === 1) oneFrame++;
          const under = pieces.filter((piece) => piece.id === "drip:1:under" || piece.id === "drip:1:w0l90");
          for (const t of frames) expect(under.some((piece) => pieceBounds(piece, t, fakeMeasure)), `${fps} fps +${by} ${ms} ms: no underline at ${t}`).toBe(true);
        }
      }
    }
    expect(oneFrame).toBeGreaterThan(0);
  });

  test("review r1: NFC and NFD spellings lay out the same", () => {
    const nfc = "CaféCaféCaféCaféCafé".normalize("NFC");
    const nfd = nfc.normalize("NFD");
    expect(nfd).not.toBe(nfc);
    const layout = (text: string) =>
      build(script([`le:m ${text}:h@700 est:b`], "fr")).map((piece) => ({
        id: piece.id, text: piece.kind === "text" ? piece.text : null, size: piece.kind === "text" ? piece.sizePx : null,
        box: pieceBounds(piece, piece.toMs - 1, fakeMeasure),
      }));
    expect(layout(nfd)).toEqual(layout(nfc));
  });

  test("review r1: pathological tokens are capped in rows and drawn layers (shadows counted), keeping all their text", () => {
    const cost = (pieces: readonly Piece[], cue: number) => pieces.filter((piece) => cueOf(piece) === cue).reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0), 0);
    for (const [token, language] of [["x".repeat(400), "en"], ["我们今天要讨论的是一个非常重要而且非常有意思的问题".repeat(40).slice(0, 900), "zh"]] as const) {
      const pieces = build(script([`${token}:b@3000`, "ok:b"], language));
      expect(cost(pieces, 0), `${token.length} characters`).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
      const parts = pieces.filter((piece) => /^drip:0:w0l\d+$/.test(piece.id));
      expect(parts.length).toBeLessThanOrEqual(12);
      expect(parts.map((part) => (part.kind === "text" ? part.text : "")).join("")).toBe(token);
    }
    const four = build(script([`${"x".repeat(300)}:b@900 ${"y".repeat(300)}:b@900 ${"z".repeat(300)}:b@900 ${"w".repeat(300)}:b@900`]));
    expect(cost(four, 0)).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
  });
});
