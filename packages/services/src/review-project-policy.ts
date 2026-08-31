import { brandProfileSnapshotSchema } from "@narriflow/validators";

/**
 * Resolves the approval rule frozen onto a Project. A Project without a Brand
 * Profile is advisory. Once a profile is attached, its versioned snapshot is
 * the policy source; a missing, malformed, or mismatched snapshot fails closed.
 */
export function frozenProjectApprovalRequired(input: {
  brandProfileId: string | null;
  brandProfileSnapshot: unknown;
}): boolean {
  if (input.brandProfileId === null) return false;

  const parsed = brandProfileSnapshotSchema.safeParse(
    input.brandProfileSnapshot,
  );
  if (!parsed.success || parsed.data.profileId !== input.brandProfileId) {
    return true;
  }
  return parsed.data.approvalRule === "approval_required";
}
