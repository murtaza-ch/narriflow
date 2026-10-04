import { acceptedContent, inputRequired, inputResponse, type InputRequiredResult, type ToolAnnotations, type ClientCapabilities } from "@modelcontextprotocol/server";
import { autopilotService, clipService, clipExportService, projectService, socialService, socialOAuthService, socialPublishingOptions, socialPublicationScheduling, uploadSessionService, workspaceService, workspaceLibraryService, getMcpOperationExecutor, isExpectedDomainFailure, ExpectedDomainFailureError, type McpMutationOptions } from "@narriflow/services";
import * as schemas from "@narriflow/validators";
import * as z from "zod/v4";
import { McpToolAdmission, mcpToolFailure, type NarriflowMcpPrincipal, type NarriflowMcpToolName } from "./mcp-tool-admission";
import { createMcpConfirmation, verifyMcpPreparation, acceptMcpConfirmation, verifyMcpConfirmation, mcpCallerId, createMcpUploadHandoff } from "./mcp-confirmation";
import { mcpProject, mcpClip, mcpExport, mcpAutopilotRule, mcpSocialAccount, mcpPublication, mcpPublicationRecovery } from "./mcp-projections";
import { registerNarriflowMcpApps, getNarriflowAppToolMeta, supportsNarriflowApps } from "./mcp-apps";
import { recordMcpDiagnostic } from "./mcp-diagnostics";
import { installNarriflowTasks, NarriflowMcpServer as McpServer } from "./mcp-tasks";

export { McpToolAdmission, MCP_TOOL_ADMISSIONS, type NarriflowMcpToolName, type NarriflowMcpPrincipal } from "./mcp-tool-admission";
export * from "./mcp-confirmation";
export { mcpProject, mcpExport } from "./mcp-projections";
export const NARRIFLOW_MCP_SERVER_NAME = "narriflow";
export const NARRIFLOW_MCP_SERVER_VERSION = "0.3.0";
export const NARRIFLOW_MCP_INSTRUCTIONS = "Start with narriflow_list_workspaces and use the returned workspaceId. Mutations require an explicit workspaceId and a fresh clientIdempotencyKey; retry unchanged input with the same key after a lost response. Active Business access and explicit application scopes are required. Submit a supported video link or use the upload picker, authenticated web handoff, or local upload command. Follow operation status with narriflow_get_project, list clips, review their editor revision in Narriflow, and request a revision-bound export. Prepare the exact social post and obtain user confirmation before scheduling. Recheck inspects an existing provider operation. Confirm publication requires evidence; publish again requires duplicate-risk acknowledgement. Media processing consumes workspace minute quota.";
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const admission = new McpToolAdmission(workspaceService);
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
  const mutation = (tool: NarriflowMcpToolName, current: NarriflowMcpPrincipal, workspaceId: string, key: string): McpMutationOptions => ({
    clientIdempotencyKey: key, callerId: mcpCallerId(current), beforeAccept: async () => { await options.assertNewMutationAllowed?.({ tool, principal: current, workspaceId }); },
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
  const workspace = (tool: Exclude<NarriflowMcpToolName, "narriflow_list_workspaces">, current: NarriflowMcpPrincipal, workspaceId?: string) => admission.requireWorkspace(tool, current, workspaceId);
  const operationMeta = (workspaceId: string, domainKind: "ingest" | "generation" | "export", domainId: string, projectId: string, clipId?: string) => ({ "narriflow/operation": { workspaceId, domainKind, domainId, projectId, ...(clipId ? { clipId } : {}) } });

  const workspacesOutput = schemas.mcpWorkspacesResultSchema;
  server.registerTool("narriflow_list_workspaces", { ...config("List workspaces", "Discover current memberships and MCP eligibility", workspacesOutput), inputSchema: schemas.mcpListWorkspacesSchema }, () => execute("narriflow_list_workspaces", workspacesOutput, async (current) => ({ data: { workspaces: await admission.listWorkspaces(current) } })));
  const projectsOutput = schemas.mcpProjectsResultSchema;
  server.registerTool("narriflow_list_projects", { ...config("List projects", "Page through workspace projects with compact progress facts", projectsOutput), inputSchema: schemas.mcpListProjectsSchema }, (input) => execute("narriflow_list_projects", projectsOutput, async (current) => {
    const actor = await workspace("narriflow_list_projects", current, input.workspaceId);
    const page = await workspaceLibraryService.listProjects(actor, { limit: input.limit, cursor: input.cursor ?? null });
    return { data: { items: page.items.map((project) => ({ ...mcpProject(project, appOrigin), progress: { ...project.progress, stage: null, percent: null }, clipCount: project.clipCount })), nextCursor: page.nextCursor, totalCount: page.totalCount } };
  }));
  const projectOutput = schemas.mcpProjectResultSchema;
  server.registerTool("narriflow_get_project", { ...config("Get project progress", "Get compact intake and generation progress; use list_clips for review", projectOutput, readOnly, "progress"), inputSchema: schemas.mcpGetProjectSchema }, (input) => execute("narriflow_get_project", projectOutput, async (current) => {
    const actor = await workspace("narriflow_get_project", current, input.workspaceId);
    const snapshot = await projectService.getProjectSnapshot(actor, input.projectId);
    return { data: { project: snapshot.project ? mcpProject(snapshot.project, appOrigin) : null, progress: snapshot.progress ? { ...snapshot.progress, stage: snapshot.activeRun?.stage ?? null, percent: snapshot.activeRun?.progress ?? null } : null } };
  }));
  const usageOutput = schemas.mcpWorkspaceUsageResultSchema;
  server.registerTool("narriflow_get_workspace_usage", { ...config("Get workspace usage", "Read the current plan, processing budget and upload limit", usageOutput), inputSchema: schemas.mcpWorkspaceOnlySchema }, (input) => execute("narriflow_get_workspace_usage", usageOutput, async (current) => ({ data: await projectService.getUsageSummary(await workspace("narriflow_get_workspace_usage", current, input.workspaceId)) })));
  const clipsOutput = schemas.mcpClipsResultSchema;
  server.registerTool("narriflow_list_clips", { ...config("List clips", "Page clips ranked by virality; transcript excerpts are opt-in", clipsOutput), inputSchema: schemas.mcpListClipsSchema }, (input) => execute("narriflow_list_clips", clipsOutput, async (current) => {
    const actor = await workspace("narriflow_list_clips", current, input.workspaceId);
    const page = await clipService.listClipReviewFacts(actor, input.projectId, input);
    return { data: { items: page.items.map((clip) => mcpClip(clip, appOrigin, input.includeTranscriptExcerpt)), nextCursor: page.nextCursor } };
  }));
  const clipOutput = schemas.mcpClipResultSchema;
  server.registerTool("narriflow_get_clip", { ...config("Review a clip", "Read timing, scores and editor revision, then open visual review in Narriflow", clipOutput, readOnly, "clip-review"), inputSchema: schemas.mcpGetClipSchema }, (input) => execute("narriflow_get_clip", clipOutput, async (current) => {
    const actor = await workspace("narriflow_get_clip", current, input.workspaceId);
    const facts = await clipService.getClipReviewFacts(actor, input.projectId, input.clipId, input);
    const preview = supportsNarriflowApps(server.server.getClientCapabilities(), options.protocolEra) && facts.hasPreview ? await clipService.getClipPreviewSource(actor, input.projectId, input.clipId) : null;
    return { data: { clip: mcpClip(facts, appOrigin, input.includeTranscriptExcerpt) }, ...(preview?.previewUrl ? { _meta: { previewMediaUrl: preview.previewUrl, previewStartSec: preview.previewStartSec, previewDurationSec: preview.previewDurationSec } } : {}) };
  }));
  server.registerTool("narriflow_submit_video", { ...config("Submit a video link", "Atomically import supported media with committed clip generation settings", schemas.mcpOperationSchema, write, "progress"), inputSchema: schemas.mcpSubmitVideoSchema }, (input) => execute("narriflow_submit_video", schemas.mcpOperationSchema, async (current) => {
    const actor = await workspace("narriflow_submit_video", current, input.workspaceId);
    const accepted = await projectService.queueLinkIngest(actor, { url: input.url, title: input.title, commitToken: input.clientIdempotencyKey }, { generationContext: { contentPack: schemas.buildMcpContentPack(input.generation), languageCode: input.generation.languageCode }, mutation: mutation("narriflow_submit_video", current, actor.workspaceId, input.clientIdempotencyKey) });
    if (!accepted.queuedJobId) unavailable("mcp_ingest_operation_missing", "The accepted import has no operation identifier", "unavailable");
    return { data: { projectId: accepted.project.id, operationId: accepted.queuedJobId, operationKind: "ingest", status: "accepted", statusTool: "narriflow_get_project", reviewUrl: `${appOrigin}/projects/${accepted.project.id}` }, _meta: operationMeta(actor.workspaceId, "ingest", accepted.queuedJobId, accepted.project.id) };
  }));
  server.registerTool("narriflow_generate_clips", { ...config("Generate clips", "Start generation on a ready project using quota admission and durable retries", schemas.mcpOperationSchema, write, "progress"), inputSchema: schemas.mcpGenerateClipsSchema }, (input) => execute("narriflow_generate_clips", schemas.mcpOperationSchema, async (current) => {
    const actor = await workspace("narriflow_generate_clips", current, input.workspaceId);
    const accepted = await projectService.triggerGeneration(actor, input.projectId, { contentPack: schemas.buildMcpContentPack(input.generation), languageCode: input.generation.languageCode, forceRegenerate: input.forceRegenerate }, input.clientIdempotencyKey, { mutation: mutation("narriflow_generate_clips", current, actor.workspaceId, input.clientIdempotencyKey) });
    return { data: { projectId: input.projectId, operationId: accepted.workflowRunId, operationKind: "generation", status: "accepted", statusTool: "narriflow_get_project", reviewUrl: `${appOrigin}/projects/${input.projectId}` }, _meta: operationMeta(actor.workspaceId, "generation", accepted.workflowRunId, input.projectId) };
  }));
  server.registerTool("narriflow_upload_video", { ...config("Upload a video", "Open an assistant picker or authenticated upload handoff; file bytes transfer directly to storage", schemas.mcpUploadHandoffSchema, write, "upload"), inputSchema: schemas.mcpUploadVideoSchema }, (input) => execute("narriflow_upload_video", schemas.mcpUploadHandoffSchema, async (current) => {
    const actor = await workspace("narriflow_upload_video", current, input.workspaceId);
    const handoff = createMcpUploadHandoff(current, input);
    return { data: { workspaceId: actor.workspaceId, status: "awaiting_file", handoffUrl: `${appOrigin}/integrations/mcp/upload?intent=${encodeURIComponent(handoff.token)}`, localUploadCommand: "bun run mcp:upload --file <path> --workspace <workspaceId> --key <clientIdempotencyKey>", confirmationExpiresAt: handoff.expiresAt }, _meta: { uploadContext: { workspaceId: actor.workspaceId, clientIdempotencyKey: input.clientIdempotencyKey, title: input.title, generationContext: { contentPack: schemas.buildMcpContentPack(input.generation), languageCode: input.generation.languageCode } } } };
  }));
  const exportOutput = schemas.mcpClipExportResultSchema;
  server.registerTool("narriflow_create_clip_export", { ...config("Create clip export", "Export the exact reviewed editor revision in explicitly selected formats", exportOutput, write, "progress"), inputSchema: schemas.mcpCreateClipExportSchema }, (input) => execute("narriflow_create_clip_export", exportOutput, async (current) => {
    const actor = await workspace("narriflow_create_clip_export", current, input.workspaceId);
    const accepted = await clipExportService.create(actor, input.projectId, input.clipId, { expectedRevision: input.expectedRevision, aspectRatios: input.aspectRatios, resolution: input.resolution }, input.clientIdempotencyKey, mutation("narriflow_create_clip_export", current, actor.workspaceId, input.clientIdempotencyKey));
    return { data: { export: mcpExport(accepted.export, appOrigin), reused: accepted.reused }, _meta: operationMeta(actor.workspaceId, "export", accepted.export.id, input.projectId, input.clipId) };
  }));
  server.registerTool("narriflow_get_clip_export", { ...config("Get clip export", "Read export progress and an ordinary Narriflow review/download link", exportOutput), inputSchema: schemas.mcpGetClipExportSchema }, (input) => execute("narriflow_get_clip_export", exportOutput, async (current) => {
    const snapshot = await clipExportService.getOwned(await workspace("narriflow_get_clip_export", current, input.workspaceId), input.projectId, input.clipId, input.exportId);
    if (!snapshot) unavailable("clip_export_not_found", "Clip export was not found", "missing");
    return { data: { export: mcpExport(snapshot, appOrigin) } };
  }));
  const accountsOutput = schemas.mcpAccountsResultSchema;
  server.registerTool("narriflow_list_social_accounts", { ...config("List publishing accounts", "List destinations and their current connection status without credentials", accountsOutput), inputSchema: schemas.mcpListSocialAccountsSchema }, (input) => execute("narriflow_list_social_accounts", accountsOutput, async (current) => ({ data: { accounts: (await socialOAuthService.listAccounts(await workspace("narriflow_list_social_accounts", current, input.workspaceId))).map(mcpSocialAccount) } })));
  server.registerTool("narriflow_get_publishing_options", { ...config("Get publishing options", "Read provider limits and account-specific publishing choices", schemas.mcpPublishingOptionsResultSchema, { ...readOnly, openWorldHint: true }), inputSchema: schemas.mcpPublishingOptionsSchema }, (input) => execute("narriflow_get_publishing_options", schemas.mcpPublishingOptionsResultSchema, async (current) => {
    const options = await socialPublishingOptions(await workspace("narriflow_get_publishing_options", current, input.workspaceId), input.accountId);
    return { data: { accountId: input.accountId, platform: options.platform, directEnabled: options.directEnabled, inboxEnabled: options.inboxEnabled, privacyOptions: options.privacyOptions, commentDisabled: options.commentDisabled, duetDisabled: options.duetDisabled, stitchDisabled: options.stitchDisabled, maximumDurationSec: options.maximumDurationSec, textLimit: options.capability.textLimit, aspectRatios: options.capability.aspectRatios, confirmationRequired: true } };
  }));
  server.registerTool("narriflow_prepare_social_post", { ...config("Prepare exact social post", "Preview the exact export, revision, destination, caption, settings and time; this does not approve publication", schemas.mcpPreparedPublicationSchema, write, "publication-confirmation"), inputSchema: schemas.mcpPrepareSocialPostSchema }, (input) => execute("narriflow_prepare_social_post", schemas.mcpPreparedPublicationSchema, async (current) => {
    const actor = await workspace("narriflow_prepare_social_post", current, input.workspaceId);
    let accountDisplayName = "";
    const accepted = await getMcpOperationExecutor().execute({ identity: { workspaceId: actor.workspaceId, callerId: mcpCallerId(current), toolName: "narriflow_prepare_social_post", clientIdempotencyKey: input.clientIdempotencyKey }, input,
      authorize: async () => { await workspace("narriflow_prepare_social_post", current, input.workspaceId); }, beforeAccept: mutation("narriflow_prepare_social_post", current, actor.workspaceId, input.clientIdempotencyKey).beforeAccept,
      prepare: async () => {
        const [clip, exportSnapshot, accounts] = await Promise.all([clipService.getClipReviewFacts(actor, input.projectId, input.clipId), clipExportService.getOwned(actor, input.projectId, input.clipId, input.clipExportId), socialOAuthService.listAccounts(actor)]);
        const account = accounts.find((account) => account.id === input.accountId && account.platform === input.platform && account.status === "active");
        if (!account) unavailable("social_account_unavailable", "Reconnect the selected publishing account", "unavailable");
        const variant = exportSnapshot?.variants.find((variant) => variant.id === input.clipExportVariantId && variant.aspectRatio === input.aspectRatio && variant.resolution === input.resolution);
        if (clip.editorRevision !== input.expectedEditorRevision || exportSnapshot?.editorRevision !== input.expectedEditorRevision || !variant) unavailable("publication_export_mismatch", "Review the current clip revision and select its exact export variant");
        accountDisplayName = account.displayName;
      }, mutate: async () => {
        const prepared = createMcpConfirmation(current, input);
        return { resourceType: "project", resourceId: input.projectId, value: { status: "confirmation_required" as const, intent: input, accountDisplayName, preparationToken: prepared.token, confirmationUrl: `${appOrigin}/integrations/mcp/confirm?token=${encodeURIComponent(prepared.token)}`, expiresAt: prepared.expiresAt } };
      },
    });
    return { data: accepted.value };
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
  server.registerTool("narriflow_list_autopilot_rules", { ...config("List RSS autopilot rules", "Read rule schedules and product status", rulesOutput), inputSchema: schemas.mcpWorkspaceOnlySchema }, (input) => execute("narriflow_list_autopilot_rules", rulesOutput, async (current) => ({ data: { rules: (await autopilotService.listRules(await workspace("narriflow_list_autopilot_rules", current, input.workspaceId))).map(mcpAutopilotRule) } })));
  const ruleOutput = schemas.mcpAutopilotRuleResultSchema;
  server.registerTool("narriflow_create_rss_autopilot_rule", { ...config("Create RSS autopilot rule", "Create a rule with committed generation defaults and caller retry identity", ruleOutput, write), inputSchema: schemas.mcpCreateAutopilotSchema }, (input) => execute("narriflow_create_rss_autopilot_rule", ruleOutput, async (current) => {
    const actor = await workspace("narriflow_create_rss_autopilot_rule", current, input.workspaceId);
    const rule = await autopilotService.createRule(actor, { name: input.name, rssUrl: input.rssUrl, titlePrefix: input.titlePrefix ?? null, intervalMinutes: input.intervalMinutes, maxEpisodesPerRun: input.maxEpisodesPerRun, contentPack: schemas.buildMcpContentPack(input.generation), languageCode: input.generation.languageCode }, mutation("narriflow_create_rss_autopilot_rule", current, actor.workspaceId, input.clientIdempotencyKey));
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
      if (action === "open") {
        const opening = schemas.openUploadSessionSchema.parse(body);
        try { await mutation("narriflow_upload_video", current, actor.workspaceId, opening.clientIdempotencyKey).beforeAccept?.(); }
        catch (limiterError) {
          if (!isExpectedDomainFailure(limiterError) || limiterError.code !== "mcp_mutations_unavailable") throw limiterError;
          try { await uploadSessionService.status(actor, { clientIdempotencyKey: opening.clientIdempotencyKey, sessionId: null, browserFingerprint: opening.source.browserFingerprint }); }
          catch (lookupError) { if (isExpectedDomainFailure(lookupError) && lookupError.code === "upload_session_not_found") throw limiterError; throw lookupError; }
        }
      } else if (action === "discard") await options.assertNewMutationAllowed?.({ tool: "narriflow_upload_video", principal: current, workspaceId: actor.workspaceId });
      const outcome = action === "open" ? await uploadSessionService.open(actor, schemas.openUploadSessionSchema.parse(body))
        : action === "status" ? await uploadSessionService.status(actor, schemas.readUploadSessionSchema.parse(body))
        : action === "grants" ? await uploadSessionService.grant(actor, schemas.grantUploadPartsSchema.parse(body))
        : action === "finalize" ? await uploadSessionService.finalize(actor, schemas.finalizeUploadSessionSchema.parse(body))
        : await uploadSessionService.discard(actor, schemas.discardUploadSessionSchema.parse(body));
      // The private adapter payload is for the embedded client. Grants and media
      // access locations never appear in model-visible content or structuredContent.
      return { content: [{ type: "text", text: JSON.stringify({ action, outcome: outcome.outcome }) }], structuredContent: { action, outcome: outcome.outcome }, _meta: { uploadTransfer: outcome }, ttlMs: 0, cacheScope: "private" };
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
