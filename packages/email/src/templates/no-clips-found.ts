import {
  emailShell,
  escapeHtml,
  type NotificationEmailTemplate,
} from "./shared";

export function noClipsFound(input: {
  projectTitle: string;
  deepLink: string;
}): NotificationEmailTemplate {
  const subject = `No clip-worthy moments found — ${input.projectTitle}`;
  const suggestions =
    "Try widening the processing window, choosing shorter clip lengths, or adding a specific moment you want Narriflow to prioritize.";

  return {
    subject,
    html: emailShell({
      eyebrow: "Generation complete",
      heading: "No clip-worthy moments found",
      bodyHtml: `<p style="margin:0 0 12px">We finished analyzing <strong>${escapeHtml(input.projectTitle)}</strong>, but did not find moments that met the current settings.</p><p style="margin:0">${escapeHtml(suggestions)}</p>`,
      actionLabel: "Adjust and try again",
      actionUrl: input.deepLink,
    }),
    text: `${subject}\n\nWe finished analyzing the project, but did not find moments that met the current settings.\n\n${suggestions}\n\nAdjust and try again: ${input.deepLink}`,
  };
}
