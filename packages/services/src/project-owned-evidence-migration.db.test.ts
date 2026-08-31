import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool, type PoolClient } from "pg";

const databaseUrl = process.env.VIZARD_EXPANSION_TEST_DATABASE_URL;
const enabled =
  process.env.ALLOW_VIZARD_EXPANSION_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;
const root = resolve(import.meta.dir, "../../..");
const beforeLifecycleMigration =
  "20260831200000_generated_media_editor_insertions";
const lifecycleMigration =
  "20260831210000_generated_media_lifecycle_hardening";
const ownershipMigration =
  "20260831220000_stable_personal_brand_ownership";
const repairMigration =
  "20260831230000_project_owned_evidence_and_editor_v2_repair";

setDefaultTimeout(180_000);

function migrationSql(name: string) {
  return readFileSync(
    resolve(root, "packages/db/prisma/migrations", name, "migration.sql"),
    "utf8",
  );
}

async function applyMigrationsThrough(client: PoolClient, lastMigration: string) {
  const migrations = readdirSync(
    resolve(root, "packages/db/prisma/migrations"),
  )
    .filter((entry) => /^\d+_/.test(entry) && entry <= lastMigration)
    .sort();
  for (const migration of migrations) {
    await client.query(migrationSql(migration));
  }
}

dbDescribe("generated-media lifecycle and project-owned evidence migrations", () => {
  let migrationPool: Pool;

  beforeAll(() => {
    if (!databaseUrl) {
      throw new Error("Vizard expansion test database is required");
    }
    migrationPool = new Pool({ connectionString: databaseUrl, max: 2 });
  });

  afterAll(async () => {
    await migrationPool?.end();
  });

  test("rejects pre-lifecycle rows instead of fabricating key or allowance history", async () => {
    if (!databaseUrl) {
      throw new Error("Vizard expansion test database is required");
    }
    const schema = `generated_lifecycle_preflight_${randomUUID().replaceAll("-", "")}`;
    const prismaPool = new Pool({ connectionString: databaseUrl, max: 2 });
    const client = await migrationPool.connect();
    let prisma: PrismaClient | undefined;

    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await applyMigrationsThrough(client, beforeLifecycleMigration);
      prisma = new PrismaClient({
        adapter: new PrismaPg(prismaPool, { schema }),
      });

      const user = await prisma.user.create({
        data: {
          clerkId: `lifecycle-preflight-${randomUUID()}`,
          primaryEmail: `lifecycle-preflight-${randomUUID()}@example.test`,
        },
      });
      const workspace = await prisma.workspace.create({
        data: {
          name: "Lifecycle preflight",
          ownerUserId: user.id,
          pricingTier: "business",
        },
      });
      const project = await prisma.project.create({
        data: {
          title: "Lifecycle preflight",
          sourceMediaUrl: "https://media.example.test/source.mp4",
          userId: user.id,
          workspaceId: workspace.id,
          createdByUserId: user.id,
          ingestStatus: "ready",
        },
      });

      await client.query(
        `INSERT INTO "GeneratedMediaJob" (
          "id", "workspaceId", "projectId", "actorUserId", "ownerWorkspaceId",
          "kind", "status", "idempotencyKey", "requestFingerprint", "provider",
          "model", "promptFingerprint", "promptOriginKind", "promptOriginSourceIds",
          "aspectRatio", "style"
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $2::uuid,
          'image', 'queued', $5::uuid, $6, 'test-provider',
          'test-model', $7, 'manual', '[]'::jsonb, '9:16', 'editorial'
        )`,
        [
          randomUUID(),
          workspace.id,
          project.id,
          user.id,
          randomUUID(),
          "a".repeat(64),
          "b".repeat(64),
        ],
      );

      await expect(client.query(migrationSql(lifecycleMigration))).rejects.toThrow(
        "generated_media_lifecycle_preexisting_rows_require_reset",
      );
      await client.query("ROLLBACK");

      const columns = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'GeneratedMediaJob'
           AND column_name = 'promptKeyVersion'`,
        [schema],
      );
      expect(columns.rows[0]?.count).toBe(0);
    } finally {
      await prisma?.$disconnect();
      await prismaPool.end();
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
    }
  });

  test("repairs editor arrays and lets project deletion remove project-owned evidence", async () => {
    if (!databaseUrl) {
      throw new Error("Vizard expansion test database is required");
    }
    const schema = `project_evidence_repair_${randomUUID().replaceAll("-", "")}`;
    const prismaPool = new Pool({ connectionString: databaseUrl, max: 4 });
    const client = await migrationPool.connect();
    let prisma: PrismaClient | undefined;

    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await applyMigrationsThrough(client, ownershipMigration);
      prisma = new PrismaClient({
        adapter: new PrismaPg(prismaPool, { schema }),
      });

      const user = await prisma.user.create({
        data: {
          clerkId: `project-evidence-${randomUUID()}`,
          primaryEmail: `project-evidence-${randomUUID()}@example.test`,
        },
      });
      const workspace = await prisma.workspace.create({
        data: {
          name: "Project evidence repair",
          ownerUserId: user.id,
          personalOwnerUserId: user.id,
          pricingTier: "business",
        },
      });
      const project = await prisma.project.create({
        data: {
          title: "Project evidence repair",
          sourceMediaUrl: "https://media.example.test/source.mp4",
          sourceStorageKey: `fixtures/${randomUUID()}/source.mp4`,
          userId: user.id,
          workspaceId: workspace.id,
          createdByUserId: user.id,
          ingestStatus: "ready",
        },
      });
      const workflow = await prisma.workflowRun.create({
        data: {
          projectId: project.id,
          idempotencyKey: `project-evidence:${randomUUID()}`,
          stage: "moment_detection",
          status: "completed",
          progress: 100,
          lifecycleVersion: 2,
        },
      });
      const clip = await prisma.clip.create({
        data: {
          projectId: project.id,
          workflowRunId: workflow.id,
          index: 0,
          status: "edited",
          startSec: 0,
          endSec: 10,
          title: "Project evidence clip",
          hookText: "Migration repair",
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
        },
      });
      const clipExport = await prisma.clipExport.create({
        data: {
          projectId: project.id,
          workspaceId: workspace.id,
          createdByUserId: user.id,
          clipId: clip.id,
          editorRevision: clip.editorRevision,
          fingerprint: `project-evidence-${randomUUID()}`,
          resolution: "1080p",
          watermark: false,
          status: "ready",
          progress: 100,
          completedAt: new Date(),
          variants: {
            create: {
              aspectRatio: "ratio_9_16",
              resolution: "1080p",
              watermark: false,
              status: "completed",
              storageKey: `fixtures/${randomUUID()}/vertical.mp4`,
              sizeBytes: 1_024n,
              durationSec: 10,
              completedAt: new Date(),
            },
          },
        },
        include: { variants: true },
      });
      const variant = clipExport.variants[0];
      if (!variant?.storageKey) {
        throw new Error("Project evidence export variant is missing");
      }

      await client.query(`
        ALTER TABLE "Clip"
          ALTER COLUMN "sceneBlocks" DROP NOT NULL,
          ALTER COLUMN "sceneBlocks" DROP DEFAULT,
          ALTER COLUMN "censorSegments" DROP NOT NULL,
          ALTER COLUMN "censorSegments" DROP DEFAULT,
          ALTER COLUMN "mediaMotions" DROP NOT NULL,
          ALTER COLUMN "mediaMotions" DROP DEFAULT
      `);
      await client.query(
        `UPDATE "Clip"
         SET "sceneBlocks" = NULL,
             "censorSegments" = NULL,
             "mediaMotions" = NULL
         WHERE id = $1::uuid`,
        [clip.id],
      );

      const asset = await prisma.visualAsset.create({
        data: {
          userId: user.id,
          createdByUserId: user.id,
          title: "Reusable extracted frame",
          kind: "image",
          storageKey: `visual-assets/${user.id}/${randomUUID()}.jpg`,
          contentType: "image/jpeg",
          sizeBytes: 2_048n,
          width: 1_080,
          height: 1_920,
          fingerprint: "c".repeat(64),
          provenance: "extracted",
          sourceExportVariantId: variant.id,
          sourceTimeMs: 1_000,
        },
      });
      const thumbnailJob = await prisma.thumbnailExtractionJob.create({
        data: {
          workspaceId: workspace.id,
          projectId: project.id,
          actorUserId: user.id,
          idempotencyKey: randomUUID(),
          requestFingerprint: "d".repeat(64),
          platform: "youtube_shorts",
          exportVariantId: variant.id,
          sourceStorageKey: variant.storageKey,
          sourceTimeMs: 1_000,
          title: "Reusable extracted frame",
          status: "completed",
          attempts: 1,
          assetId: asset.id,
        },
      });
      const reviewRound = await prisma.reviewRound.create({
        data: {
          workspaceId: workspace.id,
          projectId: project.id,
          createdByUserId: user.id,
          revision: 1,
          title: "Project evidence review",
          accessTokenHash: "e".repeat(64),
        },
      });
      const reviewItem = await prisma.reviewRoundItem.create({
        data: {
          reviewRoundId: reviewRound.id,
          clipId: clip.id,
          exportId: clipExport.id,
          editorRevision: clip.editorRevision,
          position: 0,
          selectedVariantIds: [variant.id],
        },
      });
      const recipient = await prisma.reviewRecipient.create({
        data: {
          reviewRoundId: reviewRound.id,
          role: "reviewer",
          emailHash: "f".repeat(64),
          emailEncrypted: "encrypted-reviewer",
        },
      });
      const notification = await prisma.reviewNotification.create({
        data: {
          reviewRoundId: reviewRound.id,
          recipientId: recipient.id,
          kind: "review_invitation",
          sourceKey: `review:${reviewRound.id}`,
          status: "pending",
          attemptCount: 1,
          failureCode: "review_notification_provider_unavailable",
        },
      });
      const approvalOverride = await prisma.reviewApprovalOverride.create({
        data: {
          workspaceId: workspace.id,
          projectId: project.id,
          actorUserId: user.id,
          idempotencyKey: randomUUID(),
          requestFingerprint: "0".repeat(64),
          exportIds: [clipExport.id],
          reason: "Migration deletion fixture",
        },
      });

      await client.query(
        `UPDATE "Clip" SET "sceneBlocks" = '{}'::jsonb WHERE id = $1::uuid`,
        [clip.id],
      );
      await expect(client.query(migrationSql(repairMigration))).rejects.toThrow(
        "editor_document_v2_array_repair_conflict",
      );
      await client.query("ROLLBACK");
      const untouchedAfterPreflight = await client.query<{
        scene_blocks: unknown;
        censor_segments: unknown;
        media_motions: unknown;
      }>(
        `SELECT
           "sceneBlocks" AS scene_blocks,
           "censorSegments" AS censor_segments,
           "mediaMotions" AS media_motions
         FROM "Clip"
         WHERE id = $1::uuid`,
        [clip.id],
      );
      expect(untouchedAfterPreflight.rows[0]).toEqual({
        scene_blocks: {},
        censor_segments: null,
        media_motions: null,
      });
      await client.query(
        `UPDATE "Clip" SET "sceneBlocks" = NULL WHERE id = $1::uuid`,
        [clip.id],
      );

      await client.query(migrationSql(repairMigration));

      expect(
        await prisma.clip.findUniqueOrThrow({ where: { id: clip.id } }),
      ).toMatchObject({
        sceneBlocks: [],
        censorSegments: [],
        mediaMotions: [],
      });
      const repairedColumns = await client.query<{
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name::text, is_nullable::text, column_default::text
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'Clip'
           AND column_name IN ('sceneBlocks', 'censorSegments', 'mediaMotions')
         ORDER BY column_name`,
        [schema],
      );
      expect(repairedColumns.rows).toEqual([
        {
          column_name: "censorSegments",
          is_nullable: "NO",
          column_default: "'[]'::jsonb",
        },
        {
          column_name: "mediaMotions",
          is_nullable: "NO",
          column_default: "'[]'::jsonb",
        },
        {
          column_name: "sceneBlocks",
          is_nullable: "NO",
          column_default: "'[]'::jsonb",
        },
      ]);

      await expect(
        Promise.resolve(
          prisma.reviewNotification.update({
            where: { id: notification.id },
            data: { status: "not_a_status" },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          prisma.reviewNotification.update({
            where: { id: notification.id },
            data: { attemptCount: -1 },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          prisma.reviewNotification.update({
            where: { id: notification.id },
            data: { status: "claimed" },
          }),
        ),
      ).rejects.toThrow();
      const claimId = randomUUID();
      await prisma.reviewNotification.update({
        where: { id: notification.id },
        data: {
          status: "claimed",
          claimId,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      await prisma.reviewNotification.update({
        where: { id: notification.id },
        data: {
          status: "pending",
          claimId: null,
          leaseExpiresAt: null,
        },
      });
      await expect(
        Promise.resolve(
          prisma.reviewNotification.update({
            where: { id: notification.id },
            data: { claimId, leaseExpiresAt: new Date(Date.now() + 60_000) },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          prisma.reviewNotification.update({
            where: { id: notification.id },
            data: { status: "sent", failureCode: null },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          prisma.reviewNotification.update({
            where: { id: notification.id },
            data: { sentAt: new Date() },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          prisma.reviewNotification.update({
            where: { id: notification.id },
            data: { status: "failed", attemptCount: 1, failureCode: null },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          prisma.reviewNotification.update({
            where: { id: notification.id },
            data: {
              status: "failed",
              attemptCount: 0,
              failureCode: "review_notification_provider_unavailable",
            },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          prisma.visualAsset.update({
            where: { id: asset.id },
            data: { sourceTimeMs: null },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          prisma.visualAsset.update({
            where: { id: asset.id },
            data: { provenance: "generated" },
          }),
        ),
      ).rejects.toThrow();

      await prisma.project.delete({ where: { id: project.id } });

      expect(
        await Promise.all([
          prisma.project.count({ where: { id: project.id } }),
          prisma.clip.count({ where: { id: clip.id } }),
          prisma.clipExport.count({ where: { id: clipExport.id } }),
          prisma.clipExportVariant.count({ where: { id: variant.id } }),
          prisma.thumbnailExtractionJob.count({ where: { id: thumbnailJob.id } }),
          prisma.reviewRound.count({ where: { id: reviewRound.id } }),
          prisma.reviewRoundItem.count({ where: { id: reviewItem.id } }),
          prisma.reviewApprovalOverride.count({
            where: { id: approvalOverride.id },
          }),
          prisma.reviewNotification.count({ where: { id: notification.id } }),
        ]),
      ).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
      expect(
        await prisma.visualAsset.findUniqueOrThrow({ where: { id: asset.id } }),
      ).toMatchObject({
        userId: user.id,
        workspaceId: null,
        provenance: "extracted",
        sourceExportVariantId: variant.id,
        sourceTimeMs: 1_000,
      });
    } finally {
      await prisma?.$disconnect();
      await prismaPool.end();
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
    }
  });
});
