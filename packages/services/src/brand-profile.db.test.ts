import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { buildGenerationContentPack, brandTemplateInputSchema, DEFAULT_CAPTION_PRESET } from "@narriflow/validators";
import { Pool } from "pg";
import {
  BrandProfileConflictError,
  BrandProfileMembershipError,
  BrandProfileMissingAssetError,
  BrandProfileNotFoundError,
  BrandProfileService,
  brandProfileService,
} from "./brand-profile.service";
import {
  BrandAccessError,
  brandOwnerForWorkspace,
  brandOwnerWhere,
  brandOwnerWhereFor,
  resolveBrandOwner,
} from "./brand-ownership";
import { PlanRequirementError } from "./plan-features";
import { brandTemplateService } from "./brand-template.service";
import { BrandFontService, brandFontService } from "./brand-font.service";
import { projectService } from "./project.service";
import { createProductionReviewApprovalGate } from "./review-approval-gate.prisma";
import { sceneTemplateService } from "./scene-template.service";
import {
  VisualAssetReferenceError,
  VisualAssetService,
  visualAssetService,
} from "./visual-asset.service";

const databaseUrl = process.env.BRAND_PROFILE_TEST_DATABASE_URL;
const databaseSchema = process.env.BRAND_PROFILE_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_BRAND_PROFILE_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);

dbDescribe("Brand Profile PostgreSQL contracts", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const prismaGlobal = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };

  beforeAll(() => {
    if (!databaseUrl) throw new Error("Brand Profile test database is required");
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined) });
    priorPrisma = prismaGlobal.narriflowPrismaClient;
    prismaGlobal.narriflowPrismaClient = prisma;
  });

  afterAll(async () => {
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function workspaceFixture(label: string, personal = false) {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { clerkId: `brand-${label}-${suffix}`, primaryEmail: `brand-${label}-${suffix}@example.test` } });
    const workspace = await prisma.workspace.create({ data: {
      name: `Brand ${label}`,
      ownerUserId: user.id,
      personalOwnerUserId: personal ? user.id : null,
      pricingTier: personal ? "creator" : "business",
      members: { create: { userId: user.id, role: "owner" } },
    } });
    return {
      user,
      workspace,
      scope: {
        actorUserId: user.id,
        workspaceId: workspace.id,
        workspaceOwnerUserId: user.id,
        role: "owner" as const,
        status: "active" as const,
        pricingTier: personal ? "creator" : "business",
        isPersonalWorkspace: personal,
      },
    };
  }

  test("default brand selection uses current Workspace management permission", async () => {
    const f = await workspaceFixture("default-permission");
    const template = await prisma.brandTemplate.create({ data: { name: "Workspace default", workspaceId: f.workspace.id, createdByUserId: f.user.id, captionPreset: DEFAULT_CAPTION_PRESET } });
    const editor = await prisma.user.create({ data: { clerkId: `default-editor:${randomUUID()}` } });
    const member = await prisma.workspaceMember.create({ data: { workspaceId: f.workspace.id, userId: editor.id, role: "editor" } });
    const scope = { actorUserId: editor.id, workspaceId: f.workspace.id };
    await expect(brandTemplateService.setDefault(scope, template.id)).rejects.toMatchObject({ code: "workspace_access_denied" });
    expect((await prisma.workspace.findUnique({ where: { id: f.workspace.id } }))?.defaultBrandTemplateId).toBeNull();
    await prisma.workspaceMember.update({ where: { id: member.id }, data: { role: "admin" } });
    await brandTemplateService.setDefault(scope, template.id);
    expect((await prisma.workspace.findUnique({ where: { id: f.workspace.id } }))?.defaultBrandTemplateId).toBe(template.id);
    await prisma.workspace.update({ where: { id: f.workspace.id }, data: { status: "pending_payment", defaultBrandTemplateId: null } });
    await brandTemplateService.setDefault(f.scope, template.id);
    expect((await prisma.workspace.findUnique({ where: { id: f.workspace.id } }))?.defaultBrandTemplateId).toBe(template.id);
  });

  test("enforces owner scope, built-in exclusion, and optimistic concurrency", async () => {
    const first = await workspaceFixture("scope-first");
    const second = await workspaceFixture("scope-second");
    const profile = await brandProfileService.create(first.scope, { name: "Northstar", slug: "northstar" });
    await expect(brandProfileService.get(second.scope, profile.id)).rejects.toBeInstanceOf(BrandProfileNotFoundError);
    await expect(
      brandProfileService.resolveForProject(
        { ...first.scope, pricingTier: "free" },
        { profileId: profile.id },
      ),
    ).rejects.toBeInstanceOf(PlanRequirementError);
    await expect(
      brandProfileService.resolveForProject(
        { ...first.scope, status: "restricted" },
        { profileId: profile.id },
      ),
    ).rejects.toBeInstanceOf(BrandAccessError);

    const builtIn = await prisma.brandTemplate.create({ data: { name: "Global", isBuiltIn: true, builtInKey: `global-${randomUUID()}`, captionPreset: DEFAULT_CAPTION_PRESET } });
    await expect(brandProfileService.setMembership(first.scope, profile.id, { kind: "template", resourceId: builtIn.id, position: 0 })).rejects.toBeInstanceOf(BrandProfileMembershipError);

    const updates = await Promise.allSettled([
      brandProfileService.update(first.scope, profile.id, { revision: profile.revision, name: "Northstar One" }),
      brandProfileService.update(first.scope, profile.id, { revision: profile.revision, name: "Northstar Two" }),
    ]);
    expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(updates.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason)).toEqual([expect.any(BrandProfileConflictError)]);

    const linkIngest = await projectService.queueLinkIngest({ actorUserId: first.user.id, workspaceId: first.workspace.id }, {
      url: "https://www.youtube.com/watch?v=brand-profile-db-test",
      brandProfileId: profile.id,
      commitToken: randomUUID(),
    });
    const frozen = await prisma.project.findUniqueOrThrow({
      where: { id: linkIngest.project.id },
      select: { brandProfileId: true, brandProfileSnapshot: true },
    });
    expect(frozen.brandProfileId).toBe(profile.id);
    expect(frozen.brandProfileSnapshot).toMatchObject({ profileId: profile.id });
  });

  test("assistant intake resolves only Brand Profiles the actor can use and falls back to the default", async () => {
    const f = await workspaceFixture("assistant-intake");
    const foreign = await workspaceFixture("assistant-foreign");
    const memberPersonal = await workspaceFixture("assistant-member-personal", true);
    await prisma.workspaceMember.create({ data: { workspaceId: f.workspace.id, userId: memberPersonal.user.id, role: "editor" } });
    const acme = await brandProfileService.create(f.scope, { name: "Acme", slug: "acme" });
    const other = await brandProfileService.create(foreign.scope, { name: "Other", slug: "other" });
    const personal = await brandProfileService.create(memberPersonal.scope, { name: "Mine", slug: "mine" });
    await expect(brandProfileService.requireUsableId(f.scope, acme.id)).resolves.toBe(acme.id);
    await expect(brandProfileService.requireUsableId(f.scope, other.id)).rejects.toBeInstanceOf(BrandProfileNotFoundError);
    const asMember = { ...f.scope, actorUserId: memberPersonal.user.id, role: "editor" as const };
    await expect(brandProfileService.requireUsableId(asMember, personal.id)).rejects.toBeInstanceOf(BrandProfileNotFoundError);
    await brandProfileService.setDefault(f.scope, acme.id);
    expect(await brandProfileService.listSummaries(f.scope)).toEqual([{ id: acme.id, name: "Acme", isDefault: true, defaultStyle: null }]);

    // Assistant intake applies the default after replay lookup, so a retry
    // with the same key keeps its identity after the default changes.
    const key = randomUUID();
    const assistantIntake = () => projectService.queueLinkIngest({ actorUserId: f.user.id, workspaceId: f.workspace.id },
      { url: "https://www.youtube.com/watch?v=brand-default-db-test", commitToken: key },
      { generationContext: { contentPack: buildGenerationContentPack(), languageCode: null }, mutation: { clientIdempotencyKey: key, callerId: `oauth:test:${f.user.id}` } });
    const first = await assistantIntake();
    expect((await prisma.project.findUniqueOrThrow({ where: { id: first.project.id }, select: { brandProfileId: true } })).brandProfileId).toBe(acme.id);
    const second = await brandProfileService.create(f.scope, { name: "Second", slug: "second" });
    await brandProfileService.setDefault(f.scope, second.id);
    expect((await assistantIntake()).project.id).toBe(first.project.id);
    await expect(projectService.queueLinkIngest({ actorUserId: f.user.id, workspaceId: f.workspace.id },
      { url: "https://www.youtube.com/watch?v=brand-foreign-db-test", commitToken: randomUUID(), brandProfileId: other.id })).rejects.toBeInstanceOf(BrandProfileNotFoundError);
  });

  test("a remembered default never blocks intake after a downgrade removes Brand Profiles", async () => {
    const f = await workspaceFixture("default-after-downgrade", true);
    const profile = await brandProfileService.create(f.scope, { name: "Kept", slug: "kept" });
    await brandProfileService.setDefault(f.scope, profile.id);
    await prisma.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "free" } });
    const free = { ...f.scope, pricingTier: "free" };
    // Brand kit still shows the remembered default; intake treats it as "no profile".
    expect(await brandProfileService.getDefaultId(free)).toBe(profile.id);
    expect(await brandProfileService.getApplicableDefaultId(free)).toBeNull();
    const key = randomUUID();
    const intake = await projectService.queueLinkIngest({ actorUserId: f.user.id, workspaceId: f.workspace.id },
      { url: "https://www.youtube.com/watch?v=brand-default-after-downgrade", commitToken: key },
      { generationContext: { contentPack: buildGenerationContentPack(), languageCode: null }, mutation: { clientIdempotencyKey: key, callerId: `oauth:test:${f.user.id}` } });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: intake.project.id }, select: { brandProfileId: true } })).brandProfileId).toBeNull();
    // Naming the profile explicitly is still refused by the plan.
    await expect(projectService.queueLinkIngest({ actorUserId: f.user.id, workspaceId: f.workspace.id },
      { url: "https://www.youtube.com/watch?v=brand-explicit-after-downgrade", commitToken: randomUUID(), brandProfileId: profile.id })).rejects.toMatchObject({ code: "plan_feature_required" });
  });

  test("RSS imports freeze the Brand Profile like link intake, so its approval rule gates the clips", async () => {
    const f = await workspaceFixture("rss-intake");
    const scope = { actorUserId: f.user.id, workspaceId: f.workspace.id };
    const client = await brandProfileService.create(f.scope, { name: "Client brand", slug: "client-brand", approvalRule: "approval_required" });
    const episode = (id: string) => ({ id, title: `Episode ${id}`, enclosureUrl: `https://cdn.example.test/${id}.mp3`, durationSeconds: 60 });
    const settings = { generationContext: { contentPack: buildGenerationContentPack(), languageCode: null } };
    const rssProjects = () => prisma.project.count({ where: { workspaceId: f.workspace.id, sourceType: "rss" } });

    const branded = await projectService.importResolvedRssEpisodes(scope, { rssUrl: "https://feeds.example.test/show.xml", episodes: [episode("branded")], brandProfileId: client.id }, settings);
    const unbranded = await projectService.importResolvedRssEpisodes(scope, { rssUrl: "https://feeds.example.test/show.xml", episodes: [episode("unbranded")], brandProfileId: null }, settings);
    const frozen = await prisma.project.findUniqueOrThrow({ where: { id: branded.projects[0]!.project.id }, select: { brandProfileId: true, brandProfileSnapshot: true } });
    expect(frozen.brandProfileId).toBe(client.id);
    expect(frozen.brandProfileSnapshot).toMatchObject({ profileId: client.id, approvalRule: "approval_required" });
    expect(await prisma.programAnalyticsEvent.count({ where: { projectId: branded.projects[0]!.project.id, type: "brand_profile_applied" } })).toBe(1);

    // The review approval gate reads the frozen snapshot: clips of the branded
    // RSS Project need client approval, the unbranded one is advisory.
    const exportFor = async (projectId: string) => {
      const detection = await prisma.workflowRun.create({ data: { projectId, stage: "moment_detection", status: "completed", idempotencyKey: randomUUID() } });
      const clip = await prisma.clip.create({ data: { projectId, workflowRunId: detection.id, index: 0, startSec: 0, endSec: 30, hookText: "Hook", reasoning: "Test", category: "story",
        transcriptSlice: [], viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50, durationOptimalityScore: 50,
        tiktokScore: 50, youtubeScore: 50, instagramScore: 50, llmProvider: "test", llmModel: "test" } });
      return prisma.clipExport.create({ data: { projectId, workspaceId: f.workspace.id, clipId: clip.id, editorRevision: 0, fingerprint: randomUUID(), resolution: "720p", watermark: true, status: "ready", progress: 100 } });
    };
    const gate = createProductionReviewApprovalGate();
    const authorize = (projectId: string, exportId: string) => gate.authorize({ principal: { kind: "workspace_user", userId: f.user.id }, workspaceId: f.workspace.id, projectId, exportIds: [exportId], idempotencyKey: randomUUID() });
    await expect(authorize(branded.projects[0]!.project.id, (await exportFor(branded.projects[0]!.project.id)).id)).rejects.toMatchObject({ code: "review_approval_required" });
    await expect(authorize(unbranded.projects[0]!.project.id, (await exportFor(unbranded.projects[0]!.project.id)).id)).resolves.toMatchObject({ allowed: true });

    // A profile that can't be applied refuses the import instead of importing without the brand.
    const before = await rssProjects();
    await brandProfileService.softDelete(f.scope, (await brandProfileService.create(f.scope, { name: "Gone", slug: "gone" })).id, { revision: 1 });
    const gone = await prisma.brandProfile.findFirstOrThrow({ where: { workspaceId: f.workspace.id, slug: "gone" } });
    await expect(projectService.importResolvedRssEpisodes(scope, { rssUrl: "https://feeds.example.test/show.xml", episodes: [episode("gone")], brandProfileId: gone.id }, settings)).rejects.toBeInstanceOf(BrandProfileNotFoundError);
    await prisma.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "free" } });
    await expect(projectService.importResolvedRssEpisodes(scope, { rssUrl: "https://feeds.example.test/show.xml", episodes: [episode("downgraded")], brandProfileId: client.id }, settings)).rejects.toBeInstanceOf(PlanRequirementError);
    expect(await rssProjects()).toBe(before);
  });

  test("persists a member style as the profile default", async () => {
    const fixture = await workspaceFixture("default-style");
    const profile = await brandProfileService.create(fixture.scope, {
      name: "Default style",
      slug: "default-style",
    });
    const template = await prisma.brandTemplate.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Editorial",
        captionPreset: DEFAULT_CAPTION_PRESET,
      },
    });
    const withMembership = await brandProfileService.setMembership(
      fixture.scope,
      profile.id,
      { kind: "template", resourceId: template.id, position: 0 },
    );
    const updated = await brandProfileService.update(fixture.scope, profile.id, {
      revision: withMembership.revision,
      defaultTemplateId: template.id,
    });
    expect(updated.defaultTemplateId).toBe(template.id);
  });

  test("refuses to move a style that remains another profile's default", async () => {
    const fixture = await workspaceFixture("default-style-move");
    const first = await brandProfileService.create(fixture.scope, {
      name: "First profile",
      slug: "first-profile",
    });
    const second = await brandProfileService.create(fixture.scope, {
      name: "Second profile",
      slug: "second-profile",
    });
    const template = await prisma.brandTemplate.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Anchored default",
        captionPreset: DEFAULT_CAPTION_PRESET,
      },
    });
    const withMembership = await brandProfileService.setMembership(
      fixture.scope,
      first.id,
      { kind: "template", resourceId: template.id, position: 0 },
    );
    await brandProfileService.update(fixture.scope, first.id, {
      revision: withMembership.revision,
      defaultTemplateId: template.id,
    });
    await expect(
      brandProfileService.setMembership(fixture.scope, second.id, {
        kind: "template",
        resourceId: template.id,
        position: 0,
      }),
    ).rejects.toBeInstanceOf(BrandProfileMembershipError);
    expect(
      await prisma.brandProfileTemplate.findUniqueOrThrow({
        where: { templateId: template.id },
      }),
    ).toMatchObject({ profileId: first.id });
    expect(
      await prisma.brandProfile.findUniqueOrThrow({ where: { id: first.id } }),
    ).toMatchObject({ defaultTemplateId: template.id });
  });

  test("keeps template and audio membership inside the current workspace", async () => {
    const first = await workspaceFixture("membership-workspace-a");
    const secondWorkspace = await prisma.workspace.create({
      data: {
        name: "Brand membership workspace B",
        ownerUserId: first.user.id,
        pricingTier: "business",
        members: { create: { userId: first.user.id, role: "owner" } },
      },
    });
    const secondScope = {
      ...first.scope,
      workspaceId: secondWorkspace.id,
    };
    const foreignTemplate = await prisma.brandTemplate.create({
      data: {
        userId: first.user.id,
        workspaceId: first.workspace.id,
        name: "Workspace A style",
        captionPreset: DEFAULT_CAPTION_PRESET,
      },
    });
    const foreignAudio = await prisma.audioAsset.create({
      data: {
        kind: "music",
        userId: first.user.id,
        workspaceId: first.workspace.id,
        storageKey: `workspaces/${first.workspace.id}/audio-assets/foreign.mp3`,
        title: "Workspace A audio",
        durationSec: 12,
      },
    });
    const curatedAudio = await prisma.audioAsset.create({
      data: {
        kind: "music",
        storageKey: `audio-assets/curated-${randomUUID()}.mp3`,
        title: "Curated audio",
        durationSec: 12,
      },
    });
    await expect(
      brandProfileService.create(secondScope, {
        name: "Cross workspace default",
        slug: "cross-workspace-default",
        defaultTemplateId: foreignTemplate.id,
      }),
    ).rejects.toBeInstanceOf(BrandProfileMembershipError);
    const profile = await brandProfileService.create(secondScope, {
      name: "Workspace B profile",
      slug: "workspace-b-profile",
    });
    await expect(
      brandProfileService.setMembership(secondScope, profile.id, {
        kind: "template",
        resourceId: foreignTemplate.id,
        position: 0,
      }),
    ).rejects.toBeInstanceOf(BrandProfileMembershipError);
    await expect(
      brandProfileService.setMembership(secondScope, profile.id, {
        kind: "audio",
        resourceId: foreignAudio.id,
        position: 0,
      }),
    ).rejects.toBeInstanceOf(BrandProfileMembershipError);
    await expect(
      brandProfileService.setMembership(secondScope, profile.id, {
        kind: "audio",
        resourceId: curatedAudio.id,
        position: 0,
      }),
    ).resolves.toMatchObject({ id: profile.id });
  });

  test("blocks new application when identity storage is missing", async () => {
    const fixture = await workspaceFixture("missing-object");
    const asset = await prisma.visualAsset.create({
      data: {
        workspaceId: fixture.workspace.id,
        createdByUserId: fixture.user.id,
        title: "Missing logo",
        kind: "image",
        storageKey: `workspaces/${fixture.workspace.id}/visual-assets/missing.png`,
        contentType: "image/png",
        sizeBytes: 128,
        width: 64,
        height: 64,
        fingerprint: "d".repeat(64),
      },
    });
    const profile = await brandProfileService.create(fixture.scope, {
      name: "Missing storage",
      slug: "missing-storage",
      identity: {
        primaryColor: "#FFFFFF",
        secondaryColor: "#111522",
        accentColor: null,
        primaryLogoAssetId: asset.id,
        alternateLogoAssetId: null,
      },
    });
    const service = new BrandProfileService();
    (
      service as unknown as {
        requirePrisma: () => PrismaClient;
        objectExists: () => Promise<boolean>;
      }
    ).requirePrisma = () => prisma;
    (
      service as unknown as { objectExists: () => Promise<boolean> }
    ).objectExists = async () => false;
    await expect(
      service.resolveForProject(fixture.scope, { profileId: profile.id }),
    ).rejects.toBeInstanceOf(BrandProfileMissingAssetError);
  });

  test("records entitlement-blocked profile mutations", async () => {
    const fixture = await workspaceFixture("blocked-analytics");
    await expect(
      brandProfileService.create(
        { ...fixture.scope, pricingTier: "free" },
        { name: "Blocked", slug: "blocked" },
      ),
    ).rejects.toMatchObject({ code: "plan_feature_required", details: { feature: "brand.profiles" } });
    expect(
      await prisma.programAnalyticsEvent.count({
        where: {
          workspaceId: fixture.workspace.id,
          type: "brand_premium_mutation_blocked",
        },
      }),
    ).toBe(1);
  });

  test("deduplicates fingerprints per owner, conceals other tenants, and replaces live references before deletion", async () => {
    const first = await workspaceFixture("asset-first");
    const second = await workspaceFixture("asset-second");
    const fingerprint = "a".repeat(64);
    const createAsset = async (workspaceId: string, actorUserId: string, title: string, key: string) =>
      prisma.visualAsset.create({
        data: {
          workspaceId,
          createdByUserId: actorUserId,
          title,
          kind: "image",
          storageKey: key,
          contentType: "image/png",
          sizeBytes: 128,
          width: 64,
          height: 64,
          fingerprint,
        },
      });
    const original = await createAsset(first.workspace.id, first.user.id, "Original", `workspaces/${first.workspace.id}/visual-assets/original.png`);
    await expect(createAsset(first.workspace.id, first.user.id, "Duplicate", `workspaces/${first.workspace.id}/visual-assets/duplicate.png`)).rejects.toMatchObject({ code: "P2002" });
    await expect(createAsset(second.workspace.id, second.user.id, "Other tenant", `workspaces/${second.workspace.id}/visual-assets/original.png`)).resolves.toBeDefined();
    expect(
      await prisma.visualAsset.count({
        where: { workspaceId: first.workspace.id, deletedAt: null },
      }),
    ).toBe(1);

    const replacement = await prisma.visualAsset.create({ data: {
      workspaceId: first.workspace.id,
      createdByUserId: first.user.id,
      title: "Replacement",
      kind: "image",
      storageKey: `workspaces/${first.workspace.id}/visual-assets/replacement.png`,
      contentType: "image/png",
      sizeBytes: 128,
      width: 64,
      height: 64,
      fingerprint: "b".repeat(64),
    } });
    const otherTenantAsset = await prisma.visualAsset.findFirstOrThrow({
      where: { workspaceId: second.workspace.id, fingerprint },
    });
    await expect(
      brandProfileService.create(first.scope, {
        name: "Cross tenant logo",
        slug: "cross-tenant-logo",
        identity: {
          primaryColor: "#FFFFFF",
          secondaryColor: "#111522",
          accentColor: null,
          primaryLogoAssetId: otherTenantAsset.id,
          alternateLogoAssetId: null,
        },
      }),
    ).rejects.toBeInstanceOf(BrandProfileMembershipError);
    const profile = await brandProfileService.create(first.scope, {
      name: "Asset profile",
      slug: "asset-profile",
      identity: {
        primaryColor: "#FFFFFF",
        secondaryColor: "#111522",
        accentColor: null,
        primaryLogoAssetId: original.id,
        alternateLogoAssetId: null,
      },
    });
    expect(
      await prisma.brandProfileAsset.findUnique({
        where: { profileId_assetId: { profileId: profile.id, assetId: original.id } },
      }),
    ).not.toBeNull();
    await expect(visualAssetService.softDelete(first.scope, original.id, {})).rejects.toBeInstanceOf(VisualAssetReferenceError);
    const sceneTemplate = await prisma.sceneTemplate.create({
      data: {
        profileId: profile.id,
        sourceAssetId: original.id,
        createdByUserId: first.user.id,
        name: "Referenced visual",
        definition: {
          schemaVersion: 1,
          durationSec: 3,
          content: {
            kind: "image",
            asset: { kind: "visual_asset", id: original.id, fingerprint: original.fingerprint },
            fit: "cover",
            backgroundColor: "#000000",
          },
          motion: { entrance: "fade", exit: "fade" },
        },
        fingerprint: "c".repeat(64),
      },
    });
    await expect(
      visualAssetService.softDelete(first.scope, original.id, { replacementId: replacement.id }),
    ).rejects.toBeInstanceOf(VisualAssetReferenceError);
    await prisma.sceneTemplate.update({
      where: { id: sceneTemplate.id },
      data: { deletedAt: new Date() },
    });
    await visualAssetService.softDelete(first.scope, original.id, { replacementId: replacement.id });
    expect(await prisma.brandProfileAsset.findUnique({ where: { profileId_assetId: { profileId: profile.id, assetId: replacement.id } } })).not.toBeNull();
    expect((await prisma.visualAsset.findUniqueOrThrow({ where: { id: original.id } })).deletedAt).not.toBeNull();
  });

  test("serializes Scene Template creation against referenced asset and font deletion", async () => {
    if (!databaseSchema || !/^[a-zA-Z0-9_]+$/.test(databaseSchema)) {
      throw new Error("A safe disposable Brand Profile test schema is required");
    }
    const fixture = await workspaceFixture("scene-reference-race");
    const profile = await brandProfileService.create(fixture.scope, {
      name: "Scene race profile",
      slug: `scene-race-${randomUUID()}`,
    });
    const lockKey = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
    const triggerFunction = "narriflow_test_block_scene_template_insert";
    const triggerName = "narriflow_test_block_scene_template_insert";
    const blocker = await pool.connect();

    const waitForBlockedInsert = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await blocker.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = $1::oid) AS waiting",
          [lockKey],
        );
        if (result.rows[0]?.waiting) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("Scene Template insert did not reach the concurrency barrier");
    };

    const raceCreateAgainstDelete = async (
      name: string,
      definition: unknown,
      deleteReference: () => Promise<unknown>,
      expectedCode: string,
    ) => {
      await blocker.query("SELECT pg_advisory_lock($1)", [lockKey]);
      const create = sceneTemplateService.create(fixture.scope, profile.id, {
        name,
        role: "inline",
        definition,
      });
      await waitForBlockedInsert();
      await deleteReference();
      await blocker.query("SELECT pg_advisory_unlock($1)", [lockKey]);
      await expect(create).rejects.toMatchObject({ code: expectedCode });
      expect(await prisma.sceneTemplate.count({ where: { profileId: profile.id, name, deletedAt: null } })).toBe(0);
    };

    try {
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION "${databaseSchema}"."${triggerFunction}"()
        RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN
          IF NEW."name" LIKE 'Concurrent race %' THEN
            PERFORM pg_advisory_xact_lock(${lockKey});
          END IF;
          RETURN NEW;
        END
        $body$
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "${triggerName}"
        BEFORE INSERT ON "${databaseSchema}"."SceneTemplate"
        FOR EACH ROW EXECUTE FUNCTION "${databaseSchema}"."${triggerFunction}"()
      `);

      const visual = await prisma.visualAsset.create({
        data: {
          workspaceId: fixture.workspace.id,
          createdByUserId: fixture.user.id,
          title: "Race visual",
          kind: "image",
          storageKey: `workspaces/${fixture.workspace.id}/visual-assets/race.png`,
          contentType: "image/png",
          sizeBytes: 128,
          width: 64,
          height: 64,
          fingerprint: "d".repeat(64),
        },
      });
      await raceCreateAgainstDelete(
        "Concurrent race visual",
        {
          schemaVersion: 1,
          durationSec: 3,
          content: {
            kind: "image",
            asset: { kind: "visual_asset", id: visual.id, fingerprint: visual.fingerprint },
            fit: "cover",
            backgroundColor: "#000000",
          },
          motion: { entrance: "fade", exit: "fade" },
        },
        () => visualAssetService.softDelete(fixture.scope, visual.id, {}),
        "scene_template_asset_invalid",
      );
      expect((await prisma.visualAsset.findUniqueOrThrow({ where: { id: visual.id } })).deletedAt).not.toBeNull();

      const sourceFont = await prisma.brandFont.create({
        data: {
          workspaceId: fixture.workspace.id,
          licenseConfirmedByUserId: fixture.user.id,
          family: "Race Sans",
          style: "normal",
          weight: 400,
          format: "ttf",
          storageKey: `workspaces/${fixture.workspace.id}/brand-fonts/race-source.ttf`,
          sizeBytes: 128,
          fingerprint: "e".repeat(64),
          licenseConfirmedAt: new Date(),
        },
      });
      const replacementFont = await prisma.brandFont.create({
        data: {
          workspaceId: fixture.workspace.id,
          licenseConfirmedByUserId: fixture.user.id,
          family: "Race Sans Replacement",
          style: "normal",
          weight: 400,
          format: "ttf",
          storageKey: `workspaces/${fixture.workspace.id}/brand-fonts/race-replacement.ttf`,
          sizeBytes: 128,
          fingerprint: "f".repeat(64),
          licenseConfirmedAt: new Date(),
        },
      });
      await prisma.brandProfileFont.create({ data: { profileId: profile.id, fontId: sourceFont.id, role: "body", position: 0 } });
      await raceCreateAgainstDelete(
        "Concurrent race font",
        {
          schemaVersion: 1,
          durationSec: 3,
          content: {
            kind: "text",
            text: "Race-safe",
            fontFamily: sourceFont.family,
            fontAsset: { kind: "brand_font", id: sourceFont.id, fingerprint: sourceFont.fingerprint },
            color: "#FFFFFF",
            backgroundColor: "#000000",
          },
          motion: { entrance: "fade", exit: "fade" },
        },
        () => brandFontService.softDelete(fixture.scope, sourceFont.id, { replacementId: replacementFont.id }),
        "scene_template_font_invalid",
      );
      expect((await prisma.brandFont.findUniqueOrThrow({ where: { id: sourceFont.id } })).deletedAt).not.toBeNull();
      expect(
        await prisma.brandProfileFont.findUnique({
          where: { profileId_role: { profileId: profile.id, role: "body" } },
        }),
      ).toMatchObject({ fontId: replacementFont.id });
    } finally {
      await blocker.query("SELECT pg_advisory_unlock_all()");
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "${databaseSchema}"."SceneTemplate"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${databaseSchema}"."${triggerFunction}"()`);
      blocker.release();
    }
  });

  test("replays upload finalization without reading the object twice", async () => {
    const fixture = await workspaceFixture("asset-replay");
    const fingerprint = "c".repeat(64);
    const key = `workspaces/${fixture.workspace.id}/visual-assets/replay.png`;
    let objectReads = 0;
    const service = new VisualAssetService({
      async presign() {
        return "https://upload.example.test";
      },
      async head() {
        objectReads += 1;
        return { contentType: "image/png", sizeBytes: 128 };
      },
      async probe() {
        return {
          kind: "image",
          contentType: "image/png",
          width: 64,
          height: 64,
          durationSec: null,
        };
      },
      async fingerprint() {
        return fingerprint;
      },
      async accessUrl() {
        return "https://download.example.test";
      },
    });
    (
      service as unknown as { requirePrisma: () => PrismaClient }
    ).requirePrisma = () => prisma;
    const input = {
      key,
      contentType: "image/png" as const,
      sizeBytes: 128,
      fingerprint,
      title: "Replay",
      provenance: "uploaded" as const,
    };

    const created = await service.finalizeUpload(fixture.scope, input);
    const replay = await service.finalizeUpload(fixture.scope, input);

    expect(replay.id).toBe(created.id);
    expect(replay.replayed).toBe(true);
    expect(objectReads).toBe(1);
  });

  async function setTier<T extends { workspace: { id: string }; scope: { pricingTier: string } }>(f: T, tier: "free" | "creator" | "pro" | "business"): Promise<T> {
    await prisma.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: tier } });
    return { ...f, scope: { ...f.scope, pricingTier: tier } };
  }

  test("a personal Workspace keeps the same branding across Creator, Business, and Pro", async () => {
    let f = await workspaceFixture("tier-stable", true);
    const profile = await brandProfileService.create(f.scope, { name: "Stable", slug: "stable" });
    await brandProfileService.setDefault(f.scope, profile.id);
    const asset = await prisma.visualAsset.create({ data: {
      ...resolveBrandOwner(f.scope),
      createdByUserId: f.user.id,
      title: "Scene image",
      kind: "image",
      storageKey: `visual-assets/${f.user.id}/${randomUUID()}.png`,
      contentType: "image/png",
      sizeBytes: BigInt(128),
      width: 10,
      height: 10,
      fingerprint: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    } });
    expect(await prisma.brandProfile.findUniqueOrThrow({ where: { id: profile.id } })).toMatchObject({ userId: f.user.id, workspaceId: null });
    for (const tier of ["business", "pro", "creator"] as const) {
      f = await setTier(f, tier);
      expect((await brandProfileService.list(f.scope)).map((row) => row.id)).toEqual([profile.id]);
      expect(await brandProfileService.getDefaultId(f.scope)).toBe(profile.id);
      expect((await brandProfileService.resolveForProject(f.scope, { profileId: profile.id })).profileId).toBe(profile.id);
      // Export and render resolve Scene assets from the Workspace kind alone.
      const exportOwner = brandOwnerWhereFor(brandOwnerForWorkspace({ id: f.workspace.id, personalOwnerUserId: f.workspace.personalOwnerUserId }));
      expect(await prisma.visualAsset.count({ where: { id: asset.id, ...exportOwner } })).toBe(1);
      expect(await prisma.visualAsset.count({ where: { id: asset.id, ...brandOwnerWhere(f.scope) } })).toBe(1);
    }
  });

  test("the ownership migration moves personal-Business rows and their default to the owner", async () => {
    const f = await workspaceFixture("ownership-migration", true);
    const workspaceOwned = await prisma.brandProfile.create({ data: {
      workspaceId: f.workspace.id, createdByUserId: f.user.id, updatedByUserId: f.user.id,
      name: "Old rule", slug: "same", visualIdentity: {}, voiceGuidance: {},
    } });
    const userOwned = await prisma.brandProfile.create({ data: {
      userId: f.user.id, createdByUserId: f.user.id, updatedByUserId: f.user.id,
      name: "Kept", slug: "same", visualIdentity: {}, voiceGuidance: {},
    } });
    const asset = await prisma.visualAsset.create({ data: {
      workspaceId: f.workspace.id, createdByUserId: f.user.id, title: "Old rule asset", kind: "image",
      storageKey: `workspaces/${f.workspace.id}/visual-assets/${randomUUID()}.png`, contentType: "image/png",
      sizeBytes: BigInt(1), width: 1, height: 1, fingerprint: randomUUID(),
    } });
    await prisma.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "business", defaultBrandProfileId: workspaceOwned.id } });
    const shared = await workspaceFixture("ownership-migration-shared");
    const sharedProfile = await brandProfileService.create(shared.scope, { name: "Shared", slug: "shared" });

    const sql = await Bun.file(new URL("../../db/prisma/migrations/20261026000003_brand_owner_by_workspace_kind/migration.sql", import.meta.url)).text();
    const client = await pool.connect();
    try {
      if (databaseSchema) await client.query(`SET search_path TO "${databaseSchema}"`);
      await client.query(sql);
      await client.query(sql);
    } finally {
      client.release();
    }

    const moved = await prisma.brandProfile.findUniqueOrThrow({ where: { id: workspaceOwned.id } });
    expect(moved).toMatchObject({ userId: f.user.id, workspaceId: null });
    expect(moved.slug).toBe(`same-${workspaceOwned.id.slice(0, 8)}`);
    expect(await prisma.brandProfile.findUniqueOrThrow({ where: { id: userOwned.id } })).toMatchObject({ slug: "same" });
    expect(await prisma.visualAsset.findUniqueOrThrow({ where: { id: asset.id } })).toMatchObject({ userId: f.user.id, workspaceId: null });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: f.user.id } })).defaultBrandProfileId).toBe(workspaceOwned.id);
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspace.id } })).defaultBrandProfileId).toBeNull();
    expect(await prisma.brandProfile.findUniqueOrThrow({ where: { id: sharedProfile.id } })).toMatchObject({ userId: null, workspaceId: shared.workspace.id });
    expect((await brandProfileService.list({ ...f.scope, pricingTier: "business" })).map((row) => row.id).sort()).toEqual([userOwned.id, workspaceOwned.id].sort());
  });

  test("admits exactly one of two concurrent creations for the last Brand Profile slot", async () => {
    const f = await workspaceFixture("profile-last-slot", true);
    const results = await Promise.allSettled([
      brandProfileService.create(f.scope, { name: "One", slug: "one" }),
      brandProfileService.create(f.scope, { name: "Two", slug: "two" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({
      code: "plan_limit_reached",
      kind: "payment_required",
      details: { limit: "brandProfiles", used: 1, max: 1, currentTier: "creator", requiredTier: "pro" },
    });
    expect(await prisma.brandProfile.count({ where: { userId: f.user.id, deletedAt: null } })).toBe(1);
  });

  test("over the profile limit after a downgrade, profiles stay visible, editable, and removable", async () => {
    let f = await workspaceFixture("profile-over-limit", true);
    f = await setTier(f, "pro");
    const first = await brandProfileService.create(f.scope, { name: "First", slug: "first" });
    const second = await brandProfileService.create(f.scope, { name: "Second", slug: "second" });
    await brandProfileService.setDefault(f.scope, first.id);
    f = await setTier(f, "creator");
    expect((await brandProfileService.list(f.scope)).map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
    await expect(brandProfileService.create(f.scope, { name: "Third", slug: "third" })).rejects.toMatchObject({ code: "plan_limit_reached", details: { used: 2, max: 1 } });
    const renamed = await brandProfileService.update(f.scope, second.id, { revision: second.revision, name: "Second renamed" });
    expect(renamed.name).toBe("Second renamed");
    await brandProfileService.softDelete(f.scope, second.id, { revision: renamed.revision });
    // On Free no default can be chosen, so deleting the default clears it.
    f = await setTier(f, "free");
    await brandProfileService.softDelete(f.scope, first.id, { revision: first.revision });
    expect(await brandProfileService.list(f.scope)).toEqual([]);
    expect(await brandProfileService.getDefaultId(f.scope)).toBeNull();
  });

  test("a downgraded Free Workspace can delete a profile and then its font and asset", async () => {
    let f = await workspaceFixture("free-cleanup", true);
    const profile = await brandProfileService.create(f.scope, { name: "Cleanup", slug: "cleanup" });
    const owner = resolveBrandOwner(f.scope);
    const font = await prisma.brandFont.create({ data: {
      ...owner, licenseConfirmedByUserId: f.user.id, family: "Acme", style: "normal", weight: 400, format: "ttf",
      storageKey: `brand-fonts/${f.user.id}/${randomUUID()}.ttf`, sizeBytes: BigInt(1), fingerprint: randomUUID(), licenseConfirmedAt: new Date(),
    } });
    const asset = await prisma.visualAsset.create({ data: {
      ...owner, createdByUserId: f.user.id, title: "Logo", kind: "image", storageKey: `visual-assets/${f.user.id}/${randomUUID()}.png`,
      contentType: "image/png", sizeBytes: BigInt(1), width: 1, height: 1, fingerprint: randomUUID(),
    } });
    await prisma.brandProfileFont.create({ data: { profileId: profile.id, fontId: font.id, role: "display", position: 0 } });
    await prisma.brandProfileAsset.create({ data: { profileId: profile.id, assetId: asset.id, role: "logo", position: 0 } });
    f = await setTier(f, "free");
    await expect(brandFontService.softDelete(f.scope, font.id, {})).rejects.toMatchObject({ code: "brand_font_in_use" });
    await brandProfileService.softDelete(f.scope, profile.id, { revision: profile.revision });
    await brandFontService.softDelete(f.scope, font.id, {});
    await visualAssetService.softDelete(f.scope, asset.id, {});
    expect((await prisma.brandFont.findUniqueOrThrow({ where: { id: font.id } })).deletedAt).not.toBeNull();
    expect((await prisma.visualAsset.findUniqueOrThrow({ where: { id: asset.id } })).deletedAt).not.toBeNull();
  });

  test("a downgraded shared Workspace can remove its default when its plan cannot choose a replacement", async () => {
    let f = await workspaceFixture("shared-default-cleanup");
    const profile = await brandProfileService.create(f.scope, { name: "Shared default", slug: "shared-default" });
    await brandProfileService.setDefault(f.scope, profile.id);
    f = await setTier(f, "creator");
    await expect(brandProfileService.setDefault(f.scope, profile.id)).rejects.toBeInstanceOf(PlanRequirementError);
    await brandProfileService.softDelete(f.scope, profile.id, { revision: profile.revision });
    expect(await brandProfileService.getDefaultId(f.scope)).toBeNull();
    expect((await prisma.brandProfile.findUniqueOrThrow({ where: { id: profile.id } })).deletedAt).not.toBeNull();
  });

  test("approval governance needs Business, and a downgrade keeps an existing rule", async () => {
    let f = await workspaceFixture("governance", true);
    await expect(brandProfileService.create(f.scope, { name: "Governed", slug: "governed", approvalRule: "approval_required" }))
      .rejects.toMatchObject({ code: "plan_feature_required", details: { feature: "brand.governance", currentTier: "creator", requiredTier: "business" } });
    const plain = await brandProfileService.create(f.scope, { name: "Plain", slug: "plain" });
    await expect(brandProfileService.update(f.scope, plain.id, { revision: plain.revision, approvalRule: "approval_required" }))
      .rejects.toMatchObject({ code: "plan_feature_required", details: { feature: "brand.governance" } });
    f = await setTier(f, "business");
    const governed = await brandProfileService.update(f.scope, plain.id, { revision: plain.revision, approvalRule: "approval_required" });
    f = await setTier(f, "creator");
    const kept = await brandProfileService.update(f.scope, plain.id, { revision: governed.revision, name: "Still governed", approvalRule: "approval_required" });
    expect(kept.approvalRule).toBe("approval_required");
    const cleared = await brandProfileService.update(f.scope, plain.id, { revision: kept.revision, approvalRule: "none" });
    expect(cleared.approvalRule).toBe("none");
  });

  test("custom Brand Templates need a paid plan, count per Workspace, and stay removable", async () => {
    const f = await workspaceFixture("templates", true);
    const scope = { actorUserId: f.user.id, workspaceId: f.workspace.id };
    const builtIn = await prisma.brandTemplate.create({ data: { name: "Built-in", isBuiltIn: true, builtInKey: `builtin-${randomUUID()}`, captionPreset: DEFAULT_CAPTION_PRESET } });
    const input = { name: "Mine", captionPreset: DEFAULT_CAPTION_PRESET };
    await setTier(f, "free");
    const refusal = { code: "plan_feature_required", details: { feature: "brand.customTemplates", requiredTier: "creator" } };
    await expect(brandTemplateService.create(scope, input as never)).rejects.toMatchObject(refusal);
    await expect(brandTemplateService.duplicate(scope, builtIn.id)).rejects.toMatchObject(refusal);
    await expect(brandTemplateService.presignLogoUpload(scope, { contentType: "image/png" } as never)).rejects.toMatchObject(refusal);
    // Built-ins stay free to choose and apply.
    await brandTemplateService.setDefault(scope, builtIn.id);
    expect((await brandTemplateService.resolveSnapshotForUser(f.user.id, builtIn.id, scope))?.templateId).toBe(builtIn.id);

    await setTier(f, "creator");
    const made = [
      await brandTemplateService.create(scope, input as never),
      await brandTemplateService.duplicate(scope, builtIn.id),
    ];
    const race = await Promise.allSettled([
      brandTemplateService.create(scope, { ...input, name: "Race A" } as never),
      brandTemplateService.duplicate(scope, made[0]!.id, "Race B"),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((race.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
      .toMatchObject({ code: "plan_limit_reached", details: { limit: "brandTemplates", used: 3, max: 3, requiredTier: "pro" } });
    const updated = await brandTemplateService.update(scope, made[0]!.id, { name: "Renamed" } as never);
    expect(updated.name).toBe("Renamed");
    await brandTemplateService.setDefault(scope, made[0]!.id);

    await setTier(f, "free");
    // Applying a custom template, requested or as the default, needs the plan again.
    await expect(brandTemplateService.resolveSnapshotForUser(f.user.id, made[1]!.id, scope)).rejects.toMatchObject(refusal);
    await expect(brandTemplateService.resolveSnapshotForUser(f.user.id, null, scope)).rejects.toMatchObject(refusal);
    await expect(brandTemplateService.update(scope, made[0]!.id, { name: "No" } as never)).rejects.toMatchObject(refusal);
    expect((await brandTemplateService.list(scope)).mine).toHaveLength(3);
    for (const template of (await brandTemplateService.list(scope)).mine) await brandTemplateService.softDelete(scope, template.id);
    expect((await brandTemplateService.list(scope)).mine).toEqual([]);
  });

  test("default intro and outro Scenes need Business, and Scene Templates stay removable on Free", async () => {
    let f = await workspaceFixture("default-scenes", true);
    f = await setTier(f, "pro");
    const profile = await brandProfileService.create(f.scope, { name: "Scenes", slug: "scenes" });
    const definition = {
      schemaVersion: 1,
      durationSec: 2,
      content: { kind: "color", color: "#1D4ED8" },
      motion: { entrance: "none", exit: "none", durationSec: 0.5 },
    };
    await expect(sceneTemplateService.create(f.scope, profile.id, { name: "Intro", role: "intro", definition, makeDefault: true }))
      .rejects.toMatchObject({ code: "plan_feature_required", details: { feature: "brand.defaultScenes", currentTier: "pro", requiredTier: "business" } });
    const intro = await sceneTemplateService.create(f.scope, profile.id, { name: "Intro", role: "intro", definition });
    f = await setTier(f, "free");
    await expect(sceneTemplateService.create(f.scope, profile.id, { name: "Another", role: "inline", definition }))
      .rejects.toMatchObject({ code: "plan_feature_required", details: { feature: "brand.scenes" } });
    await sceneTemplateService.softDelete(f.scope, profile.id, intro.id, { expectedRevision: intro.revision });
    expect(await sceneTemplateService.list(f.scope, profile.id)).toEqual([]);
  });

  test("a downgraded Workspace can clear a default Scene but not edit Scenes", async () => {
    let f = await workspaceFixture("clear-default-scene", true);
    f = await setTier(f, "business");
    const profile = await brandProfileService.create(f.scope, { name: "Defaults", slug: "defaults" });
    const definition = {
      schemaVersion: 1,
      durationSec: 2,
      content: { kind: "color", color: "#1D4ED8" },
      motion: { entrance: "none", exit: "none", durationSec: 0.5 },
    };
    const intro = await sceneTemplateService.create(f.scope, profile.id, { name: "Intro", role: "intro", definition, makeDefault: true });
    expect((await prisma.brandProfile.findUniqueOrThrow({ where: { id: profile.id } })).defaultIntroSceneTemplateId).toBe(intro.id);
    f = await setTier(f, "free");
    await expect(sceneTemplateService.update(f.scope, profile.id, intro.id, { expectedRevision: intro.revision, name: "Renamed" }))
      .rejects.toMatchObject({ code: "plan_feature_required", details: { feature: "brand.scenes" } });
    await expect(sceneTemplateService.update(f.scope, profile.id, intro.id, { expectedRevision: intro.revision, name: "Renamed", makeDefault: false }))
      .rejects.toMatchObject({ code: "plan_feature_required", details: { feature: "brand.scenes" } });
    await expect(sceneTemplateService.update({ ...f.scope, role: "viewer" }, profile.id, intro.id, { expectedRevision: intro.revision, makeDefault: false }))
      .rejects.toMatchObject({ code: "brand_forbidden" });
    await sceneTemplateService.update(f.scope, profile.id, intro.id, { expectedRevision: intro.revision, makeDefault: false });
    expect((await prisma.brandProfile.findUniqueOrThrow({ where: { id: profile.id } })).defaultIntroSceneTemplateId).toBeNull();
  });

  test("a downgraded Workspace can clear a profile's logo and default template but not change its identity", async () => {
    let f = await workspaceFixture("clear-profile-logo", true);
    f = await setTier(f, "pro");
    const profile = await brandProfileService.create(f.scope, { name: "Logo", slug: "logo" });
    const asset = await prisma.visualAsset.create({ data: {
      ...resolveBrandOwner(f.scope), createdByUserId: f.user.id, title: "Logo", kind: "image", storageKey: `visual-assets/${f.user.id}/${randomUUID()}.png`,
      contentType: "image/png", sizeBytes: BigInt(1), width: 1, height: 1, fingerprint: randomUUID(),
    } });
    const identity = { primaryColor: "#FFFFFF", secondaryColor: "#111522", accentColor: null, primaryLogoAssetId: asset.id, alternateLogoAssetId: null };
    const withLogo = await brandProfileService.update(f.scope, profile.id, { revision: profile.revision, identity });
    f = await setTier(f, "free");
    await expect(brandProfileService.update(f.scope, profile.id, { revision: withLogo.revision, identity: { ...identity, primaryColor: "#000000" } }))
      .rejects.toMatchObject({ code: "plan_feature_required" });
    await expect(brandProfileService.update(f.scope, profile.id, { revision: withLogo.revision, identity: { ...identity, primaryLogoAssetId: null, alternateLogoAssetId: asset.id } }))
      .rejects.toMatchObject({ code: "plan_feature_required" });
    await expect(brandProfileService.update(f.scope, profile.id, { revision: withLogo.revision, name: "Renamed" }))
      .rejects.toMatchObject({ code: "plan_feature_required" });
    await expect(brandProfileService.update({ ...f.scope, role: "viewer" }, profile.id, { revision: withLogo.revision, defaultTemplateId: null }))
      .rejects.toMatchObject({ code: "brand_forbidden" });
    await brandProfileService.update(f.scope, profile.id, { revision: withLogo.revision, identity: { ...identity, primaryLogoAssetId: null }, defaultTemplateId: null });
    const stored = await prisma.brandProfile.findUniqueOrThrow({ where: { id: profile.id } });
    expect(stored.defaultTemplateId).toBeNull();
    expect((stored.visualIdentity as { primaryLogoAssetId: string | null }).primaryLogoAssetId).toBeNull();
    expect(await prisma.brandProfileAsset.count({ where: { profileId: profile.id, role: "logo" } })).toBe(0);
  });

  test("renaming a profile keeps its approval rule", async () => {
    let f = await workspaceFixture("keep-approval-rule", true);
    f = await setTier(f, "business");
    const profile = await brandProfileService.create(f.scope, { name: "Governed", slug: "governed", approvalRule: "approval_required" });
    await brandProfileService.update(f.scope, profile.id, { revision: profile.revision, name: "Governed renamed" });
    expect((await prisma.brandProfile.findUniqueOrThrow({ where: { id: profile.id } })).approvalRule).toBe("approval_required");
  });
  test("font uploads verify bytes and ownership; deleted uploads remain available to saved clips", async () => {
    const f = await workspaceFixture("custom-font", true);
    const other = await workspaceFixture("other-font-owner", true);
    const bytes = readFileSync(new URL("../../caption-fonts/fonts/Anton-Regular.ttf", import.meta.url));
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    let unavailable = false;
    let uploads = 0;
    const service = new BrandFontService({
      isR2Configured: () => true,
      headObject: async () => ({ contentType: "font/ttf", sizeBytes: bytes.length, etag: null, metadata: {} }),
      readObjectBytes: async () => { if (unavailable) throw new Error("missing"); return bytes; },
      presignDownloadUrl: async () => "https://storage.example.test/font.ttf",
      presignSingleUploadUrl: async () => { uploads++; return "https://storage.example.test/upload"; },
    });
    const metadata = { contentType: "font/ttf" as const, sizeBytes: bytes.length, licenseConfirmed: true as const };
    await expect(service.presignUpload({ ...f.scope, pricingTier: "free" }, metadata)).rejects.toMatchObject({ code: "plan_feature_required" });
    await expect(service.presignUpload({ ...f.scope, role: "viewer" }, metadata)).rejects.toMatchObject({ code: "brand_forbidden" });
    expect(uploads).toBe(0);
    const presigned = await service.presignUpload(f.scope, metadata);
    expect(presigned.key).toStartWith(`brand-fonts/${f.user.id}/`);
    const input = { ...metadata, key: presigned.key, fingerprint };
    await expect(service.finalizeUpload(other.scope, input)).rejects.toMatchObject({ code: "brand_font_key_forbidden" });
    await expect(service.finalizeUpload(f.scope, { ...input, fingerprint: "f".repeat(64) })).rejects.toMatchObject({ code: "brand_font_fingerprint_mismatch" });
    const font = await service.finalizeUpload(f.scope, input);
    expect(font.family).toBe("Anton");
    expect(font.face?.assName).toBe("Anton Regular");
    expect(font.face?.ascent).toBeCloseTo(1.4043, 4);
    expect((await service.finalizeUpload(f.scope, input)).replayed).toBe(true);
    expect((await service.list(f.scope)).map((item) => item.id)).toEqual([font.id]);
    const ref = { id: font.id, fingerprint };
    await service.assertSelection(f.scope, ref);
    await expect(service.assertSelection(other.scope, ref)).rejects.toMatchObject({ code: "brand_font_not_found" });
    expect(await service.resolveReferences(other.scope, [ref])).toEqual([]);
    const styleInput = brandTemplateInputSchema.parse({ name: "Custom font style", captionPreset: { ...DEFAULT_CAPTION_PRESET, fontAsset: { kind: "brand_font", ...ref } } });
    await expect(brandTemplateService.create(other.scope, styleInput)).rejects.toMatchObject({ code: "brand_font_not_found" });
    const style = await brandTemplateService.create(f.scope, styleInput);
    expect(style.captionPreset.fontAsset).toEqual({ kind: "brand_font", ...ref });
    await expect(service.softDelete(f.scope, font.id, {})).rejects.toMatchObject({ code: "brand_font_in_use" });
    await brandTemplateService.update(f.scope, style.id, { captionPreset: { ...style.captionPreset, fontAsset: null } });
    const profile = await brandProfileService.create(f.scope, { name: "Typography", slug: "typography" });
    await prisma.brandProfileFont.create({ data: { profileId: profile.id, fontId: font.id, role: "caption", position: 0 } });
    await expect(service.softDelete(f.scope, font.id, {})).rejects.toMatchObject({ code: "brand_font_in_use" });
    await brandProfileService.setMembership({ ...f.scope, pricingTier: "free" }, profile.id, { kind: "font", resourceId: font.id, role: "caption", position: 0, remove: true });
    expect(await prisma.brandProfileFont.count({ where: { profileId: profile.id } })).toBe(0);
    await service.softDelete(f.scope, font.id, {});
    expect(await service.list(f.scope)).toEqual([]);
    await expect(service.assertSelection(f.scope, ref)).rejects.toMatchObject({ code: "brand_font_not_found" });
    expect((await service.resolveReferences(f.scope, [ref]))[0]?.accessUrl).toBe("https://storage.example.test/font.ttf");
    expect(await service.resolveReferences(f.scope, [{ ...ref, fingerprint: "b".repeat(64) }])).toEqual([]);
    unavailable = true;
    expect((await service.resolveReferences(f.scope, [ref]))[0]?.accessUrl).toBeNull();
    unavailable = false;
    const restored = await service.finalizeUpload(f.scope, input);
    expect(restored.id).toBe(font.id);
    expect((await service.list(f.scope)).map((item) => item.id)).toEqual([font.id]);
  });

});
