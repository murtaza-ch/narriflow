import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type WorkspaceRole } from "@prisma/client";
import { Pool } from "pg";
import { workspaceMembershipService } from "./workspace-membership.service";

const databaseUrl = process.env.VIZARD_EXPANSION_TEST_DATABASE_URL;
const databaseSchema = process.env.VIZARD_EXPANSION_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_VIZARD_EXPANSION_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

dbDescribe("Workspace membership PostgreSQL concurrency", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const prismaGlobal = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
  const workspaceIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(() => {
    if (!databaseUrl || !databaseSchema) throw new Error("Isolated membership test database is required");
    pool = new Pool({ connectionString: databaseUrl, max: 8,
      options: `-csearch_path=${databaseSchema}` });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: databaseSchema }),
      transactionOptions: { timeout: 15_000 } });
    priorPrisma = prismaGlobal.narriflowPrismaClient;
    prismaGlobal.narriflowPrismaClient = prisma;
  });

  afterAll(async () => {
    await prisma?.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma?.user.deleteMany({ where: { id: { in: userIds } } });
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function fixture(role: WorkspaceRole) {
    const suffix = randomUUID();
    const owner = await prisma.user.create({ data: { clerkId: `membership-owner-${suffix}` } });
    const memberUser = await prisma.user.create({ data: { clerkId: `membership-member-${suffix}` } });
    userIds.push(owner.id, memberUser.id);
    const workspace = await prisma.workspace.create({ data: {
      name: "Membership concurrency", ownerUserId: owner.id, pricingTier: "business",
      members: { create: { userId: owner.id, role: "owner" } },
      billingAccount: { create: { desiredAdditionalSeats: role === "viewer" ? 0 : 1 } },
    } });
    workspaceIds.push(workspace.id);
    const member = await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: memberUser.id, role } });
    return { owner, workspace, member };
  }

  async function raceBehindMemberLock<T>(memberId: string, operations: Array<() => Promise<T>>) {
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "WorkspaceMember" WHERE id = ${memberId}::uuid FOR UPDATE`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const outcomes = operations.map(async (operation) => {
      try { return { status: "fulfilled" as const, value: await operation() }; }
      catch (reason) { return { status: "rejected" as const, reason }; }
    });
    try {
      const relation = `"${databaseSchema}"."WorkspaceMember"`;
      const deadline = Date.now() + 5_000;
      while (true) {
        const [waiting] = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT count(DISTINCT a.pid)::int AS count
          FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
          WHERE l.relation = ${relation}::regclass AND a.wait_event_type = 'Lock'`;
        if (waiting && waiting.count >= operations.length) break;
        if (Date.now() >= deadline) throw new Error("Membership requests did not reach the database lock");
        await Bun.sleep(5);
      }
    } finally {
      release.resolve();
      await blocker;
    }
    return Promise.all(outcomes);
  }

  for (const [from, to, seats] of [["editor", "viewer", 0], ["viewer", "editor", 1]] as const) {
    test(`concurrent identical ${from} to ${to} changes apply one seat delta`, async () => {
      const current = await fixture(from);
      const change = () => workspaceMembershipService.changeRole(current.owner.id, current.workspace.id, current.member.id, to);
      const outcomes = await raceBehindMemberLock(current.member.id, [change, change]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
      expect((await prisma.workspaceMember.findUniqueOrThrow({ where: { id: current.member.id } })).role).toBe(to);
      const account = await prisma.workspaceBillingAccount.findUniqueOrThrow({ where: { workspaceId: current.workspace.id } });
      expect(account.desiredAdditionalSeats).toBe(seats);
      expect(account.seatRevision).toBe(1);
    });
  }

  test("concurrent removals are idempotent and subtract the member's seat once", async () => {
    const current = await fixture("editor");
    const remove = () => workspaceMembershipService.removeMember(current.owner.id, current.workspace.id, current.member.id);
    const outcomes = await raceBehindMemberLock(current.member.id, [remove, remove]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await prisma.workspaceMember.count({ where: { id: current.member.id } })).toBe(0);
    const account = await prisma.workspaceBillingAccount.findUniqueOrThrow({ where: { workspaceId: current.workspace.id } });
    expect(account.desiredAdditionalSeats).toBe(0);
    expect(account.seatRevision).toBe(1);
  });
});
