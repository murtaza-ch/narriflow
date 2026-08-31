import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import { createPrismaThumbnailExtractionStore } from "./thumbnail-extraction.prisma";

const now = new Date("2026-08-31T10:00:00.000Z");
const claimExpiresAt = new Date("2026-08-31T10:02:00.000Z");
const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  workspace: "10000000-0000-4000-8000-000000000002",
  project: "10000000-0000-4000-8000-000000000003",
  variant: "10000000-0000-4000-8000-000000000004",
  job: "10000000-0000-4000-8000-000000000005",
  claim: "10000000-0000-4000-8000-000000000006",
  asset: "10000000-0000-4000-8000-000000000007",
};
const destinationStorageKey =
  `visual-assets/extracted/${ids.workspace}/${ids.job}/attempt-1.jpg`;

function job(status: "processing" | "completed", assetId: string | null) {
  return {
    id: ids.job,
    workspaceId: ids.workspace,
    projectId: ids.project,
    actorUserId: ids.actor,
    idempotencyKey: "request-1",
    requestFingerprint: "a".repeat(64),
    platform: "instagram_reels",
    exportVariantId: ids.variant,
    sourceStorageKey: "exports/frozen.mp4",
    sourceTimeMs: 4_000,
    title: "Exact frame",
    status,
    attempts: 1,
    claimId: status === "processing" ? ids.claim : null,
    claimExpiresAt: status === "processing" ? claimExpiresAt : null,
    assetId,
    errorCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("Prisma thumbnail extraction output adoption", () => {
  test("renews the live job and its exact cleanup hold in one transaction", async () => {
    const renewedAt = new Date("2026-08-31T10:01:00.000Z");
    const renewedUntil = new Date("2026-08-31T10:03:00.000Z");
    const calls: string[] = [];
    let inTransaction = false;
    const fake = {
      thumbnailExtractionJob: {
        updateMany: async (input: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          expect(inTransaction).toBe(true);
          expect(input).toEqual({
            where: {
              id: ids.job,
              status: "processing",
              claimId: ids.claim,
              claimExpiresAt: { gt: renewedAt },
            },
            data: {
              claimExpiresAt: renewedUntil,
              updatedAt: renewedAt,
            },
          });
          calls.push("job");
          return { count: 1 };
        },
      },
      mediaCleanupObligation: {
        updateMany: async (input: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          expect(inTransaction).toBe(true);
          expect(input).toEqual({
            where: {
              claimId: ids.claim,
              claimExpiresAt: { gt: renewedAt },
              completedAt: null,
              attemptCount: 0,
              OR: [{
                origin: "thumbnail_extraction",
                cleanupClass: "thumbnail_extraction_output",
                objectKey: destinationStorageKey,
              }],
            },
            data: {
              claimExpiresAt: renewedUntil,
              nextAttemptAt: renewedUntil,
            },
          });
          calls.push("cleanup");
          return { count: 1 };
        },
      },
      $transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await operation(fake);
        } finally {
          inTransaction = false;
        }
      },
    } as unknown as PrismaClient;
    const store = createPrismaThumbnailExtractionStore({ prisma: fake });

    await store.renewOutput({
      jobId: ids.job,
      claimId: ids.claim,
      destinationStorageKey,
      now: renewedAt,
      claimExpiresAt: renewedUntil,
    });

    expect(calls).toEqual(["job", "cleanup"]);
  });

  test("admits before object publication and adopts the exact key in the asset/job transaction", async () => {
    let inTransaction = false;
    let cleanupAdmitted = false;
    let cleanupAdopted = false;
    let assetCreated = false;
    let jobCompleted = false;
    const processing = {
      ...job("processing", null),
      workspace: { personalOwnerUserId: ids.actor, pricingTier: "business" },
    };
    const completed = job("completed", ids.asset);
    const fake = {
      thumbnailExtractionJob: {
        findFirst: async () => processing,
        updateMany: async (input: { data?: { status?: string } }) => {
          expect(inTransaction).toBe(true);
          if (input.data?.status === "completed") jobCompleted = true;
          return { count: 1 };
        },
        findUniqueOrThrow: async () => completed,
      },
      visualAsset: {
        upsert: async (input: {
          create: { storageKey: string; userId: string | null; workspaceId: string | null };
        }) => {
          expect(inTransaction).toBe(true);
          expect(cleanupAdmitted).toBe(true);
          expect(input.create.storageKey).toBe(destinationStorageKey);
          expect(input.create).toMatchObject({
            userId: ids.actor,
            workspaceId: null,
          });
          assetCreated = true;
          return {
            id: ids.asset,
            storageKey: destinationStorageKey,
            fingerprint: "b".repeat(64),
            deletedAt: null,
          };
        },
      },
      mediaCleanupObligation: {
        createMany: async (input: { data: Array<{ objectKey: string; claimId?: string }> }) => {
          expect(inTransaction).toBe(true);
          expect(input.data).toEqual([
            expect.objectContaining({
              origin: "thumbnail_extraction",
              cleanupClass: "thumbnail_extraction_output",
              objectKey: destinationStorageKey,
              claimId: ids.claim,
            }),
          ]);
          cleanupAdmitted = true;
          return { count: 1 };
        },
        updateMany: async (input: {
          where: Record<string, unknown>;
          data: { completedAt?: Date };
        }) => {
          expect(inTransaction).toBe(true);
          expect(assetCreated).toBe(true);
          expect(jobCompleted).toBe(true);
          expect(input.where).toMatchObject({
            claimId: ids.claim,
            completedAt: null,
            OR: [{
              origin: "thumbnail_extraction",
              cleanupClass: "thumbnail_extraction_output",
              objectKey: destinationStorageKey,
            }],
          });
          expect(input.data.completedAt).toEqual(now);
          cleanupAdopted = true;
          return { count: 1 };
        },
        count: async () => 0,
      },
      $transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await operation(fake);
        } finally {
          inTransaction = false;
        }
      },
    } as unknown as PrismaClient;
    const store = createPrismaThumbnailExtractionStore({ prisma: fake });

    await store.prepareOutput({
      jobId: ids.job,
      claimId: ids.claim,
      claimExpiresAt,
      destinationStorageKey,
      now,
    });
    await store.complete({
      jobId: ids.job,
      claimId: ids.claim,
      asset: {
        id: ids.asset,
        workspaceId: ids.workspace,
        createdByUserId: ids.actor,
        title: "Exact frame",
        kind: "image",
        storageKey: destinationStorageKey,
        contentType: "image/jpeg",
        sizeBytes: 42_000,
        width: 1080,
        height: 1920,
        fingerprint: "b".repeat(64),
        provenance: "extracted",
        sourceExportVariantId: ids.variant,
        sourceTimeMs: 4_000,
        deletedAt: null,
        createdAt: now,
      },
      now,
    });

    expect({ cleanupAdmitted, assetCreated, jobCompleted, cleanupAdopted }).toEqual({
      cleanupAdmitted: true,
      assetCreated: true,
      jobCompleted: true,
      cleanupAdopted: true,
    });
  });

  test("loads one newest durable job per requested exact export", async () => {
    const completed = job("completed", ids.asset);
    const asset = {
      id: ids.asset,
      userId: ids.actor,
      workspaceId: null,
      createdByUserId: ids.actor,
      title: "Exact frame",
      kind: "image",
      storageKey: destinationStorageKey,
      contentType: "image/jpeg",
      sizeBytes: 42_000n,
      width: 1080,
      height: 1920,
      fingerprint: "b".repeat(64),
      provenance: "extracted",
      sourceExportVariantId: ids.variant,
      sourceTimeMs: 4_000,
      deletedAt: null,
      createdAt: now,
    };
    const fake = {
      thumbnailExtractionJob: {
        groupBy: async (input: {
          where: {
            workspaceId: string;
            projectId: string;
            platform: string;
            exportVariantId: { in: string[] };
          };
        }) => {
          expect(input.where).toEqual({
            workspaceId: ids.workspace,
            projectId: ids.project,
            platform: "instagram_reels",
            exportVariantId: { in: [ids.variant] },
          });
          return [{ exportVariantId: ids.variant, _max: { createdAt: now } }];
        },
        findMany: async (input: {
          where: { OR: Array<{ exportVariantId: string; createdAt: Date }> };
          include: { asset: boolean };
        }) => {
          expect(input.where.OR).toEqual([
            { exportVariantId: ids.variant, createdAt: now },
          ]);
          expect(input.include).toEqual({ asset: true });
          return [{ ...completed, asset }];
        },
      },
    } as unknown as PrismaClient;
    const store = createPrismaThumbnailExtractionStore({ prisma: fake });

    await expect(store.listLatest({
      actorUserId: ids.actor,
      workspaceId: ids.workspace,
      projectId: ids.project,
      platform: "instagram_reels",
      exportVariantIds: [ids.variant],
    })).resolves.toEqual([{
      record: completed,
      asset: expect.objectContaining({
        id: ids.asset,
        workspaceId: ids.workspace,
        sourceExportVariantId: ids.variant,
      }),
    }]);
  });

  test("releases a duplicate attempt object when the frozen frame already has an asset", async () => {
    const existingAssetId = "10000000-0000-4000-8000-000000000008";
    const existingStorageKey = "visual-assets/extracted/existing-frame.jpg";
    let released = false;
    const processing = {
      ...job("processing", null),
      workspace: { personalOwnerUserId: ids.actor, pricingTier: "creator" },
    };
    const fake = {
      thumbnailExtractionJob: {
        findFirst: async () => processing,
        updateMany: async () => ({ count: 1 }),
        findUniqueOrThrow: async () => job("completed", existingAssetId),
      },
      visualAsset: {
        upsert: async () => ({
          id: existingAssetId,
          storageKey: existingStorageKey,
          fingerprint: "a".repeat(64),
          deletedAt: null,
        }),
      },
      mediaCleanupObligation: {
        updateMany: async (input: {
          where: Record<string, unknown>;
          data: { completedAt?: Date; claimId?: string | null; nextAttemptAt?: Date };
        }) => {
          expect(input.data.completedAt).toBeUndefined();
          expect(input.where).toMatchObject({
            origin: "thumbnail_extraction",
            cleanupClass: "thumbnail_extraction_output",
            objectKey: destinationStorageKey,
          });
          expect(input.data).toMatchObject({ claimId: null, nextAttemptAt: now });
          released = true;
          return { count: 1 };
        },
        count: async () => 0,
      },
      $transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
        operation(fake),
    } as unknown as PrismaClient;
    const store = createPrismaThumbnailExtractionStore({ prisma: fake });

    expect(await store.complete({
      jobId: ids.job,
      claimId: ids.claim,
      asset: {
        id: ids.asset,
        workspaceId: ids.workspace,
        createdByUserId: ids.actor,
        title: "Exact frame",
        kind: "image",
        storageKey: destinationStorageKey,
        contentType: "image/jpeg",
        sizeBytes: 42_000,
        width: 1080,
        height: 1920,
        fingerprint: "b".repeat(64),
        provenance: "extracted",
        sourceExportVariantId: ids.variant,
        sourceTimeMs: 4_000,
        deletedAt: null,
        createdAt: now,
      },
      now,
    })).toMatchObject({ assetId: existingAssetId, status: "completed" });
    expect(released).toBe(true);
  });
});
