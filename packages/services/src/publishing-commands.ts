import { PUBLISHING_RECEIPT_COMMANDS } from "./publishing-receipt-commands";

/** Dependencies of the publishing receipt-backed commands. The owning ticket adds what its commands need. */
export type PublishingCommandDependencies = Record<string, never>;

/**
 * Receipt-backed retryable commands of the publishing domain. Only names registered
 * in `PUBLISHING_RECEIPT_COMMANDS` may be recorded.
 */
export function createPublishingCommands(_dependencies: PublishingCommandDependencies) {
  return { receiptCommands: PUBLISHING_RECEIPT_COMMANDS };
}

export type PublishingCommands = ReturnType<typeof createPublishingCommands>;
