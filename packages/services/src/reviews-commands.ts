import { REVIEWS_RECEIPT_COMMANDS } from "./reviews-receipt-commands";

/** Dependencies of the reviews receipt-backed commands. The owning ticket adds what its commands need. */
export type ReviewsCommandDependencies = Record<string, never>;

/**
 * Receipt-backed retryable commands of the reviews domain. Only names registered
 * in `REVIEWS_RECEIPT_COMMANDS` may be recorded.
 */
export function createReviewsCommands(_dependencies: ReviewsCommandDependencies) {
  return { receiptCommands: REVIEWS_RECEIPT_COMMANDS };
}

export type ReviewsCommands = ReturnType<typeof createReviewsCommands>;
