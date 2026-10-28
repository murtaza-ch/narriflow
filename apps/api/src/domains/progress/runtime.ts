import type { ApiConfig } from "../../config";
import type { ProgressRouteDeps } from "./routes";

/** Production wiring of the progress routes. */
export function createProgressRouteDeps(_config: ApiConfig): ProgressRouteDeps {
  return {};
}
