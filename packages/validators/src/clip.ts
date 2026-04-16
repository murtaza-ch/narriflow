import { z } from "zod";
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

export const captionAnimationSchema = z.enum([
  "none", "word-by-word", "karaoke", "bounce",
  "blur-in", "grow", "breathe", "soft-landing", "glitch", "seamless-bounce",
]);

export type CaptionAnimation = z.infer<typeof captionAnimationSchema>;

export const captionPresetSchema = z.object({
  fontName: z.string().max(100).default("Bebas Neue"),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#FFFFFF"),
  outlineColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#000000"),
  outlineWidth: z.number().int().min(0).max(4).default(2),
  shadow: z.number().int().min(0).max(1).default(1),
  bold: z.boolean().default(true),
  position: z.enum(["bottom", "top", "center"]).default("bottom"),
  highlightColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#00FF88"),
  animation: captionAnimationSchema.default("word-by-word"),
  fontSize: z.number().min(8).max(120).default(36),
  positionX: z.number().min(0).max(100).optional(),
  positionY: z.number().min(0).max(100).optional(),

  // Backdrop behind all caption text
  backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  backgroundOpacity: z.number().min(0).max(1).optional(),

  // Colored box behind the active word
  highlightBoxColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  highlightBoxOpacity: z.number().min(0).max(1).optional(),

  // Glow effect
  glowColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  glowIntensity: z.number().min(0).max(20).optional(),

  // Text styling
  textTransform: z.enum(["uppercase", "lowercase", "capitalize", "none"]).optional(),
  letterSpacing: z.number().min(-0.1).max(0.5).optional(),
});

export const updateClipCaptionPresetSchema = z.object({
  captionPreset: captionPresetSchema.nullable(),
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
  hookText: z.string().min(1),
  reasoning: z.string().min(1),
  category: clipCategorySchema,
  viralityScore: z.number().int().min(1).max(100),
  hookStrengthScore: z.number().int().min(1).max(100),
  emotionalIntensityScore: z.number().int().min(1).max(100),
  pacingScore: z.number().int().min(1).max(100),
  durationOptimalityScore: z.number().int().min(1).max(100),
  tiktokScore: z.number().int().min(1).max(100),
  youtubeScore: z.number().int().min(1).max(100),
  instagramScore: z.number().int().min(1).max(100),
  transcriptSlice: z.array(transcriptUtteranceSchema),
  renderVariants: z.array(clipRenderVariantSchema),
  captionPreset: captionPresetSchema.nullable().optional(),
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

export const clipDetectionLlmResponseSchema = z.object({
  clips: z.array(
    z.object({
      start_time: z.number().nonnegative(),
      end_time: z.number().nonnegative(),
      hook_text: z.string().min(1),
      reasoning: z.string().min(1),
      category: clipCategorySchema,
      hook_strength: z.number().int().min(1).max(100),
      emotional_intensity: z.number().int().min(1).max(100),
    }),
  ),
});

export type ClipCategory = z.infer<typeof clipCategorySchema>;
export type ClipStatus = z.infer<typeof clipStatusSchema>;
export type ClipRenderStatus = z.infer<typeof clipRenderStatusSchema>;
export type ClipAspectRatio = z.infer<typeof clipAspectRatioSchema>;
export type ClipAspectRatioDb = z.infer<typeof clipAspectRatioDbSchema>;
export type CaptionPreset = z.infer<typeof captionPresetSchema>;
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
