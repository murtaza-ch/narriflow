import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameAtOrAfter, exportFrameAtOrBefore, exportFrameTimes } from "./frame-grid";
import { type Box, type Piece, evaluatePiece, pieceBounds } from "./scene";
import { pixelpopProgram } from "./templates/pixelpop";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("pixelpop", pixelpopProgram, { anchorLineY: 1290 });

const colours = { primary: "#FFFFFF", highlight: "#FFEF3A", accent: "#2BE4FF", shadow: "#000000" };
const build = (lines: string[], opts: { gap?: number; cueGap?: number; language?: string; fps?: number } = {}) => {
  const { cues } = demoCues({ lines, language: opts.language, options: { lead: 400, gap: opts.gap ?? 30, cueGap: opts.cueGap ?? 140, tail: 800 } });
  return { cues, pieces: pixelpopProgram.build(sceneInput(cues, { fps: opts.fps ?? 30, colours })).pieces };
};
const wordRe = (cue: number) => new RegExp(`^pixelpop:${cue}:w\\d+(?:l\\d+)?$`);
const faces = (pieces: Piece[], cue: number) => pieces.filter((piece) => wordRe(cue).test(piece.id));
const meets = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

describe("pixelpop", () => {
  test("ink starts at the word's onset, never before it", () => {
    const { cues, pieces } = build(["level:b up:b skills:h@640"]);
    for (const word of cues[0]!.words) {
      const face = pieces.find((piece) => piece.id === `pixelpop:0:w${cues[0]!.words.indexOf(word)}`)!;
      expect(face.fromMs).toBeGreaterThanOrEqual(word.startMs - 1);
      expect(pieceBounds(face, exportFrameAtOrAfter(word.startMs, 30), fakeMeasure)).not.toBeNull();
    }
  });

  test("a word builds as a stair of snapped bands on the export frame grid, the rows lagging, and is whole on its complete frame", () => {
    for (const fps of [24, 25, 30, 60]) {
      const { cues, pieces } = build(["level:b up:b skills:h@640"], { fps });
      const start = cues[0]!.words[2]!.startMs;
      const ids = ["pixelpop:0:w2", "pixelpop:0:w2row1", "pixelpop:0:w2row2"].map((id) => pieces.find((p) => p.id === id));
      // Every temporary row survives the shared two-frame filter at every frame rate (the sample jumped to the whole word).
      expect(ids.every((piece) => piece !== undefined), `rows kept at ${fps} fps`).toBe(true);
      const base = ids[0]!;
      const full = evaluatePiece(base, start + 600).clip!;
      const share = (piece: Piece, t: number) => { const pose = evaluatePiece(piece, t); return pose.visible && pose.clip ? (pose.clip.x2 - pose.clip.x1) / (full.x2 - full.x1) : 0; };
      const times = exportFrameTimes(start, start + 160, fps);
      const top = times.map((t) => share(base, t));
      const mid = times.map((t) => share(ids[1]!, t));
      const low = times.map((t) => share(ids[2]!, t));
      // Each lower row reaches the whole width on a later frame than the one above, and never before it.
      const doneAt = (shares: number[]) => shares.findIndex((value) => value >= 0.999);
      expect(doneAt(top)).toBeGreaterThanOrEqual(0);
      expect(doneAt(mid)).toBeGreaterThan(doneAt(top));
      expect(doneAt(low)).toBeGreaterThan(doneAt(mid));
      for (let f = 0; f < times.length; f++) {
        expect(mid[f]!).toBeLessThanOrEqual(top[f]! + 1e-9);
        expect(low[f]!).toBeLessThanOrEqual(mid[f]! + 1e-9);
      }
      // The word is whole and readable on its complete frame, and the lead frame already shows ink.
      expect(top[0]!).toBeGreaterThan(0);
      expect(top.at(-1)!).toBeCloseTo(1, 3);
    }
  });

  test("a word with fewer than two stair frames appears whole at once", () => {
    const { cues, pieces } = build(["go:h@70"], { fps: 24 });
    const start = cues[0]!.words[0]!.startMs;
    const base = pieces.find((p) => p.id === "pixelpop:0:w0")!;
    const first = exportFrameAtOrAfter(start, 24);
    const whole = pieceBounds({ ...base, clip: undefined }, first, fakeMeasure)!;
    const seen = pieceBounds(base, first, fakeMeasure)!;
    expect(seen.x2).toBeGreaterThanOrEqual(whole.x2 - 0.5);
    expect(seen.y2).toBeGreaterThanOrEqual(whole.y2 - 0.5);
    expect(pieces.some((p) => /^pixelpop:0:w0row(1d|2)$/.test(p.id))).toBe(false);
  });

  test("the key word is three colour bands over one extrusion stack, cut from its face ink", () => {
    const { pieces } = build(["level:b up:b skills:h@640"]);
    const hero = pieces.find((p) => p.id === "pixelpop:0:w2")!;
    expect(hero.kind === "text" && hero.fill).toBe("#FF3DAE");
    expect(hero.kind === "text" && hero.shadows?.length).toBe(5);
    const top = pieces.find((p) => p.id === "pixelpop:0:w2row0")!;
    const mid = pieces.find((p) => p.id === "pixelpop:0:w2row1")!;
    expect(top.kind === "text" && top.fill).toBe("#2BE4FF");
    expect(mid.kind === "text" && mid.fill).toBe("#FFEF3A");
    expect(top.kind === "text" && top.shadows).toBeUndefined();
    const t = hero.fromMs + 500;
    const ink = pieceBounds({ ...hero, clip: undefined }, t, fakeMeasure)!;
    const a = evaluatePiece(top, t).clip!;
    const b = evaluatePiece(mid, t).clip!;
    expect(b.y1).toBeCloseTo(a.y2, 3);
    expect((a.y2 - ink.y1) / (ink.y2 - ink.y1)).toBeCloseTo(0.44, 1);
    // Grid steps: the stack's layers are whole 4 to 6 px cells apart.
    const offsets = (hero.kind === "text" ? hero.shadows! : []).map((s) => s.dx);
    for (let i = 1; i < offsets.length; i++) expect(offsets[i - 1]! - offsets[i]!).toBeCloseTo(offsets[0]! - offsets[1]!, 5);
    expect(offsets[offsets.length - 2]! - offsets[offsets.length - 1]!).toBeGreaterThanOrEqual(4);
    expect(offsets[offsets.length - 2]! - offsets[offsets.length - 1]!).toBeLessThanOrEqual(6.01);
  });

  test("the exit never starts before the last word has been read, and the cue is not cut mid-word on a short gap", () => {
    const { cues, pieces } = build(["level:b up:b skills:h@640", "press:b start:h@560"], { cueGap: 60 });
    const cue = cues[0]!;
    const last = pieces.find((p) => p.id === "pixelpop:0:w2")!;
    const lastFrame = exportFrameAtOrBefore(cue.words[2]!.endMs + 150, 30);
    const times = exportFrameTimes(cue.words[2]!.startMs + 120, Math.min(lastFrame + 1, last.toMs), 30);
    expect(times.length).toBeGreaterThan(3);
    for (const t of times) {
      const clip = evaluatePiece(last, t).clip!;
      const whole = pieceBounds({ ...last, clip: undefined }, t, fakeMeasure)!;
      expect(clip.x2).toBeGreaterThanOrEqual(whole.x2);
    }
  });

  test("decorations sit in free space: none touches any word's ink or extrusion, on every cue", () => {
    const { cues, pieces } = build(["level:b up:b skills:h@640", "press:b start:h@560", "just:b hit:b record:b", "you:m got:m this:h@520", "new:b high:b score:h@600"]);
    for (const cue of cues) {
      const words = faces(pieces, cue.index);
      const decorations = pieces.filter((p) => p.id.startsWith(`pixelpop:${cue.index}:`) && !wordRe(cue.index).test(p.id) && !/:w\d+(?:l\d+)?row/.test(p.id));
      expect(decorations.length).toBeGreaterThan(0);
      for (const t of exportFrameTimes(cue.startMs, cue.endMs, 30)) {
        const ink = words.flatMap((word) => {
          const box = pieceBounds(word, t, fakeMeasure);
          if (!box) return [];
          const dep = word.kind === "text" ? Math.max(0, ...(word.shadows ?? []).map((s) => s.dx)) : 0;
          return [{ ...box, x2: box.x2 + dep, y2: box.y2 + dep }];
        });
        for (const decoration of decorations) {
          const box = pieceBounds(decoration, t, fakeMeasure);
          if (box) for (const other of ink) expect(meets(box, other), `${decoration.id} touches a word at ${t}`).toBe(false);
        }
      }
    }
  });

  test("every cue carries the icon, the twinkle and the progress cells, and the icon cycles", () => {
    const { cues, pieces } = build(["level:b up:b skills:h@640", "press:b start:h@560", "just:b hit:b record:b", "you:m got:m this:h@520", "new:b high:b score:h@600"]);
    for (const cue of cues) {
      for (const part of ["icon", "spark", "bar0"]) expect(pieces.some((p) => p.id === `pixelpop:${cue.index}:${part}`), `${part} on cue ${cue.index}`).toBe(true);
    }
    const shapeOf = (cue: number) => JSON.stringify((pieces.find((p) => p.id === `pixelpop:${cue}:icon`) as { path: unknown }).path);
    expect(new Set([0, 1, 3, 4].map(shapeOf)).size).toBeGreaterThanOrEqual(3);
  });

  test("a word too long for the column breaks across rows at a readable size", () => {
    const word = "pneumonoultramicroscopicsilicovolcanoconiosis";
    const { cues, pieces } = build([`${word}:h@900`]);
    const parts = pieces.filter((p) => /^pixelpop:0:w0l\d$/.test(p.id));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.map((p) => (p.kind === "text" ? p.text : "")).join("")).toBe(word.toUpperCase());
    for (const piece of parts) expect(piece.kind === "text" && piece.sizePx).toBeGreaterThanOrEqual(70);
    const ys = new Set(parts.map((p) => Math.round(evaluatePiece(p, cues[0]!.endMs - 300).y)));
    expect(ys.size).toBe(parts.length);
  });

  test("Devanagari stays one whole piece per word; Urdu builds right to left", () => {
    const hindi = build(["यह:b बहुत:h@700"], { language: "hi" });
    expect(hindi.pieces.filter((p) => /^pixelpop:0:w\d+l\d$/.test(p.id))).toHaveLength(0);
    const urdu60 = build(["یہ:b بہت:h@700"], { language: "ur", fps: 60 });
    const base = urdu60.pieces.find((p) => p.id === "pixelpop:0:w1")!;
    const first = exportFrameAtOrAfter(base.fromMs, 60);
    const early = evaluatePiece(urdu60.pieces.find((p) => p.id === "pixelpop:0:w1row1")!, first + 17).clip!;
    const done = evaluatePiece(base, base.fromMs + 500).clip!;
    expect(early.x2).toBeCloseTo(done.x2, 3);
    expect(early.x1).toBeGreaterThan(done.x1);
  });

  test("stays inside the safe area at twice the size on every frame shape", () => {
    for (const edge of ["urdu", "nine-words", "long-word", "no-hero"] as const) {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
        const { cues } = sceneEdgeDemo(edge);
        const pieces = pixelpopProgram.build(sceneInput(cues, { fps: 30, colours, scale: 2, canvas })).pieces;
        for (const piece of pieces) {
          for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
            const box = pieceBounds(piece, t, fakeMeasure);
            if (!box) continue;
            expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
            expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
            expect(box.y1).toBeGreaterThanOrEqual(0.05 * canvas.height - 1);
            expect(box.y2).toBeLessThanOrEqual(0.95 * canvas.height + 1);
          }
        }
      }
    }
  });

  test("the piece count of a cue stays inside the budget", () => {
    const { cues, pieces } = build(["so:m here:b is:m the:m thing:h@300", "nobody:b tells:b you:m this"]);
    for (const cue of cues) {
      const own = pieces.filter((p) => p.id.startsWith(`pixelpop:${cue.index}:`));
      const events = own.reduce((sum, p) => sum + 1 + (p.kind === "text" ? (p.shadows?.length ?? 0) : (p.shadows?.length ?? 0)), 0);
      expect(events).toBeLessThanOrEqual(150);
    }
  });

  test("every face has a thin navy outline behind all three bands, and the measured bounds include it", () => {
    const { pieces } = build(["level:b up:b skills:h@640"]);
    for (const id of ["pixelpop:0:w0", "pixelpop:0:w2"]) {
      const face = pieces.find((p) => p.id === id)!;
      expect(face.kind === "text" && face.stroke?.colour).toBe("#14093F");
      expect(face.kind === "text" && face.stroke!.widthPx).toBeGreaterThanOrEqual(2);
      const t = face.fromMs + 600;
      const plain = pieceBounds({ ...face, clip: undefined, ...(face.kind === "text" ? { stroke: undefined } : {}) } as Piece, t, fakeMeasure)!;
      const outlined = pieceBounds({ ...face, clip: undefined }, t, fakeMeasure)!;
      expect(outlined.x1).toBeLessThan(plain.x1);
      expect(outlined.y1).toBeLessThan(plain.y1);
    }
    // The bands sit over the outlined base, so none of them draws its own outline.
    expect(pieces.find((p) => p.id === "pixelpop:0:w2row0")!.kind === "text" && (pieces.find((p) => p.id === "pixelpop:0:w2row0") as { stroke?: unknown }).stroke).toBeFalsy();
  });

  test("a brand colour that cannot reach 3:1 against the navy outline falls back to the style's own", () => {
    const { cues } = demoCues({ lines: ["level:b up:b skills:h@640"], options: { lead: 400, gap: 30, cueGap: 140, tail: 800 } });
    const branded = pixelpopProgram.build(sceneInput(cues, { fps: 30, colours: { ...colours, primary: "#1B1052", highlight: "#241A5E" } })).pieces;
    const face = branded.find((p) => p.id === "pixelpop:0:w0")!;
    const band = branded.find((p) => p.id === "pixelpop:0:w2row1")!;
    expect(face.kind === "text" && face.fill).toBe("#FFFFFF");
    expect(band.kind === "text" && band.fill).toBe("#FFEF3A");
    const washed = pixelpopProgram.build(sceneInput(cues, { fps: 30, colours: { ...colours, primary: "#F6F3EA" } })).pieces;
    expect((washed.find((p) => p.id === "pixelpop:0:w0") as { fill: string }).fill).toBe("#F6F3EA");
  });

  test("a long hero word takes the fewest rows that keep its size, balanced, in portrait and landscape", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
      const { cues } = demoCues({ lines: ["unbelievable:h@700"], options: { lead: 400, gap: 30, cueGap: 140, tail: 800 } });
      const pieces = pixelpopProgram.build(sceneInput(cues, { fps: 30, colours, canvas })).pieces;
      const parts = pieces.filter((p) => /^pixelpop:0:w0l\d$/.test(p.id));
      expect(parts.length).toBeLessThanOrEqual(2);
      expect(parts.map((p) => (p.kind === "text" ? p.text : "")).join("")).toBe("UNBELIEVABLE");
      const widths = parts.map((p) => (p.kind === "text" ? p.text.length : 0));
      if (parts.length === 2) expect(Math.abs(widths[0]! - widths[1]!)).toBeLessThanOrEqual(2);
    }
  });

  test("the beats show on ordinary and short cues, still when there is no room to animate", () => {
    const lines = ["will:b@100 deal:b@100", "all:b@100", "go:m@90 now:b@90 quick:h@100", "so:m here:b is:m the:m thing:h@300", "nobody:b tells:b you:m this"];
    const { cues, pieces } = build(lines, { cueGap: 0, gap: 0 });
    for (const cue of cues) {
      for (const part of ["icon", "spark", "bar0"]) expect(pieces.some((p) => p.id === `pixelpop:${cue.index}:${part}`), `${part} on cue ${cue.index} (${cue.words.map((w) => w.text).join(" ")})`).toBe(true);
    }
  });

  test("the twinkle ends at its last burst: it never comes back during the exit", () => {
    const { cues, pieces } = build(["hold:h@4200"]);
    const cue = cues[0]!;
    const spark = pieces.find((p) => p.id === "pixelpop:0:spark")!;
    expect(spark.toMs).toBeLessThan(cue.endMs - 150);
    for (const t of exportFrameTimes(spark.toMs, cue.endMs + 100, 30)) expect(evaluatePiece(spark, t).visible).toBe(false);
    for (const piece of pieces.filter((p) => /^pixelpop:0:(icon|cells)/.test(p.id))) {
      const frames = exportFrameTimes(cue.endMs - 250, piece.toMs, 30).map((t) => evaluatePiece(piece, t).sx);
      for (let i = 1; i < frames.length; i++) expect(frames[i]!).toBeLessThanOrEqual(frames[i - 1]! + 1e-9);
    }
  });

  test("the cue before an onset keeps its time: the window opens at the first word, so the exit is not cut short", () => {
    const { cues, pieces } = build(["level:b up:b skills:h@300", "press:b start:h@300"], { cueGap: 0, gap: 0 });
    const next = cues[1]!.words[0]!.startMs;
    const first = pieces.filter((p) => p.id.startsWith("pixelpop:0:w"));
    expect(Math.max(...first.map((p) => p.toMs))).toBeGreaterThanOrEqual(next - 1);
    expect(Math.min(...pieces.filter((p) => p.id.startsWith("pixelpop:1:")).map((p) => p.fromMs))).toBeGreaterThanOrEqual(next - 1);
  });
});
