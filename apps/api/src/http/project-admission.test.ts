import { describe, expect, mock, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { resolveAuthenticatedProject } from "./project-admission";
import type { ActorScope } from "./request-policy";

const actor = { actorUserId: "u", workspaceId: "w" } as ActorScope;
const id = "11111111-1111-4111-8111-111111111111";

function prismaReturning(project: unknown, workspaceName = "X") {
  const findFirst = mock(async () => project);
  const findUnique = mock(async () => ({ name: workspaceName }));
  return {
    prisma: { project: { findFirst }, workspace: { findUnique } } as unknown as Pick<PrismaClient, "project" | "workspace">,
    findFirst,
    findUnique,
  };
}

describe("Project admission", () => {
  test("conceals a malformed identifier without querying the database", async () => {
    const { prisma, findFirst } = prismaReturning(null);
    await expect(resolveAuthenticatedProject(prisma, { actor, projectId: "../../etc" })).resolves.toEqual({
      kind: "missing",
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  test("conceals a Project the actor is not a member of by filtering on the membership", async () => {
    const { prisma, findFirst } = prismaReturning(null);
    await expect(resolveAuthenticatedProject(prisma, { actor, projectId: id })).resolves.toEqual({ kind: "missing" });
    const query = (findFirst.mock.calls as unknown as Array<[{ where: { workspace: unknown } }]>)[0]?.[0];
    expect(query?.where.workspace).toEqual({ members: { some: { userId: "u" } } });
  });

  test("admits a matching Workspace in one read", async () => {
    const same = prismaReturning({ id, workspaceId: "w" });
    await expect(resolveAuthenticatedProject(same.prisma, { actor, projectId: id })).resolves.toEqual({
      kind: "active",
      projectId: id,
    });
    expect(same.findFirst).toHaveBeenCalledTimes(1);
    expect(same.findUnique).not.toHaveBeenCalled();
  });

  test("reports an entitled mismatch with the other Workspace's name", async () => {
    const other = prismaReturning({ id, workspaceId: "x" });
    await expect(resolveAuthenticatedProject(other.prisma, { actor, projectId: id })).resolves.toEqual({
      kind: "workspace_mismatch",
      projectId: id,
      workspaceId: "x",
      workspaceName: "X",
    });
  });
});
