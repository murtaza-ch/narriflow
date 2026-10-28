/** Literal Operation Receipt command names owned by the recipes domain. `ReceiptCommand` composes every domain list, so a name must be added here to be accepted. */
export const RECIPES_RECEIPT_COMMANDS = [
	"create_recipe",
	"duplicate_recipe",
] as const;
