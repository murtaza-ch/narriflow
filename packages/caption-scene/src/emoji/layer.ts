import type { CaptionEmojiArt } from "@narriflow/caption-emoji/art";
import { CAPTION_EMOJI_SIZES, type CaptionEmojiPalette, type CaptionEmojiPosition, type CaptionSceneEmojiSlot } from "@narriflow/validators";
import { SCENE_DEFAULT_FPS, exportFrameTimes, sceneSampleRate } from "../frame-grid";
import type { Box, ShapePiece } from "../scene";
import { turnedBox, unionBox } from "./box";
import type { CaptionEmojiCueBox } from "./cue-box";
import { type CaptionEmojiDrawing, captionEmojiDrawing } from "./drawing";
import {
  CAPTION_EMOJI_FACE_ZONE,
  CAPTION_EMOJI_MAX_GAP,
  CAPTION_EMOJI_MAX_TRIM_MS,
  CAPTION_EMOJI_NUDGES,
  CAPTION_EMOJI_POP_FALLBACK_GAP,
  CAPTION_EMOJI_SHRINK,
  type CaptionEmojiFootprint,
  type CaptionEmojiOccupant,
  type CaptionEmojiSide,
  captionEmojiSideFirst,
  captionEmojiSides,
  slotPivot,
  slotWindow,
} from "./placement";
import { CAPTION_EMOJI_FADE_MS, CAPTION_EMOJI_POP_MS, type CaptionEmojiEntrance, captionEmojiOpacity, captionEmojiScale } from "./timing";

/**
 * The emoji layer (spec D3 to D5): pieces drawn above a target's captions, built from cue boxes,
 * never part of a template's scene, so an emoji edit rebuilds this layer alone. Pure and
 * synchronous; the art must already be loaded.
 */

/** An emoji's size: this many times its cue's body text size, times the preset's `emojiSize`. */
export const CAPTION_EMOJI_BODY_SCALE = 1.6;
/**
 * The emoji's size before `emojiSize` is kept between these fractions of the canvas's short side
 * (so small, default and large always differ). Under 12.5% it reads as a badge next to display text.
 */
export const CAPTION_EMOJI_MIN_SHORT_SIDE = 0.125;
export const CAPTION_EMOJI_MAX_SHORT_SIDE = 0.16;
/**
 * A phrase badge is drawn this many times an emoji's size: its art draws the main emoji at 0.74 of
 * the box (the disc takes the corner), so at 1 it reads smaller than a single emoji beside it (1.2
 * puts the main emoji at 0.89 of one). Placement tries the larger drawing, then it at
 * `CAPTION_EMOJI_SHRINK`, then a single emoji's shrunk size, where a bubble stack leaves no more room
 * (with the smaller Size choices' steps between, `captionEmojiSizeSteps`).
 */
export const CAPTION_EMOJI_BADGE_SCALE = 1.2;
/** The sticker tilt, degrees; it alternates by emoji and mirrors in RTL cues. */
export const CAPTION_EMOJI_TILT_DEG = 7;
/** An anchor word that leaves less than this before the cue's last paint enters with the quick entrance (no overshoot). */
export const CAPTION_EMOJI_QUICK_HOLD_MS = 450;
/**
 * The least an emoji shows at full strength, ms, before it starts to fade. An emoji never shows
 * before its word is spoken, and under about a quarter second a sticker is a flicker. A held emoji
 * (see `CAPTION_EMOJI_MIN_SHOWN_MS`) is at full strength for this long, then leaves (fades and
 * shrinks to `CAPTION_EMOJI_LEAVE_SCALE`) over the rest of its hold.
 */
export const CAPTION_EMOJI_MIN_HOLD_MS = 250;
/**
 * The least window an emoji draws over, ms: `CAPTION_EMOJI_MIN_HOLD_MS` at full strength, then its
 * fade. An anchor word that leaves less than this before its cue's last paint (a cue's last word in
 * fast speech) holds past that paint for `CAPTION_EMOJI_LATE_HOLD_MS` from its word instead, where
 * its slot stays clear on every frame, and otherwise draws nothing. The next emoji of its cue cuts it
 * no shorter: that one starts when this one ends, or draws nothing (`no-time`) when that leaves it
 * less than this.
 */
export const CAPTION_EMOJI_MIN_SHOWN_MS = CAPTION_EMOJI_MIN_HOLD_MS + CAPTION_EMOJI_FADE_MS;
/**
 * The window, from its word, of an emoji whose word leaves its cue under `CAPTION_EMOJI_MIN_SHOWN_MS`,
 * ms. It ends earlier when an emoji of a later cue starts (it yields to the next caption's emoji);
 * one left under `CAPTION_EMOJI_MIN_SHOWN_MS` that way draws nothing (`no-time`).
 */
export const CAPTION_EMOJI_LATE_HOLD_MS = 400;
/**
 * The least a late word must leave of its cue, ms: the emoji enters (the 90 ms quick entrance) while
 * its word is still on screen. Under it, the emoji draws nothing (`no-time`).
 */
export const CAPTION_EMOJI_LATE_MIN_MS = 120;
/**
 * The longest an emoji holds from its word's start, ms (about 1.5 s after a typical word ends); then it
 * fades out as at its cue's end. A sticker that stays over the cue's later words, or over a stack that
 * keeps painting for seconds, reads as random; and the ASS writer's cost grows with an animated
 * piece's length.
 */
export const CAPTION_EMOJI_MAX_HOLD_MS = 2000;
/** Pieces one emoji may draw. */
export const CAPTION_EMOJI_PIECE_CAP = 24;
/** Paint order of every emoji piece: above any template's pieces. */
export const CAPTION_EMOJI_Z = 10_000;

export interface CaptionEmojiLayerEmoji {
  readonly cueIndex: number;
  readonly id: string;
  readonly tone?: number;
  /** The anchor word's start, clip ms. */
  readonly atMs: number;
  /**
   * Its place among the target's emojis in time order (the plan's `order`): the tilt alternates by
   * it, so one cue's emojis placed alone turn as they do with the whole target. Absent, its place
   * in this input's time order.
   */
  readonly order?: number;
}

export interface CaptionEmojiLayerStyle {
  readonly palette: CaptionEmojiPalette;
  /** The preset's `emojiSize` (1 = default). */
  readonly size: number;
  readonly position: CaptionEmojiPosition;
  readonly sticker: boolean;
  /** The template's shadow colour, `#RRGGBB`: the sticker's hard shadow. */
  readonly shadowColour: string;
  /** The style's slot (`captionSceneEmojiSlot`); `above` for Dynamic and classic presets. */
  readonly slot: CaptionSceneEmojiSlot;
}

export interface CaptionEmojiLayerInput {
  readonly cueBoxes: readonly CaptionEmojiCueBox[];
  readonly emojis: readonly CaptionEmojiLayerEmoji[];
  readonly art: ReadonlyMap<string, CaptionEmojiArt>;
  readonly style: CaptionEmojiLayerStyle;
  readonly canvas: { readonly width: number; readonly height: number };
  /** The caption anchor's height, percent of the frame: auto places below a caption in the top 30%. */
  readonly anchorYPct: number;
  /**
   * When the first emoji of the target's cues after this input's cues starts, clip ms (the plan's
   * time of its word, `captionEmojiNextAtMs`): an input that holds one cue (a classic line, a Caption
   * Block) does not see the emojis of the cues after it, and a held emoji yields to them. Emojis of
   * the input's own later cues count without it.
   */
  readonly nextEmojiAtMs?: number;
  /**
   * The render's frame rate (the clip's `renderFrameRate`, which the Studio has too): placement checks collisions
   * and trims windows on its frame grid, the one the scene was planned on and the export writes on.
   * `SCENE_DEFAULT_FPS` when absent.
   */
  readonly fps?: number;
  /**
   * Where the target ends, clip ms (the plan's edited duration): no emoji window runs past it, and a held emoji left under
   * `CAPTION_EMOJI_MIN_SHOWN_MS` before it draws nothing (it never starts before its word). Unbounded when absent.
   */
  readonly endMs?: number;
}

/** What became of one emoji. */
export type CaptionEmojiOutcome =
  | { readonly emoji: CaptionEmojiLayerEmoji; readonly placed: true; readonly side: CaptionEmojiSide; readonly shrunk: boolean; readonly pieces: readonly ShapePiece[] }
  | { readonly emoji: CaptionEmojiLayerEmoji; readonly placed: false; readonly reason: "no-art" | "no-cue" | "no-time" | "piece-cap" | "no-room" };

/** The emoji's size for a cue, px, before any shrink. */
export function captionEmojiSizePx(bodyPx: number, size: number, canvas: { readonly width: number; readonly height: number }): number {
  const short = Math.min(canvas.width, canvas.height);
  return size * Math.min(CAPTION_EMOJI_MAX_SHORT_SIDE * short, Math.max(CAPTION_EMOJI_MIN_SHORT_SIDE * short, CAPTION_EMOJI_BODY_SCALE * bodyPx));
}

/**
 * Whether an auto, above-slot emoji tries below first because above would reach into the face zone
 * (spec D4): talking-head faces fill the upper part of the frame and the layer has no face data.
 * Below then sits under the text that reads when the emoji pops, and must stay clear of the rows a
 * stack reveals after it.
 * Judged by the top of the emoji's ink, not its centre: a centre just under the line still puts the
 * emoji on the chin. An explicit position and other slots keep their order.
 */
function inFaceZone(
  sides: readonly CaptionEmojiSide[],
  style: CaptionEmojiLayerStyle,
  cue: CaptionEmojiCueBox,
  footprint: CaptionEmojiFootprint,
  canvas: { readonly width: number; readonly height: number },
): boolean {
  if (style.position !== "auto" || style.slot !== "above" || sides[0] !== "above") return false;
  return slotPivot(cue, "above", footprint, canvas).y + footprint.ink.y1 < CAPTION_EMOJI_FACE_ZONE * canvas.height;
}

const scaledBox = (box: Box, k: number): Box => ({ x1: box.x1 * k, y1: box.y1 * k, x2: box.x2 * k, y2: box.y2 * k });

/** Sizes, largest first, without one within a hair of the one before. */
const distinctSteps = (steps: readonly number[]) => [...steps].sort((a, b) => b - a).filter((step, at, sorted) => at === 0 || sorted[at - 1]! - step > 1e-9);

/**
 * The sizes one Size choice is tried at, as multiples of the default size, largest first: the choice, every smaller
 * choice at full size (`CAPTION_EMOJI_SIZES`), then its own at `CAPTION_EMOJI_SHRINK` (a badge also at a single emoji's
 * shrunk size). Large that has no room tries the default size before its own shrunk size.
 */
export function captionEmojiSizeSteps(size: number, badge: boolean): number[] {
  return distinctSteps([size, ...CAPTION_EMOJI_SIZES.filter((choice) => choice < size - 1e-9), size * CAPTION_EMOJI_SHRINK, ...(badge ? [(size * CAPTION_EMOJI_SHRINK) / CAPTION_EMOJI_BADGE_SCALE] : [])]);
}

/**
 * Every Size choice up to `size`, smallest first, each with its steps (`captionEmojiSizeSteps`): placement finds the
 * slot with the smallest choice that has one, and a larger choice only draws larger there (S <= M <= L, on one side).
 */
export function captionEmojiSizeChains(size: number, badge: boolean): number[][] {
  const choices = [...CAPTION_EMOJI_SIZES.filter((choice) => choice < size - 1e-9), size];
  return choices.map((choice) => captionEmojiSizeSteps(choice, badge));
}

/** An emoji as placement sees it, in time order, with what is known before any slot is tried. */
interface Planned {
  readonly emoji: CaptionEmojiLayerEmoji;
  /** Its place in time order: piece ids and, without the plan's `order`, the tilt. */
  readonly order: number;
  /** Its cue's box, with what it must miss (`withOtherCues`). */
  readonly cue: CaptionEmojiCueBox;
  readonly fromMs: number;
  /** Where its window may end at the latest: the cue's last paint, or later for a late word (`CAPTION_EMOJI_LATE_HOLD_MS`). */
  readonly untilMs: number;
  readonly entrance: CaptionEmojiEntrance;
  readonly tiltDeg: number;
  /** Every step of its Size choice and the smaller ones, largest first: its choice first. */
  readonly sizes: readonly Size[];
  /** The steps of each Size choice up to its own, smallest choice first (`captionEmojiSizeChains`), out of `sizes`. */
  readonly chains: readonly (readonly Size[])[];
  /**
   * The earlier emojis of its cue it starts less than a frame after (a late anchor clamped to the
   * start of the one before, or two words at once). It cannot take their slot: it is tried only when
   * all of them are dropped, and until then it cuts no window.
   */
  readonly waitsFor: readonly Planned[];
}

interface Size {
  readonly shrink: number;
  readonly sizePx: number;
  readonly drawing: CaptionEmojiDrawing;
  /** The drawing's ink turned by the tilt, relative to the pivot. */
  readonly ink: Box;
}

/** A placed emoji: its slot, and the window it shows over, which a later dropped emoji of its cue can lengthen. */
interface Placed {
  readonly planned: Planned;
  /** Where its window starts at the earliest: its word, or the end of the emoji of its cue before it (`CAPTION_EMOJI_MIN_SHOWN_MS`). */
  readonly startMs: number;
  readonly x: number;
  readonly y: number;
  readonly size: Size;
  readonly side: CaptionEmojiSide;
  readonly strict: boolean;
  shown: { readonly fromMs: number; readonly toMs: number };
  /** The planned emoji whose start ends this window, if any. */
  cutBy: Planned | null;
  occupant: CaptionEmojiOccupant;
}

type Unplaceable = Extract<CaptionEmojiOutcome, { placed: false }>["reason"];

/**
 * A cue box with what its emoji must miss. A box with `obstacles` (a Scene Style's) names every cue's
 * live pieces already. A box without (a classic line, a Caption Block) is missed itself, and so is
 * every other cue box of the input while that cue paints: a held emoji must stay off the next cue's
 * text, which a one-cue feeder passes beside its own box.
 */
function withOtherCues(cue: CaptionEmojiCueBox, cueBoxes: readonly CaptionEmojiCueBox[]): CaptionEmojiCueBox {
  if (cue.obstacles) return cue;
  const others = cueBoxes.filter((other) => other.cueIndex !== cue.cueIndex);
  if (others.length === 0) return cue;
  return { ...cue, obstacles: (atMs) => [cue.box, ...others.filter((other) => atMs >= other.fromMs && atMs < other.toMs).map((other) => other.box)] };
}

/**
 * When a held emoji starts to leave: at its cue's last paint, after at least `CAPTION_EMOJI_MIN_HOLD_MS`
 * at full strength. Undefined for an emoji that ends with its cue (it takes the usual fade).
 */
function leaveFromMs(cue: CaptionEmojiCueBox, shown: { readonly fromMs: number; readonly toMs: number }): number | undefined {
  return shown.toMs > cue.toMs ? Math.max(cue.toMs, shown.fromMs + CAPTION_EMOJI_MIN_HOLD_MS) : undefined;
}

/**
 * When each emoji starts (spec D5): at its anchor word, never before it and never before an earlier
 * emoji of its cue starts. A word that leaves less than `CAPTION_EMOJI_MIN_SHOWN_MS` before its cue's
 * last paint may hold past it to `CAPTION_EMOJI_LATE_HOLD_MS` from the word (placement checks the
 * slot over that time) or to the first emoji of a later cue, by its word's time whether or not that
 * one draws (a one-cue feeder knows no more), and with less than `CAPTION_EMOJI_MIN_SHOWN_MS` that
 * way, or under `CAPTION_EMOJI_LATE_MIN_MS` left in its cue, draws nothing (`no-time`); one whose
 * window is under `CAPTION_EMOJI_QUICK_HOLD_MS` enters quickly. One that would start less than a frame after an earlier one waits for it (`waitsFor`)
 * rather than replacing it.
 */
function plan(input: CaptionEmojiLayerInput): (Planned | { readonly emoji: CaptionEmojiLayerEmoji; readonly reason: Unplaceable })[] {
  const cues = new Map(input.cueBoxes.map((cue) => [cue.cueIndex, withOtherCues(cue, input.cueBoxes)]));
  /** Where an emoji of `cueIndex` yields: the first emoji of a later cue, in the input or after it. */
  const yieldAt = (cueIndex: number) => Math.min(input.nextEmojiAtMs ?? Number.POSITIVE_INFINITY, ...input.emojis.filter((other) => other.cueIndex > cueIndex).map((other) => other.atMs));
  const ordered = input.emojis.map((emoji, at) => ({ emoji, at })).sort((a, b) => a.emoji.atMs - b.emoji.atMs || a.at - b.at);
  const lastStart = new Map<number, number>();
  const earlier = new Map<number, Planned[]>();
  const frameMs = 1000 / sceneSampleRate(input.fps ?? SCENE_DEFAULT_FPS);
  return ordered.map(({ emoji }, order) => {
    const art = input.art.get(emoji.id);
    if (!art) return { emoji, reason: "no-art" as const };
    const cue = cues.get(emoji.cueIndex);
    if (!cue) return { emoji, reason: "no-cue" as const };
    const sign = ((emoji.order ?? order) % 2 === 0 ? 1 : -1) * (cue.direction === "rtl" ? -1 : 1);
    const tiltDeg = cue.tiltDeg + sign * CAPTION_EMOJI_TILT_DEG;
    // The default size's drawing px (`emojiSize` 1): the Size choice multiplies it, and each step is a multiple of it.
    const unitPx = captionEmojiSizePx(cue.bodyPx, 1, input.canvas) * (art.badge ? CAPTION_EMOJI_BADGE_SCALE : 1);
    const stepChains = captionEmojiSizeChains(input.style.size, art.badge);
    const steps = distinctSteps(stepChains.flat());
    const sizes = steps.map((step): Size => {
      const sizePx = unitPx * step;
      const shrink = step / input.style.size;
      const drawing = captionEmojiDrawing(art, { sizePx, palette: input.style.palette, ...(emoji.tone !== undefined ? { tone: emoji.tone } : {}), sticker: input.style.sticker, shadowColour: input.style.shadowColour, tiltDeg });
      return { shrink, sizePx, drawing, ink: turnedBox(drawing.ink, tiltDeg) };
    });
    const sizeOf = (step: number) => sizes[steps.findIndex((each) => Math.abs(each - step) <= 1e-9)]!;
    const chains = stepChains.map((chain) => chain.map(sizeOf));
    if (sizes[0]!.drawing.parts.length > CAPTION_EMOJI_PIECE_CAP) return { emoji, reason: "piece-cap" as const };
    const at = Math.min(Math.max(emoji.atMs, cue.fromMs), cue.toMs);
    const left = cue.toMs - at;
    if (left < CAPTION_EMOJI_LATE_MIN_MS) return { emoji, reason: "no-time" as const };
    const held = left < CAPTION_EMOJI_MIN_SHOWN_MS;
    // Cut at the clip's end before the least window is checked: time after it is never seen.
    const untilMs = Math.min(input.endMs ?? Number.POSITIVE_INFINITY, held ? Math.max(cue.toMs, Math.min(at + CAPTION_EMOJI_LATE_HOLD_MS, yieldAt(cue.cueIndex))) : cue.toMs);
    if (untilMs - at < CAPTION_EMOJI_MIN_SHOWN_MS) return { emoji, reason: "no-time" as const };
    const fromMs = Math.max(at, lastStart.get(cue.cueIndex) ?? Number.NEGATIVE_INFINITY);
    lastStart.set(cue.cueIndex, fromMs);
    const entrance: CaptionEmojiEntrance = untilMs - at < CAPTION_EMOJI_QUICK_HOLD_MS ? "quick" : "pop";
    const before = earlier.get(cue.cueIndex) ?? [];
    const planned: Planned = { emoji, order, cue, fromMs, untilMs, entrance, tiltDeg, sizes, chains, waitsFor: before.filter((other) => fromMs - other.fromMs < frameMs) };
    earlier.set(cue.cueIndex, [...before, planned]);
    return planned;
  });
}

/**
 * The boxes an emoji starting at `startMs` is kept close to (`CAPTION_EMOJI_MAX_GAP`): its cue's text that reads on the
 * emoji's first painted frame (the first export frame at or after its start), or, when nothing reads yet on that frame, on
 * the first frame of its pop that shows some. A row a stack reveals later in the pop does not count: the emoji would sit
 * alone by empty space until it appeared. A cue without `shownAt` shows its whole box. The conformance checks use the same
 * frame.
 */
export function captionEmojiShownAtPop(cue: Pick<CaptionEmojiCueBox, "box" | "shownAt">, startMs: number, fps: number = SCENE_DEFAULT_FPS): readonly Box[] {
  if (!cue.shownAt) return [cue.box];
  for (const t of exportFrameTimes(startMs, startMs + CAPTION_EMOJI_POP_MS, fps)) {
    const boxes = cue.shownAt(t);
    if (boxes.length > 0) return boxes;
  }
  return [];
}

/** Where each emoji went, or why it was dropped, in time order. */
export function placeCaptionEmojis(input: CaptionEmojiLayerInput): CaptionEmojiOutcome[] {
  const fps = input.fps ?? SCENE_DEFAULT_FPS;
  const frameMs = 1000 / sceneSampleRate(fps);
  const planned = plan(input);
  const candidates = planned.filter((entry): entry is Planned => "cue" in entry);
  const dropped = new Set<Planned>();
  /** An emoji still waiting for an earlier one of its cue that may draw. */
  const waiting = (emoji: Planned) => emoji.waitsFor.some((other) => !dropped.has(other));
  /**
   * The window an emoji starting at `fromMs` may show over: to the next emoji of its cue that is not
   * dropped or waiting (an unknown id, a dropped emoji or one that waits for it does not shorten it),
   * but never under `CAPTION_EMOJI_MIN_SHOWN_MS` that way; the cue's last paint (later for a late
   * word); or `CAPTION_EMOJI_MAX_HOLD_MS`.
   */
  const windowOf = (emoji: Planned, fromMs: number) => {
    const next = candidates.find((other) => other.order > emoji.order && other.cue === emoji.cue && other.fromMs >= emoji.fromMs && !dropped.has(other) && !waiting(other)) ?? null;
    const cut = next ? Math.max(next.fromMs, fromMs + CAPTION_EMOJI_MIN_SHOWN_MS) : Number.POSITIVE_INFINITY;
    return { toMs: Math.min(emoji.untilMs, fromMs + CAPTION_EMOJI_MAX_HOLD_MS, cut), cutBy: next };
  };
  const occupants: CaptionEmojiOccupant[] = [];
  const placed = new Map<Planned, Placed>();
  /** The latest emoji of each cue that draws. */
  const latest = new Map<CaptionEmojiCueBox, Placed>();
  const reasons = new Map<Planned, Unplaceable>();

  const occupantOf = (at: { x: number; y: number }, size: Size, shown: { fromMs: number; toMs: number }, emoji: Planned): CaptionEmojiOccupant => ({
    x: at.x,
    y: at.y,
    ink: size.ink,
    fromMs: shown.fromMs,
    toMs: shown.toMs,
    scale: captionEmojiScale(shown.fromMs, shown.toMs, emoji.entrance, leaveFromMs(emoji.cue, shown)),
  });

  const tryPlace = (emoji: Planned, fromMs: number, toMs: number): Placed | null => {
    const { cue, sizes, chains, entrance } = emoji;
    const autoSides = captionEmojiSides(input.style.slot, input.style.position, input.anchorYPct);
    // Judged at the default size, so the Size choice never changes the side.
    const full = sizes[0]!;
    const reference = full.sizePx / input.style.size;
    const faceZone = inFaceZone(autoSides, input.style, cue, { sizePx: reference, ink: scaledBox(full.ink, 1 / input.style.size) }, input.canvas);
    // In the face zone: below, then level with the cue at its reading end and its other end, and only then back above.
    const sides: readonly CaptionEmojiSide[] = faceZone ? ["below", "end", "start", "above"] : autoSides;
    const sideFirst = faceZone || captionEmojiSideFirst(input.style.slot, input.style.position);
    // What reads on the emoji's first painted frame (`captionEmojiShownAtPop`): the slot keeps close to it, and below sits
    // under it (a stack's later rows must then stay clear of the emoji, which the window's collision check sees).
    const shownFrom = (startMs: number): readonly Box[] => captionEmojiShownAtPop(cue, startMs, fps);
    const shownOverPop = (startMs: number): readonly Box[] => (cue.shownAt ? exportFrameTimes(startMs, startMs + CAPTION_EMOJI_POP_MS, fps).flatMap((t) => cue.shownAt!(t)) : [cue.box]);
    const shownBoxes = shownFrom(fromMs);
    const shown = unionBox(shownBoxes);
    // Every text that may read when it pops, from its word to the latest start it may wait for (`CAPTION_EMOJI_MAX_TRIM_MS`):
    // a slot far from all of it is skipped before its window is checked.
    const reachable = cue.shownAt ? exportFrameTimes(fromMs, fromMs + CAPTION_EMOJI_MAX_TRIM_MS + CAPTION_EMOJI_POP_MS, fps).flatMap((t) => cue.shownAt!(t)) : shownBoxes;
    // Near some text that reads (or its plate), not only near the union of it: a stack's rows can sit far apart.
    const close = (pivot: { x: number; y: number }, size: Size, boxes: readonly Box[], gap: number = CAPTION_EMOJI_MAX_GAP) => {
      if (boxes.length === 0) return true;
      const { ink } = size;
      const limit = gap * (ink.y2 - ink.y1);
      return boxes.some((box) => {
        const dx = Math.max(0, box.x1 - (pivot.x + ink.x2), pivot.x + ink.x1 - box.x2);
        const dy = Math.max(0, box.y1 - (pivot.y + ink.y2), pivot.y + ink.y1 - box.y2);
        return Math.hypot(dx, dy) <= limit;
      });
    };
    const sameBox = (a: Box, b: Box) => a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2;
    /**
     * What a side's slot is measured from, in order. Above: the cue's box, then the text that reads at the pop (a stack whose
     * late box reaches higher than what is on screen then). Below: that text alone. Beside: level with the last row, then
     * with the whole cue past its widest row (a stack whose dim neighbour lines crowd the last row's end leaves room there),
     * then with the text that reads at the pop.
     */
    const references = (side: CaptionEmojiSide): CaptionEmojiCueBox[] => {
      const popped = cue.shownAt && shown ? shown : null;
      if (side === "below") return [popped ? { ...cue, box: popped } : cue];
      if (side === "above") return [cue, ...(popped && !sameBox(popped, cue.box) ? [{ ...cue, box: popped }] : [])];
      const rows = cue.endBox ? [cue.endBox, cue.box] : [cue.box];
      if (popped && !rows.some((row) => sameBox(row, popped))) rows.push(popped);
      return rows.map((row) => ({ ...cue, endBox: row }));
    };
    // Judged by what reads on its first painted frame, at the start it may have waited for. Failing that everywhere, a slot
    // close to the text that reads by the end of its pop, and not far from what reads on its first frame
    // (`CAPTION_EMOJI_POP_FALLBACK_GAP`): a bubble or a frame that grows in with the word; better than no emoji.
    const fits = [
      (pivot: { x: number; y: number }, size: Size, startMs: number) => close(pivot, size, startMs === fromMs ? shownBoxes : shownFrom(startMs)),
      (pivot: { x: number; y: number }, size: Size, startMs: number) => close(pivot, size, shownOverPop(startMs)) && close(pivot, size, shownFrom(startMs), CAPTION_EMOJI_POP_FALLBACK_GAP),
    ];
    // The tiers, best first: closeness by the first frame, then the fallback; in each, clear of everything, then covering
    // decorations (soft obstacles); in each, by the text, then at the edge slots (`slotPivot`).
    const tiers = fits.flatMap((fit) => [true, false].flatMap((strict) => [false, true].map((edge) => ({ fit, strict, edge }))));
    const beside = (side: CaptionEmojiSide) => side === "end" || side === "start";
    const attempt = ({ fit, strict, edge }: (typeof tiers)[number], size: Size, side: CaptionEmojiSide): Placed | null => {
      for (const reference of references(side)) {
        for (const nudge of edge && beside(side) ? [0] : CAPTION_EMOJI_NUDGES) {
          const pivot = slotPivot(reference, side, size, input.canvas, nudge, edge);
          if (!close(pivot, size, reachable)) continue;
          const window = slotWindow({ ...pivot, ink: size.ink, fromMs, toMs, cue, occupants, canvas: input.canvas, fps, strict, entrance });
          if (window && fit(pivot, size, window.fromMs)) return { planned: emoji, startMs: fromMs, ...pivot, size, side, strict, shown: window, cutBy: null, occupant: occupantOf(pivot, size, window, emoji) };
        }
      }
      return null;
    };
    // One choice's search: tier by tier; in each, every size of a side before the next side for auto on an above slot and
    // the face zone, every side of a size before the next size otherwise.
    const search = (chain: readonly Size[]): { readonly placed: Placed; readonly tier: number } | null => {
      for (const [tier, rule] of tiers.entries()) {
        const order = sideFirst ? sides.flatMap((side) => chain.map((size) => [size, side] as const)) : chain.flatMap((size) => sides.map((side) => [size, side] as const));
        for (const [size, side] of order) {
          const placed = attempt(rule, size, side);
          if (placed) return { placed, tier };
        }
      }
      return null;
    };
    // The side is the smallest Size choice's that finds a slot (`captionEmojiSizeChains`); a larger choice then takes the
    // largest of its sizes that fits on that side in as good a tier, so for one cue S <= M <= L, on one side.
    const found = chains.reduce<ReturnType<typeof search>>((done, chain) => done ?? search(chain), null);
    if (!found) return null;
    for (const size of sizes) {
      if (size.sizePx <= found.placed.size.sizePx + 1e-6) break;
      for (const [tier, rule] of tiers.entries()) {
        if (tier > found.tier) break;
        const placed = attempt(rule, size, found.placed.side);
        if (placed) return placed;
      }
    }
    return found.placed;
  };

  /**
   * A dropped emoji gives its time back to the latest emoji of its cue that draws, when that one was cut by it and its slot
   * stays clear for longer (an earlier one is never lengthened: it would run over the latest).
   */
  const lengthen = (gone: Planned) => {
    const before = latest.get(gone.cue);
    if (!before || before.cutBy !== gone) return;
    const { toMs, cutBy } = windowOf(before.planned, before.startMs);
    // Its least window already ends past the next emoji's word: the window stays, and now that next emoji starts where it ends.
    if (toMs <= before.shown.toMs) {
      before.cutBy = toMs === before.shown.toMs ? cutBy : null;
      return;
    }
    const others = occupants.filter((other) => other !== before.occupant);
    const shown = slotWindow({ x: before.x, y: before.y, ink: before.size.ink, fromMs: before.shown.fromMs, toMs, cue: before.planned.cue, occupants: others, canvas: input.canvas, fps, strict: before.strict, entrance: before.planned.entrance });
    if (!shown || shown.fromMs !== before.shown.fromMs || shown.toMs <= before.shown.toMs) {
      // Not lengthened: the emoji after the dropped one now starts where this one ends, never inside it.
      before.cutBy = cutBy;
      return;
    }
    const occupant = occupantOf(before, before.size, shown, before.planned);
    occupants[occupants.indexOf(before.occupant)] = occupant;
    before.occupant = occupant;
    before.shown = shown;
    before.cutBy = shown.toMs === toMs ? cutBy : null;
  };

  for (const emoji of candidates) {
    // An earlier emoji it waited for was placed and holds the slot: this one's word has no time of its own.
    if (waiting(emoji)) {
      reasons.set(emoji, "no-time");
      dropped.add(emoji);
      continue;
    }
    // The latest emoji of its cue that draws keeps its window: this one starts when that one ends, never inside it (that one
    // may not have been cut for this one, when an emoji between them was still waiting).
    const before = latest.get(emoji.cue);
    const fromMs = Math.max(emoji.fromMs, before?.shown.toMs ?? Number.NEGATIVE_INFINITY);
    const { toMs, cutBy } = windowOf(emoji, fromMs);
    const short = toMs - fromMs < Math.min(CAPTION_EMOJI_MIN_SHOWN_MS, emoji.untilMs - emoji.fromMs) || toMs - fromMs < frameMs;
    const result = short ? null : tryPlace(emoji, fromMs, toMs);
    if (!result) {
      reasons.set(emoji, short ? "no-time" : "no-room");
      dropped.add(emoji);
      lengthen(emoji);
      continue;
    }
    // Only a window that reaches the next emoji's start was cut by it (one that left early for the cue's exit was not).
    result.cutBy = result.shown.toMs === toMs ? cutBy : null;
    occupants.push(result.occupant);
    placed.set(emoji, result);
    latest.set(emoji.cue, result);
  }

  return planned.map((entry): CaptionEmojiOutcome => {
    if (!("cue" in entry)) return { emoji: entry.emoji, placed: false, reason: entry.reason };
    const result = placed.get(entry);
    if (!result) return { emoji: entry.emoji, placed: false, reason: reasons.get(entry) ?? "no-room" };
    return { emoji: entry.emoji, placed: true, side: result.side, shrunk: result.size.shrink !== 1, pieces: emojiPieces(result) };
  });
}

function emojiPieces(placed: Placed): ShapePiece[] {
  const { planned, size, shown } = placed;
  const half = size.drawing.side / 2;
  const leave = leaveFromMs(planned.cue, shown);
  const scale = captionEmojiScale(shown.fromMs, shown.toMs, planned.entrance, leave);
  return size.drawing.parts.map((part): ShapePiece => ({
    id: `emoji:${planned.cue.cueIndex}:${planned.order}:${part.key}`,
    kind: "shape",
    z: CAPTION_EMOJI_Z,
    fromMs: shown.fromMs,
    toMs: shown.toMs,
    origin: { dx: half, dy: half },
    path: part.path,
    fill: part.alpha === undefined ? { colour: part.colour } : { colour: part.colour, alpha: part.alpha },
    track: {
      x: [[shown.fromMs, placed.x]],
      y: [[shown.fromMs, placed.y]],
      sx: scale,
      sy: scale,
      rz: [[shown.fromMs, planned.tiltDeg]],
      o: captionEmojiOpacity(shown.fromMs, shown.toMs, planned.entrance, leave),
    },
  }));
}

/** Every piece of the emoji layer, in paint order. */
export function buildCaptionEmojiPieces(input: CaptionEmojiLayerInput): ShapePiece[] {
  return placeCaptionEmojis(input).flatMap((outcome) => (outcome.placed ? outcome.pieces : []));
}

/**
 * What the layer is a function of besides its cue boxes, as a string, for memoising: `source` names
 * what the boxes and their obstacles come from (a built scene's identity, or one cue's own box) and
 * stands for them, since equal sources give equal boxes; then the emojis (with their order, which
 * sets the tilt), which of their art is loaded, the style, the canvas, the anchor height, the frame rate,
 * where held emojis yield and where the target ends.
 */
export function captionEmojiLayerKey(input: Omit<CaptionEmojiLayerInput, "cueBoxes">, source: string): string {
  const { style } = input;
  return JSON.stringify([
    source,
    input.canvas.width,
    input.canvas.height,
    input.anchorYPct,
    input.fps ?? null,
    input.nextEmojiAtMs ?? null,
    input.endMs ?? null,
    [style.palette.a, style.palette.b, style.palette.c, style.size, style.position, style.sticker, style.shadowColour, style.slot],
    input.emojis.map((emoji) => [emoji.cueIndex, emoji.id, emoji.tone ?? 0, emoji.atMs, emoji.order ?? null, input.art.has(emoji.id)]),
  ]);
}
