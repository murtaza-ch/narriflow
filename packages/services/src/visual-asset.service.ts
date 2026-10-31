import { randomUUID } from "node:crypto";
import type { Prisma, VisualAsset } from "@prisma/client";
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
  assertBrandManageAllowed,
  assertBrandMutationAllowedWithAnalytics,
  BrandAccessError,
  brandOwnerStoragePrefix,
  brandOwnerWhere,
  type BrandActorScope,
} from "./brand-ownership";
import {
  headObject,
  isR2Configured,
  presignDownloadUrl,
  presignSingleUploadUrl,
} from "./r2-storage";
import { analyticsService } from "./analytics.service";
import { getNativeValidationService } from "./native-validation-runtime";
import { accessibleProjectWhere } from "./project-access";
import { withSerializableTransaction } from "./serializable-transaction";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
  type ExpectedDomainFailureDetails,
} from "./expected-domain-failure";


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
  accessUrl(key: string): Promise<string>;
}

const visualAssetIntegrityFailureCatalog = {
  scene_visual_asset_invalid: "unprocessable",
  scene_visual_asset_range_invalid: "unprocessable",
  visual_asset_fingerprint_mismatch: "unprocessable",
	visual_asset_in_use: "conflict",
  visual_asset_key_forbidden: "forbidden",
  visual_asset_kind_mismatch: "unprocessable",
  visual_asset_mime_mismatch: "unprocessable",
  visual_asset_not_found: "missing",
  visual_asset_not_generated: "unprocessable",
  visual_asset_object_missing: "missing",
  visual_asset_probe_failed: "unavailable",
  visual_asset_replacement_invalid: "unprocessable",
  visual_asset_size_mismatch: "unprocessable",
	visual_asset_storage_unavailable: "unavailable",
  visual_broll_asset_invalid: "unprocessable",
} as const satisfies ExpectedDomainFailureCatalog<string>;

type VisualAssetIntegrityFailureCode = keyof typeof visualAssetIntegrityFailureCatalog;

export class VisualAssetIntegrityError extends ExpectedDomainFailureError<VisualAssetIntegrityFailureCode> {
  constructor(code: VisualAssetIntegrityFailureCode, details?: ExpectedDomainFailureDetails) {
    super({ code, kind: visualAssetIntegrityFailureCatalog[code], message: "The selected visual asset could not be verified", details });
    this.name = "VisualAssetIntegrityError";
  }
}

export type VisualAssetUsage = {
  clips: readonly string[];
  sceneTemplates: readonly string[];
  profiles: readonly string[];
};

const USAGE_NAMES_SHOWN = 3;

/** "A, B, C and 2 more" - enough to find the place, short enough to read. */
function namesWithMore(names: readonly string[]) {
  const shown = names.slice(0, USAGE_NAMES_SHOWN).map((name) => name.length > 40 ? `${name.slice(0, 39)}…` : name).join(", ");
  const rest = names.length - USAGE_NAMES_SHOWN;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/** Where the asset is used, as one readable line: "clips A, B and 2 more; brand profile Acme". */
export function describeVisualAssetUsage(usage: VisualAssetUsage): string {
  return [
    usage.clips.length > 0 ? `${usage.clips.length === 1 ? "clip" : "clips"} ${namesWithMore(usage.clips)}` : null,
    usage.sceneTemplates.length > 0 ? `${usage.sceneTemplates.length === 1 ? "scene template" : "scene templates"} ${namesWithMore(usage.sceneTemplates)}` : null,
    usage.profiles.length > 0 ? `${usage.profiles.length === 1 ? "brand profile" : "brand profiles"} ${namesWithMore(usage.profiles)}` : null,
  ].filter((part): part is string => part !== null).join("; ");
}

export class VisualAssetReferenceError extends ExpectedDomainFailureError<"visual_asset_in_use"> {
  constructor(usage: VisualAssetUsage) {
    super({
      code: "visual_asset_in_use",
      kind: visualAssetIntegrityFailureCatalog.visual_asset_in_use,
      message:
        "Remove this asset from every Clip, Brand Profile, and Scene template before deleting it",
      details: { usedIn: describeVisualAssetUsage(usage) },
    });
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
  // Name every unusable placement so the Studio can offer to remove them.
  const placementIds = placements
    .filter((placement) => {
      const asset = byId.get(placement.asset.id);
      return !asset || asset.kind !== "image" || asset.fingerprint !== placement.asset.fingerprint;
    })
    .map((placement) => placement.id);
  if (placementIds.length > 0) {
    throw new VisualAssetIntegrityError("visual_broll_asset_invalid", { placementIds });
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
    if (!isR2Configured()) {
      throw new VisualAssetIntegrityError("visual_asset_storage_unavailable");
    }
    const key = `${brandOwnerStoragePrefix(scope, "visual-assets")}${randomUUID()}.${extensionForVisual(parsed.contentType)}`;
    return { key, contentType: parsed.contentType, uploadUrl: await this.storage.presign({ key, contentType: parsed.contentType }) };
  }

  async finalizeUpload(scope: BrandActorScope, input: VisualAssetFinalizeInput) {
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.profiles", "profile");
    const parsed = visualAssetFinalizeSchema.parse(input);
    if (!parsed.key.startsWith(brandOwnerStoragePrefix(scope, "visual-assets"))) throw new VisualAssetIntegrityError("visual_asset_key_forbidden");
    return getNativeValidationService().admit(scope, { kind: "visual", ...parsed });
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
    assertBrandManageAllowed(scope);
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
          // Only live profiles hold an asset in use; a deleted profile never blocks cleanup.
          profiles: { where: { profile: { deletedAt: null } }, include: { profile: { select: { name: true } } } },
          sceneTemplates: { where: { deletedAt: null, profile: { deletedAt: null } }, select: { id: true, name: true } },
        },
      });
      if (!asset) throw new VisualAssetIntegrityError("visual_asset_not_found");
      if (generatedOnly && asset.provenance !== "generated") {
        throw new VisualAssetIntegrityError("visual_asset_not_generated");
      }
      // An expired Project can't be opened, rendered or restored (only a paid
      // plan before the deadline clears it), so its clips don't hold the asset.
      const clips = await tx.clip.findMany({
        where: { project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() } },
        select: { title: true, studioEdits: true, sceneBlocks: true },
      });
      const identityReferences = await tx.brandProfile.findMany({
        where: {
          ...brandOwnerWhere(scope),
          deletedAt: null,
          OR: [
            { visualIdentity: { path: ["primaryLogoAssetId"], equals: id } },
            { visualIdentity: { path: ["alternateLogoAssetId"], equals: id } },
          ],
        },
        select: { id: true, name: true, visualIdentity: true },
      });
      // Clips and Scene templates always block; Brand Profiles only when no replacement takes over.
      const usage: VisualAssetUsage = {
        clips: clips
          .filter((clip) => visualAssetIsReferencedByClipStorage(id, clip))
          .map((clip) => clip.title?.trim() || "Untitled clip"),
        sceneTemplates: asset.sceneTemplates.map((template) => template.name),
        profiles: parsed.replacementId
          ? []
          : [...new Map([
              ...asset.profiles.map((membership) => [membership.profileId, membership.profile.name] as const),
              ...identityReferences.map((profile) => [profile.id, profile.name] as const),
            ]).values()],
      };
      if (usage.clips.length + usage.sceneTemplates.length + usage.profiles.length > 0) {
        throw new VisualAssetReferenceError(usage);
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
