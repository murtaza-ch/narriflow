import { z } from "zod";
export {
  captionAnimationSchema,
  captionPresetSchema,
  type CaptionAnimation,
  type CaptionPreset,
} from "./caption-preset";
import { brollCuesArraySchema } from "./broll";
import { captionPresetSchema } from "./caption-preset";
import { clipPlatformTargetSchema } from "./content-pack";
import { studioEditsSchema } from "./studio-edits";
import { transcriptUtteranceSchema } from "./transcript";

export const clipCategorySchema = z.enum([
  "hook",
  "insight",
  "story",
  "humor",
  "controversy",
  "emotional",
  "tutorial",
  "quote",
  "debate",
  "surprise",
]);

export const clipStatusSchema = z.enum([
  "detected",
  "accepted",
  "rejected",
  "edited",
]);

export const clipRenderStatusSchema = z.enum([
  "pending",
  "rendering",
  "completed",
  "failed",
]);

export const clipAspectRatioSchema = z.enum([
  "9:16",
  "1:1",
  "16:9",
  "4:5",
]);

export const clipAspectRatioDbSchema = z.enum([
  "ratio_9_16",
  "ratio_1_1",
  "ratio_16_9",
  "ratio_4_5",
]);

export const clipAspectRatioOptions = [
  {
    value: "9:16",
    label: "Vertical 9:16",
    css: "9 / 16",
    slug: "9x16",
    width: 1080,
    height: 1920,
    iconW: 9,
    iconH: 16,
  },
  {
    value: "1:1",
    label: "Square 1:1",
    css: "1 / 1",
    slug: "1x1",
    width: 1080,
    height: 1080,
    iconW: 12,
    iconH: 12,
  },
  {
    value: "16:9",
    label: "Landscape 16:9",
    css: "16 / 9",
    slug: "16x9",
    width: 1920,
    height: 1080,
    iconW: 16,
    iconH: 9,
  },
  {
    value: "4:5",
    label: "Portrait 4:5",
    css: "4 / 5",
    slug: "4x5",
    width: 1080,
    height: 1350,
    iconW: 10,
    iconH: 12,
  },
] as const satisfies ReadonlyArray<{
  value: z.infer<typeof clipAspectRatioSchema>;
  label: string;
  css: string;
  slug: string;
  width: number;
  height: number;
  iconW: number;
  iconH: number;
}>;

export const clipAspectRatioToDb = {
  "9:16": "ratio_9_16",
  "1:1": "ratio_1_1",
  "16:9": "ratio_16_9",
  "4:5": "ratio_4_5",
} as const satisfies Record<
  z.infer<typeof clipAspectRatioSchema>,
  z.infer<typeof clipAspectRatioDbSchema>
>;

export const clipAspectRatioFromDb = {
  ratio_9_16: "9:16",
  ratio_1_1: "1:1",
  ratio_16_9: "16:9",
  ratio_4_5: "4:5",
} as const satisfies Record<
  z.infer<typeof clipAspectRatioDbSchema>,
  z.infer<typeof clipAspectRatioSchema>
>;

export const updateClipCaptionPresetSchema = z.object({
  captionPreset: captionPresetSchema.nullable(),
});

export const updateClipBrollSchema = z.object({
  // A chosen Pexels download URL, or null to clear and fall back to auto B-roll.
  brollUrl: z.string().url().nullable(),
});

export const brollSearchQuerySchema = z.object({
  query: z.string().min(1).max(120),
  orientation: z.enum(["portrait", "landscape", "square"]).default("portrait"),
});

export const clipRenderVariantSchema = z.object({
  aspectRatio: clipAspectRatioSchema,
  status: clipRenderStatusSchema,
  sizeBytes: z.number().nullable(),
  durationSec: z.number().nullable(),
  errorCode: z.string().nullable(),
  completedAt: z.string().datetime().nullable(),
  hasAsset: z.boolean(),
});

export const clipSnapshotSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  index: z.number().int().nonnegative(),
  status: clipStatusSchema,
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  durationSec: z.number().positive(),
  title: z.string().nullable(),
  hookText: z.string().min(1),
  payoffText: z.string().nullable(),
  reasoning: z.string().min(1),
  category: clipCategorySchema,
  platformFit: z.array(clipPlatformTargetSchema),
  viralityScore: z.number().int().min(1).max(100),
  hookStrengthScore: z.number().int().min(1).max(100),
  emotionalIntensityScore: z.number().int().min(1).max(100),
  storyCompletenessScore: z.number().int().min(1).max(100),
  pacingScore: z.number().int().min(1).max(100),
  durationOptimalityScore: z.number().int().min(1).max(100),
  tiktokScore: z.number().int().min(1).max(100),
  youtubeScore: z.number().int().min(1).max(100),
  instagramScore: z.number().int().min(1).max(100),
  transcriptSlice: z.array(transcriptUtteranceSchema),
  renderVariants: z.array(clipRenderVariantSchema),
  captionPreset: captionPresetSchema.nullable().optional(),
  brollUrl: z.string().nullable().optional(),
  brollCues: brollCuesArraySchema.optional(),
  studioEdits: studioEditsSchema.optional(),
  createdAt: z.string().datetime(),
});

export const updateClipBoundariesSchema = z
  .object({
    startSec: z.number().nonnegative(),
    endSec: z.number().nonnegative(),
  })
  .refine((data) => data.endSec > data.startSec, {
    message: "endSec must be greater than startSec",
  })
  .refine((data) => data.endSec - data.startSec >= 10, {
    message: "Clip must be at least 10 seconds",
  })
  .refine((data) => data.endSec - data.startSec <= 120, {
    message: "Clip must be at most 120 seconds",
  });

export const updateClipTranscriptSliceSchema = z.object({
  transcriptSlice: z.array(transcriptUtteranceSchema),
});

export const updateClipStatusSchema = z.object({
  status: z.enum(["accepted", "rejected"]),
});

export const triggerClipRenderSchema = z.object({
  clipIds: z.array(z.string().uuid()).min(1).max(50).optional(),
  aspectRatios: z.array(clipAspectRatioSchema).min(1).max(4).optional(),
});

export const clipDownloadQuerySchema = z.object({
  aspectRatio: clipAspectRatioSchema.optional(),
});

// Snake_case shape matching the raw LLM/JSON-schema layer (CLIP_DETECTION_JSON_SCHEMA
// in apps/worker/src/tasks/detect-clips.ts uses at_sec/query/reason), which is
// NOT the same shape as brollCuesArraySchema (camelCase atSec) below —
// normalizeLlmClip maps at_sec -> atSec once parsed, producing the canonical
// camelCase BrollCue shape used everywhere past this LLM response boundary.
// Deliberately lenient (no upper bound on string length or array size) beyond
// what OpenAI's strict-mode JSON schema requires: brollCuesArraySchema already
// re-validates the normalized cues downstream (apps/worker/src/tasks/render-clips.ts)
// and degrades gracefully to the keyword-derived query on failure, so this layer
// should never be the reason a whole clip gets dropped over an oversized B-roll field.
const clipDetectionBrollCueSchema = z.object({
  at_sec: z.number().min(0),
  query: z.string().trim().min(1),
  reason: z.string().trim().min(1),
});

export const clipDetectionLlmResponseSchema = z.object({
  clips: z.array(
    z.object({
      title: z.string().min(1),
      start_time: z.number().nonnegative(),
      end_time: z.number().nonnegative(),
      hook_text: z.string().min(1),
      payoff_text: z.string().min(1),
      reasoning: z.string().min(1),
      category: clipCategorySchema,
      platform_fit: z.array(clipPlatformTargetSchema).min(1),
      hook_strength: z.number().int().min(1).max(100),
      emotional_intensity: z.number().int().min(1).max(100),
      story_completeness_score: z.number().int().min(1).max(100),
      // Required (not .optional()) because OpenAI `strict: true` requires every
      // property to be listed in the JSON schema's `required` array — but the
      // array itself is allowed to be empty for a pure talking-head clip.
      broll_cues: z.array(clipDetectionBrollCueSchema),
    }),
  ),
});

export type ClipCategory = z.infer<typeof clipCategorySchema>;
export type ClipStatus = z.infer<typeof clipStatusSchema>;
export type ClipRenderStatus = z.infer<typeof clipRenderStatusSchema>;
export type ClipAspectRatio = z.infer<typeof clipAspectRatioSchema>;
export type ClipAspectRatioDb = z.infer<typeof clipAspectRatioDbSchema>;
export type ClipRenderVariant = z.infer<typeof clipRenderVariantSchema>;
export type ClipSnapshot = z.infer<typeof clipSnapshotSchema>;
export type UpdateClipBoundaries = z.infer<typeof updateClipBoundariesSchema>;
export type UpdateClipStatus = z.infer<typeof updateClipStatusSchema>;
export type TriggerClipRender = z.infer<typeof triggerClipRenderSchema>;
export type ClipDownloadQuery = z.infer<typeof clipDownloadQuerySchema>;
export type ClipDetectionLlmResponse = z.infer<
  typeof clipDetectionLlmResponseSchema
>;
export type UpdateClipCaptionPreset = z.infer<typeof updateClipCaptionPresetSchema>;
export type UpdateClipTranscriptSlice = z.infer<typeof updateClipTranscriptSliceSchema>;
export type UpdateClipBroll = z.infer<typeof updateClipBrollSchema>;
export type BrollSearchQuery = z.infer<typeof brollSearchQuerySchema>;
