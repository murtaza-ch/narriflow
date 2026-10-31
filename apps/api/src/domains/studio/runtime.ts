import { analyzeSceneDocumentMutation } from "@narriflow/services/scene-document-mutation";
import { autoCensorService } from "@narriflow/services/auto-censor.service";
import { brandFontService } from "@narriflow/services/brand-font.service";
import { brandProfileService } from "@narriflow/services/brand-profile.service";
import { clipEditorDocumentPersistence } from "@narriflow/services/clip-editor-document-persistence";
import { clipService } from "@narriflow/services/clip.service";
import { generatedImageCapability } from "@narriflow/services/generation-usage";
import { presignDownloadUrl } from "@narriflow/services/r2-storage";
import { projectService } from "@narriflow/services/project.service";
import { sceneTemplateService } from "@narriflow/services/scene-template.service";
import { visualAssetService } from "@narriflow/services/visual-asset.service";
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
