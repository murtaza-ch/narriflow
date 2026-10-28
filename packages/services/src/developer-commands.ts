import { DEVELOPER_RECEIPT_COMMANDS } from "./developer-receipt-commands";

/** Dependencies of the developer receipt-backed commands. The owning ticket adds what its commands need. */
export type DeveloperCommandDependencies = Record<string, never>;

/**
 * Receipt-backed retryable commands of the developer domain. Only names registered
 * in `DEVELOPER_RECEIPT_COMMANDS` may be recorded.
 */
export function createDeveloperCommands(_dependencies: DeveloperCommandDependencies) {
  return { receiptCommands: DEVELOPER_RECEIPT_COMMANDS };
}

export type DeveloperCommands = ReturnType<typeof createDeveloperCommands>;
