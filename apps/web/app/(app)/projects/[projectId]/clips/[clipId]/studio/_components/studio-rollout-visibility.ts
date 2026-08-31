import type {
  AutoCensorTreatment,
  SceneMotion,
  StudioTransition,
} from "@narriflow/validators";

export type StudioAutoCensorRollout = Readonly<{
  scan: boolean;
  captionMask: boolean;
  mute: boolean;
  beep: boolean;
}>;

export type StudioMotionRollout = Readonly<{
  legacyTransitions: boolean;
  crossDissolve: boolean;
  directionalWipe: boolean;
  directionalSlide: boolean;
  zoom: boolean;
  mediaFadeScale: boolean;
  panKenBurns: boolean;
  campaignApply: boolean;
}>;

const TRANSITIONS: readonly StudioTransition["type"][] = [
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
];

const ENTRANCES: readonly SceneMotion["entrance"][] = [
  "none",
  "fade",
  "scale-in",
  "pan-left",
  "pan-right",
  "pan-up",
  "pan-down",
  "ken-burns-in",
];

const EXITS: readonly SceneMotion["exit"][] = [
  "none",
  "fade",
  "scale-out",
  "pan-left",
  "pan-right",
  "pan-up",
  "pan-down",
  "ken-burns-out",
];

export function availableAutoCensorTreatments(
  rollout: StudioAutoCensorRollout,
): AutoCensorTreatment[] {
  if (!rollout.scan) return [];
  return [
    ...(rollout.captionMask ? (["caption_mask"] as const) : []),
    ...(rollout.mute ? (["mute"] as const) : []),
    ...(rollout.beep ? (["beep"] as const) : []),
  ];
}

export function boundedAutoCensorPreview<T>(
  suggestions: readonly T[],
  canPersist: boolean,
  configuredLimit: number,
): readonly T[] {
  if (canPersist) return suggestions;
  const limit = Number.isFinite(configuredLimit)
    ? Math.min(Math.max(Math.trunc(configuredLimit), 0), 10)
    : 0;
  return suggestions.slice(0, limit);
}

export function hasManualBrollTarget(
  brollUrl: string | null | undefined,
  brollPlacements: readonly unknown[],
): boolean {
  return Boolean(brollUrl) || brollPlacements.length > 0;
}

function transitionReleased(
  value: StudioTransition["type"],
  rollout: StudioMotionRollout,
): boolean {
  if (value === "none") return true;
  if (value === "fade" || value === "fade-black" || value === "dip-white") {
    return rollout.legacyTransitions;
  }
  if (value === "cross-dissolve") return rollout.crossDissolve;
  if (value.startsWith("wipe-")) return rollout.directionalWipe;
  if (value.startsWith("slide-")) return rollout.directionalSlide;
  return rollout.zoom;
}

export function availableStudioTransitions(
  rollout: StudioMotionRollout,
  saved: StudioTransition["type"],
): StudioTransition["type"][] {
  return TRANSITIONS.filter(
    (value) => transitionReleased(value, rollout) || value === saved,
  );
}

function mediaMotionReleased(
  value: SceneMotion["entrance"] | SceneMotion["exit"],
  rollout: StudioMotionRollout,
): boolean {
  if (value === "none") return true;
  if (value === "fade" || value.startsWith("scale-")) {
    return rollout.mediaFadeScale;
  }
  return rollout.panKenBurns;
}

export function availableSceneMotionValues(
  rollout: StudioMotionRollout,
  phase: "entrance",
  saved: SceneMotion["entrance"],
): SceneMotion["entrance"][];
export function availableSceneMotionValues(
  rollout: StudioMotionRollout,
  phase: "exit",
  saved: SceneMotion["exit"],
): SceneMotion["exit"][];
export function availableSceneMotionValues(
  rollout: StudioMotionRollout,
  phase: "entrance" | "exit",
  saved: SceneMotion["entrance"] | SceneMotion["exit"],
) {
  const values = phase === "entrance" ? ENTRANCES : EXITS;
  return values.filter(
    (value) => mediaMotionReleased(value, rollout) || value === saved,
  );
}
