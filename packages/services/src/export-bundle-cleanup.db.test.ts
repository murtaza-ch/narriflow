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
  adoptExportBundlePublication,
  admitExportBundleCleanup,
  planExportBundleCleanup,
} from "./export-bundle-cleanup";
import { prismaMediaCleanupStore } from "./media-cleanup";

const databaseUrl = process.env.VIZARD_EXPANSION_TEST_DATABASE_URL;
const databaseSchema = process.env.VIZARD_EXPANSION_TEST_DATABASE_SCHEMA;
const enabled =
  process.env.ALLOW_VIZARD_EXPANSION_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);

dbDescribe("Export Bundle cleanup PostgreSQL contract", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const prismaGlobal = globalThis as unknown as {
    narriflowPrismaClient?: PrismaClient;
  };

  beforeAll(() => {
    if (!databaseUrl) throw new Error("Vizard expansion test database is required");
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    prisma = new PrismaClient({
      adapter: new PrismaPg(
        pool,
        databaseSchema ? { schema: databaseSchema } : undefined,
      ),
    });
    priorPrisma = prismaGlobal.narriflowPrismaClient;
    prismaGlobal.narriflowPrismaClient = prisma;
  });

  afterAll(async () => {
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

  test("adopts only the published key with its bundle reference and recovers a crashed attempt", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        clerkId: `export-cleanup-${suffix}`,
        primaryEmail: `export-cleanup-${suffix}@example.test`,
      },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: "Export cleanup",
        ownerUserId: user.id,
        pricingTier: "business",
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    const project = await prisma.project.create({
      data: {
        title: "Export cleanup fixture",
        sourceMediaUrl: "https://media.example.test/source.mp4",
        sourceStorageKey: `fixtures/${suffix}/source.mp4`,
        userId: user.id,
        workspaceId: workspace.id,
        createdByUserId: user.id,
        ingestStatus: "ready",
      },
    });
    const workflowRun = await prisma.workflowRun.create({
      data: {
        projectId: project.id,
        idempotencyKey: `export-cleanup:${suffix}`,
        stage: "export_bundle",
        status: "running",
        lifecycleVersion: 2,
      },
    });
    const operation = await prisma.campaignOperation.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        actorUserId: user.id,
        action: "export_bundle",
        idempotencyKey: randomUUID(),
        requestFingerprint: "a".repeat(64),
        validatedOptions: {},
        pricingTier: "business",
        requestedCount: 1,
        workflowRunId: workflowRun.id,
      },
    });
    const bundle = await prisma.exportBundle.create({
      data: {
        operationId: operation.id,
        workflowRunId: workflowRun.id,
        status: "building",
        manifest: { schemaVersion: 1, included: [], excluded: [] },
      },
    });
    const attemptId = randomUUID();
    const admittedAt = new Date();
    const plan = planExportBundleCleanup(
      project.id,
      operation.id,
      attemptId,
      admittedAt,
    );
    await prisma.$transaction(async (tx) => {
      await admitExportBundleCleanup(tx.mediaCleanupObligation, plan);
      await tx.workflowRun.update({
        where: { id: workflowRun.id },
        data: {
          attemptId,
          leaseOwner: "export-cleanup-test",
          leaseExpiresAt: plan.claimExpiresAt,
        },
      });
    });

    const admitted = await prisma.mediaCleanupObligation.findMany({
      where: {
        origin: "export_bundle_attempt",
        objectKey: {
          in: plan.obligations.map((obligation) => obligation.objectKey),
        },
      },
      orderBy: { cleanupClass: "asc" },
    });
    expect(admitted).toHaveLength(2);
    expect(admitted.every((row) => row.claimId === attemptId)).toBe(true);
    expect(admitted.every((row) => row.completedAt === null)).toBe(true);

    await expect(
      prisma.$transaction(async (tx) => {
        await adoptExportBundlePublication(tx.mediaCleanupObligation, plan, new Date());
        await tx.exportBundle.update({
          where: { id: bundle.id },
          data: { storageKey: plan.obligations[1].objectKey, status: "completed" },
        });
        throw new Error("injected_settlement_rollback");
      }),
    ).rejects.toThrow("injected_settlement_rollback");
    expect(
      await prisma.exportBundle.findUniqueOrThrow({ where: { id: bundle.id } }),
    ).toMatchObject({ storageKey: null, status: "building" });
    expect(
      await prisma.mediaCleanupObligation.findUniqueOrThrow({
        where: { id: admitted.find((row) => row.cleanupClass.includes("unsettled"))!.id },
      }),
    ).toMatchObject({ completedAt: null, failureCode: null });

    await prisma.$transaction(async (tx) => {
      await adoptExportBundlePublication(tx.mediaCleanupObligation, plan, new Date());
      await tx.exportBundle.update({
        where: { id: bundle.id },
        data: {
          storageKey: plan.obligations[1].objectKey,
          status: "completed",
          completedAt: new Date(),
        },
      });
    });
    const publication = await prisma.mediaCleanupObligation.findFirstOrThrow({
      where: {
        origin: "export_bundle_attempt",
        cleanupClass: "export_bundle_unsettled_publication",
        objectKey: plan.obligations[1].objectKey,
      },
    });
    expect(publication).toMatchObject({
      completedAt: expect.any(Date),
      failureCode: "export_bundle_published",
      claimId: null,
    });

    const crashedAttempt = await prisma.mediaCleanupObligation.findFirstOrThrow({
      where: {
        origin: "export_bundle_attempt",
        cleanupClass: "export_bundle_attempt",
        objectKey: plan.obligations[0].objectKey,
      },
    });
    const crashRecoveryAt = new Date(
      Math.max(
        crashedAttempt.claimExpiresAt?.getTime() ?? 0,
        crashedAttempt.nextAttemptAt.getTime(),
      ) + 1,
    );
    const claimed = await prismaMediaCleanupStore.claimDue({
      now: crashRecoveryAt,
      limit: 100,
      leaseMs: 60_000,
      createId: randomUUID,
    });
    expect(
      claimed.find((row) => row.objectKey === plan.obligations[0].objectKey),
    ).toMatchObject({
      origin: "export_bundle_attempt",
      cleanupClass: "export_bundle_attempt",
    });
    expect(
      claimed.some((row) => row.objectKey === plan.obligations[1].objectKey),
    ).toBe(false);
  });
});
