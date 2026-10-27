import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { processingPeriodStart } from "@narriflow/validators";
import { Pool } from "pg";
import { dubbingService } from "./dubbing.service";
import type { GeneratedMediaJobRecord } from "./generated-media";
import { prismaGeneratedMediaStore } from "./generated-media-prisma-store";
import {
  createPrismaGenerationUsageLedger,
  reconcileGenerationUsageReservations,
  releaseFailedDubUsage,
  summarizeGenerationUsage,
} from "./generated-media-usage-ledger";
import { projectRetentionService } from "./project-retention.service";
import { WorkflowFailure, WorkflowRunLifecycle } from "./workflow-run-lifecycle";

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
  const prismaGlobal = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
  let priorPrisma: PrismaClient | undefined;
  const ledger = createPrismaGenerationUsageLedger();
  const now = new Date();
  const currentPeriod = processingPeriodStart(now);
  const previousPeriod = processingPeriodStart(new Date(currentPeriod.getTime() - DAY_MS));

  beforeAll(() => {
    if (!databaseUrl) throw new Error("Vizard expansion test database is required");
    pool = new Pool({
      connectionString: databaseUrl,
      max: 12,
      options: databaseSchema ? `-csearch_path=${databaseSchema}` : undefined,
    });
    prisma = new PrismaClient({
      adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined),
    });
    priorPrisma = prismaGlobal.narriflowPrismaClient;
    prismaGlobal.narriflowPrismaClient = prisma;
  });

  afterAll(async () => {
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

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

  /** Leaves exactly one claimable dubbing run in the schema. */
  async function claimOnly(runId: string) {
    await prisma.workflowRun.updateMany({
      where: { stage: "dubbing", status: { in: ["queued", "running", "waiting"] }, id: { not: runId } },
      data: { status: "failed" },
    });
    await prisma.workflowRun.update({ where: { id: runId }, data: { nextAttemptAt: null } });
    const lifecycle = new WorkflowRunLifecycle({ prisma, leaseOwner: randomUUID() });
    const attempt = await lifecycle.claim("dubbing");
    if (!attempt || attempt.workflowRunId !== runId) throw new Error("dubbing claim missing");
    return { lifecycle, attempt };
  }

  const completedDubData = () => ({
    status: "completed" as const,
    transcriptText: "hello",
    translatedText: "hola",
    audioStorageKey: "test/dub.mp3",
    renderStorageKey: "test/dub.mp4",
    audioSizeBytes: 10n,
    renderSizeBytes: 20n,
    durationSec: 10,
    model: "test",
    errorCode: null,
    completedAt: new Date(),
  });

  function imageRecord(input: {
    id: string;
    reservationId: string;
    workspaceId: string;
    actorUserId: string;
    projectId: string;
  }): GeneratedMediaJobRecord {
    return {
      id: input.id,
      scope: {
        actorUserId: input.actorUserId,
        workspaceId: input.workspaceId,
        workspaceOwnerUserId: input.actorUserId,
        role: "owner",
        status: "active",
        pricingTier: "creator",
        isPersonalWorkspace: true,
      },
      projectId: input.projectId,
      clipId: null,
      mediaKind: "image",
      idempotencyKey: `generation-${randomUUID()}`,
      requestFingerprint: "fingerprint",
      protectedPrompt: "protected",
      promptFingerprint: "prompt-fingerprint",
      promptOrigin: "manual",
      sourceStartSec: null,
      sourceEndSec: null,
      sourceCueAtSec: null,
      aspectRatio: "9:16",
      style: "editorial",
      title: "Generated editorial frame",
      status: "queued",
      moderationStatus: "pending",
      usageStatus: "reserved",
      usageReservationId: input.reservationId,
      provider: "openai",
      providerModel: "test",
      providerRef: null,
      providerUsageImages: null,
      providerResultContentType: null,
      resultAsset: null,
      attempt: 0,
      retryAt: null,
      claimId: null,
      claimExpiresAt: null,
      errorCode: null,
      outcomeUnknown: false,
      insertedAt: null,
      brandSavedAt: null,
      promptExpiresAt: new Date(Date.now() + 30 * DAY_MS),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  const reserveImage = (workspaceId: string, actorUserId: string, pricingTier: string) =>
    ledger.reserve({ kind: "image", jobId: randomUUID(), workspaceId, actorUserId, pricingTier });

  test("the last image of the month goes to exactly one of several concurrent requests", async () => {
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
  });

  test("image concurrency spans periods while counts stay pinned to their admission month", async () => {
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
  });

  test("a Free refusal after paid images this month offers a plan with room for them", async () => {
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
  });

  test("the Free image sample is lifetime, ignores paid history, and survives upgrade and downgrade", async () => {
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
  });

  test("attaching an image job requires its own image reservation in the same Workspace", async () => {
    const { owner, workspace: ws } = await workspace("creator", "attach");
    const other = await workspace("creator", "attach-other");
    const { project } = await dubbableProject(ws.id, owner.id);
    const id = randomUUID();
    const reservation = await ledger.reserve({
      kind: "image",
      jobId: id,
      workspaceId: other.workspace.id,
      actorUserId: other.owner.id,
      pricingTier: "creator",
    });
    await expect(
      prismaGeneratedMediaStore.create(
        imageRecord({ id, reservationId: reservation.reservationId, workspaceId: ws.id, actorUserId: owner.id, projectId: project.id }),
      ),
    ).rejects.toMatchObject({ code: "generated_media_usage_reconciliation_required" });
    const dubReservation = randomUUID();
    await prisma.generatedMediaUsageReservation.create({
      data: { id: dubReservation, jobId: randomUUID(), kind: "dub", workspaceId: ws.id, policy: "metered", periodStart: currentPeriod },
    });
    await expect(
      prismaGeneratedMediaStore.create(
        imageRecord({ id: randomUUID(), reservationId: dubReservation, workspaceId: ws.id, actorUserId: owner.id, projectId: project.id }),
      ),
    ).rejects.toMatchObject({ code: "generated_media_usage_reconciliation_required" });
    // A released image reservation cannot be replayed as active.
    await ledger.release({ jobId: id, reservationId: reservation.reservationId, reason: "test" });
    await expect(
      ledger.reserve({ kind: "image", jobId: id, workspaceId: other.workspace.id, actorUserId: other.owner.id, pricingTier: "creator" }),
    ).rejects.toMatchObject({ code: "generated_media_usage_reconciliation_required" });
  });

  test("the sweep releases admission orphans, keeps unknown outcomes reserved, and never refunds deletion", async () => {
    const { owner, workspace: ws } = await workspace("creator", "sweep-images");
    const { project } = await dubbableProject(ws.id, owner.id);
    const orphan = await reserveImage(ws.id, owner.id, "creator");
    const unknownId = randomUUID();
    const unknown = await ledger.reserve({ kind: "image", jobId: unknownId, workspaceId: ws.id, actorUserId: owner.id, pricingTier: "creator" });
    await prismaGeneratedMediaStore.create(
      imageRecord({ id: unknownId, reservationId: unknown.reservationId, workspaceId: ws.id, actorUserId: owner.id, projectId: project.id }),
    );
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
  });

  test("image claims fence expired owners and serialize cancellation with processing", async () => {
    const { owner, workspace: ws } = await workspace("creator", "image-claims");
    const { project } = await dubbableProject(ws.id, owner.id);
    const id = randomUUID();
    const reservation = await ledger.reserve({ kind: "image", jobId: id, workspaceId: ws.id, actorUserId: owner.id, pricingTier: "creator" });
    await prismaGeneratedMediaStore.create(
      imageRecord({ id, reservationId: reservation.reservationId, workspaceId: ws.id, actorUserId: owner.id, projectId: project.id }),
    );
    const startedAt = new Date();
    const expiredAt = new Date(startedAt.getTime() + 1_000);
    const firstClaim = randomUUID();
    const secondClaim = randomUUID();
    expect(await prismaGeneratedMediaStore.claim(id, firstClaim, startedAt, 1_000)).not.toBeNull();
    await expect(prismaGeneratedMediaStore.updateClaimed(id, firstClaim, { status: "failed", updatedAt: expiredAt }))
      .rejects.toMatchObject({ code: "generated_media_claim_lost" });
    expect(await prismaGeneratedMediaStore.claim(id, secondClaim, expiredAt, 1_000)).not.toBeNull();
    await expect(prismaGeneratedMediaStore.updateClaimed(id, firstClaim, { status: "failed", updatedAt: expiredAt }))
      .rejects.toMatchObject({ code: "generated_media_claim_lost" });
    await prismaGeneratedMediaStore.updateClaimed(id, secondClaim, { claimId: null, claimExpiresAt: null, updatedAt: expiredAt });

    await prismaGeneratedMediaStore.update(id, { status: "running" });
    expect(await prismaGeneratedMediaStore.claim(id, randomUUID(), expiredAt, 1_000, "cancel")).toBeNull();
    await prismaGeneratedMediaStore.update(id, { status: "queued", providerUsageImages: 1 });
    expect(await prismaGeneratedMediaStore.claim(id, randomUUID(), expiredAt, 1_000, "cancel")).toBeNull();
    await prismaGeneratedMediaStore.update(id, { providerUsageImages: null });
    await prismaGeneratedMediaStore.update(id, { outcomeUnknown: true });
    expect(await prismaGeneratedMediaStore.claim(id, randomUUID(), expiredAt, 1_000)).toBeNull();
    expect(await prismaGeneratedMediaStore.claim(id, randomUUID(), expiredAt, 1_000, "cancel")).toBeNull();
    await prismaGeneratedMediaStore.update(id, { outcomeUnknown: false, retryAt: new Date(expiredAt.getTime() + 60_000) });
    expect(await prismaGeneratedMediaStore.claim(id, randomUUID(), expiredAt, 1_000)).toBeNull();
    const cancellationClaim = randomUUID();
    expect(await prismaGeneratedMediaStore.claim(id, cancellationClaim, expiredAt, 1_000, "cancel")).not.toBeNull();
    expect(await prismaGeneratedMediaStore.claim(id, randomUUID(), expiredAt, 1_000, "cancel")).toBeNull();
    await prismaGeneratedMediaStore.updateClaimed(id, cancellationClaim, {
      status: "cancelled", claimId: null, claimExpiresAt: null, updatedAt: expiredAt,
    });
    await ledger.release({ jobId: id, reservationId: reservation.reservationId, reason: "test_cancelled" });
  });

  test("deleting the actor, output, or Project never refunds a finalized count", async () => {
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
  });

  test("dubbing needs the plan, a short enough clip, and an unexhausted month", async () => {
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
  });

  test("the last dub of the month goes to one of two members racing on different Projects", async () => {
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
  });

  test("a concurrent idempotent dub request admits one dub, one run, and one count", async () => {
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
  });

  test("a failed dub re-request is counted again in the current month", async () => {
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

    // With room this month, the same dub is re-admitted on its one reservation row.
    await prisma.generatedMediaUsageReservation.deleteMany({ where: { workspaceId: ws.id, jobId: { not: first.dub.id } } });
    await prefill({ workspaceId: ws.id, kind: "dub", count: 9 });
    const again = await dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id));
    expect(again.dub).toMatchObject({ id: first.dub.id, status: "queued" });
    expect(again.workflowRunId).not.toBe(first.workflowRunId);
    expect(
      await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: first.dub.id } }),
    ).toMatchObject({ status: "reserved", periodStart: currentPeriod, reason: null });
    expect((await summarizeGenerationUsage(ws.id)).dubs).toMatchObject({ used: 10, remaining: 0 });

    // A failure still settling (reserved from last month) is not a free pass either.
    await prisma.workflowRun.update({ where: { id: again.workflowRunId! }, data: { status: "failed" } });
    await prisma.clipDub.update({ where: { id: first.dub.id }, data: { status: "failed" } });
    await prisma.generatedMediaUsageReservation.update({ where: { jobId: first.dub.id }, data: { periodStart: previousPeriod } });
    await prefill({ workspaceId: ws.id, kind: "dub", count: 1 });
    await expect(
      dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id)),
    ).rejects.toMatchObject({ code: "plan_limit_reached" });
  });

  test("a worker crash before completion retries on the same count; completion finalizes atomically", async () => {
    const { owner, workspace: ws } = await workspace("pro", "dub-crash");
    const { project, clip } = await dubbableProject(ws.id, owner.id);
    const admitted = await dubbingService.requestClipDub({ actorUserId: owner.id, workspaceId: ws.id }, project.id, randomUUID(), dubInput(clip.id));
    const reservation = await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: admitted.dub.id } });

    // Crash mid-provider call: the reaper's retryable failure requeues the dub.
    let { lifecycle, attempt } = await claimOnly(admitted.workflowRunId!);
    expect((await lifecycle.markDubProcessing(attempt, admitted.dub.id)).count).toBe(1);
    await lifecycle.failAttempt(attempt, new WorkflowFailure("worker_lost", "retryable", "lost"));
    expect(await prisma.clipDub.findUniqueOrThrow({ where: { id: admitted.dub.id } })).toMatchObject({ status: "queued" });
    expect(
      await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: admitted.dub.id } }),
    ).toMatchObject({ id: reservation.id, status: "reserved" });

    ({ lifecycle, attempt } = await claimOnly(admitted.workflowRunId!));
    expect((await lifecycle.markDubProcessing(attempt, admitted.dub.id)).count).toBe(1);
    expect((await lifecycle.completeDub(attempt, admitted.dub.id, completedDubData())).count).toBe(1);
    expect(
      await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: admitted.dub.id } }),
    ).toMatchObject({ id: reservation.id, status: "finalized", actualUnits: 1 });

    // Crash after completion: the retry leaves the completed dub and its count alone.
    await lifecycle.failAttempt(attempt, new WorkflowFailure("worker_lost", "retryable", "lost"));
    expect(await prisma.clipDub.findUniqueOrThrow({ where: { id: admitted.dub.id } })).toMatchObject({ status: "completed" });
    const replay = await dubbingService.requestClipDub({ actorUserId: owner.id, workspaceId: ws.id }, project.id, randomUUID(), dubInput(clip.id));
    expect(replay).toMatchObject({ dub: { id: admitted.dub.id, status: "completed" }, workflowRunId: null });
    expect((await summarizeGenerationUsage(ws.id)).dubs).toMatchObject({ used: 1, finalized: 1, reserved: 0 });
  });

  test("no dub runs or completes without its live count, and a terminal failure releases it", async () => {
    const { owner, workspace: ws } = await workspace("pro", "dub-guards");
    const { project, clip } = await dubbableProject(ws.id, owner.id);
    const scope = { actorUserId: owner.id, workspaceId: ws.id };
    const admitted = await dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id));
    let { lifecycle, attempt } = await claimOnly(admitted.workflowRunId!);
    expect((await lifecycle.markDubProcessing(attempt, admitted.dub.id)).count).toBe(1);
    // The count disappeared mid-flight (operator release): completion refuses free output.
    await prisma.generatedMediaUsageReservation.update({ where: { jobId: admitted.dub.id }, data: { status: "released" } });
    await expect(lifecycle.completeDub(attempt, admitted.dub.id, completedDubData())).rejects.toMatchObject({
      code: "generated_media_usage_reconciliation_required",
    });
    expect(await prisma.clipDub.findUniqueOrThrow({ where: { id: admitted.dub.id } })).toMatchObject({ status: "processing" });
    await lifecycle.failAttempt(attempt, new WorkflowFailure("dubbing_failed", "permanent", "failed"));

    // A queued dub without a count is failed before any provider call.
    const orphan = await prisma.clipDub.create({
      data: { projectId: project.id, clipId: clip.id, aspectRatio: "ratio_9_16", targetLanguageCode: "de", voice: "marin", model: "test" },
    });
    const run = await prisma.workflowRun.create({
      data: { projectId: project.id, idempotencyKey: randomUUID(), stage: "dubbing", status: "queued" },
    });
    ({ lifecycle, attempt } = await claimOnly(run.id));
    expect((await lifecycle.markDubProcessing(attempt, orphan.id)).count).toBe(0);
    expect(await prisma.clipDub.findUniqueOrThrow({ where: { id: orphan.id } })).toMatchObject({
      status: "failed",
      errorCode: "dub_usage_not_reserved",
    });
    await lifecycle.completeDubbing(attempt);

    // A permanent failure of the run releases the count in the same transaction.
    const retried = await dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id));
    expect(retried.dub.id).toBe(admitted.dub.id);
    ({ lifecycle, attempt } = await claimOnly(retried.workflowRunId!));
    expect((await lifecycle.markDubProcessing(attempt, admitted.dub.id)).count).toBe(1);
    await lifecycle.failDub(attempt, admitted.dub.id, "openai_tts_failed");
    await lifecycle.failAttempt(attempt, new WorkflowFailure("dubbing_failed", "permanent", "failed"));
    expect(
      await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: admitted.dub.id } }),
    ).toMatchObject({ status: "released", reason: "dubbing_failed" });
  });

  test("a partial run releases its failed dub, but not one re-admitted before the release", async () => {
    const { owner, workspace: ws } = await workspace("pro", "dub-partial");
    const { project, clip } = await dubbableProject(ws.id, owner.id);
    const scope = { actorUserId: owner.id, workspaceId: ws.id };
    const runPartial = async () => {
      const admitted = await dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id));
      // A second tuple accepted into the same run.
      const sibling = await prisma.clipDub.upsert({
        where: {
          clipId_targetLanguageCode_voice_aspectRatio: {
            clipId: clip.id, targetLanguageCode: "fr", voice: "marin", aspectRatio: "ratio_9_16",
          },
        },
        create: { projectId: project.id, clipId: clip.id, aspectRatio: "ratio_9_16", targetLanguageCode: "fr", voice: "marin", model: "test" },
        update: { status: "queued", workflowAttemptId: null },
      });
      await prisma.generatedMediaUsageReservation.upsert({
        where: { jobId: sibling.id },
        create: { jobId: sibling.id, kind: "dub", workspaceId: ws.id, policy: "metered", periodStart: currentPeriod, attachedAt: new Date() },
        update: { status: "reserved" },
      });
      const { lifecycle, attempt } = await claimOnly(admitted.workflowRunId!);
      expect((await lifecycle.markDubProcessing(attempt, sibling.id)).count).toBe(1);
      expect((await lifecycle.completeDub(attempt, sibling.id, completedDubData())).count).toBe(1);
      expect((await lifecycle.markDubProcessing(attempt, admitted.dub.id)).count).toBe(1);
      await lifecycle.failDub(attempt, admitted.dub.id, "openai_tts_failed");
      return { admitted, lifecycle, attempt };
    };

    // Uninterrupted: completing the run releases the failed dub's count.
    const first = await runPartial();
    await first.lifecycle.completeDubbing(first.attempt);
    expect(await prisma.workflowRun.findUniqueOrThrow({ where: { id: first.admitted.workflowRunId! } })).toMatchObject({ status: "partial" });
    expect(
      await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: first.admitted.dub.id } }),
    ).toMatchObject({ status: "released", reason: "dub_failed" });

    // Interleaved: the run settles, the user re-requests the failed dub, then the release step runs.
    await prisma.clipDub.updateMany({ where: { projectId: project.id }, data: { status: "failed" } });
    const second = await runPartial();
    await second.lifecycle.completeAggregateStage(second.attempt, { requestedCount: 2, succeededCount: 1, failedCount: 1 });
    const readmitted = await dubbingService.requestClipDub(scope, project.id, randomUUID(), dubInput(clip.id));
    expect(readmitted.dub).toMatchObject({ id: second.admitted.dub.id, status: "queued" });
    await prisma.$transaction((tx) =>
      releaseFailedDubUsage(tx, { projectId: project.id, attemptId: second.attempt.attemptId, reason: "dub_failed" }),
    );
    expect(
      await prisma.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: second.admitted.dub.id } }),
    ).toMatchObject({ status: "reserved", reason: null });
    // The accepted retry still runs on its count.
    const { lifecycle, attempt } = await claimOnly(readmitted.workflowRunId!);
    expect((await lifecycle.markDubProcessing(attempt, second.admitted.dub.id)).count).toBe(1);
  });

  test("the sweep never releases a queued dub and settles terminal or deleted ones", async () => {
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
  });

  test("a new Free Project gets its 72-hour deadline with no retention configuration", async () => {
    for (const key of ["PROJECT_RETENTION_MODE", "PROJECT_RETENTION_ENFORCEMENT_STARTED_AT"]) delete process.env[key];
    const free = await workspace("free", "retention");
    const paid = await workspace("pro", "retention-paid");
    const createdAt = new Date("2026-10-26T12:00:00.000Z");
    expect(await projectRetentionService.assignmentForWorkspace(free.workspace.id, createdAt)).toEqual({
      retentionPolicyKey: "free_project_v1",
      expiresAt: new Date(createdAt.getTime() + 72 * 60 * 60 * 1000),
    });
    expect(await projectRetentionService.assignmentForWorkspace(paid.workspace.id, createdAt)).toBeNull();
  });
});
