import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { IngestJobClaimLost, projectService } from "./project.service";

const url = process.env.WORKFLOW_TEST_DATABASE_URL;
const schema = process.env.WORKFLOW_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_WORKFLOW_DB_TESTS === "1" && Boolean(url);
const dbDescribe = enabled ? describe : describe.skip;

dbDescribe("Ingest Job lifecycle PostgreSQL ownership", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  const globalPrisma = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
  let previous: PrismaClient | undefined;

  beforeAll(() => {
    pool = new Pool({ connectionString: url, max: 2 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, schema ? { schema } : undefined) });
    previous = globalPrisma.narriflowPrismaClient;
    globalPrisma.narriflowPrismaClient = prisma;
  });
  afterAll(async () => { globalPrisma.narriflowPrismaClient = previous; await prisma.$disconnect(); await pool.end(); });

  test("a re-claimed job rejects a stale worker completion without changing its Project", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { clerkId: `ingest-db-test:${suffix}`, primaryEmail: `ingest-${suffix}@example.test` } });
    const workspace = await prisma.workspace.create({ data: { name: "Ingest lifecycle", ownerUserId: user.id, personalOwnerUserId: user.id, members: { create: { userId: user.id, role: "owner" } } } });
    const project = await prisma.project.create({ data: { title: "Ingest", sourceMediaUrl: "r2://pending", userId: user.id, workspaceId: workspace.id, createdByUserId: user.id, ingestStatus: "queued" } });
    const job = await prisma.ingestJob.create({ data: { projectId: project.id, jobType: "link_import", payload: {} } });
    const claimed = await projectService.claimNextIngestJob();
    expect(claimed?.id).toBe(job.id);
    await prisma.ingestJob.update({ where: { id: job.id }, data: { claimId: randomUUID() } });
    await expect(projectService.completeIngestJob(job.id, claimed!.claimId, { sourceStorageKey: "projects/test.mp4" })).rejects.toBeInstanceOf(IngestJobClaimLost);
    const unchanged = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(unchanged.ingestStatus).toBe("queued");
  });
});
