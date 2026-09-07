import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { editorDocumentSchema, applyEditorAction } from "@narriflow/validators";
import { Pool } from "pg";
import { CampaignOperationError, CampaignOperationService, campaignOperationService } from "./campaign-operation.service";
import { clipEditorDocumentPersistence } from "./clip-editor-document-persistence";
import { ReviewServiceError, reviewService } from "./review.service";
import { sceneTemplateService } from "./scene-template.service";
import { socialOAuthService } from "./social-oauth.service";
import { visualAssetService } from "./visual-asset.service";
import { BrandFontReferenceError, brandFontService } from "./brand-font.service";
import { clipExportService } from "./clip-export.service";
import { prismaAssistedCopyStore } from "./assisted-social-copy.service";
import { createAssistedSocialCopy } from "./assisted-social-copy";
import { AutopilotService } from "./autopilot.service";
import { dubbingService } from "./dubbing.service";
import { bulkSocialSchedulingService } from "./bulk-social-scheduling.service";

const databaseUrl = process.env.VIZARD_EXPANSION_TEST_DATABASE_URL;
const databaseSchema = process.env.VIZARD_EXPANSION_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_VIZARD_EXPANSION_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;
const sessionSecret = "vizard-expansion-review-session-secret-for-tests";

setDefaultTimeout(180_000);

dbDescribe("Vizard expansion PostgreSQL contracts", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const prismaGlobal = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };

  beforeAll(() => {
    if (!databaseUrl) throw new Error("Vizard expansion test database is required");
    pool = new Pool({ connectionString: databaseUrl, max: 12, options: databaseSchema ? `-csearch_path=${databaseSchema}` : undefined });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined) });
    priorPrisma = prismaGlobal.narriflowPrismaClient;
    prismaGlobal.narriflowPrismaClient = prisma;
  });

  afterAll(async () => {
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function fixture(label: string) {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { clerkId: `vizard-${label}-${suffix}`, primaryEmail: `vizard-${label}-${suffix}@example.test` } });
    const workspace = await prisma.workspace.create({ data: {
      name: `Vizard ${label}`,
      ownerUserId: user.id,
      pricingTier: "business",
      members: { create: { userId: user.id, role: "owner" } },
    } });
    const project = await prisma.project.create({ data: {
      title: `Project ${label}`,
      sourceMediaUrl: "https://media.example.test/source.mp4",
      sourceStorageKey: `fixtures/${suffix}/source.mp4`,
      userId: user.id,
      workspaceId: workspace.id,
      createdByUserId: user.id,
      ingestStatus: "ready",
    } });
    const workflow = await prisma.workflowRun.create({ data: {
      projectId: project.id,
      idempotencyKey: `fixture:${suffix}`,
      stage: "moment_detection",
      status: "completed",
      progress: 100,
    } });
    const clip = await prisma.clip.create({ data: {
      projectId: project.id,
      workflowRunId: workflow.id,
      index: 0,
      status: "edited",
      startSec: 0,
      endSec: 10,
      title: "Launch / teaser",
      hookText: "A strong hook",
      reasoning: "Fixture",
      category: "hook",
      transcriptSlice: [],
      editorRevision: 3,
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
    } });
    const clipExport = await prisma.clipExport.create({ data: {
      projectId: project.id,
      workspaceId: workspace.id,
      createdByUserId: user.id,
      clipId: clip.id,
      editorRevision: 3,
      fingerprint: `fixture-${suffix}`,
      resolution: "1080p",
      watermark: false,
      status: "ready",
      progress: 100,
      completedAt: new Date(),
      variants: { create: [
        { aspectRatio: "ratio_9_16", resolution: "1080p", watermark: false, status: "completed", storageKey: `fixtures/${suffix}/vertical.mp4`, sizeBytes: 64n, durationSec: 10, completedAt: new Date() },
        { aspectRatio: "ratio_1_1", resolution: "1080p", watermark: false, status: "completed", storageKey: `fixtures/${suffix}/square.mp4`, sizeBytes: 32n, durationSec: 10, completedAt: new Date() },
      ] },
    }, include: { variants: true } });
    return { user, workspace, project, clip, clipExport };
  }

  test("dubbing admission enforces render readiness and reuses an idempotent queue request", async () => {
    const current = await fixture("dubbing-admission");
    const input = { clipId: current.clip.id, aspectRatio: "9:16" as const, targetLanguageCode: "es" as const, voice: "marin" as const };
    const request = (key: string) => dubbingService.requestClipDub(current.user.id, current.workspace.id, current.project.id, key, input);
    await expect(request("")).rejects.toMatchObject({ code: "dubbing_idempotency_key_required" });
    await expect(request("before-render")).rejects.toMatchObject({ code: "dubbing_render_required" });
    expect(await prisma.clipDub.count({ where: { projectId: current.project.id } })).toBe(0);
    await prisma.workspace.update({ where: { id: current.workspace.id }, data: { pricingTier: "creator" } });
    await expect(request("creator-denied")).rejects.toMatchObject({ code: "requires_pro_plan" });
    await prisma.workspace.update({ where: { id: current.workspace.id }, data: { pricingTier: "business" } });
    await prisma.clipRender.create({ data: { clipId: current.clip.id, aspectRatio: "ratio_9_16", status: "completed", storageKey: "fixtures/dubbing/base.mp4" } });
    const first = await request("same-request");
    const replay = await request("same-request");
    expect(first.dub.status).toBe("queued");
    expect(replay.dub.id).toBe(first.dub.id);
    expect(replay.workflowRunId).toBe(first.workflowRunId);
    expect(await prisma.clipDub.count({ where: { projectId: current.project.id } })).toBe(1);
    expect(await prisma.workflowRun.count({ where: { projectId: current.project.id, stage: "dubbing" } })).toBe(1);
    await prisma.clipDub.update({ where: { id: first.dub.id }, data: { status: "completed", completedAt: new Date() } });
    const completed = await request("completed-replay");
    expect(completed.dub.id).toBe(first.dub.id);
    expect(completed.workflowRunId).toBeNull();
    expect(await prisma.workflowRun.count({ where: { projectId: current.project.id, stage: "dubbing" } })).toBe(1);
  });

  for (const outcome of ["success", "not_modified", "failure"] as const) {
    test(`Autopilot fences a replaced claim after feed ${outcome}`, async () => {
      const current = await fixture(`autopilot-${outcome}`);
      const rule = await prisma.autopilotRule.create({ data: {
        userId: current.user.id, workspaceId: current.workspace.id,
        name: "Claim fencing", rssUrl: "https://feeds.example.test/private",
        contentPack: { outputTypes: ["short_clip"], clipCountTarget: 3, clipDurationSecTarget: 30, platformPlaybookVersion: "2026.2" }, nextRunAt: new Date(0),
      } });
      const warnings = spyOn(console, "warn").mockImplementation(() => {});
      const sender = new AutopilotService({ fetchFeed: async () => {
        // A user pause revokes this owner even before its lease expires.
        await sender.updateRule(current.user.id, rule.id, { status: "paused" });
        if (outcome === "failure") throw new Error("feed unavailable");
        return { title: "Late feed", episodes: [], etag: "late", lastModified: null, finalUrl: rule.rssUrl, notModified: outcome === "not_modified" };
      } });
      try {
        expect(await sender.processDueRules(1)).toMatchObject({ checked: 1, imported: 0, claimLost: 1 });
        expect((await sender.listRules(current.user.id))[0]).toMatchObject({ status: "paused", consecutiveFailures: 0, lastSuccessAt: null });
        expect(warnings.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual(expect.objectContaining({ message: "autopilot_claim_lost", ruleId: rule.id }));
      } finally { warnings.mockRestore(); await prisma.autopilotRule.delete({ where: { id: rule.id } }); }
    });
  }

  for (const outcome of ["success", "failure"] as const) {
    for (const loss of ["replaced", "expired"] as const) {
      test(`Campaign Render selected reports ${loss} claims on ${outcome}`, async () => {
        const current = await fixture(`render-${loss}-${outcome}`);
        const request = {
          actorUserId: current.user.id, workspaceId: current.workspace.id,
          projectId: current.project.id, pricingTier: "business" as const,
          idempotencyKey: randomUUID(), clipIds: [current.clip.id], resolution: "1080p" as const,
          execute: async () => {
            await prisma.campaignOperation.updateMany({ where: { projectId: current.project.id }, data: loss === "replaced" ? { claimToken: randomUUID() } : { leaseExpiresAt: new Date(0) } });
            if (outcome === "failure") throw new Error("render admission unavailable");
            return { workflowRunId: randomUUID(), acceptedAt: new Date().toISOString(), initialSeq: 1, clipCount: 1, variantCount: 1, resolution: "1080p" as const };
          },
        };
        await expect(campaignOperationService.renderSelected(request)).rejects.toMatchObject({ code: "campaign_operation_claim_lost" });
        const operation = (await campaignOperationService.listOperations({ workspaceId: current.workspace.id, projectId: current.project.id }))[0]!;
        expect(operation).toMatchObject({ status: "running", failedCount: 0, succeededCount: 0 });
        expect(operation.items[0]?.status).toBe("pending");
      });
    }
  }

  for (const action of ["motion", "style", "scene"] as const) {
  test(`Campaign ${action} reports a lost item settlement`, async () => {
    const current = await fixture(`${action}-claim-lost`);
    const scope = { actorUserId: current.user.id, workspaceId: current.workspace.id, workspaceOwnerUserId: current.user.id,
      projectId: current.project.id, pricingTier: "business" as const, role: "owner" as const, status: "active" as const, isPersonalWorkspace: false, idempotencyKey: randomUUID() };
    const profile = await prisma.brandProfile.create({ data: { workspaceId: current.workspace.id, name: "Claim test", slug: randomUUID(), visualIdentity: {}, voiceGuidance: {}, createdByUserId: current.user.id, updatedByUserId: current.user.id } });
    await prisma.project.update({ where: { id: current.project.id }, data: { brandProfileId: profile.id } });
    await prisma.brandTemplate.create({ data: { name: "Claim style", workspaceId: current.workspace.id, captionPreset: {}, profileMembership: { create: { profileId: profile.id } } } });
    const scene = await sceneTemplateService.create(scope, profile.id, { name: "Claim opener", role: "intro", makeDefault: false, definition: { schemaVersion: 1, durationSec: 3, content: { kind: "text", text: "Opening", fontFamily: "Arial", fontAsset: null, color: "#FFFFFF", backgroundColor: "#111827" }, motion: { entrance: "fade", exit: "fade" } } });
    const style = (await campaignOperationService.getEditorActionCatalog(scope)).styles[0]!;
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    const extended = prisma.$extends({ query: { campaignOperationItem: {
      async updateMany({ args, query }) {
        if (args.where?.status === "processing" && args.where?.claimToken) {
          await prisma.campaignOperationItem.updateMany({ where: args.where, data: { claimToken: randomUUID() } });
        }
        return query(args);
      },
    } } });
    prismaGlobal.narriflowPrismaClient = extended as unknown as PrismaClient;
    try {
      const clips = [{ clipId: current.clip.id, expectedEditorRevision: 2 }];
      const request = action === "motion"
        ? campaignOperationService.applyMotionSelected(scope, { clips, change: { scope: "clip_transition", transition: { type: "none", durationSec: 0.4 } } })
        : action === "style"
          ? campaignOperationService.applyStyleSelected(scope, { clips, templateId: style.id, templateFingerprint: style.fingerprint })
          : campaignOperationService.applySceneTemplate(scope, profile.id, scene.id, { clips, placement: "start", templateFingerprint: scene.fingerprint });
      await expect(request).rejects.toMatchObject({ code: "campaign_operation_claim_lost" });
      expect(warnings.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual(expect.objectContaining({ message: "campaign_operation_claim_lost", clipId: current.clip.id }));
    } finally { prismaGlobal.narriflowPrismaClient = prisma; warnings.mockRestore(); }
  });
  }

  for (const outcome of ["success", "failure"] as const) {
    test(`Campaign export bundle preserves the replacement owner's items after admission ${outcome}`, async () => {
      const current = await fixture(`bundle-claim-${outcome}`);
      const bundles = new CampaignOperationService(async ({ projectId, idempotencyKey, stage }) => {
        await prisma.campaignOperation.updateMany({ where: { projectId }, data: { claimToken: randomUUID() } });
        if (outcome === "failure") throw new Error("admission unavailable");
        return prisma.workflowRun.create({ data: { projectId, idempotencyKey, stage, status: "queued" }, select: { id: true } });
      });
      await expect(bundles.createExportBundle({
        actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id,
        pricingTier: "business", role: "owner", status: "active", idempotencyKey: randomUUID(),
      }, { clips: [{ clipId: current.clip.id, expectedEditorRevision: 3 }], aspectRatios: ["9:16"], resolution: "1080p" })).rejects.toMatchObject({ code: "campaign_operation_claim_lost" });
      const operation = (await campaignOperationService.listOperations({ workspaceId: current.workspace.id, projectId: current.project.id }))[0]!;
      expect(operation).toMatchObject({ status: "running", failedCount: 0, workflowRunId: null, bundle: null });
      expect(operation.items[0]?.status).toBe("pending");
    });
  }

  for (const action of ["render", "export"] as const) {
    test(`Campaign ${action} reports claim loss when settling an empty selection`, async () => {
      const current = await fixture(`empty-${action}`);
      const replacement = randomUUID();
      const extended = prisma.$extends({ query: { campaignOperation: {
        async create({ args, query }) {
          const operation = await query(args);
          await prisma.campaignOperation.update({ where: { id: operation.id }, data: { claimToken: replacement } });
          return operation;
        },
      } } });
      prismaGlobal.narriflowPrismaClient = extended as unknown as PrismaClient;
      const scope = { actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" as const, role: "owner" as const, status: "active" as const, idempotencyKey: randomUUID() };
      try {
        const request = action === "render"
          ? campaignOperationService.renderSelected({ ...scope, clipIds: [randomUUID()], resolution: "1080p", execute: async () => { throw new Error("must not execute"); } })
          : campaignOperationService.createExportBundle(scope, { clips: [{ clipId: randomUUID(), expectedEditorRevision: 3 }], aspectRatios: ["9:16"], resolution: "1080p" });
        await expect(request).rejects.toMatchObject({ code: "campaign_operation_claim_lost" });
        expect((await campaignOperationService.listOperations(scope))[0]).toMatchObject({ status: "running", claimToken: replacement });
      } finally { prismaGlobal.narriflowPrismaClient = prisma; }
    });
  }

  test("Autopilot's immutable token fences a late worker even when replacement lease dates match", async () => {
    const current = await fixture("autopilot-immutable-token");
    const now = new Date();
    const rule = await prisma.autopilotRule.create({ data: {
      userId: current.user.id, workspaceId: current.workspace.id, name: "Immutable claim", rssUrl: "https://feeds.example.test/show.xml",
      contentPack: { outputTypes: ["short_clip"], clipCountTarget: 3, clipDurationSecTarget: 30, platformPlaybookVersion: "2026.2" }, nextRunAt: new Date(0),
    } });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let replacementRun: ReturnType<AutopilotService["processDueRules"]> | undefined;
    let originalToken: string | null = null;
    let replacementToken: string | null = null;
    const replacement = new AutopilotService({ now: () => now, fetchFeed: async () => {
      replacementToken = (await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).claimToken;
      entered.resolve();
      await release.promise;
      return { title: "Current feed", episodes: [], etag: "current", lastModified: null, finalUrl: rule.rssUrl, notModified: false };
    } });
    const original = new AutopilotService({ now: () => now, fetchFeed: async () => {
      originalToken = (await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).claimToken;
      await original.updateRule(current.user.id, rule.id, { status: "paused" });
      await original.updateRule(current.user.id, rule.id, { status: "active" });
      // Match eligibility to the frozen test clock after the user resumed it.
      await prisma.autopilotRule.update({ where: { id: rule.id }, data: { nextRunAt: now } });
      replacementRun = replacement.processDueRules(1);
      await entered.promise;
      return { title: "Late feed", episodes: [], etag: "late", lastModified: null, finalUrl: rule.rssUrl, notModified: false };
    } });
    try {
      expect(await original.processDueRules(1)).toEqual({ checked: 1, imported: 0, claimLost: 1 });
      expect(originalToken).toBeTruthy();
      expect(replacementToken).toBeTruthy();
      expect(replacementToken).not.toBe(originalToken);
      expect((await original.listRules(current.user.id))[0]?.status).toBe("running");
      release.resolve();
      expect(await replacementRun).toEqual({ checked: 1, imported: 0, claimLost: 0 });
      expect((await original.listRules(current.user.id))[0]?.feedTitle).toBe("Current feed");
    } finally { release.resolve(); await replacementRun; await prisma.autopilotRule.delete({ where: { id: rule.id } }); }
  });

  for (const expired of [false, true]) {
    test(`Autopilot ${expired ? "rejects an expired claim before" : "renews the same token before"} episode import`, async () => {
      const current = await fixture(`autopilot-renew-${expired}`);
      let now = new Date();
      const rule = await prisma.autopilotRule.create({ data: {
        userId: current.user.id, workspaceId: current.workspace.id, name: "Renewal", rssUrl: "https://feeds.example.test/show.xml",
        initialImportMode: "latest", initialImportCount: 1,
        contentPack: { outputTypes: ["short_clip"], clipCountTarget: 3, clipDurationSecTarget: 30, platformPlaybookVersion: "2026.2" }, nextRunAt: new Date(0),
      } });
      let claimToken: string | null = null;
      let renewedToken: string | null = null;
      let renewedUntil: Date | null = null;
      const sender = new AutopilotService({ now: () => now, fetchFeed: async () => {
        claimToken = (await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).claimToken;
        now = new Date(now.getTime() + (expired ? 120_000 : 60_000));
        return { title: "Feed", episodes: [{ id: "one", title: "Episode one", enclosureUrl: "https://media.example.test/one.mp3", durationSeconds: 60, publishedAt: null, mimeType: "audio/mpeg" }], etag: null, lastModified: null, finalUrl: rule.rssUrl, notModified: false };
      } });
      const extended = prisma.$extends({ query: { autopilotRule: { async updateMany({ args, query }) {
        const result = await query(args);
        if (result.count === 1 && args.where?.claimToken && args.data.leaseExpiresAt instanceof Date) {
          const row = await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } });
          renewedToken = row.claimToken;
          renewedUntil = row.leaseExpiresAt;
        }
        return result;
      } } } });
      prismaGlobal.narriflowPrismaClient = extended as unknown as PrismaClient;
      try {
        const result = await sender.processDueRules(1);
        expect(result.claimLost).toBe(expired ? 1 : 0);
        expect(result.imported).toBe(expired ? 0 : 1);
        if (!expired) {
          expect(renewedToken).toBe(claimToken);
          expect(renewedUntil).toEqual(new Date(now.getTime() + 120_000));
        }
        expect((await sender.listRules(current.user.id))[0]?.importedEpisodeCount).toBe(expired ? 0 : 1);
      } finally { prismaGlobal.narriflowPrismaClient = prisma; await prisma.autopilotRule.delete({ where: { id: rule.id } }); }
    });
  }

  test("an Autopilot edit revokes a claim acquired after the edit's initial read without stranding the rule", async () => {
    const current = await fixture("autopilot-edit-race");
    const rule = await prisma.autopilotRule.create({ data: {
      userId: current.user.id, workspaceId: current.workspace.id, name: "Before edit", rssUrl: "https://feeds.example.test/show.xml",
      contentPack: { outputTypes: ["short_clip"], clipCountTarget: 3, clipDurationSecTarget: 30, platformPlaybookVersion: "2026.2" }, nextRunAt: new Date(0),
    } });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let processing: ReturnType<AutopilotService["processDueRules"]> | undefined;
    let workerNow = new Date();
    const worker = new AutopilotService({ now: () => workerNow, fetchFeed: async () => {
      entered.resolve(); await release.promise;
      return { title: "Feed", episodes: [], etag: null, lastModified: null, finalUrl: rule.rssUrl, notModified: false };
    } });
    const extended = prisma.$extends({ query: { autopilotRule: { async findFirst({ args, query }) {
      const row = await query(args);
      if (args.where?.userId === current.user.id) {
        processing = worker.processDueRules(1);
        await entered.promise;
      }
      return row;
    } } } });
    prismaGlobal.narriflowPrismaClient = extended as unknown as PrismaClient;
    try {
      const edited = await worker.updateRule(current.user.id, rule.id, { name: "After edit" });
      expect(edited.status).toBe("active");
      release.resolve();
      expect(await processing).toMatchObject({ claimLost: 1 });
      prismaGlobal.narriflowPrismaClient = prisma;
      workerNow = new Date(edited.nextRunAt);
      expect(await worker.processDueRules(1)).toMatchObject({ checked: 1, claimLost: 0 });
      expect((await worker.listRules(current.user.id))[0]?.name).toBe("After edit");
    } finally { release.resolve(); await processing; prismaGlobal.narriflowPrismaClient = prisma; await prisma.autopilotRule.delete({ where: { id: rule.id } }); }
  });

  test("a late atomic export handoff reports claim loss after a replacement has created the bundle", async () => {
    const current = await fixture("atomic-bundle-late");
    const scope = { actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" as const, role: "owner" as const, status: "active" as const, idempotencyKey: randomUUID() };
    const input = { clips: [{ clipId: current.clip.id, expectedEditorRevision: 3 }], aspectRatios: ["9:16"], resolution: "1080p" };
    let replacement: Awaited<ReturnType<CampaignOperationService["createExportBundle"]>> | undefined;
    const extended = prisma.$extends({ query: { campaignOperation: { async create({ args, query }) {
      const operation = await query(args);
      await prisma.campaignOperation.update({ where: { id: operation.id }, data: { leaseExpiresAt: new Date(0) } });
      replacement = await campaignOperationService.createExportBundle(scope, input);
      return operation;
    } } } });
    prismaGlobal.narriflowPrismaClient = extended as unknown as PrismaClient;
    try {
      await expect(campaignOperationService.createExportBundle(scope, input)).rejects.toMatchObject({ code: "campaign_operation_claim_lost" });
      expect(await campaignOperationService.listExportBundles(scope)).toMatchObject([{ workflowRunId: replacement!.workflowRunId }]);
      expect((await campaignOperationService.listOperations(scope))[0]?.items[0]?.status).toBe("pending");
    } finally { prismaGlobal.narriflowPrismaClient = prisma; }
  });

  test("keeps assisted-copy prompts and content out of analytics metadata", async () => {
    const current = await fixture("assisted-copy-privacy");
    const promptSecret = "PROMPT_SECRET https://private.example.test/campaign";
    const generatedSecret = "GENERATED_COPY_SECRET";
    const editedSecret = "EDITED_COPY_SECRET";
    const hashtagSecret = "#PrivateLaunchSecret";
    const assistedCopy = createAssistedSocialCopy({
      store: prismaAssistedCopyStore,
      provider: {
        name: "privacy-test",
        modelAlias: "privacy-test-model",
        async generate() {
          return {
            model: "privacy-test-model-2026-09-02",
            inputTokens: 32,
            outputTokens: 16,
            variants: [
              {
                platform: "youtube_shorts",
                caption: generatedSecret,
                hashtags: [hashtagSecret],
                title: "PRIVATE_TITLE_SECRET",
              },
            ],
          };
        },
      },
      authorize: async () => undefined,
      loadContext: async () => ({
        clipTitle: "Privacy contract",
        hook: null,
        payoff: null,
        voiceGuidance: null,
      }),
      moderate: async () => ({ outcome: "approved" }),
      createId: randomUUID,
      now: () => new Date("2026-09-02T12:00:00.000Z"),
      timeoutMs: 5_000,
    });

    const generation = await assistedCopy.generate({
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      clipId: current.clip.id,
      idempotencyKey: randomUUID(),
      platforms: ["youtube_shorts"],
      campaignNote: promptSecret,
    });
    await assistedCopy.confirm({
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      variantId: generation.variants[0]!.id,
      caption: editedSecret,
      hashtags: [hashtagSecret],
      title: "EDITED_PRIVATE_TITLE_SECRET",
    });

    const events = await prisma.projectAnalyticsEvent.findMany({
      where: {
        projectId: current.project.id,
        type: { in: ["assisted_copy_generated", "assisted_copy_confirmed", "assisted_copy_edited"] },
      },
      select: { metadata: true },
    });
    expect(events).toHaveLength(2);
    const serializedMetadata = JSON.stringify(events);
    for (const secret of [
      promptSecret,
      generatedSecret,
      editedSecret,
      hashtagSecret,
      "PRIVATE_TITLE_SECRET",
      "EDITED_PRIVATE_TITLE_SECRET",
    ]) {
      expect(serializedMetadata).not.toContain(secret);
    }
  });

	test("lists every usable current-revision export so publishing can choose a compatible older render", async () => {
		const current = await fixture("publishing-current-exports");
		const newer = await prisma.clipExport.create({
			data: {
				projectId: current.project.id,
				workspaceId: current.workspace.id,
				createdByUserId: current.user.id,
				clipId: current.clip.id,
				editorRevision: current.clip.editorRevision,
				fingerprint: `newer-${randomUUID()}`,
				resolution: "1080p",
				watermark: false,
				status: "ready",
				progress: 100,
				createdAt: new Date(Date.now() + 1_000),
				completedAt: new Date(),
				variants: {
					create: {
						aspectRatio: "ratio_16_9",
						resolution: "1080p",
						watermark: false,
						status: "completed",
						storageKey: `fixtures/${randomUUID()}/landscape.mp4`,
						sizeBytes: 64n,
						durationSec: 10,
						completedAt: new Date(),
					},
				},
			},
		});

		const exports = await clipExportService.listCurrentProjectExports(
			current.workspace.id,
			current.project.id,
		);
		expect(exports.map((item) => item.id)).toEqual([newer.id, current.clipExport.id]);
		expect(exports[1]?.variants.some((variant) => variant.aspectRatio === "9:16" && variant.hasAsset)).toBe(true);
	});

	test("rejects cross-project bulk clip identifiers before persisting an operation", async () => {
		const current = await fixture("bulk-boundary-current");
		const foreign = await fixture("bulk-boundary-foreign");
		const idempotencyKey = randomUUID();

		await expect(bulkSocialSchedulingService.schedule({
			actorUserId: current.user.id,
			workspaceId: current.workspace.id,
			projectId: current.project.id,
			value: {
				idempotencyKey,
				accounts: [{ accountId: randomUUID(), platform: "youtube_shorts" }],
				clips: [{
					clipId: foreign.clip.id,
					expectedEditorRevision: foreign.clip.editorRevision,
					exportId: foreign.clipExport.id,
					exportVariantId: foreign.clipExport.variants[0]!.id,
					aspectRatio: "9:16",
					resolution: "1080p",
					copyByPlatform: {},
					thumbnailByPlatform: {},
				}],
				startDate: "2026-09-03",
				timeZone: "UTC",
				postingWindow: { start: "09:00", end: "17:00" },
				frequency: { unit: "hours", value: 2 },
				dstDisambiguation: null,
			},
		})).rejects.toMatchObject({ code: "campaign_schedule_clip_not_found" });
		expect(await prisma.campaignOperation.count({
			where: { workspaceId: current.workspace.id, idempotencyKey },
		})).toBe(0);
	});

  test("settles duplicate and partial Render selected admission with stable item counts", async () => {
    const current = await fixture("render-selected");
    const missingClipId = randomUUID();
    let executions = 0;
    const execute = async (clipIds: string[]) => {
      executions += 1;
      return { workflowRunId: randomUUID(), acceptedAt: new Date().toISOString(), initialSeq: 1, clipCount: clipIds.length, variantCount: clipIds.length, resolution: "1080p" as const };
    };
    const request = {
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      pricingTier: "business" as const,
      idempotencyKey: randomUUID(),
      clipIds: [current.clip.id, missingClipId],
      resolution: "1080p" as const,
      execute,
    };
    const first = await campaignOperationService.renderSelected(request);
    const replay = await campaignOperationService.renderSelected(request);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(executions).toBe(1);
    const operation = await prisma.campaignOperation.findUniqueOrThrow({ where: { id: first.operationId }, include: { items: true } });
		expect(operation).toMatchObject({ requestedCount: 2, succeededCount: 1, ineligibleCount: 1, failedCount: 0, status: "partial" });
    expect(operation.items.map((item) => [item.requestedClipId, item.status, item.errorCode]).sort()).toEqual([
      [current.clip.id, "succeeded", null],
      [missingClipId, "ineligible", "campaign_clip_not_found"],
    ].sort());
  });

  test("persists revision-fenced motion with partial truth and idempotent replay", async () => {
    const current = await fixture("campaign-motion");
    const missingClipId = randomUUID();
    const preflightScope = {
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      workspaceOwnerUserId: current.user.id,
      projectId: current.project.id,
      pricingTier: "business",
      role: "owner" as const,
      status: "active" as const,
      isPersonalWorkspace: false,
    };
    const preflight = await campaignOperationService.previewEditorAction(
      preflightScope,
      {
        action: "apply_motion",
        input: {
          change: {
            scope: "clip_transition",
            transition: { type: "none", durationSec: 0.4 },
          },
          clips: [{ clipId: current.clip.id, expectedEditorRevision: 2 }],
        },
      },
    );
    expect(preflight).toMatchObject({
      counts: { stale: 1, eligible: 0 },
      items: [{ clipId: current.clip.id, status: "stale" }],
    });
    const scope = {
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      workspaceOwnerUserId: current.user.id,
      projectId: current.project.id,
      pricingTier: "business" as const,
      role: "owner" as const,
      status: "active" as const,
      idempotencyKey: randomUUID(),
    };
    const request = {
      change: {
        scope: "clip_transition" as const,
        transition: { type: "fade-black" as const, durationSec: 0.55 },
      },
      clips: [
        { clipId: current.clip.id, expectedEditorRevision: 3 },
        { clipId: missingClipId, expectedEditorRevision: 0 },
      ],
    };

    const first = await campaignOperationService.applyMotionSelected(scope, request);
    const replay = await campaignOperationService.applyMotionSelected(scope, request);
    expect(first).toMatchObject({
      status: "partial",
      replayed: false,
      counts: {
        succeeded: 1,
        unchanged: 0,
        stale: 0,
        ineligible: 1,
        failed: 0,
      },
    });
    expect(replay).toMatchObject({ operationId: first.operationId, replayed: true });

    const persisted = await clipEditorDocumentPersistence.readDocument({
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      workspaceOwnerUserId: current.user.id,
      projectId: current.project.id,
      clipId: current.clip.id,
    });
    expect(persisted).toMatchObject({
      revision: 4,
      document: {
        studioEdits: {
          transition: { type: "fade-black", durationSec: 0.55 },
        },
      },
    });
    const operation = await prisma.campaignOperation.findUniqueOrThrow({
      where: { id: first.operationId },
      include: { items: true },
    });
    expect(operation.items.map((item) => [item.requestedClipId, item.status, item.errorCode]).sort()).toEqual([
      [current.clip.id, "succeeded", null],
      [missingClipId, "ineligible", "campaign_clip_not_found"],
    ].sort());

    const stale = await campaignOperationService.applyMotionSelected(
      { ...scope, idempotencyKey: randomUUID() },
      {
        change: {
          scope: "clip_transition",
          transition: { type: "dip-white", durationSec: 0.4 },
        },
        clips: [{ clipId: current.clip.id, expectedEditorRevision: 3 }],
      },
    );
    expect(stale.counts).toMatchObject({ stale: 1, succeeded: 0 });

    const source = await prisma.campaignOperation.findUniqueOrThrow({
      where: { id: stale.operationId },
    });
    const retry = await campaignOperationService.applyMotionSelected(
      {
        ...scope,
        idempotencyKey: randomUUID(),
        retryOfId: source.id,
      },
      {
        change: {
          scope: "clip_transition",
          transition: { type: "dip-white", durationSec: 0.4 },
        },
        clips: [{ clipId: current.clip.id, expectedEditorRevision: 4 }],
      },
    );
    expect(
      await prisma.campaignOperation.findUniqueOrThrow({
        where: { id: retry.operationId },
        select: { retryOfId: true },
      }),
    ).toEqual({ retryOfId: source.id });
    await expect(
      campaignOperationService.applyMotionSelected(
        {
          ...scope,
          idempotencyKey: (
            await prisma.campaignOperation.findUniqueOrThrow({
              where: { id: retry.operationId },
              select: { idempotencyKey: true },
            })
          ).idempotencyKey,
          retryOfId: source.id,
        },
        {
          change: {
            scope: "clip_transition",
            transition: { type: "dip-white", durationSec: 0.4 },
          },
          clips: [{ clipId: current.clip.id, expectedEditorRevision: 4 }],
        },
      ),
    ).resolves.toMatchObject({ operationId: retry.operationId, replayed: true });
    await expect(
      campaignOperationService.applyMotionSelected(
        {
          ...scope,
          idempotencyKey: (
            await prisma.campaignOperation.findUniqueOrThrow({
              where: { id: retry.operationId },
              select: { idempotencyKey: true },
            })
          ).idempotencyKey,
        },
        {
          change: {
            scope: "clip_transition",
            transition: { type: "dip-white", durationSec: 0.4 },
          },
          clips: [{ clipId: current.clip.id, expectedEditorRevision: 4 }],
        },
      ),
    ).rejects.toMatchObject({ code: "campaign_operation_idempotency_conflict" });
  });

  test("freezes bundle revisions and variants while excluding stale and missing clips", async () => {
    const current = await fixture("bundle-freeze");
    const missingClipId = randomUUID();
    const bundleService = new CampaignOperationService(async ({ projectId, idempotencyKey, stage }) => prisma.workflowRun.create({ data: {
      projectId,
      idempotencyKey,
      stage,
      status: "queued",
    }, select: { id: true } }));
    await expect(bundleService.createExportBundle({
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      pricingTier: "business",
      role: "editor",
      status: "restricted",
      idempotencyKey: randomUUID(),
    }, {
      clips: [{ clipId: current.clip.id, expectedEditorRevision: 3 }],
      aspectRatios: ["9:16"],
      resolution: "1080p",
    })).rejects.toMatchObject({ code: "campaign_operation_forbidden" });
    await expect(bundleService.getExportBundleDownload({
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      role: "editor",
      status: "restricted",
    }, randomUUID())).rejects.toMatchObject({
      code: "campaign_operation_forbidden",
    });
    const preflight = await bundleService.previewExportBundle({
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      pricingTier: "business",
      role: "owner",
      status: "active",
    }, {
      clips: [
        { clipId: current.clip.id, expectedEditorRevision: 3 },
        { clipId: missingClipId, expectedEditorRevision: 0 },
      ],
      aspectRatios: ["9:16", "1:1"],
      resolution: "1080p",
    });
    expect(preflight).toMatchObject({
      requestedCount: 2,
      counts: { eligible: 1, stale: 0, ineligible: 1 },
      items: [
        {
          clipId: current.clip.id,
          currentEditorRevision: 3,
          exportEditorRevision: 3,
          status: "eligible",
          code: null,
          aspectRatios: ["9:16", "1:1"],
        },
        {
          clipId: missingClipId,
          currentEditorRevision: null,
          status: "ineligible",
          code: "campaign_clip_not_found",
        },
      ],
    });
    expect(preflight.estimatedSizeBytes).toBeGreaterThan(0);
    const result = await bundleService.createExportBundle({
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      pricingTier: "business",
      role: "owner",
      status: "active",
      idempotencyKey: randomUUID(),
    }, {
      clips: [
        { clipId: current.clip.id, expectedEditorRevision: 3 },
        { clipId: missingClipId, expectedEditorRevision: 0 },
      ],
      aspectRatios: ["9:16", "1:1"],
      resolution: "1080p",
    });
    expect(result.manifest.included[0]).toMatchObject({ clipId: current.clip.id, editorRevision: 3 });
    expect(result.manifest.included[0]?.files.map((file) => file.variantId)).toEqual(current.clipExport.variants.map((variant) => variant.id));
    expect(result.manifest.excluded).toEqual([{ clipId: missingClipId, code: "campaign_clip_not_found" }]);
    expect(JSON.stringify(result.manifest)).not.toContain("http");

    await prisma.clip.update({ where: { id: current.clip.id }, data: { editorRevision: 4 } });
    await expect(bundleService.previewExportBundle({
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      pricingTier: "business",
      role: "owner",
      status: "active",
    }, {
      clips: [{ clipId: current.clip.id, expectedEditorRevision: 3 }],
      aspectRatios: ["9:16"],
      resolution: "1080p",
    })).resolves.toMatchObject({
      counts: { eligible: 0, stale: 1, ineligible: 0 },
      items: [{
        clipId: current.clip.id,
        currentEditorRevision: 4,
        status: "stale",
        code: "campaign_clip_stale",
      }],
    });
    await expect(bundleService.createExportBundle({
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      pricingTier: "business",
      role: "owner",
      status: "active",
      idempotencyKey: randomUUID(),
    }, { clips: [{ clipId: current.clip.id, expectedEditorRevision: 3 }], aspectRatios: ["9:16"], resolution: "1080p" })).rejects.toMatchObject({ code: "export_bundle_empty" });

    const exactRevision = await fixture("bundle-exact-export-revision");
    await prisma.clipExport.update({ where: { id: exactRevision.clipExport.id }, data: { editorRevision: 2 } });
    await expect(bundleService.createExportBundle({
      actorUserId: exactRevision.user.id,
      workspaceId: exactRevision.workspace.id,
      projectId: exactRevision.project.id,
      pricingTier: "business",
      role: "owner",
      status: "active",
      idempotencyKey: randomUUID(),
    }, { clips: [{ clipId: exactRevision.clip.id, expectedEditorRevision: 3 }], aspectRatios: ["9:16"], resolution: "1080p" })).rejects.toMatchObject({ code: "export_bundle_empty" });
  });

	test("retries an export bundle admission failure by source operation", async () => {
		const current = await fixture("bundle-admission-retry");
		const sourceKey = randomUUID();
		const failing = new CampaignOperationService(async () => {
			throw new Error("injected_bundle_admission_failure");
		});
		await expect(failing.createExportBundle({
			actorUserId: current.user.id,
			workspaceId: current.workspace.id,
			projectId: current.project.id,
			pricingTier: "business",
			role: "owner",
			status: "active",
			idempotencyKey: sourceKey,
		}, {
			clips: [{ clipId: current.clip.id, expectedEditorRevision: 3 }],
			aspectRatios: ["9:16"],
			resolution: "1080p",
		})).rejects.toThrow("injected_bundle_admission_failure");
		const source = await prisma.campaignOperation.findUniqueOrThrow({
			where: { workspaceId_projectId_action_idempotencyKey: {
				workspaceId: current.workspace.id,
				projectId: current.project.id,
				action: "export_bundle",
				idempotencyKey: sourceKey,
			} },
			include: { bundle: true, items: true },
		});
		expect(source.bundle).toBeNull();
		expect(source.items[0]).toMatchObject({ status: "failed", errorCode: "export_bundle_admission_failed" });

		const succeeding = new CampaignOperationService(async ({ projectId, idempotencyKey, stage }) => prisma.workflowRun.create({
			data: { projectId, idempotencyKey, stage, status: "queued" },
			select: { id: true },
		}));
		const retried = await succeeding.retryExportBundleOperation({
			actorUserId: current.user.id,
			workspaceId: current.workspace.id,
			projectId: current.project.id,
			pricingTier: "business",
			role: "owner",
			status: "active",
			idempotencyKey: randomUUID(),
		}, source.id);
		const retry = await prisma.campaignOperation.findUniqueOrThrow({ where: { id: retried.operationId } });
		expect(retry.retryOfId).toBe(source.id);
		expect(retried.manifest.included.map((item) => item.clipId)).toEqual([current.clip.id]);
	});

  test("allows only one concurrent retry and selects failed admission items", async () => {
    const current = await fixture("campaign-retry");
    const source = await prisma.campaignOperation.create({ data: {
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      actorUserId: current.user.id,
      action: "render_selected",
      idempotencyKey: randomUUID(),
      requestFingerprint: randomUUID(),
			validatedOptions: { aspectRatios: [], resolution: "1080p" },
			pricingTier: "business",
      status: "failed",
      requestedCount: 1,
      failedCount: 1,
      items: { create: { requestedClipId: current.clip.id, clipId: current.clip.id, expectedEditorRevision: 3, status: "failed", errorCode: "campaign_render_admission_failed" } },
    } });
    const execute = async (clipIds: string[]) => ({ workflowRunId: randomUUID(), acceptedAt: new Date().toISOString(), initialSeq: 1, clipCount: clipIds.length, variantCount: 1, resolution: "1080p" as const });
    const outcomes = await Promise.allSettled([0, 1].map(() => campaignOperationService.retryRenderSelected({
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      pricingTier: "business",
      sourceOperationId: source.id,
      idempotencyKey: randomUUID(),
      resolution: "1080p",
      execute,
    })));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => (outcome as PromiseRejectedResult).reason)).toEqual([expect.any(CampaignOperationError)]);
    expect(await prisma.campaignOperation.count({ where: { retryOfId: source.id } })).toBe(1);
  });

	test("persists only the selected Facebook Page and consumes the selection once", async () => {
		const current = await fixture("facebook-page-selection");
		const state = randomUUID().replaceAll("-", "");
		await prisma.socialOAuthState.create({ data: {
			userId: current.user.id,
			workspaceId: current.workspace.id,
			createdByUserId: current.user.id,
			platform: "facebook_reels",
			state,
			redirectPath: "/settings/social",
			expiresAt: new Date(Date.now() + 15 * 60_000),
		} });
		const originalFetch = globalThis.fetch;
		const responses = [
			new Response(JSON.stringify({ access_token: "short-token", scope: "pages_show_list,pages_read_engagement,pages_manage_posts" }), { status: 200 }),
			new Response(JSON.stringify({ access_token: "long-token", expires_in: 3600 }), { status: 200 }),
			new Response(JSON.stringify({ data: [
				{ permission: "pages_show_list", status: "granted" },
				{ permission: "pages_read_engagement", status: "granted" },
				{ permission: "pages_manage_posts", status: "granted" },
			] }), { status: 200 }),
			new Response(JSON.stringify({ data: [
				{ id: "page-a", name: "Page A", access_token: "page-token-a", tasks: ["CREATE_CONTENT"] },
				{ id: "page-b", name: "Page B", access_token: "page-token-b", tasks: ["CREATE_CONTENT"] },
			] }), { status: 200 }),
		];
		globalThis.fetch = async () => responses.shift() ?? new Response(null, { status: 500 });
		try {
			const callback = await socialOAuthService.handleCallback({ state, code: "provider-code", origin: "https://app.example.test" });
			expect(callback.facebookSelectionToken).toBe(state);
			await expect(socialOAuthService.getFacebookPageSelection(current.user.id, randomUUID(), state)).rejects.toMatchObject({ code: "social_facebook_selection_invalid" });
			expect(await socialOAuthService.getFacebookPageSelection(current.user.id, current.workspace.id, state)).toEqual([
				{ id: "page-a", name: "Page A", avatarUrl: null },
				{ id: "page-b", name: "Page B", avatarUrl: null },
			]);
			await prisma.socialOAuthState.update({ where: { state }, data: { expiresAt: new Date(Date.now() - 1_000) } });
			await expect(socialOAuthService.getFacebookPageSelection(current.user.id, current.workspace.id, state)).rejects.toMatchObject({ code: "social_facebook_selection_invalid" });
			await prisma.socialOAuthState.update({ where: { state }, data: { expiresAt: new Date(Date.now() + 15 * 60_000) } });
			const selected = await socialOAuthService.completeFacebookPageSelection(current.user.id, current.workspace.id, state, "page-b");
			expect(selected).toMatchObject({ platform: "facebook_reels", providerAccountId: "page-b", displayName: "Page B" });
			await expect(socialOAuthService.completeFacebookPageSelection(current.user.id, current.workspace.id, state, "page-a")).rejects.toMatchObject({ code: "social_facebook_selection_invalid" });
			expect(await prisma.socialAccount.findMany({ where: { userId: current.user.id, platform: "facebook_reels" }, select: { providerAccountId: true } })).toEqual([{ providerAccountId: "page-b" }]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

  test("revokes replayed guest sessions, isolates media IDs, and serializes opposite decisions", async () => {
    const current = await fixture("review-security");
    const foreign = await fixture("review-foreign");
    const variant = current.clipExport.variants[0]!;
    const created = await reviewService.createRound({ actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" }, {
      title: "Client round",
      message: null,
      passcode: "review-secret",
      expiresAt: null,
      allowDownloads: false,
      approvalRequired: true,
      recipientEmails: ["client@example.test"],
      items: [{ clipId: current.clip.id, exportId: current.clipExport.id, expectedEditorRevision: 3, variantIds: [variant.id], required: true }],
    });
    const persistedRound = await prisma.reviewRound.findUniqueOrThrow({ where: { id: created.id } });
    expect(persistedRound.deliveryTokenEncrypted).not.toContain(created.token);
    expect(await prisma.reviewNotificationLedger.count({ where: { reviewRoundId: created.id, kind: "round_sent" } })).toBe(1);
		await expect(reviewService.inviteReviewers(
			{ actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" },
			created.id,
			{ recipientEmails: ["SECOND@example.test", "second@example.test"] },
		)).resolves.toEqual({
			addedCount: 1,
			recipientEmails: ["client@example.test", "second@example.test"],
		});
		await expect(reviewService.inviteReviewers(
			{ actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" },
			created.id,
			{ recipientEmails: ["second@example.test"] },
		)).resolves.toMatchObject({ addedCount: 0 });
		await Promise.all([
			reviewService.inviteReviewers(
				{ actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" },
				created.id,
				{ recipientEmails: ["third@example.test"] },
			),
			reviewService.inviteReviewers(
				{ actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" },
				created.id,
				{ recipientEmails: ["fourth@example.test"] },
			),
		]);
		expect((await prisma.reviewRound.findUniqueOrThrow({ where: { id: created.id } })).recipientEmails).toEqual([
			"client@example.test",
			"fourth@example.test",
			"second@example.test",
			"third@example.test",
		]);
		expect(await prisma.reviewNotificationLedger.count({ where: { reviewRoundId: created.id, kind: "round_sent" } })).toBe(4);
		expect(await prisma.reviewAuditEvent.count({ where: { reviewRoundId: created.id, kind: "reviewers_invited" } })).toBe(3);
    await expect(reviewService.authenticate(created.token, { identity: "Client", email: "client@example.test", passcode: "wrong-passcode" }, "203.0.113.10", sessionSecret)).rejects.toMatchObject({ code: "review_access_invalid" });
    const firstSession = await reviewService.authenticate(created.token, { identity: "Client", email: "client@example.test", passcode: "review-secret" }, "203.0.113.10", sessionSecret);
    const secondSession = await reviewService.authenticate(created.token, { identity: "Client updated", email: "CLIENT@example.test", passcode: "review-secret" }, "203.0.113.10", sessionSecret);
		const additionalSessions = [];
		for (let index = 0; index < 10; index += 1) {
			additionalSessions.push(await reviewService.authenticate(created.token, { identity: `Reviewer ${index + 1}`, email: `reviewer-${index + 1}@example.test`, passcode: "review-secret" }, "203.0.113.10", sessionSecret));
		}
		expect(additionalSessions).toHaveLength(10);
    await expect(reviewService.readRound(firstSession, sessionSecret)).rejects.toMatchObject({ code: "review_session_invalid" });
    const snapshot = await reviewService.readRound(secondSession, sessionSecret);
    const item = snapshot.round.items[0]!;
    await expect(reviewService.resolveMedia(secondSession, sessionSecret, item.id, foreign.clipExport.variants[0]!.id)).rejects.toMatchObject({ code: "review_media_not_found" });
    await expect(reviewService.resolveMedia(secondSession, sessionSecret, item.id, variant.id, "download")).rejects.toMatchObject({ code: "review_download_forbidden" });
    await expect(reviewService.addComment(secondSession, sessionSecret, { itemId: null, parentId: null, body: "Impossible round timecode", timestampSec: 1 })).rejects.toMatchObject({ code: "review_timecode_requires_item" });
    await expect(reviewService.addComment(secondSession, sessionSecret, { itemId: item.id, parentId: null, body: "Past the frozen export", timestampSec: 11 })).rejects.toMatchObject({ code: "review_timecode_out_of_range" });
		const parentComment = await reviewService.addComment(secondSession, sessionSecret, { itemId: item.id, parentId: null, body: "At the exact end", timestampSec: 10 });
		const internalReplyParent = await reviewService.addComment(secondSession, sessionSecret, { itemId: item.id, parentId: null, body: "Please have the team respond", timestampSec: null });
		await reviewService.addInternalComment(
			{ workspaceId: current.workspace.id, projectId: current.project.id, actorUserId: current.user.id },
			created.id,
			{ itemId: item.id, parentId: internalReplyParent.id, body: "@client@example.test Please check this note", timestampSec: null, mentionRecipients: ["client@example.test"] },
		);
		expect(await prisma.reviewNotificationLedger.count({ where: { reviewRoundId: created.id, kind: "mention" } })).toBe(1);
		const concurrentEdits = await Promise.all([
			reviewService.editComment(secondSession, sessionSecret, parentComment.id, { body: "Edit from browser A" }),
			reviewService.editComment(secondSession, sessionSecret, parentComment.id, { body: "Edit from browser B" }),
		]);
		expect(concurrentEdits).toHaveLength(2);
		expect(["Edit from browser A", "Edit from browser B"]).toContain((await prisma.reviewComment.findUniqueOrThrow({ where: { id: parentComment.id } })).body);
		const concurrentResolution = await Promise.all([
			reviewService.resolveComment({ workspaceId: current.workspace.id, projectId: current.project.id, actorUserId: current.user.id }, created.id, parentComment.id, true),
			reviewService.resolveComment({ workspaceId: current.workspace.id, projectId: current.project.id, actorUserId: current.user.id }, created.id, parentComment.id, false),
		]);
		expect(concurrentResolution).toHaveLength(2);
		expect(await prisma.reviewAuditEvent.count({ where: { reviewRoundId: created.id, targetId: parentComment.id, kind: { in: ["comment_edited", "comment_resolved", "comment_reopened"] } } })).toBe(4);
		const auditPayload = JSON.stringify(await prisma.reviewAuditEvent.findMany({ where: { reviewRoundId: created.id } }));
		for (const secretValue of [created.token, "review-secret", "Client updated", "client@example.test", "second@example.test", "third@example.test", "fourth@example.test", parentComment.body, "https://review.example/private"]) {
			expect(auditPayload).not.toContain(secretValue);
		}
		const reply = await reviewService.addComment(additionalSessions[0]!, sessionSecret, { itemId: item.id, parentId: parentComment.id, body: "Reply", timestampSec: null });
		await expect(reviewService.deleteComment(secondSession, sessionSecret, parentComment.id)).rejects.toMatchObject({ code: "review_comment_has_replies" });
		await expect(reviewService.deleteComment(additionalSessions[0]!, sessionSecret, reply.id)).resolves.toEqual({ deleted: true });
		await expect(reviewService.deleteComment(secondSession, sessionSecret, parentComment.id)).resolves.toEqual({ deleted: true });

    const decisions = await Promise.all([
      reviewService.decide(secondSession, sessionSecret, { itemId: item.id, decision: "approved", reason: null }),
      reviewService.decide(secondSession, sessionSecret, { itemId: item.id, decision: "changes_requested", reason: "Tighten the opening" }),
    ]);
    expect(decisions).toHaveLength(2);
    expect(await prisma.reviewDecision.count({ where: { reviewRoundId: created.id } })).toBe(2);
    expect(await prisma.reviewDecision.count({ where: { reviewRoundId: created.id, supersededAt: null } })).toBe(1);
		await reviewService.decide(secondSession, sessionSecret, { itemId: item.id, decision: "changes_requested", reason: "Tighten the opening" });
		await reviewService.decide(secondSession, sessionSecret, { itemId: item.id, decision: "approved", reason: null });
		await reviewService.decide(secondSession, sessionSecret, { itemId: null, decision: "approved", reason: null });
		expect(await prisma.reviewNotificationLedger.count({ where: { reviewRoundId: created.id, kind: "first_change_requested" } })).toBe(1);
		expect(await prisma.reviewNotificationLedger.count({ where: { reviewRoundId: created.id, kind: "all_approved" } })).toBe(1);
		expect(await prisma.projectAnalyticsEvent.count({ where: { projectId: current.project.id, type: "review_sent" } })).toBe(1);
		expect(await prisma.projectAnalyticsEvent.count({ where: { projectId: current.project.id, type: "review_opened" } })).toBe(1);
		expect(await prisma.projectAnalyticsEvent.count({ where: { projectId: current.project.id, type: "review_first_comment" } })).toBe(1);
		expect(await prisma.projectAnalyticsEvent.count({ where: { projectId: current.project.id, type: "review_changes_requested" } })).toBe(1);
		expect(await prisma.projectAnalyticsEvent.count({ where: { projectId: current.project.id, type: "review_item_approved" } })).toBeGreaterThanOrEqual(1);
		expect(await prisma.projectAnalyticsEvent.count({ where: { projectId: current.project.id, type: "campaign_approved" } })).toBe(1);
		for (let attempt = 0; attempt < 7; attempt += 1) {
			await expect(reviewService.authenticate(created.token, { identity: "Attacker", email: "attacker@example.test", passcode: "wrong-passcode" }, "203.0.113.10", sessionSecret)).rejects.toMatchObject({ code: "review_access_invalid" });
		}
			await expect(reviewService.authenticate(created.token, { identity: "Attacker", email: "attacker@example.test", passcode: "wrong-passcode" }, "203.0.113.10", sessionSecret)).rejects.toMatchObject({ code: "review_access_rate_limited" });
			await prisma.reviewRound.update({ where: { id: created.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
			expect(await reviewService.recordExpiredRounds(100)).toBe(1);
			expect(await reviewService.recordExpiredRounds(100)).toBe(0);
			await expect(reviewService.readRound(secondSession, sessionSecret)).rejects.toBeInstanceOf(ReviewServiceError);
		expect(await prisma.projectAnalyticsEvent.count({ where: { projectId: current.project.id, type: "review_expired" } })).toBe(1);
		await prisma.reviewRound.update({ where: { id: created.id }, data: { expiresAt: null } });
		await reviewService.revokeRound({ workspaceId: current.workspace.id, projectId: current.project.id, actorUserId: current.user.id }, created.id);
		expect(await prisma.projectAnalyticsEvent.count({ where: { projectId: current.project.id, type: "review_revoked" } })).toBe(1);
		await expect(reviewService.inviteReviewers(
			{ actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" },
			created.id,
			{ recipientEmails: ["late@example.test"] },
		)).rejects.toMatchObject({ code: "review_round_closed" });
    await expect(reviewService.readRound(secondSession, sessionSecret)).rejects.toBeInstanceOf(ReviewServiceError);
  });

  test("allocates concurrent review revisions and freezes scene-template insertion", async () => {
    const current = await fixture("review-revisions-scenes");
    const variant = current.clipExport.variants[0]!;
    const input = (title: string) => ({
      title,
      message: null,
      passcode: null,
      expiresAt: null,
      allowDownloads: true,
      approvalRequired: false,
      items: [{ clipId: current.clip.id, exportId: current.clipExport.id, expectedEditorRevision: 3, variantIds: [variant.id], required: true }],
    });
    const rounds = await Promise.all([
      reviewService.createRound({ actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" }, input("Round A")),
      reviewService.createRound({ actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" }, input("Round B")),
    ]);
    expect(rounds.map((round) => round.revision).sort()).toEqual([1, 2]);
    expect(await prisma.reviewRound.count({ where: { projectId: current.project.id, status: "open" } })).toBe(1);
		const resubmitted = await reviewService.createRound(
			{ actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" },
			input("Round C"),
		);
		expect(resubmitted.revision).toBe(3);
		expect(rounds.map((round) => round.token)).not.toContain(resubmitted.token);
		expect(await prisma.reviewRound.count({ where: { projectId: current.project.id, status: "open" } })).toBe(1);
		const reviewSession = await reviewService.authenticate(
			resubmitted.token,
			{ identity: "Client", email: "client@example.test", passcode: null },
			"203.0.113.77",
			sessionSecret,
		);
		const unresolved = await reviewService.addComment(reviewSession, sessionSecret, {
			itemId: null,
			parentId: null,
			body: "Keep the disclosure closer to the opening.",
			timestampSec: null,
		});
		const intervening = await reviewService.createRound(
			{ actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" },
			input("Round D"),
		);
		await reviewService.revokeRound(
			{ workspaceId: current.workspace.id, projectId: current.project.id, actorUserId: current.user.id },
			intervening.id,
		);
		const linked = await reviewService.createRound(
			{ actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" },
			{ ...input("Round E"), contextCommentIds: [unresolved.id] },
		);
		expect(linked.revision).toBe(5);
		expect(await prisma.reviewRoundContext.count({ where: { reviewRoundId: linked.id, sourceCommentId: unresolved.id } })).toBe(1);
			expect((await reviewService.internalRoom(current.workspace.id, current.project.id, "manage")).rounds[0]?.context).toEqual([
				expect.objectContaining({ sourceCommentId: unresolved.id, sourceRoundRevision: 3, body: unresolved.body }),
			]);
			const viewerRoom = await reviewService.internalRoom(current.workspace.id, current.project.id, "view");
			const viewerSourceRound = viewerRoom.rounds.find((round) => round.id === resubmitted.id);
			expect(viewerRoom.candidates).toEqual([]);
			expect(viewerSourceRound).toMatchObject({
				path: null,
				recipientEmails: [],
				auditEvents: [],
				notifications: [],
				context: [],
			});
			expect(viewerSourceRound?.comments[0]?.authorName).toBe("Client reviewer");
			expect(viewerSourceRound?.guests[0]).toMatchObject({ displayName: null, email: null });
			expect(JSON.stringify(viewerRoom)).not.toContain(resubmitted.token);
			expect(JSON.stringify(viewerRoom)).not.toContain("client@example.test");
		expect(await prisma.projectAnalyticsEvent.count({ where: { projectId: current.project.id, type: "review_resubmitted" } })).toBe(4);

    const profile = await prisma.brandProfile.create({ data: {
      workspaceId: current.workspace.id,
      name: "Launch system",
      slug: `launch-${randomUUID()}`,
      visualIdentity: {},
      voiceGuidance: {},
      createdByUserId: current.user.id,
      updatedByUserId: current.user.id,
    } });
    const scope = { actorUserId: current.user.id, workspaceId: current.workspace.id, workspaceOwnerUserId: current.user.id, role: "owner" as const, status: "active" as const, pricingTier: "business" as const, isPersonalWorkspace: false };
    const retainedAsset = await prisma.visualAsset.create({
      data: {
        workspaceId: current.workspace.id,
        createdByUserId: current.user.id,
        title: "Retained opener",
        kind: "image",
        storageKey: `test/retained-${randomUUID()}.png`,
        contentType: "image/png",
        sizeBytes: 128,
        width: 1080,
        height: 1080,
        fingerprint: "c".repeat(64),
        deletedAt: new Date(),
      },
    });
    const retainedScene = editorDocumentSchema.parse({
      version: 2,
      clipStartSec: 0,
      clipEndSec: 10,
      captionPreset: {},
      transcriptSlice: [],
      studioEdits: {},
      brollUrl: null,
      deletedRanges: [],
      sceneBlocks: [{
        id: randomUUID(),
        schemaVersion: 1,
        anchorSec: 0,
        durationSec: 2,
        content: {
          kind: "image",
          asset: { kind: "visual_asset", id: retainedAsset.id, fingerprint: retainedAsset.fingerprint },
          fit: "cover",
          backgroundColor: "#000000",
        },
        motion: { entrance: "none", exit: "none" },
        templateSnapshot: null,
      }],
    }).sceneBlocks;
    await expect(
      visualAssetService.assertSceneReferencesWithPolicy(scope, retainedScene, true),
    ).resolves.toBeUndefined();
    await expect(
      visualAssetService.assertSceneReferences(scope, retainedScene),
    ).rejects.toMatchObject({ code: "scene_visual_asset_invalid" });
    const sourceFont = await prisma.brandFont.create({
      data: {
        workspaceId: current.workspace.id,
        licenseConfirmedByUserId: current.user.id,
        family: "Launch Display",
        style: "Regular",
        weight: 400,
        format: "ttf",
        storageKey: `test/font-${randomUUID()}.ttf`,
        sizeBytes: 128,
        fingerprint: "d".repeat(64),
        licenseConfirmedAt: new Date(),
        profiles: { create: { profileId: profile.id, role: "display" } },
      },
    });
    const replacementFont = await prisma.brandFont.create({
      data: {
        workspaceId: current.workspace.id,
        licenseConfirmedByUserId: current.user.id,
        family: "Launch Display Next",
        style: "Regular",
        weight: 400,
        format: "ttf",
        storageKey: `test/font-${randomUUID()}.ttf`,
        sizeBytes: 128,
        fingerprint: "e".repeat(64),
        licenseConfirmedAt: new Date(),
      },
    });
    const fontTemplate = await sceneTemplateService.create(scope, profile.id, {
      name: "Font-protected card",
      role: "inline",
      makeDefault: false,
      definition: {
        schemaVersion: 1,
        durationSec: 3,
        content: {
          kind: "text",
          text: "Protected typography",
          fontFamily: sourceFont.family,
          fontAsset: { kind: "brand_font", id: sourceFont.id, fingerprint: sourceFont.fingerprint },
          color: "#FFFFFF",
          backgroundColor: "#111827",
        },
        motion: { entrance: "fade", exit: "fade" },
      },
    });
    await expect(
      brandFontService.softDelete(scope, sourceFont.id, { replacementId: replacementFont.id }),
    ).rejects.toBeInstanceOf(BrandFontReferenceError);
    await prisma.sceneTemplate.update({
      where: { id: fontTemplate.id },
      data: { deletedAt: new Date() },
    });
    const template = await sceneTemplateService.create(scope, profile.id, {
      name: "Opening card",
      role: "intro",
      makeDefault: true,
      definition: { schemaVersion: 1, durationSec: 3, content: { kind: "text", text: "Launch day", fontFamily: "Arial", fontAsset: null, color: "#FFFFFF", backgroundColor: "#111827" }, motion: { entrance: "fade", exit: "fade" } },
    });
    const frozen = await sceneTemplateService.freezeForInsertion(scope, profile.id, template.id, { id: randomUUID(), anchorSec: 0 });
    await sceneTemplateService.update(scope, profile.id, template.id, { expectedRevision: template.revision, definition: { schemaVersion: 1, durationSec: 3, content: { kind: "text", text: "Changed later", fontFamily: "Arial", fontAsset: null, color: "#FFFFFF", backgroundColor: "#111827" }, motion: { entrance: "fade", exit: "fade" } } });
    expect(frozen.content).toMatchObject({ kind: "text", text: "Launch day" });
		const document = editorDocumentSchema.parse({ version: 2, clipStartSec: 0, clipEndSec: 10, captionPreset: {}, transcriptSlice: [], studioEdits: {}, brollUrl: null, deletedRanges: [] });
    const once = applyEditorAction(document, { type: "insertSceneBlock", scene: frozen });
    const twice = applyEditorAction(once, { type: "insertSceneBlock", scene: { ...frozen, id: randomUUID() } });
    expect(twice).toBe(once);

    const latestTemplate = await prisma.sceneTemplate.findUniqueOrThrow({ where: { id: template.id } });
    const applied = await campaignOperationService.applySceneTemplate({
      ...scope,
      projectId: current.project.id,
      idempotencyKey: randomUUID(),
    }, profile.id, template.id, {
      templateFingerprint: latestTemplate.fingerprint,
      placement: "start",
      clips: [{ clipId: current.clip.id, expectedEditorRevision: 3 }],
    });
    expect(applied.counts).toEqual({ succeeded: 1, unchanged: 0, stale: 0, ineligible: 0, failed: 0 });
    const reapplied = await campaignOperationService.applySceneTemplate({
      ...scope,
      projectId: current.project.id,
      idempotencyKey: randomUUID(),
    }, profile.id, template.id, {
      templateFingerprint: latestTemplate.fingerprint,
      placement: "start",
      clips: [{ clipId: current.clip.id, expectedEditorRevision: 4 }],
    });
    expect(reapplied.counts).toEqual({ succeeded: 0, unchanged: 1, stale: 0, ineligible: 0, failed: 0 });
    const persisted = await clipEditorDocumentPersistence.readDocument({
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      workspaceOwnerUserId: current.user.id,
      projectId: current.project.id,
      clipId: current.clip.id,
    });
    expect(persisted.document.sceneBlocks).toHaveLength(1);

    const appliedAtEnd = await campaignOperationService.applySceneTemplate({
      ...scope,
      projectId: current.project.id,
      idempotencyKey: randomUUID(),
    }, profile.id, template.id, {
      templateFingerprint: latestTemplate.fingerprint,
      placement: "end",
      clips: [{ clipId: current.clip.id, expectedEditorRevision: persisted.revision }],
    });
    expect(appliedAtEnd.counts.succeeded).toBe(1);
    const afterEnd = await clipEditorDocumentPersistence.readDocument({
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      workspaceOwnerUserId: current.user.id,
      projectId: current.project.id,
      clipId: current.clip.id,
    });
    const reappliedAtEnd = await campaignOperationService.applySceneTemplate({
      ...scope,
      projectId: current.project.id,
      idempotencyKey: randomUUID(),
    }, profile.id, template.id, {
      templateFingerprint: latestTemplate.fingerprint,
      placement: "end",
      clips: [{ clipId: current.clip.id, expectedEditorRevision: afterEnd.revision }],
    });
    expect(reappliedAtEnd.counts.unchanged).toBe(1);
    const finalDocument = await clipEditorDocumentPersistence.readDocument({
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      workspaceOwnerUserId: current.user.id,
      projectId: current.project.id,
      clipId: current.clip.id,
    });
    expect(finalDocument.document.sceneBlocks).toHaveLength(2);
    const createdExport = await clipExportService.create(
      current.project.id,
      current.clip.id,
      { expectedRevision: finalDocument.revision, aspectRatios: ["9:16"], resolution: "1080p" },
      randomUUID(),
      { workspaceId: current.workspace.id, actorUserId: current.user.id },
    );
    const render = await prisma.clipRender.findFirstOrThrow({
      where: { exportVariant: { exportId: createdExport.export.id } },
      select: { clipSnapshot: true },
    });
    expect(Reflect.get(render.clipSnapshot as object, "editorDocumentVersion")).toBe(2);
    expect(Reflect.get(render.clipSnapshot as object, "sceneBlocks")).toHaveLength(2);
  });
});
