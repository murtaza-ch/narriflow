import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { AutopilotService } from "./autopilot.service";

const describeDb =
  process.env.ALLOW_VIZARD_EXPANSION_DB_TESTS === "1" ? describe : describe.skip;

describeDb("Autopilot database concurrency and recovery", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const prismaGlobal = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
  const suffix = randomUUID();
  let userId = "";
  let workspaceId = "";
  let ruleId = "";

  beforeAll(async () => {
    const databaseUrl = process.env.VIZARD_EXPANSION_TEST_DATABASE_URL;
    const schema = process.env.VIZARD_EXPANSION_TEST_DATABASE_SCHEMA;
    if (!databaseUrl || !schema) throw new Error("Disposable Autopilot test schema is required");
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    priorPrisma = prismaGlobal.narriflowPrismaClient;
    prismaGlobal.narriflowPrismaClient = prisma;
    const user = await prisma.user.create({
      data: { clerkId: `rss-db-test-${suffix}` },
    });
    userId = user.id;
    const workspace = await prisma.workspace.create({
      data: {
        name: "RSS integration test",
        ownerUserId: user.id,
        personalOwnerUserId: user.id,
      },
    });
    workspaceId = workspace.id;
    const rule = await prisma.autopilotRule.create({
      data: {
        userId,
        workspaceId,
        name: "DB concurrency",
        rssUrl: "https://feeds.example.test/show.xml",
        contentPack: {},
        initializedAt: new Date(),
        nextRunAt: new Date(),
      },
    });
    ruleId = rule.id;
  });

  afterAll(async () => {
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    if (prisma && userId) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await prisma?.$disconnect();
    await pool?.end();
  });

  test("concurrent admission creates exactly one project for a rule episode", async () => {
    if (!prisma) throw new Error("DATABASE_URL is required");
    const episodeId = `episode-${suffix}`;
    const sourceInput = `rss-db-test:${suffix}`;

    async function admit() {
      return prisma!.$transaction(async (tx) => {
        await tx.autopilotEpisode.create({ data: { ruleId, episodeId } });
        const project = await tx.project.create({
          data: {
            userId,
            workspaceId,
            title: "Concurrent episode",
            sourceMediaUrl: "https://cdn.example.test/episode.mp3",
            sourceType: "rss",
            sourceInput,
            ingestStatus: "queued",
          },
        });
        await tx.ingestJob.create({
          data: {
            projectId: project.id,
            jobType: "rss_import",
            payload: { episodeId },
          },
        });
        await tx.autopilotEpisode.update({
          where: { ruleId_episodeId: { ruleId, episodeId } },
          data: { projectId: project.id },
        });
        return project.id;
      });
    }

    const attempts = await Promise.allSettled([admit(), admit()]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(
      await prisma.project.count({ where: { workspaceId, sourceInput } }),
    ).toBe(1);
    const admitted = await prisma.autopilotEpisode.findUnique({
      where: { ruleId_episodeId: { ruleId, episodeId } },
    });
    expect(admitted?.projectId).toBeTruthy();
  });

  test("reclaims an expired running lease without touching a live lease", async () => {
    if (!prisma) throw new Error("DATABASE_URL is required");
    const expired = await prisma.autopilotRule.create({
      data: {
        userId,
        workspaceId,
        name: "Expired lease",
        rssUrl: "https://feeds.example.test/expired.xml",
        contentPack: {},
        status: "running",
        claimToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    const live = await prisma.autopilotRule.create({
      data: {
        userId,
        workspaceId,
        name: "Live lease",
        rssUrl: "https://feeds.example.test/live.xml",
        contentPack: {},
        status: "running",
        claimToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    expect(await new AutopilotService().reapStalledRules()).toBe(1);
    const [expiredAfter, liveAfter] = await Promise.all([
      prisma.autopilotRule.findUniqueOrThrow({ where: { id: expired.id } }),
      prisma.autopilotRule.findUniqueOrThrow({ where: { id: live.id } }),
    ]);
    expect(expiredAfter.status).toBe("active");
    expect(expiredAfter.leaseExpiresAt).toBeNull();
    expect(expiredAfter.claimToken).toBeNull();
    expect(liveAfter.status).toBe("running");
    expect(liveAfter.claimToken).toBe(live.claimToken);
  });
});
