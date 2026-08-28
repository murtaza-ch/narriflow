import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import {
  createBillingCatalog,
  createPrismaWorkspaceBillingStore,
  createWorkspaceBillingModule,
  WorkspaceBillingAttemptLost,
  type WorkspaceBillingProvider,
} from "./workspace-billing.service";

const databaseUrl = process.env.WORKSPACE_BILLING_TEST_DATABASE_URL;
const databaseSchema = process.env.WORKSPACE_BILLING_TEST_DATABASE_SCHEMA;
const enabled =
  process.env.ALLOW_WORKSPACE_BILLING_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);

const catalog = createBillingCatalog({
  basePrices: [
    { priceId: "price_creator_monthly", tier: "creator", interval: "monthly" },
    { priceId: "price_creator_annual", tier: "creator", interval: "annual" },
    { priceId: "price_pro_monthly", tier: "pro", interval: "monthly" },
    { priceId: "price_pro_annual", tier: "pro", interval: "annual" },
    { priceId: "price_business_monthly", tier: "business", interval: "monthly" },
    { priceId: "price_business_annual", tier: "business", interval: "annual" },
  ],
  seatPrices: [
    { priceId: "price_seat_monthly", interval: "monthly" },
    { priceId: "price_seat_annual", interval: "annual" },
  ],
  worker: {
    batchSize: 25,
    concurrency: 4,
    leaseMs: 60_000,
    providerDeadlineMs: 10_000,
    providerCallBudget: 4,
  },
});

dbDescribe("Workspace Billing PostgreSQL invariants", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const prismaGlobal = globalThis as unknown as {
    narriflowPrismaClient?: PrismaClient;
  };

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("Workspace Billing test database is required");
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    prisma = new PrismaClient({
      adapter: new PrismaPg(
        pool,
        databaseSchema ? { schema: databaseSchema } : undefined,
      ),
      transactionOptions: { maxWait: 120_000, timeout: 120_000 },
    });
    priorPrisma = prismaGlobal.narriflowPrismaClient;
    prismaGlobal.narriflowPrismaClient = prisma;
    process.env.PROJECT_RETENTION_MODE = "enforce";
    process.env.PROJECT_RETENTION_ENFORCEMENT_STARTED_AT =
      "2026-01-01T00:00:00.000Z";
  });

  afterAll(async () => {
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function createWorkspace(label: string) {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        clerkId: `billing-db-${label}-${suffix}`,
        primaryEmail: `billing-${label}-${suffix}@example.test`,
      },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: `Billing ${label}`,
        ownerUserId: user.id,
        personalOwnerUserId: user.id,
        members: { create: { userId: user.id, role: "owner" } },
        billingAccount: { create: {} },
      },
      include: { billingAccount: true },
    });
    return { user, workspace };
  }

  test("enforces one account per Workspace and unique provider bindings", async () => {
    const first = await createWorkspace("unique-first");
    const second = await createWorkspace("unique-second");
    await expect(
      Promise.resolve(
        prisma.workspaceBillingAccount.create({
          data: { workspaceId: first.workspace.id },
        }),
      ),
    ).rejects.toMatchObject({ code: "P2002" });

    await prisma.workspaceBillingAccount.update({
      where: { workspaceId: first.workspace.id },
      data: { providerCustomerId: "cus_unique" },
    });
    await expect(
      Promise.resolve(
        prisma.workspaceBillingAccount.update({
          where: { workspaceId: second.workspace.id },
          data: { providerCustomerId: "cus_unique" },
        }),
      ),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  test("concurrent Checkout starts settle on one durable attempt and provider identity", async () => {
    const { user, workspace } = await createWorkspace("checkout-race");
    const providerCustomers = new Map<string, string>();
    const providerSessions = new Map<
      string,
      {
        sessionId: string;
        url: string;
        expiresAt: Date;
        status: "open";
        paymentStatus: string;
        workspaceId: string;
        attemptId: string;
      }
    >();
    const provider: WorkspaceBillingProvider = {
      verifyDelivery: () => {
        throw new Error("not used");
      },
      retrieveCurrentState: async () => {
        throw new Error("not used");
      },
      findCustomersByWorkspace: async () => [],
      createCustomer: async (input, key) => {
        const customerId = providerCustomers.get(key) ?? `cus_${input.workspaceId}`;
        providerCustomers.set(key, customerId);
        return { customerId };
      },
      findCheckoutSessionsByAttempt: async ({ attemptId }) =>
        providerSessions.has(attemptId) ? [providerSessions.get(attemptId)!] : [],
      createCheckoutSession: async (input, key) => {
        const session = providerSessions.get(input.attemptId) ?? {
          sessionId: `cs_${key}`,
          url: "https://checkout.stripe.test/race",
          expiresAt: new Date("2026-08-28T11:00:00.000Z"),
          status: "open" as const,
          paymentStatus: "unpaid",
          workspaceId: input.workspaceId,
          attemptId: input.attemptId,
        };
        providerSessions.set(input.attemptId, session);
        return session;
      },
      retrieveCheckoutSession: async (sessionId) =>
        [...providerSessions.values()].find(
          (session) => session.sessionId === sessionId,
        )!,
    };
    const billing = createWorkspaceBillingModule({
      catalog,
      store: createPrismaWorkspaceBillingStore(),
      provider,
      clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
      diagnostics: { record: () => undefined },
    });
    const input = {
      workspaceId: workspace.id,
      actorUserId: user.id,
      clientIdempotencyKey: randomUUID(),
      targetTier: "pro" as const,
      interval: "monthly" as const,
      returnDestination: "https://app.test/settings/billing",
    };

    const [first, second] = await Promise.all([
      billing.startCheckout(input),
      billing.startCheckout(input),
    ]);

    expect(second).toEqual(first);
    expect(
      await prisma.workspaceCheckoutAttempt.count({
        where: { billingAccount: { workspaceId: workspace.id } },
      }),
    ).toBe(1);
    expect(providerCustomers.size).toBe(1);
    expect(providerSessions.size).toBe(1);

    const retry = await billing.startCheckout({
      ...input,
      clientIdempotencyKey: randomUUID(),
    });
    expect(retry.kind).toBe("checkout");
    expect(
      await prisma.workspaceCheckoutAttempt.count({
        where: { billingAccount: { workspaceId: workspace.id } },
      }),
    ).toBe(2);
    expect(providerCustomers.size).toBe(1);
    expect(providerSessions.size).toBe(2);
  });

  test("accepts one delivery and wakes its account atomically under concurrency", async () => {
    const { workspace } = await createWorkspace("delivery");
    await prisma.workspaceBillingAccount.update({
      where: { workspaceId: workspace.id },
      data: {
        providerCustomerId: "cus_delivery",
        nextReconcileAt: new Date("2027-01-01T00:00:00.000Z"),
      },
    });
    const now = new Date("2026-08-28T10:00:00.000Z");
    const provider: WorkspaceBillingProvider = {
      verifyDelivery: () => ({
        eventId: "evt_delivery_once",
        eventType: "customer.subscription.updated",
        providerCreatedAt: new Date("2026-08-28T09:59:00.000Z"),
        liveMode: false,
        apiVersion: "2026-08-27.basil",
        customerId: "cus_delivery",
        subscriptionId: "sub_delivery",
        checkoutSessionId: null,
        workspaceHint: workspace.id,
      }),
      retrieveCurrentState: async () => {
        throw new Error("not used");
      },
    };
    const billing = createWorkspaceBillingModule({
      catalog,
      store: createPrismaWorkspaceBillingStore(),
      provider,
      clock: { now: () => now },
      diagnostics: { record: () => undefined },
    });

    const results = await Promise.all([
      billing.acceptStripeDelivery("body", "signature"),
      billing.acceptStripeDelivery("body", "signature"),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual([
      "accepted",
      "duplicate",
    ]);
    expect(
      await prisma.webhookDeliveryLog.count({
        where: { provider: "stripe", eventId: "evt_delivery_once" },
      }),
    ).toBe(1);
    const account = await prisma.workspaceBillingAccount.findUniqueOrThrow({
      where: { workspaceId: workspace.id },
    });
    expect(account.nextReconcileAt).toEqual(now);
  });

  test("settles projection, retention, and audit atomically and replayably", async () => {
    const { user, workspace } = await createWorkspace("projection");
    await prisma.workspaceBillingAccount.update({
      where: { workspaceId: workspace.id },
      data: { providerCustomerId: "cus_projection" },
    });
    const projectionAccount =
      await prisma.workspaceBillingAccount.findUniqueOrThrow({
        where: { workspaceId: workspace.id },
      });
    const acceptedDelivery = await prisma.webhookDeliveryLog.create({
      data: {
        provider: "stripe",
        eventId: `evt_projection_${randomUUID()}`,
        eventType: "invoice.paid",
        status: "accepted",
        workspaceBillingAccountId: projectionAccount.id,
      },
    });
    const deadline = new Date("2026-09-10T00:00:00.000Z");
    const project = await prisma.project.create({
      data: {
        title: "Retention rescue",
        sourceMediaUrl: "https://example.test/source.mp4",
        userId: user.id,
        workspaceId: workspace.id,
        retentionPolicyKey: "free_project_v1",
        expiresAt: deadline,
      },
    });
    const now = new Date("2026-08-28T10:00:00.000Z");
    const provider: WorkspaceBillingProvider = {
      verifyDelivery: () => {
        throw new Error("not used");
      },
      retrieveCurrentState: async () => ({
        customerId: "cus_projection",
        ownership: { kind: "verified", workspaceId: workspace.id },
        subscriptions: [
          {
            id: "sub_projection",
            status: "active",
            items: [{ priceId: "price_pro_monthly", quantity: 1 }],
            createdAt: new Date("2026-08-28T09:00:00.000Z"),
            effectiveAt: new Date("2026-08-28T09:00:00.000Z"),
            currentPeriodEnd: new Date("2026-09-28T09:00:00.000Z"),
            trialEnd: null,
            cancelAtPeriodEnd: false,
          },
        ],
      }),
    };
    const billing = createWorkspaceBillingModule({
      catalog,
      store: createPrismaWorkspaceBillingStore(),
      provider,
      clock: { now: () => now },
      diagnostics: { record: () => undefined },
    });

    await billing.reconcileCurrentState(workspace.id);
    await billing.reconcileCurrentState(workspace.id);

    expect(
      await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } }),
    ).toMatchObject({ pricingTier: "pro", status: "active" });
    expect(
      await prisma.project.findUniqueOrThrow({ where: { id: project.id } }),
    ).toMatchObject({ retentionPolicyKey: null, expiresAt: null });
    expect(
      await prisma.workspaceBillingTransition.count({
        where: { billingAccount: { workspaceId: workspace.id } },
      }),
    ).toBe(1);
    expect(
      await prisma.webhookDeliveryLog.findUniqueOrThrow({
        where: { id: acceptedDelivery.id },
      }),
    ).toMatchObject({ status: "reconciled", processedAt: now });
  });

  test("claims competing workers without duplication and drains beyond three batches", async () => {
    await prisma.workspaceBillingAccount.updateMany({
      data: {
        nextReconcileAt: new Date("2027-01-01T00:00:00.000Z"),
        reconcileAttemptId: null,
        leaseExpiresAt: null,
      },
    });
    const workspaces = await Promise.all(
      Array.from({ length: 31 }, (_, index) => createWorkspace(`fair-${index}`)),
    );
    const now = new Date("2026-08-28T10:00:00.000Z");
    await prisma.workspaceBillingAccount.updateMany({
      where: { workspaceId: { in: workspaces.map(({ workspace }) => workspace.id) } },
      data: { nextReconcileAt: now },
    });
    const stores = Array.from({ length: 4 }, () =>
      createPrismaWorkspaceBillingStore(),
    );
    const batches = await Promise.all(
      stores.map((store) =>
        store.claimDueAccounts({ now, limit: 10, leaseMs: 60_000 }),
      ),
    );
    const workspaceIds = batches.flat().map((claim) => claim.workspaceId);

    expect(workspaceIds).toHaveLength(31);
    expect(new Set(workspaceIds).size).toBe(31);
  });

  test("expired claims are taken over and stale retry or commit settlement is fenced", async () => {
    const { workspace } = await createWorkspace("takeover");
    await prisma.workspaceBillingAccount.update({
      where: { workspaceId: workspace.id },
      data: {
        providerCustomerId: "cus_takeover",
        nextReconcileAt: new Date("2026-08-28T10:00:00.000Z"),
      },
    });
    const store = createPrismaWorkspaceBillingStore();
    const claimedAt = new Date("2026-08-28T10:00:00.000Z");
    const [first] = await store.claimDueAccounts({
      now: claimedAt,
      limit: 1,
      leaseMs: 60_000,
    });
    expect(first).toBeDefined();
    expect(
      await store.claimDueAccounts({
        now: new Date(claimedAt.getTime() + 59_999),
        limit: 1,
        leaseMs: 60_000,
      }),
    ).toHaveLength(0);
    const takeoverAt = new Date(claimedAt.getTime() + 60_001);
    const [takeover] = await store.claimDueAccounts({
      now: takeoverAt,
      limit: 1,
      leaseMs: 60_000,
    });
    expect(takeover?.attemptId).not.toBe(first?.attemptId);

    expect(
      await store.scheduleRetry({
        workspaceId: workspace.id,
        attemptId: first!.attemptId,
        now: takeoverAt,
        nextReconcileAt: new Date(takeoverAt.getTime() + 60_000),
        reason: "stale",
        health: "retrying",
      }),
    ).toBe(false);
    await expect(
      store.commitVerifiedState({
        workspaceId: workspace.id,
        expectedCustomerId: "cus_takeover",
        subscription: {
          id: "sub_takeover",
          status: "active",
          items: [{ priceId: "price_creator_monthly", quantity: 1 }],
          createdAt: claimedAt,
          effectiveAt: claimedAt,
          currentPeriodEnd: new Date("2026-09-28T10:00:00.000Z"),
          trialEnd: null,
          cancelAtPeriodEnd: false,
        },
        tier: "creator",
        interval: "monthly",
        workspaceStatus: "active",
        health: "current",
        attentionReason: null,
        firstPastDueAt: null,
        graceDeadlineAt: null,
        effectiveAt: claimedAt,
        now: takeoverAt,
        attemptId: first!.attemptId,
      }),
    ).rejects.toBeInstanceOf(WorkspaceBillingAttemptLost);
  });

  test("a failed projection transaction rolls back tier, retention, and audit", async () => {
    const first = await createWorkspace("rollback-first");
    const second = await createWorkspace("rollback-second");
    await prisma.workspaceBillingAccount.update({
      where: { workspaceId: first.workspace.id },
      data: { providerCustomerId: "cus_rollback_first" },
    });
    await prisma.workspaceBillingAccount.update({
      where: { workspaceId: second.workspace.id },
      data: {
        providerCustomerId: "cus_rollback_second",
        canonicalSubscriptionId: "sub_unique_collision",
      },
    });
    const deadline = new Date("2026-09-10T00:00:00.000Z");
    const project = await prisma.project.create({
      data: {
        title: "Rollback retention",
        sourceMediaUrl: "https://example.test/rollback.mp4",
        userId: first.user.id,
        workspaceId: first.workspace.id,
        retentionPolicyKey: "free_project_v1",
        expiresAt: deadline,
      },
    });
    const store = createPrismaWorkspaceBillingStore();
    const now = new Date("2026-08-28T10:00:00.000Z");
    const firstAccount = await prisma.workspaceBillingAccount.findUniqueOrThrow({
      where: { workspaceId: first.workspace.id },
    });
    const delivery = await prisma.webhookDeliveryLog.create({
      data: {
        provider: "stripe",
        eventId: `evt_rollback_${randomUUID()}`,
        eventType: "customer.subscription.updated",
        status: "accepted",
        workspaceBillingAccountId: firstAccount.id,
      },
    });

    await expect(
      store.commitVerifiedState({
        workspaceId: first.workspace.id,
        expectedCustomerId: "cus_rollback_first",
        subscription: {
          id: "sub_unique_collision",
          status: "active",
          items: [{ priceId: "price_pro_monthly", quantity: 1 }],
          createdAt: now,
          effectiveAt: now,
          currentPeriodEnd: new Date("2026-09-28T10:00:00.000Z"),
          trialEnd: null,
          cancelAtPeriodEnd: false,
        },
        tier: "pro",
        interval: "monthly",
        workspaceStatus: "active",
        health: "current",
        attentionReason: null,
        firstPastDueAt: null,
        graceDeadlineAt: null,
        effectiveAt: now,
        now,
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    expect(
      await prisma.workspace.findUniqueOrThrow({ where: { id: first.workspace.id } }),
    ).toMatchObject({ pricingTier: "free", status: "active" });
    expect(
      await prisma.project.findUniqueOrThrow({ where: { id: project.id } }),
    ).toMatchObject({ retentionPolicyKey: "free_project_v1", expiresAt: deadline });
    expect(
      await prisma.workspaceBillingTransition.count({
        where: { billingAccount: { workspaceId: first.workspace.id } },
      }),
    ).toBe(0);
    expect(
      await prisma.webhookDeliveryLog.findUniqueOrThrow({
        where: { id: delivery.id },
      }),
    ).toMatchObject({ status: "accepted" });
  });
});
