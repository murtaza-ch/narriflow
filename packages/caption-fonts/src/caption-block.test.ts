import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  CAPTION_BLOCK,
  CAPTION_CUE_TILTS_DEG,
  CAPTION_DYNAMIC_STYLES,
  CAPTION_FIT_WIDTH_FRACTION,
  CAPTION_MOTIONS,
  type CaptionAnimation,
  type CaptionBlock,
  type CaptionDynamicStyle,
  type CaptionPresetInput,
  type CaptionWordRole,
  captionBlockRows,
  captionEntranceMs,
  captionPresetSchema,
  fnv1a32,
} from "@narriflow/validators";
import { type CaptionBlockLayoutInput, layoutCaptionBlock, type MeasuredWord, type PlacedWord } from "./caption-block";

const CANVAS = { width: 1080, height: 1920 };
const HEADLINE = CAPTION_DYNAMIC_STYLES.headline;
const S = 80;

/** Fake measurement: 0.5 em per letter, cap ink 0.7 em, descenders 0.2 em. */
function measure(text: string): MeasuredWord {
  return { advanceEm: 0.5 * Array.from(text).length, inkTopEm: 0.7, inkBottomEm: /[gjpqy]/.test(text) ? 0.2 : 0 };
}

interface Case {
  readonly texts: readonly string[];
  readonly roles: readonly CaptionWordRole[];
  readonly heroSpan?: readonly [number, number] | null;
  readonly seed?: number;
  readonly style?: CaptionDynamicStyle;
  readonly preset?: CaptionPresetInput;
  readonly anchor?: { xPct: number; yPct: number };
  readonly direction?: "ltr" | "rtl";
  readonly spaceBefore?: readonly (boolean | undefined)[];
  readonly canvas?: { width: number; height: number };
  readonly startSec?: readonly number[];
  readonly cueEndSec?: number;
}

function layout(input: Case) {
  const style = input.style ?? HEADLINE;
  const heroStart = input.roles.indexOf("hero");
  const heroSpan = input.heroSpan !== undefined
    ? input.heroSpan
    : heroStart < 0 ? null : [heroStart, input.roles.lastIndexOf("hero")] as const;
  const block: CaptionBlock = {
    style: "headline",
    roles: input.roles,
    texts: input.texts,
    keys: input.texts.map(() => null),
    rows: captionBlockRows(input.roles, heroSpan, style),
    seed: input.seed ?? 0,
  };
  const preset = captionPresetSchema.parse({
    dynamic: "headline", fontName: "Inter SemiBold", fontSize: S, textTransform: "none", outlineWidth: 0, animation: "slide",
    ...input.preset,
  });
  const layoutInput: CaptionBlockLayoutInput = {
    block,
    preset,
    style,
    words: input.texts.map((_, index) => {
      const spaceBefore = input.spaceBefore?.[index];
      const startSec = input.startSec?.[index];
      return { ...(spaceBefore === undefined ? {} : { spaceBefore }), ...(startSec === undefined ? {} : { startSec }) };
    }),
    measured: input.texts.map(measure),
    canvas: input.canvas ?? CANVAS,
    anchor: input.anchor ?? { xPct: 50, yPct: 50 },
    direction: input.direction ?? "ltr",
    ...(input.cueEndSec === undefined ? {} : { cueEndSec: input.cueEndSec }),
  };
  return { ...layoutCaptionBlock(layoutInput), block, measured: layoutInput.measured };
}

const advance = (word: PlacedWord, measured: MeasuredWord) => measured.advanceEm * word.px;
const inkTop = (word: PlacedWord, measured: MeasuredWord) => word.baselineY - measured.inkTopEm * word.px;
const inkBottom = (word: PlacedWord, measured: MeasuredWord) => word.baselineY + measured.inkBottomEm * word.px;

/** Rest ink box of the placed words (advance boxes horizontally, ink vertically). */
function inkBox(result: ReturnType<typeof layout>) {
  return {
    left: Math.min(...result.words.map((word) => word.baselineX)),
    right: Math.max(...result.words.map((word, index) => word.baselineX + advance(word, result.measured[index]!))),
    top: Math.min(...result.words.map((word, index) => inkTop(word, result.measured[index]!))),
    bottom: Math.max(...result.words.map((word, index) => inkBottom(word, result.measured[index]!))),
  };
}

const styleWith = (changes: Partial<CaptionDynamicStyle>): CaptionDynamicStyle => ({ ...HEADLINE, ...changes });
const smallMinor = styleWith({ roles: { ...HEADLINE.roles, minor: { ...HEADLINE.roles.minor, sizeEm: 0.75 } } });

describe("rule 1, sizes", () => {
  test("roles size as multiples of S; minor words take their own size", () => {
    const result = layout({ texts: ["the", "big", "deal"], roles: ["minor", "body", "body"], style: styleWith({ ...smallMinor, layout: "row", roles: { ...smallMinor.roles } }), heroSpan: [1, 1] });
    // No hero role here, so non-minor words take noHeroSizeEm.
    expect(result.words.map((word) => word.px)).toEqual([0.75 * S, HEADLINE.noHeroSizeEm * S, HEADLINE.noHeroSizeEm * S]);
  });

  test("with a hero, body and minor words keep their role sizes", () => {
    const result = layout({ texts: ["the", "BEST", "part"], roles: ["minor", "hero", "body"], style: smallMinor });
    expect(result.words[0]!.px).toBe(0.75 * S);
    expect(result.words[2]!.px).toBe(S);
  });

  test("Headline draws minor words at body size", () => {
    const result = layout({ texts: ["with", "Accurate", "captions"], roles: ["minor", "hero", "body"] });
    expect(result.words[0]!.px).toBe(result.words[2]!.px);
  });
});

describe("rule 2, gaps", () => {
  test("adjacent words are wordGapEm times the larger size apart", () => {
    // No hero: minor words at 0.75 S, the others at noHeroSizeEm, so each gap follows the larger word.
    const result = layout({ texts: ["the", "big", "deal"], roles: ["minor", "body", "body"], style: smallMinor });
    const [first, second, third] = result.words;
    expect(first!.px).toBeLessThan(second!.px);
    expect(second!.baselineX - (first!.baselineX + advance(first!, result.measured[0]!))).toBeCloseTo(CAPTION_BLOCK.wordGapEm * second!.px, 9);
    expect(third!.baselineX - (second!.baselineX + advance(second!, result.measured[1]!))).toBeCloseTo(CAPTION_BLOCK.wordGapEm * third!.px, 9);
  });

  test("a word with spaceBefore false joins the previous word", () => {
    const result = layout({ texts: ["今日", "は", "晴れ"], roles: ["body", "body", "body"], spaceBefore: [undefined, false, false] });
    const [first, second] = result.words;
    expect(second!.baselineX).toBeCloseTo(first!.baselineX + advance(first!, result.measured[0]!), 9);
  });

  test("tile styles add their padding to the gap", () => {
    const tiled = styleWith({ layout: "row", tile: { fill: { hero: "accent", body: "#16161A", minor: "#F4B6D2" }, tiltsDeg: [0], radiusEm: 0.05, padXEm: 0.12, padYEm: 0.08, gapEm: 0.08, shadowEm: 3 / 84 } });
    const result = layout({ texts: ["keep", "it"], roles: ["body", "minor"], style: tiled, heroSpan: null });
    const [first, second] = result.words;
    const px = HEADLINE.noHeroSizeEm * S;
    // The tile gap replaces the word gap, and each tile's padding is added on its side.
    expect(second!.baselineX - (first!.baselineX + advance(first!, result.measured[0]!)))
      .toBeCloseTo(0.08 * px + 0.12 * px + 0.12 * S, 9);
  });

  test("tiles keep their gap between words joined without a space", () => {
    const tiled = styleWith({ layout: "row", tile: { fill: { hero: "accent", body: "#16161A", minor: "#F4B6D2" }, tiltsDeg: [0], radiusEm: 0.05, padXEm: 0.12, padYEm: 0.08, gapEm: 0.08, shadowEm: 0 } });
    const result = layout({ texts: ["今日", "は"], roles: ["body", "body"], style: tiled, heroSpan: null, spaceBefore: [undefined, false] });
    const [first, second] = result.words;
    const px = HEADLINE.noHeroSizeEm * S;
    expect(second!.baselineX - (first!.baselineX + advance(first!, result.measured[0]!))).toBeCloseTo((0.08 + 0.24) * px, 9);
  });
});

describe("rule 3, hero fill", () => {
  test("the hero row fills the style's share of the frame width", () => {
    const result = layout({ texts: ["with", "Accurate", "captions"], roles: ["minor", "hero", "body"] });
    const hero = result.words[1]!;
    expect(advance(hero, result.measured[1]!)).toBeCloseTo(0.8 * CANVAS.width, 9);
    expect(result.scale).toBe(1);
  });

  test("a 2-word hero fills with its gap and the stroke at both ends", () => {
    const result = layout({ texts: ["got", "1", "million", "views"], roles: ["body", "hero", "hero", "body"], preset: { outlineWidth: 4 } });
    const [, one, million] = result.words;
    const stroke = (4 / S) * one!.px;
    const width = million!.baselineX + advance(million!, result.measured[2]!) - one!.baselineX + 2 * stroke;
    expect(width).toBeCloseTo(0.8 * CANVAS.width, 9);
    expect(million!.baselineX - (one!.baselineX + advance(one!, result.measured[1]!))).toBeCloseTo(CAPTION_BLOCK.wordGapEm * one!.px, 9);
  });

  test("the hero size is clamped to [minEm, maxEm] × S, then multiplied by emphasisScale", () => {
    const short = layout({ texts: ["so", "OK", "then"], roles: ["minor", "hero", "minor"] });
    expect(short.words[1]!.px).toBe(3.4 * S);
    const scaled = layout({ texts: ["so", "OK", "then"], roles: ["minor", "hero", "minor"], preset: { emphasisScale: 0.8 } });
    expect(scaled.words[1]!.px).toBeCloseTo(3.4 * S * 0.8, 9);
    const long = layout({ texts: ["it", "abcdefghijklmnop"], roles: ["minor", "hero"] });
    // 8 em at the 2.2 S floor is wider than the fit width, so the fit scale applies on top.
    expect(long.words[1]!.px).toBeCloseTo(2.2 * S * long.scale, 9);
    expect(long.scale).toBeCloseTo((CAPTION_FIT_WIDTH_FRACTION * CANVAS.width) / (8 * 2.2 * S), 9);
  });
});

describe("rule 4, row pitch from measured ink", () => {
  test("ink-to-ink gaps between rows equal rowGapEm × S, whatever the sizes", () => {
    const result = layout({ texts: ["you", "will", "never", "guess"], roles: ["minor", "minor", "hero", "body"] });
    const rowGap = HEADLINE.rowGapEm * S;
    const rows = result.block.rows;
    for (let k = 1; k < rows.length; k++) {
      const upper = Math.max(...rows[k - 1]!.map((index) => inkBottom(result.words[index]!, result.measured[index]!)));
      const lower = Math.min(...rows[k]!.map((index) => inkTop(result.words[index]!, result.measured[index]!)));
      expect(lower - upper).toBeCloseTo(rowGap, 9);
    }
  });

  test("a negative rowGapEm overlaps rows by that much ink, and stroke counts as ink", () => {
    const style = styleWith({ rowGapEm: -0.1 });
    const result = layout({ texts: ["the", "BEST"], roles: ["minor", "hero"], style, preset: { outlineWidth: 5 } });
    const [lead, hero] = result.words;
    const strokeLead = (5 / S) * lead!.px;
    const strokeHero = (5 / S) * hero!.px;
    const gap = (inkTop(hero!, result.measured[1]!) - strokeHero) - (inkBottom(lead!, result.measured[0]!) + strokeLead);
    expect(gap).toBeCloseTo(-0.1 * S, 9);
  });
});

describe("rules 5 and 6, row x and stagger", () => {
  const staggered = styleWith({ staggerEm: 0.25 });
  const rowCentre = (result: ReturnType<typeof layout>, row: readonly number[]) => {
    const left = Math.min(...row.map((index) => result.words[index]!.baselineX));
    const right = Math.max(...row.map((index) => result.words[index]!.baselineX + advance(result.words[index]!, result.measured[index]!)));
    return (left + right) / 2;
  };

  test("lead and tail rows shift in opposite directions from the seed; the hero row stays centred", () => {
    for (const [seed, sign] of [[2, 1], [3, -1]] as const) {
      const result = layout({ texts: ["the", "BEST", "part"], roles: ["minor", "hero", "body"], style: staggered, seed });
      const [lead, hero, tail] = result.block.rows.map((row) => rowCentre(result, row));
      const shift = 0.25 * S;
      expect(lead! - hero!).toBeCloseTo(sign * shift, 9);
      expect(tail! - hero!).toBeCloseTo(-sign * shift, 9);
      expect(result.words.map((word) => word.motionSign)).toEqual([sign, sign, -sign]);
    }
  });

  test("a hero on row 0 keeps the seed's sign and the tail takes the opposite", () => {
    const result = layout({ texts: ["BEST", "part", "ever"], roles: ["hero", "body", "body"], style: staggered, seed: 4 });
    expect(result.words.map((word) => word.motionSign)).toEqual([1, -1, -1]);
  });

  test("RTL rows read in bidi visual order: the first word is rightmost", () => {
    const result = layout({ texts: ["یہ", "بہت", "اچھا"], roles: ["body", "body", "body"], direction: "rtl" });
    const xs = result.words.map((word) => word.baselineX);
    expect(xs[0]!).toBeGreaterThan(xs[1]!);
    expect(xs[1]!).toBeGreaterThan(xs[2]!);
  });
});

/** The safe area of a canvas, px. */
const safeArea = (canvas: { width: number; height: number }) => ({
  left: CAPTION_BLOCK.safeArea.left * canvas.width,
  right: CAPTION_BLOCK.safeArea.right * canvas.width,
  top: CAPTION_BLOCK.safeArea.top * canvas.height,
  bottom: CAPTION_BLOCK.safeArea.bottom * canvas.height,
});

function expectInsideSafeArea(result: ReturnType<typeof layout>, canvas = CANVAS) {
  const safe = safeArea(canvas);
  const { x, y, width, height } = result.bounds;
  expect(x).toBeGreaterThanOrEqual(safe.left - 1e-6);
  expect(x + width).toBeLessThanOrEqual(safe.right + 1e-6);
  expect(y).toBeGreaterThanOrEqual(safe.top - 1e-6);
  expect(y + height).toBeLessThanOrEqual(safe.bottom + 1e-6);
}

describe("rule 7, fit", () => {
  test("one scale for the whole block keeps the hierarchy", () => {
    const result = layout({ texts: ["abcdefghijkl", "mnopqrstuvwx", "ABCDEFGH"], roles: ["body", "body", "hero"] });
    // The lead row (12.232 em at S) enters 0.18 em from the left, so its envelope is 12.412 em wide.
    expect(result.scale).toBeCloseTo((CAPTION_FIT_WIDTH_FRACTION * CANVAS.width) / (12.412 * S), 9);
    const lead = result.block.rows[0]!;
    const width = result.words[lead[1]!]!.baselineX + advance(result.words[lead[1]!]!, result.measured[lead[1]!]!) - result.words[lead[0]!]!.baselineX;
    expect(width).toBeCloseTo(12.232 * S * result.scale, 9);
    expect(result.words[0]!.px).toBeCloseTo(S * result.scale, 9);
    // The hero filled 80% of the width before the block scaled down with everything else.
    expect(advance(result.words[2]!, result.measured[2]!)).toBeCloseTo(0.8 * CANVAS.width * result.scale, 9);
    expect(result.bounds.width).toBeCloseTo(CAPTION_FIT_WIDTH_FRACTION * CANVAS.width, 9);
    expectInsideSafeArea(result);
  });

  test("a punch hero's entrance scale counts: the filled hero shrinks until 1.45× of it fits", () => {
    const result = layout({ texts: ["with", "Accurate", "captions"], roles: ["minor", "hero", "body"], preset: { animation: "punch" } });
    // Resting, the hero fills 864 px; at its 1.45 entrance scale it would span 1252.8 px.
    expect(result.scale).toBeCloseTo((CAPTION_FIT_WIDTH_FRACTION * CANVAS.width) / (0.8 * CANVAS.width * 1.45), 9);
    expect(advance(result.words[1]!, result.measured[1]!) * 1.45).toBeCloseTo(CAPTION_FIT_WIDTH_FRACTION * CANVAS.width, 9);
    expectInsideSafeArea(result);
  });

  test("a long slide row's sideways travel stays inside the safe width", () => {
    for (const seed of [0, 1]) {
      const result = layout({ texts: ["abcdefghijkl", "mnopqrstuvwx", "OK"], roles: ["body", "body", "hero"], seed });
      expectInsideSafeArea(result);
      const safe = safeArea(CANVAS);
      const [first, second] = result.words;
      const travel = 0.18 * first!.px;
      // Sign +1 enters from the left, sign −1 from the right; either way the first frame is inside.
      expect(first!.baselineX - (first!.motionSign === 1 ? travel : 0)).toBeGreaterThanOrEqual(safe.left - 1e-6);
      expect(second!.baselineX + advance(second!, result.measured[1]!) + (second!.motionSign === -1 ? travel : 0)).toBeLessThanOrEqual(safe.right + 1e-6);
    }
  });

  test("a short frame fits the block's height into the safe area too", () => {
    for (const canvas of [{ width: 1920, height: 1080 }, { width: 1080, height: 1080 }]) {
      // A large preset size: the 3.4 S hero, punched to 1.45×, over two rows is taller than 72% of 1080.
      const tall = layout({ texts: ["so", "OK", "then"], roles: ["minor", "hero", "minor"], preset: { animation: "punch", fontSize: 200 }, canvas });
      expect(tall.scale).toBeLessThan(1);
      expect(tall.bounds.height).toBeCloseTo(0.72 * canvas.height, 6);
      expect(tall.bounds.width).toBeLessThan(CAPTION_FIT_WIDTH_FRACTION * canvas.width);
      expectInsideSafeArea(tall, canvas);
      const wide = layout({ texts: ["you", "will", "never", "guess", "this"], roles: ["minor", "minor", "hero", "body", "body"], preset: { animation: "punch", fontSize: 150 }, canvas });
      expectInsideSafeArea(wide, canvas);
    }
  });
});

describe("duration cap (spec 5.7)", () => {
  const slideHeroMs = captionEntranceMs(CAPTION_MOTIONS.slide.hero);
  const slideWordMs = captionEntranceMs(CAPTION_MOTIONS.slide.word);

  test("in a short cue the hero's entrance has finished by the tail's onset", () => {
    const result = layout({ texts: ["the", "BEST", "part"], roles: ["minor", "hero", "body"], startSec: [0, 0.08, 0.16], cueEndSec: 0.4 });
    const [lead, hero, tail] = result.words;
    expect(0.08 + (hero!.entranceTimeScale * slideHeroMs) / 1000).toBeLessThanOrEqual(0.16 + 1e-9);
    expect(hero!.entranceTimeScale).toBeCloseTo(80 / slideHeroMs, 9);
    expect(lead!.entranceTimeScale).toBeCloseTo(80 / slideWordMs, 9);
    // The last word has no next onset; 45% of its 240 ms covers the 90 ms entrance.
    expect(tail!.entranceTimeScale).toBe(1);
  });

  test("the last word uses only the cue time left, and under 100 ms left it is settled", () => {
    const result = layout({ texts: ["the", "BEST"], roles: ["minor", "hero"], startSec: [0, 0.2], cueEndSec: 0.4 });
    expect(result.words[1]!.entranceTimeScale).toBeCloseTo((0.45 * 200) / slideHeroMs, 9);
    const late = layout({ texts: ["the", "BEST"], roles: ["minor", "hero"], startSec: [0, 0.35], cueEndSec: 0.4 });
    expect(late.words[1]!.entranceTimeScale).toBe(0);
  });

  test("without word times the entrance plays in full", () => {
    const result = layout({ texts: ["the", "BEST"], roles: ["minor", "hero"] });
    expect(result.words.map((word) => word.entranceTimeScale)).toEqual([1, 1]);
  });
});

describe("rule 8, anchor", () => {
  test("centre styles put the rest ink box centre on the anchor", () => {
    const result = layout({ texts: ["the", "BEST", "part"], roles: ["minor", "hero", "body"], anchor: { xPct: 45, yPct: 45 } });
    const box = inkBox(result);
    expect((box.left + box.right) / 2).toBeCloseTo(0.45 * CANVAS.width, 9);
    expect((box.top + box.bottom) / 2).toBeCloseTo(0.45 * CANVAS.height, 9);
  });

  test("left styles put the block's left edge on the anchor and left-align rows", () => {
    const left = styleWith({ align: "left", leftGuidePct: 8 });
    const result = layout({ texts: ["the", "BEST", "part"], roles: ["minor", "hero", "body"], style: left, anchor: { xPct: 10, yPct: 50 } });
    for (const word of result.words) expect(word.baselineX).toBeCloseTo(0.1 * CANVAS.width, 9);
    const box = inkBox(result);
    expect((box.top + box.bottom) / 2).toBeCloseTo(0.5 * CANVAS.height, 9);
  });

  test("left styles mirror to the right edge for an RTL cue", () => {
    const left = styleWith({ align: "left", leftGuidePct: 8 });
    const result = layout({ texts: ["یہ", "بہت", "اچھا"], roles: ["minor", "hero", "body"], style: left, direction: "rtl", anchor: { xPct: 10, yPct: 50 } });
    for (const [index, word] of result.words.entries()) {
      expect(word.baselineX + advance(word, result.measured[index]!)).toBeCloseTo(0.9 * CANVAS.width, 9);
    }
  });
});

describe("rule 9, safe area", () => {
  test("the block shifts up so its bounds, including the hero's rising travel, end at 82%", () => {
    // The hero is the last row and has no descender, so its 0.12 em start below rest reaches lowest.
    const result = layout({ texts: ["with", "ACCURATE"], roles: ["minor", "hero"], anchor: { xPct: 50, yPct: 95 } });
    const bottom = result.bounds.y + result.bounds.height;
    expect(bottom).toBeCloseTo(0.82 * CANVAS.height, 9);
    const hero = result.words[1]!;
    expect(bottom - inkBox(result).bottom).toBeCloseTo(0.12 * hero.px, 9);
    // The shift is reported, so the Studio can store a dragged block where it is drawn.
    const unshifted = layout({ texts: ["with", "ACCURATE"], roles: ["minor", "hero"], anchor: { xPct: 50, yPct: 50 } });
    expect(result.shift.x).toBe(0);
    expect(result.shift.y).toBeCloseTo(result.bounds.y - (unshifted.bounds.y + 0.45 * CANVAS.height), 9);
    expect(result.shift.y).toBeLessThan(0);
  });

  test("reserved sideways travel keeps a left style's entering words inside 6%", () => {
    const left = styleWith({ align: "left", leftGuidePct: 8 });
    const result = layout({ texts: ["the", "BEST", "part"], roles: ["minor", "hero", "body"], style: left, seed: 0, anchor: { xPct: 6, yPct: 50 } });
    // Row 0 has sign +1, so its words enter from 0.18 em to the left of rest.
    expect(result.words[0]!.motionSign).toBe(1);
    expect(result.bounds.x).toBeCloseTo(0.06 * CANVAS.width, 9);
    expect(result.words[0]!.baselineX).toBeCloseTo(0.06 * CANVAS.width + 0.18 * S, 9);
  });

  test("a block inside the safe area is not moved", () => {
    const result = layout({ texts: ["with", "Accurate", "captions"], roles: ["minor", "hero", "body"], anchor: { xPct: 50, yPct: 50 } });
    expect(result.bounds.y).toBeGreaterThan(0.1 * CANVAS.height);
    expect(result.bounds.y + result.bounds.height).toBeLessThan(0.82 * CANVAS.height);
    const box = inkBox(result);
    expect((box.top + box.bottom) / 2).toBeCloseTo(0.5 * CANVAS.height, 9);
    expect(result.shift).toEqual({ x: 0, y: 0 });
  });
});

describe("rule 10, rotation", () => {
  const tiled = styleWith({
    layout: "row",
    tile: { fill: { hero: "accent", body: "#16161A", minor: "#F4B6D2" }, tiltsDeg: [-2, 1.5, -1, 2], radiusEm: 0.05, padXEm: 0.12, padYEm: 0.08, gapEm: 0.08, shadowEm: 3 / 84 },
  });
  const words = { texts: ["keep", "it", "short"], roles: ["body", "minor", "body"] as const, style: tiled, heroSpan: null, seed: 5 };

  test("rotation is the block tilt plus the word's tile tilt", () => {
    const result = layout({ ...words, preset: { animation: "bounce" as CaptionAnimation } });
    const blockTilt = CAPTION_CUE_TILTS_DEG[5 % 4]!;
    expect(result.words.map((word) => word.rotationDeg)).toEqual([0, 1, 2].map((index) => blockTilt + tiled.tile!.tiltsDeg[(index + 5) % 4]!));
  });

  test("the block tilt turns word centres about the block centre", () => {
    const flat = layout({ ...words, preset: { animation: "fade" as CaptionAnimation } });
    const tilted = layout({ ...words, preset: { animation: "bounce" as CaptionAnimation } });
    const theta = (CAPTION_CUE_TILTS_DEG[5 % 4]! * Math.PI) / 180;
    const cx = CANVAS.width / 2;
    const cy = CANVAS.height / 2;
    flat.words.forEach((word, index) => {
      const x = word.centerX - cx;
      const y = word.centerY - cy;
      expect(tilted.words[index]!.centerX).toBeCloseTo(cx + x * Math.cos(theta) - y * Math.sin(theta), 6);
      expect(tilted.words[index]!.centerY).toBeCloseTo(cy + x * Math.sin(theta) + y * Math.cos(theta), 6);
      expect(flat.words[index]!.rotationDeg).toBe(tiled.tile!.tiltsDeg[(index + 5) % 4]!);
    });
  });

  test("baselines are given in the word's own frame around its centre", () => {
    const result = layout({ ...words, preset: { animation: "bounce" as CaptionAnimation } });
    result.words.forEach((word, index) => {
      const measured = result.measured[index]!;
      expect(word.centerX - word.baselineX).toBeCloseTo(advance(word, measured) / 2, 9);
      expect(word.baselineY - word.centerY).toBeCloseTo(((measured.inkTopEm - measured.inkBottomEm) / 2) * word.px, 9);
    });
  });
});

describe("tiles", () => {
  const CUTOUT = CAPTION_DYNAMIC_STYLES.cutout;
  const cutout = (texts: readonly string[], roles: readonly CaptionWordRole[], preset: CaptionPresetInput = {}) =>
    layout({ texts, roles, style: CUTOUT, heroSpan: null, seed: 1, preset: { animation: "drop", fontSize: 84, ...preset } });

  test("each word's tile spans its advance plus padding and its row's ink plus padding", () => {
    // "keep" has a descender, so the whole row's tiles reach down to it.
    const result = cutout(["AND", "keep", "IT"], ["minor", "body", "minor"]);
    const px = 84;
    for (const [index, word] of result.words.entries()) {
      const measured = result.measured[index]!;
      const tile = word.tile!;
      expect(tile.width).toBeCloseTo(advance(word, measured) + 2 * 0.12 * px, 9);
      expect(tile.height).toBeCloseTo((0.7 + 0.2) * px + 2 * 0.08 * px, 9);
      expect(tile.centerX).toBeCloseTo(word.centerX, 9);
      // Top of the tile, in the word's own frame: the row's ink top plus the padding above it.
      expect(tile.centerY - tile.height / 2).toBeCloseTo(word.baselineY - 0.7 * px - 0.08 * px, 9);
      expect(tile.radius).toBeCloseTo(0.05 * px, 9);
      expect(tile.shadowOffset).toBeCloseTo(3, 9);
    }
  });

  test("words turn by the tile tilts, offset by the seed", () => {
    const result = cutout(["AND", "I", "KEEP", "IT", "SHORT"], ["minor", "minor", "body", "minor", "body"]);
    expect(result.words.map((word) => word.rotationDeg)).toEqual([1.5, -1, 2, -2, 1.5]);
  });

  test("the reserved bounds hold every turned tile, its shadow and the drop", () => {
    const result = cutout(["AND", "I", "KEEP", "IT", "SHORT"], ["minor", "minor", "body", "minor", "body"]);
    const bounds = result.bounds;
    for (const word of result.words) {
      const tile = word.tile!;
      // Tile corners plus the shadow, turned about the word centre, as far as the drop's -4 degrees.
      for (const extra of [0, -4]) {
        const theta = ((word.rotationDeg + extra) * Math.PI) / 180;
        for (const x of [-tile.width / 2, tile.width / 2 + tile.shadowOffset]) {
          for (const y of [tile.centerY - word.centerY - tile.height / 2, tile.centerY - word.centerY + tile.height / 2 + tile.shadowOffset]) {
            const cx = word.centerX + x * Math.cos(theta) - y * Math.sin(theta);
            const cy = word.centerY + x * Math.sin(theta) + y * Math.cos(theta);
            expect(cx).toBeGreaterThanOrEqual(bounds.x - 1e-9);
            expect(cx).toBeLessThanOrEqual(bounds.x + bounds.width + 1e-9);
            expect(cy).toBeGreaterThanOrEqual(bounds.y - 0.2 * word.px - 1e-9);
            expect(cy).toBeLessThanOrEqual(bounds.y + bounds.height + 1e-9);
          }
        }
      }
    }
  });

  test("styles without tiles place none", () => {
    expect(layout({ texts: ["the", "BEST"], roles: ["minor", "hero"] }).words.every((word) => word.tile === null)).toBe(true);
  });
});

describe("scale origin", () => {
  test("is the middle of the line box when the painter reports one, else the word centre", () => {
    const plain = layout({ texts: ["the", "BEST"], roles: ["minor", "hero"] });
    for (const word of plain.words) {
      expect(word.scaleOriginX).toBe(word.centerX);
      expect(word.scaleOriginY).toBe(word.centerY);
    }
  });

  test("slam's hero growth is reserved about the scale origin", () => {
    const result = layout({ texts: ["the", "BEST", "part"], roles: ["minor", "hero", "body"], preset: { animation: "slam" } });
    const hero = result.words[1]!;
    const measured = result.measured[1]!;
    const halfW = (advance(hero, measured) / 2) * 1.25;
    expect(result.bounds.x).toBeLessThanOrEqual(hero.centerX - halfW + 1e-9);
    expect(result.bounds.x + result.bounds.width).toBeGreaterThanOrEqual(hero.centerX + halfW - 1e-9);
  });
});

describe("seeds and stability", () => {
  test("the same block lays out identically every time", () => {
    const input = { texts: ["the", "BEST", "part"], roles: ["minor", "hero", "body"] as const, style: styleWith({ staggerEm: 0.2 }), seed: fnv1a32("1250") };
    expect(layout(input).words).toEqual(layout(input).words);
  });

  test("decorations are empty in phase 1", () => {
    expect(layout({ texts: ["the", "BEST"], roles: ["minor", "hero"] }).decorations).toEqual([]);
  });
});

test("the caption-block import graph has no node: modules", async () => {
  const entry = resolve(import.meta.dir, "caption-block.ts");
  const code = `const result = await Bun.build({ entrypoints: [${JSON.stringify(entry)}], target: "browser", write: false, metafile: true });
    if (!result.success) { console.error(result.logs); process.exit(1); }
    const imports = Object.values(result.metafile.inputs).flatMap((input) => input.imports.map((entry) => entry.path));
    console.log(JSON.stringify(imports.filter((path) => path.startsWith("node:") || /^(fs|path|os|crypto|child_process)$/.test(path))));`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", code], {
    cwd: resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual([]);
}, 30_000);
