import {
  analyzeSceneDocumentMutation,
  autoCensorService,
  brandFontService,
  brandProfileService,
  clipEditorDocumentPersistence,
  clipService,
  generatedImageCapability,
  presignDownloadUrl,
  projectService,
  sceneTemplateService,
  visualAssetService,
} from "@narriflow/services";
import type { ApiConfig } from "../../config";
import type { StudioRouteDeps } from "./routes";

/** Production wiring of the studio routes. */
export function createStudioRouteDeps(_config: ApiConfig): StudioRouteDeps {
  return {
    clipService,
    clipEditorDocumentPersistence,
    analyzeSceneDocumentMutation,
    projectService,
    autoCensorService,
    visualAssetService,
    sceneTemplateService,
    brandFontService,
    brandProfileService,
    presignDownloadUrl,
    generatedImageCapability,
  };
}
