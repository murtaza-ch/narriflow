import type { ReviewRoomData, ReviewRound } from "./review-panel";

const CLOSED_ROUND_STATUSES = new Set(["expired", "revoked", "superseded"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function reviewerEmailsFromText(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,;]+/)
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function invalidReviewerEmails(value: string): string[] {
  return reviewerEmailsFromText(value).filter((email) => !EMAIL_PATTERN.test(email));
}

export function activeShareRound(data: ReviewRoomData): ReviewRound | null {
  return data.rounds.find(
    (round) => Boolean(round.path) && !CLOSED_ROUND_STATUSES.has(round.status),
  ) ?? null;
}

export function quickReviewItems(data: ReviewRoomData) {
  return data.candidates.flatMap((candidate) => {
    const latestExport = candidate.exports[0];
    const variantIds = latestExport?.variants.slice(0, 4).map((variant) => variant.id) ?? [];
    return latestExport && variantIds.length > 0
      ? [{
          clipId: candidate.id,
          exportId: latestExport.id,
          expectedEditorRevision: latestExport.editorRevision,
          variantIds,
          required: true,
        }]
      : [];
  });
}

export function buildQuickReviewRoundInput(
  data: ReviewRoomData,
  recipientEmails: string[],
) {
  return {
    title: `${data.project.title} review`,
    message: null,
    passcode: null,
    expiresAt: null,
    allowDownloads: false,
    approvalRequired: data.project.approvalRequiredByDefault,
    recipientEmails,
    contextCommentIds: [],
    items: quickReviewItems(data),
  };
}

export function reviewApprovalProgress(round: ReviewRound) {
  const requiredItems = round.items.filter((item) => item.required);
  return {
    approved: requiredItems.filter((item) => item.currentDecision === "approved").length,
    required: requiredItems.length,
  };
}
