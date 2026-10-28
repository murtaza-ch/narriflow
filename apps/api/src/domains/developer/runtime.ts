import type { ApiConfig } from "../../config";
import type { DeveloperRouteDeps } from "./routes";

/** Production wiring of the developer routes. */
export function createDeveloperRouteDeps(_config: ApiConfig): DeveloperRouteDeps {
  return {};
}
