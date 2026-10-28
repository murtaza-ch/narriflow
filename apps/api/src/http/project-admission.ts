import type { PrismaClient } from "@prisma/client";
import type { ActorScope, ProjectAdmissionResult } from "./request-policy";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Project ids are Postgres UUIDs. A malformed id cannot name a Project, so it
 * is concealed exactly like a missing one instead of reaching the database.
 */
export async function resolveAuthenticatedProject(
  prisma: Pick<PrismaClient, "project">,
  input: { actor: ActorScope; projectId: string; now?: Date },
): Promise<ProjectAdmissionResult> {
  if (!UUID_PATTERN.test(input.projectId)) return { kind: "missing" };
  const project = await prisma.project.findFirst({
    where: {
      id: input.projectId,
      purgeStartedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: input.now ?? new Date() } }],
    },
    select: {
      id: true,
      workspace: {
        select: {
          id: true,
          name: true,
          members: {
            where: { userId: input.actor.actorUserId },
            select: { id: true },
            take: 1,
          },
        },
      },
    },
  });

  if (!project || project.workspace.members.length === 0) {
    return { kind: "missing" };
  }
  if (project.workspace.id !== input.actor.workspaceId) {
    return {
      kind: "workspace_mismatch",
      projectId: project.id,
      workspaceId: project.workspace.id,
      workspaceName: project.workspace.name,
    };
  }
  return { kind: "active", projectId: project.id };
}
