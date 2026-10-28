import { CLIPS_RECEIPT_COMMANDS } from "./clips-receipt-commands";

/** Dependencies of the clips receipt-backed commands. The owning ticket adds what its commands need. */
export type ClipsCommandDependencies = Record<string, never>;

/**
 * Receipt-backed retryable commands of the clips domain. Only names registered
 * in `CLIPS_RECEIPT_COMMANDS` may be recorded.
 */
export function createClipsCommands(_dependencies: ClipsCommandDependencies) {
  return { receiptCommands: CLIPS_RECEIPT_COMMANDS };
}

export type ClipsCommands = ReturnType<typeof createClipsCommands>;
