import { listUserWorkspaces } from "@narriflow/auth";
import { sendEmail } from "@narriflow/email";
import { autoCensorService } from "@narriflow/services/auto-censor.service";
import { performanceService } from "@narriflow/services/performance.service";
import { projectService } from "@narriflow/services/project.service";
import { workspaceCommands } from "@narriflow/services/workspace-commands-runtime";
import { workspaceMembershipService } from "@narriflow/services/workspace-membership.service";
import { workspaceService } from "@narriflow/services/workspace.service";
import type { ApiConfig } from "../../config";
import type { WorkspaceRouteDeps } from "./routes";

/** Production wiring of the workspace routes. */
export function createWorkspaceRouteDeps(config: ApiConfig): WorkspaceRouteDeps {
  return {
    workspaceService,
    workspaceMembershipService,
    workspaceCommands,
    projectService,
    performanceService,
    autoCensorService,
    listUserWorkspaces,
    sendEmail,
    webOrigin: config.webOrigin,
  };
}
