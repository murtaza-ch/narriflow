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
import { PrismaClient, type PricingTier } from "@prisma/client";
import { Pool } from "pg";
import {
  contentPackSchema,
  parseStoredContentPack,
  PROCESSING_CAPACITY_DEFAULTS,
} from "@narriflow/validators";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { IngestJobLifecycle } from "./ingest-job-lifecycle";
import { ProcessingUsage, ProcessingUsageError } from "./processing-usage";
import { projectService } from "./project.service";
import {
  createUploadSessionModule,
  defaultUploadSessionConfig,
  prismaUploadSessionPersistence,
  type UploadSessionStorage,
} from "./upload-session.service";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";

const url = process.env.PROCESSING_USAGE_TEST_DATABASE_URL;
const schema = process.env.PROCESSING_USAGE_TEST_DATABASE_SCHEMA;
const enabled =
  process.env.ALLOW_PROCESSING_USAGE_DB_TESTS === "1" && Boolean(url);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);

const CONTENT_PACK = {
  outputTypes: ["short_clip"],
  clipGenerationMode: "best",
  clipCountTarget: 10,
  clipDurationSecTarget: 45,
  minDurationSec: 15,
  preferredMinDurationSec: 30,
  preferredMaxDurationSec: 60,
  maxDurationSec: 90,
  platformTargets: ["tiktok", "youtube_shorts", "instagram_reels"],
  toneConstraints: ["concise", "conversational"],
  captionPreset: "brand_default",
  platformPlaybookVersion: "2026-07-01",
  mode: "clip",
  autoHook: true,
  specificMoments: "",
  processingStartSec: null,
  processingEndSec: null,
  clipLengthPreset: "auto",
  defaultAspectRatio: "9:16",
} as const;
const STORED_PACK = parseStoredContentPack(contentPackSchema.parse(CONTENT_PACK));

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExpectedDomainFailureError) return error;
    throw error;
  }
  throw new Error("expected a typed refusal");
}

dbDescribe("Processing Usage PostgreSQL interface", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const prismaGlobal = globalThis as unknown as {
    narriflowPrismaClient?: PrismaClient;
  };
  let clock = new Date();

  beforeAll(() => {
    if (!schema?.startsWith("processing_usage_test_"))
      throw new Error("Processing Usage tests require a disposable schema");
    pool = new Pool({ connectionString: url, max: 24 });
    prisma = new PrismaClient({
      adapter: new PrismaPg(pool, { schema }),
      transactionOptions: { maxWait: 60_000, timeout: 60_000 },
    });
    priorPrisma = prismaGlobal.narriflowPrismaClient;
    prismaGlobal.narriflowPrismaClient = prisma;
  });
  afterAll(async () => {
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    await prisma.$disconnect();
    await pool.end();
  });

  function usage(capacity: Partial<Record<PricingTier, number>> = {}) {
    return new ProcessingUsage({
      prisma,
      capacityLimits: { ...PROCESSING_CAPACITY_DEFAULTS, ...capacity },
      now: () => clock,
      log: () => {},
    });
  }
  async function workspace(tier: PricingTier = "free") {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { clerkId: `usage-db:${suffix}`, primaryEmail: `usage-${suffix}@example.test` },
    });
    const created = await prisma.workspace.create({
      data: {
        name: "Processing usage",
        ownerUserId: user.id,
        pricingTier: tier,
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    return {
      user,
      workspace: created,
      scope: { actorUserId: user.id, workspaceId: created.id },
    };
  }
  function reserve(
    module: ProcessingUsage,
    workspaceId: string,
    input: { declaredSeconds?: number | null; projectId?: string } = {},
  ) {
    return prisma.$transaction((tx) =>
      module.reserve(tx, {
        workspaceId,
        projectId: input.projectId ?? randomUUID(),
        actorUserId: null,
        intakeKind: "link",
        declaredSeconds: input.declaredSeconds,
      }),
    );
  }
  async function measuredProject(
    workspaceId: string,
    seconds: number,
    input: { id?: string; ingestStatus?: "ready" | "queued" } = {},
  ) {
    return prisma.project.create({
      data: {
        id: input.id ?? randomUUID(),
        title: "Measured",
        workspaceId,
        sourceMediaUrl: "r2://test/source.mp4",
        sourceType: "link",
        sourceDurationSeconds: input.ingestStatus === "queued" ? null : seconds,
        ingestStatus: input.ingestStatus ?? "ready",
      },
    });
  }
  /** Another intake's reservation, written directly so it bypasses admission. */
  function filler(workspaceId: string, seconds: number, at = clock) {
    return prisma.processingUsageReservation.create({
      data: {
        projectId: randomUUID(),
        workspaceId,
        intakeKind: "link",
        periodStart: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
        reservedSeconds: seconds,
      },
    });
  }
  function settle(module: ProcessingUsage, projectId: string) {
    return prisma.$transaction((tx) => module.settle(tx, projectId));
  }
  function row(projectId: string) {
    return prisma.processingUsageReservation.findUniqueOrThrow({
      where: { projectId },
    });
  }

  test("the sweep releases stranded reservations and never releases intakes awaiting handoff", async () => {
    clock = new Date();
    const { workspace: ws, user } = await workspace("business");
    const module = usage();
    const failed = await measuredProject(ws.id, 60, { ingestStatus: "queued" });
    await prisma.ingestJob.create({ data: { projectId: failed.id, jobType: "link_import", payload: {}, status: "failed" } });
    const awaiting = await measuredProject(ws.id, 60);
    await prisma.ingestJob.create({
      data: { projectId: awaiting.id, jobType: "link_import", payload: {}, status: "completed", completedAt: clock },
    });
    await prisma.contentPack.create({ data: { projectId: awaiting.id, ...STORED_PACK, draft: true } });
    const running = await measuredProject(ws.id, 60, { ingestStatus: "queued" });
    await prisma.ingestJob.create({
      data: {
        projectId: running.id, jobType: "link_import", payload: {}, status: "running",
        claimId: randomUUID(), claimExpiresAt: new Date(clock.getTime() + 60 * 60_000),
      },
    });
    const vanished = randomUUID();
    const sessionFor = async (status: "expired" | "uploading") => {
      const projectId = randomUUID();
      await prisma.uploadSession.create({
        data: {
          workspaceId: ws.id, actorUserId: user.id, clientIdempotencyKey: randomUUID(),
          immutableInputFingerprint: "sweep", preallocatedProjectId: projectId, title: "Sweep",
          fileName: "sweep.mp4", fileSizeBytes: 10n, contentType: "video/mp4", browserFingerprint: "sweep",
          generationSettings: {}, transferKind: "single", storageKey: `workspaces/${ws.id}/${projectId}.mp4`,
          status, expiresAt: clock, hardExpiresAt: clock,
        },
      });
      return projectId;
    };
    const expired = await sessionFor("expired");
    const uploading = await sessionFor("uploading");
    for (const projectId of [failed.id, awaiting.id, running.id, vanished, expired, uploading])
      await reserve(module, ws.id, { projectId, declaredSeconds: 60 });

    // A crash between reserve and settle stays reserved until it's past the grace period.
    expect(await module.reconcileStranded()).toBe(0);
    clock = new Date(clock.getTime() + 11 * 60_000);
    expect(await module.reconcileStranded()).toBe(3);
    expect((await row(failed.id)).reason).toBe("reconciled_ingest_terminal");
    expect((await row(vanished)).reason).toBe("reconciled_intake_missing");
    expect((await row(expired)).reason).toBe("reconciled_upload_session_terminal");
    for (const kept of [awaiting.id, running.id, uploading])
      expect((await row(kept)).state).toBe("reserved");
    expect(await module.reconcileStranded()).toBe(0);
  });

  test("sizes reservations from declared facts, the per-video cap, and the remaining allowance", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("free");
    const module = usage({ free: 10 });
    expect((await reserve(module, ws.id, { declaredSeconds: 599.2 })).reservedSeconds).toBe(600);
    const tooLong = await refusal(reserve(module, ws.id, { declaredSeconds: 31 * 60 }));
    expect(tooLong).toMatchObject({ code: "upload_too_long", kind: "unprocessable", details: { maxSeconds: 1800 } });
    await filler(ws.id, 1500);
    const over = await refusal(reserve(module, ws.id, { declaredSeconds: 26 * 60 }));
    expect(over).toMatchObject({
      code: "processing_quota_exhausted",
      kind: "payment_required",
      details: { remainingMinutes: 25, requestedMinutes: 26, limitMinutes: 60 },
    });
    expect((await reserve(module, ws.id, { declaredSeconds: 25 * 60 })).reservedSeconds).toBe(1500);
    expect((await refusal(reserve(module, ws.id))).code).toBe("processing_quota_exhausted");

    const fresh = (await workspace("free")).workspace;
    // Unknown duration reserves the authorized upper bound.
    expect((await reserve(module, fresh.id)).reservedSeconds).toBe(1800);
    expect(await module.summarize(fresh.id)).toMatchObject({
      usedMinutes: 0,
      reservedMinutes: 30,
      remainingMinutes: 30,
      inFlight: 1,
      inFlightLimit: 10,
      maxUploadSeconds: 1800,
    });
  });

  test("a repeated admission for the same Project returns the original reservation", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("creator");
    const module = usage();
    const projectId = randomUUID();
    const first = await reserve(module, ws.id, { projectId, declaredSeconds: 600 });
    const before = await module.summarize(ws.id);
    const replay = await reserve(module, ws.id, { projectId, declaredSeconds: 1200 });
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, reservedSeconds: 600 });
    expect(await module.summarize(ws.id)).toEqual(before);
  });

  test("parallel admissions near the limit admit exactly what fits", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("free");
    const module = usage({ free: 100 });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => reserve(module, ws.id, { declaredSeconds: 300 })),
    );
    const admitted = results.filter((result) => result.status === "fulfilled");
    const refused = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    expect(admitted).toHaveLength(12);
    expect(refused).toHaveLength(8);
    for (const error of refused) {
      expect(error).toBeInstanceOf(ProcessingUsageError);
      expect(error.code).toBe("processing_quota_exhausted");
    }
    const total = await prisma.processingUsageReservation.aggregate({
      where: { workspaceId: ws.id, state: "reserved" },
      _sum: { reservedSeconds: true },
    });
    expect(total._sum.reservedSeconds).toBe(3600);
    expect((await module.summarize(ws.id)).remainingMinutes).toBe(0);
  });

  test("parallel admissions admit exactly the Processing Capacity, with retry guidance", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("pro");
    const module = usage({ pro: 3 });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => reserve(module, ws.id, { declaredSeconds: 60 })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    for (const result of results) {
      if (result.status === "fulfilled") continue;
      expect(result.reason).toMatchObject({
        code: "workspace_processing_capacity_reached",
        kind: "rate_limited",
        retryAfterSeconds: 60,
        details: { inFlight: 3, inFlightLimit: 3 },
      });
    }
  });

  test("capacity counts active runs and accepted export renders, and frees at terminal states", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("pro");
    const module = usage({ pro: 1 });
    const busy = await measuredProject(ws.id, 60);
    const run = await prisma.workflowRun.create({
      data: { projectId: busy.id, idempotencyKey: randomUUID(), stage: "dubbing", status: "running" },
    });
    expect((await refusal(reserve(module, ws.id))).code).toBe(
      "workspace_processing_capacity_reached",
    );
    await prisma.workflowRun.update({ where: { id: run.id }, data: { status: "completed" } });
    const clip = await prisma.clip.create({
      data: {
        projectId: busy.id, workflowRunId: run.id, index: 0, startSec: 0, endSec: 10,
        hookText: "Hook", reasoning: "Reason", category: "hook", transcriptSlice: [],
        viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50,
        durationOptimalityScore: 50, tiktokScore: 50, youtubeScore: 50, instagramScore: 50,
        llmProvider: "test", llmModel: "test",
      },
    });
    const render = await prisma.clipRender.create({
      data: { clipId: clip.id, aspectRatio: "ratio_9_16", status: "pending" },
    });
    expect((await module.summarize(ws.id)).inFlight).toBe(1);
    expect((await refusal(reserve(module, ws.id))).code).toBe(
      "workspace_processing_capacity_reached",
    );
    await prisma.clipRender.update({ where: { id: render.id }, data: { status: "completed" } });
    expect((await reserve(module, ws.id, { declaredSeconds: 60 })).state).toBe("reserved");
  });

  test("an ingested intake awaiting setup keeps its minutes but frees capacity", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("pro");
    const module = usage({ pro: 1 });
    const awaiting = await measuredProject(ws.id, 600, { ingestStatus: "queued" });
    await reserve(module, ws.id, { projectId: awaiting.id, declaredSeconds: 600 });
    expect((await refusal(reserve(module, ws.id))).code).toBe("workspace_processing_capacity_reached");
    await prisma.project.update({
      where: { id: awaiting.id },
      data: { ingestStatus: "ready", sourceDurationSeconds: 600 },
    });
    expect(await module.summarize(ws.id)).toMatchObject({ inFlight: 0, reservedMinutes: 10 });
    expect((await reserve(module, ws.id, { declaredSeconds: 60 })).state).toBe("reserved");
  });

  test("settlement admits a measured intake that predates the ledger", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("free");
    const module = usage();
    const legacy = await measuredProject(ws.id, 600);
    expect(await settle(module, legacy.id)).toEqual({ outcome: "settled", charged: true, settledSeconds: 600 });
    expect((await row(legacy.id)).periodStart.getTime()).toBe(
      Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), 1),
    );
    const tooLong = await measuredProject(ws.id, 31 * 60);
    const refused = await settle(module, tooLong.id);
    expect(refused.outcome === "refused" && refused.failure.code).toBe("upload_too_long");
    expect(await prisma.processingUsageReservation.count({ where: { projectId: tooLong.id } })).toBe(0);
  });

  test("resize shrinks, grows from the remaining allowance, or refuses without changing the row", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("free");
    const module = usage({ free: 10 });
    const projectId = randomUUID();
    await reserve(module, ws.id, { projectId });
    expect((await module.resize({ projectId, seconds: 600 })).reservedSeconds).toBe(600);
    expect((await module.summarize(ws.id)).remainingMinutes).toBe(50);
    expect((await module.resize({ projectId, seconds: 1200 })).reservedSeconds).toBe(1200);
    expect((await refusal(module.resize({ projectId, seconds: 1801 }))).code).toBe("upload_too_long");
    await filler(ws.id, 2100);
    // 3600 - 1200 - 2100 leaves 300 seconds to grow into.
    const exhausted = await refusal(module.resize({ projectId, seconds: 1501 }));
    expect(exhausted).toMatchObject({
      code: "processing_quota_exhausted",
      details: { remainingMinutes: 25, requestedMinutes: 26 },
    });
    expect((await row(projectId)).reservedSeconds).toBe(1200);
    expect((await module.resize({ projectId, seconds: 1500 })).reservedSeconds).toBe(1500);
  });

  test("settlement charges the probed duration once, at the boundary, and refuses what can't fit", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("free");
    const module = usage({ free: 10 });

    const shorter = await measuredProject(ws.id, 500);
    await reserve(module, ws.id, { projectId: shorter.id, declaredSeconds: 600 });
    expect(await settle(module, shorter.id)).toEqual({ outcome: "settled", charged: true, settledSeconds: 500 });
    expect(await settle(module, shorter.id)).toEqual({ outcome: "settled", charged: false, settledSeconds: 500 });

    const longer = await measuredProject(ws.id, 700);
    await reserve(module, ws.id, { projectId: longer.id, declaredSeconds: 600 });
    expect((await settle(module, longer.id)).outcome).toBe("settled");

    // 3600 - 500 - 700 = 2400 remain. Reserve 600 and leave exactly 1000 more.
    const boundary = await measuredProject(ws.id, 1600);
    await reserve(module, ws.id, { projectId: boundary.id, declaredSeconds: 600 });
    await reserve(module, ws.id, { declaredSeconds: 800 });
    expect(await settle(module, boundary.id)).toMatchObject({ outcome: "settled", settledSeconds: 1600 });
    expect(await module.summarize(ws.id)).toMatchObject({ usedMinutes: 47, reservedMinutes: 14, remainingMinutes: 0 });

    const refused = await measuredProject(ws.id, 61);
    await prisma.processingUsageReservation.create({
      data: {
        projectId: refused.id,
        workspaceId: ws.id,
        intakeKind: "link",
        periodStart: new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), 1)),
        reservedSeconds: 60,
      },
    });
    const outcome = await settle(module, refused.id);
    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome === "refused")
      expect(outcome.failure.code).toBe("processing_quota_exhausted");
    expect(await row(refused.id)).toMatchObject({ state: "released", reason: "processing_quota_exhausted" });

    const pending = await measuredProject(ws.id, 60, { ingestStatus: "queued" });
    await prisma.processingUsageReservation.update({
      where: { projectId: refused.id },
      data: { projectId: pending.id, state: "reserved", reason: null },
    });
    expect(await settle(module, pending.id)).toEqual({ outcome: "not_ready" });
    expect((await row(pending.id)).state).toBe("reserved");
  });

  test("a downgrade or restriction refuses settlement and releases the reservation", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("pro");
    const module = usage();
    const long = await measuredProject(ws.id, 2 * 60 * 60);
    await reserve(module, ws.id, { projectId: long.id, declaredSeconds: 2 * 60 * 60 });
    await prisma.workspace.update({ where: { id: ws.id }, data: { pricingTier: "free" } });
    const downgraded = await settle(module, long.id);
    expect(downgraded.outcome === "refused" && downgraded.failure.code).toBe("upload_too_long");
    expect((await row(long.id)).state).toBe("released");

    await prisma.workspace.update({ where: { id: ws.id }, data: { pricingTier: "pro" } });
    const restricted = await measuredProject(ws.id, 60);
    await reserve(module, ws.id, { projectId: restricted.id, declaredSeconds: 60 });
    await prisma.workspace.update({ where: { id: ws.id }, data: { status: "restricted" } });
    const refused = await settle(module, restricted.id);
    expect(refused.outcome === "refused" && refused.failure.code).toBe("project_access_denied");
    expect((await row(restricted.id)).state).toBe("released");
  });

  test("no speech-to-text Workflow Run exists without settled usage", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("creator");
    const module = usage();
    const project = await measuredProject(ws.id, 120);
    await reserve(module, ws.id, { projectId: project.id, declaredSeconds: 120 });
    const workflow = new WorkflowRunLifecycle({ prisma });
    const admit = () =>
      workflow.admitTranscript({
        projectId: project.id,
        idempotencyKey: randomUUID(),
        contentPack: STORED_PACK,
        transcriptProvider: "assemblyai",
        transcriptProviderModel: "test",
      });
    await expect(admit()).rejects.toThrow("processing_usage_not_settled");
    expect(await prisma.workflowRun.count({ where: { projectId: project.id } })).toBe(0);
    await settle(module, project.id);
    expect((await admit()).created).toBe(true);
    const unsettled = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count" FROM "WorkflowRun" run
      LEFT JOIN "ProcessingUsageReservation" usage ON usage."projectId" = run."projectId"
      WHERE run."stage" = 'stt' AND (usage."state" IS NULL OR usage."state" NOT IN ('settled', 'refunded'))
    `;
    expect(unsettled[0]?.count).toBe(0);
  });

  test("usage stays in its admission month and an upgrade raises the allowance at once", async () => {
    const { workspace: ws } = await workspace("free");
    const module = usage();
    const project = await measuredProject(ws.id, 600);
    clock = new Date("2026-01-31T23:59:59.000Z");
    await reserve(module, ws.id, { projectId: project.id, declaredSeconds: 600 });
    clock = new Date("2026-02-01T00:00:05.000Z");
    expect((await settle(module, project.id)).outcome).toBe("settled");
    expect((await row(project.id)).periodStart.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(await module.summarize(ws.id)).toMatchObject({ usedMinutes: 0, remainingMinutes: 60 });
    clock = new Date("2026-01-15T00:00:00.000Z");
    expect(await module.summarize(ws.id)).toMatchObject({ usedMinutes: 10, remainingMinutes: 50 });

    clock = new Date("2026-02-10T00:00:00.000Z");
    await filler(ws.id, 3600);
    expect((await refusal(reserve(module, ws.id))).code).toBe("processing_quota_exhausted");
    await prisma.workspace.update({ where: { id: ws.id }, data: { pricingTier: "creator" } });
    expect((await reserve(module, ws.id)).reservedSeconds).toBe(90 * 60);
    expect(await module.summarize(ws.id)).toMatchObject({
      tier: "creator",
      limitMinutes: 600,
      maxUploadSeconds: 90 * 60,
      inFlightLimit: 5,
    });
    for (const [tier, limitMinutes] of [["pro", 1800], ["business", 1800]] as const) {
      await prisma.workspace.update({ where: { id: ws.id }, data: { pricingTier: tier } });
      expect((await module.summarize(ws.id)).limitMinutes).toBe(limitMinutes);
    }
  });

  test("settled usage survives Project deletion and actor removal; refunds are audited", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("creator");
    const module = usage();
    const actor = await prisma.user.create({ data: { clerkId: `usage-actor:${randomUUID()}` } });
    const project = await measuredProject(ws.id, 600);
    await prisma.$transaction((tx) =>
      module.reserve(tx, {
        workspaceId: ws.id,
        projectId: project.id,
        actorUserId: actor.id,
        intakeKind: "upload",
        declaredSeconds: 600,
      }),
    );
    await settle(module, project.id);
    const before = await module.summarize(ws.id);
    await prisma.project.delete({ where: { id: project.id } });
    await prisma.user.delete({ where: { id: actor.id } });
    expect(await module.summarize(ws.id)).toEqual(before);
    expect(await row(project.id)).toMatchObject({ state: "settled", actorUserId: null, settledSeconds: 600 });
    expect(
      await prisma.$transaction((tx) => module.release(tx, { projectId: project.id, reason: "late" })),
    ).toBe(false);

    const operator = randomUUID();
    const refunded = await module.refund({ projectId: project.id, actorUserId: operator, reason: "duplicate charge" });
    expect(refunded.state).toBe("refunded");
    expect(await row(project.id)).toMatchObject({ refundedByUserId: operator, reason: "duplicate charge" });
    expect((await module.summarize(ws.id)).usedMinutes).toBe(0);
    const reserved = await reserve(module, ws.id, { declaredSeconds: 60 });
    expect(
      (await refusal(module.refund({ projectId: reserved.projectId, actorUserId: operator, reason: "no" }))).code,
    ).toBe("processing_usage_not_refundable");
  });

  test("manual retry re-admits a released reservation with fresh checks", async () => {
    clock = new Date();
    const { workspace: ws, user } = await workspace("free");
    const module = usage();
    const ingest = new IngestJobLifecycle({
      prisma,
      workflow: new WorkflowRunLifecycle({ prisma }),
      usage: module,
      requireRetryActor: async () => {},
    });
    const project = await measuredProject(ws.id, 1200, { ingestStatus: "queued" });
    await prisma.project.update({ where: { id: project.id }, data: { ingestStatus: "failed", sourceDurationSeconds: 1200 } });
    await prisma.ingestJob.create({ data: { projectId: project.id, jobType: "rss_import", payload: {}, status: "failed" } });
    await reserve(module, ws.id, { projectId: project.id, declaredSeconds: 1200 });
    await prisma.$transaction((tx) => module.release(tx, { projectId: project.id, reason: "ingest_failed" }));
    await prisma.processingUsageReservation.update({
      where: { projectId: project.id },
      data: { periodStart: new Date("2025-12-01T00:00:00.000Z") },
    });
    const blocker = await filler(ws.id, 3000);
    const retry = () => ingest.retry({ projectId: project.id, workspaceId: ws.id, actorUserId: user.id });
    expect((await refusal(retry())).code).toBe("processing_quota_exhausted");
    expect(await prisma.ingestJob.count({ where: { projectId: project.id } })).toBe(1);
    expect((await row(project.id)).state).toBe("released");

    await prisma.$transaction((tx) => module.release(tx, { projectId: blocker.projectId, reason: "test" }));
    await retry();
    expect(await row(project.id)).toMatchObject({
      state: "reserved",
      reservedSeconds: 1200,
      intakeKind: "rss",
      actorUserId: user.id,
    });
    expect((await row(project.id)).periodStart.getTime()).toBeGreaterThan(new Date("2026-01-01").getTime());
  });

  test("link and RSS intake reserve in their acceptance transactions", async () => {
    clock = new Date();
    const { workspace: ws, scope } = await workspace("free");
    const link = await projectService.queueLinkIngest(scope, {
      url: "https://www.dropbox.com/s/abc/video.mp4",
      commitToken: randomUUID(),
    });
    expect(await row(link.project.id)).toMatchObject({ state: "reserved", intakeKind: "link", reservedSeconds: 1800 });

    const rss = await projectService.importResolvedRssEpisodes(scope, {
      rssUrl: "https://example.test/feed.xml",
      episodes: [
        { id: "a", title: "A", enclosureUrl: "https://example.test/a.mp3", durationSeconds: 20 * 60 },
        { id: "b", title: "B", enclosureUrl: "https://example.test/b.mp3", durationSeconds: 20 * 60 },
      ],
    });
    // 30 minutes remain: one episode fits, the other is reported, not admitted.
    expect(rss.count).toBe(1);
    expect(rss.notAdmitted).toEqual([{ episodeId: "b", code: "processing_quota_exhausted" }]);
    await expect(
      projectService.queueLinkIngest(scope, { url: "https://www.dropbox.com/s/def/video.mp4", commitToken: randomUUID() }),
    ).rejects.toBeInstanceOf(ProcessingUsageError);
    expect(await prisma.project.count({ where: { workspaceId: ws.id } })).toBe(2);

    await projectService.deleteProject(scope, link.project.id);
    expect(await row(link.project.id)).toMatchObject({ state: "released", reason: "project_deleted" });
  });

  test("generation admission settles once and commits a refusal on the failed Project", async () => {
    clock = new Date();
    const { workspace: ws, scope } = await workspace("free");
    const ready = async (seconds: number, reservedSeconds: number) => {
      const project = await measuredProject(ws.id, seconds);
      await prisma.ingestJob.create({
        data: { projectId: project.id, jobType: "link_import", payload: {}, status: "completed", completedAt: clock },
      });
      await prisma.processingUsageReservation.create({
        data: {
          projectId: project.id, workspaceId: ws.id, intakeKind: "link",
          periodStart: new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), 1)),
          reservedSeconds,
        },
      });
      return project;
    };
    const request = {
      contentPack: contentPackSchema.parse(CONTENT_PACK),
      forceRegenerate: false,
      languageCode: null,
    };
    const fits = await ready(600, 600);
    const first = await projectService.triggerGeneration(scope, fits.id, request, randomUUID());
    const again = await projectService.triggerGeneration(scope, fits.id, request, randomUUID());
    expect(again.workflowRunId).toBe(first.workflowRunId);
    expect(await row(fits.id)).toMatchObject({ state: "settled", settledSeconds: 600 });

    // Another intake holds 2400 seconds, so 600 remain: a 25-minute source
    // can't settle against its 5-minute reservation.
    await filler(ws.id, 2400);
    const tooLong = await ready(1500, 300);
    const browser = await refusal(projectService.triggerGeneration(scope, tooLong.id, request, randomUUID()));
    expect(browser.code).toBe("processing_quota_exhausted");
    expect(await prisma.project.findUniqueOrThrow({ where: { id: tooLong.id } })).toMatchObject({
      ingestStatus: "failed",
      ingestErrorCode: "processing_quota_exhausted",
    });
    expect((await row(tooLong.id)).state).toBe("released");
    expect(
      await prisma.ingestJob.findFirstOrThrow({ where: { projectId: tooLong.id } }),
    ).toMatchObject({ status: "failed" });
    expect(await prisma.workflowRun.count({ where: { projectId: tooLong.id } })).toBe(0);

    const mcp = await ready(1500, 300);
    const viaMcp = await refusal(
      projectService.triggerGeneration(scope, mcp.id, request, randomUUID(), {
        mutation: { clientIdempotencyKey: randomUUID() },
      }),
    );
    expect(viaMcp.code).toBe("processing_quota_exhausted");
    const replayKey = randomUUID();
    const replay = await refusal(
      projectService.triggerGeneration(scope, mcp.id, request, randomUUID(), {
        mutation: { clientIdempotencyKey: replayKey },
      }),
    );
    expect(replay).toMatchObject({ code: "processing_quota_exhausted", kind: "payment_required" });
    expect((await row(mcp.id)).state).toBe("released");
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: mcp.id } })).ingestErrorCode,
    ).toBe("processing_quota_exhausted");
  });

  test("Upload Session open reserves declared minutes and terminal compensation releases them", async () => {
    clock = new Date();
    const { workspace: ws, user } = await workspace("free");
    const storage: UploadSessionStorage = {
      async grantSinglePut() { return { url: "https://upload.invalid/direct" }; },
      async createMultipart() { throw new Error("unused"); },
      async grantMultipartParts() { throw new Error("unused"); },
      async completeMultipart() { throw new Error("unused"); },
      async listMultipartParts() { throw new Error("unused"); },
      async headExactObject() { return { sizeBytes: 100, contentType: "video/mp4" }; },
      async headExactObjectIfExists() { return null; },
      async listExactKeyMultipartUploads() { return []; },
      async abortMultipart() {},
      async deleteExactObject() {},
    };
    const module = createUploadSessionModule({
      config: defaultUploadSessionConfig(),
      persistence: prismaUploadSessionPersistence,
      storage,
      admission: { async resolveBrand() { return null; } },
      now: () => new Date(),
      createId: randomUUID,
    });
    const open = (declaredDurationSeconds: number) =>
      module.open({
        actorUserId: user.id,
        workspaceId: ws.id,
        clientIdempotencyKey: randomUUID(),
        title: "Declared",
        source: { fileName: "declared.mp4", sizeBytes: 100, contentType: "video/mp4", browserFingerprint: randomUUID() },
        brandTemplateId: null,
        brandProfileId: null,
        generation: { languageCode: "en", contentPack: CONTENT_PACK },
        declaredDurationSeconds,
      });
    const refused = await refusal(open(31 * 60));
    expect(refused.code).toBe("upload_too_long");
    expect(
      await prisma.uploadSession.findFirstOrThrow({ where: { workspaceId: ws.id } }),
    ).toMatchObject({ status: "failed", failureCode: "upload_too_long" });
    expect(await prisma.processingUsageReservation.count({ where: { workspaceId: ws.id } })).toBe(0);

    const opened = await open(600);
    expect(await row(opened.projectId)).toMatchObject({ state: "reserved", reservedSeconds: 600, intakeKind: "upload" });
    expect(await module.discard({ actorUserId: user.id, workspaceId: ws.id, sessionId: opened.sessionId })).toMatchObject({
      outcome: "discarded",
    });
    expect(await row(opened.projectId)).toMatchObject({ state: "released", reason: "user_discarded" });
  });
});
