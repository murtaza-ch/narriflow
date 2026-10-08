import { createHash } from "node:crypto";
import {
  buildGenerationContentPack,
  type ClipExportRequest,
  type ClipExportSnapshot,
  type GenerationSettings,
} from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import type { clipService } from "./clip.service";
import { clipExportService } from "./clip-export.service";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import type { IntegrationCommand } from "./integration-admission";
import type { IntegrationMutation } from "./operation-receipt";
import { projectService } from "./project.service";
import type { UploadSessionService } from "./upload-session.service";

/** Transport-neutral commands that MCP tools and REST endpoints both call.
 * Each returns domain facts; adapters add their own status pointers. */

const INTEGRATION_KEY_NAMESPACE = "8d2f1c3a-6b4e-5f70-9a1d-2c3b4e5f6a7b";

function uuidBytes(uuid: string) {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

/** RFC 9562 UUIDv5 of one acting user's command and caller key. Integration
 * keys are arbitrary strings, while Upload Sessions and Workflow Runs keep
 * their own UUID identities; deriving them per user keeps equal caller keys
 * from different users, or different commands, apart. */
export function integrationKeyUuid(actorUserId: string, command: IntegrationCommand, callerKey: string) {
  const hash = createHash("sha1")
    .update(uuidBytes(INTEGRATION_KEY_NAMESPACE))
    .update(JSON.stringify([actorUserId, command, callerKey]))
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The Upload Session key shared by every integration transport. */
export function integrationUploadSessionKey(actorUserId: string, callerKey: string) {
  return integrationKeyUuid(actorUserId, "open_upload", callerKey);
}

type UploadSessionCommands = Pick<UploadSessionService, "open" | "status" | "grant" | "finalize" | "discard">;

/** Upload Sessions as integrations see them: callers name a session by their
 * own key, and the session stores the per-user derived UUID. Grants, finalize,
 * and discard address the session by ID. */
export function integrationUploadSessions(service: UploadSessionCommands): UploadSessionCommands {
  return {
    open: (actor, input) => service.open(actor, { ...input, clientIdempotencyKey: integrationUploadSessionKey(actor.actorUserId, input.clientIdempotencyKey) }),
    status: (actor, input) => service.status(actor, { ...input, clientIdempotencyKey: integrationUploadSessionKey(actor.actorUserId, input.clientIdempotencyKey) }),
    grant: (actor, input) => service.grant(actor, input),
    finalize: (actor, input) => service.finalize(actor, input),
    discard: (actor, input) => service.discard(actor, input),
  };
}

export interface OperationRef {
  kind: "intake" | "generation" | "export";
  id: string;
}

function generationContext(settings: GenerationSettings) {
  return { contentPack: buildGenerationContentPack(settings), languageCode: settings.languageCode };
}

export async function submitVideo(
  actor: ActorScope,
  input: { url: string; title?: string; brandProfileId?: string; generation: GenerationSettings },
  mutation: IntegrationMutation,
) {
  const accepted = await projectService.queueLinkIngest(
    actor,
    { url: input.url, title: input.title, brandProfileId: input.brandProfileId },
    { generationContext: generationContext(input.generation), mutation },
  );
  if (!accepted.queuedJobId) {
    throw new ExpectedDomainFailureError({ code: "intake_operation_missing", kind: "unavailable", message: "The accepted import has no operation identifier" });
  }
  return {
    projectId: accepted.project.id,
    operation: { kind: "intake", id: accepted.queuedJobId } satisfies OperationRef,
    replayed: "replayed" in accepted && accepted.replayed,
  };
}

export async function generateClips(
  actor: ActorScope,
  input: { projectId: string; generation: GenerationSettings; forceRegenerate: boolean },
  mutation: IntegrationMutation,
) {
  const accepted = await projectService.triggerGeneration(
    actor,
    input.projectId,
    { ...generationContext(input.generation), forceRegenerate: input.forceRegenerate },
    // The run's key is per user, so equal caller keys never share a run.
    integrationKeyUuid(actor.actorUserId, "generate_clips", mutation.clientIdempotencyKey),
    { mutation },
  );
  return {
    projectId: input.projectId,
    operation: { kind: "generation", id: accepted.workflowRunId } satisfies OperationRef,
    replayed: "replayed" in accepted && accepted.replayed,
  };
}

export async function createClipExport(
  actor: ActorScope,
  input: ClipExportRequest & { projectId: string; clipId: string },
  mutation: IntegrationMutation,
) {
  const accepted = await clipExportService.create(
    actor,
    input.projectId,
    input.clipId,
    { expectedRevision: input.expectedRevision, aspectRatios: input.aspectRatios, resolution: input.resolution },
    mutation.clientIdempotencyKey,
    mutation,
  );
  return {
    ...accepted,
    operation: { kind: "export", id: accepted.export.id } satisfies OperationRef,
  };
}

type Project = NonNullable<Awaited<ReturnType<typeof projectService.getProjectSnapshot>>["project"]>;

/** Resource views shared by MCP and REST. Review links open Narriflow. */
export function projectView(project: Project, appOrigin: string) {
  return { projectId: project.id, workspaceId: project.workspaceId, title: project.title,
    sourceType: project.sourceType, ingestStatus: project.ingestStatus,
    durationSeconds: project.sourceDurationSeconds, languageCode: project.languageCode,
    createdAt: project.createdAt, reviewUrl: `${appOrigin}/projects/${project.id}` };
}

export function clipView(clip: Awaited<ReturnType<typeof clipService.getClipReviewFacts>>, appOrigin: string, includeTranscriptExcerpt = false) {
  return { clipId: clip.id, projectId: clip.projectId, editorRevision: clip.editorRevision,
    title: clip.title, status: clip.status, startSec: clip.startSec, endSec: clip.endSec,
    durationSec: clip.durationSec, hookText: clip.hookText.slice(0, 2_000), reasoning: clip.reasoning.slice(0, 2_000),
    category: clip.category, platformFit: clip.platformFit,
    scores: { virality: clip.viralityScore, hookStrength: clip.hookStrengthScore,
      emotionalIntensity: clip.emotionalIntensityScore, storyCompleteness: clip.storyCompletenessScore,
      pacing: clip.pacingScore, durationOptimality: clip.durationOptimalityScore }, hasPreview: clip.hasPreview,
    ...(includeTranscriptExcerpt ? { transcriptExcerpt: clip.transcriptExcerpt ?? "" } : {}),
    reviewUrl: `${appOrigin}/projects/${clip.projectId}/clips/${clip.id}/studio` };
}

export function exportView(snapshot: ClipExportSnapshot, appOrigin: string) {
  return { exportId: snapshot.id, projectId: snapshot.projectId, clipId: snapshot.clipId,
    editorRevision: snapshot.editorRevision, currentEditorRevision: snapshot.currentEditorRevision,
    isOlderVersion: snapshot.isOlderVersion, resolution: snapshot.resolution, watermark: snapshot.watermark, status: snapshot.status,
    progress: snapshot.progress, createdAt: snapshot.createdAt, completedAt: snapshot.completedAt,
    variants: snapshot.variants.map((variant) => ({ variantId: variant.id, aspectRatio: variant.aspectRatio,
      resolution: variant.resolution, status: variant.status, hasAsset: variant.hasAsset, durationSeconds: variant.durationSec })),
    reviewUrl: `${appOrigin}/projects/${snapshot.projectId}/clips/${snapshot.clipId}/exports/${snapshot.id}` };
}
