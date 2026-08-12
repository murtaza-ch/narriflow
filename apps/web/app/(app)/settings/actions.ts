"use server";

import { revalidatePath } from "next/cache";
import { sendEmail } from "@narriflow/email";
import { workspaceMembershipService, workspaceService } from "@narriflow/services";
import { requireWorkspaceAppUser } from "@/lib/workspace";

function inviteUrl(token: string) {
  const origin =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
    "http://localhost:3000";
  return `${origin}/invite/${token}`;
}

async function deliverWorkspaceInvite(input: {
  id: string;
  email: string;
  token: string;
  workspaceName: string;
}) {
  const url = inviteUrl(input.token);
  const delivery = await sendEmail({
    to: input.email,
    subject: `Join ${input.workspaceName} on Narriflow`,
    text: [
      `You've been invited to join ${input.workspaceName} on Narriflow.`,
      "",
      `Accept invitation: ${url}`,
      "",
      "This invitation expires in seven days.",
    ].join("\n"),
    idempotencyKey: `workspace-invite/${input.id}`,
  });
  return { url, emailSent: delivery.sent };
}

export async function updateWorkspaceAction(formData: FormData) {
  const appUser = await requireWorkspaceAppUser("workspace.manage");
  await workspaceService.updateWorkspace(appUser.actorUserId, appUser.workspaceId, {
    name: String(formData.get("name") ?? ""),
    timezone: String(formData.get("timezone") ?? "UTC"),
  });
  revalidatePath("/", "layout");
  revalidatePath("/settings/workspace");
}

export async function inviteMemberAction(input: {
  email: string;
  role: "admin" | "editor" | "viewer";
}) {
  try {
    const appUser = await requireWorkspaceAppUser("members.invite");
    const invite = await workspaceService.createInvite(
      appUser.actorUserId,
      appUser.workspaceId,
      input,
    );
    revalidatePath("/settings/members");
    const delivery = await deliverWorkspaceInvite({
      ...invite,
      workspaceName: appUser.workspace.workspaceName,
    });
    return { ok: true as const, inviteUrl: delivery.url, emailSent: delivery.emailSent };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Invite failed" };
  }
}

export async function resendInviteAction(inviteId: string) {
  try {
    const appUser = await requireWorkspaceAppUser("members.invite");
    const invite = await workspaceService.resendInvite(
      appUser.actorUserId,
      appUser.workspaceId,
      inviteId,
    );
    revalidatePath("/settings/members");
    const delivery = await deliverWorkspaceInvite({
      ...invite,
      workspaceName: appUser.workspace.workspaceName,
    });
    return { ok: true as const, inviteUrl: delivery.url, emailSent: delivery.emailSent };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Invitation resend failed",
    };
  }
}

export async function revokeInviteAction(inviteId: string) {
  const appUser = await requireWorkspaceAppUser("members.invite");
  await workspaceService.revokeInvite(appUser.actorUserId, appUser.workspaceId, inviteId);
  revalidatePath("/settings/members");
}

export async function changeMemberRoleAction(
  memberId: string,
  role: "admin" | "editor" | "viewer",
) {
  try {
    const appUser = await requireWorkspaceAppUser("members.invite");
    await workspaceMembershipService.changeRole(
      appUser.actorUserId,
      appUser.workspaceId,
      memberId,
      role,
    );
    revalidatePath("/settings/members");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Role change failed" };
  }
}

export async function removeMemberAction(memberId: string) {
  try {
    const appUser = await requireWorkspaceAppUser("members.invite");
    await workspaceMembershipService.removeMember(
      appUser.actorUserId,
      appUser.workspaceId,
      memberId,
    );
    revalidatePath("/settings/members");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Member removal failed" };
  }
}

export async function createApiKeyAction(input: { name: string; scopes?: string[] }) {
  try {
    const appUser = await requireWorkspaceAppUser("api.manage");
    const key = await workspaceService.createApiKey(
      appUser.actorUserId,
      appUser.workspaceId,
      input,
    );
    revalidatePath("/settings/api");
    return { ok: true as const, key: { ...key, createdAt: key.createdAt.toISOString() } };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "API key creation failed" };
  }
}

export async function revokeApiKeyAction(keyId: string) {
  const appUser = await requireWorkspaceAppUser("api.manage");
  await workspaceService.revokeApiKey(appUser.actorUserId, appUser.workspaceId, keyId);
  revalidatePath("/settings/api");
}
