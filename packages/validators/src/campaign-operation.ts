import { z } from "zod";
import { clipAspectRatioSchema, clipRenderResolutionSchema } from "./clip";

// The worker materializes every input plus the ZIP on one volume, and R2's
// single-part publication copy is limited to 5 GiB. Four GiB leaves room for
// the manifest and ZIP metadata while keeping disk use predictable.
export const MAX_EXPORT_BUNDLE_INPUT_BYTES = 4 * 1024 * 1024 * 1024;

export const campaignOperationActionSchema = z.enum([
  "render_selected",
  "export_bundle",
  "schedule_selected",
  "apply_brand_profile",
  "apply_scene_template",
]);

export const campaignOperationItemStatusSchema = z.enum([
  "pending",
  "processing",
  "succeeded",
  "unchanged",
  "stale",
  "ineligible",
  "failed",
]);

export const createExportBundleSchema = z.strictObject({
  clips: z.array(z.strictObject({
    clipId: z.string().uuid(),
    expectedEditorRevision: z.number().int().nonnegative(),
  })).min(1).max(100),
  aspectRatios: z.array(clipAspectRatioSchema).min(1).max(4),
  resolution: clipRenderResolutionSchema,
});

export const exportBundleManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: z.string().uuid(),
  projectId: z.string().uuid(),
  createdAt: z.string().datetime(),
  included: z.array(z.strictObject({
    clipId: z.string().uuid(),
    exportId: z.string().uuid(),
    editorRevision: z.number().int().nonnegative(),
    files: z.array(z.strictObject({
      variantId: z.string().uuid(),
      aspectRatio: clipAspectRatioSchema,
			name: z.string().min(1).max(240).regex(/^project\/[0-9]{3}-[a-z0-9][a-z0-9.-]*\/[0-9]+x[0-9]+\.mp4$/),
      sizeBytes: z.number().int().positive().max(MAX_EXPORT_BUNDLE_INPUT_BYTES),
    })),
  })),
  excluded: z.array(z.strictObject({ clipId: z.string().uuid(), code: z.string().min(1).max(100) })),
}).superRefine((manifest, context) => {
  const total = manifest.included.reduce(
    (bundleTotal, item) => bundleTotal + item.files.reduce((itemTotal, file) => itemTotal + file.sizeBytes, 0),
    0,
  );
  if (total > MAX_EXPORT_BUNDLE_INPUT_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["included"],
      message: "export bundle exceeds the maximum aggregate input size",
    });
  }
});

export type ExportBundleManifest = z.infer<typeof exportBundleManifestSchema>;
export type CreateExportBundleInput = z.infer<typeof createExportBundleSchema>;
