import "server-only";

import { cache } from "react";
import {
  assertWorkspaceCapability,
  getCurrentAppUser,
  getWorkspaceContextForUser,
  type AppUser,
  type WorkspaceActorContext,
  type WorkspaceCapability,
} from "@narriflow/auth";
import { projectService } from "@narriflow/services";

export interface WorkspaceAppUser extends Omit<AppUser, "id"> {
  /** Temporary legacy owner key used only by services still in dual-read mode. */
  id: string;
  /** The signed-in user who must be written to actor/audit columns. */
  actorUserId: string;
  workspaceId: string;
  workspace: WorkspaceActorContext;
}

/**
 * Compatibility adapter for the workspace migration window. Authorization is
 * based on the signed-in actor and active workspace; `id` remains the legacy
 * resource owner so older service methods continue working for team members.
 */
const resolveCurrentWorkspaceAppUser = cache(async (): Promise<WorkspaceAppUser | null> => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return null;

  const workspace = await getWorkspaceContextForUser(appUser);
  if (!appUser || !workspace || appUser.id !== workspace.userId) return null;

  return {
    ...appUser,
    id: workspace.workspaceOwnerUserId,
    actorUserId: workspace.userId,
    workspaceId: workspace.workspaceId,
    workspace,
  };
});

export async function getCurrentWorkspaceAppUser(): Promise<WorkspaceAppUser | null> {
  return resolveCurrentWorkspaceAppUser();
}

export async function requireWorkspaceAppUser(
  capability: WorkspaceCapability = "content.view",
): Promise<WorkspaceAppUser> {
  const appUser = await getCurrentWorkspaceAppUser();
  if (!appUser) throw new Error("Unauthorized");
  assertWorkspaceCapability(appUser.workspace, capability);
  return appUser;
}

export async function requireWorkspaceProject(
  projectId: string,
  capability: WorkspaceCapability = "content.view",
): Promise<WorkspaceAppUser> {
  const appUser = await requireWorkspaceAppUser(capability);
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );
  if (access === "missing") throw new Error("Project not found");
  if (access === "forbidden") throw new Error("Forbidden");
  return appUser;
}
