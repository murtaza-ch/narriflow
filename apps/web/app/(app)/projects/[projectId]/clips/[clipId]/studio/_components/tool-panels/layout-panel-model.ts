import {
  SCENE_LAYOUT_MIN_DURATION_SEC,
  removeSceneLayoutSelection,
  removeSpeakerLayoutOverrideRange,
  replaceSceneLayoutSelection,
  resolveEffectiveFramingMode,
  sceneLayoutSelectionAt,
  type ClipAspectRatio,
  type SceneLayoutPreset,
  type StudioEdits,
  type StudioSceneLayoutSelection,
} from "@narriflow/validators";
import { SCENE_LAYOUT_PRESET_CATALOG } from "@narriflow/composition-plan";

export type SceneLayoutChoice = "clip-default" | SceneLayoutPreset;

export interface LayoutSceneTarget {
  startSec: number | null;
  endSec: number | null;
  speakerLayerCount: number;
  speakerAnalysisStatus?: "pending" | "available" | "failed";
}

export function activeSceneLayoutChoice(
  selections: readonly StudioSceneLayoutSelection[],
  aspectRatio: ClipAspectRatio,
  scene: LayoutSceneTarget | null,
): SceneLayoutChoice {
  if (scene?.startSec === null || scene?.startSec === undefined) return "clip-default";
  return (
    sceneLayoutSelectionAt(selections, aspectRatio, scene.startSec)?.preset ??
    "clip-default"
  );
}

export function applySceneLayoutChoice(input: {
  selections: readonly StudioSceneLayoutSelection[];
  aspectRatio: ClipAspectRatio;
  scene: LayoutSceneTarget | null;
  applyToAllScenes: boolean;
  editedDurationSec: number;
  choice: SceneLayoutChoice;
  id: string;
}): StudioSceneLayoutSelection[] {
  const range = input.applyToAllScenes
    ? { startSec: 0, endSec: input.editedDurationSec }
    : input.scene?.startSec !== null &&
        input.scene?.startSec !== undefined &&
        input.scene.endSec !== null &&
        input.scene.endSec !== undefined
      ? { startSec: input.scene.startSec, endSec: input.scene.endSec }
      : null;
  if (
    !range ||
    range.endSec - range.startSec < SCENE_LAYOUT_MIN_DURATION_SEC
  ) {
    return [...input.selections];
  }
  const target = { aspectRatio: input.aspectRatio, ...range };
  return input.choice === "clip-default"
    ? removeSceneLayoutSelection(input.selections, target)
    : replaceSceneLayoutSelection(input.selections, {
        id: input.id,
        ...target,
        preset: input.choice,
      });
}

/**
 * A layout choice as one `studioEdits` change: the scene (or, with `applyToAllScenes`, the whole
 * clip) takes the choice, and manual speaker transforms over the same range are dropped so the
 * choice shows. The Layout panel's grid and the AI tools panel's Auto reframe both apply it.
 */
export function sceneLayoutEdits(
  previous: StudioEdits,
  input: Omit<Parameters<typeof applySceneLayoutChoice>[0], "selections">,
): StudioEdits {
  const range = input.applyToAllScenes
    ? { startSec: 0, endSec: input.editedDurationSec }
    : { startSec: input.scene?.startSec ?? 0, endSec: input.scene?.endSec ?? 0 };
  return {
    ...previous,
    sceneLayouts: applySceneLayoutChoice({ ...input, selections: previous.sceneLayouts }),
    speakerLayoutOverrides: removeSpeakerLayoutOverrideRange(previous.speakerLayoutOverrides, { aspectRatio: input.aspectRatio, ...range }),
  };
}

/** Margin within which layout selections count as touching (edited seconds). */
const COVER_SLACK_SEC = 0.001;

/**
 * True when every moment of the clip in `aspectRatio` is framed Auto with no manual speaker
 * transform: each scene selection is Auto, and any stretch without one falls back to a clip
 * default that is Auto.
 */
export function wholeClipIsAuto(
  edits: Pick<StudioEdits, "sceneLayouts" | "speakerLayoutOverrides" | "background" | "framing">,
  aspectRatio: ClipAspectRatio,
  editedDurationSec: number,
): boolean {
  if (edits.speakerLayoutOverrides.some((override) => override.aspectRatio === aspectRatio)) return false;
  const selections = edits.sceneLayouts.filter((selection) => selection.aspectRatio === aspectRatio).sort((left, right) => left.startSec - right.startSec);
  if (selections.some((selection) => selection.preset !== "auto")) return false;
  if (resolveEffectiveFramingMode(edits) === "auto") return true;
  let coveredTo = 0;
  for (const selection of selections) {
    if (selection.startSec > coveredTo + COVER_SLACK_SEC) return false;
    coveredTo = Math.max(coveredTo, selection.endSec);
  }
  return coveredTo >= editedDurationSec - COVER_SLACK_SEC;
}

export function sceneLayoutEvidenceHint(
  preset: SceneLayoutPreset,
  scene: LayoutSceneTarget | null,
): "ready" | "speaker-analysis" | "speaker-count" {
  const requirements = SCENE_LAYOUT_PRESET_CATALOG.find(
    (candidate) => candidate.id === preset,
  );
  if (!requirements) return "ready";
  if ((scene?.speakerLayerCount ?? 0) >= requirements.minimumSpeakers) return "ready";
  return scene?.speakerAnalysisStatus === "available" ||
    scene?.speakerAnalysisStatus === "failed"
    ? "speaker-count"
    : "speaker-analysis";
}
