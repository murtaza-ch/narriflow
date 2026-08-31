import { z } from "zod";
import { socialPlatformSchema } from "./social";

export const analyticsEventTypeSchema = z.enum([
  "render_completed",
  "download_opened",
  "social_scheduled",
  "social_cancelled",
  "social_posted",
  "social_failed",
  "dub_completed",
  "dub_download_opened",
  "clips_ready",
  "campaign_operation_started",
  "campaign_operation_completed",
  "review_sent",
  "review_opened",
  "review_changes_requested",
  "campaign_approved",
  "campaign_scheduled",
  "generated_asset_completed",
  "generated_asset_inserted",
  "assisted_copy_generated",
  "assisted_copy_confirmed",
  "thumbnail_prepared",
  "brand_profile_created",
  "brand_profile_applied",
  "visual_asset_upload_succeeded",
  "visual_asset_upload_failed",
  "brand_font_upload_succeeded",
  "brand_font_upload_failed",
  "scene_template_used",
  "brand_premium_mutation_blocked",
]);

const SENSITIVE_ANALYTICS_KEY =
  /(transcript|prompt|comment|reviewer(?:email|identity)?|token|passcode|signed.?url)/i;

const ALLOWED_ANALYTICS_METADATA_KEYS = new Set([
  "aspectRatio",
  "asset",
  "assetId",
  "assetKind",
  "approvalOverrides",
  "campaignOperationId",
  "durationBucket",
  "featureVersion",
  "fontId",
  "generatedMediaJobId",
  "guardrails",
  "insertionAction",
  "kind",
  "languageCode",
  "latencyBucket",
  "modelAlias",
  "moderationOutcome",
  "outcome",
  "planTier",
  "platform",
  "providerAlias",
  "profileId",
  "projectId",
  "requestedCount",
  "retryCount",
  "revisionCount",
  "reviewRoundId",
  "sceneTemplateId",
  "scheduledCount",
  "selectedCount",
  "status",
  "staleCount",
  "succeededCount",
  "templateId",
  "unchangedCount",
  "usageUnits",
  "voice",
  "workspaceId",
  "failedCount",
  "ineligibleCount",
]);

function findSensitiveMetadataPath(
  value: unknown,
  path: Array<string | number> = [],
): Array<string | number> | null {
	if (typeof value === "string" && /(?:https?|s3|r2):\/\//i.test(value)) {
		return path;
	}
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSensitiveMetadataPath(item, [...path, index]);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_ANALYTICS_KEY.test(key)) return [...path, key];
    const found = findSensitiveMetadataPath(nested, [...path, key]);
    if (found) return found;
  }
  return null;
}

function findUnknownMetadataPath(
  value: unknown,
  path: Array<string | number> = [],
): Array<string | number> | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findUnknownMetadataPath(item, [...path, index]);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    if (!ALLOWED_ANALYTICS_METADATA_KEYS.has(key)) return [...path, key];
    const found = findUnknownMetadataPath(nested, [...path, key]);
    if (found) return found;
  }
  return null;
}

export const analyticsSnapshotSchema = z.object({
  projectId: z.string().uuid(),
  totals: z.object({
    rendersCompleted: z.number().int().nonnegative(),
    downloadsOpened: z.number().int().nonnegative(),
    socialScheduled: z.number().int().nonnegative(),
    socialPosted: z.number().int().nonnegative(),
    socialFailed: z.number().int().nonnegative(),
    dubsCompleted: z.number().int().nonnegative(),
    dubDownloadsOpened: z.number().int().nonnegative(),
  }),
  byClip: z.array(
    z.object({
      clipId: z.string().uuid(),
      rendersCompleted: z.number().int().nonnegative(),
      downloadsOpened: z.number().int().nonnegative(),
      socialScheduled: z.number().int().nonnegative(),
      socialPosted: z.number().int().nonnegative(),
      socialFailed: z.number().int().nonnegative(),
      dubsCompleted: z.number().int().nonnegative(),
      dubDownloadsOpened: z.number().int().nonnegative(),
    }),
  ),
});

const percentileCountSchema = z
  .object({
    median: z.number().nonnegative().nullable(),
    p90: z.number().nonnegative().nullable(),
  })
  .strict();

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function ratesMatch(actual: number, expected: number) {
  return Math.abs(actual - expected) <= 1e-9;
}

const publicationAttemptBreakdownSchema = z
  .object({
    terminal: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    needsAttention: z.number().int().nonnegative(),
    failureRate: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((summary, context) => {
    if (
      summary.succeeded + summary.failed + summary.needsAttention !==
      summary.terminal
    ) {
      context.addIssue({
        code: "custom",
        path: ["terminal"],
        message: "Publication terminal counts must reconcile",
      });
    }
    const expected = ratio(
      summary.failed + summary.needsAttention,
      summary.terminal,
    );
    if (!ratesMatch(summary.failureRate, expected)) {
      context.addIssue({
        code: "custom",
        path: ["failureRate"],
        message: "Publication failure rate must match terminal counts",
      });
    }
  });

const generatedProviderBreakdownSchema = z
  .object({
    terminal: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    failureRate: z.number().min(0).max(1),
    rejectionRate: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.completed + summary.failed + summary.rejected !== summary.terminal) {
      context.addIssue({
        code: "custom",
        path: ["terminal"],
        message: "Generated-provider terminal counts must reconcile",
      });
    }
    if (!ratesMatch(summary.failureRate, ratio(summary.failed, summary.terminal))) {
      context.addIssue({
        code: "custom",
        path: ["failureRate"],
        message: "Generated-provider failure rate must match terminal counts",
      });
    }
    if (
      !ratesMatch(summary.rejectionRate, ratio(summary.rejected, summary.terminal))
    ) {
      context.addIssue({
        code: "custom",
        path: ["rejectionRate"],
        message: "Generated-provider rejection rate must match terminal counts",
      });
    }
  });

export const campaignCompletionIntervalReportSchema = z
  .object({
    windowStart: z.string().datetime({ offset: true }),
    windowEnd: z.string().datetime({ offset: true }),
    eligibleProjects: z.number().int().nonnegative(),
    scheduledProjects: z.number().int().nonnegative(),
    completionRate: z.number().min(0).max(1),
    scheduledDeliverables: z.number().int().nonnegative(),
    approvalOverrides: z.number().int().nonnegative(),
    overriddenProjects: z.number().int().nonnegative(),
    approvalOverrideProjectRate: z.number().min(0).max(1),
    durationSeconds: z
      .object({
        median: z.number().nonnegative().nullable(),
        p90: z.number().nonnegative().nullable(),
      })
      .strict(),
    reviewRevisions: percentileCountSchema.extend({
      projectsWithRounds: z.number().int().nonnegative(),
    }),
    publicationAttempts: publicationAttemptBreakdownSchema.safeExtend({
      byPlatform: z.array(
        publicationAttemptBreakdownSchema.safeExtend({
          platform: socialPlatformSchema,
        }),
      ),
    }),
    generatedProviderOutcomes: generatedProviderBreakdownSchema.safeExtend({
      byProviderKind: z.array(
        generatedProviderBreakdownSchema.safeExtend({
          providerAlias: z.string().trim().min(1).max(80),
          kind: z.enum(["image", "video"]),
        }),
      ),
    }),
  })
  .strict()
  .superRefine((report, context) => {
    if (Date.parse(report.windowStart) >= Date.parse(report.windowEnd)) {
      context.addIssue({
        code: "custom",
        path: ["windowEnd"],
        message: "Campaign completion report window must move forward",
      });
    }
    if (report.scheduledProjects > report.eligibleProjects) {
      context.addIssue({
        code: "custom",
        path: ["scheduledProjects"],
        message: "Scheduled projects cannot exceed eligible projects",
      });
    }
    if (report.overriddenProjects > report.scheduledProjects) {
      context.addIssue({
        code: "custom",
        path: ["overriddenProjects"],
        message: "Overridden projects cannot exceed scheduled projects",
      });
    }
    if (
      !ratesMatch(
        report.approvalOverrideProjectRate,
        ratio(report.overriddenProjects, report.scheduledProjects),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["approvalOverrideProjectRate"],
        message: "Approval override rate must match scheduled project counts",
      });
    }
    if (report.reviewRevisions.projectsWithRounds > report.scheduledProjects) {
      context.addIssue({
        code: "custom",
        path: ["reviewRevisions", "projectsWithRounds"],
        message: "Review-round projects cannot exceed scheduled projects",
      });
    }
    if (
      report.durationSeconds.median !== null &&
      report.durationSeconds.p90 !== null &&
      report.durationSeconds.p90 < report.durationSeconds.median
    ) {
      context.addIssue({
        code: "custom",
        path: ["durationSeconds", "p90"],
        message: "The p90 duration cannot be below the median",
      });
    }
    if (
      report.reviewRevisions.median !== null &&
      report.reviewRevisions.p90 !== null &&
      report.reviewRevisions.p90 < report.reviewRevisions.median
    ) {
      context.addIssue({
        code: "custom",
        path: ["reviewRevisions", "p90"],
        message: "The p90 Review revision count cannot be below the median",
      });
    }

    const publicationTotals = report.publicationAttempts.byPlatform.reduce(
      (totals, item) => ({
        terminal: totals.terminal + item.terminal,
        succeeded: totals.succeeded + item.succeeded,
        failed: totals.failed + item.failed,
        needsAttention: totals.needsAttention + item.needsAttention,
      }),
      { terminal: 0, succeeded: 0, failed: 0, needsAttention: 0 },
    );
    for (const key of [
      "terminal",
      "succeeded",
      "failed",
      "needsAttention",
    ] as const) {
      if (publicationTotals[key] !== report.publicationAttempts[key]) {
        context.addIssue({
          code: "custom",
          path: ["publicationAttempts", "byPlatform"],
          message: "Publication platform counts must reconcile",
        });
        break;
      }
    }

    const providerTotals = report.generatedProviderOutcomes.byProviderKind.reduce(
      (totals, item) => ({
        terminal: totals.terminal + item.terminal,
        completed: totals.completed + item.completed,
        failed: totals.failed + item.failed,
        rejected: totals.rejected + item.rejected,
      }),
      { terminal: 0, completed: 0, failed: 0, rejected: 0 },
    );
    for (const key of ["terminal", "completed", "failed", "rejected"] as const) {
      if (providerTotals[key] !== report.generatedProviderOutcomes[key]) {
        context.addIssue({
          code: "custom",
          path: ["generatedProviderOutcomes", "byProviderKind"],
          message: "Generated-provider breakdown counts must reconcile",
        });
        break;
      }
    }
  });

export const recordAnalyticsEventSchema = z
  .object({
    type: analyticsEventTypeSchema,
    clipId: z.string().uuid().nullable().optional(),
    platform: socialPlatformSchema.nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const sensitivePath = findSensitiveMetadataPath(value.metadata);
    if (sensitivePath) {
      context.addIssue({
        code: "custom",
        message: "Analytics metadata contains a prohibited sensitive field",
        path: ["metadata", ...sensitivePath],
      });
      return;
    }
    const unknownPath = findUnknownMetadataPath(value.metadata);
    if (unknownPath) {
      context.addIssue({
        code: "custom",
        message: "Analytics metadata contains a field outside the approved allowlist",
        path: ["metadata", ...unknownPath],
      });
    }
  });

export const generatedMediaAnalyticsMetadataSchema = z
  .object({
    kind: z.enum(["image", "video"]),
    providerAlias: z.string().trim().min(1).max(80),
    modelAlias: z.string().trim().min(1).max(160),
    status: z.enum([
      "queued",
      "running",
      "waiting",
      "completed",
      "failed",
      "rejected",
      "cancelled",
    ]),
    latencyBucket: z.enum(["under_10s", "under_1m", "under_5m", "5m_plus"]),
    retryCount: z.number().int().nonnegative().max(1_000),
    moderationOutcome: z.enum(["pending", "passed", "rejected"]),
    usageUnits: z.number().int().nonnegative(),
    insertionAction: z.enum(["broll", "scene_block"]).optional(),
    outcome: z.enum(["succeeded", "failed", "rejected", "cancelled"]),
    planTier: z.enum(["free", "creator", "pro", "business"]),
  })
  .strict();

export const generatedMediaAnalyticsEventSchema = z
  .object({
    type: z.enum(["generated_asset_completed", "generated_asset_inserted"]),
    projectId: z.string().uuid(),
    clipId: z.string().uuid().nullable().optional(),
    metadata: generatedMediaAnalyticsMetadataSchema,
  })
  .strict()
  .superRefine((event, context) => {
    const sensitivePath = findSensitiveMetadataPath(event.metadata);
    if (sensitivePath) {
      context.addIssue({
        code: "custom",
        path: ["metadata", ...sensitivePath],
        message: "Generated media analytics contain prohibited sensitive data",
      });
      return;
    }
    if (
      event.type === "generated_asset_inserted" &&
      event.metadata.insertionAction === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["metadata", "insertionAction"],
        message: "Generated asset insertion analytics require an insertion action",
      });
    }
    if (
      event.type === "generated_asset_inserted" &&
      (event.metadata.status !== "completed" ||
        event.metadata.outcome !== "succeeded")
    ) {
      context.addIssue({
        code: "custom",
        path: ["metadata", "outcome"],
        message:
          "Generated asset insertion analytics require a committed insertion command",
      });
    }
    if (
      event.type === "generated_asset_completed" &&
      event.metadata.insertionAction !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["metadata", "insertionAction"],
        message: "Generated asset completion analytics cannot contain an insertion action",
      });
    }
    if (event.type === "generated_asset_completed") {
      const expectedOutcome =
        event.metadata.status === "completed"
          ? "succeeded"
          : event.metadata.status === "failed"
            ? "failed"
            : event.metadata.status === "rejected"
              ? "rejected"
              : event.metadata.status === "cancelled"
                ? "cancelled"
                : null;
      if (!expectedOutcome || event.metadata.outcome !== expectedOutcome) {
        context.addIssue({
          code: "custom",
          path: ["metadata", "outcome"],
          message:
            "Generated asset terminal status and outcome must describe the same transition",
        });
      }
    }
  });

export const brandProgramAnalyticsEventSchema = z
  .object({
    type: z.enum([
      "brand_profile_created",
      "brand_profile_applied",
      "visual_asset_upload_succeeded",
      "visual_asset_upload_failed",
      "brand_font_upload_succeeded",
      "brand_font_upload_failed",
      "scene_template_used",
      "brand_premium_mutation_blocked",
    ]),
    workspaceId: z.string().uuid(),
    actorUserId: z.string().uuid(),
    projectId: z.string().uuid().nullable().optional(),
    metadata: z
      .object({
        profileId: z.string().uuid().optional(),
        assetId: z.string().uuid().optional(),
        fontId: z.string().uuid().optional(),
        templateId: z.string().uuid().optional(),
        sceneTemplateId: z.string().uuid().optional(),
        assetKind: z.enum(["image", "video", "font", "profile", "scene"]).optional(),
        planTier: z.enum(["free", "creator", "pro", "business"]).optional(),
        outcome: z.enum(["succeeded", "failed", "blocked"]).optional(),
      })
      .strict(),
  })
  .strict();

export type AnalyticsEventType = z.infer<typeof analyticsEventTypeSchema>;
export type AnalyticsSnapshot = z.infer<typeof analyticsSnapshotSchema>;
export type CampaignCompletionIntervalReport = z.infer<
  typeof campaignCompletionIntervalReportSchema
>;
export type RecordAnalyticsEventInput = z.infer<typeof recordAnalyticsEventSchema>;
export type BrandProgramAnalyticsEventInput = z.infer<typeof brandProgramAnalyticsEventSchema>;
export type GeneratedMediaAnalyticsMetadata = z.infer<
  typeof generatedMediaAnalyticsMetadataSchema
>;
export type GeneratedMediaAnalyticsEventInput = z.infer<
  typeof generatedMediaAnalyticsEventSchema
>;
