import { bindServiceTestEnvironment } from "./runtime-test-support";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type WorkspaceRole } from "@prisma/client";
import { Pool } from "pg";
import { workspaceCommands } from "./workspace-commands-runtime";
import { workspaceMembershipService } from "./workspace-membership.service";
import { workspaceService } from "./workspace.service";

const databaseUrl = process.env.VIZARD_EXPANSION_TEST_DATABASE_URL;
const databaseSchema = process.env.VIZARD_EXPANSION_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_VIZARD_EXPANSION_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

dbDescribe("Workspace membership PostgreSQL concurrency", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const prismaGlobal = createDatabaseTestContext();
  const workspaceIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(bindServiceTestEnvironment(prismaGlobal.bind(() => {
    if (!databaseUrl || !databaseSchema) throw new Error("Isolated membership test database is required");
    pool = new Pool({ connectionString: databaseUrl, max: 8,
      options: `-csearch_path=${databaseSchema}` });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: databaseSchema }),
      transactionOptions: { timeout: 15_000 } });
    priorPrisma = prismaGlobal.client;
    prismaGlobal.client = prisma;
  })));

  afterAll(bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    await prisma?.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma?.user.deleteMany({ where: { id: { in: userIds } } });
    prismaGlobal.client = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  })));

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
    test(`concurrent identical ${from} to ${to} changes apply one seat delta`, bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const current = await fixture(from);
      const change = () => workspaceMembershipService.changeRole(current.owner.id, current.workspace.id, current.member.id, to);
      const outcomes = await raceBehindMemberLock(current.member.id, [change, change]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
      expect((await prisma.workspaceMember.findUniqueOrThrow({ where: { id: current.member.id } })).role).toBe(to);
      const account = await prisma.workspaceBillingAccount.findUniqueOrThrow({ where: { workspaceId: current.workspace.id } });
      expect(account.desiredAdditionalSeats).toBe(seats);
      expect(account.seatRevision).toBe(1);
    })));
  }

  test("concurrent removals are idempotent and subtract the member's seat once", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const current = await fixture("editor");
    const remove = () => workspaceMembershipService.removeMember(current.owner.id, current.workspace.id, current.member.id);
    const outcomes = await raceBehindMemberLock(current.member.id, [remove, remove]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await prisma.workspaceMember.count({ where: { id: current.member.id } })).toBe(0);
    const account = await prisma.workspaceBillingAccount.findUniqueOrThrow({ where: { workspaceId: current.workspace.id } });
    expect(account.desiredAdditionalSeats).toBe(0);
    expect(account.seatRevision).toBe(1);
  })));

  describe("receipt-backed Workspace commands", () => {
    const inviteTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

    test("simultaneous invites with one key write one invite and one receipt, and only one caller sees the token", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const current = await fixture("editor");
      const email = `invitee-${randomUUID()}@example.com`;
      const actor = { actorUserId: current.owner.id, workspaceId: current.workspace.id };
      const invite = () => workspaceCommands.inviteMember(actor, { email, role: "viewer" }, { clientIdempotencyKey: "lost-response-key" });
      const outcomes = await Promise.all([invite(), invite(), invite(), invite()]);

      expect(new Set(outcomes.map((outcome) => outcome.invite.id)).size).toBe(1);
      const withToken = outcomes.filter((outcome) => outcome.token !== null);
      expect(withToken).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.replayed)).toHaveLength(3);
      const rows = await prisma.workspaceInvite.findMany({ where: { workspaceId: current.workspace.id, email } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenHash).toBe(inviteTokenHash(withToken[0]?.token as string));
      expect(rows[0]?.invitedByUserId).toBe(current.owner.id);
      const receipts = await prisma.operationReceipt.findMany({ where: { workspaceId: current.workspace.id, command: "invite_workspace_member" } });
      expect(receipts).toHaveLength(1);
      // The raw token is a credential; the durable receipt never holds it.
      expect(JSON.stringify(receipts[0]?.result)).not.toContain(withToken[0]?.token as string);

      // The response was lost: the same key later resolves to the same invite and cannot reveal the token.
      const later = await invite();
      expect(later).toMatchObject({ replayed: true, token: null });
      expect(later.invite.id).toBe(rows[0]?.id);
      expect(await prisma.workspaceInvite.count({ where: { workspaceId: current.workspace.id, email } })).toBe(1);
    })));

    test("concurrent invites to one address leave a single pending invite, and the database refuses a second", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const current = await fixture("editor");
      const email = `Concurrent-${randomUUID()}@Example.com`;
      await Promise.all(["a", "b", "c"].map(() => workspaceService.createInvite(current.owner.id, current.workspace.id, { email, role: "viewer" })));
      const pending = await prisma.workspaceInvite.findMany({ where: { workspaceId: current.workspace.id, acceptedAt: null, revokedAt: null } });
      expect(pending).toHaveLength(1);
      await expect((async () => prisma.workspaceInvite.create({ data: { workspaceId: current.workspace.id, email: email.toUpperCase(), role: "viewer", tokenHash: randomUUID(), invitedByUserId: current.owner.id, expiresAt: new Date(Date.now() + 1000) } }))()).rejects.toMatchObject({ code: "P2002" });
    })));

    test("an invite key reused with different input conflicts instead of inviting someone else", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const current = await fixture("editor");
      const actor = { actorUserId: current.owner.id, workspaceId: current.workspace.id };
      const mutation = { clientIdempotencyKey: "changed-input" };
      await workspaceCommands.inviteMember(actor, { email: `a-${randomUUID()}@example.com`, role: "viewer" }, mutation);
      await expect(
        workspaceCommands.inviteMember(actor, { email: `b-${randomUUID()}@example.com`, role: "viewer" }, mutation),
      ).rejects.toMatchObject({ code: "operation_idempotency_conflict" });
    })));

    test("an invite refused by the plan leaves no invite and no receipt", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const current = await fixture("editor");
      await prisma.workspace.update({ where: { id: current.workspace.id }, data: { pricingTier: "free" } });
      const actor = { actorUserId: current.owner.id, workspaceId: current.workspace.id };
      await expect(
        workspaceCommands.inviteMember(actor, { email: `p-${randomUUID()}@example.com`, role: "viewer" }, { clientIdempotencyKey: "plan" }),
      ).rejects.toThrow();
      expect(await prisma.workspaceInvite.count({ where: { workspaceId: current.workspace.id } })).toBe(0);
      expect(await prisma.operationReceipt.count({ where: { workspaceId: current.workspace.id } })).toBe(0);
    })));

    test("a resend replaces the pending invite once per key", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const current = await fixture("editor");
      const actor = { actorUserId: current.owner.id, workspaceId: current.workspace.id };
      const email = `again-${randomUUID()}@example.com`;
      const first = await workspaceCommands.inviteMember(actor, { email, role: "editor" }, { clientIdempotencyKey: "first" });
      const resend = () => workspaceCommands.resendInvite(actor, first.invite.id, { clientIdempotencyKey: "resend" });
      const [a, b] = await Promise.all([resend(), resend()]);
      expect(a.invite.id).toBe(b.invite.id);
      expect(a.invite.id).not.toBe(first.invite.id);
      expect([a.token, b.token].filter(Boolean)).toHaveLength(1);
      const pending = await prisma.workspaceInvite.findMany({ where: { workspaceId: current.workspace.id, email, revokedAt: null } });
      expect(pending.map((row) => row.id)).toEqual([a.invite.id]);
    })));

    test("simultaneous Workspace creation with one key creates one pending Business Workspace", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const suffix = randomUUID();
      const user = await prisma.user.create({ data: { clerkId: `creator-${suffix}` } });
      userIds.push(user.id);
      const personal = await prisma.workspace.create({ data: {
        name: "Personal", ownerUserId: user.id, personalOwnerUserId: user.id,
        members: { create: { userId: user.id, role: "owner" } },
        billingAccount: { create: {} },
      } });
      workspaceIds.push(personal.id);
      const name = `Studio ${suffix}`;
      const create = () => workspaceCommands.createBusinessWorkspace(user.id, { name }, { clientIdempotencyKey: "create-key" });
      const outcomes = await Promise.all([create(), create(), create()]);

      expect(new Set(outcomes.map((outcome) => outcome.workspaceId)).size).toBe(1);
      expect(outcomes.filter((outcome) => !outcome.replayed)).toHaveLength(1);
      const created = await prisma.workspace.findMany({ where: { name, ownerUserId: user.id } });
      expect(created).toHaveLength(1);
      workspaceIds.push(created[0]?.id as string);
      expect(created[0]).toMatchObject({ status: "pending_payment", pricingTier: "free" });
      expect(await prisma.workspaceMember.count({ where: { workspaceId: created[0]?.id, userId: user.id, role: "owner" } })).toBe(1);
      // A fresh key while the first Workspace is still unpaid resumes it: a user has at
      // most one pending Business Workspace (abandoned checkouts never pile up).
      const second = await workspaceCommands.createBusinessWorkspace(user.id, { name }, { clientIdempotencyKey: "another-key" });
      expect(second.workspaceId).toBe(outcomes[0]?.workspaceId);
      expect(await prisma.workspace.count({ where: { id: { in: workspaceIds }, status: "pending_payment" } })).toBe(1);
    })));
  });
});
