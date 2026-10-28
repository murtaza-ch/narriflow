"use client";

import { type WorkspaceScope, scopedKey, STALE_TIME } from "@narriflow/api-client";
import type { WorkspaceBootstrap } from "@narriflow/validators/api/workspace";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useApiRuntime } from "@/app/_components/api-provider";

/**
 * The Workspace bootstrap (`GET /api/workspace/bootstrap`): capabilities and the
 * credit usage of the selected Workspace, read once and shared by every screen
 * that shows credits (shell, Billing, Usage). The key is the Workspace
 * bootstrap's own, so an aggregate prime from the shell fills it.
 */
export function workspaceBootstrapQueryOptions(
  transport: ReturnType<typeof useApiRuntime>["transport"],
  scope: WorkspaceScope,
) {
  return queryOptions({
    queryKey: scopedKey(scope, "workspace", "bootstrap"),
    queryFn: ({ signal }) =>
      transport.scoped(scope).json<WorkspaceBootstrap>("/api/workspace/bootstrap", { signal }),
    staleTime: STALE_TIME.default,
  });
}

export function useWorkspaceBootstrap(scope: WorkspaceScope) {
  const { transport } = useApiRuntime();
  return useQuery(workspaceBootstrapQueryOptions(transport, scope));
}
