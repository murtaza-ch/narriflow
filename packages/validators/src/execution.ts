import { z } from "zod";
import { publicationNativeCommandSchema, publicationNativeReplySchema } from "./publication-execution";
import { clipRenderCaptionDiagnosticsSchema } from "./clip";
import { mediaFactsSchema, sourceProbeSchema } from "./source-probe";
import { renderGroupOutcomeSchema } from "./render-execution";

export const EXECUTION_ENVELOPE_MAX_BYTES = 64 * 1024;
export const EXECUTION_COMMAND_MAX_BYTES = 64 * 1024;
export const EXECUTOR_MAX_LEASE_SECONDS = 120;
export const EXECUTION_SIGNATURE_MAX_AGE_SECONDS = 300;

const executionId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const generation = z.number().int().positive().safe();
export const executionMediaIdentitySchema = z.strictObject({
  provider: z.enum(["youtube", "upload", "rss", "direct", "drive", "zoom"]),
  mediaId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-][A-Za-z0-9._:-]*$/),
}).refine(value => value.provider !== "youtube" || /^[A-Za-z0-9_-]{11}$/.test(value.mediaId), "Invalid normalized YouTube media identity");
export const executionAudioTrackSchema = z.strictObject({
  id: executionId,
  language: z.string().min(1).max(32).regex(/^[A-Za-z0-9-]+$/).nullable(),
  codec: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/),
  sampleRate: z.number().int().positive().max(768000),
  channels: z.number().int().positive().max(64),
});

/** A dispatch names durable state. Workflow payloads never contain the state itself. */
export const executionDispatchKindSchema = z.enum([
  "import_pipeline", "render_run", "operation_driver", "maintenance",
  "project_progress", "local_fetch", "modal_execution",
]);

export const executionSubjectKindSchema = z.enum([
  "ingest_job", "workflow_run", "render_group", "clip_selection_window", "clip_preparation", "upload_session",
  "social_publication", "completion_callback", "webhook_subscription", "workspace_billing",
  "autopilot_rule", "zoom_notification", "generation_finishing", "dubbing", "export_bundle", "generated_media",
  "thumbnail_frame", "native_validation", "outbound_probe", "outbound_delivery", "library_index", "notification", "media_cleanup", "workflow_event",
  "workspace_event", "standing_grant", "pending_workspace", "retention", "maintenance",
]);

export const executionSubjectSchema = z.strictObject({
  kind: executionSubjectKindSchema,
  id: executionId,
});

export const executionDispatchReferenceSchema = z.strictObject({
  dispatchId: z.string().uuid(),
  deploymentEpoch: generation,
  kind: executionDispatchKindSchema,
  subject: executionSubjectSchema,
  generation,
  inputHash: sha256,
});

export type ExecutionDispatchKind = z.infer<typeof executionDispatchKindSchema>;
export type ExecutionSubjectKind = z.infer<typeof executionSubjectKindSchema>;
export type ExecutionSubject = z.infer<typeof executionSubjectSchema>;

/** A provider lineage survives its TS execution lease, but never a source or epoch change. */
export const providerAttemptReferenceSchema = z.strictObject({
  workflowRunId: z.string().uuid(),
  attemptId: z.string().uuid(),
  deploymentEpoch: generation,
  sourceRevision: generation,
  sourceAudioId: z.string().uuid().nullable(),
});
export type ProviderAttemptReference = z.infer<typeof providerAttemptReferenceSchema>;
export type ExecutionDispatchReference = z.infer<typeof executionDispatchReferenceSchema>;

/** Optional native language-probe input. No source URL or captions enter it. */
export const sourceLanguageProbeInputSchema = z.strictObject({
  sourceAudioId: z.string().uuid(), sourceBindingHash: sha256,
  workflowRunId: z.string().uuid(), generation,
  windows: z.array(z.strictObject({ startSec: z.number().finite().nonnegative(), durationSec: z.literal(20) })).length(3),
  toolchainFingerprint: sha256, deadlineAt: z.iso.datetime(),
});
export type SourceLanguageProbeInput = z.infer<typeof sourceLanguageProbeInputSchema>;

/** Parsing a fence never grants authority. Services must compare it under locks. */
export const executorFenceSchema = z.strictObject({
  reference: executionDispatchReferenceSchema,
  attemptToken: z.string().uuid(),
  owner: z.string().uuid(),
});

export const executionArtifactRoleSchema = z.enum([
  "source_audio", "source_video", "layout_evidence", "render_variant", "render_outcome", "clip_preview", "preview_peaks", "probe",
  "thumbnail", "export_bundle", "dub_mix", "validated_font", "validated_asset", "selection_window", "outbound_receipt", "publication_checkpoint",
]);

/** artifactId identifies a server-assigned key. Executors cannot choose publication keys. */
export const executionArtifactSchema = z.strictObject({
  artifactId: z.string().uuid(),
  role: executionArtifactRoleSchema,
  contentType: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
  byteLength: z.number().int().positive().safe().max(10 * 1024 ** 3),
  sha256,
  etag: z.string().min(1).max(160).regex(/^[\x21-\x7e]+$/),
  bindingHash: sha256,
  sourceAudio: z.lazy(() => sourceAudioBindingSchema).optional(),
  sourceVideo: z.lazy(() => sourceVideoBindingSchema).optional(),
  renderVariant: z.strictObject({ renderId: z.string().uuid(), durationSec: z.number().finite().positive(),
    usedStockIds: z.array(z.number().int().positive().safe()).max(6).refine(ids => new Set(ids).size === ids.length).optional(),
    captionDiagnostics: clipRenderCaptionDiagnosticsSchema.optional() }).optional(),
}).superRefine((value, context) => {
  for (const [field, role] of [["sourceAudio", "source_audio"], ["sourceVideo", "source_video"], ["renderVariant", "render_variant"]] as const) {
    if (value[field] !== undefined && value.role !== role) context.addIssue({ code: "custom", path: [field], message: "Artifact evidence must match its assigned role" });
  }
  if (value.role === "source_audio" && !value.sourceAudio) context.addIssue({ code: "custom", path: ["sourceAudio"], message: "Whole-source audio evidence is required" });
  if (value.role === "source_video" && !value.sourceVideo) context.addIssue({ code: "custom", path: ["sourceVideo"], message: "Whole-source video evidence is required" });
});

const failureCode = z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/);
const ownedCommand = { fence: executorFenceSchema };

export const executionCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("acquire"),
    reference: executionDispatchReferenceSchema,
    attemptToken: z.string().uuid(),
    owner: z.string().uuid(),
    leaseSeconds: z.number().int().positive().max(EXECUTOR_MAX_LEASE_SECONDS),
  }),
  z.strictObject({
    action: z.literal("renew"), ...ownedCommand,
    leaseSeconds: z.number().int().positive().max(EXECUTOR_MAX_LEASE_SECONDS),
  }),
  z.strictObject({ action: z.literal("process-start"), ...ownedCommand }),
  z.strictObject({ action: z.literal("publication-command"), ...ownedCommand, command: publicationNativeCommandSchema }),
  z.strictObject({ action: z.literal("read-disposition"), ...ownedCommand }),
  z.strictObject({ action: z.literal("commit-artifact"), ...ownedCommand, artifact: executionArtifactSchema }),
  z.strictObject({ action: z.literal("fail"), ...ownedCommand, failureCode, retryable: z.boolean() }),
  z.strictObject({ action: z.literal("release"), ...ownedCommand, reason: z.enum(["shutdown", "startup_rejected", "cancelled"]) }),
  z.strictObject({
    action: z.literal("progress"), ...ownedCommand,
    phase: z.enum(["acquiring", "downloading", "uploading", "preparing", "encoding", "delivering"]),
    progress: z.number().min(0).max(100),
  }),
]);

export type ExecutorFence = z.infer<typeof executorFenceSchema>;
export type ExecutionArtifactRole = z.infer<typeof executionArtifactRoleSchema>;
export type ExecutionArtifact = z.infer<typeof executionArtifactSchema>;
export type ExecutionCommand = z.infer<typeof executionCommandSchema>;

/** Timestamp is Unix seconds; signature is HMAC-SHA256 hex over the canonical fields. */
export const executionSignatureSchema = z.strictObject({
  version: z.literal(1),
  keyId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  audience: z.enum(["modal-bridge", "executor-control", "dev-device"]),
  method: z.enum(["GET", "POST"]),
  canonicalTarget: z.string().min(1).max(2048).regex(/^\/(?!\/)[\x21-\x22\x24-\x7e]*$/),
  bodySha256: sha256,
  timestamp: z.number().int().positive().safe(),
  deliveryId: z.string().uuid(),
  signature: sha256,
});
export type ExecutionSignature = z.infer<typeof executionSignatureSchema>;

const instant = z.iso.datetime();
const acquiredDisposition = z.strictObject({
  disposition: z.literal("acquired"),
  fence: executorFenceSchema,
  serverTime: instant,
  leaseExpiresAt: instant,
  operationDeadlineAt: instant,
}).superRefine((value, context) => {
  if (Date.parse(value.leaseExpiresAt) <= Date.parse(value.serverTime) ||
    Date.parse(value.leaseExpiresAt) > Date.parse(value.operationDeadlineAt)) {
    context.addIssue({ code: "custom", path: ["leaseExpiresAt"], message: "Lease must be live and bounded by the operation deadline" });
  }
});

export const executionDispositionSchema = z.discriminatedUnion("disposition", [
  acquiredDisposition,
  z.strictObject({ disposition: z.literal("already_owned"), leaseExpiresAt: instant }),
  z.strictObject({ disposition: z.literal("busy"), leaseExpiresAt: instant }),
  z.strictObject({ disposition: z.literal("renewed"), leaseExpiresAt: instant }),
  z.strictObject({ disposition: z.literal("started") }),
  z.strictObject({ disposition: z.literal("committed"), artifactId: z.string().uuid(), renderGroup: renderGroupOutcomeSchema.optional() }),
  z.strictObject({ disposition: z.literal("progress_recorded") }),
  z.strictObject({ disposition: z.literal("publication_recorded"), result: publicationNativeReplySchema }),
  z.strictObject({ disposition: z.literal("released"), dueAt: instant.nullable() }),
  z.strictObject({ disposition: z.literal("retry_due"), dueAt: instant }),
  z.strictObject({ disposition: z.literal("completed") }),
  z.strictObject({ disposition: z.literal("failed"), failureCode }),
  z.strictObject({ disposition: z.literal("cancelled") }),
  z.strictObject({ disposition: z.literal("expired") }),
  z.strictObject({ disposition: z.literal("superseded") }),
]);

export const executionDeadlineSchema = z.strictObject({
  reference: executionDispatchReferenceSchema,
  attemptToken: z.string().uuid(),
  kind: z.enum(["lease", "operation", "provider_submission", "provider_result", "retry"]),
  observedDeadlineAt: instant,
});

export type ExecutionDisposition = z.infer<typeof executionDispositionSchema>;
export type ExecutionDeadline = z.infer<typeof executionDeadlineSchema>;

/** Durable object identity; never an access URL or a callback-chosen publication key. */
export const executionObjectIdentitySchema = z.strictObject({
  key: z.string().min(1).max(1024).regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/).refine(
    (value) => !value.split("/").some((segment) => segment === ".." || segment === "." || segment === ""),
    "Object key must contain only nonempty, exact path segments",
  ),
  etag: z.string().min(1).max(160).regex(/^[\x21-\x7e]+$/),
  byteLength: z.number().int().positive().safe().max(10 * 1024 ** 3),
  sha256,
});

export const sourceAudioBindingSchema = z.strictObject({
  sourceAudioId: z.string().uuid(),
  projectId: z.string().uuid(),
  sourceRevision: generation,
  mediaIdentity: executionMediaIdentitySchema,
  audioTrack: executionAudioTrackSchema,
  object: executionObjectIdentitySchema,
  durationSeconds: z.number().finite().positive(),
  wholeSource: z.literal(true),
  audioStartTimeSec: z.number().finite(),
  probeVersion: executionId,
  toolchainFingerprint: sha256,
});

export type ExecutionObjectIdentity = z.infer<typeof executionObjectIdentitySchema>;
export type SourceAudioBinding = z.infer<typeof sourceAudioBindingSchema>;

/** Frozen at source admission. Draft settings cannot authorize speech work. */
export const ingestAcquisitionSchema = z.strictObject({
  audioPolicy: z.enum(["required", "none", "pending_pack"]), contentPackId: z.string().uuid().optional(),
});
export type IngestAcquisition = z.infer<typeof ingestAcquisitionSchema>;

/** One provider-resolved media read. Only Drive/Zoom may carry scoped read credentials. */
export const ingestDirectReadSchema=z.strictObject({
 provider:z.enum(["direct","rss","drive","zoom"]),url:z.url().max(8192).refine(value=>{const url=new URL(value);return ["http:","https:"].includes(url.protocol)&&!url.username&&!url.password&&!url.hash;}),
 authorization:z.string().min(1).max(4096).regex(/^Bearer [A-Za-z0-9._~+/-]+=*$/).nullable(),
}).superRefine((value,context)=>{
 if((["drive","zoom"].includes(value.provider))!==(value.authorization!==null))context.addIssue({code:"custom",message:"Invalid provider read credential"});
 if(value.provider==="zoom"&&new URL(value.url).protocol!=="https:")context.addIssue({code:"custom",message:"Invalid Zoom media endpoint"});
 if(value.provider==="drive"&&!/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/[A-Za-z0-9_-]{10,200}\?alt=media&supportsAllDrives=true$/.test(value.url))context.addIssue({code:"custom",message:"Invalid Drive media endpoint"});
});
export type IngestDirectRead=z.infer<typeof ingestDirectReadSchema>;

/** Worker-produced source input. Scoped grants stay in the package descriptors. */
export const ingestFetchSourceCommandSchema = z.strictObject({
  kind: z.literal("youtube_source"), audioPolicy: ingestAcquisitionSchema.shape.audioPolicy, projectId: z.string().uuid(), sourceRevision: generation,
  mediaId: z.string().regex(/^[A-Za-z0-9_-]{11}$/), sourceAudioId: z.string().uuid(), maxSourceSeconds: z.number().int().positive(),
  toolchainFingerprint: sha256, probeVersion: z.literal("normalized-probe-v1"),
  existingSourceAudio: sourceAudioBindingSchema.nullable(), languageProbe: sourceLanguageProbeInputSchema.nullable(),
});
export type IngestFetchSourceCommand = z.infer<typeof ingestFetchSourceCommandSchema>;

export const ingestUploadReadSchema=z.strictObject({
 storageKey:executionObjectIdentitySchema.shape.key,etag:executionObjectIdentitySchema.shape.etag,byteLength:executionObjectIdentitySchema.shape.byteLength,
 contentType:z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
});
export type IngestUploadRead=z.infer<typeof ingestUploadReadSchema>;
const ingestFileSourceBase=ingestFetchSourceCommandSchema.omit({kind:true,mediaId:true,maxSourceSeconds:true}).extend({mediaIdentity:executionMediaIdentitySchema});
export const ingestDirectSourceCommandSchema=ingestFileSourceBase.extend({kind:z.literal("direct_source"),source:ingestDirectReadSchema})
 .refine(value=>value.mediaIdentity.provider===value.source.provider);
export const ingestPinSourceCommandSchema=ingestFileSourceBase.extend({kind:z.literal("upload_source"),source:ingestUploadReadSchema})
 .refine(value=>value.mediaIdentity.provider==="upload");
export const ingestSourceRefusalCommandSchema=z.strictObject({kind:z.literal("source_refusal"),failureCode:z.enum(["drive_token_expired","drive_file_unavailable","zoom_recording_unavailable","zoom_connection_unavailable","worker_invalid_payload","source_download_failed","link_unsupported_source"]),retryable:z.boolean()});
export const ingestNativeSourceCommandSchema=z.union([ingestFetchSourceCommandSchema,ingestDirectSourceCommandSchema,ingestPinSourceCommandSchema,ingestSourceRefusalCommandSchema]);
export type IngestNativeSourceCommand=z.infer<typeof ingestNativeSourceCommandSchema>;

/** Complete probe facts plus the extraction identity, before any full-video publication. */
export const sourceVideoBindingSchema = z.strictObject({
  projectId: z.string().uuid(),
  sourceRevision: generation,
  mediaIdentity: executionMediaIdentitySchema,
  audioTrack: executionAudioTrackSchema.nullable(),
  probe: sourceProbeSchema.extend({ facts: mediaFactsSchema }),
  wholeSource: z.literal(true),
  audioStartTimeSec: z.number().finite().nullable(),
  videoStartTimeSec: z.number().finite().nullable(),
  probeVersion: executionId,
  toolchainFingerprint: sha256,
});
export type SourceVideoBinding = z.infer<typeof sourceVideoBindingSchema>;

/** Modal receives references only. It resolves neither project data nor SQL. */
export const executionInvocationSchema = z.strictObject({
  reference: executionDispatchReferenceSchema.refine(value => value.kind === "modal_execution", "Modal requires its admitted dispatch"),
  attemptToken: z.string().uuid(),
});
export const executionMediaFunctionSchema = z.enum([
  "fetch_source", "pin_source", "prepare_clip", "render_group", "probe_extract", "thumbnail",
  "export_bundle", "dub_mix", "outbound_delivery", "asset_validation", "generated_image", "publication",
]);
const bridgeInvocation = executionInvocationSchema.shape;
export const modalBridgeCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("spawn"), ...bridgeInvocation, function: executionMediaFunctionSchema }),
  z.strictObject({ action: z.literal("status"), ...bridgeInvocation, spawnDeliveryId: z.string().uuid() }),
  z.strictObject({ action: z.literal("cancel"), ...bridgeInvocation, spawnDeliveryId: z.string().uuid() }),
]);
const modalCallId = z.string().regex(/^fc-[A-Za-z0-9_-]{1,160}$/);
export const modalBridgeDispositionSchema = z.discriminatedUnion("disposition", [
  z.strictObject({ disposition: z.literal("spawned"), callId: modalCallId }),
  z.strictObject({ disposition: z.literal("observed"), callId: modalCallId, state: z.enum(["pending", "succeeded", "failed", "cancelled", "unknown"]) }),
  z.strictObject({ disposition: z.literal("cancel_requested"), callId: modalCallId }),
]);
export type ExecutionInvocation = z.infer<typeof executionInvocationSchema>;
export type ModalBridgeCommand = z.infer<typeof modalBridgeCommandSchema>;
export type ModalBridgeDisposition = z.infer<typeof modalBridgeDispositionSchema>;
