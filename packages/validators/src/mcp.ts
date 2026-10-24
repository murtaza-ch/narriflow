import { z } from "zod";
import { clipAspectRatioSchema, clipRenderResolutionSchema } from "./clip";
import { socialDeliveryModeSchema, socialPlatformSchema, socialPostMetricsSnapshotSchema, socialPostStatusSchema, confirmSocialPublicationSchema, scheduleSocialPostSchema } from "./social";
import { autopilotStatusSchema } from "./autopilot";
import { finishingSettingsSchema } from "./finishing";
import { postingScheduleSchema } from "./posting-schedule";
import { proposeSocialPostSchema, socialPostProposalSchema } from "./publishing-queue";
import { timelineFormatSchema } from "./timeline-export";
import { captionedVideoOptionsSchema, framingNoticeSchema } from "./captioned-video";
import { acceptedRecipeSchema, clipExportRequestSchema, clipViewSchema, exportViewSchema, generationSettingsSchema, projectViewSchema, recipeIdSchema, recipesResultSchema, refuseRecipeWithInlineSettings } from "./integration";
import { LIBRARY_SEARCH_DEFAULT_LIMIT, librarySearchLimitSchema, librarySearchQuerySchema, librarySearchResultSchema } from "./library-search";
import { WORKSPACE_EVENT_DEFAULT_LIMIT, WORKSPACE_EVENT_MAX_LIMIT, WORKSPACE_EVENT_TYPES, workspaceEventCursorSchema, workspaceEventOrderSchema, workspaceEventTypeSchema, workspaceEventsResultSchema } from "./workspace-event";

const id = z.string().uuid();
const text = z.string().max(2_000);
const date = z.string().datetime();
const link = z.string().url().max(4_096);
const continuationLink = z.string().url().max(49_152);
export const mcpWorkspaceInput = { workspaceId: id.optional() };
export const mcpMutationInput = { workspaceId: id, clientIdempotencyKey: id };
// Omitted generation means the defaults; a Recipe replaces it.
const generation = generationSettingsSchema.optional();
const recipeId = recipeIdSchema.optional();
const finishing = finishingSettingsSchema.optional().describe("Export the best clips and write copy when generation completes (Pro and above)");
/** Omitted means the Workspace's default Brand Profile, if any. */
const brandProfileId = id.optional().describe("Brand Profile from narriflow_list_brand_profiles; omit to use the Workspace default");
export const mcpSubmitVideoSchema = z.strictObject({ ...mcpMutationInput, url: link, title: z.string().trim().min(1).max(200).optional(), brandProfileId, generation, finishing, recipeId }).superRefine(refuseRecipeWithInlineSettings);
export const mcpCreateCaptionedVideoSchema = captionedVideoOptionsSchema.extend({ ...mcpMutationInput, url: link, title: z.string().trim().min(1).max(200).optional(), brandProfileId });
export const mcpUploadVideoSchema = z.strictObject({ ...mcpMutationInput, title: z.string().trim().min(1).max(200).optional(), brandProfileId, generation, finishing, recipeId }).superRefine(refuseRecipeWithInlineSettings);
export const mcpGenerateClipsSchema = z.strictObject({ ...mcpMutationInput, projectId: id, generation, finishing, recipeId, forceRegenerate: z.boolean().default(false) }).superRefine(refuseRecipeWithInlineSettings);
export const mcpGetProjectSchema = z.strictObject({ ...mcpWorkspaceInput, projectId: id });
export const mcpListClipsSchema = z.strictObject({ ...mcpWorkspaceInput, projectId: id, limit: z.number().int().min(1).max(50).default(20), cursor: z.string().max(512).nullable().optional(), includeTranscriptExcerpt: z.boolean().default(false) });
export const mcpGetClipSchema = z.strictObject({ ...mcpWorkspaceInput, projectId: id, clipId: id, includeTranscriptExcerpt: z.boolean().default(false) });
export const mcpCreateClipExportSchema = clipExportRequestSchema.extend({ ...mcpMutationInput, projectId: id, clipId: id });
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
export const mcpCreateAutopilotSchema = z.strictObject({ ...mcpMutationInput, name: z.string().trim().min(1).max(120), rssUrl: link, titlePrefix: z.string().trim().min(1).max(100).nullable().optional(), intervalMinutes: z.number().int().min(60).max(10080).default(1440), maxEpisodesPerRun: z.number().int().min(1).max(10).default(3), recipeId: recipeIdSchema.describe("Recipe from narriflow_list_recipes: the Brand Profile, language, generation settings, and finishing every import uses") });
export const mcpRunAutopilotSchema = z.strictObject({ ...mcpMutationInput, ruleId: id });
export const mcpListProjectsSchema = z.strictObject({ ...mcpWorkspaceInput, limit: z.number().int().min(1).max(100).default(20), cursor: z.string().max(512).nullable().optional() });
export const mcpWorkspaceOnlySchema = z.strictObject(mcpWorkspaceInput);
export const mcpListEventsSchema = z.strictObject({ ...mcpWorkspaceInput, after: workspaceEventCursorSchema.optional(),
  order: workspaceEventOrderSchema.default("asc").describe("asc (default) reads forward from `after`. desc returns the newest `limit` matching events, newest first, and cannot be combined with `after`; its nextCursor is the highest seq on the page."),
  limit: z.number().int().min(1).max(WORKSPACE_EVENT_MAX_LIMIT).default(WORKSPACE_EVENT_DEFAULT_LIMIT),
  types: z.array(workspaceEventTypeSchema).max(WORKSPACE_EVENT_TYPES.length).optional() });
export const mcpEventsResultSchema = workspaceEventsResultSchema;
export const mcpGetPublicationSchema = z.strictObject({ ...mcpWorkspaceInput, socialPostId: id });
export const mcpSearchLibrarySchema = z.strictObject({ ...mcpWorkspaceInput, query: librarySearchQuerySchema, limit: librarySearchLimitSchema.default(LIBRARY_SEARCH_DEFAULT_LIMIT), projectId: id.optional().describe("Search only this Project") });
export const mcpSearchLibraryResultSchema = librarySearchResultSchema;

export const mcpFailureSchema = z.strictObject({ error: z.string().max(100), kind: z.enum(["invalid", "unprocessable", "forbidden", "payment_required", "missing", "conflict", "rate_limited", "unavailable"]).optional(), message: text, retryGuidance: z.enum(["correct_request", "request_access", "review_billing", "refresh_resource", "refresh_state", "retry_later"]).optional(), retryAfterSeconds: z.number().positive().optional(), details: z.record(z.string(), z.json()).optional() });
export const mcpWorkspaceSchema = z.strictObject({ workspaceId: id, name: z.string().max(200), role: z.enum(["owner", "admin", "editor", "viewer"]), status: z.string().max(30), pricingTier: z.string().max(30), isPersonal: z.boolean(), mcpEnabled: z.boolean() });
export const mcpProgressSchema = z.strictObject({ status: z.enum(["ready", "processing", "queued", "failed"]), label: z.string().max(200), active: z.boolean(), stage: z.string().max(100).nullable(), percent: z.number().min(0).max(100).nullable() });
export const mcpAutopilotRuleSchema = z.strictObject({ ruleId: id, workspaceId: id, name: z.string().max(120), rssUrl: link, status: autopilotStatusSchema, recipeId: id, recipeName: z.string().max(120), pausedReason: text.nullable(), intervalMinutes: z.number().int().positive(), maxEpisodesPerRun: z.number().int().positive(), nextRunAt: date, lastCheckedAt: date.nullable(), lastSuccessAt: date.nullable(), importedEpisodeCount: z.number().int().nonnegative() });
export const mcpAccountSchema = z.strictObject({ accountId: id, platform: socialPlatformSchema, displayName: z.string().max(500), handle: z.string().max(500).nullable(), status: z.enum(["active", "expired", "revoked"]),
  postingSchedule: postingScheduleSchema.nullable().describe("Weekly slots a person's accepted proposals fill; null when the account has none") });
export const mcpPublicationSchema = z.strictObject({ socialPostId: id, projectId: id, clipId: id.nullable(), accountId: id.nullable(), platform: socialPlatformSchema, deliveryMode: socialDeliveryModeSchema, status: socialPostStatusSchema, caption: z.string().max(5_000), scheduledFor: date.nullable(), postedAt: date.nullable(), externalUrl: link.nullable(), errorCode: z.string().max(200).nullable(), latestMetrics: socialPostMetricsSnapshotSchema.nullable(), allowedActions: z.array(z.enum(["cancel", "recheck", "confirm_published", "publish_again", "reconnect_account", "schedule_again"])), reviewUrl: link });
export const mcpPublicationRecoverySchema = z.strictObject({ socialPostId: id, projectId: id, platform: socialPlatformSchema, status: socialPostStatusSchema, scheduledFor: date.nullable(), postedAt: date.nullable(), externalUrl: link.nullable(), errorCode: z.string().max(200).nullable(), latestMetrics: socialPostMetricsSnapshotSchema.nullable(), allowedActions: mcpPublicationSchema.shape.allowedActions, attempts: z.array(z.strictObject({ attemptId: id, attemptNumber: z.number().int().positive(), phase: z.string().max(60), outcome: z.string().max(60).nullable(), failureCode: z.string().max(200).nullable(), startedAt: date.nullable(), terminalAt: date.nullable(), decisions: z.array(z.strictObject({ kind: z.string().max(100), reason: z.string().max(500), evidenceKind: z.string().max(100).nullable(), ownershipValidated: z.boolean(), createdAt: date })) })), reviewUrl: link });
export const mcpPublishingOptionsResultSchema = z.strictObject({ accountId: id, platform: socialPlatformSchema, directEnabled: z.boolean(), inboxEnabled: z.boolean(), privacyOptions: z.array(z.string().max(100)).max(50), commentDisabled: z.boolean(), duetDisabled: z.boolean(), stitchDisabled: z.boolean(), maximumDurationSec: z.number().nonnegative(), textLimit: z.number().int().nonnegative(), aspectRatios: z.array(clipAspectRatioSchema), confirmationRequired: z.literal(true) });
export const mcpOperationKindSchema = z.enum(["intake", "generation", "export"]);
/** Pass to narriflow_get_operation to follow exactly the work a mutation accepted. */
export const mcpOperationRefSchema = z.strictObject({ kind: mcpOperationKindSchema, id });
const operationStatusTool = z.literal("narriflow_get_operation");
export const mcpOperationSchema = z.strictObject({ projectId: id, operation: mcpOperationRefSchema, status: z.enum(["accepted", "working", "completed", "failed", "cancelled"]), statusTool: operationStatusTool, reviewUrl: link,
  recipe: acceptedRecipeSchema.optional().describe("The Recipe and revision this request used, when it named one") });
export const mcpUploadHandoffSchema = z.strictObject({ workspaceId: id, status: z.literal("awaiting_file"), handoffUrl: continuationLink, localUploadCommand: z.literal("bun run mcp:upload --file <path> --workspace <workspaceId> --key <clientIdempotencyKey>"), confirmationExpiresAt: date });
export const mcpPreparedPublicationSchema = z.strictObject({ status: z.literal("confirmation_required"), intent: mcpPrepareSocialPostSchema, accountDisplayName: z.string().max(500), preparationToken: z.string().max(32_768), confirmationUrl: continuationLink, expiresAt: date });
export const mcpAppTransferResultSchema = z.strictObject({ action: z.enum(["open", "status", "grants", "finalize", "discard"]), outcome: z.enum(["queued_for_ingest", "reconciling", "uploading", "terminal", "granted", "discarded", "compensating"]), operation: mcpOperationRefSchema.optional(), statusTool: operationStatusTool.optional(), recipe: acceptedRecipeSchema.optional() });
export const mcpAppConfirmationResultSchema = z.strictObject({ status: z.literal("confirmed") });
export const mcpAppConfirmIntentSchema = z.strictObject({ workspaceId: id, token: z.string().min(1).max(32_768), accepted: z.boolean() });
export const mcpListWorkspacesSchema = z.strictObject({});
export const mcpWorkspacesResultSchema = z.strictObject({ workspaces: z.array(mcpWorkspaceSchema) });
export const mcpProjectsResultSchema = z.strictObject({ items: z.array(projectViewSchema.extend({ progress: mcpProgressSchema, clipCount: z.number().int().nonnegative() })), nextCursor: z.string().nullable(), totalCount: z.number().int().nonnegative() });
export const mcpProjectResultSchema = z.strictObject({ project: projectViewSchema.nullable(), progress: mcpProgressSchema.nullable() });
export const mcpWorkspaceUsageResultSchema = z.strictObject({
  tier: z.string().max(30),
  usedMinutes: z.number().int().nonnegative().describe("Settled processing minutes this UTC month"),
  reservedMinutes: z.number().int().nonnegative().describe("Minutes reserved for videos still importing"),
  limitMinutes: z.number().int().nonnegative(),
  remainingMinutes: z.number().int().nonnegative(),
  inFlight: z.number().int().nonnegative().describe("Videos currently processing"),
  inFlightLimit: z.number().int().positive().describe("Videos the plan may process at once"),
  maxUploadSeconds: z.number().int().nonnegative().describe("Per-video duration limit"),
});
export const mcpClipsResultSchema = z.strictObject({ items: z.array(clipViewSchema).max(50), nextCursor: z.string().nullable() });
export const mcpClipResultSchema = z.strictObject({ clip: clipViewSchema });
export const mcpClipExportResultSchema = z.strictObject({ export: exportViewSchema });
export const mcpExportOutputSchema = z.strictObject({
  requested: z.strictObject({ resolution: clipRenderResolutionSchema }),
  granted: z.strictObject({ resolution: clipRenderResolutionSchema, watermark: z.boolean() }),
  reason: z.literal("plan_limit").nullable().describe("Why the granted output differs from the request"),
});
export const mcpCreatedClipExportResultSchema = z.strictObject({ export: exportViewSchema, reused: z.boolean(), output: mcpExportOutputSchema, operation: mcpOperationRefSchema, statusTool: operationStatusTool });
export const mcpAccountsResultSchema = z.strictObject({ accounts: z.array(mcpAccountSchema), timeZone: z.string().max(100).describe("The Workspace time zone that posting slots are in") });
export const mcpProposeSocialPostSchema = proposeSocialPostSchema.extend(mcpMutationInput);
export const mcpProposedSocialPostResultSchema = z.strictObject({ proposal: socialPostProposalSchema, queueUrl: link.describe("Where a person accepts or rejects it in Narriflow"), replayed: z.boolean() });
export const mcpScheduledPublicationResultSchema = z.strictObject({ socialPostId: id, projectId: id, clipId: id, status: socialPostStatusSchema, scheduledFor: date, reviewUrl: link, statusTool: z.literal("narriflow_get_social_publication") });
export const mcpPublicationsResultSchema = z.strictObject({ items: z.array(mcpPublicationSchema), nextCursor: z.string().nullable() });
export const mcpAutopilotRulesResultSchema = z.strictObject({ rules: z.array(mcpAutopilotRuleSchema) });
export const mcpAutopilotRuleResultSchema = z.strictObject({ rule: mcpAutopilotRuleSchema });
export const mcpRecoveryMutationResultSchema = z.strictObject({ socialPostId: id, attemptId: id, priorAttemptId: id.optional(), status: socialPostStatusSchema, evidence: z.enum(["provider_validated", "manual"]).optional(), ownershipValidated: z.boolean().optional(), externalUrl: link.nullable().optional() });
export const mcpElicitationConfirmationSchema = z.strictObject({ confirm: z.literal(true) });
export const mcpGetOperationSchema = z.strictObject({ ...mcpWorkspaceInput, operation: mcpOperationRefSchema });
const operationItemState = z.enum(["working", "completed", "failed", "cancelled"]);
export const mcpOperationStatusResultSchema = z.strictObject({
  operation: mcpOperationRefSchema,
  state: z.enum(["working", "completed", "partial", "failed", "cancelled"]),
  stage: z.string().max(60).nullable(),
  progress: z.number().min(0).max(1),
  items: z.array(z.strictObject({ kind: z.enum(["clip", "variant"]), id, state: operationItemState, failureCode: z.string().max(200).nullable() })).max(2_000),
  results: z.strictObject({ projectId: id.nullable(), clipIds: z.array(id).max(2_000), exportId: id.nullable() }),
  notices: z.array(framingNoticeSchema).max(4).describe("Facts about how the work was done that the caller may want to act on"),
  failureCode: z.string().max(200).nullable(),
  reviewUrl: link.nullable(),
});
export const mcpGetExportDownloadSchema = z.strictObject({ ...mcpWorkspaceInput, exportId: id, variantId: id.optional() });
export const mcpExportDownloadResultSchema = z.strictObject({
  exportId: id, projectId: id, clipId: id, editorRevision: z.number().int().nonnegative(),
  variants: z.array(z.strictObject({ variantId: id, aspectRatio: clipAspectRatioSchema, resolution: clipRenderResolutionSchema, watermark: z.boolean(), fileName: z.string().max(200), sizeBytes: z.number().int().nonnegative().nullable(), downloadUrl: z.string().url().max(8_192).describe("Private Download Grant; do not share or store"), expiresAt: date })).max(4),
  subtitles: z.array(z.strictObject({ format: z.enum(["srt", "vtt"]), fileName: z.string().max(200), content: z.string().max(500_000) })).max(2),
});
export const mcpGetClipTimelineSchema = z.strictObject({ ...mcpWorkspaceInput, projectId: id, clipId: id, format: timelineFormatSchema });
export const mcpClipTimelineResultSchema = z.strictObject({
  projectId: id, clipId: id, editorRevision: z.number().int().nonnegative(), format: timelineFormatSchema,
  timeline: z.strictObject({ fileName: z.string().max(200), content: z.string().max(2_000_000).describe("Timeline file text; save it beside the source file under fileName") }),
  subtitles: z.strictObject({ format: z.literal("srt"), fileName: z.string().max(200), content: z.string().max(500_000) }),
  source: z.strictObject({
    fileName: z.string().max(200).describe("The name the timeline refers to; save the source file under it"),
    sizeBytes: z.number().int().nonnegative().nullable(),
    downloadUrl: z.string().url().max(8_192).describe("Private Download Grant; do not share or store"),
    expiresAt: date,
  }),
});
export const mcpListRecipesSchema = z.strictObject(mcpWorkspaceInput);
export const mcpRecipesResultSchema = recipesResultSchema;
export const mcpListBrandProfilesSchema = z.strictObject(mcpWorkspaceInput);
export const mcpBrandProfilesResultSchema = z.strictObject({
  profiles: z.array(z.strictObject({ brandProfileId: id, name: z.string().max(200), isDefault: z.boolean(),
    defaultStyle: z.strictObject({ templateId: id, name: z.string().max(200) }).nullable().describe("Caption style used when generation.captionPreset is brand_default") })).max(100),
});
export const mcpCreateReviewHandoffSchema = z.strictObject({ ...mcpWorkspaceInput, items: z.array(z.strictObject({ exportId: id, variantIds: z.array(id).min(1).max(4) })).min(1).max(20) });
export const mcpReviewHandoffResultSchema = z.strictObject({
  projectId: id, composerUrl: continuationLink,
  items: z.array(z.strictObject({ clipId: id, exportId: id, editorRevision: z.number().int().nonnegative(), variantIds: z.array(id) })),
  nextStep: z.literal("A signed-in member sets recipients and sends the round in Narriflow"),
});
export const mcpListReviewRoundsSchema = z.strictObject({ ...mcpWorkspaceInput, projectId: id.optional(), limit: z.number().int().min(1).max(20).default(10) });
export const mcpGetReviewRoundSchema = z.strictObject({ ...mcpWorkspaceInput, roundId: id });
export const mcpReviewRoundSchema = z.strictObject({
  roundId: id, projectId: id, revision: z.number().int().positive(), title: z.string().max(500),
  status: z.string().max(40).describe("open, approved, changes_requested, expired, revoked, or superseded"),
  decision: z.string().max(60).nullable(), sentAt: date.nullable(), expiresAt: date.nullable(),
  items: z.array(z.strictObject({ itemId: id, clipId: id, clipTitle: z.string().max(500).nullable(), exportId: id, editorRevision: z.number().int().nonnegative(), required: z.boolean(), decision: z.string().max(60).nullable(), commentCount: z.number().int().nonnegative() })),
  generalCommentCount: z.number().int().nonnegative(),
  reviewUrl: link,
});
export const mcpReviewRoundsResultSchema = z.strictObject({ rounds: z.array(mcpReviewRoundSchema).max(20) });
export const mcpReviewRoundResultSchema = z.strictObject({ round: mcpReviewRoundSchema });
export function mcpResultSchema<T extends z.ZodType>(data: T) { return z.strictObject({ data: z.union([data, mcpFailureSchema]) }); }
