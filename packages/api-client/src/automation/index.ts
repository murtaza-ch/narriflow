import type { AutomationRoutes } from "@narriflow/api/types/automation";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { AutomationRoutes };

/** Typed client for the automation routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createAutomationClient(transport: RpcTransport) {
  return createRpcClient<AutomationRoutes>(transport);
}

export type AutomationClient = ReturnType<typeof createAutomationClient>;
