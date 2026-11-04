import { bindServiceTestEnvironment } from "./runtime-test-support";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { processingPeriodStart } from "@narriflow/validators";
import { Pool } from "pg";
import { dubbingService } from "./dubbing.service";
import {
  createPrismaGenerationUsageLedger,
  reconcileGenerationUsagePage,
  releaseFailedDubUsage,
  summarizeGenerationUsage,
} from "./generated-media-usage-ledger";
import { projectRetentionService } from "./project-retention.service";
import { startDubbingTestExecution } from "./dubbing-execution-test-support";

/**
 * Runs in its own process under `test:vizard-expansion:db`, because dub
 * admission uses the process-wide Workflow Run lifecycle singleton.
 */
const databaseUrl = process.env.VIZARD_EXPANSION_TEST_DATABASE_URL;
const databaseSchema = process.env.VIZARD_EXPANSION_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_VIZARD_EXPANSION_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);

const DAY_MS = 24 * 60 * 60 * 1000;

dbDescribe("Generation usage PostgreSQL contracts", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  const prismaGlobal = createDatabaseTestContext();
  let priorPrisma: PrismaClient | undefined;
  const ledger = createPrismaGenerationUsageLedger();
  const now = new Date();
  const currentPeriod = processingPeriodStart(now);
  const previousPeriod = processingPeriodStart(new Date(currentPeriod.getTime() - DAY_MS));

  beforeAll(bindServiceTestEnvironment(prismaGlobal.bind(() => {
    if (!databaseUrl) throw new Error("Vizard expansion test database is required");
    pool = new Pool({
      connectionString: databaseUrl,
      max: 12,
      options: databaseSchema ? `-csearch_path=${databaseSchema}` : undefined,
    });
    prisma = new PrismaClient({
      adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined),
    });
    priorPrisma = prismaGlobal.client;
    prismaGlobal.client = prisma;
  })));

  afterAll(bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    prismaGlobal.client = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  })));

  async function user(label: string) {
    const suffix = randomUUID();
    return prisma.user.create({
      data: { clerkId: `generation-${label}-${suffix}`, primaryEmail: `generation-${label}-${suffix}@example.test` },
    });
  }

  async function workspace(tier: "free" | "creator" | "pro" | "business", label = tier) {
    const owner = await user(label);
    const created = await prisma.workspace.create({
      data: {
        name: `Generation ${label}`,
        ownerUserId: owner.id,
        pricingTier: tier,
        members: { create: { userId: owner.id, role: "owner" } },
      },
    });
    return { owner, workspace: created };
  }

  async function dubbableProject(workspaceId: string, createdByUserId: string, renderSeconds: number | null = 10) {
    const project = await prisma.project.create({
      data: {
        title: "Generation project",
        sourceMediaUrl: "https://media.example.test/source.mp4",
        sourceStorageKey: `fixtures/${randomUUID()}/source.mp4`,
        workspaceId,
        createdByUserId,
        ingestStatus: "ready",
        sourceDurationSeconds: 10,
      },
    });
    const detection = await prisma.workflowRun.create({
      data: {
        projectId: project.id,
        idempotencyKey: `fixture:${randomUUID()}`,
        stage: "moment_detection",
        status: "completed",
        progress: 100,
      },
    });
    const clip = await prisma.clip.create({
      data: {
        projectId: project.id,
        workflowRunId: detection.id,
        index: 0,
        status: "edited",
        startSec: 0,
        endSec: 10,
        title: "Dub me",
        hookText: "A strong hook",
        reasoning: "Fixture",
        category: "hook",
        transcriptSlice: [],
        viralityScore: 80,
        hookStrengthScore: 80,
        emotionalIntensityScore: 70,
        pacingScore: 75,
        durationOptimalityScore: 80,
        tiktokScore: 80,
        youtubeScore: 80,
        instagramScore: 80,
        llmProvider: "test",
        llmModel: "test",
      },
    });
    await prisma.clipRender.create({
      data: {
        clipId: clip.id,
        aspectRatio: "ratio_9_16",
        status: "completed",
        storageKey: `fixtures/${randomUUID()}/base.mp4`,
        durationSec: renderSeconds,
        sizeBytes: 3n,
      },
    });
    return { project, clip };
  }

  function dubInput(clipId: string, targetLanguageCode: "es" | "fr" | "de" = "es") {
    return { clipId, aspectRatio: "9:16" as const, targetLanguageCode, voice: "marin" as const };
  }

  async function prefill(input: {
    workspaceId: string;
    kind: "image" | "dub";
    count: number;
    policy?: string;
    periodStart?: Date;
    status?: "reserved" | "finalized" | "released";
  }) {
    await prisma.generatedMediaUsageReservation.createMany({
      data: Array.from({ length: input.count }, () => ({
        jobId: randomUUID(),
        kind: input.kind,
        workspaceId: input.workspaceId,
        policy: input.policy ?? "metered",
        periodStart: input.periodStart ?? currentPeriod,
        status: input.status ?? "finalized",
        attachedAt: new Date(),
      })),
    });
  }

  /** One hourly maintenance page over every due reservation. */
  const reconcileGenerationUsageReservations = (cutoff = new Date()) =>
    prisma.$transaction((tx) => reconcileGenerationUsagePage(tx, { deploymentEpoch: 1, cutoff, after: null, limit: 100 }));

  async function createImageSubject(input:{id:string;reservationId:string;workspaceId:string;actorUserId:string;projectId:string}){
   return prisma.$transaction(async tx=>{
    await tx.generatedMediaUsageReservation.update({where:{id:input.reservationId},data:{attachedAt:new Date()}});
    return tx.generatedMediaJob.create({data:{id:input.id,workspaceId:input.workspaceId,projectId:input.projectId,createdByUserId:input.actorUserId,workspaceOwnerUserId:input.actorUserId,actorRole:"owner",actorStatus:"active",pricingTier:"creator",isPersonalWorkspace:true,idempotencyKey:randomUUID(),requestFingerprint:"fixture",protectedPrompt:"protected",promptFingerprint:"fixture",promptOrigin:"manual",aspectRatio:"9:16",style:"editorial",title:"Generated fixture",usageReservationId:input.reservationId,provider:"openai",providerModel:"fixture",promptExpiresAt:new Date(Date.now()+30*DAY_MS)}});
   });
  }

  const reserveImage = (workspaceId: string, actorUserId: string, pricingTier: string) =>
    ledger.reserve({ kind: "image", jobId: randomUUID(), workspaceId, actorUserId, pricingTier });

  test("the last image of the month goes to exactly one of several concurrent requests", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { owner, workspace: ws } = await workspace("creator");
    await prefill({ workspaceId: ws.id, kind: "image", count: 9 });
    // A dub never consumes image allowance or concurrency.
    await prefill({ workspaceId: ws.id, kind: "dub", count: 5, status: "reserved" });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => reserveImage(ws.id, owner.id, "creator")),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({
          code: "plan_limit_reached",
          details: { limit: "generatedImages", used: 10, max: 10, currentTier: "creator", requiredTier: "pro" },
        });
      }
    }
    expect((await summarizeGenerationUsage(ws.id)).images).toMatchObject({
      period: "month",
      limit: 10,
      used: 10,
      reserved: 1,
      remaining: 0,
      concurrency: { limit: 2, active: 1 },
    });
  })));

  test("image concurrency spans periods while counts stay pinned to their admission month", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { owner, workspace: ws } = await workspace("creator");
    // Two requests admitted last month are still waiting on the provider.
    await prefill({ workspaceId: ws.id, kind: "image", count: 2, status: "reserved", periodStart: previousPeriod });
    await expect(reserveImage(ws.id, owner.id, "creator")).rejects.toMatchObject({
      code: "generated_media_concurrency_limit_reached",
    });
    expect((await summarizeGenerationUsage(ws.id)).images).toMatchObject({ used: 0, remaining: 10 });
    await prisma.generatedMediaUsageReservation.updateMany({
      where: { workspaceId: ws.id },
      data: { status: "finalized" },
    });
    // Finalizing after the UTC rollover keeps last month's period.
    const rows = await prisma.generatedMediaUsageReservation.findMany({ where: { workspaceId: ws.id } });
    expect(rows.every((row) => row.periodStart.getTime() === previousPeriod.getTime())).toBe(true);
    await reserveImage(ws.id, owner.id, "creator");
    expect((await summarizeGenerationUsage(ws.id)).images).toMatchObject({ used: 1, remaining: 9 });
  })));

  test("a Free refusal after paid images this month offers a plan with room for them", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    // Downgraded to Free after the sample plus 29 paid images this month: Creator's
    // 10 a month can't admit another image, so the offer must be Business, not Creator.
    const { owner, workspace: ws } = await workspace("free", "month-history");
    await prefill({ workspaceId: ws.id, kind: "image", count: 1, policy: "trial_metered" });
    await prefill({ workspaceId: ws.id, kind: "image", count: 29 });
    await expect(reserveImage(ws.id, owner.id, "free")).rejects.toMatchObject({
      code: "plan_limit_reached",
      details: { limit: "generatedImages", used: 1, max: 1, requiredTier: "business" },
    });
    expect((await summarizeGenerationUsage(ws.id)).images).toMatchObject({ used: 1, monthUsed: 30 });
  })));

  test("the Free image sample is lifetime, ignores paid history, and survives upgrade and downgrade", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { owner, workspace: ws } = await workspace("free");
    const sample = await reserveImage(ws.id, owner.id, "free");
    expect(
      await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { id: sample.reservationId } }),
    ).toMatchObject({ kind: "image", policy: "trial_metered", periodStart: currentPeriod });
    await prisma.generatedMediaUsageReservation.update({
      where: { id: sample.reservationId },
      data: { status: "finalized", periodStart: previousPeriod },
    });
    await expect(reserveImage(ws.id, owner.id, "free")).rejects.toMatchObject({
      code: "plan_limit_reached",
      details: { limit: "generatedImages", used: 1, max: 1, requiredTier: "creator" },
    });
    expect((await summarizeGenerationUsage(ws.id)).images).toMatchObject({
      period: "lifetime",
      periodStart: null,
      used: 1,
      remaining: 0,
      policy: "trial_metered",
    });
    // Upgrade: the monthly allowance applies.
    await prisma.workspace.update({ where: { id: ws.id }, data: { pricingTier: "creator" } });
    await reserveImage(ws.id, owner.id, "creator");
    // Downgrade cannot grant a second sample.
    await prisma.workspace.update({ where: { id: ws.id }, data: { pricingTier: "free" } });
    await expect(reserveImage(ws.id, owner.id, "free")).rejects.toMatchObject({ code: "plan_limit_reached" });

    // Paid images are not trial use: a paid-only history still gets one sample.
    const paid = await workspace("creator", "paid-history");
    await prefill({ workspaceId: paid.workspace.id, kind: "image", count: 3 });
    await prisma.workspace.update({ where: { id: paid.workspace.id }, data: { pricingTier: "free" } });
    await reserveImage(paid.workspace.id, paid.owner.id, "free");
    await prisma.generatedMediaUsageReservation.updateMany({
      where: { workspaceId: paid.workspace.id },
      data: { status: "finalized" },
    });
    await expect(reserveImage(paid.workspace.id, paid.owner.id, "free")).rejects.toMatchObject({
      code: "plan_limit_reached",
    });
  })));

  test("the sweep releases admission orphans, keeps unknown outcomes reserved, and never refunds deletion", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { owner, workspace: ws } = await workspace("creator", "sweep-images");
    const { project } = await dubbableProject(ws.id, owner.id);
    const orphan = await reserveImage(ws.id, owner.id, "creator");
    const unknownId = randomUUID();
    const unknown = await ledger.reserve({ kind: "image", jobId: unknownId, workspaceId: ws.id, actorUserId: owner.id, pricingTier: "creator" });
    await createImageSubject({id:unknownId,reservationId:unknown.reservationId,workspaceId:ws.id,actorUserId:owner.id,projectId:project.id});
    await prisma.generatedMediaJob.update({
      where: { id: unknownId },
      data: { status: "waiting", outcomeUnknown: true, errorCode: "provider_outcome_unknown" },
    });
    await prisma.generatedMediaUsageReservation.updateMany({
      where: { workspaceId: ws.id },
      data: { createdAt: new Date(Date.now() - DAY_MS) },
    });
    await reconcileGenerationUsageReservations();
    const rows = await prisma.generatedMediaUsageReservation.findMany({ where: { workspaceId: ws.id } });
    expect(rows.find((row) => row.id === orphan.reservationId)).toMatchObject({
      status: "released",
      reason: "generated_media_admission_orphan_reconciled",
    });
    expect(rows.find((row) => row.id === unknown.reservationId)).toMatchObject({ status: "reserved" });
    expect(rows.find((row) => row.id === unknown.reservationId)?.attachedAt).not.toBeNull();

    // Deleting the Project while the outcome is unknown keeps the count.
    await prisma.project.delete({ where: { id: project.id } });
    await reconcileGenerationUsageReservations();
    expect(
      await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { id: unknown.reservationId } }),
    ).toMatchObject({ status: "finalized", reason: "generation_subject_deleted" });
    expect((await summarizeGenerationUsage(ws.id)).images).toMatchObject({ used: 1, concurrency: { active: 0 } });
  })));

  test("the hourly sweep frees the concurrency slot of an image job deleted with its Project", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { owner, workspace: ws } = await workspace("creator", "sweep-slot");
    const { project } = await dubbableProject(ws.id, owner.id);
    const jobId = randomUUID();
    const { reservationId } = await ledger.reserve({ kind: "image", jobId, workspaceId: ws.id, actorUserId: owner.id, pricingTier: "creator" });
    await createImageSubject({ id: jobId, reservationId, workspaceId: ws.id, actorUserId: owner.id, projectId: project.id });
    await prisma.generatedMediaUsageReservation.update({ where: { id: reservationId }, data: { attachedAt: new Date() } });
    await prisma.project.delete({ where: { id: project.id } });
    expect((await summarizeGenerationUsage(ws.id)).images.concurrency.active).toBe(1);

    // Inside the grace window a page leaves it alone.
    await reconcileGenerationUsageReservations(new Date(Date.now() + 60_000));
    expect((await summarizeGenerationUsage(ws.id)).images.concurrency.active).toBe(1);

    await reconcileGenerationUsageReservations(new Date(Date.now() + 11 * 60_000));
    expect(await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { id: reservationId } })).toMatchObject({ status: "finalized", reason: "generation_subject_deleted" });
    expect((await summarizeGenerationUsage(ws.id)).images.concurrency.active).toBe(0);
  })));

  test("a sweep page resumes after its cursor", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { owner, workspace: ws } = await workspace("business", "sweep-pages");
    const at = new Date(Date.now() - 7 * DAY_MS);
    for (const offset of [0, 1, 2]) {
      const { reservationId } = await ledger.reserve({ kind: "image", jobId: randomUUID(), workspaceId: ws.id, actorUserId: owner.id, pricingTier: "business" });
      await prisma.generatedMediaUsageReservation.update({ where: { id: reservationId }, data: { createdAt: new Date(at.getTime() + offset) } });
    }
    await prisma.generatedMediaUsageReservation.updateMany({ where: { workspaceId: { not: ws.id }, status: "reserved", createdAt: { lt: new Date(at.getTime() + DAY_MS) } }, data: { createdAt: new Date() } });
    const cutoff = new Date(at.getTime() + DAY_MS);
    const first = await prisma.$transaction((tx) => reconcileGenerationUsagePage(tx, { deploymentEpoch: 1, cutoff, after: null, limit: 2 }));
    expect(first.processed).toBe(2);
    expect(first.next?.at).toEqual(new Date(at.getTime() + 1));
    const second = await prisma.$transaction((tx) => reconcileGenerationUsagePage(tx, { deploymentEpoch: 1, cutoff, after: first.next, limit: 2 }));
    expect(second).toEqual({ processed: 1, next: null });
    expect(await prisma.generatedMediaUsageReservation.count({ where: { workspaceId: ws.id, status: "released" } })).toBe(3);
  })));

  test("deleting the actor, output, or Project never refunds a finalized count", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { owner, workspace: ws } = await workspace("business", "deletion");
    const member = await user("deletion-member");
    await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: member.id, role: "editor" } });
    const { project, clip } = await dubbableProject(ws.id, owner.id);
    const image = await ledger.reserve({ kind: "image", jobId: randomUUID(), workspaceId: ws.id, actorUserId: member.id, pricingTier: "business" });
    await prisma.generatedMediaUsageReservation.update({ where: { id: image.reservationId }, data: { status: "finalized" } });
    const dub = await dubbingService.requestClipDub(
      { actorUserId: member.id, workspaceId: ws.id },
      project.id,
      randomUUID(),
      dubInput(clip.id),
    );
    await prisma.generatedMediaUsageReservation.update({ where: { jobId: dub.dub.id }, data: { status: "finalized" } });
    await prisma.clipDub.update({ where: { id: dub.dub.id }, data: { status: "completed", completedAt: new Date() } });

    await prisma.user.delete({ where: { id: member.id } });
    await prisma.workflowRun.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } });
    await reconcileGenerationUsageReservations();

    const rows = await prisma.generatedMediaUsageReservation.findMany({ where: { workspaceId: ws.id } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "finalized" && row.actorUserId === null)).toBe(true);
    const summary = await summarizeGenerationUsage(ws.id);
    expect(summary.images.used).toBe(1);
    expect(summary.dubs).toMatchObject({ used: 1, limit: 30, remaining: 29, entitled: true, maxClipSeconds: 180 });
  })));

  test("dubbing needs the plan, a short enough clip, and an unexhausted month", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const creator = await workspace("creator", "dub-creator");
    const creatorProject = await dubbableProject(creator.workspace.id, creator.owner.id);
    await expect(
      dubbingService.requestClipDub(
        { actorUserId: creator.owner.id, workspaceId: creator.workspace.id },
        creatorProject.project.id,
        randomUUID(),
        dubInput(creatorProject.clip.id),
      ),
    ).rejects.toMatchObject({ code: "plan_feature_required", details: { feature: "dubbing", requiredTier: "pro" } });
    expect(await dubbingService.getDubbingAllowance({ actorUserId: creator.owner.id, workspaceId: creator.workspace.id })).toMatchObject({
      entitled: false,
      limit: 0,
    });

    const pro = await workspace("pro", "dub-pro-long");
    const long = await dubbableProject(pro.workspace.id, pro.owner.id, 181);
    await expect(
      dubbingService.requestClipDub(
        { actorUserId: pro.owner.id, workspaceId: pro.workspace.id },
        long.project.id,
        randomUUID(),
        dubInput(long.clip.id),
      ),
    ).rejects.toMatchObject({ code: "dubbing_clip_too_long" });
    expect(await prisma.clipDub.count({ where: { projectId: long.project.id } })).toBe(0);
  })));

  test("the last dub of the month goes to one of two members racing on different Projects", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { owner, workspace: ws } = await workspace("business", "dub-race");
    const member = await user("dub-race-member");
    await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: member.id, role: "editor" } });
    await prefill({ workspaceId: ws.id, kind: "dub", count: 29 });
    // Image usage never consumes dub allowance.
    await prefill({ workspaceId: ws.id, kind: "image", count: 4, status: "reserved" });
    const first = await dubbableProject(ws.id, owner.id);
    const second = await dubbableProject(ws.id, member.id);
    const results = await Promise.allSettled([
      dubbingService.requestClipDub({ actorUserId: owner.id, workspaceId: ws.id }, first.project.id, randomUUID(), dubInput(first.clip.id)),
      dubbingService.requestClipDub({ actorUserId: member.id, workspaceId: ws.id }, second.project.id, randomUUID(), dubInput(second.clip.id)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({
      code: "plan_limit_reached",
      details: { limit: "dubs", used: 30, max: 30, requiredTier: null },
    });
    // The refusal rolled back the dub row and its Workflow Run together.
    const dubs = await prisma.clipDub.count({ where: { projectId: { in: [first.project.id, second.project.id] } } });
    const runs = await prisma.workflowRun.count({
      where: { projectId: { in: [first.project.id, second.project.id] }, stage: "dubbing" },
    });
    expect(dubs).toBe(1);
    expect(runs).toBe(1);
    expect((await summarizeGenerationUsage(ws.id)).dubs).toMatchObject({ used: 30, remaining: 0 });
  })));

  test("a concurrent idempotent dub request admits one dub, one run, and one count", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { owner, workspace: ws } = await workspace("pro", "dub-idempotent");
    const { project, clip } = await dubbableProject(ws.id, owner.id);
    const key = randomUUID();
    const [left, right] = await Promise.all(
      [0, 1].map(() =>
        dubbingService.requestClipDub({ actorUserId: owner.id, workspaceId: ws.id }, project.id, key, dubInput(clip.id)),
      ),
    );
    expect(left!.dub.id).toBe(right!.dub.id);
    expect(left!.workflowRunId).toBe(right!.workflowRunId);
    // A different key for the live dub replays it too.
    const replay = await dubbingService.requestClipDub({ actorUserId: owner.id, workspaceId: ws.id }, project.id, randomUUID(), dubInput(clip.id));
    expect(replay).toMatchObject({ dub: { id: left!.dub.id }, workflowRunId: left!.workflowRunId });
    expect(await prisma.generatedMediaUsageReservation.count({ where: { workspaceId: ws.id, kind: "dub" } })).toBe(1);
    expect(await prisma.workflowRun.count({ where: { projectId: project.id, stage: "dubbing" } })).toBe(1);
    // Another tuple while that run is live is refused, not stranded.
    await expect(
      dubbingService.requestClipDub({ actorUserId: owner.id, workspaceId: ws.id }, project.id, randomUUID(), dubInput(clip.id, "fr")),
    ).rejects.toMatchObject({ code: "dubbing_in_progress" });
    expect(await prisma.generatedMediaUsageReservation.count({ where: { workspaceId: ws.id, kind: "dub" } })).toBe(1);
  })));

  test("a failed dub re-request is counted again in the current month", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { owner, workspace: ws } = await workspace("pro", "dub-readmit");
    const { project, clip } = await dubbableProject(ws.id, owner.id);
    const scope = { actorUserId: owner.id, workspaceId: ws.id };
    const first = await dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id));
    // It failed last month; its reservation was released then.
    await prisma.workflowRun.update({ where: { id: first.workflowRunId! }, data: { status: "failed" } });
    await prisma.clipDub.update({ where: { id: first.dub.id }, data: { status: "failed", errorCode: "openai_tts_failed" } });
    await prisma.generatedMediaUsageReservation.update({
      where: { jobId: first.dub.id },
      data: { status: "released", periodStart: previousPeriod, reason: "dub_failed" },
    });
    await prefill({ workspaceId: ws.id, kind: "dub", count: 10 });
    await expect(
      dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id)),
    ).rejects.toMatchObject({ code: "plan_limit_reached", details: { limit: "dubs" } });
    expect(await prisma.clipDub.findUniqueOrThrow({ where: { id: first.dub.id } })).toMatchObject({ status: "failed" });
    expect(
      await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: first.dub.id } }),
    ).toMatchObject({ status: "released", periodStart: previousPeriod });

    // With room this month, a new accepted row preserves the old reservation history.
    await prisma.generatedMediaUsageReservation.deleteMany({ where: { workspaceId: ws.id, jobId: { not: first.dub.id } } });
    await prefill({ workspaceId: ws.id, kind: "dub", count: 9 });
    const again = await dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id));
    expect(again.dub.status).toBe("queued");
    expect(again.dub.id).not.toBe(first.dub.id);
    expect(again.workflowRunId).not.toBe(first.workflowRunId);
    expect(
      await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: again.dub.id } }),
    ).toMatchObject({ status: "reserved", periodStart: currentPeriod, reason: null });
    expect(await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: first.dub.id } })).toMatchObject({ status: "released", periodStart: previousPeriod });
    expect((await summarizeGenerationUsage(ws.id)).dubs).toMatchObject({ used: 10, remaining: 0 });

    // A failure still settling (reserved from last month) is not a free pass either.
    await prisma.workflowRun.update({ where: { id: again.workflowRunId! }, data: { status: "failed" } });
    await prisma.clipDub.update({ where: { id: again.dub.id }, data: { status: "failed" } });
    await prisma.generatedMediaUsageReservation.update({ where: { jobId: again.dub.id }, data: { periodStart: previousPeriod } });
    await prefill({ workspaceId: ws.id, kind: "dub", count: 1 });
    await expect(
      dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id)),
    ).rejects.toMatchObject({ code: "plan_limit_reached" });
  })));

  test("an interrupted native generation retries on the same count and a sealed completion finalizes it atomically", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { owner, workspace: ws } = await workspace("pro", "dub-crash");
    const { project, clip } = await dubbableProject(ws.id, owner.id), scope = { actorUserId: owner.id, workspaceId: ws.id };
    const admitted = await dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id));
    const reservation = await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: admitted.dub.id } });
    const first = await startDubbingTestExecution(prisma, admitted.workflowRunId!);
    await first.command("fail", { failureCode: "native_lost_before_provider", retryable: true });
    expect(await prisma.clipDub.findUniqueOrThrow({ where: { id: admitted.dub.id } })).toMatchObject({ status: "queued" });
    expect(await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: admitted.dub.id } })).toMatchObject({ id: reservation.id, status: "reserved" });
    await prisma.workflowRun.update({ where: { id: admitted.workflowRunId! }, data: { nextAttemptAt: new Date(0) } });
    const retry = await startDubbingTestExecution(prisma, admitted.workflowRunId!);
    await retry.complete();
    const completed = await prisma.clipDub.findUniqueOrThrow({ where: { id: admitted.dub.id } });
    expect(completed).toMatchObject({ status: "completed", workflowRunId: admitted.workflowRunId });
    expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: admitted.workflowRunId! } })).toMatchObject({ status: "completed", attemptCount: 2 });
    expect(await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: admitted.dub.id } })).toMatchObject({ id: reservation.id, status: "finalized", actualUnits: 1 });
    await retry.command("fail", { failureCode: "late_failure_after_commit", retryable: true });
    expect(await prisma.clipDub.findUniqueOrThrow({ where: { id: admitted.dub.id } })).toEqual(completed);
    expect(await dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id))).toMatchObject({ dub: { id: admitted.dub.id, status: "completed" }, workflowRunId: null });
    expect((await summarizeGenerationUsage(ws.id)).dubs).toMatchObject({ used: 1, finalized: 1, reserved: 0 });
  })));

  test("native permission and sealed completion both require the accepted Dub's live count", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { owner, workspace: ws } = await workspace("pro", "dub-guards"), scope = { actorUserId: owner.id, workspaceId: ws.id };
    const { project, clip } = await dubbableProject(ws.id, owner.id);
    const admitted = await dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id));
    const execution = await startDubbingTestExecution(prisma, admitted.workflowRunId!);
    await prisma.generatedMediaUsageReservation.update({ where: { jobId: admitted.dub.id }, data: { status: "released" } });
    await expect(execution.complete()).rejects.toMatchObject({ code: "generated_media_usage_reconciliation_required" });
    expect(await prisma.clipDub.findUniqueOrThrow({ where: { id: admitted.dub.id } })).toMatchObject({ status: "processing", outcomeArtifactId: null });
    await execution.command("fail", { failureCode: "dubbing_failed", retryable: false });
    const unreserved = await dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id));
    await prisma.generatedMediaUsageReservation.update({ where: { jobId: unreserved.dub.id }, data: { status: "released" } });
    await expect(startDubbingTestExecution(prisma, unreserved.workflowRunId!)).rejects.toMatchObject({ code: "authority_lost" });
    expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: unreserved.workflowRunId! } })).toMatchObject({ attemptCount: 0, attemptId: null, leaseOwner: null });
    expect(await prisma.executionAttempt.findFirstOrThrow({ where: { dispatch: { subjectId: unreserved.workflowRunId! } } })).toMatchObject({ owner: null, processStartedAt: null });
    const other = await dubbableProject(ws.id, owner.id), known = await dubbingService.requestClipDub(scope, other.project.id, randomUUID(), dubInput(other.clip.id));
    const failed = await startDubbingTestExecution(prisma, known.workflowRunId!);
    await failed.command("fail", { failureCode: "dubbing_failed", retryable: false });
    expect(await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: known.dub.id } })).toMatchObject({ status: "released", reason: "dubbing_failed" });
  })));

  test("late known-failure settlement cannot release a deliberately accepted replacement Dub", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { owner, workspace: ws } = await workspace("pro", "dub-late-release"), scope = { actorUserId: owner.id, workspaceId: ws.id };
    const { project, clip } = await dubbableProject(ws.id, owner.id);
    const first = await dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id));
    const execution = await startDubbingTestExecution(prisma, first.workflowRunId!);
    await execution.command("fail", { failureCode: "translation_rejected", retryable: false });
    const replacement = await dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id));
    expect(replacement.dub.id).not.toBe(first.dub.id);
    const reservation = await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: replacement.dub.id } });
    await prisma.$transaction(tx => releaseFailedDubUsage(tx, { projectId: project.id, workflowRunId: first.workflowRunId!, attemptId: execution.fence.attemptToken, reason: "late_failure" }));
    expect(await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: replacement.dub.id } })).toEqual(reservation);
    await (await startDubbingTestExecution(prisma, replacement.workflowRunId!)).complete();
    expect(await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: replacement.dub.id } })).toMatchObject({ status: "finalized", actualUnits: 1 });
  })));

  test("an ambiguous paid Dub keeps its reservation and refuses a fresh request for the same tuple", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { owner, workspace: ws } = await workspace("pro", "dub-unknown"), scope = { actorUserId: owner.id, workspaceId: ws.id };
    const { project, clip } = await dubbableProject(ws.id, owner.id);
    const admitted = await dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id));
    const execution = await startDubbingTestExecution(prisma, admitted.workflowRunId!);
    await execution.translationIntent();
    await execution.command("fail", { failureCode: "native_connection_lost", retryable: true });
    await prisma.$transaction(tx => releaseFailedDubUsage(tx, { projectId: project.id, workflowRunId: admitted.workflowRunId!, attemptId: execution.fence.attemptToken, reason: "dub_failed" }));
    await reconcileGenerationUsageReservations(new Date(Date.now() + DAY_MS));
    expect(await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: admitted.dub.id } })).toMatchObject({ status: "reserved", reason: null });
    await expect(dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id))).rejects.toMatchObject({ code: "dubbing_outcome_unknown" });
    expect(await prisma.clipDub.findUniqueOrThrow({ where: { id: admitted.dub.id } })).toMatchObject({ status: "unknown", errorCode: "dub_provider_outcome_unknown", workflowRunId: admitted.workflowRunId });
    await expect(Promise.resolve(prisma.clipDub.update({ where: { id: admitted.dub.id }, data: { status: "queued", errorCode: null } }))).rejects.toThrow("Unknown paid dubbing outcome is immutable");
    expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: admitted.workflowRunId! } })).toMatchObject({ status: "failed", attemptCount: 1, requestedCount: 1, failedCount: 1 });
  })));

  test("a deliberate known-failed dub creates a new frozen request and retains both reservation histories before an unknown outcome blocks the tuple", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { owner, workspace: ws } = await workspace("pro", "dub-history");
    const { project, clip } = await dubbableProject(ws.id, owner.id);
    const scope = { actorUserId: owner.id, workspaceId: ws.id };
    const first = await dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id));
    let current = await startDubbingTestExecution(prisma, first.workflowRunId!);
    await current.command("fail", { failureCode: "openai_request_rejected", retryable: false });
    await prisma.clip.update({ where: { id: clip.id }, data: { hookText: "A deliberately revised script" } });
    const second = await dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id));
    expect(second.dub.id).not.toBe(first.dub.id);
    expect(await prisma.clipDub.findUniqueOrThrow({ where: { id: first.dub.id } })).toMatchObject({ status: "failed", workflowRunId: first.workflowRunId, frozenRequest: { script: "A strong hook", targetLanguageCode: "es", voice: "marin" } });
    expect(await prisma.clipDub.findUniqueOrThrow({ where: { id: second.dub.id } })).toMatchObject({ status: "queued", workflowRunId: second.workflowRunId, frozenRequest: { script: "A deliberately revised script", targetLanguageCode: "es", voice: "marin" } });
    await expect(Promise.resolve(prisma.clipDub.update({ where: { id: first.dub.id }, data: { voice: "coral" } }))).rejects.toThrow("Accepted dubbing request is immutable");
    await expect(Promise.resolve(prisma.clipDub.update({ where: { id: first.dub.id }, data: { status: "queued", errorCode: null } }))).rejects.toThrow("Terminal dubbing request history is immutable");
    expect(await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: first.dub.id } })).toMatchObject({ status: "released", reason: "openai_request_rejected" });
    expect(await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: second.dub.id } })).toMatchObject({ status: "reserved", reason: null });
    current = await startDubbingTestExecution(prisma, second.workflowRunId!);
    await current.translationIntent();
    await current.command("fail", { failureCode: "native_connection_lost", retryable: true });
    await expect(dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id))).rejects.toMatchObject({ code: "dubbing_outcome_unknown" });
    expect(await prisma.clipDub.count({ where: { clipId: clip.id } })).toBe(2);
    expect((await summarizeGenerationUsage(ws.id)).dubs).toMatchObject({ used: 1, reserved: 1, finalized: 0 });
  })));

  test("the sweep never releases a queued dub and settles terminal or deleted ones", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    const { owner, workspace: ws } = await workspace("business", "dub-sweep");
    const scope = { actorUserId: owner.id, workspaceId: ws.id };
    const queued = await dubbableProject(ws.id, owner.id);
    const failedLive = await dubbableProject(ws.id, owner.id);
    const failedDone = await dubbableProject(ws.id, owner.id);
    const deleted = await dubbableProject(ws.id, owner.id);
    const admit = (target: typeof queued) =>
      dubbingService.requestClipDub(scope, target.project.id, randomUUID(), dubInput(target.clip.id));
    const [queuedDub, liveDub, doneDub, deletedDub] = [
      await admit(queued),
      await admit(failedLive),
      await admit(failedDone),
      await admit(deleted),
    ];
    await prisma.clipDub.updateMany({ where: { id: { in: [liveDub.dub.id, doneDub.dub.id] } }, data: { status: "failed" } });
    await prisma.workflowRun.update({ where: { id: doneDub.workflowRunId! }, data: { status: "partial" } });
    await prisma.workflowRun.deleteMany({ where: { projectId: deleted.project.id } });
    await prisma.project.delete({ where: { id: deleted.project.id } });
    await prisma.generatedMediaUsageReservation.updateMany({
      where: { workspaceId: ws.id },
      data: { createdAt: new Date(Date.now() - 7 * DAY_MS) },
    });

    await reconcileGenerationUsageReservations();
    const status = async (jobId: string) =>
      (await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId } })).status;
    expect(await status(queuedDub.dub.id)).toBe("reserved");
    expect(await status(liveDub.dub.id)).toBe("reserved");
    expect(await status(doneDub.dub.id)).toBe("released");
    expect(await status(deletedDub.dub.id)).toBe("finalized");
  })));

  test("a new Free Project gets its 72-hour deadline with no retention configuration", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    for (const key of ["PROJECT_RETENTION_MODE", "PROJECT_RETENTION_ENFORCEMENT_STARTED_AT"]) delete process.env[key];
    const free = await workspace("free", "retention");
    const paid = await workspace("pro", "retention-paid");
    const createdAt = new Date("2026-10-26T12:00:00.000Z");
    expect(await projectRetentionService.assignmentForWorkspace(prisma, free.workspace.id, createdAt)).toEqual({
      retentionPolicyKey: "free_project_v1",
      expiresAt: new Date(createdAt.getTime() + 72 * 60 * 60 * 1000),
    });
    expect(await projectRetentionService.assignmentForWorkspace(prisma, paid.workspace.id, createdAt)).toBeNull();
  })));
});
