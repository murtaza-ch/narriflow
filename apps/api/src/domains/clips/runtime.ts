import { campaignOperationService } from "@narriflow/services/campaign-operation.service";
import { clipEditorDocumentPersistence } from "@narriflow/services/clip-editor-document-persistence";
import { clipService } from "@narriflow/services/clip.service";
import { clipsCommands } from "@narriflow/services/clips-commands-runtime";
import { thumbnailFramePreparationService } from "@narriflow/services/thumbnail-frame-preparation-runtime";
import type { ApiConfig } from "../../config";
import type { ClipsRouteDeps } from "./routes";

/** Production wiring of the clips routes. */
export function createClipsRouteDeps(_config: ApiConfig): ClipsRouteDeps {
  return {
    clipService,
    clipEditorDocumentPersistence,
    campaignOperationService,
    clipsCommands,
    thumbnailFramePreparationService,
  };
}
