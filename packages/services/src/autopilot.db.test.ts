import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { AutopilotService } from "./autopilot.service";
import { ProcessingUsageError } from "./processing-usage";
import { projectService } from "./project.service";
import { analyticsService } from "./analytics.service";
import { clipExportService } from "./clip-export.service";
import { contentSuiteService } from "./content-suite.service";
import { dubbingService } from "./dubbing.service";
import { campaignOperationService } from "./campaign-operation.service";
import { brandTemplateService } from "./brand-template.service";
import { brandProfileService, BrandProfileNotFoundError } from "./brand-profile.service";
import { recipeService } from "./recipe.service";
import { workspaceService } from "./workspace.service";
import { socialOAuthService } from "./social-oauth.service";
import { brandTemplateInputSchema, contentPackSchema, DEFAULT_CAPTION_PRESET, type RecipeInput } from "@narriflow/validators";
import { listWorkspaceEvents } from "./workspace-event";

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
  let recipeId = "";
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
        pricingTier: "business",
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
    recipeId = (await prisma.recipe.create({ data: { workspaceId, name: "Default settings", contentPack: CONTENT_PACK, createdByUserId: userId } })).id;
    const rule = await prisma.autopilotRule.create({
      data: {
        workspaceId,
        createdByUserId: userId,
        name: "DB concurrency",
        rssUrl: "https://feeds.example.test/show.xml",
        recipeId,
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
        recipeId,
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
        recipeId,
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

  test("an episode deferred for capacity is retried on the next poll", async () => {
    const rule = await prisma.autopilotRule.create({
      data: {
        workspaceId,
        createdByUserId: userId,
        name: "Deferred capacity",
        rssUrl: "https://feeds.example.test/deferred.xml",
        recipeId,
        initializedAt: new Date(),
        lastSeenEpisodeId: "seen-episode",
        lastSeenPublishedAt: new Date("2026-10-01T00:00:00.000Z"),
      },
    });
    const dueOnlyThisRule = async () => {
      await prisma.autopilotRule.updateMany({ where: { workspaceId }, data: { nextRunAt: new Date(Date.now() + 86_400_000) } });
      await prisma.autopilotRule.update({ where: { id: rule.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
    };
    const episodeInput = (id: string, publishedAt: string) => ({ id, title: id, enclosureUrl: `https://cdn.example.test/${id}.mp3`, publishedAt, durationSeconds: 60, mimeType: "audio/mpeg" });
    const requestedEtags: Array<string | null | undefined> = [];
    const worker = new AutopilotService({
      fetchFeed: async (_url, validators) => {
        requestedEtags.push(validators?.etag);
        if (validators?.etag === "feed-v1") return { title: "Deferred feed", finalUrl: "https://feeds.example.test/deferred.xml", episodes: [], etag: "feed-v1", lastModified: null, notModified: true };
        return { title: "Deferred feed", finalUrl: "https://feeds.example.test/deferred.xml", episodes: [episodeInput("new-episode", "2026-10-02T00:00:00.000Z"), episodeInput("seen-episode", "2026-10-01T00:00:00.000Z")], etag: "feed-v1", lastModified: null, notModified: false };
      },
    });
    const importEpisodes = spyOn(projectService, "importResolvedRssEpisodes").mockImplementation(async () => {
      throw new ProcessingUsageError({ code: "workspace_processing_capacity_reached", message: "At capacity", details: { tier: "free", inFlight: 1, inFlightLimit: 1 } });
    });
    try {
      await dueOnlyThisRule();
      await worker.processDueRules();
      expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ etag: null, lastSeenEpisodeId: "seen-episode" });

      await dueOnlyThisRule();
      await worker.processDueRules();
      expect(requestedEtags).toEqual([null, null]);
      expect(importEpisodes).toHaveBeenCalledTimes(2);
    } finally {
      importEpisodes.mockRestore();
    }
  });

  test("removing an automation creator keeps Workspace rules and history while stopping new imports", async () => {
    const creator = await prisma.user.create({ data: { clerkId: `rss-removable-${suffix}` } });
    await prisma.workspaceMember.create({ data: { workspaceId, userId: creator.id, role: "editor" } });
    const service = new AutopilotService({ fetchFeed: async () => ({ title: "Scoped feed", finalUrl: "https://feeds.example.test/scoped.xml", episodes: [], etag: null, lastModified: null, notModified: false }) });
    const rule = await service.createRule({ actorUserId: creator.id, workspaceId }, { name: "Preserved automation", rssUrl: "https://feeds.example.test/scoped.xml", recipeId });
    const episode = await prisma.autopilotEpisode.create({ data: { ruleId: rule.id, episodeId: "kept-history", projectId } });
    await prisma.user.delete({ where: { id: creator.id } });
    expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ workspaceId, createdByUserId: null });
    expect((await prisma.autopilotEpisode.findUniqueOrThrow({ where: { id: episode.id } })).projectId).toBe(projectId);
    await prisma.autopilotRule.updateMany({ where: { workspaceId }, data: { nextRunAt: new Date(Date.now() + 86_400_000) } });
    await prisma.autopilotRule.update({ where: { id: rule.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
    let feedsRead = 0;
    const worker = new AutopilotService({ fetchFeed: async () => { feedsRead++; throw new Error("Creatorless automation must not run"); } });
    expect(await worker.processDueRules()).toEqual({ checked: 1, imported: 0, claimLost: 0 });
    expect(feedsRead).toBe(0);
    // The rule stops with a reason for an Owner or Admin instead of being skipped silently.
    expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({
      status: "paused",
      pauseKind: "acting_member",
      consecutiveFailures: 0,
      claimToken: null,
      leaseExpiresAt: null,
      lastError: expect.stringContaining("Owner or Admin can take it over"),
    });
  });

  describe("Brand Profiles and acting member", () => {
    const episodeInput = (id: string) => ({ id, title: `Episode ${id}`, enclosureUrl: `https://cdn.example.test/${id}.mp3`, publishedAt: "2026-10-02T00:00:00.000Z", durationSeconds: 60, mimeType: "audio/mpeg" });
    const feedWith = (...ids: string[]) => async () => ({ title: "Brand feed", finalUrl: "https://feeds.example.test/brand.xml", episodes: ids.map(episodeInput), etag: null, lastModified: null, notModified: false });
    const createdWorkspaces: string[] = [];
    const createdUsers: string[] = [];

    afterAll(async () => {
      await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaces } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    });

    async function businessFixture(label: string) {
      const owner = await prisma.user.create({ data: { clerkId: `rss-${label}-owner-${randomUUID()}`, firstName: "Olive", lastName: "Owner" } });
      const creator = await prisma.user.create({ data: { clerkId: `rss-${label}-creator-${randomUUID()}`, firstName: "Dana", lastName: "Lee" } });
      const admin = await prisma.user.create({ data: { clerkId: `rss-${label}-admin-${randomUUID()}` } });
      const editor = await prisma.user.create({ data: { clerkId: `rss-${label}-editor-${randomUUID()}` } });
      createdUsers.push(owner.id, creator.id, admin.id, editor.id);
      const workspace = await prisma.workspace.create({ data: {
        name: `Autopilot ${label}`,
        ownerUserId: owner.id,
        pricingTier: "business",
        members: { create: [
          { userId: owner.id, role: "owner" },
          { userId: creator.id, role: "editor" },
          { userId: admin.id, role: "admin" },
          { userId: editor.id, role: "editor" },
        ] },
      } });
      createdWorkspaces.push(workspace.id);
      const brandScope = (userId: string, role: "owner" | "admin" | "editor") => ({
        actorUserId: userId,
        workspaceId: workspace.id,
        workspaceOwnerUserId: owner.id,
        role,
        status: "active" as const,
        pricingTier: "business",
        isPersonalWorkspace: false,
      });
      return { owner, creator, admin, editor, workspace, brandScope };
    }

    /** A Recipe saved through the service by the member who will save the rule. */
    const saveRecipe = (f: Awaited<ReturnType<typeof businessFixture>>, extra: Partial<RecipeInput> = {}, name = "Settings") =>
      recipeService.create({ actorUserId: f.creator.id, workspaceId: f.workspace.id }, { name, contentPack: CONTENT_PACK, ...extra });

    /** Only this rule is due, so processDueRules cannot touch other tests' rules. */
    async function onlyDue(ruleId: string) {
      await prisma.autopilotRule.updateMany({ where: { id: { not: ruleId } }, data: { nextRunAt: new Date(Date.now() + 86_400_000) } });
      await prisma.autopilotRule.update({ where: { id: ruleId }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
    }

    test("a Recipe stores the Workspace default Brand Profile at save time and an explicit null stores none; rules follow the Recipe", async () => {
      const f = await businessFixture("default");
      const first = await brandProfileService.create(f.brandScope(f.owner.id, "owner"), { name: "First", slug: "first" });
      const second = await brandProfileService.create(f.brandScope(f.owner.id, "owner"), { name: "Second", slug: "second" });
      await brandProfileService.setDefault(f.brandScope(f.owner.id, "owner"), first.id);
      const foreign = await businessFixture("foreign");
      const foreignProfile = await brandProfileService.create(foreign.brandScope(foreign.owner.id, "owner"), { name: "Foreign", slug: "foreign" });
      const service = new AutopilotService({ fetchFeed: feedWith() });
      const scope = { actorUserId: f.creator.id, workspaceId: f.workspace.id };

      const omitted = await saveRecipe(f, {}, "Omitted");
      const none = await saveRecipe(f, { brandProfileId: null }, "None");
      const chosen = await saveRecipe(f, { brandProfileId: second.id }, "Chosen");
      expect([omitted.brandProfileId, none.brandProfileId, chosen.brandProfileId]).toEqual([first.id, null, second.id]);

      // Later changes to the Workspace default don't move existing Recipes.
      await brandProfileService.setDefault(f.brandScope(f.owner.id, "owner"), second.id);
      expect((await recipeService.get(scope, omitted.id)).brandProfileId).toBe(first.id);

      await expect(saveRecipe(f, { brandProfileId: foreignProfile.id }, "Foreign")).rejects.toBeInstanceOf(BrandProfileNotFoundError);
      await expect(recipeService.update(scope, omitted.id, { expectedRevision: 1, brandProfileId: foreignProfile.id })).rejects.toBeInstanceOf(BrandProfileNotFoundError);
      expect((await recipeService.update(scope, omitted.id, { expectedRevision: 1, brandProfileId: null })).brandProfileId).toBeNull();
      expect((await recipeService.update(scope, omitted.id, { expectedRevision: 2, brandProfileId: second.id })).brandProfileId).toBe(second.id);

      // A rule carries none of this itself: it follows its Recipe.
      const rule = await service.createRule(scope, { name: "Follows", rssUrl: "https://feeds.example.test/brand.xml", recipeId: chosen.id });
      expect(rule).toMatchObject({ recipeId: chosen.id, recipeName: "Chosen" });
      expect(await service.listRules(scope)).toEqual([expect.objectContaining({ id: rule.id, recipeId: chosen.id })]);
    });

    test("Autopilot imports carry the Recipe's Brand Profile snapshot, including an approval rule", async () => {
      const f = await businessFixture("import");
      const profile = await brandProfileService.create(f.brandScope(f.owner.id, "owner"), { name: "Client", slug: "client", approvalRule: "approval_required" });
      const service = new AutopilotService({ fetchFeed: feedWith("brand-episode") });
      const recipe = await saveRecipe(f, { brandProfileId: profile.id });
      const rule = await service.createRule({ actorUserId: f.creator.id, workspaceId: f.workspace.id }, { name: "Branded", rssUrl: "https://feeds.example.test/brand.xml", recipeId: recipe.id, initialImportMode: "latest", initialImportCount: 1 });
      await onlyDue(rule.id);
      expect(await service.processDueRules()).toMatchObject({ checked: 1, imported: 1 });
      const episode = await prisma.autopilotEpisode.findUniqueOrThrow({ where: { ruleId_episodeId: { ruleId: rule.id, episodeId: "brand-episode" } } });
      const project = await prisma.project.findUniqueOrThrow({ where: { id: episode.projectId! } });
      expect(project).toMatchObject({ sourceType: "rss", brandProfileId: profile.id });
      expect(project.brandProfileSnapshot).toMatchObject({ profileId: profile.id, approvalRule: "approval_required" });
    });

    test("editing a Recipe changes the next Autopilot import, never one already made", async () => {
      const f = await businessFixture("edit-next");
      const scope = { actorUserId: f.creator.id, workspaceId: f.workspace.id };
      const finishing = { topClips: 2, minScore: 0, aspectRatios: ["9:16" as const], copyPlatforms: [], resolution: "1080p" as const, delivery: "ready_to_review" as const, queueAccountIds: [] };
      const recipe = await saveRecipe(f, { brandProfileId: null, languageCode: "en", contentPack: contentPackSchema.parse({ ...CONTENT_PACK, clipCountTarget: 10 }), finishing });
      // The feed gains a newer episode between the two runs.
      let episodes = ["episode-one"];
      const service = new AutopilotService({ fetchFeed: async () => feedWith(...episodes)() });
      const rule = await service.createRule(scope, { name: "Shared", rssUrl: "https://feeds.example.test/brand.xml", recipeId: recipe.id, initialImportMode: "latest", initialImportCount: 1, maxEpisodesPerRun: 1 });
      const importedPack = async (episodeId: string) => {
        const episode = await prisma.autopilotEpisode.findUniqueOrThrow({ where: { ruleId_episodeId: { ruleId: rule.id, episodeId } } });
        const project = await prisma.project.findUniqueOrThrow({ where: { id: episode.projectId! }, include: { contentPacks: true } });
        return { languageCode: project.languageCode, pack: project.contentPacks[0]! };
      };

      await onlyDue(rule.id);
      expect(await service.processDueRules()).toMatchObject({ checked: 1, imported: 1 });
      const before = await importedPack("episode-one");
      // The Project records which Recipe revision its settings came from.
      expect(before).toMatchObject({ languageCode: "en", pack: { clipCountTarget: 10, finishing, recipe: { id: recipe.id, revision: recipe.revision } } });

      // One edit: more clips, another language, no finishing.
      const edited = await recipeService.update(scope, recipe.id, { expectedRevision: recipe.revision, languageCode: "es", contentPack: contentPackSchema.parse({ ...CONTENT_PACK, clipCountTarget: 4 }), finishing: null });
      expect(edited.revision).toBe(recipe.revision + 1);
      episodes = ["episode-two", "episode-one"];
      await onlyDue(rule.id);
      expect(await service.processDueRules()).toMatchObject({ checked: 1, imported: 1 });
      const after = await importedPack("episode-two");
      expect(after).toMatchObject({ languageCode: "es", pack: { clipCountTarget: 4, finishing: null, recipe: { id: recipe.id, revision: edited.revision } } });

      // The first import still has the settings it was made with.
      expect(await importedPack("episode-one")).toEqual(before);
    });

    test("a Recipe saves finishing and validates it; a rule's imports carry it to the committed Content Pack", async () => {
      const f = await businessFixture("finishing");
      const service = new AutopilotService({ fetchFeed: feedWith("finishing-episode") });
      const scope = { actorUserId: f.creator.id, workspaceId: f.workspace.id };
      const finishing = { topClips: 3, minScore: 60, aspectRatios: ["9:16" as const, "1:1" as const], copyPlatforms: ["tiktok" as const], resolution: "1080p" as const, delivery: "ready_to_review" as const, queueAccountIds: [] };
      const recipe = await saveRecipe(f, { brandProfileId: null, finishing }, "Finishing");
      expect(recipe.finishing).toEqual(finishing);
      const rule = await service.createRule(scope, { name: "Finishing", rssUrl: "https://feeds.example.test/finish.xml", recipeId: recipe.id, initialImportMode: "latest", initialImportCount: 1 });

      // Invalid settings never reach the database.
      await expect(recipeService.update(scope, recipe.id, { expectedRevision: 1, finishing: { topClips: 99 } as never })).rejects.toThrow();
      expect((await recipeService.get(scope, recipe.id)).finishing).toEqual(finishing);

      await onlyDue(rule.id);
      expect(await service.processDueRules()).toMatchObject({ checked: 1, imported: 1 });
      const episode = await prisma.autopilotEpisode.findUniqueOrThrow({ where: { ruleId_episodeId: { ruleId: rule.id, episodeId: "finishing-episode" } } });
      const pack = await prisma.contentPack.findFirstOrThrow({ where: { projectId: episode.projectId! } });
      expect(pack.finishing).toEqual(finishing);

      // Clearing it stores nothing; a Recipe without finishing leaves the pack's column empty.
      expect((await recipeService.update(scope, recipe.id, { expectedRevision: 1, finishing: null })).finishing).toBeNull();
      expect((await saveRecipe(f, { brandProfileId: null }, "Plain")).finishing).toBeNull();
    });

    test("finishing and Autopilot need the Pro plan; a downgraded rule pauses before reading its feed and stays editable", async () => {
      const f = await businessFixture("finishing-plan");
      let feedsRead = 0;
      const service = new AutopilotService({ fetchFeed: async () => { feedsRead++; return feedWith("downgraded-episode")(); } });
      const scope = { actorUserId: f.creator.id, workspaceId: f.workspace.id };
      const finishing = { topClips: 2 };
      const recipe = await saveRecipe(f, { brandProfileId: null, finishing }, "Finished");
      const plain = await saveRecipe(f, { brandProfileId: null }, "Plain");
      const rule = await service.createRule(scope, { name: "Downgrade", rssUrl: "https://feeds.example.test/down.xml", recipeId: recipe.id, initialImportMode: "latest", initialImportCount: 1 });
      const other = await service.createRule(scope, { name: "Plain rule", rssUrl: "https://feeds.example.test/plain.xml", recipeId: plain.id });

      await prisma.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "creator" } });
      const finishingRefusal = { code: "plan_feature_required", kind: "payment_required", details: { feature: "campaign.operations", requiredTier: "pro" } };
      await expect(saveRecipe(f, { brandProfileId: null, finishing }, "Refused")).rejects.toMatchObject(finishingRefusal);
      await expect(recipeService.update(scope, recipe.id, { expectedRevision: 1, finishing: { topClips: 5 } as never })).rejects.toMatchObject(finishingRefusal);
      await expect(service.createRule(scope, { name: "Refused rule", rssUrl: "https://feeds.example.test/down.xml", recipeId: plain.id })).rejects.toMatchObject({ code: "plan_feature_required", details: { feature: "automation.autopilot", requiredTier: "pro" } });
      await expect(service.updateRule(scope, other.id, { recipeId: recipe.id })).rejects.toMatchObject(finishingRefusal);
      expect((await prisma.autopilotRule.findUniqueOrThrow({ where: { id: other.id } })).recipeId).toBe(plain.id);
      // Leaving it alone, or turning it off, is always allowed.
      await expect(service.updateRule(scope, rule.id, { name: "Renamed" })).resolves.toMatchObject({ name: "Renamed" });
      await expect(recipeService.update(scope, recipe.id, { expectedRevision: 1, name: "Finished, renamed" })).resolves.toMatchObject({ revision: 2 });

      feedsRead = 0;
      await onlyDue(rule.id);
      expect(await service.processDueRules()).toMatchObject({ checked: 1, imported: 0 });
      expect(feedsRead).toBe(0);
      expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ status: "paused", pauseKind: "plan", consecutiveFailures: 0, lastError: expect.stringContaining("Autopilot needs the Pro plan") });
      expect(await prisma.autopilotEpisode.count({ where: { ruleId: rule.id } })).toBe(0);
      // Paused, it stays readable and editable, and can't be turned back on without the plan.
      await expect(service.listRules(scope)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: rule.id, status: "paused", pauseKind: "plan" })]));
      await expect(service.updateRule(scope, rule.id, { status: "active" })).rejects.toMatchObject({ code: "plan_feature_required" });
      expect((await recipeService.update(scope, recipe.id, { expectedRevision: 2, finishing: null })).finishing).toBeNull();
    });

    test("a rule whose Recipe's Brand Profile can't be applied pauses with a reason and imports nothing", async () => {
      const f = await businessFixture("refused");
      const deleted = await brandProfileService.create(f.brandScope(f.owner.id, "owner"), { name: "Retired brand", slug: "retired" });
      const service = new AutopilotService({ fetchFeed: feedWith("refused-episode") });
      const create = async (name: string, brandProfileId: string) =>
        service.createRule({ actorUserId: f.creator.id, workspaceId: f.workspace.id }, { name, rssUrl: "https://feeds.example.test/brand.xml", recipeId: (await saveRecipe(f, { brandProfileId }, name)).id, initialImportMode: "latest", initialImportCount: 1 });
      const deletedRule = await create("Deleted profile", deleted.id);
      await prisma.brandProfile.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

      await onlyDue(deletedRule.id);
      expect(await service.processDueRules()).toMatchObject({ checked: 1, imported: 0 });
      const paused = await prisma.autopilotRule.findUniqueOrThrow({ where: { id: deletedRule.id } });
      expect(paused).toMatchObject({ status: "paused", pauseKind: "brand_profile", consecutiveFailures: 0, claimToken: null, initializedAt: null, lastSeenEpisodeId: null });
      expect(paused.lastError).toContain('Brand Profile "Retired brand"');
      expect(paused.lastError).toContain("turn the rule back on");
      expect(await prisma.autopilotEpisode.count({ where: { ruleId: deletedRule.id } })).toBe(0);
      expect(await prisma.project.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      await onlyDue(deletedRule.id);
      expect(await service.processDueRules()).toMatchObject({ checked: 0 });

      // A plan that no longer includes Brand Profiles is refused the same way, never imported unbranded.
      const live = await brandProfileService.create(f.brandScope(f.owner.id, "owner"), { name: "Live brand", slug: "live" });
      const downgradedRule = await create("Downgraded", live.id);
      await prisma.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "free" } });
      await onlyDue(downgradedRule.id);
      expect(await service.processDueRules()).toMatchObject({ checked: 1, imported: 0 });
      // Free has no Autopilot, so the plan pause comes first; nothing imports unbranded either way.
      expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: downgradedRule.id } })).toMatchObject({ status: "paused", pauseKind: "plan", consecutiveFailures: 0 });
      expect(await prisma.project.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    });

    test("a rule whose acting member was removed pauses without burning failures until an Admin takes it over", async () => {
      const f = await businessFixture("ownership");
      let feedsRead = 0;
      const worker = new AutopilotService({ fetchFeed: async () => { feedsRead++; return { title: "Quiet feed", finalUrl: "https://feeds.example.test/quiet.xml", episodes: [], etag: null, lastModified: null, notModified: true }; } });
      const rule = await worker.createRule({ actorUserId: f.creator.id, workspaceId: f.workspace.id }, { name: "Dana's rule", rssUrl: "https://feeds.example.test/quiet.xml", recipeId: (await saveRecipe(f, { brandProfileId: null })).id });
      feedsRead = 0;
      await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: f.creator.id } } });

      await onlyDue(rule.id);
      expect(await worker.processDueRules()).toEqual({ checked: 1, imported: 0, claimLost: 0 });
      expect(feedsRead).toBe(0);
      const paused = await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } });
      expect(paused).toMatchObject({ status: "paused", pauseKind: "acting_member", consecutiveFailures: 0, claimToken: null, leaseExpiresAt: null });
      expect(paused.lastError).toContain("Dana Lee can no longer run this rule");
      expect(paused.lastError).toContain("Owner or Admin can take it over");
      // Nothing retries until someone acts.
      await onlyDue(rule.id);
      expect(await worker.processDueRules()).toMatchObject({ checked: 0 });

      // A Member without the Workspace management capability cannot take it over.
      await expect(worker.takeOver({ actorUserId: f.editor.id, workspaceId: f.workspace.id }, rule.id)).rejects.toMatchObject({ code: "workspace_access_denied" });
      expect((await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).status).toBe("paused");
      // Rules in other Workspaces are concealed.
      const other = await businessFixture("ownership-other");
      await expect(worker.takeOver({ actorUserId: other.admin.id, workspaceId: other.workspace.id }, rule.id)).rejects.toMatchObject({ code: "autopilot_rule_not_found" });

      const resumed = await worker.takeOver({ actorUserId: f.admin.id, workspaceId: f.workspace.id }, rule.id);
      expect(resumed).toMatchObject({ createdByUserId: f.admin.id, status: "active", pauseKind: null, lastError: null, consecutiveFailures: 0 });
      expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ createdByUserId: f.admin.id, updatedByUserId: f.admin.id, status: "active" });
      await onlyDue(rule.id);
      expect(await worker.processDueRules()).toMatchObject({ checked: 1, claimLost: 0 });
      expect(feedsRead).toBe(1);
      expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ status: "active", lastError: null });
    });

    test("a soft-deleted acting member or one who lost processing permission pauses the rule", async () => {
      const f = await businessFixture("lost-access");
      const worker = new AutopilotService({ fetchFeed: async () => { throw new Error("A paused rule must not read its feed"); } });
      const make = async (name: string) => prisma.autopilotRule.create({ data: { workspaceId: f.workspace.id, createdByUserId: f.creator.id, name, rssUrl: "https://feeds.example.test/quiet.xml", recipeId: (await saveRecipe(f, { brandProfileId: null })).id, initializedAt: new Date() } });
      const deletedUserRule = await make("Deleted user");
      await prisma.user.update({ where: { id: f.creator.id }, data: { deletedAt: new Date() } });
      await onlyDue(deletedUserRule.id);
      expect(await worker.processDueRules()).toMatchObject({ checked: 1 });
      expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: deletedUserRule.id } })).toMatchObject({ status: "paused", consecutiveFailures: 0 });

      await prisma.user.update({ where: { id: f.creator.id }, data: { deletedAt: null } });
      const viewerRule = await make("Viewer");
      await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: f.creator.id } }, data: { role: "viewer" } });
      await onlyDue(viewerRule.id);
      expect(await worker.processDueRules()).toMatchObject({ checked: 1 });
      expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: viewerRule.id } })).toMatchObject({ status: "paused", consecutiveFailures: 0, lastError: expect.stringContaining("Dana Lee can no longer run this rule") });
    });

    test("the plan's active-rule count bounds create, re-enable, run-now and takeover; a downgrade pauses the newest rules", async () => {
      const f = await businessFixture("rule-count");
      let feedsRead = 0;
      const service = new AutopilotService({ fetchFeed: async () => { feedsRead++; return feedWith()(); } });
      const scope = { actorUserId: f.creator.id, workspaceId: f.workspace.id };
      const recipe = await saveRecipe(f, { brandProfileId: null });
      const rule = (name: string) => service.createRule(scope, { name, rssUrl: "https://feeds.example.test/brand.xml", recipeId: recipe.id });
      const rules = [];
      for (const name of ["one", "two", "three", "four", "five"]) rules.push(await rule(name));
      for (const [index, created] of rules.entries()) await prisma.autopilotRule.update({ where: { id: created.id }, data: { createdAt: new Date(Date.UTC(2026, 0, 1 + index)) } });

      await prisma.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "pro" } });
      await expect(rule("six")).rejects.toMatchObject({ code: "plan_limit_reached", details: { limit: "autopilotRules", used: 5, max: 3, requiredTier: "business" } });
      // The poller keeps the three oldest and pauses the rest before reading their feeds.
      feedsRead = 0;
      for (const created of rules) {
        await onlyDue(created.id);
        await service.processDueRules();
      }
      const states = await prisma.autopilotRule.findMany({ where: { id: { in: rules.map((created) => created.id) } }, orderBy: { createdAt: "asc" }, select: { status: true, pauseKind: true } });
      expect(states).toEqual([
        { status: "active", pauseKind: null }, { status: "active", pauseKind: null }, { status: "active", pauseKind: null },
        { status: "paused", pauseKind: "plan" }, { status: "paused", pauseKind: "plan" },
      ]);
      expect(feedsRead).toBe(3);

      // Every way back on rechecks the count.
      const paused = rules[4]!.id;
      await expect(service.updateRule(scope, paused, { status: "active" })).rejects.toMatchObject({ code: "plan_limit_reached" });
      await expect(service.triggerRuleNow(scope, paused)).rejects.toMatchObject({ code: "plan_limit_reached" });
      await expect(service.takeOver({ actorUserId: f.owner.id, workspaceId: f.workspace.id }, paused)).rejects.toMatchObject({ code: "plan_limit_reached" });
      // Editing a paused rule, or pausing an active one, needs no slot; pausing frees one.
      await expect(service.updateRule(scope, paused, { name: "Renamed while paused" })).resolves.toMatchObject({ status: "paused" });
      await service.updateRule(scope, rules[0]!.id, { status: "paused" });
      await expect(service.updateRule(scope, paused, { status: "active" })).resolves.toMatchObject({ status: "active", pauseKind: null });
      await expect(service.triggerRuleNow(scope, rules[0]!.id)).rejects.toMatchObject({ code: "plan_limit_reached" });
    });

    test("a partial update keeps the schedule the rule already had", async () => {
      const f = await businessFixture("partial-update");
      const service = new AutopilotService({ fetchFeed: feedWith() });
      const scope = { actorUserId: f.creator.id, workspaceId: f.workspace.id };
      const rule = await service.createRule(scope, { name: "Weekly", rssUrl: "https://feeds.example.test/brand.xml", recipeId: (await saveRecipe(f, { brandProfileId: null })).id, intervalMinutes: 10080, maxEpisodesPerRun: 10, initialImportMode: "latest", initialImportCount: 7 });
      const schedule = { intervalMinutes: 10080, maxEpisodesPerRun: 10, initialImportMode: "latest", initialImportCount: 7 };
      const before = await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } });

      await service.updateRule(scope, rule.id, { name: "Renamed" });
      const renamed = await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } });
      expect(renamed).toMatchObject({ name: "Renamed", ...schedule });
      expect(renamed.nextRunAt).toEqual(before.nextRunAt);

      await service.updateRule(scope, rule.id, { status: "paused" });
      expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ status: "paused", pauseKind: null, ...schedule });
      await service.updateRule(scope, rule.id, { status: "active" });
      expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ status: "active", ...schedule });
    });

    test("Recipe and rule saves are refused when the Brand Profile can't be applied, default or chosen", async () => {
      const f = await businessFixture("save-time");
      const owner = f.brandScope(f.owner.id, "owner");
      const profile = await brandProfileService.create(owner, { name: "Plan bound", slug: "plan-bound" });
      await brandProfileService.setDefault(owner, profile.id);
      const service = new AutopilotService({ fetchFeed: feedWith() });
      const scope = { actorUserId: f.creator.id, workspaceId: f.workspace.id };
      const bound = await saveRecipe(f, {}, "Before downgrade");
      expect(bound.brandProfileId).toBe(profile.id);
      const unbranded = await saveRecipe(f, { brandProfileId: null }, "Unbranded");
      const rule = await service.createRule(scope, { name: "Rule", rssUrl: "https://feeds.example.test/brand.xml", recipeId: bound.id });
      const loose = await service.createRule(scope, { name: "Loose", rssUrl: "https://feeds.example.test/brand.xml", recipeId: unbranded.id });

      await prisma.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "free" } });
      const brandRefusal = { code: "plan_feature_required", details: { feature: "brand.profiles" } };
      // Like link intake, an inapplicable default refuses the save instead of storing null.
      await expect(saveRecipe(f, {}, "Default")).rejects.toMatchObject(brandRefusal);
      await expect(saveRecipe(f, { brandProfileId: profile.id }, "Chosen")).rejects.toMatchObject(brandRefusal);
      await expect(recipeService.update(scope, unbranded.id, { expectedRevision: 1, brandProfileId: profile.id })).rejects.toMatchObject(brandRefusal);
      // A rule can't be created on, or moved to, a Recipe its saver couldn't have saved.
      // On Free, creating any rule is refused by the plan first.
      await expect(service.createRule(scope, { name: "Pointed", rssUrl: "https://feeds.example.test/brand.xml", recipeId: bound.id })).rejects.toMatchObject({ code: "plan_feature_required" });
      await expect(service.updateRule(scope, loose.id, { recipeId: bound.id })).rejects.toMatchObject(brandRefusal);
      // Choosing no profile stays possible.
      expect((await saveRecipe(f, { brandProfileId: null }, "None")).brandProfileId).toBeNull();
      expect((await service.updateRule(scope, rule.id, { recipeId: unbranded.id })).recipeId).toBe(unbranded.id);

      await prisma.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "business" } });
      expect((await saveRecipe(f, { brandProfileId: profile.id }, "Restored plan")).brandProfileId).toBe(profile.id);
      expect((await service.updateRule(scope, loose.id, { recipeId: bound.id })).recipeId).toBe(bound.id);
    });

    test("a replayed rule create keeps the Recipe it was accepted with, even after that Recipe is edited", async () => {
      const f = await businessFixture("replay");
      let feeds = 0;
      const service = new AutopilotService({ fetchFeed: async () => { feeds++; return feedWith()(); } });
      const scope = { actorUserId: f.creator.id, workspaceId: f.workspace.id };
      const recipe = await saveRecipe(f, { brandProfileId: null });
      const input = { name: "Assistant rule", rssUrl: "https://feeds.example.test/brand.xml", recipeId: recipe.id };
      const key = randomUUID();

      const accepted = await service.createRule(scope, input, { clientIdempotencyKey: key });
      expect(accepted.recipeId).toBe(recipe.id);
      await recipeService.update(scope, recipe.id, { expectedRevision: 1, name: "Edited since" });
      const replay = await service.createRule(scope, input, { clientIdempotencyKey: key });
      expect(replay).toMatchObject({ id: accepted.id, recipeId: recipe.id, recipeName: "Settings" });
      expect(feeds).toBe(1);
      expect(await prisma.autopilotRule.count({ where: { workspaceId: f.workspace.id } })).toBe(1);

      // A Recipe from another Workspace is concealed.
      const foreign = await businessFixture("replay-foreign");
      const foreignRecipe = await recipeService.create({ actorUserId: foreign.creator.id, workspaceId: foreign.workspace.id }, { name: "Elsewhere", brandProfileId: null, contentPack: CONTENT_PACK });
      await expect(service.createRule(scope, { ...input, recipeId: foreignRecipe.id }, { clientIdempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "recipe_not_found" });
    });

    test("a Recipe an Autopilot rule uses can't be deleted until the rule moves or goes", async () => {
      const f = await businessFixture("in-use");
      const scope = { actorUserId: f.creator.id, workspaceId: f.workspace.id };
      const service = new AutopilotService({ fetchFeed: feedWith() });
      const used = await saveRecipe(f, { brandProfileId: null }, "Used");
      const spare = await saveRecipe(f, { brandProfileId: null }, "Spare");
      const rule = await service.createRule(scope, { name: "Rule", rssUrl: "https://feeds.example.test/brand.xml", recipeId: used.id });
      await expect(recipeService.delete(scope, used.id)).rejects.toMatchObject({ code: "recipe_in_use" });
      await service.updateRule(scope, rule.id, { recipeId: spare.id });
      await recipeService.delete(scope, used.id);
      // A deleted Recipe can't be chosen for a rule.
      await expect(service.updateRule(scope, rule.id, { recipeId: used.id })).rejects.toMatchObject({ code: "recipe_not_found" });
      await expect(recipeService.delete(scope, spare.id)).rejects.toMatchObject({ code: "recipe_in_use" });
    });

    test("choosing another Recipe resumes a rule paused over its profile, and a pause someone chose stays", async () => {
      const f = await businessFixture("resume");
      const owner = f.brandScope(f.owner.id, "owner");
      const retired = await brandProfileService.create(owner, { name: "Retired", slug: "retired" });
      const live = await brandProfileService.create(owner, { name: "Live", slug: "live" });
      const service = new AutopilotService({ fetchFeed: feedWith("resume-episode") });
      const scope = { actorUserId: f.creator.id, workspaceId: f.workspace.id };
      const retiredRecipe = await saveRecipe(f, { brandProfileId: retired.id }, "Retired recipe");
      const liveRecipe = await saveRecipe(f, { brandProfileId: live.id }, "Live recipe");
      const noneRecipe = await saveRecipe(f, { brandProfileId: null }, "No brand");
      const rule = await service.createRule(scope, { name: "Branded", rssUrl: "https://feeds.example.test/brand.xml", recipeId: retiredRecipe.id, initialImportMode: "latest", initialImportCount: 1 });
      await prisma.brandProfile.update({ where: { id: retired.id }, data: { deletedAt: new Date() } });
      await onlyDue(rule.id);
      await service.processDueRules();
      expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ status: "paused", pauseKind: "brand_profile" });

      // Unrelated edits leave the pause and its reason in place.
      const renamed = await service.updateRule(scope, rule.id, { name: "Still paused" });
      expect(renamed).toMatchObject({ status: "paused", pauseKind: "brand_profile", lastError: expect.stringContaining("Retired") });

      const resumed = await service.updateRule(scope, rule.id, { recipeId: liveRecipe.id });
      expect(resumed).toMatchObject({ status: "active", pauseKind: null, lastError: null, recipeId: liveRecipe.id });
      expect(new Date(resumed.nextRunAt).getTime()).toBeLessThanOrEqual(Date.now());
      await onlyDue(rule.id);
      expect(await service.processDueRules()).toMatchObject({ checked: 1, imported: 1 });
      const imported = await prisma.project.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
      expect(imported.brandProfileId).toBe(live.id);

      // A pause someone chose is not a system pause: a Recipe change does not resume it.
      await service.updateRule(scope, rule.id, { status: "paused" });
      await service.updateRule(scope, rule.id, { recipeId: noneRecipe.id });
      expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ status: "paused", pauseKind: null, recipeId: noneRecipe.id });
    });

    test("an Admin taking over while a run holds the claim is not overwritten by that run's pause", async () => {
      const f = await businessFixture("live-claim");
      const service = new AutopilotService({ fetchFeed: async () => { throw new Error("The run was revoked before it read the feed"); } });
      const rule = await prisma.autopilotRule.create({ data: { workspaceId: f.workspace.id, createdByUserId: f.creator.id, name: "Contested", rssUrl: "https://feeds.example.test/quiet.xml", recipeId: (await saveRecipe(f, { brandProfileId: null })).id, initializedAt: new Date() } });
      await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: f.creator.id } } });
      await onlyDue(rule.id);

      // The Admin acts after the run claimed the rule and found the member
      // unavailable, but before the run records its pause.
      const original = workspaceService.requireActor.bind(workspaceService);
      let takenOver = false;
      const spy = spyOn(workspaceService, "requireActor").mockImplementation(async (userId, workspaceId, capability) => {
        if (userId === f.creator.id && !takenOver) {
          takenOver = true;
          const claimed = await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } });
          expect(claimed).toMatchObject({ status: "running", claimToken: expect.any(String) });
          await service.takeOver({ actorUserId: f.admin.id, workspaceId: f.workspace.id }, rule.id);
        }
        return original(userId, workspaceId, capability);
      });
      try {
        expect(await service.processDueRules()).toEqual({ checked: 1, imported: 0, claimLost: 1 });
      } finally {
        spy.mockRestore();
      }
      expect(takenOver).toBe(true);
      expect(await prisma.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ status: "active", createdByUserId: f.admin.id, pauseKind: null, lastError: null, claimToken: null, leaseExpiresAt: null });
    });

    test("taking over a rule that does not exist or is not a UUID is a not-found, not a database error", async () => {
      const f = await businessFixture("takeover-missing");
      const service = new AutopilotService();
      const scope = { actorUserId: f.admin.id, workspaceId: f.workspace.id };
      await expect(service.takeOver(scope, "not-a-uuid")).rejects.toMatchObject({ code: "autopilot_rule_not_found" });
      await expect(service.takeOver(scope, randomUUID())).rejects.toMatchObject({ code: "autopilot_rule_not_found" });
      await expect(service.takeOver({ actorUserId: f.editor.id, workspaceId: f.workspace.id }, "not-a-uuid")).rejects.toMatchObject({ code: "workspace_access_denied" });
    });
  });

  test("an Autopilot import writes one autopilot.episode_imported event in its admission transaction, and a repeat writes none", async () => {
    const owner = await prisma.autopilotRule.create({ data: { workspaceId, createdByUserId: userId, name: "Event source", rssUrl: "https://feeds.example.test/events.xml",
      recipeId, initializedAt: new Date(), nextRunAt: new Date(Date.now() + 86_400_000) } });
    const input = { rssUrl: "https://feeds.example.test/events.xml",
      episodes: [{ id: `episode-event-${suffix}`, title: "Episode", enclosureUrl: "https://cdn.example.test/event.mp3", durationSeconds: 600 }] };
    const options = { autopilotRuleId: owner.id, generationContext: { contentPack: CONTENT_PACK, languageCode: null } };
    const imported = await projectService.importResolvedRssEpisodes({ actorUserId: userId, workspaceId }, input, options);
    expect(imported.count).toBe(1);
    const created = imported.projects[0]!.project.id;
    const feed = () => listWorkspaceEvents(prisma, { workspaceId }, { types: ["autopilot.episode_imported"], limit: 200 });
    const subjects = (await feed()).data.map((event) => event.subject).filter((subject) => (subject as { ruleId: string }).ruleId === owner.id);
    expect(subjects).toEqual([{ ruleId: owner.id, projectId: created, episodeId: input.episodes[0]!.id }]);

    // The admission fence refuses a second import of the same episode, so no second event exists.
    expect((await projectService.importResolvedRssEpisodes({ actorUserId: userId, workspaceId }, input, options)).count).toBe(0);
    expect((await feed()).data.map((event) => event.subject).filter((subject) => (subject as { ruleId: string }).ruleId === owner.id)).toHaveLength(1);

    // A manual RSS import has no rule behind it and emits nothing.
    const before = (await feed()).data.length;
    await projectService.importResolvedRssEpisodes({ actorUserId: userId, workspaceId }, { ...input, episodes: [{ ...input.episodes[0]!, id: `manual-${suffix}` }] },
      { generationContext: options.generationContext });
    expect((await feed()).data).toHaveLength(before);
  });
});
