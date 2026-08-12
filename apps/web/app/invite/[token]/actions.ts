"use server";

import { redirect } from "next/navigation";
import { requireCurrentAppUser, setActiveWorkspace } from "@narriflow/auth";
import { workspaceMembershipService } from "@narriflow/services";

export async function acceptWorkspaceInviteAction(token: string) {
  const appUser = await requireCurrentAppUser();
  const accepted = await workspaceMembershipService.acceptInvite(appUser.id, token);
  await setActiveWorkspace(accepted.workspaceId);
  redirect("/home");
}
