import { z } from "zod";
import { outputTypeSchema } from "./output-type";

export const clipGenerationModeSchema = z.enum(["best"]);

export const clipPlatformTargetSchema = z.enum([
  "tiktok",
  "youtube_shorts",
  "instagram_reels",
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
});

export type ContentPack = z.infer<typeof contentPackSchema>;
export type ClipGenerationMode = z.infer<typeof clipGenerationModeSchema>;
export type ClipPlatformTarget = z.infer<typeof clipPlatformTargetSchema>;
