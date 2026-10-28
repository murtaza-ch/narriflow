import type { ProjectsRoutes } from "@narriflow/api/types/projects";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { ProjectsRoutes };

/** Typed client for the projects routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createProjectsClient(transport: RpcTransport) {
  return createRpcClient<ProjectsRoutes>(transport);
}

export type ProjectsClient = ReturnType<typeof createProjectsClient>;
