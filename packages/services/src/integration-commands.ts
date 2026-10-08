import {
  buildGenerationContentPack,
  type ClipExportRequest,
  type ClipExportSnapshot,
  type GenerationSettings,
} from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import type { clipService } from "./clip.service";
import { clipExportService } from "./clip-export.service";
import { ExpectedDomainFailureError, isExpectedDomainFailure } from "./expected-domain-failure";
import type { IntegrationCommand } from "./integration-admission";
import type { IntegrationMutation } from "./operation-receipt";
import { getPrismaClient } from "@narriflow/db/client";
import { callbackEventId, resetCompletionCallbacks } from "./completion-callback";
import { accessibleProjectWhere } from "./project-access";
import { getOperationReceiptExecutor } from "./operation-receipt-runtime";
import { operationStatusService } from "./operation-status-runtime";
import { projectService } from "./project.service";
import { workspaceService } from "./workspace.service";
import type { UploadSessionService } from "./upload-session.service";
import { uuidV5 } from "./uuid-v5";

/** Transport-neutral commands that MCP tools and REST endpoints both call.
 * Each returns domain facts; adapters add their own status pointers. */

const INTEGRATION_KEY_NAMESPACE = "8d2f1c3a-6b4e-5f70-9a1d-2c3b4e5f6a7b";

/** UUIDv5 of one acting user's command and caller key. Integration keys are
 * arbitrary strings, while Upload Sessions and Workflow Runs keep their own
 * UUID identities; deriving them per user keeps equal caller keys from
 * different users, or different commands, apart. */
export function integrationKeyUuid(actorUserId: string, command: IntegrationCommand, callerKey: string) {
  return uuidV5(INTEGRATION_KEY_NAMESPACE, JSON.stringify([actorUserId, command, callerKey]));
}

/** The Upload Session key shared by every integration transport. */
export function integrationUploadSessionKey(actorUserId: string, callerKey: string) {
  return integrationKeyUuid(actorUserId, "open_upload", callerKey);
}

type UploadSessionCommands = Pick<UploadSessionService, "open" | "statusByClientKey" | "statusById" | "grant" | "finalize" | "discard">;
type OpenUploadArguments = Parameters<UploadSessionService["open"]>;
type FinalizeArguments = Parameters<UploadSessionService["finalize"]>;
type ReadUploadArguments = Parameters<UploadSessionService["status"]>;
type NewMutationGuard = () => void | Promise<void>;

export interface IntegrationUploadSessions {
  /** `beforeAccept` is the new-mutation limiter. While it is unavailable,
   * open still resumes a session that already exists for this key. */
  open(actor: OpenUploadArguments[0], input: OpenUploadArguments[1], beforeAccept?: NewMutationGuard): ReturnType<UploadSessionService["open"]>;
  /** Integrations name sessions by key alone; no browser fingerprint applies. */
  status(actor: ReadUploadArguments[0], input: Pick<ReadUploadArguments[1], "clientIdempotencyKey">): ReturnType<UploadSessionService["status"]>;
  grant: UploadSessionService["grant"];
  /** Finalize starts the intake, so it is a new mutation unless the session's
   * finalization was already accepted. */
  finalize(actor: FinalizeArguments[0], input: FinalizeArguments[1], options?: FinalizeArguments[2], beforeAccept?: NewMutationGuard): ReturnType<UploadSessionService["finalize"]>;
  discard: UploadSessionService["discard"];
}

/** The source fingerprint integrations store: file facts every transport
 * knows, so MCP and REST opening the same file under one key match. */
function integrationSourceFingerprint(source: { fileName: string; sizeBytes: number; contentType: string }) {
  return `integration:${JSON.stringify([source.fileName, source.sizeBytes, source.contentType])}`;
}

async function unlessAccepted(beforeAccept: NewMutationGuard | undefined, accepted: () => Promise<boolean>) {
  try {
    await beforeAccept?.();
  } catch (limiterError) {
    if (!isExpectedDomainFailure(limiterError) || limiterError.code !== "mutations_unavailable") throw limiterError;
    if (!await accepted().catch((lookupError) => {
      if (isExpectedDomainFailure(lookupError) && lookupError.code === "upload_session_not_found") return false;
      throw lookupError;
    })) throw limiterError;
  }
}

/** Upload Sessions as integrations see them: callers name a session by their
 * own key, and the session stores the per-user derived UUID. Grants, finalize,
 * and discard address the session by ID. */
export function integrationUploadSessions(service: UploadSessionCommands): IntegrationUploadSessions {
  const status = (actor: ActorScope, callerKey: string) => service.statusByClientKey(actor, integrationUploadSessionKey(actor.actorUserId, callerKey));
  return {
    async open(actor, input, beforeAccept) {
      await unlessAccepted(beforeAccept, async () => Boolean(await status(actor, input.clientIdempotencyKey)));
      return service.open(actor, {
        ...input,
        clientIdempotencyKey: integrationUploadSessionKey(actor.actorUserId, input.clientIdempotencyKey),
        source: { ...input.source, browserFingerprint: integrationSourceFingerprint(input.source) },
      });
    },
    status: (actor, input) => status(actor, input.clientIdempotencyKey),
    grant: (actor, input) => service.grant(actor, input),
    async finalize(actor, input, options, beforeAccept) {
      await unlessAccepted(beforeAccept, async () => {
        const current = await service.statusById(actor, input.sessionId);
        return current.outcome !== "uploading";
      });
      return service.finalize(actor, input, options);
    },
    discard: (actor, input) => service.discard(actor, input),
  };
}

export interface OperationRef {
  kind: "intake" | "generation" | "export";
  id: string;
}

/** What an accepted starting command reports about its callback. */
function acceptedCallback(mutation: IntegrationMutation, receiptId: string) {
  return mutation.callback ? { eventId: callbackEventId(receiptId) } : null;
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
    throw new ExpectedDomainFailureError({ code: "intake_operation_missing", kind: "unavailable", message: "The import was accepted but its status isn't available yet. Retry the request with the same idempotency key." });
  }
  const receiptId = "receiptId" in accepted ? accepted.receiptId : "";
  return {
    projectId: accepted.project.id,
    operation: { kind: "intake", id: accepted.queuedJobId } satisfies OperationRef,
    replayed: "replayed" in accepted && accepted.replayed,
    callback: acceptedCallback(mutation, receiptId),
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
  const receiptId = "receiptId" in accepted ? accepted.receiptId : "";
  return {
    projectId: input.projectId,
    operation: { kind: "generation", id: accepted.workflowRunId } satisfies OperationRef,
    replayed: "replayed" in accepted && accepted.replayed,
    callback: acceptedCallback(mutation, receiptId),
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
    callback: acceptedCallback(mutation, accepted.receiptId),
  };
}

function notFound(code: string, message: string): never {
  throw new ExpectedDomainFailureError({ code, kind: "missing", message });
}

function prisma() {
  const client = getPrismaClient();
  if (!client) throw new Error("Database client unavailable");
  return client;
}

/** Resolves a clip addressed by ID alone to its accessible Project. */
export async function locateClip(actor: ActorScope, clipId: string) {
  const clip = await prisma().clip.findFirst({ where: { id: clipId, project: { workspaceId: actor.workspaceId, ...accessibleProjectWhere() } }, select: { projectId: true } });
  if (!clip) notFound("clip_not_found", "This clip doesn't exist in the key's workspace. List the project's clips for current IDs.");
  return { projectId: clip.projectId, clipId };
}

/** Resolves an export addressed by ID alone to its accessible clip. */
export async function locateExport(actor: ActorScope, exportId: string) {
  const row = await prisma().clipExport.findFirst({ where: { id: exportId, workspaceId: actor.workspaceId, project: { workspaceId: actor.workspaceId, ...accessibleProjectWhere() } }, select: { projectId: true, clipId: true } });
  if (!row) notFound("clip_export_not_found", "This export doesn't exist in the key's workspace. Use the export ID returned when it was requested.");
  return { projectId: row.projectId, clipId: row.clipId, exportId };
}

/** Asks for an operation's completion events again, once per idempotency
 * key. A live operation's visibility is rechecked through Operation Status; a
 * deleted or expired one is still redeliverable, because its frozen
 * `unavailable` event stays scoped to this Workspace. */
export async function redeliverCallbacks(actor: ActorScope, operation: OperationRef, mutation: IntegrationMutation) {
  await operationStatusService.read(actor, operation).catch((error) => {
    if (!isExpectedDomainFailure(error) || error.code !== "operation_not_found") throw error;
  });
  const accepted = await getOperationReceiptExecutor().execute({
    identity: { workspaceId: actor.workspaceId, actorUserId: actor.actorUserId, command: "redeliver_callback", clientIdempotencyKey: mutation.clientIdempotencyKey },
    input: { operation },
    authorize: async () => {
      await workspaceService.requireActor(actor.actorUserId, actor.workspaceId, "processing.consume");
    },
    beforeAccept: mutation.beforeAccept,
    mutate: async (tx) => ({
      resourceType: "completion_callback",
      resourceId: operation.id,
      value: { callbacks: await resetCompletionCallbacks(tx, actor, operation, new Date()) },
    }),
  });
  return { ...accepted.value, replayed: accepted.replayed };
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
