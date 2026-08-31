import { z } from "zod";

import {
  applyMotionSelectedSchema,
  applyProjectBrandProfileSelectedSchema,
  applyStyleSelectedSchema,
  campaignOperationActionSchema,
  campaignOperationItemStatusSchema,
  previewCampaignEditorActionSchema,
} from "./campaign-operation";
import { brandProfileListSchema } from "./brand-profile";
import {
  generatedMediaAutomationSubmitSchema,
  generatedMediaAspectRatioSchema,
  generatedMediaJobStatusSchema,
  generatedMediaKindSchema,
  generatedMediaStyleSchema,
} from "./generated-media";
import {
  bulkScheduleAutomationSchema,
  generateAssistedCopySchema,
  requestThumbnailExtractionSchema,
} from "./publishing-preparation";
import {
  createReviewRoundAutomationSchema,
  reviewNotificationKindSchema,
} from "./review";
import { applySceneTemplateSchema } from "./scene-template";
import { socialPlatformSchema } from "./social";

export const businessAutomationUuidSchema = z.string().uuid();

export const businessAutomationWorkspaceInputSchema = z.strictObject({
  workspaceId: businessAutomationUuidSchema.optional().describe(
    "Narriflow workspace ID. Omit to use the personal workspace with OAuth or the key-bound workspace with an API key.",
  ),
});
const workspaceInputShape = businessAutomationWorkspaceInputSchema.shape;

export const businessAutomationListBrandProfilesInputSchema =
  brandProfileListSchema.extend(workspaceInputShape);
export const businessAutomationGetBrandProfileInputSchema = z.strictObject({
  ...workspaceInputShape,
  profileId: businessAutomationUuidSchema,
});
export const businessAutomationProjectInputSchema = z.strictObject({
  ...workspaceInputShape,
  projectId: businessAutomationUuidSchema,
});
export const businessAutomationApplyMotionInputSchema =
  applyMotionSelectedSchema.extend({
    ...workspaceInputShape,
    projectId: businessAutomationUuidSchema,
    idempotencyKey: businessAutomationUuidSchema,
  });
export const businessAutomationPreviewCampaignInputSchema =
  z.strictObject({
    ...workspaceInputShape,
    projectId: businessAutomationUuidSchema,
    request: previewCampaignEditorActionSchema,
  });
export const businessAutomationApplyBrandInputSchema =
  applyProjectBrandProfileSelectedSchema.extend({
    ...workspaceInputShape,
    projectId: businessAutomationUuidSchema,
    idempotencyKey: businessAutomationUuidSchema,
  });
export const businessAutomationApplyStyleInputSchema =
  applyStyleSelectedSchema.extend({
    ...workspaceInputShape,
    projectId: businessAutomationUuidSchema,
    idempotencyKey: businessAutomationUuidSchema,
  });
export const businessAutomationApplySceneInputSchema =
  applySceneTemplateSchema.safeExtend({
    ...workspaceInputShape,
    projectId: businessAutomationUuidSchema,
    profileId: businessAutomationUuidSchema,
    templateId: businessAutomationUuidSchema,
    idempotencyKey: businessAutomationUuidSchema,
  });
export const businessAutomationCreateReviewInputSchema =
  createReviewRoundAutomationSchema.extend({
    ...workspaceInputShape,
    projectId: businessAutomationUuidSchema,
  });
export const businessAutomationGenerateAssistedCopyInputSchema =
  generateAssistedCopySchema.extend({
    ...workspaceInputShape,
    projectId: businessAutomationUuidSchema,
  });
export const businessAutomationGetAssistedCopyInputSchema = z.strictObject({
  ...workspaceInputShape,
  projectId: businessAutomationUuidSchema,
  draftId: businessAutomationUuidSchema,
});
export const businessAutomationRequestThumbnailInputSchema =
  requestThumbnailExtractionSchema.extend({
    ...workspaceInputShape,
    projectId: businessAutomationUuidSchema,
  });
export const businessAutomationGetThumbnailInputSchema = z.strictObject({
  ...workspaceInputShape,
  projectId: businessAutomationUuidSchema,
  jobId: businessAutomationUuidSchema,
});
export const businessAutomationBulkScheduleInputSchema =
  bulkScheduleAutomationSchema.extend({
    ...workspaceInputShape,
    projectId: businessAutomationUuidSchema,
  });
export const businessAutomationSubmitGeneratedMediaInputSchema =
  generatedMediaAutomationSubmitSchema.safeExtend(workspaceInputShape);
export const businessAutomationGetGeneratedMediaInputSchema = z.strictObject({
  ...workspaceInputShape,
  jobId: businessAutomationUuidSchema,
});

export const businessAutomationDataOutputSchema = z.object({ data: z.unknown() });

export const businessAutomationCampaignOperationStatusSchema = z.object({
  operationId: businessAutomationUuidSchema,
  action: campaignOperationActionSchema,
  status: z.enum(["queued", "running", "completed", "partial", "failed", "cancelled"]),
  requestedCount: z.number().int().nonnegative(),
  counts: z.object({
    succeeded: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
    ineligible: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  items: z.array(z.object({
    clipId: businessAutomationUuidSchema,
    expectedEditorRevision: z.number().int().nonnegative().nullable(),
    status: campaignOperationItemStatusSchema,
    errorCode: z.string().nullable(),
    settledAt: z.string().datetime().nullable(),
  })),
  createdAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  replayed: z.boolean(),
});

export const businessAutomationCampaignOperationOutputSchema = z.object({
  data: businessAutomationCampaignOperationStatusSchema,
});
export const businessAutomationCampaignOperationListOutputSchema = z.object({
  data: z.array(businessAutomationCampaignOperationStatusSchema),
});
export const businessAutomationCampaignPreviewSchema = z.object({
		action: z.enum([
			"apply_brand_profile",
			"apply_style",
      "apply_scene_template",
		]),
    requestedCount: z.number().int().nonnegative(),
    counts: z.object({
      eligible: z.number().int().nonnegative(),
      unchanged: z.number().int().nonnegative(),
      stale: z.number().int().nonnegative(),
      ineligible: z.number().int().nonnegative(),
    }),
    items: z.array(z.object({
      clipId: businessAutomationUuidSchema,
      expectedEditorRevision: z.number().int().nonnegative(),
      currentEditorRevision: z.number().int().nonnegative().nullable(),
      status: z.enum(["eligible", "unchanged", "stale", "ineligible"]),
			code: z.string().nullable(),
		})),
});
export const businessAutomationCampaignPreviewOutputSchema = z.object({
	data: businessAutomationCampaignPreviewSchema,
});

const reviewDecisionSchema = z.enum(["approved", "changes_requested"]);
export const businessAutomationReviewRoundStatusSchema = z.object({
  roundId: businessAutomationUuidSchema,
  revision: z.number().int().nonnegative(),
  status: z.enum([
    "open",
    "approved",
    "changes_requested",
    "superseded",
    "revoked",
    "expired",
  ]),
  approvalRequired: z.boolean(),
  allowDownloads: z.boolean(),
  sentAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  supersededAt: z.string().datetime().nullable(),
  decision: reviewDecisionSchema.nullable(),
  decidedAt: z.string().datetime().nullable(),
  newerWorkAvailable: z.boolean(),
  items: z.array(z.object({
    itemId: businessAutomationUuidSchema,
    clipId: businessAutomationUuidSchema,
    exportId: businessAutomationUuidSchema,
    editorRevision: z.number().int().nonnegative(),
    required: z.boolean(),
    currentDecision: reviewDecisionSchema.nullable(),
    newerWorkAvailable: z.boolean(),
  })),
  notificationStatus: z.array(z.object({
    kind: reviewNotificationKindSchema,
    status: z.enum(["pending", "claimed", "sent", "failed"]),
    attemptCount: z.number().int().nonnegative(),
    failureCode: z.string().nullable(),
    sentAt: z.string().datetime().nullable(),
  })),
  createdAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime().nullable(),
});

export const businessAutomationReviewRoundListSchema = z.object({
		projectId: businessAutomationUuidSchema,
		rounds: z.array(businessAutomationReviewRoundStatusSchema),
});
export const businessAutomationReviewRoundListOutputSchema = z.object({
	data: businessAutomationReviewRoundListSchema,
});

export const businessAutomationAssistedCopyContentSchema = z.strictObject({
  caption: z.string().min(1).max(5_000),
  hashtags: z.array(z.string().min(1).max(100)).max(30),
  title: z.string().min(1).max(300).nullable(),
});

export const businessAutomationAssistedCopyStatusSchema = z.object({
  draftId: businessAutomationUuidSchema,
  clipId: businessAutomationUuidSchema,
  platform: socialPlatformSchema,
  status: z.enum(["generating", "completed", "rejected", "failed", "unknown"]),
  revision: z.number().int().nonnegative(),
  content: businessAutomationAssistedCopyContentSchema.nullable(),
  confirmed: z.boolean(),
  moderationOutcome: z.enum(["pending", "accepted", "rejected", "unknown"]),
  modelAlias: z.string().nullable(),
  promptVersion: z.string().nullable(),
  guidanceSkipped: z.boolean(),
  errorCode: z.string().nullable(),
  replayed: z.boolean(),
});

export const businessAutomationThumbnailAssetSchema = z.object({
  id: businessAutomationUuidSchema,
  title: z.string().min(1).max(160),
  kind: z.literal("image"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sizeBytes: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export const businessAutomationThumbnailStatusSchema = z.object({
  jobId: businessAutomationUuidSchema,
  status: z.enum(["queued", "processing", "completed", "failed"]),
  attempts: z.number().int().nonnegative(),
  platform: socialPlatformSchema,
  exportVariantId: businessAutomationUuidSchema,
  sourceTimeMs: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  asset: businessAutomationThumbnailAssetSchema.nullable(),
  replayed: z.boolean(),
});

export const businessAutomationGeneratedMediaStatusSchema = z.object({
  jobId: businessAutomationUuidSchema,
  projectId: businessAutomationUuidSchema,
  clipId: businessAutomationUuidSchema.nullable(),
  kind: generatedMediaKindSchema,
  status: generatedMediaJobStatusSchema,
  aspectRatio: generatedMediaAspectRatioSchema,
  style: generatedMediaStyleSchema,
  durationSec: z.number().nonnegative().nullable(),
  resultAssetId: businessAutomationUuidSchema.nullable(),
  insertionCount: z.number().int().nonnegative(),
  lastInsertionKind: z.enum(["broll", "scene_block"]).nullable(),
  lastInsertedAt: z.string().datetime().nullable(),
  errorCode: z.string().nullable(),
  moderationOutcome: z.enum(["pending", "passed", "rejected", "unknown"]),
  createdAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime().nullable(),
  replayed: z.boolean(),
});

export const businessAutomationReviewRoundCreatedSchema = z.object({
		roundId: businessAutomationUuidSchema,
		revision: z.number().int().nonnegative(),
		createdAt: z.string().datetime().nullable(),
		replayed: z.boolean(),
});
export const businessAutomationReviewRoundCreatedOutputSchema = z.object({
	data: businessAutomationReviewRoundCreatedSchema,
});
export const businessAutomationAssistedCopyOutputSchema = z.object({
  data: businessAutomationAssistedCopyStatusSchema,
});
export const businessAutomationThumbnailOutputSchema = z.object({
  data: businessAutomationThumbnailStatusSchema,
});
export const businessAutomationGeneratedMediaOutputSchema = z.object({
  data: businessAutomationGeneratedMediaStatusSchema,
});
export const businessAutomationBulkScheduleStatusSchema = z.object({
		operationId: businessAutomationUuidSchema,
		status: z.enum(["completed", "partial", "failed"]),
    counts: z.object({
      scheduled: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
    items: z.array(z.object({
      itemKey: businessAutomationUuidSchema,
      clipId: businessAutomationUuidSchema,
      accountId: businessAutomationUuidSchema,
      status: z.enum(["scheduled", "failed"]),
      postId: businessAutomationUuidSchema.nullable(),
      scheduledFor: z.string().datetime().nullable(),
      errorCode: z.string().nullable(),
		})),
		replayed: z.boolean(),
});
export const businessAutomationBulkScheduleOutputSchema = z.object({
	data: businessAutomationBulkScheduleStatusSchema,
});
