import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { contentPackSchema } from "@narriflow/validators";
import { AutopilotService } from "./autopilot.service";
import { ProcessingUsageError } from "./processing-usage";
import { projectService } from "./project.service";
import { ZoomService } from "./zoom.service";
import { createZoomTokenCipher, ZOOM_SCOPES, ZoomError } from "./zoom";
import type { ZoomApi } from "./zoom-api";
import { ruleFingerprint } from "./standing-grant";

setDefaultTimeout(180_000);
const describeDb = process.env.ALLOW_VIZARD_EXPANSION_DB_TESTS === "1" ? describe : describe.skip;
const config = { clientId: "zoom-test-client", clientSecret: "zoom-test-secret", webhookSecret: "zoom-test-webhook", encryptionKey: "zoom-test-encryption" };
const contentPack = contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 3, clipDurationSecTarget: 45, platformPlaybookVersion: "2026-10-04" });
const tokens = { access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600, scope: ZOOM_SCOPES.join(" ") };

describeDb("Zoom recording admission and authorization", () => {
  let prisma: PrismaClient, pool: Pool, prior: PrismaClient | undefined;
  const global = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
  const workspaceIds: string[] = [], userIds: string[] = [];
  let refreshes = 0;
  const api: ZoomApi = {
    exchange: async () => tokens,
    refresh: async () => { refreshes++; return { ...tokens, access_token: `private-access-${refreshes}`, refresh_token: `private-refresh-${refreshes}` }; },
    me: async () => ({ id: "zoom-host", account_id: "zoom-account", displayName: "Dana on Zoom" }),
    recording: async () => "https://us02web.zoom.us/rec/download/private",
    revoke: async () => {},
  };
  const service = () => new ZoomService({ config: () => config, api });

  beforeAll(async () => {
    const url = process.env.VIZARD_EXPANSION_TEST_DATABASE_URL, schema = process.env.VIZARD_EXPANSION_TEST_DATABASE_SCHEMA;
    if (!url || !schema) throw new Error("Disposable Zoom test schema is required");
    pool = new Pool({ connectionString: url, max: 6, options: `-csearch_path=${schema}` });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    prior = global.narriflowPrismaClient;
    global.narriflowPrismaClient = prisma;
  });
  beforeEach(async () => {
    refreshes = 0;
    await prisma.zoomWebhookJob.deleteMany();
    await prisma.autopilotRule.updateMany({ data: { status: "paused" } });
  });
  afterAll(async () => {
    if (prisma) {
      await prisma.zoomWebhookJob.deleteMany();
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    }
    global.narriflowPrismaClient = prior;
    await pool?.end();
  });

  async function fixture(topicFilter: string | null = null) {
    const user = await prisma.user.create({ data: { clerkId: `zoom-${randomUUID()}` } });
    userIds.push(user.id);
    const workspace = await prisma.workspace.create({ data: { name: "Zoom tests", ownerUserId: user.id, pricingTier: "business", members: { create: { userId: user.id, role: "owner" } } } });
    workspaceIds.push(workspace.id);
    const scope = { actorUserId: user.id, workspaceId: workspace.id };
    const recipe = await prisma.recipe.create({ data: { workspaceId: workspace.id, name: "Zoom clips", contentPack, createdByUserId: user.id } });
    const connection = await prisma.zoomConnection.create({ data: { workspaceId: workspace.id, userId: user.id, zoomUserId: "zoom-host", zoomAccountId: "zoom-account", displayName: "Dana on Zoom", accessTokenEncrypted: createZoomTokenCipher(config.encryptionKey).seal(tokens.access_token), refreshTokenEncrypted: createZoomTokenCipher(config.encryptionKey).seal(tokens.refresh_token), expiresAt: new Date(Date.now() + 3600_000), scopes: [...ZOOM_SCOPES] } });
    const rule = await new AutopilotService().createRule(scope, { sourceKind: "zoom", name: "Webinars", zoomConnectionId: connection.id, zoomTopicFilter: topicFilter, recipeId: recipe.id });
    return { user, workspace, scope, recipe, connection, rule };
  }
  function event(overrides: Record<string, unknown> = {}) {
    return { event: "recording.completed", event_id: randomUUID(), event_ts: Date.now(), download_token: "private-webhook-token", payload: { account_id: "zoom-account", object: { uuid: "meeting-uuid", host_id: "zoom-host", topic: "Product WEBINAR", duration: 5, recording_files: [{ id: "recording-id", status: "completed", file_type: "MP4", recording_type: "shared_screen_with_speaker_view", download_url: "https://zoom.us/private?access_token=secret" }] } }, ...overrides };
  }
  function signed(body: unknown) {
    const rawBody = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000));
    return { rawBody, timestamp, signature: `v0=${createHmac("sha256", config.webhookSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}` };
  }

  test("retries and concurrent claims import a recording once per rule with frozen Recipe settings", async () => {
    const f = await fixture("webinar"), zoom = service(), notification = event();
    await Promise.all(Array.from({ length: 5 }, () => zoom.acceptWebhook(signed(notification))));
    expect(await prisma.zoomWebhookJob.count()).toBe(1);
    expect(JSON.stringify((await prisma.zoomWebhookJob.findFirstOrThrow()).payload)).not.toContain("private");
    await Promise.all([zoom.processDueNotifications(), zoom.processDueNotifications()]);
    const rows = await prisma.project.findMany({ where: { workspaceId: f.workspace.id }, include: { ingestJobs: true, contentPacks: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceType: "zoom", sourceMimeType: "video/mp4", sourceDurationSeconds: 300 });
    expect(rows[0]!.ingestJobs).toHaveLength(1);
    expect(rows[0]!.ingestJobs[0]).toMatchObject({ jobType: "zoom_import", sourceCredential: null, payload: { connectionId: f.connection.id, meetingUuid: "meeting-uuid", recordingId: "recording-id" } });
    expect(rows[0]!.contentPacks[0]).toMatchObject({ autopilotRuleId: f.rule.id, recipe: { id: f.recipe.id, revision: 1 } });
    expect(await prisma.autopilotEpisode.count({ where: { ruleId: f.rule.id } })).toBe(1);
    // A new delivery ID for the same recording is harmless, including after retention.
    await prisma.project.delete({ where: { id: rows[0]!.id } });
    await zoom.acceptWebhook(signed(event()));
    await zoom.processDueNotifications();
    expect(await prisma.project.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await prisma.autopilotEpisode.count({ where: { ruleId: f.rule.id } })).toBe(1);
  });

  test("host, account and topic restrict matching; other rules can import the same recording", async () => {
    const match = await fixture("webinar"), noMatch = await fixture("podcast"), zoom = service();
    const second = await new AutopilotService().createRule(match.scope, { sourceKind: "zoom", name: "All recordings", zoomConnectionId: match.connection.id, recipeId: match.recipe.id });
    await zoom.acceptWebhook(signed(event()));
    await zoom.processDueNotifications();
    expect(await prisma.autopilotEpisode.count({ where: { ruleId: { in: [match.rule.id, second.id] } } })).toBe(2);
    expect(await prisma.autopilotEpisode.count({ where: { ruleId: noMatch.rule.id } })).toBe(0);
    const body = event(); body.payload.object.host_id = "other-host";
    await zoom.acceptWebhook(signed(body)); await zoom.processDueNotifications();
    expect(await prisma.project.count({ where: { workspaceId: match.workspace.id } })).toBe(2);
  });

  test("a recording for a rule the plan no longer runs pauses the rule once, imports nothing, and completes the job", async () => {
    const f = await fixture(), zoom = service();
    await prisma.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "creator" } });
    const imported = spyOn(projectService, "importZoomRecording");
    try {
      await zoom.acceptWebhook(signed(event()));
      await zoom.processDueNotifications();
      expect(imported).not.toHaveBeenCalled();
    } finally { imported.mockRestore(); }
    expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: f.rule.id } })).toMatchObject({ status: "paused", pauseKind: "plan", lastError: expect.stringContaining("Autopilot needs the Pro plan") });
    expect(await prisma.project.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await prisma.zoomWebhookJob.findFirstOrThrow({ orderBy: { createdAt: "desc" } })).toMatchObject({ status: "completed" });
    await expect(new AutopilotService().updateRule(f.scope, f.rule.id, { status: "active" })).rejects.toMatchObject({ code: "plan_feature_required" });
  });

  test("a capacity refusal retries durably without consuming the recording", async () => {
    const f = await fixture(), zoom = service();
    await zoom.acceptWebhook(signed(event()));
    const refusal = spyOn(projectService, "importZoomRecording").mockRejectedValue(new ProcessingUsageError({ code: "workspace_processing_capacity_reached", message: "Capacity is full", details: { tier: "business", inFlight: 10, inFlightLimit: 10 } }));
    try { await zoom.processDueNotifications(); } finally { refusal.mockRestore(); }
    expect(await prisma.project.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await prisma.autopilotEpisode.count({ where: { ruleId: f.rule.id } })).toBe(0);
    expect(await prisma.zoomWebhookJob.findFirstOrThrow()).toMatchObject({ status: "queued", lastError: "workspace_processing_capacity_reached" });
    await prisma.zoomWebhookJob.updateMany({ data: { availableAt: new Date(0) } });
    await zoom.processDueNotifications();
    expect(await prisma.project.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
  });

  test("disconnection erases tokens, pauses rules, and refuses new admission and cross-workspace access", async () => {
    const f = await fixture(), other = await fixture(), zoom = service();
    await expect(zoom.disconnect(other.scope, f.connection.id)).rejects.toMatchObject({ code: "zoom_connection_unavailable" });
    await zoom.disconnect(f.scope, f.connection.id);
    expect(await prisma.zoomConnection.findUniqueOrThrow({ where: { id: f.connection.id } })).toMatchObject({ accessTokenEncrypted: null, refreshTokenEncrypted: null, revokedAt: expect.any(Date) });
    expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: f.rule.id } })).toMatchObject({ status: "paused", pauseKind: "zoom_connection", lastError: expect.stringContaining("Reconnect") });
    await expect(new AutopilotService().updateRule(f.scope, f.rule.id, { status: "active" })).rejects.toMatchObject({ code: "zoom_connection_unavailable" });
    await expect(zoom.recordingDownload({ connectionId: f.connection.id, projectId: randomUUID(), meetingUuid: "meeting", recordingId: "recording" })).rejects.toMatchObject({ code: "zoom_recording_unavailable" });
  });

  test("OAuth state binds member, Workspace and redirect URI and can be redeemed only once", async () => {
    const f = await fixture(), other = await fixture(), zoom = service();
    const url = new URL(await zoom.createAuthorizationUrl(f.scope, "https://narriflow.test"));
    const state = url.searchParams.get("state")!;
    const input = { state, code: "private-code", origin: "https://narriflow.test" };
    await expect(zoom.handleCallback(other.scope, input)).rejects.toMatchObject({ code: "zoom_oauth_state_invalid" });
    await expect(zoom.handleCallback(f.scope, { ...input, origin: "https://other.test" })).rejects.toMatchObject({ code: "zoom_oauth_state_invalid" });
    const results = await Promise.allSettled([zoom.handleCallback(f.scope, input), zoom.handleCallback(f.scope, input)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const stored = await prisma.zoomConnection.findUniqueOrThrow({ where: { id: f.connection.id } });
    expect(stored.accessTokenEncrypted).not.toContain(tokens.access_token);
    expect(createZoomTokenCipher(config.encryptionKey).open(stored.accessTokenEncrypted!)).toBe(tokens.access_token);
    expect(JSON.stringify(await zoom.listConnections(f.scope))).not.toContain("Token");
    expect(await prisma.zoomOAuthState.count({ where: { stateHash: state } })).toBe(0);
  });

  test("connecting Zoom needs the plan that runs Autopilot; existing connections stay readable and disconnectable", async () => {
    const f = await fixture(), zoom = service();
    await prisma.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "creator" } });
    await expect(zoom.createAuthorizationUrl(f.scope, "https://narriflow.test")).rejects.toMatchObject({
      code: "plan_feature_required",
      kind: "payment_required",
      details: expect.objectContaining({ feature: "automation.autopilot", currentTier: "creator", requiredTier: "pro" }),
    });
    expect(await prisma.zoomOAuthState.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await zoom.listConnections(f.scope)).toMatchObject([{ id: f.connection.id, revoked: false, canDisconnect: true }]);
    await zoom.disconnect(f.scope, f.connection.id);
    expect((await prisma.zoomConnection.findUniqueOrThrow({ where: { id: f.connection.id } })).revokedAt).not.toBeNull();
  });

  test("two workers rotate one expired refresh token under the connection lock", async () => {
    const f = await fixture(), zoom = service();
    const project = await prisma.project.create({ data: { workspaceId: f.workspace.id, createdByUserId: f.user.id, title: "Download", sourceMediaUrl: "zoom:recording", sourceType: "zoom" } });
    await prisma.zoomConnection.update({ where: { id: f.connection.id }, data: { expiresAt: new Date(0) } });
    const input = { connectionId: f.connection.id, projectId: project.id, meetingUuid: "meeting", recordingId: "recording" };
    const results = await Promise.all([zoom.recordingDownload(input), zoom.recordingDownload(input)]);
    expect(refreshes).toBe(1);
    expect(results.map((result) => result.accessToken)).toEqual(["private-access-1", "private-access-1"]);
  });

  test("a provider-revoked refresh token pauses the connection's rules", async () => {
    const f = await fixture();
    const zoom = new ZoomService({ config: () => config, api: { ...api, refresh: async () => { throw new ZoomError("zoom_connection_unavailable"); } } });
    const project = await prisma.project.create({ data: { workspaceId: f.workspace.id, createdByUserId: f.user.id, title: "Download", sourceMediaUrl: "zoom:recording", sourceType: "zoom" } });
    await prisma.zoomConnection.update({ where: { id: f.connection.id }, data: { expiresAt: new Date(0) } });
    await expect(zoom.recordingDownload({ connectionId: f.connection.id, projectId: project.id, meetingUuid: "meeting", recordingId: "file" })).rejects.toMatchObject({ code: "zoom_connection_unavailable" });
    expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: f.rule.id } })).toMatchObject({ status: "paused", pauseKind: "zoom_connection" });
    expect((await prisma.zoomConnection.findUniqueOrThrow({ where: { id: f.connection.id } })).refreshTokenEncrypted).toBeNull();
  });

  test("source edits and disconnection pause grants, while a rule rename does not", async () => {
    const f = await fixture(), zoom = service(), autopilot = new AutopilotService();
    const createGrant = async () => prisma.standingGrant.create({ data: { workspaceId: f.workspace.id, autopilotRuleId: f.rule.id, kind: "review_send", reviewerEmails: ["reviewer@example.test"], dailyCap: 1, weeklyCap: 2, expiresAt: new Date(Date.now() + 86_400_000), grantedByUserId: f.user.id, ruleFingerprint: (await ruleFingerprint(prisma, f.rule.id))! } });
    const grant = await createGrant();
    await autopilot.updateRule(f.scope, f.rule.id, { name: "Renamed" });
    expect((await prisma.standingGrant.findUniqueOrThrow({ where: { id: grant.id } })).status).toBe("active");
    await autopilot.updateRule(f.scope, f.rule.id, { zoomTopicFilter: "webinar" });
    expect(await prisma.standingGrant.findUniqueOrThrow({ where: { id: grant.id } })).toMatchObject({ status: "paused", pausedReason: "rule_changed" });
    const second = await createGrant();
    await zoom.disconnect(f.scope, f.connection.id);
    expect(await prisma.standingGrant.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: "paused", pausedReason: "rule_changed" });
    await autopilot.updateRule(f.scope, f.rule.id, { recipeId: f.recipe.id });
    expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: f.rule.id } })).toMatchObject({ status: "paused", pauseKind: "zoom_connection" });
  });

  test("delayed events from before rule creation do not backfill recordings", async () => {
    const f = await fixture(), zoom = service();
    await zoom.acceptWebhook(signed(event({ event_ts: Date.parse(f.rule.createdAt) - 1000 })));
    await zoom.processDueNotifications();
    expect(await prisma.project.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  });

  test("a deauthorization pauses connected rules and stale deauthorization cannot undo a reconnect", async () => {
    const f = await fixture(), zoom = service();
    await zoom.acceptWebhook(signed({ event: "app_deauthorized", event_ts: Date.now() + 50, payload: { account_id: "zoom-account", user_id: "zoom-host" } }));
    await zoom.processDueNotifications();
    expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: f.rule.id } })).toMatchObject({ pauseKind: "zoom_connection", status: "paused" });
    const url = new URL(await zoom.createAuthorizationUrl(f.scope, "https://narriflow.test"));
    await zoom.handleCallback(f.scope, { state: url.searchParams.get("state")!, code: "code", origin: "https://narriflow.test" });
    await zoom.acceptWebhook(signed({ event: "app_deauthorized", event_ts: 1, payload: { account_id: "zoom-account", user_id: "zoom-host" } }));
    await zoom.processDueNotifications();
    expect((await prisma.zoomConnection.findUniqueOrThrow({ where: { id: f.connection.id } })).revokedAt).toBeNull();
    expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: f.rule.id } })).toMatchObject({ status: "paused" });
  });
});
