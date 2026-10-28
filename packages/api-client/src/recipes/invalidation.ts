import type { QueryClient } from "@tanstack/query-core";
import { invalidateScoped, type WorkspaceScope } from "../core";

/**
 * After a Recipe is created, changed, duplicated or deleted: the list, the upload
 * screen's configuration (which offers Recipes) and the Autopilot rules that choose
 * one.
 */
export async function invalidateAfterRecipeChange(
  queryClient: QueryClient,
  scope: WorkspaceScope,
): Promise<void> {
  await Promise.all([
    invalidateScoped(queryClient, scope, "recipes"),
    invalidateScoped(queryClient, scope, "ingest", "configuration"),
    invalidateScoped(queryClient, scope, "automation"),
  ]);
}
