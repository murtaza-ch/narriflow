import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import {
  createBillingCatalog,
  createPrismaWorkspaceBillingStore,
  createWorkspaceBillingModule,
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
        subscriptions: [
          {
            id: "sub_projection",
            status: "active",
            items: [{ priceId: "price_pro_monthly", quantity: 1 }],
            createdAt: new Date("2026-08-28T09:00:00.000Z"),
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
  });
});
