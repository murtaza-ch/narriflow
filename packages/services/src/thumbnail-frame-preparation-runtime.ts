import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  createThumbnailFramePreparation,
  ThumbnailPreparationError,
  type ThumbnailFrameRecord,
  type ThumbnailFrameStore,
} from "./thumbnail-frame-preparation";
import { brandOwnerStoragePrefix, brandOwnerWhere } from "./brand-ownership";
import { hasFeature } from "./plan-features";
import {
  headObject,
  presignDownloadUrl,
  putObjectBytes,
} from "./r2-storage";
import { workspaceService } from "./workspace.service";

const operationInclude = {
  resultAsset: true,
} satisfies Prisma.ThumbnailFrameOperationInclude;

type OperationRow = Prisma.ThumbnailFrameOperationGetPayload<{
  include: typeof operationInclude;
}>;

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

function toRecord(row: OperationRow): ThumbnailFrameRecord {
  return {
    id: row.id,
    actorUserId: row.createdByUserId,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    clipId: row.clipId,
    exportVariantId: row.exportVariantId,
    sourceTimeMs: row.sourceTimeMs,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    exportFingerprint: row.exportFingerprint,
    status: row.status,
    attempt: row.attempt,
    claimId: row.claimId,
    claimExpiresAt: row.claimExpiresAt,
    errorCode: row.errorCode,
    asset: row.resultAsset
      ? {
          id: row.resultAsset.id,
          fingerprint: row.resultAsset.fingerprint,
          deleted: row.resultAsset.deletedAt !== null,
        }
      : null,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

async function readByIdempotency(workspaceId: string, idempotencyKey: string) {
  return requirePrisma().thumbnailFrameOperation.findUnique({
    where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
    include: operationInclude,
  });
}

export const prismaThumbnailFrameStore: ThumbnailFrameStore = {
  async open(input) {
    const existing = await readByIdempotency(input.workspaceId, input.idempotencyKey);
    if (existing) return { record: toRecord(existing), replayed: true };
    const sameFrame = await requirePrisma().thumbnailFrameOperation.findUnique({
      where: {
        exportVariantId_sourceTimeMs: {
          exportVariantId: input.exportVariantId,
          sourceTimeMs: input.sourceTimeMs,
        },
      },
      include: operationInclude,
    });
    if (sameFrame) return { record: toRecord(sameFrame), replayed: true };
    const candidate = input.create();
    try {
      const created = await requirePrisma().thumbnailFrameOperation.create({
        data: {
          id: candidate.id,
          workspaceId: candidate.workspaceId,
          projectId: candidate.projectId,
          clipId: candidate.clipId,
          exportVariantId: candidate.exportVariantId,
          createdByUserId: candidate.actorUserId,
          idempotencyKey: candidate.idempotencyKey,
          requestFingerprint: candidate.requestFingerprint,
          exportFingerprint: candidate.exportFingerprint,
          sourceTimeMs: candidate.sourceTimeMs,
          status: candidate.status,
        },
        include: operationInclude,
      });
      return { record: toRecord(created), replayed: false };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
      const raced = await readByIdempotency(input.workspaceId, input.idempotencyKey) ??
        await requirePrisma().thumbnailFrameOperation.findUnique({
          where: {
            exportVariantId_sourceTimeMs: {
              exportVariantId: input.exportVariantId,
              sourceTimeMs: input.sourceTimeMs,
            },
          },
          include: operationInclude,
        });
      if (!raced) throw error;
      return { record: toRecord(raced), replayed: true };
    }
  },

  async get(id) {
    const row = await requirePrisma().thumbnailFrameOperation.findUnique({
      where: { id },
      include: operationInclude,
    });
    return row ? toRecord(row) : null;
  },

  async claim(id, claimId, now, leaseMs) {
    const claimed = await requirePrisma().thumbnailFrameOperation.updateMany({
      where: {
        id,
        OR: [
          { status: { in: ["queued", "failed"] } },
          { status: "processing", claimExpiresAt: { lte: now } },
        ],
      },
      data: {
        status: "processing",
        attempt: { increment: 1 },
        errorCode: null,
        claimId,
        claimExpiresAt: new Date(now.getTime() + leaseMs),
      },
    });
    if (claimed.count !== 1) return null;
    const row = await requirePrisma().thumbnailFrameOperation.findUniqueOrThrow({
      where: { id },
      include: operationInclude,
    });
    return toRecord(row);
  },

  async settle(id, claimId, patch) {
    const row = await requirePrisma().$transaction(async (tx) => {
			const updatedCount = await tx.thumbnailFrameOperation.updateMany({
				where: { id, status: "processing", claimId },
        data: {
          status: patch.status,
          attempt: patch.attempt,
          claimId: patch.claimId,
          claimExpiresAt: patch.claimExpiresAt,
          resultAssetId: patch.asset?.id,
          errorCode: patch.errorCode,
          completedAt: patch.completedAt,
        },
      });
			if (updatedCount.count !== 1) {
				throw new ThumbnailPreparationError("thumbnail_claim_lost");
			}
			const updated = await tx.thumbnailFrameOperation.findUniqueOrThrow({
				where: { id },
				include: operationInclude,
			});
      if (patch.status === "completed" || patch.status === "failed") {
        await tx.projectAnalyticsEvent.create({
          data: {
            projectId: updated.projectId,
            clipId: updated.clipId,
            type: patch.status === "completed" ? "thumbnail_prepared" : "thumbnail_failed",
            metadata: {
              operationId: updated.id,
              sourceKind: "extracted_frame",
              sourceTimeMs: updated.sourceTimeMs,
              outcome: patch.status,
              errorCode: updated.errorCode,
            },
          },
        });
      }
      return updated;
    });
    return toRecord(row);
  },

	async requeue(id) {
		const queued = await requirePrisma().thumbnailFrameOperation.updateMany({
			where: { id, status: "failed" },
			data: {
				status: "queued",
				errorCode: null,
				claimId: null,
				claimExpiresAt: null,
				completedAt: null,
			},
		});
		if (queued.count !== 1) {
			const current = await requirePrisma().thumbnailFrameOperation.findUnique({
				where: { id },
				include: operationInclude,
			});
			if (!current) throw new ThumbnailPreparationError("thumbnail_operation_not_found");
			return toRecord(current);
		}
		const row = await requirePrisma().thumbnailFrameOperation.findUniqueOrThrow({
			where: { id },
			include: operationInclude,
		});
		return toRecord(row);
	},
};

function ffmpegFrame(inputUrl: string, sourceTimeMs: number) {
  return new Promise<Uint8Array>((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        (sourceTimeMs / 1_000).toFixed(3),
        "-i",
        inputUrl,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ],
      { encoding: "buffer", timeout: 60_000, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout) => {
        if (error || !(stdout instanceof Buffer) || stdout.byteLength === 0) {
          reject(error ?? new Error("thumbnail extraction returned no image"));
          return;
        }
        resolve(new Uint8Array(stdout));
      },
    );
  });
}

async function publishFrame(input: {
  record: ThumbnailFrameRecord;
  bytes: Uint8Array;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  fingerprint: string;
}) {
  const prisma = requirePrisma();
	const actor = await workspaceService.requireActor(
		input.record.actorUserId,
		input.record.workspaceId,
		"publishing.manage",
	);
	const scope = {
		actorUserId: input.record.actorUserId,
		workspaceId: actor.workspaceId,
		workspaceOwnerUserId: actor.workspaceOwnerUserId,
		role: actor.role,
		status: actor.status,
		pricingTier: actor.pricingTier,
		isPersonalWorkspace: actor.isPersonalWorkspace,
	};
  const existing = await prisma.visualAsset.findFirst({
    where: {
			...brandOwnerWhere(scope),
      fingerprint: input.fingerprint,
      deletedAt: null,
    },
  });
  if (existing) {
    return { id: existing.id, fingerprint: existing.fingerprint, deleted: false };
  }
	const storageKey = `${brandOwnerStoragePrefix(scope, "visual-assets")}extracted/${input.fingerprint}.jpg`;
  const claimId = randomUUID();
  const now = new Date();
  const claimExpiresAt = new Date(now.getTime() + 10 * 60_000);
  await prisma.mediaCleanupObligation.create({
    data: {
      origin: "thumbnail_frame_preparation",
      cleanupClass: "thumbnail_asset",
      projectId: input.record.projectId,
      clipId: input.record.clipId,
      objectKey: storageKey,
      nextAttemptAt: new Date(now.getTime() + 24 * 60 * 60_000),
      claimId,
      claimExpiresAt,
    },
  }).catch((error) => {
    if ((error as { code?: string }).code !== "P2002") throw error;
  });
  const held = await prisma.mediaCleanupObligation.findFirst({
    where: {
      origin: "thumbnail_frame_preparation",
      cleanupClass: "thumbnail_asset",
      objectKey: storageKey,
      completedAt: null,
      claimId,
      claimExpiresAt: { gt: now },
    },
    select: { id: true },
  });
  if (!held) throw new ThumbnailPreparationError("thumbnail_asset_publication_in_progress");
  await putObjectBytes({
    key: storageKey,
    bytes: input.bytes,
    contentType: input.contentType,
    metadata: { source: "thumbnail-frame" },
  });
  const asset = await prisma.$transaction(async (tx) => {
    const adopted = await tx.mediaCleanupObligation.updateMany({
      where: { id: held.id, claimId, claimExpiresAt: { gt: new Date() }, completedAt: null },
      data: { completedAt: new Date(), claimId: null, claimExpiresAt: null, failureCode: null },
    });
    if (adopted.count !== 1) {
      throw new ThumbnailPreparationError("thumbnail_asset_publication_claim_lost");
    }
    return tx.visualAsset.create({
      data: {
				...brandOwnerWhere(scope),
				createdByUserId: input.record.actorUserId,
        title: `Frame at ${(input.record.sourceTimeMs / 1_000).toFixed(1)}s`,
        kind: "image",
        storageKey,
        contentType: input.contentType,
        sizeBytes: BigInt(input.bytes.byteLength),
        width: input.width,
        height: input.height,
        fingerprint: input.fingerprint,
        provenance: "extracted_frame",
      },
    });
  });
  return { id: asset.id, fingerprint: asset.fingerprint, deleted: false };
}

function productionModule() {
  return createThumbnailFramePreparation({
    store: prismaThumbnailFrameStore,
    authorize: async ({ actorUserId, workspaceId, permission }) => {
      const actor = await workspaceService.requireActor(actorUserId, workspaceId, permission);
      if (!hasFeature(actor.pricingTier, "publishing.customThumbnails")) {
        throw new ThumbnailPreparationError(
          "thumbnail_entitlement_required",
          "Custom thumbnails require a Pro or Business plan",
        );
      }
    },
    async resolveSource({ workspaceId, projectId, clipId, exportVariantId }) {
      const variant = await requirePrisma().clipExportVariant.findFirst({
        where: {
          id: exportVariantId,
          status: "completed",
          storageKey: { not: null },
          durationSec: { gt: 0 },
          export: {
            projectId,
            clipId,
            project: { workspaceId },
          },
        },
        include: { export: { select: { fingerprint: true } } },
      });
      if (!variant?.storageKey || !variant.durationSec) return null;
      const object = await headObject(variant.storageKey).catch(() => null);
      if (!object || !object.sizeBytes || object.sizeBytes <= 0) return null;
      return {
        storageKey: variant.storageKey,
        durationMs: Math.round(variant.durationSec * 1_000),
        exportFingerprint: variant.export.fingerprint,
        width: 0,
        height: 0,
      };
    },
    async extract({ storageKey, sourceTimeMs }) {
      const { default: sharp } = await import("sharp");
      const url = await presignDownloadUrl({ key: storageKey, expiresIn: 300 });
      const bytes = await ffmpegFrame(url, sourceTimeMs);
      const metadata = await sharp(bytes, {
        failOn: "warning",
        limitInputPixels: 40_000_000,
      }).metadata();
      if (metadata.format !== "jpeg" || !metadata.width || !metadata.height) {
        throw new ThumbnailPreparationError("thumbnail_extraction_invalid");
      }
      return {
        bytes,
        contentType: "image/jpeg" as const,
        width: metadata.width,
        height: metadata.height,
      };
    },
    publish: publishFrame,
    createId: randomUUID,
    now: () => new Date(),
  });
}

export class ThumbnailFramePreparationService {
  request(input: Parameters<ReturnType<typeof productionModule>["request"]>[0]) {
    return productionModule().request(input);
  }

  get(workspaceId: string, projectId: string, id: string) {
    return productionModule().get(workspaceId, projectId, id);
  }

	async retry(workspaceId: string, projectId: string, id: string) {
		await productionModule().get(workspaceId, projectId, id);
		await prismaThumbnailFrameStore.requeue(id);
		return productionModule().get(workspaceId, projectId, id);
  }

  async processPending(limit = 4) {
    const now = new Date();
    const rows = await requirePrisma().thumbnailFrameOperation.findMany({
      where: {
        OR: [
          { status: "queued" },
          { status: "processing", claimExpiresAt: { lte: now } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: Math.max(1, Math.min(limit, 10)),
      select: { id: true },
    });
    const outcomes = await Promise.allSettled(
      rows.map((row) => productionModule().process(row.id)),
    );
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === "rejected") {
        console.warn(JSON.stringify({
          level: "warn",
          message: "thumbnail_frame_preparation_failed",
          operationId: rows[index]!.id,
          errorCode: (outcome.reason as { code?: string }).code ?? "thumbnail_extraction_failed",
        }));
      }
    }
    return outcomes.length;
  }
}

export const thumbnailFramePreparationService = new ThumbnailFramePreparationService();
