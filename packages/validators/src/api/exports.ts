import { z } from "zod";
import { createClipExportSchema } from "../clip-export";
import { clipAspectRatioDbSchema, clipRenderStatusSchema } from "../clip";
import type { ClipExportSnapshot, ClipExportStatus } from "../clip-export";

// Shared request and response shapes of the exports routes.
export { createExportBundleSchema, type CreateExportBundleInput } from "../campaign-operation";
export { createClipExportSchema, createClipShareLinkSchema } from "../clip-export";
export { timelineFormatSchema, type TimelineFormat } from "../timeline-export";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** `GET /api/workspace/exports`: the Exports page's filters. Dates are inclusive UTC days. */
export const workspaceExportsQuerySchema = z.object({
  status: z.enum(["ready", "processing", "failed"]).optional(),
  q: z.string().trim().max(200).optional(),
  project: z.string().uuid().optional(),
  ratio: clipAspectRatioDbSchema.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  cursor: z.string().min(1).max(1000).optional(),
});

/** `GET /api/workspace/exports/:exportId/download`. */
export const workspaceExportDownloadQuerySchema = z.object({
  variant: z.string().uuid().optional(),
});

/** What a client sends to start an export; the server fills the defaults. */
export type CreateClipExportInput = z.input<typeof createClipExportSchema>;
export type WorkspaceExportsQuery = z.infer<typeof workspaceExportsQuerySchema>;

export interface WorkspaceExportVariant {
  id: string;
  aspectRatio: z.infer<typeof clipAspectRatioDbSchema>;
  status: z.infer<typeof clipRenderStatusSchema>;
  sizeBytes: number | null;
  /** A finished file exists; ask for a Download Grant to fetch it. */
  hasAsset: boolean;
  /** Short-lived playback URL of the finished file (no credentials), or null. */
  previewUrl: string | null;
}

export interface WorkspaceExportItem {
  id: string;
  projectId: string;
  clipId: string;
  status: ClipExportStatus;
  progress: number;
  resolution: string;
  watermark: boolean;
  createdAt: string;
  completedAt: string | null;
  errorCode: string | null;
  project: { title: string };
  clip: { title: string | null; hookText: string };
  variants: WorkspaceExportVariant[];
}

/** `GET /api/workspace/exports`. */
export interface WorkspaceExportPage {
  items: WorkspaceExportItem[];
  nextCursor: string | null;
}

/** `GET /api/workspace/export-projects`. */
export interface WorkspaceExportProjects {
  projects: Array<{ id: string; title: string }>;
}

/** `GET /api/projects/:id/clips/:clipId/exports/:exportId`: the export plus the Project's workflow cursor. */
export type ClipExportDetail = ClipExportSnapshot & { lastSeq: number };

/** A Download Grant for one export file: navigate to `downloadUrl`; it expires at `expiresAt`. */
export interface ExportDownloadGrant {
  exportId: string;
  variantId: string;
  fileName: string;
  sizeBytes: number | null;
  downloadUrl: string;
  expiresAt: string;
}

/** `GET /api/projects/:id/export-bundles/:bundleId/download`. */
export interface ExportBundleDownloadGrant {
  downloadUrl: string;
}
