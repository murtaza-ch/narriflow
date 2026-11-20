import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { SIGNAL_DEMO, signalProgram, signalSplitPx, signalTyped } from "./templates/signal";
import { evaluatePiece, type Piece, type ShapePiece, type TextPiece } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";

const { cues } = demoCues(SIGNAL_DEMO);
const input = sceneInput(cues, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: { primary: "#D8FFE9", highlight: "#FFFFFF", accent: "#39FF9C", shadow: "#000000" } });
const scene = signalProgram.build(input);
const cueNo = (piece: Piece) => Number(piece.id.split(":")[1]);
const of = (cue: number, name: string) => scene.pieces.find((piece) => piece.id === `signal:${cue}:${name}`);
const text = (cue: number, name: string) => of(cue, name) as TextPiece;
const shape = (cue: number, name: string) => of(cue, name) as ShapePiece;
const at = (piece: Piece | undefined, t: number) => evaluatePiece(piece!, t);

describe("Signal geometry", () => {
  test("a cue with a hero has typed words, a cursor, seven hero pieces, four brackets, a scan line, a counter and a line", () => {
    const ids = scene.pieces.filter((piece) => cueNo(piece) === 1).map((piece) => piece.id.split(":")[2]);
    expect(ids.sort()).toEqual(
      ["bracket0", "bracket1", "bracket2", "bracket3", "counter", "cursor", "cyan", "line", "magenta", "scan", "sliceA", "sliceB", "w0", "w1", "w2", "w3", "white", "whiteMid", "whiteOut"].sort(),
    );
    // A cue without a hero is the typed line and its cursor alone.
    expect(scene.pieces.filter((piece) => cueNo(piece) === 0).map((piece) => piece.id.split(":")[2]).sort()).toEqual(["cursor", "w0", "w1", "w2"]);
  });

  test("support words are mono, lowercase-as-given, 52 px under a hero and 64 px alone, in the primary colour", () => {
    expect(text(1, "w0")).toMatchObject({ face: "JetBrains Mono Medium", sizePx: 52, fill: "#D8FFE9", text: "the" });
    expect(text(0, "w0").sizePx).toBe(64);
  });

  test("the line is one monospaced row centred on its final width: cells of one advance, the sample's rounded left edge", () => {
    const cell = fakeMeasure("0", "JetBrains Mono Medium", 64, 0).advance;
    const w = [0, 1, 2].map((index) => text(0, `w${index}`));
    const left = (piece: TextPiece) => evaluatePiece(piece, piece.fromMs).x - (piece.origin?.dx ?? 0);
    // "stop memorizing syntax." is 23 cells: the row starts at round(540 - 23 * cell / 2).
    expect(left(w[0]!)).toBeCloseTo(Math.round(540 - (23 * cell) / 2), 6);
    expect(left(w[1]!) - left(w[0]!)).toBeCloseTo(5 * cell, 6);
    expect(left(w[2]!) - left(w[1]!)).toBeCloseTo(11 * cell, 6);
  });

  test("the hero is Chakra Petch caps in the highlight colour, 190 px, with a fixed baseline 0.8368 em under its line box", () => {
    const hero = text(1, "white");
    expect(hero).toMatchObject({ face: "Chakra Petch", text: "TASTE", sizePx: 190, fill: "#FFFFFF", letterSpacingEm: 0.01 });
    // Cap box centre HERO_Y 1340, line box top = 1340 - 0.5175 em; the baseline is 0.3193 em under the centre.
    expect(at(hero, hero.fromMs + 10).y - (hero.origin?.dy ?? 0)).toBeCloseTo(1340 + 0.3193 * 190, 1);
    expect(text(1, "cyan").fill).toBe("#00F0FF");
    expect(text(1, "magenta").fill).toBe("#FF2BD6");
  });

  test("the brackets enclose the cap box with a 26 px inset, arms 46 px, strokes 5 px", () => {
    const corners = [0, 1, 2, 3].map((index) => shape(1, `bracket${index}`));
    const rest = (piece: ShapePiece) => at(piece, 3600);
    const hero = text(1, "white");
    const width = fakeMeasure("TASTE", "Chakra Petch", 190, 0.01).advance + 0.01 * 190;
    const capH = 0.705 * 190;
    const xs = corners.map((piece) => rest(piece).x);
    const ys = corners.map((piece) => rest(piece).y);
    // Pivots are the corner nodes' centres, 23 px inside the corner.
    expect(xs[0]!).toBeCloseTo(540 - width / 2 - 26 + 23, 4);
    expect(xs[1]!).toBeCloseTo(540 + width / 2 + 26 - 23, 4);
    expect(ys[0]!).toBeCloseTo(1340 - capH / 2 - 26 + 23, 4);
    expect(ys[2]!).toBeCloseTo(1340 + capH / 2 + 26 - 23, 4);
    // The hero is live from 30 ms before its word; the white copy takes over from the slices 90 ms later.
    expect(text(1, "cyan").fromMs).toBe(cues[1]!.words[4]!.startMs - 30);
    expect(hero.fromMs).toBe(cues[1]!.words[4]!.startMs + 60);
    // An L: the polygon spans the arm in both directions and is a stroke thick.
    const xsPath = corners[0]!.path.flatMap((command) => (command[0] === "Z" ? [] : [command[1]]));
    expect(Math.max(...xsPath) - Math.min(...xsPath)).toBe(46);
  });

  test("the counter reads the cue number over the total, above the top-left bracket", () => {
    expect(text(1, "counter").text).toBe("02/04");
    expect(text(3, "counter").text).toBe("04/04");
    expect(text(1, "counter")).toMatchObject({ face: "JetBrains Mono Medium", sizePx: 28, letterSpacingEm: 0.04 });
  });
});

describe("Signal motion", () => {
  const hero = cues[1]!.words[4]!;
  const lead = hero.startMs - 30;

  test("the split steps 16, -9, 5 every 45 ms, then a 3 px fringe, exactly as the sample", () => {
    expect([0, 44, 45, 89, 90, 134, 135, 400].map(signalSplitPx)).toEqual([16, 16, -9, -9, 5, 5, 3, 3]);
    expect(signalSplitPx(-1)).toBe(0);
    const cyan = text(1, "cyan");
    const magenta = text(1, "magenta");
    for (const dt of [0, 20, 44, 45, 70, 89, 90, 120, 134, 135, 300, 500]) {
      expect(at(cyan, lead + dt).x).toBeCloseTo(540 - signalSplitPx(dt), 6);
      expect(at(magenta, lead + dt).x).toBeCloseTo(540 + signalSplitPx(dt), 6);
    }
  });

  test("two slices are thrown sideways for 90 ms (26, then -18 and -26, then 14), and the white copy has holes where they are", () => {
    const a = text(1, "sliceA");
    const b = text(1, "sliceB");
    expect(at(a, lead + 10).x).toBeCloseTo(540 + 26, 6);
    expect(at(b, lead + 10).x).toBeCloseTo(540 - 26, 6);
    expect(at(a, lead + 60).x).toBeCloseTo(540 - 18, 6);
    expect(at(b, lead + 60).x).toBeCloseTo(540 + 14, 6);
    expect(at(a, lead + 89).visible).toBe(true);
    expect(at(a, lead + 90).visible).toBe(false);
    expect(at(text(1, "whiteOut"), lead + 89).visible).toBe(true);
    expect(at(text(1, "whiteOut"), lead + 90).visible).toBe(false);
    expect(at(text(1, "white"), lead + 89).visible).toBe(false);
    expect(at(text(1, "white"), lead + 90).visible).toBe(true);
    // The two bands sit inside the white copy's hole and between them is the middle part.
    const out = at(text(1, "whiteOut"), lead + 10).clip!;
    const mid = at(text(1, "whiteMid"), lead + 10).clip!;
    const bandA = at(a, lead + 10).clip!;
    const bandB = at(b, lead + 10).clip!;
    expect(out.inverse).toBe(true);
    expect(out.y1).toBeCloseTo(bandA.y1, 6);
    expect(out.y2).toBeCloseTo(bandB.y2, 6);
    expect(mid.y1).toBeCloseTo(bandA.y2, 6);
    expect(mid.y2).toBeCloseTo(bandB.y1, 6);
    expect(bandA.y2).toBeLessThan(bandB.y1);
  });

  test("the glitch is a time-sampled step, never eased: a value between two frames never leaves the two step values", () => {
    const cyan = text(1, "cyan");
    for (let t = lead; t < lead + 200; t += 1) {
      const x = at(cyan, t).x;
      // Only the 1 ms ramp into a step may sit between two values.
      const near = [16, -9, 5, 3].some((d) => Math.abs(x - (540 - d)) < 1e-6);
      const edge = [45, 90, 135].some((dt) => Math.abs(t - (lead + dt)) <= 1);
      expect(near || edge).toBe(true);
    }
  });

  test("brackets start 44 px outside and snap on in 160 ms (outExpo), then collapse with the cue", () => {
    const tl = shape(1, "bracket0");
    const rest = at(tl, 3600);
    expect(at(tl, lead).x).toBeCloseTo(rest.x - 44, 6);
    expect(at(tl, lead).y).toBeCloseTo(rest.y - 44, 6);
    expect(at(tl, lead + 160).x).toBeCloseTo(rest.x, 6);
    const p = 40 / 160;
    expect(at(tl, lead + 40).x).toBeCloseTo(rest.x - 44 * (1 - (1 - 2 ** (-10 * p))), 3);
    const end = cues[1]!.endMs;
    expect(at(tl, end - 190).o).toBe(1);
    expect(at(tl, end - 80 - 1).o).toBeLessThan(0.01);
  });

  test("one scanline pass top to bottom in 320 ms, 40 ms after the hero starts", () => {
    const scan = shape(1, "scan");
    const bracket = (index: number) => at(shape(1, `bracket${index}`), 3600);
    const top = bracket(0).y - 23;
    const bottom = bracket(2).y + 23;
    expect(at(scan, hero.startMs + 40).y).toBeCloseTo(top + 1, 4);
    expect(at(scan, hero.startMs + 200).y).toBeCloseTo(top + 1 + (bottom - top) / 2, 4);
    expect(at(scan, hero.startMs + 359).visible).toBe(true);
    expect(at(scan, hero.startMs + 360).visible).toBe(false);
    expect(at(scan, hero.startMs + 40).visible).toBe(false);
  });

  test("the hero collapses to a 4 px line in 110 ms with the sample's curve, then the line shrinks away and the cue is gone", () => {
    const white = text(1, "white");
    const end = cues[1]!.endMs;
    const capH = 0.705 * 190;
    for (const dt of [0, 20, 50, 80, 100, 109]) {
      const expected = Math.max(4 / capH, 1 - (1 - (1 - dt / 110) ** 3));
      expect(at(white, end - 190 + dt).sy).toBeCloseTo(expected, 2);
    }
    expect(at(white, end - 80).visible).toBe(false);
    const line = shape(1, "line");
    expect(at(line, end - 108).visible).toBe(false);
    expect(at(line, end - 107).visible).toBe(true);
    expect(at(line, end - 90).sx).toBe(1);
    expect(at(line, end - 31).sx).toBeCloseTo(1 - (59 / 60) ** 3, 6);
    expect(at(line, end - 30).visible).toBe(false);
    for (const piece of scene.pieces.filter((candidate) => cueNo(candidate) === 1)) expect(piece.toMs).toBeLessThanOrEqual(end - 30);
  });

  test("support words type one character at a time: the sample's stepped wipe and the cursor stays at the typed edge", () => {
    const word = cues[1]!.words[1]!; // "real"
    const n = 4;
    const piece = text(1, "w1");
    const cell = fakeMeasure("0", "JetBrains Mono Medium", 52, 0).advance;
    const left = at(piece, piece.fromMs).x - piece.origin!.dx;
    for (const t of [word.startMs - 41, word.startMs - 40, word.startMs + 10, word.startMs + 100, word.startMs + 200, word.endMs, word.endMs + 500]) {
      const k = signalTyped(t, word.startMs, word.endMs, n);
      if (k === 0) {
        expect(at(piece, t).visible).toBe(false);
        continue;
      }
      expect(at(piece, t).clip!.x2).toBeCloseTo(left + k * cell, 5);
    }
    const cursor = shape(1, "cursor");
    const k = signalTyped(word.startMs + 100, word.startMs, word.endMs, n);
    expect(at(cursor, word.startMs + 100).x).toBeCloseTo(left + k * cell + cell / 2, 4);
  });

  test("typing speed: at least 28 ms a character, or 80 % of the spoken duration", () => {
    expect(signalTyped(1000 - 41, 1000, 1500, 5)).toBe(0);
    expect(signalTyped(1000 - 40, 1000, 1500, 5)).toBe(1);
    // span = max(5 * 28, 400) = 400: a character every 80 ms.
    expect(signalTyped(1000 - 40 + 79, 1000, 1500, 5)).toBe(1);
    expect(signalTyped(1000 - 40 + 80, 1000, 1500, 5)).toBe(2);
    expect(signalTyped(1000 + 5000, 1000, 1500, 5)).toBe(5);
    // A very short word still takes 28 ms a character.
    expect(signalTyped(1000 - 40 + 27, 1000, 1040, 5)).toBe(1);
    expect(signalTyped(1000 - 40 + 28, 1000, 1040, 5)).toBe(2);
  });

  test("the cursor is solid while typing and 300 ms after, then blinks off 260 ms, on 260 ms", () => {
    const cursor = shape(0, "cursor");
    const first = cues[0]!.words[0]!; // "stop", then a 380 ms pause before "memorizing"
    const typingEnd = first.startMs - 40 + Math.max(4 * 28, (first.endMs - first.startMs) * 0.8);
    expect(at(cursor, first.startMs).o).toBe(1);
    expect(at(cursor, typingEnd + 299).o).toBe(1);
    expect(at(cursor, typingEnd + 300 + 100).o).toBe(0);
    expect(at(cursor, typingEnd + 300 + 260 + 100).o).toBe(1);
    // It stands still where it stopped, and hides for the exit.
    expect(at(cursor, typingEnd + 300).x).toBeCloseTo(at(cursor, typingEnd + 100).x, 6);
    expect(at(cursor, cues[0]!.endMs - 190).visible).toBe(false);
  });

  test("a long idle keeps blinking, 260 ms off then 260 ms on, at the end of the last word", () => {
    const quiet = { index: 0, startMs: 1000, endMs: 3000, speaker: 0, language: "en", words: [{ text: "go", startMs: 1000, endMs: 1200, role: "body" as const, key: null }] };
    const built = signalProgram.build(sceneInput([quiet], { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } }));
    const cursor = built.pieces.find((piece) => piece.id === "signal:0:cursor")!;
    // span = max(2 * 28, 160) = 160, so typing ends at 960 + 160 = 1120; the idle starts counting there.
    const on = (idle: number) => evaluatePiece(cursor, 1120 + idle).o;
    expect([0, 299, 300, 559, 560, 819, 820, 1079, 1080, 1339].map(on)).toEqual([1, 1, 0, 0, 1, 1, 0, 0, 1, 1]);
    expect(evaluatePiece(cursor, 1120 + 300).x).toBeCloseTo(evaluatePiece(cursor, 1120 + 100).x, 6);
  });

  test("the typed words collapse vertically and fade on exit", () => {
    const piece = text(1, "w0");
    const end = cues[1]!.endMs;
    expect(at(piece, end - 190).sy).toBe(1);
    expect(at(piece, end - 190 + 55).sy).toBeCloseTo(1 - (1 - (1 - 0.5) ** 3), 6);
    expect(at(piece, end - 190 + 55).o).toBeCloseTo(at(piece, end - 190 + 55).sy, 6);
    expect(at(piece, end - 80).visible).toBe(false);
  });
});

describe("Signal edge cases", () => {
  const build = (kind: Parameters<typeof sceneEdgeDemo>[0]) => {
    const edge = sceneEdgeDemo(kind).cues;
    return { cues: edge, scene: signalProgram.build(sceneInput(edge, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } })) };
  };

  test("a cue that is only a hero draws no typed line and no cursor", () => {
    const { scene: built } = build("one-word");
    const ids = built.pieces.filter((piece) => cueNo(piece) === 0).map((piece) => piece.id.split(":")[2]);
    expect(ids).not.toContain("cursor");
    expect(ids.some((id) => /^w\d+$/.test(id!))).toBe(false);
    expect(ids).toContain("white");
  });

  test("a row wider than the safe width wraps evenly into rows above the hero and keeps one cursor", () => {
    const { scene: built } = build("nine-words");
    const words = built.pieces.filter((piece): piece is TextPiece => piece.kind === "text" && cueNo(piece) === 0 && /:w\d+$/.test(piece.id));
    const rows = new Set(words.map((piece) => Math.round(evaluatePiece(piece, piece.fromMs).y)));
    expect(words).toHaveLength(8);
    expect(rows.size).toBe(2);
    expect(built.pieces.filter((piece) => piece.id === "signal:0:cursor")).toHaveLength(1);
  });

  test("a word wider than a row shrinks the line to fit, and a long hero shrinks to 760 px", () => {
    const { scene: built } = build("long-word");
    const long = built.pieces.find((piece): piece is TextPiece => piece.kind === "text" && piece.id === "signal:1:w0")!;
    expect(long.sizePx).toBeLessThan(64);
    const hero = built.pieces.find((piece): piece is TextPiece => piece.kind === "text" && piece.id === "signal:0:white")!;
    expect(hero.sizePx).toBeLessThan(190);
    expect(fakeMeasure(hero.text, hero.face, hero.sizePx, hero.letterSpacingEm).advance + hero.letterSpacingEm * hero.sizePx).toBeCloseTo(760, 3);
  });

  test("an RTL cue types from the right: its clip reveals from the right edge", () => {
    const { scene: built } = build("urdu");
    const first = built.pieces.find((piece): piece is TextPiece => piece.kind === "text" && piece.id === "signal:0:w0")!;
    const early = evaluatePiece(first, first.fromMs + 1).clip!;
    const late = evaluatePiece(first, first.toMs - 200).clip!;
    expect(late.x1).toBeLessThan(early.x1);
    expect(late.x2).toBe(early.x2);
  });

  test("a hero that starts in the last 190 ms of its cue skips the slices instead of clipping a moving word", () => {
    const base = cues[1]!;
    const slicesOf = (endMs: number) => signalProgram.build(sceneInput([{ ...base, endMs }], { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } })).pieces.find((piece) => piece.id === "signal:0:sliceA");
    const start = base.words[4]!.startMs;
    // 200 ms after the hero starts the exit begins at +10 ms: a slice would last 90 ms, so it is cut at the exit.
    expect(slicesOf(start + 200)!.toMs).toBe(start + 200 - 190);
    // The exit begins before the hero is even live: no slices at all.
    expect(slicesOf(start + 100)).toBeUndefined();
  });
});
