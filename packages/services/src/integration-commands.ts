import {
  buildCaptionedVideoContentPack,
  buildCaptionedVideoSettings,
  buildGenerationContentPack,
  buildGenerationContext,
  generationSettingsSchema,
  WORKSPACE_EVENT_PUBLISHING_TYPES,
  WORKSPACE_EVENT_TYPES,
  SuppliedCaptionsError,
  type CaptionedVideoOptions,
  type CaptionedVideoSettings,
  type ClipExportRequest,
  type ClipExportSnapshot,
  type AcceptedRecipe,
  type FinishingSettingsInput,
  type GenerationSettingsInput,
  type ProposeSocialPostInput,
  type RecipeView,
  type WorkspaceEventOrder,
  type WorkspaceEventType,
} from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import type { clipService } from "./clip.service";
import { clipExportService } from "./clip-export.service";
import { ExpectedDomainFailureError, isExpectedDomainFailure } from "./expected-domain-failure";
import { IntegrationAdmissionError, requireQueueDeliveryScope, type IntegrationCommand } from "./integration-admission";

export { requireQueueDeliveryScope };
import type { IntegrationMutation } from "./operation-receipt";
import { getPrismaClient } from "@narriflow/db/client";
import { callbackEventId, resetCompletionCallbacks } from "./completion-callback";
import { accessibleProjectWhere } from "./project-access";
import { getOperationReceiptExecutor } from "./operation-receipt-runtime";
import { operationStatusService } from "./operation-status-runtime";
import { projectService } from "./project.service";
import { assertFinishingQueue, publishingQueue } from "./publishing-queue.service";
import { recipeService, type RecipeUse } from "./recipe.service";
import { socialOAuthService } from "./social-oauth.service";
import { workspaceService } from "./workspace.service";
import type { UploadSessionService } from "./upload-session.service";
import { uuidV5 } from "./uuid-v5";
import { listWorkspaceEvents } from "./workspace-event";

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

type UploadSessionCommands = Pick<UploadSessionService, "open" | "statusByClientKey" | "statusById" | "grant" | "finalize" | "discard"> & Partial<Pick<UploadSessionService, "recipeUsed">>;
type OpenUploadArguments = Parameters<UploadSessionService["open"]>;
type FinalizeArguments = Parameters<UploadSessionService["finalize"]>;
type ReadUploadArguments = Parameters<UploadSessionService["status"]>;
type NewMutationGuard = () => void | Promise<void>;

export interface IntegrationUploadSessions {
  /** `beforeAccept` is the new-mutation limiter. While it is unavailable,
   * open still resumes a session that already exists for this key. */
  open(actor: OpenUploadArguments[0], input: OpenUploadArguments[1], beforeAccept?: NewMutationGuard, credential?: CommandCredential): Promise<Awaited<ReturnType<UploadSessionService["open"]>> & { recipe?: AcceptedRecipe }>;
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

/** Finishing settings passed inline by a REST or MCP request. Sending a Review Round belongs to
 * an Autopilot rule, because the standing grant that allows it is granted for a rule. */
export async function assertInlineFinishing(actor: ActorScope, finishing: Parameters<typeof assertFinishingQueue>[1]) {
  if (finishing?.delivery === "send_review_round") {
    throw new ExpectedDomainFailureError({
      code: "finishing_review_delivery_rule_only",
      kind: "invalid",
      message: "send_review_round belongs to an Autopilot rule with a standing grant. Use ready_to_review or propose_to_queue here.",
    });
  }
  await assertFinishingQueue(actor, finishing);
}

/** Upload Sessions as integrations see them: callers name a session by their
 * own key, and the session stores the per-user derived UUID. Grants, finalize,
 * and discard address the session by ID. */
export function integrationUploadSessions(service: UploadSessionCommands): IntegrationUploadSessions {
  const status = (actor: ActorScope, callerKey: string) => service.statusByClientKey(actor, integrationUploadSessionKey(actor.actorUserId, callerKey));
  return {
    async open(actor, input, beforeAccept, credential) {
      await unlessAccepted(beforeAccept, async () => Boolean(await status(actor, input.clientIdempotencyKey)));
      const keyed = {
        ...input,
        clientIdempotencyKey: integrationUploadSessionKey(actor.actorUserId, input.clientIdempotencyKey),
        source: { ...input.source, browserFingerprint: integrationSourceFingerprint(input.source) },
      };
      // A named Recipe is read by the session's admission, after its replay lookup.
      if (input.recipeId) {
        if (!credential) throw new Error("Using a Recipe needs the calling credential");
        const outcome = await service.open(actor, keyed, { recipe: recipeUse(actor, credential, input.recipeId) });
        // The session keeps the Recipe and revision it opened with; say which.
        const recipe = await service.recipeUsed?.(actor, outcome.sessionId);
        return recipe ? { ...outcome, recipe } : outcome;
      }
      // Finishing that proposes to the queue names accounts; a resumed session keeps the ones it was opened with.
      const finishing = input.generationContext?.finishing;
      if ((finishing?.delivery === "propose_to_queue" || finishing?.delivery === "send_review_round") && !await status(actor, input.clientIdempotencyKey).catch(() => null)) await assertInlineFinishing(actor, finishing);
      return service.open(actor, keyed);
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

type LinkIntake = { url: string; title?: string; brandProfileId?: string };
/** The scopes of the credential calling a command. */
export type CommandCredential = { scopes: readonly string[] };
/** Settings a request sends inline, or the Recipe that supplies them instead. */
type RecipeOrInlineSettings = { recipeId?: string; generation?: GenerationSettingsInput; finishing?: FinishingSettingsInput };

function recipeWithInlineSettings(): never {
  throw new ExpectedDomainFailureError({ code: "recipe_with_inline_settings", kind: "invalid", message: "A Recipe replaces brandProfileId, generation, and finishing. Send recipeId or those settings, not both." });
}

/** A named Recipe, checked as it is read: it exists in the Workspace, and
 * finishing that proposes to the queue needs the credential's publishing
 * scope and the caller's queue rights. */
function recipeUse(actor: ActorScope, credential: CommandCredential, recipeId: string): RecipeUse {
  return {
    id: recipeId,
    async resolve() {
      const recipe = await recipeService.resolve(actor, recipeId);
      requireQueueDeliveryScope(credential, recipe.finishing);
      await assertFinishingQueue(actor, recipe.finishing);
      return recipe;
    },
  };
}
/** The one context shape every intake carries to its Ingest Generation Handoff:
 * ordinary generations (`buildGenerationContext`, which also carries finishing)
 * and captioned videos (whose settings ride in their Content Pack). */
type IntakeGenerationContext = ReturnType<typeof buildGenerationContext>;

async function acceptLinkIntake(
  actor: ActorScope,
  input: LinkIntake,
  options: { generationContext: IntakeGenerationContext; command: "submit_video" | "create_captioned_video" } | { recipe: RecipeUse; command: "submit_video" },
  mutation: IntegrationMutation,
) {
  const accepted = await projectService.queueLinkIngest(
    actor,
    { url: input.url, title: input.title, brandProfileId: input.brandProfileId },
    { ...options, mutation },
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
    recipe: "recipe" in accepted ? accepted.recipe : undefined,
  };
}

export async function submitVideo(
  actor: ActorScope,
  input: LinkIntake & RecipeOrInlineSettings,
  mutation: IntegrationMutation,
  credential: CommandCredential,
) {
  if (input.recipeId) {
    if (input.brandProfileId !== undefined || input.generation !== undefined || input.finishing !== undefined) recipeWithInlineSettings();
    return acceptLinkIntake(actor, { url: input.url, title: input.title }, { recipe: recipeUse(actor, credential, input.recipeId), command: "submit_video" }, mutation);
  }
  await assertInlineFinishing(actor, input.finishing);
  return acceptLinkIntake(actor, input, { generationContext: buildGenerationContext(generationSettingsSchema.parse(input.generation ?? {}), input.finishing), command: "submit_video" }, mutation);
}

const suppliedCaptionsFailureKinds = {
  supplied_captions_empty: "unprocessable",
  supplied_captions_malformed: "unprocessable",
  supplied_captions_too_large: "invalid",
  supplied_captions_too_many_cues: "invalid",
} as const;

/** Validates captioned-video options and normalizes supplied captions into the
 * transcript model. Malformed, empty, or oversized captions are typed refusals. */
export function captionedVideoSettings(options: CaptionedVideoOptions): CaptionedVideoSettings {
  try {
    return buildCaptionedVideoSettings(options);
  } catch (error) {
    if (!(error instanceof SuppliedCaptionsError)) throw error;
    throw new ExpectedDomainFailureError({
      code: error.code,
      kind: suppliedCaptionsFailureKinds[error.code],
      message: error.message,
      ...(error.cue === null ? {} : { details: { cue: error.cue } }),
    });
  }
}

/** The generation context an Upload Session carries for a captioned video. */
export function captionedVideoGenerationContext(settings: CaptionedVideoSettings) {
  return { contentPack: buildCaptionedVideoContentPack(settings), languageCode: null };
}

/** Captions a finished short from a supported link: no clip detection, one
 * whole-source clip, exported at each requested format. */
export async function createCaptionedVideo(
  actor: ActorScope,
  input: LinkIntake & { settings: CaptionedVideoSettings },
  mutation: IntegrationMutation,
) {
  return acceptLinkIntake(actor, input, { generationContext: captionedVideoGenerationContext(input.settings), command: "create_captioned_video" }, mutation);
}

export async function generateClips(
  actor: ActorScope,
  input: { projectId: string; forceRegenerate: boolean } & RecipeOrInlineSettings,
  mutation: IntegrationMutation,
  credential: CommandCredential,
) {
  // The run's key is per user, so equal caller keys never share a run.
  const runKey = integrationKeyUuid(actor.actorUserId, "generate_clips", mutation.clientIdempotencyKey);
  let accepted;
  if (input.recipeId) {
    if (input.generation !== undefined || input.finishing !== undefined) recipeWithInlineSettings();
    accepted = await projectService.triggerGeneration(actor, input.projectId, { forceRegenerate: input.forceRegenerate, recipe: recipeUse(actor, credential, input.recipeId) }, runKey, { mutation });
  } else {
    await assertInlineFinishing(actor, input.finishing);
    const generation = generationSettingsSchema.parse(input.generation ?? {});
    accepted = await projectService.triggerGeneration(
      actor,
      input.projectId,
      { contentPack: buildGenerationContentPack(generation), languageCode: generation.languageCode, forceRegenerate: input.forceRegenerate },
      runKey,
      // Finishing is asked for by integrations only, never by the browser's generate route.
      { mutation, finishing: input.finishing },
    );
  }
  const receiptId = "receiptId" in accepted ? accepted.receiptId : "";
  return {
    projectId: input.projectId,
    operation: { kind: "generation", id: accepted.workflowRunId } satisfies OperationRef,
    replayed: "replayed" in accepted && accepted.replayed,
    callback: acceptedCallback(mutation, receiptId),
    recipe: "recipe" in accepted ? accepted.recipe : undefined,
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

/** One page of the Workspace Event feed for a credential. Publishing outcomes
 * and queue proposals need `publishing:read` on top of the command's own scope.
 * A request that names those types among visible ones has them filtered out; a
 * request for only types the credential can't see is refused with the scope it
 * lacks, since an empty page would read as "nothing happened".
 *
 * `order: "desc"` reads the newest `limit` matching events, newest first. It has
 * no cursor to continue from, so it can't be combined with `after`. */
export async function listEvents(
  actor: ActorScope,
  credential: { scopes: readonly string[] },
  input: { after?: string; limit?: number; types?: readonly WorkspaceEventType[]; order?: WorkspaceEventOrder },
) {
  if (input.order === "desc" && input.after) {
    throw new ExpectedDomainFailureError({ code: "invalid_request", kind: "invalid", message: "order=desc returns the newest events and cannot be combined with after. Omit after, or read in ascending order from a cursor." });
  }
  const mayViewPublishing = credential.scopes.includes("publishing:read");
  const visible = WORKSPACE_EVENT_TYPES.filter((type) => mayViewPublishing || !WORKSPACE_EVENT_PUBLISHING_TYPES.includes(type));
  // An empty list means every type.
  const types = input.types?.length ? visible.filter((type) => input.types!.includes(type)) : visible;
  if (types.length === 0) throw new IntegrationAdmissionError("scope_required", "This credential requires the publishing:read scope to read these events", { scope: "publishing:read" });
  return listWorkspaceEvents(prisma(), actor, { after: input.after, limit: input.limit, types, order: input.order });
}

/** A Recipe as integrations read it. */
export function recipeView(recipe: Awaited<ReturnType<typeof recipeService.get>>): RecipeView {
  const pack = recipe.contentPack;
  return {
    recipeId: recipe.id, name: recipe.name, revision: recipe.revision,
    brandProfileId: recipe.brandProfileId, languageCode: recipe.languageCode,
    generation: { clipCountTarget: pack.clipCountTarget, clipLengthPreset: pack.clipLengthPreset, defaultAspectRatio: pack.defaultAspectRatio,
      captionPreset: pack.captionPreset, mode: pack.mode, autoHook: pack.autoHook, specificMoments: pack.specificMoments,
      processingStartSec: pack.processingStartSec, processingEndSec: pack.processingEndSec },
    finishing: recipe.finishing,
    updatedAt: recipe.updatedAt,
  };
}

/** The Workspace's Recipes, for choosing one by ID. */
export async function recipesView(actor: ActorScope) {
  return { recipes: (await recipeService.list(actor)).map(recipeView) };
}

/** Proposes a post into an account's Publishing Queue. It never publishes and
 * takes no slot: a person accepts it in Narriflow, and the Brand Profile's
 * approval rule applies then. */
export async function proposeSocialPost(actor: ActorScope, input: ProposeSocialPostInput, mutation: IntegrationMutation) {
  return publishingQueue.propose(actor, input, { source: "integration", mutation });
}

/** The Workspace's connected accounts without credentials, with their posting
 * schedules and the time zone those slots are in. */
export async function socialAccountsView(actor: ActorScope) {
  const [accounts, workspace] = await Promise.all([socialOAuthService.listAccounts(actor), workspaceService.getWorkspace(actor.actorUserId, actor.workspaceId)]);
  return {
    accounts: accounts.map((account) => ({ accountId: account.id, platform: account.platform, displayName: account.displayName, handle: account.handle,
      status: account.status, postingSchedule: account.postingSchedule })),
    timeZone: workspace?.timezone ?? "UTC",
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
