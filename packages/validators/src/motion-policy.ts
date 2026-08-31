export const STUDIO_TRANSITION_TYPES = [
  "none",
  "fade",
  "fade-black",
  "dip-white",
  "cross-dissolve",
  "wipe-left",
  "wipe-right",
  "wipe-up",
  "wipe-down",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
  "zoom-in",
  "zoom-out",
] as const;

export const SCENE_MOTION_ENTRANCES = [
  "none",
  "fade",
  "scale-in",
  "pan-left",
  "pan-right",
  "pan-up",
  "pan-down",
  "ken-burns-in",
] as const;

export const SCENE_MOTION_EXITS = [
  "none",
  "fade",
  "scale-out",
  "pan-left",
  "pan-right",
  "pan-up",
  "pan-down",
  "ken-burns-out",
] as const;

export type StudioTransitionType = (typeof STUDIO_TRANSITION_TYPES)[number];
export type SceneMotionEntrance = (typeof SCENE_MOTION_ENTRANCES)[number];
export type SceneMotionExit = (typeof SCENE_MOTION_EXITS)[number];

export type MotionReleaseState = Readonly<{
  legacyTransitions: boolean;
  crossDissolve: boolean;
  directionalWipe: boolean;
  directionalSlide: boolean;
  zoom: boolean;
  mediaFadeScale: boolean;
  panKenBurns: boolean;
}>;

export type MotionRolloutState = MotionReleaseState & Readonly<{
  campaignApply: boolean;
}>;

export function transitionMotionReleased(
  value: StudioTransitionType,
  rollout: MotionReleaseState,
): boolean {
  if (value === "none") return true;
  if (value === "fade" || value === "fade-black" || value === "dip-white") {
    return rollout.legacyTransitions;
  }
  if (value === "cross-dissolve") return rollout.crossDissolve;
  if (
    value === "wipe-left" ||
    value === "wipe-right" ||
    value === "wipe-up" ||
    value === "wipe-down"
  ) {
    return rollout.directionalWipe;
  }
  if (
    value === "slide-left" ||
    value === "slide-right" ||
    value === "slide-up" ||
    value === "slide-down"
  ) {
    return rollout.directionalSlide;
  }
  if (value === "zoom-in" || value === "zoom-out") return rollout.zoom;
  return false;
}

export function mediaMotionReleased(
  value: SceneMotionEntrance | SceneMotionExit,
  rollout: MotionReleaseState,
): boolean {
  if (value === "none") return true;
  if (value === "fade" || value === "scale-in" || value === "scale-out") {
    return rollout.mediaFadeScale;
  }
  if (
    value === "pan-left" ||
    value === "pan-right" ||
    value === "pan-up" ||
    value === "pan-down" ||
    value === "ken-burns-in" ||
    value === "ken-burns-out"
  ) {
    return rollout.panKenBurns;
  }
  return false;
}
