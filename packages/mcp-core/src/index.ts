import { acceptedContent, inputRequired, inputResponse, type InputRequiredResult, type ToolAnnotations, type ClientCapabilities } from "@modelcontextprotocol/server";
import { autopilotService, brandProfileService, clipService, clipExportService, clipTimelineService, encodeReviewSelection, projectService, operationStatusService, reviewService, socialService, socialOAuthService, socialPublishingOptions, socialPublicationScheduling, uploadSessionService, workspaceService, workspaceLibraryService, getOperationReceiptExecutor, librarySearchService, listEvents, createCaptionedVideo, captionedVideoSettings, ExpectedDomainFailureError, submitVideo, generateClips, createClipExport, proposeSocialPost, requireQueueDeliveryScope, socialAccountsView, projectView, clipView, exportView, integrationUploadSessions, recipeService, recipesView, type IntegrationMutation } from "@narriflow/services";
import * as schemas from "@narriflow/validators";
import * as z from "zod/v4";
import { McpToolAdmission, mcpOperationReadScope, mcpToolFailure, type NarriflowMcpPrincipal, type NarriflowMcpToolName } from "./mcp-tool-admission";
import { createMcpConfirmation, verifyMcpPreparation, acceptMcpConfirmation, verifyMcpConfirmation, createMcpUploadHandoff, mcpPreparationDigest, MCP_CONTINUATION_TTL_MS } from "./mcp-confirmation";
import { mcpAutopilotRule, mcpPublication, mcpPublicationRecovery } from "./mcp-projections";
import { registerNarriflowMcpApps, getNarriflowAppToolMeta, supportsNarriflowApps } from "./mcp-apps";
import { recordMcpDiagnostic } from "./mcp-diagnostics";
import { installNarriflowTasks, NarriflowMcpServer as McpServer } from "./mcp-tasks";

export { McpToolAdmission, MCP_TOOL_COMMANDS, MCP_WORKSPACE_ACCESS_MESSAGE, mcpFailureMessage, type NarriflowMcpToolName, type NarriflowMcpPrincipal } from "./mcp-tool-admission";
export * from "./mcp-confirmation";
export const NARRIFLOW_MCP_SERVER_NAME = "narriflow";
export const NARRIFLOW_MCP_SERVER_VERSION = "0.4.0";
export const NARRIFLOW_MCP_INSTRUCTIONS = "Start with narriflow_list_workspaces and use the returned workspaceId. Mutations require an explicit workspaceId and a fresh clientIdempotencyKey; retry unchanged input with the same key after a lost response. The workspace must be active on a plan that includes the connector, and the credential needs explicit application scopes. Pick a Brand Profile with narriflow_list_brand_profiles, or a Recipe with narriflow_list_recipes to use its Brand Profile, generation settings, and finishing together, then submit a supported video link or use the upload picker, authenticated web handoff, or local upload command. Follow each accepted mutation with narriflow_get_operation and its returned operation reference; narriflow_get_project is only a Project snapshot. List clips, review their editor revision in Narriflow, request a revision-bound export, fetch files and subtitles with narriflow_get_export_download, and fetch an editor timeline with narriflow_get_clip_timeline, only when the user asks for them. To send exports to a client, create a review handoff link; a person sends the round in Narriflow, and narriflow_get_review_round reports decisions. Prepare the exact social post and obtain user confirmation before scheduling. Recheck inspects an existing provider operation. Confirm publication requires evidence; publish again requires duplicate-risk acknowledgement. Media processing consumes the workspace's monthly credits.";
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const admission = new McpToolAdmission(workspaceService);
const uploadSessions = integrationUploadSessions(uploadSessionService);
export interface NarriflowMcpServerOptions {
  appOrigin?: string;
  protocolEra?: "modern" | "legacy";
  authenticatePrincipal?: () => Promise<NarriflowMcpPrincipal>;
  assertNewMutationAllowed?: (context: { tool: NarriflowMcpToolName; principal: NarriflowMcpPrincipal; workspaceId: string }) => void | Promise<void>;
  appConnectDomains?: string[];
  appResourceDomains?: string[];
}
type ToolOutcome = { data: unknown; _meta?: Record<string, unknown> };
function unavailable(code: string, message: string, kind: "conflict" | "missing" | "forbidden" | "unavailable" = "conflict"): never {
  throw new ExpectedDomainFailureError({ code, kind, message });
}
function config<T extends z.ZodType>(title: string, description: string, output: T, annotations: ToolAnnotations = readOnly, view?: Parameters<typeof getNarriflowAppToolMeta>[0]) {
  return { title, description, outputSchema: schemas.mcpResultSchema(output), annotations,
    ...(view ? { _meta: getNarriflowAppToolMeta(view) } : {}) };
}
export function buildNarriflowMcpServer(principal: NarriflowMcpPrincipal, options: NarriflowMcpServerOptions = {}) {
  const appOrigin = new URL(options.appOrigin ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").origin;
  const currentPrincipal = options.authenticatePrincipal ?? (async () => principal);
  const server = new McpServer({ name: NARRIFLOW_MCP_SERVER_NAME, version: NARRIFLOW_MCP_SERVER_VERSION }, {
    instructions: NARRIFLOW_MCP_INSTRUCTIONS,
    cacheHints: { "server/discover": { ttlMs: 300_000, cacheScope: "public" }, "tools/list": { ttlMs: 300_000, cacheScope: "public" } },
    requestState: { verify: async (state) => verifyMcpPreparation(state, { principal: await currentPrincipal() }) },
  });
  installNarriflowTasks(server, { principal, authenticatePrincipal: options.authenticatePrincipal, assertNewMutationAllowed: options.assertNewMutationAllowed });
  const mutation = (tool: NarriflowMcpToolName, current: NarriflowMcpPrincipal, workspaceId: string, key: string): IntegrationMutation => ({
    clientIdempotencyKey: key, beforeAccept: async () => { await options.assertNewMutationAllowed?.({ tool, principal: current, workspaceId }); },
  });
  const execute = async (tool: NarriflowMcpToolName, output: z.ZodType, operation: (current: NarriflowMcpPrincipal) => Promise<ToolOutcome | InputRequiredResult>) => {
    const started = Date.now();
    let current = principal;
    try {
      current = await currentPrincipal();
      const result = await operation(current);
      if ("resultType" in result) {
        recordMcpDiagnostic({ event: "tool", outcome: "accepted", tool, durationMs: Date.now() - started, transport: options.authenticatePrincipal ? "stdio" : "http" });
        return result;
      }
      const data = output.parse(result.data);
      recordMcpDiagnostic({ event: "tool", outcome: "success", tool, durationMs: Date.now() - started, transport: options.authenticatePrincipal ? "stdio" : "http", operationId: (result._meta?.["narriflow/operation"] as {domainId?:string}|undefined)?.domainId });
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: { data }, ttlMs: 0, cacheScope: "private" as const, _meta: result._meta };
    } catch (error) {
      const result = mcpToolFailure(error);
      recordMcpDiagnostic({ event: "tool", outcome: "failure", tool, durationMs: Date.now() - started, transport: options.authenticatePrincipal ? "stdio" : "http" });
      return { ...result, ttlMs: 0, cacheScope: "private" as const };
    }
  };
  const workspace = (tool: Exclude<NarriflowMcpToolName, "narriflow_list_workspaces">, current: NarriflowMcpPrincipal, workspaceId?: string, scope?: Parameters<McpToolAdmission["requireWorkspace"]>[3]) => admission.requireWorkspace(tool, current, workspaceId, scope);
  const operationMeta = (workspaceId: string, domainKind: "intake" | "generation" | "export", domainId: string, projectId: string, clipId?: string) => ({ "narriflow/operation": { workspaceId, domainKind, domainId, projectId, ...(clipId ? { clipId } : {}) } });
  const operationStatusTool = "narriflow_get_operation" as const;

  const workspacesOutput = schemas.mcpWorkspacesResultSchema;
  server.registerTool("narriflow_list_workspaces", { ...config("List workspaces", "Discover current memberships and MCP eligibility", workspacesOutput), inputSchema: schemas.mcpListWorkspacesSchema }, () => execute("narriflow_list_workspaces", workspacesOutput, async (current) => ({ data: { workspaces: await admission.listWorkspaces(current) } })));
  const projectsOutput = schemas.mcpProjectsResultSchema;
  server.registerTool("narriflow_list_projects", { ...config("List projects", "Page through workspace projects with compact progress facts", projectsOutput), inputSchema: schemas.mcpListProjectsSchema }, (input) => execute("narriflow_list_projects", projectsOutput, async (current) => {
    const actor = await workspace("narriflow_list_projects", current, input.workspaceId);
    const page = await workspaceLibraryService.listProjects(actor, { limit: input.limit, cursor: input.cursor ?? null });
    return { data: { items: page.items.map((project) => ({ ...projectView(project, appOrigin), progress: { ...project.progress, stage: null, percent: null }, clipCount: project.clipCount })), nextCursor: page.nextCursor, totalCount: page.totalCount } };
  }));
  const projectOutput = schemas.mcpProjectResultSchema;
  server.registerTool("narriflow_get_project", { ...config("Get project snapshot", "Read a Project's current facts and latest activity; follow accepted work with narriflow_get_operation", projectOutput, readOnly, "progress"), inputSchema: schemas.mcpGetProjectSchema }, (input) => execute("narriflow_get_project", projectOutput, async (current) => {
    const actor = await workspace("narriflow_get_project", current, input.workspaceId);
    const snapshot = await projectService.getProjectSnapshot(actor, input.projectId);
    return { data: { project: snapshot.project ? projectView(snapshot.project, appOrigin) : null, progress: snapshot.progress ? { ...snapshot.progress, stage: snapshot.activeRun?.stage ?? null, percent: snapshot.activeRun?.progress ?? null } : null } };
  }));
  const usageOutput = schemas.mcpWorkspaceUsageResultSchema;
  server.registerTool("narriflow_get_workspace_usage", { ...config("Get workspace usage", "Read the plan, credits used, reserved, and remaining this UTC month with the renewal date, videos processing against the capacity limit, and the per-video limit. One credit is one started minute of source video, per video", usageOutput), inputSchema: schemas.mcpWorkspaceOnlySchema }, (input) => execute("narriflow_get_workspace_usage", usageOutput, async (current) => { const usage = await projectService.getUsageSummary(await workspace("narriflow_get_workspace_usage", current, input.workspaceId)); return { data: { ...usage, periodStart: usage.periodStart.toISOString(), renewsAt: usage.renewsAt.toISOString() } }; }));
  const searchOutput = schemas.mcpSearchLibraryResultSchema;
  server.registerTool("narriflow_search_library", { ...config("Search the library", "Search every transcript in the workspace by meaning and by exact words. Returns timestamped moments with their project; open a result's project with narriflow_get_project", searchOutput), inputSchema: schemas.mcpSearchLibrarySchema }, (input) => execute("narriflow_search_library", searchOutput, async (current) => {
    const actor = await workspace("narriflow_search_library", current, input.workspaceId);
    return { data: { results: await librarySearchService.search(actor, { query: input.query, limit: input.limit, projectIds: input.projectId ? [input.projectId] : undefined }) } };
  }));
  const clipsOutput = schemas.mcpClipsResultSchema;
  server.registerTool("narriflow_list_clips", { ...config("List clips", "Page clips ranked by virality; transcript excerpts are opt-in", clipsOutput), inputSchema: schemas.mcpListClipsSchema }, (input) => execute("narriflow_list_clips", clipsOutput, async (current) => {
    const actor = await workspace("narriflow_list_clips", current, input.workspaceId);
    const page = await clipService.listClipReviewFacts(actor, input.projectId, input);
    return { data: { items: page.items.map((clip) => clipView(clip, appOrigin, input.includeTranscriptExcerpt)), nextCursor: page.nextCursor } };
  }));
  const clipOutput = schemas.mcpClipResultSchema;
  server.registerTool("narriflow_get_clip", { ...config("Review a clip", "Read timing, scores and editor revision, then open visual review in Narriflow", clipOutput, readOnly, "clip-review"), inputSchema: schemas.mcpGetClipSchema }, (input) => execute("narriflow_get_clip", clipOutput, async (current) => {
    const actor = await workspace("narriflow_get_clip", current, input.workspaceId);
    const facts = await clipService.getClipReviewFacts(actor, input.projectId, input.clipId, input);
    const preview = supportsNarriflowApps(server.server.getClientCapabilities(), options.protocolEra) && facts.hasPreview ? await clipService.getClipPreviewSource(actor, input.projectId, input.clipId) : null;
    return { data: { clip: clipView(facts, appOrigin, input.includeTranscriptExcerpt) }, ...(preview?.previewUrl ? { _meta: { previewMediaUrl: preview.previewUrl, previewStartSec: preview.previewStartSec, previewDurationSec: preview.previewDurationSec } } : {}) };
  }));
  server.registerTool("narriflow_submit_video", { ...config("Submit a video link", "Atomically import supported media with committed clip generation settings, sent inline or named by recipeId", schemas.mcpOperationSchema, write, "progress"), inputSchema: schemas.mcpSubmitVideoSchema }, (input) => execute("narriflow_submit_video", schemas.mcpOperationSchema, async (current) => {
    const actor = await workspace("narriflow_submit_video", current, input.workspaceId);
    requireQueueDeliveryScope(current, input.finishing);
    const accepted = await submitVideo(actor, { url: input.url, title: input.title, brandProfileId: input.brandProfileId, generation: input.generation, finishing: input.finishing, recipeId: input.recipeId }, mutation("narriflow_submit_video", current, actor.workspaceId, input.clientIdempotencyKey), current);
    return { data: { projectId: accepted.projectId, operation: accepted.operation, status: "accepted", statusTool: operationStatusTool, reviewUrl: `${appOrigin}/projects/${accepted.projectId}`, ...(accepted.recipe ? { recipe: accepted.recipe } : {}) }, _meta: operationMeta(actor.workspaceId, "intake", accepted.operation.id, accepted.projectId) };
  }));
  server.registerTool("narriflow_create_captioned_video", { ...config("Caption a finished video", "Caption a short, finished video (such as an AI-generated one) from a supported link: no clip detection, one whole-video clip up to 3 minutes, framed Fit (whole frame) or Center (cover crop) and exported at each requested format. Captions come from the speech, supplied SRT or WebVTT text, or are omitted. For a local file, use the REST API.", schemas.mcpOperationSchema, write, "progress"), inputSchema: schemas.mcpCreateCaptionedVideoSchema }, (input) => execute("narriflow_create_captioned_video", schemas.mcpOperationSchema, async (current) => {
    const actor = await workspace("narriflow_create_captioned_video", current, input.workspaceId);
    const settings = captionedVideoSettings({ framing: input.framing, aspectRatios: input.aspectRatios, resolution: input.resolution, captions: input.captions });
    const accepted = await createCaptionedVideo(actor, { url: input.url, title: input.title, brandProfileId: input.brandProfileId, settings }, mutation("narriflow_create_captioned_video", current, actor.workspaceId, input.clientIdempotencyKey));
    return { data: { projectId: accepted.projectId, operation: accepted.operation, status: "accepted", statusTool: operationStatusTool, reviewUrl: `${appOrigin}/projects/${accepted.projectId}` }, _meta: operationMeta(actor.workspaceId, "intake", accepted.operation.id, accepted.projectId) };
  }));
  server.registerTool("narriflow_generate_clips", { ...config("Generate clips", "Start generation on a ready project using credit admission and durable retries", schemas.mcpOperationSchema, write, "progress"), inputSchema: schemas.mcpGenerateClipsSchema }, (input) => execute("narriflow_generate_clips", schemas.mcpOperationSchema, async (current) => {
    const actor = await workspace("narriflow_generate_clips", current, input.workspaceId);
    requireQueueDeliveryScope(current, input.finishing);
    const accepted = await generateClips(actor, { projectId: input.projectId, generation: input.generation, finishing: input.finishing, recipeId: input.recipeId, forceRegenerate: input.forceRegenerate }, mutation("narriflow_generate_clips", current, actor.workspaceId, input.clientIdempotencyKey), current);
    return { data: { projectId: input.projectId, operation: accepted.operation, status: "accepted", statusTool: operationStatusTool, reviewUrl: `${appOrigin}/projects/${input.projectId}`, ...(accepted.recipe ? { recipe: accepted.recipe } : {}) }, _meta: operationMeta(actor.workspaceId, "generation", accepted.operation.id, input.projectId) };
  }));
  server.registerTool("narriflow_upload_video", { ...config("Upload a video", "Open an assistant picker or authenticated upload handoff; file bytes transfer directly to storage", schemas.mcpUploadHandoffSchema, write, "upload"), inputSchema: schemas.mcpUploadVideoSchema }, (input) => execute("narriflow_upload_video", schemas.mcpUploadHandoffSchema, async (current) => {
    const actor = await workspace("narriflow_upload_video", current, input.workspaceId);
    requireQueueDeliveryScope(current, input.finishing);
    // The handoff signs the requested Brand Profile; admission applies the
    // Workspace default when it is omitted.
    if (input.brandProfileId) await brandProfileService.requireUsableId(actor, input.brandProfileId);
    // A Recipe is read when the upload opens; here it only has to exist and fit this credential.
    if (input.recipeId) requireQueueDeliveryScope(current, (await recipeService.resolve(actor, input.recipeId)).finishing);
    const handoff = createMcpUploadHandoff(current, input);
    return { data: { workspaceId: actor.workspaceId, status: "awaiting_file", handoffUrl: `${appOrigin}/integrations/mcp/upload?intent=${encodeURIComponent(handoff.token)}`, localUploadCommand: "bun run mcp:upload --file <path> --workspace <workspaceId> --key <clientIdempotencyKey>", confirmationExpiresAt: handoff.expiresAt }, _meta: { uploadContext: { workspaceId: actor.workspaceId, clientIdempotencyKey: input.clientIdempotencyKey, title: input.title, ...(input.recipeId ? { recipeId: input.recipeId } : { ...(input.brandProfileId ? { brandProfileId: input.brandProfileId } : {}), generationContext: schemas.buildGenerationContext(schemas.generationSettingsSchema.parse(input.generation ?? {}), input.finishing) }) } } };
  }));
  const createdExportOutput = schemas.mcpCreatedClipExportResultSchema;
  server.registerTool("narriflow_create_clip_export", { ...config("Create clip export", "Export the exact reviewed editor revision in explicitly selected formats; reports any plan limit applied to resolution or watermark", createdExportOutput, write, "progress"), inputSchema: schemas.mcpCreateClipExportSchema }, (input) => execute("narriflow_create_clip_export", createdExportOutput, async (current) => {
    const actor = await workspace("narriflow_create_clip_export", current, input.workspaceId);
    const accepted = await createClipExport(actor, { projectId: input.projectId, clipId: input.clipId, expectedRevision: input.expectedRevision, aspectRatios: input.aspectRatios, resolution: input.resolution }, mutation("narriflow_create_clip_export", current, actor.workspaceId, input.clientIdempotencyKey));
    return { data: { export: exportView(accepted.export, appOrigin), reused: accepted.reused, output: accepted.output, operation: accepted.operation, statusTool: operationStatusTool }, _meta: operationMeta(actor.workspaceId, "export", accepted.operation.id, input.projectId, input.clipId) };
  }));
  const exportOutput = schemas.mcpClipExportResultSchema;
  server.registerTool("narriflow_get_clip_export", { ...config("Get clip export", "Read export progress and its Narriflow page; fetch files with narriflow_get_export_download", exportOutput), inputSchema: schemas.mcpGetClipExportSchema }, (input) => execute("narriflow_get_clip_export", exportOutput, async (current) => {
    const snapshot = await clipExportService.getOwned(await workspace("narriflow_get_clip_export", current, input.workspaceId), input.projectId, input.clipId, input.exportId);
    if (!snapshot) unavailable("clip_export_not_found", "Clip export was not found", "missing");
    return { data: { export: exportView(snapshot, appOrigin) } };
  }));
  const operationOutput = schemas.mcpOperationStatusResultSchema;
  server.registerTool("narriflow_get_operation", { ...config("Get operation status", "Follow exactly the work one accepted mutation started: state, progress, per-clip or per-format outcomes, and produced IDs", operationOutput, readOnly, "progress"), inputSchema: schemas.mcpGetOperationSchema }, (input) => execute("narriflow_get_operation", operationOutput, async (current) => {
    const actor = await workspace("narriflow_get_operation", current, input.workspaceId, mcpOperationReadScope(input.operation.kind));
    const status = await operationStatusService.read(actor, input.operation);
    const projectId = status.results.projectId;
    return { data: { operation: { kind: status.kind, id: status.id }, state: status.state, stage: status.stage, progress: status.progress, items: status.items,
      results: status.results, notices: status.notices, failureCode: status.failureCode, reviewUrl: projectId ? `${appOrigin}/projects/${projectId}` : null } };
  }));
  const eventsOutput = schemas.mcpEventsResultSchema;
  server.registerTool("narriflow_list_events", { ...config("List workspace events", "Poll what finished in this Workspace, including work no request started such as an Autopilot import. Pass the returned nextCursor as `after`; events are ordered, delivered at least once (deduplicate by id), and expire after 30 days. order=desc returns the newest events, newest first, with no `after` (read the newest page each poll and deduplicate by id; at most `limit` events per poll). Queue proposals and posting outcomes need the publishing:read scope; asking only for those types without it is refused with scope_required.", eventsOutput), inputSchema: schemas.mcpListEventsSchema }, (input) => execute("narriflow_list_events", eventsOutput, async (current) => {
    const actor = await workspace("narriflow_list_events", current, input.workspaceId);
    return { data: await listEvents(actor, current, { after: input.after, limit: input.limit, types: input.types, order: input.order }) };
  }));
  const downloadOutput = schemas.mcpExportDownloadResultSchema;
  server.registerTool("narriflow_get_export_download", { ...config("Get export files", "Issue fresh private download links (valid 15 minutes) for a finished export's video files, plus SRT and VTT subtitles. Call again for new links.", downloadOutput), inputSchema: schemas.mcpGetExportDownloadSchema }, (input) => execute("narriflow_get_export_download", downloadOutput, async (current) => {
    const actor = await workspace("narriflow_get_export_download", current, input.workspaceId);
    const grants = await clipExportService.issueDownloadGrants(actor, input.exportId, { variantId: input.variantId, credentialKind: current.kind });
    return { data: grants };
  }));
  const timelineOutput = schemas.mcpClipTimelineResultSchema;
  server.registerTool("narriflow_get_clip_timeline", { ...config("Get editor timeline", "The clip's current edit as a timeline that cuts the original source, for Premiere Pro (xmeml), Final Cut Pro and DaVinci Resolve (fcpxml), or any editor (edl), with SRT captions and a private Download Grant (valid 15 minutes) for the original source. Save the source under source.fileName beside the timeline file. Scenes, overlays, and burned-in captions are not timeline layers.", timelineOutput), inputSchema: schemas.mcpGetClipTimelineSchema }, (input) => execute("narriflow_get_clip_timeline", timelineOutput, async (current) => {
    const actor = await workspace("narriflow_get_clip_timeline", current, input.workspaceId);
    return { data: await clipTimelineService.export(actor, input.projectId, input.clipId, input.format, { credentialKind: current.kind }) };
  }));
  const brandsOutput = schemas.mcpBrandProfilesResultSchema;
  server.registerTool("narriflow_list_brand_profiles", { ...config("List Brand Profiles", "List the workspace's Brand Profiles by name; pass brandProfileId when submitting or uploading a video", brandsOutput), inputSchema: schemas.mcpListBrandProfilesSchema }, (input) => execute("narriflow_list_brand_profiles", brandsOutput, async (current) => {
    const profiles = await brandProfileService.listSummaries(await workspace("narriflow_list_brand_profiles", current, input.workspaceId));
    return { data: { profiles: profiles.map((profile) => ({ brandProfileId: profile.id, name: profile.name, isDefault: profile.isDefault,
      defaultStyle: profile.defaultStyle ? { templateId: profile.defaultStyle.id, name: profile.defaultStyle.name } : null })) } };
  }));
  const recipesOutput = schemas.mcpRecipesResultSchema;
  server.registerTool("narriflow_list_recipes", { ...config("List Recipes", "List the workspace's saved Recipes: a Brand Profile, language, generation settings, and finishing under one name. Pass recipeId instead of those settings when submitting, uploading, or generating, or when creating an Autopilot rule. Recipes are created and edited in Narriflow", recipesOutput), inputSchema: schemas.mcpListRecipesSchema }, (input) => execute("narriflow_list_recipes", recipesOutput, async (current) => ({
    data: await recipesView(await workspace("narriflow_list_recipes", current, input.workspaceId)),
  })));
  const handoffOutput = schemas.mcpReviewHandoffResultSchema;
  server.registerTool("narriflow_create_review_handoff", { ...config("Prepare client review", "Check finished exports against client review rules and return a Narriflow link that opens the review composer with them selected. Creates and sends nothing.", handoffOutput), inputSchema: schemas.mcpCreateReviewHandoffSchema }, (input) => execute("narriflow_create_review_handoff", handoffOutput, async (current) => {
    const actor = await workspace("narriflow_create_review_handoff", current, input.workspaceId);
    const selection = await reviewService.prepareHandoff(actor, input.items);
    const composerUrl = `${appOrigin}/projects/${selection.projectId}?tab=review&reviewSelection=${encodeURIComponent(encodeReviewSelection(selection.items))}`;
    return { data: { projectId: selection.projectId, composerUrl, items: selection.items, nextStep: "A signed-in member sets recipients and sends the round in Narriflow" } };
  }));
  const roundUrl = (round: { projectId: string }) => `${appOrigin}/projects/${round.projectId}?tab=review`;
  const roundsOutput = schemas.mcpReviewRoundsResultSchema;
  server.registerTool("narriflow_list_review_rounds", { ...config("List review rounds", "List recent client review rounds with status and per-clip decisions", roundsOutput), inputSchema: schemas.mcpListReviewRoundsSchema }, (input) => execute("narriflow_list_review_rounds", roundsOutput, async (current) => {
    const actor = await workspace("narriflow_list_review_rounds", current, input.workspaceId);
    const rounds = await reviewService.listRoundSummaries(actor, { projectId: input.projectId, limit: input.limit });
    return { data: { rounds: rounds.map((round) => ({ ...round, reviewUrl: roundUrl(round) })) } };
  }));
  const roundOutput = schemas.mcpReviewRoundResultSchema;
  server.registerTool("narriflow_get_review_round", { ...config("Get review round", "Read whether the client approved or requested changes, per clip, with comment counts", roundOutput), inputSchema: schemas.mcpGetReviewRoundSchema }, (input) => execute("narriflow_get_review_round", roundOutput, async (current) => {
    const actor = await workspace("narriflow_get_review_round", current, input.workspaceId);
    const round = await reviewService.getRoundSummary(actor, input.roundId);
    return { data: { round: { ...round, reviewUrl: roundUrl(round) } } };
  }));
  const accountsOutput = schemas.mcpAccountsResultSchema;
  server.registerTool("narriflow_list_social_accounts", { ...config("List publishing accounts", "List destinations and their current connection status without credentials", accountsOutput), inputSchema: schemas.mcpListSocialAccountsSchema }, (input) => execute("narriflow_list_social_accounts", accountsOutput, async (current) => ({ data: await socialAccountsView(await workspace("narriflow_list_social_accounts", current, input.workspaceId)) })));
  const proposedOutput = schemas.mcpProposedSocialPostResultSchema;
  server.registerTool("narriflow_propose_social_post", { ...config("Propose social post", "Add a clip's finished export to an account's Publishing Queue as a draft caption. Nothing is scheduled or published: a person accepts it in Narriflow, which gives it the account's next free posting slot. Use narriflow_list_social_accounts for accounts and their posting slots", proposedOutput, write), inputSchema: schemas.mcpProposeSocialPostSchema }, (input) => execute("narriflow_propose_social_post", proposedOutput, async (current) => {
    const actor = await workspace("narriflow_propose_social_post", current, input.workspaceId);
    const result = await proposeSocialPost(actor, { clipId: input.clipId, exportId: input.exportId, socialAccountId: input.socialAccountId, caption: input.caption }, mutation("narriflow_propose_social_post", current, actor.workspaceId, input.clientIdempotencyKey));
    return { data: { proposal: result.proposal, queueUrl: `${appOrigin}/calendar/queue`, replayed: result.replayed } };
  }));
  server.registerTool("narriflow_get_publishing_options", { ...config("Get publishing options", "Read provider limits and account-specific publishing choices", schemas.mcpPublishingOptionsResultSchema, { ...readOnly, openWorldHint: true }), inputSchema: schemas.mcpPublishingOptionsSchema }, (input) => execute("narriflow_get_publishing_options", schemas.mcpPublishingOptionsResultSchema, async (current) => {
    const options = await socialPublishingOptions(await workspace("narriflow_get_publishing_options", current, input.workspaceId), input.accountId);
    return { data: { accountId: input.accountId, platform: options.platform, directEnabled: options.directEnabled, inboxEnabled: options.inboxEnabled, privacyOptions: options.privacyOptions, commentDisabled: options.commentDisabled, duetDisabled: options.duetDisabled, stitchDisabled: options.stitchDisabled, maximumDurationSec: options.maximumDurationSec, textLimit: options.capability.textLimit, aspectRatios: options.capability.aspectRatios, confirmationRequired: true } };
  }));
  server.registerTool("narriflow_prepare_social_post", { ...config("Prepare exact social post", "Preview the exact export, revision, destination, caption, settings and time; this does not approve publication", schemas.mcpPreparedPublicationSchema, write, "publication-confirmation"), inputSchema: schemas.mcpPrepareSocialPostSchema }, (input) => execute("narriflow_prepare_social_post", schemas.mcpPreparedPublicationSchema, async (current) => {
    const actor = await workspace("narriflow_prepare_social_post", current, input.workspaceId);
    let accountDisplayName = "";
    // The receipt stores only the credential-neutral intent. Each acceptance
    // and replay mints a continuation for the credential calling now.
    const accepted = await getOperationReceiptExecutor().execute({ identity: { workspaceId: actor.workspaceId, actorUserId: current.userId, command: "prepare_social_post", clientIdempotencyKey: input.clientIdempotencyKey }, input,
      authorize: async () => { await workspace("narriflow_prepare_social_post", current, input.workspaceId); }, beforeAccept: mutation("narriflow_prepare_social_post", current, actor.workspaceId, input.clientIdempotencyKey).beforeAccept,
      prepare: async () => {
        const [clip, exportSnapshot, accounts] = await Promise.all([clipService.getClipReviewFacts(actor, input.projectId, input.clipId), clipExportService.getOwned(actor, input.projectId, input.clipId, input.clipExportId), socialOAuthService.listAccounts(actor)]);
        const account = accounts.find((account) => account.id === input.accountId && account.platform === input.platform && account.status === "active");
        if (!account) unavailable("social_account_unavailable", "Reconnect the selected publishing account", "unavailable");
        const variant = exportSnapshot?.variants.find((variant) => variant.id === input.clipExportVariantId && variant.aspectRatio === input.aspectRatio && variant.resolution === input.resolution);
        if (clip.editorRevision !== input.expectedEditorRevision || exportSnapshot?.editorRevision !== input.expectedEditorRevision || !variant) unavailable("publication_export_mismatch", "Review the current clip revision and select its exact export variant");
        accountDisplayName = account.displayName;
      }, mutate: async () => ({ resourceType: "project", resourceId: input.projectId,
        value: { intent: input, accountDisplayName, digest: mcpPreparationDigest(input), expiresAtMs: Date.now() + MCP_CONTINUATION_TTL_MS } }),
    });
    const prepared = createMcpConfirmation(current, accepted.value.intent, { expiresAtMs: accepted.value.expiresAtMs });
    return { data: { status: "confirmation_required" as const, intent: accepted.value.intent, accountDisplayName: accepted.value.accountDisplayName, preparationToken: prepared.token, confirmationUrl: `${appOrigin}/integrations/mcp/confirm?token=${encodeURIComponent(prepared.token)}`, expiresAt: prepared.expiresAt } };
  }));
  const scheduledOutput = schemas.mcpScheduledPublicationResultSchema;
  const scheduledOutcome = (post: Awaited<ReturnType<typeof socialPublicationScheduling.schedule>>) => ({ data: { socialPostId: post.id, projectId: post.projectId, clipId: post.clipId, status: post.status, scheduledFor: post.frozen.scheduledFor.toISOString(), reviewUrl: `${appOrigin}/projects/${post.projectId}?tab=publishing`, statusTool: "narriflow_get_social_publication" } });
  server.registerTool("narriflow_schedule_social_post", { ...config("Schedule confirmed social post", "Schedule only the exact signed intent after user confirmation; rechecks current review approval", scheduledOutput, write), inputSchema: schemas.mcpScheduleSocialPostSchema }, (input, context) => execute("narriflow_schedule_social_post", scheduledOutput, async (current) => {
    const actor = await workspace("narriflow_schedule_social_post", current, input.workspaceId);
    const binding = { principal: current, workspaceId: actor.workspaceId, clientIdempotencyKey: input.clientIdempotencyKey };
    const prepared = verifyMcpPreparation(input.preparationToken, { ...binding, allowExpired: true });
    const accepted = await socialPublicationScheduling.replay({ ...prepared.intent, actorUserId: current.userId, scheduledFor: new Date(prepared.intent.scheduledFor) }, { actor });
    if (accepted) return scheduledOutcome(accepted);
    let receipt = input.confirmationReceipt;
    if (!receipt) {
      verifyMcpPreparation(input.preparationToken, binding);
      const response = inputResponse(context.mcpReq.inputResponses, "confirmPost");
      if (response.kind === "elicit" && response.action !== "accept") unavailable("mcp_confirmation_declined", "The publication was not confirmed");
      const confirmed = acceptedContent(context.mcpReq.inputResponses, "confirmPost", schemas.mcpElicitationConfirmationSchema);
      const echoed = context.mcpReq.requestState<{ digest: string }>();
      if (confirmed && echoed?.digest === prepared.digest) receipt = acceptMcpConfirmation(input.preparationToken, { actorUserId: current.userId, accepted: true });
      else if ((context.mcpReq.envelope as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28" && ((context.mcpReq.envelope as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientCapabilities"] as ClientCapabilities | undefined)?.elicitation?.form) {
        return inputRequired({ requestState: input.preparationToken, inputRequests: { confirmPost: inputRequired.elicit({ message: `Confirm this exact post: ${JSON.stringify(prepared.intent)}`, requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Schedule this exact post" } }, required: ["confirm"] } }) } });
      } else unavailable("mcp_confirmation_required", "Confirm this exact post using the preparation's Narriflow confirmation link or assistant card", "forbidden");
    }
    const { intent } = verifyMcpConfirmation(input.preparationToken, receipt, current, actor.workspaceId, input.clientIdempotencyKey, { allowExpired: true });
    const post = await socialPublicationScheduling.schedule({ ...intent, actorUserId: current.userId, scheduledFor: new Date(intent.scheduledFor), beforeAccept: async () => { verifyMcpConfirmation(input.preparationToken, receipt!, current, actor.workspaceId, input.clientIdempotencyKey); await mutation("narriflow_schedule_social_post", current, actor.workspaceId, input.clientIdempotencyKey).beforeAccept?.(); } }, { actor });
    return scheduledOutcome(post);
  }));
  const publicationsOutput = schemas.mcpPublicationsResultSchema;
  server.registerTool("narriflow_list_social_publications", { ...config("List social publications", "List a project's scheduled and published social posts", publicationsOutput), inputSchema: schemas.mcpListSocialPublicationsSchema }, (input) => execute("narriflow_list_social_publications", publicationsOutput, async (current) => {
    const page = await socialService.listProjectPosts(await workspace("narriflow_list_social_publications", current, input.workspaceId), input.projectId, { cursor: input.cursor });
    return { data: { items: page.items.map((post) => mcpPublication(post, appOrigin)), nextCursor: page.nextCursor } };
  }));
  server.registerTool("narriflow_get_social_publication", { ...config("Inspect social publication", "Inspect existing attempt outcomes and available recovery actions", schemas.mcpPublicationRecoverySchema), inputSchema: schemas.mcpGetPublicationSchema }, (input) => execute("narriflow_get_social_publication", schemas.mcpPublicationRecoverySchema, async (current) => ({ data: mcpPublicationRecovery(await socialService.inspectPublication(await workspace("narriflow_get_social_publication", current, input.workspaceId), input.socialPostId), appOrigin) })));
  const rulesOutput = schemas.mcpAutopilotRulesResultSchema;
  server.registerTool("narriflow_list_autopilot_rules", { ...config("List RSS autopilot rules", "Read rule schedules, Recipe, status, and why a rule is paused", rulesOutput), inputSchema: schemas.mcpWorkspaceOnlySchema }, (input) => execute("narriflow_list_autopilot_rules", rulesOutput, async (current) => ({ data: { rules: (await autopilotService.listRules(await workspace("narriflow_list_autopilot_rules", current, input.workspaceId))).map(mcpAutopilotRule) } })));
  const ruleOutput = schemas.mcpAutopilotRuleResultSchema;
  server.registerTool("narriflow_create_rss_autopilot_rule", { ...config("Create RSS autopilot rule", "Create a rule that imports each new episode with a Recipe (see narriflow_list_recipes), with caller retry identity", ruleOutput, write), inputSchema: schemas.mcpCreateAutopilotSchema }, (input) => execute("narriflow_create_rss_autopilot_rule", ruleOutput, async (current) => {
    const actor = await workspace("narriflow_create_rss_autopilot_rule", current, input.workspaceId);
    const rule = await autopilotService.createRule(actor, { name: input.name, rssUrl: input.rssUrl, titlePrefix: input.titlePrefix ?? null, intervalMinutes: input.intervalMinutes, maxEpisodesPerRun: input.maxEpisodesPerRun, recipeId: input.recipeId }, mutation("narriflow_create_rss_autopilot_rule", current, actor.workspaceId, input.clientIdempotencyKey), current);
    return { data: { rule: mcpAutopilotRule(rule) } };
  }));
  server.registerTool("narriflow_run_autopilot_rule_now", { ...config("Run autopilot rule now", "Mark the rule due for the worker's next poll", ruleOutput, write), inputSchema: schemas.mcpRunAutopilotSchema }, (input) => execute("narriflow_run_autopilot_rule_now", ruleOutput, async (current) => {
    const actor = await workspace("narriflow_run_autopilot_rule_now", current, input.workspaceId);
    return { data: { rule: mcpAutopilotRule(await autopilotService.triggerRuleNow(actor, input.ruleId, mutation("narriflow_run_autopilot_rule_now", current, actor.workspaceId, input.clientIdempotencyKey))) } };
  }));
  const recoveryOutput = schemas.mcpRecoveryMutationResultSchema;
  server.registerTool("narriflow_recheck_social_publication", { ...config("Recheck social publication", "Reconcile the existing provider operation without resubmitting", recoveryOutput, write), inputSchema: schemas.mcpRecoverySchema }, (input) => execute("narriflow_recheck_social_publication", recoveryOutput, async (current) => {
    const actor = await workspace("narriflow_recheck_social_publication", current, input.workspaceId);
    return { data: await socialService.recheckPublication(actor, input.socialPostId, { reason: input.reason }, undefined, mutation("narriflow_recheck_social_publication", current, actor.workspaceId, input.clientIdempotencyKey)) };
  }));
  server.registerTool("narriflow_confirm_social_publication", { ...config("Confirm social publication", "Record operator evidence without creating another provider submission", recoveryOutput, write), inputSchema: schemas.mcpConfirmSocialPublicationSchema }, (input) => execute("narriflow_confirm_social_publication", recoveryOutput, async (current) => {
    const actor = await workspace("narriflow_confirm_social_publication", current, input.workspaceId);
    return { data: await socialService.confirmPublication(actor, input.socialPostId, { reason: input.reason, evidenceKind: input.evidenceKind, providerReference: input.providerReference, externalUrl: input.externalUrl }, undefined, mutation("narriflow_confirm_social_publication", current, actor.workspaceId, input.clientIdempotencyKey)) };
  }));
  server.registerTool("narriflow_publish_social_publication_again", { ...config("Publish social publication again", "Create a new attempt only with explicit duplicate-risk acknowledgement", recoveryOutput, { ...write, destructiveHint: true }), inputSchema: schemas.mcpRepublishSchema }, (input) => execute("narriflow_publish_social_publication_again", recoveryOutput, async (current) => {
    const actor = await workspace("narriflow_publish_social_publication_again", current, input.workspaceId);
    return { data: await socialService.republishPublication(actor, input.socialPostId, { reason: input.reason, duplicateRiskAcknowledged: input.duplicateRiskAcknowledged }, undefined, mutation("narriflow_publish_social_publication_again", current, actor.workspaceId, input.clientIdempotencyKey)) };
  }));
  registerNarriflowMcpApps(server, { appOrigin, protocolEra: options.protocolEra, connectDomains: options.appConnectDomains, resourceDomains: options.appResourceDomains,
    callUpload: async (action, input) => {
      try {
      const current = await currentPrincipal();
      const requestedWorkspaceId = z.string().uuid().parse(input.workspaceId);
      const actor = await workspace("narriflow_upload_video", current, requestedWorkspaceId);
      const { workspaceId: _workspaceId, ...body } = input;
      const assertNewMutationAllowed = async () => { await options.assertNewMutationAllowed?.({ tool: "narriflow_upload_video", principal: current, workspaceId: actor.workspaceId }); };
      if (action === "discard") await assertNewMutationAllowed();
      const outcome = action === "open" ? await uploadSessions.open(actor, schemas.openUploadSessionSchema.parse(body), assertNewMutationAllowed, current)
        : action === "status" ? await uploadSessions.status(actor, schemas.readUploadSessionSchema.parse(body))
        : action === "grants" ? await uploadSessions.grant(actor, schemas.grantUploadPartsSchema.parse(body))
        : action === "finalize" ? await uploadSessions.finalize(actor, schemas.finalizeUploadSessionSchema.parse(body), {}, assertNewMutationAllowed)
        : await uploadSessions.discard(actor, schemas.discardUploadSessionSchema.parse(body));
      // The private adapter payload is for the embedded client. Grants and media
      // access locations never appear in model-visible content or structuredContent.
      // A finalized upload is its intake operation: the Upload Session follows
      // verification, import, and the generation it hands off to.
      const operation = action === "finalize" && (outcome.outcome === "queued_for_ingest" || outcome.outcome === "reconciling")
        ? { operation: { kind: "intake" as const, id: outcome.sessionId }, statusTool: operationStatusTool } : {};
      const recipe = "recipe" in outcome && outcome.recipe ? { recipe: outcome.recipe } : {};
      const visible = { action, outcome: outcome.outcome, ...operation, ...recipe };
      return { content: [{ type: "text", text: JSON.stringify(visible) }], structuredContent: visible, _meta: { uploadTransfer: outcome }, ttlMs: 0, cacheScope: "private" };
      } catch (error) { return mcpToolFailure(error); }
    },
    acceptPublication: async (input) => {
      try {
      const current = await currentPrincipal();
      await workspace("narriflow_schedule_social_post", current, input.workspaceId);
      verifyMcpPreparation(input.token, { principal: current, workspaceId: input.workspaceId });
      const receipt = acceptMcpConfirmation(input.token, { actorUserId: current.userId, accepted: input.accepted });
      return { content: [{ type: "text", text: "Publication intent confirmed" }], structuredContent: { status: "confirmed" }, _meta: { confirmationReceipt: receipt }, ttlMs: 0, cacheScope: "private" };
      } catch (error) { return mcpToolFailure(error); }
    },
  });
  return server;
}
