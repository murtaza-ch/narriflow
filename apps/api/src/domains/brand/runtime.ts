import {
  audioAssetService,
  brandFontService,
  brandProfileService,
  brandTemplateService,
  campaignOperationService,
  generatedMediaService,
  sceneTemplateService,
  visualAssetService,
} from "@narriflow/services";
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
