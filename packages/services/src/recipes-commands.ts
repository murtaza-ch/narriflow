import { RECIPES_RECEIPT_COMMANDS } from "./recipes-receipt-commands";

/** Dependencies of the recipes receipt-backed commands. The owning ticket adds what its commands need. */
export type RecipesCommandDependencies = Record<string, never>;

/**
 * Receipt-backed retryable commands of the recipes domain. Only names registered
 * in `RECIPES_RECEIPT_COMMANDS` may be recorded.
 */
export function createRecipesCommands(_dependencies: RecipesCommandDependencies) {
  return { receiptCommands: RECIPES_RECEIPT_COMMANDS };
}

export type RecipesCommands = ReturnType<typeof createRecipesCommands>;
