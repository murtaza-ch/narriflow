import type { CaptionEmojiArt } from "@narriflow/caption-emoji/art";
import type { CaptionEmojiPalette, CaptionEmojiPosition, CaptionSceneEmojiSlot } from "@narriflow/validators";
import { SCENE_DEFAULT_FPS, sceneSampleRate } from "../frame-grid";
import type { Box, ShapePiece } from "../scene";
import { turnedBox } from "./box";
import type { CaptionEmojiCueBox } from "./cue-box";
import { type CaptionEmojiDrawing, captionEmojiDrawing } from "./drawing";
import {
  CAPTION_EMOJI_FACE_ZONE,
  CAPTION_EMOJI_NUDGES,
  CAPTION_EMOJI_SHRINK,
  type CaptionEmojiFootprint,
  type CaptionEmojiOccupant,
  type CaptionEmojiSide,
  captionEmojiSides,
  slotPivot,
  slotWindow,
} from "./placement";
import { type CaptionEmojiEntrance, captionEmojiOpacity, captionEmojiScale } from "./timing";

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
 * `CAPTION_EMOJI_SHRINK`, then a single emoji's shrunk size, where a bubble stack leaves no more room.
 */
export const CAPTION_EMOJI_BADGE_SCALE = 1.2;
/** The sticker tilt, degrees; it alternates by emoji and mirrors in RTL cues. */
export const CAPTION_EMOJI_TILT_DEG = 7;
/** An anchor word that leaves less than this before the cue's last paint enters with the quick entrance (no overshoot). */
export const CAPTION_EMOJI_QUICK_HOLD_MS = 450;
/**
 * The least an emoji shows inside its cue, ms. An emoji never shows before its word is spoken, and
 * under about a quarter second a sticker is a flicker: an anchor word that leaves less than this
 * before its cue's last paint (a cue's last word in fast speech) holds past that paint for
 * `CAPTION_EMOJI_LATE_HOLD_MS` from its word instead, where its slot stays clear on every frame, and
 * otherwise draws nothing. A held emoji is at full strength for this long, then leaves (fades and
 * shrinks to `CAPTION_EMOJI_LEAVE_SCALE`) over the rest of its hold.
 */
export const CAPTION_EMOJI_MIN_HOLD_MS = 250;
/**
 * The window, from its word, of an emoji whose word leaves its cue under `CAPTION_EMOJI_MIN_HOLD_MS`,
 * ms. It ends earlier when an emoji of a later cue starts (it yields to the next caption's emoji);
 * one left under `CAPTION_EMOJI_MIN_HOLD_MS` that way draws nothing (`no-time`).
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
  /** At full size, then at `CAPTION_EMOJI_SHRINK` (a badge last at a single emoji's shrunk size). */
  readonly sizes: readonly Size[];
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
 * emoji of its cue starts. A word that leaves less than `CAPTION_EMOJI_MIN_HOLD_MS` before its cue's
 * last paint may hold past it to `CAPTION_EMOJI_LATE_HOLD_MS` from the word (placement checks the
 * slot over that time) or to the first emoji of a later cue, by its word's time whether or not that
 * one draws (a one-cue feeder knows no more), and with less than `CAPTION_EMOJI_MIN_HOLD_MS` that
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
    const fullPx = captionEmojiSizePx(cue.bodyPx, input.style.size, input.canvas) * (art.badge ? CAPTION_EMOJI_BADGE_SCALE : 1);
    const shrinks = art.badge ? [1, CAPTION_EMOJI_SHRINK, CAPTION_EMOJI_SHRINK / CAPTION_EMOJI_BADGE_SCALE] : [1, CAPTION_EMOJI_SHRINK];
    const sizes = shrinks.map((shrink): Size => {
      const sizePx = fullPx * shrink;
      const drawing = captionEmojiDrawing(art, { sizePx, palette: input.style.palette, ...(emoji.tone !== undefined ? { tone: emoji.tone } : {}), sticker: input.style.sticker, shadowColour: input.style.shadowColour, tiltDeg });
      return { shrink, sizePx, drawing, ink: turnedBox(drawing.ink, tiltDeg) };
    });
    if (sizes[0]!.drawing.parts.length > CAPTION_EMOJI_PIECE_CAP) return { emoji, reason: "piece-cap" as const };
    const at = Math.min(Math.max(emoji.atMs, cue.fromMs), cue.toMs);
    const left = cue.toMs - at;
    if (left < CAPTION_EMOJI_LATE_MIN_MS) return { emoji, reason: "no-time" as const };
    const held = left < CAPTION_EMOJI_MIN_HOLD_MS;
    const untilMs = held ? Math.max(cue.toMs, Math.min(at + CAPTION_EMOJI_LATE_HOLD_MS, yieldAt(cue.cueIndex))) : cue.toMs;
    if (held && untilMs - at < CAPTION_EMOJI_MIN_HOLD_MS) return { emoji, reason: "no-time" as const };
    const fromMs = Math.max(at, lastStart.get(cue.cueIndex) ?? Number.NEGATIVE_INFINITY);
    lastStart.set(cue.cueIndex, fromMs);
    const entrance: CaptionEmojiEntrance = untilMs - at < CAPTION_EMOJI_QUICK_HOLD_MS ? "quick" : "pop";
    const before = earlier.get(cue.cueIndex) ?? [];
    const planned: Planned = { emoji, order, cue, fromMs, untilMs, entrance, tiltDeg, sizes, waitsFor: before.filter((other) => fromMs - other.fromMs < frameMs) };
    earlier.set(cue.cueIndex, [...before, planned]);
    return planned;
  });
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
   * The window an emoji may show over: to the next emoji of its cue that is not dropped or waiting
   * (an unknown id, a dropped emoji or one that waits for it does not shorten it), the cue's last
   * paint (later for a late word), or `CAPTION_EMOJI_MAX_HOLD_MS`.
   */
  const windowOf = (emoji: Planned) => {
    const next = candidates.find((other) => other.order > emoji.order && other.cue === emoji.cue && other.fromMs >= emoji.fromMs && !dropped.has(other) && !waiting(other)) ?? null;
    return { toMs: Math.min(emoji.untilMs, emoji.fromMs + CAPTION_EMOJI_MAX_HOLD_MS, next?.fromMs ?? Number.POSITIVE_INFINITY), cutBy: next };
  };
  const occupants: CaptionEmojiOccupant[] = [];
  const placed = new Map<Planned, Placed>();
  const reasons = new Map<Planned, Unplaceable>();

  const occupantOf = (at: { x: number; y: number }, size: Size, shown: { fromMs: number; toMs: number }, emoji: Planned): CaptionEmojiOccupant => ({
    x: at.x,
    y: at.y,
    ink: size.ink,
    fromMs: shown.fromMs,
    toMs: shown.toMs,
    scale: captionEmojiScale(shown.fromMs, shown.toMs, emoji.entrance, leaveFromMs(emoji.cue, shown)),
  });

  const tryPlace = (emoji: Planned, toMs: number): Placed | null => {
    const { cue, fromMs, sizes, entrance } = emoji;
    const autoSides = captionEmojiSides(input.style.slot, input.style.position, input.anchorYPct);
    const faceZone = inFaceZone(autoSides, input.style, cue, sizes[0]!, input.canvas);
    // In the face zone: below, then level with the cue at its reading end and its other end, and only then back above.
    const sides: readonly CaptionEmojiSide[] = faceZone ? ["below", "end", "start", "above"] : autoSides;
    // Clear of everything at full size, then at 0.7, then the same at the edge slots (`slotPivot`); only then covering
    // decorations (soft obstacles), full size first. In the face zone each side is tried at every size before the next side.
    // A side slot sits level with the last row, then level with the whole cue past its widest row
    // (a stack whose dim neighbour lines crowd the last row's end leaves room there).
    const rows = (side: CaptionEmojiSide) => (cue.endBox && (side === "end" || side === "start") ? [cue.endBox, cue.box] : [undefined]);
    const beside = (side: CaptionEmojiSide) => side === "end" || side === "start";
    const at = (strict: boolean, edge: boolean, size: Size, side: CaptionEmojiSide) =>
      rows(side).flatMap((row) => (edge && beside(side) ? [0] : CAPTION_EMOJI_NUDGES).map((nudge) => ({ strict, edge, size, side, row, nudge })));
    const pass = (strict: boolean, edge: boolean) =>
      faceZone ? sides.flatMap((side) => sizes.flatMap((size) => at(strict, edge, size, side))) : sizes.flatMap((size) => sides.flatMap((side) => at(strict, edge, size, side)));
    const tries = [true, false].flatMap((strict) => [false, true].flatMap((edge) => pass(strict, edge)));
    for (const { strict, edge, size, side, row, nudge } of tries) {
      const pivot = slotPivot(row ? { ...cue, endBox: row } : cue, side, size, input.canvas, nudge, edge);
      const shown = slotWindow({ ...pivot, ink: size.ink, fromMs, toMs, cue, occupants, canvas: input.canvas, fps, strict, entrance });
      if (shown) return { planned: emoji, ...pivot, size, side, strict, shown, cutBy: null, occupant: occupantOf(pivot, size, shown, emoji) };
    }
    return null;
  };

  /** A dropped emoji gives its time back to the one before it in its cue, when that one's slot stays clear for longer. */
  const lengthen = (gone: Planned) => {
    const before = [...placed.values()].find((entry) => entry.cutBy === gone);
    if (!before) return;
    const { toMs, cutBy } = windowOf(before.planned);
    const others = occupants.filter((other) => other !== before.occupant);
    const shown = slotWindow({ x: before.x, y: before.y, ink: before.size.ink, fromMs: before.shown.fromMs, toMs, cue: before.planned.cue, occupants: others, canvas: input.canvas, fps, strict: before.strict, entrance: before.planned.entrance });
    if (!shown || shown.fromMs !== before.shown.fromMs || shown.toMs <= before.shown.toMs) return;
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
    const { toMs, cutBy } = windowOf(emoji);
    const result = toMs - emoji.fromMs < frameMs ? null : tryPlace(emoji, toMs);
    if (!result) {
      reasons.set(emoji, toMs - emoji.fromMs < frameMs ? "no-time" : "no-room");
      dropped.add(emoji);
      lengthen(emoji);
      continue;
    }
    // Only a window that reaches the next emoji's start was cut by it (one that left early for the cue's exit was not).
    result.cutBy = result.shown.toMs === toMs ? cutBy : null;
    occupants.push(result.occupant);
    placed.set(emoji, result);
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
 * sets the tilt), which of their art is loaded, the style, the canvas, the anchor height, the frame rate
 * and where held emojis yield.
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
    [style.palette.a, style.palette.b, style.palette.c, style.size, style.position, style.sticker, style.shadowColour, style.slot],
    input.emojis.map((emoji) => [emoji.cueIndex, emoji.id, emoji.tone ?? 0, emoji.atMs, emoji.order ?? null, input.art.has(emoji.id)]),
  ]);
}
