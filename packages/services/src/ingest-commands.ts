import { INGEST_RECEIPT_COMMANDS } from "./ingest-receipt-commands";

/** Dependencies of the ingest receipt-backed commands. The owning ticket adds what its commands need. */
export type IngestCommandDependencies = Record<string, never>;

/**
 * Receipt-backed retryable commands of the ingest domain. Only names registered
 * in `INGEST_RECEIPT_COMMANDS` may be recorded.
 */
export function createIngestCommands(_dependencies: IngestCommandDependencies) {
  return { receiptCommands: INGEST_RECEIPT_COMMANDS };
}

export type IngestCommands = ReturnType<typeof createIngestCommands>;
