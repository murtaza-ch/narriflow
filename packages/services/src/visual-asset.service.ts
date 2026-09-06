import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { Prisma, VisualAsset, VisualAssetKind } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  reusableAssetSoftDeleteSchema,
  resolvePricingTier,
  sceneBlockSchema,
  studioEditsSchema,
  visualAssetFinalizeSchema,
  visualAssetUploadSchema,
  workspaceAllowsCapability,
  type SceneBlock,
  type StudioVisualBrollPlacement,
  type ReusableAssetSoftDeleteInput,
  type VisualAssetFinalizeInput,
  type VisualAssetUploadInput,
} from "@narriflow/validators";
import {
  assertBrandMutationAllowedWithAnalytics,
  BrandAccessError,
  brandOwnerStoragePrefix,
  brandOwnerWhere,
  resolveBrandOwner,
  type BrandActorScope,
} from "./brand-ownership";
import {
  hashObjectSha256,
  headObject,
  isR2Configured,
  presignDownloadUrl,
  presignSingleUploadUrl,
} from "./r2-storage";
import { analyticsService } from "./analytics.service";
import { withSerializableTransaction } from "./serializable-transaction";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

const execFileAsync = promisify(execFile);

export interface VisualMediaProbe {
  kind: "image" | "video";
  contentType:
    | "image/png"
    | "image/jpeg"
    | "image/webp"
    | "video/mp4"
    | "video/quicktime";
  width: number;
  height: number;
  durationSec: number | null;
}

export interface VisualAssetStorage {
  presign(input: { key: string; contentType: string }): Promise<string>;
  head(key: string): Promise<{ contentType: string | null; sizeBytes: number | null } | null>;
  probe(key: string, contentType: string): Promise<VisualMediaProbe | null>;
  fingerprint(key: string): Promise<string>;
  accessUrl(key: string): Promise<string>;
}

const visualAssetIntegrityFailureCatalog = {
  scene_visual_asset_invalid: "unprocessable",
  scene_visual_asset_range_invalid: "unprocessable",
  visual_asset_fingerprint_mismatch: "unprocessable",
  visual_asset_key_forbidden: "forbidden",
  visual_asset_kind_mismatch: "unprocessable",
  visual_asset_mime_mismatch: "unprocessable",
  visual_asset_not_found: "missing",
  visual_asset_not_generated: "unprocessable",
  visual_asset_object_missing: "missing",
  visual_asset_probe_failed: "unavailable",
  visual_asset_replacement_invalid: "unprocessable",
  visual_asset_size_mismatch: "unprocessable",
  visual_broll_asset_invalid: "unprocessable",
} as const satisfies ExpectedDomainFailureCatalog<string>;

type VisualAssetIntegrityFailureCode = keyof typeof visualAssetIntegrityFailureCatalog;

export class VisualAssetIntegrityError extends ExpectedDomainFailureError<VisualAssetIntegrityFailureCode> {
  constructor(code: VisualAssetIntegrityFailureCode) {
    super({ code, kind: visualAssetIntegrityFailureCatalog[code], message: "The selected visual asset could not be verified" });
    this.name = "VisualAssetIntegrityError";
  }
}

export class VisualAssetReferenceError extends ExpectedDomainFailureError<"visual_asset_in_use"> {
  constructor() {
    super({ code: "visual_asset_in_use", kind: "conflict", message: "Remove this asset from every Clip, Brand Profile, and Scene template before deleting it" });
    this.name = "VisualAssetReferenceError";
  }
}

type SceneVisualAssetRecord = {
	id: string;
	kind: "image" | "video";
	fingerprint: string;
	durationSec: number | null;
};

export function assertSceneVisualAssetReferences(
	scenes: readonly SceneBlock[],
	assets: readonly SceneVisualAssetRecord[],
): void {
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	for (const scene of scenes) {
		if (scene.content.kind !== "image" && scene.content.kind !== "video") continue;
		const asset = byId.get(scene.content.asset.id);
		if (
			!asset ||
			asset.kind !== scene.content.kind ||
			asset.fingerprint !== scene.content.asset.fingerprint
		) {
			throw new VisualAssetIntegrityError("scene_visual_asset_invalid");
		}
		if (
			scene.content.kind === "video" &&
			(asset.durationSec === null || scene.content.sourceEndSec > asset.durationSec + 0.001)
		) {
			throw new VisualAssetIntegrityError("scene_visual_asset_range_invalid");
		}
	}
}

export function assertVisualBrollAssetReferences(
  placements: readonly StudioVisualBrollPlacement[],
  assets: readonly SceneVisualAssetRecord[],
): void {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  for (const placement of placements) {
    const asset = byId.get(placement.asset.id);
    if (
      !asset ||
      asset.kind !== "image" ||
      asset.fingerprint !== placement.asset.fingerprint
    ) {
      throw new VisualAssetIntegrityError("visual_broll_asset_invalid");
    }
  }
}

export function visualAssetIsReferencedByClipStorage(
  assetId: string,
  stored: { studioEdits: unknown; sceneBlocks: unknown },
): boolean {
  const studioEdits = studioEditsSchema.safeParse(stored.studioEdits ?? {});
  if (
    studioEdits.success &&
    studioEdits.data.visualBroll.some((placement) => placement.asset.id === assetId)
  ) {
    return true;
  }
  if (!Array.isArray(stored.sceneBlocks)) return false;
  return stored.sceneBlocks.some((value) => {
    const scene = sceneBlockSchema.safeParse(value);
    return scene.success &&
      (scene.data.content.kind === "image" || scene.data.content.kind === "video") &&
      scene.data.content.asset.id === assetId;
  });
}

export function visualAssetKindForContentType(contentType: string): "image" | "video" {
  return contentType.startsWith("image/") ? "image" : "video";
}

export function assertFinalizedVisualObject(
  declared: { contentType: string; sizeBytes: number },
  object: { contentType: string | null; sizeBytes: number | null } | null,
  probe: VisualMediaProbe | null,
): asserts probe is VisualMediaProbe {
  if (!object) throw new VisualAssetIntegrityError("visual_asset_object_missing");
  if (object.contentType !== declared.contentType) throw new VisualAssetIntegrityError("visual_asset_mime_mismatch");
  if (object.sizeBytes !== declared.sizeBytes) throw new VisualAssetIntegrityError("visual_asset_size_mismatch");
  if (!probe || probe.width <= 0 || probe.height <= 0) throw new VisualAssetIntegrityError("visual_asset_probe_failed");
  if (probe.contentType !== declared.contentType) throw new VisualAssetIntegrityError("visual_asset_mime_mismatch");
  if (probe.kind !== visualAssetKindForContentType(declared.contentType)) throw new VisualAssetIntegrityError("visual_asset_kind_mismatch");
}

function extensionForVisual(contentType: string) {
  return ({
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
  } as Record<string, string>)[contentType] ?? "bin";
}

async function productionProbe(key: string): Promise<VisualMediaProbe | null> {
  try {
    const url = await presignDownloadUrl({ key, expiresIn: 300 });
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,duration:format=format_name:format_tags=major_brand", "-of", "json", url,
    ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{
        codec_name?: string;
        width?: number;
        height?: number;
        duration?: string;
      }>;
      format?: { format_name?: string; tags?: { major_brand?: string } };
    };
    const stream = parsed.streams?.[0];
    if (!stream?.width || !stream.height) return null;
    const contentType = stream.codec_name === "png"
      ? "image/png"
      : stream.codec_name === "mjpeg"
        ? "image/jpeg"
        : stream.codec_name === "webp"
          ? "image/webp"
          : parsed.format?.format_name?.split(",").some((name) => name === "mov" || name === "mp4")
            ? parsed.format.tags?.major_brand?.trim().toLowerCase() === "qt"
              ? "video/quicktime"
              : "video/mp4"
            : null;
    if (!contentType) return null;
    const duration = Number(stream.duration);
    return {
      kind: visualAssetKindForContentType(contentType),
      contentType,
      width: stream.width,
      height: stream.height,
      durationSec: Number.isFinite(duration) && duration >= 0 ? duration : null,
    };
  } catch {
    return null;
  }
}

const productionStorage: VisualAssetStorage = {
  async presign({ key, contentType }) {
    return presignSingleUploadUrl({ key, contentType });
  },
  async head(key) {
    try {
      return await headObject(key);
    } catch {
      return null;
    }
  },
  probe: productionProbe,
  fingerprint: hashObjectSha256,
  async accessUrl(key) {
    return presignDownloadUrl({ key });
  },
};

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

function toRow(asset: VisualAsset, accessUrl: string | null, replayed = false) {
  return {
    id: asset.id,
    title: asset.title,
    kind: asset.kind as "image" | "video",
    contentType: asset.contentType,
    sizeBytes: Number(asset.sizeBytes),
    width: asset.width,
    height: asset.height,
    durationSec: asset.durationSec,
    fingerprint: asset.fingerprint,
    provenance: asset.provenance as "uploaded" | "generated" | "extracted_frame",
    accessUrl,
    replayed,
    createdAt: asset.createdAt.toISOString(),
  };
}

export class VisualAssetService {
  private requirePrisma = requirePrisma;
  constructor(private readonly storage: VisualAssetStorage = productionStorage) {}

  async presignUpload(scope: BrandActorScope, input: VisualAssetUploadInput) {
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.profiles", "profile");
    const parsed = visualAssetUploadSchema.parse(input);
    if (!isR2Configured()) throw new Error("R2 configuration is missing");
    const key = `${brandOwnerStoragePrefix(scope, "visual-assets")}${randomUUID()}.${extensionForVisual(parsed.contentType)}`;
    return { key, contentType: parsed.contentType, uploadUrl: await this.storage.presign({ key, contentType: parsed.contentType }) };
  }

  async finalizeUpload(scope: BrandActorScope, input: VisualAssetFinalizeInput) {
    try {
      const result = await this.finalizeVerifiedUpload(scope, input);
      await analyticsService.recordBrandProgramEventBestEffort({
          type: "visual_asset_upload_succeeded",
          workspaceId: scope.workspaceId,
          actorUserId: scope.actorUserId,
          metadata: {
            assetId: result.id,
            assetKind: result.kind,
            planTier: resolvePricingTier(scope.pricingTier),
            outcome: "succeeded",
          },
        });
      return result;
    } catch (error) {
      await analyticsService.recordBrandProgramEventBestEffort({
          type: "visual_asset_upload_failed",
          workspaceId: scope.workspaceId,
          actorUserId: scope.actorUserId,
          metadata: {
            assetKind: visualAssetKindForContentType(input.contentType),
            planTier: resolvePricingTier(scope.pricingTier),
            outcome: "failed",
          },
        });
      throw error;
    }
  }

  private async finalizeVerifiedUpload(scope: BrandActorScope, input: VisualAssetFinalizeInput) {
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.profiles", "profile");
    const parsed = visualAssetFinalizeSchema.parse(input);
    if (!parsed.key.startsWith(brandOwnerStoragePrefix(scope, "visual-assets"))) {
      throw new VisualAssetIntegrityError("visual_asset_key_forbidden");
    }
    const prisma = this.requirePrisma();
    const ownerWhere = brandOwnerWhere(scope);
    const existing = await prisma.visualAsset.findFirst({ where: { ...ownerWhere, fingerprint: parsed.fingerprint, deletedAt: null } });
    if (existing) return toRow(existing, await this.storage.accessUrl(existing.storageKey), true);

    const [object, probe, fingerprint] = await Promise.all([
      this.storage.head(parsed.key),
      this.storage.probe(parsed.key, parsed.contentType),
      this.storage.fingerprint(parsed.key),
    ]);
    assertFinalizedVisualObject(parsed, object, probe);
    if (fingerprint !== parsed.fingerprint) throw new VisualAssetIntegrityError("visual_asset_fingerprint_mismatch");
    const owner = resolveBrandOwner(scope);
    try {
      const created = await prisma.visualAsset.create({
        data: {
          ...owner,
          createdByUserId: scope.actorUserId,
          title: parsed.title,
          kind: probe.kind as VisualAssetKind,
          storageKey: parsed.key,
          contentType: parsed.contentType,
          sizeBytes: BigInt(parsed.sizeBytes),
          width: probe.width,
          height: probe.height,
          durationSec: probe.durationSec,
          fingerprint,
          provenance: parsed.provenance,
        },
      });
      return toRow(created, await this.storage.accessUrl(created.storageKey));
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      const replay = await prisma.visualAsset.findFirst({ where: { ...ownerWhere, fingerprint, deletedAt: null } });
      if (!replay) throw error;
      return toRow(replay, await this.storage.accessUrl(replay.storageKey), true);
    }
  }

  async list(scope: BrandActorScope) {
    const prisma = this.requirePrisma();
    const rows = await prisma.visualAsset.findMany({ where: { ...brandOwnerWhere(scope), deletedAt: null }, orderBy: { createdAt: "desc" } });
    return Promise.all(rows.map(async (row) => toRow(row, await this.storage.accessUrl(row.storageKey))));
  }

	async assertSceneReferences(scope: BrandActorScope, scenes: readonly SceneBlock[]) {
		return this.assertSceneReferencesWithPolicy(scope, scenes, false);
	}

	async assertSceneReferencesWithPolicy(
		scope: BrandActorScope,
		scenes: readonly SceneBlock[],
		allowDeleted: boolean,
	) {
		const assetIds = [...new Set(scenes.flatMap((scene) =>
			scene.content.kind === "image" || scene.content.kind === "video"
				? [scene.content.asset.id]
				: [],
		))];
		if (assetIds.length === 0) return;
		const assets = await this.requirePrisma().visualAsset.findMany({
			where: { id: { in: assetIds }, ...brandOwnerWhere(scope), ...(allowDeleted ? {} : { deletedAt: null }) },
			select: { id: true, kind: true, fingerprint: true, durationSec: true },
		});
		assertSceneVisualAssetReferences(
			scenes,
			assets.map((asset) => ({ ...asset, kind: asset.kind as "image" | "video" })),
		);
	}

	async resolveSceneReferences(scope: BrandActorScope, scenes: readonly SceneBlock[]) {
		const assetIds = [...new Set(scenes.flatMap((scene) =>
			scene.content.kind === "image" || scene.content.kind === "video"
				? [scene.content.asset.id]
				: [],
		))];
		if (assetIds.length === 0) return [];
		const rows = await this.requirePrisma().visualAsset.findMany({
			where: { id: { in: assetIds }, ...brandOwnerWhere(scope) },
		});
		return Promise.all(rows.map(async (row) => {
			const exists = await this.storage.head(row.storageKey).catch(() => null);
			const accessUrl = exists ? await this.storage.accessUrl(row.storageKey).catch(() => null) : null;
			return { ...toRow(row, accessUrl), missing: accessUrl === null, insertable: false as const };
		}));
	}

  async assertVisualBrollReferences(
    scope: BrandActorScope,
    placements: readonly StudioVisualBrollPlacement[],
  ) {
    const assetIds = [...new Set(placements.map((placement) => placement.asset.id))];
    if (assetIds.length === 0) return;
    const assets = await this.requirePrisma().visualAsset.findMany({
      where: { id: { in: assetIds }, ...brandOwnerWhere(scope), deletedAt: null },
      select: { id: true, kind: true, fingerprint: true, durationSec: true },
    });
    assertVisualBrollAssetReferences(
      placements,
      assets.map((asset) => ({ ...asset, kind: asset.kind as "image" | "video" })),
    );
  }

  async resolveVisualBrollReferences(
    scope: BrandActorScope,
    placements: readonly StudioVisualBrollPlacement[],
  ) {
    const assetIds = [...new Set(placements.map((placement) => placement.asset.id))];
    if (assetIds.length === 0) return [];
    const rows = await this.requirePrisma().visualAsset.findMany({
      where: { id: { in: assetIds }, ...brandOwnerWhere(scope) },
    });
    return Promise.all(rows.map(async (row) => {
      const exists = await this.storage.head(row.storageKey).catch(() => null);
      const accessUrl = exists ? await this.storage.accessUrl(row.storageKey).catch(() => null) : null;
      return { ...toRow(row, accessUrl), missing: accessUrl === null, insertable: false as const };
    }));
  }

  async recordGeneratedInsertionsBestEffort(
    scope: BrandActorScope,
    projectId: string,
    assetIds: readonly string[],
  ) {
    if (assetIds.length === 0) return;
    try {
      const jobs = await this.requirePrisma().generatedMediaJob.findMany({
        where: {
          workspaceId: scope.workspaceId,
          resultAssetId: { in: [...new Set(assetIds)] },
          status: "completed",
        },
        select: { id: true, resultAssetId: true, aspectRatio: true },
      });
      await this.requirePrisma().generatedMediaJob.updateMany({
        where: { id: { in: jobs.map((job) => job.id) }, insertedAt: null },
        data: { insertedAt: new Date() },
      });
      await Promise.all(jobs.map((job) => analyticsService.recordBrandProgramEventBestEffort({
        type: "generated_asset_inserted",
        workspaceId: scope.workspaceId,
        actorUserId: scope.actorUserId,
        projectId,
        metadata: {
          generatedMediaJobId: job.id,
          assetId: job.resultAssetId ?? undefined,
          assetKind: "image",
          aspectRatio: job.aspectRatio as "9:16" | "16:9" | "1:1",
          planTier: resolvePricingTier(scope.pricingTier),
          outcome: "succeeded",
        },
      })));
    } catch {
      console.warn(JSON.stringify({
        level: "warn",
        message: "generated_asset_insertion_analytics_failed",
        workspaceId: scope.workspaceId,
        projectId,
      }));
    }
  }

  async softDelete(scope: BrandActorScope, id: string, input: ReusableAssetSoftDeleteInput) {
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.profiles", "profile");
    return this.softDeleteOwned(scope, id, input, false);
  }

  async softDeleteGenerated(scope: BrandActorScope, id: string, input: ReusableAssetSoftDeleteInput) {
    if (!workspaceAllowsCapability({ role: scope.role, status: scope.status }, "content.edit")) {
      throw new BrandAccessError("brand_forbidden");
    }
    return this.softDeleteOwned(scope, id, input, true);
  }

  private async softDeleteOwned(
    scope: BrandActorScope,
    id: string,
    input: ReusableAssetSoftDeleteInput,
    generatedOnly: boolean,
  ) {
    const parsed = reusableAssetSoftDeleteSchema.parse(input);
    const prisma = this.requirePrisma();
    await withSerializableTransaction(prisma, async (tx) => {
      const asset = await tx.visualAsset.findFirst({
        where: { id, ...brandOwnerWhere(scope), deletedAt: null },
        include: {
          profiles: true,
          sceneTemplates: { where: { deletedAt: null }, select: { id: true } },
        },
      });
      if (!asset) throw new VisualAssetIntegrityError("visual_asset_not_found");
      if (generatedOnly && asset.provenance !== "generated") {
        throw new VisualAssetIntegrityError("visual_asset_not_generated");
      }
      if (asset.sceneTemplates.length > 0) throw new VisualAssetReferenceError();
      const clipDocuments = await tx.clip.findMany({
        where: { project: { workspaceId: scope.workspaceId } },
        select: { studioEdits: true, sceneBlocks: true },
      });
      if (clipDocuments.some((document) => visualAssetIsReferencedByClipStorage(id, document))) {
        throw new VisualAssetReferenceError();
      }
      const identityReferences = await tx.brandProfile.findMany({
        where: {
          ...brandOwnerWhere(scope),
          deletedAt: null,
          OR: [
            { visualIdentity: { path: ["primaryLogoAssetId"], equals: id } },
            { visualIdentity: { path: ["alternateLogoAssetId"], equals: id } },
          ],
        },
        select: { id: true, visualIdentity: true },
      });
      if (
        (asset.profiles.length > 0 || identityReferences.length > 0) &&
        !parsed.replacementId
      ) {
        throw new VisualAssetReferenceError();
      }
      const replacement = parsed.replacementId
        ? await tx.visualAsset.findFirst({ where: { id: parsed.replacementId, ...brandOwnerWhere(scope), deletedAt: null, kind: asset.kind }, select: { id: true } })
        : null;
      if (parsed.replacementId && !replacement) throw new VisualAssetIntegrityError("visual_asset_replacement_invalid");
      if (replacement) {
        for (const membership of asset.profiles) {
          const existing = await tx.brandProfileAsset.findUnique({ where: { profileId_assetId: { profileId: membership.profileId, assetId: replacement.id } }, select: { id: true } });
          if (existing) await tx.brandProfileAsset.delete({ where: { id: membership.id } });
          else await tx.brandProfileAsset.update({ where: { id: membership.id }, data: { assetId: replacement.id } });
        }
        for (const profile of identityReferences) {
          const identity = profile.visualIdentity as Record<string, unknown>;
          const nextIdentity = {
            ...identity,
            ...(identity.primaryLogoAssetId === id ? { primaryLogoAssetId: replacement.id } : {}),
            ...(identity.alternateLogoAssetId === id ? { alternateLogoAssetId: replacement.id } : {}),
          };
          await tx.brandProfile.update({ where: { id: profile.id }, data: { visualIdentity: nextIdentity as Prisma.InputJsonValue, revision: { increment: 1 }, updatedByUserId: scope.actorUserId } });
        }
      }
      await tx.visualAsset.update({ where: { id }, data: { deletedAt: new Date() } });
    });
  }
}

export const visualAssetService = new VisualAssetService();
