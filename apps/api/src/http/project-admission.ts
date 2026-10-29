import type { PrismaClient } from "@prisma/client";
import type { ActorScope, ProjectAdmissionResult } from "./request-policy";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Project ids are Postgres UUIDs. A malformed id cannot name a Project, so it
 * is concealed exactly like a missing one instead of reaching the database.
 */
export async function resolveAuthenticatedProject(
  prisma: Pick<PrismaClient, "project" | "workspace">,
  input: { actor: ActorScope; projectId: string; now?: Date },
): Promise<ProjectAdmissionResult> {
  if (!UUID_PATTERN.test(input.projectId)) return { kind: "missing" };
  // One single-table read: the actor's membership is a filter, not a second
  // lookup, and the Workspace name is fetched only to explain a mismatch.
  const project = await prisma.project.findFirst({
    where: {
      id: input.projectId,
      purgeStartedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: input.now ?? new Date() } }],
      workspace: { members: { some: { userId: input.actor.actorUserId } } },
    },
    select: { id: true, workspaceId: true },
  });

  if (!project) return { kind: "missing" };
  if (project.workspaceId === input.actor.workspaceId) {
    return { kind: "active", projectId: project.id };
  }
  const workspace = await prisma.workspace.findUnique({
    where: { id: project.workspaceId },
    select: { name: true },
  });
  return {
    kind: "workspace_mismatch",
    projectId: project.id,
    workspaceId: project.workspaceId,
    workspaceName: workspace?.name ?? "",
  };
}
