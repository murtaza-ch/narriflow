import { z } from "zod";

/**
 * Music/SFX library (docs/plans/vizard-parity.md "Music/SFX library").
 * Upload + list/finalize contracts for `AudioAsset` — mirrors the shape of
 * `presignBrandLogoSchema`/`presignUploadSchema` (packages/validators/src)
 * but scoped to audio (MP3/WAV/M4A) and capped at 50MB per the plan.
 */

export const AUDIO_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

export const audioUploadContentTypeSchema = z.enum([
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
]);

export type AudioUploadContentType = z.infer<
  typeof audioUploadContentTypeSchema
>;

export const presignAudioUploadSchema = z.object({
  contentType: audioUploadContentTypeSchema,
  sizeBytes: z.number().int().positive().max(AUDIO_UPLOAD_MAX_BYTES),
}).strict();

export type PresignAudioUploadInput = z.infer<typeof presignAudioUploadSchema>;

export const audioAssetKindSchema = z.enum(["music", "sfx"]);
export type AudioAssetKindInput = z.infer<typeof audioAssetKindSchema>;

export const finalizeAudioUploadSchema = z.object({
  key: z.string().min(1).max(512),
  kind: audioAssetKindSchema,
  title: z.string().trim().min(1).max(120),
  durationSec: z.number().min(0).max(60 * 60).default(0),
}).strict();

export type FinalizeAudioUploadInput = z.infer<
  typeof finalizeAudioUploadSchema
>;

export const listAudioAssetsQuerySchema = z.object({
  kind: audioAssetKindSchema,
  mood: z.string().trim().max(40).optional(),
}).strict();

export type ListAudioAssetsQuery = z.infer<typeof listAudioAssetsQuerySchema>;

/**
 * L3 (vizard-parity.md "Music/SFX library"): every `/audio-assets/:id...`
 * route validates the path param against this BEFORE calling into
 * `audioAssetService` — `AudioAsset.id` is a Postgres `uuid` column, and
 * handing Prisma a malformed id throws a raw `PrismaClientValidationError`
 * whose message leaks internal query shape instead of a clean 400.
 */
export const audioAssetIdParamSchema = z.string().uuid();
