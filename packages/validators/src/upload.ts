import { z } from "zod";
import { contentPackSchema } from "./content-pack";
import { sourceLanguageCodeSchema } from "./language";

export const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_MEDIA_DURATION_SECONDS = 4 * 60 * 60;
export const uploadMimeTypes = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/aac",
] as const;

export const uploadMimeTypeSchema = z.enum(uploadMimeTypes);

const uploadGenerationContextSchema = z
  .object({
    contentPack: contentPackSchema,
    languageCode: sourceLanguageCodeSchema,
  })
  .strict();

export const openUploadSessionSchema = z
  .object({
    clientIdempotencyKey: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    source: z
      .object({
        fileName: z.string().trim().min(1).max(500),
        sizeBytes: z.number().int().positive().max(MAX_UPLOAD_SIZE_BYTES),
        contentType: uploadMimeTypeSchema,
        browserFingerprint: z.string().min(1).max(2_048),
      })
      .strict(),
    brandTemplateId: z.string().uuid().nullable().optional(),
    generationContext: uploadGenerationContextSchema,
  })
  .strict();

export const finalizeUploadSessionSchema = z
  .object({
    sessionId: z.string().uuid(),
    parts: z
      .array(
        z
          .object({
            partNumber: z.number().int().positive(),
            etag: z.string().trim().min(1).max(1_024),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict();

export type UploadMimeType = z.infer<typeof uploadMimeTypeSchema>;
export type OpenUploadSessionInput = z.infer<typeof openUploadSessionSchema>;
export type FinalizeUploadSessionInput = z.infer<
  typeof finalizeUploadSessionSchema
>;
