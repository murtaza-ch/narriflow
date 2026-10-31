import { DurableObject } from "cloudflare:workers";
import { localFetchDeviceClaimsSchema, type LocalFetchDeviceClaims } from "@narriflow/validators/api/local-fetch";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { requireLocalFetchDevelopment } from "@narriflow/services/local-fetch-device";

interface Bindings { [name: string]: string | undefined; API_ORIGIN?: string }
interface Attachment { sessionId: string; connectedAt: number; expiresAt: number }
type Row = { claims: string };
const PRESENCE_MS = 45_000;

/** One development Workspace mailbox. Idle ping/pong and presence use the
 * hibernation runtime, with no PostgreSQL client or provider credential. */
export class LocalFetchMailbox extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS device (singleton INTEGER PRIMARY KEY CHECK(singleton=1), claims TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tickets (nonce TEXT PRIMARY KEY, session_id TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  private current(): LocalFetchDeviceClaims | null {
    const row = this.ctx.storage.sql.exec<Row>("SELECT claims FROM device WHERE singleton=1").toArray()[0];
    if (!row) return null;
    const claims = localFetchDeviceClaimsSchema.parse(JSON.parse(row.claims));
    requireLocalFetchDevelopment(this.env, claims.workspaceId);
    return claims.expiresAt > Date.now() ? claims : null;
  }
  private socket(claims: LocalFetchDeviceClaims) {
    return this.ctx.getWebSockets(`session:${claims.sessionId}`).find(socket => {
      const state = socket.deserializeAttachment() as Attachment;
      const last = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? state.connectedAt;
      return socket.readyState === WebSocket.OPEN && Date.now() - last <= PRESENCE_MS && state.expiresAt > Date.now();
    });
  }
  async register(value: LocalFetchDeviceClaims) {
    const claims = localFetchDeviceClaimsSchema.parse(value);
    requireLocalFetchDevelopment(this.env, claims.workspaceId);
    if (this.ctx.id.name !== claims.workspaceId || claims.apiOrigin !== this.env.API_ORIGIN || claims.issuedAt > Date.now() + 5000 ||
      claims.expiresAt <= Date.now() || claims.expiresAt - claims.issuedAt !== 2 * 60 * 60_000) throw new Error("local_fetch_session_invalid");
    for (const socket of this.ctx.getWebSockets()) socket.close(1008, "Device session replaced");
    this.ctx.storage.sql.exec("DELETE FROM tickets");
    this.ctx.storage.sql.exec("INSERT INTO device VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET claims=excluded.claims", JSON.stringify(claims));
    await this.ctx.storage.setAlarm(claims.expiresAt);
  }
  async authorize(sessionId: string) {
    const claims = this.current();
    if (!claims || claims.sessionId !== sessionId) throw new Error("local_fetch_session_invalid");
    return claims;
  }
  async connectTicket(sessionId: string) {
    const claims = await this.authorize(sessionId), nonce = crypto.randomUUID(), expiresAt = Math.min(Date.now() + 30_000, claims.expiresAt);
    this.ctx.storage.sql.exec("DELETE FROM tickets WHERE expires_at <= ?", Date.now());
    if (this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tickets").toArray()[0]!.n >= 10) throw new Error("local_fetch_ticket_limit");
    this.ctx.storage.sql.exec("INSERT INTO tickets VALUES(?,?,?)", nonce, sessionId, expiresAt);
    await this.ctx.storage.setAlarm(expiresAt);
    return { ticket: nonce, expiresAt };
  }
  async presence() {
    const claims = this.current();
    return { available: !!claims && !!this.socket(claims) };
  }
  async deliver(value: { reference: ExecutionDispatchReference; attemptToken: string }) {
    const reference = executionDispatchReferenceSchema.parse(value.reference), claims = this.current();
    if (!claims || reference.kind !== "local_fetch" || reference.subject.kind !== "ingest_job" || reference.deploymentEpoch !== claims.deploymentEpoch ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.attemptToken)) throw new Error("local_fetch_session_invalid");
    const socket = this.socket(claims);
    if (!socket) throw new Error("local_fetch_offline");
    socket.send(JSON.stringify({ type: "fetch", reference, attemptToken: value.attemptToken }));
    return { destinationId: claims.sessionId };
  }
  async revoke(input: { workspaceId: string; actorUserId?: string; authorizedBefore: number }) {
    const claims = this.current();
    if (!claims || claims.workspaceId !== input.workspaceId || claims.issuedAt > input.authorizedBefore ||
      input.actorUserId && claims.actorUserId !== input.actorUserId) return;
    for (const socket of this.ctx.getWebSockets()) socket.close(1008, "Device authorization ended");
    this.ctx.storage.sql.exec("DELETE FROM device"); this.ctx.storage.sql.exec("DELETE FROM tickets");
    await this.ctx.storage.deleteAlarm();
  }
  override async fetch(request: Request) {
    const url = new URL(request.url), claims = this.current();
    if (!claims || request.headers.get("Origin") !== claims.apiOrigin || url.pathname !== `/api/dev-device/${claims.workspaceId}/socket`) return new Response(null, { status: 403 });
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
    const nonce = url.searchParams.get("ticket");
    if (!nonce || !/^[a-f0-9-]{36}$/.test(nonce)) return new Response(null, { status: 401 });
    const consumed = this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ session_id: string; expires_at: number }>("SELECT session_id,expires_at FROM tickets WHERE nonce=?", nonce).toArray()[0];
      if (!row || row.session_id !== claims.sessionId || row.expires_at <= Date.now()) return false;
      this.ctx.storage.sql.exec("DELETE FROM tickets WHERE nonce=?", nonce); return true;
    });
    if (!consumed) return new Response(null, { status: 401 });
    for (const socket of this.ctx.getWebSockets()) socket.close(1001, "Device reconnected");
    const pair = new WebSocketPair(), socket = pair[1];
    this.ctx.acceptWebSocket(socket, [`session:${claims.sessionId}`]);
    socket.serializeAttachment({ sessionId: claims.sessionId, connectedAt: Date.now(), expiresAt: claims.expiresAt } satisfies Attachment);
    await this.ctx.storage.setAlarm(claims.expiresAt);
    socket.send(JSON.stringify({ type: "connected", expiresAt: claims.expiresAt }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  override async webSocketMessage(socket: WebSocket) { socket.close(1008, "Unexpected device message"); }
  override async alarm() {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM tickets WHERE expires_at <= ?", now);
    const claims = this.current();
    if (!claims) {
      for (const socket of this.ctx.getWebSockets()) socket.close(1008, "Device session expired");
      this.ctx.storage.sql.exec("DELETE FROM device"); return;
    }
    const ticket = this.ctx.storage.sql.exec<{ at: number | null }>("SELECT MIN(expires_at) AS at FROM tickets").toArray()[0]?.at;
    await this.ctx.storage.setAlarm(Math.min(claims.expiresAt, ticket ?? claims.expiresAt));
  }
}
