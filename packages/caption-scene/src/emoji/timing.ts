import { type Frames, kf } from "../ease";

/** The emoji's entrance: it grows from this scale to 1 with `outBack` over `CAPTION_EMOJI_POP_MS`. */
export const CAPTION_EMOJI_POP_FROM = 0.4;
export const CAPTION_EMOJI_POP_MS = 180;
/**
 * The entrance of an emoji whose anchor word comes late in its cue: shorter and with no overshoot,
 * from this scale to 1 over `CAPTION_EMOJI_QUICK_MS`, so it lands with the word and does not linger
 * mid-pop when the cue is about to end.
 */
export const CAPTION_EMOJI_QUICK_FROM = 0.7;
export const CAPTION_EMOJI_QUICK_MS = 90;
/** The emoji's exit: a fade over the last this many ms of its window. */
export const CAPTION_EMOJI_FADE_MS = 90;
/**
 * The exit of an emoji held past its cue's last paint (its word ended the cue): from where it starts
 * leaving it fades out and shrinks to this scale by the end of its window, so on the next caption it
 * reads as the previous caption's emoji on its way out.
 */
export const CAPTION_EMOJI_LEAVE_SCALE = 0.85;

/** How an emoji enters: the full pop, or the quick one for a late anchor word. */
export type CaptionEmojiEntrance = "pop" | "quick";

function entranceEnd(fromMs: number, toMs: number, entrance: CaptionEmojiEntrance): number {
  return fromMs + Math.min(entrance === "quick" ? CAPTION_EMOJI_QUICK_MS : CAPTION_EMOJI_POP_MS, (toMs - fromMs) / 2);
}

/** Where the exit starts: at `leaveFromMs` when it leaves the fade its time, never inside the entrance. */
function exitStart(fromMs: number, toMs: number, entrance: CaptionEmojiEntrance, leaveFromMs: number | undefined): number {
  return Math.max(entranceEnd(fromMs, toMs, entrance), Math.min(leaveFromMs ?? toMs, toMs - CAPTION_EMOJI_FADE_MS));
}

/**
 * The scale of an emoji shown over `[fromMs, toMs)`: its entrance, never more than half its window,
 * and for a held emoji (`leaveFromMs`, see `captionEmojiOpacity`) the shrink to
 * `CAPTION_EMOJI_LEAVE_SCALE` as it leaves.
 */
export function captionEmojiScale(fromMs: number, toMs: number, entrance: CaptionEmojiEntrance = "pop", leaveFromMs?: number): Frames {
  const end = entranceEnd(fromMs, toMs, entrance);
  const enter: Frames = entrance === "quick" ? [[fromMs, CAPTION_EMOJI_QUICK_FROM], [end, 1, "out"]] : [[fromMs, CAPTION_EMOJI_POP_FROM], [end, 1, "outBack"]];
  if (leaveFromMs === undefined) return enter;
  const leave = exitStart(fromMs, toMs, entrance, leaveFromMs);
  return [...enter, ...(leave > end ? [[leave, 1] as const] : []), [toMs, CAPTION_EMOJI_LEAVE_SCALE]];
}

/**
 * The opacity of an emoji shown over `[fromMs, toMs)`: full after its entrance, then a fade to 0 over
 * the last `CAPTION_EMOJI_FADE_MS`, or from `leaveFromMs` when that is earlier (a held emoji leaves
 * over the rest of its hold). Linear, so the ASS writer draws each exit as one `\t`.
 */
export function captionEmojiOpacity(fromMs: number, toMs: number, entrance: CaptionEmojiEntrance = "pop", leaveFromMs?: number): Frames {
  return [[exitStart(fromMs, toMs, entrance, leaveFromMs), 1], [toMs, 0]];
}

/** The largest scale the pop reaches (`outBack` overshoots 1): an emoji kept inside an edge must fit at it. */
export const CAPTION_EMOJI_POP_PEAK = Math.max(...Array.from({ length: 181 }, (_, ms) => kf(ms, captionEmojiScale(0, 1000))));
