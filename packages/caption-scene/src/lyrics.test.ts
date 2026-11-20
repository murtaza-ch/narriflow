import { describe, expect, test } from "bun:test";
import { demoCues } from "./demo";
import { EASES, lerp, prog } from "./ease";
import { LYRICS_DEMO, lyricsDotPop, lyricsProgram } from "./templates/lyrics";
import { evaluatePiece, type Piece, type ShapePiece, type TextPiece } from "./scene";
import { sceneInput } from "./test-support";

const { cues, duration } = demoCues(LYRICS_DEMO);
const scene = lyricsProgram.build(sceneInput(cues, { anchor: { xPct: 50, yPct: (1226 / 1920) * 100 } }));
const isText = (piece: Piece): piece is TextPiece => piece.kind === "text";
const texts = scene.pieces.filter(isText);
const dots = scene.pieces.filter((piece): piece is ShapePiece => piece.kind === "shape");
const layer = (cue: number, word: number, name: string) => texts.find((piece) => piece.id === `lyrics:${cue}:w${word}:${name}`)!;
/** The piece of a word that is drawn at `t` among its fill, its shadowless dim fill and its glows (a word's fill changes piece once its line has dimmed). */
const shown = (cue: number, word: number, t: number, names: string[]) => {
  const piece = texts.find((candidate) => names.some((name) => candidate.id === `lyrics:${cue}:w${word}:${name}`) && t >= candidate.fromMs && t < candidate.toMs);
  if (!piece) throw new Error(`nothing of cue ${cue} word ${word} at ${t}`);
  return evaluatePiece(piece, t);
};
const MOVE = 450;
const CUR_TOP = 1226;

describe("Lyrics", () => {
  test("four layers per word: base, feather and fill, plus a glow for the hero only", () => {
    const of = (cue: number, word: number) => texts.filter((piece) => piece.id.startsWith(`lyrics:${cue}:w${word}:`)).map((piece) => piece.id.split(":")[3]);
    expect(of(0, 0).sort()).toEqual(["base", "feather", "fill"]);
    expect(of(1, 2).sort()).toEqual(["base", "feather", "fill", "glow"]);
    expect(texts.filter((piece) => piece.id.endsWith(":glow")).map((piece) => piece.id)).toEqual(["lyrics:1:w2:glow", "lyrics:2:w4:glow", "lyrics:4:w0:glow"]);
  });

  test("the current line sits at the reading position, left aligned at x 96, and wraps at 880", () => {
    // Cue 1 is current from 1496 + 450 ms; "savings" wraps to the second row.
    const t = 2100;
    const with_ = evaluatePiece(layer(1, 0, "fill"), t);
    const savings = evaluatePiece(layer(1, 3, "base"), t);
    expect(with_.x).toBeCloseTo(96, 4);
    expect(savings.x).toBeCloseTo(96, 4);
    // The baseline of the first row is 0.9137 em under the line's top (line-height 1.1 and the face's ascent and descent); a word has lifted 4 px.
    const lineHeight = 92 * 1.1;
    // `with` is spoken and has lifted 4 px; `savings` is not.
    expect(savings.y - with_.y).toBeCloseTo(lineHeight + 4, 3);
    expect(with_.sx).toBeCloseTo(1, 6);
    expect(with_.o).toBeCloseTo(1, 6);
    expect(with_.blur).toBeCloseTo(0, 6);
  });

  test("the neighbours are the same text at 0.8 from the left edge, 34 px away, dim and blurred", () => {
    const t = 2100;
    const prevWord = shown(0, 0, t, ["fill"]);
    const nextWord = evaluatePiece(layer(2, 0, "base"), t);
    const curWord = evaluatePiece(layer(1, 0, "fill"), t);
    for (const pose of [prevWord, nextWord]) {
      expect(pose.sx).toBeCloseTo(0.8, 4);
      expect(pose.x).toBeCloseTo(96, 4);
      expect(pose.blur).toBeCloseTo(3 * 0.8, 3);
    }
    expect(prevWord.o).toBeCloseTo(0.3, 3);
    expect(nextWord.o).toBeCloseTo(0.3, 3);
    // Row tops: current at 1226 (two rows, 202 px), the next line 34 px under it, the previous line 34 px over it (one row at 0.8).
    // A first-row word's baseline is `firstBaseline` under its line's top, lifted 4 px once spoken (the next line's words have not been).
    const firstBaseline = curWord.y - CUR_TOP + 4;
    expect(nextWord.y).toBeCloseTo(CUR_TOP + 202 + 34 + 0.8 * firstBaseline, 1);
    expect(prevWord.y).toBeCloseTo(CUR_TOP - 34 - 0.8 * 101 + 0.8 * (firstBaseline - 4), 1);
  });

  test("a cue change moves the stack in 450 ms with outExpo, like the sample", () => {
    const at = 1616 - 120;
    for (const t of [at, at + 60, at + 150, at + 300, at + MOVE]) {
      const p = EASES.outExpo(prog(t, at, MOVE));
      // Cue 1 grows from the next slot (0.8) to current (1); cue 0 shrinks from current to previous.
      expect(evaluatePiece(layer(1, 0, "base"), t).sx).toBeCloseTo(lerp(0.8, 1, p), 2);
      expect(shown(0, 0, t, ["fill"]).sx).toBeCloseTo(lerp(1, 0.8, p), 2);
      // The base is the cue's opacity times its own (1 waiting, 0.38 when current).
      expect(evaluatePiece(layer(1, 0, "base"), t).o).toBeCloseTo(lerp(0.3, 1, p) * lerp(1, 0.38, p), 1);
    }
  });

  test("each word fills left to right over its own spoken time, with a half-bright feather 20 px ahead", () => {
    const word = cues[1]!.words[1]!; // literally
    const fill = layer(1, 1, "fill");
    const feather = layer(1, 1, "feather");
    const mid = (word.startMs + word.endMs) / 2;
    const left = evaluatePiece(fill, mid).x;
    // The wipe's edge runs from -20 px at the word's start to its width at the end; the feather's is 20 px ahead.
    const fillEdge = evaluatePiece(fill, mid).clip!.x2 - left;
    const featherEdge = evaluatePiece(feather, mid).clip!.x2 - left;
    expect(featherEdge - fillEdge).toBeCloseTo(20, 1);
    // Linear in time.
    const a = evaluatePiece(fill, word.startMs + (word.endMs - word.startMs) * 0.4).clip!.x2;
    const b = evaluatePiece(fill, word.startMs + (word.endMs - word.startMs) * 0.8).clip!.x2;
    const c = evaluatePiece(fill, word.startMs + (word.endMs - word.startMs) * 0.6).clip!.x2;
    expect(c - a).toBeCloseTo((b - a) / 2, 1);
    expect(feather.fill).toBe("#FFFFFF");
    expect(evaluatePiece(feather, mid).o).toBeCloseTo(0.5, 6);
  });

  test("an unspoken word is the dim base at 0.38; the base leaves when the word is complete", () => {
    const word = cues[1]!.words[3]!; // savings
    const base = layer(1, 3, "base");
    expect(evaluatePiece(base, 2100).o).toBeCloseTo(0.38, 3);
    expect(base.toMs).toBe(word.endMs);
    // A line that is only waiting (the next one) shows the base at the neighbour's 0.3.
    expect(evaluatePiece(layer(2, 1, "base"), 2100).o).toBeCloseTo(0.3, 3);
  });

  test("a word lifts 4 px as it is spoken, over 260 ms, and stays lifted", () => {
    const word = cues[1]!.words[3]!; // current and settled at its start
    const fill = layer(1, 3, "fill");
    const base = layer(1, 3, "base");
    const rest = evaluatePiece(base, word.startMs - 1).y;
    expect(evaluatePiece(base, word.startMs - 1).y).toBeCloseTo(rest, 6);
    expect(evaluatePiece(base, word.startMs + 260 - 1).y - rest).toBeCloseTo(-4 * EASES.out(prog(word.startMs + 259, word.startMs, 260)), 1);
    expect(evaluatePiece(fill, word.endMs - 12).y - rest).toBeCloseTo(-4, 1);
  });

  test("the hero fills in the highlight colour, without the dark shadow, and glows once filled", () => {
    const zero = cues[1]!.words[2]!;
    const fill = layer(1, 2, "fill");
    const glow = layer(1, 2, "glow");
    expect(fill.fill).toBe("#FFE9A8");
    expect(fill.shadows).toBeUndefined();
    expect(layer(1, 0, "fill").shadows).toHaveLength(2);
    expect(layer(1, 0, "base").shadows).toHaveLength(2);
    expect(layer(1, 2, "base").fill).toBe("#FFFFFF");
    expect(glow.shadows).toHaveLength(2);
    expect(evaluatePiece(glow, zero.endMs - 120).o).toBeCloseTo(0, 3);
    expect(evaluatePiece(glow, zero.endMs - 120 + 420).o).toBeCloseTo(0.85, 2);
  });

  test("breathing dots appear only for the one pause longer than 700 ms, between cues 2 and 3", () => {
    expect(dots.map((dot) => dot.id)).toEqual(["lyrics:2:dot0", "lyrics:2:dot1", "lyrics:2:dot2"]);
    const lastEnd = cues[2]!.words[4]!.endMs;
    const nextStart = cues[3]!.startMs;
    expect(nextStart - lastEnd).toBeGreaterThan(700);
    expect(dots[0]!.fromMs).toBe(lastEnd + 160 + 1);
    // They grow into the current slot (scale 0 to 1, 450 ms) and the last cue waits dimmed above.
    expect(evaluatePiece(dots[1]!, lastEnd + 160 + MOVE + 5).sx).toBeGreaterThan(0.8);
    expect(evaluatePiece(dots[1]!, lastEnd + 160 + 2).sx).toBeLessThan(0.1);
    const dotsStart = lastEnd + 160;
    expect(shown(2, 0, dotsStart + MOVE + 10, ["fill"]).sx).toBeCloseTo(0.8, 2);
    expect(shown(2, 0, dotsStart + MOVE + 10, ["fill"]).o).toBeCloseTo(0.3, 2);
  });

  test("the dots swell one after another over the pause", () => {
    const first = cues[2]!.words[4]!.endMs + 160;
    const to = cues[3]!.startMs - 120;
    const step = (to - first - 260) / 3;
    const a = first + 160;
    // Dot 0 is dim until its turn, full brightness when its fill completes; dot 2 is still waiting.
    const t = a + step;
    expect(evaluatePiece(dots[0]!, t).o).toBeCloseTo(1, 1);
    expect(evaluatePiece(dots[2]!, t).o).toBeCloseTo(0.4, 1);
    expect(lyricsDotPop(a, a, step)).toBe(0.82);
    expect(lyricsDotPop(a + step * 0.55, a, step)).toBeCloseTo(1.16, 6);
    expect(lyricsDotPop(a + step, a, step)).toBeCloseTo(1, 6);
    // Before the pause ends the whole trio swells to 1.14.
    expect(evaluatePiece(dots[1]!, to - 40).sx).toBeGreaterThan(evaluatePiece(dots[1]!, to - 300).sx);
  });

  test("the sample's two shadows are kept: under the spoken fill and under the unspoken ghost, none under the hero", () => {
    for (const [cue, word] of [[0, 0], [1, 0], [1, 3]] as const) {
      expect(layer(cue, word, "fill").shadows).toHaveLength(2);
      expect(layer(cue, word, "base").shadows).toHaveLength(2);
    }
    expect(layer(1, 2, "glow").shadows).toHaveLength(2);
    expect(layer(1, 2, "glow").shadows!.map((shadow) => shadow.blur)).toEqual([13, 30]);
  });

  test("a move lands exactly on its end: the rest of a line is steady, not a drift", () => {
    // Cue 0 is dim from 1946 on; 3032 is the next move. Nothing about it changes in between.
    const word = layer(0, 1, "fill");
    const a = evaluatePiece(word, 2000);
    const b = evaluatePiece(word, 3000);
    for (const key of ["x", "y", "sx", "o", "blur"] as const) expect(b[key]).toBe(a[key]);
  });

  test("a shadowed piece is clipped to its ink plus the reach past which its shadows are under one 8-bit step", () => {
    const fill = layer(1, 0, "fill");
    const pose = evaluatePiece(fill, 2100);
    const reach = (pose.clip!.y2 - pose.clip!.y1) - (0.72 + 0.2) * fill.sizePx;
    // Full strength: 2.4 to 2.6 sigma of the 9 px shadow, a few px of offset, each side.
    expect(reach).toBeGreaterThan(30);
    expect(reach).toBeLessThan(60);
    // Fainter, the reach is shorter.
    const dimmed = evaluatePiece(fill, 4500);
    expect(dimmed.clip!.y2 - dimmed.clip!.y1).toBeLessThan(pose.clip!.y2 - pose.clip!.y1);
  });

  test("the whole stack fades in over the first 280 ms and out over the last 320", () => {
    const first = layer(0, 0, "base");
    // A piece shows from the first ms its opacity reaches 3 %: nothing is drawn while it cannot be seen.
    expect(first.fromMs).toBeLessThan(40);
    expect(evaluatePiece(first, 140).o).toBeCloseTo(0.5 * 0.38, 2);
    const last = cues.length - 1;
    const lastFill = layer(last, 0, "fill");
    expect(evaluatePiece(lastFill, duration - 320 - 10).o).toBeCloseTo(1, 2);
    expect(evaluatePiece(lastFill, duration - 160).o).toBeCloseTo(0.5, 1);
    expect(lastFill.toMs).toBeGreaterThan(duration - 40);
  });

  test("a cue change that starts before the last move finished continues from where the stack is", () => {
    const quick = demoCues({ lines: ["go:b@120", "now:b@120", "stop:b@120", "here:b@120"], options: { cueGap: 20, gap: 10, lead: 300 } });
    const built = lyricsProgram.build(sceneInput(quick.cues));
    const pieces = built.pieces.filter(isText);
    for (const piece of pieces) {
      let previous = evaluatePiece(piece, Math.max(piece.fromMs, 0) + 1);
      for (let t = piece.fromMs + 2; t < piece.toMs; t += 4) {
        const pose = evaluatePiece(piece, t);
        // The sample would jump by tens of px where a move is cut short; here the stack never steps.
        expect(Math.abs(pose.y - previous.y)).toBeLessThan(40);
        expect(Math.abs(pose.sx - previous.sx)).toBeLessThan(0.08);
        previous = pose;
      }
    }
  });

  test("a word wider than a row shrinks its cue; right-to-left cues are flush right", () => {
    const wide = demoCues({ lines: ["so:m antidisestablishmentarianism-and-pneumonoultramicroscopic:b", "short:b one:b"] });
    const built = lyricsProgram.build(sceneInput(wide.cues));
    const sizes = built.pieces.filter(isText).filter((piece) => piece.id.startsWith("lyrics:0:")).map((piece) => piece.sizePx);
    expect(Math.max(...sizes)).toBeLessThan(92);
    expect(built.pieces.filter(isText).filter((piece) => piece.id.startsWith("lyrics:1:")).every((piece) => piece.sizePx === 92)).toBe(true);
    const urdu = demoCues({ lines: ["یہ:m بہت:b اچھا:h@600 ہے:m", "میں نے آج سیکھا:b"], language: "ur" });
    const rtl = lyricsProgram.build(sceneInput(urdu.cues));
    const first = rtl.pieces.filter(isText).filter((piece) => piece.id.startsWith("lyrics:0:") && piece.id.endsWith(":fill"));
    // The first word is the rightmost one.
    const xs = first.map((piece) => evaluatePiece(piece, 1500).x);
    expect(xs[0]!).toBeGreaterThan(xs[xs.length - 1]!);
    // A right-to-left word fills from its right edge: the clip's left edge travels left, its right edge stays out of the way.
    const word = urdu.cues[0]!.words[1]!;
    const fill = first[1]!;
    const early = evaluatePiece(fill, word.startMs + (word.endMs - word.startMs) * 0.3).clip!;
    const late = evaluatePiece(fill, word.startMs + (word.endMs - word.startMs) * 0.7).clip!;
    expect(late.x1).toBeLessThan(early.x1);
    expect(early.x2).toBe(late.x2);
  });
});
