import type { ExportsRoutes } from "@narriflow/api/types/exports";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { ExportsRoutes };

/** Typed client for the exports routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createExportsClient(transport: RpcTransport) {
  return createRpcClient<ExportsRoutes>(transport);
}

export type ExportsClient = ReturnType<typeof createExportsClient>;
