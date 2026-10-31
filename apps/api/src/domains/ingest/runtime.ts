import { brandProfileService } from "@narriflow/services/brand-profile.service";
import { brandTemplateService } from "@narriflow/services/brand-template.service";
import { getIngestJobLifecycle } from "@narriflow/services/ingest-job-lifecycle-runtime";
import { projectService } from "@narriflow/services/project.service";
import { recipeService } from "@narriflow/services/recipe.service";
import { uploadSessionService } from "@narriflow/services/upload-session.service";
import type { ApiConfig } from "../../config";
import type { IngestRouteDeps } from "./routes";
import { youtubeImportCapability } from "@narriflow/services/source-fetch-capability";
import { issueLocalFetchDevice } from "../execution/local-device-runtime";
import type { ApiWorkerBindings } from "../../worker-bindings";

/** Production wiring of the ingest routes. */
export function createIngestRouteDeps(_config: ApiConfig): IngestRouteDeps {
  return {
    youtubeImportCapability,
    issueLocalFetchDevice: (actor, bindings) => issueLocalFetchDevice(actor, bindings as ApiWorkerBindings),
    projectService,
    recipeService,
    brandTemplateService,
    brandProfileService,
    uploadSessionService,
    ingestJobLifecycle: getIngestJobLifecycle,
  };
}
