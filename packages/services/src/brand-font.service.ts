import { randomUUID } from "node:crypto";
import type { BrandFont, BrandFontFormat } from "@prisma/client";
import { create as parseFont } from "fontkit";
import { getPrismaClient } from "@narriflow/db/client";
import {
  brandFontFinalizeSchema,
  brandFontUploadSchema,
  reusableAssetSoftDeleteSchema,
  resolvePricingTier,
  type SceneBlock,
  type BrandFontFinalizeInput,
  type BrandFontUploadInput,
  type ReusableAssetSoftDeleteInput,
} from "@narriflow/validators";
import {
  assertBrandMutationAllowedWithAnalytics,
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
  readObjectBytes,
} from "./r2-storage";
import { analyticsService } from "./analytics.service";
import { withSerializableTransaction } from "./serializable-transaction";

export class BrandFontIntegrityError extends Error {
  constructor(readonly code: string) {
    super("The uploaded font could not be verified");
    this.name = "BrandFontIntegrityError";
  }
}

export class BrandFontReferenceError extends Error {
  readonly code = "brand_font_in_use";
  constructor() {
    super("Remove this font from every Brand Profile and Scene template before deleting it");
    this.name = "BrandFontReferenceError";
  }
}

export function assertSceneBrandFontReferences(
	scenes: readonly SceneBlock[],
	fonts: readonly { id: string; family: string; fingerprint: string }[],
): void {
	const byId = new Map(fonts.map((font) => [font.id, font]));
	for (const scene of scenes) {
		if (scene.content.kind !== "text" || !scene.content.fontAsset) continue;
		const font = byId.get(scene.content.fontAsset.id);
		if (
			!font ||
			font.fingerprint !== scene.content.fontAsset.fingerprint ||
			font.family !== scene.content.fontFamily
		) {
			throw new BrandFontIntegrityError("scene_brand_font_invalid");
		}
	}
}

export interface ParsedBrandFont {
  format: "ttf" | "otf" | "woff2";
  family: string;
  style: string;
  weight: number;
}

function normalizeFontName(value: string, maximumLength: number) {
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new BrandFontIntegrityError("brand_font_name_invalid");
  }
  return normalized;
}

export function parseBrandFont(bytes: Uint8Array): ParsedBrandFont {
  if (bytes.byteLength < 4) throw new BrandFontIntegrityError("brand_font_malformed");
  const signature = Buffer.from(bytes.subarray(0, 4));
  if (signature.toString("ascii") === "ttcf") throw new BrandFontIntegrityError("brand_font_collection_unsupported");
  const format = signature.toString("ascii") === "OTTO"
    ? "otf"
    : signature.toString("ascii") === "wOF2"
      ? "woff2"
      : signature.equals(Buffer.from([0x00, 0x01, 0x00, 0x00])) ||
          signature.toString("ascii") === "true"
        ? "ttf"
        : null;
  if (!format) throw new BrandFontIntegrityError("brand_font_malformed");
  try {
    const font = parseFont(Buffer.from(bytes));
    if ("fonts" in font) {
      throw new BrandFontIntegrityError("brand_font_collection_unsupported");
    }
    const family = normalizeFontName(font.familyName, 120);
    const style = normalizeFontName(font.subfamilyName, 80);
    if (!font.postscriptName || font.numGlyphs <= 0 || font.unitsPerEm <= 0) {
      throw new BrandFontIntegrityError("brand_font_malformed");
    }
    const weight = Math.max(
      100,
      Math.min(900, Math.round(font["OS/2"].usWeightClass || 400)),
    );
    return { format, family, style, weight };
  } catch (error) {
    if (error instanceof BrandFontIntegrityError) throw error;
    throw new BrandFontIntegrityError("brand_font_malformed");
  }
}

export function parseBrandFontHeader(bytes: Uint8Array): "ttf" | "otf" | "woff2" {
  return parseBrandFont(bytes).format;
}

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

function toRow(font: BrandFont, accessUrl: string | null, replayed = false) {
  return {
    id: font.id,
    family: font.family,
    style: font.style,
    weight: font.weight,
    format: font.format as "ttf" | "otf" | "woff2",
    sizeBytes: Number(font.sizeBytes),
    fingerprint: font.fingerprint,
    accessUrl,
    replayed,
    createdAt: font.createdAt.toISOString(),
  };
}

export class BrandFontService {
  private requirePrisma = requirePrisma;

  async presignUpload(scope: BrandActorScope, input: BrandFontUploadInput) {
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.customFonts", "font");
    const parsed = brandFontUploadSchema.parse(input);
    if (!isR2Configured()) throw new Error("R2 configuration is missing");
    const format = formatForContentType(parsed.contentType);
    const key = `${brandOwnerStoragePrefix(scope, "brand-fonts")}${randomUUID()}.${format}`;
    return { key, contentType: parsed.contentType, uploadUrl: await presignSingleUploadUrl({ key, contentType: parsed.contentType }) };
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
    const existing = await prisma.brandFont.findFirst({ where: { ...ownerWhere, fingerprint: parsed.fingerprint, deletedAt: null } });
    if (existing) return toRow(existing, await presignDownloadUrl({ key: existing.storageKey }), true);
    let object;
    try {
      object = await headObject(parsed.key);
    } catch {
      throw new BrandFontIntegrityError("brand_font_object_missing");
    }
    if (object.contentType !== parsed.contentType) throw new BrandFontIntegrityError("brand_font_mime_mismatch");
    if (object.sizeBytes !== parsed.sizeBytes) throw new BrandFontIntegrityError("brand_font_size_mismatch");
    const [bytes, fingerprint] = await Promise.all([
      readObjectBytes(parsed.key, 20 * 1024 * 1024),
      hashObjectSha256(parsed.key),
    ]);
    const parsedFont = parseBrandFont(bytes);
    if (parsedFont.format !== formatForContentType(parsed.contentType)) throw new BrandFontIntegrityError("brand_font_format_mismatch");
    if (fingerprint !== parsed.fingerprint) throw new BrandFontIntegrityError("brand_font_fingerprint_mismatch");
    const owner = resolveBrandOwner(scope);
    try {
      const created = await prisma.brandFont.create({ data: {
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
      } });
      return toRow(created, await presignDownloadUrl({ key: created.storageKey }));
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      const replay = await prisma.brandFont.findFirst({ where: { ...ownerWhere, fingerprint, deletedAt: null } });
      if (!replay) throw error;
      return toRow(replay, await presignDownloadUrl({ key: replay.storageKey }), true);
    }
  }

  async list(scope: BrandActorScope) {
    const prisma = this.requirePrisma();
    const rows = await prisma.brandFont.findMany({ where: { ...brandOwnerWhere(scope), deletedAt: null }, orderBy: { createdAt: "desc" } });
    return Promise.all(rows.map(async (row) => toRow(row, await presignDownloadUrl({ key: row.storageKey }))));
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
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.customFonts", "font");
    const parsed = reusableAssetSoftDeleteSchema.parse(input);
    const prisma = this.requirePrisma();
    await withSerializableTransaction(prisma, async (tx) => {
      const font = await tx.brandFont.findFirst({ where: { id, ...brandOwnerWhere(scope), deletedAt: null }, include: { profiles: { select: { id: true } } } });
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
