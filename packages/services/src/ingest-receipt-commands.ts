/** Literal Operation Receipt command names owned by the ingest domain. `ReceiptCommand` composes every domain list, so a name must be added here to be accepted. */
export const INGEST_RECEIPT_COMMANDS = [
	"submit_video",
	"create_captioned_video",
] as const;
