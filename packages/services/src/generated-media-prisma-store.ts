import type {
  GeneratedMediaJob as PrismaGeneratedMediaJob,
  VisualAsset,
} from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import type {
  GeneratedMediaAsset,
  GeneratedMediaJobRecord,
  GeneratedMediaStore,
} from "./generated-media";
import { presignDownloadUrl } from "./r2-storage";
import { withSerializableTransaction } from "./serializable-transaction";
import { GeneratedMediaJobError } from "./generated-media";

type Row = PrismaGeneratedMediaJob & { resultAsset: VisualAsset | null };

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

async function assetRow(asset: VisualAsset | null): Promise<GeneratedMediaAsset | null> {
  if (!asset || asset.deletedAt) return null;
  return {
    id: asset.id,
    title: asset.title,
    kind: "image",
    contentType: asset.contentType as GeneratedMediaAsset["contentType"],
    sizeBytes: Number(asset.sizeBytes),
    width: asset.width,
    height: asset.height,
    durationSec: null,
    fingerprint: asset.fingerprint,
    provenance: "generated",
    accessUrl: await presignDownloadUrl({ key: asset.storageKey }).catch(() => null),
    replayed: false,
    createdAt: asset.createdAt.toISOString(),
  };
}

async function record(row: Row): Promise<GeneratedMediaJobRecord> {
  return {
    id: row.id,
    scope: {
      actorUserId: row.createdByUserId,
      workspaceId: row.workspaceId,
      workspaceOwnerUserId: row.workspaceOwnerUserId,
      role: row.actorRole as GeneratedMediaJobRecord["scope"]["role"],
      status: row.actorStatus as GeneratedMediaJobRecord["scope"]["status"],
      pricingTier: row.pricingTier,
      isPersonalWorkspace: row.isPersonalWorkspace,
    },
    projectId: row.projectId,
    clipId: row.clipId,
    mediaKind: "image",
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    protectedPrompt: row.protectedPrompt,
    promptFingerprint: row.promptFingerprint,
    promptOrigin: row.promptOrigin,
    sourceStartSec: row.sourceStartSec,
    sourceEndSec: row.sourceEndSec,
    sourceCueAtSec: row.sourceCueAtSec,
    aspectRatio: row.aspectRatio as GeneratedMediaJobRecord["aspectRatio"],
    style: row.style as GeneratedMediaJobRecord["style"],
    title: row.title,
    status: row.status,
    moderationStatus: row.moderationStatus as GeneratedMediaJobRecord["moderationStatus"],
    usageStatus: row.usageStatus,
    usageReservationId: row.usageReservationId,
    provider: row.provider,
    providerModel: row.providerModel,
    providerRef: row.providerRef,
    providerUsageImages: row.providerUsageImages,
    providerResultContentType: row.providerResultContentType as GeneratedMediaJobRecord["providerResultContentType"],
    resultAsset: await assetRow(row.resultAsset),
    attempt: row.attempt,
    retryAt: row.retryAt,
    claimId: row.claimId,
    claimExpiresAt: row.claimExpiresAt,
    errorCode: row.errorCode,
    outcomeUnknown: row.outcomeUnknown,
    insertedAt: row.insertedAt,
    brandSavedAt: row.brandSavedAt,
    promptExpiresAt: row.promptExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const include = { resultAsset: true } as const;

export const prismaGeneratedMediaStore: GeneratedMediaStore = {
  async findByIdempotency(workspaceId, idempotencyKey) {
    const row = await requirePrisma().generatedMediaJob.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
      include,
    });
    return row ? record(row) : null;
  },

  async create(input) {
    try {
      const prisma = requirePrisma();
      const row = await withSerializableTransaction(prisma, async (tx) => {
        const reservation = await tx.generatedMediaUsageReservation.findUnique({
          where: { id: input.usageReservationId },
          select: { jobId: true, status: true },
        });
        if (reservation?.jobId !== input.id || reservation.status !== "reserved") {
          throw new GeneratedMediaJobError("generated_media_usage_reconciliation_required");
        }
        return tx.generatedMediaJob.create({
        data: {
        id: input.id,
        workspaceId: input.scope.workspaceId,
        projectId: input.projectId,
        clipId: input.clipId,
        createdByUserId: input.scope.actorUserId,
        workspaceOwnerUserId: input.scope.workspaceOwnerUserId,
        actorRole: input.scope.role,
        actorStatus: input.scope.status,
        pricingTier: input.scope.pricingTier,
        isPersonalWorkspace: input.scope.isPersonalWorkspace,
        mediaKind: input.mediaKind,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        protectedPrompt: input.protectedPrompt,
        promptFingerprint: input.promptFingerprint,
        promptOrigin: input.promptOrigin,
        sourceStartSec: input.sourceStartSec,
        sourceEndSec: input.sourceEndSec,
        sourceCueAtSec: input.sourceCueAtSec,
        aspectRatio: input.aspectRatio,
        style: input.style,
        title: input.title,
        status: input.status,
        moderationStatus: input.moderationStatus,
        usageStatus: input.usageStatus,
        usageReservationId: input.usageReservationId,
        provider: input.provider,
        providerModel: input.providerModel,
        providerRef: input.providerRef,
        providerUsageImages: input.providerUsageImages,
        providerResultContentType: input.providerResultContentType,
        resultAssetId: input.resultAsset?.id ?? null,
        attempt: input.attempt,
        retryAt: input.retryAt,
        claimId: input.claimId,
        claimExpiresAt: input.claimExpiresAt,
        errorCode: input.errorCode,
        outcomeUnknown: input.outcomeUnknown,
        insertedAt: input.insertedAt,
        brandSavedAt: input.brandSavedAt,
        promptExpiresAt: input.promptExpiresAt,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        },
        include,
        });
      });
      return record(row);
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      const replay = await requirePrisma().generatedMediaJob.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: input.scope.workspaceId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        include,
      });
      if (!replay) throw error;
      return record(replay);
    }
  },

  async get(id) {
    const row = await requirePrisma().generatedMediaJob.findUnique({ where: { id }, include });
    return row ? record(row) : null;
  },

  async list(workspaceId, projectId, clipId) {
    const rows = await requirePrisma().generatedMediaJob.findMany({
      where: { workspaceId, projectId, ...(clipId ? { clipId } : {}) },
      include,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    return Promise.all(rows.map(record));
  },

  async update(id, patch) {
    const row = await requirePrisma().generatedMediaJob.update({
      where: { id },
      data: {
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.moderationStatus ? { moderationStatus: patch.moderationStatus } : {}),
        ...(patch.usageStatus ? { usageStatus: patch.usageStatus } : {}),
        ...(patch.providerRef !== undefined ? { providerRef: patch.providerRef } : {}),
        ...(patch.providerUsageImages !== undefined ? { providerUsageImages: patch.providerUsageImages } : {}),
        ...(patch.providerResultContentType !== undefined ? { providerResultContentType: patch.providerResultContentType } : {}),
        ...(patch.resultAsset !== undefined ? { resultAssetId: patch.resultAsset?.id ?? null } : {}),
        ...(patch.attempt !== undefined ? { attempt: patch.attempt } : {}),
        ...(patch.retryAt !== undefined ? { retryAt: patch.retryAt } : {}),
        ...(patch.claimId !== undefined ? { claimId: patch.claimId } : {}),
        ...(patch.claimExpiresAt !== undefined ? { claimExpiresAt: patch.claimExpiresAt } : {}),
        ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
        ...(patch.outcomeUnknown !== undefined ? { outcomeUnknown: patch.outcomeUnknown } : {}),
        ...(patch.insertedAt !== undefined ? { insertedAt: patch.insertedAt } : {}),
        ...(patch.brandSavedAt !== undefined ? { brandSavedAt: patch.brandSavedAt } : {}),
        ...(patch.protectedPrompt !== undefined ? { protectedPrompt: patch.protectedPrompt } : {}),
        ...(patch.promptExpiresAt !== undefined ? { promptExpiresAt: patch.promptExpiresAt } : {}),
        ...(patch.updatedAt ? { updatedAt: patch.updatedAt } : {}),
      },
      include,
    });
    return record(row);
  },

  async updateClaimed(id, claimId, patch) {
    const prisma = requirePrisma();
    const result = await prisma.generatedMediaJob.updateMany({
      where: { id, claimId },
      data: {
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.moderationStatus ? { moderationStatus: patch.moderationStatus } : {}),
        ...(patch.usageStatus ? { usageStatus: patch.usageStatus } : {}),
        ...(patch.providerRef !== undefined ? { providerRef: patch.providerRef } : {}),
        ...(patch.providerUsageImages !== undefined ? { providerUsageImages: patch.providerUsageImages } : {}),
        ...(patch.providerResultContentType !== undefined ? { providerResultContentType: patch.providerResultContentType } : {}),
        ...(patch.resultAsset !== undefined ? { resultAssetId: patch.resultAsset?.id ?? null } : {}),
        ...(patch.attempt !== undefined ? { attempt: patch.attempt } : {}),
        ...(patch.retryAt !== undefined ? { retryAt: patch.retryAt } : {}),
        ...(patch.claimId !== undefined ? { claimId: patch.claimId } : {}),
        ...(patch.claimExpiresAt !== undefined ? { claimExpiresAt: patch.claimExpiresAt } : {}),
        ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
        ...(patch.outcomeUnknown !== undefined ? { outcomeUnknown: patch.outcomeUnknown } : {}),
        ...(patch.protectedPrompt !== undefined ? { protectedPrompt: patch.protectedPrompt } : {}),
        ...(patch.promptExpiresAt !== undefined ? { promptExpiresAt: patch.promptExpiresAt } : {}),
        ...(patch.updatedAt ? { updatedAt: patch.updatedAt } : {}),
      },
    });
    if (result.count !== 1) throw new GeneratedMediaJobError("generated_media_claim_lost");
    const row = await prisma.generatedMediaJob.findUnique({ where: { id }, include });
    if (!row) throw new GeneratedMediaJobError("generated_media_claim_lost");
    return record(row);
  },

  async renew(id, claimId, now, leaseMs) {
    const result = await requirePrisma().generatedMediaJob.updateMany({
      where: { id, claimId, claimExpiresAt: { gt: now } },
      data: { claimExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now },
    });
    return result.count === 1;
  },

  async claim(id, claimId, now, leaseMs) {
    const result = await requirePrisma().generatedMediaJob.updateMany({
      where: {
        id,
        status: { in: ["queued", "running", "waiting"] },
        OR: [{ retryAt: null }, { retryAt: { lte: now } }],
        AND: [{ OR: [{ claimId: null }, { claimExpiresAt: { lte: now } }] }],
      },
      data: {
        claimId,
        claimExpiresAt: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      },
    });
    if (result.count !== 1) return null;
    const claimed = await requirePrisma().generatedMediaJob.findUnique({ where: { id }, include });
    return claimed ? record(claimed) : null;
  },

  async due(now, limit) {
    const rows = await requirePrisma().generatedMediaJob.findMany({
      where: {
        status: { in: ["queued", "running", "waiting"] },
        OR: [{ retryAt: null }, { retryAt: { lte: now } }],
        AND: [
          { OR: [{ claimId: null }, { claimExpiresAt: { lte: now } }] },
          { outcomeUnknown: false },
        ],
      },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
    });
    return rows.map((row) => row.id);
  },
};

export async function purgeExpiredGeneratedMediaPrompts(now = new Date()) {
  return requirePrisma().generatedMediaJob.updateMany({
    where: {
      status: { in: ["completed", "failed", "rejected", "cancelled"] },
      promptExpiresAt: { lte: now },
      protectedPrompt: { not: "" },
    },
    data: { protectedPrompt: "" },
  });
}
