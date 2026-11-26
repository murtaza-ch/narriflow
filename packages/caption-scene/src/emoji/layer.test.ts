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
  CAPTION_EMOJI_PIECE_CAP,
  CAPTION_EMOJI_TILT_DEG,
  type CaptionEmojiLayerInput,
  buildCaptionEmojiPieces,
  captionEmojiLayerKey,
  captionEmojiSizePx,
  placeCaptionEmojis,
} from "./layer";
import { captionEmojiSides } from "./placement";
import { CAPTION_EMOJI_FADE_MS, CAPTION_EMOJI_LEAVE_SCALE, CAPTION_EMOJI_POP_FROM, CAPTION_EMOJI_POP_MS, CAPTION_EMOJI_QUICK_FROM, CAPTION_EMOJI_QUICK_MS } from "./timing";

const art = await loadCaptionEmojiArt(["rocket", "thumbs-up", "astronaut", "heart-eyes"]);
/** "hundred" fits above a tall cue near the top where "flame" never does (the late-emoji test). */
const bigArt = await loadCaptionEmojiArt(["hundred", "flame"]);
const CANVAS = { width: 1080, height: 1920 };

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

  test("a late anchor shows its emoji at the word with a quick entrance; under 250 ms left it holds past the cue when clear; never before its word", () => {
    // 300 ms left: at the word, 90 ms to full size, no overshoot.
    const late = placed(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs: 2700 }] }))[0]!.pieces[0]!;
    expect(windowOf([late])).toEqual([2700, 3000]);
    expect(evaluatePiece(late, 2700).sx).toBeCloseTo(CAPTION_EMOJI_QUICK_FROM, 6);
    for (let t = 2700; t < 3000; t += 5) expect(evaluatePiece(late, t).sx).toBeLessThanOrEqual(1);
    expect(evaluatePiece(late, 2700 + CAPTION_EMOJI_QUICK_MS).sx).toBe(1);
    expect(evaluatePiece(late, 3000 - CAPTION_EMOJI_FADE_MS).o).toBe(1);
    // 450 ms or more left: the full pop.
    const early = placed(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs: 2550 }] }))[0]!.pieces[0]!;
    expect(evaluatePiece(early, 2550 + CAPTION_EMOJI_POP_MS * 0.6).sx).toBeGreaterThan(1);
    // Exactly the minimum left: shown, at the word.
    const edge = placed(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs: 3000 - CAPTION_EMOJI_MIN_HOLD_MS }] }))[0]!.pieces[0]!;
    expect(windowOf([edge])).toEqual([3000 - CAPTION_EMOJI_MIN_HOLD_MS, 3000]);
    // Less left: it holds past the cue's last paint to 400 ms from its word, with the quick entrance.
    for (const atMs of [2760, 2850, 2880]) {
      const held = placed(input({ emojis: [{ cueIndex: 0, id: "rocket", atMs }] }))[0]!.pieces[0]!;
      expect(windowOf([held])).toEqual([atMs, atMs + CAPTION_EMOJI_LATE_HOLD_MS]);
      expect(evaluatePiece(held, atMs).sx).toBeCloseTo(CAPTION_EMOJI_QUICK_FROM, 6);
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
    // The earlier one cannot fit (the flame above the tall cue): the later one draws.
    const tall = cue({ box: { x1: 0, y1: 248, x2: 1080, y2: 1890 }, bodyPx: 130 });
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

  test("a slot taken for the whole window by another cue moves the emoji to the other side", () => {
    const blocker = { x1: 0, y1: 0, x2: 1080, y2: 1195 };
    const [emoji] = placed(input({ cueBoxes: [cue({ obstacles: () => [blocker] })] }));
    expect(emoji!.side).toBe("below");
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
    expect(placed(input({ cueBoxes: [cue({ obstacles: () => [ray] })] }))[0]!.side).toBe("below");
    const floor = { x1: 0, y1: 1295, x2: 1080, y2: 1920 };
    expect(placed(input({ cueBoxes: [cue({ obstacles: () => [ray, floor] })] }))[0]).toMatchObject({ side: "above", shrunk: false });
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
    for (const atMs of [1200, 2700, 3000 - CAPTION_EMOJI_MIN_HOLD_MS]) {
      const piece = placed(input({ cueBoxes: [cue(), next], emojis: [{ cueIndex: 0, id: "rocket", atMs }], nextEmojiAtMs: 3050 }))[0]!.pieces[0]!;
      expect(piece.toMs).toBe(3000);
      expect(piece.track.o).toEqual([[3000 - CAPTION_EMOJI_FADE_MS, 1], [3000, 0]]);
      expect(piece.track.sx).toHaveLength(2);
    }
    expect(held({ emojis: [{ cueIndex: 0, id: "rocket", atMs: 2900 }] }).map((outcome) => outcome.placed || outcome.reason)).toEqual(["no-time"]);
  });

  test("it yields to the first emoji of a later cue, whether the input holds that cue or a one-cue feeder passes its time", () => {
    const together = placeCaptionEmojis(input({ cueBoxes: [cue(), next], emojis: [{ cueIndex: 0, id: "rocket", atMs: 2850 }, { cueIndex: 1, id: "thumbs-up", atMs: 3150 }] }));
    const alone = held({ cueBoxes: [cue(), next], nextEmojiAtMs: 3150 });
    expect(alone[0]).toEqual(together[0]!);
    const pieces = alone[0]!.placed ? alone[0]!.pieces : [];
    expect(windowOf(pieces)).toEqual([2850, 3150]);
    // Never two emojis at once: the next one starts where the held one ends.
    expect(together[1]!.placed && windowOf(together[1]!.pieces)[0]).toBe(3150);
    // Still leaving: a fade of at least 90 ms, at full strength before it.
    expect(pieces[0]!.track.o).toEqual([[3150 - CAPTION_EMOJI_FADE_MS, 1], [3150, 0]]);
    // Left under 250 ms from its word by the next emoji: it draws nothing rather than flash.
    expect(held({ nextEmojiAtMs: 3050 }).map((outcome) => outcome.placed || outcome.reason)).toEqual(["no-time"]);
    // A later emoji past the hold changes nothing; the layer key follows the time.
    expect(held({ nextEmojiAtMs: 3600 })).toEqual(held());
    expect(captionEmojiLayerKey(input({ nextEmojiAtMs: 3150 }), "s")).not.toBe(captionEmojiLayerKey(input(), "s"));
  });

  test("it stays off the next cue's box that a one-cue feeder passes beside its own: another slot, or not drawn", () => {
    // The next cue is taller and reaches over the slot above this one; there is room below.
    const taller = cue({ cueIndex: 1, fromMs: 3000, toMs: 4500, box: { x1: 200, y1: 1000, x2: 880, y2: 1290 } });
    const [outcome] = held({ cueBoxes: [cue(), taller] });
    expect(outcome!.placed && outcome!.side).toBe("below");
    const pieces = outcome!.placed ? outcome!.pieces : [];
    for (let t = 3000; t < 3250; t += 1000 / 30) {
      for (const piece of pieces) {
        const ink = pieceBounds({ ...piece, path: piece.path.slice(2) }, t, fakeMeasure)!;
        expect(ink.y1 >= taller.box.y2 || ink.y2 <= taller.box.y1).toBe(true);
      }
    }
    // Without the next box, or for an emoji that ends with its cue, the slot above is kept.
    expect(held()[0]!.placed && (held()[0] as { side: string }).side).toBe("above");
    const ends = placed(input({ cueBoxes: [cue(), taller], emojis: [{ cueIndex: 0, id: "rocket", atMs: 2700 }] }))[0]!;
    expect(ends.side).toBe("above");
    // Covered above and below: not drawn.
    const around = cue({ cueIndex: 1, fromMs: 3000, toMs: 4500, box: { x1: 200, y1: 900, x2: 880, y2: 1700 } });
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
    expect(captionEmojiSides("above", "auto", 20)).toEqual(["below", "above"]);
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

  test("a short line whose longer neighbours crowd its end: the emoji sits level with it at the safe area's edge", () => {
    // A 300 ms cue of fast speech; the stack scrolls 74 px up while it paints.
    const line = { x1: 96, y1: 1248, x2: 411, y2: 1332 };
    const neighbours = [{ x1: 96, y1: 1140, x2: 810, y2: 1214 }, { x1: 96, y1: 1397, x2: 647, y2: 1468 }];
    const scrolled = (boxes: readonly { x1: number; y1: number; x2: number; y2: number }[]) => (atMs: number) => {
      const dy = -74 * Math.min(1, Math.max(0, (atMs - 2850) / 216));
      return boxes.map((box) => ({ ...box, y1: box.y1 + dy, y2: box.y2 + dy }));
    };
    const fast = { fromMs: 2750, toMs: 3100, bodyPx: 92 };
    const style = { ...input().style, slot: "beside-end" as const };
    const emojis = [{ cueIndex: 0, id: "rocket", atMs: 2850 }];
    const outcome = placed(input({ style, emojis, cueBoxes: [cue({ ...fast, box: line, endBox: line, obstacles: scrolled([line, ...neighbours]) })] }))[0];
    expect(outcome?.side).toBe("end");
    const ink = inkOf(outcome!);
    expect(ink.x1).toBeGreaterThan(810);
    expect(ink.x2).toBeLessThanOrEqual(0.95 * CANVAS.width);
    // RTL mirrors it to the left edge.
    const mirror = (box: { x1: number; y1: number; x2: number; y2: number }) => ({ ...box, x1: CANVAS.width - box.x2, x2: CANVAS.width - box.x1 });
    const rtlLine = mirror(line);
    const rtl = placed(input({ style, emojis, cueBoxes: [cue({ ...fast, box: rtlLine, endBox: rtlLine, direction: "rtl", obstacles: scrolled([rtlLine, ...neighbours.map(mirror)]) })] }))[0];
    expect(rtl?.side).toBe("end");
    expect(inkOf(rtl!).x2).toBeLessThan(CANVAS.width - 810);
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

  test("auto goes below a mid-frame caption when the emoji above would reach into the face zone", () => {
    // Caption top at 47% of the height: the emoji above would centre near 43% and reach 39%.
    const mid = cue({ box: { x1: 240, y1: 900, x2: 840, y2: 990 } });
    expect(placed(input({ anchorYPct: 47, cueBoxes: [mid] }))[0]!.side).toBe("below");
    // The owner's explicit position wins.
    expect(placed(input({ anchorYPct: 47, cueBoxes: [mid], style: { ...input().style, position: "above" } }))[0]!.side).toBe("above");
    // Below is taken: level with the cue at its reading end, then its other end, before going back above into the face zone.
    const narrow = { x1: 340, y1: 900, x2: 740, y2: 990 };
    const under = { x1: 300, y1: 1000, x2: 760, y2: 1400 };
    expect(placed(input({ anchorYPct: 47, cueBoxes: [cue({ box: narrow, obstacles: () => [narrow, under] })] }))[0]!.side).toBe("end");
    expect(placed(input({ anchorYPct: 47, cueBoxes: [cue({ box: narrow, direction: "rtl", obstacles: () => [narrow, under] })] }))[0]!.side).toBe("end");
    const right = { x1: 745, y1: 0, x2: 1080, y2: 1920 };
    expect(placed(input({ anchorYPct: 47, cueBoxes: [cue({ box: narrow, obstacles: () => [narrow, under, right] })] }))[0]!.side).toBe("start");
    const left = { x1: 0, y1: 0, x2: 335, y2: 1920 };
    expect(placed(input({ anchorYPct: 47, cueBoxes: [cue({ box: narrow, obstacles: () => [narrow, under, right, left] })] }))[0]!.side).toBe("above");
    // Below at 0.7 is taken before above at full size.
    const tight = cue({ box: mid.box, obstacles: () => [mid.box, { x1: 0, y1: 1125, x2: 1080, y2: 1400 }] });
    const shrunk = placed(input({ anchorYPct: 47, cueBoxes: [tight] }))[0]!;
    expect([shrunk.side, shrunk.shrunk]).toEqual(["below", true]);
    // A lower caption keeps above.
    expect(placed(input())[0]!.side).toBe("above");
    // Other slots keep their order.
    const style = { ...input().style, slot: "beside-end" as const };
    expect(placed(input({ anchorYPct: 47, cueBoxes: [{ ...mid, box: { x1: 240, y1: 900, x2: 600, y2: 990 } }], style }))[0]!.side).toBe("end");
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
