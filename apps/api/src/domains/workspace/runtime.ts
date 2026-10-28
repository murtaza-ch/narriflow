import { workspaceService } from "@narriflow/services";
import type { ApiConfig } from "../../config";
import type { WorkspaceRouteDeps } from "./routes";

/** Production wiring of the workspace routes. */
export function createWorkspaceRouteDeps(_config: ApiConfig): WorkspaceRouteDeps {
  return { workspaceService };
}
