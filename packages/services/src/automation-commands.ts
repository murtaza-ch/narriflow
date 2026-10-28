import { AUTOMATION_RECEIPT_COMMANDS } from "./automation-receipt-commands";

/** Dependencies of the automation receipt-backed commands. The owning ticket adds what its commands need. */
export type AutomationCommandDependencies = Record<string, never>;

/**
 * Receipt-backed retryable commands of the automation domain. Only names registered
 * in `AUTOMATION_RECEIPT_COMMANDS` may be recorded.
 */
export function createAutomationCommands(_dependencies: AutomationCommandDependencies) {
  return { receiptCommands: AUTOMATION_RECEIPT_COMMANDS };
}

export type AutomationCommands = ReturnType<typeof createAutomationCommands>;
