import { describe, expect, test } from "bun:test";
import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast } from "@narriflow/validators";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues } from "./demo";
import { exportFrameTimes, paintedFrameCount } from "./frame-grid";
import type { SceneInput } from "./input";
import type { SceneCue } from "./input";
import { type Box, type Measure, type Piece, evaluatePiece, pieceBounds } from "./scene";
import { HELIUM_BASE_FLOOR, heliumPalette, heliumProgram, heliumShine } from "./templates/helium";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("helium", heliumProgram, { anchorLineY: 1290 });

const colours = { primary: "#2456F5", highlight: "#FF5A48", accent: "#0FBF94", shadow: "#000000" };

/** The fake measure, with taller ink for Devanagari and Nastaliq and full-width CJK, as the real faces draw them. */
const scriptMeasure: Measure = (text, face, size, spacing) => {
  const base = fakeMeasure(text, face, size, spacing);
  if (/[ऀ-ॿ]/u.test(text)) return { ...base, inkTop: -0.98 * size, inkBottom: 0.32 * size };
  if (/[؀-ۿ]/u.test(text)) return { ...base, inkTop: -0.92 * size, inkBottom: 0.48 * size };
  if (/[　-ヿ一-鿿]/u.test(text)) {
    const n = [...text].length;
    return { ...base, advance: n * (1 + spacing) * size - spacing * size, inkTop: -0.86 * size, inkBottom: 0.1 * size };
  }
  return base;
};

const build = (lines: string[], options: { language?: string; input?: Partial<SceneInput>; demo?: Record<string, number> } = {}) => {
  const { cues } = demoCues({ lines, language: options.language, options: { lead: 400, gap: 30, cueGap: 140, tail: 900, ...options.demo } });
  const input = sceneInput(cues, { fps: 30, colours, measure: scriptMeasure, ...options.input });
  return { cues, input, pieces: heliumProgram.build(input).pieces };
};

const FACE = /^helium:(\d+):w(\d+)(?:l\d+)?$/;
const faces = (pieces: readonly Piece[], cue: number) => pieces.filter((piece) => FACE.test(piece.id) && Number(piece.id.split(":")[1]) === cue);
const decorations = (pieces: readonly Piece[], cue: number) => pieces.filter((piece) => /^helium:\d+:(str|knot|bal\d)/.test(piece.id) && Number(piece.id.split(":")[1]) === cue);
const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
const wordOf = (piece: Piece) => Number(FACE.exec(piece.id)![2]);

/** Every word's face stays inside the safe area; no two words and no word and decoration meet, on any export frame. */
function expectClean(built: ReturnType<typeof build>) {
  const { cues, input, pieces } = built;
  const { width, height } = input.canvas;
  const safe = { x1: 0.05 * width - 1, y1: 0.05 * height - 1, x2: 0.95 * width + 1, y2: 0.95 * height + 1 };
  for (const cue of cues) {
    const own = faces(pieces, cue.index);
    const decos = decorations(pieces, cue.index);
    for (const t of exportFrameTimes(cue.startMs, cue.endMs, 30)) {
      const live = own.map((piece) => ({ piece, box: pieceBounds(piece, t, input.measure) })).filter((item): item is { piece: Piece; box: Box } => item.box !== null);
      for (const { box } of live) {
        expect(box.x1).toBeGreaterThanOrEqual(safe.x1);
        expect(box.x2).toBeLessThanOrEqual(safe.x2);
        expect(box.y1).toBeGreaterThanOrEqual(safe.y1);
        expect(box.y2).toBeLessThanOrEqual(safe.y2);
      }
      for (const [i, a] of live.entries()) {
        for (const b of live.slice(i + 1)) if (wordOf(a.piece) !== wordOf(b.piece)) expect(meets(a.box, b.box)).toBe(false);
      }
      for (const deco of decos) {
        const box = pieceBounds(deco, t, input.measure);
        if (!box || evaluatePiece(deco, t).o < 0.05) continue;
        expect(box.y2).toBeLessThanOrEqual(safe.y2);
        if (/:(str|knot)$/.test(deco.id)) continue; // the string hangs from the key word itself
        for (const { box: faceBox } of live) expect(meets(box, faceBox)).toBe(false);
      }
    }
  }
}

describe("helium", () => {
  test("hues cycle cobalt, coral, mint by cue on any clip, each with the sample's rim, deep edge and base", () => {
    const { pieces } = build(["one:b two:b", "three:b four:b", "five:b six:b", "seven:b eight:b"]);
    const fill = (cue: number, suffix = "") => (pieces.find((piece) => piece.id === `helium:${cue}:w0${suffix}`) as { fill: string }).fill;
    expect([0, 1, 2, 3].map((cue) => fill(cue))).toEqual(["#2456F5", "#FF5A48", "#0FBF94", "#2456F5"]);
    expect([fill(1, "r"), fill(1, "d"), fill(1, "s")]).toEqual(["#FFB09F", "#C72D2B", "#6B1117"]);
  });

  test("every hue keeps 3:1 against its dark base; a brand colour gets a derived base, a colour that cannot reach it keeps the style's own", () => {
    for (const face of ["#2456F5", "#FF5A48", "#0FBF94", "#FFFFFF", "#7A3CFF", "#FFD400"]) {
      const palette = heliumPalette(face, "#2456F5");
      expect(captionColourContrast(palette.face, palette.shadow)).toBeGreaterThanOrEqual(CAPTION_SCENE_BRAND_MIN_CONTRAST);
    }
    expect(heliumPalette("#7A3CFF", "#2456F5").face).toBe("#7A3CFF");
    expect(heliumPalette("#101010", "#FF5A48").face).toBe("#FF5A48");
    expect(captionColourContrast("#2456F5", HELIUM_BASE_FLOOR)).toBeGreaterThanOrEqual(CAPTION_SCENE_BRAND_MIN_CONTRAST);
    const { pieces } = build(["one:b two:b"], { input: { colours: { ...colours, primary: "#0A0A0A" } } });
    expect((pieces.find((piece) => piece.id === "helium:0:w0") as { fill: string }).fill).toBe("#2456F5");
  });

  test("shines come from the font table: inside the cap box, with accented capitals taking their base letter's", () => {
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
      const shine = heliumShine(letter, "Fredoka Bold");
      expect(shine).not.toBeNull();
      for (let at = 1; at < shine!.length; at += 2) {
        expect(shine![at]!).toBeGreaterThan(0);
        expect(shine![at + 1]!).toBeLessThan(0);
        expect(shine![at + 1]!).toBeGreaterThan(-0.72);
      }
    }
    expect(heliumShine("É", "Fredoka Bold")).toEqual(heliumShine("E", "Fredoka Bold"));
    expect(heliumShine("Ç", "Fredoka SemiBold")).toEqual(heliumShine("C", "Fredoka SemiBold"));
  });

  test("each Latin word's shine is one shape that rides its word to the end of the cue; other scripts take one white pill per word", () => {
    const latin = build(["just:b let:b it:m go:b"]);
    for (const face of faces(latin.pieces, 0)) {
      const shine = latin.pieces.find((piece) => piece.id === `${face.id}g`)!;
      expect(shine.kind).toBe("shape");
      expect(shine.track).toEqual(face.track);
      expect(shine.toMs).toBe(face.toMs);
    }
    const hindi = build(["और:m अगर:b सीधा:h@600"], { language: "hi" });
    for (const face of faces(hindi.pieces, 0)) {
      const shine = hindi.pieces.find((piece) => piece.id === `${face.id}g`)!;
      expect(shine.kind).toBe("text");
      expect(shine.clip?.radius).toBeGreaterThan(0);
      expect(shine.track).toEqual(face.track);
    }
  });

  test("a key word is whole and opaque by its spoken start: every letter drawn from the word's first frame, only the rise staggered", () => {
    const { cues, pieces } = build(["your:m ideas:b deserve:b to:m fly:h@580", "keep:b rising:h@640"]);
    for (const cue of cues) {
      const heroAt = cue.words.findIndex((word) => word.role === "hero");
      const letters = pieces.filter((piece) => new RegExp(`^helium:${cue.index}:w${heroAt}l\\d+$`).test(piece.id));
      expect(letters.length).toBe(cue.words[heroAt]!.text.length);
      const from = letters[0]!.fromMs;
      for (const letter of letters) {
        expect(letter.fromMs).toBe(from);
        expect(evaluatePiece(letter, cue.words[heroAt]!.startMs).o).toBeGreaterThanOrEqual(0.99);
      }
      expect(from).toBeGreaterThanOrEqual(cue.words[heroAt]!.startMs - 80);
    }
  });

  test("the string hangs only under a last-row key word, inside the band; a key word with words after it has none", () => {
    const { input, pieces } = build(["your:m ideas:b deserve:b to:m fly:h@580", "the:m remote:b doesn't:h@600 work.:b"]);
    const string = pieces.find((piece) => piece.id === "helium:0:str")!;
    expect(string).toBeDefined();
    for (const t of exportFrameTimes(string.fromMs, string.toMs, 30)) {
      const box = pieceBounds(string, t, input.measure);
      if (box) expect(box.y2).toBeLessThanOrEqual(0.95 * input.canvas.height);
    }
    expect(pieces.some((piece) => piece.id === "helium:1:str")).toBe(false);
  });

  test("on a 24-cue clip of ordinary speech nearly every cue releases its balloons, clear of every word", () => {
    const lines = Array.from({ length: 24 }, (_, at) => (at % 3 === 0 ? "it's:b time:b to:m say:h@420" : at % 3 === 1 ? "does:b the:m remote:b" : "is:m it:m dead?:h@380"));
    const built = build(lines, { demo: { cueGap: 60, gap: 20, tail: 500 } });
    const released = built.cues.filter((cue) => built.pieces.some((piece) => piece.id === `helium:${cue.index}:bal0`)).length;
    expect(released).toBeGreaterThanOrEqual(20);
    expectClean(built);
  });

  test("a landing word nudges the row's previous word outward and back, and the first word of a row eases into its slot", () => {
    const { cues, pieces } = build(["just:b let:b it:m go:b"]);
    const just = pieces.find((piece) => piece.id === "helium:0:w0")!;
    const at = cues[0]!.words[1]!.startMs;
    const x = (ms: number) => evaluatePiece(just, ms).x;
    expect(x(just.fromMs)).toBeGreaterThan(x(at - 1) + 5);
    const rest = x(at + 600);
    expect(Math.min(...[0, 60, 120, 180].map((dt) => x(at - 50 + dt)))).toBeLessThan(rest - 2);
  });

  test("the cue leaves as one unit: every piece fades out by the next cue's first paint", () => {
    const { cues, pieces } = build(["just:b let:b it:m go:b", "keep:b rising:h@640"], { demo: { cueGap: 400 } });
    const next = Math.min(...pieces.filter((piece) => piece.id.startsWith("helium:1:")).map((piece) => piece.fromMs));
    for (const piece of pieces.filter((piece) => piece.id.startsWith("helium:0:"))) {
      expect(piece.toMs).toBeLessThanOrEqual(next);
      if (FACE.test(piece.id)) expect(evaluatePiece(piece, piece.toMs - 1).o).toBeLessThan(0.2);
    }
    expect(cues.length).toBe(2);
  });

  test("Hindi with a key word: Devanagari stays whole, tall ink grows the rows, nothing meets", () => {
    const built = build(["display:b glare:b बहुत:h@420", "और:m अगर:b इसे:m सीधा:h@400", "देखो:b तो:m इतना:h@380"], { language: "hi" });
    for (const piece of built.pieces.filter((piece) => FACE.test(piece.id) && /[ऀ-ॿ]/u.test((piece as { text: string }).text))) {
      expect(piece.id).toMatch(/:w\d+$/);
    }
    expectClean(built);
  });

  test("Urdu with a key word: one piece per word, the row runs right to left, nothing meets", () => {
    const built = build(["یہ:m بہت:b ضروری:h@500 ہے:b", "ہم:m نے:m سوچا:b"], { language: "ur" });
    const cue = built.cues[1]!;
    const xs = cue.words.map((_, w) => evaluatePiece(built.pieces.find((piece) => piece.id === `helium:1:w${w}`)!, cue.endMs - 50).x);
    expect(xs[0]!).toBeGreaterThan(xs[1]!);
    expect(xs[1]!).toBeGreaterThan(xs[2]!);
    expect(built.pieces.some((piece) => /^helium:0:w2l\d+$/.test(piece.id))).toBe(false);
    expectClean(built);
  });

  test("a CJK cue with no spaces breaks into even rows at a readable size instead of shrinking", () => {
    const built = build(["今天我们来谈谈这个非常重要的问题:b"], { language: "zh" });
    const parts = built.pieces.filter((piece) => /^helium:0:w0l\d+$/.test(piece.id)) as { text: string; sizePx: number }[];
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.map((part) => part.text).join("")).toBe("今天我们来谈谈这个非常重要的问题");
    for (const part of parts) expect(part.sizePx).toBeGreaterThanOrEqual(160 * 0.62 - 0.5);
    expectClean(built);
  });

  test("mixed Latin and digits, accented Latin, and a long key word in SemiBold all fit, uncovered", () => {
    expectClean(build(["top:b 10:h@420 tips:b", "café:b déjà:b vu:h@400", "it's:m unbelievable:h@700"]));
    const { pieces } = build(["simply:m unstoppable:h@900"]);
    const letter = pieces.find((piece) => piece.id === "helium:0:w1l0") as { face: string };
    expect(letter.face).toBe("Fredoka SemiBold");
  });

  test("a word too long for the row breaks into the fewest even rows at 16:9, never below the floor", () => {
    const built = build(["contemporaneousness:h@900"], { input: { canvas: { width: 1920, height: 1080 } } });
    const parts = built.pieces.filter((piece) => /^helium:0:w0l\d+$/.test(piece.id)) as { text: string; sizePx: number }[];
    expect(parts.map((part) => part.text).join("")).toBe("CONTEMPORANEOUSNESS");
    for (const part of parts) expect(part.sizePx).toBeGreaterThanOrEqual(104 - 0.5);
    expectClean(built);
  });

  // --- wave 7 review findings ---

  test("entrance poses keep clear: no piece of one word (stack, band, shine) meets another word's on any frame of the rise, swell or nudge", () => {
    for (const built of [
      build(["just:b let:b it:m go:b", "your:m ideas:b deserve:b to:m fly:h@580", "keep:b rising:h@640", "the:m remote:b doesn't:h@600 work.:b"]),
      build(["और:m अगर:b इसे:m सीधा:h@400", "देखो:b तो:m इतना:h@380"], { language: "hi" }),
      build(["it's:b time:b to:m say:h@420", "does:b the:m remote:b"], { demo: { cueGap: 0, gap: 0, rate: 150 } }),
    ]) {
      const owner = /^helium:(\d+):w(\d+)/;
      for (const cue of built.cues) {
        const own = built.pieces.filter((piece) => owner.test(piece.id) && Number(owner.exec(piece.id)![1]) === cue.index);
        for (const t of exportFrameTimes(cue.startMs, cue.endMs, 30)) {
          const live = own.map((piece) => ({ w: Number(owner.exec(piece.id)![2]), box: pieceBounds(piece, t, built.input.measure) })).filter((item) => item.box !== null);
          for (const [i, a] of live.entries()) for (const b of live.slice(i + 1)) if (a.w !== b.w) expect(meets(a.box!, b.box!)).toBe(false);
        }
      }
    }
  });

  test("a word that paints on one frame keeps its dark keyline and base in its own face piece", () => {
    const { cues } = demoCues({ lines: ["go:b", "now:b", "fast:b", "yes:b", "no:b", "ok:b"], options: { rate: 70, gap: 0, cueGap: 0, tail: 40, lead: 100 } });
    let single = 0;
    for (const fps of [24, 25]) {
      const input = sceneInput(cues, { fps, colours });
      for (const face of heliumProgram.build(input).pieces.filter((piece) => FACE.test(piece.id))) {
        if (paintedFrameCount(face.fromMs, face.toMs, fps) >= 2) continue;
        single++;
        expect(face.kind === "text" && face.stroke && face.shadows?.length).toBeTruthy();
      }
    }
    expect(single).toBeGreaterThan(0);
  });

  test("colours keep 3:1 as drawn: face and the lighter key-word band against the dark base, for direct Studio greys", () => {
    for (const primary of ["#858585", "#666666", "#FFFFFF", "#2456F5"]) {
      const { pieces } = build(["keep:b rising:h@640", "go:b now:b", "yes:b"], { input: { colours: { ...colours, primary, highlight: primary, accent: primary } } });
      for (const piece of pieces.filter((piece) => /^helium:\d+:w\d+(l\d+)?(b)?$/.test(piece.id))) {
        const base = pieces.find((other) => other.id === `${piece.id.replace(/b$/, "")}s`) as { fill: string } | undefined;
        if (!base || piece.kind !== "text") continue;
        expect(captionColourContrast(piece.fill, base.fill)).toBeGreaterThanOrEqual(CAPTION_SCENE_BRAND_MIN_CONTRAST);
      }
    }
  });

  test("single-word cues hand off without a blank frame: the outgoing word lasts until the next cue's first paint", () => {
    const { cues, pieces } = build(["unstoppable:h@600", "rising:h@500", "go:b"], { demo: { cueGap: 0, gap: 0 } });
    for (const cue of cues.slice(0, -1)) {
      const own = pieces.filter((piece) => FACE.test(piece.id) && Number(piece.id.split(":")[1]) === cue.index);
      const next = Math.min(...pieces.filter((piece) => FACE.test(piece.id) && Number(piece.id.split(":")[1]) === cue.index + 1).map((piece) => piece.fromMs));
      for (const face of own) expect(face.toMs).toBe(next);
    }
  });

  test("long tokens hold the size floor after the fit (9:16 and 1:1, a 90-character CJK token) and a pathological one stays in budget", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }]) {
      const { pieces } = build(["contemporaneousness:b"], { input: { canvas } });
      const parts = pieces.filter((piece) => /^helium:0:w0l\d+$/.test(piece.id)) as { text: string; sizePx: number }[];
      expect(parts.map((part) => part.text).join("")).toBe("CONTEMPORANEOUSNESS");
      for (const part of parts) expect(part.sizePx).toBeGreaterThanOrEqual(160 * 0.62 - 0.5);
    }
    const cjk = "我们今天要讨论的是一个非常重要而且非常有意思的问题".repeat(4).slice(0, 90);
    const long = build([`${cjk}:b`], { language: "zh" });
    const parts = long.pieces.filter((piece) => /^helium:0:w0l\d+$/.test(piece.id)) as { text: string; sizePx: number }[];
    expect(parts.map((part) => part.text).join("")).toBe(cjk);
    for (const part of parts) expect(part.sizePx).toBeGreaterThanOrEqual(160 * 0.62 - 0.5);
    expectClean(long);
    const absurd = "x".repeat(400);
    const built = build([`${absurd}:b`, "ok:b"]);
    expect(built.pieces.filter((piece) => piece.id.startsWith("helium:0:")).length).toBeLessThanOrEqual(150);
    expect((built.pieces.filter((piece) => /^helium:0:w0l\d+$/.test(piece.id)) as { text: string }[]).map((part) => part.text).join("")).toBe(absurd.toUpperCase());
  });

  test("decorations move with their cue into a speaker lane: at 2x on 16:9 each cue's string and balloons stay with it, off the other cue", () => {
    const cue = (index: number, speaker: number, words: [string, number, number, "hero" | "body" | "minor"][]): SceneCue => ({
      index, speaker, language: "en", startMs: words[0]![1], endMs: words.at(-1)![2] + 400,
      words: words.map(([text, startMs, endMs, role]) => ({ text, startMs, endMs, role, key: null })),
    });
    const cues = [
      cue(0, 0, [["so", 300, 450, "minor"], ["I", 480, 600, "minor"], ["quit", 630, 1100, "hero"]]),
      cue(1, 1, [["wait,", 800, 1100, "body"], ["for", 1130, 1300, "minor"], ["real?", 1330, 1700, "hero"]]),
    ];
    const input = sceneInput(cues, { fps: 30, colours, canvas: { width: 1920, height: 1080 }, scale: 2 });
    const pieces = heliumProgram.build(input).pieces;
    for (const own of [0, 1]) {
      const decos = decorations(pieces, own);
      const mine = faces(pieces, own);
      const theirs = faces(pieces, 1 - own);
      for (const deco of decos) {
        for (const t of exportFrameTimes(deco.fromMs, deco.toMs, 30)) {
          const box = pieceBounds(deco, t, input.measure);
          if (!box) continue;
          for (const other of theirs) {
            const b = pieceBounds(other, t, input.measure);
            if (b) expect(meets(box, b)).toBe(false);
          }
          const near = mine.map((face) => pieceBounds(face, t, input.measure)).filter((b): b is Box => b !== null);
          if (near.length) expect(Math.min(...near.map((b) => Math.max(b.y1 - box.y2, box.y1 - b.y2, 0)))).toBeLessThan(120);
        }
      }
    }
  });
});
