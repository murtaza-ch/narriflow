import { z } from "zod";
import { BRAND_DEFAULT_CAPTION_PRESET_ID, captionPresetIdSchema } from "./caption-preset";
import { clipAspectRatioSchema, clipRenderResolutionSchema, clipCategorySchema, clipStatusSchema } from "./clip";
import { contentPackSchema, clipLengthPresetRanges, clipLengthPresetSchema, clipPlatformTargetSchema, generationModeSchema, PLATFORM_PLAYBOOK_VERSION } from "./content-pack";
import { sourceLanguageCodeSchema } from "./language";
import { ingestStatusSchema } from "./ingest";
import { socialDeliveryModeSchema, socialPlatformSchema, socialPostStatusSchema, confirmSocialPublicationSchema, scheduleSocialPostSchema } from "./social";
import { clipExportStatusSchema } from "./clip-export";
import { autopilotStatusSchema } from "./autopilot";

const id = z.string().uuid();
const text = z.string().max(2_000);
const date = z.string().datetime();
const link = z.string().url().max(4_096);
const continuationLink = z.string().url().max(49_152);
export const mcpWorkspaceInput = { workspaceId: id.optional() };
export const mcpMutationInput = { workspaceId: id, clientIdempotencyKey: id };
export const mcpGenerationSettingsSchema = z.strictObject({
  clipCountTarget: z.number().int().min(3).max(30).default(10),
  clipLengthPreset: clipLengthPresetSchema.default("auto"),
  defaultAspectRatio: clipAspectRatioSchema.default("9:16"),
  captionPreset: captionPresetIdSchema.default(BRAND_DEFAULT_CAPTION_PRESET_ID),
  mode: generationModeSchema.default("clip"),
  autoHook: z.boolean().default(true),
  specificMoments: z.string().max(500).default(""),
  processingStartSec: z.number().int().min(0).nullable().default(null),
  processingEndSec: z.number().int().min(0).nullable().default(null),
  languageCode: sourceLanguageCodeSchema.default(null),
});
export type McpGenerationSettings = z.infer<typeof mcpGenerationSettingsSchema>;
export function buildMcpContentPack(input: z.input<typeof mcpGenerationSettingsSchema> = {}) {
  const settings = mcpGenerationSettingsSchema.parse(input);
  return contentPackSchema.parse({
    outputTypes: ["short_clip"], clipGenerationMode: "best", clipCountTarget: settings.clipCountTarget,
    ...clipLengthPresetRanges[settings.clipLengthPreset],
    platformTargets: ["tiktok", "youtube_shorts", "instagram_reels"],
    toneConstraints: ["concise", "conversational"],
    captionPreset: settings.captionPreset, platformPlaybookVersion: PLATFORM_PLAYBOOK_VERSION,
    mode: settings.mode, autoHook: settings.autoHook, specificMoments: settings.specificMoments,
    processingStartSec: settings.processingStartSec, processingEndSec: settings.processingEndSec,
    clipLengthPreset: settings.clipLengthPreset, defaultAspectRatio: settings.defaultAspectRatio,
  });
}
const generation = mcpGenerationSettingsSchema.default(() => mcpGenerationSettingsSchema.parse({}));
export const mcpSubmitVideoSchema = z.strictObject({ ...mcpMutationInput, url: link, title: z.string().trim().min(1).max(200).optional(), generation });
export const mcpUploadVideoSchema = z.strictObject({ ...mcpMutationInput, title: z.string().trim().min(1).max(200).optional(), generation });
export const mcpGenerateClipsSchema = z.strictObject({ ...mcpMutationInput, projectId: id, generation, forceRegenerate: z.boolean().default(false) });
export const mcpGetProjectSchema = z.strictObject({ ...mcpWorkspaceInput, projectId: id });
export const mcpListClipsSchema = z.strictObject({ ...mcpWorkspaceInput, projectId: id, limit: z.number().int().min(1).max(50).default(20), cursor: z.string().max(512).nullable().optional(), includeTranscriptExcerpt: z.boolean().default(false) });
export const mcpGetClipSchema = z.strictObject({ ...mcpWorkspaceInput, projectId: id, clipId: id, includeTranscriptExcerpt: z.boolean().default(false) });
export const mcpCreateClipExportSchema = z.strictObject({ ...mcpMutationInput, projectId: id, clipId: id, expectedRevision: z.number().int().nonnegative(), aspectRatios: z.array(clipAspectRatioSchema).min(1).max(4).refine((values) => new Set(values).size === values.length, "Choose each format once"), resolution: clipRenderResolutionSchema });
export const mcpGetClipExportSchema = z.strictObject({ ...mcpWorkspaceInput, projectId: id, clipId: id, exportId: id });
export const mcpListSocialAccountsSchema = z.strictObject(mcpWorkspaceInput);
export const mcpPublishingOptionsSchema = z.strictObject({ ...mcpWorkspaceInput, accountId: id });
const scalarSetting = z.union([z.string().max(2_000), z.boolean(), z.number().finite(), z.null()]);
// These are user-selected provider settings, never provider responses or credentials.
export const mcpPublicationIntentSchema = z.strictObject({
  projectId: id, clientIdempotencyKey: id, clipId: id, expectedEditorRevision: scheduleSocialPostSchema.shape.expectedEditorRevision,
  accountId: id, clipExportId: id, clipExportVariantId: id,
  platform: socialPlatformSchema, deliveryMode: scheduleSocialPostSchema.shape.deliveryMode,
  caption: scheduleSocialPostSchema.shape.caption, aspectRatio: clipAspectRatioSchema,
  resolution: scheduleSocialPostSchema.shape.resolution, scheduledFor: scheduleSocialPostSchema.shape.scheduledFor,
  providerSettings: z.record(z.string().max(100), scalarSetting).refine((settings) => Object.keys(settings).length <= 30, "Too many provider settings").default({}),
}).superRefine((intent, context) => {
  const domainInput: Record<string, unknown> = { ...intent };
  delete domainInput.projectId;
  delete domainInput.workspaceId;
  const parsed = scheduleSocialPostSchema.safeParse(domainInput);
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
}).refine((intent) => new TextEncoder().encode(JSON.stringify(intent)).byteLength <= 16_000, "Publication intent is too large for confirmation");
export const mcpPrepareSocialPostSchema = mcpPublicationIntentSchema.safeExtend({ workspaceId: id });
export const mcpScheduleSocialPostSchema = z.strictObject({ ...mcpMutationInput, preparationToken: z.string().min(32).max(32_768), confirmationReceipt: z.string().min(32).max(32_768).optional() });
export const mcpListSocialPublicationsSchema = z.strictObject({ ...mcpWorkspaceInput, projectId: id, cursor: z.string().max(512).optional() });
export const mcpConfirmSocialPublicationSchema = confirmSocialPublicationSchema.extend({ ...mcpMutationInput, socialPostId: id }).strict();
export const mcpRecoverySchema = z.strictObject({ ...mcpMutationInput, socialPostId: id, reason: z.string().trim().min(1).max(500) });
export const mcpRepublishSchema = mcpRecoverySchema.extend({ duplicateRiskAcknowledged: z.literal(true) });
export const mcpCreateAutopilotSchema = z.strictObject({ ...mcpMutationInput, name: z.string().trim().min(1).max(120), rssUrl: link, titlePrefix: z.string().trim().min(1).max(100).nullable().optional(), intervalMinutes: z.number().int().min(60).max(10080).default(1440), maxEpisodesPerRun: z.number().int().min(1).max(10).default(3), generation });
export const mcpRunAutopilotSchema = z.strictObject({ ...mcpMutationInput, ruleId: id });
export const mcpListProjectsSchema = z.strictObject({ ...mcpWorkspaceInput, limit: z.number().int().min(1).max(100).default(20), cursor: z.string().max(512).nullable().optional() });
export const mcpWorkspaceOnlySchema = z.strictObject(mcpWorkspaceInput);
export const mcpGetPublicationSchema = z.strictObject({ ...mcpWorkspaceInput, socialPostId: id });

export const mcpFailureSchema = z.strictObject({ error: z.string().max(100), kind: z.enum(["invalid", "unprocessable", "forbidden", "payment_required", "missing", "conflict", "rate_limited", "unavailable"]).optional(), message: text, retryGuidance: z.enum(["correct_request", "request_access", "review_billing", "refresh_resource", "refresh_state", "retry_later"]).optional(), retryAfterSeconds: z.number().positive().optional(), details: z.record(z.string(), z.json()).optional() });
export const mcpWorkspaceSchema = z.strictObject({ workspaceId: id, name: z.string().max(200), role: z.enum(["owner", "admin", "editor", "viewer"]), status: z.string().max(30), pricingTier: z.string().max(30), isPersonal: z.boolean(), mcpEnabled: z.boolean() });
export const mcpProgressSchema = z.strictObject({ status: z.enum(["ready", "processing", "queued", "failed"]), label: z.string().max(200), active: z.boolean(), stage: z.string().max(100).nullable(), percent: z.number().min(0).max(100).nullable() });
export const mcpProjectSchema = z.strictObject({ projectId: id, workspaceId: id, title: z.string().max(500), sourceType: z.enum(["upload", "youtube", "rss", "link"]), ingestStatus: ingestStatusSchema, durationSeconds: z.number().nonnegative().nullable(), languageCode: z.string().max(30).nullable(), createdAt: date, reviewUrl: link });
export const mcpClipSchema = z.strictObject({ clipId: id, projectId: id, editorRevision: z.number().int().nonnegative(), title: z.string().max(500).nullable(), status: clipStatusSchema, startSec: z.number().nonnegative(), endSec: z.number().nonnegative(), durationSec: z.number().nonnegative(), hookText: text, reasoning: text, category: clipCategorySchema, platformFit: z.array(clipPlatformTargetSchema), scores: z.strictObject({ virality: z.number().min(0).max(100), hookStrength: z.number().min(0).max(100), emotionalIntensity: z.number().min(0).max(100), storyCompleteness: z.number().min(0).max(100), pacing: z.number().min(0).max(100), durationOptimality: z.number().min(0).max(100) }), hasPreview: z.boolean(), transcriptExcerpt: z.string().max(2_000).optional(), reviewUrl: link });
export const mcpExportSchema = z.strictObject({ exportId: id, projectId: id, clipId: id, editorRevision: z.number().int().nonnegative(), currentEditorRevision: z.number().int().nonnegative(), isOlderVersion: z.boolean(), resolution: clipRenderResolutionSchema, status: clipExportStatusSchema, progress: z.number().min(0).max(100), createdAt: date, completedAt: date.nullable(), variants: z.array(z.strictObject({ variantId: id, aspectRatio: clipAspectRatioSchema, resolution: clipRenderResolutionSchema, status: z.enum(["pending", "rendering", "completed", "failed"]), hasAsset: z.boolean(), durationSeconds: z.number().nonnegative().nullable() })), reviewUrl: link, statusTool: z.literal("narriflow_get_clip_export") });
export const mcpAutopilotRuleSchema = z.strictObject({ ruleId: id, workspaceId: id, name: z.string().max(120), rssUrl: link, status: autopilotStatusSchema, intervalMinutes: z.number().int().positive(), maxEpisodesPerRun: z.number().int().positive(), nextRunAt: date, lastCheckedAt: date.nullable(), lastSuccessAt: date.nullable(), importedEpisodeCount: z.number().int().nonnegative() });
export const mcpAccountSchema = z.strictObject({ accountId: id, platform: socialPlatformSchema, displayName: z.string().max(500), handle: z.string().max(500).nullable(), status: z.enum(["active", "expired", "revoked"]) });
export const mcpPublicationSchema = z.strictObject({ socialPostId: id, projectId: id, clipId: id.nullable(), accountId: id.nullable(), platform: socialPlatformSchema, deliveryMode: socialDeliveryModeSchema, status: socialPostStatusSchema, caption: z.string().max(5_000), scheduledFor: date.nullable(), postedAt: date.nullable(), externalUrl: link.nullable(), errorCode: z.string().max(200).nullable(), allowedActions: z.array(z.enum(["cancel", "recheck", "confirm_published", "publish_again", "reconnect_account", "schedule_again"])), reviewUrl: link });
export const mcpPublicationRecoverySchema = z.strictObject({ socialPostId: id, projectId: id, platform: socialPlatformSchema, status: socialPostStatusSchema, scheduledFor: date.nullable(), postedAt: date.nullable(), externalUrl: link.nullable(), errorCode: z.string().max(200).nullable(), allowedActions: mcpPublicationSchema.shape.allowedActions, attempts: z.array(z.strictObject({ attemptId: id, attemptNumber: z.number().int().positive(), phase: z.string().max(60), outcome: z.string().max(60).nullable(), failureCode: z.string().max(200).nullable(), startedAt: date.nullable(), terminalAt: date.nullable(), decisions: z.array(z.strictObject({ kind: z.string().max(100), reason: z.string().max(500), evidenceKind: z.string().max(100).nullable(), ownershipValidated: z.boolean(), createdAt: date })) })), reviewUrl: link });
export const mcpPublishingOptionsResultSchema = z.strictObject({ accountId: id, platform: socialPlatformSchema, directEnabled: z.boolean(), inboxEnabled: z.boolean(), privacyOptions: z.array(z.string().max(100)).max(50), commentDisabled: z.boolean(), duetDisabled: z.boolean(), stitchDisabled: z.boolean(), maximumDurationSec: z.number().nonnegative(), textLimit: z.number().int().nonnegative(), aspectRatios: z.array(clipAspectRatioSchema), confirmationRequired: z.literal(true) });
export const mcpOperationSchema = z.strictObject({ projectId: id, operationId: id, operationKind: z.enum(["ingest", "generation"]), status: z.enum(["accepted", "working", "completed", "failed", "cancelled"]), statusTool: z.literal("narriflow_get_project"), reviewUrl: link });
export const mcpUploadHandoffSchema = z.strictObject({ workspaceId: id, status: z.literal("awaiting_file"), handoffUrl: continuationLink, localUploadCommand: z.literal("bun run mcp:upload --file <path> --workspace <workspaceId> --key <clientIdempotencyKey>"), confirmationExpiresAt: date });
export const mcpPreparedPublicationSchema = z.strictObject({ status: z.literal("confirmation_required"), intent: mcpPrepareSocialPostSchema, accountDisplayName: z.string().max(500), preparationToken: z.string().max(32_768), confirmationUrl: continuationLink, expiresAt: date });
export const mcpAppTransferResultSchema = z.strictObject({ action: z.enum(["open", "status", "grants", "finalize", "discard"]), outcome: z.enum(["queued_for_ingest", "reconciling", "uploading", "terminal", "granted", "discarded", "compensating"]) });
export const mcpAppConfirmationResultSchema = z.strictObject({ status: z.literal("confirmed") });
export const mcpAppConfirmIntentSchema = z.strictObject({ workspaceId: id, token: z.string().min(1).max(32_768), accepted: z.boolean() });
export const mcpListWorkspacesSchema = z.strictObject({});
export const mcpWorkspacesResultSchema = z.strictObject({ workspaces: z.array(mcpWorkspaceSchema) });
export const mcpProjectsResultSchema = z.strictObject({ items: z.array(mcpProjectSchema.extend({ progress: mcpProgressSchema, clipCount: z.number().int().nonnegative() })), nextCursor: z.string().nullable(), totalCount: z.number().int().nonnegative() });
export const mcpProjectResultSchema = z.strictObject({ project: mcpProjectSchema.nullable(), progress: mcpProgressSchema.nullable() });
export const mcpWorkspaceUsageResultSchema = z.strictObject({ tier: z.string().max(30), usedMinutes: z.number().nonnegative(), limitMinutes: z.number().nonnegative(), maxUploadSeconds: z.number().nonnegative() });
export const mcpClipsResultSchema = z.strictObject({ items: z.array(mcpClipSchema).max(50), nextCursor: z.string().nullable() });
export const mcpClipResultSchema = z.strictObject({ clip: mcpClipSchema });
export const mcpClipExportResultSchema = z.strictObject({ export: mcpExportSchema, reused: z.boolean().optional() });
export const mcpAccountsResultSchema = z.strictObject({ accounts: z.array(mcpAccountSchema) });
export const mcpScheduledPublicationResultSchema = z.strictObject({ socialPostId: id, projectId: id, clipId: id, status: socialPostStatusSchema, scheduledFor: date, reviewUrl: link, statusTool: z.literal("narriflow_get_social_publication") });
export const mcpPublicationsResultSchema = z.strictObject({ items: z.array(mcpPublicationSchema), nextCursor: z.string().nullable() });
export const mcpAutopilotRulesResultSchema = z.strictObject({ rules: z.array(mcpAutopilotRuleSchema) });
export const mcpAutopilotRuleResultSchema = z.strictObject({ rule: mcpAutopilotRuleSchema });
export const mcpRecoveryMutationResultSchema = z.strictObject({ socialPostId: id, attemptId: id, priorAttemptId: id.optional(), status: socialPostStatusSchema, evidence: z.enum(["provider_validated", "manual"]).optional(), ownershipValidated: z.boolean().optional(), externalUrl: link.nullable().optional() });
export const mcpElicitationConfirmationSchema = z.strictObject({ confirm: z.literal(true) });
export function mcpResultSchema<T extends z.ZodType>(data: T) { return z.strictObject({ data: z.union([data, mcpFailureSchema]) }); }
