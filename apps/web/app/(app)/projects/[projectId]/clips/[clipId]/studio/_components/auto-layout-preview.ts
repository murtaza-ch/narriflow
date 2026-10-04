import type {
  ClipAutoLayoutSegment,
  SpeakerLayerRole,
  SpeakerLayerTransform,
} from "@narriflow/validators";

export function activeAutoLayoutSegment(
  segments: ClipAutoLayoutSegment[],
  editedTimeSec: number,
): ClipAutoLayoutSegment | null {
  if (segments.length === 0) return null;
  const time = Math.max(0, editedTimeSec);
  return (
    segments.find(
      (segment, index) =>
        time >= segment.startSec &&
        (time < segment.endSec ||
          (index === segments.length - 1 && time <= segment.endSec + 0.075)),
    ) ?? null
  );
}

export function speakerLayerTransformEquals(
  left: SpeakerLayerTransform,
  right: SpeakerLayerTransform,
): boolean {
  return (
    left.role === right.role &&
    left.frameX === right.frameX &&
    left.frameY === right.frameY &&
    left.frameWidth === right.frameWidth &&
    left.frameHeight === right.frameHeight &&
    left.rotationDeg === right.rotationDeg &&
    left.cropCxNorm === right.cropCxNorm &&
    left.cropCyNorm === right.cropCyNorm &&
    left.cropZoom === right.cropZoom
  );
}

export function resetSpeakerLayerTransform(
  layers: SpeakerLayerTransform[],
  defaultLayers: SpeakerLayerTransform[],
  role: SpeakerLayerRole,
): {
  layers: SpeakerLayerTransform[];
  changed: boolean;
  isFullyReset: boolean;
} {
  const defaultLayer = defaultLayers.find((layer) => layer.role === role);
  const currentLayer = layers.find((layer) => layer.role === role);
  if (
    !defaultLayer ||
    !currentLayer ||
    speakerLayerTransformEquals(currentLayer, defaultLayer)
  ) {
    return {
      layers,
      changed: false,
      isFullyReset: layers.every((layer) => {
        const defaultForRole = defaultLayers.find(
          (candidate) => candidate.role === layer.role,
        );
        return defaultForRole
          ? speakerLayerTransformEquals(layer, defaultForRole)
          : false;
      }),
    };
  }

  const nextLayers = layers.map((layer) =>
    layer.role === role ? defaultLayer : layer,
  );
  return {
    layers: nextLayers,
    changed: true,
    isFullyReset: nextLayers.every((layer) => {
      const defaultForRole = defaultLayers.find(
        (candidate) => candidate.role === layer.role,
      );
      return defaultForRole
        ? speakerLayerTransformEquals(layer, defaultForRole)
        : false;
    }),
  };
}
