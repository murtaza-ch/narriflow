import { PROGRESS_FRAME_MAX_BYTES, progressSocketFrameSchema, progressTicketResponseSchema } from "@narriflow/validators/api/progress";
import { ApiError, CLIENT_ERROR_CODES, scopeChangedError } from "../core/error";
import type { BoundTransport } from "../core/transport";
import { decodeProgressMessage, type ProgressMessage } from "./events";

export type StreamStatus = { state: "connecting"; attempt: number } | { state: "open"; attempt: number } | { state: "reconnecting"; attempt: number; retryInMs: number; error: ApiError | null } | { state: "closed" };
export type StreamEnd = { reason: "aborted" } | { reason: "fatal"; error: ApiError };
export interface ProgressSocketOptions {
  transport: BoundTransport;
  projectId: string;
  signal: AbortSignal;
  initialCursor?: number;
  onEvent(message: ProgressMessage): void | Promise<void>;
  onStatus?(status: StreamStatus): void;
  /** Browser transport seams, used by the deterministic client gates. */
  createSocket?(url: string): WebSocket;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  random?(): number;
  idleTimeoutMs?: number;
}
export const MAX_STREAM_RETRY_AFTER_SECONDS = 300;
const error = (code: string, message: string) => new ApiError({ code, message, status: 0 });
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener("abort", done, { once: true });
  });
}
class ApplicationFailure extends Error { constructor(readonly original: unknown) { super("Progress consumer failed"); } }

/** One bounded queue, rather than one Promise per received message. */
async function* messages(socket: WebSocket, signal: AbortSignal, idleTimeoutMs: number, expiresAt: number): AsyncGenerator<string> {
  const queue: string[] = [];
  let finished = false;
  let failure: ApiError | undefined;
  let wake = () => {};
  let lastReceived = Date.now();
  const end = () => { finished = true; wake(); };
  const fail = (value: ApiError) => { failure = value; end(); socket.close(); };
  const onMessage = (event: MessageEvent) => {
    lastReceived = Date.now();
    if (event.data === "pong") return;
    if (typeof event.data !== "string" || new TextEncoder().encode(event.data).byteLength > PROGRESS_FRAME_MAX_BYTES || queue.length >= 256) {
      fail(error("stream_protocol", "Progress exceeded its frame or queue limit.")); return;
    }
    queue.push(event.data); wake();
  };
  const onError = () => fail(error(CLIENT_ERROR_CODES.network, "The progress connection was interrupted."));
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", end);
  socket.addEventListener("error", onError);
  signal.addEventListener("abort", end, { once: true });
  const expiry = setTimeout(() => { end(); socket.close(1000, "Renew progress authorization"); }, Math.max(1, Math.min(60_000, expiresAt - Date.now())));
  const timer = setInterval(() => {
    if (Date.now() - lastReceived >= idleTimeoutMs) fail(error(CLIENT_ERROR_CODES.streamIdle, "The progress connection went silent."));
    else if (socket.readyState === 1) socket.send("ping");
  }, Math.min(20_000, Math.max(10, Math.floor(idleTimeoutMs / 2))));
  try {
    while (!signal.aborted) {
      if (queue.length) { yield queue.shift()!; continue; }
      if (finished) { if (failure) throw failure; return; }
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally {
    clearTimeout(expiry); clearInterval(timer); socket.removeEventListener("message", onMessage); socket.removeEventListener("close", end); socket.removeEventListener("error", onError); signal.removeEventListener("abort", end); socket.close();
  }
}

/** A fresh Bearer-authorized ticket for each connection. Only the connect
 * ticket enters the socket URL. Idle sockets hold no HTTP request or SQL. */
export async function runProgressSocket(options: ProgressSocketOptions): Promise<StreamEnd> {
  const tracked = options.transport.track(options.signal);
  const signal = tracked.signal;
  let cursor = options.initialCursor ?? 0;
  let attempt = 0;
  try {
    while (!signal.aborted) {
      options.onStatus?.({ state: "connecting", attempt });
      let failure: ApiError | null = null;
      let delivered = false;
      try {
        const ticket = await options.transport.json(`/api/projects/${encodeURIComponent(options.projectId)}/progress-ticket`, { method: "POST", json: {}, signal, parse: progressTicketResponseSchema.parse });
        if (signal.aborted) break;
        const url = new URL(`/api/progress/${encodeURIComponent(options.projectId)}`, options.transport.baseUrl);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("ticket", ticket.ticket);
        url.searchParams.set("sinceSeq", String(cursor));
        const socket = (options.createSocket ?? ((address) => new WebSocket(address)))(url.href);
        for await (const raw of messages(socket, signal, options.idleTimeoutMs ?? 45_000, ticket.subscriptionExpiresAt)) {
          let frame;
          try { frame = progressSocketFrameSchema.parse(JSON.parse(raw)); }
          catch { throw error("stream_protocol", "Progress sent an invalid frame."); }
          if (frame.type === "resync") break;
          if (frame.type === "connected") {
            if (frame.projectId !== options.projectId || frame.cursor !== cursor) throw error("stream_protocol", "Progress cursor or Project changed.");
            options.onStatus?.({ state: "open", attempt }); continue;
          }
          if (frame.type === "event") {
            if (frame.event.projectId !== options.projectId) throw error("stream_protocol", "Progress crossed its Project scope.");
            if (frame.event.seq <= cursor) continue;
            if (frame.event.seq !== cursor + 1) break;
          }
          const message = decodeProgressMessage(frame);
          if (message) { try { await options.onEvent(message); } catch (cause) { throw new ApplicationFailure(cause); } }
          if (frame.type === "event") { cursor = frame.event.seq; delivered = true; }
          if (frame.type === "reset") { cursor = frame.cursor; delivered = true; }
          if (frame.type === "revoked") {
            if (frame.control.error === "authentication_required") break;
            return { reason: "fatal", error: new ApiError({ code: frame.control.error, message: "Progress access ended.", status: 403 }) };
          }
        }
      } catch (cause) {
        if (cause instanceof ApplicationFailure) throw cause.original;
        if (signal.aborted) break;
        failure = cause instanceof ApiError ? cause : error(CLIENT_ERROR_CODES.network, "Progress could not connect.");
        const retryable = failure.code !== CLIENT_ERROR_CODES.scopeChanged && (failure.status === 0 || failure.status === 408 || failure.status === 429 || failure.status >= 500);
        if (!retryable || (failure.retryAfterSeconds ?? 0) > MAX_STREAM_RETRY_AFTER_SECONDS) return { reason: "fatal", error: failure };
      }
      if (signal.aborted) break;
      attempt = delivered ? 0 : attempt + 1;
      const ceiling = Math.min(1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 5), 30_000);
      const retryInMs = Math.max(Math.round(ceiling * (0.5 + (options.random ?? Math.random)() / 2)), (failure?.retryAfterSeconds ?? 0) * 1_000);
      options.onStatus?.({ state: "reconnecting", attempt, retryInMs, error: failure });
      await (options.sleep ?? sleep)(retryInMs, signal);
    }
    return tracked.scopeAborted ? { reason: "fatal", error: scopeChangedError() } : { reason: "aborted" };
  } finally { tracked.release(); options.onStatus?.({ state: "closed" }); }
}
