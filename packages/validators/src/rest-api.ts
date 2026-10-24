import { z } from "zod";
import { captionedVideoOptionsSchema } from "./captioned-video";
import { finishingSettingsSchema } from "./finishing";
import { proposeSocialPostSchema } from "./publishing-queue";
import { acceptedRecipeSchema, clipExportRequestSchema, clipViewSchema, exportViewSchema, generationSettingsSchema, projectViewSchema, recipeIdSchema, recipeViewSchema, refuseRecipeWithInlineSettings } from "./integration";
import { LIBRARY_SEARCH_DEFAULT_LIMIT, LIBRARY_SEARCH_MAX_LIMIT, librarySearchQuerySchema, librarySearchResultSchema } from "./library-search";
import { mcpAccountsResultSchema, mcpBrandProfilesResultSchema, mcpProposedSocialPostResultSchema, mcpClipTimelineResultSchema, mcpExportDownloadResultSchema, mcpExportOutputSchema, mcpOperationStatusResultSchema, mcpProgressSchema, mcpWorkspaceUsageResultSchema } from "./mcp";
import { timelineFormatSchema } from "./timeline-export";
import { uploadMimeTypeSchema, MAX_UPLOAD_SIZE_BYTES } from "./upload";
import { createWebhookRequestSchema, webhookViewSchema } from "./webhook-subscription";
import { parseWorkspaceEventTypes, WORKSPACE_EVENT_DEFAULT_LIMIT, WORKSPACE_EVENT_MAX_LIMIT, WORKSPACE_EVENT_TYPES, workspaceEventCursorSchema, workspaceEventOrderSchema, workspaceEventsResultSchema } from "./workspace-event";

/** REST v1 request and response envelopes. Command inputs and resource views
 * come from the shared validators; this file adds only REST's own shape.
 * Changes are additive; breaking changes require /api/v2. */

const id = z.string().uuid();
export const restUuidParam = z.object({ id: id.describe("Resource ID") });
export const restOperationIdParam = z.object({ id: z.string().regex(/^op_[A-Za-z0-9_-]{23}$/).describe("Operation ID from an accepted request") });

export const REST_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:-]{1,200}$/;
export const restIdempotencyHeaders = z.object({
  "idempotency-key": z.string().regex(REST_IDEMPOTENCY_KEY_PATTERN)
    .describe("1–200 URL-safe characters. Retrying with the same key and input returns the original result; different input under the same key is a conflict."),
});

export const restErrorSchema = z.strictObject({
  error: z.string().describe("Stable error code"),
  message: z.string(),
  requestId: z.string(),
  details: z.record(z.string(), z.unknown()).optional().describe("Structured facts about the failure, such as limits or validation issues"),
  retryAfterSeconds: z.number().positive().optional(),
}).meta({ id: "Error" });

export const callbackRequestSchema = z.strictObject({
  url: z.string().url().max(2_048).describe("Public HTTPS URL on port 443. Receives one signed operation.completed event."),
}).meta({ id: "CallbackRequest" });

export const generationSettingsInput = generationSettingsSchema.meta({ id: "GenerationSettings" });
export const finishingSettingsInput = finishingSettingsSchema.meta({ id: "FinishingSettings" });

export const acceptedOperationSchema = z.strictObject({
  operationId: z.string(),
  kind: z.enum(["intake", "generation", "export"]),
  statusUrl: z.string().url(),
}).meta({ id: "AcceptedOperation" });

export const acceptedCallbackSchema = z.strictObject({
  eventId: id.describe("The webhook-id this operation's completion event will carry"),
}).nullable().meta({ id: "AcceptedCallback" });

export const workspaceResultSchema = z.strictObject({
  workspace: z.strictObject({ workspaceId: id, name: z.string(), role: z.enum(["owner", "admin", "editor", "viewer"]), status: z.string(), pricingTier: z.string() }),
  usage: mcpWorkspaceUsageResultSchema,
}).meta({ id: "WorkspaceResult" });

export const brandProfilesResultSchema = mcpBrandProfilesResultSchema.meta({ id: "BrandProfilesResult" });

export const openUploadRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional().describe("Defaults to the file name"),
  file: z.strictObject({
    name: z.string().trim().min(1).max(500),
    sizeBytes: z.number().int().positive().max(MAX_UPLOAD_SIZE_BYTES),
    contentType: uploadMimeTypeSchema,
  }),
  brandProfileId: id.optional().describe("Omit to use the Workspace default Brand Profile"),
  generation: generationSettingsInput.optional(),
  finishing: finishingSettingsInput.optional(),
  recipeId: recipeIdSchema.optional(),
  transfer: z.enum(["auto", "single"]).default("auto").describe("single returns one signed PUT at any supported size; auto uses multipart above 100 MiB"),
}).superRefine(refuseRecipeWithInlineSettings).meta({ id: "OpenUploadRequest" });

export const uploadSchema = z.strictObject({
  uploadId: id,
  state: z.enum(["uploading", "reconciling", "queued_for_ingest", "terminal", "discarded", "compensating"]),
  projectId: id.nullable(),
  expiresAt: z.string().datetime().nullable(),
  transfer: z.union([
    z.strictObject({ kind: z.literal("single"), method: z.literal("PUT"), url: z.string().url(), headers: z.record(z.string(), z.string()) }),
    z.strictObject({ kind: z.literal("multipart"), partSizeBytes: z.number().int(), partCount: z.number().int(), concurrency: z.number().int(),
      parts: z.array(z.strictObject({ partNumber: z.number().int(), url: z.string().url() })), grantExpiresAt: z.string().datetime(),
      completedParts: z.array(z.strictObject({ partNumber: z.number().int(), etag: z.string() })) }),
  ]).nullable().describe("Signed storage URLs. Never log or share them."),
  retryAfterSeconds: z.number().int().positive().nullable(),
  failureCode: z.string().nullable(),
  operation: acceptedOperationSchema.nullable().describe("The upload intake, once finalize accepts it"),
  recipe: acceptedRecipeSchema.optional().describe("The Recipe and revision a session opened with a recipeId used. Returned by the open request"),
}).meta({ id: "Upload" });

export const uploadResultSchema = z.strictObject({ upload: uploadSchema, callback: acceptedCallbackSchema.optional() }).meta({ id: "UploadResult" });

export const grantPartsRequestSchema = z.strictObject({
  partNumbers: z.array(z.number().int().positive()).min(1).max(16),
}).meta({ id: "GrantPartsRequest" });
export const grantPartsResultSchema = z.strictObject({
  uploadId: id, expiresAt: z.string().datetime(), parts: z.array(z.strictObject({ partNumber: z.number().int(), url: z.string().url() })),
}).meta({ id: "GrantPartsResult" });

export const finalizeUploadRequestSchema = z.strictObject({
  parts: z.array(z.strictObject({ partNumber: z.number().int().positive(), etag: z.string().trim().min(1).max(1_024) })).max(10_000).default([])
    .describe("Every uploaded part with its ETag; empty for a single PUT"),
  callback: callbackRequestSchema.optional(),
}).meta({ id: "FinalizeUploadRequest" });

export const submitVideoRequestSchema = z.strictObject({
  url: z.string().url().max(4_096).describe("A supported video link"),
  title: z.string().trim().min(1).max(200).optional(),
  brandProfileId: id.optional().describe("Omit to use the Workspace default Brand Profile"),
  generation: generationSettingsInput.optional(),
  finishing: finishingSettingsInput.optional(),
  recipeId: recipeIdSchema.optional(),
  callback: callbackRequestSchema.optional(),
}).superRefine(refuseRecipeWithInlineSettings).meta({ id: "SubmitVideoRequest" });

export const captionedVideoRequestSchema = captionedVideoOptionsSchema.extend({
  source: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("url"),
      url: z.string().url().max(4_096).describe("A supported video link"),
      callback: callbackRequestSchema.optional(),
    }).describe("Import a supported link. Accepted at once, as for POST /projects."),
    z.strictObject({
      kind: z.literal("upload"),
      file: openUploadRequestSchema.shape.file,
      transfer: openUploadRequestSchema.shape.transfer,
    }).describe("Open an Upload Session that carries these settings. Upload the file, then POST /uploads/{id}/finalize (with an optional callback)."),
  ]),
  title: z.string().trim().min(1).max(200).optional().describe("Defaults to the file name or link title"),
  brandProfileId: id.optional().describe("Omit to use the Workspace default Brand Profile"),
}).meta({ id: "CaptionedVideoRequest" });

export const acceptedProjectSchema = z.strictObject({
  projectId: id,
  operation: acceptedOperationSchema,
  reviewUrl: z.string().url(),
  callback: acceptedCallbackSchema,
  recipe: acceptedRecipeSchema.optional().describe("The Recipe and revision this request used, when it named one"),
}).meta({ id: "AcceptedProjectOperation" });

export const generateClipsRequestSchema = z.strictObject({
  generation: generationSettingsInput.optional(),
  finishing: finishingSettingsInput.optional(),
  recipeId: recipeIdSchema.optional(),
  forceRegenerate: z.boolean().default(false),
  callback: callbackRequestSchema.optional(),
}).superRefine(refuseRecipeWithInlineSettings).meta({ id: "GenerateClipsRequest" });

export const recipeSchema = recipeViewSchema.meta({ id: "Recipe" });
export const recipesResultSchema = z.strictObject({ recipes: z.array(recipeSchema) }).meta({ id: "RecipesResult" });
export const recipeResultSchema = z.strictObject({ recipe: recipeSchema }).meta({ id: "RecipeResult" });

export const projectSchema = projectViewSchema.meta({ id: "Project" });
export const projectsResultSchema = z.strictObject({
  items: z.array(projectViewSchema.extend({ progress: mcpProgressSchema, clipCount: z.number().int().nonnegative() })),
  nextCursor: z.string().nullable(),
  totalCount: z.number().int().nonnegative(),
}).meta({ id: "ProjectsResult" });
export const projectResultSchema = z.strictObject({ project: projectSchema, progress: mcpProgressSchema.nullable() }).meta({ id: "ProjectResult" });
export const listProjectsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(512).optional(),
});

export const librarySearchQuery = z.object({
  q: librarySearchQuerySchema,
  limit: z.coerce.number().int().min(1).max(LIBRARY_SEARCH_MAX_LIMIT).default(LIBRARY_SEARCH_DEFAULT_LIMIT),
  projectId: id.optional().describe("Search only this Project"),
});
export const librarySearchResultsSchema = librarySearchResultSchema.meta({ id: "LibrarySearchResult" });

export const clipSchema = clipViewSchema.meta({ id: "Clip" });
export const clipsResultSchema = z.strictObject({ items: z.array(clipSchema), nextCursor: z.string().nullable() }).meta({ id: "ClipsResult" });
export const clipResultSchema = z.strictObject({ clip: clipSchema }).meta({ id: "ClipResult" });
const booleanQuery = z.enum(["true", "false"]).default("false").transform((value) => value === "true");
export const listClipsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(512).optional(),
  includeTranscriptExcerpt: booleanQuery,
});
export const getClipQuery = z.object({ includeTranscriptExcerpt: booleanQuery });

export const createExportRequestSchema = clipExportRequestSchema.extend({ callback: callbackRequestSchema.optional() }).meta({ id: "CreateExportRequest" });
export const exportSchema = exportViewSchema.meta({ id: "Export" });
export const createdExportResultSchema = z.strictObject({
  export: exportSchema,
  reused: z.boolean().describe("An identical export of this revision already existed"),
  output: mcpExportOutputSchema,
  operation: acceptedOperationSchema,
  callback: acceptedCallbackSchema,
}).meta({ id: "CreatedExportResult" });
export const exportResultSchema = z.strictObject({ export: exportSchema }).meta({ id: "ExportResult" });
export const exportDownloadQuery = z.object({ variantId: id.optional() });
export const exportDownloadResultSchema = mcpExportDownloadResultSchema.meta({ id: "ExportDownload" });
export const clipTimelineQuery = z.object({ format: timelineFormatSchema.describe("xmeml for Premiere Pro, fcpxml for Final Cut Pro and DaVinci Resolve, edl for any editor") });
export const clipTimelineResultSchema = mcpClipTimelineResultSchema.meta({ id: "ClipTimeline" });

export const operationSchema = mcpOperationStatusResultSchema.omit({ operation: true }).extend({
  operationId: z.string(),
  kind: z.enum(["intake", "generation", "export"]),
  statusUrl: z.string().url(),
}).meta({ id: "Operation" });

export const redeliverResultSchema = z.strictObject({
  callbacks: z.array(z.strictObject({ eventId: id, state: z.enum(["waiting", "pending", "delivered", "failed", "cancelled"]) })),
}).meta({ id: "RedeliverResult" });

export { createWebhookRequestSchema };
export const webhookResultSchema = z.strictObject({ webhook: webhookViewSchema }).meta({ id: "WebhookResult" });
export const webhooksResultSchema = z.strictObject({ webhooks: z.array(webhookViewSchema) }).meta({ id: "WebhooksResult" });
export const deletedWebhookSchema = z.strictObject({ webhookId: id, deleted: z.literal(true) }).meta({ id: "DeletedWebhook" });
export const webhookTestResultSchema = z.strictObject({
  eventId: id.describe("The webhook-id of the webhook.test event"),
  delivered: z.boolean().describe("True when the endpoint answered 2xx"),
  status: z.number().int().nullable().describe("The endpoint's HTTP status, or null when it didn't answer"),
  durationMs: z.number().int().nonnegative(),
}).meta({ id: "WebhookTestResult" });

export const eventsResultSchema = workspaceEventsResultSchema.meta({ id: "EventsResult" });

export const socialAccountsResultSchema = mcpAccountsResultSchema.meta({ id: "SocialAccountsResult" });
export const proposeSocialPostRequestSchema = proposeSocialPostSchema.meta({ id: "ProposeSocialPostRequest" });
export const proposedSocialPostResultSchema = mcpProposedSocialPostResultSchema.meta({ id: "ProposedSocialPostResult" });
export const listEventsQuery = z.object({
  after: workspaceEventCursorSchema.optional(),
  order: workspaceEventOrderSchema.default("asc").describe("asc (default) reads forward from `after`. desc returns the newest `limit` matching events, newest first, and cannot be combined with `after`; its nextCursor is the highest seq on the page."),
  limit: z.coerce.number().int().min(1).max(WORKSPACE_EVENT_MAX_LIMIT).default(WORKSPACE_EVENT_DEFAULT_LIMIT),
  types: z.string().max(200).refine((value) => parseWorkspaceEventTypes(value) !== null, "Unknown event type")
    .optional().describe(`Comma-separated event types: ${WORKSPACE_EVENT_TYPES.join(", ")}`),
});
