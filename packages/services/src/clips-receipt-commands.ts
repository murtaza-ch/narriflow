/** Literal Operation Receipt command names owned by the clips domain. `ReceiptCommand` composes every domain list, so a name must be added here to be accepted. */
export const CLIPS_RECEIPT_COMMANDS = [
	"generate_clips",
	"duplicate_clip",
	"create_clip_from_range",
	"create_clip_from_selection",
] as const;
