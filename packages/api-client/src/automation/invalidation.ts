import type { QueryClient } from "@tanstack/query-core";
import { invalidateScoped, type WorkspaceScope } from "../core";

/**
 * After a rule, grant or Zoom connection changes: the Autopilot and grants screens, the rule list,
 * Zoom connections (a disconnect pauses rules, which must stay visible), the Home dashboard's
 * Autopilot card, and the upload screen's Recipe choices that a rule counts against.
 */
export async function invalidateAfterAutomationChange(
  queryClient: QueryClient,
  scope: WorkspaceScope,
): Promise<void> {
  await Promise.all([
    invalidateScoped(queryClient, scope, "automation"),
    invalidateScoped(queryClient, scope, "projects", "home"),
  ]);
}
