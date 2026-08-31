import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool, type PoolClient } from "pg";

const databaseUrl = process.env.VIZARD_EXPANSION_TEST_DATABASE_URL;
const enabled =
  process.env.ALLOW_VIZARD_EXPANSION_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;
const root = resolve(import.meta.dir, "../../..");
const frozenMigration = "20260831210000_generated_media_lifecycle_hardening";
const ownershipMigration = "20260831220000_stable_personal_brand_ownership";

setDefaultTimeout(180_000);

dbDescribe("stable personal Brand ownership migration", () => {
  let schema: string;
  let migrationPool: Pool;
  let prismaPool: Pool;
  let migrationClient: PoolClient;
  let prisma: PrismaClient;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("Vizard expansion test database is required");
    schema = `stable_brand_owner_${randomUUID().replaceAll("-", "")}`;
    migrationPool = new Pool({ connectionString: databaseUrl, max: 1 });
    prismaPool = new Pool({ connectionString: databaseUrl, max: 4 });
    await migrationPool.query(`CREATE SCHEMA "${schema}"`);
    migrationClient = await migrationPool.connect();
    await migrationClient.query(`SET search_path TO "${schema}"`);

    const migrations = readdirSync(
      resolve(root, "packages/db/prisma/migrations"),
    )
      .filter((entry) => /^\d+_/.test(entry) && entry <= frozenMigration)
      .sort();
    for (const migration of migrations) {
      await migrationClient.query(
        readFileSync(
          resolve(root, "packages/db/prisma/migrations", migration, "migration.sql"),
          "utf8",
        ),
      );
    }

    prisma = new PrismaClient({
      adapter: new PrismaPg(prismaPool, { schema }),
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    migrationClient?.release();
    await prismaPool?.end();
    await migrationPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await migrationPool?.end();
  });

  test("repairs only personal XOR owners while preserving IDs, links, defaults, and team owners", async () => {
    const personalUser = await prisma.user.create({
      data: {
        clerkId: `stable-personal-${randomUUID()}`,
        primaryEmail: `stable-personal-${randomUUID()}@example.test`,
      },
    });
    const teamUser = await prisma.user.create({
      data: {
        clerkId: `stable-team-${randomUUID()}`,
        primaryEmail: `stable-team-${randomUUID()}@example.test`,
      },
    });
    const personalWorkspace = await prisma.workspace.create({
      data: {
        name: "Stable personal owner",
        ownerUserId: personalUser.id,
        personalOwnerUserId: personalUser.id,
        pricingTier: "business",
      },
    });
    const teamWorkspace = await prisma.workspace.create({
      data: {
        name: "Stable team owner",
        ownerUserId: teamUser.id,
        pricingTier: "business",
      },
    });

    const personalProfile = await prisma.brandProfile.create({
      data: {
        workspaceId: personalWorkspace.id,
        createdByUserId: personalUser.id,
        updatedByUserId: personalUser.id,
        name: "Personal Business profile",
        slug: `personal-business-${randomUUID()}`,
        visualIdentity: {},
        voiceGuidance: {},
      },
    });
    const teamProfile = await prisma.brandProfile.create({
      data: {
        workspaceId: teamWorkspace.id,
        createdByUserId: teamUser.id,
        updatedByUserId: teamUser.id,
        name: "Team Business profile",
        slug: `team-business-${randomUUID()}`,
        visualIdentity: {},
        voiceGuidance: {},
      },
    });
    await prisma.workspace.update({
      where: { id: personalWorkspace.id },
      data: { defaultBrandProfileId: personalProfile.id },
    });
    await prisma.workspace.update({
      where: { id: teamWorkspace.id },
      data: { defaultBrandProfileId: teamProfile.id },
    });

    const personalAsset = await prisma.visualAsset.create({
      data: {
        workspaceId: personalWorkspace.id,
        createdByUserId: personalUser.id,
        title: "Personal generated still",
        kind: "image",
        storageKey: `workspaces/${personalWorkspace.id}/visual-assets/${randomUUID()}.png`,
        contentType: "image/png",
        sizeBytes: 128n,
        width: 1080,
        height: 1920,
        fingerprint: "a".repeat(64),
        provenance: "generated",
      },
    });
    const teamAsset = await prisma.visualAsset.create({
      data: {
        workspaceId: teamWorkspace.id,
        createdByUserId: teamUser.id,
        title: "Team generated still",
        kind: "image",
        storageKey: `workspaces/${teamWorkspace.id}/visual-assets/${randomUUID()}.png`,
        contentType: "image/png",
        sizeBytes: 128n,
        width: 1080,
        height: 1920,
        fingerprint: "b".repeat(64),
        provenance: "generated",
      },
    });
    const personalFont = await prisma.brandFont.create({
      data: {
        workspaceId: personalWorkspace.id,
        licenseConfirmedByUserId: personalUser.id,
        family: "Personal Sans",
        style: "Regular",
        weight: 400,
        format: "woff2",
        storageKey: `workspaces/${personalWorkspace.id}/brand-fonts/${randomUUID()}.woff2`,
        sizeBytes: 256n,
        fingerprint: "c".repeat(64),
        licenseConfirmedAt: new Date(),
      },
    });
    const teamFont = await prisma.brandFont.create({
      data: {
        workspaceId: teamWorkspace.id,
        licenseConfirmedByUserId: teamUser.id,
        family: "Team Sans",
        style: "Regular",
        weight: 400,
        format: "woff2",
        storageKey: `workspaces/${teamWorkspace.id}/brand-fonts/${randomUUID()}.woff2`,
        sizeBytes: 256n,
        fingerprint: "d".repeat(64),
        licenseConfirmedAt: new Date(),
      },
    });
    const excludedTemplate = await prisma.brandTemplate.create({
      data: {
        workspaceId: personalWorkspace.id,
        createdByUserId: personalUser.id,
        updatedByUserId: personalUser.id,
        name: "Excluded Brand Template",
        captionPreset: {},
      },
    });
    const excludedAudio = await prisma.audioAsset.create({
      data: {
        workspaceId: personalWorkspace.id,
        createdByUserId: personalUser.id,
        kind: "music",
        storageKey: `workspaces/${personalWorkspace.id}/audio/${randomUUID()}.mp3`,
        title: "Excluded audio",
        durationSec: 10,
      },
    });
    await prisma.brandProfileAsset.create({
      data: {
        profileId: personalProfile.id,
        assetId: personalAsset.id,
        role: "image",
      },
    });
    await prisma.brandProfileFont.create({
      data: {
        profileId: personalProfile.id,
        fontId: personalFont.id,
        role: "display",
      },
    });
    const scene = await prisma.sceneTemplate.create({
      data: {
        profileId: personalProfile.id,
        sourceAssetId: personalAsset.id,
        createdByUserId: personalUser.id,
        name: "Frozen opener",
        definition: {},
        fingerprint: "e".repeat(64),
      },
    });

    const personalProject = await prisma.project.create({
      data: {
        title: "Personal campaign",
        sourceMediaUrl: "https://media.example.test/personal.mp4",
        sourceStorageKey: `fixtures/${randomUUID()}/personal.mp4`,
        userId: personalUser.id,
        workspaceId: personalWorkspace.id,
        createdByUserId: personalUser.id,
        brandProfileId: personalProfile.id,
        brandProfileSnapshot: { profileId: personalProfile.id },
        ingestStatus: "ready",
      },
    });
    const teamProject = await prisma.project.create({
      data: {
        title: "Team campaign",
        sourceMediaUrl: "https://media.example.test/team.mp4",
        sourceStorageKey: `fixtures/${randomUUID()}/team.mp4`,
        userId: teamUser.id,
        workspaceId: teamWorkspace.id,
        createdByUserId: teamUser.id,
        ingestStatus: "ready",
      },
    });
    const personalJob = await prisma.generatedMediaJob.create({
      data: {
        workspaceId: personalWorkspace.id,
        projectId: personalProject.id,
        actorUserId: personalUser.id,
        ownerWorkspaceId: personalWorkspace.id,
        kind: "image",
        status: "completed",
        idempotencyKey: randomUUID(),
        requestFingerprint: "f".repeat(64),
        provider: "test",
        model: "test-image",
        promptFingerprint: "1".repeat(64),
        promptKeyVersion: "primary",
        promptOriginKind: "manual",
        promptOriginSourceIds: [],
        aspectRatio: "9:16",
        style: "editorial",
        resultAssetId: personalAsset.id,
        completedAt: new Date(),
      },
    });
    const teamJob = await prisma.generatedMediaJob.create({
      data: {
        workspaceId: teamWorkspace.id,
        projectId: teamProject.id,
        actorUserId: teamUser.id,
        ownerWorkspaceId: teamWorkspace.id,
        kind: "image",
        status: "completed",
        idempotencyKey: randomUUID(),
        requestFingerprint: "2".repeat(64),
        provider: "test",
        model: "test-image",
        promptFingerprint: "3".repeat(64),
        promptKeyVersion: "primary",
        promptOriginKind: "manual",
        promptOriginSourceIds: [],
        aspectRatio: "9:16",
        style: "editorial",
        resultAssetId: teamAsset.id,
        completedAt: new Date(),
      },
    });

    const migrationSql = readFileSync(
      resolve(
        root,
        "packages/db/prisma/migrations",
        ownershipMigration,
        "migration.sql",
      ),
      "utf8",
    );
    await migrationClient.query(migrationSql);

    const [
      repairedProfile,
      repairedAsset,
      repairedFont,
      repairedJob,
      repairedUser,
      repairedWorkspace,
      retainedTeamProfile,
      retainedTeamAsset,
      retainedTeamFont,
      retainedTeamJob,
      retainedTeamWorkspace,
      retainedProject,
      retainedScene,
      retainedTemplate,
      retainedAudio,
    ] = await Promise.all([
      prisma.brandProfile.findUniqueOrThrow({ where: { id: personalProfile.id } }),
      prisma.visualAsset.findUniqueOrThrow({ where: { id: personalAsset.id } }),
      prisma.brandFont.findUniqueOrThrow({ where: { id: personalFont.id } }),
      prisma.generatedMediaJob.findUniqueOrThrow({ where: { id: personalJob.id } }),
      prisma.user.findUniqueOrThrow({ where: { id: personalUser.id } }),
      prisma.workspace.findUniqueOrThrow({ where: { id: personalWorkspace.id } }),
      prisma.brandProfile.findUniqueOrThrow({ where: { id: teamProfile.id } }),
      prisma.visualAsset.findUniqueOrThrow({ where: { id: teamAsset.id } }),
      prisma.brandFont.findUniqueOrThrow({ where: { id: teamFont.id } }),
      prisma.generatedMediaJob.findUniqueOrThrow({ where: { id: teamJob.id } }),
      prisma.workspace.findUniqueOrThrow({ where: { id: teamWorkspace.id } }),
      prisma.project.findUniqueOrThrow({ where: { id: personalProject.id } }),
      prisma.sceneTemplate.findUniqueOrThrow({ where: { id: scene.id } }),
      prisma.brandTemplate.findUniqueOrThrow({ where: { id: excludedTemplate.id } }),
      prisma.audioAsset.findUniqueOrThrow({ where: { id: excludedAudio.id } }),
    ]);

    expect({
      profile: [repairedProfile.userId, repairedProfile.workspaceId],
      asset: [repairedAsset.userId, repairedAsset.workspaceId],
      font: [repairedFont.userId, repairedFont.workspaceId],
      job: [repairedJob.ownerUserId, repairedJob.ownerWorkspaceId],
    }).toEqual({
      profile: [personalUser.id, null],
      asset: [personalUser.id, null],
      font: [personalUser.id, null],
      job: [personalUser.id, null],
    });
    expect({
      userDefault: repairedUser.defaultBrandProfileId,
      workspaceDefault: repairedWorkspace.defaultBrandProfileId,
    }).toEqual({ userDefault: personalProfile.id, workspaceDefault: null });
    expect({
      profile: [retainedTeamProfile.userId, retainedTeamProfile.workspaceId],
      asset: [retainedTeamAsset.userId, retainedTeamAsset.workspaceId],
      font: [retainedTeamFont.userId, retainedTeamFont.workspaceId],
      job: [retainedTeamJob.ownerUserId, retainedTeamJob.ownerWorkspaceId],
      defaultId: retainedTeamWorkspace.defaultBrandProfileId,
    }).toEqual({
      profile: [null, teamWorkspace.id],
      asset: [null, teamWorkspace.id],
      font: [null, teamWorkspace.id],
      job: [null, teamWorkspace.id],
      defaultId: teamProfile.id,
    });
    expect({
      projectProfileId: retainedProject.brandProfileId,
      sceneProfileId: retainedScene.profileId,
      sceneAssetId: retainedScene.sourceAssetId,
      resultAssetId: repairedJob.resultAssetId,
      assetStorageKey: repairedAsset.storageKey,
      fontStorageKey: repairedFont.storageKey,
      excludedTemplateOwner: [retainedTemplate.userId, retainedTemplate.workspaceId],
      excludedAudioOwner: [retainedAudio.userId, retainedAudio.workspaceId],
    }).toEqual({
      projectProfileId: personalProfile.id,
      sceneProfileId: personalProfile.id,
      sceneAssetId: personalAsset.id,
      resultAssetId: personalAsset.id,
      assetStorageKey: personalAsset.storageKey,
      fontStorageKey: personalFont.storageKey,
      excludedTemplateOwner: [null, personalWorkspace.id],
      excludedAudioOwner: [null, personalWorkspace.id],
    });
  });

  test("fails before writes on default, target-unique, and owner-coherence conflicts", async () => {
    if (!databaseUrl) throw new Error("Vizard expansion test database is required");
    const conflictSchema = `stable_brand_conflict_${randomUUID().replaceAll("-", "")}`;
    const conflictMigrationPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const conflictPrismaPool = new Pool({ connectionString: databaseUrl, max: 4 });
    let conflictClient: PoolClient | undefined;
    let conflictPrisma: PrismaClient | undefined;
    try {
      await conflictMigrationPool.query(`CREATE SCHEMA "${conflictSchema}"`);
      conflictClient = await conflictMigrationPool.connect();
      await conflictClient.query(`SET search_path TO "${conflictSchema}"`);
      const migrations = readdirSync(
        resolve(root, "packages/db/prisma/migrations"),
      )
        .filter((entry) => /^\d+_/.test(entry) && entry <= frozenMigration)
        .sort();
      for (const migration of migrations) {
        await conflictClient.query(
          readFileSync(
            resolve(
              root,
              "packages/db/prisma/migrations",
              migration,
              "migration.sql",
            ),
            "utf8",
          ),
        );
      }
      conflictPrisma = new PrismaClient({
        adapter: new PrismaPg(conflictPrismaPool, { schema: conflictSchema }),
      });

      const personalUser = await conflictPrisma.user.create({
        data: {
          clerkId: `stable-conflict-personal-${randomUUID()}`,
          primaryEmail: `stable-conflict-personal-${randomUUID()}@example.test`,
        },
      });
      const teamUser = await conflictPrisma.user.create({
        data: {
          clerkId: `stable-conflict-team-${randomUUID()}`,
          primaryEmail: `stable-conflict-team-${randomUUID()}@example.test`,
        },
      });
      const personalWorkspace = await conflictPrisma.workspace.create({
        data: {
          name: "Conflicting personal owner",
          ownerUserId: personalUser.id,
          personalOwnerUserId: personalUser.id,
          pricingTier: "business",
        },
      });
      const teamWorkspace = await conflictPrisma.workspace.create({
        data: {
          name: "Unrelated team owner",
          ownerUserId: teamUser.id,
          pricingTier: "business",
        },
      });
      const workspaceProfile = await conflictPrisma.brandProfile.create({
        data: {
          workspaceId: personalWorkspace.id,
          createdByUserId: personalUser.id,
          updatedByUserId: personalUser.id,
          name: "Workspace default",
          slug: "target-slug",
          visualIdentity: {},
          voiceGuidance: {},
        },
      });
      const existingUserProfile = await conflictPrisma.brandProfile.create({
        data: {
          userId: personalUser.id,
          createdByUserId: personalUser.id,
          updatedByUserId: personalUser.id,
          name: "Existing user default",
          slug: "existing-user-default",
          visualIdentity: {},
          voiceGuidance: {},
        },
      });
      const teamProfile = await conflictPrisma.brandProfile.create({
        data: {
          workspaceId: teamWorkspace.id,
          createdByUserId: teamUser.id,
          updatedByUserId: teamUser.id,
          name: "Foreign team profile",
          slug: "foreign-team-profile",
          visualIdentity: {},
          voiceGuidance: {},
        },
      });
      await conflictPrisma.user.update({
        where: { id: personalUser.id },
        data: { defaultBrandProfileId: existingUserProfile.id },
      });
      await conflictPrisma.workspace.update({
        where: { id: personalWorkspace.id },
        data: { defaultBrandProfileId: workspaceProfile.id },
      });
      const workspaceFont = await conflictPrisma.brandFont.create({
        data: {
          workspaceId: personalWorkspace.id,
          licenseConfirmedByUserId: personalUser.id,
          family: "Collision Sans",
          style: "Regular",
          weight: 400,
          format: "woff2",
          storageKey: `workspaces/${personalWorkspace.id}/brand-fonts/${randomUUID()}.woff2`,
          sizeBytes: 256n,
          fingerprint: "7".repeat(64),
          licenseConfirmedAt: new Date(),
        },
      });
      const workspaceAsset = await conflictPrisma.visualAsset.create({
        data: {
          workspaceId: personalWorkspace.id,
          createdByUserId: personalUser.id,
          title: "Collision target asset",
          kind: "image",
          storageKey: `workspaces/${personalWorkspace.id}/visual-assets/${randomUUID()}.png`,
          contentType: "image/png",
          sizeBytes: 128n,
          width: 1080,
          height: 1920,
          fingerprint: "6".repeat(64),
          provenance: "generated",
        },
      });
      const personalProject = await conflictPrisma.project.create({
        data: {
          title: "Owner conflict campaign",
          sourceMediaUrl: "https://media.example.test/conflict.mp4",
          sourceStorageKey: `fixtures/${randomUUID()}/conflict.mp4`,
          userId: personalUser.id,
          workspaceId: personalWorkspace.id,
          createdByUserId: personalUser.id,
          ingestStatus: "ready",
        },
      });
      const job = await conflictPrisma.generatedMediaJob.create({
        data: {
          workspaceId: personalWorkspace.id,
          projectId: personalProject.id,
          actorUserId: personalUser.id,
          ownerWorkspaceId: personalWorkspace.id,
          kind: "image",
          status: "completed",
          idempotencyKey: randomUUID(),
          requestFingerprint: "8".repeat(64),
          provider: "test",
          model: "test-image",
          promptFingerprint: "9".repeat(64),
          promptKeyVersion: "primary",
          promptOriginKind: "manual",
          promptOriginSourceIds: [],
          aspectRatio: "9:16",
          style: "editorial",
          completedAt: new Date(),
        },
      });
      const migrationSql = readFileSync(
        resolve(
          root,
          "packages/db/prisma/migrations",
          ownershipMigration,
          "migration.sql",
        ),
        "utf8",
      );
      const expectFailure = async (code: string) => {
        let failure: unknown;
        try {
          await conflictClient!.query(migrationSql);
        } catch (error) {
          failure = error;
        }
        await conflictClient!.query("ROLLBACK");
        expect(failure).toMatchObject({
          message: expect.stringContaining(code),
        });
        expect(
          await conflictPrisma!.brandProfile.findUniqueOrThrow({
            where: { id: workspaceProfile.id },
          }),
        ).toMatchObject({ userId: null, workspaceId: personalWorkspace.id });
      };

      await expectFailure("stable_personal_brand_ownership_default_conflict");
      await conflictPrisma.user.update({
        where: { id: personalUser.id },
        data: { defaultBrandProfileId: null },
      });

      const collidingProfile = await conflictPrisma.brandProfile.create({
        data: {
          userId: personalUser.id,
          createdByUserId: personalUser.id,
          updatedByUserId: personalUser.id,
          name: "Target slug collision",
          slug: workspaceProfile.slug,
          visualIdentity: {},
          voiceGuidance: {},
        },
      });
      await expectFailure("stable_personal_brand_ownership_profile_slug_conflict");
      await conflictPrisma.brandProfile.delete({ where: { id: collidingProfile.id } });

      const collidingAsset = await conflictPrisma.visualAsset.create({
        data: {
          userId: personalUser.id,
          createdByUserId: personalUser.id,
          title: "Target fingerprint collision",
          kind: "image",
          storageKey: `visual-assets/${personalUser.id}/${randomUUID()}.png`,
          contentType: "image/png",
          sizeBytes: 128n,
          width: 1080,
          height: 1920,
          fingerprint: workspaceAsset.fingerprint,
          provenance: "generated",
        },
      });
      await expectFailure(
        "stable_personal_brand_ownership_visual_asset_fingerprint_conflict",
      );
      await conflictPrisma.visualAsset.delete({ where: { id: collidingAsset.id } });

      const collidingFont = await conflictPrisma.brandFont.create({
        data: {
          userId: personalUser.id,
          licenseConfirmedByUserId: personalUser.id,
          family: "Target collision",
          style: "Regular",
          weight: 400,
          format: "woff2",
          storageKey: `brand-fonts/${personalUser.id}/${randomUUID()}.woff2`,
          sizeBytes: 256n,
          fingerprint: workspaceFont.fingerprint,
          licenseConfirmedAt: new Date(),
        },
      });
      await expectFailure("stable_personal_brand_ownership_font_fingerprint_conflict");
      await conflictPrisma.brandFont.delete({ where: { id: collidingFont.id } });

      await conflictPrisma.generatedMediaJob.update({
        where: { id: job.id },
        data: {
          ownerUser: { disconnect: true },
          ownerWorkspace: { connect: { id: teamWorkspace.id } },
        },
      });
      await expectFailure("stable_personal_brand_ownership_generated_job_conflict");
      await conflictPrisma.generatedMediaJob.update({
        where: { id: job.id },
        data: { ownerWorkspace: { connect: { id: personalWorkspace.id } } },
      });

      await conflictPrisma.workspace.update({
        where: { id: personalWorkspace.id },
        data: { ownerUserId: teamUser.id },
      });
      await expectFailure("stable_personal_brand_ownership_workspace_identity_conflict");
      await conflictPrisma.workspace.update({
        where: { id: personalWorkspace.id },
        data: { ownerUserId: personalUser.id },
      });

      await conflictPrisma.workspace.update({
        where: { id: personalWorkspace.id },
        data: { defaultBrandProfileId: teamProfile.id },
      });
      await expectFailure("stable_personal_brand_ownership_default_owner_conflict");
    } finally {
      await conflictPrisma?.$disconnect();
      conflictClient?.release();
      await conflictPrismaPool.end();
      await conflictMigrationPool.query(
        `DROP SCHEMA IF EXISTS "${conflictSchema}" CASCADE`,
      );
      await conflictMigrationPool.end();
    }
  });
});
