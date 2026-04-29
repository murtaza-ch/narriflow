import { z } from "zod";

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

const uploadMimeTypeSchema = z.enum(uploadMimeTypes);

export const presignUploadSchema = z.object({
  projectId: z.string().uuid().optional(),
  uploadId: z.string().uuid().optional(),
  title: z.string().min(1).max(200),
  fileName: z.string().min(1),
  fileSizeBytes: z.number().int().positive().max(MAX_UPLOAD_SIZE_BYTES),
  mimeType: uploadMimeTypeSchema,
  partCount: z.number().int().positive().max(10_000),
  brandTemplateId: z.string().uuid().nullable().optional(),
});

export const completeMultipartUploadSchema = z.object({
  projectId: z.string().uuid(),
  uploadId: z.string().uuid(),
  key: z.string().min(1),
  etags: z.array(
    z.object({
      partNumber: z.number().int().positive(),
      etag: z.string().min(1),
    }),
  ),
});

export type PresignUploadInput = z.infer<typeof presignUploadSchema>;
export type CompleteMultipartUploadInput = z.infer<typeof completeMultipartUploadSchema>;
export type UploadMimeType = z.infer<typeof uploadMimeTypeSchema>;
