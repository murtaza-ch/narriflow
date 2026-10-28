import {
  campaignOperationService,
  clipEditorDocumentPersistence,
  clipService,
  clipsCommands,
  thumbnailFramePreparationService,
} from "@narriflow/services";
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
