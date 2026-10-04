import { z } from "zod";
import type { ClipAspectRatio } from "./clip";
import { SCENE_LAYOUT_MIN_DURATION_SEC } from "./scene-layouts";

const unit = z.number().finite().min(0).max(1);

export const speakerLayerRoleSchema = z.enum([
  "single",
  "top",
  "bottom",
  "third",
  "fourth",
]);

export const speakerLayerTransformSchema = z
  .object({
    role: speakerLayerRoleSchema,
    /** Layer frame on the output canvas, normalized to 0..1. */
    frameX: unit,
    frameY: unit,
    frameWidth: z.number().finite().min(0.08).max(1),
    frameHeight: z.number().finite().min(0.08).max(1),
    rotationDeg: z.number().finite().min(-180).max(180).default(0),
    /** Virtual-camera crop inside the source frame. */
    cropCxNorm: unit,
    cropCyNorm: unit,
    cropZoom: z.number().finite().min(1).max(4),
  })
  .superRefine((layer, ctx) => {
    // Keeping the unrotated frame inside the output canvas is a shared
    // preview/render invariant. The editor already clamps gestures; this
    // closes the same boundary at API/JSON ingress so malformed documents
    // cannot produce clipped or negative FFmpeg overlay coordinates.
    if (layer.frameX + layer.frameWidth > 1 + Number.EPSILON) {
      ctx.addIssue({
        code: "custom",
        path: ["frameWidth"],
        message: "frameX + frameWidth must not exceed 1",
      });
    }
    if (layer.frameY + layer.frameHeight > 1 + Number.EPSILON) {
      ctx.addIssue({
        code: "custom",
        path: ["frameHeight"],
        message: "frameY + frameHeight must not exceed 1",
      });
    }
  });

/**
 * A manual edit for one automatically detected scene. Times are on the
 * edited timeline, like ClipAutoLayoutAnalysis.segments. Overrides are
 * aspect-specific because moving a layer on 9:16 must not silently damage
 * a separately composed 16:9 export.
 */
export const studioSpeakerLayoutOverrideSchema = z
  .object({
    id: z.string().min(1).max(100),
    aspectRatio: z.enum(["9:16", "1:1", "16:9", "4:5"]),
    startSec: z.number().finite().min(0),
    endSec: z.number().finite().gt(0),
    layout: z.enum(["single", "two-up"]),
    layers: z.array(speakerLayerTransformSchema).min(1).max(2),
  })
  .superRefine((override, ctx) => {
    if (override.endSec <= override.startSec) {
      ctx.addIssue({
        code: "custom",
        path: ["endSec"],
        message: "endSec must be greater than startSec",
      });
    }
    const roles = override.layers.map((layer) => layer.role);
    const expected = override.layout === "single" ? ["single"] : ["top", "bottom"];
    if (
      roles.length !== expected.length ||
      expected.some((role) => !roles.includes(role as (typeof roles)[number]))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["layers"],
        message:
          override.layout === "single"
            ? "single overrides require one single layer"
            : "two-up overrides require top and bottom layers",
      });
    }
  });

export type SpeakerLayerRole = z.infer<typeof speakerLayerRoleSchema>;
export type SpeakerLayerTransform = z.infer<typeof speakerLayerTransformSchema>;
export type StudioSpeakerLayoutOverride = z.infer<
  typeof studioSpeakerLayoutOverrideSchema
>;

function speakerLayerTransformsEqual(
  left: SpeakerLayerTransform,
  right: SpeakerLayerTransform,
): boolean {
  return (
    left === right ||
    (left.role === right.role &&
      left.frameX === right.frameX &&
      left.frameY === right.frameY &&
      left.frameWidth === right.frameWidth &&
      left.frameHeight === right.frameHeight &&
      left.rotationDeg === right.rotationDeg &&
      left.cropCxNorm === right.cropCxNorm &&
      left.cropCyNorm === right.cropCyNorm &&
      left.cropZoom === right.cropZoom)
  );
}

/** Order-sensitive equality for canonical manual speaker-layout scenes. */
export function speakerLayoutOverridesEqual(
  left: readonly StudioSpeakerLayoutOverride[],
  right: readonly StudioSpeakerLayoutOverride[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((override, index) => {
    const candidate = right[index]!;
    if (override === candidate) return true;
    if (
      override.id !== candidate.id ||
      override.aspectRatio !== candidate.aspectRatio ||
      override.startSec !== candidate.startSec ||
      override.endSec !== candidate.endSec ||
      override.layout !== candidate.layout ||
      override.layers.length !== candidate.layers.length
    ) {
      return false;
    }
    return override.layers.every((layer, layerIndex) =>
      speakerLayerTransformsEqual(layer, candidate.layers[layerIndex]!),
    );
  });
}

function overrideFragmentId(
  override: StudioSpeakerLayoutOverride,
  side: "left" | "right",
  boundarySec: number,
): string {
  const seed = `${override.id}:${side}:${boundarySec.toFixed(6)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${override.id.slice(0, 86)}:${side[0]}:${(hash >>> 0).toString(16)}`;
}

/** Removes one edited-time range while retaining valid manual-transform
 * remainders on either side and every override for other aspect ratios. */
export function removeSpeakerLayoutOverrideRange(
  overrides: readonly StudioSpeakerLayoutOverride[],
  range: Pick<
    StudioSpeakerLayoutOverride,
    "aspectRatio" | "startSec" | "endSec"
  >,
): StudioSpeakerLayoutOverride[] {
  const output: StudioSpeakerLayoutOverride[] = [];
  for (const override of overrides) {
    if (
      override.aspectRatio !== range.aspectRatio ||
      override.endSec <= range.startSec ||
      override.startSec >= range.endSec
    ) {
      output.push(override);
      continue;
    }
    if (
      range.startSec - override.startSec >= SCENE_LAYOUT_MIN_DURATION_SEC
    ) {
      output.push({
        ...override,
        id: overrideFragmentId(override, "left", range.startSec),
        endSec: range.startSec,
      });
    }
    if (override.endSec - range.endSec >= SCENE_LAYOUT_MIN_DURATION_SEC) {
      output.push({
        ...override,
        id: overrideFragmentId(override, "right", range.endSec),
        startSec: range.endSec,
      });
    }
  }
  return output.sort(
    (left, right) =>
      left.aspectRatio.localeCompare(right.aspectRatio) ||
      left.startSec - right.startSec ||
      left.endSec - right.endSec,
  );
}

export interface ResolvedSpeakerLayoutScene {
  startSec: number;
  endSec: number;
  layout: "single" | "two-up";
  layers: SpeakerLayerTransform[];
  overrideId: string | null;
}

/** Structural subset shared by persisted auto-layout segments and the
 * worker's in-memory SplitLayoutSegment. Split segments may omit vertical
 * framing and zoom; resolution then centers vertically at zoom 1. */
export type SpeakerLayoutBaseSegment =
  | {
      startSec: number;
      endSec: number;
      layout: "single";
      cxNorm: number;
      cyNorm?: number;
      zoom?: number;
    }
  | {
      startSec: number;
      endSec: number;
      layout: "two-up";
      topCxNorm: number;
      bottomCxNorm: number;
      topCyNorm?: number;
      bottomCyNorm?: number;
      topZoom?: number;
      bottomZoom?: number;
    };

export function defaultSpeakerLayersForSegment(
  segment: SpeakerLayoutBaseSegment,
): SpeakerLayerTransform[] {
  if (segment.layout === "single") {
    return [
      {
        role: "single",
        frameX: 0,
        frameY: 0,
        frameWidth: 1,
        frameHeight: 1,
        rotationDeg: 0,
        cropCxNorm: segment.cxNorm,
        cropCyNorm: segment.cyNorm ?? 0.5,
        cropZoom: segment.zoom ?? 1,
      },
    ];
  }
  return [
    {
      role: "top",
      frameX: 0,
      frameY: 0,
      frameWidth: 1,
      frameHeight: 0.5,
      rotationDeg: 0,
      cropCxNorm: segment.topCxNorm,
      cropCyNorm: segment.topCyNorm ?? 0.5,
      cropZoom: segment.topZoom ?? 1,
    },
    {
      role: "bottom",
      frameX: 0,
      frameY: 0.5,
      frameWidth: 1,
      frameHeight: 0.5,
      rotationDeg: 0,
      cropCxNorm: segment.bottomCxNorm,
      cropCyNorm: segment.bottomCyNorm ?? 0.5,
      cropZoom: segment.bottomZoom ?? 1,
    },
  ];
}

function overlapRatio(
  segment: Pick<SpeakerLayoutBaseSegment, "startSec" | "endSec">,
  override: Pick<StudioSpeakerLayoutOverride, "startSec" | "endSec">,
): number {
  const overlap = Math.max(
    0,
    Math.min(segment.endSec, override.endSec) -
      Math.max(segment.startSec, override.startSec),
  );
  const shortest = Math.min(
    segment.endSec - segment.startSec,
    override.endSec - override.startSec,
  );
  return shortest > 0 ? overlap / shortest : 0;
}

/**
 * Resolves one analyzed segment to its editable scene. Exact boundary
 * matches win; a strong overlap fallback keeps a manual edit attached after
 * a small detector-boundary shift, while layout/aspect checks prevent it
 * leaking onto a different composition.
 */
export function resolveSpeakerLayoutScene(
  segment: SpeakerLayoutBaseSegment,
  overrides: StudioSpeakerLayoutOverride[],
  aspectRatio: ClipAspectRatio,
): ResolvedSpeakerLayoutScene {
  const candidates = overrides
    .filter(
      (override) =>
        override.aspectRatio === aspectRatio &&
        override.layout === segment.layout,
    )
    .map((override) => ({ override, overlap: overlapRatio(segment, override) }))
    .filter(({ overlap }) => overlap >= 0.6)
    .sort((left, right) => right.overlap - left.overlap);
  const winner = candidates[0]?.override ?? null;
  return {
    startSec: segment.startSec,
    endSec: segment.endSec,
    layout: segment.layout,
    layers: winner
      ? winner.layers.map((layer) => ({ ...layer }))
      : defaultSpeakerLayersForSegment(segment),
    overrideId: winner?.id ?? null,
  };
}

export function speakerLayoutOverrideFromScene(
  scene: ResolvedSpeakerLayoutScene,
  aspectRatio: ClipAspectRatio,
  id: string,
): StudioSpeakerLayoutOverride {
  return studioSpeakerLayoutOverrideSchema.parse({
    id,
    aspectRatio,
    startSec: scene.startSec,
    endSec: scene.endSec,
    layout: scene.layout,
    layers: scene.layers,
  });
}
