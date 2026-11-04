import { z } from "zod";
import { contentPackSchema } from "./content-pack";
import { finishingSettingsSchema } from "./finishing";
import { sourceLanguageCodeSchema } from "./language";

// Larger sources use multipart transfer and conditional ranged-read pinning.
export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 ** 3;
export const MAX_SINGLE_UPLOAD_SIZE_BYTES = 5 * 1024 ** 3;
export const MAX_CONDITIONAL_COPY_SIZE_BYTES = 5 * 1024 ** 3 - 5 * 1024 ** 2;
export const MAX_MEDIA_DURATION_SECONDS = 4 * 60 * 60;
export const MAX_UPLOAD_GRANT_TTL_SECONDS = 60 * 60;
/** Allow all outstanding PUT grants to expire before the final exact-key deletion. */
const UPLOAD_SOURCE_CLEANUP_DELAY_MS = (MAX_UPLOAD_GRANT_TTL_SECONDS + 10 * 60) * 1000;
/** A PUT started just before its grant expired can still land. This bounds that
 * late write at a conservative 64 KiB/s, as a cleanup policy rather than a provider deadline. */
export const SINGLE_PUT_CLEANUP_DELAY_MS =
  UPLOAD_SOURCE_CLEANUP_DELAY_MS + Math.ceil(MAX_UPLOAD_SIZE_BYTES / (64 * 1024)) * 1_000;
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

export const uploadMimeTypeByExtension: Readonly<Record<string, (typeof uploadMimeTypes)[number]>> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
};

/** Browsers report the same file differently, or not at all, so an unknown type falls back to the extension. */
export function uploadMimeTypeForFile(file: { name: string; type: string }): UploadMimeType | null {
  if ((uploadMimeTypes as readonly string[]).includes(file.type)) return file.type as UploadMimeType;
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  return uploadMimeTypeByExtension[extension] ?? null;
}

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
    /** Frozen onto the Project at handoff; omitted means true. */
    notifyOnComplete: z.boolean().optional(),
    /** Integrations may name a Recipe instead; admission reads it once. */
    recipeId: z.string().uuid().optional(),
    /** `single` asks for one signed PUT up to 5 GiB. Larger files require
     * multipart. Browsers keep the server's `auto` transfer plan. */
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
