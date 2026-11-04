import type { listUserWorkspaces } from "@narriflow/auth";
import { type projectService } from "@narriflow/services/project.service";
import { type workspaceService } from "@narriflow/services/workspace.service";
import { resolvePricingTier } from "@narriflow/validators";
import type { SessionUser, WorkspaceSummary } from "@narriflow/validators/api/session";
import type { WorkspaceUsage } from "@narriflow/validators/api/workspace";

/** What both bootstrap reads need to list a user's Workspaces. */
export interface MembershipReads {
  listUserWorkspaces: typeof listUserWorkspaces;
  workspaceService: Pick<typeof workspaceService, "presignAvatarUrls">;
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
  return projectMemberships(reads, await reads.listUserWorkspaces(userId));
}

/** The wire shape of memberships already read. The listing proves access to each avatar. */
export async function projectMemberships(
  reads: Pick<MembershipReads, "workspaceService">,
  memberships: Awaited<ReturnType<typeof listUserWorkspaces>>,
): Promise<WorkspaceSummary[]> {
  const avatarUrls = await reads.workspaceService.presignAvatarUrls(
    memberships.map(({ workspace }) => workspace),
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

/** The wire shape of the Workspace's processing usage. */
export function toUsage(summary: Awaited<ReturnType<typeof projectService.getUsageSummary>>): WorkspaceUsage {
  return {
    tier: resolvePricingTier(summary.tier),
    usedCredits: summary.usedCredits,
    reservedCredits: summary.reservedCredits,
    limitCredits: summary.limitCredits,
    remainingCredits: summary.remainingCredits,
    periodStart: summary.periodStart.toISOString(),
    renewsAt: summary.renewsAt.toISOString(),
    inFlight: summary.inFlight,
    inFlightLimit: summary.inFlightLimit,
    maxUploadSeconds: summary.maxUploadSeconds,
  };
}
