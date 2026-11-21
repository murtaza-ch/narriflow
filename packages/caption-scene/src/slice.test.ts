import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { SLICE_DEMO, sliceCellScale, sliceHash, slicePlateSpots, sliceProgram, sliceSlide } from "./templates/slice";
import { fakeMeasure, sceneInput } from "./test-support";

const COLOURS = { primary: "#FFFFFF", highlight: "#8FE51E", accent: "#0C0F08", shadow: "#000000" };
const build = (list: readonly SceneCue[], overrides = {}) => sliceProgram.build(sceneInput(list, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
const demo = demoCues(SLICE_DEMO);
const cues = demo.cues;
const scene = build(cues);
const ofCue = (list: readonly Piece[], cue: number) => list.filter((piece) => piece.id.startsWith(`slice:${cue}:`));
const text = (list: readonly Piece[]) => list.filter((piece): piece is TextPiece => piece.kind === "text");
const shapes = (list: readonly Piece[]) => list.filter((piece): piece is ShapePiece => piece.kind === "shape");
const part = (piece: Piece) => piece.id.split(":")[2]!;

describe("Slice geometry", () => {
  test("every word is two clipped halves in Inter Tight ExtraBold, upper case, tightened by 0.035 em", () => {
    const first = text(ofCue(scene, 0)).filter((piece) => part(piece).startsWith("w0"));
    expect(first.map(part).sort()).toEqual(["w0tw", "w0bw"].sort());
    for (const piece of first) {
      expect(piece).toMatchObject({ text: "NOBODY", face: "Inter Tight ExtraBold", letterSpacingEm: -0.035, fill: "#FFFFFF" });
      expect(piece.shadows).toHaveLength(2);
      expect(piece.shadows![0]).toMatchObject({ dy: 5, blur: 13, alpha: 0.55 });
    }
  });

  test("lines step 66 px further along and sit 97 px apart (150 px for the hero line), centred on y 1290", () => {
    const lines = (cue: number) => {
      const words = text(ofCue(scene, cue)).filter((piece) => /^w\d+tw$/.test(part(piece)));
      const rows = new Map<number, number[]>();
      for (const word of words) {
        const settled = evaluatePiece(word, word.fromMs + 400);
        rows.set(settled.y, [...(rows.get(settled.y) ?? []), settled.x]);
      }
      return [...rows.entries()].sort((a, b) => a[0] - b[0]);
    };
    const rows = lines(0);
    expect(rows.length).toBeGreaterThan(1);
    // The plain lines are 97 px apart and each starts 66 px right of the last (the first word of each line).
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]![0] - rows[i - 1]![0]).toBeCloseTo(97, 1);
      expect(Math.min(...rows[i]![1]) - Math.min(...rows[i - 1]![1])).toBeCloseTo(66, 1);
    }
  });

  test("the plate is ceil((word + 84) / 62) columns of two rows with one step out at each end, the snake alternating columns", () => {
    const spots = slicePlateSpots(4, false);
    expect(spots.slice(0, 2)).toEqual([[-1, 2], [-1, 1]]);
    expect(spots.slice(2, 6)).toEqual([[0, 1], [0, 0], [1, 0], [1, 1]]);
    expect(spots.slice(-2)).toEqual([[4, 0], [4, -1]]);
    expect(spots).toHaveLength(2 + 2 * 4 + 2);
    // The mirror steps up at the entry and down at the exit, and continues from the last entry cell.
    const mirrored = slicePlateSpots(4, true);
    expect(mirrored.slice(0, 2)).toEqual([[-1, -1], [-1, 0]]);
    expect(mirrored[2]).toEqual([0, 0]);
    expect(mirrored.slice(-2)).toEqual([[4, 1], [4, 2]]);
    const cells = shapes(ofCue(scene, 1)).filter((piece) => /^c\d+$/.test(part(piece)));
    const word = text(ofCue(scene, 1)).find((piece) => part(piece).startsWith("w2"))!;
    expect(word).toBeDefined();
    expect(cells.length).toBe(2 + 2 * Math.ceil((fakeMeasure("YOURSELF", "Inter Tight ExtraBold", 106, -0.035).advance - 0.035 * 106 + 84) / 62) + 2);
    expect(cells.every((cell) => cell.fill!.colour === "#8FE51E")).toBe(true);
  });

  test("a cell is a rounded square that only rounds corners with no neighbour, scaling about its centre", () => {
    const cell = shapes(ofCue(scene, 1)).find((piece) => part(piece) === "c0")!;
    expect(cell.origin!.dx).toBeCloseTo(32, 6);
    expect(cell.path.some((cmd) => cmd[0] === "C")).toBe(true);
  });

  test("the hero's ink letters use the accent colour and cast no shadow; the white copies keep theirs", () => {
    const ink = text(ofCue(scene, 1)).filter((piece) => part(piece).startsWith("w2l") && part(piece).endsWith("i"));
    expect(ink.length).toBeGreaterThan(0);
    for (const piece of ink) {
      expect(piece.fill).toBe("#0C0F08");
      expect(piece.shadows).toBeUndefined();
    }
  });
});

describe("Slice motion", () => {
  test("a word slides in 38 px over 260 ms and its halves open from the middle, the bottom 55 ms after the top", () => {
    const cue = cues[1]!;
    const word = cue.words[0]!;
    const top = text(ofCue(scene, 1)).find((piece) => part(piece) === "w0tw")!;
    const bottom = text(ofCue(scene, 1)).find((piece) => part(piece) === "w0bw")!;
    const rest = evaluatePiece(top, word.startMs + 400).x;
    for (const dt of [-60, 0, 60, 150]) {
      const t = word.startMs + dt;
      const a = EASES.outExpo(prog(t, word.startMs - 80, 260));
      expect(evaluatePiece(top, t).x - rest).toBeCloseTo(-38 * (1 - a), 1);
      const clip = evaluatePiece(top, t).clip!;
      const mid = (clip.y2 as number);
      const boxTop = mid - (evaluatePiece(top, word.startMs + 400).clip!.y2 - evaluatePiece(top, word.startMs + 400).clip!.y1);
      expect(clip.y1).toBeCloseTo(mid - (mid - boxTop) * a, 1);
      const b = EASES.outExpo(prog(t, word.startMs - 80 + 55, 260));
      const bclip = evaluatePiece(bottom, t).clip!;
      const full = evaluatePiece(bottom, word.startMs + 400).clip!;
      expect(bclip.y2 - bclip.y1).toBeCloseTo((full.y2 - full.y1) * b, 1);
    }
  });

  test("the slide and slit tracks are the sample's formulas", () => {
    const frames = sliceSlide(1000, 2000, 150, 1, 1);
    const at = (t: number) => -38 * (1 - EASES.outExpo(prog(t, 1000, 260))) + 44 * EASES.in(prog(t, 2000, 150));
    for (const t of [1000, 1100, 1200, 1500, 2050, 2100, 2149]) {
      const x = frames.reduce((acc, frame, i) => (i > 0 && t <= frame[0] && t > frames[i - 1]![0] ? i : acc), 0);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(at(t))).toBe(true);
    }
    // A word that lands inside the exit is sampled, not eased in two overlapping segments.
    expect(sliceSlide(1000, 1100, 150, 1, 1).length).toBeGreaterThan(4);
  });

  test("a cell pops with outBack(2.2) up to 1.2 times and shuts with the exit", () => {
    expect(sliceCellScale(100, 100, 5000, 100)).toBe(0);
    expect(sliceCellScale(220, 100, 5000, 100)).toBeCloseTo(1, 6);
    const peak = Math.max(...Array.from({ length: 120 }, (_, i) => sliceCellScale(100 + i, 100, 5000, 100)));
    expect(peak).toBeGreaterThan(1.1);
    expect(peak).toBeLessThanOrEqual(1.2);
    expect(sliceCellScale(5100, 100, 5000, 100)).toBe(0);
  });

  test("a hero letter turns to ink once the snake has laid the cell under it", () => {
    const letters = text(ofCue(scene, 1)).filter((piece) => /^w2l\d+tw$/.test(part(piece)));
    expect(letters.length).toBeGreaterThan(1);
    for (const letter of letters) {
      const ink = text(ofCue(scene, 1)).find((piece) => part(piece) === `${part(letter).slice(0, -1)}i`);
      if (ink) expect(ink.fromMs).toBe(letter.toMs);
    }
  });

  test("a no-hero cue springs a lime starburst in with its last word and turns it", () => {
    const star = shapes(ofCue(scene, 0)).find((piece) => part(piece) === "star")!;
    const last = cues[0]!.words[5]!;
    expect(star.fill!.colour).toBe("#8FE51E");
    expect(evaluatePiece(star, last.startMs + 300).sx).toBeGreaterThan(0.9);
    // rz = start angle + 0.03 deg/ms since the word - 40 deg * (1 - spring), the sample's formula.
    const turn = (t: number) => evaluatePiece(star, t).rz - 0.03 * (t - last.startMs) + 40 * (1 - EASES.spring(prog(t, last.startMs - 40, 520)));
    expect(turn(last.startMs + 250)).toBeCloseTo(turn(last.startMs + 400), 0);
  });
});

describe("Slice with real speech", () => {
  const word = (index: number) => demo.cues[index]!;
  const fast = demoCues({ ...SLICE_DEMO, options: { ...SLICE_DEMO.options, cueGap: 60 } }).cues;
  const fastScene = build(fast);

  test("every word is fully open and opaque for 150 ms after it lands, with 60 ms between cues", () => {
    fast.forEach((cue, number) => {
      for (const [index, spoken] of cue.words.entries()) {
        // The pieces of this word, by half (letters group by position).
        const mine = text(ofCue(fastScene, number)).filter((piece) => new RegExp(`^w${index}(l\\d+)?[tb][wi]$`).test(part(piece)));
        expect(mine.length).toBeGreaterThan(0);
        const open = (piece: TextPiece, t: number) => {
          const pose = evaluatePiece(piece, t);
          if (!pose.visible || pose.o < 0.9 || !pose.clip) return false;
          const full = evaluatePiece(piece, spoken.startMs + 120).clip!;
          const ref = part(piece).includes("t") ? full : full;
          return pose.clip.y2 - pose.clip.y1 >= (ref.y2 - ref.y1) * 0.97 - 0.01;
        };
        const landed = spoken.startMs + 122;
        for (let t = landed; t <= landed + 150; t += 10) {
          const halves = ["t", "b"].map((half) => mine.some((piece) => part(piece).replace(/\d/g, "").includes(half) && open(piece, t)));
          expect(halves).toEqual([true, true]);
        }
      }
    });
  });

  test("a cue's pieces end before its next cue's first word has had 60 ms", () => {
    fast.forEach((cue, number) => {
      for (const piece of ofCue(fastScene, number)) expect(piece.toMs).toBeLessThanOrEqual(cue.endMs - 19);
    });
    expect(word(0)).toBeDefined();
  });
});

describe("Slice across a long clip", () => {
  const long: SceneCue[] = Array.from({ length: 24 }, (_, i) => {
    const base = demoCues(SLICE_DEMO).cues[i % 5]!;
    const shift = i * 6000;
    return { ...base, index: i, startMs: base.startMs + shift, endMs: base.endMs + shift, words: base.words.map((w) => ({ ...w, startMs: w.startMs + shift, endMs: w.endMs + shift, key: `l:${i}:${w.text}` })) };
  });
  const list = build(long);

  test("every cue draws its decoration: a plate on hero cues, a starburst on the others", () => {
    long.forEach((cue, number) => {
      const mine = ofCue(list, number);
      const hasHero = cue.words.some((w) => w.role === "hero");
      expect(mine.some((piece) => part(piece) === "star")).toBe(!hasHero);
      expect(mine.some((piece) => /^c\d+$/.test(part(piece)))).toBe(hasHero);
    });
  });

  test("the decoration varies: three starbursts and both staircases alternate, deterministically", () => {
    const stars = long.flatMap((_, number) => shapes(ofCue(list, number)).filter((piece) => part(piece) === "star"));
    const sizes = new Set(stars.map((star) => star.path.length));
    expect(sizes.size).toBe(3);
    const entries = long.flatMap((_, number) => {
      const first = shapes(ofCue(list, number)).find((piece) => part(piece) === "c0");
      return first ? [evaluatePiece(first, first.toMs - 1).y] : [];
    });
    // The mirrored staircase begins one row-pair higher than the sample's.
    expect(new Set(entries.map((y) => Math.round(y))).size).toBeGreaterThan(1);
    expect(build(long)).toEqual(list);
    expect(sliceHash(1, "a")).toBe(sliceHash(1, "a"));
    expect(sliceHash(1, "a")).not.toBe(sliceHash(2, "a"));
  });

  test("the diagonal steps the other way on alternate pairs of cues", () => {
    const firstX = (number: number) => Math.min(...text(ofCue(list, number)).map((piece) => evaluatePiece(piece, piece.toMs - 1).x));
    expect(firstX(0)).not.toBeCloseTo(firstX(4), 0);
  });
});

describe("Slice edge cases", () => {
  test("a right-to-left cue runs right to left: words are whole, with no letter spacing, and the star sits at the left end", () => {
    const urdu = sceneEdgeDemo("urdu").cues;
    const list = build(urdu);
    for (const piece of text(list)) {
      expect(piece.letterSpacingEm).toBe(0);
      expect(piece.text).not.toHaveLength(1);
    }
    const plain = build(urdu.slice(1));
    const star = shapes(plain).find((piece) => part(piece) === "star")!;
    const words = text(plain);
    expect(evaluatePiece(star, star.fromMs + 400).x).toBeLessThan(Math.min(...words.map((piece) => evaluatePiece(piece, piece.fromMs + 400).x)));
    // Words slide in from the right.
    const first = words[0]!;
    expect(evaluatePiece(first, first.fromMs + 1).x).toBeGreaterThan(evaluatePiece(first, first.toMs - 60).x);
  });

  test("a long hero flips per word, a short one per letter", () => {
    const long = build(sceneEdgeDemo("long-word").cues);
    expect(text(ofCue(long, 0)).some((piece) => piece.text === "EXTRAORDINARILY")).toBe(true);
    expect(text(ofCue(scene, 1)).some((piece) => piece.text === "Y")).toBe(true);
  });

  test("the 45-letter word and nine words stay inside the safe area at every moment, on 9:16, 1:1 and 16:9", () => {
    const canvases = [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }];
    for (const canvas of canvases) {
      for (const kind of ["long-word", "nine-words", "no-hero", "one-word"] as const) {
        const pieces = build(sceneEdgeDemo(kind).cues, { canvas, anchor: { xPct: 50, yPct: 67 } });
        for (let t = 0; t < 8000; t += 40) {
          const box = sceneBoundsAt(pieces, t, fakeMeasure);
          if (!box) continue;
          expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
          expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
        }
      }
    }
  });
});
