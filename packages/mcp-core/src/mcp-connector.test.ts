import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { brandProfileService, clipExportService, clipTimelineService, ExpectedDomainFailureError, operationStatusService, projectService, reviewService, workspaceService,
  type WorkspaceActorContext } from "@narriflow/services";
import type { ClipExportSnapshot } from "@narriflow/validators";
import { buildNarriflowMcpServer, MCP_WORKSPACE_ACCESS_MESSAGE, mcpFailureMessage, verifyMcpUploadHandoff, type NarriflowMcpPrincipal } from "./index";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const PROJECT = "00000000-0000-4000-8000-000000000003";
const CLIP = "00000000-0000-4000-8000-000000000004";
const EXPORT = "00000000-0000-4000-8000-000000000005";
const VARIANT = "00000000-0000-4000-8000-000000000006";
const BRAND = "00000000-0000-4000-8000-000000000007";
const KEY = "00000000-0000-4000-8000-000000000008";
const actor: WorkspaceActorContext = { actorUserId: ACTOR, workspaceId: WORKSPACE, workspaceName: "Agency", workspaceOwnerUserId: ACTOR,
  role: "owner", status: "active", pricingTier: "business", isPersonalWorkspace: false };
const allScopes = ["projects:read", "exports:read", "exports:write", "usage:read", "autopilot:read", "autopilot:write", "publishing:read", "publishing:write", "processing:write"];
const oauth = (scopes = allScopes): NarriflowMcpPrincipal => ({ kind: "oauth", userId: ACTOR, clientId: "assistant", scopes });

const restores: Array<{ mockRestore(): void }> = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const spy of restores.splice(0)) spy.mockRestore();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
function track<T extends { mockRestore(): void }>(spy: T) { restores.push(spy); return spy; }
async function connect(principal: NarriflowMcpPrincipal) {
  track(spyOn(workspaceService, "requireActor").mockResolvedValue(actor));
  const handler = createMcpHandler(() => buildNarriflowMcpServer(principal, { appOrigin: "https://app.narriflow.test" }));
  const client = new Client({ name: "connector-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL("https://app.narriflow.test/mcp"), { fetch: (input, init) => handler.fetch(new Request(input, init)) }));
  return client;
}
const data = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.structuredContent as { data: Record<string, unknown> }).data;

function snapshot(): ClipExportSnapshot {
  return { id: EXPORT, projectId: PROJECT, clipId: CLIP, clipTitle: "Hook", projectTitle: "Talk", editorRevision: 2, currentEditorRevision: 2, isOlderVersion: false,
    resolution: "720p", watermark: true, status: "ready", progress: 100, errorCode: null, createdAt: "2026-10-07T00:00:00.000Z", completedAt: "2026-10-07T00:01:00.000Z",
    variants: [{ id: VARIANT, aspectRatio: "9:16", resolution: "720p", watermark: true, status: "completed", sizeBytes: 10, durationSec: 30, errorCode: null, hasAsset: true,
      previewUrl: "https://storage.test/preview?X-Amz-Signature=secret", downloadUrl: "https://storage.test/download?X-Amz-Signature=secret", completedAt: "2026-10-07T00:01:00.000Z" }] };
}

describe("Operation Status tool", () => {
  test("intake and generation need projects:read while export operations need exports:read", async () => {
    const read = track(spyOn(operationStatusService, "read").mockResolvedValue({ kind: "intake", id: KEY, state: "partial", stage: "rendering", progress: 1,
      items: [{ kind: "clip", id: CLIP, state: "failed", failureCode: "render_failed" }], results: { projectId: PROJECT, clipIds: [CLIP], exportId: null },
      notices: [{ code: "framing_degraded", aspectRatio: "9:16", croppedPercent: 68 }], failureCode: "render_failed" }));
    const projectsOnly = await connect(oauth(["projects:read"]));
    const intake = await projectsOnly.callTool({ name: "narriflow_get_operation", arguments: { workspaceId: WORKSPACE, operation: { kind: "intake", id: KEY } } });
    expect(data(intake)).toMatchObject({ operation: { kind: "intake", id: KEY }, state: "partial", items: [{ id: CLIP, state: "failed" }],
      notices: [{ code: "framing_degraded", aspectRatio: "9:16", croppedPercent: 68 }], reviewUrl: `https://app.narriflow.test/projects/${PROJECT}` });
    expect(read).toHaveBeenCalledWith(actor, { kind: "intake", id: KEY });
    const exported = await projectsOnly.callTool({ name: "narriflow_get_operation", arguments: { workspaceId: WORKSPACE, operation: { kind: "export", id: EXPORT } } });
    expect(data(exported)).toMatchObject({ error: "scope_required", message: "This credential requires the exports:read scope" });
    const exportsOnly = await connect(oauth(["exports:read"]));
    const generation = await exportsOnly.callTool({ name: "narriflow_get_operation", arguments: { workspaceId: WORKSPACE, operation: { kind: "generation", id: KEY } } });
    expect(data(generation)).toMatchObject({ error: "scope_required" });
  });

  test("accepted mutations point at their own operation, not the Project's latest run", async () => {
    track(spyOn(projectService, "queueLinkIngest").mockResolvedValue({ project: { id: PROJECT } as never, queuedJobId: KEY }));
    const client = await connect(oauth());
    const result = await client.callTool({ name: "narriflow_submit_video", arguments: { workspaceId: WORKSPACE, clientIdempotencyKey: KEY, url: "https://example.test/talk.mp4" } });
    expect(data(result)).toEqual({ projectId: PROJECT, operation: { kind: "intake", id: KEY }, status: "accepted", statusTool: "narriflow_get_operation", reviewUrl: `https://app.narriflow.test/projects/${PROJECT}` });
  });
});

describe("Captioned video tool", () => {
  test("captions a link through the captioned-video command and points at its intake operation", async () => {
    const queue = track(spyOn(projectService, "queueLinkIngest").mockResolvedValue({ project: { id: PROJECT } as never, queuedJobId: KEY }));
    const client = await connect(oauth());
    const result = await client.callTool({ name: "narriflow_create_captioned_video", arguments: { workspaceId: WORKSPACE, clientIdempotencyKey: KEY, url: "https://example.test/short.mp4",
      framing: "center", aspectRatios: ["9:16", "1:1"], captions: { source: "supplied", text: "1\n00:00:00,000 --> 00:00:02,000\nHello there" } } });
    expect(data(result)).toEqual({ projectId: PROJECT, operation: { kind: "intake", id: KEY }, status: "accepted", statusTool: "narriflow_get_operation", reviewUrl: `https://app.narriflow.test/projects/${PROJECT}` });
    const [, link, options] = queue.mock.calls[0]!;
    expect(link).toMatchObject({ url: "https://example.test/short.mp4" });
    expect(options).toMatchObject({ command: "create_captioned_video" });
    const pack = options!.generationContext!.contentPack;
    expect(pack).toMatchObject({ mode: "caption_only", defaultAspectRatio: "9:16", captionedVideo: { framing: "center", aspectRatios: ["9:16", "1:1"], resolution: "1080p",
      captions: { source: "supplied", utterances: [{ text: "Hello there", startSec: 0, endSec: 2, words: [{ word: "Hello" }, { word: "there" }] }] } } });
  });

  test("refuses malformed supplied captions with a typed error before accepting work", async () => {
    const queue = track(spyOn(projectService, "queueLinkIngest").mockResolvedValue({ project: { id: PROJECT } as never, queuedJobId: KEY }));
    const client = await connect(oauth());
    const result = await client.callTool({ name: "narriflow_create_captioned_video", arguments: { workspaceId: WORKSPACE, clientIdempotencyKey: KEY, url: "https://example.test/short.mp4",
      captions: { source: "supplied", text: "not captions at all" } } });
    expect(data(result)).toMatchObject({ error: "supplied_captions_malformed" });
    expect(queue).not.toHaveBeenCalled();
  });
});

describe("Brand Profile selection", () => {
  test("submission passes the requested profile unchanged so intake resolves the default after replay lookup", async () => {
    const queue = track(spyOn(projectService, "queueLinkIngest").mockResolvedValue({ project: { id: PROJECT } as never, queuedJobId: KEY }));
    track(spyOn(brandProfileService, "listSummaries").mockResolvedValue([{ id: BRAND, name: "Acme", isDefault: true, defaultStyle: { id: VARIANT, name: "Bold" } }]));
    const client = await connect(oauth());
    await client.callTool({ name: "narriflow_submit_video", arguments: { workspaceId: WORKSPACE, clientIdempotencyKey: KEY, url: "https://example.test/talk.mp4", brandProfileId: BRAND } });
    await client.callTool({ name: "narriflow_submit_video", arguments: { workspaceId: WORKSPACE, clientIdempotencyKey: KEY, url: "https://example.test/talk.mp4" } });
    expect(queue.mock.calls[0]![1]).toMatchObject({ brandProfileId: BRAND });
    expect(queue.mock.calls[1]![1].brandProfileId).toBeUndefined();
    const listed = await client.callTool({ name: "narriflow_list_brand_profiles", arguments: { workspaceId: WORKSPACE } });
    expect(data(listed)).toEqual({ profiles: [{ brandProfileId: BRAND, name: "Acme", isDefault: true, defaultStyle: { templateId: VARIANT, name: "Bold" } }] });
  });

  test("an inaccessible profile is reported missing", async () => {
    const missing = new ExpectedDomainFailureError({ code: "brand_profile_not_found", kind: "missing", message: "Brand Profile not found" });
    track(spyOn(projectService, "queueLinkIngest").mockRejectedValue(missing));
    const usable = track(spyOn(brandProfileService, "requireUsableId").mockRejectedValue(missing));
    const client = await connect(oauth());
    const submitted = await client.callTool({ name: "narriflow_submit_video", arguments: { workspaceId: WORKSPACE, clientIdempotencyKey: KEY, url: "https://example.test/talk.mp4", brandProfileId: BRAND } });
    expect(data(submitted)).toMatchObject({ error: "brand_profile_not_found", kind: "missing" });
    const uploaded = await client.callTool({ name: "narriflow_upload_video", arguments: { workspaceId: WORKSPACE, clientIdempotencyKey: KEY, brandProfileId: BRAND } });
    expect(data(uploaded)).toMatchObject({ error: "brand_profile_not_found", kind: "missing" });
    expect(usable).toHaveBeenCalledWith(actor, BRAND);
  });

  test("the upload handoff signs exactly the requested profile", async () => {
    const previous = process.env.MCP_CONTINUATION_SECRET;
    process.env.MCP_CONTINUATION_SECRET = "a-shared-secret-of-at-least-32-bytes-long";
    try {
      track(spyOn(brandProfileService, "requireUsableId").mockResolvedValue(BRAND));
      const client = await connect(oauth());
      const intent = async (args: Record<string, unknown>) => {
        const result = await client.callTool({ name: "narriflow_upload_video", arguments: { workspaceId: WORKSPACE, clientIdempotencyKey: KEY, ...args } });
        return verifyMcpUploadHandoff(new URL(String(data(result).handoffUrl)).searchParams.get("intent")!).intent;
      };
      expect((await intent({ brandProfileId: BRAND })).brandProfileId).toBe(BRAND);
      expect((await intent({})).brandProfileId).toBeUndefined();
    } finally { process.env.MCP_CONTINUATION_SECRET = previous; }
  });
});

describe("export delivery", () => {
  test("export results state requested and granted output and never carry media URLs", async () => {
    track(spyOn(clipExportService, "create").mockResolvedValue({ export: snapshot(), reused: false,
      output: { requested: { resolution: "1080p" }, granted: { resolution: "720p", watermark: true }, reason: "plan_limit" } }));
    track(spyOn(clipExportService, "getOwned").mockResolvedValue(snapshot()));
    const client = await connect(oauth());
    const created = await client.callTool({ name: "narriflow_create_clip_export", arguments: { workspaceId: WORKSPACE, clientIdempotencyKey: KEY, projectId: PROJECT, clipId: CLIP, expectedRevision: 2, aspectRatios: ["9:16"], resolution: "1080p" } });
    expect(data(created)).toMatchObject({ output: { requested: { resolution: "1080p" }, granted: { resolution: "720p", watermark: true }, reason: "plan_limit" },
      operation: { kind: "export", id: EXPORT }, statusTool: "narriflow_get_operation", export: { watermark: true } });
    const read = await client.callTool({ name: "narriflow_get_clip_export", arguments: { workspaceId: WORKSPACE, projectId: PROJECT, clipId: CLIP, exportId: EXPORT } });
    for (const result of [created, read]) expect(JSON.stringify(result)).not.toContain("storage.test");
  });

  test("only the download tool returns Download Grants, for the calling credential kind", async () => {
    const grants = track(spyOn(clipExportService, "issueDownloadGrants").mockResolvedValue({ exportId: EXPORT, projectId: PROJECT, clipId: CLIP, editorRevision: 2,
      variants: [{ variantId: VARIANT, aspectRatio: "9:16", resolution: "720p", watermark: true, fileName: "hook-9x16-720p-v2.mp4", sizeBytes: 10,
        downloadUrl: "https://storage.test/download?X-Amz-Signature=fresh", expiresAt: "2026-10-07T00:16:00.000Z" }],
      subtitles: [{ format: "srt", fileName: "hook-v2.srt", content: "1\n00:00:00,000 --> 00:00:01,000\nHi\n\n" }, { format: "vtt", fileName: "hook-v2.vtt", content: "WEBVTT\n\n" }] }));
    const client = await connect(oauth(["exports:read"]));
    const result = await client.callTool({ name: "narriflow_get_export_download", arguments: { workspaceId: WORKSPACE, exportId: EXPORT, variantId: VARIANT } });
    expect(data(result)).toMatchObject({ variants: [{ downloadUrl: "https://storage.test/download?X-Amz-Signature=fresh", expiresAt: "2026-10-07T00:16:00.000Z" }], subtitles: [{ format: "srt" }, { format: "vtt" }] });
    expect(grants).toHaveBeenCalledWith(actor, EXPORT, { variantId: VARIANT, credentialKind: "oauth" });
  });
});

describe("editor timelines", () => {
  test("return the timeline text with a source grant only to a credential that may download", async () => {
    const timeline = { projectId: PROJECT, clipId: CLIP, editorRevision: 2, format: "xmeml",
      timeline: { fileName: "hook-v2.xml", content: '<xmeml version="5"/>' }, subtitles: { format: "srt", fileName: "hook-v2.srt", content: "" },
      source: { fileName: "talk-source.mp4", sizeBytes: 10, downloadUrl: "https://storage.test/source?X-Amz-Signature=fresh", expiresAt: "2026-10-24T00:15:00.000Z" } };
    const exported = track(spyOn(clipTimelineService, "export").mockResolvedValue(timeline as never));
    const client = await connect(oauth(["exports:read"]));
    const result = await client.callTool({ name: "narriflow_get_clip_timeline", arguments: { workspaceId: WORKSPACE, projectId: PROJECT, clipId: CLIP, format: "xmeml" } });
    expect(data(result)).toEqual(timeline);
    expect(exported).toHaveBeenCalledWith(actor, PROJECT, CLIP, "xmeml", { credentialKind: "oauth" });

    const refused = await (await connect(oauth(["projects:read"]))).callTool({ name: "narriflow_get_clip_timeline", arguments: { workspaceId: WORKSPACE, projectId: PROJECT, clipId: CLIP, format: "edl" } });
    expect(data(refused)).toMatchObject({ error: "scope_required" });
    const unknown = await client.callTool({ name: "narriflow_get_clip_timeline", arguments: { workspaceId: WORKSPACE, projectId: PROJECT, clipId: CLIP, format: "aaf" } });
    expect(unknown.isError).toBe(true);
  });
});

describe("review handoff", () => {
  test("returns a composer link with the checked selection and creates nothing", async () => {
    track(spyOn(reviewService, "prepareHandoff").mockResolvedValue({ projectId: PROJECT, items: [{ clipId: CLIP, exportId: EXPORT, editorRevision: 2, variantIds: [VARIANT] }] }));
    const create = track(spyOn(reviewService, "createRound"));
    const client = await connect(oauth(["exports:read"]));
    const result = await client.callTool({ name: "narriflow_create_review_handoff", arguments: { workspaceId: WORKSPACE, items: [{ exportId: EXPORT, variantIds: [VARIANT] }] } });
    expect(new URL(String(data(result).composerUrl)).searchParams.get("reviewSelection")).toBe(`${EXPORT}:${VARIANT}`);
    expect(create).not.toHaveBeenCalled();
  });

  test("round reads report decisions through the summary projection", async () => {
    const round = { roundId: KEY, projectId: PROJECT, revision: 1, title: "Client cut", status: "approved", decision: "approved", sentAt: "2026-10-07T00:00:00.000Z", expiresAt: null,
      items: [{ itemId: VARIANT, clipId: CLIP, clipTitle: "Hook", exportId: EXPORT, editorRevision: 2, required: true, decision: "approved", commentCount: 2 }], generalCommentCount: 0 };
    const list = track(spyOn(reviewService, "listRoundSummaries").mockResolvedValue([round]));
    track(spyOn(reviewService, "getRoundSummary").mockResolvedValue(round));
    const client = await connect(oauth(["exports:read"]));
    expect(data(await client.callTool({ name: "narriflow_list_review_rounds", arguments: { workspaceId: WORKSPACE, projectId: PROJECT } }))).toMatchObject({ rounds: [{ status: "approved" }] });
    expect(list).toHaveBeenCalledWith(actor, { projectId: PROJECT, limit: 10 });
    expect(data(await client.callTool({ name: "narriflow_get_review_round", arguments: { workspaceId: WORKSPACE, roundId: KEY } }))).toMatchObject({ round: { items: [{ decision: "approved", commentCount: 2 }], reviewUrl: `https://app.narriflow.test/projects/${PROJECT}?tab=review` } });
  });
});

test("Workspace access errors name the requirement without sales prompts", async () => {
  const client = await connect(oauth());
  const requireActor = track(spyOn(workspaceService, "requireActor").mockResolvedValue({ ...actor, pricingTier: "creator" }));
  const planRefusal = data(await client.callTool({ name: "narriflow_list_brand_profiles", arguments: { workspaceId: WORKSPACE } }));
  expect(planRefusal).toMatchObject({ error: "plan_feature_required", kind: "payment_required", retryGuidance: "review_billing",
    details: { feature: "integrations.mcp", currentTier: "creator", requiredTier: "pro" } });
  requireActor.mockResolvedValue({ ...actor, status: "restricted" });
  const inactive = data(await client.callTool({ name: "narriflow_list_brand_profiles", arguments: { workspaceId: WORKSPACE } }));
  expect(inactive).toMatchObject({ error: "integration_access_unavailable", message: MCP_WORKSPACE_ACCESS_MESSAGE });
  for (const message of [String(planRefusal.message), MCP_WORKSPACE_ACCESS_MESSAGE]) {
    for (const word of ["upgrade", "checkout", "billing", "http", "price", "subscribe"]) expect(message.toLowerCase()).not.toContain(word);
  }
});

test("credit and per-video limits reach assistants as the requirement, without upgrade prompts", async () => {
  track(spyOn(projectService, "queueLinkIngest").mockRejectedValue(new ExpectedDomainFailureError({ code: "credits_exhausted", kind: "payment_required",
    message: "This video needs 30 credits, but the workspace has 10 of 1800 Business credits left this month. Credits renew on 2026-11-01 (UTC), or upgrade for more.",
    details: { tier: "business", limitCredits: 1800, remainingCredits: 10, requestedCredits: 30, renewsAt: "2026-11-01T00:00:00.000Z" } })));
  const client = await connect(oauth());
  const result = data(await client.callTool({ name: "narriflow_submit_video", arguments: { workspaceId: WORKSPACE, clientIdempotencyKey: KEY, url: "https://example.test/talk.mp4" } }));
  expect(result).toMatchObject({ error: "credits_exhausted", message: "This video needs 30 credits, but the workspace has 10 of 1800 left this month. Credits renew on 2026-11-01 (UTC).", details: { requestedCredits: 30 } });
  expect(String(result.message).toLowerCase()).not.toContain("upgrade");
  expect(mcpFailureMessage({ code: "upload_too_long", message: "Upgrade for longer videos.", details: { maxSeconds: 10_800 } })).toBe("This video is longer than the workspace's 180-minute per-video limit.");
});
