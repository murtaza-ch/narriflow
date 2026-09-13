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

  test("an expired unreaped claim cannot renew, report progress, fail, or complete", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { clerkId: `ingest-db-test:${suffix}`, primaryEmail: `ingest-${suffix}@example.test` } });
    const workspace = await prisma.workspace.create({ data: { name: "Ingest expiry", ownerUserId: user.id, personalOwnerUserId: user.id, members: { create: { userId: user.id, role: "owner" } } } });
    const project = await prisma.project.create({ data: { title: "Expired", sourceMediaUrl: "r2://pending", userId: user.id, workspaceId: workspace.id, createdByUserId: user.id, ingestStatus: "queued" } });
    await prisma.ingestJob.create({ data: { projectId: project.id, jobType: "link_import", payload: {} } });
    const claimed = await projectService.claimNextIngestJob();
    await prisma.ingestJob.update({ where: { id: claimed!.id }, data: { claimExpiresAt: new Date(Date.now() - 1_000) } });
    await expect(projectService.renewIngestJobClaim(claimed!.id, claimed!.claimId)).rejects.toBeInstanceOf(IngestJobClaimLost);
    await expect(projectService.markIngestJobDownloading(claimed!.id, claimed!.claimId)).rejects.toBeInstanceOf(IngestJobClaimLost);
    await expect(projectService.failIngestJob(claimed!.id, claimed!.claimId, "worker_unhandled_error", "expired")).rejects.toBeInstanceOf(IngestJobClaimLost);
    await expect(projectService.completeIngestJob(claimed!.id, claimed!.claimId, { sourceStorageKey: "projects/test.mp4" })).rejects.toBeInstanceOf(IngestJobClaimLost);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).ingestStatus).toBe("queued");
  });

  test("unavailable YouTube leaves YouTube jobs queued while other intake claims", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { clerkId: `ingest-db-test:${suffix}`, primaryEmail: `ingest-${suffix}@example.test` } });
    const workspace = await prisma.workspace.create({ data: { name: "Ingest availability", ownerUserId: user.id, personalOwnerUserId: user.id, members: { create: { userId: user.id, role: "owner" } } } });
    const makeJob = async (jobType: "youtube_import" | "link_import" | "upload_finalize" | "rss_import", payload: object) => {
      const project = await prisma.project.create({ data: { title: jobType, sourceMediaUrl: "r2://pending", userId: user.id, workspaceId: workspace.id, createdByUserId: user.id, ingestStatus: "queued" } });
      return prisma.ingestJob.create({ data: { projectId: project.id, jobType, payload } });
    };
    const youtubeLegacy = await makeJob("youtube_import", { youtubeUrl: "https://youtube.test/a" });
    const youtubeLink = await makeJob("link_import", { provider: "youtube", url: "https://youtube.test/b" });
    const upload = await makeJob("upload_finalize", {});
    const rss = await makeJob("rss_import", {});
    const direct = await makeJob("link_import", { provider: "dropbox", url: "https://dropbox.test/c" });
    const claimed = [
      await projectService.claimNextIngestJob({ youtubeAvailable: false }),
      await projectService.claimNextIngestJob({ youtubeAvailable: false }),
      await projectService.claimNextIngestJob({ youtubeAvailable: false }),
    ];
    expect(new Set(claimed.map((job) => job?.id))).toEqual(new Set([upload.id, rss.id, direct.id]));
    const untouched = await prisma.ingestJob.findMany({ where: { id: { in: [youtubeLegacy.id, youtubeLink.id] } }, select: { status: true, attemptCount: true } });
    expect(untouched).toEqual([{ status: "queued", attemptCount: 0 }, { status: "queued", attemptCount: 0 }]);
  });

  test("deferred draft handoffs cannot pin a later durable generation handoff", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { clerkId: `ingest-db-test:${suffix}`, primaryEmail: `ingest-${suffix}@example.test` } });
    const workspace = await prisma.workspace.create({ data: { name: "Ingest handoff fairness", ownerUserId: user.id, personalOwnerUserId: user.id, members: { create: { userId: user.id, role: "owner" } } } });
    for (let index = 0; index < 25; index++) {
      const project = await prisma.project.create({ data: { title: `Draft ${index}`, sourceMediaUrl: "r2://pending", userId: user.id, workspaceId: workspace.id, createdByUserId: user.id, ingestStatus: "ready" } });
      await prisma.ingestJob.create({ data: { projectId: project.id, jobType: "link_import", payload: {}, status: "completed", createdAt: new Date(1_000 + index), completedAt: new Date(1_000 + index) } });
    }
    const readyProject = await prisma.project.create({ data: { title: "Admitted", sourceMediaUrl: "r2://ready", userId: user.id, workspaceId: workspace.id, createdByUserId: user.id, ingestStatus: "ready" } });
    const readyJob = await prisma.ingestJob.create({ data: { projectId: readyProject.id, jobType: "link_import", payload: {}, status: "completed", createdAt: new Date(10_000), completedAt: new Date(10_000) } });
    await prisma.workflowRun.create({ data: { projectId: readyProject.id, stage: "stt", status: "queued", idempotencyKey: `handoff:${suffix}` } });
    await projectService.processPendingIngestGenerationHandoffs(25);
    await projectService.processPendingIngestGenerationHandoffs(25);
    expect((await prisma.ingestJob.findUniqueOrThrow({ where: { id: readyJob.id } })).generationHandoffAt).not.toBeNull();
  });

  test("due handoff retries stay ahead of newly completed ingests", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { clerkId: `ingest-fair-${suffix}`, primaryEmail: `${suffix}@example.test` } });
    const workspace = await prisma.workspace.create({ data: { name: "Fair retry", ownerUserId: user.id, members: { create: { userId: user.id, role: "owner" } } } });
    const makeProject = () => prisma.project.create({ data: { title: "Fair handoff", sourceMediaUrl: "r2://ready", userId: user.id, workspaceId: workspace.id, ingestStatus: "ready" } });
    const retry = await makeProject();
    const retryJob = await prisma.ingestJob.create({ data: { projectId: retry.id, jobType: "link_import", payload: {}, status: "completed", completedAt: new Date(Date.now() - 120_000), generationHandoffRetryAt: new Date(Date.now() - 60_000) } });
    await prisma.workflowRun.create({ data: { projectId: retry.id, stage: "stt", status: "queued", idempotencyKey: suffix } });
    for (let i = 0; i < 26; i++) {
      const project = await makeProject();
      await prisma.ingestJob.create({ data: { projectId: project.id, jobType: "link_import", payload: {}, status: "completed", completedAt: new Date() } });
    }
    await projectService.processPendingIngestGenerationHandoffs(25);
    expect((await prisma.ingestJob.findUniqueOrThrow({ where: { id: retryJob.id } })).generationHandoffAt).not.toBeNull();
  });

  test("a transient handoff failure retries durably without another generation run", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { clerkId: `ingest-db-test:${suffix}`, primaryEmail: `ingest-${suffix}@example.test` } });
    const workspace = await prisma.workspace.create({ data: { name: "Ingest handoff retry", ownerUserId: user.id, personalOwnerUserId: user.id, members: { create: { userId: user.id, role: "owner" } } } });
    const project = await prisma.project.create({ data: { title: "Retry", sourceMediaUrl: "r2://ready", userId: user.id, workspaceId: workspace.id, createdByUserId: user.id, ingestStatus: "ready" } });
    const job = await prisma.ingestJob.create({ data: { projectId: project.id, jobType: "link_import", payload: {}, status: "completed", completedAt: new Date() } });
    await prisma.workflowRun.create({ data: { projectId: project.id, stage: "stt", status: "queued", idempotencyKey: `handoff-retry:${suffix}` } });
    const original = projectService.triggerGenerationIfPending.bind(projectService);
    let calls = 0;
    (projectService as unknown as { triggerGenerationIfPending: (projectId: string) => Promise<boolean> }).triggerGenerationIfPending = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return original(project.id);
    };
    try {
      await projectService.processPendingIngestGenerationHandoffs(1, job.id);
      await prisma.ingestJob.update({ where: { id: job.id }, data: { generationHandoffRetryAt: new Date(Date.now() - 1) } });
      await projectService.processPendingIngestGenerationHandoffs(1, job.id);
    } finally {
      (projectService as unknown as { triggerGenerationIfPending: typeof original }).triggerGenerationIfPending = original;
    }
    expect(calls).toBe(2);
    expect((await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).generationHandoffAt).not.toBeNull();
    expect(await prisma.workflowRun.count({ where: { projectId: project.id } })).toBe(1);
  });
});
