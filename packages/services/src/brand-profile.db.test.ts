import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { DEFAULT_CAPTION_PRESET } from "@narriflow/validators";
import { Pool } from "pg";
import {
  BrandProfileConflictError,
  BrandProfileMembershipError,
  BrandProfileMissingAssetError,
  BrandProfileNotFoundError,
  BrandProfileService,
  brandProfileService,
} from "./brand-profile.service";
import { BrandAccessError } from "./brand-ownership";
import { brandFontService } from "./brand-font.service";
import { projectService } from "./project.service";
import { ProgramWriteDisabledError } from "./program-rollout";
import { sceneTemplateService } from "./scene-template.service";
import {
  VISUAL_ASSET_UPLOAD_CLEANUP_SKEW_SECONDS,
  VISUAL_ASSET_UPLOAD_URL_TTL_SECONDS,
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
  let priorProjectionWrites: string | undefined;
  const prismaGlobal = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };

  beforeAll(() => {
    if (!databaseUrl) throw new Error("Brand Profile test database is required");
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined) });
    priorPrisma = prismaGlobal.narriflowPrismaClient;
    prismaGlobal.narriflowPrismaClient = prisma;
    priorProjectionWrites = process.env.NARRIFLOW_WRITES_BRAND_KIT_PROJECTION;
    process.env.NARRIFLOW_WRITES_BRAND_KIT_PROJECTION = "1";
  });

  afterAll(async () => {
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    if (priorProjectionWrites === undefined) {
      delete process.env.NARRIFLOW_WRITES_BRAND_KIT_PROJECTION;
    } else {
      process.env.NARRIFLOW_WRITES_BRAND_KIT_PROJECTION = priorProjectionWrites;
    }
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
    await expect(
      brandProfileService.resolveForProject(
        { ...first.scope, pricingTier: "free" },
        { profileId: profile.id },
      ),
    ).rejects.toBeInstanceOf(BrandAccessError);
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

  test("stops project profile writes when the projection rollout is disabled", async () => {
    process.env.NARRIFLOW_WRITES_BRAND_KIT_PROJECTION = "0";
    try {
      await expect(
        brandProfileService.resolveForProject(
          {
            actorUserId: randomUUID(),
            workspaceId: randomUUID(),
            workspaceOwnerUserId: randomUUID(),
            role: "owner",
            status: "active",
            pricingTier: "business",
            isPersonalWorkspace: false,
          },
          { profileId: randomUUID() },
        ),
      ).rejects.toBeInstanceOf(ProgramWriteDisabledError);
    } finally {
      process.env.NARRIFLOW_WRITES_BRAND_KIT_PROJECTION = "1";
    }
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
    ).rejects.toBeInstanceOf(BrandAccessError);
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
    await prisma.mediaCleanupObligation.create({
      data: {
        origin: "visual_asset_upload",
        cleanupClass: "unfinalized_visual_asset_upload",
        objectKey: key,
        nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const created = await service.finalizeUpload(fixture.scope, input);
    const replay = await service.finalizeUpload(fixture.scope, input);

    expect(replay.id).toBe(created.id);
    expect(replay.replayed).toBe(true);
    expect(objectReads).toBe(1);
  });

  test("defers presigned upload cleanup beyond URL expiry and adopts it atomically", async () => {
    const fixture = await workspaceFixture("asset-upload-cleanup");
    const startedAt = new Date("2026-08-31T00:00:00.000Z");
    const signedAt = new Date("2026-08-31T00:00:02.000Z");
    const times = [startedAt, signedAt];
    const fingerprint = "d".repeat(64);
    let signedTtl: number | undefined;
    const service = new VisualAssetService(
      {
        async presign(input) {
          signedTtl = input.expiresInSeconds;
          return "https://upload.example.test";
        },
        async head() {
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
      },
      () => times.shift() ?? signedAt,
    );
    (
      service as unknown as { requirePrisma: () => PrismaClient }
    ).requirePrisma = () => prisma;

    const grant = await service.presignUpload(fixture.scope, {
      contentType: "image/png",
      sizeBytes: 128,
    });
    const obligation = await prisma.mediaCleanupObligation.findUniqueOrThrow({
      where: {
        origin_cleanupClass_objectKey: {
          origin: "visual_asset_upload",
          cleanupClass: "unfinalized_visual_asset_upload",
          objectKey: grant.key,
        },
      },
    });
    const expiresAt = new Date(
      startedAt.getTime() + VISUAL_ASSET_UPLOAD_URL_TTL_SECONDS * 1000,
    );
    expect(signedTtl).toBe(VISUAL_ASSET_UPLOAD_URL_TTL_SECONDS);
    expect(grant.expiresAt).toBe(expiresAt.toISOString());
    expect(obligation.nextAttemptAt).toEqual(
      new Date(
        signedAt.getTime() +
          (VISUAL_ASSET_UPLOAD_URL_TTL_SECONDS +
            VISUAL_ASSET_UPLOAD_CLEANUP_SKEW_SECONDS) *
            1000,
      ),
    );
    expect(obligation.nextAttemptAt.getTime()).toBeGreaterThan(
      expiresAt.getTime(),
    );

    const asset = await service.finalizeUpload(fixture.scope, {
      key: grant.key,
      contentType: "image/png",
      sizeBytes: 128,
      fingerprint,
      title: "Cleanup-owned upload",
      provenance: "uploaded",
    });
    expect(asset.fingerprint).toBe(fingerprint);
    expect(
      await prisma.mediaCleanupObligation.findUniqueOrThrow({
        where: { id: obligation.id },
      }),
    ).toMatchObject({
      completedAt: expect.any(Date),
      failureCode: "visual_asset_adopted",
      claimId: null,
    });
  });

  test("rejects Visual Asset finalization after exact-key cleanup has claimed the upload", async () => {
    const fixture = await workspaceFixture("asset-upload-claim-race");
    const fingerprint = "e".repeat(64);
    const key = `workspaces/${fixture.workspace.id}/visual-assets/claimed.png`;
    await prisma.mediaCleanupObligation.create({
      data: {
        origin: "visual_asset_upload",
        cleanupClass: "unfinalized_visual_asset_upload",
        objectKey: key,
        attemptCount: 1,
        claimId: randomUUID(),
        claimExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const service = new VisualAssetService({
      async presign() {
        return "https://upload.example.test";
      },
      async head() {
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

    await expect(
      service.finalizeUpload(fixture.scope, {
        key,
        contentType: "image/png",
        sizeBytes: 128,
        fingerprint,
        title: "Claimed upload",
        provenance: "uploaded",
      }),
    ).rejects.toMatchObject({ code: "visual_asset_upload_ownership_lost" });
    expect(
      await prisma.visualAsset.count({ where: { storageKey: key } }),
    ).toBe(0);
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
