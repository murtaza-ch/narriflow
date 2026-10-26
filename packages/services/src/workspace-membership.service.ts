import { createHash } from "node:crypto";
import type { Prisma, WorkspaceRole } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";

import { requirePlanFeature } from "./plan-features";
import { pauseGrantsOfGranter } from "./standing-grant";
import {
  WorkspaceOperationError,
  workspaceService,
  workspacesV1EnabledForUser,
} from "./workspace.service";
import { flushWorkspaceEvents } from "./workspace-event";

function requiredPrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("DATABASE_URL is required for workspace membership");
  return prisma;
}

function isBillable(role: WorkspaceRole) {
  return role === "admin" || role === "editor";
}

const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

/**
 * Whether a role change grants more privilege. Below the team-members plan
 * only cleanup is allowed: removals and demotions. Any elevation, with or
 * without a seat change, needs the plan.
 */
export function isWorkspaceRoleElevation(
  from: WorkspaceRole,
  to: WorkspaceRole,
): boolean {
  return ROLE_RANK[to] > ROLE_RANK[from];
}

/**
 * Re-checked inside the writing transaction: a new member or a role
 * elevation needs a plan with team members and an active Workspace; adding a
 * billable seat also needs billing that can take a seat change.
 */
async function requireMemberGrowthAllowed(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  input: { addsSeat: boolean },
) {
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      status: true,
      pricingTier: true,
      billingAccount: { select: { health: true } },
    },
  });
  if (!workspace) {
    throw new WorkspaceOperationError(
      "workspace_members_unavailable",
      "This workspace cannot accept members right now",
    );
  }
  requirePlanFeature(workspace.pricingTier, "workspace.members");
  if (workspace.status !== "active") {
    throw input.addsSeat
      ? new WorkspaceOperationError(
          "workspace_paid_members_unavailable",
          "This workspace cannot add paid members right now",
        )
      : new WorkspaceOperationError(
          "workspace_members_unavailable",
          "This workspace cannot accept members right now",
        );
  }
  if (
    input.addsSeat &&
    (workspace.billingAccount?.health === "attention_required" ||
      workspace.billingAccount?.health === "payment_action_required")
  ) {
    throw new WorkspaceOperationError(
      "workspace_billing_action_required",
      "Resolve workspace billing before adding a paid member",
    );
  }
}

/**
 * Every membership change wakes Workspace Billing: billable changes converge
 * seats, and any change can lift or apply the below-Business member
 * restriction in the access projection.
 */
async function markMembershipChanged(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  seatDelta: number,
) {
  if (seatDelta === 0) {
    await tx.workspaceBillingAccount.updateMany({
      where: { workspaceId },
      data: { nextReconcileAt: new Date() },
    });
    return;
  }
  await tx.workspaceBillingAccount.update({
    where: { workspaceId },
    data: {
      desiredAdditionalSeats: { increment: seatDelta },
      seatRevision: { increment: 1 },
      nextReconcileAt: new Date(),
    },
  });
}

export class WorkspaceMembershipService {
  async acceptInvite(userId: string, rawToken: string) {
    if (!workspacesV1EnabledForUser(userId)) {
      throw new WorkspaceOperationError(
        "workspace_collaboration_disabled",
        "Workspace collaboration is not enabled for this account",
      );
    }
    const prisma = requiredPrisma();
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const invite = await prisma.workspaceInvite.findUnique({
      where: { tokenHash },
      include: {
        workspace: { select: { id: true, name: true, pricingTier: true, status: true } },
      },
    });
    if (!invite || invite.revokedAt || invite.acceptedAt || invite.expiresAt <= new Date()) {
      throw new WorkspaceOperationError(
        "workspace_invite_invalid",
        "This invitation is invalid or has expired",
      );
    }
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { primaryEmail: true } });
    if (!user?.primaryEmail || user.primaryEmail.toLocaleLowerCase("en-US") !== invite.email.toLocaleLowerCase("en-US")) {
      throw new WorkspaceOperationError(
        "workspace_invite_email_mismatch",
        "Sign in with the email address this invitation was sent to",
      );
    }
    requirePlanFeature(invite.workspace.pricingTier, "workspace.members");
    if (invite.workspace.status !== "active") {
      throw new WorkspaceOperationError(
        "workspace_members_unavailable",
        "This workspace cannot accept members right now",
      );
    }

    const existing = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId } },
    });
    if (existing) {
      await prisma.workspaceInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
      return { workspaceId: invite.workspaceId, workspaceName: invite.workspace.name, role: existing.role };
    }

    const member = await prisma.$transaction(async (tx) => {
      const fresh = await tx.workspaceInvite.findFirst({
        where: {
          id: invite.id,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (!fresh) {
        throw new WorkspaceOperationError(
          "workspace_invite_unavailable",
          "This invitation is no longer available",
        );
      }
      await requireMemberGrowthAllowed(tx, invite.workspaceId, {
        addsSeat: isBillable(fresh.role),
      });
      const created = await tx.workspaceMember.create({
        data: { workspaceId: invite.workspaceId, userId, role: fresh.role },
      });
      await tx.workspaceInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });
      await markMembershipChanged(
        tx,
        invite.workspaceId,
        isBillable(fresh.role) ? 1 : 0,
      );
      return created;
    });
    return {
      workspaceId: invite.workspaceId,
      workspaceName: invite.workspace.name,
      role: member.role,
    };
  }

  async changeRole(
    actorUserId: string,
    workspaceId: string,
    memberId: string,
    nextRole: Exclude<WorkspaceRole, "owner">,
  ) {
    const actor = await workspaceService.requireActor(actorUserId, workspaceId, "members.invite");
    if (nextRole === "admin" && actor.role !== "owner") {
      throw new WorkspaceOperationError(
        "workspace_admin_promotion_owner_required",
        "Only owners can promote admins",
      );
    }
    const prisma = requiredPrisma();
    return prisma.$transaction(async (tx) => {
      const member = await tx.workspaceMember.findFirst({
        where: { id: memberId, workspaceId },
      });
      if (!member) {
        throw new WorkspaceOperationError(
          "workspace_member_not_found",
          "Member not found",
        );
      }
      if (member.role === "owner") {
        throw new WorkspaceOperationError(
          "workspace_owner_role_immutable",
          "The owner role cannot be changed",
        );
      }
      if (actor.role === "admin" && member.role === "admin") {
        throw new WorkspaceOperationError(
          "workspace_admin_peer_forbidden",
          "Admins cannot manage other admins",
        );
      }
      if (member.role === nextRole) return member;
      const delta = Number(isBillable(nextRole)) - Number(isBillable(member.role));
      if (isWorkspaceRoleElevation(member.role, nextRole)) {
        await requireMemberGrowthAllowed(tx, workspaceId, { addsSeat: delta > 0 });
      }
      const updated = await tx.workspaceMember.update({
        where: { id: member.id },
        data: { role: nextRole },
      });
      await markMembershipChanged(tx, workspaceId, delta);
      // A grant acts for a person who manages the Workspace. Demoted below Admin, theirs pause now,
      // not at the next delivery.
      if (nextRole !== "admin") await pauseGrantsOfGranter(tx, { workspaceId, userId: member.userId });
      await flushWorkspaceEvents(tx);
      return updated;
    });
  }

  async removeMember(actorUserId: string, workspaceId: string, memberId: string) {
    const actor = await workspaceService.requireActor(actorUserId, workspaceId, "members.invite");
    const prisma = requiredPrisma();
    await prisma.$transaction(async (tx) => {
      const member = await tx.workspaceMember.findFirst({
        where: { id: memberId, workspaceId },
      });
      if (!member) return;
      if (member.role === "owner") {
        throw new WorkspaceOperationError(
          "workspace_owner_removal_forbidden",
          "The workspace owner cannot be removed",
        );
      }
      if (actor.role === "admin" && member.role === "admin") {
        throw new WorkspaceOperationError(
          "workspace_admin_peer_forbidden",
          "Admins cannot remove other admins",
        );
      }
      await tx.workspaceMember.delete({ where: { id: member.id } });
      await markMembershipChanged(tx, workspaceId, isBillable(member.role) ? -1 : 0);
      await pauseGrantsOfGranter(tx, { workspaceId, userId: member.userId });
      await flushWorkspaceEvents(tx);
    });
  }
}

export const workspaceMembershipService = new WorkspaceMembershipService();
