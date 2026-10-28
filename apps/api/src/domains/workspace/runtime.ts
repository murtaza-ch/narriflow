import { listUserWorkspaces } from "@narriflow/auth";
import { sendEmail } from "@narriflow/email";
import {
  autoCensorService,
  performanceService,
  projectService,
  workspaceCommands,
  workspaceMembershipService,
  workspaceService,
} from "@narriflow/services";
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
