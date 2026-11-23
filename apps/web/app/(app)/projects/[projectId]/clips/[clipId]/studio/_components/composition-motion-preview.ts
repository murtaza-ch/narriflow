import type { CompositionMotionPlan, CompositionMotionState } from "@narriflow/composition-plan";
import { adoptCompositionMotion } from "./composition-preview-adapter";
import type { PlaybackClock } from "./playback-clock";

type Canvas = { readonly width: number; readonly height: number };

export function previewMotionStyle(motion: CompositionMotionState | null, canvas: Canvas | null) {
  if (!motion || !canvas) return undefined;
  const cropScale = canvas.width / Math.max(1, motion.crop.width);
  const cropCenterX = motion.crop.x + motion.crop.width / 2;
  const cropCenterY = motion.crop.y + motion.crop.height / 2;
  const translateX = (motion.transform.translateX + canvas.width / 2 - cropCenterX) / canvas.width;
  const translateY = (motion.transform.translateY + canvas.height / 2 - cropCenterY) / canvas.height;
  const clipTop = (motion.clip.y / canvas.height) * 100;
  const clipRight = ((canvas.width - motion.clip.x - motion.clip.width) / canvas.width) * 100;
  const clipBottom = ((canvas.height - motion.clip.y - motion.clip.height) / canvas.height) * 100;
  const clipLeft = (motion.clip.x / canvas.width) * 100;
  return {
    opacity: motion.opacity,
    transform: `translate(${(translateX * 100).toFixed(3)}%, ${(translateY * 100).toFixed(3)}%) scale(${(motion.transform.scale * cropScale).toFixed(6)})`,
    transformOrigin: "center",
    clipPath: `inset(${clipTop.toFixed(3)}% ${clipRight.toFixed(3)}% ${clipBottom.toFixed(3)}% ${clipLeft.toFixed(3)}%)`,
  };
}

/** Translate the plan once. The compositor interpolates between observations of
 * the 24/30fps media clock, without waiting for a React render on every step. */
export function createClipTransitionPreview(input: {
  element: HTMLElement;
  motion: CompositionMotionPlan;
  canvas: Canvas;
  application: "source" | "overlay";
  clock: PlaybackClock;
  playing: boolean;
  rate: number;
}) {
  const { element, motion, canvas, clock, playing, rate } = input;
  const { startSec, endSec } = motion.activeRange;
  const durationSec = endSec - startSec;
  const times = [...new Set([
    startSec,
    ...(motion.entrance ? [motion.entrance.range.endSec] : []),
    ...(motion.exit ? [motion.exit.range.startSec] : []),
    endSec,
  ])].sort((a, b) => a - b);
  const keyframes = times.map((time): Keyframe => {
    const state = adoptCompositionMotion(motion, time, false);
    const offset = (time - startSec) / durationSec;
    if (input.application === "overlay") return { offset, opacity: state.opacity };
    return { offset, ...previewMotionStyle(state, canvas) };
  });
  const durationMs = durationSec * 1000;
  const animation = element.animate(keyframes, { duration: durationMs, easing: "linear", fill: "both" });
  animation.pause();
  animation.playbackRate = rate;
  const synchronize = () => {
    const desiredTime = Math.min(durationMs, Math.max(0, (clock.getSnapshot() - startSec) * 1000));
    if (!playing || desiredTime >= durationMs) {
      animation.pause();
      animation.currentTime = desiredTime;
      return;
    }
    // Video-frame observations can trail the running compositor by one frame.
    // Correct seeks/drift, but don't snap it back at the source frame rate.
    if (animation.playState !== "running" || Math.abs(Number(animation.currentTime) - desiredTime) > 100) {
      animation.currentTime = desiredTime;
    }
    if (animation.playState !== "running") animation.play();
  };
  synchronize();
  const unsubscribe = clock.subscribe(synchronize);
  return {
    dispose() { unsubscribe(); animation.cancel(); },
  };
}
