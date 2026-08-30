import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { DEFAULT_CAPTION_PRESET } from "@narriflow/validators";
import { Pool } from "pg";
import {
  BrandProfileConflictError,
  BrandProfileMembershipError,
  BrandProfileNotFoundError,
  brandProfileService,
} from "./brand-profile.service";
import { projectService } from "./project.service";
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

  test("enforces owner scope, built-in exclusion, and optimistic concurrency", async () => {
    const first = await workspaceFixture("scope-first");
    const second = await workspaceFixture("scope-second");
    const profile = await brandProfileService.create(first.scope, { name: "Northstar", slug: "northstar" });
    await expect(brandProfileService.get(second.scope, profile.id)).rejects.toBeInstanceOf(BrandProfileNotFoundError);

    const builtIn = await prisma.brandTemplate.create({ data: { name: "Global", isBuiltIn: true, builtInKey: `global-${randomUUID()}`, captionPreset: DEFAULT_CAPTION_PRESET } });
    await expect(brandProfileService.setMembership(first.scope, profile.id, { kind: "template", resourceId: builtIn.id, position: 0 })).rejects.toBeInstanceOf(BrandProfileMembershipError);

    const updates = await Promise.allSettled([
      brandProfileService.update(first.scope, profile.id, { revision: profile.revision, name: "Northstar One" }),
      brandProfileService.update(first.scope, profile.id, { revision: profile.revision, name: "Northstar Two" }),
    ]);
    expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(updates.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason)).toEqual([expect.any(BrandProfileConflictError)]);

    const linkIngest = await projectService.queueLinkIngest(first.user.id, {
      url: "https://www.youtube.com/watch?v=brand-profile-db-test",
      brandProfileId: profile.id,
      commitToken: randomUUID(),
    }, first.workspace.id);
    const frozen = await prisma.project.findUniqueOrThrow({
      where: { id: linkIngest.project.id },
      select: { brandProfileId: true, brandProfileSnapshot: true },
    });
    expect(frozen.brandProfileId).toBe(profile.id);
    expect(frozen.brandProfileSnapshot).toMatchObject({ profileId: profile.id });
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
    const profile = await brandProfileService.create(first.scope, { name: "Asset profile", slug: "asset-profile" });
    await brandProfileService.setMembership(first.scope, profile.id, { kind: "asset", resourceId: original.id, role: "logo", position: 0 });
    await expect(visualAssetService.softDelete(first.scope, original.id, {})).rejects.toBeInstanceOf(VisualAssetReferenceError);
    await visualAssetService.softDelete(first.scope, original.id, { replacementId: replacement.id });
    expect(await prisma.brandProfileAsset.findUnique({ where: { profileId_assetId: { profileId: profile.id, assetId: replacement.id } } })).not.toBeNull();
    expect((await prisma.visualAsset.findUniqueOrThrow({ where: { id: original.id } })).deletedAt).not.toBeNull();
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
        return { kind: "image", width: 64, height: 64, durationSec: null };
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

  test("backfill is bounded, resumable, idempotent, and leaves built-ins, deleted templates, and old Project reads unchanged", async () => {
    const collaborative = await workspaceFixture("backfill-workspace");
    const personal = await workspaceFixture("backfill-personal", true);
    const templateData = (name: string) => ({ name, captionPreset: DEFAULT_CAPTION_PRESET, primaryColor: "#FFFFFF", secondaryColor: "#00FF88" });
    const workspaceTemplate = await prisma.brandTemplate.create({ data: { ...templateData("Workspace style"), userId: collaborative.user.id, workspaceId: collaborative.workspace.id, createdByUserId: collaborative.user.id } });
    const personalTemplate = await prisma.brandTemplate.create({ data: { ...templateData("Personal style"), userId: personal.user.id, workspaceId: personal.workspace.id, createdByUserId: personal.user.id } });
    await prisma.brandTemplate.create({ data: { ...templateData("Deleted style"), userId: collaborative.user.id, workspaceId: collaborative.workspace.id, deletedAt: new Date() } });
    const builtIn = await prisma.brandTemplate.create({ data: { ...templateData("Built in"), isBuiltIn: true, builtInKey: `builtin-${randomUUID()}` } });
    await prisma.brandTemplate.create({ data: templateData("Ownerless style") });
    await prisma.workspace.update({ where: { id: collaborative.workspace.id }, data: { defaultBrandTemplateId: workspaceTemplate.id } });

    const first = await brandProfileService.backfillCompatibilityProfiles({ batchSize: 1 });
    expect(first.processedTemplates).toBe(1);
    let cursor = first.nextCursor ?? undefined;
    while (cursor) {
      const next = await brandProfileService.backfillCompatibilityProfiles({ cursor, batchSize: 1 });
      cursor = next.done ? undefined : (next.nextCursor ?? undefined);
    }
    const profileCount = await prisma.brandProfile.count({ where: { isCompatibility: true, OR: [{ workspaceId: collaborative.workspace.id }, { userId: personal.user.id }] } });
    expect(profileCount).toBe(2);
    const rerun = await brandProfileService.backfillCompatibilityProfiles({ batchSize: 100 });
    expect(rerun.createdProfiles).toBe(0);
    expect(rerun.attachedTemplates).toBe(0);
    expect(await prisma.brandProfileTemplate.count({ where: { templateId: { in: [workspaceTemplate.id, personalTemplate.id] } } })).toBe(2);

    const compatibilityProfile = await prisma.brandProfile.findFirstOrThrow({
      where: { workspaceId: collaborative.workspace.id, isCompatibility: true },
    });
    expect(await brandProfileService.resolveProfileForTemplate(collaborative.scope, workspaceTemplate.id)).toBe(compatibilityProfile.id);
    expect(await brandProfileService.resolveProfileForTemplate(collaborative.scope, builtIn.id)).toBeNull();
    expect(await brandProfileService.resolveProfileForTemplate(collaborative.scope, randomUUID())).toBeNull();
    expect((await brandProfileService.get({ ...collaborative.scope, pricingTier: "free" }, compatibilityProfile.id)).id).toBe(compatibilityProfile.id);
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: collaborative.workspace.id } })).defaultBrandTemplateId).toBe(workspaceTemplate.id);

    const deletedTemplate = await prisma.brandTemplate.create({
      data: {
        ...templateData("Deleted route style"),
        userId: collaborative.user.id,
        workspaceId: collaborative.workspace.id,
      },
    });
    const deletedProfile = await prisma.brandProfile.create({
      data: {
        workspaceId: collaborative.workspace.id,
        createdByUserId: collaborative.user.id,
        updatedByUserId: collaborative.user.id,
        name: "Deleted profile",
        slug: `deleted-profile-${randomUUID()}`,
        visualIdentity: {},
        voiceGuidance: {},
        deletedAt: new Date(),
        templates: { create: { templateId: deletedTemplate.id, position: 0 } },
      },
    });
    expect(await brandProfileService.resolveProfileForTemplate(collaborative.scope, deletedTemplate.id)).toBeNull();
    await expect(brandProfileService.get(collaborative.scope, deletedProfile.id)).rejects.toBeInstanceOf(BrandProfileNotFoundError);

    const project = await prisma.project.create({ data: { title: "Legacy project", sourceMediaUrl: "https://example.test/video.mp4", userId: collaborative.user.id, workspaceId: collaborative.workspace.id, brandTemplateId: workspaceTemplate.id, brandSnapshot: { templateId: workspaceTemplate.id } } });
    const legacyRead = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { brandTemplateId: true, brandSnapshot: true, brandProfileId: true } });
    expect(legacyRead).toEqual({ brandTemplateId: workspaceTemplate.id, brandSnapshot: { templateId: workspaceTemplate.id }, brandProfileId: null });
  });
});
