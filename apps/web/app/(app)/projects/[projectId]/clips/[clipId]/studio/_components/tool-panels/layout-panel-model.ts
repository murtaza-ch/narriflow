import {
  SCENE_LAYOUT_MIN_DURATION_SEC,
  removeSceneLayoutSelection,
  replaceSceneLayoutSelection,
  sceneLayoutSelectionAt,
  type ClipAspectRatio,
  type SceneLayoutPreset,
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
