export type ReviewCreationAccess =
  | "available"
  | "capability_denied"
  | "plan_required"
  | "rollout_paused";

export function resolveReviewCreationAccess(input: {
  canManageReview: boolean;
  hasReviewRooms: boolean;
  writesEnabled: boolean;
}): ReviewCreationAccess {
  if (!input.canManageReview) return "capability_denied";
  if (!input.hasReviewRooms) return "plan_required";
  if (!input.writesEnabled) return "rollout_paused";
  return "available";
}
