import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { autopilotService, clipService, clipExportService, projectService, recipeService, socialPublicationScheduling, workspaceService, ExpectedDomainFailureError } from "@narriflow/services";
import { buildNarriflowMcpServer, type NarriflowMcpPrincipal, type NarriflowMcpServerOptions } from "./index";
import * as services from "@narriflow/services";
import { buildGenerationContentPack } from "@narriflow/validators";
import { createMcpConfirmation, acceptMcpConfirmation, verifyMcpPreparation } from "./mcp-confirmation";
const userId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const principal = { kind: "oauth" as const, userId, clientId: "test-client", scopes: ["projects:read"] };
const clients: Client[] = [];
const mocks: Array<{ mockRestore(): void }> = [];
afterEach(async () => { for (const mock of mocks.splice(0)) mock.mockRestore(); await Promise.all(clients.splice(0).map((client) => client.close())); });
async function connect(subject: NarriflowMcpPrincipal = principal, options: NarriflowMcpServerOptions = {}, confirm?: () => boolean, mode: "auto" | "legacy" = "auto") {
  const handler = createMcpHandler(({ era }) => buildNarriflowMcpServer(subject, { appOrigin: "https://narriflow.test", protocolEra: era, ...options }));
  const client = new Client({ name: "workflow-test", version: "1" }, { versionNegotiation: { mode }, capabilities: { ...(confirm ? { elicitation: { form: {} } } : {}), ...(mode === "legacy" ? { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } : {}) } });
  if (confirm) client.setRequestHandler("elicitation/create", async () => ({ action: confirm() ? "accept" : "decline", content: { confirm: true } }));
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL("https://narriflow.test/mcp"), { fetch: (input, init) => handler.fetch(new Request(input, init)) }));
  return client;
}
describe("Compact MCP workflow", () => {
  test("project progress contains product facts and never loads a transcript body", async () => {
    mocks.push(spyOn(workspaceService, "requireActor").mockResolvedValue({ actorUserId: userId, workspaceId, workspaceName: "Team", workspaceOwnerUserId: userId, role: "owner", status: "active", pricingTier: "business", isPersonalWorkspace: true }));
    mocks.push(spyOn(projectService, "getProjectSnapshot").mockResolvedValue({ project: { id: projectId, workspaceId, createdByUserId: userId, title: "A test project", sourceType: "upload", sourceMediaUrl: "private-url", sourceStorageKey: "private-key", sourceProvider: "internal", sourceInput: null, sourceMimeType: "video/mp4", sourceSizeBytes: 12, sourceDurationSeconds: 45, languageCode: "en", brandProfileId: null, brandTemplateId: null, ingestStatus: "ready", ingestErrorCode: null, ingestCompletedAt: null, notifyOnComplete: false, retentionPolicyKey: null, expiresAt: null, persisted: true, createdAt: "2026-10-05T00:00:00.000Z" }, progress: { status: "ready", active: false, label: "Ready" }, activeRun: null, lastSeq: 4, ingestAttemptCount: 1 }));
    const transcript = spyOn(projectService, "getTranscriptSnapshot"); mocks.push(transcript);
    const result = await (await connect()).callTool({ name: "narriflow_get_project", arguments: { workspaceId, projectId } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ data: { project: { projectId, workspaceId, title: "A test project", sourceType: "upload", ingestStatus: "ready", durationSeconds: 45, languageCode: "en", createdAt: "2026-10-05T00:00:00.000Z", reviewUrl: `https://narriflow.test/projects/${projectId}` }, progress: { status: "ready", active: false, label: "Ready", stage: null, percent: null } } });
    expect(transcript).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-key");
  });

  test("clip paging returns review facts and fetches excerpts only on request", async () => {
    admitActor();
    const clipId = "00000000-0000-4000-8000-000000000004";
    const read = spyOn(clipService, "listClipReviewFacts").mockResolvedValue({ items: [{ id: clipId, projectId, editorRevision: 7, index: 0, status: "edited", startSec: 10, endSec: 40, durationSec: 30, title: "A useful moment", hookText: "The hook", reasoning: "Clear payoff", category: "insight", platformFit: ["youtube_shorts"], viralityScore: 80, hookStrengthScore: 75, emotionalIntensityScore: 50, storyCompletenessScore: 80, pacingScore: 70, durationOptimalityScore: 95, hasPreview: true, createdAt: "2026-10-05T00:00:00.000Z", transcriptExcerpt: "Requested words only" }], nextCursor: "next-page" });
    mocks.push(read);
    const client = await connect();
    const without = await client.callTool({ name: "narriflow_list_clips", arguments: { workspaceId, projectId } });
    expect(without.structuredContent).toMatchObject({ data: { items: [{ clipId, editorRevision: 7, scores: { virality: 80 } }], nextCursor: "next-page" } });
    expect(JSON.stringify(without.structuredContent)).not.toContain("Requested words only");
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId }), projectId, expect.objectContaining({ limit: 20, includeTranscriptExcerpt: false }));
    const withExcerpt = await client.callTool({ name: "narriflow_list_clips", arguments: { workspaceId, projectId, includeTranscriptExcerpt: true, limit: 5 } });
    expect(withExcerpt.structuredContent).toMatchObject({ data: { items: [{ transcriptExcerpt: "Requested words only" }] } });
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId }), projectId, expect.objectContaining({ limit: 5, includeTranscriptExcerpt: true }));
  });

  test("legacy clip cards receive private preview metadata without exposing it to the model", async () => {
    admitActor();
    const clipId = "00000000-0000-4000-8000-000000000004";
    mocks.push(spyOn(clipService, "getClipReviewFacts").mockResolvedValue({ id: clipId, projectId, editorRevision: 7, index: 0, status: "edited", startSec: 10, endSec: 40, durationSec: 30, title: "A useful moment", hookText: "The hook", reasoning: "Clear payoff", category: "insight", platformFit: ["youtube_shorts"], viralityScore: 80, hookStrengthScore: 75, emotionalIntensityScore: 50, storyCompletenessScore: 80, pacingScore: 70, durationOptimalityScore: 95, hasPreview: true, createdAt: "2026-10-05T00:00:00.000Z" }));
    const preview = spyOn(clipService, "getClipPreviewSource").mockResolvedValue({ previewUrl: "https://bucket.storage.test/private-preview", previewStartSec: 0, previewDurationSec: 60, waveformPeaksUrl: null });
    mocks.push(preview);
    const result = await (await connect(principal, {}, undefined, "legacy")).callTool({ name: "narriflow_get_clip", arguments: { workspaceId, projectId, clipId } });
    expect(result.isError).not.toBe(true);
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }), projectId, clipId);
    expect(result._meta).toMatchObject({ previewMediaUrl: "https://bucket.storage.test/private-preview", previewStartSec: 0, previewDurationSec: 60 });
    expect(JSON.stringify(result.content)).not.toContain("private-preview");
    expect(JSON.stringify(result.structuredContent)).not.toContain("private-preview");
  });

  test("generation admits the canonical settings and returns the durable workflow ID", async () => {
    admitActor();
    const operationId = "00000000-0000-4000-8000-000000000006";
    const trigger = spyOn(projectService, "triggerGeneration").mockResolvedValue({ workflowRunId: operationId, acceptedAt: "2026-10-05T00:00:00.000Z", initialSeq: 2 });
    mocks.push(trigger);
    const key = "00000000-0000-4000-8000-000000000005";
    const client = await connect({ ...principal, scopes: ["processing:write"] });
    const result = await client.callTool({ name: "narriflow_generate_clips", arguments: { workspaceId, projectId, clientIdempotencyKey: key, generation: { clipCountTarget: 6, clipLengthPreset: "under_30s" } } });
    expect(result.structuredContent).toMatchObject({ data: { projectId, operation: { kind: "generation", id: operationId }, status: "accepted", statusTool: "narriflow_get_operation" } });
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }), projectId, expect.objectContaining({ contentPack: expect.objectContaining({ clipCountTarget: 6, clipDurationSecTarget: 25, maxDurationSec: 35 }) }), services.integrationKeyUuid(userId, "generate_clips", key), expect.objectContaining({ mutation: expect.objectContaining({ clientIdempotencyKey: key }) }));
  });

  test("generation and submission carry finishing to the service, and an invalid one never reaches it", async () => {
    admitActor();
    const trigger = spyOn(projectService, "triggerGeneration").mockResolvedValue({ workflowRunId: "00000000-0000-4000-8000-000000000006", acceptedAt: "2026-10-05T00:00:00.000Z", initialSeq: 2 });
    mocks.push(trigger);
    const key = "00000000-0000-4000-8000-000000000005";
    const client = await connect({ ...principal, scopes: ["processing:write"] });
    const finishing = { topClips: 3, minScore: 50, aspectRatios: ["9:16"], copyPlatforms: ["tiktok", "x"] };
    const accepted = await client.callTool({ name: "narriflow_generate_clips", arguments: { workspaceId, projectId, clientIdempotencyKey: key, finishing } });
    expect(accepted.isError).not.toBe(true);
    // Finishing travels beside the generation input, never inside the browser's request shape.
    expect(trigger.mock.calls[0]?.[2]).not.toHaveProperty("finishing");
    expect(trigger.mock.calls[0]?.[4]).toMatchObject({ finishing: { topClips: 3, minScore: 50, aspectRatios: ["9:16"], copyPlatforms: ["tiktok", "x"], resolution: "1080p" } });

    const plain = await client.callTool({ name: "narriflow_generate_clips", arguments: { workspaceId, projectId, clientIdempotencyKey: key } });
    expect(plain.isError).not.toBe(true);
    expect(trigger.mock.calls[1]?.[4]).not.toHaveProperty("finishing", expect.anything());

    const refused = await client.callTool({ name: "narriflow_generate_clips", arguments: { workspaceId, projectId, clientIdempotencyKey: key, finishing: { topClips: 11 } } });
    expect(refused.isError).toBe(true);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  test("recipes are listed by name for choosing, without Content Pack internals", async () => {
    admitActor();
    const recipeId = "00000000-0000-4000-8000-0000000000e1";
    const list = spyOn(recipeService, "list").mockResolvedValue([{ id: recipeId, workspaceId, name: "Weekly show", revision: 3, brandProfileId: null, languageCode: "en", contentPack: buildGenerationContentPack({ clipCountTarget: 6 }), finishing: null, ruleCount: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }]);
    mocks.push(list);
    const result = await (await connect()).callTool({ name: "narriflow_list_recipes", arguments: { workspaceId } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: { recipes: [{ recipeId, name: "Weekly show", revision: 3, languageCode: "en", finishing: null, generation: { clipCountTarget: 6, defaultAspectRatio: "9:16" } }] } });
    expect(JSON.stringify(result.structuredContent)).not.toContain("platformPlaybookVersion");
  });

  test("generation and submission can name a Recipe in place of settings, and report the revision they used", async () => {
    admitActor();
    const recipeId = "00000000-0000-4000-8000-0000000000e1";
    const operationId = "00000000-0000-4000-8000-000000000006";
    const trigger = spyOn(projectService, "triggerGeneration").mockResolvedValue({ workflowRunId: operationId, acceptedAt: "2026-10-05T00:00:00.000Z", initialSeq: 2, recipe: { id: recipeId, revision: 4 } });
    const intake = spyOn(projectService, "queueLinkIngest").mockResolvedValue({ project: { id: projectId }, queuedJobId: operationId, replayed: false, receiptId: "00000000-0000-4000-8000-0000000000aa", recipe: { id: recipeId, revision: 4 } } as never);
    mocks.push(trigger, intake);
    const key = "00000000-0000-4000-8000-000000000005";
    const client = await connect({ ...principal, scopes: ["processing:write"] });

    const generated = await client.callTool({ name: "narriflow_generate_clips", arguments: { workspaceId, projectId, clientIdempotencyKey: key, recipeId } });
    expect(generated.structuredContent).toMatchObject({ data: { projectId, operation: { kind: "generation", id: operationId }, recipe: { id: recipeId, revision: 4 } } });
    // The run is asked for with the Recipe itself; nothing is read until it is accepted.
    expect(trigger.mock.calls[0]?.[2]).toMatchObject({ forceRegenerate: false, recipe: { id: recipeId } });
    expect(trigger.mock.calls[0]?.[2]).not.toHaveProperty("contentPack");

    const submitted = await client.callTool({ name: "narriflow_submit_video", arguments: { workspaceId, clientIdempotencyKey: key, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", recipeId } });
    expect(submitted.structuredContent).toMatchObject({ data: { operation: { kind: "intake", id: operationId }, recipe: { id: recipeId, revision: 4 } } });
    expect(intake.mock.calls[0]?.[2]).toMatchObject({ command: "submit_video", recipe: { id: recipeId } });
    expect(intake.mock.calls[0]?.[2]).not.toHaveProperty("generationContext");

    // A Recipe beside inline settings is a validation error and reaches no service.
    for (const [name, inline] of [["narriflow_generate_clips", { projectId, generation: { clipCountTarget: 5 } }], ["narriflow_submit_video", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", finishing: { topClips: 2 } }], ["narriflow_upload_video", { brandProfileId: userId }]] as const) {
      const refused = await client.callTool({ name, arguments: { workspaceId, clientIdempotencyKey: key, recipeId, ...inline } });
      expect(refused.isError).toBe(true);
    }
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(intake).toHaveBeenCalledTimes(1);
  });

  test("autopilot rules import with a Recipe, and a paused rule says why", async () => {
    admitActor();
    const ruleId = "00000000-0000-4000-8000-000000000007";
    const recipeId = "00000000-0000-4000-8000-000000000008";
    const key = "00000000-0000-4000-8000-000000000005";
    const rule = (overrides: Record<string, unknown>) => ({ id: ruleId, workspaceId, createdByUserId: userId, name: "Podcast", rssUrl: "https://podcast.test/feed.xml", titlePrefix: null, recipeId, recipeName: "Weekly show", intervalMinutes: 1440, maxEpisodesPerRun: 3, feedTitle: null, initialImportMode: "future_only" as const, initialImportCount: 3, status: "active" as const, pauseKind: null, lastCheckedAt: null, lastSuccessAt: null, nextRunAt: "2026-10-24T00:00:00.000Z", lastError: null, consecutiveFailures: 0, importedEpisodeCount: 0, createdAt: "2026-10-24T00:00:00.000Z", ...overrides });
    const create = spyOn(autopilotService, "createRule").mockResolvedValue(rule({}));
    const list = spyOn(autopilotService, "listRules").mockResolvedValue([rule({}), rule({ id: "00000000-0000-4000-8000-000000000009", status: "paused", pauseKind: "acting_member" as const, lastError: "Dana Lee can no longer run this rule. A Workspace Owner or Admin can take it over to resume it.", consecutiveFailures: 0 }), rule({ id: "00000000-0000-4000-8000-00000000000a", status: "failed", lastError: "feed unreachable" })]);
    mocks.push(create, list);
    const client = await connect({ ...principal, scopes: ["autopilot:read", "autopilot:write"] });
    const created = await client.callTool({ name: "narriflow_create_rss_autopilot_rule", arguments: { workspaceId, clientIdempotencyKey: key, name: "Podcast", rssUrl: "https://podcast.test/feed.xml", recipeId } });
    expect(created.isError).not.toBe(true);
    // The calling credential goes with it, so the Recipe's queue delivery is checked against its scopes.
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }), expect.objectContaining({ recipeId }), expect.anything(), expect.objectContaining({ scopes: ["autopilot:read", "autopilot:write"] }));
    // The rule carries no settings of its own: a Recipe is required, and inline ones are refused.
    const omitted = await client.callTool({ name: "narriflow_create_rss_autopilot_rule", arguments: { workspaceId, clientIdempotencyKey: key, name: "Podcast", rssUrl: "https://podcast.test/feed.xml" } });
    expect(omitted.isError).toBe(true);
    const inline = await client.callTool({ name: "narriflow_create_rss_autopilot_rule", arguments: { workspaceId, clientIdempotencyKey: key, name: "Podcast", rssUrl: "https://podcast.test/feed.xml", recipeId, brandProfileId: null } });
    expect(inline.isError).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);

    const listed = await client.callTool({ name: "narriflow_list_autopilot_rules", arguments: { workspaceId } });
    expect(listed.structuredContent).toMatchObject({ data: { rules: [
      { ruleId, status: "active", recipeId, recipeName: "Weekly show", pausedReason: null },
      { status: "paused", recipeId, pausedReason: expect.stringContaining("take it over") },
      { status: "failed", recipeId, pausedReason: null },
    ] } });
    expect(JSON.stringify(listed.structuredContent)).not.toContain("feed unreachable");
  });

  test("export review exposes the exact revision and ordinary download page without signed URLs", async () => {
    admitActor();
    const clipId = "00000000-0000-4000-8000-000000000004";
    const exportId = "00000000-0000-4000-8000-000000000005";
    const read = spyOn(clipExportService, "getOwned").mockResolvedValue({ id: exportId, projectId, clipId, clipTitle: "Clip", projectTitle: "Project", editorRevision: 7, currentEditorRevision: 8, isOlderVersion: true, resolution: "1080p", watermark: false, status: "ready", progress: 100, errorCode: null, createdAt: "2026-10-05T00:00:00.000Z", completedAt: "2026-10-05T00:01:00.000Z", variants: [{ id: "00000000-0000-4000-8000-000000000006", aspectRatio: "9:16", resolution: "1080p", watermark: false, status: "completed", sizeBytes: 50, durationSec: 30, errorCode: null, hasAsset: true, previewUrl: "https://private.example/preview?secret=temporary", downloadUrl: "https://private.example/download?secret=temporary", completedAt: "2026-10-05T00:01:00.000Z" }] });
    mocks.push(read);
    const result = await (await connect({ ...principal, scopes: ["exports:read"] })).callTool({ name: "narriflow_get_clip_export", arguments: { workspaceId, projectId, clipId, exportId } });
    expect(result.structuredContent).toMatchObject({ data: { export: { exportId, editorRevision: 7, currentEditorRevision: 8, isOlderVersion: true, reviewUrl: `https://narriflow.test/projects/${projectId}/clips/${clipId}/exports/${exportId}` } } });
    expect(JSON.stringify(result)).not.toContain("secret=temporary");
  });

  test("a prepared post without user confirmation never calls scheduling", async () => {
    await withSecret(async () => {
      admitActor();
      const schedule = spyOn(socialPublicationScheduling, "schedule"); mocks.push(schedule);
      const publishing = { ...principal, scopes: ["publishing:write"] };
      const prepared = createMcpConfirmation(publishing, publicationIntent());
      const result = await (await connect(publishing)).callTool({ name: "narriflow_schedule_social_post", arguments: { workspaceId, clientIdempotencyKey: publicationIntent().clientIdempotencyKey, preparationToken: prepared.token } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ data: { error: "mcp_confirmation_required", kind: "forbidden" } });
      expect(schedule).not.toHaveBeenCalled();
    });
  });

  test("a prepared-post replay from a second credential receives a continuation bound to that credential", async () => {
    await withSecret(async () => {
      admitActor();
      const receipts = new Map<string, services.OperationReceiptIdentity & { id: string; fingerprint: string; resourceType: string; resourceId: string; result: unknown }>();
      const key = (identity: services.OperationReceiptIdentity) => JSON.stringify([identity.workspaceId, identity.actorUserId, identity.command, identity.clientIdempotencyKey]);
      const executor = services.createOperationReceiptExecutor<null>({
        read: async (identity) => receipts.get(key(identity)) ?? null, transaction: (run) => run(null), lock: async () => {},
        readInTransaction: async (_tx, identity) => receipts.get(key(identity)) ?? null,
        create: async (_tx, receipt) => { receipts.set(key(receipt as services.OperationReceiptIdentity), receipt as never); },
      });
      mocks.push(spyOn(services, "getOperationReceiptExecutor").mockReturnValue(executor));
      const intent = publicationIntent();
      mocks.push(spyOn(clipService, "getClipReviewFacts").mockResolvedValue({ editorRevision: 3 } as never));
      mocks.push(spyOn(clipExportService, "getOwned").mockResolvedValue({ editorRevision: 3, variants: [{ id: intent.clipExportVariantId, aspectRatio: "9:16", resolution: "1080p" }] } as never));
      mocks.push(spyOn(services.socialOAuthService, "listAccounts").mockResolvedValue([{ id: intent.accountId, platform: intent.platform, status: "active", displayName: "Channel" }] as never));
      const first = { kind: "api_key" as const, userId, clientId: "key-a", apiKeyId: "00000000-0000-4000-8000-0000000000a1", workspaceId, scopes: ["publishing:write"] };
      const rotated = { ...first, clientId: "key-b", apiKeyId: "00000000-0000-4000-8000-0000000000b2" };
      const prepare = async (subject: NarriflowMcpPrincipal) => ((await (await connect(subject)).callTool({ name: "narriflow_prepare_social_post", arguments: intent })).structuredContent as { data: { preparationToken: string; expiresAt: string } }).data;
      const original = await prepare(first);
      const replayed = await prepare(rotated);
      expect(receipts.size).toBe(1);
      expect(replayed.expiresAt).toBe(original.expiresAt);
      expect(verifyMcpPreparation(replayed.preparationToken, { principal: rotated }).intent).toMatchObject(intent);
      expect(() => verifyMcpPreparation(replayed.preparationToken, { principal: first })).toThrow(expect.objectContaining({ code: "mcp_confirmation_binding_mismatch" }));
      expect(JSON.stringify([...receipts.values()][0]?.result)).not.toContain(original.preparationToken);
    });
  });

  test("modern elicitation schedules the exact intent only after the client's accepted response", async () => {
    await withSecret(async () => {
      admitActor();
      const intent = publicationIntent();
      const schedule = spyOn(socialPublicationScheduling, "schedule").mockImplementation(async (input) => { await input.beforeAccept?.(); return scheduledPublication(); }); mocks.push(schedule);
      const publishing = { ...principal, scopes: ["publishing:write"] };
      const prepared = createMcpConfirmation(publishing, intent);
      const result = await (await connect(publishing, {}, () => true)).callTool({ name: "narriflow_schedule_social_post", arguments: { workspaceId, clientIdempotencyKey: intent.clientIdempotencyKey, preparationToken: prepared.token } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ data: { socialPostId: scheduledPublication().id, status: "scheduled" } });
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(schedule).toHaveBeenCalledWith(expect.objectContaining({ expectedEditorRevision: 3, clipExportId: intent.clipExportId, clipExportVariantId: intent.clipExportVariantId, caption: "Exact caption", accountId: intent.accountId }), expect.objectContaining({ actor: expect.objectContaining({ actorUserId: userId }) }));
    });
  });

  test("declined elicitation and expired new approvals cannot submit a post", async () => {
    await withSecret(async () => {
      admitActor();
      const schedule = spyOn(socialPublicationScheduling, "schedule").mockImplementation(async (input) => { await input.beforeAccept?.(); return scheduledPublication(); }); mocks.push(schedule);
      const publishing = { ...principal, scopes: ["publishing:write"] };
      const prepared = createMcpConfirmation(publishing, publicationIntent());
      const declined = await (await connect(publishing, {}, () => false)).callTool({ name: "narriflow_schedule_social_post", arguments: { workspaceId, clientIdempotencyKey: publicationIntent().clientIdempotencyKey, preparationToken: prepared.token } });
      expect(declined.structuredContent).toMatchObject({ data: { error: "mcp_confirmation_declined" } });
      expect(schedule).not.toHaveBeenCalled();
      const past = Date.now() - 601_000;
      const expired = createMcpConfirmation(publishing, publicationIntent(), { now: past });
      const receipt = acceptMcpConfirmation(expired.token, { actorUserId: userId, accepted: true, now: past });
      const result = await (await connect(publishing)).callTool({ name: "narriflow_schedule_social_post", arguments: { workspaceId, clientIdempotencyKey: publicationIntent().clientIdempotencyKey, preparationToken: expired.token, confirmationReceipt: receipt } });
      expect(result.structuredContent).toMatchObject({ data: { error: "mcp_confirmation_expired" } });
      expect(schedule).toHaveBeenCalledTimes(1);
    });
  });

  test("accepted scheduling replays survive confirmation expiry and a limiter outage", async () => {
    await withSecret(async () => {
      const replay = admitActor();
      replay.mockResolvedValue(scheduledPublication());
      const schedule = spyOn(socialPublicationScheduling, "schedule"); mocks.push(schedule);
      const publishing = { ...principal, scopes: ["publishing:write"] };
      const past = Date.now() - 601_000;
      const prepared = createMcpConfirmation(publishing, publicationIntent(), { now: past });
      const receipt = acceptMcpConfirmation(prepared.token, { actorUserId: userId, accepted: true, now: past });
      const result = await (await connect(publishing, { assertNewMutationAllowed: () => { throw new ExpectedDomainFailureError({ code: "mutations_unavailable", kind: "unavailable", message: "Paused" }); } })).callTool({ name: "narriflow_schedule_social_post", arguments: { workspaceId, clientIdempotencyKey: publicationIntent().clientIdempotencyKey, preparationToken: prepared.token, confirmationReceipt: receipt } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ data: { socialPostId: scheduledPublication().id } });
      expect(schedule).not.toHaveBeenCalled();
    });
  });

  test("a lost elicitation response replays the accepted post without a receipt or another confirmation", async () => {
    await withSecret(async () => {
      const replay = admitActor();
      replay.mockResolvedValue(scheduledPublication());
      const schedule = spyOn(socialPublicationScheduling, "schedule"); mocks.push(schedule);
      const publishing = { ...principal, scopes: ["publishing:write"] };
      const prepared = createMcpConfirmation(publishing, publicationIntent(), { now: Date.now() - 601_000 });
      const guard = () => { throw new ExpectedDomainFailureError({ code: "mutations_unavailable", kind: "unavailable", message: "Paused" }); };
      const result = await (await connect(publishing, { assertNewMutationAllowed: guard })).callTool({ name: "narriflow_schedule_social_post", arguments: { workspaceId, clientIdempotencyKey: publicationIntent().clientIdempotencyKey, preparationToken: prepared.token } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ data: { socialPostId: scheduledPublication().id, status: "scheduled" } });
      expect(schedule).not.toHaveBeenCalled();
    });
  });

  test("an exact confirmed intent still respects the authoritative review gate without an override", async () => {
    await withSecret(async () => {
      admitActor();
      const schedule = spyOn(socialPublicationScheduling, "schedule").mockImplementation(async (input) => {
        await input.beforeAccept?.();
        expect(input.reviewOverrideReason).toBeUndefined();
        throw new ExpectedDomainFailureError({ code: "review_approval_required", kind: "forbidden", message: "Approve this exact export in Narriflow before publishing" });
      }); mocks.push(schedule);
      const publishing = { ...principal, scopes: ["publishing:write"] };
      const prepared = createMcpConfirmation(publishing, publicationIntent());
      const receipt = acceptMcpConfirmation(prepared.token, { actorUserId: userId, accepted: true });
      const result = await (await connect(publishing)).callTool({ name: "narriflow_schedule_social_post", arguments: { workspaceId,
        clientIdempotencyKey: publicationIntent().clientIdempotencyKey, preparationToken: prepared.token, confirmationReceipt: receipt } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ data: { error: "review_approval_required" } });
      expect(schedule).toHaveBeenCalledTimes(1);
    });
  });
});

function admitActor() {
  mocks.push(spyOn(workspaceService, "requireActor").mockResolvedValue({ actorUserId: userId, workspaceId, workspaceName: "Team", workspaceOwnerUserId: userId, role: "owner", status: "active", pricingTier: "business", isPersonalWorkspace: true }));
  const replay = spyOn(socialPublicationScheduling, "replay").mockResolvedValue(null);
  mocks.push(replay);
  return replay;
}
function publicationIntent() { return { workspaceId, projectId, clientIdempotencyKey: "00000000-0000-4000-8000-000000000004", clipId: "00000000-0000-4000-8000-000000000005", accountId: "00000000-0000-4000-8000-000000000006", clipExportId: "00000000-0000-4000-8000-000000000007", clipExportVariantId: "00000000-0000-4000-8000-000000000008", expectedEditorRevision: 3, platform: "youtube_shorts" as const, aspectRatio: "9:16" as const, resolution: "1080p" as const, caption: "Exact caption", scheduledFor: "2026-10-06T12:00:00.000Z", providerSettings: {} }; }
function scheduledPublication() { const intent = publicationIntent(); return { id: "00000000-0000-4000-8000-000000000009", createdByUserId: userId, workspaceId, projectId, clipId: intent.clipId, clientIdempotencyKey: intent.clientIdempotencyKey, immutableRequestHash: "a".repeat(64), status: "scheduled" as const, submissionEligible: true, reviewApprovalOverrideId: null, frozen: { deliveryMode: "direct" as const, clipExportId: intent.clipExportId, clipExportVariantId: intent.clipExportVariantId, editorRevision: 3, exportFingerprint: "fingerprint", storageKey: "private/video.mp4", sizeBytes: 50, durationSec: 30, aspectRatio: "9:16" as const, caption: intent.caption, providerSettings: {}, socialAccountId: intent.accountId, platform: intent.platform, capabilityVersion: "v1", scheduledFor: new Date(intent.scheduledFor) }, createdAt: new Date(), updatedAt: new Date() }; }
async function withSecret(run: () => Promise<void>) { const previous = process.env.MCP_CONTINUATION_SECRET; process.env.MCP_CONTINUATION_SECRET = "a-test-continuation-secret-of-at-least-32-bytes"; try { await run(); } finally { if (previous === undefined) delete process.env.MCP_CONTINUATION_SECRET; else process.env.MCP_CONTINUATION_SECRET = previous; } }
