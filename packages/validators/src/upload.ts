import { z } from "zod";
import { contentPackSchema } from "./content-pack";
import { finishingSettingsSchema } from "./finishing";
import { sourceLanguageCodeSchema } from "./language";

// Uploaded sources are pinned with one conditional server-side copy before
// ingest probes them. R2 caps a single copy at 5 GiB minus 5 MiB.
export const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024 * 1024 - 5 * 1024 * 1024;
export const MAX_MEDIA_DURATION_SECONDS = 4 * 60 * 60;
export const MAX_UPLOAD_GRANT_TTL_SECONDS = 60 * 60;
/** Allow all outstanding PUT grants to expire before the final exact-key deletion. */
export const UPLOAD_SOURCE_CLEANUP_DELAY_MS = (MAX_UPLOAD_GRANT_TTL_SECONDS + 10 * 60) * 1000;
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
    finishing: finishingSettingsSchema.optional(),
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
    brandProfileId: z.string().uuid().nullable().optional(),
    /** Explicit settings, which browser intake always sends. */
    generationContext: uploadGenerationContextSchema.optional(),
    /** Integrations may name a Recipe instead; admission reads it once. */
    recipeId: z.string().uuid().optional(),
    /** `single` asks for one signed PUT at any supported size, for machine
     * callers that can't orchestrate multipart parts. Browsers keep `auto`. */
    transfer: z.enum(["auto", "single"]).optional(),
    /** Browser media metadata. Reserved at admission, never trusted to settle. */
    declaredDurationSeconds: z
      .number()
      .positive()
      .max(7 * 24 * 60 * 60)
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.recipeId === undefined) {
      if (input.generationContext === undefined) {
        context.addIssue({ code: "custom", path: ["generationContext"], message: "Send generationContext or a recipeId" });
      }
      return;
    }
    for (const field of ["generationContext", "brandProfileId", "brandTemplateId"] as const) {
      if (input[field] !== undefined) {
        context.addIssue({ code: "custom", path: [field], message: "A Recipe replaces the Brand Profile and generation settings. Send recipeId or those, not both" });
      }
    }
  });

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

export const uploadCompletionIntentSchema = z
  .object({
    version: z.literal(1),
    parts: finalizeUploadSessionSchema.shape.parts,
  })
  .strict();

export const grantUploadPartsSchema = z
  .object({
    sessionId: z.string().uuid(),
    partNumbers: z.array(z.number().int().positive()).min(1).max(16),
  })
  .strict()
  .refine((value) => new Set(value.partNumbers).size === value.partNumbers.length, {
    message: "Part numbers must be unique",
    path: ["partNumbers"],
  });

export const readUploadSessionSchema = z
  .object({
    clientIdempotencyKey: z.string().uuid(),
    sessionId: z.string().uuid().nullable(),
    browserFingerprint: z.string().min(1).max(2_048),
  })
  .strict();

export const discardUploadSessionSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();

export type UploadMimeType = z.infer<typeof uploadMimeTypeSchema>;
export type OpenUploadSessionInput = z.infer<typeof openUploadSessionSchema>;
export type FinalizeUploadSessionInput = z.infer<
  typeof finalizeUploadSessionSchema
>;
export type UploadCompletionIntent = z.infer<
  typeof uploadCompletionIntentSchema
>;
export type GrantUploadPartsInput = z.infer<typeof grantUploadPartsSchema>;
export type ReadUploadSessionInput = z.infer<typeof readUploadSessionSchema>;
export type DiscardUploadSessionInput = z.infer<
  typeof discardUploadSessionSchema
>;
