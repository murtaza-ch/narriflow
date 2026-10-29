import type { QueryClient } from "@tanstack/query-core";
import { invalidateScoped, type WorkspaceScope } from "../core";

/**
 * After a rule, grant or Zoom connection changes: the Autopilot and grants screens, the rule list,
 * Zoom connections (a disconnect pauses rules, which must stay visible), the Home dashboard's
 * Autopilot card, and the Recipes (their rule-use facts decide delete availability and the upload choices).
 */
export async function invalidateAfterAutomationChange(
  queryClient: QueryClient,
  scope: WorkspaceScope,
): Promise<void> {
  await Promise.all([
    invalidateScoped(queryClient, scope, "automation"),
    invalidateScoped(queryClient, scope, "recipes"),
    invalidateScoped(queryClient, scope, "projects", "home"),
  ]);
}
