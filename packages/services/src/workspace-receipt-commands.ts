/** Literal Operation Receipt command names owned by the workspace domain. `ReceiptCommand` composes every domain list, so a name must be added here to be accepted. */
export const WORKSPACE_RECEIPT_COMMANDS = [
  "create_business_workspace",
  "invite_workspace_member",
  "resend_workspace_invite",
] as const;
