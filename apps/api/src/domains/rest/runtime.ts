import { checkRateLimit } from "@narriflow/services";
import type { ApiConfig } from "../../config";
import type { RestRouteDeps } from "./routes";

export function createRestRouteDeps(config: ApiConfig): RestRouteDeps {
  return { checkRateLimit, apiOrigin: () => config.apiOrigin, webOrigin: () => config.webOrigin, corsAllowedOrigins: config.corsAllowedOrigins };
}
