import { BrandFontIntegrityError, BrandFontReferenceError, assertSceneBrandFontReferences, } from "./brand-font-contract";
export { BrandFontIntegrityError, BrandFontReferenceError, assertSceneBrandFontReferences, type ParsedBrandFont } from "./brand-font-contract";
import { randomUUID } from "node:crypto";
import type { BrandFont } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  brandFontFinalizeSchema,
  brandFontUploadSchema,
  reusableAssetSoftDeleteSchema,
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
  type BrandActorScope,
} from "./brand-ownership";
import {
  headObject,
  isR2Configured,
  presignDownloadUrl,
  presignSingleUploadUrl,
} from "./r2-storage";
import { validatedFontFaceSchema } from "@narriflow/validators/native-validation";
import { getNativeValidationService } from "./native-validation-runtime";
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
  constructor(private readonly storage = { headObject, presignDownloadUrl, presignSingleUploadUrl, isR2Configured }) {}

  private async row(font: BrandFont, replayed = false) {
    try {
      const face = validatedFontFaceSchema.safeParse(font.face);
      if (!face.success) return toRow(font, null, replayed);
      await this.storage.headObject(font.storageKey);
      return toRow(font, await this.storage.presignDownloadUrl({ key: font.storageKey }), replayed, face.data);
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
    return Promise.all(rows.filter(font => validatedFontFaceSchema.safeParse(font.face).success).filter((font) => references.some((ref) => ref.id === font.id && ref.fingerprint === font.fingerprint)).map((font) => this.row(font)));
  }

  async assertSelection(scope: BrandActorScope, reference: { id: string; fingerprint: string } | null | undefined) {
    if (!reference) return;
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.customFonts", "font");
    const font = await this.requirePrisma().brandFont.findFirst({ where: {
      ...brandOwnerWhere(scope), id: reference.id, fingerprint: reference.fingerprint, deletedAt: null,
    }, select: { id: true, face: true } });
    if (!font || !validatedFontFaceSchema.safeParse(font.face).success) throw new BrandFontIntegrityError("brand_font_not_found");
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
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.customFonts", "font");
    const parsed = brandFontFinalizeSchema.parse(input);
    if (!parsed.key.startsWith(brandOwnerStoragePrefix(scope, "brand-fonts"))) throw new BrandFontIntegrityError("brand_font_key_forbidden");
    return getNativeValidationService().admit(scope, { kind: "font", ...parsed });
  }

  async list(scope: BrandActorScope) {
    const prisma = this.requirePrisma();
    const rows = await prisma.brandFont.findMany({ where: { ...brandOwnerWhere(scope), deletedAt: null }, orderBy: { createdAt: "desc" } });
    return Promise.all(rows.filter(row => validatedFontFaceSchema.safeParse(row.face).success).map((row) => this.row(row)));
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
				if (!validatedFontFaceSchema.safeParse(font.face).success) throw new BrandFontIntegrityError("brand_font_not_found");
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
			select: { id: true, family: true, fingerprint: true, face: true },
		});
		assertSceneBrandFontReferences(scenes, fonts.filter(font => validatedFontFaceSchema.safeParse(font.face).success));
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
        ? await tx.brandFont.findFirst({ where: { id: parsed.replacementId, ...brandOwnerWhere(scope), deletedAt: null }, select: { id: true, face: true } })
        : null;
      if (parsed.replacementId && (!replacement || !validatedFontFaceSchema.safeParse(replacement.face).success)) throw new BrandFontIntegrityError("brand_font_replacement_invalid");
      if (replacement) {
        await tx.brandProfileFont.updateMany({ where: { fontId: id }, data: { fontId: replacement.id } });
        await tx.brandProfile.updateMany({ where: { fonts: { some: { fontId: replacement.id } } }, data: { revision: { increment: 1 }, updatedByUserId: scope.actorUserId } });
      }
      await tx.brandFont.update({ where: { id }, data: { deletedAt: new Date() } });
    });
  }
}

export const brandFontService = new BrandFontService();
