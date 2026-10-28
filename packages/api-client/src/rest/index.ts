import type { RestRoutes } from "@narriflow/api/types/rest";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { RestRoutes };

/** Typed client for the rest routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createRestClient(transport: RpcTransport) {
  return createRpcClient<RestRoutes>(transport, "/api/v1");
}

export type RestClient = ReturnType<typeof createRestClient>;
