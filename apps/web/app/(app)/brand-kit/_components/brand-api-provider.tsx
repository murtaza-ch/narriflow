"use client";

import type { WorkspaceScope } from "@narriflow/api-client";
import { brandMutations, brandQueries, invalidateBrand } from "@narriflow/api-client/brand";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { BrandApiContext, type BrandApiValue } from "./brand-api";

/**
 * The Brand Kit's data layer for one Workspace: query factories, commands and
 * the invalidation helper, all bound to the identity and Workspace the screen
 * was admitted under. Screens render it only once a Workspace is selected.
 */
export function BrandApiProvider({ scope, children }: { scope: WorkspaceScope; children: ReactNode }) {
  const runtime = useApiRuntime();
  const queryClient = useQueryClient();
  const value = useMemo<BrandApiValue>(() => {
    const api = { transport: runtime.transport, scope };
    return {
      scope,
      queries: brandQueries(api),
      mutations: brandMutations(api),
      queryClient,
      invalidate: () => invalidateBrand(queryClient, scope),
      createIntent: () => runtime.createIntent(),
    };
  }, [runtime, queryClient, scope]);
  return <BrandApiContext.Provider value={value}>{children}</BrandApiContext.Provider>;
}

/** The selected Workspace, or `null` until one is selected (screens show their skeleton meanwhile). */
export function useBrandScope(): WorkspaceScope | null {
  return useWorkspaceScope();
}
