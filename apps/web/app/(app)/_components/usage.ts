import { cache } from "react";
import { projectService } from "@narriflow/services";

/**
 * Request-deduped dashboard stats. The app shell reads usage minutes for the
 * sidebar meter on every page; wrapping in React `cache()` means any page in
 * the same render pass (e.g. the dashboard) can call this too without a
 * second round of queries.
 */
export const getCachedDashboardStats = cache((userId: string, workspaceId: string) =>
  projectService.getDashboardStats(userId, workspaceId),
);
