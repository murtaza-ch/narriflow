import { describe, expect, test } from "bun:test";
import { type CaptionEmojiArt, loadCaptionEmojiArt } from "@narriflow/caption-emoji/art";
import { CAPTION_EMOJI_BOX, CAPTION_EMOJI_GRID } from "@narriflow/caption-emoji/draw";
import { evaluatePiece, pieceBounds, type ShapePiece } from "../scene";
import { pathBounds } from "../shapes";
import { fakeMeasure } from "../test-support";
import { CAPTION_CUE_TILTS_DEG, CAPTION_MOTIONS, type CaptionAnimationName, captionDynamicStyle, getCaptionPresetById } from "@narriflow/validators";
import { blockCueBox, type CaptionEmojiCueBox, captionBlockCueBox, classicLineCueBox, lineCueBox } from "./cue-box";
import { CAPTION_EMOJI_SHADOW_OFFSET } from "./drawing";
import {
  CAPTION_EMOJI_BADGE_SCALE,
  CAPTION_EMOJI_LATE_HOLD_MS,
  CAPTION_EMOJI_LATE_MIN_MS,
  CAPTION_EMOJI_MAX_HOLD_MS,
  CAPTION_EMOJI_MIN_HOLD_MS,
  CAPTION_EMOJI_MIN_SHOWN_MS,
  CAPTION_EMOJI_PIECE_CAP,
  CAPTION_EMOJI_TILT_DEG,
  type CaptionEmojiLayerInput,
  buildCaptionEmojiPieces,
  captionEmojiLayerKey,
  captionEmojiSizePx,
  placeCaptionEmojis,
} from "./layer";
import { captionSceneDemo } from "../registry";
import { captionEmojiSides } from "./placement";
import { placementScene } from "./placement-support";
import { CAPTION_EMOJI_FADE_MS, CAPTION_EMOJI_LEAVE_SCALE, CAPTION_EMOJI_POP_FROM, CAPTION_EMOJI_POP_MS, CAPTION_EMOJI_QUICK_FROM, CAPTION_EMOJI_QUICK_MS } from "./timing";

const art = await loadCaptionEmojiArt(["rocket", "thumbs-up", "astronaut", "heart-eyes"]);
/** "hundred" fits above a tall cue near the top where "flame" never does (the late-emoji test). */
const bigArt = await loadCaptionEmojiArt(["hundred", "flame"]);
const CANVAS = { width: 1080, height: 1920 };
const sceneArt = await loadCaptionEmojiArt(["party"]);

function cue(overrides: Partial<CaptionEmojiCueBox> = {}): CaptionEmojiCueBox {
  return { cueIndex: 0, box: { x1: 240, y1: 1200, x2: 840, y2: 1290 }, fromMs: 1000, toMs: 3000, bodyPx: 80, tiltDeg: 0, direction: "ltr", ...overrides };
}

function input(overrides: Partial<CaptionEmojiLayerInput> = {}): CaptionEmojiLayerInput {
  return {
    cueBoxes: [cue()],
    emojis: [{ cueIndex: 0, id: "rocket", atMs: 1200 }],
    art,
    style: { palette: { a: "#ffe45c", b: "#ff4f9a", c: "#ffffff" }, size: 1, position: "auto", sticker: true, shadowColour: "#000000", slot: "above" },
    canvas: CANVAS,
    anchorYPct: 67,
    ...overrides,
  };
}

const placed = (layer: CaptionEmojiLayerInput) => placeCaptionEmojis(layer).flatMap((outcome) => (outcome.placed ? [outcome] : []));
const windowOf = (pieces: readonly ShapePiece[]) => [pieces[0]!.fromMs, pieces[0]!.toMs];

describe("emoji pieces", () => {
  test("a sticker is its shadow, its white outline, then its colour layers, all with ids emoji:<cue>:<n>:<layer>", () => {
    const pieces = buildCaptionEmojiPieces(input());
    const layers = art.get("rocket")!.layers.length;
    expect(pieces.map((piece) => piece.id)).toEqual(["emoji:0:0:shadow", "emoji:0:0:outline", ...Array.from({ length: layers }, (_, index) => `emoji:0:0:${index}`)]);
    expect(pieces[0]!.fill!.colour).toBe("#000000");
    expect(pieces[1]!.fill!.colour).toBe("#FFFFFF");
    // The occlusion test's word-face pattern (`<scene>:<cue>:w<n>`) cannot match an emoji piece.
    for (const piece of pieces) expect(/^[a-z]+:\d+:w\d+(?:l\d+)?$/.test(piece.id)).toBe(false);
  });

  test("flat draws the colour layers only", () => {
    const pieces = buildCaptionEmojiPieces(input({ style: { ...input().style, sticker: false } }));
    expect(pieces.map((piece) => piece.id.split(":")[3])).toEqual(art.get("rocket")!.layers.map((_, index) => String(index)));
  });

  test("every piece of one emoji shares one drawing box, centred on its pivot, so libass aligns and scales them as one", () => {
    const [emoji] = placed(input());
    const boxes = emoji!.pieces.map((piece) => pathBounds(piece.path));
    for (const box of boxes) expect(box).toEqual(boxes[0]!);
    const side = boxes[0]!.x2 - boxes[0]!.x1;
    expect(boxes[0]!.x1).toBe(0);
    expect(boxes[0]!.y1).toBe(0);
    for (const piece of emoji!.pieces) expect(piece.origin).toEqual({ dx: side / 2, dy: side / 2 });
    // The box is the art's box grown by the shadow's reach, so it holds every point of the outline moved by the shadow.
    const k = captionEmojiSizePx(80, 1, CANVAS) / CAPTION_EMOJI_GRID;
    expect(side).toBeCloseTo((CAPTION_EMOJI_BOX.width + 2 * CAPTION_EMOJI_SHADOW_OFFSET * CAPTION_EMOJI_GRID * Math.SQRT2) * k, 6);
    for (const piece of emoji!.pieces) {
      const drawn = pathBounds(piece.path.slice(2));
      expect(drawn.x1).toBeGreaterThanOrEqual(0);
      expect(drawn.y1).toBeGreaterThanOrEqual(0);
      expect(drawn.x2).toBeLessThanOrEqual(side);
      expect(drawn.y2).toBeLessThanOrEqual(side);
    }
  });

  test("on the pop every layer has the same pose at every sampled time", () => {
    const [emoji] = placed(input());
    const [from, to] = windowOf(emoji!.pieces);
    for (let t = from!; t < to!; t += 7) {
      const poses = emoji!.pieces.map((piece) => evaluatePiece(piece, t));
      for (const pose of poses) expect({ ...pose, colour: "" }).toEqual({ ...poses[0]!, colour: "" });
    }
    const first = evaluatePiece(emoji!.pieces[0]!, from!);
    expect(first.sx).toBeCloseTo(CAPTION_EMOJI_POP_FROM, 6);
    expect(evaluatePiece(emoji!.pieces[0]!, from! + CAPTION_EMOJI_POP_MS * 0.6).sx).toBeGreaterThan(1);
    expect(evaluatePiece(emoji!.pieces[0]!, from! + CAPTION_EMOJI_POP_MS).sx).toBe(1);
    expect(evaluatePiece(emoji!.pieces[0]!, to! - CAPTION_EMOJI_FADE_MS).o).toBe(1);
    expect(evaluatePiece(emoji!.pieces[0]!, to! - CAPTION_EMOJI_FADE_MS / 2).o).toBeCloseTo(0.5, 1);
  });

  test("the shadow falls down and to the right on screen whatever the tilt", () => {
    for (const order of [0, 1]) {
      const emojis = [{ cueIndex: 0, id: "rocket", atMs: 1200 }, { cueIndex: 1, id: "rocket", atMs: 4200 }];
      const outcome = placed(input({ emojis, cueBoxes: [cue(), cue({ cueIndex: 1, fromMs: 4000, toMs: 6000 })] }))[order]!;
      const [shadow, outline] = outcome.pieces;
      const t = shadow!.toMs - 200;
      const a = pieceBounds({ ...shadow!, path: shadow!.path.slice(2) }, t, fakeMeasure)!;
      const b = pieceBounds({ ...outline!, path: outline!.path.slice(2) }, t, fakeMeasure)!;
      const offset = CAPTION_EMOJI_SHADOW_OFFSET * captionEmojiSizePx(80, 1, CANVAS);
      expect(a.x1 - b.x1).toBeCloseTo(offset, 0);
      expect(a.y1 - b.y1).toBeCloseTo(offset, 0);
    }
  });

  test("an emoji whose art is not loaded is skipped; the others still draw", () => {
    const outcomes = placeCaptionEmojis(input({ emojis: [{ cueIndex: 0, id: "not-loaded", atMs: 1100 }, { cueIndex: 0, id: "rocket", atMs: 1600 }] }));
    expect(outcomes.map((outcome) => (outcome.placed ? "placed" : outcome.reason))).toEqual(["no-art", "placed"]);
  });

  test("an emoji with more parts than the cap is dropped; the largest design fits under it", () => {
    const astronaut = art.get("astronaut")!;
    expect(astronaut.layers.length + 2).toBeLessThanOrEqual(CAPTION_EMOJI_PIECE_CAP);
    expect(placed(input({ emojis: [{ cueIndex: 0, id: "astronaut", atMs: 1200 }] }))).toHaveLength(1);
    const layer = astronaut.layers[0]!;
    const heavy: CaptionEmojiArt = { ...astronaut, id: "heavy", layers: Array.from({ length: CAPTION_EMOJI_PIECE_CAP - 1 }, () => layer) };
    const outcomes = placeCaptionEmojis(input({ art: new Map([["heavy", heavy]]), emojis: [{ cueIndex: 0, id: "heavy", atMs: 1200 }] }));
    expect(outcomes[0]).toMatchObject({ placed: false, reason: "piece-cap" });
  });

  test("an emoji for a cue without a box is dropped, not an error", () => {
    expect(placeCaptionEmojis(input({ emojis: [{ cueIndex: 7, id: "rocket", atMs: 1200 }] }))[0]).toMatchObject({ placed: false, reason: "no-cue" });
  });
});

describe("emoji timing", () => {
  test("an emoji shows from its anchor word to the cue's last paint", () => {
    expect(windowOf(placed(input())[0]!.pieces)).toEqual([1200, 3000]);
  });

  test("a late anchor shows its emoji at the word with a quick entrance; under 340 ms left it holds past the cue when clear; never before its word", () => {
    expect(CAPTION_EMOJI_MIN_SHOWN_MS).toBe(CAPTION_EMOJI_MIN_HOLD_MS + CAPTION_EMOJI_FADE_MS);
    // 360 ms left: at the word, 90 ms to full size, no overshoot.
    const late = placed(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs: 2640 }] }))[0]!.pieces[0]!;
    expect(windowOf([late])).toEqual([2640, 3000]);
    expect(evaluatePiece(late, 2640).sx).toBeCloseTo(CAPTION_EMOJI_QUICK_FROM, 6);
    for (let t = 2640; t < 3000; t += 5) expect(evaluatePiece(late, t).sx).toBeLessThanOrEqual(1);
    expect(evaluatePiece(late, 2640 + CAPTION_EMOJI_QUICK_MS).sx).toBe(1);
    expect(evaluatePiece(late, 3000 - CAPTION_EMOJI_FADE_MS).o).toBe(1);
    // 450 ms or more left: the full pop.
    const early = placed(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs: 2550 }] }))[0]!.pieces[0]!;
    expect(evaluatePiece(early, 2550 + CAPTION_EMOJI_POP_MS * 0.6).sx).toBeGreaterThan(1);
    // Exactly the minimum left: shown, at the word, 250 ms at full strength before its fade.
    const edge = placed(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs: 3000 - CAPTION_EMOJI_MIN_SHOWN_MS }] }))[0]!.pieces[0]!;
    expect(windowOf([edge])).toEqual([3000 - CAPTION_EMOJI_MIN_SHOWN_MS, 3000]);
    expect(edge.track.o).toEqual([[3000 - CAPTION_EMOJI_FADE_MS, 1], [3000, 0]]);
    // Less left (a 250 to 340 ms window once lost its full strength to the fade): it holds past the cue's last paint to
    // 400 ms from its word, with the quick entrance, at full strength for 250 ms.
    for (const atMs of [2700, 2740, 2760, 2850, 2880]) {
      const held = placed(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs }] }))[0]!.pieces[0]!;
      expect(windowOf([held])).toEqual([atMs, atMs + CAPTION_EMOJI_LATE_HOLD_MS]);
      expect(evaluatePiece(held, atMs).sx).toBeCloseTo(CAPTION_EMOJI_QUICK_FROM, 6);
      expect(evaluatePiece(held, atMs + CAPTION_EMOJI_MIN_HOLD_MS).o).toBe(1);
    }
    // When what follows the cue covers its slot, or the word leaves under 120 ms, it draws nothing.
    const next = cue({ obstacles: (t) => [cue().box, ...(t >= 3000 ? [{ x1: 0, y1: 0, x2: 1080, y2: 1920 }] : [])] });
    expect(placeCaptionEmojis(input({ cueBoxes: [next], emojis: [{ cueIndex: 0, id: "rocket", atMs: 2850 }] })).map((outcome) => outcome.placed || outcome.reason)).toEqual(["no-room"]);
    for (const atMs of [3000 - CAPTION_EMOJI_LATE_MIN_MS + 1, 2990]) {
      expect(placeCaptionEmojis(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs }] })).map((outcome) => outcome.placed || outcome.reason)).toEqual(["no-time"]);
    }
    // No piece of any emoji is ever visible before its anchor word starts.
    for (const atMs of [1000, 1200, 2000, 2550, 2700, 2750, 2850]) {
      for (const outcome of placed(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs }] }))) {
        for (const piece of outcome.pieces) expect(piece.fromMs).toBeGreaterThanOrEqual(atMs);
      }
    }
  });

  test("an emoji holds at most 2 s from its word, then fades as at its cue's end", () => {
    const long = cue({ fromMs: 1000, toMs: 30_000 });
    const piece = placed(input({ cueBoxes: [long], emojis: [{ cueIndex: 0, id: "rocket", atMs: 1200 }] }))[0]!.pieces[0]!;
    expect(CAPTION_EMOJI_MAX_HOLD_MS).toBe(2000);
    expect(windowOf([piece])).toEqual([1200, 1200 + CAPTION_EMOJI_MAX_HOLD_MS]);
    expect(evaluatePiece(piece, 1200 + CAPTION_EMOJI_MAX_HOLD_MS - CAPTION_EMOJI_FADE_MS).o).toBe(1);
    expect(evaluatePiece(piece, 1200 + CAPTION_EMOJI_MAX_HOLD_MS - CAPTION_EMOJI_FADE_MS / 2).o).toBeCloseTo(0.5, 1);
    // A later emoji of the cue still takes over from it.
    const two = placed(input({ cueBoxes: [long], emojis: [{ cueIndex: 0, id: "rocket", atMs: 1200 }, { cueIndex: 0, id: "thumbs-up", atMs: 2500 }] }));
    expect(two.map((outcome) => windowOf(outcome.pieces))).toEqual([[1200, 2500], [2500, 2500 + CAPTION_EMOJI_MAX_HOLD_MS]]);
  });

  test("an emoji that is not drawn does not cut the one before it short", () => {
    // Unknown art, and a design over the piece cap: known before placement.
    for (const id of ["not-loaded", "heavy"]) {
      const astronaut = art.get("astronaut")!;
      const heavy: CaptionEmojiArt = { ...astronaut, id: "heavy", layers: Array.from({ length: CAPTION_EMOJI_PIECE_CAP - 1 }, () => astronaut.layers[0]!) };
      const outcomes = placeCaptionEmojis(input({ art: new Map([...art, ["heavy", heavy]]), emojis: [{ cueIndex: 0, id: "rocket", atMs: 1100 }, { cueIndex: 0, id, atMs: 2000 }] }));
      expect(outcomes.map((outcome) => (outcome.placed ? windowOf(outcome.pieces) : outcome.reason))).toEqual([[1100, 3000], id === "heavy" ? "piece-cap" : "no-art"]);
    }
    // Dropped for room: the whole frame is taken from 2760 to 2800, so the second (300 ms from 2700) cannot wait for its slot
    // and still show 300 ms; the first keeps its slot past 2700 up to the frame the obstacle arrives.
    const busy = cue({ obstacles: (t) => [cue().box, ...(t >= 2760 && t < 2800 ? [{ x1: 0, y1: 0, x2: 1080, y2: 1920 }] : [])] });
    const outcomes = placeCaptionEmojis(input({ cueBoxes: [busy], emojis: [{ cueIndex: 0, id: "rocket", atMs: 1100 }, { cueIndex: 0, id: "thumbs-up", atMs: 2700 }] }));
    expect(outcomes.map((outcome) => (outcome.placed ? windowOf(outcome.pieces) : outcome.reason))).toEqual([[1100, 2767], "no-room"]);
  });

  test("a late emoji with no time of its own does not displace an earlier one, and never shows early", () => {
    // A tall cue near the top: "hundred" fits above it, "flame" never does. The flame's word leaves 50 ms: it draws nothing
    // (it once fell back to the cue's start and could take the earlier emoji's slot).
    const tall = cue({ box: { x1: 0, y1: 248, x2: 1080, y2: 1890 }, bodyPx: 130 });
    const layer = (emojis: CaptionEmojiLayerInput["emojis"]) =>
      input({ cueBoxes: [tall], art: new Map([...art, ...bigArt]), style: { ...input().style, position: "above" }, anchorYPct: 65, emojis });
    const alone = placeCaptionEmojis(layer([{ cueIndex: 0, id: "flame", atMs: 2950 }]));
    expect(alone.map((outcome) => outcome.placed || outcome.reason)).toEqual(["no-time"]);
    const outcomes = placeCaptionEmojis(layer([{ cueIndex: 0, id: "hundred", atMs: 1100 }, { cueIndex: 0, id: "flame", atMs: 2950 }]));
    expect(outcomes.map((outcome) => [outcome.emoji.id, outcome.placed ? windowOf(outcome.pieces) : outcome.reason])).toEqual([["hundred", [1100, 3000]], ["flame", "no-time"]]);
    // The same with a late emoji that fits: the earlier one keeps its slot and the late one, whose word has no time, is not drawn.
    const fits = placeCaptionEmojis(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs: 1100 }, { cueIndex: 0, id: "thumbs-up", atMs: 2950 }] }));
    expect(fits.map((outcome) => [outcome.emoji.id, outcome.placed ? windowOf(outcome.pieces) : outcome.reason])).toEqual([["rocket", [1100, 3000]], ["thumbs-up", "no-time"]]);
  });

  test("an emoji starting within a frame of an earlier one waits for it: placed only when the earlier one is not", () => {
    // The earlier one fits, so it keeps the slot.
    const both = placeCaptionEmojis(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs: 1100 }, { cueIndex: 0, id: "thumbs-up", atMs: 1110 }] }));
    expect(both.map((outcome) => [outcome.emoji.id, outcome.placed ? windowOf(outcome.pieces) : outcome.reason])).toEqual([["rocket", [1100, 3000]], ["thumbs-up", "no-time"]]);
    // The earlier one cannot fit (the flame above the tall cue, even at Small's shrunk size): the later one draws.
    const tall = cue({ box: { x1: 0, y1: 220, x2: 1080, y2: 1890 }, bodyPx: 130 });
    const outcomes = placeCaptionEmojis(
      input({ cueBoxes: [tall], art: bigArt, style: { ...input().style, position: "above" }, anchorYPct: 65, emojis: [{ cueIndex: 0, id: "flame", atMs: 1100 }, { cueIndex: 0, id: "hundred", atMs: 1110 }] }),
    );
    expect(outcomes.map((outcome) => [outcome.emoji.id, outcome.placed ? windowOf(outcome.pieces) : outcome.reason])).toEqual([["flame", "no-room"], ["hundred", [1110, 3000]]]);
  });

  test("two emojis in one cue share its slot: the first gives way when the second starts", () => {
    const outcomes = placed(input({ emojis: [{ cueIndex: 0, id: "thumbs-up", atMs: 2000 }, { cueIndex: 0, id: "rocket", atMs: 1100 }] }));
    expect(outcomes.map((outcome) => [outcome.emoji.id, ...windowOf(outcome.pieces)])).toEqual([["rocket", 1100, 2000], ["thumbs-up", 2000, 3000]]);
    // The same slot: centred on the cue, each emoji's ink the same gap above it.
    expect(outcomes[0]!.pieces[0]!.track.x![0]![1]).toBe(outcomes[1]!.pieces[0]!.track.x![0]![1]);
    const bottom = (outcome: (typeof outcomes)[number]) => pieceBounds({ ...outcome.pieces[0]!, path: outcome.pieces[1]!.path.slice(2) }, outcome.pieces[0]!.toMs - 100, fakeMeasure)!.y2;
    // Within a pixel: the gap is kept from the turned ink box, a little looser than the turned path.
    expect(Math.abs(bottom(outcomes[0]!) - bottom(outcomes[1]!))).toBeLessThan(1);
  });

  test("a slot is kept close to the text that reads when the emoji pops, not to a late box that reaches further", () => {
    // A Scene Style's box is one late sample: here it reaches 300 px past the row on screen when the emoji pops.
    const row = { x1: 240, y1: 1200, x2: 840, y2: 1290 };
    const withRow = (box: typeof row, more: Partial<CaptionEmojiCueBox> = {}) => cue({ box, obstacles: () => [row], shownAt: () => [row], ...more });
    const inkGap = (outcome: ReturnType<typeof placed>[number]) => {
      const ink = pieceBounds({ ...outcome.pieces[1]!, path: outcome.pieces[1]!.path.slice(2) }, 2000, fakeMeasure)!;
      return { gap: Math.max(row.y1 - ink.y2, ink.y1 - row.y2), height: ink.y2 - ink.y1 };
    };
    // Above: the box's top is far over the row, so the slot is measured from the row.
    const tallAbove = placed(input({ cueBoxes: [withRow({ ...row, y1: 900 })] }))[0]!;
    expect(tallAbove.side).toBe("above");
    expect(inkGap(tallAbove).gap).toBeLessThanOrEqual(0.5 * inkGap(tallAbove).height);
    // Below (a caption high in the frame tries below first): under the row, not under the box's late bottom.
    const high = { x1: 240, y1: 380, x2: 840, y2: 470 };
    const highCue = cue({ box: { ...high, y2: 770 }, obstacles: () => [high], shownAt: () => [high] });
    const below = placed(input({ anchorYPct: 20, cueBoxes: [highCue] }))[0]!;
    expect(below.side).toBe("below");
    const ink = pieceBounds({ ...below.pieces[1]!, path: below.pieces[1]!.path.slice(2) }, 2000, fakeMeasure)!;
    expect(ink.y1 - high.y2).toBeLessThanOrEqual(0.5 * (ink.y2 - ink.y1));
    // Nothing close is clear (the rows on screen are boxed in on every side but far above): not drawn.
    const far = cue({ box: row, obstacles: () => [{ x1: 0, y1: 0, x2: 1080, y2: 1195 }, { x1: 0, y1: 1195, x2: 235, y2: 1920 }, { x1: 845, y1: 1195, x2: 1080, y2: 1920 }, { x1: 0, y1: 1295, x2: 1080, y2: 1500 }], shownAt: () => [row] });
    expect(placeCaptionEmojis(input({ cueBoxes: [far] }))[0]).toMatchObject({ placed: false, reason: "no-room" });
  });

  test("back to back in one cue: the first keeps 250 ms at full strength and its fade; the second waits for it, or draws nothing", () => {
    // 150 ms apart: the rocket shows its least window, and the thumbs-up starts where it ends.
    const outcomes = placed(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs: 1100 }, { cueIndex: 0, id: "thumbs-up", atMs: 1250 }] }));
    expect(outcomes.map((outcome) => [outcome.emoji.id, ...windowOf(outcome.pieces)])).toEqual([["rocket", 1100, 1100 + CAPTION_EMOJI_MIN_SHOWN_MS], ["thumbs-up", 1100 + CAPTION_EMOJI_MIN_SHOWN_MS, 3000]]);
    for (const outcome of outcomes) {
      const piece = outcome.pieces[0]!;
      expect(piece.track.o![0]![0] - piece.fromMs).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_HOLD_MS);
    }
    // In a cue that ends 500 ms after the rocket, waiting leaves the thumbs-up 160 ms: it draws nothing, and the rocket keeps
    // the cue to its end (it is not cut for an emoji that does not draw).
    const short = placeCaptionEmojis(input({ cueBoxes: [cue({ toMs: 1600 })], emojis: [{ cueIndex: 0, id: "rocket", atMs: 1100 }, { cueIndex: 0, id: "thumbs-up", atMs: 1250 }] }));
    expect(short.map((outcome) => (outcome.placed ? windowOf(outcome.pieces) : outcome.reason))).toEqual([[1100, 1600], "no-time"]);
    // Far enough apart, nothing changes: the first gives way when the second starts.
    const apart = placed(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs: 1100 }, { cueIndex: 0, id: "thumbs-up", atMs: 1100 + CAPTION_EMOJI_MIN_SHOWN_MS }] }));
    expect(apart.map((outcome) => windowOf(outcome.pieces))).toEqual([[1100, 1100 + CAPTION_EMOJI_MIN_SHOWN_MS], [1100 + CAPTION_EMOJI_MIN_SHOWN_MS, 3000]]);
  });

  test("closeness is judged on the emoji's first painted frame, not on a row that appears later in its pop", () => {
    // The row on screen when the emoji pops, and a row far above that appears 100 ms later (a stack's next line).
    const row = { x1: 240, y1: 1500, x2: 840, y2: 1590 };
    const later = { x1: 240, y1: 1000, x2: 840, y2: 1090 };
    const rows = (t: number) => (t < 1300 ? [row] : [row, later]);
    const stack = cue({ box: { ...row, y1: 1000 }, obstacles: rows, shownAt: rows });
    const [emoji] = placed(input({ cueBoxes: [stack] }));
    expect(emoji!.side).toBe("above");
    const ink = pieceBounds({ ...emoji!.pieces[1]!, path: emoji!.pieces[1]!.path.slice(2) }, 2000, fakeMeasure)!;
    // Above the row on screen at 1200, not above the later row (about 2.5 emoji heights from it).
    expect(row.y1 - ink.y2).toBeGreaterThanOrEqual(0);
    expect(row.y1 - ink.y2).toBeLessThanOrEqual(0.5 * (ink.y2 - ink.y1));
    // An emoji that waits for its slot is judged on the frame it does pop: here only the far row reads then, so it is
    // measured from that row, and placed close to it.
    const leaving = (t: number) => (t < 1300 ? [row] : [later]);
    const moved = placed(input({ cueBoxes: [cue({ box: { ...row, y1: 1000 }, obstacles: (t) => [...leaving(t), ...(t < 1300 ? [{ x1: 0, y1: 0, x2: 1080, y2: 1920 }] : [])], shownAt: leaving })] }))[0]!;
    const movedInk = pieceBounds({ ...moved.pieces[1]!, path: moved.pieces[1]!.path.slice(2) }, 2000, fakeMeasure)!;
    const gap = Math.max(later.y1 - movedInk.y2, movedInk.y1 - later.y2, 0);
    expect(moved.pieces[0]!.fromMs).toBeGreaterThanOrEqual(1300);
    expect(gap).toBeLessThanOrEqual(0.5 * (movedInk.y2 - movedInk.y1));
  });

  test("when nothing close to the first frame's text stays clear, a slot by the text that grows in during the pop, within one height of the first frame's", () => {
    // One glyph on the first frame (1200); from the next frame a bubble grows round it, over every slot close to the glyph.
    const glyph = { x1: 500, y1: 1500, x2: 560, y2: 1590 };
    const grows = (top: number) => {
      const bubble = { x1: 300, y1: top, x2: 780, y2: 1700 };
      const shown = (t: number) => (t < 1233 ? [glyph] : [glyph, bubble]);
      return cue({ box: bubble, obstacles: shown, shownAt: shown });
    };
    const [near] = placeCaptionEmojis(input({ cueBoxes: [grows(1440)] }));
    expect(near!.placed && near!.side).toBe("above");
    const ink = near!.placed ? pieceBounds({ ...near!.pieces[1]!, path: near!.pieces[1]!.path.slice(2) }, 2000, fakeMeasure)! : null;
    const gap = (glyph.y1 - ink!.y2) / (ink!.y2 - ink!.y1);
    expect(gap).toBeGreaterThan(0.5);
    expect(gap).toBeLessThanOrEqual(1);
    // A bubble whose top is over two emoji heights from the glyph: nothing is close enough, so no emoji.
    expect(placeCaptionEmojis(input({ cueBoxes: [grows(1250)] }))[0]).toMatchObject({ placed: false, reason: "no-room" });
  });

  test("three emojis in a short cue: when the middle one draws nothing, the first and third never show at once", () => {
    for (const [fromMs, toMs, anchors] of [[1000, 1500, [1000, 1100, 1200]], [0, 500, [0, 100, 180]]] as const) {
      const ids = ["rocket", "thumbs-up", "heart-eyes"];
      const outcomes = placeCaptionEmojis(input({ cueBoxes: [cue({ fromMs, toMs })], emojis: anchors.map((atMs, at) => ({ cueIndex: 0, id: ids[at]!, atMs })) }));
      // The first keeps the cue (the others' time is given back to it), the others are too late for 340 ms of their own.
      expect(outcomes.map((outcome) => (outcome.placed ? windowOf(outcome.pieces) : outcome.reason))).toEqual([[fromMs, toMs], "no-time", "no-time"]);
      const windows = outcomes.flatMap((outcome) => (outcome.placed ? [windowOf(outcome.pieces)] : []));
      for (const [a, b] of windows.flatMap((one, at) => windows.slice(at + 1).map((other) => [one, other] as const))) expect(a[1]! <= b[0]! || b[1]! <= a[0]!).toBe(true);
    }
  });

  test("no two drawn emojis of one cue ever show at once, and each draws its least window inside its cue and the clip", () => {
    const ids = ["rocket", "thumbs-up", "heart-eyes", "astronaut"];
    // Dense clusters (a frame or two apart, the 30 fps case that once drew 1000–3000 and 1050–3000), then spaced ones.
    const patterns: number[][] = [
      [1000, 1025, 1050],
      [1000, 1025, 1050, 1075],
      [1000, 1030, 1060, 1090, 1120, 1150],
      [1000, 1040, 1080, 1120, 1160, 1200],
      [1000, 1010, 1020, 1100, 1110, 1200],
      [1000, 1050, 1100, 1150, 1200],
      [1100, 1133, 1166, 1199],
      [1000, 1200, 1400, 1600],
      [1000, 1500, 2000, 2500, 2800],
      [1000, 1340, 1680, 2020, 2360, 2700],
      [1200, 1250, 2600, 2650, 2900],
    ];
    for (const fps of [24, 30, 60]) {
      for (const toMs of [1500, 3000]) {
        for (const endMs of [undefined, toMs + 100]) {
          for (const anchors of patterns) {
            const label = `${fps} fps, cue to ${toMs}, end ${endMs}, anchors ${anchors.join("/")}`;
            const layer = input({ fps, cueBoxes: [cue({ toMs })], ...(endMs === undefined ? {} : { endMs }), emojis: anchors.map((atMs, at) => ({ cueIndex: 0, id: ids[at % ids.length]!, atMs })) });
            const windows = placeCaptionEmojis(layer).flatMap((outcome) => (outcome.placed ? [{ atMs: outcome.emoji.atMs, window: windowOf(outcome.pieces) }] : []));
            for (const { atMs, window } of windows) {
              const [from, to] = window as [number, number];
              expect(from, label).toBeGreaterThanOrEqual(atMs);
              expect(to - from, label).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_SHOWN_MS);
              expect(to, label).toBeLessThanOrEqual(Math.min(endMs ?? Number.POSITIVE_INFINITY, Math.max(toMs, atMs + CAPTION_EMOJI_LATE_HOLD_MS)));
            }
            for (const [a, b] of windows.flatMap((one, at) => windows.slice(at + 1).map((other) => [one.window, other.window] as const))) {
              expect(a[1]! <= b[0]! || b[1]! <= a[0]!, `${label}: ${a.join("–")} and ${b.join("–")}`).toBe(true);
            }
          }
        }
      }
    }
  });

  test("a hold never runs past the clip's end: what is left of it is the window, and under 340 ms it draws nothing", () => {
    // The cue's last paint is 3000 and its emoji's word at 2850 holds to 3250; the clip ends at 3100 (150 ms visible).
    const ends = (endMs: number, atMs = 2850) => placeCaptionEmojis(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs }], endMs }));
    expect(ends(3100).map((outcome) => outcome.placed || outcome.reason)).toEqual(["no-time"]);
    // Enough left before the end: the window stops at it.
    const early = ends(3150, 2700)[0]!;
    expect(early.placed && windowOf(early.pieces)).toEqual([2700, 3100]);
    const cut = ends(3050, 2700)[0]!;
    expect(cut.placed && windowOf(cut.pieces)).toEqual([2700, 3050]);
    // An end past the hold changes nothing; the layer key follows the end.
    expect(ends(4000)).toEqual(placeCaptionEmojis(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs: 2850 }] })));
    expect(captionEmojiLayerKey(input({ endMs: 3100 }), "s")).not.toBe(captionEmojiLayerKey(input(), "s"));
  });

  test("overlapping speakers each keep a slot, and the two emojis never meet", () => {
    const left = cue({ cueIndex: 0, box: { x1: 100, y1: 1200, x2: 500, y2: 1290 } });
    const right = cue({ cueIndex: 1, box: { x1: 580, y1: 1200, x2: 980, y2: 1290 }, fromMs: 1500, toMs: 3500 });
    const outcomes = placed(input({ cueBoxes: [left, right], emojis: [{ cueIndex: 0, id: "rocket", atMs: 1100 }, { cueIndex: 1, id: "thumbs-up", atMs: 1600 }] }));
    expect(outcomes).toHaveLength(2);
    for (let t = 1600; t < 3000; t += 33) {
      const [a, b] = outcomes.map((outcome) => pieceBounds({ ...outcome.pieces[1]!, path: outcome.pieces[1]!.path.slice(2) }, t, fakeMeasure)!);
      expect(a!.x2 <= b!.x1 || b!.x2 <= a!.x1 || a!.y2 <= b!.y1 || b!.y2 <= a!.y1).toBe(true);
    }
  });

  test("a slot taken for the whole window by another cue moves the emoji beside the cue, then below", () => {
    const blocker = { x1: 0, y1: 0, x2: 1080, y2: 1195 };
    const [beside] = placed(input({ cueBoxes: [cue({ obstacles: () => [blocker] })] }));
    expect(beside!.side).toBe("end");
    const sides = { x1: 0, y1: 0, x2: 1080, y2: 1290 };
    const [below] = placed(input({ cueBoxes: [cue({ obstacles: () => [sides] })] }));
    expect(below!.side).toBe("below");
  });

  test("a slot still being vacated at the anchor is waited for", () => {
    const leaving = { x1: 0, y1: 1000, x2: 1080, y2: 1195 };
    const [emoji] = placed(input({ cueBoxes: [cue({ obstacles: (t) => (t < 1350 ? [leaving] : []) })] }));
    expect(emoji!.side).toBe("above");
    expect(emoji!.pieces[0]!.fromMs).toBeGreaterThanOrEqual(1350);
    expect(emoji!.pieces[0]!.fromMs).toBeLessThan(1400);
  });

  test("a soft obstacle (a decoration) is covered only when no slot clear of everything is left", () => {
    const ray = { x1: 0, y1: 1000, x2: 1080, y2: 1195, soft: true };
    expect(placed(input({ cueBoxes: [cue({ obstacles: () => [ray] })] }))[0]!.side).toBe("end");
    const floor = { x1: 0, y1: 1295, x2: 1080, y2: 1920 };
    // A clear slot at any size, down to Small's shrunk one (S <= M on one side), comes before covering the ray.
    expect(placed(input({ cueBoxes: [cue({ obstacles: () => [ray, floor] })] }))[0]).toMatchObject({ side: "end", shrunk: true });
    const walls = [{ x1: 0, y1: 1195, x2: 239, y2: 1295 }, { x1: 841, y1: 1195, x2: 1080, y2: 1295 }];
    expect(placed(input({ cueBoxes: [cue({ obstacles: () => [ray, floor, ...walls] })] }))[0]).toMatchObject({ side: "above", shrunk: false });
  });
});

describe("a held emoji leaves with its caption", () => {
  // The cue's last paint is 3000; a word at 2850 leaves it 150 ms, so its emoji holds to 3250.
  const held = (overrides: Partial<CaptionEmojiLayerInput> = {}) => placeCaptionEmojis(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs: 2850 }], ...overrides }));
  const next = cue({ cueIndex: 1, fromMs: 3000, toMs: 4500 });

  test("full strength for 250 ms from its word, then it fades and shrinks to 0.85 over the rest of the hold, in place", () => {
    const [outcome] = held();
    const pieces = outcome!.placed ? outcome!.pieces : [];
    expect(windowOf(pieces)).toEqual([2850, 2850 + CAPTION_EMOJI_LATE_HOLD_MS]);
    const leave = 2850 + CAPTION_EMOJI_MIN_HOLD_MS;
    for (const piece of pieces) {
      for (let t = 2850 + CAPTION_EMOJI_QUICK_MS; t <= leave; t += 10) expect([evaluatePiece(piece, t).o, evaluatePiece(piece, t).sx]).toEqual([1, 1]);
      let previous = { o: 1, sx: 1 };
      for (let t = leave + 10; t < 3250; t += 10) {
        const pose = evaluatePiece(piece, t);
        expect(pose.o).toBeLessThan(previous.o);
        expect(pose.sx).toBeLessThan(previous.sx);
        expect(pose.sy).toBe(pose.sx);
        previous = { o: pose.o, sx: pose.sx };
      }
      expect(evaluatePiece(piece, 3200).o).toBeCloseTo(1 / 3, 6);
      expect(evaluatePiece(piece, 3250).sx).toBeCloseTo(CAPTION_EMOJI_LEAVE_SCALE, 6);
      // It does not move: one position for its whole window, the one placed for its own cue.
      expect([piece.track.x, piece.track.y]).toEqual([[[2850, expect.any(Number)]], [[2850, expect.any(Number)]]]);
    }
    expect(CAPTION_EMOJI_LEAVE_SCALE).toBe(0.85);
  });

  test("an emoji that ends with its cue keeps its entrance and 90 ms fade; under 120 ms left it is still not drawn", () => {
    for (const atMs of [1200, 2640, 3000 - CAPTION_EMOJI_MIN_SHOWN_MS]) {
      const piece = placed(input({ cueBoxes: [cue(), next], emojis: [{ cueIndex: 0, id: "rocket", atMs }], nextEmojiAtMs: 3050 }))[0]!.pieces[0]!;
      expect(piece.toMs).toBe(3000);
      expect(piece.track.o).toEqual([[3000 - CAPTION_EMOJI_FADE_MS, 1], [3000, 0]]);
      expect(piece.track.sx).toHaveLength(2);
    }
    expect(held({ emojis: [{ cueIndex: 0, id: "rocket", atMs: 2900 }] }).map((outcome) => outcome.placed || outcome.reason)).toEqual(["no-time"]);
  });

  test("it yields to the first emoji of a later cue, whether the input holds that cue or a one-cue feeder passes its time", () => {
    const together = placeCaptionEmojis(input({ cueBoxes: [cue(), next], emojis: [{ cueIndex: 0, id: "rocket", atMs: 2850 }, { cueIndex: 1, id: "thumbs-up", atMs: 3200 }] }));
    const alone = held({ cueBoxes: [cue(), next], nextEmojiAtMs: 3200 });
    expect(alone[0]).toEqual(together[0]!);
    const pieces = alone[0]!.placed ? alone[0]!.pieces : [];
    expect(windowOf(pieces)).toEqual([2850, 3200]);
    // Never two emojis at once: the next one starts where the held one ends.
    expect(together[1]!.placed && windowOf(together[1]!.pieces)[0]).toBe(3200);
    // Still leaving: 250 ms at full strength, then a fade of at least 90 ms.
    expect(pieces[0]!.track.o).toEqual([[2850 + CAPTION_EMOJI_MIN_HOLD_MS, 1], [3200, 0]]);
    // Left under 340 ms from its word by the next emoji: it draws nothing rather than flash.
    for (const nextEmojiAtMs of [3050, 3150]) expect(held({ nextEmojiAtMs }).map((outcome) => outcome.placed || outcome.reason)).toEqual(["no-time"]);
    // A later emoji past the hold changes nothing; the layer key follows the time.
    expect(held({ nextEmojiAtMs: 3600 })).toEqual(held());
    expect(captionEmojiLayerKey(input({ nextEmojiAtMs: 3150 }), "s")).not.toBe(captionEmojiLayerKey(input(), "s"));
  });

  test("it stays off the next cue's box that a one-cue feeder passes beside its own: another slot, or not drawn", () => {
    // The next cue is taller and reaches over the slot above this one; there is room beside it, past the next cue's end.
    const taller = cue({ cueIndex: 1, fromMs: 3000, toMs: 4500, box: { x1: 200, y1: 1000, x2: 880, y2: 1290 } });
    const [outcome] = held({ cueBoxes: [cue(), taller] });
    expect(outcome!.placed && outcome!.side).toBe("end");
    const pieces = outcome!.placed ? outcome!.pieces : [];
    for (let t = 3000; t < 3250; t += 1000 / 30) {
      for (const piece of pieces) {
        const ink = pieceBounds({ ...piece, path: piece.path.slice(2) }, t, fakeMeasure)!;
        expect(ink.y1 >= taller.box.y2 || ink.y2 <= taller.box.y1 || ink.x1 >= taller.box.x2 || ink.x2 <= taller.box.x1).toBe(true);
      }
    }
    // Without the next box, or for an emoji that ends with its cue, the slot above is kept.
    expect(held()[0]!.placed && (held()[0] as { side: string }).side).toBe("above");
    const ends = placed(input({ cueBoxes: [cue(), taller], emojis: [{ cueIndex: 0, id: "rocket", atMs: 2640 }] }))[0]!;
    expect(ends.side).toBe("above");
    // Covered above, below and on both sides: not drawn.
    const around = cue({ cueIndex: 1, fromMs: 3000, toMs: 4500, box: { x1: 100, y1: 900, x2: 980, y2: 1700 } });
    expect(held({ cueBoxes: [cue(), around] }).map((each) => each.placed || each.reason)).toEqual(["no-room"]);
  });
});

describe("emoji pose and slot", () => {
  test("the tilt alternates by emoji and mirrors in RTL cues", () => {
    const boxes = [0, 1, 2].map((index) => cue({ cueIndex: index, fromMs: 1000 + index * 3000, toMs: 3000 + index * 3000 }));
    const emojis = [0, 1, 2].map((index) => ({ cueIndex: index, id: "rocket", atMs: 1100 + index * 3000 }));
    const tilts = (direction: "ltr" | "rtl") =>
      placed(input({ cueBoxes: boxes.map((box) => ({ ...box, direction })), emojis })).map((outcome) => outcome.pieces[0]!.track.rz![0]![1]);
    expect(tilts("ltr")).toEqual([CAPTION_EMOJI_TILT_DEG, -CAPTION_EMOJI_TILT_DEG, CAPTION_EMOJI_TILT_DEG]);
    expect(tilts("rtl")).toEqual([-CAPTION_EMOJI_TILT_DEG, CAPTION_EMOJI_TILT_DEG, -CAPTION_EMOJI_TILT_DEG]);
    // A tilted cue turns its emoji with it.
    expect(placed(input({ cueBoxes: [cue({ tiltDeg: -4 })] }))[0]!.pieces[0]!.track.rz![0]![1]).toBe(-4 + CAPTION_EMOJI_TILT_DEG);
    // One cue placed alone (the Studio's classic and Dynamic paths) turns its emoji by the target's order, as the whole target does.
    const alone = boxes.map((box, index) => placed(input({ cueBoxes: [box], emojis: [{ ...emojis[index]!, order: index }] }))[0]!.pieces[0]!.track.rz![0]![1]);
    expect(alone).toEqual(tilts("ltr"));
  });

  test("centred above the cue at 0.18 of its size, or below a caption in the top 30%", () => {
    const sizePx = captionEmojiSizePx(80, 1, CANVAS);
    const above = placed(input())[0]!;
    const ink = (outcome: typeof above) => pieceBounds({ ...outcome.pieces[0]!, path: outcome.pieces[1]!.path.slice(2) }, 2000, fakeMeasure)!;
    expect(above.pieces[0]!.track.x![0]![1]).toBeCloseTo(540, 6);
    expect(cue().box.y1 - ink(above).y2).toBeGreaterThan(0.1 * sizePx);
    const top = placed(input({ anchorYPct: 20, cueBoxes: [cue({ box: { x1: 240, y1: 380, x2: 840, y2: 470 } })] }))[0]!;
    expect(top.side).toBe("below");
    expect(captionEmojiSides("above", "auto", 20)).toEqual(["below", "end", "start", "above"]);
    expect(captionEmojiSides("above", "auto", 67)).toEqual(["above", "end", "start", "below"]);
    expect(captionEmojiSides("above", "above", 20)).toEqual(["above", "below"]);
    expect(captionEmojiSides("beside-end", "auto", 50)[0]).toBe("end");
  });

  test("beside-end sits level with the last row at its reading end: right in LTR, left in RTL", () => {
    // Rows apart enough for an emoji 1.6 times the body text to sit level with the last.
    const box = { x1: 100, y1: 1040, x2: 900, y2: 1290 };
    const firstRow = { x1: 100, y1: 1040, x2: 900, y2: 1130 };
    const endBox = { x1: 100, y1: 1200, x2: 500, y2: 1290 };
    const style = { ...input().style, slot: "beside-end" as const };
    const ltr = placed(input({ style, cueBoxes: [cue({ box, endBox, obstacles: () => [firstRow, endBox] })] }))[0]!;
    expect(ltr.side).toBe("end");
    expect(ltr.pieces[0]!.track.x![0]![1]).toBeGreaterThan(500);
    expect(ltr.pieces[0]!.track.y![0]![1]).toBeCloseTo(1245, 6);
    const rtlRow = { x1: 580, y1: 1200, x2: 980, y2: 1290 };
    const rtl = placed(input({ style, cueBoxes: [cue({ box: { ...box, x2: 980 }, endBox: rtlRow, direction: "rtl", obstacles: () => [{ ...firstRow, x2: 980 }, rtlRow] })] }))[0]!;
    expect(rtl.side).toBe("end");
    expect(rtl.pieces[0]!.track.x![0]![1]).toBeLessThan(580);
  });

  test("beside-end falls back to level with the whole cue past its widest row when dim lines crowd the last row's end", () => {
    // Full-width rows with dim neighbour lines 50 px above and below: no room by the last row or above or below.
    const rows = [{ x1: 96, y1: 1244, x2: 820, y2: 1333 }, { x1: 96, y1: 1349, x2: 300, y2: 1434 }];
    const neighbours = [{ x1: 96, y1: 1126, x2: 790, y2: 1194 }, { x1: 96, y1: 1480, x2: 700, y2: 1547 }];
    const box = { x1: 96, y1: 1244, x2: 820, y2: 1434 };
    const style = { ...input().style, slot: "beside-end" as const };
    const outcome = placed(input({ style, cueBoxes: [cue({ box, endBox: rows[1], obstacles: () => [...rows, ...neighbours] })] }))[0]!;
    expect(outcome.side).toBe("end");
    expect(outcome.pieces[0]!.track.x![0]![1]).toBeGreaterThan(820);
    expect(outcome.pieces[0]!.track.y![0]![1]).toBeCloseTo((1244 + 1434) / 2, 6);
  });

  // Lyrics on fast speech (measured, 9:16): the active line and its dim neighbour lines 30 to 50 px above and below.
  const inkOf = (outcome: { readonly pieces: readonly ShapePiece[] }) => pieceBounds({ ...outcome.pieces[1]!, path: outcome.pieces[1]!.path.slice(2) }, outcome.pieces[0]!.toMs - 1, fakeMeasure)!;

  test("a line that fills the width with dim lines above and below: the emoji goes over its reading end, past the shorter line above", () => {
    const line = { x1: 96, y1: 1244, x2: 940, y2: 1330 };
    const neighbours = [{ x1: 96, y1: 1123, x2: 724, y2: 1195 }, { x1: 96, y1: 1379, x2: 646, y2: 1448 }];
    const style = { ...input().style, slot: "beside-end" as const };
    const outcome = placed(input({ style, cueBoxes: [cue({ box: line, endBox: line, obstacles: () => [line, ...neighbours] })] }))[0];
    expect(outcome?.side).toBe("above");
    const ink = inkOf(outcome!);
    expect(ink.x1).toBeGreaterThan(724);
    expect(ink.y2).toBeLessThan(1244);
  });

  test("a short line whose longer neighbours crowd its end: the safe area's edge is too far from it, so no emoji is drawn", () => {
    // A 300 ms cue of fast speech; the stack scrolls 74 px up while it paints. Level with the line at the safe area's edge
    // (past the longer neighbours) is about three emoji heights from its text: it would belong to nothing.
    const line = { x1: 96, y1: 1248, x2: 411, y2: 1332 };
    const neighbours = [{ x1: 96, y1: 1140, x2: 810, y2: 1214 }, { x1: 96, y1: 1397, x2: 647, y2: 1468 }];
    const scrolled = (boxes: readonly { x1: number; y1: number; x2: number; y2: number }[]) => (atMs: number) => {
      const dy = -74 * Math.min(1, Math.max(0, (atMs - 2850) / 216));
      return boxes.map((box) => ({ ...box, y1: box.y1 + dy, y2: box.y2 + dy }));
    };
    const fast = { fromMs: 2750, toMs: 3100, bodyPx: 92 };
    const style = { ...input().style, slot: "beside-end" as const };
    const emojis = [{ cueIndex: 0, id: "rocket", atMs: 2850 }];
    const outcome = placeCaptionEmojis(input({ style, emojis, cueBoxes: [cue({ ...fast, box: line, endBox: line, obstacles: scrolled([line, ...neighbours]) })] }))[0];
    expect(outcome).toMatchObject({ placed: false, reason: "no-room" });
    // A line about as long as its neighbours: level with its end, close to it, inside the safe area.
    const near = [{ ...neighbours[0]!, x2: 880 }, neighbours[1]!];
    const long = { ...line, x2: 850 };
    const edged = placed(input({ style, emojis, cueBoxes: [cue({ ...fast, box: long, endBox: long, obstacles: scrolled([long, ...near]) })] }))[0];
    expect(edged?.side).toBe("end");
    const ink = inkOf(edged!);
    expect(ink.x1 - long.x2).toBeLessThanOrEqual(0.5 * (ink.y2 - ink.y1));
    expect(ink.x2).toBeLessThanOrEqual(0.95 * CANVAS.width);
  });

  test("an emoji that fits by the text keeps that slot; the edge slots come after", () => {
    const line = { x1: 96, y1: 1244, x2: 600, y2: 1330 };
    const style = { ...input().style, slot: "beside-end" as const };
    const outcome = placed(input({ style, cueBoxes: [cue({ box: line, endBox: line, obstacles: () => [line] })] }))[0]!;
    expect(outcome.side).toBe("end");
    expect(inkOf(outcome).x1).toBeLessThan(600 + 0.3 * captionEmojiSizePx(80, 1, CANVAS));
  });

  test("a phrase badge draws 1.2 times an emoji's size, and tries a single emoji's shrunk size before it is dropped", async () => {
    const pair = await loadCaptionEmojiArt(["sticker-shock", "exploding-head"]);
    expect(pair.get("sticker-shock")!.badge).toBe(true);
    expect(pair.get("exploding-head")!.badge).toBe(false);
    const side = (outcome: { readonly pieces: readonly ShapePiece[] }) => pathBounds(outcome.pieces[0]!.path).x2;
    const one = (id: string, layer: Partial<CaptionEmojiLayerInput> = {}) => placed(input({ art: pair, emojis: [{ cueIndex: 0, id, atMs: 1200 }], ...layer }))[0];
    const badge = one("sticker-shock")!;
    const single = one("exploding-head")!;
    expect(side(badge) / side(single)).toBeCloseTo(CAPTION_EMOJI_BADGE_SCALE, 6);
    // Room under the cue for a single emoji at 0.7 but not for the badge at 0.7 of its own size; everything above taken.
    const low = cue({ box: { x1: 240, y1: 1560, x2: 840, y2: 1680 }, obstacles: () => [{ x1: 0, y1: 0, x2: 1080, y2: 1680 }] });
    const tight = { cueBoxes: [low], style: { ...input().style, slot: "below" as const } };
    const shrunkSingle = one("exploding-head", tight)!;
    const shrunkBadge = one("sticker-shock", tight)!;
    expect(shrunkSingle.shrunk).toBe(true);
    expect(shrunkBadge.shrunk).toBe(true);
    expect(side(shrunkBadge)).toBeCloseTo(side(shrunkSingle), 6);
  });

  test("an emoji kept inside an edge of the safe area stays inside through the pop's overshoot", () => {
    // A cue box at the frame's left edge (a lower third's bar): the emoji is held in at the edge.
    const edge = cue({ box: { x1: 84, y1: 1197, x2: 98, y2: 1294 }, fromMs: 300, toMs: 1100 });
    const [outcome] = placed(input({ cueBoxes: [edge], emojis: [{ cueIndex: 0, id: "rocket", atMs: 400 }] }));
    expect(outcome).toBeDefined();
    const left = 0.05 * CANVAS.width;
    for (let t = outcome!.pieces[0]!.fromMs; t < outcome!.pieces[0]!.toMs; t += 10) {
      for (const piece of outcome!.pieces) expect(pieceBounds({ ...piece, path: piece.path.slice(2) }, t, fakeMeasure)!.x1).toBeGreaterThanOrEqual(left - 0.5);
    }
  });

  test("size is 1.6 of the body text, kept between 12.5% and 16% of the short side, then times the preset's size", () => {
    expect(captionEmojiSizePx(100, 1, CANVAS)).toBeCloseTo(160, 6);
    expect(captionEmojiSizePx(20, 1, CANVAS)).toBeCloseTo(0.125 * 1080, 6);
    expect(captionEmojiSizePx(400, 1, CANVAS)).toBeCloseTo(0.16 * 1080, 6);
    // The clamp comes before the preset's size, so small, default and large differ at either bound.
    for (const bodyPx of [20, 100, 400]) {
      const sizes = [0.8, 1, 1.25].map((size) => captionEmojiSizePx(bodyPx, size, CANVAS));
      expect(sizes[0]).toBeLessThan(sizes[1]!);
      expect(sizes[1]).toBeLessThan(sizes[2]!);
    }
    expect(captionEmojiSizePx(400, 1.25, CANVAS)).toBeCloseTo(1.25 * 0.16 * 1080, 6);
  });

  test("auto goes below a caption high in the frame when the emoji above would reach into the face zone", () => {
    // Caption top at 38.5% of the height: the emoji above would reach about 28%, past the face zone's 30%.
    const mid = cue({ box: { x1: 240, y1: 740, x2: 840, y2: 830 } });
    expect(placed(input({ anchorYPct: 40, cueBoxes: [mid] }))[0]!.side).toBe("below");
    // The owner's explicit position wins.
    expect(placed(input({ anchorYPct: 40, cueBoxes: [mid], style: { ...input().style, position: "above" } }))[0]!.side).toBe("above");
    // Below is taken: level with the cue at its reading end, then its other end, before going back above into the face zone.
    const narrow = { x1: 340, y1: 740, x2: 740, y2: 830 };
    const under = { x1: 300, y1: 840, x2: 760, y2: 1240 };
    expect(placed(input({ anchorYPct: 40, cueBoxes: [cue({ box: narrow, obstacles: () => [narrow, under] })] }))[0]!.side).toBe("end");
    expect(placed(input({ anchorYPct: 40, cueBoxes: [cue({ box: narrow, direction: "rtl", obstacles: () => [narrow, under] })] }))[0]!.side).toBe("end");
    const right = { x1: 745, y1: 0, x2: 1080, y2: 1920 };
    expect(placed(input({ anchorYPct: 40, cueBoxes: [cue({ box: narrow, obstacles: () => [narrow, under, right] })] }))[0]!.side).toBe("start");
    const left = { x1: 0, y1: 0, x2: 335, y2: 1920 };
    expect(placed(input({ anchorYPct: 40, cueBoxes: [cue({ box: narrow, obstacles: () => [narrow, under, right, left] })] }))[0]!.side).toBe("above");
    // Below at 0.7 is taken before above at full size.
    const tight = cue({ box: mid.box, obstacles: () => [mid.box, { x1: 0, y1: 965, x2: 1080, y2: 1240 }] });
    const shrunk = placed(input({ anchorYPct: 40, cueBoxes: [tight] }))[0]!;
    expect([shrunk.side, shrunk.shrunk]).toEqual(["below", true]);
    // A caption at 47% (the emoji above reaching about 37%) keeps above: an emoji close above its caption, not on the face.
    expect(placed(input({ anchorYPct: 47, cueBoxes: [cue({ box: { x1: 240, y1: 900, x2: 840, y2: 990 } })] }))[0]!.side).toBe("above");
    // A lower caption keeps above.
    expect(placed(input())[0]!.side).toBe("above");
    // Other slots keep their order.
    const style = { ...input().style, slot: "beside-end" as const };
    expect(placed(input({ anchorYPct: 47, cueBoxes: [{ ...mid, box: { x1: 240, y1: 900, x2: 600, y2: 990 } }], style }))[0]!.side).toBe("end");
  });

  test("the Size choice never changes the side, and a larger choice never draws smaller (S <= M <= L)", () => {
    const at = (size: number, cueBoxes: CaptionEmojiLayerInput["cueBoxes"]) => {
      const [outcome] = placeCaptionEmojis(input({ cueBoxes, anchorYPct: 40, style: { ...input().style, size } }));
      if (!outcome?.placed) return { side: "none", height: 0 };
      const ink = pieceBounds({ ...outcome.pieces[1]!, path: outcome.pieces[1]!.path.slice(2) }, 2500, fakeMeasure)!;
      return { side: outcome.side, height: Math.round(ink.y2 - ink.y1) };
    };
    // A three-row stack at heights around the face zone's line: the side is judged at the default size for every choice.
    for (let top = 560; top <= 860; top += 20) {
      const stack = [cue({ box: { x1: 240, y1: top, x2: 840, y2: top + 300 } })];
      const [s, m, l] = [0.8, 1, 1.25].map((size) => at(size, stack));
      expect([s!.side, l!.side], `top ${top}`).toEqual([m!.side, m!.side]);
      expect(s!.height <= m!.height && m!.height <= l!.height, `top ${top}: ${s!.height} ${m!.height} ${l!.height}`).toBe(true);
    }
    // Room above for the default size, not for Large: Large draws at the default size, never at 0.7 of its own (0.875).
    const roof = [cue({ obstacles: () => [cue().box, { x1: 0, y1: 0, x2: 1080, y2: 1010 }] })];
    const [s, m, l] = [0.8, 1, 1.25].map((size) => at(size, roof));
    expect([s!.side, m!.side, l!.side]).toEqual(["above", "above", "above"]);
    expect(l!.height).toBe(m!.height);
    expect(s!.height).toBeLessThan(m!.height);
  });

  test("across classic, Dynamic and Scene captions at three heights: S <= M <= L drawn, on the smaller choice's side", () => {
    type Scenario = { readonly label: string; readonly layer: (size: number) => CaptionEmojiLayerInput };
    const scenarios: Scenario[] = [];
    const sizesOf = (layer: (size: number) => CaptionEmojiLayerInput) =>
      [0.8, 1, 1.25].map((size) => {
        const [outcome] = placeCaptionEmojis(layer(size));
        if (!outcome?.placed) return null;
        const piece = outcome.pieces[1]!;
        const ink = pieceBounds({ ...piece, path: piece.path.slice(2) }, Math.min(piece.fromMs + CAPTION_EMOJI_POP_MS + 10, piece.toMs - 1), fakeMeasure)!;
        return { side: outcome.side, height: Math.round(ink.y2 - ink.y1) };
      });
    // Classic lines (one flat, one that tilts), a short and a full-width line, at the preset's height, 30% and 58%.
    const tilting = Object.entries(CAPTION_MOTIONS).find(([, motion]) => motion.tilt)![0] as CaptionAnimationName;
    const boldPop = getCaptionPresetById("bold-pop")!.preset;
    for (const preset of [boldPop, { ...boldPop, animation: tilting }]) {
      for (const yPct of [preset.positionY ?? 67, 30, 58]) {
        for (const widthEm of [3, 9]) {
          const line = classicLineCueBox({ cueIndex: 1, activeRange: { startSec: 1, endSec: 3 }, anchor: { xPct: 50, yPct }, words: [{ text: "more" }, { text: "money" }], language: "en", preset }, { widthEm, heightEm: 1.4, px: preset.fontSize }, CANVAS);
          for (const slot of ["above", "beside-end"] as const) {
            scenarios.push({ label: `classic ${preset.animation} ${widthEm}em at ${yPct}% ${slot}`, layer: (size) => input({ cueBoxes: [line], emojis: [{ cueIndex: 1, id: "rocket", atMs: 1500 }], anchorYPct: yPct, style: { ...input().style, size, slot } }) });
          }
        }
      }
    }
    // A Dynamic-like block: three rows, each drawn from its word's onset, so the emoji pops by the first row alone.
    for (const yPct of [67, 30, 58]) {
      const top = (yPct / 100) * CANVAS.height - 200;
      const rows = [0, 1, 2].map((row) => ({ x1: 300 - row * 40, y1: top + row * 140, x2: 780 + row * 40, y2: top + row * 140 + 120 }));
      const block = cue({ cueIndex: 0, box: { x1: rows[2]!.x1, y1: rows[0]!.y1, x2: rows[2]!.x2, y2: rows[2]!.y2 }, shownAt: (atMs) => rows.filter((_, row) => atMs >= 1000 + row * 300) });
      scenarios.push({ label: `Dynamic block at ${yPct}%`, layer: (size) => input({ cueBoxes: [block], emojis: [{ cueIndex: 0, id: "heart-eyes", atMs: 1000 }], anchorYPct: yPct, style: { ...input().style, size } }) });
    }
    // Scene Styles: one emoji on each sample cue's hero (else middle) word, alone.
    for (const name of ["bubble", "pills", "tilt", "cascade", "lyrics"] as const) {
      const cues = captionSceneDemo(name).cues;
      for (const positionY of [undefined, 30, 58]) {
        const scene = placementScene({ name, cues, canvas: CANVAS, measure: fakeMeasure, ...(positionY === undefined ? {} : { positionY }) });
        for (const sceneCue of cues) {
          const word = sceneCue.words.find((candidate) => candidate.role === "hero") ?? sceneCue.words[Math.floor((sceneCue.words.length - 1) / 2)]!;
          scenarios.push({
            label: `${name} at ${positionY ?? "default"}, cue ${sceneCue.index}`,
            layer: (size) => ({ cueBoxes: scene.cueBoxes, emojis: [{ cueIndex: sceneCue.index, id: "party", atMs: word.startMs }], art: sceneArt, style: scene.style(size), canvas: CANVAS, anchorYPct: scene.anchorYPct, fps: 30 }),
          });
        }
      }
    }
    // The owner's report: Bubble at 30%, a 🎉 on "and it costs nothing" drew S at 0.8 on the reading-start side and M at 0.7 at its end.
    expect(scenarios.some((scenario) => scenario.label === "bubble at 30, cue 3")).toBe(true);
    for (const { label, layer } of scenarios) {
      const drawn = sizesOf(layer);
      for (let at = 1; at < drawn.length; at++) {
        const [smaller, bigger] = [drawn[at - 1], drawn[at]];
        if (!smaller) continue;
        expect(bigger, `${label}: the larger choice draws whenever the smaller does`).not.toBeNull();
        expect(bigger!.side, `${label}: side`).toBe(smaller.side);
        expect(bigger!.height, `${label}: ${drawn.map((one) => one?.height ?? "none").join(" ")}`).toBeGreaterThanOrEqual(smaller.height);
      }
    }
  });

  test("the layer key changes with what the layer depends on and not otherwise", () => {
    const base = input();
    const key = captionEmojiLayerKey(base, "scene-a");
    expect(captionEmojiLayerKey(input(), "scene-a")).toBe(key);
    expect(captionEmojiLayerKey(base, "scene-b")).not.toBe(key);
    expect(captionEmojiLayerKey(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs: 1300 }] }), "scene-a")).not.toBe(key);
    expect(captionEmojiLayerKey(input({ style: { ...base.style, sticker: false } }), "scene-a")).not.toBe(key);
    expect(captionEmojiLayerKey(input({ art: new Map() }), "scene-a")).not.toBe(key);
    // The clip's render rate sets the placement grid.
    expect(captionEmojiLayerKey(input({ fps: 60 }), "scene-a")).not.toBe(key);
    expect(captionEmojiLayerKey(input({ fps: 60 }), "scene-a")).toBe(captionEmojiLayerKey(input({ fps: 60 }), "scene-a"));
    // The plan's order sets the tilt's sign.
    expect(captionEmojiLayerKey(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs: 1200, order: 1 }] }), "scene-a")).not.toBe(key);
    // The source stands for the boxes: the key does not read them.
    expect(captionEmojiLayerKey(input({ cueBoxes: [cue({ box: { x1: 0, y1: 0, x2: 10, y2: 10 } })] }), "scene-a")).toBe(key);
  });
});

describe("cue boxes for the other caption paths", () => {
  const timing = { cueIndex: 3, fromMs: 0, toMs: 1000, bodyPx: 64, direction: "ltr" as const };

  test("a classic line's box, turned about its anchor", () => {
    expect(lineCueBox({ centerX: 540, top: 1200, bottom: 1280, width: 600 }, timing).box).toEqual({ x1: 240, y1: 1200, x2: 840, y2: 1280 });
    const turned = lineCueBox({ centerX: 540, top: 1200, bottom: 1280, width: 600, tiltDeg: 10, pivot: { x: 540, y: 1240 } }, timing);
    expect(turned.tiltDeg).toBe(10);
    expect(turned.box.y1).toBeLessThan(1200 - 40);
    expect(turned.box.y2).toBeGreaterThan(1280 + 40);
  });

  test("a Dynamic Style block's box is its words' ink, not the reserved entrance travel", () => {
    const word = (baselineX: number, px: number) => ({
      px,
      baselineX,
      baselineY: 1300,
      centerX: baselineX + px,
      centerY: 1280,
      scaleOriginX: baselineX + px,
      scaleOriginY: 1280,
      rotationDeg: 0,
      motionSign: 1 as const,
      entranceTimeScale: 1,
      tile: null,
      keyframes: [],
      clusters: null,
    });
    const layout = {
      scale: 1,
      words: [word(300, 60), word(440, 120)],
      bounds: { x: 200, y: 1100, width: 700, height: 400 },
      decorations: [],
      gradient: null,
      curve: 0,
      shift: { x: 0, y: 0 },
    };
    const measured = [{ advanceEm: 2, inkTopEm: 0.7, inkBottomEm: 0.2 }, { advanceEm: 2, inkTopEm: 0.7, inkBottomEm: 0.2 }];
    expect(blockCueBox(layout, measured, timing)!.box).toEqual({ x1: 300, y1: 1300 - 0.7 * 120, x2: 680, y2: 1300 + 0.2 * 120 });
    expect(blockCueBox({ ...layout, words: [] }, [], timing)).toBeNull();
    // From a plan cue (both renderers): the body role's drawn size, the block's own direction.
    const headline = getCaptionPresetById("headline")!.preset;
    const planCue = { cueIndex: 2, activeRange: { startSec: 1, endSec: 2.5 }, language: "ur", preset: headline, block: { style: headline.dynamic!, texts: ["یہ", "خیال"] } };
    expect(captionBlockCueBox(planCue, { ...layout, scale: 0.8 }, measured)).toMatchObject({
      cueIndex: 2, fromMs: 1000, toMs: 2500, direction: "rtl",
      bodyPx: headline.fontSize * 0.8 * captionDynamicStyle(headline.dynamic!).roles.body.sizeEm,
    });
  });

  test("a classic line from a plan cue: the line box and advance centred on the anchor, grown by the outline at the fitted size", () => {
    const preset = { ...getCaptionPresetById("bold-pop")!.preset, outlineWidth: 6, outerOutlineWidth: 4 };
    const planCue = { cueIndex: 1, activeRange: { startSec: 2, endSec: 3 }, anchor: { xPct: 50, yPct: 70 }, words: [{ text: "more" }, { text: "money" }], language: "en", preset };
    const px = preset.fontSize * 0.5;
    const line = classicLineCueBox(planCue, { widthEm: 4, heightEm: 1.5, px }, CANVAS);
    const stroke = 10 * 0.5;
    expect(line.box).toEqual({ x1: 540 - 2 * px - stroke, y1: 1344 - 0.75 * px - stroke, x2: 540 + 2 * px + stroke, y2: 1344 + 0.75 * px + stroke });
    expect(line).toMatchObject({ cueIndex: 1, fromMs: 2000, toMs: 3000, bodyPx: px, direction: "ltr", tiltDeg: 0 });
    const tilting = Object.entries(CAPTION_MOTIONS).find(([, motion]) => motion.tilt)![0] as CaptionAnimationName;
    expect(classicLineCueBox({ ...planCue, preset: { ...preset, animation: tilting } }, { widthEm: 4, heightEm: 1.5, px }, CANVAS).tiltDeg).toBe(CAPTION_CUE_TILTS_DEG[1]);
  });
});
