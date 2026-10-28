import {
  autopilotService,
  automationCommands,
  recipeService,
  socialOAuthService,
  standingGrants,
  zoomConfigured,
  zoomService,
} from "@narriflow/services";
import type { ApiConfig } from "../../config";
import type { AutomationRouteDeps } from "./routes";
import type { AutomationWebhookDeps } from "./webhooks";

/** Production wiring of the automation routes. */
export function createAutomationRouteDeps(config: ApiConfig): AutomationRouteDeps {
  return {
    autopilotService,
    automationCommands,
    recipeService,
    standingGrants,
    socialOAuthService,
    zoomService,
    zoomConfigured: () => zoomConfigured(),
    callbackOrigin: config.apiOrigin,
    webOrigin: config.webOrigin,
  };
}

/** Production wiring of the Zoom webhook adapter. */
export function createAutomationWebhookDeps(): AutomationWebhookDeps {
  return { zoomService };
}
