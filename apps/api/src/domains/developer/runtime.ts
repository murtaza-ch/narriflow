import { callbackSigningSecrets } from "@narriflow/services/completion-callback-runtime";
import { developerCommands } from "@narriflow/services/developer-commands-runtime";
import { socialOAuthService } from "@narriflow/services/social-oauth.service";
import { webhookSubscriptions } from "@narriflow/services/webhook-subscription-runtime";
import { workspaceService } from "@narriflow/services/workspace.service";
import type { ApiConfig } from "../../config";
import type { DeveloperRouteDeps } from "./routes";

/** Production wiring of the developer routes. */
export function createDeveloperRouteDeps(_config: ApiConfig): DeveloperRouteDeps {
  return { workspaceService, developerCommands, callbackSigningSecrets, webhookSubscriptions, socialOAuthService };
}
