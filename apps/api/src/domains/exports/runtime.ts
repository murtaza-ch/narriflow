import {
  campaignOperationService,
  clipExportService,
  clipTimelineService,
  getLastWorkflowSeq,
  workspaceLibraryService,
} from "@narriflow/services";
import type { ApiConfig } from "../../config";
import type { ExportsRouteDeps } from "./routes";

/** Production wiring of the exports routes. */
export function createExportsRouteDeps(_config: ApiConfig): ExportsRouteDeps {
  return {
    campaignOperationService,
    clipExportService,
    clipTimelineService,
    workspaceLibraryService,
    getLastWorkflowSeq,
  };
}
