/** Literal Operation Receipt command names owned by the developer domain. `ReceiptCommand` composes every domain list, so a name must be added here to be accepted. */
export const DEVELOPER_RECEIPT_COMMANDS = [
	"redeliver_callback",
	"create_api_key",
	"rotate_callback_signing_secret",
	"create_webhook",
] as const;
