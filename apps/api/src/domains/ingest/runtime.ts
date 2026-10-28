import {
  brandProfileService,
  brandTemplateService,
  getIngestJobLifecycle,
  projectService,
  recipeService,
  uploadSessionService,
} from "@narriflow/services";
import type { ApiConfig } from "../../config";
import type { IngestRouteDeps } from "./routes";

/** Production wiring of the ingest routes. */
export function createIngestRouteDeps(_config: ApiConfig): IngestRouteDeps {
  return {
    projectService,
    recipeService,
    brandTemplateService,
    brandProfileService,
    uploadSessionService,
    ingestJobLifecycle: getIngestJobLifecycle,
  };
}
