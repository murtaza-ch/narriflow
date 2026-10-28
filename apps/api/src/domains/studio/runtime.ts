import type { ApiConfig } from "../../config";
import type { StudioRouteDeps } from "./routes";

/** Production wiring of the studio routes. */
export function createStudioRouteDeps(_config: ApiConfig): StudioRouteDeps {
  return {};
}
