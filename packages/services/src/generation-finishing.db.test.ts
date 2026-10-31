import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { ruleFingerprint } from "./standing-grant";
import type { AutopilotFinishingAuthority } from "@narriflow/validators/autopilot-finishing-authority";
import { bindServiceTestEnvironment } from "./runtime-test-support";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { RenderFixtureLifecycle } from "./render-group-test-fixture";
import type { WorkflowAttemptRef } from "./workflow-run-lifecycle";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { creditDebitSeconds, finishingReasonMessage, parseStoredContentPack, processingPeriodStart, finishingSettingsSchema, type FinishingSettingsInput } from "@narriflow/validators";
import { AssistedSocialCopyError } from "./assisted-social-copy";
import { clipExportService } from "./clip-export.service";
import {
  createGenerationFinishing,
  queueGenerationFinishing,
  finishingCopyKey,
  finishingExportKey,
  FINISHING_MAX_WAIT_MS,
  readProjectFinishing,
  type GenerationFinishingDependencies,
} from "./generation-finishing";
import { NotificationService } from "./notification.service";
import { publishingQueue } from "./publishing-queue.service";
import { encodeOperationId } from "./operation-status";
import { projectService } from "./project.service";
import { acceptProposalUnderGrant, sendReviewRoundUnderGrant, standingGrants } from "./standing-grant-runtime";
import { listWorkspaceEvents } from "./workspace-event";
import { workspaceService } from "./workspace.service";

const databaseUrl = process.env.SERVERLESS_TEST_DATABASE_URL;
const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && Boolean(databaseUrl);
const describeDb = enabled ? describe : describe.skip;
setDefaultTimeout(180_000);
const FINISHING = { topClips: 2, minScore: 50, aspectRatios: ["9:16", "1:1"], resolution: "1080p", copyPlatforms: ["tiktok", "x"], delivery: "ready_to_review" } as const;

describeDb("Finishing runner on PostgreSQL", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const globalPrisma = createDatabaseTestContext();
  const fixtureIds: string[] = [];

  beforeAll(bindServiceTestEnvironment(globalPrisma.bind(() => {
    assertExecutionDatabaseTestTarget(databaseUrl, schema ?? "public");
    if (!schema?.startsWith("serverless_execution_test_")) throw Error("A disposable execution schema is required");
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), transactionOptions: { maxWait: 120_000, timeout: 120_000 } });
    priorPrisma = globalPrisma.client;
    globalPrisma.client = prisma;
  })));
  beforeEach(() => { fixtureIds.length = 0; renderFixtures.clear(); });
  afterAll(bindServiceTestEnvironment(globalPrisma.bind(async () => {
    globalPrisma.client = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  })));

  async function workspace(pricingTier: "business" | "pro" | "creator" = "business") {
    const user = await prisma.user.create({ data: { clerkId: `finishing-runner:${randomUUID()}` } });
    const created = await prisma.workspace.create({ data: { name: "Finishing", ownerUserId: user.id, pricingTier, members: { create: { userId: user.id, role: "owner" } } } });
    return { user, workspaceId: created.id, scope: { actorUserId: user.id, workspaceId: created.id } };
  }
  type Owner = Awaited<ReturnType<typeof workspace>>;

  /** The credit reservation every accepted intake holds; `settled` once its speech-to-text was admitted. */
  const usage = (owner: Owner, project: { id: string; sourceDurationSeconds: number | null }, state: "reserved" | "settled") => {
    const seconds = creditDebitSeconds(project.sourceDurationSeconds ?? 0);
    return prisma.processingUsageReservation.create({ data: { projectId: project.id, workspaceId: owner.workspaceId, actorUserId: owner.user.id, intakeKind: "upload",
      periodStart: processingPeriodStart(new Date()), reservedSeconds: seconds, ...(state === "settled" ? { state, settledSeconds: seconds, settledAt: new Date() } : { state }) } });
  };

  const PACK = { outputTypes: ["short_clip" as const], clipCountTarget: 5, clipDurationSecTarget: 30, platformPlaybookVersion: "test", defaultAspectRatio: "1:1" as const };

  /** A finished generation: committed pack, completed transcript, speech-to-text and detection runs, and clips with these scores. */
  async function finishedGeneration(owner: Owner, scores: number[], finishing: FinishingSettingsInput | null = FINISHING, frozen: { actorUserId?: string; dueAt?: Date; autopilotRuleId?: string; autopilotAuthority?: AutopilotFinishingAuthority } = {}) {
    const project = await prisma.project.create({ data: { workspaceId: owner.workspaceId, createdByUserId: owner.user.id, title: "Generated", sourceMediaUrl: "https://example.test/source.mp4",
      sourceDurationSeconds: 120, ingestStatus: "ready", languageCode: "en" } });
    await usage(owner, project, "settled");
    const pack = await prisma.contentPack.create({ data: { projectId: project.id, outputTypes: ["short_clip"], clipGenerationMode: "best", clipCountTarget: 5, clipDurationSecTarget: 30,
      platformTargets: ["tiktok"], toneConstraints: [], captionPreset: "brand_default", platformPlaybookVersion: "test", defaultAspectRatio: "1:1" } });
    const stt = await prisma.workflowRun.create({ data: { projectId: project.id, stage: "stt", status: "completed", idempotencyKey: `stt:${randomUUID()}`, contentPackId: pack.id } });
    await prisma.transcript.create({ data: { projectId: project.id, status: "completed", provider: "elevenlabs", providerModel: "test" } });
    const detection = await prisma.workflowRun.create({ data: { projectId: project.id, stage: "moment_detection", status: "completed", idempotencyKey: `${stt.idempotencyKey}__moment_detection`, contentPackId: pack.id } });
    const clips = [];
    for (const [index, score] of scores.entries()) {
      clips.push(await prisma.clip.create({ data: { projectId: project.id, workflowRunId: detection.id, index, startSec: 0, endSec: 30, hookText: `Hook ${index}`, title: `Clip ${index}`, reasoning: "Complete story",
        category: "insight", transcriptSlice: [], viralityScore: score, hookStrengthScore: 80, emotionalIntensityScore: 60, pacingScore: 70, durationOptimalityScore: 90,
        tiktokScore: 80, youtubeScore: 80, instagramScore: 80, llmProvider: "test", llmModel: "test" } }));
    }
    let row = null;
    if (finishing) {
      row = await prisma.generationFinishing.create({ data: { workspaceId: owner.workspaceId, projectId: project.id, originRunId: stt.id, actorUserId: frozen.actorUserId ?? owner.user.id,
        deploymentEpoch: (await prisma.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch,
        settings: { ...finishingSettingsSchema.parse(finishing), aspectRatios: finishing.aspectRatios ?? ["1:1"] }, state: "due", dueAt: frozen.dueAt ?? new Date(),
        autopilotRuleId: frozen.autopilotRuleId ?? null, ...(frozen.autopilotAuthority ? { autopilotAuthority: frozen.autopilotAuthority } : {}) } });
      fixtureIds.push(row.id);
    }
    return { project, pack, stt, detection, clips, row: row! };
  }

  /** Real exports through the Clip Export service; copy and notification are recorded fakes. */
  function runner(overrides: Partial<GenerationFinishingDependencies> = {}) {
    const calls = { copy: [] as Array<Parameters<GenerationFinishingDependencies["writeCopy"]>[0]>, exports: [] as string[], notifications: [] as Array<{ projectId: string; sourceId: string; clipCount: number }> };
    const service = createGenerationFinishing({
      prisma,
      register: async () => {},
      requireActor: (userId, workspaceId) => workspaceService.requireActor(userId, workspaceId, "processing.consume"),
      canManagePublishing: (userId, workspaceId) => workspaceService.requireActor(userId, workspaceId, "publishing.manage").then(() => true, () => false),
      createExport: async (scope, projectId, clipId, input, key) => {
        calls.exports.push(key);
        return clipExportService.create(scope, projectId, clipId, input, key);
      },
      retryExport: (scope, projectId, clipId, exportId) => clipExportService.retryFailed(scope, projectId, clipId, exportId),
      writeCopy: async (input) => {
        calls.copy.push(input);
        return { id: randomUUID() };
      },
      queueAccounts: (workspaceId, accountIds) => publishingQueue.activeAccounts(workspaceId, accountIds),
      propose: (input) => publishingQueue.propose(
        { actorUserId: input.actorUserId, workspaceId: input.workspaceId },
        { clipId: input.clipId, exportId: input.exportId, socialAccountId: input.socialAccountId },
        { source: "finishing", copyGenerationId: input.copyGenerationId, mutation: { clientIdempotencyKey: input.idempotencyKey } },
      ),
      acceptUnderGrant: acceptProposalUnderGrant,
      sendReviewRound: sendReviewRoundUnderGrant,
      notify: async (input) => {
        calls.notifications.push(input);
      },
      ...overrides,
    });
    return { service, calls };
  }

  const row = (id: string) => prisma.generationFinishing.findUniqueOrThrow({ where: { id } });
  /** Drives only fixture IDs already created by this test. No queue discovery or clock override. */
  async function drive(service: ReturnType<typeof createGenerationFinishing>, limit = 3, ids: readonly string[] = fixtureIds): Promise<number> {
    let handled = 0;
    for (const id of ids) {
      if (handled >= limit) break;
      let changed = false;
      for (let command = 0; command < 64; command++) {
        const before = await row(id);
        if (["ready", "partial", "skipped", "waiting"].includes(before.state)) break;
        const reference = await prisma.$transaction(tx => queueGenerationFinishing(tx,id));
        if (!reference) break;
        const outcome = await service.run(reference), after = await row(id);
        const facts = (value: typeof before) => JSON.stringify([value.generation,value.state,value.picks,value.attempts,value.reason,value.finishedAt]);
        const progress = facts(before) !== facts(after);
        if (outcome.kind === "complete") changed ||= progress;
        if (outcome.kind === "wait" && after.state === "exporting" && after.dueAt && after.operationDeadlineAt && outcome.dueAt.getTime() === Math.min(after.dueAt.getTime()+FINISHING_MAX_WAIT_MS,after.operationDeadlineAt.getTime())) changed ||= progress;
        if (outcome.kind === "wait" || outcome.kind === "sleep" || !progress) break;
        if (command === 63) throw Error("Finishing fixture exceeded finite command bound");
      }
      if (changed) handled++;
    }
    return handled;
  }

  const finishingEvents = async (workspaceId: string) => (await listWorkspaceEvents(prisma, { workspaceId }, { limit: 200 })).data.filter((event) => event.type === "finishing.finished");
  const lookAgain = (id: string) => prisma.generationFinishing.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
  type Pick = { clipId: string; editorRevision: number; exportId?: string; exportError?: string; copyAttempt?: number; copyError?: string; copyGenerationId?: string };
  const renderFixtures = new Map<string, { lifecycle: RenderFixtureLifecycle; attempt: WorkflowAttemptRef }>();
  async function settleExport(exportId: string, outcome: "completed" | "failed") {
    const exported = await prisma.clipExport.findUniqueOrThrow({ where: { id: exportId }, include: { variants: { include: { render: true } } } });
    let fixture = renderFixtures.get(exported.projectId);
    if (fixture && (await prisma.workflowRun.findUniqueOrThrow({ where: { id: fixture.attempt.workflowRunId } })).status !== "running") fixture = undefined;
    if (!fixture) {
      const attemptId = randomUUID();
      const leaseOwner = randomUUID();
      const queued = await prisma.workflowRun.findFirst({ where: { projectId: exported.projectId, stage: "clip_rendering", status: "queued" } });
      const data = { status: "running", attemptId, attemptCount: 1, leaseOwner, leaseExpiresAt: new Date(Date.now() + 120_000) };
      const run = queued ? await prisma.workflowRun.update({ where: { id: queued.id }, data }) : await prisma.workflowRun.create({ data: { projectId: exported.projectId, stage: "clip_rendering", idempotencyKey: randomUUID(), ...data } });
      fixture = { lifecycle: new RenderFixtureLifecycle({ prisma, leaseOwner }), attempt: { workflowRunId: run.id, projectId: exported.projectId, stage: "clip_rendering", attemptId, attemptCount: 1 } };
      renderFixtures.set(exported.projectId, fixture);
      await fixture.lifecycle.beginRenderWorkSet(fixture.attempt);
    }
    for (const variant of exported.variants) {
      const render = variant.render;
      if (!render || variant.status === outcome) continue;
      await fixture.lifecycle.markClipRenderVariantRendering(fixture.attempt, render.id);
      if (outcome === "completed") await fixture.lifecycle.completeClipRenderVariant(fixture.attempt, render.id, { storageKey: `exports/${exportId}/${render.id}.mp4`, sizeBytes: 1024, durationSec: 30 });
      else await fixture.lifecycle.failClipRenderVariant(fixture.attempt, render.id, "encode_failed", "permanent");
    }
    await fixture.lifecycle.settleRenderWorkSet(fixture.attempt);
  }
  const exportsOf = async (finishingId: string) => ((await row(finishingId)).picks as Pick[] | null) ?? [];

  test("picks the best clips at or above the minimum score, exports and writes copy for each exactly once, and ends ready", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const owner = await workspace();
    const g = await finishedGeneration(owner, [90, 40, 80, 70, 20]);
    const { service, calls } = runner();

    expect(await drive(service)).toBe(1);
    // Highest first, up to topClips, none below the minimum score.
    const picks = await exportsOf(g.row.id);
    expect(picks.map((pick) => pick.clipId)).toEqual([g.clips[0]!.id, g.clips[2]!.id]);
    expect(calls.exports).toEqual(picks.map((pick) => finishingExportKey(g.row.id, pick.clipId, pick.editorRevision)));
    expect(await prisma.clipExport.count({ where: { projectId: g.project.id } })).toBe(2);
    const created = await prisma.clipExport.findMany({ where: { projectId: g.project.id }, include: { variants: true } });
    for (const exported of created) {
      expect(exported.createdByUserId).toBe(owner.user.id);
      expect(exported.resolution).toBe("1080p");
      expect(exported.variants.map((variant) => variant.aspectRatio).sort()).toEqual(["ratio_1_1", "ratio_9_16"]);
    }
    // Renders are still queued: the row waits, unclaimed, and waiting costs no attempt.
    expect(await row(g.row.id)).toMatchObject({ state: "exporting", attempts: 0, claimToken: null });
    expect(calls.copy).toHaveLength(0);
    expect(await drive(service)).toBe(0);

    for (const pick of picks) await settleExport(pick.exportId!, "completed");
    expect(await drive(service)).toBe(1);

    const ended = await row(g.row.id);
    expect(ended).toMatchObject({ state: "ready", reason: null, claimToken: null, leaseExpiresAt: null });
    expect(ended.finishedAt).not.toBeNull();
    expect(calls.copy.map((call) => [call.clipId, call.platforms, call.idempotencyKey, call.actorUserId])).toEqual(
      picks.map((pick) => [pick.clipId, ["tiktok", "x"], finishingCopyKey(g.row.id, pick.clipId, 0), owner.user.id]),
    );
    expect(calls.notifications).toEqual([{ projectId: g.project.id, sourceId: g.row.id, clipCount: 2 }]);
    const events = await finishingEvents(owner.workspaceId);
    expect(events.map((event) => event.subject)).toEqual([{
      projectId: g.project.id,
      operation: { kind: "generation", id: encodeOperationId({ kind: "generation", id: g.stt.id }) },
      state: "ready",
      reason: null,
      exportIds: picks.map((pick) => pick.exportId),
    }]);
    expect(await drive(service)).toBe(0);

    const view = await readProjectFinishing(prisma, { workspaceId: owner.workspaceId, projectId: g.project.id });
    expect(view).toMatchObject({ state: "ready", message: null });
    expect(view?.clips.map((clip) => [clip.title, clip.exportStatus, clip.copyWritten])).toEqual([["Clip 0", "ready", true], ["Clip 2", "ready", true]]);
  })));

  describe("ranking with the Workspace's audience data", () => {
    const COMPUTED_AT = new Date("2026-10-23T03:00:00.000Z");
    const GROUPS = [
      { dimension: "category", key: "story", posts: 12, lift: 1.4 },
      { dimension: "category", key: "insight", posts: 12, lift: 0.6 },
    ];
    /** Clips 0 and 1 are insight and story at 80 and 70; clip 2 is a story below the minimum score. */
    async function setup(guidance: { groups: unknown[] } | null, setting: boolean | null = null, topClips = 1) {
      const owner = await workspace();
      const g = await finishedGeneration(owner, [80, 70, 45], { ...FINISHING, topClips, copyPlatforms: [] });
      await prisma.clip.updateMany({ where: { id: { in: [g.clips[1]!.id, g.clips[2]!.id] } }, data: { category: "story" } });
      if (guidance) await prisma.performanceGuidance.create({ data: { workspaceId: owner.workspaceId, computedAt: COMPUTED_AT, attemptedAt: COMPUTED_AT, totalPosts: 40, platforms: [], groups: guidance.groups as never } });
      if (setting !== null) await prisma.workspace.update({ where: { id: owner.workspaceId }, data: { usePerformanceGuidance: setting } });
      return { owner, g };
    }

    test("score times a bounded factor picks the clip, the factor is recorded, and the Project says so", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const { owner, g } = await setup({ groups: GROUPS });
      await drive(runner().service);
      // Plain scores would pick clip 0 (80); 70 x 1.25 beats 80 x 0.8.
      const picks = (await row(g.row.id).then((found) => found.picks)) as Array<Pick & { ranking?: unknown }>;
      expect(picks.map((pick) => pick.clipId)).toEqual([g.clips[1]!.id]);
      expect(picks[0]!.ranking).toEqual({
        score: 70,
        factor: 1.25,
        groups: [{ dimension: "category", label: "Category Story", lift: 1.4 }],
        guidanceComputedAt: COMPUTED_AT.toISOString(),
      });
      const view = await readProjectFinishing(prisma, { workspaceId: owner.workspaceId, projectId: g.project.id });
      expect(view?.rankedWithAudienceData).toBe(true);
      expect(view?.clips[0]?.ranking).toMatchObject({ score: 70, factor: 1.25 });
    })));

    test("a clip is measured by its edited length, the measure its clip facts use", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      // Under 20 seconds is the strong length band. Clip 1 is 30 seconds long but 15 of them are cut; clip 0 is a plain 30.
      const { g } = await setup({ groups: [{ dimension: "duration", key: "under-20", posts: 12, lift: 1.5 }] });
      await prisma.clip.updateMany({ where: { id: { in: [g.clips[0]!.id, g.clips[1]!.id] } }, data: { category: "insight" } });
      await prisma.clip.update({ where: { id: g.clips[1]!.id }, data: { deletedRanges: [{ startSec: 5, endSec: 20 }] } });
      await drive(runner().service);
      // 70 x 1.25 beats 80 only because the cut is counted.
      const picks = (await row(g.row.id).then((found) => found.picks)) as Array<Pick & { ranking?: unknown }>;
      expect(picks.map((pick) => pick.clipId)).toEqual([g.clips[1]!.id]);
      expect(picks[0]!.ranking).toMatchObject({ score: 70, factor: 1.25, groups: [{ dimension: "duration", label: "Length Under 20 seconds", lift: 1.5 }] });
    })));

    test("a clip may not overtake one more than 15 points above it, whatever its factor", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      // Clip 0 scores 80 and is the weak category; clip 1 scores 70 and is the strong one; clip 2 scores 45, below the minimum.
      // Move clip 1 down to 64: the factor would put it first (64 x 1.25 = 80 > 64), but it is 16 points behind.
      const { g } = await setup({ groups: GROUPS });
      await prisma.clip.update({ where: { id: g.clips[1]!.id }, data: { viralityScore: 64 } });
      await drive(runner().service);
      const picks = (await row(g.row.id).then((found) => found.picks)) as Array<Pick & { ranking?: unknown }>;
      expect(picks.map((pick) => pick.clipId)).toEqual([g.clips[0]!.id]);
    })));

    test("the minimum score is checked against the plain score, whatever the factor", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const { g } = await setup({ groups: GROUPS }, null, 3);
      // Three picks are allowed, but clip 2 (45, a story at 1.25) is under minScore 50.
      await drive(runner().service);
      expect((await exportsOf(g.row.id)).map((pick) => pick.clipId)).toEqual([g.clips[1]!.id, g.clips[0]!.id]);
    })));

    test("switched off, without data, or without enough data, clips are ranked on their own score", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      for (const scenario of [
        { guidance: { groups: GROUPS }, setting: false },
        { guidance: null, setting: null },
        { guidance: { groups: [] }, setting: null },
      ]) {
        const { owner, g } = await setup(scenario.guidance, scenario.setting);
        await drive(runner().service);
        const picks = (await row(g.row.id).then((found) => found.picks)) as Array<Pick & { ranking?: unknown }>;
        expect(picks.map((pick) => pick.clipId)).toEqual([g.clips[0]!.id]);
        expect(picks[0]!.ranking).toBeUndefined();
        const view = await readProjectFinishing(prisma, { workspaceId: owner.workspaceId, projectId: g.project.id });
        expect(view?.rankedWithAudienceData).toBe(false);
      }
    })));

    test("a re-claim keeps the picks and the factors it first used", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const { g } = await setup({ groups: GROUPS });
      const { service } = runner();
      await drive(service);
      const first = (await row(g.row.id)).picks;
      // The audience data changes while the exports render; the picks do not.
      await prisma.performanceGuidance.update({ where: { workspaceId: g.row.workspaceId }, data: { groups: [] } });
      await prisma.$executeRaw`UPDATE "GenerationFinishing" SET "state" = 'running', "claimToken" = ${randomUUID()}::uuid,
        "leaseExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE "id" = ${g.row.id}::uuid`;
      await drive(service);
      expect((await row(g.row.id)).picks).toEqual(first);
    })));
  });

  test("a re-claim, even one that lost its picks, creates no second export and finishes no second time", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const owner = await workspace();
    const g = await finishedGeneration(owner, [90, 80, 10]);
    const { service, calls } = runner();
    await drive(service);
    const picks = await exportsOf(g.row.id);
    const exportIds = picks.map((pick) => pick.exportId!);
    expect(exportIds).toHaveLength(2);

    // The worker died before it saved its picks: the derived keys find the same exports.
    await prisma.$executeRaw`UPDATE "GenerationFinishing" SET "picks" = NULL, "state" = 'running', "claimToken" = ${randomUUID()}::uuid,
      "leaseExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE "id" = ${g.row.id}::uuid`;
    for (const exportId of exportIds) await settleExport(exportId, "completed");
    expect(await drive(service)).toBe(1);
    expect(await prisma.clipExport.count({ where: { projectId: g.project.id } })).toBe(2);
    expect((await exportsOf(g.row.id)).map((pick) => pick.exportId)).toEqual(exportIds);
    expect(await row(g.row.id)).toMatchObject({ state: "ready", attempts: 1 });
    // Both claims used the same keys; the service answered the second from its receipt.
    const keys = picks.map((pick) => finishingExportKey(g.row.id, pick.clipId, pick.editorRevision));
    expect(calls.exports).toEqual([...keys, ...keys]);

    // A lapsed lease after the outcome was written changes nothing.
    const copyCalls = calls.copy.length;
    await prisma.generationFinishing.update({ where: { id: g.row.id }, data: { state: "running", claimToken: randomUUID(), leaseExpiresAt: new Date(Date.now() - 1_000), finishedAt: null } });
    expect(await drive(service)).toBe(1);
    expect(calls.copy).toHaveLength(copyCalls);
    expect(calls.exports).toHaveLength(4);
    expect(await finishingEvents(owner.workspaceId)).toHaveLength(1);
  })));

  test("a Workspace below Pro keeps its rule but ends skipped with a visible reason and exports nothing", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    for (const tier of ["free", "creator"] as const) {
      const owner = await workspace(tier as "creator");
      const g = await finishedGeneration(owner, [90, 80]);
      const { service, calls } = runner();
      expect(await drive(service)).toBe(1);
      expect(await row(g.row.id)).toMatchObject({ state: "skipped", reason: "plan_required" });
      expect(await prisma.clipExport.count({ where: { projectId: g.project.id } })).toBe(0);
      expect(calls.notifications).toHaveLength(0);
      const view = await readProjectFinishing(prisma, { workspaceId: owner.workspaceId, projectId: g.project.id });
      expect(view).toMatchObject({ state: "skipped", reason: "plan_required" });
      expect(view?.message).toContain("Pro");
      expect((await finishingEvents(owner.workspaceId))[0]!.subject).toMatchObject({ state: "skipped", reason: "plan_required", exportIds: [] });
    }
    // Pro is enough.
    const pro = await workspace("pro");
    const g = await finishedGeneration(pro, [90]);
    await drive(runner().service);
    expect((await row(g.row.id)).picks).not.toBeNull();
  })));

  test("a person who left the Workspace ends it skipped", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const owner = await workspace();
    const stranger = await prisma.user.create({ data: { clerkId: `finishing-stranger:${randomUUID()}` } });
    const g = await finishedGeneration(owner, [90], FINISHING, { actorUserId: stranger.id });
    expect(await drive(runner().service)).toBe(1);
    expect(await row(g.row.id)).toMatchObject({ state: "skipped", reason: "actor_unavailable" });
  })));

  test("no clip at or above the minimum score ends skipped without exporting", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const owner = await workspace();
    const g = await finishedGeneration(owner, [10, 20]);
    expect(await drive(runner().service)).toBe(1);
    expect(await row(g.row.id)).toMatchObject({ state: "skipped", reason: "no_clips" });
    expect(await prisma.clipExport.count({ where: { projectId: g.project.id } })).toBe(0);
  })));

  test("a failed export leaves the rest ready and ends partial, naming only what finished", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const owner = await workspace();
    const g = await finishedGeneration(owner, [90, 80]);
    const { service, calls } = runner();
    await drive(service);
    const [good, bad] = await exportsOf(g.row.id);
    await settleExport(good!.exportId!, "completed");
    await settleExport(bad!.exportId!, "failed");
    await drive(service);

    expect(await row(g.row.id)).toMatchObject({ state: "partial", reason: "exports_failed" });
    expect(calls.copy.map((call) => call.clipId)).toEqual([good!.clipId]);
    expect(calls.notifications).toEqual([{ projectId: g.project.id, sourceId: g.row.id, clipCount: 1 }]);
    expect((await finishingEvents(owner.workspaceId))[0]!.subject).toMatchObject({ state: "partial", reason: "exports_failed", exportIds: [good!.exportId] });
  })));

  test("a copy the provider refuses outright ends partial and is not retried", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const owner = await workspace();
    const g = await finishedGeneration(owner, [90]);
    let attempts = 0;
    const { service } = runner({ writeCopy: async () => { attempts += 1; throw new AssistedSocialCopyError("assisted_copy_moderation_rejected"); } });
    await drive(service);
    for (const pick of await exportsOf(g.row.id)) await settleExport(pick.exportId!, "completed");
    await drive(service);
    expect(await row(g.row.id)).toMatchObject({ state: "partial", reason: "copy_failed", attempts: 0 });
    expect(attempts).toBe(1);
    expect((await exportsOf(g.row.id))[0]!.copyError).toBe("assisted_copy_moderation_rejected");
  })));

  test("a transient copy failure backs the row off and the retry writes it under a fresh key, without exporting again", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const owner = await workspace();
    const g = await finishedGeneration(owner, [90]);
    const keys: string[] = [];
    let failures = 0;
    const { service, calls } = runner({
      writeCopy: async (input) => {
        keys.push(input.idempotencyKey);
        if (failures < 2) {
          failures += 1;
          throw new AssistedSocialCopyError("assisted_copy_provider_unavailable");
        }
        return { id: randomUUID() };
      },
    });
    await drive(service);
    const [pick] = await exportsOf(g.row.id);
    await settleExport(pick!.exportId!, "completed");

    expect(await drive(service)).toBe(1);
    expect(await row(g.row.id)).toMatchObject({ state: "due", attempts: 1, claimToken: null });
    expect((await row(g.row.id)).nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await exportsOf(g.row.id))[0]).toMatchObject({ copyAttempt: 1, exportId: pick!.exportId });
    expect(await finishingEvents(owner.workspaceId)).toHaveLength(0);

    await lookAgain(g.row.id);
    expect(await drive(service)).toBe(1);
    expect(await row(g.row.id)).toMatchObject({ state: "due", attempts: 2 });
    await lookAgain(g.row.id);
    expect(await drive(service)).toBe(1);

    expect(await row(g.row.id)).toMatchObject({ state: "ready", reason: null, attempts: 2 });
    expect(keys).toEqual([0, 1, 2].map((attempt) => finishingCopyKey(g.row.id, pick!.clipId, attempt)));
    expect(new Set(keys).size).toBe(3);
    // Exports were made once; the retries only wrote copy.
    expect(calls.exports).toHaveLength(1);
    expect(await prisma.clipExport.count({ where: { projectId: g.project.id } })).toBe(1);
    expect(await finishingEvents(owner.workspaceId)).toHaveLength(1);
  })));

  test("a clip edited between picking and exporting is exported at the revision it has now, under that revision's key", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const owner = await workspace();
    const g = await finishedGeneration(owner, [90]);
    const keys: string[] = [];
    let edited = false;
    const { service } = runner({
      createExport: async (scope, projectId, clipId, input, key) => {
        keys.push(key);
        if (!edited) {
          edited = true;
          await prisma.clip.update({ where: { id: clipId }, data: { editorRevision: 1 } });
        }
        return clipExportService.create(scope, projectId, clipId, input, key);
      },
    });
    await drive(service);
    const clipId = g.clips[0]!.id;
    expect(keys).toEqual([finishingExportKey(g.row.id, clipId, 0), finishingExportKey(g.row.id, clipId, 1)]);
    const [pick] = await exportsOf(g.row.id);
    expect(pick).toMatchObject({ editorRevision: 1 });
    expect(pick!.exportError).toBeUndefined();
    const exported = await prisma.clipExport.findMany({ where: { clipId } });
    expect(exported.map((entry) => [entry.id, entry.editorRevision])).toEqual([[pick!.exportId, 1]]);
    expect(await row(g.row.id)).toMatchObject({ state: "exporting", attempts: 0 });
  })));

  test("an earlier failed export of the same revision and formats is requeued through the export retry path, not reported failed", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const owner = await workspace();
    const g = await finishedGeneration(owner, [90]);
    const earlier = await clipExportService.create(owner.scope, g.project.id, g.clips[0]!.id, { expectedRevision: 0, aspectRatios: ["9:16", "1:1"], resolution: "1080p" }, randomUUID());
    await settleExport(earlier.export.id, "failed");
    expect((await prisma.clipExport.findUniqueOrThrow({ where: { id: earlier.export.id } })).status).toBe("failed");

    const { service } = runner();
    await drive(service);
    const [pick] = await exportsOf(g.row.id);
    // The fingerprint upsert answered with the earlier export, which is now queued again.
    expect(pick).toMatchObject({ exportId: earlier.export.id });
    expect(pick!.exportError).toBeUndefined();
    const requeued = await prisma.clipExport.findUniqueOrThrow({ where: { id: earlier.export.id }, include: { variants: true } });
    expect(requeued).toMatchObject({ status: "queued", retryCount: 1 });
    expect(requeued.variants.map((variant) => variant.status)).toEqual(["pending", "pending"]);
    expect(await row(g.row.id)).toMatchObject({ state: "exporting" });

    await settleExport(earlier.export.id, "completed");
    await drive(service);
    expect(await row(g.row.id)).toMatchObject({ state: "ready" });
    expect((await finishingEvents(owner.workspaceId))[0]!.subject).toMatchObject({ state: "ready", exportIds: [earlier.export.id] });
  })));

  test("a plan that changes after the exports exist ends the row partial with them, not skipped", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const owner = await workspace();
    const g = await finishedGeneration(owner, [90, 80]);
    const { service, calls } = runner();
    await drive(service);
    const picks = await exportsOf(g.row.id);
    await prisma.workspace.update({ where: { id: owner.workspaceId }, data: { pricingTier: "creator" } });
    for (const pick of picks) await settleExport(pick.exportId!, "completed");
    await drive(service);

    expect(await row(g.row.id)).toMatchObject({ state: "partial", reason: "plan_required" });
    expect((await finishingEvents(owner.workspaceId))[0]!.subject).toMatchObject({ state: "partial", reason: "plan_required", exportIds: picks.map((pick) => pick.exportId) });
    expect((await exportsOf(g.row.id)).map((pick) => pick.exportId)).toEqual(picks.map((pick) => pick.exportId));
    expect(calls.copy).toHaveLength(0);
  })));

  test("waiting exports leave an independent finishing runnable and hold no renewable lease", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const owner = await workspace();
    const parked = [];
    for (let index = 0; index < 3; index += 1) {
      const g = await finishedGeneration(owner, [90]);
      await drive(runner().service, 1, [g.row.id]);
      expect((await row(g.row.id)).state).toBe("exporting");
      parked.push(g);
    }
    const fresh = await finishedGeneration(owner, [80]);
    const { service, calls } = runner();
    // The new reference runs independently of the three durable export waits.
    expect(await drive(service, 1, [fresh.row.id])).toBe(1);
    expect((await exportsOf(fresh.row.id))[0]!.exportId).toBeDefined();
    expect(calls.exports).toHaveLength(1);
    for (const g of parked) expect(await row(g.row.id)).toMatchObject({ state: "exporting", attempts: 0, claimToken: null });

    // Its own export-completion wake resumes only that finishing.
    for (const pick of await exportsOf(parked[1]!.row.id)) await settleExport(pick.exportId!, "completed");
    expect(await drive(service, 1, [parked[1]!.row.id])).toBe(1);
    expect(await row(parked[1]!.row.id)).toMatchObject({ state: "ready" });
    expect(await row(parked[0]!.row.id)).toMatchObject({ state: "exporting" });
  })));

  test("the notification reaches the person finishing ran for, through the real ledger, once", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const owner = await workspace();
    const actor = await prisma.user.create({ data: { clerkId: `finishing-actor:${randomUUID()}`, primaryEmail: `actor-${randomUUID()}@example.test` } });
    await prisma.workspaceMember.create({ data: { workspaceId: owner.workspaceId, userId: actor.id, role: "editor" } });
    const g = await finishedGeneration(owner, [90, 80], FINISHING, { actorUserId: actor.id });

    const mails: Array<{ to: string; outcome: string; clipCount: number; deepLink: string }> = [];
    const notifications = new NotificationService({ mailer: async (mail) => { mails.push(mail); return { sent: true, id: `message-${mails.length}` }; }, hasResendApiKey: () => true });
    const results: string[] = [];
    const { service } = runner({
      notify: async (input) => {
        results.push((await notifications.enqueueAndSend({ ...input, outcome: "finishing_ready", deepLink: `https://app.narriflow.test/projects/${input.projectId}` })).status);
      },
    });
    await drive(service);
    for (const pick of await exportsOf(g.row.id)) await settleExport(pick.exportId!, "completed");
    await drive(service);

    expect(await row(g.row.id)).toMatchObject({ state: "ready" });
    expect(results).toEqual(["sent"]);
    const ledger = await prisma.notificationLedger.findMany({ where: { projectId: g.project.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ sourceId: g.row.id, outcome: "finishing_ready", status: "sent" });
    const actorEmail = (await prisma.user.findUniqueOrThrow({ where: { id: actor.id } })).primaryEmail;
    expect(mails).toEqual([{ to: actorEmail!, outcome: "finishing_ready", clipCount: 2, deepLink: `https://app.narriflow.test/projects/${g.project.id}`, reason: expect.any(String), expiresAt: null, idempotencyKey: `notification-ledger-${ledger[0]!.id}`, projectTitle: "Generated" }]);

    // A re-claim of the finished work asks again and the ledger absorbs it.
    await prisma.generationFinishing.update({ where: { id: g.row.id }, data: { state: "running", claimToken: randomUUID(), leaseExpiresAt: new Date(Date.now() - 1_000), finishedAt: null } });
    await drive(service);
    expect(mails).toHaveLength(1);
    expect(await prisma.notificationLedger.count({ where: { projectId: g.project.id } })).toBe(1);
  })));

  test("exports still unfinished long after finishing came due count as failed", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const owner = await workspace();
    const g = await finishedGeneration(owner, [90], FINISHING, { dueAt: new Date(Date.now() - FINISHING_MAX_WAIT_MS - 60_000) });
    await drive(runner().service);
    expect(await row(g.row.id)).toMatchObject({ state: "partial", reason: "exports_failed" });
    expect(((await row(g.row.id)).picks as Array<{ exportError?: string }>)[0]!.exportError).toBe("export_timeout");
  })));

  test("an unexpected failure releases the row with backoff, and running out of attempts reports what exists", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const owner = await workspace();
    const g = await finishedGeneration(owner, [90]);
    const broken = runner({ createExport: async () => { throw new Error("database blip"); } });
    expect(await drive(broken.service)).toBe(1);
    expect(await row(g.row.id)).toMatchObject({ state: "due", attempts: 1, claimToken: null });
    expect((await row(g.row.id)).nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await drive(broken.service)).toBe(0);

    await prisma.generationFinishing.update({ where: { id: g.row.id }, data: { attempts: 4, nextAttemptAt: new Date(Date.now() - 1_000) } });
    await drive(broken.service);
    expect(await row(g.row.id)).toMatchObject({ state: "skipped", reason: "finishing_failed" });
  })));

  test("running out of attempts after some exports exist ends partial and keeps them", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const owner = await workspace();
    const g = await finishedGeneration(owner, [90, 80]);
    await prisma.generationFinishing.update({ where: { id: g.row.id }, data: { attempts: 4 } });
    let created = 0;
    const flaky = runner({
      createExport: async (scope, projectId, clipId, input, key) => {
        created += 1;
        if (created > 1) throw new Error("database blip");
        return clipExportService.create(scope, projectId, clipId, input, key);
      },
    });
    await drive(flaky.service);
    const ended = await row(g.row.id);
    expect(ended).toMatchObject({ state: "partial", reason: "finishing_failed" });
    const picks = ended.picks as Array<{ exportId?: string }>;
    expect(picks.filter((pick) => pick.exportId)).toHaveLength(1);
    expect(await prisma.clipExport.count({ where: { projectId: g.project.id } })).toBe(1);
    // The one export that exists is not yet finished, so the event names none.
    expect((await finishingEvents(owner.workspaceId))[0]!.subject).toMatchObject({ state: "partial", reason: "finishing_failed", exportIds: [] });
  })));

  test("a concurrent targeted command waits without issuing another export", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const owner = await workspace();
    const g = await finishedGeneration(owner, [90, 80]);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const a = runner({ requireActor: async (userId, workspaceId) => {
      entered(); await barrier;
      return workspaceService.requireActor(userId, workspaceId, "processing.consume");
    } });
    const b = runner();
    const reference = (await prisma.$transaction(tx => queueGenerationFinishing(tx,g.row.id)))!;
    const first = a.service.run(reference);
    await started;
    expect((await b.service.run(reference)).kind).toBe("wait");
    expect(b.calls.exports).toHaveLength(0);
    release(); await first;
    await drive(a.service, 1, [g.row.id]);
    expect(a.calls.exports.length + b.calls.exports.length).toBe(2);
    expect((await row(g.row.id)).state).toBe("exporting");
  })));

  describe("freezing at generate_clips admission", () => {
    const request = (forceRegenerate = false) => ({ contentPack: parseStoredContentPack(PACK), languageCode: "en" as const, forceRegenerate });
    const finishingFor = (settings: FinishingSettingsInput) => ({ minScore: 0, resolution: "1080p" as const, copyPlatforms: [], delivery: "ready_to_review" as const, ...settings });
    const trigger = (owner: Owner, projectId: string, settings: FinishingSettingsInput | undefined, key = randomUUID()) =>
      projectService.triggerGeneration(owner.scope, projectId, request(), key, { mutation: { clientIdempotencyKey: key }, ...(settings ? { finishing: finishingFor(settings) } : {}) });
    const freshProject = async (owner: Owner, title: string) => {
      const project = await prisma.project.create({ data: { workspaceId: owner.workspaceId, createdByUserId: owner.user.id, title, sourceMediaUrl: `https://example.test/${title}.mp4`, sourceDurationSeconds: 60, ingestStatus: "ready", sourceProbe: { durationSec: 60, video: null, audio: null } } });
      await usage(owner, project, "reserved");
      return project;
    };

    test("a new generation freezes one row keyed by its run, stable under replay and reuse", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const owner = await workspace();
      const project = await freshProject(owner, "fresh");
      const key = randomUUID();
      const first = await trigger(owner, project.id, { topClips: 3 }, key);
      const frozen = await prisma.generationFinishing.findUniqueOrThrow({ where: { originRunId: first.workflowRunId } });
      expect(frozen).toMatchObject({ workspaceId: owner.workspaceId, projectId: project.id, actorUserId: owner.user.id, state: "waiting" });
      // The format falls back to the pack's own default ratio.
      expect(frozen.settings).toEqual({ topClips: 3, minScore: 0, resolution: "1080p", copyPlatforms: [], delivery: "ready_to_review", queueAccountIds: [], aspectRatios: ["1:1"] });

      const replay = await trigger(owner, project.id, { topClips: 3 }, key);
      expect(replay.workflowRunId).toBe(first.workflowRunId);
      // Another key asking for the same finishing reuses the generation and its row.
      const reused = await trigger(owner, project.id, { topClips: 3 });
      expect(reused.workflowRunId).toBe(first.workflowRunId);
      expect(await prisma.generationFinishing.count({ where: { projectId: project.id } })).toBe(1);

      // The request's finishing is part of its fingerprint: the same key with other settings conflicts.
      await expect(trigger(owner, project.id, { topClips: 4 }, key)).rejects.toThrow();
    })));

    test("a request without finishing creates no row, and may reuse a generation that has one", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const owner = await workspace();
      const plain = await freshProject(owner, "plain");
      await trigger(owner, plain.id, undefined);
      expect(await prisma.generationFinishing.count({ where: { projectId: plain.id } })).toBe(0);

      const withFinishing = await freshProject(owner, "with");
      const first = await trigger(owner, withFinishing.id, { topClips: 2 });
      expect((await trigger(owner, withFinishing.id, undefined)).workflowRunId).toBe(first.workflowRunId);
      expect(await prisma.generationFinishing.count({ where: { projectId: withFinishing.id } })).toBe(1);
    })));

    test("a request that reuses a generation with other finishing, or finishing that already ran, conflicts", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const owner = await workspace();
      const project = await freshProject(owner, "conflict");
      const first = await trigger(owner, project.id, { topClips: 2, copyPlatforms: ["tiktok", "x"] });
      const origin = { originRunId: first.workflowRunId };
      const conflict = { code: "generation_settings_conflict" };

      await expect(trigger(owner, project.id, { topClips: 5 })).rejects.toMatchObject(conflict);
      await expect(trigger(owner, project.id, { topClips: 2, copyPlatforms: ["tiktok"] })).rejects.toMatchObject(conflict);
      // The order of platforms is not a difference.
      expect((await trigger(owner, project.id, { topClips: 2, copyPlatforms: ["x", "tiktok"] })).workflowRunId).toBe(first.workflowRunId);
      expect((await prisma.generationFinishing.findUniqueOrThrow({ where: origin })).settings).toMatchObject({ topClips: 2 });

      await prisma.generationFinishing.update({ where: origin, data: { state: "ready", finishedAt: new Date() } });
      await expect(trigger(owner, project.id, { topClips: 2, copyPlatforms: ["tiktok", "x"] })).rejects.toMatchObject(conflict);
      expect(await prisma.generationFinishing.count({ where: { projectId: project.id } })).toBe(1);
    })));

    test("only integration requests carry finishing; the browser's generate path refuses it", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const owner = await workspace();
      const project = await freshProject(owner, "browser");
      await expect(projectService.triggerGeneration(owner.scope, project.id, request(), randomUUID(), { finishing: finishingFor({ topClips: 2 }) })).rejects.toThrow("integration");
      expect(await prisma.generationFinishing.count({ where: { projectId: project.id } })).toBe(0);
    })));

    test("asking for finishing on a generation that already finished makes it due at once", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const owner = await workspace();
      const g = await finishedGeneration(owner, [90], null);
      await prisma.project.update({ where: { id: g.project.id }, data: { sourceDurationSeconds: 60 } });
      const key = randomUUID();
      const accepted = await projectService.triggerGeneration(owner.scope, g.project.id, { contentPack: parseStoredContentPack(g.pack), languageCode: "en", forceRegenerate: false }, key,
        { mutation: { clientIdempotencyKey: key }, finishing: finishingFor({ topClips: 1 }) });
      expect(accepted.workflowRunId).toBe(g.stt.id);
      const frozen = await prisma.generationFinishing.findUniqueOrThrow({ where: { originRunId: g.stt.id } });
      expect(frozen.state).toBe("due");
      expect(frozen.dueAt).not.toBeNull();
    })));
  });

  describe("delivery: propose_to_queue", () => {
    async function account(owner: Owner, platform: "youtube_shorts" | "x" | "tiktok", status: "active" | "expired" = "active") {
      return prisma.socialAccount.create({ data: { userId: owner.user.id, workspaceId: owner.workspaceId, platform, providerAccountId: `finishing-queue:${randomUUID()}`,
        displayName: `${platform} account`, accessTokenEncrypted: "encrypted-test-token", status } });
    }
    /** Copy that really exists: one generation per clip, with a distinct caption per platform. */
    const realCopy = (owner: Owner, record: Array<Parameters<GenerationFinishingDependencies["writeCopy"]>[0]> = []): Partial<GenerationFinishingDependencies> => ({
      writeCopy: async (input) => {
        record.push(input);
        const generation = await prisma.assistedCopyGeneration.create({ data: { workspaceId: owner.workspaceId, projectId: input.projectId, clipId: input.clipId, createdByUserId: owner.user.id,
          idempotencyKey: input.idempotencyKey, requestFingerprint: "finishing-queue", status: "completed", provider: "test", model: "test", promptVersion: "test", completedAt: new Date() } });
        for (const platform of input.platforms) {
          await prisma.assistedCopyVariant.create({ data: { generationId: generation.id, platform, caption: `${platform} copy for ${input.clipId}`, hashtags: ["#queue"], title: null,
            model: "test", promptVersion: "test", moderationOutcome: "approved", originalFingerprint: "x" } });
        }
        return { id: generation.id };
      },
    });
    const queueSettings = (accountIds: string[], extra: Record<string, unknown> = {}) =>
      ({ topClips: 2, minScore: 0, aspectRatios: ["9:16"], resolution: "1080p", copyPlatforms: [], delivery: "propose_to_queue", queueAccountIds: accountIds, ...extra }) as unknown as FinishingSettingsInput;
    const proposalsOf = (workspaceId: string) => prisma.socialPost.findMany({ where: { workspaceId, status: "draft", proposal: { isNot: null } }, include: { proposal: true }, orderBy: { createdAt: "asc" } });

    test("proposes each picked clip to each account with that platform's copy, once, and ends ready", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const owner = await workspace();
      const [youtube, x] = [await account(owner, "youtube_shorts"), await account(owner, "x")];
      const g = await finishedGeneration(owner, [90, 80, 10], queueSettings([youtube.id, x.id]));
      const copied: Array<Parameters<GenerationFinishingDependencies["writeCopy"]>[0]> = [];
      const { service } = runner(realCopy(owner, copied));

      await drive(service);
      const picks = await exportsOf(g.row.id);
      for (const pick of picks) await settleExport(pick.exportId!, "completed");
      expect(await drive(service)).toBe(1);

      // The accounts' platforms get copy although the settings name none.
      expect(copied.map((call) => [...call.platforms].sort())).toEqual(picks.map(() => ["x", "youtube_shorts"]));
      const proposals = await proposalsOf(owner.workspaceId);
      expect(proposals).toHaveLength(4);
      expect(new Set(proposals.map((post) => `${post.clipId}:${post.socialAccountId}`)).size).toBe(4);
      for (const post of proposals) {
        expect(post).toMatchObject({ status: "draft", scheduledFor: null, createdByUserId: owner.user.id });
        expect(post.proposal?.source).toBe("finishing");
        expect(post.caption).toBe(`${post.platform} copy for ${post.clipId}\n\n#queue`);
      }
      expect(await row(g.row.id)).toMatchObject({ state: "ready", reason: null });
      const proposed = (await listWorkspaceEvents(prisma, { workspaceId: owner.workspaceId }, { limit: 200, types: ["social_post.proposed"] })).data;
      expect(proposed).toHaveLength(4);

      // A worker that died before it recorded its work repeats nothing: each pair's key finds its proposal.
      await prisma.$executeRaw`UPDATE "GenerationFinishing" SET "state" = 'due', "picks" = (SELECT jsonb_agg(elem - 'queue') FROM jsonb_array_elements("picks") elem), "finishedAt" = NULL WHERE "id" = ${g.row.id}::uuid`;
      expect(await drive(service)).toBe(1);
      expect(await proposalsOf(owner.workspaceId)).toHaveLength(4);
      expect((await listWorkspaceEvents(prisma, { workspaceId: owner.workspaceId }, { limit: 200, types: ["social_post.proposed"] })).data).toHaveLength(4);
      expect(await row(g.row.id)).toMatchObject({ state: "ready" });
    })));

    test("a member who can't manage publishing runs a shared Recipe's queue delivery without proposing: exports and copy finish, the reason says why", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const owner = await workspace();
      const live = await account(owner, "youtube_shorts");
      // The settings were saved by someone who may propose; they run as the row's member, who may not.
      const g = await finishedGeneration(owner, [90, 80], queueSettings([live.id], { copyPlatforms: ["youtube_shorts"] }));
      const checked: string[] = [];
      const { service } = runner({
        ...realCopy(owner),
        canManagePublishing: async (userId) => {
          checked.push(userId);
          return false;
        },
      });
      await drive(service);
      for (const pick of await exportsOf(g.row.id)) await settleExport(pick.exportId!, "completed");
      await drive(service);
      expect(checked.every((userId) => userId === owner.user.id)).toBe(true);
      expect(await proposalsOf(owner.workspaceId)).toHaveLength(0);
      expect(await row(g.row.id)).toMatchObject({ state: "partial", reason: "actor_lacks_publishing" });
      const picks = await exportsOf(g.row.id);
      expect(picks.every((pick) => pick.exportId && pick.copyGenerationId && !pick.queue)).toBe(true);
      expect(finishingReasonMessage("actor_lacks_publishing")).toContain("can't manage publishing");
    })));

    test("an account that is no longer active gets nothing, and the rest of finishing still happens", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const owner = await workspace();
      const [live, gone] = [await account(owner, "youtube_shorts"), await account(owner, "x")];
      const g = await finishedGeneration(owner, [90, 80], queueSettings([live.id, gone.id]));
      const { service } = runner(realCopy(owner));
      await drive(service);
      for (const pick of await exportsOf(g.row.id)) await settleExport(pick.exportId!, "completed");
      // It was active when the settings were saved; it is not when they run.
      await prisma.socialAccount.update({ where: { id: gone.id }, data: { status: "revoked" } });
      await drive(service);
      const proposals = await proposalsOf(owner.workspaceId);
      expect(proposals.map((post) => post.socialAccountId)).toEqual([live.id, live.id]);
      expect(await row(g.row.id)).toMatchObject({ state: "partial", reason: "queue_account_unavailable" });
    })));

    test("an account the queue refuses is recorded, and the accounts after it still get their proposals", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const owner = await workspace();
      // TikTok takes only 9:16 and this finishing exports only 1:1. Its ID sorts before X's, so it is tried first.
      const hex = () => randomUUID().replaceAll("-", "").slice(0, 12);
      const tiktok = await prisma.socialAccount.create({ data: { id: `00000000-0000-4000-8000-${hex()}`, userId: owner.user.id, workspaceId: owner.workspaceId, platform: "tiktok",
        providerAccountId: `finishing-queue:${randomUUID()}`, displayName: "tiktok account", accessTokenEncrypted: "encrypted-test-token" } });
      const x = await prisma.socialAccount.create({ data: { id: `ffffffff-0000-4000-8000-${hex()}`, userId: owner.user.id, workspaceId: owner.workspaceId, platform: "x",
        providerAccountId: `finishing-queue:${randomUUID()}`, displayName: "x account", accessTokenEncrypted: "encrypted-test-token" } });
      const g = await finishedGeneration(owner, [90, 80], queueSettings([x.id, tiktok.id], { aspectRatios: ["1:1"] }));
      const { service } = runner(realCopy(owner));
      await drive(service);
      for (const pick of await exportsOf(g.row.id)) await settleExport(pick.exportId!, "completed");
      await drive(service);

      const ended = await row(g.row.id);
      expect(ended).toMatchObject({ state: "partial", reason: "queue_failed", attempts: 0 });
      // Every clip was proposed to X despite TikTok refusing it first, and the outcome of each account is kept.
      const picks = (await exportsOf(g.row.id)) as Array<Pick & { queue?: Record<string, string> }>;
      for (const pick of picks) expect(pick.queue).toEqual({ [tiktok.id]: "social_proposal_variant_unavailable", [x.id]: "proposed" });
      expect((await proposalsOf(owner.workspaceId)).map((post) => post.platform)).toEqual(["x", "x"]);

      // A re-claim does not try the refused account again.
      await prisma.generationFinishing.update({ where: { id: g.row.id }, data: { state: "due", finishedAt: null } });
      await drive(service);
      expect(await proposalsOf(owner.workspaceId)).toHaveLength(2);
      expect(await row(g.row.id)).toMatchObject({ state: "partial", reason: "queue_failed" });
    })));

    test("ready_to_review proposes nothing", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const owner = await workspace();
      const live = await account(owner, "youtube_shorts");
      const g = await finishedGeneration(owner, [90], { ...FINISHING, topClips: 1 });
      const { service } = runner(realCopy(owner));
      await drive(service);
      for (const pick of await exportsOf(g.row.id)) await settleExport(pick.exportId!, "completed");
      await drive(service);
      expect(await row(g.row.id)).toMatchObject({ state: "ready" });
      expect(await proposalsOf(owner.workspaceId)).toHaveLength(0);
      expect(live.id).toBeDefined();
    })));
  });

  describe("standing grants", () => {
    const EVERY_DAY = { slots: (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((weekday) => ({ weekday, time: "09:00" })) };
    const settings = (extra: Record<string, unknown>) =>
      ({ topClips: 2, minScore: 0, aspectRatios: ["9:16"], resolution: "1080p", copyPlatforms: [], queueAccountIds: [], delivery: "ready_to_review", ...extra }) as unknown as FinishingSettingsInput;
    let secret: string | undefined;
    beforeAll(bindServiceTestEnvironment(globalPrisma.bind(() => {
      secret = process.env.REVIEW_ACCESS_SECRET;
      process.env.REVIEW_ACCESS_SECRET = "finishing-grant-review-secret-0123456789abcdef";
      // Accepting a post with assisted copy checks its provenance, which builds the copy provider; nothing calls it.
      process.env.OPENAI_API_KEY ||= "test-key-never-sent";
      process.env.OPENAI_ASSISTED_COPY_MODEL ||= "test-model";
    })));
    afterAll(bindServiceTestEnvironment(globalPrisma.bind(() => {
      if (secret === undefined) delete process.env.REVIEW_ACCESS_SECRET;
      else process.env.REVIEW_ACCESS_SECRET = secret;
    })));

    /** A generation the Autopilot rule imported, so grants for that rule cover it. */
    async function ruleGeneration(owner: Owner, scores: number[], finishing: FinishingSettingsInput) {
      const recipe = await prisma.recipe.create({ data: { workspaceId: owner.workspaceId, createdByUserId: owner.user.id, name: "Weekly settings", contentPack: parseStoredContentPack({ ...PACK, platformTargets: ["tiktok"] }) as object, finishing: finishingSettingsSchema.parse(finishing) } });
      const rule = await prisma.autopilotRule.create({ data: { workspaceId: owner.workspaceId, createdByUserId: owner.user.id, name: "Weekly show", rssUrl: `https://feeds.example.test/${randomUUID()}.xml`, recipeId: recipe.id } });
      const sourceRuleFingerprint = (await ruleFingerprint(prisma, rule.id))!;
      const g = await finishedGeneration(owner, scores, finishing, { autopilotRuleId: rule.id, autopilotAuthority: { sourceRuleFingerprint, publish: (finishing.queueAccountIds ?? []).map(socialAccountId => ({ socialAccountId, grant: null })), review: null } });
      await prisma.autopilotEpisode.create({ data: { ruleId: rule.id, episodeId: randomUUID(), projectId: g.project.id } });
      return { ...g, rule };
    }
    async function freezeGrant(g: Awaited<ReturnType<typeof ruleGeneration>>, grant: { id: string }, kind: "publish" | "review_send") {
      const current = await row(g.row.id);
      expect(current).toMatchObject({ state: "due", generation: 0, picks: null, attempts: 0, claimToken: null });
      const intended = await prisma.standingGrant.findUniqueOrThrow({ where: { id: grant.id } });
      const tuple = { id: intended.id, revision: intended.revision, ruleFingerprint: intended.ruleFingerprint };
      const authority = current.autopilotAuthority as unknown as AutopilotFinishingAuthority;
      const updated = { ...authority, publish: authority.publish.map(item => ({ ...item, grant: kind === "publish" && item.socialAccountId === intended.socialAccountId ? tuple : item.grant })), review: kind === "review_send" ? tuple : authority.review };
      await prisma.generationFinishing.delete({ where: { id: current.id } });
      g.row = await prisma.generationFinishing.create({ data: { ...current, autopilotAuthority: updated, settings: current.settings as never, picks: undefined } });
    }
    const copy = (owner: Owner): Partial<GenerationFinishingDependencies> => ({
      writeCopy: async (input) => {
        const generation = await prisma.assistedCopyGeneration.create({ data: { workspaceId: owner.workspaceId, projectId: input.projectId, clipId: input.clipId, createdByUserId: owner.user.id,
          idempotencyKey: input.idempotencyKey, requestFingerprint: "finishing-grant", status: "completed", provider: "test", model: "test", promptVersion: "test", completedAt: new Date() } });
        for (const platform of input.platforms) {
          await prisma.assistedCopyVariant.create({ data: { generationId: generation.id, platform, caption: `${platform} copy`, hashtags: [], title: null, model: "test", promptVersion: "test", moderationOutcome: "approved", originalFingerprint: "x" } });
        }
        return { id: generation.id };
      },
    });
    async function finishAll(service: ReturnType<typeof runner>["service"], finishingId: string) {
      await drive(service, 1, [finishingId]);
      for (const pick of await exportsOf(finishingId)) await settleExport(pick.exportId!, "completed");
      await drive(service, 1, [finishingId]);
    }

    test("a publish grant takes the proposals it covers into slots within its cap, and the rest wait for a person", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const owner = await workspace();
      const account = await prisma.socialAccount.create({ data: { userId: owner.user.id, workspaceId: owner.workspaceId, platform: "youtube_shorts", providerAccountId: `grant-finishing:${randomUUID()}`,
        displayName: "YouTube", accessTokenEncrypted: "encrypted-test-token", postingSchedule: EVERY_DAY } });
      const g = await ruleGeneration(owner, [90, 80], settings({ delivery: "propose_to_queue", queueAccountIds: [account.id] }));
      const grant = await standingGrants.create(owner.scope, { kind: "publish", autopilotRuleId: g.rule.id, socialAccountId: account.id, dailyCap: 1, weeklyCap: 5, expiresInDays: 30 });
      await freezeGrant(g, grant, "publish");
      const { service } = runner(copy(owner));
      await finishAll(service, g.row.id);

      const picks = (await exportsOf(g.row.id)) as Array<Pick & { queue?: Record<string, string>; grant?: Record<string, string> }>;
      expect(picks.map((pick) => pick.grant?.[account.id])).toEqual(["accepted", "standing_grant_cap_reached"]);
      expect(picks.map((pick) => pick.queue?.[account.id])).toEqual(["proposed", "proposed"]);
      const posts = await prisma.socialPost.findMany({ where: { workspaceId: owner.workspaceId }, orderBy: { createdAt: "asc" } });
      expect(posts.map((post) => [post.status, post.standingGrantId])).toEqual([["scheduled", grant.id], ["draft", null]]);
      expect(await row(g.row.id)).toMatchObject({ state: "ready", reason: null });

      // A re-claim that repeats the proposals finds them as they were and takes no more of the cap.
      await prisma.$executeRaw`UPDATE "GenerationFinishing" SET "state" = 'due', "picks" = (SELECT jsonb_agg(elem - 'queue' - 'grant') FROM jsonb_array_elements("picks") elem), "finishedAt" = NULL WHERE "id" = ${g.row.id}::uuid`;
      await drive(service);
      expect(await prisma.socialPost.count({ where: { workspaceId: owner.workspaceId } })).toBe(2);
      expect(await prisma.socialPost.count({ where: { workspaceId: owner.workspaceId, standingGrantId: grant.id } })).toBe(1);
    })));

    test("without a grant a proposal stays a proposal and the pick records no grant", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const owner = await workspace();
      const account = await prisma.socialAccount.create({ data: { userId: owner.user.id, workspaceId: owner.workspaceId, platform: "youtube_shorts", providerAccountId: `grant-finishing:${randomUUID()}`,
        displayName: "YouTube", accessTokenEncrypted: "encrypted-test-token", postingSchedule: EVERY_DAY } });
      const g = await ruleGeneration(owner, [90], settings({ topClips: 1, delivery: "propose_to_queue", queueAccountIds: [account.id] }));
      const { service } = runner(copy(owner));
      await finishAll(service, g.row.id);
      expect((await exportsOf(g.row.id))[0]).not.toHaveProperty("grant");
      expect(await prisma.socialPost.findMany({ where: { workspaceId: owner.workspaceId } })).toMatchObject([{ status: "draft", standingGrantId: null }]);
    })));

    test("send_review_round sends one round to the grant's reviewers when finishing ends ready", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const owner = await workspace();
      const g = await ruleGeneration(owner, [90, 80], settings({ delivery: "send_review_round" }));
      await prisma.user.update({ where: { id: owner.user.id }, data: { primaryEmail: `owner-${randomUUID()}@example.test` } });
      const grant = await standingGrants.create(owner.scope, { kind: "review_send", autopilotRuleId: g.rule.id, reviewerEmails: ["client@example.test"], dailyCap: 2, weeklyCap: 5, expiresInDays: 30 });
      await freezeGrant(g, grant, "review_send");
      const { service } = runner();
      await finishAll(service, g.row.id);

      expect(await row(g.row.id)).toMatchObject({ state: "ready", reason: null });
      const rounds = await prisma.reviewRound.findMany({ where: { projectId: g.project.id }, include: { items: true } });
      expect(rounds).toHaveLength(1);
      expect(rounds[0]).toMatchObject({ finishingId: g.row.id, standingGrantId: grant.id, standingGrantRevision: 1, recipientEmails: ["client@example.test"] });
      expect(rounds[0]!.items.map((item) => item.clipId).sort()).toEqual([g.clips[0]!.id, g.clips[1]!.id].sort());

      // A re-claim sends nothing more.
      await prisma.generationFinishing.update({ where: { id: g.row.id }, data: { state: "due", finishedAt: null } });
      await drive(service);
      expect(await prisma.reviewRound.count({ where: { projectId: g.project.id } })).toBe(1);
      expect(await row(g.row.id)).toMatchObject({ state: "ready" });
    })));

    test("send_review_round with no grant, or below Business, ends partial with the reason and the clips still finished", bindServiceTestEnvironment(globalPrisma.bind(async () => {
      const owner = await workspace();
      const g = await ruleGeneration(owner, [90], settings({ topClips: 1, delivery: "send_review_round" }));
      const { service, calls } = runner();
      await finishAll(service, g.row.id);
      expect(await row(g.row.id)).toMatchObject({ state: "partial", reason: "review_not_sent_no_grant" });
      expect(await prisma.reviewRound.count({ where: { projectId: g.project.id } })).toBe(0);
      expect(calls.notifications).toHaveLength(1);
      const finished = (await listWorkspaceEvents(prisma, { workspaceId: owner.workspaceId }, { types: ["finishing.finished"] })).data;
      expect(finished.map((event) => event.subject)).toMatchObject([{ state: "partial", reason: "review_not_sent_no_grant", exportIds: expect.any(Array) }]);

      // The grant exists but the plan has dropped below review rooms: the step is skipped with its own reason.
      const second = await ruleGeneration(owner, [90], settings({ topClips: 1, delivery: "send_review_round" }));
      const secondGrant = await standingGrants.create(owner.scope, { kind: "review_send", autopilotRuleId: second.rule.id, reviewerEmails: ["client@example.test"], dailyCap: 2, weeklyCap: 5, expiresInDays: 30 });
      await freezeGrant(second, secondGrant, "review_send");
      await prisma.workspace.update({ where: { id: owner.workspaceId }, data: { pricingTier: "pro" } });
      await finishAll(service, second.row.id);
      expect(await row(second.row.id)).toMatchObject({ state: "partial", reason: "review_not_sent_plan" });
      expect(await prisma.reviewRound.count({ where: { projectId: second.project.id } })).toBe(0);
    })));
  });
});
