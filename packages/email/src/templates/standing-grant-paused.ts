import {
  emailShell,
  escapeHtml,
  type NotificationEmailTemplate,
} from "./shared";

export function standingGrantPaused(input: {
  ruleName: string;
  destination: string;
  reason: string;
  settingsLink: string;
}): NotificationEmailTemplate {
  const subject = `Automation grant paused: ${input.ruleName}`;
  const body = `The standing grant for the Autopilot rule <strong>${escapeHtml(input.ruleName)}</strong> (${escapeHtml(input.destination)}) paused itself. ${escapeHtml(input.reason)} Nothing more goes out under it until you check and renew it in Settings.`;

  return {
    subject,
    html: emailShell({
      eyebrow: "Automation grants",
      heading: "A standing grant was paused",
      bodyHtml: `<p style="margin:0">${body}</p>`,
      actionLabel: "Open automation grants",
      actionUrl: input.settingsLink,
    }),
    text: `${subject}\n\nThe standing grant for the Autopilot rule ${input.ruleName} (${input.destination}) paused itself. ${input.reason} Nothing more goes out under it until you check and renew it in Settings.\n\nSettings: ${input.settingsLink}`,
  };
}
