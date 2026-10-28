import type { LibraryRoutes } from "@narriflow/api/types/library";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { LibraryRoutes };

/** Typed client for the library routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createLibraryClient(transport: RpcTransport) {
  return createRpcClient<LibraryRoutes>(transport);
}

export type LibraryClient = ReturnType<typeof createLibraryClient>;
