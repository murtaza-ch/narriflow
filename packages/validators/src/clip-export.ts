import { z } from "zod";
import {
  clipAspectRatioSchema,
  clipRenderResolutionSchema,
  clipRenderStatusSchema,
} from "./clip";

export const clipExportStatusSchema = z.enum([
  "queued",
  "rendering",
  "partial_ready",
  "ready",
  "failed",
]);

/** A user-confirmed, revision-bound export request. The client sends the
 * revision it just flushed; the server rejects a mismatch instead of silently
 * exporting different content. */
export const createClipExportSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  aspectRatios: z.array(clipAspectRatioSchema).min(1).max(4).default(["9:16"]),
  resolution: clipRenderResolutionSchema.default("1080p"),
});

export const createClipShareLinkSchema = z.object({
  expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30)]).nullable().default(7),
});

export const clipExportVariantSnapshotSchema = z.object({
  id: z.string().uuid(),
  aspectRatio: clipAspectRatioSchema,
  resolution: clipRenderResolutionSchema,
  watermark: z.boolean(),
  status: clipRenderStatusSchema,
  sizeBytes: z.number().nullable(),
  durationSec: z.number().nullable(),
  errorCode: z.string().nullable(),
  hasAsset: z.boolean(),
  previewUrl: z.string().url().nullable().optional(),
  downloadUrl: z.string().url().nullable().optional(),
  completedAt: z.string().datetime().nullable(),
});

export const clipExportSnapshotSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  clipId: z.string().uuid(),
  clipTitle: z.string(),
  projectTitle: z.string(),
  editorRevision: z.number().int().nonnegative(),
  currentEditorRevision: z.number().int().nonnegative(),
  isOlderVersion: z.boolean(),
  resolution: clipRenderResolutionSchema,
  watermark: z.boolean(),
  status: clipExportStatusSchema,
  progress: z.number().int().min(0).max(100),
  errorCode: z.string().nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  variants: z.array(clipExportVariantSnapshotSchema),
});

export type ClipExportStatus = z.infer<typeof clipExportStatusSchema>;
export type CreateClipExport = z.infer<typeof createClipExportSchema>;
export type ClipExportSnapshot = z.infer<typeof clipExportSnapshotSchema>;
export type ClipExportVariantSnapshot = z.infer<
  typeof clipExportVariantSnapshotSchema
>;
