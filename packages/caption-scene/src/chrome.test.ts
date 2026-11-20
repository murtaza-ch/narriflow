import { describe, expect, test } from "bun:test";
import { demoCues } from "./demo";
import { kf } from "./ease";
import { CHROME_DEMO, chromeLanding, chromeProgram, chromeSupport } from "./templates/chrome";
import { evaluatePiece, type Measure, type Piece, type ShapePiece, type TextPiece } from "./scene";
import { sceneInput } from "./test-support";

/**
 * A stand-in for Unbounded: 0.8 em per character, caps exactly 0.75 em tall and nothing below the baseline,
 * as the sample's own measurement of a Latin capital word.
 */
const measure: Measure = (text, _face, sizePx, letterSpacingEm) => ({
  advance: [...text].length * (0.8 + letterSpacingEm) * sizePx - letterSpacingEm * sizePx,
  inkTop: -0.75 * sizePx,
  inkBottom: 0,
  ascent: 1.26 * sizePx,
  descent: 0.29 * sizePx,
});

const { cues } = demoCues(CHROME_DEMO);
const ANCHOR = { xPct: 50, yPct: (1290 / 1920) * 100 };
const build = (list = cues, overrides = {}) => chromeProgram.build(sceneInput(list, { measure, anchor: ANCHOR, ...overrides })).pieces;
const scene = build();
const cuePieces = (cue: number) => scene.filter((piece) => piece.id.startsWith(`chrome:${cue}:`));
const piece = (cue: number, name: string) => cuePieces(cue).find((p) => p.id === `chrome:${cue}:${name}`)!;
const text = (cue: number, name: string) => piece(cue, name) as TextPiece;
/** The hero layer's piece that is on screen at `t`: the landing piece, then the rest piece (`<name>r`). */
const at = (cue: number, name: string, t: number) =>
  cuePieces(cue).find((p) => (p.id === `chrome:${cue}:${name}` || p.id === `chrome:${cue}:${name}r`) && t >= p.fromMs && t < p.toMs) as TextPiece;
const poseOf = (cue: number, name: string, t: number) => evaluatePiece(at(cue, name, t), t);

const HERO_CUE = 1;
const hero = cues[HERO_CUE]!.words.find((word) => word.role === "hero")!;
const landStart = hero.startMs - 80;
const CAP_H = 0.75 * 190;

describe("Chrome", () => {
  test("a hero cue is a glow, ten rimmed colour bands, two glint stripes and a sparkle, then one piece per support word", () => {
    const ids = cuePieces(HERO_CUE).map((p) => p.id.split(":").slice(2).join(":"));
    expect(ids.filter((id) => /^band\d$/.test(id))).toHaveLength(10);
    expect(ids.filter((id) => /^band\dr$/.test(id))).toHaveLength(10);
    expect(ids).toEqual(expect.arrayContaining(["glow", "band0", "glint0", "glint1", "star", "spark", "w0", "w1", "w3"]));
    expect(ids).not.toContain("w2");
    // The hero's glyphs are upper case, the support words lower case.
    expect(text(HERO_CUE, "band0").text).toBe("ICONIC");
    expect(text(HERO_CUE, "w0").text).toBe("it's");
  });

  test("the hero is Unbounded Black at 190 px, 0.75 em tall, tilted 8 degrees, the support Unbounded Medium at 52 px", () => {
    expect(text(HERO_CUE, "band0")).toMatchObject({ face: "Unbounded Black", sizePx: 190, letterSpacingEm: -0.01 });
    // Every band wears the navy rim: 0.05 em across, half of it outside the glyph.
    for (let index = 0; index < 10; index++) expect(text(HERO_CUE, `band${index}`).stroke).toEqual({ widthPx: 190 * 0.025, colour: "#0A1636" });
    expect(poseOf(HERO_CUE, "band0", hero.startMs + 500).skx).toBe(-8);
    expect(text(HERO_CUE, "w0")).toMatchObject({ face: "Unbounded Medium", sizePx: 52, letterSpacingEm: -0.01, fill: "#FFFFFF" });
    // A cue with no hero draws its words at 64 px.
    expect(text(0, "w0").sizePx).toBe(64);
  });

  test("the block is centred on the anchor line: lead line, 30, badge, 4, 30, tail line", () => {
    const lead = text(HERO_CUE, "w0");
    const tail = text(HERO_CUE, "w3");
    const when = hero.startMs + 800;
    const pivotNow = poseOf(HERO_CUE, "band0", when).y;
    const restLead = evaluatePiece(lead, when).y;
    const restTail = evaluatePiece(tail, when).y;
    const badgeBottom = pivotNow + CAP_H / 2;
    const line = 52 * 1.18;
    // Baselines sit 50 px below a 52 px line box's top.
    const total = line + 30 + CAP_H + 4 + 30 + line;
    const top = 1290 - total / 2;
    expect(restLead).toBeCloseTo(top + 50, 5);
    expect(pivotNow - CAP_H / 2).toBeCloseTo(top + line + 30, 5);
    expect(badgeBottom).toBeCloseTo(top + line + 30 + CAP_H, 5);
    expect(restTail).toBeCloseTo(top + line + 30 + CAP_H + 4 + 30 + 50, 5);
  });

  test("the hero shrinks until the sheared word fits 86 % of the width, and never exceeds 190 px", () => {
    const long = demoCues({ lines: ["it's:m extraordinarily:h@500 hard:b"] }).cues;
    const size = (build(long).find((p) => p.id.endsWith(":band0")) as TextPiece).sizePx;
    const width = 15 * 0.79 * size + Math.tan((8 * Math.PI) / 180) * 0.75 * size;
    expect(size).toBeLessThan(190);
    expect(width).toBeCloseTo(0.86 * 1080, 3);
  });

  test("the landing is the sample's: scale 1.7 to 1 and blur 16 to 0 over 260 ms outExpo, opacity in over 90 ms", () => {
    for (const t of [landStart, landStart + 30, landStart + 60, landStart + 130, landStart + 259, landStart + 400]) {
      const now = poseOf(HERO_CUE, "band0", t);
      const expected = chromeLanding(t, hero.startMs);
      expect(now.sx).toBeCloseTo(expected.scale, 2);
      expect(now.sy).toBeCloseTo(expected.scale, 2);
      expect(now.blur).toBeCloseTo(expected.blur, 1);
      expect(now.o).toBeCloseTo(expected.opacity, 6);
    }
    // The landing runs far past the safe area for 260 ms and is a bleed piece; the rest is not.
    expect(text(HERO_CUE, "band0").bleed).toBe(true);
    expect(text(HERO_CUE, "band0r").bleed).toBeUndefined();
    expect([text(HERO_CUE, "band0").fromMs, text(HERO_CUE, "band0").toMs]).toEqual([landStart, landStart + 260]);
    expect(text(HERO_CUE, "band0r").fromMs).toBe(landStart + 260);
  });

  test("the glow is the accent colour at full opacity, its blur and the landing blur added in quadrature", () => {
    expect(text(HERO_CUE, "glow").fill).toBe("#FFFFFF");
    const sigma = 190 * 0.07;
    for (const t of [landStart, landStart + 60, landStart + 140, landStart + 400]) {
      expect(poseOf(HERO_CUE, "glow", t).blur).toBeCloseTo(Math.hypot(sigma, chromeLanding(t, hero.startMs).blur), 1);
    }
    expect(poseOf(HERO_CUE, "glow", landStart + 400).o).toBe(1);
  });

  test("the bands tile the cap box top to bottom, each colour as the sample's, and ride the landing scale about the pivot", () => {
    const colours = ["#FFFFFF", "#F1F6FF", "#DCE8FA", "#BCD3F3", "#F7FBFF", "#0A1530", "#17305F", "#2F5A97", "#7FA8DC", "#E4F0FF"];
    expect(Array.from({ length: 10 }, (_, index) => text(HERO_CUE, `band${index}`).fill)).toEqual(colours);
    const rest = hero.startMs + 700;
    const pivotY = poseOf(HERO_CUE, "band0", rest).y;
    const top = pivotY - CAP_H / 2;
    const edges = [0, 16, 30, 42, 50, 54, 64, 74, 84, 92, 100];
    // The first band's clip reaches above the cap box and the last band's below it, so the rim is whole there.
    const reach = 190 * 0.025 + 0.03 * 190;
    const rest0 = (index: number) => top + (CAP_H * edges[index]!) / 100 - (index === 0 ? reach : 0);
    const rest1 = (index: number) => top + (CAP_H * edges[index + 1]!) / 100 + (index === 9 ? reach : 0);
    colours.forEach((_, index) => {
      const clip = poseOf(HERO_CUE, `band${index}`, rest).clip!;
      expect(clip.y1).toBeCloseTo(rest0(index), 5);
      expect(clip.y2).toBeCloseTo(rest1(index), 5);
      // While landing, the edge is the pivot plus the scale times its rest offset.
      for (const t of [landStart + 40, landStart + 100]) {
        const scale = chromeLanding(t, hero.startMs).scale;
        const during = poseOf(HERO_CUE, `band${index}`, t).clip!;
        expect(during.y1).toBeCloseTo(pivotY + scale * (rest0(index) - pivotY), 5);
        expect(during.y2).toBeCloseTo(pivotY + scale * (rest1(index) - pivotY), 5);
      }
    });
    // Neighbouring bands meet with no gap and no overlap, and the glow sits under them.
    for (let index = 0; index < 9; index++) expect(rest1(index)).toBeCloseTo(rest0(index + 1), 9);
    expect(text(HERO_CUE, "glow").z).toBeLessThan(text(HERO_CUE, "band0").z);
  });

  test("the glint sweeps two upright white stripes (46 px at 0.85, 10 px at 0.75, trailing) across the badge in 440 ms inOut", () => {
    const start = hero.startMs + 110;
    const wide = text(HERO_CUE, "glint0");
    const thin = text(HERO_CUE, "glint1");
    expect([wide.fill, thin.fill]).toEqual(["#FFFFFF", "#FFFFFF"]);
    expect([wide.fromMs, wide.toMs]).toEqual([start, start + 440]);
    expect(evaluatePiece(wide, start + 100).o).toBe(0.85);
    expect(evaluatePiece(thin, start + 100).o).toBe(0.75);
    const width = 6 * 0.79 * 190;
    const left = 540 - width / 2;
    const lean = Math.tan((8 * Math.PI) / 180) * CAP_H * 0.5;
    const overhang = lean + 6;
    const head = (t: number) => -overhang - 46 + (width + 2 * overhang + 46 + 60 + 12) * kf(t, [[start, 0], [start + 440, 1, "inOut"]]);
    for (const t of [start + 1, start + 110, start + 220, start + 330, start + 430]) {
      const a = evaluatePiece(wide, t).clip!;
      const b = evaluatePiece(thin, t).clip!;
      expect(a.x1).toBeCloseTo(left + head(t), 4);
      expect(a.x2 - a.x1).toBeCloseTo(46, 6);
      expect(b.x2 - b.x1).toBeCloseTo(10, 6);
      expect(b.x1).toBeCloseTo(left + head(t) - 60, 4);
    }
    // The stripes are 40 % taller than the badge each way and do not move with the badge.
    const a = evaluatePiece(wide, start + 200).clip!;
    expect(a.y2 - a.y1).toBeCloseTo(CAP_H * 1.8, 5);
  });

  test("the sparkle pops at the top-right corner: scale 0 to 1 to 0 with a quarter turn over 520 ms", () => {
    const star = piece(HERO_CUE, "star") as ShapePiece;
    const spark = piece(HERO_CUE, "spark") as ShapePiece;
    const start = hero.startMs + 330;
    const k = (t: number) => kf(t, [[start, 0], [start + 520 * 0.42, 1, "outBack"], [start + 520, 0, "in"]]);
    for (const t of [start + 40, start + 120, start + 218, start + 300, start + 450]) {
      const pose = evaluatePiece(star, t);
      expect(pose.sx).toBeCloseTo(k(t), 6);
      expect(pose.rz).toBeCloseTo(((t - start) / 520) * 90, 6);
      expect(pose.x).toBeCloseTo(evaluatePiece(star, start + 40).x, 6);
    }
    expect(evaluatePiece(spark, start + 218.4).o).toBeCloseTo(0.9, 2);
    expect(star.fill).toEqual({ colour: "#FFFFFF" });
    // The star hangs off the badge's top-right corner: the sheared top edge's right end, 0.2 of its size back, 0.28 up.
    const size = Math.max(70, CAP_H * 0.62);
    const width = 6 * 0.79 * 190;
    const lean = Math.tan((8 * Math.PI) / 180) * CAP_H * 0.5;
    const pose = evaluatePiece(star, start + 200);
    expect(pose.x).toBeCloseTo(540 - width / 2 + width + lean - size * 0.2, 4);
    expect(pose.y).toBeCloseTo(poseOf(HERO_CUE, "band0", start + 200).y - CAP_H / 2 - size * 0.28, 4);
    // Nothing shows before it starts or after it ends.
    expect(star.fromMs).toBeGreaterThan(start);
    expect(star.toMs).toBeLessThan(start + 520);
  });

  test("a support word rises 24 px and fades in over 220 ms, a tail word is drawn over the hero", () => {
    for (const name of ["w0", "w1", "w3"]) {
      const word = text(HERO_CUE, name);
      const spoken = cues[HERO_CUE]!.words[Number(name.slice(1))]!;
      const rest = evaluatePiece(word, spoken.startMs + 400).y;
      for (const t of [spoken.startMs - 70, spoken.startMs - 20, spoken.startMs + 40, spoken.startMs + 100, spoken.startMs + 150]) {
        const expected = chromeSupport(t, spoken.startMs);
        const pose = evaluatePiece(word, t);
        expect(pose.y).toBeCloseTo(rest + expected.rise, 5);
        expect(Math.abs(pose.o - expected.opacity)).toBeLessThan(0.021);
      }
    }
    expect(text(HERO_CUE, "w3").z).toBeGreaterThan(text(HERO_CUE, "band0").z);
    expect(text(HERO_CUE, "w0").z).toBeLessThan(text(HERO_CUE, "band0").z);
    // One soft shadow under every support word.
    expect(text(HERO_CUE, "w0").shadows).toEqual([{ dx: 0, dy: 3, blur: 7, colour: "#000000", alpha: 0.7 }]);
  });

  test("a cue without a hero is the support words at 64 px in the highlight colour's last word, with the glint over it only", () => {
    const plain = cuePieces(0);
    expect(plain.some((p) => p.id.includes(":band") || p.id.endsWith(":band0") || p.id.endsWith(":star"))).toBe(false);
    const last = text(0, "w3");
    expect(last.fill).toBe("#FFE9A8");
    expect(text(0, "w0").fill).toBe("#FFFFFF");
    const glints = plain.filter((p): p is TextPiece => p.id.includes(":glint"));
    expect(glints).toHaveLength(2);
    for (const glint of glints) expect([glint.text, glint.fill, glint.shadows]).toEqual(["different", "#FFFFFF", undefined]);
    // Four words that do not fit 900 px wrap greedily: the last one is on a second row.
    expect(evaluatePiece(last, 2000).y).toBeGreaterThan(evaluatePiece(text(0, "w0"), 2000).y);
    // The sweep starts 150 ms after the word and lasts 560 ms, or until the cue leaves (40 ms before its end).
    const start = cues[0]!.words[3]!.startMs + 150;
    expect([glints[0]!.fromMs, glints[0]!.toMs]).toEqual([start, Math.min(start + 560, cues[0]!.endMs - 40)]);
    const second = demoCues({ lines: ["only:m a:m moment:b@300"] }).cues;
    const lone = build(second).find((p) => p.id.includes(":glint0")) as TextPiece;
    expect(lone.toMs - lone.fromMs).toBeLessThanOrEqual(560);
  });

  test("a word wider than a row shrinks the support so it fits", () => {
    const long = demoCues({ lines: ["pneumonoultramicroscopicsilicovolcanoconiosis:b@400"] }).cues;
    const pieces = build(long);
    const word = pieces.find((p) => p.id.includes(":w0")) as TextPiece;
    expect(word.sizePx).toBeLessThan(64);
    expect(45 * 0.79 * word.sizePx + 0.01 * word.sizePx).toBeLessThanOrEqual(900.5);
  });

  test("a script that reaches past the cap box (Urdu) gets chrome over its whole ink, and a right-to-left cue reads from the right", () => {
    const tall: Measure = (value, face, size, ls) => ({ ...measure(value, face, size, ls), inkTop: -1.1 * size, inkBottom: 0.35 * size });
    const urdu = demoCues({ lines: ["یہ:m بہت:b اچھا:h@600 ہے:m"], language: "ur" }).cues;
    const pieces = chromeProgram.build(sceneInput(urdu, { measure: tall, anchor: ANCHOR })).pieces;
    const first = pieces.find((p) => p.id.endsWith(":band0")) as TextPiece;
    const last = pieces.find((p) => p.id.endsWith(":band9")) as TextPiece;
    const at = 600 + 350 + 600;
    const top = evaluatePiece(first, at).clip!.y1;
    const bottom = evaluatePiece(last, at).clip!.y2;
    // The ink box (1.1 em above the baseline, 0.35 below) plus the rim's reach (0.055 em) at either end.
    expect(bottom - top).toBeCloseTo((1.45 + 2 * 0.055) * first.sizePx, 4);
    // The lead row's two words: the first spoken one is on the right.
    const [a, b] = ["w0", "w1"].map((name) => evaluatePiece(pieces.find((p) => p.id.endsWith(`:${name}`)) as Piece, at).x);
    expect(a!).toBeGreaterThan(b!);
  });

  test("on a 16:9 canvas and a scaled preset the block keeps its proportions about the anchor", () => {
    const wide = chromeProgram.build(sceneInput(cues, { measure, canvas: { width: 1920, height: 1080 }, anchor: { xPct: 50, yPct: 67.2 } })).pieces;
    const rim = wide.find((p) => p.id === `chrome:${HERO_CUE}:band0`) as TextPiece;
    expect(rim.sizePx).toBe(190);
    expect(evaluatePiece(rim, hero.startMs + 700).x).toBeCloseTo(960, 3);
    const big = chromeProgram.build(sceneInput(cues, { measure, scale: 1.2, anchor: ANCHOR })).pieces.find((p) => p.id === `chrome:${HERO_CUE}:w0`) as TextPiece;
    expect(big.sizePx).toBeCloseTo(52 * 1.2, 6);
  });
});
