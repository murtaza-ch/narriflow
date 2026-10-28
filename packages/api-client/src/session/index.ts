import type { SessionRoutes } from "@narriflow/api/types/session";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { SessionRoutes };

/** Typed client for the session routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createSessionClient(transport: RpcTransport) {
  return createRpcClient<SessionRoutes>(transport);
}

export type SessionClient = ReturnType<typeof createSessionClient>;
