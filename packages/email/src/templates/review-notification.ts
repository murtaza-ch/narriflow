import { emailShell, escapeHtml, type NotificationEmailTemplate } from "./shared";

type ReviewNotificationKind =
  | "round_sent"
  | "first_change_requested"
  | "all_approved"
  | "mention";

const COPY: Record<ReviewNotificationKind, {
  eyebrow: string;
  heading: string;
  subject: string;
  action: string;
  body: (roundTitle: string, projectTitle: string) => string;
}> = {
  round_sent: {
    eyebrow: "Client review",
    heading: "A review is ready",
    subject: "Review ready",
    action: "Open review",
    body: (roundTitle, projectTitle) => `<strong>${escapeHtml(roundTitle)}</strong> for ${escapeHtml(projectTitle)} is ready for your feedback.`,
  },
  first_change_requested: {
    eyebrow: "Review update",
    heading: "Changes were requested",
    subject: "Changes requested",
    action: "View feedback",
    body: (roundTitle, projectTitle) => `A reviewer requested changes on <strong>${escapeHtml(roundTitle)}</strong> for ${escapeHtml(projectTitle)}.`,
  },
  all_approved: {
    eyebrow: "Review update",
    heading: "Every required clip is approved",
    subject: "Review approved",
    action: "View approval",
    body: (roundTitle, projectTitle) => `All required clips in <strong>${escapeHtml(roundTitle)}</strong> for ${escapeHtml(projectTitle)} are approved.`,
  },
  mention: {
    eyebrow: "Review comment",
    heading: "You were mentioned",
    subject: "Mentioned in a review",
    action: "Open conversation",
    body: (roundTitle, projectTitle) => `A teammate mentioned you in <strong>${escapeHtml(roundTitle)}</strong> for ${escapeHtml(projectTitle)}.`,
  },
};

export function reviewNotification(input: {
  kind: ReviewNotificationKind;
  projectTitle: string;
  roundTitle: string;
  reviewUrl: string;
  /** A round a Standing Grant sent says so, and offers the reviewer a way out. */
  optOut?: { url: string; workspaceName: string };
}): NotificationEmailTemplate {
  const copy = COPY[input.kind];
  const subject = `${copy.subject}: ${input.projectTitle}`;
  const body = copy.body(input.roundTitle, input.projectTitle);
  return {
    subject,
    html: emailShell({
      eyebrow: copy.eyebrow,
      heading: copy.heading,
      bodyHtml: `<p style="margin:0">${body}</p>${input.optOut
        ? `<p style="margin:20px 0 0;font-size:13px;color:#6b7080">Narriflow sent this automatically for ${escapeHtml(input.optOut.workspaceName)}. <a href="${escapeHtml(input.optOut.url)}" style="color:#6b7080">Stop automated review requests from ${escapeHtml(input.optOut.workspaceName)}</a>.</p>`
        : ""}`,
      actionLabel: copy.action,
      actionUrl: input.reviewUrl,
    }),
    text: `${subject}\n\n${body.replace(/<[^>]*>/g, "")}\n\n${copy.action}: ${input.reviewUrl}${input.optOut
      ? `\n\nNarriflow sent this automatically for ${input.optOut.workspaceName}. Stop automated review requests from ${input.optOut.workspaceName}: ${input.optOut.url}`
      : ""}`,
  };
}
