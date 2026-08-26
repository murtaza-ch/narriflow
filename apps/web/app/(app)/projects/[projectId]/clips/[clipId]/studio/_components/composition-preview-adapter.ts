import {
  CLIP_COMPOSITION_PLAN_VERSION,
  type ClipCompositionPlan,
  type CompositionLayer,
} from "@narriflow/composition-plan";

export function plannedCompositionSourceDimensions(
  proxy: { width: number; height: number },
  durable: { sourceWidth: number; sourceHeight: number } | null,
): { width: number; height: number } {
  return durable
    ? { width: durable.sourceWidth, height: durable.sourceHeight }
    : proxy;
}

export function plannedCompositionFrameStyle(
  layer: Extract<CompositionLayer, { kind: "source-video" }>,
  canvas: { width: number; height: number },
) {
  return {
    position: "absolute" as const,
    left: `${(layer.destination.x / canvas.width) * 100}%`,
    top: `${(layer.destination.y / canvas.height) * 100}%`,
    width: `${(layer.destination.width / canvas.width) * 100}%`,
    height: `${(layer.destination.height / canvas.height) * 100}%`,
    transform: `rotate(${layer.rotationDeg}deg)`,
    transformOrigin: "center",
  };
}

export function plannedCompositionVideoStyle(
  layer: Extract<CompositionLayer, { kind: "source-video" }>,
  source: { width: number; height: number },
  destinationPixels: { width: number; height: number },
  visible: boolean,
) {
  if (layer.fit === "contain") {
    return {
      position: "absolute" as const,
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "contain" as const,
      display: visible ? "block" : "none",
    };
  }
  const normalized = {
    x: layer.sourceCrop.x / source.width,
    y: layer.sourceCrop.y / source.height,
    width: layer.sourceCrop.width / source.width,
    height: layer.sourceCrop.height / source.height,
  };
  const width = destinationPixels.width / normalized.width;
  const height = destinationPixels.height / normalized.height;
  return {
    position: "absolute" as const,
    left: `${-normalized.x * width}px`,
    top: `${-normalized.y * height}px`,
    width: `${width}px`,
    height: `${height}px`,
    maxWidth: "none" as const,
    display: visible ? "block" : "none",
  };
}

export function plannedCompositionUsesStackedStage(
  preview: ReturnType<typeof adoptCompositionPreview>,
): boolean {
  if (
    preview.effectiveMode !== "split" &&
    preview.effectiveMode !== "screen"
  ) {
    return false;
  }
  return (
    preview.layers.filter((layer) => layer.kind === "source-video").length > 1
  );
}

const SCENE_END_EPSILON_SEC = 0.075;

function assertFiniteRect(
  rect: { x: number; y: number; width: number; height: number },
  bounds: { width: number; height: number },
  code: string,
): void {
  if (
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x + rect.width > bounds.width ||
    rect.y + rect.height > bounds.height
  ) {
    throw new Error(code);
  }
}

function assertLayerGeometry(
  layer: CompositionLayer,
  canvas: { width: number; height: number },
  source: { width: number; height: number },
): void {
  assertFiniteRect(
    layer.destination,
    canvas,
    "invalid_clip_composition_destination",
  );
  if (layer.kind === "source-video") {
    if (
      ![layer.sourceCrop.x, layer.sourceCrop.y, layer.sourceCrop.width, layer.sourceCrop.height]
        .every(Number.isFinite) ||
      layer.sourceCrop.x < 0 ||
      layer.sourceCrop.y < 0 ||
      layer.sourceCrop.width <= 0 ||
      layer.sourceCrop.height <= 0 ||
      layer.sourceCrop.x + layer.sourceCrop.width > source.width ||
      layer.sourceCrop.y + layer.sourceCrop.height > source.height
    ) {
      throw new Error("invalid_clip_composition_source_crop");
    }
  }
}

export function adoptCompositionPreview(
  plan: ClipCompositionPlan,
  targetId: string,
  editedTimeSec: number,
) {
  if (plan.version !== CLIP_COMPOSITION_PLAN_VERSION) {
    throw new Error("unsupported_clip_composition_plan_version");
  }
  const target = plan.targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error("clip_composition_target_missing");
  if (
    !Number.isInteger(target.canvas.width) ||
    !Number.isInteger(target.canvas.height) ||
    target.canvas.width <= 0 ||
    target.canvas.height <= 0 ||
    target.canvas.width % target.canvas.divisibleBy !== 0 ||
    target.canvas.height % target.canvas.divisibleBy !== 0
  ) {
    throw new Error("invalid_clip_composition_canvas");
  }
  if (target.scenes.length === 0) {
    throw new Error("invalid_clip_composition_scenes");
  }
  let cursor = 0;
  for (const [index, candidate] of target.scenes.entries()) {
    if (
      Math.abs(candidate.startSec - cursor) > SCENE_END_EPSILON_SEC ||
      candidate.endSec <= candidate.startSec ||
      (index === target.scenes.length - 1 &&
        Math.abs(candidate.endSec - plan.editedDurationSec) >
          SCENE_END_EPSILON_SEC)
    ) {
      throw new Error("invalid_clip_composition_scenes");
    }
    for (const layer of candidate.layers) {
      assertLayerGeometry(layer, target.canvas, plan.source);
      if (
        layer.kind === "source-video" &&
        layer.sourceRef !== plan.source.ref
      ) {
        throw new Error("invalid_clip_composition_source_ref");
      }
    }
    cursor = candidate.endSec;
  }

  const time = Math.max(0, Math.min(editedTimeSec, plan.editedDurationSec));
  const scene = target.scenes.find(
    (candidate, index) =>
      time >= candidate.startSec &&
      (time < candidate.endSec ||
        (index === target.scenes.length - 1 &&
          time <= candidate.endSec + SCENE_END_EPSILON_SEC)),
  );
  if (!scene) throw new Error("clip_composition_scene_missing");
  const mainSource = scene.layers.find(
    (layer): layer is Extract<CompositionLayer, { kind: "source-video" }> =>
      layer.kind === "source-video",
  );
  if (!mainSource) throw new Error("clip_composition_source_layer_missing");

  return {
    planVersion: plan.version,
    planFingerprint: plan.fingerprint,
    mainMediaKey: mainSource.sourceRef,
    canvas: target.canvas,
    sceneId: scene.id,
    sceneStartSec: scene.startSec,
    sceneEndSec: scene.endSec,
    requestedMode: target.requestedMode,
    effectiveMode: target.effectiveMode,
    layers: scene.layers,
    notices: plan.notices.filter(
      (notice) =>
        notice.targetId === target.id &&
        (notice.sceneId === null || notice.sceneId === scene.id),
    ),
  };
}
