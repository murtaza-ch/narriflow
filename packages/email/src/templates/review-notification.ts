import {
  emailShell,
  escapeHtml,
  type NotificationEmailTemplate,
} from "./shared";

type ReviewNotificationKind =
  | "round_sent"
  | "round_resent"
  | "first_changes_requested"
  | "all_approved"
  | "mention";

const copy: Record<
  ReviewNotificationKind,
  { eyebrow: string; heading: string; action: string; sentence: string }
> = {
  round_sent: {
    eyebrow: "Client review",
    heading: "A review round is ready",
    action: "Open review",
    sentence: "A new review round is ready for your comments and decision.",
  },
  round_resent: {
    eyebrow: "Client review",
    heading: "Review link reminder",
    action: "Open review",
    sentence: "The review link has been sent again for your attention.",
  },
  first_changes_requested: {
    eyebrow: "Review update",
    heading: "Changes were requested",
    action: "Review feedback",
    sentence: "A reviewer requested changes. Open the project to see the feedback.",
  },
  all_approved: {
    eyebrow: "Review update",
    heading: "The round is approved",
    action: "Open project",
    sentence: "The reviewer approved the submitted round.",
  },
  mention: {
    eyebrow: "Review comment",
    heading: "You were mentioned",
    action: "Open comment",
    sentence: "A teammate mentioned you in the review discussion.",
  },
};

export function reviewNotification(input: {
  kind: ReviewNotificationKind;
  projectTitle: string;
  roundNumber: number;
  actionUrl: string;
}): NotificationEmailTemplate {
  const selected = copy[input.kind];
  const subject = `${selected.heading} — ${input.projectTitle}`;
  const context = `Round ${Math.max(1, Math.trunc(input.roundNumber))} of <strong>${escapeHtml(input.projectTitle)}</strong>.`;
  return {
    subject,
    html: emailShell({
      eyebrow: selected.eyebrow,
      heading: selected.heading,
      bodyHtml: `<p style="margin:0 0 10px">${selected.sentence}</p><p style="margin:0">${context}</p>`,
      actionLabel: selected.action,
      actionUrl: input.actionUrl,
    }),
    text: `${subject}\n\n${selected.sentence}\nRound ${input.roundNumber} of ${input.projectTitle}.\n\n${selected.action}: ${input.actionUrl}`,
  };
}
