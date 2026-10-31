import { BrandFontIntegrityError, BrandFontReferenceError, assertSceneBrandFontReferences, parseBrandFont, } from "./brand-font-parser";
export { BrandFontIntegrityError, BrandFontReferenceError, assertSceneBrandFontReferences, parseBrandFont, parseBrandFontHeader, brandFontRenderer, type ParsedBrandFont } from "./brand-font-parser";
import { createHash, randomUUID } from "node:crypto";
import type { BrandFont, BrandFontFormat } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  brandFontFinalizeSchema,
  brandFontUploadSchema,
  reusableAssetSoftDeleteSchema,
  resolvePricingTier,
  type BrandFontFinalizeInput,
  type BrandFontUploadInput,
  type ReusableAssetSoftDeleteInput,
  type CaptionFontFace,
  type SceneBlock,
} from "@narriflow/validators";
import {
  assertBrandManageAllowed,
  assertBrandMutationAllowedWithAnalytics,
  brandOwnerStoragePrefix,
  brandOwnerWhere,
  resolveBrandOwner,
  type BrandActorScope,
} from "./brand-ownership";
import {
  headObject,
  isR2Configured,
  presignDownloadUrl,
  presignSingleUploadUrl,
  readObjectBytes,
} from "./r2-storage";
import { analyticsService } from "./analytics.service";
import { withSerializableTransaction } from "./serializable-transaction";

function formatForContentType(contentType: string): "ttf" | "otf" | "woff2" {
  if (contentType === "font/woff2") return "woff2";
  if (contentType === "font/otf") return "otf";
  return "ttf";
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

function toRow(font: BrandFont, accessUrl: string | null, replayed = false, face: CaptionFontFace | null = null) {
  return {
    id: font.id,
    family: font.family,
    style: font.style,
    weight: font.weight,
    format: font.format as "ttf" | "otf" | "woff2",
    sizeBytes: Number(font.sizeBytes),
    fingerprint: font.fingerprint,
    accessUrl,
    face,
    replayed,
    createdAt: font.createdAt.toISOString(),
  };
}

export class BrandFontService {
  private requirePrisma = requirePrisma;
  constructor(private readonly storage = { headObject, readObjectBytes, presignDownloadUrl, presignSingleUploadUrl, isR2Configured }) {}

  private async row(font: BrandFont, replayed = false) {
    try {
      const bytes = await this.storage.readObjectBytes(font.storageKey, 20 * 1024 * 1024);
      if (createHash("sha256").update(bytes).digest("hex") !== font.fingerprint) return toRow(font, null, replayed);
      const parsed = parseBrandFont(bytes);
      return toRow(font, await this.storage.presignDownloadUrl({ key: font.storageKey }), replayed, parsed.face);
    } catch {
      return toRow(font, null, replayed);
    }
  }

  /** Deleted uploads remain resolvable by existing documents; new pickers use list(). */
  async resolveReferences(scope: BrandActorScope, references: readonly { id: string; fingerprint: string }[]) {
    if (!references.length) return [];
    const rows = await this.requirePrisma().brandFont.findMany({ where: {
      ...brandOwnerWhere(scope), id: { in: [...new Set(references.map((ref) => ref.id))] },
    } });
    return Promise.all(rows.filter((font) => references.some((ref) => ref.id === font.id && ref.fingerprint === font.fingerprint)).map((font) => this.row(font)));
  }

  async assertSelection(scope: BrandActorScope, reference: { id: string; fingerprint: string } | null | undefined) {
    if (!reference) return;
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.customFonts", "font");
    const font = await this.requirePrisma().brandFont.findFirst({ where: {
      ...brandOwnerWhere(scope), id: reference.id, fingerprint: reference.fingerprint, deletedAt: null,
    }, select: { id: true } });
    if (!font) throw new BrandFontIntegrityError("brand_font_not_found");
  }

  async presignUpload(scope: BrandActorScope, input: BrandFontUploadInput) {
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.customFonts", "font");
    const parsed = brandFontUploadSchema.parse(input);
    if (!this.storage.isR2Configured()) {
      throw new BrandFontIntegrityError("brand_font_storage_unavailable");
    }
    const format = formatForContentType(parsed.contentType);
    const key = `${brandOwnerStoragePrefix(scope, "brand-fonts")}${randomUUID()}.${format}`;
    return { key, contentType: parsed.contentType, uploadUrl: await this.storage.presignSingleUploadUrl({ key, contentType: parsed.contentType }) };
  }

  async finalizeUpload(scope: BrandActorScope, input: BrandFontFinalizeInput) {
    try {
      const result = await this.finalizeVerifiedUpload(scope, input);
      await analyticsService.recordBrandProgramEventBestEffort({
          type: "brand_font_upload_succeeded",
          workspaceId: scope.workspaceId,
          actorUserId: scope.actorUserId,
          metadata: {
            fontId: result.id,
            assetKind: "font",
            planTier: resolvePricingTier(scope.pricingTier),
            outcome: "succeeded",
          },
        });
      return result;
    } catch (error) {
      await analyticsService.recordBrandProgramEventBestEffort({
          type: "brand_font_upload_failed",
          workspaceId: scope.workspaceId,
          actorUserId: scope.actorUserId,
          metadata: {
            assetKind: "font",
            planTier: resolvePricingTier(scope.pricingTier),
            outcome: "failed",
          },
        });
      throw error;
    }
  }

  private async finalizeVerifiedUpload(scope: BrandActorScope, input: BrandFontFinalizeInput) {
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.customFonts", "font");
    const parsed = brandFontFinalizeSchema.parse(input);
    if (!parsed.key.startsWith(brandOwnerStoragePrefix(scope, "brand-fonts"))) throw new BrandFontIntegrityError("brand_font_key_forbidden");
    const prisma = this.requirePrisma();
    const ownerWhere = brandOwnerWhere(scope);
    const existing = await prisma.brandFont.findFirst({ where: { ...ownerWhere, fingerprint: parsed.fingerprint } });
    if (existing && !existing.deletedAt) return this.row(existing, true);
    let object;
    try {
      object = await this.storage.headObject(parsed.key);
    } catch {
      throw new BrandFontIntegrityError("brand_font_object_missing");
    }
    if (object.contentType !== parsed.contentType) throw new BrandFontIntegrityError("brand_font_mime_mismatch");
    if (object.sizeBytes !== parsed.sizeBytes) throw new BrandFontIntegrityError("brand_font_size_mismatch");
    const bytes = await this.storage.readObjectBytes(parsed.key, 20 * 1024 * 1024);
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    const parsedFont = parseBrandFont(bytes);
    if (parsedFont.format !== formatForContentType(parsed.contentType)) throw new BrandFontIntegrityError("brand_font_format_mismatch");
    if (fingerprint !== parsed.fingerprint) throw new BrandFontIntegrityError("brand_font_fingerprint_mismatch");
    const owner = resolveBrandOwner(scope);
    try {
      const data = {
        ...owner,
        licenseConfirmedByUserId: scope.actorUserId,
        family: parsedFont.family,
        style: parsedFont.style,
        weight: parsedFont.weight,
        format: parsedFont.format as BrandFontFormat,
        storageKey: parsed.key,
        sizeBytes: BigInt(parsed.sizeBytes),
        fingerprint,
        licenseConfirmedAt: new Date(),
        deletedAt: null,
      };
      // The fingerprint is unique for an owner even after soft deletion.
      // Re-uploading the same bytes restores that asset and its saved references.
      const created = existing
        ? await prisma.brandFont.update({ where: { id: existing.id }, data })
        : await prisma.brandFont.create({ data });
      return toRow(created, await this.storage.presignDownloadUrl({ key: created.storageKey }), false, parsedFont.face);
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      const replay = await prisma.brandFont.findFirst({ where: { ...ownerWhere, fingerprint, deletedAt: null } });
      if (!replay) throw error;
      return this.row(replay, true);
    }
  }

  async list(scope: BrandActorScope) {
    const prisma = this.requirePrisma();
    const rows = await prisma.brandFont.findMany({ where: { ...brandOwnerWhere(scope), deletedAt: null }, orderBy: { createdAt: "desc" } });
    return Promise.all(rows.map((row) => this.row(row)));
  }

	async resolveSceneReferences(scope: BrandActorScope, scenes: readonly SceneBlock[]) {
		const fontIds = [...new Set(scenes.flatMap((scene) =>
			scene.content.kind === "text" && scene.content.fontAsset
				? [scene.content.fontAsset.id]
				: [],
		))];
		if (fontIds.length === 0) return [];
		const rows = await this.requirePrisma().brandFont.findMany({
			where: { id: { in: fontIds }, ...brandOwnerWhere(scope) },
		});
		return Promise.all(rows.map(async (font) => {
			let accessUrl: string | null = null;
			try {
				await headObject(font.storageKey);
				accessUrl = await presignDownloadUrl({ key: font.storageKey });
			} catch {
				accessUrl = null;
			}
			return { id: font.id, family: font.family, style: font.style, weight: font.weight, fingerprint: font.fingerprint, accessUrl, missing: accessUrl === null, insertable: false as const };
		}));
	}

	async assertSceneReferences(
		scope: BrandActorScope,
		projectId: string,
		scenes: readonly SceneBlock[],
		options: { allowDeleted: boolean; requireActiveProfile: boolean },
	) {
		const fontIds = [...new Set(scenes.flatMap((scene) =>
			scene.content.kind === "text" && scene.content.fontAsset
				? [scene.content.fontAsset.id]
				: [],
		))];
		if (fontIds.length === 0) return;
		const project = options.requireActiveProfile
			? await this.requirePrisma().project.findFirst({
				where: { id: projectId, workspaceId: scope.workspaceId },
				select: { brandProfileId: true },
			})
			: null;
		if (options.requireActiveProfile && !project?.brandProfileId) {
			throw new BrandFontIntegrityError("scene_brand_font_profile_invalid");
		}
		const fonts = await this.requirePrisma().brandFont.findMany({
			where: {
				id: { in: fontIds },
				...brandOwnerWhere(scope),
				...(options.allowDeleted ? {} : { deletedAt: null }),
				...(project?.brandProfileId ? { profiles: { some: { profileId: project.brandProfileId } } } : {}),
			},
			select: { id: true, family: true, fingerprint: true },
		});
		assertSceneBrandFontReferences(scenes, fonts);
	}

  async softDelete(scope: BrandActorScope, id: string, input: ReusableAssetSoftDeleteInput) {
    assertBrandManageAllowed(scope);
    const parsed = reusableAssetSoftDeleteSchema.parse(input);
    if (parsed.replacementId === id) throw new BrandFontIntegrityError("brand_font_replacement_invalid");
    const prisma = this.requirePrisma();
    await withSerializableTransaction(prisma, async (tx) => {
      // Only live profiles hold a font in use; a deleted profile never blocks cleanup.
      const font = await tx.brandFont.findFirst({ where: { id, ...brandOwnerWhere(scope), deletedAt: null }, include: { profiles: { where: { profile: { deletedAt: null } }, select: { id: true } } } });
      if (!font) throw new BrandFontIntegrityError("brand_font_not_found");
      const templateReference = await tx.sceneTemplate.findFirst({
        where: {
          deletedAt: null,
          profile: { ...brandOwnerWhere(scope), deletedAt: null },
          definition: { path: ["content", "fontAsset", "id"], equals: id },
        },
        select: { id: true },
      });
      if (templateReference) throw new BrandFontReferenceError();
      const captionStyleReference = await tx.brandTemplate.findFirst({
        where: {
          deletedAt: null,
          workspaceId: scope.workspaceId,
          captionPreset: { path: ["fontAsset", "id"], equals: id },
        },
        select: { id: true },
      });
      if (captionStyleReference) throw new BrandFontReferenceError();
      if (font.profiles.length > 0 && !parsed.replacementId) throw new BrandFontReferenceError();
      const replacement = parsed.replacementId
        ? await tx.brandFont.findFirst({ where: { id: parsed.replacementId, ...brandOwnerWhere(scope), deletedAt: null }, select: { id: true } })
        : null;
      if (parsed.replacementId && !replacement) throw new BrandFontIntegrityError("brand_font_replacement_invalid");
      if (replacement) {
        await tx.brandProfileFont.updateMany({ where: { fontId: id }, data: { fontId: replacement.id } });
        await tx.brandProfile.updateMany({ where: { fonts: { some: { fontId: replacement.id } } }, data: { revision: { increment: 1 }, updatedByUserId: scope.actorUserId } });
      }
      await tx.brandFont.update({ where: { id }, data: { deletedAt: new Date() } });
    });
  }
}

export const brandFontService = new BrandFontService();
