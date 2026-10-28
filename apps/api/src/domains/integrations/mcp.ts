import { Hono } from "hono";
import type { ApiEnv } from "../../http/env";

/** Dependencies of the MCP transport. The MCP owner replaces this with the handler factories. */
export type McpTransportDeps = Record<string, never>;

/**
 * The MCP resource (`/mcp`), its discovery documents under `/.well-known` and
 * the upload-session transport (`/mcp/integrations/:workspaceId/upload-sessions/*`).
 * Mounted at `/` before the first-party chain: OAuth and API-key credentials,
 * host/origin checks and protocol error envelopes belong to this app alone.
 */
export function createMcpTransportRoutes(_deps: McpTransportDeps) {
  return new Hono<ApiEnv>();
}

export type McpTransportRoutes = ReturnType<typeof createMcpTransportRoutes>;
