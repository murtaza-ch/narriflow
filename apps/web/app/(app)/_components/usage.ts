import { cache } from "react";
import { projectService } from "@narriflow/services";

/** Share one usage query within the page render and its app shell. */
export const getCachedUsageSummary = cache((actorUserId: string, workspaceId: string) =>
  projectService.getUsageSummary({ actorUserId, workspaceId }),
);
