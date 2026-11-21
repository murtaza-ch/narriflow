import { describe, expect, test } from "bun:test";
import { type DemoScript, demoCues, sceneEdgeDemo } from "./demo";
import { EASES } from "./ease";
import { SCENE_PIECE_BUDGET, type Piece, type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { HYPE_BODY_STEPS, HYPE_DEMO, HYPE_HERO_STEPS, hypeDisplay, hypeHash, hypeLetters, hypeProgram, hypeRng, hypeSparklePath } from "./templates/hype";
import { fakeMeasure, sceneInput } from "./test-support";

const COLOURS = { primary: "#FFF2D6", highlight: "#3EE06B", accent: "#FFC22E", shadow: "#000000" };
const ANCHOR = { xPct: 50, yPct: (1290 / 1920) * 100 };
const buildFor = (script: DemoScript, overrides = {}) => hypeProgram.build(sceneInput(demoCues(script).cues, { anchor: ANCHOR, colours: COLOURS, ...overrides })).pieces;
const { cues } = demoCues(HYPE_DEMO);
const scene = buildFor(HYPE_DEMO);
const ofCue = (list: readonly Piece[], cue: number) => list.filter((piece) => piece.id.startsWith(`hype:${cue}:`));
const texts = (list: readonly Piece[]) => list.filter((piece): piece is TextPiece => piece.kind === "text");
const sparkles = (list: readonly Piece[]) => list.filter((piece): piece is ShapePiece => piece.kind === "shape");
const settled = (piece: Piece) => evaluatePiece(piece, piece.fromMs + 500);

describe("Hype helpers", () => {
  test("hash and generator are deterministic and spread", () => {
    expect(hypeHash("a")).toBe(hypeHash("a"));
    expect(hypeHash("a")).not.toBe(hypeHash("b"));
    const r = hypeRng(5);
    const draws = [...Array(40)].map(() => r());
    expect(new Set(draws).size).toBe(40);
    expect(draws.every((d) => d >= 0 && d < 1)).toBe(true);
  });

  test("letters split for Latin, Greek and Cyrillic only, up to 12; other scripts stay whole and keep their case", () => {
    expect(hypeLetters("HUGE")).toEqual(["H", "U", "G", "E"]);
    expect(hypeLetters("привет")).toHaveLength(6);
    for (const word of ["اچھا", "नमस्ते", "你好", "שלום", "x".repeat(13)]) expect(hypeLetters(word)).toBeNull();
    expect(hypeDisplay("huge")).toBe("HUGE");
    expect(hypeDisplay("اچھا")).toBe("اچھا");
  });

  test("the sparkle is the sample's four-point shape drawn from its own top-left", () => {
    const path = hypeSparklePath(4.6);
    expect(path[0]).toEqual(["M", 9 * 4.6, 0]);
    expect(path.filter((cmd) => cmd[0] === "C")).toHaveLength(4);
  });
});

describe("Hype rows and words", () => {
  test("a hero cue is a lead row above a big hero row of letters; the hero takes the green, the rest cream with a hard extrusion", () => {
    const cue0 = texts(ofCue(scene, 0));
    const okay = cue0.find((piece) => piece.id === "hype:0:w0")!;
    const letters = cue0.filter((piece) => piece.id.startsWith("hype:0:w3l"));
    expect(okay.text).toBe("OKAY");
    expect(letters.map((piece) => piece.text).join("")).toBe("HUGE");
    expect(okay.fill).toBe(COLOURS.primary);
    expect(letters[0]!.fill).toBe(COLOURS.highlight);
    expect(okay.face).toBe("Barlow Condensed Black Italic");
    expect(letters[0]!.sizePx).toBeGreaterThan(okay.sizePx);
    expect(letters[0]!.sizePx).toBeLessThanOrEqual(256);
    expect(okay.sizePx).toBeLessThanOrEqual(148);
    expect(okay.stroke).toMatchObject({ widthPx: 0.025 * okay.sizePx, colour: "#1E1411" });
    // Extrusion: copies stepped 0.0115 em down and 0.8 of that right.
    expect(okay.shadows).toHaveLength(HYPE_BODY_STEPS.length);
    expect(letters[0]!.shadows).toHaveLength(HYPE_HERO_STEPS.length);
    HYPE_BODY_STEPS.forEach((step, at) => {
      expect(okay.shadows![at]!.dy).toBeCloseTo(step * 0.0115 * okay.sizePx, 6);
      expect(okay.shadows![at]!.dx).toBeCloseTo(0.8 * okay.shadows![at]!.dy, 6);
    });
    const ys = (piece: TextPiece) => settled(piece).y;
    expect(ys(okay)).toBeLessThan(ys(letters[0]!));
  });

  test("a single short word before the key word shares its row (\"for REAL\"); a lone word is bigger", () => {
    const cue4 = texts(ofCue(scene, 4));
    const bottom = (piece: TextPiece) => settled(piece).y + (piece.sizePx * 0.45);
    const forWord = cue4.find((piece) => piece.text === "FOR")!;
    const real = cue4.find((piece) => piece.text === "R")!;
    expect(Math.abs(bottom(forWord) - bottom(real))).toBeGreaterThan(0);
    expect(Math.abs(settled(forWord).y - settled(real).y)).toBeLessThan(120);
    const lone = texts(ofCue(scene, 2))[0]!;
    expect(lone.sizePx).toBeGreaterThan(148 * 0.9);
  });

  test("a cue with no key word and four words takes two even rows at one size", () => {
    const cue3 = texts(ofCue(scene, 3));
    expect(cue3).toHaveLength(4);
    expect(new Set(cue3.map((piece) => piece.sizePx)).size).toBe(1);
    const ys = cue3.map((piece) => Math.round(settled(piece).y / 40));
    expect(new Set(ys).size).toBeGreaterThanOrEqual(2);
  });

  test("a word slaps on from 135 % (less at the edge) with the sample's spring and settles to 1", () => {
    const piece = scene.find((p) => p.id === "hype:0:w1")! as TextPiece;
    const start = cues[0]!.words[1]!.startMs - 50;
    expect(piece.fromMs).toBe(start);
    expect(evaluatePiece(piece, start + 2).sx).toBeGreaterThan(1.2);
    const first = evaluatePiece(piece, start + 2).sx;
    // The sample's lerp(s0, 1, spring(p)) over 220 ms.
    const expected = 1 + (first - 1) * (1 - EASES.spring(110 / 220)) / (1 - EASES.spring(2 / 220));
    expect(evaluatePiece(piece, start + 110).sx).toBeCloseTo(expected, 1);
    expect(evaluatePiece(piece, start + 600).sx).toBeCloseTo(1, 1);
  });

  test("hero letters land out of order, 32 ms apart at most, each a fresh pop", () => {
    const letters = texts(ofCue(scene, 0)).filter((piece) => piece.id.startsWith("hype:0:w3l"));
    const hero = cues[0]!.words[3]!;
    const starts = letters.map((piece) => piece.fromMs - (hero.startMs - 70));
    expect([...starts].sort((a, b) => a - b).map((s, at) => Math.round(s / 32) === at)).toEqual([true, true, true, true]);
    expect(starts).not.toEqual([0, 32, 64, 96]);
  });

  test("the block rocks and the rows drift for the whole hold", () => {
    const piece = scene.find((p) => p.id === "hype:0:w1")! as TextPiece;
    const tilts: number[] = [];
    for (let t = piece.fromMs + 400; t < piece.toMs - 200; t += 50) tilts.push(evaluatePiece(piece, t).rz);
    expect(Math.max(...tilts) - Math.min(...tilts)).toBeGreaterThan(0.5);
    expect(Math.max(...tilts)).toBeLessThan(-3);
    expect(Math.min(...tilts)).toBeGreaterThan(-12);
  });

  test("the cue leaves in 150 ms ending 60 ms before its end: shrinks to 0.88, fades", () => {
    const piece = scene.find((p) => p.id === "hype:0:w0")! as TextPiece;
    const end = cues[0]!.endMs - 60;
    expect(piece.toMs).toBe(end);
    expect(evaluatePiece(piece, end - 151).o).toBe(1);
    const near = evaluatePiece(piece, end - 1);
    expect(near.o).toBeLessThan(0.05);
    expect(near.sx).toBeCloseTo(0.88, 1);
  });
});

describe("Hype recurs and varies", () => {
  const long: DemoScript = { lines: Array.from({ length: 6 }, () => HYPE_DEMO.lines).flat(), options: HYPE_DEMO.options };
  const many = buildFor(long);
  const { cues: all } = demoCues(long);

  test("every cue of a 30-cue clip has sparkles; a hero cue four, a cue without a hero two", () => {
    expect(all).toHaveLength(30);
    all.forEach((cue, at) => {
      const spots = new Set(sparkles(ofCue(many, at)).map((piece) => piece.id.split(":")[2]!.split("t")[0]));
      expect(spots.size).toBe(cue.words.some((word) => word.role === "hero") ? 4 : 2);
    });
  });

  test("sparkles twinkle again and again through a long hold", () => {
    const heroHold: DemoScript = { lines: ["wow:h@5000"], options: { tail: 1000 } };
    const twinkles = sparkles(buildFor(heroHold)).filter((piece) => piece.id.includes(":sp1t"));
    expect(twinkles.length).toBeGreaterThanOrEqual(4);
    const gaps = twinkles.slice(1).map((piece, at) => piece.fromMs - twinkles[at]!.fromMs);
    for (const gap of gaps) expect(gap).toBeCloseTo(1150, -1);
  });

  test("every cue stays inside the piece budget", () => {
    for (let at = 0; at < all.length; at++) {
      const count = ofCue(many, at).reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0), 0);
      expect(count).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
    }
  });

  test("hero colours cycle green, yellow, red; tilts and sparkle sides keep varying", () => {
    const fills: string[] = [];
    const tilts = new Set<number>();
    const sides = new Set<number>();
    all.forEach((_cue, at) => {
      const own = ofCue(many, at);
      const hero = texts(own).find((piece) => piece.fill !== COLOURS.primary);
      if (hero) fills.push(hero.fill);
      tilts.add(Math.round(settled(texts(own)[0]!).rz));
      const spark = sparkles(own)[0];
      if (spark) sides.add(Math.sign(evaluatePiece(spark, spark.fromMs + 100).x - 540));
    });
    expect(fills.slice(0, 6)).toEqual([COLOURS.highlight, COLOURS.accent, "#FF4651", COLOURS.highlight, COLOURS.accent, "#FF4651"]);
    expect(tilts.size).toBeGreaterThan(3);
    expect(sides.size).toBe(2);
  });
});

describe("Hype with real speech timing", () => {
  test.each([60, 0])("cueGap %d: every word stays visible 150 ms after it lands", (cueGap) => {
    const pieces = buildFor({ ...HYPE_DEMO, options: { ...HYPE_DEMO.options, cueGap } });
    for (const piece of texts(pieces)) {
      const landed = [...Array(piece.toMs - piece.fromMs).keys()].map((at) => piece.fromMs + at).find((t) => evaluatePiece(piece, t).o > 0.9);
      expect(landed).toBeDefined();
      for (let t = landed!; t <= landed! + 150; t += 5) {
        const pose = evaluatePiece(piece, t);
        expect(pose.visible).toBe(true);
        expect(pose.o).toBeGreaterThan(0.9);
      }
    }
  });

  test("a one-word cue followed 100 ms later by the next still holds its word", () => {
    const script: DemoScript = { lines: ["go:h@200", "now:h@200"], options: { cueGap: 40, rate: 100 } };
    for (const piece of texts(buildFor(script))) {
      const landed = [...Array(piece.toMs - piece.fromMs).keys()].map((at) => piece.fromMs + at).find((t) => evaluatePiece(piece, t).o > 0.9)!;
      expect(piece.toMs - landed).toBeGreaterThanOrEqual(150);
    }
  });
});

describe("Hype in other scripts and frames", () => {
  test("Urdu words are whole pieces and keep their text, the hero too", () => {
    const pieces = texts(hypeProgram.build(sceneInput(sceneEdgeDemo("urdu").cues, { anchor: ANCHOR, colours: COLOURS })).pieces).filter((piece) => piece.id.startsWith("hype:0:"));
    expect(pieces.map((piece) => piece.text).sort()).toEqual(["یہ", "بہت", "اچھا", "ہے"].sort());
  });

  test("edge demos stay inside the safe area in 9:16, 1:1 and 16:9, sparkles included", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      for (const kind of ["long-word", "nine-words", "one-word", "urdu", "no-hero"] as const) {
        const pieces = hypeProgram.build(sceneInput(sceneEdgeDemo(kind).cues, { canvas, anchor: ANCHOR, colours: COLOURS })).pieces;
        for (let t = 0; t < 8000; t += 33) {
          const box = sceneBoundsAt(pieces, t, fakeMeasure);
          if (!box) continue;
          expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
          expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
          expect(box.y1).toBeGreaterThanOrEqual(0.05 * canvas.height - 1);
          expect(box.y2).toBeLessThanOrEqual(0.95 * canvas.height + 1);
        }
      }
    }
  });
});
