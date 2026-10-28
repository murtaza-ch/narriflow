import {
  analyticsService,
  contentSuiteService,
  dubbingService,
  projectService,
  workspaceLibraryService,
} from "@narriflow/services";
import type { ApiConfig } from "../../config";
import type { ProjectsRouteDeps } from "./routes";

/** Production wiring of the projects routes. */
export function createProjectsRouteDeps(_config: ApiConfig): ProjectsRouteDeps {
  return {
    projectService,
    workspaceLibraryService,
    contentSuiteService,
    analyticsService,
    dubbingService,
  };
}
