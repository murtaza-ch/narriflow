import {
  emailShell,
  escapeHtml,
  type NotificationEmailTemplate,
} from "./shared";

/** Sent to the person a finishing ran for, once their clips are exported. */
export function finishingReady(input: {
  clipCount: number;
  projectTitle: string;
  deepLink: string;
}): NotificationEmailTemplate {
  const count = Math.max(0, Math.trunc(input.clipCount));
  const noun = count === 1 ? "clip is" : "clips are";
  const subject = `${count} exported ${noun} ready to review — ${input.projectTitle}`;
  const body = `${count} ${noun} exported with copy written, ready for your review in <strong>${escapeHtml(input.projectTitle)}</strong>.`;

  return {
    subject,
    html: emailShell({
      eyebrow: "Finishing complete",
      heading: `${count} exported ${noun} ready to review`,
      bodyHtml: `<p style="margin:0">${body}</p>`,
      actionLabel: "Review exports",
      actionUrl: input.deepLink,
    }),
    text: `${subject}\n\n${count} ${noun} exported and ready to review.\n\nReview exports: ${input.deepLink}`,
  };
}
