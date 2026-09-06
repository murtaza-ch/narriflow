import type { EditorDocument, SceneBlock } from "@narriflow/validators";
import { hasFeature } from "./billing.service";
import { ClipActionError } from "./clip.service";
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

export function analyzeSceneDocumentMutation(
  current: EditorDocument,
  next: EditorDocument,
  pricingTier: string,
): SceneDocumentMutationAnalysis {
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

  if (changedIds.size > 0) {
    if (!hasFeature(pricingTier, "brand.scenes")) {
      throw new ClipActionError("scene_feature_unavailable");
    }
    const disabledGroup = [...changedIds]
      .flatMap((id) => [currentById.get(id), nextById.get(id)])
      .filter((scene): scene is SceneBlock => Boolean(scene))
      .map(sceneProgramReleaseGroup)
      .find((group) => group && !isProgramWriteEnabled(group));
    if (disabledGroup) throw new ProgramWriteDisabledError(disabledGroup);
  }

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
