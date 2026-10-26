import type { CensorSegment, EditorDocument, SceneBlock } from "@narriflow/validators";
import { requirePlanFeature } from "./plan-features";
import {
  isProgramWriteEnabled,
  ProgramWriteDisabledError,
  type ProgramReleaseGroup,
} from "./program-rollout";

export interface SceneDocumentMutationAnalysis {
  changedSceneBlocks: SceneBlock[];
  introducedSceneReferences: SceneBlock[];
  introducedVisualAssetIds: string[];
}

function sceneProgramReleaseGroup(
  scene: SceneBlock,
): ProgramReleaseGroup | null {
  if (scene.templateSnapshot) return "scene_templates";
  if (scene.content.kind === "text" || scene.content.kind === "color") {
    return "scene_cards";
  }
  if (scene.content.kind === "image") return "scene_images";
  if (scene.content.kind === "video") return "scene_videos";
  return null;
}

function sceneReference(scene: SceneBlock) {
  if (scene.content.kind === "image" || scene.content.kind === "video") {
    return scene.content.asset;
  }
  return scene.content.kind === "text" ? scene.content.fontAsset : null;
}

function visualAssetIds(document: EditorDocument): string[] {
  return [
    ...document.sceneBlocks.flatMap((scene) =>
      scene.content.kind === "image" || scene.content.kind === "video"
        ? [scene.content.asset.id]
        : [],
    ),
    ...document.studioEdits.visualBroll.map(
      (placement) => placement.asset.id,
    ),
  ];
}

function sceneChanges(current: EditorDocument, next: EditorDocument) {
  const currentById = new Map(
    current.sceneBlocks.map((scene) => [scene.id, scene]),
  );
  const nextById = new Map(next.sceneBlocks.map((scene) => [scene.id, scene]));
  const changedIds = new Set(
    [...currentById.keys(), ...nextById.keys()].filter(
      (id) =>
        JSON.stringify(currentById.get(id)) !==
        JSON.stringify(nextById.get(id)),
    ),
  );
  return { currentById, nextById, changedIds };
}

/** The Scene references a document change introduces, for reference validation. */
export function analyzeSceneDocumentMutation(
  current: EditorDocument,
  next: EditorDocument,
): SceneDocumentMutationAnalysis {
  const { currentById, changedIds } = sceneChanges(current, next);
  const changedSceneBlocks = next.sceneBlocks.filter((scene) =>
    changedIds.has(scene.id),
  );
  const introducedSceneReferences = next.sceneBlocks.filter((scene) => {
    const previous = currentById.get(scene.id);
    return (
      !previous ||
      previous.content.kind !== scene.content.kind ||
      JSON.stringify(sceneReference(previous)) !==
        JSON.stringify(sceneReference(scene))
    );
  });
  const currentVisualAssetIds = new Set(visualAssetIds(current));
  const introducedVisualAssetIds = [
    ...new Set(
      visualAssetIds(next).filter((id) => !currentVisualAssetIds.has(id)),
    ),
  ];

  return {
    changedSceneBlocks,
    introducedSceneReferences,
    introducedVisualAssetIds,
  };
}

function activeMotionChanged(current: EditorDocument, next: EditorDocument): boolean {
  if (
    JSON.stringify(current.studioEdits.transition) !==
      JSON.stringify(next.studioEdits.transition) &&
    next.studioEdits.transition.type !== "none"
  ) {
    return true;
  }

  const currentScenes = new Map(current.sceneBlocks.map((scene) => [scene.id, scene]));
  if (
    next.sceneBlocks.some((scene) => {
      const previous = currentScenes.get(scene.id);
      return (
        JSON.stringify(previous?.motion) !== JSON.stringify(scene.motion) &&
        (scene.motion.entrance !== "none" || scene.motion.exit !== "none")
      );
    })
  ) {
    return true;
  }

  const targetKey = (motion: EditorDocument["mediaMotions"][number]) =>
    motion.target.kind === "broll"
      ? "broll"
      : `scene:${motion.target.sceneBlockId}`;
  const currentMedia = new Map(current.mediaMotions.map((motion) => [targetKey(motion), motion]));
  return next.mediaMotions.some((motion) => {
    const previous = currentMedia.get(targetKey(motion));
    return (
      JSON.stringify(previous) !== JSON.stringify(motion) &&
      motion.enabled &&
      (motion.entrance !== "none" || motion.exit !== "none")
    );
  });
}

function onlyDeactivatesMotion(previous: SceneBlock | undefined, scene: SceneBlock): boolean {
  return (
    previous !== undefined &&
    scene.motion.entrance === "none" &&
    scene.motion.exit === "none" &&
    JSON.stringify({ ...previous, motion: scene.motion }) === JSON.stringify(scene)
  );
}

function censorTreatmentProgramGroup(
  segment: CensorSegment,
): ProgramReleaseGroup {
  return segment.treatment === "caption_mask"
    ? "auto_censor_caption_masks"
    : segment.treatment === "mute"
      ? "auto_censor_mute"
      : "auto_censor_beep";
}

/**
 * The plan and rollout rules for one Clip Editor Document change, enforced by
 * document persistence for every replace, field patch, reset, and bulk edit.
 * Adding, activating, or changing paid content (Scenes, motion, Auto Censor)
 * needs the plan feature. Removing or disabling it never does, so a downgraded
 * Workspace can always clean a document up.
 */
export function assertEditorDocumentFeatureDelta(
  pricingTier: string,
  current: EditorDocument,
  next: EditorDocument,
): void {
  const { currentById, changedIds } = sceneChanges(current, next);
  // Removed Scenes and Scenes whose only change turns their motion off are
  // cleanup; only added or edited Scenes in the next document are gated.
  const gatedScenes = next.sceneBlocks.filter(
    (scene) => changedIds.has(scene.id) && !onlyDeactivatesMotion(currentById.get(scene.id), scene),
  );
  if (gatedScenes.length > 0) {
    requirePlanFeature(pricingTier, "brand.scenes");
    const disabledGroup = gatedScenes
      .map(sceneProgramReleaseGroup)
      .find((group) => group && !isProgramWriteEnabled(group));
    if (disabledGroup) throw new ProgramWriteDisabledError(disabledGroup);
  }

  if (activeMotionChanged(current, next)) {
    requirePlanFeature(pricingTier, "editor.motion");
  }

  const currentCensor = new Map(current.censorSegments.map((segment) => [segment.id, segment]));
  const changedCensor = next.censorSegments.filter(
    (segment) => JSON.stringify(currentCensor.get(segment.id)) !== JSON.stringify(segment),
  );
  if (changedCensor.some((segment) => !currentCensor.has(segment.id) || segment.enabled)) {
    requirePlanFeature(pricingTier, "editor.censoring");
    const disabled = changedCensor.find(
      (segment) => segment.enabled && !isProgramWriteEnabled(censorTreatmentProgramGroup(segment)),
    );
    if (disabled) throw new ProgramWriteDisabledError(censorTreatmentProgramGroup(disabled));
  }
}
