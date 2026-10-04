import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { clipService, clipExportService, projectService, socialPublicationScheduling, workspaceService, ExpectedDomainFailureError } from "@narriflow/services";
import { buildNarriflowMcpServer, type NarriflowMcpPrincipal, type NarriflowMcpServerOptions } from "./index";
import { createMcpConfirmation, acceptMcpConfirmation } from "./mcp-confirmation";
const userId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const principal = { kind: "oauth" as const, userId, clientId: "test-client", scopes: ["projects:read"] };
const clients: Client[] = [];
const mocks: Array<{ mockRestore(): void }> = [];
afterEach(async () => { for (const mock of mocks.splice(0)) mock.mockRestore(); await Promise.all(clients.splice(0).map((client) => client.close())); });
async function connect(subject: NarriflowMcpPrincipal = principal, options: NarriflowMcpServerOptions = {}, confirm?: () => boolean) {
  const handler = createMcpHandler(() => buildNarriflowMcpServer(subject, { appOrigin: "https://narriflow.test", ...options }));
  const client = new Client({ name: "workflow-test", version: "1" }, { versionNegotiation: { mode: "auto" }, ...(confirm ? { capabilities: { elicitation: { form: {} } } } : {}) });
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

  test("generation admits the canonical settings and returns the durable workflow ID", async () => {
    admitActor();
    const operationId = "00000000-0000-4000-8000-000000000006";
    const trigger = spyOn(projectService, "triggerGeneration").mockResolvedValue({ workflowRunId: operationId, acceptedAt: "2026-10-05T00:00:00.000Z", initialSeq: 2 });
    mocks.push(trigger);
    const key = "00000000-0000-4000-8000-000000000005";
    const client = await connect({ ...principal, scopes: ["processing:write"] });
    const result = await client.callTool({ name: "narriflow_generate_clips", arguments: { workspaceId, projectId, clientIdempotencyKey: key, generation: { clipCountTarget: 6, clipLengthPreset: "under_30s" } } });
    expect(result.structuredContent).toMatchObject({ data: { projectId, operationId, operationKind: "generation", status: "accepted", statusTool: "narriflow_get_project" } });
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }), projectId, expect.objectContaining({ contentPack: expect.objectContaining({ clipCountTarget: 6, clipDurationSecTarget: 25, maxDurationSec: 35 }) }), key, expect.objectContaining({ mutation: expect.objectContaining({ clientIdempotencyKey: key, callerId: `oauth:test-client:${userId}` }) }));
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
      const result = await (await connect(publishing, { assertNewMutationAllowed: () => { throw new ExpectedDomainFailureError({ code: "mcp_mutations_unavailable", kind: "unavailable", message: "Paused" }); } })).callTool({ name: "narriflow_schedule_social_post", arguments: { workspaceId, clientIdempotencyKey: publicationIntent().clientIdempotencyKey, preparationToken: prepared.token, confirmationReceipt: receipt } });
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
      const guard = () => { throw new ExpectedDomainFailureError({ code: "mcp_mutations_unavailable", kind: "unavailable", message: "Paused" }); };
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
