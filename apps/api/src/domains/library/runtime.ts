import {
  isPexelsConfigured,
  librarySearchService,
  projectsCommands,
  searchBrollVideos,
  workspaceLibraryService,
} from "@narriflow/services";
import type { ApiConfig } from "../../config";
import type { LibraryRouteDeps } from "./routes";

/** Production wiring of the library routes. */
export function createLibraryRouteDeps(_config: ApiConfig): LibraryRouteDeps {
  return { workspaceLibraryService, librarySearchService, searchBrollVideos, isPexelsConfigured, projectsCommands };
}
