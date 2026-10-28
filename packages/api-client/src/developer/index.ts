import type { DeveloperRoutes } from "@narriflow/api/types/developer";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { DeveloperRoutes };

/** Typed client for the developer routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createDeveloperClient(transport: RpcTransport) {
  return createRpcClient<DeveloperRoutes>(transport);
}

export type DeveloperClient = ReturnType<typeof createDeveloperClient>;
