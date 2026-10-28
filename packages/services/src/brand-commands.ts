import { BRAND_RECEIPT_COMMANDS } from "./brand-receipt-commands";

/** Dependencies of the brand receipt-backed commands. The owning ticket adds what its commands need. */
export type BrandCommandDependencies = Record<string, never>;

/**
 * Receipt-backed retryable commands of the brand domain. Only names registered
 * in `BRAND_RECEIPT_COMMANDS` may be recorded.
 */
export function createBrandCommands(_dependencies: BrandCommandDependencies) {
  return { receiptCommands: BRAND_RECEIPT_COMMANDS };
}

export type BrandCommands = ReturnType<typeof createBrandCommands>;
