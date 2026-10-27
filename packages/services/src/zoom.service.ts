import { randomBytes, randomUUID } from "node:crypto";
import { getPrismaClient } from "@narriflow/db/client";
import { workspaceAllowsCapability, zoomNotificationSchema, type ZoomConnectionSnapshot, type ZoomRecordingNotification } from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import { workspaceService, WorkspaceOperationError } from "./workspace.service";
import { createZoomApi, type ZoomApi } from "./zoom-api";
import { createZoomTokenCipher, parseZoomNotification, verifyZoomSignature, zoomConfig, zoomStateHash, zoomValidationChallenge, ZoomError, ZOOM_CALLBACK_PATH, ZOOM_SCOPES, ZOOM_WEBHOOK_MAX_BYTES } from "./zoom";
import { recipeService } from "./recipe.service";
import { projectService } from "./project.service";
import { ProcessingUsageError } from "./processing-usage";
import { pauseGrantsWhoseRuleChanged } from "./standing-grant";
import { flushWorkspaceEvents } from "./workspace-event";
import { BrandProfileMembershipError, BrandProfileMissingAssetError, BrandProfileNotFoundError } from "./brand-profile.service";
import { isBrandAccessRefusal } from "./brand-ownership";
import { autopilotPlanPauseReason } from "./autopilot-plan";
import { requirePlanFeature } from "./plan-features";

function db() { const prisma = getPrismaClient(); if (!prisma) throw new Error("Database client unavailable"); return prisma; }

export class ZoomService {
  constructor(private readonly deps: { api?: ZoomApi; config?: typeof zoomConfig; now?: () => Date } = {}) {}
  private now() { return this.deps.now?.() ?? new Date(); }
  private config() { return (this.deps.config ?? zoomConfig)(); }
  private api() { return this.deps.api ?? createZoomApi(this.config()); }
  private cipher() { return createZoomTokenCipher(this.config().encryptionKey); }

  async listConnections(scope: ActorScope): Promise<ZoomConnectionSnapshot[]> {
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
    const admin = workspaceAllowsCapability(actor, "workspace.manage");
    const rows = await db().zoomConnection.findMany({ where: { workspaceId: scope.workspaceId }, orderBy: { createdAt: "asc" } });
    return rows.map((row) => ({ id: row.id, userId: row.userId, displayName: row.displayName, revoked: row.revokedAt !== null, canDisconnect: admin || row.userId === scope.actorUserId }));
  }

  async requireConnection(scope: ActorScope, connectionId: string) {
    this.config();
    if (!connectionId) throw new ZoomError("zoom_connection_unavailable");
    const connection = await db().zoomConnection.findFirst({ where: { id: connectionId, workspaceId: scope.workspaceId, revokedAt: null } });
    if (!connection) throw new ZoomError("zoom_connection_unavailable");
    // A rule can use a connected Workspace member's source, but it can't keep
    // using their recordings after they lose Workspace access.
    try { await workspaceService.requireActor(connection.userId, scope.workspaceId, "processing.consume"); }
    catch (error) { if (error instanceof WorkspaceOperationError) throw new ZoomError("zoom_connection_unavailable"); throw error; }
    return connection;
  }

  async createAuthorizationUrl(scope: ActorScope, origin: string) {
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
    // A connection only feeds Autopilot rules, so connecting needs the plan that runs them.
    // Existing connections stay listable and disconnectable after a downgrade.
    requirePlanFeature(actor.pricingTier, "automation.autopilot");
    const config = this.config();
    const state = randomBytes(32).toString("base64url");
    const redirectUri = new URL(ZOOM_CALLBACK_PATH, origin).href;
    await db().zoomOAuthState.deleteMany({ where: { expiresAt: { lte: this.now() } } });
    await db().zoomOAuthState.create({ data: { workspaceId: scope.workspaceId, userId: scope.actorUserId, stateHash: zoomStateHash(state), redirectUri, expiresAt: new Date(this.now().getTime() + 10 * 60_000) } });
    const url = new URL("https://zoom.us/oauth/authorize");
    url.search = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: redirectUri, state, scope: ZOOM_SCOPES.join(" ") }).toString();
    return url.href;
  }

  async handleCallback(scope: ActorScope, input: { state: string; code: string; origin: string }) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.state)) throw new ZoomError("zoom_oauth_state_invalid");
    const redirectUri = new URL(ZOOM_CALLBACK_PATH, input.origin).href;
    const state = await db().$transaction(async (tx) => {
      const row = await tx.zoomOAuthState.findUnique({ where: { stateHash: zoomStateHash(input.state) } });
      if (!row || row.userId !== scope.actorUserId || row.workspaceId !== scope.workspaceId || row.redirectUri !== redirectUri || row.expiresAt <= this.now()) throw new ZoomError("zoom_oauth_state_invalid");
      const consumed = await tx.zoomOAuthState.deleteMany({ where: { id: row.id } });
      if (consumed.count !== 1) throw new ZoomError("zoom_oauth_state_invalid");
      return row;
    });
    await workspaceService.requireActor(state.userId, state.workspaceId, "content.edit");
    const tokens = await this.api().exchange(input.code, redirectUri);
    const identity = await this.api().me(tokens.access_token);
    // Recheck after network work; the member may have been removed meanwhile.
    await workspaceService.requireActor(state.userId, state.workspaceId, "content.edit");
    const data = { zoomAccountId: identity.account_id, displayName: identity.displayName, accessTokenEncrypted: this.cipher().seal(tokens.access_token), refreshTokenEncrypted: this.cipher().seal(tokens.refresh_token), expiresAt: new Date(this.now().getTime() + tokens.expires_in * 1000), scopes: tokens.scope.split(" "), revokedAt: null };
    await db().zoomConnection.upsert({ where: { workspaceId_userId_zoomUserId: { workspaceId: state.workspaceId, userId: state.userId, zoomUserId: identity.id } }, create: { workspaceId: state.workspaceId, userId: state.userId, zoomUserId: identity.id, ...data }, update: data });
    // Reconnecting never resumes rules or grants without a person's choice.
  }

  async disconnect(scope: ActorScope, id: string) {
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
    const row = await db().zoomConnection.findFirst({ where: { id, workspaceId: scope.workspaceId } });
    if (!row) throw new ZoomError("zoom_connection_unavailable");
    if (row.userId !== scope.actorUserId && !workspaceAllowsCapability(actor, "workspace.manage")) throw new ZoomError("zoom_connection_forbidden");
    const sealed = await this.revokeConnection(id);
    if (sealed) {
      try { await this.api().revoke(this.cipher().open(sealed)); }
      catch { console.warn(JSON.stringify({ level: "warn", message: "zoom_provider_revoke_failed", connectionId: id })); }
    }
  }

  private async revokeConnection(id: string, before?: Date) {
    return db().$transaction(async (tx) => {
      // Match the rule-then-connection order used by intake and rule saves.
      await tx.$queryRaw`SELECT "id" FROM "AutopilotRule" WHERE "zoomConnectionId" = ${id}::uuid ORDER BY "id" FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "ZoomConnection" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const connection = await tx.zoomConnection.findUnique({ where: { id } });
      if (!connection || connection.revokedAt || (before && connection.updatedAt > before)) return null;
      await tx.zoomConnection.update({ where: { id }, data: { revokedAt: this.now(), accessTokenEncrypted: null, refreshTokenEncrypted: null, expiresAt: null } });
      const rules = await tx.autopilotRule.findMany({ where: { zoomConnectionId: id }, select: { id: true } });
      await tx.autopilotRule.updateMany({ where: { zoomConnectionId: id }, data: { status: "paused", pauseKind: "zoom_connection", claimToken: null, leaseExpiresAt: null, lastError: "Zoom access was revoked. Reconnect Zoom, then resume this rule." } });
      for (const rule of rules) await pauseGrantsWhoseRuleChanged(tx, rule.id);
      await flushWorkspaceEvents(tx);
      return connection.accessTokenEncrypted;
    });
  }

  async acceptWebhook(input: { rawBody: string; timestamp: string | null; signature: string | null }) {
    const config = this.config();
    if (Buffer.byteLength(input.rawBody) > ZOOM_WEBHOOK_MAX_BYTES) throw new ZoomError("zoom_payload_invalid");
    let body: Record<string, unknown>;
    try { body = JSON.parse(input.rawBody); } catch { throw new ZoomError("zoom_payload_invalid"); }
    if (!body || typeof body !== "object") throw new ZoomError("zoom_payload_invalid");
    // Zoom's initial CRC is authenticated by possession of the secret in the
    // response; it does not need an OAuth session or a database connection.
    if (body.event === "endpoint.url_validation") return zoomValidationChallenge((body.payload as Record<string, unknown> | undefined)?.plainToken, config.webhookSecret);
    verifyZoomSignature({ ...input, secret: config.webhookSecret, nowMs: this.now().getTime() });
    const parsed = parseZoomNotification(body);
    if (!parsed) return { accepted: true };
    await db().zoomWebhookJob.createMany({ data: [{ eventKey: parsed.eventKey, payload: parsed.notification }], skipDuplicates: true });
    return { accepted: true };
  }

  /** A fresh recording URL and access token, kept in memory for this download.
   * Refresh tokens rotate under the connection row lock across all workers. */
  async recordingDownload(input: { connectionId: string; projectId: string; meetingUuid: string; recordingId: string }) {
    const project = await db().project.findUnique({ where: { id: input.projectId }, select: { workspaceId: true } });
    if (!project) throw new ZoomError("zoom_recording_unavailable");
    const connection = await this.requireConnection({ actorUserId: "", workspaceId: project.workspaceId }, input.connectionId);
    let authorizedAt = connection.updatedAt;
    try {
      const accessToken = await db().$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "ZoomConnection" WHERE "id" = ${connection.id}::uuid FOR UPDATE`;
        const row = await tx.zoomConnection.findUniqueOrThrow({ where: { id: connection.id } });
        authorizedAt = row.updatedAt;
        if (row.revokedAt || !row.accessTokenEncrypted || !row.refreshTokenEncrypted) throw new ZoomError("zoom_connection_unavailable");
        if (row.expiresAt && row.expiresAt.getTime() > this.now().getTime() + 60_000) return this.cipher().open(row.accessTokenEncrypted);
        const refreshed = await this.api().refresh(this.cipher().open(row.refreshTokenEncrypted));
        const refreshedRow = await tx.zoomConnection.update({ where: { id: row.id }, data: { accessTokenEncrypted: this.cipher().seal(refreshed.access_token), refreshTokenEncrypted: this.cipher().seal(refreshed.refresh_token), expiresAt: new Date(this.now().getTime() + refreshed.expires_in * 1000), scopes: refreshed.scope.split(" ") } });
        authorizedAt = refreshedRow.updatedAt;
        return refreshed.access_token;
      }, { timeout: 25_000 });
      return { downloadUrl: await this.api().recording(accessToken, input.meetingUuid, input.recordingId, connection.zoomUserId), accessToken };
    } catch (error) {
      if (error instanceof ZoomError && error.code === "zoom_connection_unavailable") await this.revokeConnection(connection.id, authorizedAt);
      throw error;
    }
  }

  async processDueNotifications(limit = 3) {
    const prisma = db(), now = this.now();
    await prisma.autopilotRule.updateMany({
      where: { sourceKind: "zoom", status: "active", OR: [{ zoomConnectionId: null }, { zoomConnection: { revokedAt: { not: null } } }] },
      data: { status: "paused", pauseKind: "zoom_connection", lastError: "Zoom access is unavailable. Reconnect Zoom, choose its connection, then resume this rule." },
    });
    await prisma.zoomWebhookJob.deleteMany({ where: { status: "completed", completedAt: { lt: new Date(now.getTime() - 30 * 86_400_000) } } });
    await prisma.zoomWebhookJob.updateMany({ where: { status: "running", leaseExpiresAt: { lte: now } }, data: { status: "queued", claimToken: null, leaseExpiresAt: null } });
    const jobs = await prisma.zoomWebhookJob.findMany({ where: { status: "queued", availableAt: { lte: now } }, orderBy: { createdAt: "asc" }, take: Math.max(1, Math.min(10, limit)) });
    let checked = 0;
    for (const job of jobs) {
      const claimToken = randomUUID();
      const claimed = await prisma.zoomWebhookJob.updateMany({ where: { id: job.id, status: "queued" }, data: { status: "running", claimToken, leaseExpiresAt: new Date(this.now().getTime() + 120_000), attempts: { increment: 1 } } });
      if (!claimed.count) continue;
      checked++;
      const where = { id: job.id, status: "running", claimToken, leaseExpiresAt: { gt: this.now() } };
      try {
        const notification = zoomNotificationSchema.parse(job.payload);
        if (notification.event === "app_deauthorized") {
          const connections = await prisma.zoomConnection.findMany({ where: { zoomAccountId: notification.accountId, zoomUserId: notification.userId, revokedAt: null } });
          for (const connection of connections) await this.revokeConnection(connection.id, new Date(notification.eventTs));
        } else await this.importNotification(notification, job.createdAt);
        await prisma.zoomWebhookJob.updateMany({ where: { ...where, leaseExpiresAt: { gt: this.now() } }, data: { status: "completed", completedAt: this.now(), claimToken: null, leaseExpiresAt: null, lastError: null } });
      } catch (error) {
        // No provider response, payload, or token is included in durable errors.
        const code = error instanceof ProcessingUsageError || error instanceof ZoomError ? error.code : "zoom_import_failed";
        await prisma.zoomWebhookJob.updateMany({ where: { ...where, leaseExpiresAt: { gt: this.now() } }, data: { status: "queued", claimToken: null, leaseExpiresAt: null, availableAt: new Date(this.now().getTime() + Math.min(3_600_000, 60_000 * 2 ** Math.min(job.attempts, 6))), lastError: code } });
        console.warn(JSON.stringify({ level: "warn", message: "zoom_notification_deferred", jobId: job.id, code }));
      }
    }
    return checked;
  }

  private async importNotification(notification: ZoomRecordingNotification, receivedAt: Date) {
    const prisma = db();
    const rules = await prisma.autopilotRule.findMany({ where: { sourceKind: "zoom", status: { in: ["active", "paused"] }, createdAt: { lte: new Date(Math.min(receivedAt.getTime(), notification.eventTs)) }, zoomConnection: { zoomAccountId: notification.accountId, zoomUserId: notification.hostId, revokedAt: null }, workspace: { status: "active" } } });
    let deferred: unknown = null;
    for (const rule of rules) {
      if (rule.zoomTopicFilter && !notification.topic.toLocaleLowerCase().includes(rule.zoomTopicFilter.toLocaleLowerCase())) continue;
      if (rule.status === "paused") {
        if (rule.pauseKind === "brand_profile" || rule.pauseKind === "acting_member") deferred ??= new ZoomError("zoom_rule_changed");
        continue;
      }
      const scope = { actorUserId: rule.createdByUserId ?? "", workspaceId: rule.workspaceId };
      const pause = async (kind: "acting_member" | "zoom_connection" | "brand_profile" | "plan", reason: string) => {
        await prisma.autopilotRule.updateMany({ where: { id: rule.id, status: "active", updatedAt: rule.updatedAt }, data: { status: "paused", pauseKind: kind, lastError: reason, lastCheckedAt: this.now() } });
      };
      // A rule the plan no longer runs pauses before importing anything; the notification is done with.
      const planReason = await autopilotPlanPauseReason(prisma, rule);
      if (planReason) { await pause("plan", planReason); continue; }
      try {
        if (!rule.createdByUserId) { await pause("acting_member", "The rule's acting member is unavailable. A Workspace Owner or Admin can take over."); deferred ??= new ZoomError("zoom_rule_changed"); continue; }
        await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "processing.consume");
        await this.requireConnection(scope, rule.zoomConnectionId!);
        const recipe = await recipeService.resolve(scope, rule.recipeId);
        await projectService.importZoomRecording(scope, { ruleId: rule.id, ruleUpdatedAt: rule.updatedAt, connectionId: rule.zoomConnectionId!, notification, titlePrefix: rule.titlePrefix, recipe });
        await prisma.autopilotRule.updateMany({ where: { id: rule.id, status: "active", updatedAt: rule.updatedAt }, data: { lastCheckedAt: this.now(), lastSuccessAt: this.now(), lastError: null, consecutiveFailures: 0 } });
      } catch (error) {
        if (error instanceof WorkspaceOperationError && error.code === "workspace_access_denied") {
          await pause("acting_member", "The rule's acting member can no longer process videos. A Workspace Owner or Admin can take over.");
          deferred ??= error;
        }
        else if (error instanceof ZoomError && error.code === "zoom_connection_unavailable") await pause("zoom_connection", error.message);
        else if (error instanceof BrandProfileNotFoundError || error instanceof BrandProfileMissingAssetError || error instanceof BrandProfileMembershipError || isBrandAccessRefusal(error)) {
          await pause("brand_profile", "The Recipe's Brand Profile could not be applied. Fix the Brand Profile, then resume this rule.");
          deferred ??= error;
        }
        else if (!(error instanceof ProcessingUsageError && error.code === "upload_too_long")) {
          deferred ??= error;
          await prisma.autopilotRule.updateMany({ where: { id: rule.id, status: "active", updatedAt: rule.updatedAt }, data: { lastCheckedAt: this.now(), lastError: error instanceof ProcessingUsageError ? error.message : "Zoom import will be retried." } });
        }
      }
    }
    if (deferred) throw deferred;
  }
}

export const zoomService = new ZoomService();
