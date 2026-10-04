import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { AutopilotService } from "./autopilot.service";
import { analyticsService } from "./analytics.service";
import { clipExportService } from "./clip-export.service";
import { contentSuiteService } from "./content-suite.service";
import { dubbingService } from "./dubbing.service";
import { campaignOperationService } from "./campaign-operation.service";
import { brandTemplateService } from "./brand-template.service";
import { socialOAuthService } from "./social-oauth.service";
import { brandTemplateInputSchema, contentPackSchema, DEFAULT_CAPTION_PRESET } from "@narriflow/validators";

const CONTENT_PACK = contentPackSchema.parse({
  outputTypes: ["short_clip"],
  clipCountTarget: 10,
  clipDurationSecTarget: 45,
  platformPlaybookVersion: "2026-10-04",
});

setDefaultTimeout(180_000);

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
  let editorId = "";
  let adminId = "";
  let projectId = "";

  beforeAll(async () => {
    const databaseUrl = process.env.VIZARD_EXPANSION_TEST_DATABASE_URL;
    const schema = process.env.VIZARD_EXPANSION_TEST_DATABASE_SCHEMA;
    if (!databaseUrl || !schema) throw new Error("Disposable Autopilot test schema is required");
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-csearch_path=${schema}` });
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
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: "owner" } });
    const editor = await prisma.user.create({ data: { clerkId: `rss-editor-${suffix}` } });
    const admin = await prisma.user.create({ data: { clerkId: `rss-admin-${suffix}` } });
    editorId = editor.id;
    adminId = admin.id;
    await prisma.workspaceMember.createMany({ data: [{ workspaceId, userId: editorId, role: "editor" }, { workspaceId, userId: adminId, role: "admin" }] });
    const project = await prisma.project.create({ data: { workspaceId, createdByUserId: userId, title: "Shared service access", sourceMediaUrl: "https://cdn.example.test/shared.mp4", sourceType: "upload" } });
    projectId = project.id;
    const rule = await prisma.autopilotRule.create({
      data: {
        workspaceId,
        createdByUserId: userId,
        name: "DB concurrency",
        rssUrl: "https://feeds.example.test/show.xml",
        contentPack: CONTENT_PACK,
        initializedAt: new Date(),
        nextRunAt: new Date(),
      },
    });
    ruleId = rule.id;
  });

  afterAll(async () => {
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    if (prisma && userId) {
      await prisma.workspace.deleteMany({ where: { id: workspaceId } });
      await prisma.user.deleteMany({ where: { id: { in: [userId, editorId, adminId].filter(Boolean) } } });
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
            createdByUserId: userId,
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
        workspaceId,
        createdByUserId: userId,
        name: "Expired lease",
        rssUrl: "https://feeds.example.test/expired.xml",
        contentPack: CONTENT_PACK,
        status: "running",
        claimToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    const live = await prisma.autopilotRule.create({
      data: {
        workspaceId,
        createdByUserId: userId,
        name: "Live lease",
        rssUrl: "https://feeds.example.test/live.xml",
        contentPack: CONTENT_PACK,
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

  test("shared service reads and mutations use the current non-owner actor", async () => {
    const scope = { actorUserId: editorId, workspaceId };
    expect((await new AutopilotService().listRules(scope)).some((rule) => rule.id === ruleId)).toBe(true);
    await new AutopilotService().updateRule(scope, ruleId, { name: "Edited by member" });
    expect((await prisma.autopilotRule.findUniqueOrThrow({ where: { id: ruleId } })).updatedByUserId).toBe(editorId);
    expect(await contentSuiteService.list(scope, projectId)).toEqual([]);
    expect(await dubbingService.listProjectDubs(scope, projectId)).toEqual([]);
    expect(await clipExportService.listCurrentProjectExports(scope, projectId)).toEqual([]);
    expect((await analyticsService.getProjectAnalytics(scope, projectId)).projectId).toBe(projectId);
    expect(await campaignOperationService.listOperations({ ...scope, projectId })).toEqual([]);
    const brand = await brandTemplateService.create(scope, brandTemplateInputSchema.parse({ name: "Member brand", captionPreset: DEFAULT_CAPTION_PRESET }));
    const savedBrand = await prisma.brandTemplate.findUniqueOrThrow({ where: { id: brand.id } });
    expect(savedBrand).toMatchObject({ userId, workspaceId, createdByUserId: editorId, updatedByUserId: editorId });
    await brandTemplateService.update(scope, brand.id, { name: "Updated member brand" });
    expect((await brandTemplateService.get(scope, brand.id)).name).toBe("Updated member brand");
    const foreign = await prisma.workspace.create({ data: { name: "Other Workspace", ownerUserId: userId } });
    try {
      const outside = await prisma.project.create({ data: { workspaceId: foreign.id, createdByUserId: userId, title: "Outside", sourceMediaUrl: "https://cdn.example.test/outside.mp4", sourceType: "upload" } });
      await expect(contentSuiteService.list(scope, outside.id)).rejects.toMatchObject({ code: "not_found" });
      await expect(analyticsService.getProjectAnalytics(scope, outside.id)).rejects.toMatchObject({ code: "analytics_project_not_found" });
      await expect(campaignOperationService.listOperations({ ...scope, projectId: outside.id })).rejects.toMatchObject({ code: "campaign_operation_not_found" });
      expect(await clipExportService.listCurrentProjectExports(scope, outside.id)).toEqual([]);
      expect(await dubbingService.listProjectDubs(scope, outside.id)).toEqual([]);
    } finally {
      await prisma.workspace.delete({ where: { id: foreign.id } });
    }
    await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: editorId } }, data: { role: "viewer" } });
    expect(await contentSuiteService.list(scope, projectId)).toEqual([]);
    for (const mutation of [
      () => new AutopilotService().updateRule(scope, ruleId, { name: "Forbidden" }),
      () => contentSuiteService.generate(scope, projectId),
      () => dubbingService.requestClipDub(scope, projectId, randomUUID(), { clipId: randomUUID(), aspectRatio: "9:16", targetLanguageCode: "es", voice: "marin" }),
      () => clipExportService.create(scope, projectId, randomUUID(), { expectedRevision: 0, aspectRatios: ["9:16"], resolution: "720p" }, randomUUID()),
      () => brandTemplateService.update(scope, brand.id, { name: "Forbidden" }),
      () => campaignOperationService.applyMotionSelected({ ...scope, projectId, pricingTier: "business", role: "owner", status: "active", idempotencyKey: randomUUID() }, {}),
    ]) await expect(mutation()).rejects.toMatchObject({ code: "workspace_access_denied" });
    await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId: editorId } } });
    for (const read of [
      () => new AutopilotService().listRules(scope),
      () => contentSuiteService.list(scope, projectId),
      () => dubbingService.listProjectDubs(scope, projectId),
      () => clipExportService.listCurrentProjectExports(scope, projectId),
      () => analyticsService.getProjectAnalytics(scope, projectId),
      () => campaignOperationService.listOperations({ ...scope, projectId }),
      () => brandTemplateService.list(scope),
      () => socialOAuthService.listAccounts(scope),
    ]) await expect(read()).rejects.toMatchObject({ code: "workspace_access_denied" });
    await prisma.workspaceMember.create({ data: { workspaceId, userId: editorId, role: "editor" } });
    await prisma.project.update({ where: { id: projectId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    try {
      await expect(contentSuiteService.list(scope, projectId)).rejects.toMatchObject({ code: "not_found" });
      await expect(analyticsService.getProjectAnalytics(scope, projectId)).rejects.toMatchObject({ code: "analytics_project_not_found" });
      await expect(campaignOperationService.listOperations({ ...scope, projectId })).rejects.toMatchObject({ code: "campaign_operation_not_found" });
      expect(await clipExportService.listCurrentProjectExports(scope, projectId)).toEqual([]);
      expect(await dubbingService.listProjectDubs(scope, projectId)).toEqual([]);
    } finally {
      await prisma.project.update({ where: { id: projectId }, data: { expiresAt: null } });
    }
  });

  test("OAuth callback rechecks its actual connecting actor and keeps attribution distinct from credential ownership", async () => {
    const scope = { actorUserId: adminId, workspaceId };
    const previousClientId = process.env.LINKEDIN_CLIENT_ID;
    const previousClientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    const originalFetch = globalThis.fetch;
    process.env.LINKEDIN_CLIENT_ID = "scope-test-client";
    process.env.LINKEDIN_CLIENT_SECRET = "scope-test-secret";
    try {
      const url = await socialOAuthService.createAuthorizationUrl(scope, { platform: "linkedin", origin: "https://app.example.test" });
      const state = new URL(url).searchParams.get("state")!;
      expect(await prisma.socialOAuthState.findUniqueOrThrow({ where: { state } })).toMatchObject({ userId, workspaceId, createdByUserId: adminId });
      await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId: adminId } } });
      await expect(socialOAuthService.handleCallback({ state, code: "unused-provider-code", origin: "https://app.example.test" })).rejects.toMatchObject({ code: "workspace_access_denied" });
      await prisma.workspaceMember.create({ data: { workspaceId, userId: adminId, role: "admin" } });
      const responses = [
        new Response(JSON.stringify({ access_token: "scope-test-provider-token", scope: "openid profile w_member_social" })),
        new Response(JSON.stringify({ sub: `scope-test-profile-${suffix}`, name: "Connecting admin" })),
      ];
      globalThis.fetch = async () => responses.shift() ?? new Response(null, { status: 500 });
      const connected = await socialOAuthService.handleCallback({ state, code: "scope-test-provider-code", origin: "https://app.example.test" });
      expect(connected.accounts).toHaveLength(1);
      expect(await prisma.socialAccount.findUniqueOrThrow({ where: { id: connected.accounts[0]!.id } })).toMatchObject({ userId, workspaceId, createdByUserId: adminId });
    } finally {
      globalThis.fetch = originalFetch;
      if (previousClientSecret === undefined) delete process.env.LINKEDIN_CLIENT_SECRET;
      else process.env.LINKEDIN_CLIENT_SECRET = previousClientSecret;
      if (previousClientId === undefined) delete process.env.LINKEDIN_CLIENT_ID;
      else process.env.LINKEDIN_CLIENT_ID = previousClientId;
    }
  });

  test("removing an automation creator keeps Workspace rules and history while stopping new imports", async () => {
    const creator = await prisma.user.create({ data: { clerkId: `rss-removable-${suffix}` } });
    await prisma.workspaceMember.create({ data: { workspaceId, userId: creator.id, role: "editor" } });
    const service = new AutopilotService({ fetchFeed: async () => ({ title: "Scoped feed", finalUrl: "https://feeds.example.test/scoped.xml", episodes: [], etag: null, lastModified: null, notModified: false }) });
    const rule = await service.createRule({ actorUserId: creator.id, workspaceId }, { name: "Preserved automation", rssUrl: "https://feeds.example.test/scoped.xml", contentPack: CONTENT_PACK });
    const episode = await prisma.autopilotEpisode.create({ data: { ruleId: rule.id, episodeId: "kept-history", projectId } });
    await prisma.user.delete({ where: { id: creator.id } });
    expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ workspaceId, createdByUserId: null });
    expect((await prisma.autopilotEpisode.findUniqueOrThrow({ where: { id: episode.id } })).projectId).toBe(projectId);
    await prisma.autopilotRule.updateMany({ where: { workspaceId }, data: { nextRunAt: new Date(Date.now() + 86_400_000) } });
    await prisma.autopilotRule.update({ where: { id: rule.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
    let feedsRead = 0;
    const worker = new AutopilotService({ fetchFeed: async () => { feedsRead++; throw new Error("Creatorless automation must not run"); } });
    expect(await worker.processDueRules()).toEqual({ checked: 0, imported: 0, claimLost: 0 });
    expect(feedsRead).toBe(0);
  });
});
