import type { ProgressRoutes } from "@narriflow/api/types/progress";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { ProgressRoutes };

/** Typed client for the progress routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createProgressClient(transport: RpcTransport) {
  return createRpcClient<ProgressRoutes>(transport);
}

export type ProgressClient = ReturnType<typeof createProgressClient>;
