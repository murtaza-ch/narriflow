import type { IntegrationsRoutes } from "@narriflow/api/types/integrations";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { IntegrationsRoutes };

/** Typed client for the integrations routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createIntegrationsClient(transport: RpcTransport) {
  return createRpcClient<IntegrationsRoutes>(transport);
}

export type IntegrationsClient = ReturnType<typeof createIntegrationsClient>;
