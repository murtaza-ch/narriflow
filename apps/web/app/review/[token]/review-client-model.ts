export type ReviewCommentTarget = {
  id: string;
  itemId: string | null;
};

export function reviewApprovalProgress(
  items: Array<{ required: boolean; currentDecision: string | null }>,
  approvalRequired: boolean,
) {
  const required = items.filter((item) => item.required);
  const approved = required.filter((item) => item.currentDecision === "approved").length;
  return {
    approved,
    required: required.length,
    ready: !approvalRequired || approved === required.length,
  };
}

export function buildReviewCommentPayload(input: {
  body: string;
  activeItemId: string | null;
  parent: ReviewCommentTarget | null;
  scope: "clip" | "round";
  includeTimecode: boolean;
  currentTimeSec: number | null;
}) {
  const itemId = input.parent?.itemId ?? (input.scope === "round" ? null : input.activeItemId);
  const timestampSec = input.parent || input.scope === "round" || !input.includeTimecode || !itemId
    ? null
    : input.currentTimeSec;
  return {
    itemId,
    parentId: input.parent?.id ?? null,
    body: input.body.trim(),
    timestampSec,
  };
}
