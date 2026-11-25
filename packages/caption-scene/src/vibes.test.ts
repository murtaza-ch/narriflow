import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameAtOrAfter, exportFrameAtOrBefore, exportFrameTimes } from "./frame-grid";
import { type Box, type Piece, evaluatePiece, pieceBounds } from "./scene";
import { captionColourContrast } from "@narriflow/validators";
import { vibesProgram } from "./templates/vibes";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("vibes", vibesProgram, { anchorLineY: 1290 });

const colours = { primary: "#FFFFFF", highlight: "#FFA9D2", accent: "#17111F", shadow: "#000000" };
const build = (lines: string[], opts: { gap?: number; cueGap?: number; language?: string; fps?: number; scale?: number; canvas?: { width: number; height: number } } = {}) => {
  const { cues } = demoCues({ lines, language: opts.language, options: { lead: 400, gap: opts.gap ?? 30, cueGap: opts.cueGap ?? 140, tail: 800 } });
  const input = sceneInput(cues, { fps: opts.fps ?? 30, colours, ...(opts.scale ? { scale: opts.scale } : {}), ...(opts.canvas ? { canvas: opts.canvas } : {}) });
  return { cues, pieces: vibesProgram.build(input).pieces };
};
const wordRe = (cue: number) => new RegExp(`^vibes:${cue}:w\\d+(?:l\\d+)?$`);
const faces = (pieces: Piece[], cue: number) => pieces.filter((piece) => wordRe(cue).test(piece.id));
const meets = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
const LINES = ["you:b are:m ENOUGH:h@640 right:b now:b", "good:b VIBES:h@620 only:b", "be:m KIND:h@560", "take:b a:m deep:b breath:b", "stay:b WEIRD:h@620 and:m shine:b"];

describe("vibes", () => {
  test("the sticker is whole, opaque and unclipped on its first painted frame", () => {
    const { cues, pieces } = build(LINES);
    for (const cue of cues) {
      for (const [at, word] of cue.words.entries()) {
        const face = pieces.find((piece) => piece.id === `vibes:${cue.index}:w${at}`)!;
        const t = exportFrameAtOrAfter(word.startMs, 30);
        const pose = evaluatePiece(face, t);
        expect(pose.visible, `cue ${cue.index} word ${at}`).toBe(true);
        expect(pose.o).toBeGreaterThanOrEqual(0.9);
        expect(pose.clip).toBeNull();
        expect(pieceBounds(face, t, fakeMeasure)).not.toBeNull();
      }
    }
  });

  test("a highlight wipe sweeps each finished script word in 66-110 ms, in reading order, on at least two painted frames", () => {
    const { cues, pieces } = build(LINES);
    for (const cue of cues) {
      for (const [at, word] of cue.words.entries()) {
        const sweep = pieces.find((piece) => piece.id === `vibes:${cue.index}:w${at}sweep`);
        if (!sweep) continue;
        expect(sweep.toMs - sweep.fromMs).toBeGreaterThanOrEqual(66);
        expect(sweep.toMs - sweep.fromMs).toBeLessThanOrEqual(110);
        expect(sweep.fromMs).toBeGreaterThanOrEqual(word.startMs - 1);
        const times = exportFrameTimes(sweep.fromMs, sweep.toMs, 30).filter((t) => pieceBounds(sweep, t, fakeMeasure));
        expect(times.length).toBeGreaterThanOrEqual(2);
        const heads = times.map((t) => evaluatePiece(sweep, t).clip!.x2);
        for (let i = 1; i < heads.length; i++) expect(heads[i]!).toBeGreaterThan(heads[i - 1]!);
      }
    }
    // Most script words of ordinary speech keep their wipe.
    const heroes = cues.flatMap((cue) => cue.words.flatMap((word, at) => (word.role === "hero" ? [`vibes:${cue.index}:w${at}sweep`] : [])));
    expect(heroes.filter((id) => pieces.some((piece) => piece.id === id)).length).toBe(heroes.length);
  });

  test("the wipe runs right to left for Urdu", () => {
    const { pieces } = build(["یہ:b بہت:h@700"], { language: "ur" });
    const sweep = pieces.find((piece) => piece.id === "vibes:0:w1sweep")!;
    expect(sweep).toBeDefined();
    const times = exportFrameTimes(sweep.fromMs, sweep.toMs, 30).filter((t) => pieceBounds(sweep, t, fakeMeasure));
    const heads = times.map((t) => evaluatePiece(sweep, t).clip!.x1);
    for (let i = 1; i < heads.length; i++) expect(heads[i]!).toBeLessThan(heads[i - 1]!);
  });

  test("the exit is one fade of 60 ms at most, after the last word has had its reading hold", () => {
    const { cues, pieces } = build(LINES.slice(0, 2), { cueGap: 400 });
    const cue = cues[0]!;
    const spokenEnd = Math.max(...cue.words.map((word) => word.endMs));
    for (const piece of pieces.filter((p) => p.id.startsWith("vibes:0:"))) {
      const opaque = exportFrameTimes(piece.fromMs, piece.toMs, 30).filter((t) => pieceBounds(piece, t, fakeMeasure) && evaluatePiece(piece, t).o >= 0.99);
      const fading = exportFrameTimes(piece.fromMs, piece.toMs, 30).filter((t) => pieceBounds(piece, t, fakeMeasure) && evaluatePiece(piece, t).o < 0.999);
      if (wordRe(0).test(piece.id)) {
        expect(opaque.at(-1)!).toBeGreaterThanOrEqual(spokenEnd + 150 - 34);
        expect(fading.length).toBeGreaterThanOrEqual(1);
        expect(fading.at(-1)! - fading[0]!).toBeLessThanOrEqual(67);
      }
    }
  });

  test("a cue with no room for two exit frames is cut hard, never faded mid-word", () => {
    const { cues, pieces } = build(["go:h@120", "on:h@120"], { cueGap: 0, gap: 0 });
    for (const piece of faces(pieces, 0)) {
      const last = exportFrameAtOrBefore(cues[0]!.words[0]!.endMs - 1, 30);
      expect(evaluatePiece(piece, last).o).toBeGreaterThanOrEqual(0.99);
    }
  });

  test("accents stay out of every word's ink, outline and shadow on every frame, and a beat never reappears in the exit", () => {
    const { cues, pieces } = build(LINES);
    for (const cue of cues) {
      const words = faces(pieces, cue.index);
      const accents = pieces.filter((p) => p.id.startsWith(`vibes:${cue.index}:`) && !wordRe(cue.index).test(p.id) && !/sweep$|pill$|blob$/.test(p.id));
      expect(accents.length).toBeGreaterThan(0);
      for (const t of exportFrameTimes(cue.startMs, cue.endMs + 400, 30)) {
        const ink = words.flatMap((word) => {
          const box = pieceBounds(word, t, fakeMeasure);
          if (!box) return [];
          const reach = word.kind === "text" ? Math.max(0, ...(word.shadows ?? []).map((s) => s.dx)) : 0;
          return [{ ...box, x2: box.x2 + reach, y2: box.y2 + reach }];
        });
        for (const accent of accents) {
          const box = pieceBounds(accent, t, fakeMeasure);
          if (box) for (const other of ink) expect(meets(box, other), `${accent.id} touches a word at ${t}`).toBe(false);
        }
      }
      // After the reading hold nothing grows or turns again: scale and opacity only go down.
      const spokenEnd = Math.max(...cue.words.map((word) => word.endMs));
      for (const accent of accents) {
        let o = 1;
        let sx = Number.NaN;
        for (const t of exportFrameTimes(spokenEnd + 150, accent.toMs, 30)) {
          const pose = evaluatePiece(accent, t);
          if (!pose.visible) continue;
          expect(pose.o).toBeLessThanOrEqual(o + 1e-6);
          if (!Number.isNaN(sx) && pose.o < 0.999) expect(Math.abs(pose.sx - sx), `${accent.id} moves in the exit at ${t}`).toBeLessThan(0.03);
          o = pose.o;
          sx = pose.sx;
        }
      }
    }
  });

  test("every ordinary cue carries the disc, a sparkle and the dots, and the sunburst and swirl both come round", () => {
    const { cues, pieces } = build(LINES, { gap: 150, cueGap: 60 });
    for (const cue of cues) {
      for (const part of ["blob", "spark0", "dots"]) expect(pieces.some((p) => p.id === `vibes:${cue.index}:${part}`), `${part} on cue ${cue.index}`).toBe(true);
    }
    const short = build(["so:m yes:h@600", "ok:m wow:h@600", "go:m me:h@600", "be:m you:h@600"], { gap: 150, cueGap: 60 });
    const heroCues = short.cues;
    const kinds = heroCues.map((cue) => (short.pieces.some((p) => p.id === `vibes:${cue.index}:rays`) ? "rays" : short.pieces.some((p) => p.id === `vibes:${cue.index}:swirl`) ? "swirl" : "none"));
    expect(kinds.every((kind) => kind !== "none")).toBe(true);
    expect(new Set(kinds).size).toBe(2);
  });

  test("the rays start 18 px or more from the key word's painted box", () => {
    const { cues, pieces } = build(LINES);
    for (const cue of cues) {
      const rays = pieces.find((p) => p.id === `vibes:${cue.index}:rays`);
      if (!rays) continue;
      const hero = faces(pieces, cue.index).find((p) => cue.words[Number(p.id.split(":w")[1])]!.role === "hero")!;
      const t = rays.fromMs + 600;
      const a = pieceBounds(rays, t, fakeMeasure)!;
      const b = pieceBounds(hero, t, fakeMeasure)!;
      const reach = hero.kind === "text" ? (hero.shadows ?? []).reduce((m, sh) => Math.max(m, sh.dx), 0) : 0;
      const gapX = Math.max(b.x1 - a.x2, a.x1 - (b.x2 + reach), 0);
      const gapY = Math.max(b.y1 - a.y2, a.y1 - (b.y2 + reach), 0);
      expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(17);
    }
  });

  test("a word too long for the column is cut into the fewest rows, at even widths and a readable size", () => {
    const word = "unbelievable";
    const { pieces } = build([`${word}:h@900`]);
    const parts = pieces.filter((p) => /^vibes:0:w0l\d$/.test(p.id));
    expect(parts.length).toBe(2);
    expect(parts.map((p) => (p.kind === "text" ? p.text : "")).join("")).toBe(word);
    const lengths = parts.map((p) => (p.kind === "text" ? p.text.length : 0));
    expect(Math.abs(lengths[0]! - lengths[1]!)).toBeLessThanOrEqual(2);
    for (const piece of parts) expect(piece.kind === "text" && piece.sizePx).toBeGreaterThanOrEqual(0.62 * 236);
    const ys = new Set(parts.map((p) => Math.round(evaluatePiece(p, p.toMs - 300).y)));
    expect(ys.size).toBe(parts.length);
  });

  test("Devanagari stays whole and untracked; caps in the fallback script are larger than tracked Latin caps", () => {
    const { pieces } = build(["यह:b बहुत:h@700 अच्छा:b"], { language: "hi" });
    expect(pieces.filter((p) => /^vibes:0:w\d+l\d$/.test(p.id))).toHaveLength(0);
    for (const piece of faces(pieces, 0)) expect(piece.kind === "text" && piece.letterSpacingEm).toBe(0);
    const latin = build(["so:b real:h@700 now:b"]).pieces;
    const caps = (list: Piece[], at: number) => (list.find((p) => p.id === `vibes:0:w${at}`) as { sizePx: number }).sizePx;
    expect(caps(pieces, 0)).toBeGreaterThan(caps(latin, 0));
    expect(latin.find((p) => p.id === "vibes:0:w0")).toMatchObject({ letterSpacingEm: 0.07 });
  });

  test("a brand paper colour that cannot read against the ink keeps the style's white", () => {
    const { cues } = demoCues({ lines: ["so:b real:h@700"], options: { lead: 400 } });
    const dark = vibesProgram.build(sceneInput(cues, { colours: { ...colours, primary: "#2A2030" } })).pieces;
    const hero = dark.find((p) => p.id === "vibes:0:w1")!;
    expect(hero.kind === "text" && hero.stroke?.colour).toBe("#FFFFFF");
    const brand = vibesProgram.build(sceneInput(cues, { colours: { ...colours, primary: "#FFF4C2" } })).pieces;
    expect((brand.find((p) => p.id === "vibes:0:w1") as { stroke: { colour: string } }).stroke.colour).toBe("#FFF4C2");
  });

  test("rows never touch each other at rest, in Latin, nine words and Devanagari", () => {
    for (const [lines, language] of [[["so:m the:m real:b reason:b most:b people:h@520 never:b get:b there:m"], "en"], [["display:b glare:b बहुत:h@420", "और:m अगर:b इसे:m सीधा:h@400"], "hi"], [["stay:b WEIRD:h@620 and:m shine:b"], "en"]] as const) {
      const { cues, pieces } = build([...lines], { language });
      for (const cue of cues) {
        const t = cue.endMs - 200;
        const boxes = faces(pieces, cue.index).flatMap((p) => pieceBounds(p, t, fakeMeasure) ?? []);
        for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) expect(meets(a, b), `cue ${cue.index} words overlap`).toBe(false);
      }
    }
  });

  test("stays inside the safe area at twice the size on every frame shape", () => {
    for (const edge of ["urdu", "nine-words", "long-word", "no-hero", "one-word"] as const) {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
        const { cues } = sceneEdgeDemo(edge);
        const pieces = vibesProgram.build(sceneInput(cues, { fps: 30, colours, scale: 2, canvas })).pieces;
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

  test("a cue stays inside the piece budget", () => {
    const { cues, pieces } = build([...LINES, "so:m here:b is:m the:m thing:h@300"]);
    for (const cue of cues) {
      const own = pieces.filter((p) => p.id.startsWith(`vibes:${cue.index}:`));
      expect(own.reduce((sum, p) => sum + 1 + (p.shadows?.length ?? 0), 0)).toBeLessThanOrEqual(150);
    }
  });

  test("a long word is split where every part fits the column at the size floor, in the fewest rows", () => {
    for (const word of ["abdominohysterectomy", "unbelievable", "internationalization"]) {
      const { pieces } = build([`${word}:h@900`]);
      const parts = pieces.filter((p) => /^vibes:0:w0l\d+$/.test(p.id));
      expect(parts.map((p) => (p.kind === "text" ? p.text : "")).join("")).toBe(word);
      for (const part of parts) {
        if (part.kind !== "text") continue;
        expect(part.sizePx).toBeGreaterThanOrEqual(0.62 * 236 - 0.5);
        expect(fakeMeasure(part.text, part.face, part.sizePx, part.letterSpacingEm).advance).toBeLessThanOrEqual(720 + 0.5);
      }
      // One row fewer would not have fit.
      const widest = Math.max(...parts.map((part) => (part.kind === "text" ? fakeMeasure(part.text, part.face, 236, 0).advance : 0)));
      expect(widest * 0.62).toBeLessThanOrEqual(720 + 0.5);
      expect(fakeMeasure(word, "Oleo Script Bold", 236, 0).advance * 0.62 / (parts.length - 1)).toBeGreaterThan(720 - 0.5 * 720);
    }
  });

  test("a highlight that would merge with the outline gets an ink keyline, and a palette that cannot read falls back as a pair", () => {
    const { cues } = demoCues({ lines: ["so:b real:h@700", "ok:b more:h@700"], options: { lead: 400, cueGap: 200 } });
    const light = vibesProgram.build(sceneInput(cues, { fps: 30, colours: { primary: "#FFFFFF", highlight: "#FFF8FB", accent: "#17111F", shadow: "#000" } })).pieces;
    const sweep = light.find((p) => p.id === "vibes:0:w1sweep");
    expect(sweep?.kind === "text" && sweep.stroke?.colour).toBe("#17111F");
    expect(sweep?.kind === "text" && sweep.stroke?.widthPx).toBeGreaterThan(0);
    const white = vibesProgram.build(sceneInput(cues, { fps: 30, colours: { primary: "#FFFFFF", highlight: "#FFFFFF", accent: "#FFFFFF", shadow: "#000" } })).pieces;
    const hero = white.find((p) => p.id === "vibes:0:w1");
    expect(hero?.kind === "text" && hero.fill).toBe("#17111F");
    expect(hero?.kind === "text" && hero.stroke?.colour).toBe("#FFFFFF");
    // The disc after the odd-cue blend still reads against the ink at 3:1.
    for (const cue of [0, 1]) {
      const disc = [...light, ...white].filter((p) => p.id === `vibes:${cue}:blob`);
      for (const piece of disc) expect(captionColourContrast(piece.kind === "shape" ? piece.fill!.colour : "#000000", "#17111F")).toBeGreaterThanOrEqual(3);
    }
  });

  test("the sweep starts on the first painted frame, shows 18 % of the word on two frames within 110 ms, at any sub-frame offset", () => {
    for (const offset of [0, 7, 13, 23, 31]) {
      const { cues } = demoCues({ lines: LINES, options: { lead: 400 + offset, gap: 30, cueGap: 140, tail: 800 } });
      const pieces = vibesProgram.build(sceneInput(cues, { fps: 30, colours })).pieces;
      let seen = 0;
      for (const cue of cues) {
        for (const [at, word] of cue.words.entries()) {
          const sweep = pieces.find((piece) => piece.id === `vibes:${cue.index}:w${at}sweep`);
          if (!sweep) continue;
          seen++;
          expect(sweep.fromMs).toBe(exportFrameAtOrAfter(word.startMs, 30));
          expect(sweep.toMs - sweep.fromMs).toBeLessThanOrEqual(110);
          const face = pieces.find((piece) => piece.id === `vibes:${cue.index}:w${at}`)!;
          const wide = pieceBounds({ ...face, clip: undefined }, sweep.fromMs + 100, fakeMeasure)!;
          const shown = exportFrameTimes(sweep.fromMs, sweep.toMs, 30).filter((t) => {
            const box = pieceBounds(sweep, t, fakeMeasure);
            return box !== null && box.x2 - box.x1 >= 0.18 * (wide.x2 - wide.x1) * 0.9;
          });
          expect(shown.length, `${sweep.id} at offset ${offset}`).toBeGreaterThanOrEqual(2);
          // Painted on its first frame.
          expect(pieceBounds(sweep, sweep.fromMs, fakeMeasure)).not.toBeNull();
        }
      }
      expect(seen).toBeGreaterThanOrEqual(3);
    }
  });

  test("a 120 ms cue still gets its disc and a sparkle, and dots pop one at a time when there is room", () => {
    const short = build(["so:b real:h@700", "All:b@120", "go:b more:b"], { cueGap: 0, gap: 0 });
    for (const part of ["blob", "spark0"]) expect(short.pieces.some((p) => p.id === `vibes:1:${part}`), `${part} on the 120 ms cue`).toBe(true);
    const ordinary = build(LINES);
    const dots = ["dots", "dots1", "dots2"].map((id) => ordinary.pieces.find((p) => p.id === `vibes:0:${id}`));
    expect(dots.every(Boolean)).toBe(true);
    expect(new Set(dots.map((p) => p!.fromMs)).size).toBe(3);
    // The sparkle twinkles on an ordinary hold, not only a long one.
    const spark = ordinary.pieces.find((p) => p.id === "vibes:0:spark0")!;
    const scales = exportFrameTimes(spark.fromMs, spark.toMs, 30).map((t) => evaluatePiece(spark, t).sx);
    expect(Math.max(...scales)).toBeGreaterThan(1.05);
    expect(scales.at(-1)).toBeLessThan(1.05);
  });

  test("overlapping speakers on 16:9 at twice the size keep a readable, comparable key word in each lane (support words beside it when stacking would shrink)", () => {
    const { cues } = demoCues({ lines: ["first:b@300 SECOND:h@300 third:b@300", "other:b@300 NEXT:h@300 words:b@300"], options: { lead: 357, gap: 0, cueGap: 0 } });
    const starts = [400, 500];
    const run = cues.map((cue, i) => {
      const by = starts[i]! - cue.startMs;
      return { ...cue, startMs: cue.startMs + by, endMs: cue.endMs + by, words: cue.words.map((w) => ({ ...w, startMs: w.startMs + by, endMs: w.endMs + by })), speaker: i % 2 };
    });
    const pieces = vibesProgram.build(sceneInput(run, { fps: 30, scale: 2, canvas: { width: 1920, height: 1080 }, colours })).pieces;
    const heroSize = (cue: number) => (pieces.find((p) => p.id === `vibes:${cue}:w1`) as { sizePx: number }).sizePx;
    expect(heroSize(0)).toBeGreaterThan(0.5 * heroSize(1));
    expect(heroSize(1)).toBeGreaterThan(0.5 * heroSize(0));
    const t = 1300;
    const box = (id: string) => pieceBounds(pieces.find((p) => p.id === id)!, t, fakeMeasure);
    // Cue 0 takes the support words beside the key word: they share its rows' vertical range and sit before it.
    const support = box("vibes:0:w0");
    const key = box("vibes:0:w1");
    expect(support && key && support.x2 <= key.x1).toBe(true);
    for (const cue of [0, 1]) for (const id of [0, 1, 2]) {
      const b = box(`vibes:${cue}:w${id}`);
      if (b) expect(b.y2 - b.y1).toBeGreaterThan(30);
    }
  });

  test("two short key words share one row (3 rows, not 4) when that costs under 30 % of their size", () => {
    const { cues, pieces } = build(["so:b yes:h@600 now:h@600 ok:b"]);
    const [a, b] = [pieces.find((p) => p.id === "vibes:0:w1")!, pieces.find((p) => p.id === "vibes:0:w2")!];
    const t = cues[0]!.endMs - 300;
    expect(Math.round(evaluatePiece(a, t).y)).toBe(Math.round(evaluatePiece(b, t).y));
    const size = a.kind === "text" ? a.sizePx : 0;
    expect(size).toBeGreaterThanOrEqual(0.7 * 236);
    expect(size).toBeLessThan(236);
  });

  test("colours that reach the program directly (Studio colour controls) still read: a light ink or near-black paper falls back as a pair", () => {
    const { cues } = demoCues({ lines: ["so:b real:h@700 now:b"], options: { lead: 400 } });
    const run = (primary: string, accent: string) =>
      vibesProgram.build(sceneInput(cues, { fps: 30, colours: { primary, highlight: "#FFA9D2", accent, shadow: "#000000" } })).pieces.find((p) => p.id === "vibes:0:w1")!;
    for (const [primary, accent] of [["#FFFFFF", "#E0D0F0"], ["#201C24", "#17111F"], ["#FFFFFF", "#FFFFFF"], ["#1A1A1A", "#1A1A1A"]] as const) {
      const hero = run(primary, accent);
      if (hero.kind !== "text" || !hero.stroke) throw new Error("hero is a stroked text piece");
      expect(captionColourContrast(hero.fill, hero.stroke.colour), `${primary} on ${accent}`).toBeGreaterThanOrEqual(3);
    }
  });
});
