import type { QueryClient } from "@tanstack/query-core";
import { type WorkspaceScope, invalidateScoped } from "../core";
import { invalidateAfterClipChange, invalidateProjectClips } from "../clips/mutations";
import { EXPORT_RESOURCES } from "../exports/queries";
import { PROJECT_RESOURCES } from "../projects/queries";

/**
 * Non-terminal progress (a clip's preview or render landing mid-run): the
 * Project's screen, finishing, clip list and previews, the intake snapshot and
 * the Project's open export pages. The hub calls it behind the 5-second
 * trailing throttle, so no consumer needs to refetch on events itself.
 */
export async function invalidateAfterProgress(
  queryClient: QueryClient,
  scope: WorkspaceScope,
  projectId: string,
): Promise<void> {
  await Promise.all([
    invalidateProjectClips(queryClient, scope, projectId),
    invalidateScoped(queryClient, scope, "ingest", "snapshot", projectId),
    invalidateScoped(queryClient, scope, "exports", EXPORT_RESOURCES.detail, { id: projectId }),
  ]);
}

/**
 * A run reached a terminal state: everything it produced. The Project detail
 * and clips, the Project's exports and dub allowance, the lists that show its
 * counts and Workspace usage (a finished render settles credits).
 */
export async function invalidateAfterTerminalProgress(
  queryClient: QueryClient,
  scope: WorkspaceScope,
  projectId: string,
): Promise<void> {
  await Promise.all([
    invalidateAfterClipChange(queryClient, scope, projectId),
    invalidateScoped(queryClient, scope, "exports"),
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.dubsAllowance, projectId),
    invalidateScoped(queryClient, scope, "ingest", "snapshot", projectId),
  ]);
}
