import { ExpectedDomainFailureError, type RateLimitResult } from "@narriflow/services";

export const MCP_JSON_MAX_BYTES = 1024 * 1024;

export function parseMcpOrigins(values: string[]) {
  return values.map((value) => {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("MCP_ALLOWED_ORIGINS must contain complete HTTP origins without paths");
    }
    return url.origin;
  });
}

export function isAcceptedMcpOrigin(origin: string | null, allowed: readonly string[]) {
  if (origin === null) return true;
  try {
    // Origin is serialized as scheme, host and optional port, without a slash.
    const url = new URL(origin);
    return origin === url.origin && allowed.includes(origin);
  } catch { return false; }
}

export function rejectMcpOrigin(request: Request, allowed: readonly string[]) {
  return isAcceptedMcpOrigin(request.headers.get("origin"), allowed) ? null :
    Response.json({ error: "origin_not_allowed" }, { status: 403 });
}

export function mcpCorsResponse(response: Response, request: Request, allowed: readonly string[]) {
  const origin = request.headers.get("origin");
  const headers = new Headers(response.headers);
  const vary = headers.get("Vary")?.split(",").map((part) => part.trim()) ?? [];
  if (!vary.some((part) => part.toLowerCase() === "origin")) vary.push("Origin");
  headers.set("Vary", vary.join(", "));
  if (origin && isAcceptedMcpOrigin(origin, allowed)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Method, MCP-Name");
    headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Protocol-Version, Retry-After");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Read a bounded body once. Content-Length alone cannot establish the byte limit. */
export async function boundedMcpRequest(request: Request, maximum = MCP_JSON_MAX_BYTES): Promise<Request | Response> {
  const length = request.headers.get("Content-Length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    return Response.json({ error: "request_too_large", maximumBytes: maximum }, { status: 413 });
  }
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        return Response.json({ error: "request_too_large", maximumBytes: maximum }, { status: 413 });
      }
      chunks.push(next.value);
    }
  } catch {
    return Response.json({ error: "invalid_request_body" }, { status: 400 });
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new Request(request, { body });
}

/** Invoke only after the owning domain has checked its immutable replay identity. */
export function requireMcpMutationLimiter(result: RateLimitResult) {
  if (!result.allowed) throw new ExpectedDomainFailureError({ code: "mcp_request_limit_exceeded", kind: "rate_limited",
    message: "MCP request limit exceeded", retryAfterSeconds: 60 });
  if (result.availability !== "available") throw new ExpectedDomainFailureError({ code: "mcp_mutations_unavailable", kind: "unavailable",
    message: "New mutations are paused while the request limiter is unavailable", retryAfterSeconds: 5 });
}
