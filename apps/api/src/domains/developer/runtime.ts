import {
  callbackSigningSecrets,
  developerCommands,
  socialOAuthService,
  webhookSubscriptions,
  workspaceService,
} from "@narriflow/services";
import type { ApiConfig } from "../../config";
import type { DeveloperRouteDeps } from "./routes";

/** Production wiring of the developer routes. */
export function createDeveloperRouteDeps(_config: ApiConfig): DeveloperRouteDeps {
  return { workspaceService, developerCommands, callbackSigningSecrets, webhookSubscriptions, socialOAuthService };
}
