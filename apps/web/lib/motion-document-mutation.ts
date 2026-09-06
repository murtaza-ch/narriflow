import {
  ClipActionError,
  ClipExportError,
  hasFeature,
} from "@narriflow/services";
import {
  editorDocumentUsesMotion,
  type EditorDocument,
} from "@narriflow/validators";

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

export function motionDocumentExportError(
  pricingTier: string,
  document: EditorDocument,
) {
  if (!editorDocumentUsesMotion(document)) return null;
  return hasFeature(pricingTier, "editor.motion")
    ? null
    : new ClipExportError(
        "motion_feature_unavailable",
        "Motion export is available on Creator and above",
      );
}

export function motionDocumentMutationError(
  pricingTier: string,
  current: EditorDocument,
  next: EditorDocument,
) {
  if (!activeMotionChanged(current, next)) return null;
  return hasFeature(pricingTier, "editor.motion")
    ? null
    : new ClipActionError(
        "motion_feature_unavailable",
      );
}
