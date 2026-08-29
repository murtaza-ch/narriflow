import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import {
  createAuthenticatedRequestPolicy,
  type ActorScope,
} from "./authenticated-request-policy";
import { resolveAuthenticatedProject } from "./authenticated-request-project";

const databaseUrl = process.env.AUTHENTICATED_REQUEST_POLICY_TEST_DATABASE_URL;
const databaseSchema =
  process.env.AUTHENTICATED_REQUEST_POLICY_TEST_DATABASE_SCHEMA;
const enabled =
  process.env.ALLOW_AUTHENTICATED_REQUEST_POLICY_DB_TESTS === "1" &&
  Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);

dbDescribe("Authenticated Request Policy PostgreSQL admission", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let actorUserId: string;
  let activeWorkspaceId: string;
  let workspaceAId: string;
  let workspaceBId: string;
  let activeProjectId: string;
  let expiredProjectId: string;
  let purgingProjectId: string;
  let crossWorkspaceProjectId: string;
  let inaccessibleProjectId: string;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("Policy test database is required");
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    prisma = new PrismaClient({
      adapter: new PrismaPg(
        pool,
        databaseSchema ? { schema: databaseSchema } : undefined,
      ),
    });

    const suffix = randomUUID();
    const [owner, actor, outsider] = await Promise.all(
      ["owner", "actor", "outsider"].map((label) =>
        prisma.user.create({
          data: {
            clerkId: `policy-${label}-${suffix}`,
            primaryEmail: `policy-${label}-${suffix}@example.test`,
          },
        }),
      ),
    );
    actorUserId = actor.id;
    const [workspaceA, workspaceB, workspaceC] = await Promise.all([
      prisma.workspace.create({
        data: {
          name: "Policy A",
          ownerUserId: owner.id,
          members: {
            create: [
              { userId: owner.id, role: "owner" },
              { userId: actor.id, role: "editor" },
            ],
          },
        },
      }),
      prisma.workspace.create({
        data: {
          name: "Policy B",
          ownerUserId: owner.id,
          members: {
            create: [
              { userId: owner.id, role: "owner" },
              { userId: actor.id, role: "viewer" },
            ],
          },
        },
      }),
      prisma.workspace.create({
        data: {
          name: "Policy C",
          ownerUserId: outsider.id,
          members: { create: { userId: outsider.id, role: "owner" } },
        },
      }),
    ]);
    workspaceAId = workspaceA.id;
    workspaceBId = workspaceB.id;
    activeWorkspaceId = workspaceA.id;

    const createProject = (
      title: string,
      workspaceId: string,
      userId: string,
      data = {},
    ) =>
      prisma.project.create({
        data: {
          title,
          sourceMediaUrl: `https://example.test/${title}`,
          workspaceId,
          userId,
          ...data,
        },
      });
    const [active, expired, purging, cross, inaccessible] = await Promise.all([
      createProject("active", workspaceA.id, owner.id),
      createProject("expired", workspaceA.id, owner.id, {
        expiresAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
      createProject("purging", workspaceA.id, owner.id, {
        purgeStartedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
      createProject("cross", workspaceB.id, owner.id),
      createProject("inaccessible", workspaceC.id, outsider.id),
    ]);
    activeProjectId = active.id;
    expiredProjectId = expired.id;
    purgingProjectId = purging.id;
    crossWorkspaceProjectId = cross.id;
    inaccessibleProjectId = inaccessible.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function resolveActor(): Promise<ActorScope | null> {
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: activeWorkspaceId,
          userId: actorUserId,
        },
      },
      include: { workspace: true },
    });
    if (!membership) return null;
    return {
      actorUserId,
      workspaceId: membership.workspaceId,
      workspaceName: membership.workspace.name,
      workspaceOwnerUserId: membership.workspace.ownerUserId,
      role: membership.role,
      status: membership.workspace.status,
      pricingTier: membership.workspace.pricingTier,
      isPersonalWorkspace: false,
      workspaceSelectionChanged: false,
    };
  }

  function policy() {
    return createAuthenticatedRequestPolicy({
      resolveActorScope: resolveActor,
      resolveProject: ({ actor, projectId }) =>
        resolveAuthenticatedProject(prisma, {
          actor,
          projectId,
          now: new Date("2026-08-29T00:00:00.000Z"),
        }),
      rateLimit: async () => ({ allowed: true }),
      createRequestId: randomUUID,
      now: Date.now,
    });
  }

  async function admit(
    projectId: string,
    capability: "content.view" | "processing.consume",
  ) {
    return policy().execute({
      adapter: "page",
      operationName: "postgres-admission",
      admission: { kind: "project", capability, projectId },
      operation: async () => true,
    });
  }

  test("uses current membership role and Workspace status on every request", async () => {
    expect((await admit(activeProjectId, "processing.consume")).ok).toBe(true);
    await prisma.workspaceMember.update({
      where: {
        workspaceId_userId: { workspaceId: workspaceAId, userId: actorUserId },
      },
      data: { role: "viewer" },
    });
    await expect(
      admit(activeProjectId, "processing.consume"),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "capability_denied" },
    });
    await prisma.workspaceMember.update({
      where: {
        workspaceId_userId: { workspaceId: workspaceAId, userId: actorUserId },
      },
      data: { role: "editor" },
    });
    await prisma.workspace.update({
      where: { id: workspaceAId },
      data: { status: "restricted" },
    });
    await expect(admit(activeProjectId, "content.view")).resolves.toMatchObject(
      {
        ok: false,
        failure: { code: "workspace_restricted" },
      },
    );
    await prisma.workspace.update({
      where: { id: workspaceAId },
      data: { status: "active" },
    });
  });

  test("conceals lifecycle and inaccessible Projects but identifies an entitled mismatch", async () => {
    await expect(
      admit(expiredProjectId, "content.view"),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "project_not_found" },
    });
    await expect(
      admit(purgingProjectId, "content.view"),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "project_not_found" },
    });
    await expect(
      admit(inaccessibleProjectId, "content.view"),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "project_not_found" },
    });
    await expect(
      admit(crossWorkspaceProjectId, "content.view"),
    ).resolves.toMatchObject({
      ok: false,
      failure: {
        code: "active_workspace_mismatch",
        details: { workspaceId: workspaceBId, workspaceName: "Policy B" },
      },
    });
  });

  test("membership removal takes effect between requests", async () => {
    expect((await admit(activeProjectId, "content.view")).ok).toBe(true);
    await prisma.workspaceMember.delete({
      where: {
        workspaceId_userId: { workspaceId: workspaceAId, userId: actorUserId },
      },
    });
    await expect(admit(activeProjectId, "content.view")).resolves.toMatchObject(
      {
        ok: false,
        failure: { code: "authentication_required" },
      },
    );
  });
});
