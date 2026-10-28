import type { ApiConfig } from "../../config";
import type { McpTransportDeps } from "./mcp";
import type { IntegrationsRouteDeps } from "./routes";

/** Production wiring of the integrations routes. */
export function createIntegrationsRouteDeps(_config: ApiConfig): IntegrationsRouteDeps {
  return {};
}

/** Production wiring of the MCP transport. */
export function createMcpTransportDeps(_config: ApiConfig): McpTransportDeps {
  return {};
}
