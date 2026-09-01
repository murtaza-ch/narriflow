import { z } from "zod";

const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const boundedTimeSchema = z.number().finite().min(0).max(60 * 60 * 12);

export const TIMED_EDIT_LIMITS = {
  sceneBlocks: 64,
  censorSegments: 256,
  mediaMotions: 128,
  documentBytes: 512 * 1024,
  totalEditedDurationSec: 120,
} as const;

export const visualAssetReferenceSchema = z.strictObject({
  kind: z.literal("visual_asset"),
  id: z.string().uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{32,128}$/i),
});

export const SYSTEM_SCENE_FONT_FAMILIES = ["Archivo", "Arial"] as const;
export const brandFontReferenceSchema = z.strictObject({
	kind: z.literal("brand_font"),
	id: z.string().uuid(),
	fingerprint: z.string().regex(/^[a-f0-9]{32,128}$/i),
});

export const sceneMotionSchema = z.strictObject({
  entrance: z.enum(["none", "fade", "slide-up", "zoom-in"]),
  exit: z.enum(["none", "fade", "slide-down", "zoom-out"]),
});

export const sceneContentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("video"),
    asset: visualAssetReferenceSchema,
    sourceStartSec: boundedTimeSchema,
    sourceEndSec: boundedTimeSchema,
    fit: z.enum(["cover", "contain"]),
    backgroundColor: hexColorSchema,
    muted: z.boolean(),
    volume: z.number().finite().min(0).max(100).default(100),
  }).refine((content) => content.sourceEndSec > content.sourceStartSec, {
    message: "sourceEndSec must be greater than sourceStartSec",
  }),
  z.strictObject({
    kind: z.literal("image"),
    asset: visualAssetReferenceSchema,
    fit: z.enum(["cover", "contain"]),
    backgroundColor: hexColorSchema,
  }),
  z.strictObject({
    kind: z.literal("color"),
    color: hexColorSchema,
  }),
  z.strictObject({
    kind: z.literal("text"),
    text: z.string().trim().min(1).max(500),
    fontFamily: z.string().trim().min(1).max(120).default("Arial"),
		fontAsset: brandFontReferenceSchema.nullable().default(null),
    color: hexColorSchema,
    backgroundColor: hexColorSchema,
  }),
]).superRefine((content, context) => {
	if (
		content.kind === "text" &&
		content.fontAsset === null &&
		!SYSTEM_SCENE_FONT_FAMILIES.some((family) => family === content.fontFamily)
	) {
		context.addIssue({ code: "custom", path: ["fontFamily"], message: "System Scene fonts must use the supported fallback set" });
	}
});

export const sceneTemplateSnapshotSchema = z.strictObject({
  templateId: z.string().uuid(),
  templateRevision: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{32,128}$/i),
  name: z.string().trim().min(1).max(120),
}).nullable();

export function sceneDurationIssue(content: z.infer<typeof sceneContentSchema>, durationSec: number) {
  if (content.kind === "video") {
    return durationSec > content.sourceEndSec - content.sourceStartSec + 0.001
      ? "Video scene duration cannot exceed its selected source range"
      : null;
  }
  return durationSec < 1 || durationSec > 30
    ? "Image, color, and text scenes must be between 1 and 30 seconds"
    : null;
}

export const sceneBlockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  anchorSec: boundedTimeSchema,
  durationSec: z.number().finite().min(0.1).max(120),
  content: sceneContentSchema,
  motion: sceneMotionSchema,
  templateSnapshot: sceneTemplateSnapshotSchema,
}).superRefine((scene, context) => {
  const issue = sceneDurationIssue(scene.content, scene.durationSec);
  if (issue) context.addIssue({ code: "custom", path: ["durationSec"], message: issue });
});

export const censorSegmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  sourceWordIds: z.array(z.string().min(1).max(120)).min(1).max(64),
  sourceStartSec: boundedTimeSchema,
  sourceEndSec: boundedTimeSchema,
  treatment: z.enum(["beep", "mute", "caption_mask"]),
  paddingSec: z.number().finite().min(0).max(1),
  beepSettings: z.strictObject({
    frequencyHz: z.number().finite().min(200).max(2_000),
    levelDb: z.number().finite().min(-48).max(-1),
  }).nullable().default(null),
  captionMaskPolicy: z.strictObject({
    replacement: z.enum(["asterisks", "first_character", "full_block"]),
    preservePunctuation: z.boolean(),
  }).nullable().default(null),
  suggestionFingerprint: z.string().regex(/^[a-f0-9]{32,128}$/i).nullable().default(null),
  policyVersion: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
}).superRefine((segment, context) => {
  if (segment.sourceEndSec <= segment.sourceStartSec) {
    context.addIssue({ code: "custom", path: ["sourceEndSec"], message: "sourceEndSec must be greater than sourceStartSec" });
  }
  if (segment.treatment === "beep" && !segment.beepSettings) {
    context.addIssue({ code: "custom", path: ["beepSettings"], message: "beep settings are required for beep treatment" });
  }
  if (segment.treatment === "caption_mask" && !segment.captionMaskPolicy) {
    context.addIssue({ code: "custom", path: ["captionMaskPolicy"], message: "caption mask policy is required for caption masking" });
  }
});

export const mediaMotionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("broll") }),
    z.strictObject({ kind: z.literal("scene_block"), sceneBlockId: z.string().uuid() }),
  ]),
  startSec: boundedTimeSchema,
  endSec: boundedTimeSchema,
  entrance: z.enum(["none", "fade", "scale-in", "pan-left", "pan-right", "pan-up", "pan-down", "ken-burns-in"]),
  exit: z.enum(["none", "fade", "scale-out", "pan-left", "pan-right", "pan-up", "pan-down", "ken-burns-out"]),
  enabled: z.boolean().default(true),
}).refine((motion) => motion.endSec > motion.startSec, {
  message: "endSec must be greater than startSec",
});

export type SceneBlock = z.infer<typeof sceneBlockSchema>;
export type SceneContent = z.infer<typeof sceneContentSchema>;
export type SceneMotion = z.infer<typeof sceneMotionSchema>;
export type CensorSegment = z.infer<typeof censorSegmentSchema>;
export type MediaMotion = z.infer<typeof mediaMotionSchema>;

export function sortSceneBlocks(blocks: readonly SceneBlock[]): SceneBlock[] {
  return [...blocks].sort((left, right) =>
    left.anchorSec - right.anchorSec || left.id.localeCompare(right.id));
}

export function sceneBlocksEqual(left: readonly SceneBlock[], right: readonly SceneBlock[]) {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

export function timedEditsEqual(left: readonly unknown[], right: readonly unknown[]) {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}
