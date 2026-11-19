import type { PlacedDecoration } from "@narriflow/caption-fonts/caption-block";
import { CAPTION_REST_POSE, captionEntrancePose, type CaptionEntrancePose, type CaptionKeyframe } from "@narriflow/validators";

/**
 * A Caption Block word's entrance pose at one instant (spec 5.7). Offsets
 * and blur are in em of the word's own size; `offsetXEm` is before the
 * word's `motionSign`.
 */
export type CaptionBlockPose = CaptionEntrancePose;

/**
 * The pose the export draws `elapsedMs` after the word's onset: the shared
 * `captionEntrancePose` (linear opacity and travel, as libass's `\fade` and
 * `\move` are). Every keyframe time is multiplied by `timeScale`, the word's
 * duration cap from the shared geometry (spec 5.7), so a word near the cue's
 * end or close to the next onset enters faster; 0 draws the word settled
 * (also reduced motion). The pose is a pure function of time: pause, scrub
 * and seeking into an entrance all land on the values the worker's events show.
 */
export function captionBlockWordPose(
  keyframes: readonly CaptionKeyframe[],
  elapsedMs: number,
  timeScale: number,
): CaptionBlockPose {
  if (timeScale <= 0) return CAPTION_REST_POSE;
  return captionEntrancePose(keyframes, Math.max(0, elapsedMs) / timeScale);
}

/**
 * The CSS transform for a posed word whose `transform-origin` is its rest
 * centre: `rotate(θ) translate(dx, dy) scale(sx, sy)`, applied right to
 * left. That is libass's order: `\move` translates in screen space, then
 * `\frz` turns about the fixed `\org` at the rest centre (spec 5.6).
 * libass scales an `\an5` event about its `\pos`, not about `\org`, so the
 * scale is taken about `scaleOrigin`, the element's own scale origin as an
 * offset from the transform origin in display px: the word's
 * `PlacedWord.scaleOriginX/Y`, or a tile's centre.
 * `emPx` is the word's size in display px; `perspectivePx` is the display
 * camera distance for `rotateXDeg` (the classic engine's flip distance).
 */
export function captionBlockTransform(
  pose: CaptionBlockPose,
  word: { readonly rotationDeg: number; readonly motionSign: 1 | -1; readonly emPx: number },
  perspectivePx: number,
  scaleOrigin: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
): string {
  const theta = word.rotationDeg + pose.rotateZDeg;
  const dx = pose.offsetXEm * word.motionSign * word.emPx;
  const dy = pose.offsetYEm * word.emPx;
  const flip = pose.rotateXDeg !== 0 ? ` perspective(${perspectivePx}px) rotateX(${pose.rotateXDeg}deg)` : "";
  const scaled = pose.scaleX === 1 && pose.scaleY === 1;
  const scale = scaled || (scaleOrigin.x === 0 && scaleOrigin.y === 0)
    ? `scale(${pose.scaleX}, ${pose.scaleY})`
    : `translate(${scaleOrigin.x}px, ${scaleOrigin.y}px) scale(${pose.scaleX}, ${pose.scaleY}) translate(${-scaleOrigin.x}px, ${-scaleOrigin.y}px)`;
  return `rotate(${theta}deg) translate(${dx}px, ${dy}px)${flip} ${scale}`;
}

/** A decoration's entrance at one instant (spec 5.10): a star's pop scale and the underline's wipe. */
export interface CaptionDecorationPose {
  /** Scale about the decoration's centre; 0 hides a star before its pop. */
  readonly scale: number;
  /** Share of the wipe clip the leading edge has crossed, 0 to 1; 1 for stars. */
  readonly reveal: number;
}

/**
 * The pose the export draws `elapsedMs` after the hero's onset (`PlacedDecoration.startSec`): a
 * star's `\fscx`/`\fscy` keyframes through the shared `captionEntrancePose` (eased segments, as
 * libass's `\t`), the underline's `\clip` linear from `wipe.startMs` to `wipe.endMs`. Reduced
 * motion shows decorations settled.
 */
export function captionDecorationPose(
  decoration: Pick<PlacedDecoration, "keyframes" | "wipe">,
  elapsedMs: number,
  reducedMotion: boolean,
): CaptionDecorationPose {
  if (reducedMotion) return { scale: 1, reveal: 1 };
  const scale = decoration.keyframes.length > 0 ? captionEntrancePose(decoration.keyframes, Math.max(0, elapsedMs)).scaleX : 1;
  const wipe = decoration.wipe;
  const reveal = wipe ? Math.min(1, Math.max(0, (elapsedMs - wipe.startMs) / Math.max(1, wipe.endMs - wipe.startMs))) : 1;
  return { scale, reveal };
}

/**
 * The CSS `clip-path` of a decoration's wipe element, whose box is `wipe.clip` at `scale`
 * display px per canvas px: everything the leading edge has not reached is inset away.
 */
export function captionWipeClipPath(direction: "ltr" | "rtl", widthPx: number, reveal: number): string {
  const hidden = (1 - reveal) * widthPx;
  return direction === "rtl" ? `inset(0px 0px 0px ${hidden}px)` : `inset(0px ${hidden}px 0px 0px)`;
}
