import {
	activeManualBrollMotionWindow,
	MANUAL_BROLL_COMPOSITION_ID,
  mediaMotionReleased,
  SCENE_MOTION_ENTRANCES,
  SCENE_MOTION_EXITS,
  STUDIO_TRANSITION_TYPES,
  transitionMotionReleased,
} from "@narriflow/validators";
import type {
  AutoCensorTreatment,
  MotionRolloutState,
  SceneMotion,
  StudioTransition,
} from "@narriflow/validators";
import { formatDuration } from "@/lib/format";

export type StudioAutoCensorRollout = Readonly<{
  scan: boolean;
  captionMask: boolean;
  mute: boolean;
  beep: boolean;
}>;

export type StudioMotionRollout = MotionRolloutState;

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

export function brollMotionTargets(
	placements: readonly {
		id: string;
		mediaKind: "image" | "video";
		startSec: number;
		endSec: number;
	}[],
) {
	return placements.map((placement, index) => ({
		id: `broll:${placement.id}`,
		placementId: placement.id,
		label: `B-roll ${index + 1} · ${placement.mediaKind} · ${formatDuration(placement.startSec)}–${formatDuration(placement.endSec)}`,
		startSec: placement.startSec,
		endSec: placement.endSec,
	}));
}

export function manualUrlBrollMotionTarget(
	brollUrl: string | null | undefined,
	editedDurationSec: number,
	hasAssetBackedPlacements: boolean,
) {
	const window = activeManualBrollMotionWindow({
		brollUrl,
		assetBackedPlacementCount: hasAssetBackedPlacements ? 1 : 0,
		editedDurationSec,
	});
	return window
		? {
				id: `broll:${MANUAL_BROLL_COMPOSITION_ID}`,
				label: `Manual URL B-roll · ${formatDuration(window.startSec)}–${formatDuration(window.endSec)}`,
				...window,
			}
		: null;
}

export function availableStudioTransitions(
  rollout: StudioMotionRollout,
  saved: StudioTransition["type"],
): StudioTransition["type"][] {
  return STUDIO_TRANSITION_TYPES.filter(
    (value) => transitionMotionReleased(value, rollout) || value === saved,
  );
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
  const values = phase === "entrance"
    ? SCENE_MOTION_ENTRANCES
    : SCENE_MOTION_EXITS;
  return values.filter(
    (value) => mediaMotionReleased(value, rollout) || value === saved,
  );
}
