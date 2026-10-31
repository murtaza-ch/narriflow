import { DurableObject } from "cloudflare:workers";
import { createProgressTicketCodec, loadProgressTicketKeys } from "@narriflow/services/progress-ticket";
import type { ProgressReplay } from "@narriflow/services/progress-feed";
import { PROGRESS_FRAME_MAX_BYTES, progressSocketFrameSchema, workflowStageUpdatedEventSchema, type ProgressSocketFrame, type ProgressTicketPayload, type WorkflowStageUpdatedEvent } from "@narriflow/validators/api/progress";

interface ProgressBindings { [name: string]: string | undefined; API_ORIGIN?: string; PROGRESS_CONNECT_KEY_ID?: string; PROGRESS_CONNECT_KEYS_JSON?: string }
interface Scope { projectId: string; workspaceId: string }
interface Attachment extends Scope { actorUserId: string; nonce: string; authorizedAt: number; expiresAt: number; cursor: number; replaying: boolean }
export interface ProgressRevocation extends Scope { actorUserId?: string; authorizedBefore: number; error: "workspace_membership_required" | "workspace_restricted" | "project_inaccessible" }
const MAX_SOCKETS = 1_000;
const MAX_ACTOR_SOCKETS = 5;
const MAX_CACHED_EVENTS = 1_000;
const MAX_FLUSH_FRAMES = 256;

/** A hibernating delivery cache. PostgreSQL remains the authoritative event log. */
export class ProjectProgress extends DurableObject<ProgressBindings> {
  constructor(ctx: DurableObjectState, env: ProgressBindings) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS scope (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), project_id TEXT NOT NULL, workspace_id TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS revocations (actor TEXT PRIMARY KEY, cutoff INTEGER NOT NULL, expires_at INTEGER NOT NULL, error TEXT NOT NULL)");
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private bind(scope: Scope): boolean {
    const current = this.ctx.storage.sql.exec<{ project_id: string; workspace_id: string }>("SELECT project_id, workspace_id FROM scope WHERE singleton = 1").toArray()[0];
    if (current) return current.project_id === scope.projectId && current.workspace_id === scope.workspaceId;
    if (this.ctx.id.name && this.ctx.id.name !== scope.projectId) return false;
    this.ctx.storage.sql.exec("INSERT INTO scope VALUES (1, ?, ?)", scope.projectId, scope.workspaceId);
    return true;
  }

  private attachment(socket: WebSocket): Attachment { return socket.deserializeAttachment() as Attachment; }
  private send(socket: WebSocket, frame: ProgressSocketFrame): boolean {
    try {
      const text = JSON.stringify(progressSocketFrameSchema.parse(frame));
      if (new TextEncoder().encode(text).byteLength > PROGRESS_FRAME_MAX_BYTES) throw new Error("Frame exceeds limit");
      socket.send(text);
      return true;
    } catch { try { socket.close(1012, "Reconnect progress"); } catch { /* Already closed. */ } return false; }
  }
  private close(socket: WebSocket, error: string) {
    this.send(socket, { type: "revoked", control: { error } });
    try { socket.close(1008, "Progress authorization ended"); } catch (error) { console.warn(JSON.stringify({ level: "warn", message: "progress_close_failed", error: String(error) })); }
  }
  private revoked(scope: Pick<ProgressTicketPayload, "actorUserId" | "authorizedAt">): string | null {
    const rows = this.ctx.storage.sql.exec<{ cutoff: number; error: string }>("SELECT cutoff, error FROM revocations WHERE actor IN ('*', ?) AND expires_at > ? ORDER BY cutoff DESC", scope.actorUserId, Date.now()).toArray();
    return rows.find((row) => scope.authorizedAt <= row.cutoff)?.error ?? null;
  }
  private async schedule() {
    const now = Date.now();
    const expiries = this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN).map((socket) => this.attachment(socket).expiresAt);
    const row = this.ctx.storage.sql.exec<{ expiry: number | null }>("SELECT MIN(expiry) AS expiry FROM (SELECT MIN(expires_at) AS expiry FROM nonces UNION ALL SELECT MIN(expires_at) AS expiry FROM revocations)").toArray()[0];
    if (row?.expiry) expiries.push(row.expiry);
    const earliest = Math.min(...expiries);
    if (Number.isFinite(earliest)) {
      const target = Math.max(now + 1, earliest);
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current !== target) await this.ctx.storage.setAlarm(target);
    } else await this.ctx.storage.deleteAlarm();
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (!origin) return new Response(null, { status: 403 });
    let ticket: ProgressTicketPayload;
    try {
      ticket = await createProgressTicketCodec(loadProgressTicketKeys(this.env)).verify(url.searchParams.get("ticket") ?? "", { origin, audience: new URL("/api/progress", this.env.API_ORIGIN).href, nowMs: Date.now() });
    } catch { return new Response(null, { status: 401 }); }
    if (url.pathname !== `/api/progress/${ticket.projectId}` || !this.bind(ticket)) return new Response(null, { status: 403 });
    const revoked = this.revoked(ticket);
    if (revoked) return Response.json({ error: revoked }, { status: 403 });
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response(null, { status: 503, headers: { "Retry-After": "5" } });
    if (this.ctx.getWebSockets(`actor:${ticket.actorUserId}`).length >= MAX_ACTOR_SOCKETS) return new Response(null, { status: 429, headers: { "Retry-After": "5" } });
    const cursor = Number(url.searchParams.get("sinceSeq") ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) return new Response(null, { status: 400 });
    const used = this.ctx.storage.transactionSync(() => {
      if (this.ctx.storage.sql.exec("SELECT 1 FROM nonces WHERE nonce = ?", ticket.nonce).toArray().length) return true;
      this.ctx.storage.sql.exec("INSERT INTO nonces VALUES (?, ?)", ticket.nonce, ticket.subscriptionExpiresAt);
      return false;
    });
    if (used) return new Response(null, { status: 409 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const socket = pair[1];
    this.ctx.acceptWebSocket(socket, [`actor:${ticket.actorUserId}`, `nonce:${ticket.nonce}`]);
    socket.serializeAttachment({ projectId: ticket.projectId, workspaceId: ticket.workspaceId, actorUserId: ticket.actorUserId, nonce: ticket.nonce, authorizedAt: ticket.authorizedAt, expiresAt: ticket.subscriptionExpiresAt, cursor, replaying: true } satisfies Attachment);
    await this.schedule();
    return new Response(null, { status: 101, webSocket: client, headers: { "X-Progress-Connection": ticket.nonce } });
  }

  /** Worker subscribes first, then supplies one bounded SQL replay. */
  async replay(nonce: string, replay: ProgressReplay): Promise<void> {
    const socket = this.ctx.getWebSockets(`nonce:${nonce}`)[0];
    if (!socket) return;
    const state = this.attachment(socket);
    if (Date.now() >= state.expiresAt) { this.close(socket, "authentication_required"); return; }
    const revoked = this.revoked(state);
    if (revoked) { this.close(socket, revoked); return; }
    if (!Number.isSafeInteger(replay.highWater) || replay.highWater < 0 || replay.events.length > 500) throw new Error("Invalid progress replay");
    let tail = this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?", replay.highWater, MAX_CACHED_EVENTS + 1).toArray().map((row) => workflowStageUpdatedEventSchema.parse(JSON.parse(row.payload)));
    let cursor = state.cursor;
    if (replay.reset || replay.events.length + tail.length > MAX_FLUSH_FRAMES) {
      cursor = replay.highWater;
      if (replay.events.length + tail.length > MAX_FLUSH_FRAMES) { cursor = Math.max(cursor, tail.at(-1)?.seq ?? 0); tail = []; }
      if (!this.send(socket, { type: "reset", cursor })) return;
    } else {
      for (const event of replay.events) {
        if (event.projectId !== state.projectId || event.seq !== cursor + 1) { this.resync(socket); return; }
        if (!this.send(socket, { type: "event", event })) return;
        cursor = event.seq;
      }
      if (cursor !== replay.highWater) { this.resync(socket); return; }
    }
    for (const event of tail) {
      if (event.seq !== cursor + 1) { this.resync(socket); return; }
      if (!this.send(socket, { type: "event", event })) return;
      cursor = event.seq;
    }
    state.cursor = cursor;
    state.replaying = false;
    socket.serializeAttachment(state);
    this.send(socket, { type: "connected", projectId: state.projectId, cursor });
  }
  async abortReplay(nonce: string): Promise<void> { const socket = this.ctx.getWebSockets(`nonce:${nonce}`)[0]; if (socket) this.resync(socket); }
  private resync(socket: WebSocket) {
    this.send(socket, { type: "resync" });
    socket.close(1012, "Replay progress gap");
  }

  async publish(scope: Scope, input: WorkflowStageUpdatedEvent): Promise<void> {
    const event = workflowStageUpdatedEventSchema.parse(input);
    if (event.projectId !== scope.projectId || !this.bind(scope)) throw new Error("Progress project scope mismatch");
    const payload = JSON.stringify(event);
    if (new TextEncoder().encode(payload).byteLength > PROGRESS_FRAME_MAX_BYTES - 128) throw new Error("Progress event exceeds frame limit");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT INTO events VALUES (?, ?) ON CONFLICT(seq) DO NOTHING", event.seq, payload);
      this.ctx.storage.sql.exec("DELETE FROM events WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT ?)", MAX_CACHED_EVENTS);
    });
    for (const socket of this.ctx.getWebSockets()) {
      const state = this.attachment(socket);
      if (Date.now() >= state.expiresAt) { this.close(socket, "authentication_required"); continue; }
      if (state.replaying || event.seq <= state.cursor) continue;
      if (event.seq !== state.cursor + 1) { this.resync(socket); continue; }
      if (this.send(socket, { type: "event", event })) { state.cursor = event.seq; socket.serializeAttachment(state); }
    }
  }

  async revoke(input: ProgressRevocation): Promise<void> {
    if (!Number.isSafeInteger(input.authorizedBefore) || !this.bind(input)) throw new Error("Invalid progress revocation scope");
    const actor = input.actorUserId ?? "*";
    this.ctx.storage.sql.exec("INSERT INTO revocations VALUES (?, ?, ?, ?) ON CONFLICT(actor) DO UPDATE SET cutoff = MAX(cutoff, excluded.cutoff), expires_at = MAX(expires_at, excluded.expires_at), error = excluded.error", actor, input.authorizedBefore, input.authorizedBefore + 65_000, input.error);
    // An extreme burst of membership changes can only broaden the revocation.
    if ((this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM revocations").toArray()[0]?.count ?? 0) > 4_096) {
      const cutoff = this.ctx.storage.sql.exec<{ cutoff: number }>("SELECT MAX(cutoff) AS cutoff FROM revocations").toArray()[0]!.cutoff;
      this.ctx.storage.sql.exec("DELETE FROM revocations");
      this.ctx.storage.sql.exec("INSERT INTO revocations VALUES ('*', ?, ?, ?)", cutoff, cutoff + 65_000, input.error);
    }
    for (const socket of this.ctx.getWebSockets(input.actorUserId ? `actor:${input.actorUserId}` : undefined)) {
      if (this.attachment(socket).authorizedAt <= input.authorizedBefore) this.close(socket, input.error);
    }
    await this.schedule();
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) if (this.attachment(socket).expiresAt <= now) this.close(socket, "authentication_required");
    this.ctx.storage.sql.exec("DELETE FROM nonces WHERE expires_at <= ?", now);
    this.ctx.storage.sql.exec("DELETE FROM revocations WHERE expires_at <= ?", now);
    await this.schedule();
  }
  override async webSocketMessage(socket: WebSocket, _message: string | ArrayBuffer) { socket.close(1008, "Progress is server to client"); }
  override async webSocketClose(socket: WebSocket, code: number, reason: string, _wasClean: boolean) { try { socket.close(code, reason); } catch { /* Already closed. */ } await this.schedule(); }
  override async webSocketError(socket: WebSocket) { try { socket.close(1011, "Progress connection failed"); } catch { /* Already closed. */ } await this.schedule(); }
}
