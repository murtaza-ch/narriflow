import { audioAssetService } from "@narriflow/services/audio-asset.service";
import { brandFontService } from "@narriflow/services/brand-font.service";
import { brandProfileService } from "@narriflow/services/brand-profile.service";
import { brandTemplateService } from "@narriflow/services/brand-template.service";
import { campaignOperationService } from "@narriflow/services/campaign-operation.service";
import { generatedMediaService } from "@narriflow/services/generated-media-runtime";
import { sceneTemplateService } from "@narriflow/services/scene-template.service";
import { visualAssetService } from "@narriflow/services/visual-asset.service";
import type { ApiConfig } from "../../config";
import type { BrandRouteDeps } from "./routes";

/** Production wiring of the brand routes. */
export function createBrandRouteDeps(_config: ApiConfig): BrandRouteDeps {
  return {
    audioAssets: audioAssetService,
    templates: brandTemplateService,
    profiles: brandProfileService,
    fonts: brandFontService,
    scenes: sceneTemplateService,
    visualAssets: visualAssetService,
    generatedMedia: generatedMediaService,
    campaignOperations: campaignOperationService,
  };
}
