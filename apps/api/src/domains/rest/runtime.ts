import type { ApiConfig } from "../../config";
import type { RestRouteDeps } from "./routes";

/** Production wiring of the rest routes. */
export function createRestRouteDeps(_config: ApiConfig): RestRouteDeps {
  return {};
}
