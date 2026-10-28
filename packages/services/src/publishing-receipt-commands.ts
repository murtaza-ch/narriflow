/** Literal Operation Receipt command names owned by the publishing domain. `ReceiptCommand` composes every domain list, so a name must be added here to be accepted. */
export const PUBLISHING_RECEIPT_COMMANDS = [
	"prepare_social_post",
	"propose_social_post",
	"recheck_social_publication",
	"confirm_social_publication",
	"publish_social_publication_again",
] as const;
