import {
  clipAspectRatioOptions,
  type ClipAspectRatio,
  type ClipAutoLayoutAnalysis,
  type ClipAutoLayoutSegment,
  type SpeakerLayerRole,
  type SpeakerLayerTransform,
} from "@narriflow/validators";
import type { NormalizedCropRect } from "./normalized-crop";

const aspectDimensions = new Map(
  clipAspectRatioOptions.map((option) => [
    option.value,
    { width: option.width, height: option.height },
  ]),
);

export function autoLayoutSupportsTwoUp(
  aspectRatio: ClipAspectRatio,
  source: { width: number; height: number },
): boolean {
  const target = aspectDimensions.get(aspectRatio);
  if (!target || source.width <= 0 || source.height <= 0) return false;
  const tileRatio = target.width / (target.height / 2);
  const sourceRatio = source.width / source.height;
  const cropWidth =
    sourceRatio >= tileRatio
      ? Math.round(source.height * tileRatio)
      : source.width;
  return cropWidth < source.width;
}

export function autoLayoutSegmentsForAspect(
  analysis: ClipAutoLayoutAnalysis,
  aspectRatio: ClipAspectRatio,
  source: { width: number; height: number },
): ClipAutoLayoutSegment[] {
  return autoLayoutSupportsTwoUp(aspectRatio, source)
    ? analysis.segments
    : analysis.noSplitSegments;
}

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

function cropAroundCenter(
  source: { width: number; height: number },
  targetRatio: number,
  center: { cx: number; cy: number; zoom: number },
): NormalizedCropRect | null {
  if (
    source.width <= 0 ||
    source.height <= 0 ||
    !Number.isFinite(targetRatio) ||
    targetRatio <= 0
  ) {
    return null;
  }
  const sourceRatio = source.width / source.height;
  let width = sourceRatio >= targetRatio ? targetRatio / sourceRatio : 1;
  let height = sourceRatio >= targetRatio ? 1 : sourceRatio / targetRatio;
  const zoom = Math.min(4, Math.max(1, center.zoom));
  width /= zoom;
  height /= zoom;
  const x = Math.max(0, Math.min(1 - width, center.cx - width / 2));
  const y = Math.max(0, Math.min(1 - height, center.cy - height / 2));
  return { x, y, w: width, h: height };
}

export function autoLayoutCropRect(
  segment: ClipAutoLayoutSegment,
  role: "single" | "top" | "bottom",
  aspectRatio: ClipAspectRatio,
  source: { width: number; height: number },
): NormalizedCropRect | null {
  const target = aspectDimensions.get(aspectRatio);
  if (!target) return null;
  const outputRatio = target.width / target.height;

  if (segment.layout === "single") {
    return cropAroundCenter(source, outputRatio, {
      cx: segment.cxNorm,
      cy: segment.cyNorm,
      zoom: segment.zoom,
    });
  }
  const tileRatio = outputRatio * 2;
  const top = role !== "bottom";
  return cropAroundCenter(source, tileRatio, {
    cx: top ? segment.topCxNorm : segment.bottomCxNorm,
    cy: top ? segment.topCyNorm : segment.bottomCyNorm,
    zoom: top ? segment.topZoom : segment.bottomZoom,
  });
}

/** Crop for an editable speaker layer. Unlike autoLayoutCropRect, the target
 * ratio comes from the layer's own frame on the output canvas, so resizing a
 * Vizard-style speaker box changes the source crop and export identically. */
export function speakerLayerCropRect(
  layer: SpeakerLayerTransform,
  aspectRatio: ClipAspectRatio,
  source: { width: number; height: number },
): NormalizedCropRect | null {
  const target = aspectDimensions.get(aspectRatio);
  if (!target || layer.frameWidth <= 0 || layer.frameHeight <= 0) return null;
  const targetRatio =
    (target.width * layer.frameWidth) / (target.height * layer.frameHeight);
  return cropAroundCenter(source, targetRatio, {
    cx: layer.cropCxNorm,
    cy: layer.cropCyNorm,
    zoom: layer.cropZoom,
  });
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
