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
}): NotificationEmailTemplate {
  const copy = COPY[input.kind];
  const subject = `${copy.subject}: ${input.projectTitle}`;
  const body = copy.body(input.roundTitle, input.projectTitle);
  return {
    subject,
    html: emailShell({
      eyebrow: copy.eyebrow,
      heading: copy.heading,
      bodyHtml: `<p style="margin:0">${body}</p>`,
      actionLabel: copy.action,
      actionUrl: input.reviewUrl,
    }),
    text: `${subject}\n\n${body.replace(/<[^>]*>/g, "")}\n\n${copy.action}: ${input.reviewUrl}`,
  };
}
