import type { listUserWorkspaces } from "@narriflow/auth";
import type { workspaceService } from "@narriflow/services";
import { resolvePricingTier } from "@narriflow/validators";
import type { SessionUser, WorkspaceSummary } from "@narriflow/validators/api/session";

/** What both bootstrap reads need to list a user's Workspaces. */
export interface MembershipReads {
  listUserWorkspaces: typeof listUserWorkspaces;
  workspaceService: Pick<typeof workspaceService, "getAvatarUrls">;
}

/** Safe identity facts of the signed-in user; no Clerk IDs, secrets or unrelated columns. */
export function toSessionUser(user: {
  actorUserId: string;
  primaryEmail: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
}): SessionUser {
  return {
    id: user.actorUserId,
    email: user.primaryEmail,
    firstName: user.firstName,
    lastName: user.lastName,
    imageUrl: user.imageUrl,
  };
}

/** Every Workspace the user belongs to, with role, status, plan and a signed avatar URL. */
export async function readMemberships(
  reads: MembershipReads,
  userId: string,
): Promise<WorkspaceSummary[]> {
  const memberships = await reads.listUserWorkspaces(userId);
  const avatarUrls = await reads.workspaceService.getAvatarUrls(
    userId,
    memberships.map(({ workspace }) => workspace.id),
  );
  return memberships.map(({ role, workspace }) => ({
    id: workspace.id,
    name: workspace.name,
    role,
    status: workspace.status,
    pricingTier: resolvePricingTier(workspace.pricingTier),
    isPersonal: workspace.personalOwnerUserId !== null,
    avatarUrl: avatarUrls[workspace.id] ?? null,
  }));
}
