import type { ApiConfig } from "../../config";
import type { SessionRouteDeps } from "./routes";

/** Production wiring of the session routes. */
export function createSessionRouteDeps(_config: ApiConfig): SessionRouteDeps {
  return {};
}
