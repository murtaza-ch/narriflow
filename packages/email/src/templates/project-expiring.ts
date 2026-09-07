import {
  emailShell,
  escapeHtml,
  type NotificationEmailTemplate,
} from "./shared";

export function projectExpiring(input: {
  projectTitle: string;
  expiresAt: string;
  upgradeLink: string;
}): NotificationEmailTemplate {
  const deadline = new Date(input.expiresAt);
  const deadlineText = Number.isFinite(deadline.getTime())
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(deadline) + " UTC"
    : input.expiresAt;
  const subject = `Project expires in about 24 hours — ${input.projectTitle}`;
  const body = `<strong>${escapeHtml(input.projectTitle)}</strong> is scheduled for permanent deletion on ${escapeHtml(deadlineText)}. Upgrade before that deadline to keep all active projects. After the deadline, this project cannot be recovered.`;

  return {
    subject,
    html: emailShell({
      eyebrow: "Free-plan retention",
      heading: "Your project expires soon",
      bodyHtml: `<p style="margin:0">${body}</p>`,
      actionLabel: "Upgrade to keep projects",
      actionUrl: input.upgradeLink,
    }),
    text: `${subject}\n\n${input.projectTitle} is scheduled for permanent deletion on ${deadlineText}. Upgrade before the deadline to keep all active projects. After the deadline, this project cannot be recovered.\n\nUpgrade: ${input.upgradeLink}`,
  };
}
