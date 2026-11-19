import { describe, expect, test } from "bun:test";
import {
  CAPTION_BEHIND,
  CAPTION_BLOCK,
  CAPTION_DYNAMIC_STYLES,
  type CaptionBlock,
  captionBlockRows,
  getCaptionPresetById,
} from "@narriflow/validators";
import {
  type CaptionBlockRect,
  captionBehindColumns,
  captionBehindPlacement,
  captionMatteColumnTop,
  layoutCaptionBlock,
  type MeasuredWord,
} from "./caption-block";

// The shared auto-placement rule for heroes behind the speaker (spec 5.12).

const CANVAS = { width: 1080, height: 1920 };
const DEPTH = CAPTION_DYNAMIC_STYLES.depth;
const preset = getCaptionPresetById("depth")!.preset;
const measure = (text: string): MeasuredWord => ({ advanceEm: 0.5 * text.length, inkTopEm: 0.72, inkBottomEm: 0 });

function depthLayout(liftPx?: number, yPct = 32) {
  const texts = ["the", "secret", "sauce"];
  const roles = ["minor", "hero", "body"] as const;
  const block: CaptionBlock = { style: "depth", roles, texts, keys: [null, null, null], rows: captionBlockRows(roles, [1, 1], DEPTH), seed: 0, behind: true };
  return layoutCaptionBlock({
    block, preset, style: DEPTH, words: texts.map(() => ({})), measured: texts.map(measure), canvas: CANVAS,
    anchor: { xPct: 50, yPct }, direction: "ltr", ...(liftPx === undefined ? {} : { liftPx }),
  });
}

/** A person whose head top is a flat line at `headY` across columns [left, right), canvas px. */
const flatHead = (heroInk: CaptionBlockRect, headY: number | null, left = 0, right = CANVAS.width) =>
  captionBehindColumns(heroInk).map((x) => (headY !== null && x >= left && x < right ? headY : null));

describe("captionBehindPlacement", () => {
  const rest = depthLayout();
  const heroInk = rest.heroInk!;

  test("the layout reports the hero's rest ink box, and the lift moves the whole block up", () => {
    expect(heroInk.height).toBeGreaterThan(100);
    const lifted = depthLayout(120);
    expect(lifted.heroInk!.y).toBeCloseTo(heroInk.y - 120, 6);
    expect(lifted.bounds.y).toBeCloseTo(rest.bounds.y - 120, 6);
    for (const [index, word] of lifted.words.entries()) expect(word.baselineY).toBeCloseTo(rest.words[index]!.baselineY - 120, 6);
    expect(lifted.shift.y).toBeCloseTo(rest.shift.y - 120, 6);
  });

  test("head low: nothing covers more than the bottom third, so the hero stays behind where it is", () => {
    const placement = captionBehindPlacement({ heroInk, bounds: rest.bounds, canvas: CANVAS, personTop: flatHead(heroInk, heroInk.y + 0.8 * heroInk.height) });
    expect(placement).toEqual({ behind: true, liftPx: 0 });
  });

  test("no person under the hero: behind, unmoved", () => {
    expect(captionBehindPlacement({ heroInk, bounds: rest.bounds, canvas: CANVAS, personTop: flatHead(heroInk, null) })).toEqual({ behind: true, liftPx: 0 });
  });

  test("head high: the block rises until the head covers exactly the bottom third", () => {
    const headY = heroInk.y + 0.2 * heroInk.height;
    const placement = captionBehindPlacement({ heroInk, bounds: rest.bounds, canvas: CANVAS, personTop: flatHead(heroInk, headY) });
    expect(placement.behind).toBe(true);
    const lifted = depthLayout(placement.liftPx);
    expect(lifted.heroInk!.y + (1 - CAPTION_BEHIND.maxCoveredFraction) * lifted.heroInk!.height).toBeCloseTo(headY, 6);
  });

  test("the highest column decides: a narrow head among empty columns still lifts the block", () => {
    const headY = heroInk.y + 0.3 * heroInk.height;
    const narrow = flatHead(heroInk, headY, 500, 580);
    expect(narrow.filter((top) => top !== null).length).toBeGreaterThan(0);
    expect(captionBehindPlacement({ heroInk, bounds: rest.bounds, canvas: CANVAS, personTop: narrow }).liftPx).toBeGreaterThan(0);
  });

  test("cannot fit inside the safe area: the hero is drawn in front, unmoved", () => {
    const placement = captionBehindPlacement({ heroInk, bounds: rest.bounds, canvas: CANVAS, personTop: flatHead(heroInk, 150) });
    expect(placement).toEqual({ behind: false, liftPx: 0 });
  });

  test("the largest allowed lift puts the block's reserved top exactly on the safe line", () => {
    const room = rest.bounds.y - CAPTION_BLOCK.safeArea.top * CANVAS.height;
    const headY = heroInk.y - room + (1 - CAPTION_BEHIND.maxCoveredFraction) * heroInk.height;
    const placement = captionBehindPlacement({ heroInk, bounds: rest.bounds, canvas: CANVAS, personTop: flatHead(heroInk, headY) });
    expect(placement.behind).toBe(true);
    expect(depthLayout(placement.liftPx).bounds.y).toBeCloseTo(CAPTION_BLOCK.safeArea.top * CANVAS.height, 6);
    expect(captionBehindPlacement({ heroInk, bounds: rest.bounds, canvas: CANVAS, personTop: flatHead(heroInk, headY - 2) }).behind).toBe(false);
  });
});

describe("captionMatteColumnTop", () => {
  test("reads the first row at the threshold in a canvas-space matte of any size and channel count", () => {
    const width = 54, height = 96;
    const data = new Uint8Array(width * height);
    for (let y = 48; y < height; y++) for (let x = 20; x < 30; x++) data[y * width + x] = 200;
    for (let x = 20; x < 30; x++) data[47 * width + x] = 100; // below the threshold
    expect(captionMatteColumnTop({ width, height, data }, CANVAS, 25 * 20)).toBe(960);
    expect(captionMatteColumnTop({ width, height, data }, CANVAS, 5 * 20)).toBeNull();
    const rgba = new Uint8Array(width * height * 4);
    for (let index = 0; index < width * height; index++) rgba[index * 4] = data[index]!;
    expect(captionMatteColumnTop({ width, height, data: rgba, channels: 4 }, CANVAS, 25 * 20)).toBe(960);
  });

  test("columns are spread evenly across the hero's ink", () => {
    const columns = captionBehindColumns({ x: 100, y: 0, width: 480, height: 10 });
    expect(columns.length).toBe(CAPTION_BEHIND.columns);
    expect(columns[0]).toBeCloseTo(105, 6);
    expect(columns.at(-1)).toBeCloseTo(575, 6);
  });
});
