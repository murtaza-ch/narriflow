import type { PrismaClient } from "@prisma/client";
import type {
  ActorScope,
  ProjectAdmissionResult,
} from "./authenticated-request-policy";

export async function resolveAuthenticatedProject(
  prisma: Pick<PrismaClient, "project">,
  input: { actor: ActorScope; projectId: string; now?: Date },
): Promise<ProjectAdmissionResult> {
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
