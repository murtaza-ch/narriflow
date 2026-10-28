import type { WorkspaceRoutes } from "@narriflow/api/types/workspace";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { WorkspaceRoutes };

/** Typed client for the workspace routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createWorkspaceClient(transport: RpcTransport) {
  return createRpcClient<WorkspaceRoutes>(transport);
}

export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
