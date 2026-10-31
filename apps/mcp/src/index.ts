import { StreamableHTTPClientTransport, SdkHttpError, UnauthorizedError, type JSONRPCMessage, type RequestId } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const credential = process.env.NARRIFLOW_API_KEY?.trim();
if (!credential || !/^[^\s,]{1,8192}$/.test(credential)) throw new Error("NARRIFLOW_API_KEY must contain one Bearer credential");
const origin = new URL(process.env.NARRIFLOW_URL ?? "http://localhost:4000");
if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
  !(origin.protocol === "https:" || origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) {
  throw new Error("NARRIFLOW_URL must be an HTTPS API origin or a loopback HTTP origin");
}

const wire = new StdioServerTransport();
const remote = new StreamableHTTPClientTransport(new URL("/mcp", origin), {
  authProvider: { token: async () => credential },
  requestInit: { credentials: "omit", redirect: "error" },
  onInsufficientScope: "throw",
});
interface Pending { controller: AbortController; modern: boolean; initialize: boolean }
const pending = new Map<RequestId, Pending>();
let modernConnection = false;
let closed = false;
const diagnostic = (error: unknown) => console.warn(JSON.stringify({ level: "warn", message: "mcp_remote_transport_error", errorName: error instanceof Error ? error.name : "unknown" }));

async function close() {
  if (closed) return;
  closed = true;
  for (const request of pending.values()) request.controller.abort();
  pending.clear();
  await remote.close();
  await wire.close();
}
function write(message: JSONRPCMessage) { if (!closed) void wire.send(message).catch(() => close()); }
function fail(id: RequestId, cause: unknown) {
  const request = pending.get(id);
  if (!request || request.controller.signal.aborted || closed) return;
  pending.delete(id);
  const status = cause instanceof UnauthorizedError ? 401 : cause instanceof SdkHttpError ? cause.status : 0;
  write({ jsonrpc: "2.0", id, error: { code: status === 401 ? -32001 : status === 403 ? -32003 : -32002,
    message: status === 401 ? "Narriflow credential is invalid or revoked" : status === 403 ? "Narriflow refused this request" : "Narriflow request is temporarily unavailable",
    data: { error: status === 401 ? "invalid_token" : status === 403 ? "permission_denied" : "temporarily_unavailable", httpStatus: status } } });
}

remote.onmessage = (message) => {
  if ("id" in message && !("method" in message) && (typeof message.id === "string" || typeof message.id === "number")) {
    const request = pending.get(message.id);
    if (request?.initialize && "result" in message) {
      const version = message.result.protocolVersion;
      if (typeof version === "string" && /^\d{4}-\d{2}-\d{2}$/.test(version)) remote.setProtocolVersion(version);
    }
    pending.delete(message.id);
  }
  write(message);
};
remote.onerror = diagnostic;
remote.onclose = () => { void close(); };
wire.onerror = diagnostic;
wire.onclose = () => { void close(); };
wire.onmessage = (message) => { void forward(message); };

async function forward(message: JSONRPCMessage) {
  if (closed) return;
  if ("method" in message && message.method === "notifications/cancelled") {
    const id = message.params?.requestId;
    const request = typeof id === "string" || typeof id === "number" ? pending.get(id) : undefined;
    if (request?.modern) {
      request.controller.abort();
      pending.delete(id as RequestId);
      return;
    }
    if (!request && modernConnection) return;
  }
  const request = "method" in message && "id" in message ? message : null;
  if (!request) {
    try { await remote.send(message); } catch (cause) { diagnostic(cause); }
    return;
  }
  if (pending.has(request.id)) {
    write({ jsonrpc: "2.0", id: request.id, error: { code: -32600, message: "Request ID is already in flight" } });
    return;
  }
  const modern = request.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28";
  modernConnection = modern;
  const controller = new AbortController();
  pending.set(request.id, { controller, modern, initialize: request.method === "initialize" });
  try {
    await remote.send(message, { requestSignal: controller.signal,
      onRequestStreamEnd: () => fail(request.id, new Error("Remote stream ended before its response")),
    });
  } catch (cause) { fail(request.id, cause); }
}

process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
await remote.start();
await wire.start();
