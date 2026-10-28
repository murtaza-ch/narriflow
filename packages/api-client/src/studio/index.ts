import type { StudioRoutes } from "@narriflow/api/types/studio";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { StudioRoutes };

/** Typed client for the studio routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createStudioClient(transport: RpcTransport) {
  return createRpcClient<StudioRoutes>(transport);
}

export type StudioClient = ReturnType<typeof createStudioClient>;
