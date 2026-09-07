import {
  emailShell,
  escapeHtml,
  type NotificationEmailTemplate,
} from "./shared";

export function generationFailed(input: {
  projectTitle: string;
  reason: string;
  retryLink: string;
  kind?: "generation" | "import";
}): NotificationEmailTemplate {
  const label = input.kind === "import" ? "Import" : "Generation";
  const subject = `${label} needs attention — ${input.projectTitle}`;
  const reason = input.reason.trim() || "The operation could not be completed.";

  return {
    subject,
    html: emailShell({
      eyebrow: `${label} failed`,
      heading: `${label} needs attention`,
      bodyHtml: `<p style="margin:0 0 12px"><strong>${escapeHtml(input.projectTitle)}</strong> could not be completed.</p><p style="margin:0">${escapeHtml(reason)}</p>`,
      actionLabel: "Open project and retry",
      actionUrl: input.retryLink,
    }),
    text: `${subject}\n\n${input.projectTitle} could not be completed.\n\nReason: ${reason}\n\nOpen project and retry: ${input.retryLink}`,
  };
}
