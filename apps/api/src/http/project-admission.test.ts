import { describe, expect, mock, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { resolveAuthenticatedProject } from "./project-admission";
import type { ActorScope } from "./request-policy";

const actor = { actorUserId: "u", workspaceId: "w" } as ActorScope;
const id = "11111111-1111-4111-8111-111111111111";

function prismaReturning(project: unknown) {
  const findFirst = mock(async () => project);
  return { prisma: { project: { findFirst } } as unknown as Pick<PrismaClient, "project">, findFirst };
}

describe("Project admission", () => {
  test("conceals a malformed identifier without querying the database", async () => {
    const { prisma, findFirst } = prismaReturning(null);
    await expect(resolveAuthenticatedProject(prisma, { actor, projectId: "../../etc" })).resolves.toEqual({
      kind: "missing",
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  test("conceals a Project the actor is not a member of", async () => {
    const { prisma } = prismaReturning({ id, workspace: { id: "w", name: "W", members: [] } });
    await expect(resolveAuthenticatedProject(prisma, { actor, projectId: id })).resolves.toEqual({ kind: "missing" });
  });

  test("reports an entitled mismatch and admits a matching Workspace", async () => {
    const other = prismaReturning({ id, workspace: { id: "x", name: "X", members: [{ id: "m" }] } });
    await expect(resolveAuthenticatedProject(other.prisma, { actor, projectId: id })).resolves.toEqual({
      kind: "workspace_mismatch",
      projectId: id,
      workspaceId: "x",
      workspaceName: "X",
    });
    const same = prismaReturning({ id, workspace: { id: "w", name: "W", members: [{ id: "m" }] } });
    await expect(resolveAuthenticatedProject(same.prisma, { actor, projectId: id })).resolves.toEqual({
      kind: "active",
      projectId: id,
    });
  });
});
