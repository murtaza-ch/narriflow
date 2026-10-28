import { autopilotService } from "./autopilot.service";
import { createAutomationCommands } from "./automation-commands";

/** Production wiring of the automation commands. */
export const automationCommands = createAutomationCommands({ autopilot: autopilotService });
