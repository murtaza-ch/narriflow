import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, kf, lerp, prog } from "./ease";
import { type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { pathBounds } from "./shapes";
import { fakeMeasure, sceneInput } from "./test-support";
import { WORDFORM_DEMO, wordformHash, wordformProgram } from "./templates/wordform";

const { cues } = demoCues(WORDFORM_DEMO);
// Default Wordform position: the sample's anchor line, so the scene is laid out in the sample's own coordinates.
const input = sceneInput(cues, { anchor: { xPct: 50, yPct: (1330 / 1920) * 100 } });
const scene = wordformProgram.build(input);
const bars = (cue: number) => scene.pieces.filter((piece): piece is ShapePiece => piece.kind === "shape" && new RegExp(`^wordform:${cue}:bar\\d+$`).test(piece.id));
const playhead = (cue: number) => scene.pieces.find((piece) => piece.id === `wordform:${cue}:playhead`) as ShapePiece;
const words = (cue: number) => scene.pieces.filter((piece): piece is TextPiece => piece.kind === "text" && piece.id.startsWith(`wordform:${cue}:`));
const barIndex = (piece: { id: string }) => Number(piece.id.split(":bar")[1]);

// The sample's own numbers, written out again so the tests are not the implementation.
const N = 42;
const PITCH = 18;
const X0 = 540 - ((N - 1) * PITCH) / 2;
const S = 64;
const ROLE_H = { minor: 0.46 * S, body: 0.82 * S, hero: 1.28 * S };
const barHeight = (piece: ShapePiece) => {
  const box = pathBounds(piece.path);
  return box.y2 - box.y1;
};
const sampleRole = (cueNumber: number, i: number) => {
  const cue = cues[cueNumber]!;
  const ti = cue.startMs + ((i + 0.5) / N) * (cue.endMs - cue.startMs);
  const spans = cue.words.map((word, at) => {
    const next = cue.words[at + 1];
    return { word, from: word.startMs, to: next && next.startMs - word.endMs < 140 ? next.startMs : word.endMs };
  });
  const span = spans.find((s) => ti >= s.from && ti < s.to);
  return { ti, span };
};
const sampleScale = (cueNumber: number, i: number, t: number) => {
  const cue = cues[cueNumber]!;
  const { ti, span } = sampleRole(cueNumber, i);
  const grow = EASES.out(prog(t, cue.startMs - 120 + i * 4, 240));
  const fold = EASES.in(prog(t, cue.endMs - 200 + (N - 1 - i) * 1.6, 110));
  const pulse = span
    ? kf(t, [
        [ti - 30, 1],
        [ti + 50, 1.22, "out"],
        [ti + 190, 1, "in"],
      ])
    : 1;
  return grow * (1 - fold) * pulse;
};

describe("Wordform", () => {
  test("every cue is 42 bars, a playhead and a piece per word", () => {
    for (const cue of cues) {
      expect(bars(cue.index)).toHaveLength(N);
      expect(playhead(cue.index)).toBeDefined();
      expect(words(cue.index)).toHaveLength(cue.words.length);
    }
  });

  test("bars stand every 18 px, centred on the anchor, 9 px wide with round ends", () => {
    for (const bar of bars(0)) {
      const i = barIndex(bar);
      expect(evaluatePiece(bar, bar.fromMs + 5).x).toBeCloseTo(X0 + i * PITCH, 6);
      expect(evaluatePiece(bar, bar.fromMs + 5).y).toBeCloseTo(1404, 6);
      const box = pathBounds(bar.path);
      expect(box.x2 - box.x1).toBeCloseTo(9, 6);
    }
    // A bar scales about its own centre, and is drawn from its top-left, so scaling it moves nothing in libass.
    const bar = bars(0)[3]!;
    expect(bar.origin!.dx).toBeCloseTo(4.5, 6);
    expect(bar.origin!.dy).toBeCloseTo(barHeight(bar) / 2, 6);
    expect(pathBounds(bar.path).x1).toBe(0);
  });

  test("a bar's height is the sample's: role, weight and a deterministic hash; a breath is a dot", () => {
    for (const cue of cues) {
      for (const bar of bars(cue.index)) {
        const i = barIndex(bar);
        const { span } = sampleRole(cue.index, i);
        const expected = span ? Math.max(12, ROLE_H[span.word.role] * lerp(0.7, 1.15, wordformHash(`${span.word.text}:${cue.index}:${i}`))) : 8;
        expect(barHeight(bar)).toBeCloseTo(expected, 6);
      }
    }
    // The sample's second cue pauses 790 ms before its hero: the bars under that gap are dots.
    const dots = bars(1).filter((bar) => barHeight(bar) === 8);
    expect(dots.length).toBeGreaterThan(10);
    for (const dot of dots) expect(sampleRole(1, barIndex(dot)).span).toBeUndefined();
  });

  test("hero bars take the highlight colour, the rest the primary", () => {
    for (const bar of bars(0)) {
      const { span } = sampleRole(0, barIndex(bar));
      expect(bar.fill!.colour).toBe(span?.word.role === "hero" ? "#FFE9A8" : "#FFFFFF");
    }
  });

  test("the hash is the sample's, spread over [0, 1)", () => {
    const values = ["tired:0:3", "tired:0:4", "breathe:3:30"].map(wordformHash);
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(new Set(values).size).toBe(3);
    expect(wordformHash("")).toBeCloseTo((2166136261 % 10007) / 10007, 9);
  });

  test("a bar's scale follows grow x pulse x fold as the sample's formula, at many times", () => {
    for (const cueNumber of [0, 1, 3]) {
      const cue = cues[cueNumber]!;
      for (const bar of bars(cueNumber)) {
        const i = barIndex(bar);
        const { ti } = sampleRole(cueNumber, i);
        for (const t of [cue.startMs - 100, cue.startMs, cue.startMs + 150, ti - 30, ti + 20, ti + 50, ti + 120, ti + 190, cue.endMs - 190, cue.endMs - 120, cue.endMs - 60]) {
          if (t < bar.fromMs || t >= bar.toMs) continue;
          // The scale is the pose's, read as the piece's own height ratio.
          expect(Math.abs(evaluatePiece(bar, t).sy - sampleScale(cueNumber, i, t))).toBeLessThan(0.012);
        }
      }
    }
  });

  test("a bar is dim until the playhead reaches it, then lit over 60 ms", () => {
    for (const bar of bars(0)) {
      const { ti } = sampleRole(0, barIndex(bar));
      for (const t of [ti - 60, ti - 30, ti, ti + 30, ti + 100]) {
        if (t < bar.fromMs || t >= bar.toMs) continue;
        expect(evaluatePiece(bar, t).o).toBeCloseTo(lerp(0.28, 1, prog(t, ti - 30, 60)), 6);
      }
    }
  });

  test("the strip grows left to right from 120 ms before the cue and folds right to left before it ends", () => {
    const cue = cues[1]!;
    const all = bars(1);
    expect(all[0]!.fromMs).toBe(cue.startMs - 120 + 4);
    expect(all[N - 1]!.fromMs).toBe(cue.startMs - 120 + (N - 1) * 4 + 4);
    // Folding: the last bar goes first.
    expect(all[N - 1]!.toMs).toBeLessThan(all[0]!.toMs);
    for (const bar of all) expect(bar.toMs).toBeLessThanOrEqual(cue.endMs);
  });

  test("the playhead rides the cue's time axis, left to right, across the strip", () => {
    const head = playhead(0);
    const cue = cues[0]!;
    expect(evaluatePiece(head, cue.startMs).x).toBeCloseTo(X0 - PITCH / 2, 6);
    expect(evaluatePiece(head, (cue.startMs + cue.endMs) / 2).x).toBeCloseTo(540, 3);
    expect(evaluatePiece(head, cue.endMs - 100).x).toBeCloseTo(X0 - PITCH / 2 + (N * PITCH * (cue.endMs - 100 - cue.startMs)) / (cue.endMs - cue.startMs), 3);
    const box = pathBounds(head.path);
    expect(box.x2 - box.x1).toBeCloseTo(3, 6);
    expect(box.y2 - box.y1).toBeCloseTo(1.7 * S, 6);
    // It appears with the strip and leaves with it.
    const show = (t: number) => EASES.out(prog(t, cue.startMs - 60, 160)) * (1 - EASES.in(prog(t, cue.endMs - 200, 120)));
    for (const t of [cue.startMs - 40, cue.startMs + 20, cue.startMs + 100, cue.endMs - 150, cue.endMs - 100]) {
      expect(evaluatePiece(head, t).sy).toBeCloseTo(show(t), 2);
      expect(evaluatePiece(head, t).o).toBeCloseTo(0.9 * show(t), 2);
    }
  });

  test("words sit on baselines the sample's way: hero rows on 1253, two rows a line apart, last row biggest-word based", () => {
    const baseline = (piece: TextPiece) => evaluatePiece(piece, piece.fromMs + 1).y - (piece.origin?.dy ?? 0);
    // "most of us aren't TIRED": one row, the hero's 90 px box fixes the baseline at 1170.2 + 83.
    const first = words(0);
    for (const piece of first) expect(baseline(piece)).toBeCloseTo(1253.19, 1);
    // "so put your / phone down tonight": two body rows 75.52 apart, the last baseline at 1258.2.
    const two = words(2);
    expect(baseline(two[0]!)).toBeCloseTo(1182.72, 1);
    expect(baseline(two[3]!)).toBeCloseTo(1258.23, 1);
    for (const piece of two.slice(0, 3)) expect(baseline(piece)).toBeCloseTo(baseline(two[0]!), 6);
  });

  test("faces, sizes and spacing: Inter SemiBold 64 / -0.02 em, the hero Bricolage 90 / -0.03 em in the highlight colour", () => {
    const tired = words(0).find((piece) => piece.text === "tired")!;
    const most = words(0).find((piece) => piece.text === "most")!;
    expect(tired).toMatchObject({ face: "Bricolage Grotesque", sizePx: 90, letterSpacingEm: -0.03, fill: "#FFE9A8" });
    expect(most).toMatchObject({ face: "Inter SemiBold", sizePx: 64, letterSpacingEm: -0.02, fill: "#FFFFFF" });
    expect(most.shadows).toHaveLength(2);
    expect(most.shadows![1]).toMatchObject({ dy: 6, blur: 10, alpha: 0.5 });
  });

  test("a word fades in over 100 ms from 70 ms before it is spoken, out of a blur that is 6 % of its size", () => {
    const cue = cues[0]!;
    for (const piece of words(0)) {
      const word = cue.words[Number(piece.id.split(":w")[1])]!;
      const hero = piece.sizePx > 64;
      for (const t of [word.startMs - 70, word.startMs - 20, word.startMs + 30, word.startMs + 80, word.startMs + 200, cue.endMs - 190, cue.endMs - 120, cue.endMs - 70]) {
        if (t < piece.fromMs || t > piece.toMs) continue;
        const pose = evaluatePiece(piece, t);
        const exit = EASES.in(prog(t, cue.endMs - 190, 130));
        expect(pose.o).toBeCloseTo(prog(t, word.startMs - 70, 100) * (1 - exit), 3);
        expect(pose.blur).toBeCloseTo((1 - EASES.out(prog(t, word.startMs - 70, 150))) * 0.06 * piece.sizePx, 3);
        expect(pose.sx).toBeCloseTo(hero ? lerp(1.06, 1, EASES.out(prog(t, word.startMs - 70, 180))) : 1, 4);
      }
    }
  });

  test("a hero word shrinks 6 % about the point 70 % down its line box", () => {
    const tired = words(0).find((piece) => piece.text === "tired")!;
    // pivot minus the baseline-left anchor: half the box wide, 0.7 of the 1.18 line box (less the baseline's 83 px) below the box top.
    expect(tired.origin!.dy).toBeCloseTo(0.7 * 1.18 * 90 - (83 / 90) * 90, 6);
    expect(evaluatePiece(tired, 1618 - 70).sx).toBeCloseTo(1.06, 6);
  });

  test("a right-to-left cue runs its words, strip and playhead from the right", () => {
    const urdu = sceneEdgeDemo("urdu").cues;
    const rtl = wordformProgram.build(sceneInput(urdu, { anchor: { xPct: 50, yPct: (1330 / 1920) * 100 } }));
    const bar = (i: number) => rtl.pieces.find((piece) => piece.id === `wordform:0:bar${i}`)!;
    expect(evaluatePiece(bar(0), bar(0).fromMs + 5).x).toBeGreaterThan(evaluatePiece(bar(N - 1), bar(N - 1).fromMs + 5).x);
    const head = rtl.pieces.find((piece) => piece.id === "wordform:0:playhead")!;
    expect(evaluatePiece(head, urdu[0]!.startMs).x).toBeGreaterThan(evaluatePiece(head, urdu[0]!.endMs - 100).x);
    // First word of the cue sits to the right of the last.
    const urduWords = rtl.pieces.filter((piece): piece is TextPiece => piece.kind === "text" && piece.id.startsWith("wordform:0:"));
    const x = (index: number) => evaluatePiece(urduWords.find((piece) => piece.id.endsWith(`:w${index}`))!, urdu[0]!.endMs - 300).x;
    expect(x(0)).toBeGreaterThan(x(urdu[0]!.words.length - 1));
  });

  test("nine words wrap into rows that fit; a word wider than a row shrinks the cue; nothing leaves the safe area", () => {
    for (const kind of ["nine-words", "long-word"] as const) {
      const edge = sceneEdgeDemo(kind).cues;
      const out = wordformProgram.build(sceneInput(edge, { anchor: { xPct: 50, yPct: (1330 / 1920) * 100 } }));
      for (let t = 400; t < 4000; t += 100) {
        const box = sceneBoundsAt(out.pieces, t, fakeMeasure);
        if (!box) continue;
        expect(box.x1).toBeGreaterThanOrEqual(54 - 1);
        expect(box.x2).toBeLessThanOrEqual(1026 + 1);
      }
    }
    const nine = wordformProgram.build(sceneInput(sceneEdgeDemo("nine-words").cues, { anchor: { xPct: 50, yPct: (1330 / 1920) * 100 } }));
    const rows = new Set(nine.pieces.filter((piece): piece is TextPiece => piece.kind === "text" && piece.id.startsWith("wordform:0:")).map((piece) => Math.round(evaluatePiece(piece, 3300).y)));
    expect(rows.size).toBeGreaterThanOrEqual(2);
    const long = wordformProgram.build(sceneInput(sceneEdgeDemo("long-word").cues, { anchor: { xPct: 50, yPct: (1330 / 1920) * 100 } }));
    const longText = long.pieces.find((piece): piece is TextPiece => piece.kind === "text" && piece.text.startsWith("pneumono"))!;
    expect(longText.sizePx).toBeLessThan(64);
  });

  test("a cue stays well inside the piece budget even at nine words", () => {
    const nine = wordformProgram.build(sceneInput(sceneEdgeDemo("nine-words").cues, { anchor: { xPct: 50, yPct: (1330 / 1920) * 100 } }));
    const count = nine.pieces.filter((piece) => piece.id.startsWith("wordform:0:")).reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0), 0);
    expect(count).toBeLessThanOrEqual(150);
    // A bar is one piece (no shadow, see the template), a playhead one, a word three (fill and two shadows).
    expect(count).toBe(N + 1 + 9 * 3);
  });
});
