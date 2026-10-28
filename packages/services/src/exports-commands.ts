import { EXPORTS_RECEIPT_COMMANDS } from "./exports-receipt-commands";

/** Dependencies of the exports receipt-backed commands. The owning ticket adds what its commands need. */
export type ExportsCommandDependencies = Record<string, never>;

/**
 * Receipt-backed retryable commands of the exports domain. Only names registered
 * in `EXPORTS_RECEIPT_COMMANDS` may be recorded.
 */
export function createExportsCommands(_dependencies: ExportsCommandDependencies) {
  return { receiptCommands: EXPORTS_RECEIPT_COMMANDS };
}

export type ExportsCommands = ReturnType<typeof createExportsCommands>;
