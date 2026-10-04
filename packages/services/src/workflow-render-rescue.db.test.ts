import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";

const databaseUrl = process.env.WORKFLOW_TEST_DATABASE_URL;
const databaseSchema = process.env.WORKFLOW_TEST_DATABASE_SCHEMA;
const dbDescribe = process.env.ALLOW_WORKFLOW_DB_TESTS === "1" && databaseUrl ? describe : describe.skip;
setDefaultTimeout(180_000);

dbDescribe("Workflow render rescue PostgreSQL invariants", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  const fixturePrefix = "render-rescue-db-test:";

  beforeAll(() => {
    if (!databaseUrl || !databaseSchema?.startsWith("workflow_lifecycle_test_") ||
      !/^workflow_lifecycle_test_[a-z0-9_]+$/.test(databaseSchema)) {
      throw new Error("Render rescue tests require a disposable workflow schema");
    }
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    prisma = new PrismaClient({
      adapter: new PrismaPg(pool, { schema: databaseSchema }),
      transactionOptions: { maxWait: 120_000, timeout: 120_000 },
    });
  });

  beforeEach(async () => {
    await prisma.workspace.deleteMany({ where: { owner: { clerkId: { startsWith: fixturePrefix } } } });
    await prisma.user.deleteMany({ where: { clerkId: { startsWith: fixturePrefix } } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function fixture() {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { clerkId: `${fixturePrefix}${suffix}` } });
    const workspace = await prisma.workspace.create({ data: { name: "Render rescue", ownerUserId: user.id } });
    const project = await prisma.project.create({ data: {
      workspaceId: workspace.id, createdByUserId: user.id, title: "Rescue pending renders",
      sourceMediaUrl: "r2://test/source.mp4", ingestStatus: "ready",
    } });
    const detection = await prisma.workflowRun.create({ data: {
      projectId: project.id, stage: "moment_detection", status: "completed", idempotencyKey: randomUUID(),
    } });
    const clip = await prisma.clip.create({ data: {
      projectId: project.id, workflowRunId: detection.id, index: 0, startSec: 0, endSec: 10,
      hookText: "Rescue clip", reasoning: "Test", category: "hook", transcriptSlice: [],
      viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50,
      durationOptimalityScore: 50, tiktokScore: 50, youtubeScore: 50, instagramScore: 50,
      llmProvider: "test", llmModel: "test",
    } });
    const render = await prisma.clipRender.create({ data: { clipId: clip.id, aspectRatio: "ratio_9_16", status: "pending" } });
    const clipExport = await prisma.clipExport.create({ data: {
      projectId: project.id, workspaceId: workspace.id, createdByUserId: user.id, clipId: clip.id,
      editorRevision: 0, fingerprint: randomUUID(), resolution: "1080p", watermark: false, status: "queued",
    } });
    return { project, render, clipExport };
  }

  function lifecycle() { return new WorkflowRunLifecycle({ prisma, leaseOwner: randomUUID() }); }

  // Pause the actual transaction adapter after candidate discovery. The
  // competing mutation uses PostgreSQL; the rescue must re-read its facts.
  function pausedRescue() {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const adapter = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === "$transaction") return async (operation: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
          enter();
          await resume;
          return target.$transaction(operation);
        };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { module: new WorkflowRunLifecycle({ prisma: adapter }), entered, release };
  }

  test("rescues usable work and atomically links only pending exports with its queued event", async () => {
    const f = await fixture();
    const ready = await prisma.clipExport.create({ data: {
      ...f.clipExport, id: randomUUID(), fingerprint: randomUUID(), status: "ready",
    } });
    const module = lifecycle();
    const runId = await module.rescuePendingClipRenderingRun();
    expect(runId).toBeTruthy();
    const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId! } });
    const events = await prisma.workflowEvent.findMany({ where: { workflowRunId: runId! } });
    expect(run).toMatchObject({ projectId: f.project.id, stage: "clip_rendering", status: "queued" });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ workflowRunId: runId, stage: "clip_rendering", status: "queued" });
    expect((await prisma.clipExport.findUniqueOrThrow({ where: { id: f.clipExport.id } })).workflowRunId).toBe(runId);
    expect((await prisma.clipExport.findUniqueOrThrow({ where: { id: ready.id } })).workflowRunId).toBeNull();
    const attempt = await module.claim("clip_rendering");
    if (!attempt) throw new Error("Rescued run must be claimable");
    expect((await module.beginRenderWorkSet(attempt)).variantIds).toEqual([f.render.id]);
  });

  test("competing rescuers admit one run and event", async () => {
    const f = await fixture();
    const results = await Promise.all([lifecycle().rescuePendingClipRenderingRun(), lifecycle().rescuePendingClipRenderingRun()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await prisma.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(1);
    expect(await prisma.workflowEvent.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(1);
  });

  test("an ordinary admission winning the Project lock prevents rescue and export relinking", async () => {
    const f = await fixture();
    const paused = pausedRescue();
    const rescue = paused.module.rescuePendingClipRenderingRun();
    await paused.entered;
    try {
      await lifecycle().admit({ projectId: f.project.id, stage: "clip_rendering", idempotencyKey: "ordinary-admission" });
    } finally { paused.release(); }
    expect(await rescue).toBeNull();
    expect(await prisma.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(1);
    expect((await prisma.clipExport.findUniqueOrThrow({ where: { id: f.clipExport.id } })).workflowRunId).toBeNull();
  });

  test("expired or purging Projects and pending work already bound to terminal runs are not rescued", async () => {
    const f = await fixture();
    await prisma.project.update({ where: { id: f.project.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    expect(await lifecycle().rescuePendingClipRenderingRun()).toBeNull();
    await prisma.project.update({ where: { id: f.project.id }, data: { expiresAt: null, purgeStartedAt: new Date() } });
    expect(await lifecycle().rescuePendingClipRenderingRun()).toBeNull();
    await prisma.project.update({ where: { id: f.project.id }, data: { purgeStartedAt: null } });
    const terminal = await prisma.workflowRun.create({ data: { projectId: f.project.id, stage: "clip_rendering", status: "failed", idempotencyKey: randomUUID() } });
    await prisma.clipRender.update({ where: { id: f.render.id }, data: { workflowRunId: terminal.id } });
    expect(await lifecycle().rescuePendingClipRenderingRun()).toBeNull();
    expect(await prisma.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(1);
  });

  test("rescues no work after the discovered candidate settles before its transaction", async () => {
    const f = await fixture();
    const paused = pausedRescue();
    const rescue = paused.module.rescuePendingClipRenderingRun();
    await paused.entered;
    try { await prisma.clipRender.update({ where: { id: f.render.id }, data: { status: "completed" } }); }
    finally { paused.release(); }
    expect(await rescue).toBeNull();
    expect(await prisma.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(0);
  });

  test("rechecks Project availability after candidate discovery", async () => {
    const f = await fixture();
    const paused = pausedRescue();
    const rescue = paused.module.rescuePendingClipRenderingRun();
    await paused.entered;
    try { await prisma.project.update({ where: { id: f.project.id }, data: { purgeStartedAt: new Date() } }); }
    finally { paused.release(); }
    expect(await rescue).toBeNull();
    expect(await prisma.workflowEvent.count({ where: { projectId: f.project.id } })).toBe(0);
  });

  test("an export linkage failure rolls back admission, event and sequence allocation", async () => {
    const f = await fixture();
    const schema = databaseSchema!;
    await prisma.$executeRawUnsafe(`CREATE FUNCTION "${schema}".reject_rescue_export_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rescue export link rejected'; END; $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_rescue_export_link BEFORE UPDATE ON "${schema}"."ClipExport" FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_rescue_export_link()`);
    try {
      await expect(lifecycle().rescuePendingClipRenderingRun()).rejects.toThrow("rescue export link rejected");
      expect(await prisma.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(0);
      expect(await prisma.workflowEvent.count({ where: { projectId: f.project.id } })).toBe(0);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: f.project.id } })).workflowEventSeq).toBe(0);
      expect((await prisma.clipExport.findUniqueOrThrow({ where: { id: f.clipExport.id } })).workflowRunId).toBeNull();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER reject_rescue_export_link ON "${schema}"."ClipExport"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION "${schema}".reject_rescue_export_link()`);
    }
  });
});
