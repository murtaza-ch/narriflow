import {
  emailShell,
  escapeHtml,
  type NotificationEmailTemplate,
} from "./shared";

export function clipsReady(input: {
  clipCount: number;
  projectTitle: string;
  deepLink: string;
}): NotificationEmailTemplate {
  const count = Math.max(0, Math.trunc(input.clipCount));
  const noun = count === 1 ? "clip is" : "clips are";
  const subject = `${count} ${noun} ready — ${input.projectTitle}`;
  const body = `${count} ${noun} ready to review, refine, and export from <strong>${escapeHtml(input.projectTitle)}</strong>.`;

  return {
    subject,
    html: emailShell({
      eyebrow: "Generation complete",
      heading: `${count} ${noun} ready`,
      bodyHtml: `<p style="margin:0">${body}</p>`,
      actionLabel: "Review clips",
      actionUrl: input.deepLink,
    }),
    text: `${subject}\n\n${count} ${noun} ready to review, refine, and export.\n\nReview clips: ${input.deepLink}`,
  };
}
