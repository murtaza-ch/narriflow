import { z } from "zod";
import { clipAspectRatioSchema } from "./clip";

export const dubStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
]);

export const dubVoiceSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[a-z][a-z0-9_-]*$/i);

export const dubLanguageCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(16)
  .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i)
  .transform((value) => value.toLowerCase());

export const requestClipDubSchema = z.object({
  clipId: z.string().uuid(),
  aspectRatio: clipAspectRatioSchema.default("9:16"),
  targetLanguageCode: dubLanguageCodeSchema,
  voice: dubVoiceSchema.default("marin"),
});

export const clipDubSnapshotSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  clipId: z.string().uuid(),
  aspectRatio: clipAspectRatioSchema,
  targetLanguageCode: z.string(),
  voice: z.string(),
  provider: z.string(),
  model: z.string(),
  status: dubStatusSchema,
  transcriptText: z.string().nullable(),
  translatedText: z.string().nullable(),
  hasAudioAsset: z.boolean(),
  hasVideoAsset: z.boolean(),
  audioSizeBytes: z.number().nullable(),
  renderSizeBytes: z.number().nullable(),
  durationSec: z.number().nullable(),
  errorCode: z.string().nullable(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const dubDownloadQuerySchema = z.object({
  asset: z.enum(["video", "audio"]).default("video"),
});

export type DubStatus = z.infer<typeof dubStatusSchema>;
export type RequestClipDubInput = z.infer<typeof requestClipDubSchema>;
export type ClipDubSnapshot = z.infer<typeof clipDubSnapshotSchema>;
export type DubDownloadQuery = z.infer<typeof dubDownloadQuerySchema>;
