import type { sendEmail } from "@narriflow/email";

export interface InviteDeliveryDeps {
  sendEmail: typeof sendEmail;
  /** W: invitation links are for people, so they use the web origin. */
  webOrigin: string;
}

/** The link a person opens to accept; it carries the one-time token, so never log it. */
export function inviteLink(webOrigin: string, token: string): string {
  return `${webOrigin}/invite/${token}`;
}

/**
 * Emails the invitation. The provider key is the invite's own ID, so a
 * retried delivery of the same invitation is never sent twice. Failure is a
 * reported outcome, not an error: the admin still has the link.
 */
export async function deliverWorkspaceInvite(
  deps: InviteDeliveryDeps,
  input: { id: string; email: string; token: string; workspaceName: string },
): Promise<{ url: string; emailSent: boolean }> {
  const url = inviteLink(deps.webOrigin, input.token);
  try {
    const delivery = await deps.sendEmail({
      to: input.email,
      subject: `Join ${input.workspaceName} on Narriflow`,
      text: [
        `You've been invited to join ${input.workspaceName} on Narriflow.`,
        "",
        `Accept invitation: ${url}`,
        "",
        "This invitation expires in seven days.",
      ].join("\n"),
      idempotencyKey: `workspace-invite/${input.id}`,
    });
    return { url, emailSent: delivery.sent };
  } catch {
    // The invitation exists; the admin can still copy the link or resend.
    console.warn(JSON.stringify({ level: "warn", message: "workspace_invite_email_failed", inviteId: input.id }));
    return { url, emailSent: false };
  }
}
