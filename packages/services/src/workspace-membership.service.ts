import { createHash } from "node:crypto";
import type { Prisma, WorkspaceRole } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";

import {
  workspaceService,
  workspacesV1EnabledForUser,
} from "./workspace.service";

function requiredPrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("DATABASE_URL is required for workspace membership");
  return prisma;
}

function isBillable(role: WorkspaceRole) {
  return role === "admin" || role === "editor";
}

async function requireBillableAdditionAllowed(
  tx: Prisma.TransactionClient,
  workspaceId: string,
) {
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      status: true,
      pricingTier: true,
      billingAccount: { select: { health: true } },
    },
  });
  if (
    !workspace ||
    workspace.status !== "active" ||
    workspace.pricingTier !== "business"
  ) {
    throw new Error("This workspace cannot add paid members right now");
  }
  if (
    workspace.billingAccount?.health === "attention_required" ||
    workspace.billingAccount?.health === "payment_action_required"
  ) {
    throw new Error("Resolve workspace billing before adding a paid member");
  }
}

async function markSeatCountChanged(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  delta: number,
) {
  if (delta === 0) return;
  await tx.workspaceBillingAccount.update({
    where: { workspaceId },
    data: {
      desiredAdditionalSeats: { increment: delta },
      seatRevision: { increment: 1 },
      nextReconcileAt: new Date(),
    },
  });
}

export class WorkspaceMembershipService {
  async acceptInvite(userId: string, rawToken: string) {
    if (!workspacesV1EnabledForUser(userId)) {
      throw new Error("Workspace collaboration is not enabled for this account");
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
      throw new Error("This invitation is invalid or has expired");
    }
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { primaryEmail: true } });
    if (!user?.primaryEmail || user.primaryEmail.toLocaleLowerCase("en-US") !== invite.email.toLocaleLowerCase("en-US")) {
      throw new Error("Sign in with the email address this invitation was sent to");
    }
    if (
      (invite.workspace.pricingTier !== "business" ||
        invite.workspace.status !== "active") &&
      !(invite.role === "viewer" && invite.workspace.status === "restricted")
    ) {
      throw new Error("This workspace cannot accept members right now");
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
      if (!fresh) throw new Error("This invitation is no longer available");
      if (isBillable(fresh.role)) {
        await requireBillableAdditionAllowed(tx, invite.workspaceId);
      }
      const created = await tx.workspaceMember.create({
        data: { workspaceId: invite.workspaceId, userId, role: fresh.role },
      });
      await tx.workspaceInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });
      await markSeatCountChanged(
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
    if (nextRole === "admin" && actor.role !== "owner") throw new Error("Only owners can promote admins");
    const prisma = requiredPrisma();
    return prisma.$transaction(async (tx) => {
      const member = await tx.workspaceMember.findFirst({
        where: { id: memberId, workspaceId },
      });
      if (!member) throw new Error("Member not found");
      if (member.role === "owner") throw new Error("The owner role cannot be changed");
      if (actor.role === "admin" && member.role === "admin") {
        throw new Error("Admins cannot manage other admins");
      }
      if (member.role === nextRole) return member;
      const delta = Number(isBillable(nextRole)) - Number(isBillable(member.role));
      if (delta > 0) await requireBillableAdditionAllowed(tx, workspaceId);
      const updated = await tx.workspaceMember.update({
        where: { id: member.id },
        data: { role: nextRole },
      });
      await markSeatCountChanged(tx, workspaceId, delta);
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
        throw new Error("The workspace owner cannot be removed");
      }
      if (actor.role === "admin" && member.role === "admin") {
        throw new Error("Admins cannot remove other admins");
      }
      await tx.workspaceMember.delete({ where: { id: member.id } });
      await markSeatCountChanged(tx, workspaceId, isBillable(member.role) ? -1 : 0);
    });
  }
}

export const workspaceMembershipService = new WorkspaceMembershipService();
