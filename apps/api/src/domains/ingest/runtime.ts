import { projectService } from "@narriflow/services";
import type { ApiConfig } from "../../config";
import type { IngestRouteDeps } from "./routes";

/** Production wiring of the ingest routes. */
export function createIngestRouteDeps(_config: ApiConfig): IngestRouteDeps {
  return { projectService };
}
