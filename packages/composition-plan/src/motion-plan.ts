import type { MediaMotion, SceneMotion, StudioEdits } from "@narriflow/validators";

export const COMPOSITION_MOTION_VERSION = 1 as const;

export interface CompositionMotionRange {
  readonly startSec: number;
  readonly endSec: number;
}

export interface CompositionMotionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CompositionMotionState {
  readonly opacity: number;
  readonly transform: {
    readonly translateX: number;
    readonly translateY: number;
    readonly scale: number;
  };
  readonly crop: CompositionMotionRect;
  readonly clip: CompositionMotionRect;
}

export interface CompositionMotionWindow {
  readonly range: CompositionMotionRange;
  readonly from: CompositionMotionState;
  readonly to: CompositionMotionState;
}

export interface CompositionMotionPlan {
  readonly version: typeof COMPOSITION_MOTION_VERSION;
  readonly activeRange: CompositionMotionRange;
  readonly restingState: CompositionMotionState;
  readonly entrance: CompositionMotionWindow | null;
  readonly exit: CompositionMotionWindow | null;
}

export interface SampledCompositionMotion extends CompositionMotionState {
  readonly reducedMotion: boolean;
}

type Canvas = Readonly<{ width: number; height: number }>;
type TransitionType = StudioEdits["transition"]["type"];
type MediaEntrance = MediaMotion["entrance"] | SceneMotion["entrance"];
type MediaExit = MediaMotion["exit"] | SceneMotion["exit"];

function rect(canvas: Canvas): CompositionMotionRect {
  return { x: 0, y: 0, width: canvas.width, height: canvas.height };
}

function state(
  canvas: Canvas,
  partial: Partial<CompositionMotionState> = {},
): CompositionMotionState {
  return {
    opacity: partial.opacity ?? 1,
    transform: partial.transform ?? {
      translateX: 0,
      translateY: 0,
      scale: 1,
    },
    crop: partial.crop ?? rect(canvas),
    clip: partial.clip ?? rect(canvas),
  };
}

function boundedDuration(
  activeRange: CompositionMotionRange,
  requestedDurationSec: number,
): number {
  const interval = Math.max(0, activeRange.endSec - activeRange.startSec);
  return Math.max(0, Math.min(requestedDurationSec, interval / 2));
}

function windows(
  activeRange: CompositionMotionRange,
  durationSec: number,
  entranceStates: readonly [CompositionMotionState, CompositionMotionState] | null,
  exitStates: readonly [CompositionMotionState, CompositionMotionState] | null,
): Pick<CompositionMotionPlan, "entrance" | "exit"> {
  const duration = boundedDuration(activeRange, durationSec);
  if (duration <= 0) return { entrance: null, exit: null };
  return {
    entrance: entranceStates
      ? {
          range: {
            startSec: activeRange.startSec,
            endSec: activeRange.startSec + duration,
          },
          from: entranceStates[0],
          to: entranceStates[1],
        }
      : null,
    exit: exitStates
      ? {
          range: {
            startSec: activeRange.endSec - duration,
            endSec: activeRange.endSec,
          },
          from: exitStates[0],
          to: exitStates[1],
        }
      : null,
  };
}

function directionVector(
  direction: "left" | "right" | "up" | "down",
  canvas: Canvas,
): { x: number; y: number } {
  if (direction === "left") return { x: -canvas.width, y: 0 };
  if (direction === "right") return { x: canvas.width, y: 0 };
  if (direction === "up") return { x: 0, y: -canvas.height };
  return { x: 0, y: canvas.height };
}

function transitionStates(
  type: TransitionType,
  canvas: Canvas,
): {
  entrance: readonly [CompositionMotionState, CompositionMotionState] | null;
  exit: readonly [CompositionMotionState, CompositionMotionState] | null;
} {
  const resting = state(canvas);
  if (type === "none") return { entrance: null, exit: null };
  if (type === "fade" || type === "fade-black" || type === "dip-white") {
    const solid = state(canvas);
    const clear = state(canvas, { opacity: 0 });
    return { entrance: [solid, clear], exit: [clear, solid] };
  }
  if (type.startsWith("slide-")) {
    const direction = type.slice("slide-".length) as "left" | "right" | "up" | "down";
    const vector = directionVector(direction, canvas);
    const before = state(canvas, {
      transform: {
        translateX: -vector.x,
        translateY: -vector.y,
        scale: 1,
      },
    });
    const after = state(canvas, {
      transform: {
        translateX: vector.x,
        translateY: vector.y,
        scale: 1,
      },
    });
    return { entrance: [before, resting], exit: [resting, after] };
  }
  if (type.startsWith("wipe-")) {
    const direction = type.slice("wipe-".length);
    const hiddenClip =
      direction === "left"
        ? { x: canvas.width, y: 0, width: 0, height: canvas.height }
        : direction === "right"
          ? { x: 0, y: 0, width: 0, height: canvas.height }
          : direction === "up"
            ? { x: 0, y: canvas.height, width: canvas.width, height: 0 }
            : { x: 0, y: 0, width: canvas.width, height: 0 };
    const hidden = state(canvas, { clip: hiddenClip });
    return { entrance: [hidden, resting], exit: [resting, hidden] };
  }
  const scale = type === "zoom-in" ? 0.86 : 1.14;
  const edge = state(canvas, {
    transform: { translateX: 0, translateY: 0, scale },
  });
  return { entrance: [edge, resting], exit: [resting, edge] };
}

export function planTransitionMotion(input: {
  readonly type: TransitionType;
  readonly durationSec: number;
  readonly activeRange: CompositionMotionRange;
  readonly canvas: Canvas;
}): CompositionMotionPlan {
  const restingState =
    input.type === "fade" || input.type === "fade-black" || input.type === "dip-white"
      ? state(input.canvas, { opacity: 0 })
      : state(input.canvas);
  const plannedStates = transitionStates(input.type, input.canvas);
  return {
    version: COMPOSITION_MOTION_VERSION,
    activeRange: input.activeRange,
    restingState,
    ...windows(
      input.activeRange,
      input.durationSec,
      plannedStates.entrance,
      plannedStates.exit,
    ),
  };
}

function mediaMotionStates(
  family: MediaEntrance | MediaExit,
  phase: "entrance" | "exit",
  canvas: Canvas,
  resting: CompositionMotionState,
): readonly [CompositionMotionState, CompositionMotionState] | null {
  if (family === "none") return null;
  if (family === "fade") {
    const hidden = { ...resting, opacity: 0 };
    return phase === "entrance" ? [hidden, resting] : [resting, hidden];
  }
  if (family === "scale-in" || family === "scale-out") {
    const scaled = {
      ...resting,
      transform: { ...resting.transform, scale: 0.88 },
    };
    return phase === "entrance" ? [scaled, resting] : [resting, scaled];
  }
  if (family === "ken-burns-in" || family === "ken-burns-out") {
    const uncropped = state(canvas);
    return phase === "entrance" ? [uncropped, resting] : [resting, uncropped];
  }
  const direction = family.slice("pan-".length) as "left" | "right" | "up" | "down";
  const vector = directionVector(direction, {
    width: Math.round(canvas.width * 0.08),
    height: Math.round(canvas.height * 0.08),
  });
  const translated = {
    ...resting,
    transform: {
      translateX: phase === "entrance" ? -vector.x : vector.x,
      translateY: phase === "entrance" ? -vector.y : vector.y,
      scale: 1.08,
    },
  };
  return phase === "entrance" ? [translated, resting] : [resting, translated];
}

function centeredCrop(canvas: Canvas, fraction: number): CompositionMotionRect {
  const width = Math.max(2, Math.round((canvas.width * fraction) / 2) * 2);
  const height = Math.max(2, Math.round((canvas.height * fraction) / 2) * 2);
  return {
    x: Math.round((canvas.width - width) / 2),
    y: Math.round((canvas.height - height) / 2),
    width,
    height,
  };
}

export function planMediaMotion(input: {
  readonly entrance: MediaEntrance;
  readonly exit: MediaExit;
  readonly durationSec: number;
  readonly activeRange: CompositionMotionRange;
  readonly canvas: Canvas;
}): CompositionMotionPlan {
  const restingState =
    input.entrance === "ken-burns-in" || input.exit === "ken-burns-out"
      ? state(input.canvas, { crop: centeredCrop(input.canvas, 0.88) })
      : state(input.canvas);
  return {
    version: COMPOSITION_MOTION_VERSION,
    activeRange: input.activeRange,
    restingState,
    ...windows(
      input.activeRange,
      input.durationSec,
      mediaMotionStates(input.entrance, "entrance", input.canvas, restingState),
      mediaMotionStates(input.exit, "exit", input.canvas, restingState),
    ),
  };
}

function interpolate(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function interpolateRect(
  from: CompositionMotionRect,
  to: CompositionMotionRect,
  progress: number,
): CompositionMotionRect {
  return {
    x: Math.round(interpolate(from.x, to.x, progress)),
    y: Math.round(interpolate(from.y, to.y, progress)),
    width: Math.round(interpolate(from.width, to.width, progress)),
    height: Math.round(interpolate(from.height, to.height, progress)),
  };
}

function sampleWindow(
  window: CompositionMotionWindow,
  timeSec: number,
): CompositionMotionState {
  const duration = Math.max(0.001, window.range.endSec - window.range.startSec);
  const progress = Math.max(
    0,
    Math.min(1, (timeSec - window.range.startSec) / duration),
  );
  return {
    opacity: interpolate(window.from.opacity, window.to.opacity, progress),
    transform: {
      translateX: Math.round(
        interpolate(
          window.from.transform.translateX,
          window.to.transform.translateX,
          progress,
        ),
      ),
      translateY: Math.round(
        interpolate(
          window.from.transform.translateY,
          window.to.transform.translateY,
          progress,
        ),
      ),
      scale: interpolate(
        window.from.transform.scale,
        window.to.transform.scale,
        progress,
      ),
    },
    crop: interpolateRect(window.from.crop, window.to.crop, progress),
    clip: interpolateRect(window.from.clip, window.to.clip, progress),
  };
}

export function sampleCompositionMotion(
  plan: CompositionMotionPlan,
  timeSec: number,
  options: { readonly reducedMotion?: boolean } = {},
): SampledCompositionMotion {
  if (options.reducedMotion) {
    return { ...plan.restingState, reducedMotion: true };
  }
  if (plan.entrance && timeSec <= plan.entrance.range.endSec) {
    return { ...sampleWindow(plan.entrance, timeSec), reducedMotion: false };
  }
  if (plan.exit && timeSec >= plan.exit.range.startSec) {
    return { ...sampleWindow(plan.exit, timeSec), reducedMotion: false };
  }
  return { ...plan.restingState, reducedMotion: false };
}
