import {
  captionKeyframeValue,
  type CaptionKeyframe,
  type CaptionKeyframeProperty,
} from "@narriflow/validators";

/**
 * A Caption Block word's entrance pose at one instant (spec 5.7). Offsets
 * and blur are in em of the word's own size; `offsetXEm` is before the
 * word's `motionSign`.
 */
export interface CaptionBlockPose {
  readonly opacity: number;
  readonly offsetXEm: number;
  readonly offsetYEm: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly blurEm: number;
  readonly rotateZDeg: number;
  readonly rotateXDeg: number;
}

const REST: CaptionBlockPose = {
  opacity: 1,
  offsetXEm: 0,
  offsetYEm: 0,
  scaleX: 1,
  scaleY: 1,
  blurEm: 0,
  rotateZDeg: 0,
  rotateXDeg: 0,
};

/**
 * The pose the export draws `elapsedMs` after the word's onset. Every
 * keyframe time is multiplied by `timeScale`, the word's duration cap from
 * the shared geometry (spec 5.7), so a word near the cue's end or close to
 * the next onset enters faster; 0 draws the word settled (also reduced
 * motion). The pose is a pure function of time: pause, scrub and seeking
 * into an entrance all land on the values the worker's events show.
 */
export function captionBlockWordPose(
  keyframes: readonly CaptionKeyframe[],
  elapsedMs: number,
  timeScale: number,
): CaptionBlockPose {
  const at = timeScale > 0 ? Math.max(0, elapsedMs) / timeScale : Number.POSITIVE_INFINITY;
  const value = (property: CaptionKeyframeProperty) => captionKeyframeValue(keyframes, property, at) ?? REST[property];
  return {
    opacity: value("opacity"),
    offsetXEm: value("offsetXEm"),
    offsetYEm: value("offsetYEm"),
    scaleX: value("scaleX"),
    scaleY: value("scaleY"),
    blurEm: value("blurEm"),
    rotateZDeg: value("rotateZDeg"),
    rotateXDeg: value("rotateXDeg"),
  };
}

/**
 * The CSS transform for a posed word whose `transform-origin` is its rest
 * centre: `rotate(θ) translate(dx, dy) scale(sx, sy)`, applied right to
 * left. That is libass's order: `\move` translates in screen space, then
 * `\frz` turns about the fixed `\org` at the rest centre (spec 5.6).
 * `emPx` is the word's size in display px; `perspectivePx` is the display
 * camera distance for `rotateXDeg` (the classic engine's flip distance).
 */
export function captionBlockTransform(
  pose: CaptionBlockPose,
  word: { readonly rotationDeg: number; readonly motionSign: 1 | -1; readonly emPx: number },
  perspectivePx: number,
): string {
  const theta = word.rotationDeg + pose.rotateZDeg;
  const dx = pose.offsetXEm * word.motionSign * word.emPx;
  const dy = pose.offsetYEm * word.emPx;
  const flip = pose.rotateXDeg !== 0 ? ` perspective(${perspectivePx}px) rotateX(${pose.rotateXDeg}deg)` : "";
  return `rotate(${theta}deg) translate(${dx}px, ${dy}px)${flip} scale(${pose.scaleX}, ${pose.scaleY})`;
}
