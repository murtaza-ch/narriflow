import { campaignOperationService } from "@narriflow/services/campaign-operation.service";
import { clipExportService } from "@narriflow/services/clip-export.service";
import { clipTimelineService } from "@narriflow/services/clip-timeline.service";
import { getLastWorkflowSeq } from "@narriflow/services/workflow.service";
import { workspaceLibraryService } from "@narriflow/services/workspace-library.service";
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
