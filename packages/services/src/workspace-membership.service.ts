import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceRole } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";

import { billingService } from "./billing.service";
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
    if (invite.workspace.pricingTier !== "business" || invite.workspace.status !== "active") {
      throw new Error("This workspace cannot accept members right now");
    }

    const existing = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId } },
    });
    if (existing) {
      await prisma.workspaceInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
      return { workspaceId: invite.workspaceId, workspaceName: invite.workspace.name, role: existing.role };
    }

    const operationId = `invite:${invite.id}:${randomUUID()}`;
    await prisma.workspaceInvite.update({
      where: { id: invite.id },
      data: { pendingPaymentOperation: operationId },
    });
    try {
      if (isBillable(invite.role)) {
        const current = await prisma.workspaceMember.count({
          where: { workspaceId: invite.workspaceId, role: { in: ["admin", "editor"] } },
        });
        await billingService.setWorkspaceSeatQuantity(
          invite.workspaceId,
          current + 1,
          `workspace-seat-${operationId}`,
        );
      }

      const member = await prisma.$transaction(async (tx) => {
        const fresh = await tx.workspaceInvite.findFirst({
          where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        });
        if (!fresh) throw new Error("This invitation is no longer available");
        const created = await tx.workspaceMember.create({
          data: { workspaceId: invite.workspaceId, userId, role: invite.role },
        });
        await tx.workspaceInvite.update({
          where: { id: invite.id },
          data: { acceptedAt: new Date(), pendingPaymentOperation: null },
        });
        return created;
      });
      if (isBillable(invite.role)) {
        await billingService.reconcileWorkspaceSeats(invite.workspaceId, `invite-${invite.id}`);
      }
      return { workspaceId: invite.workspaceId, workspaceName: invite.workspace.name, role: member.role };
    } catch (error) {
      await prisma.workspaceInvite.updateMany({
        where: { id: invite.id, acceptedAt: null },
        data: { pendingPaymentOperation: null },
      });
      throw error;
    }
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
    const member = await prisma.workspaceMember.findFirst({ where: { id: memberId, workspaceId } });
    if (!member) throw new Error("Member not found");
    if (member.role === "owner") throw new Error("The owner role cannot be changed");
    if (actor.role === "admin" && member.role === "admin") throw new Error("Admins cannot manage other admins");
    if (member.role === nextRole) return member;

    const operationId = `role:${member.id}:${member.role}:${nextRole}`;
    await prisma.workspaceMember.update({
      where: { id: member.id },
      data: { pendingPaymentOperation: operationId },
    });
    const current = await prisma.workspaceMember.count({
      where: { workspaceId, role: { in: ["admin", "editor"] } },
    });
    const projected = current - (isBillable(member.role) ? 1 : 0) + (isBillable(nextRole) ? 1 : 0);
    try {
      if (projected !== current) {
        await billingService.setWorkspaceSeatQuantity(workspaceId, projected, `workspace-seat-${operationId}`);
      }
      const updated = await prisma.workspaceMember.update({
        where: { id: member.id },
        data: { role: nextRole, pendingPaymentOperation: null },
      });
      if (projected !== current) await billingService.reconcileWorkspaceSeats(workspaceId, `role-${member.id}`);
      return updated;
    } catch (error) {
      await prisma.workspaceMember.updateMany({
        where: { id: member.id, pendingPaymentOperation: operationId },
        data: { pendingPaymentOperation: null },
      });
      throw error;
    }
  }

  async removeMember(actorUserId: string, workspaceId: string, memberId: string) {
    const actor = await workspaceService.requireActor(actorUserId, workspaceId, "members.invite");
    const prisma = requiredPrisma();
    const member = await prisma.workspaceMember.findFirst({ where: { id: memberId, workspaceId } });
    if (!member) return;
    if (member.role === "owner") throw new Error("The workspace owner cannot be removed");
    if (actor.role === "admin" && member.role === "admin") throw new Error("Admins cannot remove other admins");
    const current = await prisma.workspaceMember.count({
      where: { workspaceId, role: { in: ["admin", "editor"] } },
    });
    const projected = current - (isBillable(member.role) ? 1 : 0);
    const operationId = `remove:${member.id}:${projected}`;
    await prisma.workspaceMember.update({
      where: { id: member.id },
      data: { pendingPaymentOperation: operationId },
    });
    try {
      if (projected !== current) {
        await billingService.setWorkspaceSeatQuantity(
          workspaceId,
          projected,
          `workspace-seat-${operationId}`,
        );
      }
      await prisma.workspaceMember.delete({ where: { id: member.id } });
      if (projected !== current) await billingService.reconcileWorkspaceSeats(workspaceId, `remove-${member.id}`);
    } catch (error) {
      await prisma.workspaceMember.updateMany({
        where: { id: member.id, pendingPaymentOperation: operationId },
        data: { pendingPaymentOperation: null },
      });
      throw error;
    }
  }
}

export const workspaceMembershipService = new WorkspaceMembershipService();
