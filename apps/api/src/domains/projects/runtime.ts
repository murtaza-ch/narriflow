import {
  analyticsService,
  autopilotService,
  brandProfileService,
  clipService,
  contentSuiteService,
  dubbingService,
  getProcessingUsage,
  getProjectFinishing,
  presignDownloadUrl,
  projectService,
  reviewService,
  socialOAuthService,
  socialService,
  workspaceLibraryService,
  workspaceService,
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
    clipService,
    socialService,
    socialOAuthService,
    brandProfileService,
    reviewService,
    workspaceService,
    autopilotService,
    getProjectFinishing,
    getProcessingUsage,
    presignDownloadUrl,
  };
}
