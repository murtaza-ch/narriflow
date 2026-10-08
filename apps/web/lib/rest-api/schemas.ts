import { z } from "zod";
import {
  clipExportRequestSchema,
  clipViewSchema,
  exportViewSchema,
  generationSettingsSchema,
  mcpBrandProfilesResultSchema,
  mcpExportDownloadResultSchema,
  mcpExportOutputSchema,
  mcpOperationStatusResultSchema,
  mcpProgressSchema,
  mcpWorkspaceUsageResultSchema,
  projectViewSchema,
  uploadMimeTypeSchema,
  MAX_UPLOAD_SIZE_BYTES,
} from "@narriflow/validators";

/** REST v1 request and response envelopes. Command inputs and resource views
 * come from the shared validators; this file adds only REST's own shape.
 * Changes are additive; breaking changes require /api/v2. */

const id = z.string().uuid();
export const uuidParam = z.object({ id: id.describe("Resource ID") });
export const operationIdParam = z.object({ id: z.string().regex(/^op_[A-Za-z0-9_-]{23}$/).describe("Operation ID from an accepted request") });

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:-]{1,200}$/;
export const idempotencyHeaders = z.object({
  "idempotency-key": z.string().regex(IDEMPOTENCY_KEY_PATTERN)
    .describe("1–200 URL-safe characters. Retrying with the same key and input returns the original result; different input under the same key is a conflict."),
});

export const errorSchema = z.strictObject({
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
  transfer: z.enum(["auto", "single"]).default("auto").describe("single returns one signed PUT at any supported size; auto uses multipart above 100 MiB"),
}).meta({ id: "OpenUploadRequest" });

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
  callback: callbackRequestSchema.optional(),
}).meta({ id: "SubmitVideoRequest" });

export const acceptedProjectSchema = z.strictObject({
  projectId: id,
  operation: acceptedOperationSchema,
  reviewUrl: z.string().url(),
  callback: acceptedCallbackSchema,
}).meta({ id: "AcceptedProjectOperation" });

export const generateClipsRequestSchema = z.strictObject({
  generation: generationSettingsInput.optional(),
  forceRegenerate: z.boolean().default(false),
  callback: callbackRequestSchema.optional(),
}).meta({ id: "GenerateClipsRequest" });

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

export const operationSchema = mcpOperationStatusResultSchema.omit({ operation: true }).extend({
  operationId: z.string(),
  kind: z.enum(["intake", "generation", "export"]),
  statusUrl: z.string().url(),
}).meta({ id: "Operation" });

export const redeliverResultSchema = z.strictObject({
  callbacks: z.array(z.strictObject({ eventId: id, state: z.enum(["waiting", "pending", "delivered", "failed", "cancelled"]) })),
}).meta({ id: "RedeliverResult" });
