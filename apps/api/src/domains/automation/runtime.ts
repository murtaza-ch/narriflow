import { autopilotService } from "@narriflow/services/autopilot.service";
import { automationCommands } from "@narriflow/services/automation-commands-runtime";
import { recipeService } from "@narriflow/services/recipe.service";
import { socialOAuthService } from "@narriflow/services/social-oauth.service";
import { standingGrants } from "@narriflow/services/standing-grant-runtime";
import { zoomConfigured } from "@narriflow/services/zoom";
import { zoomService } from "@narriflow/services/zoom.service";
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
