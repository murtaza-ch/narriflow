import { hostHeaderValidationResponse } from "@modelcontextprotocol/server";
import { boundedMcpRequest, mcpCorsResponse, rejectMcpOrigin } from "@narriflow/mcp-core/http";
import { isUuid } from "@narriflow/validators/identifiers";
import { Hono } from "hono";
import type { ApiEnv } from "../../http/env";
import { socketAddress } from "../../server-hooks";

/** The issuer's authorization-server document: plain data, so it can outlive the request that fetched it. */
export interface AuthorizationMetadataCache {
  entry?: { expiresAt: number; document: unknown };
}

export interface McpTransportDeps {
  /** The Worker rebuilds the app per request, so production passes one per isolate; the default is private to this app. */
  metadataCache?: AuthorizationMetadataCache;
  handleMcp(request: Request, socketAddress?: string): Promise<Response>;
  handleUpload(request: Request, workspaceId: string, socketAddress?: string): Promise<Response>;
  allowedHosts: string[];
  allowedOrigins: string[];
  protectedResourceMetadata(): { resource: string; authorization_servers: string[]; bearer_methods_supported: string[]; scopes_supported: string[] };
  issuerUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const discoveryHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "private, no-store",
};

/** Independent protocols mount before first-party CORS and session admission. */
export function createMcpTransportRoutes(deps: McpTransportDeps) {
  const cache = deps.metadataCache ?? {};
  const now = deps.now ?? Date.now;
  const discovery = () => {
    try {
      return Response.json(deps.protectedResourceMetadata(), { headers: discoveryHeaders });
    } catch {
      return Response.json({ error: "protected_resource_metadata_unavailable" }, { status: 502, headers: discoveryHeaders });
    }
  };
  const options = () => new Response(null, { status: 204, headers: discoveryHeaders });
  const authorization = async () => {
    try {
      if (!deps.issuerUrl) throw new Error("OAuth issuer unavailable");
      if (!cache.entry || now() >= cache.entry.expiresAt) {
        const response = await (deps.fetch ?? fetch)(new URL("/.well-known/oauth-authorization-server", deps.issuerUrl), {
          headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error("OAuth discovery unavailable");
        cache.entry = { document: await response.json(), expiresAt: now() + 3_600_000 };
      }
      return Response.json(cache.entry.document, { headers: discoveryHeaders });
    } catch {
      return Response.json({ error: "authorization_server_metadata_unavailable" }, { status: 502, headers: discoveryHeaders });
    }
  };
  const upload = async (request: Request, workspaceId: string, socketPeer?: string) => {
    const rejected = hostHeaderValidationResponse(request, deps.allowedHosts) ?? rejectMcpOrigin(request, deps.allowedOrigins);
    if (rejected) return rejected;
    let response: Response;
    if (request.method === "OPTIONS") response = new Response(null, { status: 204 });
    else if (!isUuid(workspaceId)) {
      response = Response.json({ error: "invalid_workspace" }, { status: 400 });
    } else {
      const bounded = await boundedMcpRequest(request);
      response = bounded instanceof Response ? bounded : await deps.handleUpload(bounded, workspaceId, socketPeer);
    }
    return mcpCorsResponse(response, request, deps.allowedOrigins);
  };
  return new Hono<ApiEnv>()
    .get("/.well-known/oauth-protected-resource", discovery)
    .options("/.well-known/oauth-protected-resource", options)
    .get("/.well-known/oauth-protected-resource/mcp", discovery)
    .options("/.well-known/oauth-protected-resource/mcp", options)
    .get("/.well-known/oauth-authorization-server", authorization)
    .options("/.well-known/oauth-authorization-server", options)
    .get("/mcp", (c) => deps.handleMcp(c.req.raw, socketAddress(c)))
    .post("/mcp", (c) => deps.handleMcp(c.req.raw, socketAddress(c)))
    .delete("/mcp", (c) => deps.handleMcp(c.req.raw, socketAddress(c)))
    .options("/mcp", (c) => deps.handleMcp(c.req.raw, socketAddress(c)))
    .post("/mcp/integrations/:workspaceId/upload-sessions/:action{open|finalize|grants|status|discard}", (c) => upload(c.req.raw, c.req.param("workspaceId"), socketAddress(c)))
    .options("/mcp/integrations/:workspaceId/upload-sessions/:action{open|finalize|grants|status|discard}", (c) => upload(c.req.raw, c.req.param("workspaceId"), socketAddress(c)));
}

export type McpTransportRoutes = ReturnType<typeof createMcpTransportRoutes>;
