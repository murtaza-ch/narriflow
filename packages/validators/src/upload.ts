import { z } from "zod";

export const presignUploadSchema = z.object({
  fileName: z.string().min(1),
  fileSizeBytes: z.number().int().positive(),
  mimeType: z.string().min(1),
  partCount: z.number().int().positive(),
});

export const completeMultipartUploadSchema = z.object({
  uploadId: z.string().min(1),
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
