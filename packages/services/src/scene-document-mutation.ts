import {
  buildClipCutPlan,
  deletedRangesEqual,
  rebaseSceneBlocks,
  type EditorDocument,
  type SceneBlock,
} from "@narriflow/validators";
import { requirePlanFeature } from "./plan-features";

export interface SceneDocumentMutationAnalysis {
  changedSceneBlocks: SceneBlock[];
  introducedSceneReferences: SceneBlock[];
  introducedVisualAssetIds: string[];
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
    // A window cut short by a shrinking timeline removes motion; it adds none.
    const shortened =
      previous !== undefined &&
      motion.endSec <= previous.endSec &&
      JSON.stringify({ ...previous, endSec: motion.endSec }) === JSON.stringify(motion);
    return (
      JSON.stringify(previous) !== JSON.stringify(motion) &&
      !shortened &&
      motion.enabled &&
      (motion.entrance !== "none" || motion.exit !== "none")
    );
  });
}

/** Reducer arithmetic and per-edit rounding can leave a shifted anchor a few
 *  milliseconds from a single-step rebase; no user move is that small. */
const SCENE_SHIFT_TOLERANCE_SEC = 0.01;

/** Where each kept Scene lands if the change only removed Scenes and moved
 *  the timeline under them (cuts, reverts, clip trims), using the reducer's
 *  own rebase. */
function cleanupSceneAnchors(current: EditorDocument, next: EditorDocument): Map<string, number> {
  const nextIds = new Set(next.sceneBlocks.map((scene) => scene.id));
  const currentWindow = { startSec: current.clipStartSec, endSec: current.clipEndSec };
  const oldMap = buildClipCutPlan(current.deletedRanges, currentWindow).map;
  const sameTimeline =
    current.clipStartSec === next.clipStartSec &&
    current.clipEndSec === next.clipEndSec &&
    deletedRangesEqual(current.deletedRanges, next.deletedRanges, currentWindow);
  const newMap = sameTimeline
    ? oldMap
    : buildClipCutPlan(next.deletedRanges, { startSec: next.clipStartSec, endSec: next.clipEndSec }).map;
  return new Map(
    rebaseSceneBlocks(current.sceneBlocks, oldMap, newMap, (scene) => nextIds.has(scene.id))
      .map((scene) => [scene.id, scene.anchorSec]),
  );
}

/** A kept Scene whose change only removes paid content: its motion turned
 *  off, its template link dropped (the Studio drops it on any edit), or its
 *  position shifted by removals and cuts. */
function isSceneCleanup(
  previous: SceneBlock | undefined,
  scene: SceneBlock,
  cleanupAnchorSec: number | undefined,
): boolean {
  if (!previous || cleanupAnchorSec === undefined) return false;
  if (Math.abs(scene.anchorSec - cleanupAnchorSec) > SCENE_SHIFT_TOLERANCE_SEC) return false;
  const motionOff = scene.motion.entrance === "none" && scene.motion.exit === "none";
  return JSON.stringify({
    ...previous,
    anchorSec: scene.anchorSec,
    motion: motionOff ? scene.motion : previous.motion,
    templateSnapshot: scene.templateSnapshot === null ? null : previous.templateSnapshot,
  }) === JSON.stringify(scene);
}

/**
 * The plan rules for one Clip Editor Document change, enforced by
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
  // Removed Scenes, and kept Scenes whose change is only cleanup, need no
  // plan; only added or edited Scenes in the next document are gated.
  const changedScenes = next.sceneBlocks.filter((scene) => changedIds.has(scene.id));
  if (changedScenes.length > 0) {
    const cleanupAnchors = cleanupSceneAnchors(current, next);
    if (changedScenes.some((scene) =>
      !isSceneCleanup(currentById.get(scene.id), scene, cleanupAnchors.get(scene.id)))) {
      requirePlanFeature(pricingTier, "brand.scenes");
    }
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
  }
}
