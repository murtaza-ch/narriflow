import { autopilotService } from "@narriflow/services";
import type { ApiConfig } from "../../config";
import type { AutomationWebhookDeps } from "./webhooks";
import type { AutomationRouteDeps } from "./routes";

/** Production wiring of the automation routes. */
export function createAutomationRouteDeps(_config: ApiConfig): AutomationRouteDeps {
  return { autopilotService };
}

/** Production wiring of the Zoom webhook adapter. */
export function createAutomationWebhookDeps(): AutomationWebhookDeps {
  return {};
}
