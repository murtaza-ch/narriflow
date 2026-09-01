import { z } from "zod";
import { clipAspectRatioSchema, clipRenderResolutionSchema } from "./clip";
import { studioTransitionSchema } from "./studio-edits";
import {
  mediaMotionEntranceSchema,
  mediaMotionExitSchema,
} from "./timed-edits";
import { applySceneTemplateSchema } from "./scene-template";

// The worker materializes every input plus the ZIP on one volume, and R2's
// single-part publication copy is limited to 5 GiB. Four GiB leaves room for
// the manifest and ZIP metadata while keeping disk use predictable.
export const MAX_EXPORT_BUNDLE_INPUT_BYTES = 4 * 1024 * 1024 * 1024;

export const campaignOperationActionSchema = z.enum([
  "render_selected",
  "export_bundle",
  "schedule_selected",
  "apply_brand_profile",
  "apply_style",
  "apply_scene_template",
  "apply_motion",
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

const campaignFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const campaignSelectedClipsSchema = z
  .array(
    z.strictObject({
      clipId: z.string().uuid(),
      expectedEditorRevision: z.number().int().nonnegative(),
    }),
  )
  .min(1)
  .max(100)
  .superRefine((clips, context) => {
    if (new Set(clips.map((clip) => clip.clipId)).size !== clips.length) {
      context.addIssue({
        code: "custom",
        message: "A clip can appear only once",
      });
    }
  });

export const applyProjectBrandProfileSelectedSchema = z.strictObject({
  profileFingerprint: campaignFingerprintSchema,
  styleFingerprint: campaignFingerprintSchema.nullable(),
  clips: campaignSelectedClipsSchema,
});

export const applyStyleSelectedSchema = z.strictObject({
  templateId: z.string().uuid(),
  templateFingerprint: campaignFingerprintSchema,
  clips: campaignSelectedClipsSchema,
});

export const previewCampaignEditorActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("apply_brand_profile"),
    input: applyProjectBrandProfileSelectedSchema,
  }),
  z.strictObject({
    action: z.literal("apply_style"),
    input: applyStyleSelectedSchema,
  }),
  z.strictObject({
    action: z.literal("apply_scene_template"),
    profileId: z.string().uuid(),
    templateId: z.string().uuid(),
    input: applySceneTemplateSchema,
  }),
]);

export const applyMotionSelectedSchema = z.strictObject({
  change: z.discriminatedUnion("scope", [
    z.strictObject({
      scope: z.literal("clip_transition"),
      transition: studioTransitionSchema,
    }),
    z.strictObject({
      scope: z.literal("manual_broll"),
      motion: z.strictObject({
        entrance: mediaMotionEntranceSchema,
        exit: mediaMotionExitSchema,
      }),
    }),
  ]),
  clips: campaignSelectedClipsSchema,
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
export type ApplyMotionSelectedInput = z.infer<typeof applyMotionSelectedSchema>;
export type ApplyProjectBrandProfileSelectedInput = z.infer<
  typeof applyProjectBrandProfileSelectedSchema
>;
export type ApplyStyleSelectedInput = z.infer<typeof applyStyleSelectedSchema>;
export type PreviewCampaignEditorActionInput = z.infer<
  typeof previewCampaignEditorActionSchema
>;
