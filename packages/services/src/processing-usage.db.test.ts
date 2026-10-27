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
  PLAN_CATALOG,
  lowestTier,
  planLimits,
} from "@narriflow/validators";
import { processIngestJob } from "../../../apps/worker/src/tasks/ingest";
import { productionWorkerProcessModule, type WorkerProcessModule } from "../../../apps/worker/src/worker-process";
import { createDriveTokenCipher, createGoogleDriveFileReader, DriveSourceError } from "./drive-source";
import { projectRetentionService } from "./project-retention.service";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { IngestJobLifecycle } from "./ingest-job-lifecycle";
import { ProcessingUsage, ProcessingUsageError } from "./processing-usage";
import { getProcessingUsage } from "./processing-usage-runtime";
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
  let priorEncryptionKey: string | undefined;
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
    priorEncryptionKey = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
    process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = "processing-usage-db-test-key";
  });
  afterAll(async () => {
    if (priorEncryptionKey === undefined) delete process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
    else process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = priorEncryptionKey;
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    await prisma.$disconnect();
    await pool.end();
  });

  function usage() {
    return new ProcessingUsage({
      prisma,
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
  /** A ready intake's reservation holds credits without occupying capacity. */
  async function filler(workspaceId: string, seconds: number, at = clock) {
    const project = await measuredProject(workspaceId, seconds);
    return prisma.processingUsageReservation.create({
      data: {
        projectId: project.id,
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

  async function ingestMeasuredSource(module: ProcessingUsage, projectId: string, durationSec: number) {
    const failures: string[] = [];
    await processIngestJob({
      id: randomUUID(), projectId, jobType: "link_import", claimId: randomUUID(), attemptCount: 1,
      payload: { url: "https://www.dropbox.com/s/test/source.mp4?dl=0" },
    }, {
      usage: module,
      workerProcess: {
        execute: async () => { throw new Error("No subprocess expected"); },
        inspectMedia: async () => ({ durationSec, sourceProbe: { durationSec, video: null, audio: null } }) as Awaited<ReturnType<WorkerProcessModule["inspectMedia"]>>,
        withScratchDirectory: (prefix, work) => productionWorkerProcessModule.withScratchDirectory(prefix, work),
      },
      fetchSource: async () => new Response("source bytes", { headers: { "content-type": "video/mp4" } }),
      putSource: async () => {},
      lifecycle: {
        progress: async () => {}, pinSource: async () => {},
        complete: async (_job, source) => {
          await prisma.project.update({ where: { id: projectId }, data: {
            sourceDurationSeconds: source.sourceDurationSeconds, sourceProbe: source.sourceProbe ?? undefined, ingestStatus: "ready",
          } });
        },
        fail: async (_job, code) => {
          failures.push(code);
          return { outcome: "permanent", terminalErrorCode: code };
        },
      },
    });
    return failures;
  }

  test("runtime capacity summary and admission use the catalog despite environment overrides", async () => {
    clock = new Date();
    const overrides = { PROCESSING_CAPACITY_FREE: "1", PROCESSING_CAPACITY_CREATOR: "1000", PROCESSING_CAPACITY_PRO: "1", PROCESSING_CAPACITY_BUSINESS: "1000" };
    const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    try {
      const module = getProcessingUsage();
      for (const [tier, limit] of [["free", 2], ["creator", 5], ["pro", 10], ["business", 20]] as const) {
        const { workspace: ws } = await workspace(tier);
        const admitted: string[] = [];
        try {
          expect(await module.summarize(ws.id)).toMatchObject({ inFlight: 0, inFlightLimit: limit });
          for (let index = 0; index < limit; index++)
            admitted.push((await reserve(module, ws.id, { declaredSeconds: 1 })).projectId);
          expect(await refusal(reserve(module, ws.id, { declaredSeconds: 1 }))).toMatchObject({
            code: "workspace_processing_capacity_reached", details: { tier, inFlight: limit, inFlightLimit: limit },
          });
        } finally {
          for (const projectId of admitted)
            await prisma.$transaction((tx) => module.release(tx, { projectId, reason: "user_discarded" }));
        }
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("worker ingest charges 60.01 measured seconds as two credits through settlement", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("creator");
    const module = usage();
    const project = await measuredProject(ws.id, 60, { ingestStatus: "queued" });
    await reserve(module, ws.id, { projectId: project.id, declaredSeconds: 60 });
    expect(await ingestMeasuredSource(module, project.id, 60.01)).toEqual([]);
    expect(await module.summarize(ws.id)).toMatchObject({ reservedCredits: 2 });
    expect(await settle(module, project.id)).toEqual({ outcome: "settled", charged: true, settledSeconds: 120 });
    expect(await module.summarize(ws.id)).toMatchObject({ usedCredits: 2, reservedCredits: 0 });
  });

  test("worker ingest refuses a source a fraction above its plan's duration cap", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("creator");
    const module = usage();
    const cap = planLimits("creator").maxSourceSeconds;
    const project = await measuredProject(ws.id, cap, { ingestStatus: "queued" });
    await reserve(module, ws.id, { projectId: project.id, declaredSeconds: cap });
    expect(await ingestMeasuredSource(module, project.id, cap + 0.01)).toEqual(["upload_too_long"]);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ ingestStatus: "queued", sourceDurationSeconds: null });
    expect(await module.summarize(ws.id)).toMatchObject({ usedCredits: 0 });
  });

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

  test("sizes reservations from declared facts, the per-video cap, and the remaining credits", async () => {
    clock = new Date("2026-10-15T12:00:00.000Z");
    const { workspace: ws } = await workspace("free");
    const module = usage();
    expect((await reserve(module, ws.id, { declaredSeconds: 599.2 })).reservedSeconds).toBe(600);
    const tooLong = await refusal(reserve(module, ws.id, { declaredSeconds: 61 * 60 }));
    expect(tooLong).toMatchObject({ code: "upload_too_long", kind: "unprocessable", details: { maxSeconds: 3600 } });
    expect(tooLong.message).toContain("Upgrade for longer videos.");
    await filler(ws.id, 1500);
    const over = await refusal(reserve(module, ws.id, { declaredSeconds: 26 * 60 }));
    expect(over).toMatchObject({
      code: "credits_exhausted",
      kind: "payment_required",
      details: {
        remainingCredits: 25,
        spentCredits: 35,
        requestedCredits: 26,
        limitCredits: 60,
        renewsAt: "2026-11-01T00:00:00.000Z",
      },
    });
    expect(over.message).toContain(", or upgrade for more.");
    // 25 minutes and 0.5 s is 26 started minutes.
    expect((await refusal(reserve(module, ws.id, { declaredSeconds: 25 * 60 + 0.5 }))).code).toBe("credits_exhausted");
    expect((await reserve(module, ws.id, { declaredSeconds: 25 * 60 })).reservedSeconds).toBe(1500);
    expect((await refusal(reserve(module, ws.id))).code).toBe("credits_exhausted");

    // The top plans promise nothing a higher plan cannot deliver.
    const { workspace: top } = await workspace("business");
    const topModule = usage();
    const topTooLong = await refusal(reserve(topModule, top.id, { declaredSeconds: 181 * 60 }));
    expect(topTooLong.message).toContain("Choose a shorter video.");
    expect(topTooLong.message).not.toContain("Upgrade");
    await filler(top.id, 1800 * 60);
    expect((await refusal(reserve(topModule, top.id, { declaredSeconds: 5 * 60 }))).message).not.toContain("upgrade");

    const fresh = (await workspace("free")).workspace;
    // Unknown duration reserves the authorized upper bound.
    expect((await reserve(module, fresh.id)).reservedSeconds).toBe(3600);
    expect(await module.summarize(fresh.id)).toMatchObject({
      usedCredits: 0,
      reservedCredits: 60,
      remainingCredits: 0,
      inFlight: 1,
      inFlightLimit: 2,
      maxUploadSeconds: 3600,
    });
  });

  test("a refusal after a downgrade reports what was actually spent", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("business");
    const module = usage();
    await filler(ws.id, 1000 * 60);
    await prisma.workspace.update({ where: { id: ws.id }, data: { pricingTier: "pro" } });
    // Pro includes 900: remaining clamps to 0, but 1,000 credits are spent and a
    // one-credit import needs 1,001, which only Business (1,800) covers.
    const refused = await refusal(reserve(module, ws.id, { declaredSeconds: 30 }));
    expect(refused).toMatchObject({
      code: "credits_exhausted",
      details: { tier: "pro", limitCredits: 900, remainingCredits: 0, spentCredits: 1000, requestedCredits: 1 },
    });
    expect(refused.message).toContain(", or upgrade for more.");
    // At Business's ceiling no plan covers one more credit.
    await filler(ws.id, 800 * 60);
    const none = await refusal(reserve(module, ws.id, { declaredSeconds: 30 }));
    expect(none).toMatchObject({ details: { spentCredits: 1800 } });
    expect(none.message).not.toContain("upgrade");
  });

  test("every started minute of a source is one whole credit", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("creator");
    const module = usage();
    for (const [declaredSeconds, debit] of [[1, 60], [59.99, 60], [60, 60], [60.01, 120], [30 * 60, 1800]] as const) {
      const project = await measuredProject(ws.id, Math.ceil(declaredSeconds));
      expect([declaredSeconds, (await reserve(module, ws.id, { projectId: project.id, declaredSeconds })).reservedSeconds]).toEqual([declaredSeconds, debit]);
    }
    // A better duration fact resizes to whole credits too.
    const projectId = randomUUID();
    await reserve(module, ws.id, { projectId, declaredSeconds: 600 });
    expect((await module.resize({ projectId, seconds: 60.01 })).reservedSeconds).toBe(120);
    const rows = await prisma.processingUsageReservation.findMany({ where: { workspaceId: ws.id } });
    for (const usageRow of rows) expect(usageRow.reservedSeconds % 60).toBe(0);
  });

  test("sixty 1-second sources use sixty credits", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("free");
    const module = usage();
    for (let index = 0; index < 60; index += 1) {
      const project = await measuredProject(ws.id, 1);
      await reserve(module, ws.id, { projectId: project.id, declaredSeconds: 1 });
      expect(await settle(module, project.id)).toEqual({ outcome: "settled", charged: true, settledSeconds: 60 });
    }
    expect(await module.summarize(ws.id)).toMatchObject({ usedCredits: 60, reservedCredits: 0, remainingCredits: 0 });
    expect((await refusal(reserve(module, ws.id, { declaredSeconds: 1 }))).code).toBe("credits_exhausted");
  });

  test("a Project's credit guidance excludes its hold and follows retry admission after release", async () => {
    clock = new Date("2026-12-15T08:30:00.000Z");
    const { workspace: ws } = await workspace("creator");
    const module = usage();
    const project = await measuredProject(ws.id, 61 * 60);
    await reserve(module, ws.id, { projectId: project.id, declaredSeconds: 61 * 60 });
    // The summary includes it, so guidance about this Project subtracts it once.
    expect((await module.summarize(ws.id)).reservedCredits).toBe(61);
    expect(await module.projectCreditUsage(project.id)).toEqual({
      periodStart: new Date("2026-12-01T00:00:00.000Z"), spentCredits: 0, state: "reserved",
    });
    await settle(module, project.id);
    // A settled Project's retry skips the length and credit checks, so the
    // guidance reports the state for callers to withhold their offers.
    expect(await module.projectCreditUsage(project.id)).toMatchObject({ spentCredits: 61, state: "settled" });
    await module.refund({ projectId: project.id, actorUserId: randomUUID(), reason: "duplicate charge" });
    expect((await module.projectCreditUsage(project.id))?.state).toBe("refunded");

    const released = await measuredProject(ws.id, 120);
    await reserve(module, ws.id, { projectId: released.id, declaredSeconds: 120 });
    clock = new Date("2027-01-02T00:00:00.000Z");
    await filler(ws.id, 200 * 60);
    await prisma.$transaction((tx) => module.release(tx, { projectId: released.id, reason: "ingest_failed" }));
    expect(await module.projectCreditUsage(released.id)).toEqual({
      periodStart: new Date("2027-01-01T00:00:00.000Z"), spentCredits: 200, state: "released",
    });
    expect(await module.projectCreditUsage(randomUUID())).toBeNull();
  });

  for (const scenario of [
    { priorCredits: 1000, currentCredits: 0, tier: "business" },
    { priorCredits: 0, currentCredits: 1800, tier: "creator" },
  ] as const) {
    test(`cross-month guidance with ${scenario.priorCredits} prior and ${scenario.currentCredits} current credits admits settlement on ${scenario.tier}`, async () => {
      clock = new Date("2026-09-30T23:59:00.000Z");
      const { workspace: ws } = await workspace("business");
      const module = usage();
      if (scenario.priorCredits) await filler(ws.id, scenario.priorCredits * 60);
      const project = await measuredProject(ws.id, 61 * 60);
      await reserve(module, ws.id, { projectId: project.id, declaredSeconds: 61 * 60 });
      clock = new Date("2026-10-01T00:01:00.000Z");
      if (scenario.currentCredits) await filler(ws.id, scenario.currentCredits * 60);
      await prisma.workspace.update({ where: { id: ws.id }, data: { pricingTier: "free" } });

      expect((await module.summarize(ws.id)).reservedCredits).toBe(scenario.currentCredits);
      const creditUsage = await module.projectCreditUsage(project.id);
      expect(creditUsage).toEqual({
        periodStart: new Date("2026-09-01T00:00:00.000Z"), spentCredits: scenario.priorCredits, state: "reserved",
      });
      const offeredTier = lowestTier((plan) =>
        plan.limits.maxSourceSeconds >= 61 * 60 && plan.limits.monthlyCredits >= creditUsage!.spentCredits + 61,
      );
      expect(offeredTier).toBe(scenario.tier);
      await prisma.workspace.update({ where: { id: ws.id }, data: { pricingTier: offeredTier! } });
      expect(await settle(module, project.id)).toEqual({ outcome: "settled", charged: true, settledSeconds: 61 * 60 });
      expect((await row(project.id)).periodStart).toEqual(new Date("2026-09-01T00:00:00.000Z"));
      expect((await module.summarize(ws.id)).reservedCredits).toBe(scenario.currentCredits);
    });
  }

  test("the summary's credit parts sum to the limit and renew on the next UTC month", async () => {
    clock = new Date("2026-12-15T08:30:00.000Z");
    const { workspace: ws } = await workspace("creator");
    const module = usage();
    const settled = await measuredProject(ws.id, 90);
    await reserve(module, ws.id, { projectId: settled.id, declaredSeconds: 90 });
    await settle(module, settled.id);
    await reserve(module, ws.id, { declaredSeconds: 61 });
    const summary = await module.summarize(ws.id);
    expect(summary).toMatchObject({
      tier: "creator",
      usedCredits: 2,
      reservedCredits: 2,
      limitCredits: PLAN_CATALOG.creator.limits.monthlyCredits,
      periodStart: new Date("2026-12-01T00:00:00.000Z"),
      renewsAt: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(summary.usedCredits + summary.reservedCredits + summary.remainingCredits).toBe(summary.limitCredits);
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
    const module = usage();
    // Ready intakes hold credits without occupying Processing Capacity.
    const projects = await Promise.all(Array.from({ length: 20 }, () => measuredProject(ws.id, 300)));
    const results = await Promise.allSettled(
      projects.map((project) => reserve(module, ws.id, { projectId: project.id, declaredSeconds: 300 })),
    );
    const admitted = results.filter((result) => result.status === "fulfilled");
    const refused = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    expect(admitted).toHaveLength(12);
    expect(refused).toHaveLength(8);
    for (const error of refused) {
      expect(error).toBeInstanceOf(ProcessingUsageError);
      expect(error.code).toBe("credits_exhausted");
    }
    const total = await prisma.processingUsageReservation.aggregate({
      where: { workspaceId: ws.id, state: "reserved" },
      _sum: { reservedSeconds: true },
    });
    expect(total._sum.reservedSeconds).toBe(3600);
    expect((await module.summarize(ws.id)).remainingCredits).toBe(0);
  });

  test("parallel admissions admit exactly the Processing Capacity, with retry guidance", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("pro");
    const module = usage();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => reserve(module, ws.id, { declaredSeconds: 60 })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(10);
    for (const result of results) {
      if (result.status === "fulfilled") continue;
      expect(result.reason).toMatchObject({
        code: "workspace_processing_capacity_reached",
        kind: "rate_limited",
        retryAfterSeconds: 60,
        details: { inFlight: 10, inFlightLimit: 10 },
      });
    }
  });

  test("capacity counts active runs and accepted export renders, and frees at terminal states", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("free");
    const module = usage();
    await reserve(module, ws.id, { declaredSeconds: 60 });
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
    expect((await module.summarize(ws.id)).inFlight).toBe(2);
    expect((await refusal(reserve(module, ws.id))).code).toBe(
      "workspace_processing_capacity_reached",
    );
    await prisma.clipRender.update({ where: { id: render.id }, data: { status: "completed" } });
    expect((await reserve(module, ws.id, { declaredSeconds: 60 })).state).toBe("reserved");
  });

  test("an ingested intake awaiting setup keeps its credits but frees capacity", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("free");
    const module = usage();
    await reserve(module, ws.id, { declaredSeconds: 60 });
    const awaiting = await measuredProject(ws.id, 600, { ingestStatus: "queued" });
    await reserve(module, ws.id, { projectId: awaiting.id, declaredSeconds: 600 });
    expect((await refusal(reserve(module, ws.id))).code).toBe("workspace_processing_capacity_reached");
    await prisma.project.update({
      where: { id: awaiting.id },
      data: { ingestStatus: "ready", sourceDurationSeconds: 600 },
    });
    expect(await module.summarize(ws.id)).toMatchObject({ inFlight: 1, reservedCredits: 11 });
    expect((await reserve(module, ws.id, { declaredSeconds: 60 })).state).toBe("reserved");
  });

  test("settlement requires a live reservation and never admits on its own", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("free");
    const module = usage();
    const unreserved = await measuredProject(ws.id, 600);
    await expect(settle(module, unreserved.id)).rejects.toThrow("processing_usage_not_reserved");
    expect(await prisma.processingUsageReservation.count({ where: { projectId: unreserved.id } })).toBe(0);

    const swept = await measuredProject(ws.id, 600);
    await reserve(module, ws.id, { projectId: swept.id, declaredSeconds: 600 });
    await prisma.$transaction((tx) => module.release(tx, { projectId: swept.id, reason: "reconciled_ingest_terminal" }));
    const refused = await settle(module, swept.id);
    expect(refused.outcome === "refused" && refused.failure).toMatchObject({
      code: "credits_reservation_released",
      kind: "conflict",
    });
    expect(await row(swept.id)).toMatchObject({
      state: "released",
      reason: "reconciled_ingest_terminal",
      settledSeconds: null,
    });
    expect((await module.summarize(ws.id)).usedCredits).toBe(0);
  });

  test("resize shrinks, grows from the remaining allowance, or refuses without changing the row", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("free");
    const module = usage();
    const projectId = randomUUID();
    await reserve(module, ws.id, { projectId });
    expect((await module.resize({ projectId, seconds: 600 })).reservedSeconds).toBe(600);
    expect((await module.summarize(ws.id)).remainingCredits).toBe(50);
    expect((await module.resize({ projectId, seconds: 1200 })).reservedSeconds).toBe(1200);
    expect((await refusal(module.resize({ projectId, seconds: 3601 }))).code).toBe("upload_too_long");
    await filler(ws.id, 2100);
    // 3600 - 1200 - 2100 leaves 5 credits to grow into; 1501 s needs 26 credits.
    const exhausted = await refusal(module.resize({ projectId, seconds: 1501 }));
    expect(exhausted).toMatchObject({
      code: "credits_exhausted",
      details: { remainingCredits: 25, spentCredits: 35, requestedCredits: 26 },
    });
    expect((await row(projectId)).reservedSeconds).toBe(1200);
    expect((await module.resize({ projectId, seconds: 1500 })).reservedSeconds).toBe(1500);
  });

  test("settlement charges the probed duration's whole credits once, at the boundary, and refuses what can't fit", async () => {
    clock = new Date();
    const { workspace: ws } = await workspace("free");
    const module = usage();

    // 500 s is 9 credits.
    const shorter = await measuredProject(ws.id, 500);
    await reserve(module, ws.id, { projectId: shorter.id, declaredSeconds: 600 });
    expect(await settle(module, shorter.id)).toEqual({ outcome: "settled", charged: true, settledSeconds: 540 });
    expect(await settle(module, shorter.id)).toEqual({ outcome: "settled", charged: false, settledSeconds: 540 });

    // 700 s is 12 credits, more than its 10-credit reservation.
    const longer = await measuredProject(ws.id, 700);
    await reserve(module, ws.id, { projectId: longer.id, declaredSeconds: 600 });
    expect(await settle(module, longer.id)).toMatchObject({ outcome: "settled", settledSeconds: 720 });

    // 60 - 9 - 12 = 39 credits remain. 1600 s is 27 credits: its 10-credit
    // reservation plus another intake's 12 leaves exactly 17 more.
    const boundary = await measuredProject(ws.id, 1600);
    await reserve(module, ws.id, { projectId: boundary.id, declaredSeconds: 600 });
    await reserve(module, ws.id, { declaredSeconds: 720 });
    expect(await settle(module, boundary.id)).toMatchObject({ outcome: "settled", settledSeconds: 1620 });
    expect(await module.summarize(ws.id)).toMatchObject({ usedCredits: 48, reservedCredits: 12, remainingCredits: 0 });

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
    // 61 s is 2 credits; its 1-credit reservation can't grow.
    const outcome = await settle(module, refused.id);
    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome === "refused")
      expect(outcome.failure.code).toBe("credits_exhausted");
    expect(await row(refused.id)).toMatchObject({ state: "released", reason: "credits_exhausted" });

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

    // A restricted Workspace admits nothing new; replays and the ledger stay intact.
    expect(await refusal(reserve(module, ws.id, { declaredSeconds: 60 }))).toMatchObject({
      code: "project_access_denied",
      kind: "forbidden",
    });
    expect(await prisma.processingUsageReservation.count({ where: { workspaceId: ws.id, state: "reserved" } })).toBe(0);
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
    expect(await module.summarize(ws.id)).toMatchObject({
      usedCredits: 0,
      remainingCredits: 60,
      periodStart: new Date("2026-02-01T00:00:00.000Z"),
      renewsAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    clock = new Date("2026-01-15T00:00:00.000Z");
    expect(await module.summarize(ws.id)).toMatchObject({
      usedCredits: 10,
      remainingCredits: 50,
      renewsAt: new Date("2026-02-01T00:00:00.000Z"),
    });

    clock = new Date("2026-02-10T00:00:00.000Z");
    await filler(ws.id, 3600);
    expect((await refusal(reserve(module, ws.id))).code).toBe("credits_exhausted");
    await prisma.workspace.update({ where: { id: ws.id }, data: { pricingTier: "creator" } });
    expect((await reserve(module, ws.id)).reservedSeconds).toBe(120 * 60);
    expect(await module.summarize(ws.id)).toMatchObject({
      tier: "creator",
      usedCredits: 0,
      reservedCredits: 180,
      limitCredits: 300,
      remainingCredits: 120,
      maxUploadSeconds: 120 * 60,
      inFlightLimit: 5,
    });
    for (const [tier, limitCredits, maxUploadSeconds] of [["pro", 900, 10_800], ["business", 1800, 10_800]] as const) {
      await prisma.workspace.update({ where: { id: ws.id }, data: { pricingTier: tier } });
      expect(await module.summarize(ws.id)).toMatchObject({ limitCredits, maxUploadSeconds, reservedCredits: 180 });
    }
    // A downgrade below what's already held clamps what's left at zero.
    await prisma.workspace.update({ where: { id: ws.id }, data: { pricingTier: "free" } });
    expect(await module.summarize(ws.id)).toMatchObject({ limitCredits: 60, reservedCredits: 180, remainingCredits: 0 });
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
    expect((await module.summarize(ws.id)).usedCredits).toBe(0);
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
    expect((await refusal(retry())).code).toBe("credits_exhausted");
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
    const rss = await projectService.importResolvedRssEpisodes(scope, {
      rssUrl: "https://example.test/feed.xml",
      episodes: [
        { id: "a", title: "A", enclosureUrl: "https://example.test/a.mp3", durationSeconds: 40 * 60 },
        { id: "b", title: "B", enclosureUrl: "https://example.test/b.mp3", durationSeconds: 30 * 60 },
      ],
    });
    // 20 credits remain after the first: the second is reported, not admitted.
    expect(rss.count).toBe(1);
    expect(rss.notAdmitted).toEqual([{ episodeId: "b", code: "credits_exhausted" }]);

    // A link of unknown length holds what's left, up to the per-video cap.
    const link = await projectService.queueLinkIngest(scope, {
      url: "https://www.dropbox.com/s/abc/video.mp4",
      commitToken: randomUUID(),
    });
    expect(await row(link.project.id)).toMatchObject({ state: "reserved", intakeKind: "link", reservedSeconds: 1200 });
    await expect(
      projectService.queueLinkIngest(scope, { url: "https://www.dropbox.com/s/def/video.mp4", commitToken: randomUUID() }),
    ).rejects.toBeInstanceOf(ProcessingUsageError);
    expect(await prisma.project.count({ where: { workspaceId: ws.id } })).toBe(2);

    await projectService.deleteProject(scope, link.project.id);
    expect(await row(link.project.id)).toMatchObject({ state: "released", reason: "project_deleted" });
  });

  test("a Drive Picker file is admitted as link intake from Drive's own facts, with its token sealed on the job", async () => {
    clock = new Date();
    const { workspace: ws, scope } = await workspace("free");
    const accessToken = "ya29.drive-picker-secret";
    const fileId = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123";
    const asked: Array<{ fileId: string; accessToken: string }> = [];
    const files = (durationSeconds: number | null, fail?: ExpectedDomainFailureError) => ({
      read: async (input: { fileId: string; accessToken: string }) => {
        asked.push(input);
        if (fail) throw fail;
        return { fileId: input.fileId, name: "Weekly sync.mp4", mimeType: "video/mp4", sizeBytes: 1_000, durationSeconds };
      },
    });
    const commitToken = randomUUID();
    const drive = await projectService.queueDriveIngest(
      scope,
      { fileId, accessToken, commitToken },
      { files: files(10 * 60) },
    );
    expect(asked).toEqual([{ fileId, accessToken }]);
    const project = await prisma.project.findUniqueOrThrow({ where: { id: drive.project.id } });
    expect(project).toMatchObject({
      title: "Weekly sync",
      sourceType: "link",
      sourceProvider: "gdrive",
      sourceMediaUrl: `https://drive.google.com/file/d/${fileId}/view`,
      ingestStatus: "queued",
      commitToken,
    });
    expect(await row(project.id)).toMatchObject({ state: "reserved", intakeKind: "link", reservedSeconds: 600 });
    const job = await prisma.ingestJob.findUniqueOrThrow({ where: { id: drive.queuedJobId! } });
    expect(job).toMatchObject({
      jobType: "drive_import",
      status: "queued",
      payload: { fileId, fileName: "Weekly sync.mp4" },
    });
    expect(job.sourceCredential).not.toBeNull();
    expect(createDriveTokenCipher().open(job.sourceCredential!)).toBe(accessToken);
    expect(await prisma.contentPack.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ draft: true });

    // The token lives only in the sealed column.
    const everywhere = JSON.stringify(
      [
        project,
        { ...job, sourceCredential: null },
        await prisma.workflowEvent.findMany({ where: { projectId: project.id } }),
        await prisma.processingUsageReservation.findMany({ where: { workspaceId: ws.id } }),
        await prisma.programAnalyticsEvent.findMany({ where: { projectId: project.id } }),
      ],
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    );
    expect(everywhere).not.toContain(accessToken);

    // A repeated commit returns the same Project without asking Drive again.
    const replay = await projectService.queueDriveIngest(
      scope,
      { fileId, accessToken, commitToken },
      { files: files(10 * 60) },
    );
    expect(replay.project.id).toBe(drive.project.id);
    expect(replay.queuedJobId).toBe(drive.queuedJobId);
    expect(asked).toHaveLength(1);

    // Drive's duration is checked under the tier's per-video cap, and a file
    // Drive refuses creates nothing.
    await expect(
      projectService.queueDriveIngest(scope, { fileId, accessToken }, { files: files(61 * 60) }),
    ).rejects.toBeInstanceOf(ProcessingUsageError);
    const expired = new DriveSourceError("drive_token_expired");
    expect(
      await refusal(projectService.queueDriveIngest(scope, { fileId, accessToken }, { files: files(null, expired) })),
    ).toMatchObject({ code: "drive_token_expired" });
    expect(await prisma.project.count({ where: { workspaceId: ws.id } })).toBe(1);
    expect(await prisma.ingestJob.count({ where: { project: { workspaceId: ws.id } } })).toBe(1);
  });

  test("Drive intake through the real reader refuses a foreign token and a video longer than the tier allows", async () => {
    clock = new Date();
    const { workspace: ws, scope } = await workspace("free");
    const fileId = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123";
    const clientId = "narriflow.apps.googleusercontent.com";
    const drive = (durationMillis: string, aud = clientId) => {
      const resolver = async () => [{ address: "142.250.80.42", family: 4 }];
      const transport = async (url: URL) =>
        new Response(
          JSON.stringify(
            url.hostname === "oauth2.googleapis.com"
              ? { aud, scope: "https://www.googleapis.com/auth/drive.file" }
              : { id: fileId, name: "Long.mp4", mimeType: "video/mp4", size: "1000", videoMediaMetadata: { durationMillis } },
          ),
          { status: 200 },
        );
      return createGoogleDriveFileReader({ clientId, transport, resolver });
    };
    const input = { fileId, accessToken: "ya29.reader-token" };

    // Two hours exceeds the free tier's 60-minute per-video limit.
    expect(
      await refusal(projectService.queueDriveIngest(scope, input, { files: drive("7200000") })),
    ).toMatchObject({ code: "upload_too_long" });
    expect(
      await refusal(projectService.queueDriveIngest(scope, input, { files: drive("600000", "another-app") })),
    ).toMatchObject({ code: "drive_token_invalid" });
    expect(await prisma.project.count({ where: { workspaceId: ws.id } })).toBe(0);

    const admitted = await projectService.queueDriveIngest(scope, input, { files: drive("1800000") });
    expect(await row(admitted.project.id)).toMatchObject({ state: "reserved", reservedSeconds: 1800 });
    expect(await projectService.getProjectSnapshot(scope, admitted.project.id)).toMatchObject({
      ingestJobType: "drive_import",
    });
  });

  test("a retention purge discards the Drive token of the queued job it cancels", async () => {
    clock = new Date();
    const { scope } = await workspace("free");
    const drive = await projectService.queueDriveIngest(
      scope,
      { fileId: "1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123", accessToken: "ya29.retention-token" },
      {
        files: {
          read: async (input) => ({ fileId: input.fileId, name: "a.mp4", mimeType: "video/mp4", sizeBytes: 1, durationSeconds: 60 }),
        },
      },
    );
    const before = await prisma.ingestJob.findUniqueOrThrow({ where: { id: drive.queuedJobId! } });
    expect(before.sourceCredential).not.toBeNull();
    await prisma.project.update({
      where: { id: drive.project.id },
      data: { retentionPolicyKey: "free_project_v1", expiresAt: new Date(Date.now() - 60 * 60_000) },
    });

    const priorEnv = { ...process.env };
    process.env.PROJECT_RETENTION_MODE = "enforce";
    process.env.PROJECT_RETENTION_ENFORCEMENT_STARTED_AT = "2020-01-01T00:00:00.000Z";
    // Without R2 the purge stops after claiming, so the cancelled job stays inspectable.
    delete process.env.R2_ACCOUNT_ID;
    try {
      await projectRetentionService.purgeDueProjects(10, new Date());
    } finally {
      for (const key of ["PROJECT_RETENTION_MODE", "PROJECT_RETENTION_ENFORCEMENT_STARTED_AT", "R2_ACCOUNT_ID"]) {
        if (priorEnv[key] === undefined) delete process.env[key];
        else process.env[key] = priorEnv[key];
      }
    }

    const after = await prisma.ingestJob.findUniqueOrThrow({ where: { id: drive.queuedJobId! } });
    expect(after).toMatchObject({ status: "cancelled", lastError: "PROJECT_EXPIRED", sourceCredential: null });
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
    expect(browser.code).toBe("credits_exhausted");
    expect(await prisma.project.findUniqueOrThrow({ where: { id: tooLong.id } })).toMatchObject({
      ingestStatus: "failed",
      ingestErrorCode: "credits_exhausted",
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
    expect(viaMcp.code).toBe("credits_exhausted");
    const replayKey = randomUUID();
    const replay = await refusal(
      projectService.triggerGeneration(scope, mcp.id, request, randomUUID(), {
        mutation: { clientIdempotencyKey: replayKey },
      }),
    );
    expect(replay).toMatchObject({ code: "credits_exhausted", kind: "payment_required" });
    expect((await row(mcp.id)).state).toBe("released");
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: mcp.id } })).ingestErrorCode,
    ).toBe("credits_exhausted");
  });

  test("Upload Session open reserves declared credits and terminal compensation releases them", async () => {
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
    const refused = await refusal(open(61 * 60));
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
