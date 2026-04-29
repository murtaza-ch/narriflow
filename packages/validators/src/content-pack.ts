import { z } from "zod";
import { outputTypeSchema } from "./output-type";

export const clipGenerationModeSchema = z.enum(["best"]);

export const clipPlatformTargetSchema = z.enum([
  "tiktok",
  "youtube_shorts",
  "instagram_reels",
]);

export const generationModeSchema = z.enum(["clip", "caption_only"]);

export const clipLengthPresetSchema = z.enum([
  "auto",
  "under_30s",
  "30_to_60s",
  "60_to_120s",
  "120_to_180s",
]);

export const contentPackSchema = z.object({
  outputTypes: z.array(outputTypeSchema).min(1),
  clipGenerationMode: clipGenerationModeSchema.default("best"),
  clipCountTarget: z.number().int().min(3).max(30),
  clipDurationSecTarget: z.number().int().min(15).max(120),
  minDurationSec: z.number().int().min(5).max(120).default(15),
  preferredMinDurationSec: z.number().int().min(5).max(120).default(30),
  preferredMaxDurationSec: z.number().int().min(5).max(180).default(60),
  maxDurationSec: z.number().int().min(10).max(180).default(90),
  platformTargets: z
    .array(clipPlatformTargetSchema)
    .min(1)
    .default(["tiktok", "youtube_shorts", "instagram_reels"]),
  autoRenderClips: z.boolean().default(false),
  toneConstraints: z.array(z.string()).default([]),
  captionPreset: z.string().min(1),
  platformPlaybookVersion: z.string().min(1),
  mode: generationModeSchema.default("clip"),
  autoHook: z.boolean().default(true),
  specificMoments: z.string().max(500).default(""),
  processingStartSec: z.number().int().min(0).nullable().default(null),
  processingEndSec: z.number().int().min(0).nullable().default(null),
  clipLengthPreset: clipLengthPresetSchema.default("auto"),
}).superRefine((data, ctx) => {
  if (data.minDurationSec > data.preferredMinDurationSec) {
    ctx.addIssue({
      code: "custom",
      path: ["minDurationSec"],
      message: "minDurationSec must be less than or equal to preferredMinDurationSec",
    });
  }

  if (data.preferredMinDurationSec > data.preferredMaxDurationSec) {
    ctx.addIssue({
      code: "custom",
      path: ["preferredMinDurationSec"],
      message: "preferredMinDurationSec must be less than or equal to preferredMaxDurationSec",
    });
  }

  if (data.preferredMaxDurationSec > data.maxDurationSec) {
    ctx.addIssue({
      code: "custom",
      path: ["preferredMaxDurationSec"],
      message: "preferredMaxDurationSec must be less than or equal to maxDurationSec",
    });
  }

  if (data.clipDurationSecTarget < data.minDurationSec || data.clipDurationSecTarget > data.maxDurationSec) {
    ctx.addIssue({
      code: "custom",
      path: ["clipDurationSecTarget"],
      message: "clipDurationSecTarget must be inside the hard duration range",
    });
  }

  if (
    data.processingStartSec !== null &&
    data.processingEndSec !== null &&
    data.processingStartSec >= data.processingEndSec
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["processingEndSec"],
      message: "processingEndSec must be greater than processingStartSec",
    });
  }
});

export type ContentPack = z.infer<typeof contentPackSchema>;
export type ClipGenerationMode = z.infer<typeof clipGenerationModeSchema>;
export type ClipPlatformTarget = z.infer<typeof clipPlatformTargetSchema>;
export type GenerationMode = z.infer<typeof generationModeSchema>;
export type ClipLengthPreset = z.infer<typeof clipLengthPresetSchema>;

export const clipLengthPresetRanges: Record<
  ClipLengthPreset,
  {
    clipDurationSecTarget: number;
    minDurationSec: number;
    preferredMinDurationSec: number;
    preferredMaxDurationSec: number;
    maxDurationSec: number;
  }
> = {
  auto: {
    clipDurationSecTarget: 45,
    minDurationSec: 15,
    preferredMinDurationSec: 30,
    preferredMaxDurationSec: 60,
    maxDurationSec: 90,
  },
  under_30s: {
    clipDurationSecTarget: 25,
    minDurationSec: 10,
    preferredMinDurationSec: 15,
    preferredMaxDurationSec: 30,
    maxDurationSec: 35,
  },
  "30_to_60s": {
    clipDurationSecTarget: 45,
    minDurationSec: 25,
    preferredMinDurationSec: 30,
    preferredMaxDurationSec: 60,
    maxDurationSec: 70,
  },
  "60_to_120s": {
    clipDurationSecTarget: 90,
    minDurationSec: 55,
    preferredMinDurationSec: 60,
    preferredMaxDurationSec: 120,
    maxDurationSec: 130,
  },
  "120_to_180s": {
    clipDurationSecTarget: 150,
    minDurationSec: 115,
    preferredMinDurationSec: 120,
    preferredMaxDurationSec: 180,
    maxDurationSec: 180,
  },
};
