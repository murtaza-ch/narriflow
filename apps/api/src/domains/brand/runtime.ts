import {
  audioAssetService,
  brandTemplateService,
  campaignOperationService,
} from "@narriflow/services";
import type { ApiConfig } from "../../config";
import type { BrandRouteDeps } from "./routes";

/** Production wiring of the brand routes. */
export function createBrandRouteDeps(_config: ApiConfig): BrandRouteDeps {
  return { audioAssetService, brandTemplateService, campaignOperationService };
}
