import { randomUUID } from "node:crypto";
import { getPrismaClient } from "@narriflow/db/client";
import {
  brandOwnerWhere,
  resolveBrandOwner,
} from "./brand-ownership";
import {
  createGeneratedMediaPublisher,
  GeneratedMediaPublicationError,
  type GeneratedMediaAssetRepository,
  type GeneratedMediaPublicationStorage,
} from "./generated-media-publisher";
import {
  copyObject,
  deleteObject,
  presignDownloadUrl,
  putObjectBytes,
  readObjectBytes,
} from "./r2-storage";
import { guardedFetch, readResponseBodyBounded } from "./url-guard";

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

const storage: GeneratedMediaPublicationStorage = {
  async download(url, maxBytes) {
    const response = await guardedFetch(url);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("generated_media_remote_download_failed");
    }
    return readResponseBodyBounded(response, maxBytes);
  },
  async readAttempt(key, maxBytes) {
    return readObjectBytes(key, maxBytes);
  },
  async putAttempt(key, bytes, contentType) {
    await putObjectBytes({
      key,
      bytes,
      contentType,
      metadata: { source: "generated-media-attempt" },
    });
  },
  async publishAttempt(attemptKey, finalKey) {
    await copyObject({ sourceKey: attemptKey, destinationKey: finalKey });
  },
  async delete(key) {
    await deleteObject(key);
  },
};

function repositoryForEnvironment(): GeneratedMediaAssetRepository {
  return {
  async findByFingerprint(scope, fingerprint) {
    const asset = await requirePrisma().visualAsset.findFirst({
      where: { ...brandOwnerWhere(scope), fingerprint, deletedAt: null },
    });
    if (!asset) return null;
    return {
      id: asset.id,
      title: asset.title,
      kind: "image",
      contentType: asset.contentType as "image/png" | "image/jpeg" | "image/webp",
      sizeBytes: Number(asset.sizeBytes),
      width: asset.width,
      height: asset.height,
      durationSec: null,
      fingerprint: asset.fingerprint,
      provenance: "generated",
      accessUrl: await presignDownloadUrl({ key: asset.storageKey }).catch(() => null),
      replayed: true,
      createdAt: asset.createdAt.toISOString(),
    };
  },
  async create(input) {
    const owner = resolveBrandOwner(input.scope);
    try {
      const asset = await requirePrisma().$transaction(async (tx) => {
        const orphan = await tx.mediaCleanupObligation.findFirst({
          where: {
            origin: "generated_media_publication",
            cleanupClass: "generated_asset",
            objectKey: input.storageKey,
            completedAt: null,
          },
          select: { id: true },
        });
        if (!orphan) throw new GeneratedMediaPublicationError("generated_media_cleanup_claim_lost");
        {
          const adopted = await tx.mediaCleanupObligation.updateMany({
            where: { id: orphan.id, completedAt: null, claimId: input.cleanupClaimId, claimExpiresAt: { gt: new Date() } },
            data: { completedAt: new Date(), failureCode: null, claimId: null, claimExpiresAt: null },
          });
          if (adopted.count !== 1) {
            throw new GeneratedMediaPublicationError("generated_media_cleanup_in_progress");
          }
        }
        const created = await tx.visualAsset.create({ data: {
          ...owner,
          createdByUserId: input.scope.actorUserId,
          title: input.title,
          kind: "image",
          storageKey: input.storageKey,
          contentType: input.contentType,
          sizeBytes: BigInt(input.sizeBytes),
          width: input.width,
          height: input.height,
          durationSec: null,
          fingerprint: input.fingerprint,
          provenance: "generated",
        } });
        return created;
      });
      return {
        id: asset.id,
        title: asset.title,
        kind: "image" as const,
        contentType: asset.contentType as "image/png" | "image/jpeg" | "image/webp",
        sizeBytes: Number(asset.sizeBytes),
        width: asset.width,
        height: asset.height,
        durationSec: null,
        fingerprint: asset.fingerprint,
        provenance: "generated" as const,
        accessUrl: await presignDownloadUrl({ key: asset.storageKey }).catch(() => null),
        replayed: false,
        createdAt: asset.createdAt.toISOString(),
      };
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      const replay = await this.findByFingerprint(input.scope, input.fingerprint);
      if (replay) {
        await requirePrisma().mediaCleanupObligation.updateMany({
          where: { origin: "generated_media_publication", cleanupClass: "generated_asset", objectKey: input.storageKey, completedAt: null, claimId: input.cleanupClaimId, claimExpiresAt: { gt: new Date() } },
          data: { completedAt: new Date(), failureCode: null, claimId: null, claimExpiresAt: null },
        });
        return { ...replay, replayed: true };
      }
      const prisma = requirePrisma();
      const deleted = await prisma.visualAsset.findFirst({
        where: { ...brandOwnerWhere(input.scope), fingerprint: input.fingerprint, deletedAt: { not: null } },
        select: { id: true },
      });
      if (!deleted) throw error;
      const restored = await prisma.$transaction(async (tx) => {
        const orphan = await tx.mediaCleanupObligation.findFirst({
          where: { origin: "generated_media_publication", cleanupClass: "generated_asset", objectKey: input.storageKey, completedAt: null },
          select: { id: true },
        });
        if (!orphan) throw new GeneratedMediaPublicationError("generated_media_cleanup_claim_lost");
        {
          const adopted = await tx.mediaCleanupObligation.updateMany({
            where: { id: orphan.id, completedAt: null, claimId: input.cleanupClaimId, claimExpiresAt: { gt: new Date() } },
            data: { completedAt: new Date(), failureCode: null, claimId: null, claimExpiresAt: null },
          });
          if (adopted.count !== 1) throw new GeneratedMediaPublicationError("generated_media_cleanup_in_progress");
        }
        return tx.visualAsset.update({
          where: { id: deleted.id },
          data: {
            deletedAt: null,
            createdByUserId: input.scope.actorUserId,
            title: input.title,
            storageKey: input.storageKey,
            contentType: input.contentType,
            sizeBytes: BigInt(input.sizeBytes),
            width: input.width,
            height: input.height,
            provenance: "generated",
          },
        });
      });
      return {
        id: restored.id,
        title: restored.title,
        kind: "image" as const,
        contentType: restored.contentType as "image/png" | "image/jpeg" | "image/webp",
        sizeBytes: Number(restored.sizeBytes),
        width: restored.width,
        height: restored.height,
        durationSec: null,
        fingerprint: restored.fingerprint,
        provenance: "generated" as const,
        accessUrl: await presignDownloadUrl({ key: restored.storageKey }).catch(() => null),
        replayed: true,
        createdAt: restored.createdAt.toISOString(),
      };
    }
  },
  async admitOrphan(storageKey) {
    const prisma = requirePrisma();
    const claimId = randomUUID();
    const now = new Date();
    const claimExpiresAt = new Date(now.getTime() + 10 * 60 * 1000);
    await prisma.mediaCleanupObligation.create({
      data: {
        origin: "generated_media_publication",
        cleanupClass: "generated_asset",
        objectKey: storageKey,
        // Give the durable job ample time to adopt the copied object on retry.
        nextAttemptAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        claimId,
        claimExpiresAt,
      },
    }).catch((error) => {
      if ((error as { code?: string }).code !== "P2002") throw error;
    });
    const acquired = await prisma.mediaCleanupObligation.updateMany({
      where: {
        origin: "generated_media_publication",
        cleanupClass: "generated_asset",
        objectKey: storageKey,
        claimId: { not: claimId },
        OR: [
          { completedAt: { not: null } },
          { claimId: null },
          { claimExpiresAt: { lte: now } },
        ],
      },
      data: {
        completedAt: null,
        nextAttemptAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        failureCode: null,
        claimId,
        claimExpiresAt,
      },
    });
    const held = acquired.count === 1 || Boolean(await prisma.mediaCleanupObligation.findFirst({
      where: { origin: "generated_media_publication", cleanupClass: "generated_asset", objectKey: storageKey, claimId, completedAt: null },
      select: { id: true },
    }));
    if (!held) throw new GeneratedMediaPublicationError("generated_media_cleanup_in_progress");
    return claimId;
  },
  };
}

export function createProductionGeneratedMediaPublisher(environment: NodeJS.ProcessEnv = process.env) {
  const parsedMaxBytes = Number(environment.GENERATED_IMAGE_MAX_OUTPUT_BYTES);
  const maxBytes = Number.isSafeInteger(parsedMaxBytes) && parsedMaxBytes >= 1_000_000 && parsedMaxBytes <= 100_000_000
    ? parsedMaxBytes
    : 20 * 1024 * 1024;
  return createGeneratedMediaPublisher({
  storage,
  repository: repositoryForEnvironment(),
  maxBytes,
  async inspect(bytes) {
    const { default: sharp } = await import("sharp");
    const metadata = await sharp(bytes, {
      failOn: "warning",
      limitInputPixels: 40_000_000,
    }).metadata();
    const contentType = metadata.format === "png"
      ? "image/png"
      : metadata.format === "jpeg"
        ? "image/jpeg"
        : metadata.format === "webp"
          ? "image/webp"
          : null;
    if (!contentType || !metadata.width || !metadata.height) {
      throw new Error("generated_media_output_invalid");
    }
    return { contentType, width: metadata.width, height: metadata.height };
  },
  });
}
