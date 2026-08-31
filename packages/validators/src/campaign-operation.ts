import { z } from "zod";
import { clipAspectRatioSchema, clipRenderResolutionSchema } from "./clip";
import { studioTransitionSchema } from "./studio-edits";
import { sceneMotionSchema } from "./timed-edits";
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
  "create_review",
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

/**
 * Applies only the profile already frozen on the Project. A profile id is
 * deliberately absent so Campaign Operations cannot imply that a subset of
 * clips has a different project identity. The fingerprints revision-fence
 * the exact profile/style preview the editor reviewed.
 */
export const applyProjectBrandProfileSelectedSchema = z.strictObject({
  profileFingerprint: campaignFingerprintSchema,
  styleFingerprint: campaignFingerprintSchema.nullable(),
  clips: campaignSelectedClipsSchema,
});

/** A member Brand Template, applied through Studio's caption reducer. */
export const applyStyleSelectedSchema = z.strictObject({
  templateId: z.string().uuid(),
  templateFingerprint: campaignFingerprintSchema,
  clips: campaignSelectedClipsSchema,
});

/** Read-only preflight for the three editor-document campaign actions. */
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

/**
 * The deliberately narrow bulk-motion contract. It composes the same
 * transition and media-motion validators Studio persists; Campaign
 * Operations only chooses which selected documents receive that valid edit.
 * Scene-block motion is not bulk-addressable because block ids are local to
 * each clip, while manual B-roll has one stable target per document.
 */
export const applyMotionSelectedSchema = z.strictObject({
  change: z.discriminatedUnion("scope", [
    z.strictObject({
      scope: z.literal("clip_transition"),
      transition: studioTransitionSchema,
    }),
    z.strictObject({
      scope: z.literal("manual_broll"),
      motion: sceneMotionSchema,
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
