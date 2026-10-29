"use client";

import type { WorkspaceScope } from "@narriflow/api-client";
import { workspaceBootstrapQuery } from "@narriflow/api-client/workspace";
import { useQuery } from "@tanstack/react-query";
import { useApiRuntime } from "@/app/_components/api-provider";

/**
 * The Workspace bootstrap (`GET /api/workspace/bootstrap`): capabilities and the
 * credit usage of the selected Workspace, read once and shared by every screen
 * that shows credits (shell, Billing, Usage). It is the Workspace client's own
 * query, so the shell's aggregate prime and these screens share one cache entry.
 */
export function useWorkspaceBootstrap(scope: WorkspaceScope) {
  const { transport } = useApiRuntime();
  return useQuery(workspaceBootstrapQuery(transport, scope));
}
