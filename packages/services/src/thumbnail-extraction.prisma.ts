import { randomUUID } from "node:crypto";

import {
  Prisma,
  type PrismaClient,
  type ThumbnailExtractionJob,
  type VisualAsset,
} from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import type { SocialPlatform } from "@narriflow/validators";

import { analyticsService } from "./analytics.service";
import { resolveBrandOwnerForWorkspace } from "./brand-ownership";
import { assertPublishingPreparationWriteEnabled } from "./program-rollout";
import { hasFeature } from "./plan-features";
import { headObject } from "./r2-storage";
import { withSerializableTransaction } from "./serializable-transaction";
import {
  MediaCleanupAdoptionLost,
  adoptHeldMediaCleanupObligations,
  admitMediaCleanupObligations,
} from "./media-cleanup";
import {
  ThumbnailExtractionError,
  createThumbnailExtractionService,
  type ExtractedThumbnailAsset,
  type ThumbnailExtractionRecord,
  type ThumbnailExtractionStore,
  type ThumbnailFrameProcessor,
} from "./thumbnail-extraction.service";
import { workspaceService } from "./workspace.service";

const CLAIM_LEASE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 3;
const THUMBNAIL_CLEANUP_IDENTITY = {
  origin: "visual_asset_upload" as const,
  cleanupClass: "unfinalized_visual_asset_upload" as const,
};

function thumbnailAdoptionReceipt(jobId: string) {
  return `thumbnail_extraction_adopted:${jobId}`;
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

function toRecord(row: ThumbnailExtractionJob): ThumbnailExtractionRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    actorUserId: row.actorUserId,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    platform: row.platform,
    exportVariantId: row.exportVariantId,
    sourceStorageKey: row.sourceStorageKey,
    sourceTimeMs: row.sourceTimeMs,
    title: row.title,
    status: row.status as ThumbnailExtractionRecord["status"],
    attempts: row.attempts,
    claimId: row.claimId,
    claimExpiresAt: row.claimExpiresAt,
    assetId: row.assetId,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAsset(row: VisualAsset, workspaceId: string): ExtractedThumbnailAsset {
  if (
    row.kind !== "image" ||
    row.provenance !== "extracted" ||
    !row.sourceExportVariantId ||
    row.sourceTimeMs === null ||
    !["image/jpeg", "image/png", "image/webp"].includes(row.contentType)
  ) {
    throw new ThumbnailExtractionError(
      "thumbnail_asset_invalid",
      "The extracted thumbnail asset has invalid persisted metadata",
    );
  }
  return {
    id: row.id,
    workspaceId,
    createdByUserId: row.createdByUserId,
    title: row.title,
    kind: "image",
    storageKey: row.storageKey,
    contentType: row.contentType as ExtractedThumbnailAsset["contentType"],
    sizeBytes: Number(row.sizeBytes),
    width: row.width,
    height: row.height,
    fingerprint: row.fingerprint,
    provenance: "extracted",
    sourceExportVariantId: row.sourceExportVariantId,
    sourceTimeMs: row.sourceTimeMs,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
  };
}

export function createPrismaThumbnailExtractionStore(options: {
  prisma?: PrismaClient;
  objectExists?: (storageKey: string) => Promise<boolean>;
} = {}): ThumbnailExtractionStore {
  const prisma = options.prisma ?? requirePrisma();
  const objectExists =
    options.objectExists ??
    (async (storageKey: string) => {
      try {
        await headObject(storageKey);
        return true;
      } catch {
        return false;
      }
    });

  return {
    async readVariant(input) {
      const variant = await prisma.clipExportVariant.findFirst({
        where: {
          id: input.exportVariantId,
          export: {
            projectId: input.projectId,
            project: { workspaceId: input.workspaceId },
          },
        },
        select: {
          id: true,
          status: true,
          storageKey: true,
          durationSec: true,
        },
      });
      if (!variant) return null;
      return {
        ...variant,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        status: variant.status as "pending" | "rendering" | "completed" | "failed",
        objectAvailable: variant.storageKey
          ? await objectExists(variant.storageKey)
          : false,
      };
    },

    async reserve(input) {
      try {
        const created = await prisma.thumbnailExtractionJob.create({ data: input });
        return { record: toRecord(created), created: true };
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
      }
      const existing = await prisma.thumbnailExtractionJob.findUnique({
        where: {
          workspaceId_projectId_idempotencyKey: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (!existing) throw new Error("Thumbnail idempotency row disappeared");
      return { record: toRecord(existing), created: false };
    },

    async claimNext(input) {
      return withSerializableTransaction(prisma, async (tx) => {
        await tx.thumbnailExtractionJob.updateMany({
          where: {
            status: "processing",
            claimExpiresAt: { lte: input.now },
            attempts: { lt: MAX_ATTEMPTS },
          },
          data: {
            status: "queued",
            claimId: null,
            claimExpiresAt: null,
            errorCode: "thumbnail_claim_expired",
            updatedAt: input.now,
          },
        });
        await tx.thumbnailExtractionJob.updateMany({
          where: {
            status: "processing",
            claimExpiresAt: { lte: input.now },
            attempts: { gte: MAX_ATTEMPTS },
          },
          data: {
            status: "failed",
            claimId: null,
            claimExpiresAt: null,
            errorCode: "thumbnail_claim_expired",
            updatedAt: input.now,
          },
        });

        const candidate = await tx.thumbnailExtractionJob.findFirst({
          where: { status: "queued", attempts: { lt: MAX_ATTEMPTS } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        if (!candidate) return null;
        const claimId = randomUUID();
        const claimed = await tx.thumbnailExtractionJob.updateMany({
          where: {
            id: candidate.id,
            status: "queued",
            attempts: candidate.attempts,
          },
          data: {
            status: "processing",
            attempts: { increment: 1 },
            claimId,
            claimExpiresAt: new Date(input.now.getTime() + CLAIM_LEASE_MS),
            errorCode: null,
            updatedAt: input.now,
          },
        });
        if (claimed.count !== 1) return null;
        return toRecord(
          await tx.thumbnailExtractionJob.findUniqueOrThrow({
            where: { id: candidate.id },
          }),
        );
      });
    },

    async prepareOutput(input) {
      await withSerializableTransaction(prisma, async (tx) => {
        const owned = await tx.thumbnailExtractionJob.findFirst({
          where: {
            id: input.jobId,
            status: "processing",
            claimId: input.claimId,
            claimExpiresAt: { gt: input.now },
          },
          select: { id: true, projectId: true, claimExpiresAt: true },
        });
        if (
          !owned?.claimExpiresAt ||
          owned.claimExpiresAt.getTime() !== input.claimExpiresAt.getTime()
        ) {
          throw new ThumbnailExtractionError(
            "thumbnail_claim_lost",
            "Thumbnail extraction ownership was lost",
          );
        }
        const identity = {
          ...THUMBNAIL_CLEANUP_IDENTITY,
          objectKey: input.destinationStorageKey,
        };
        const admitted = await admitMediaCleanupObligations(
          tx.mediaCleanupObligation,
          [
            {
              ...identity,
              projectId: owned.projectId,
            },
          ],
          {
            heldClaim: {
              claimId: input.claimId,
              claimExpiresAt: owned.claimExpiresAt,
            },
          },
        );
        if (admitted === 1) return;
        const reacquired = await tx.mediaCleanupObligation.updateMany({
          where: {
            ...identity,
            completedAt: null,
            attemptCount: 0,
            OR: [
              { claimId: input.claimId },
              { claimId: null, claimExpiresAt: null },
              { claimExpiresAt: { lte: input.now } },
            ],
          },
          data: {
            claimId: input.claimId,
            claimExpiresAt: owned.claimExpiresAt,
            nextAttemptAt: owned.claimExpiresAt,
            failureCode: null,
          },
        });
        if (reacquired.count !== 1) {
          throw new ThumbnailExtractionError(
            "thumbnail_output_ownership_lost",
            "Thumbnail output cleanup ownership was lost",
          );
        }
      });
    },

    async complete(input) {
      return withSerializableTransaction(prisma, async (tx) => {
        const job = await tx.thumbnailExtractionJob.findFirst({
          where: {
            id: input.jobId,
            status: "processing",
            claimId: input.claimId,
            claimExpiresAt: { gt: input.now },
          },
          include: {
            workspace: {
              select: { personalOwnerUserId: true },
            },
          },
        });
        if (!job) {
          throw new ThumbnailExtractionError(
            "thumbnail_claim_lost",
            "Thumbnail extraction ownership was lost",
          );
        }
        if (
          input.asset.sourceExportVariantId !== job.exportVariantId ||
          input.asset.sourceTimeMs !== job.sourceTimeMs ||
          input.asset.workspaceId !== job.workspaceId ||
          input.asset.createdByUserId !== job.actorUserId
        ) {
          throw new ThumbnailExtractionError(
            "thumbnail_output_invalid",
            "The extracted thumbnail does not match its claimed source",
          );
        }

        const owner = resolveBrandOwnerForWorkspace({
          workspaceId: job.workspaceId,
          personalOwnerUserId: job.workspace.personalOwnerUserId,
        });
        const asset = await tx.visualAsset.upsert({
          where: {
            sourceExportVariantId_sourceTimeMs: {
              sourceExportVariantId: job.exportVariantId,
              sourceTimeMs: job.sourceTimeMs,
            },
          },
          update: {},
          create: {
            id: input.asset.id,
            userId: owner.userId,
            workspaceId: owner.workspaceId,
            createdByUserId: job.actorUserId,
            title: input.asset.title,
            kind: "image",
            storageKey: input.asset.storageKey,
            contentType: input.asset.contentType,
            sizeBytes: BigInt(input.asset.sizeBytes),
            width: input.asset.width,
            height: input.asset.height,
            durationSec: null,
            fingerprint: input.asset.fingerprint,
            provenance: "extracted",
            sourceExportVariantId: job.exportVariantId,
            sourceTimeMs: job.sourceTimeMs,
            createdAt: input.asset.createdAt,
            updatedAt: input.now,
          },
        });
        if (asset.deletedAt) {
          throw new ThumbnailExtractionError(
            "thumbnail_asset_deleted",
            "The extracted thumbnail asset was deleted",
          );
        }
        const settled = await tx.thumbnailExtractionJob.updateMany({
          where: {
            id: job.id,
            status: "processing",
            claimId: input.claimId,
            claimExpiresAt: { gt: input.now },
          },
          data: {
            status: "completed",
            claimId: null,
            claimExpiresAt: null,
            assetId: asset.id,
            errorCode: null,
            updatedAt: input.now,
          },
        });
        if (settled.count !== 1) {
          throw new ThumbnailExtractionError(
            "thumbnail_claim_lost",
            "Thumbnail extraction ownership was lost",
          );
        }
        if (asset.storageKey === input.asset.storageKey) {
          if (asset.fingerprint !== input.asset.fingerprint) {
            throw new ThumbnailExtractionError(
              "thumbnail_output_invalid",
              "The extracted thumbnail does not match its durable object",
            );
          }
          try {
            await adoptHeldMediaCleanupObligations(
              tx.mediaCleanupObligation,
              [
                {
                  ...THUMBNAIL_CLEANUP_IDENTITY,
                  objectKey: input.asset.storageKey,
                },
              ],
              input.claimId,
              input.now,
              thumbnailAdoptionReceipt(job.id),
            );
          } catch (error) {
            if (error instanceof MediaCleanupAdoptionLost) {
              throw new ThumbnailExtractionError(
                "thumbnail_output_ownership_lost",
                "Thumbnail output cleanup ownership was lost",
              );
            }
            throw error;
          }
        } else {
          const released = await tx.mediaCleanupObligation.updateMany({
            where: {
              ...THUMBNAIL_CLEANUP_IDENTITY,
              objectKey: input.asset.storageKey,
              completedAt: null,
              attemptCount: 0,
              claimId: input.claimId,
              claimExpiresAt: { gt: input.now },
            },
            data: {
              claimId: null,
              claimExpiresAt: null,
              nextAttemptAt: input.now,
            },
          });
          if (released.count !== 1) {
            throw new ThumbnailExtractionError(
              "thumbnail_output_ownership_lost",
              "Thumbnail output cleanup ownership was lost",
            );
          }
        }
        return toRecord(
          await tx.thumbnailExtractionJob.findUniqueOrThrow({ where: { id: job.id } }),
        );
      });
    },

    async fail(input) {
      return withSerializableTransaction(prisma, async (tx) => {
        const failed = await tx.thumbnailExtractionJob.updateMany({
          where: {
            id: input.jobId,
            status: "processing",
            claimId: input.claimId,
            claimExpiresAt: { gt: input.now },
          },
          data: {
            status: "failed",
            claimId: null,
            claimExpiresAt: null,
            errorCode: input.errorCode,
            updatedAt: input.now,
          },
        });
        if (failed.count !== 1) {
          throw new ThumbnailExtractionError(
            "thumbnail_claim_lost",
            "Thumbnail extraction ownership was lost",
          );
        }
        const obligation = await tx.mediaCleanupObligation.findFirst({
          where: {
            ...THUMBNAIL_CLEANUP_IDENTITY,
            objectKey: input.destinationStorageKey,
          },
          select: {
            id: true,
            completedAt: true,
            claimId: true,
          },
        });
        if (obligation && obligation.completedAt === null) {
          const released = await tx.mediaCleanupObligation.updateMany({
            where: {
              id: obligation.id,
              completedAt: null,
              claimId: input.claimId,
            },
            data: {
              claimId: null,
              claimExpiresAt: null,
              nextAttemptAt: input.now,
            },
          });
          if (released.count !== 1) {
            throw new ThumbnailExtractionError(
              "thumbnail_output_ownership_lost",
              "Thumbnail output cleanup ownership was lost",
            );
          }
        }
        return toRecord(
          await tx.thumbnailExtractionJob.findUniqueOrThrow({
            where: { id: input.jobId },
          }),
        );
      });
    },

    async read(input) {
      const job = await prisma.thumbnailExtractionJob.findFirst({
        where: {
          id: input.id,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
        },
        include: { asset: true },
      });
      if (!job) return null;
      return {
        record: toRecord(job),
        asset: job.asset ? toAsset(job.asset, job.workspaceId) : null,
      };
    },

    async listLatest(input) {
      const where = {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        platform: input.platform,
        exportVariantId: { in: input.exportVariantIds },
      };
      const newestByVariant = await prisma.thumbnailExtractionJob.groupBy({
        by: ["exportVariantId"],
        where,
        _max: { createdAt: true },
      });
      const latestCoordinates = newestByVariant.flatMap((entry) =>
        entry._max.createdAt
          ? [{
              exportVariantId: entry.exportVariantId,
              createdAt: entry._max.createdAt,
            }]
          : [],
      );
      if (latestCoordinates.length === 0) return [];
      const jobs = await prisma.thumbnailExtractionJob.findMany({
        where: { ...where, OR: latestCoordinates },
        include: { asset: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      const seen = new Set<string>();
      return jobs.flatMap((job) => {
        if (seen.has(job.exportVariantId)) return [];
        seen.add(job.exportVariantId);
        return [{
          record: toRecord(job),
          asset: job.asset ? toAsset(job.asset, job.workspaceId) : null,
        }];
      });
    },

    async retry(input) {
      const queued = await prisma.thumbnailExtractionJob.updateMany({
        where: {
          id: input.id,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          status: "failed",
          attempts: { lt: MAX_ATTEMPTS },
        },
        data: {
          status: "queued",
          claimId: null,
          claimExpiresAt: null,
          errorCode: null,
          updatedAt: input.now,
        },
      });
      if (queued.count !== 1) return null;
      return toRecord(
        await prisma.thumbnailExtractionJob.findUniqueOrThrow({
          where: { id: input.id },
        }),
      );
    },
  };
}

export function createProductionThumbnailExtractionService(
  processor: ThumbnailFrameProcessor,
) {
  return createThumbnailExtractionService({
    store: createPrismaThumbnailExtractionStore(),
    processor,
    async authorize(scope) {
      assertPublishingPreparationWriteEnabled("thumbnail_extraction");
			const actor = await workspaceService.requireActor(
        scope.actorUserId,
        scope.workspaceId,
        "publishing.manage",
      );
			if (!hasFeature(actor.pricingTier, "publishing.customThumbnails")) {
				throw new ThumbnailExtractionError(
					"thumbnail_extraction_feature_unavailable",
					"Custom thumbnail preparation is unavailable on this plan",
				);
			}
    },
    async authorizeRead(scope) {
      await workspaceService.requireActor(
        scope.actorUserId,
        scope.workspaceId,
        "content.view",
      );
    },
    diagnostics(event) {
      console.warn(
        JSON.stringify({
          level: "info",
          message: "thumbnail_extraction_event",
          ...event,
          ts: new Date().toISOString(),
        }),
      );
      const projectId = typeof event.projectId === "string" ? event.projectId : null;
      if (!projectId || typeof event.event !== "string") return;
      void analyticsService.recordProjectEvent({
        projectId,
        type: "thumbnail_prepared",
        platform:
          typeof event.platform === "string"
            ? (event.platform as SocialPlatform)
            : null,
        metadata: {
          featureVersion: "thumbnail-extraction-v1",
          outcome: event.event.endsWith("completed") ? "succeeded" : "failed",
          kind: "video_frame",
          ...(typeof event.assetId === "string" ? { assetId: event.assetId } : {}),
          ...(typeof event.attempts === "number" ? { retryCount: event.attempts } : {}),
        },
      }).catch(() => {
        console.warn(JSON.stringify({
          level: "warn",
          message: "thumbnail_analytics_record_failed",
          projectId,
        }));
      });
    },
  });
}
