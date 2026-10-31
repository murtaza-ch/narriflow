import { isPexelsConfigured, searchBrollVideos } from "@narriflow/services/pexels.service";
import { librarySearchService } from "@narriflow/services/library-search-runtime";
import { projectsCommands } from "@narriflow/services/projects-commands-runtime";
import { workspaceLibraryService } from "@narriflow/services/workspace-library.service";
import type { ApiConfig } from "../../config";
import type { LibraryRouteDeps } from "./routes";

/** Production wiring of the library routes. */
export function createLibraryRouteDeps(_config: ApiConfig): LibraryRouteDeps {
  return { workspaceLibraryService, librarySearchService, searchBrollVideos, isPexelsConfigured, projectsCommands };
}
