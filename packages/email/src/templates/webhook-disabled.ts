import {
  emailShell,
  escapeHtml,
  type NotificationEmailTemplate,
} from "./shared";

export function webhookDisabled(input: {
  urlHost: string;
  reason: string;
  settingsLink: string;
}): NotificationEmailTemplate {
  const subject = `Webhook paused — ${input.urlHost}`;
  const body = `Narriflow stopped sending events to <strong>${escapeHtml(input.urlHost)}</strong>. ${escapeHtml(input.reason)}. Fix the endpoint, then re-enable the webhook in Settings. Delivery resumes from the last event it acknowledged.`;

  return {
    subject,
    html: emailShell({
      eyebrow: "Webhooks",
      heading: "A webhook was paused",
      bodyHtml: `<p style="margin:0">${body}</p>`,
      actionLabel: "Open webhook settings",
      actionUrl: input.settingsLink,
    }),
    text: `${subject}\n\nNarriflow stopped sending events to ${input.urlHost}. ${input.reason}. Fix the endpoint, then re-enable the webhook in Settings. Delivery resumes from the last event it acknowledged.\n\nSettings: ${input.settingsLink}`,
  };
}
