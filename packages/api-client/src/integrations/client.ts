import type { IntegrationsRoutes } from "@narriflow/api/types/integrations";
import type { InferResponseType } from "hono/client";
import { type RpcTransport, createRpcClient } from "../rpc";

export function createIntegrationsClient(transport: RpcTransport) {
  return createRpcClient<IntegrationsRoutes>(transport);
}
export type IntegrationsClient = ReturnType<typeof createIntegrationsClient>;

export type McpStatusData = InferResponseType<IntegrationsClient["integrations"]["mcp"]["status"]["$get"], 200>;
export type McpConfirmationResult = InferResponseType<IntegrationsClient["mcp"]["confirmations"]["$post"], 200>;
