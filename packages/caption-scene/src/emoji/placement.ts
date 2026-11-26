import type { CaptionSceneEmojiSlot } from "@narriflow/validators";
import { type Frames, kf } from "../ease";
import { exportFrameAfter, exportFrameTimes } from "../frame-grid";
import type { Box } from "../scene";
import type { CaptionEmojiCueBox, CaptionEmojiObstacle } from "./cue-box";
import { CAPTION_EMOJI_POP_PEAK, type CaptionEmojiEntrance, captionEmojiScale } from "./timing";

/**
 * Where an emoji goes against its cue (spec D4): a slot next to the text, never on it. A slot is
 * tried on its own side, then the other, then both at 0.7 of the size; an emoji that fits none is
 * dropped. A slot fits when, on every export frame of the emoji's window, the emoji's ink stays in
 * the safe area and meets nothing the cue box names as an obstacle, nor an emoji placed before it.
 * A slot may sit a little further from the text than its own distance (`CAPTION_EMOJI_NUDGES`).
 * Only when no slot at either size is clear of everything may an emoji cover soft obstacles
 * (decorations without text), full size first.
 */

/** Space between the cue's text and the emoji's ink, as a fraction of the emoji's size. */
export const CAPTION_EMOJI_GAP = 0.18;
/** Further distances from the text a slot is tried at when its own is taken, as fractions of the emoji's size. */
export const CAPTION_EMOJI_NUDGES = [0, 0.12, 0.25] as const;
/** The size an emoji is tried at when its slot is taken at full size. */
export const CAPTION_EMOJI_SHRINK = 0.7;
/** The margin, of the canvas's width and height, no emoji enters. */
export const CAPTION_EMOJI_SAFE_MARGIN = 0.05;

/**
 * The face zone, as a fraction of the frame's height from the top: an auto emoji whose ink would
 * reach higher than this above its caption tries below first.
 */
export const CAPTION_EMOJI_FACE_ZONE = 0.42;

export type CaptionEmojiSide = "above" | "below" | "end" | "start";

/** Sides in the order they are tried. Auto puts an above-slot emoji below a caption in the top 30% of the frame. */
export function captionEmojiSides(slot: CaptionSceneEmojiSlot, position: "auto" | "above" | "below", anchorYPct: number): readonly CaptionEmojiSide[] {
  if (position === "above") return ["above", "below"];
  if (position === "below") return ["below", "above"];
  if (slot === "beside-end") return ["end", "start", "above", "below"];
  if (slot === "below") return ["below", "above"];
  return anchorYPct < 30 ? ["below", "above"] : ["above", "below"];
}

/** Turned ink bounds of an emoji relative to its pivot, at rest scale. */
export interface CaptionEmojiFootprint {
  readonly ink: Box;
  /** The size it was drawn at, px (the gap is a fraction of it). */
  readonly sizePx: number;
}

/** A placed emoji as later placements see it: its pivot, footprint and scale over its window. */
export interface CaptionEmojiOccupant {
  readonly x: number;
  readonly y: number;
  readonly ink: Box;
  readonly fromMs: number;
  readonly toMs: number;
  readonly scale: Frames;
}

/**
 * The pivot of an emoji on `side` of a cue, kept in the safe area along the cue's edge: centred
 * over or under its box, or level with its last row (`endBox`) at the row's reading end or start.
 * An `edge` slot is the fallback when those are taken (a stack's neighbour lines, a line that fills
 * the width): over or under the box's reading end instead of its centre, or level with the row at
 * the safe area's edge on that side, past whatever shorter lines sit beside it.
 */
export function slotPivot(
  cue: Pick<CaptionEmojiCueBox, "box" | "endBox" | "direction">,
  side: CaptionEmojiSide,
  footprint: CaptionEmojiFootprint,
  canvas: { readonly width: number; readonly height: number },
  /** Extra distance from the text, as a fraction of the emoji's size. */
  nudge = 0,
  edge = false,
): { x: number; y: number } {
  const { direction } = cue;
  const { ink, sizePx } = footprint;
  const gap = (CAPTION_EMOJI_GAP + nudge) * sizePx;
  const safe = safeArea(canvas);
  // Kept inside at the pop's peak, which grows the ink about the pivot past its rest size.
  const peak = CAPTION_EMOJI_POP_PEAK;
  const clamp = (value: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, value)));
  const right = side === "end" ? direction === "ltr" : side === "start" ? direction === "rtl" : false;
  if (side === "above" || side === "below") {
    const box = cue.box;
    const along = !edge ? (box.x1 + box.x2) / 2 : direction === "ltr" ? box.x2 - ink.x2 : box.x1 - ink.x1;
    const x = clamp(along, safe.x1 - peak * ink.x1, safe.x2 - peak * ink.x2);
    return { x, y: side === "above" ? box.y1 - gap - ink.y2 : box.y2 + gap - ink.y1 };
  }
  const box = cue.endBox ?? cue.box;
  const y = clamp((box.y1 + box.y2) / 2, safe.y1 - peak * ink.y1, safe.y2 - peak * ink.y2);
  if (edge) return { x: right ? safe.x2 - peak * ink.x2 : safe.x1 - peak * ink.x1, y };
  return { x: right ? box.x2 + gap - ink.x1 : box.x1 - gap - ink.x2, y };
}

export function safeArea(canvas: { readonly width: number; readonly height: number }): Box {
  return {
    x1: CAPTION_EMOJI_SAFE_MARGIN * canvas.width,
    y1: CAPTION_EMOJI_SAFE_MARGIN * canvas.height,
    x2: (1 - CAPTION_EMOJI_SAFE_MARGIN) * canvas.width,
    y2: (1 - CAPTION_EMOJI_SAFE_MARGIN) * canvas.height,
  };
}

const EPS = 0.5;
const meets = (a: Box, b: Box) => a.x1 + EPS < b.x2 && b.x1 + EPS < a.x2 && a.y1 + EPS < b.y2 && b.y1 + EPS < a.y2;

function inkAt(x: number, y: number, ink: Box, scale: number): Box {
  return { x1: x + ink.x1 * scale, y1: y + ink.y1 * scale, x2: x + ink.x2 * scale, y2: y + ink.y2 * scale };
}

/**
 * How long an emoji may wait after its anchor for its slot to clear (a previous cue leaving, its own
 * cue settling), and how early it may leave for the cue's own exit, ms.
 */
export const CAPTION_EMOJI_MAX_TRIM_MS = 300;
/** The least an emoji that waited or left early still shows, ms (less when its whole window is shorter). */
export const CAPTION_EMOJI_MIN_SHOW_MS = 300;

/**
 * When an emoji at `(x, y)` can show inside `[fromMs, toMs)`, or null: the longest window from
 * which, on every export frame, its ink (at its pop's scale) stays in the safe area, clear of
 * obstacles and of earlier emojis. A slot still being vacated at the start is waited for, and a
 * slot the cue's exit sweeps through at the end is left early, each by up to
 * `CAPTION_EMOJI_MAX_TRIM_MS`. Not `strict`, it may cover soft obstacles (decorations without text).
 */
export function slotWindow(input: {
  readonly x: number;
  readonly y: number;
  readonly ink: Box;
  readonly fromMs: number;
  readonly toMs: number;
  readonly cue: CaptionEmojiCueBox;
  readonly occupants: readonly CaptionEmojiOccupant[];
  readonly canvas: { readonly width: number; readonly height: number };
  readonly fps: number;
  readonly strict: boolean;
  readonly entrance: CaptionEmojiEntrance;
}): { readonly fromMs: number; readonly toMs: number } | null {
  const safe = safeArea(input.canvas);
  const obstacles: (atMs: number) => readonly CaptionEmojiObstacle[] = input.cue.obstacles ?? (() => [input.cue.box]);
  const occupants = input.occupants.filter((other) => other.fromMs < input.toMs && other.toMs > input.fromMs);
  const minShow = Math.min(CAPTION_EMOJI_MIN_SHOW_MS, input.toMs - input.fromMs);
  const blocked = (t: number, scale: number) => {
    const box = inkAt(input.x, input.y, input.ink, scale);
    if (box.x1 < safe.x1 - EPS || box.y1 < safe.y1 - EPS || box.x2 > safe.x2 + EPS || box.y2 > safe.y2 + EPS) return true;
    for (const obstacle of obstacles(t)) if ((input.strict || !obstacle.soft) && meets(box, obstacle)) return true;
    for (const other of occupants) {
      if (t >= other.fromMs && t < other.toMs && meets(box, inkAt(other.x, other.y, other.ink, kf(t, other.scale)))) return true;
    }
    return false;
  };
  let fromMs = input.fromMs;
  let toMs = input.toMs;
  for (;;) {
    const scale = captionEmojiScale(fromMs, toMs, input.entrance);
    const hit = exportFrameTimes(fromMs, toMs, input.fps).find((t) => blocked(t, kf(t, scale)));
    if (hit === undefined) return { fromMs, toMs };
    if (hit - input.fromMs < CAPTION_EMOJI_MAX_TRIM_MS) fromMs = exportFrameAfter(hit, input.fps);
    else if (input.toMs - hit <= CAPTION_EMOJI_MAX_TRIM_MS) toMs = hit;
    else return null;
    if (toMs - fromMs < minShow) return null;
  }
}
