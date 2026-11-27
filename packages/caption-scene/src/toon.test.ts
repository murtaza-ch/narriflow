import { describe, expect, test } from "bun:test";
import { describeSpeechConformance, fastRun, staccatoRun } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { kf } from "./ease";
import { exportFrameAtOrAfter, exportFrameTimes } from "./frame-grid";
import type { SceneCue, SceneInput } from "./input";
import { type Box, evaluatePiece, type Piece, pieceBounds, SCENE_PIECE_BUDGET } from "./scene";
import { toonProgram } from "./templates/toon";
import { fakeMeasure, sceneInput } from "./test-support";
import type { Measure } from "./scene";

describeSpeechConformance("toon", toonProgram, { anchorLineY: 1290 });

const colours = { primary: "#4DF5B8", highlight: "#C99BFF", accent: "#1FA3F2", shadow: "#000000" };
const anchor = { xPct: 50, yPct: (1290 / 1920) * 100 };

const build = (lines: string[], options: { language?: string; cueGap?: number; input?: Partial<SceneInput> } = {}) => {
  const { cues } = demoCues({ lines, language: options.language, options: { lead: 400, gap: 30, cueGap: options.cueGap ?? 140, tail: 800 } });
  return { cues, pieces: toonProgram.build(sceneInput(cues, { fps: 30, colours, anchor, ...options.input })).pieces };
};

/** A word's readable face (its pieces when it breaks); its other copies are parts 1000 and up. */
const FACE = /^toon:(\d+):w(\d+)(?:l(\d{1,3}))?$/;
const upperOf = (face: Piece) => face.id.replace(/:w(\d+)(?:l(\d+))?$/, (_, w, part) => `:w${w}l${1000 + Number(part ?? 0)}`);
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
const box = (piece: Piece, t: number) => pieceBounds(piece, t, fakeMeasure);
const visible = (piece: Piece, t: number) => evaluatePiece(piece, t).visible && evaluatePiece(piece, t).o >= 0.5 && box(piece, t) !== null;
/** The word a decoration belongs to, from `w3hi`, `w3rim`, `pop3`; -1 for the ribbon, ball and sparkle. */
const ownWord = (piece: Piece) => Number(/:(?:w|pop)(\d+)/.exec(piece.id)?.[1] ?? -1);
const settledAt = (piece: Piece) => Math.min(piece.fromMs + 600, piece.toMs - 200);

/** No decoration of a cue sits on another word's readable face, and words of a cue never meet, on every frame. */
function expectNothingCovered(cues: readonly SceneCue[], pieces: readonly Piece[], label: string) {
  const end = Math.max(...pieces.map((piece) => piece.toMs));
  for (const t of exportFrameTimes(cues[0]!.startMs - 120, end, 30)) {
    const live = pieces.filter((piece) => visible(piece, t));
    const faces = live.filter(isFace);
    for (const [i, a] of faces.entries()) {
      for (const b of faces.slice(i + 1)) {
        if (cueOf(a) === cueOf(b) && wordOf(a) !== wordOf(b)) expect(meets(core(box(a, t)!), core(box(b, t)!)), `${label}: ${a.id} meets ${b.id} at ${t}`).toBe(false);
      }
    }
    for (const deco of live) {
      if (isFace(deco)) continue;
      const b = box(deco, t)!;
      for (const face of faces) {
        if (cueOf(face) !== cueOf(deco) || ownWord(deco) === wordOf(face) || deco.z <= face.z) continue;
        expect(meets(b, core(box(face, t)!)), `${label}: ${deco.id} is on ${face.id} at ${t}`).toBe(false);
      }
    }
  }
}

/** Every painted piece inside the caption band (y 860..1650 of 1920 at the default anchor) and the safe area. */
function expectInsideBand(pieces: readonly Piece[], label: string, canvas = { width: 1080, height: 1920 }) {
  const natural = Math.min(canvas.width, canvas.height) / 1080;
  const ay = (anchor.yPct / 100) * canvas.height;
  const band = { y1: Math.max(0.05 * canvas.height, ay - 430 * natural) - 2, y2: Math.min(0.95 * canvas.height, ay + 360 * natural) + 2 };
  for (const piece of pieces) {
    for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
      const b = box(piece, t);
      if (!b) continue;
      expect(b.y1, `${label}: ${piece.id} top at ${t}`).toBeGreaterThanOrEqual(band.y1);
      expect(b.y2, `${label}: ${piece.id} bottom at ${t}`).toBeLessThanOrEqual(band.y2);
      expect(b.x1, `${label}: ${piece.id} left at ${t}`).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
      expect(b.x2, `${label}: ${piece.id} right at ${t}`).toBeLessThanOrEqual(0.95 * canvas.width + 1);
    }
  }
}

/** The mint half follows its face exactly: same text, size and track, its clip's lower edge on the pivot (the seam). */
function expectSplitFaceTogether(pieces: readonly Piece[], label: string) {
  const faces = pieces.filter(isFace);
  expect(faces.length).toBeGreaterThan(0);
  for (const face of faces) {
    const upper = pieces.find((piece) => piece.id === upperOf(face));
    if (!upper) continue;
    expect(upper.clip?.inverse).toBe(true);
    expect(upper.kind === "text" && face.kind === "text" && upper.text === face.text && upper.sizePx === face.sizePx).toBe(true);
    for (const t of exportFrameTimes(face.fromMs, face.toMs, 30)) {
      const a = evaluatePiece(face, t);
      const b = evaluatePiece(upper, t);
      expect(b.x, `${label}: ${upper.id} x at ${t}`).toBeCloseTo(a.x, 3);
      expect(b.y, `${label}: ${upper.id} y at ${t}`).toBeCloseTo(a.y, 3);
      expect(b.sy).toBeCloseTo(a.sy, 5);
      expect(b.rz).toBeCloseTo(a.rz, 5);
      expect(b.clip!.y1, `${label}: ${upper.id} seam at ${t}`).toBeCloseTo(a.y, 3);
    }
  }
}

describe("toon", () => {
  test("every word is a whole face in the lower colour with a navy outline and drop, a rim under it and the upper colour above a level seam", () => {
    const { cues, pieces } = build(["stop:b waiting:b for:m a:m perfect:h@560 moment:b"]);
    for (const [at, word] of cues[0]!.words.entries()) {
      const face = pieces.find((piece) => piece.id === `toon:0:w${at}`)!;
      const rim = pieces.find((piece) => piece.id === `toon:0:w${at}rim`)!;
      const upper = pieces.find((piece) => piece.id === `toon:0:w${at}l1000`)!;
      expect(face.kind === "text" && face.text).toBe(word.text.toUpperCase());
      expect(face.kind === "text" && face.fill).toBe("#1FA3F2");
      expect(face.kind === "text" && face.stroke?.colour).toBe("#1A1250");
      expect(face.kind === "text" && face.shadows?.[0]?.blur).toBe(0);
      expect(upper.kind === "text" && upper.fill).toBe("#4DF5B8");
      expect(rim.z).toBeLessThan(face.z);
      expect(upper.z).toBeGreaterThan(face.z);
      expect(face.clip).toBeUndefined();
      // The seam sits inside the word's ink, near its middle.
      const t = settledAt(face);
      const ink = box(face, t)!;
      const seam = evaluatePiece(upper, t).clip!.y1;
      expect(seam).toBeGreaterThan(ink.y1 + (ink.y2 - ink.y1) * 0.25);
      expect(seam).toBeLessThan(ink.y2 - (ink.y2 - ink.y1) * 0.25);
    }
    expectSplitFaceTogether(pieces, "demo");
  });

  test("words pop in squashed and swinging, then settle; the exit squashes vertically and never widens", () => {
    const { cues, pieces } = build(["just:b start:h@520", "and:m keep:b going:b"], { cueGap: 700 });
    const hero = pieces.find((piece) => piece.id === "toon:0:w1")!;
    const onset = evaluatePiece(hero, hero.fromMs);
    expect(onset.sy).toBeLessThan(0.5);
    expect(Math.abs(onset.rz - evaluatePiece(hero, settledAt(hero)).rz)).toBeGreaterThan(5);
    const settled = box(hero, settledAt(hero))!;
    const exitFrames = exportFrameTimes(cues[0]!.words.at(-1)!.endMs + 150, hero.toMs, 30);
    expect(exitFrames.some((t) => evaluatePiece(hero, t).sy < 0.8)).toBe(true);
    for (const t of exitFrames) {
      const b = box(hero, t);
      if (!b) continue;
      expect(b.x2 - b.x1, `width at ${t}`).toBeLessThanOrEqual(settled.x2 - settled.x1 + 0.5);
      expect(evaluatePiece(hero, t).sx).toBeCloseTo(1, 5);
    }
  });

  test("the key word gets the six-section ribbon and the ball behind every letter; a cue without one gets neither", () => {
    const { pieces } = build(["stop:b waiting:b perfect:h@560", "nobody:b is:m watching:b"]);
    const ribbon = pieces.filter((piece) => /^toon:0:rib\d$/.test(piece.id));
    expect(ribbon.length).toBe(6);
    const ball = pieces.find((piece) => piece.id === "toon:0:ball")!;
    expect(ball).toBeDefined();
    const lowestText = Math.min(...pieces.filter((piece) => piece.kind === "text").map((piece) => piece.z));
    for (const piece of [...ribbon, ball]) expect(piece.z).toBeLessThan(lowestText);
    expect(pieces.some((piece) => /^toon:1:(rib|ball)/.test(piece.id))).toBe(false);
    // Wiped in: the first section's clip opens over time, then holds.
    const first = ribbon[0]!;
    const whole = box({ ...first, clip: undefined }, first.fromMs + 400)!;
    const shown = (t: number) => {
      const b = box(first, t);
      return b ? b.x2 - b.x1 : 0;
    };
    expect(shown(first.fromMs)).toBeLessThan((whole.x2 - whole.x1) * 0.2);
    expect(shown(first.fromMs + 400)).toBeCloseTo(whole.x2 - whole.x1, 3);
  });

  test("the ribbon and the ball keep a visible gap from the rows above and below, entrance frames included", () => {
    for (const lines of [["stop:b waiting:b for:m a:m perfect:h@560 moment:b"], ["it:m only:b takes a:m spark:h@520 today:b"], ["the:m remote:b doesn't:h@360 work.:b"]]) {
      const { cues, pieces } = build(lines);
      const deco = pieces.filter((piece) => /:(rib\d|ball)$/.test(piece.id));
      const others = pieces.filter((piece) => isFace(piece) && cues[0]!.words[wordOf(piece)]!.role !== "hero");
      for (const t of exportFrameTimes(cues[0]!.startMs - 100, cues[0]!.endMs, 30)) {
        for (const d of deco) {
          const b = box(d, t);
          if (!b) continue;
          for (const face of others) {
            const f = box(face, t);
            if (f) expect(meets(b, f), `${d.id} meets ${face.id} at ${t}`).toBe(false);
          }
        }
      }
    }
  });

  test("entrance poses (squash, swing, rise, spring overshoot) never touch a neighbouring row or word", () => {
    for (const lines of [
      ["stop:b waiting:b for:m a:m perfect:h@560 moment:b", "nobody:b is:m watching:b you:b that:m closely:b"],
      ["consistency:h@720 wins:b today:b", "it:m only:b takes a:m spark:h@520"],
    ]) {
      const { cues, pieces } = build(lines);
      for (const t of exportFrameTimes(cues[0]!.startMs - 100, cues.at(-1)!.endMs, 30)) {
        const faces = pieces.filter((piece) => isFace(piece) && box(piece, t));
        for (const [i, a] of faces.entries()) {
          for (const b of faces.slice(i + 1)) {
            if (cueOf(a) === cueOf(b)) expect(meets(box(a, t)!, box(b, t)!), `${a.id} touches ${b.id} at ${t}`).toBe(false);
          }
        }
      }
    }
  });

  test("short minor words are small and tilted in any language; long minor words and a row of only small words are not tiny", () => {
    const size = (pieces: readonly Piece[], id: string) => {
      const piece = pieces.find((p) => p.id === id)!;
      return piece.kind === "text" ? piece.sizePx : 0;
    };
    const en = build(["nobody:b is:m watching:b closely:b"]).pieces;
    expect(size(en, "toon:0:w1")).toBeLessThan(size(en, "toon:0:w0") * 0.6);
    const small = en.find((p) => p.id === "toon:0:w1")!;
    expect(Math.abs(evaluatePiece(small, settledAt(small)).rz)).toBeCloseTo(4, 3);
    const long = build(["nobody:b because:m watching:b"]).pieces;
    expect(size(long, "toon:0:w1")).toBeCloseTo(size(long, "toon:0:w0"), 3);
    const hi = build(["देखो:b तो:m इतना:b"], { language: "hi" }).pieces;
    expect(size(hi, "toon:0:w1")).toBeLessThan(size(hi, "toon:0:w0") * 0.6);
    const allSmall = build(["it's:m been:m that:m"]).pieces;
    expect(size(allSmall, "toon:0:w0")).toBeGreaterThan(64 * 1.2);
  });

  test("pop lines and the sparkle recur on ordinary speech and never touch another word", () => {
    const run = fastRun(60);
    const pieces = toonProgram.build(sceneInput(run, { fps: 30, colours, anchor })).pieces;
    const withPop = new Set(pieces.filter((piece) => /:pop\d+$/.test(piece.id)).map(cueOf));
    const withStar = new Set(pieces.filter((piece) => /:star$/.test(piece.id)).map(cueOf));
    expect(withPop.size).toBeGreaterThanOrEqual(Math.ceil(run.length * 0.75));
    expect(withStar.size).toBeGreaterThanOrEqual(Math.ceil(run.length * 0.75));
    for (const pop of pieces.filter((piece) => /:pop\d+$/.test(piece.id))) {
      const frames = exportFrameTimes(pop.fromMs, pop.toMs, 30).filter((t) => box(pop, t));
      expect(frames.length).toBeGreaterThanOrEqual(2);
    }
    expectNothingCovered(run, pieces, "fast run");
    // A long hold twinkles the sparkle again.
    const long = build(["keep:b going:b", "now:b"], { cueGap: 3000 }).pieces;
    const star = long.find((piece) => piece.id === "toon:0:star")!;
    expect(star.track.rz!.length).toBeGreaterThan(3);
  });

  test("brand colours that vanish against the navy outline fall back; readable ones are used", () => {
    const face = (pieces: readonly Piece[], id: string) => {
      const piece = pieces.find((p) => p.id === id)!;
      return piece.kind === "text" ? piece.fill : piece.fill?.colour;
    };
    const dark = build(["just:b start:h@520"], { input: { colours: { primary: "#666666", highlight: "#1A1250", accent: "#000000", shadow: "#000000" } } }).pieces;
    expect(face(dark, "toon:0:w0l1000")).toBe("#4DF5B8");
    expect(face(dark, "toon:0:w0")).toBe("#1FA3F2");
    expect(face(dark, "toon:0:rib0")).toBe("#C99BFF");
    const branded = build(["just:b start:h@520"], { input: { colours: { primary: "#858585", highlight: "#FFB3D9", accent: "#FF7A00", shadow: "#000000" } } }).pieces;
    expect(face(branded, "toon:0:w0l1000")).toBe("#858585");
    expect(face(branded, "toon:0:w0")).toBe("#FF7A00");
    expect(face(branded, "toon:0:rib0")).toBe("#FFB3D9");
  });

  test("continuous single-word cues hand off without a blank frame", () => {
    const run = staccatoRun(0);
    for (const fps of [24, 25, 30]) {
      const pieces = toonProgram.build(sceneInput(run, { fps, colours, anchor })).pieces;
      const faces = pieces.filter(isFace);
      for (const t of exportFrameTimes(run[0]!.words[0]!.startMs, run.at(-1)!.words.at(-1)!.endMs, fps)) {
        expect(faces.some((face) => box(face, t) && evaluatePiece(face, t).o > 0.05), `blank at ${t} (${fps} fps)`).toBe(true);
      }
      // A face that paints on a single frame still has its navy outline and drop: it never lands bare on footage.
      for (const face of faces) expect(face.kind === "text" && face.stroke && face.shadows?.length).toBeTruthy();
    }
  });

  test("everything of a cue moves with it into a speaker lane at 2x on 16:9: both face halves, their clip, the ribbon and the ball", () => {
    const { cues } = sceneEdgeDemo("two-speakers");
    const heroed = cues.map((cue) => ({ ...cue, words: cue.words.map((word, at) => (at === cue.words.length - 1 ? { ...word, role: "hero" as const } : word)) }));
    for (const canvas of [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }]) {
      const pieces = toonProgram.build(sceneInput(heroed, { fps: 30, colours, anchor, scale: 2, canvas })).pieces;
      expectSplitFaceTogether(pieces, `${canvas.width}x${canvas.height}`);
      for (const cue of heroed) {
        const hero = pieces.find((piece) => piece.id === `toon:${cue.index}:w${cue.words.findIndex((word) => word.role === "hero")}`);
        const ribbon = pieces.filter((piece) => piece.id.startsWith(`toon:${cue.index}:rib`));
        if (!hero || !ribbon.length) continue;
        const t = settledAt(hero);
        const h = box(hero, t)!;
        const r = ribbon.map((piece) => box(piece, t)).filter((b): b is Box => b !== null);
        const rb = { x1: Math.min(...r.map((b) => b.x1)), x2: Math.max(...r.map((b) => b.x2)), y1: Math.min(...r.map((b) => b.y1)), y2: Math.max(...r.map((b) => b.y2)) };
        // The ribbon surrounds its (first) key word wherever the lane put it.
        expect(rb.x1).toBeLessThan(h.x1 + (h.x2 - h.x1) * 0.2);
        expect(rb.x2).toBeGreaterThan(h.x2 - (h.x2 - h.x1) * 0.2);
        expect(rb.y1).toBeLessThan(h.y1);
        expect(rb.y2).toBeGreaterThan(h.y2 - (h.y2 - h.y1) * 0.3);
        for (const piece of ribbon) {
          const clip = evaluatePiece(piece, piece.toMs - 1).clip!;
          const b = box({ ...piece, clip: undefined }, piece.toMs - 1);
          if (b) expect(clip.x1 <= b.x1 + 1 && clip.x2 >= b.x2 - 1 && clip.y1 <= b.y1 + 1 && clip.y2 >= b.y2 - 1, `${piece.id} clip left behind`).toBe(true);
        }
      }
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
      expect(pieces.filter((piece) => piece.id.includes(":rib")).length).toBe(6);
      expectInsideBand(pieces, "hi");
      expectNothingCovered(cues, pieces, "hi");
    });

    test("an Urdu (RTL) cue with a key word reads right to left, mirrors the slant and wipes the ribbon from the right", () => {
      const { cues, pieces } = build(["یہ:m بہت:b اچھا:h@600 ہے:m", "میں:b نے:m آج:b سیکھا:b"], { language: "ur" });
      const at = (cue: number, w: number) => pieces.find((piece) => piece.id === `toon:${cue}:w${w}`)!;
      expect(evaluatePiece(at(1, 2), settledAt(at(1, 2))).x).toBeLessThan(evaluatePiece(at(1, 0), settledAt(at(1, 0))).x);
      expect(evaluatePiece(at(0, 1), settledAt(at(0, 1))).skx).toBeGreaterThan(0);
      const crest = pieces.find((piece) => piece.id === "toon:0:rib0")!;
      const early = evaluatePiece(crest, crest.fromMs + 40).clip!;
      const late = evaluatePiece(crest, crest.fromMs + 500).clip!;
      expect(early.x2).toBeCloseTo(late.x2, 3);
      expect(early.x1).toBeGreaterThan(late.x1 + 10);
      expectInsideBand(pieces, "ur");
      expectNothingCovered(cues, pieces, "ur");
    });

    test("a CJK cue with no spaces wraps into rows at a readable size, never shrinking below the floor", () => {
      const text = "我们今天要讨论的是人工智能在未来十年里的发展方向";
      const { cues, pieces } = build([`${text}:b@2400`], { language: "zh" });
      const parts = pieces.filter((piece) => /^toon:0:w0l\d{1,3}$/.test(piece.id));
      expect(parts.length).toBeGreaterThanOrEqual(2);
      expect(parts.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(text);
      for (const piece of parts) expect(piece.kind === "text" && piece.sizePx).toBeGreaterThanOrEqual(96 - 0.5);
      expect(new Set(parts.map((piece) => Math.round(evaluatePiece(piece, settledAt(piece)).y))).size).toBe(parts.length);
      expectInsideBand(pieces, "zh");
      expectNothingCovered(cues, pieces, "zh");
      expectSplitFaceTogether(pieces, "zh");
    });

    test("a mixed Latin, accents and digits cue stays in reading order, inside the band, uncovered", () => {
      const { cues, pieces } = build(["café:b crème:b 2026:h@500 déjà:m vu:b"], { language: "fr" });
      const face = (at: number) => pieces.find((piece) => piece.id === `toon:0:w${at}`)!;
      expect(evaluatePiece(face(1), settledAt(face(1))).x).toBeGreaterThan(evaluatePiece(face(0), settledAt(face(0))).x);
      expect(face(0).kind === "text" && face(0).text).toBe("CAFÉ");
      expect(face(2).kind === "text" && face(2).text).toBe("2026");
      expectInsideBand(pieces, "fr");
      expectNothingCovered(cues, pieces, "fr");
    });

    test("tall and long cues stay in the band at twice the size, portrait and landscape", () => {
      for (const edge of ["urdu", "nine-words", "long-word"] as const) {
        for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
          const { cues } = sceneEdgeDemo(edge);
          const pieces = toonProgram.build(sceneInput(cues, { fps: 30, colours, anchor, scale: 2, canvas })).pieces;
          expectInsideBand(pieces, `${edge} ${canvas.width}x${canvas.height}`, canvas);
        }
      }
    });
  });

  test("long tokens: the floor holds after the fit, rows balance without false spaces, and a pathological token stays in budget", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      for (const word of ["CONTEMPORANEOUSNESS", "abdominohysterectomy"]) {
        const { pieces } = build([`${word}:h@1200`], { input: { canvas } });
        const parts = pieces.filter((piece) => /^toon:0:w0(l\d{1,3})?$/.test(piece.id)).map((piece) => (piece.kind === "text" ? piece : null)!);
        expect(parts.map((piece) => piece.text).join("")).toBe(word.toUpperCase());
        const natural = Math.min(canvas.width, canvas.height) / 1080;
        for (const piece of parts) {
          expect(piece.sizePx).toBeGreaterThanOrEqual(140 * natural * 0.9);
          expect(piece.text).not.toContain(" ");
        }
      }
      const cjk = "我们今天要讨论的是人工智能在未来十年里的发展方向".repeat(4).slice(0, 90);
      const { pieces } = build([`${cjk}:b@4000`], { language: "zh", input: { canvas } });
      const parts = pieces.filter((piece) => /^toon:0:w0(l\d{1,3})?$/.test(piece.id));
      expect(parts.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(cjk);
      expect(pieces.length).toBeLessThanOrEqual(150);
    }
    const huge = "a".repeat(400);
    const { pieces } = build([`${huge}:b@4000`]);
    expect(pieces.length).toBeLessThanOrEqual(150);
    expect(pieces.filter(isFace).map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(huge.toUpperCase());
  });

  test("the onset frame of every word paints it at 24, 25, 30 and 60 fps, near opaque", () => {
    for (const fps of [24, 25, 30, 60]) {
      const { cues, pieces } = build(["stop:b waiting:b perfect:h@560", "keep:b going:b"], { input: { fps } });
      for (const cue of cues) {
        for (const [at, word] of cue.words.entries()) {
          const face = pieces.find((piece) => piece.id === `toon:${cue.index}:w${at}`)!;
          const t = exportFrameTimes(word.startMs, word.startMs + 100, fps)[0]!;
          expect(evaluatePiece(face, t).o).toBeGreaterThan(0.35);
          expect(kf(t, face.track.o ?? [[0, 1]])).toBeGreaterThan(0.35);
        }
      }
    }
  });
});

describe("toon review round 1", () => {
  /** Shadow copies count against the 150-piece budget too. */
  const cost = (pieces: readonly Piece[], cue: number) => pieces.filter((piece) => cueOf(piece) === cue).reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0), 0);
  const staccatoKey = (fps: number, offset: number) => {
    const lines = ["go@70", "on@70", "then@120", "we@100 stop:h@120", "we@70 stop:h@100", "one@70 more@70 step@80", "yes:h@100", "no:h@70", "right@90 now:h@100", "ok@70"];
    const { cues } = demoCues({ lines, options: { lead: 311 + offset, gap: 0, cueGap: 0, tail: 400 } });
    return { cues, pieces: toonProgram.build(sceneInput(cues, { fps, colours, anchor })).pieces };
  };

  test("a word is whole, opaque and settled in its slot on its first spoken frame (no fade, squash or travel through the onset)", () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const [name, run] of [["fast 0", fastRun(0)], ["fast 60", fastRun(60)], ["staccato 0", staccatoRun(0)], ["staccato 60", staccatoRun(60)]] as const) {
        const pieces = toonProgram.build(sceneInput(run, { fps, colours, anchor })).pieces;
        for (const cue of run) {
          for (const [at, word] of cue.words.entries()) {
            const onset = exportFrameAtOrAfter(word.startMs, fps);
            for (const piece of pieces.filter((p) => p.id === `toon:${cue.index}:w${at}` || p.id === `toon:${cue.index}:w${at}l1000`)) {
              const pose = evaluatePiece(piece, onset);
              const label = `${name} ${fps} fps ${piece.id} at ${onset}`;
              expect(pose.o, label).toBeCloseTo(1, 6);
              expect(pose.sx, label).toBeCloseTo(1, 6);
              expect(pose.sy, label).toBeCloseTo(1, 6);
              // Nothing moves between the onset and the spoken end (the exit starts after it).
              for (const track of [piece.track.y, piece.track.rz, piece.track.sx, piece.track.sy, piece.track.o]) {
                for (const [t] of track ?? []) if (t > onset) expect(t, `${label} keyed at ${t}`).toBeGreaterThanOrEqual(word.endMs);
              }
            }
          }
        }
      }
    }
    // With time before the word, it still pops: squashed and swung before the onset.
    const { cues, pieces } = build(["just:b start:h@520"], { cueGap: 700 });
    const hero = pieces.find((piece) => piece.id === "toon:0:w1")!;
    expect(evaluatePiece(hero, hero.fromMs).sy).toBeLessThan(0.5);
    expect(hero.fromMs).toBeLessThanOrEqual(cues[0]!.words[1]!.startMs - 200);
  });

  test("a key word that paints on a single frame keeps its upper colour, rim, ribbon and ball on that frame, cleared with it", () => {
    let seen = 0;
    for (const offset of [0, 2, 7, 13, 23, 31]) {
      const { cues, pieces } = staccatoKey(25, offset);
      for (const cue of cues) {
        const heroAt = cue.words.findIndex((word) => word.role === "hero");
        if (heroAt < 0) continue;
        const face = pieces.find((piece) => piece.id === `toon:${cue.index}:w${heroAt}`)!;
        const frames = exportFrameTimes(face.fromMs, face.toMs, 25).filter((t) => box(face, t));
        if (frames.length !== 1) continue;
        seen++;
        const own = pieces.filter((piece) => piece.id.startsWith(`toon:${cue.index}:w${heroAt}l`));
        const parts = own.map((piece) => Number(/l(\d+)$/.exec(piece.id)![1]));
        expect(parts, `offset ${offset} cue ${cue.index}`).toContain(1000);
        expect(parts.some((part) => part >= 2000 && part < 3000), "rim").toBe(true);
        expect(parts.filter((part) => part >= 3000 && part < 3006).length, "ribbon").toBe(6);
        expect(parts.filter((part) => part >= 3006).length, "ball").toBe(2);
        for (const piece of own) {
          expect(box(piece, frames[0]!), `${piece.id} on the frame`).not.toBeNull();
          expect(evaluatePiece(piece, frames[0]!).o).toBeGreaterThan(0.99);
          for (const t of exportFrameTimes(piece.fromMs - 200, piece.toMs + 200, 25)) if (t !== frames[0]) expect(box(piece, t), `${piece.id} at ${t}`).toBeNull();
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  test("a short joined-script word keeps a readable size and a visible gap when its measured ink is small", () => {
    // Real ink of the fallback faces at 100 px (HarfBuzz): Nastaliq "یہ" is narrow and low, "ہے" is not.
    const real: Record<string, readonly [number, number, number]> = { "یہ": [47, -22, 40], "ہے": [134, -57, 45], "بہت": [183, -70, 18], "اچھا": [150, -95, 30], "तो": [83, -90, 1], "देखो": [150, -95, 5], "इतना": [160, -95, 10] };
    const measure: Measure = (text, face, size, ls) => {
      const m = real[text];
      return m ? { advance: (m[0] * size) / 100, inkTop: (m[1] * size) / 100, inkBottom: (m[2] * size) / 100, ascent: 1.1 * size, descent: 0.3 * size } : fakeMeasure(text, face, size, ls);
    };
    const size = (pieces: readonly Piece[], id: string) => (pieces.find((p) => p.id === id) as { sizePx: number }).sizePx;
    const ur = build(["یہ:m بہت:b اچھا:h@600"], { language: "ur", input: { measure } }).pieces;
    expect(size(ur, "toon:0:w0")).toBeCloseTo(size(ur, "toon:0:w1"), 3);
    const t = 900;
    const a = pieceBounds(ur.find((p) => p.id === "toon:0:w0rim")!, t, measure)!;
    const b = pieceBounds(ur.find((p) => p.id === "toon:0:w1rim")!, t, measure)!;
    expect(Math.max(b.x1 - a.x2, a.x1 - b.x2), "outline gap").toBeGreaterThan(0.04 * size(ur, "toon:0:w0"));
    const roomy = build(["ہے:m بہت:b اچھا:h@600"], { language: "ur", input: { measure } }).pieces;
    expect(size(roomy, "toon:0:w0")).toBeLessThan(size(roomy, "toon:0:w1") * 0.6);
    const hi = build(["देखो:b तो:m इतना:b"], { language: "hi", input: { measure } }).pieces;
    expect(size(hi, "toon:0:w1")).toBeCloseTo(size(hi, "toon:0:w0"), 3);
  });

  test("NFC and NFD input spell the same caption: same rows, sizes and text, never a syllable cut across rows", () => {
    for (const [text, language] of [["한글로쓴문장에는음절이많이들어갑니다한글로쓴문장입니다", "ko"], ["électroencéphalographiquement", "fr"]] as const) {
      const layouts = ["NFC", "NFD"].map((form) => {
        const { pieces } = build([`${text.normalize(form)}:b@2000`], { language });
        return pieces.filter((piece) => /^toon:0:w0(l\d{1,3})?$/.test(piece.id)).map((piece) => ({ text: piece.kind === "text" ? piece.text : "", size: (piece as { sizePx: number }).sizePx, y: Math.round(evaluatePiece(piece, 1500).y) }));
      });
      expect(layouts[1]).toEqual(layouts[0]!);
      for (const part of layouts[0]!) expect(/^(?:\p{M}|[ᅠ-ᇿ])/u.test(part.text), part.text).toBe(false);
    }
  });

  test("long tokens keep their floor after the final fit by paging through the band; ordinary small words keep theirs; every cue stays in budget", () => {
    const han = "我们今天要讨论的是人工智能在未来十年里的发展方向".repeat(4).slice(0, 90);
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      const natural = Math.min(canvas.width, canvas.height) / 1080;
      const { pieces } = build([`${han}:b@4000`], { language: "zh", input: { canvas } });
      const parts = pieces.filter((piece) => /^toon:0:w0(l\d{1,3})?$/.test(piece.id));
      expect(parts.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(han);
      for (const piece of parts) expect((piece as { sizePx: number }).sizePx, `${canvas.width}x${canvas.height}`).toBeGreaterThanOrEqual(96 * natural - 0.5);
      expect(cost(pieces, 0)).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
      expectInsideBand(pieces, `han ${canvas.width}x${canvas.height}`, canvas);
      // Pages follow one another: every frame of the word shows some of it, never two pages at once.
      for (const t of exportFrameTimes(1000, 4800, 30)) {
        const live = parts.filter((piece) => box(piece, t));
        expect(live.length, `frame ${t}`).toBeGreaterThan(0);
        expect(new Set(live.map((piece) => piece.fromMs)).size).toBe(1);
      }
    }
    for (const [lines, label] of [[[`${"漢".repeat(480)}:b@6000`], "480 han"], [["so:m i:m quit:b my:m job:b and:m the:m whole:b team", `${"a".repeat(400)}:h@3000`], "nine words + 400 letters"]] as const) {
      const { cues, pieces } = build([...lines], { language: label.includes("han") ? "zh" : "en" });
      for (const cue of cues) expect(cost(pieces, cue.index), `${label} cue ${cue.index}`).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
      for (const piece of pieces.filter(isFace)) expect((piece as { sizePx: number }).sizePx, `${label} ${piece.id}`).toBeGreaterThanOrEqual(64 - 0.5);
    }
    const { cues } = sceneEdgeDemo("nine-words");
    const nine = toonProgram.build(sceneInput(cues, { fps: 30, colours, anchor })).pieces;
    for (const piece of nine.filter(isFace)) expect((piece as { sizePx: number }).sizePx, piece.id).toBeGreaterThanOrEqual(64 - 0.5);
  });

  test("the sparkle recurs on nearly every cue of ordinary speech", () => {
    const run = fastRun(60);
    const pieces = toonProgram.build(sceneInput(run, { fps: 30, colours, anchor })).pieces;
    expect(new Set(pieces.filter((piece) => /:star$/.test(piece.id)).map(cueOf)).size).toBeGreaterThanOrEqual(run.length - 1);
  });

  test("the ball has landed before the exit starts, and peeks out from behind the key word's outline", () => {
    // Short cues compress the ball's pop; it still lands before the squash starts (time-ordered tracks).
    for (const run of [fastRun(0), fastRun(60), staccatoRun(60)]) {
      const pieces = toonProgram.build(sceneInput(run, { fps: 30, colours, anchor })).pieces;
      for (const ball of pieces.filter((piece) => /:ball(hi)?$/.test(piece.id))) {
        for (const track of [ball.track.y, ball.track.sy, ball.track.sx]) {
          for (let i = 1; i < (track?.length ?? 0); i++) expect(track![i]![0], `${ball.id} keys out of order`).toBeGreaterThanOrEqual(track![i - 1]![0]);
        }
      }
    }
    const { pieces } = build(["just:b start:h@520"], { cueGap: 700 });
    const ball = pieces.find((piece) => piece.id === "toon:0:ball")!;
    const hero = pieces.find((piece) => piece.id === "toon:0:w1")!;
    const t = settledAt(hero);
    expect(box(ball, t)!.y2).toBeGreaterThan(box(hero, t)!.y1);
  });
});
