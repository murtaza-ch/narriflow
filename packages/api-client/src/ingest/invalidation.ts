import type { QueryClient } from "@tanstack/query-core";
import { invalidateScoped, type WorkspaceScope } from "../core";

/**
 * After intake is accepted (link, Drive, RSS, upload, finalize, retry): the new or
 * changed Project everywhere it is listed, this intake's snapshot and resume, and the
 * credit allowance the acceptance reserved against.
 */
export async function invalidateAfterIntake(
  queryClient: QueryClient,
  scope: WorkspaceScope,
): Promise<void> {
  await Promise.all([
    invalidateScoped(queryClient, scope, "ingest"),
    invalidateScoped(queryClient, scope, "projects"),
    invalidateScoped(queryClient, scope, "library"),
    invalidateScoped(queryClient, scope, "workspace", "usage"),
  ]);
}
