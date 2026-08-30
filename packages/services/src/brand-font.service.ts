import { randomUUID } from "node:crypto";
import type { BrandFont, BrandFontFormat } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  brandFontFinalizeSchema,
  brandFontUploadSchema,
  reusableAssetSoftDeleteSchema,
  type BrandFontFinalizeInput,
  type BrandFontUploadInput,
  type ReusableAssetSoftDeleteInput,
} from "@narriflow/validators";
import {
  assertBrandMutationAllowed,
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

export class BrandFontIntegrityError extends Error {
  constructor(readonly code: string) {
    super("The uploaded font could not be verified");
    this.name = "BrandFontIntegrityError";
  }
}

export class BrandFontReferenceError extends Error {
  readonly code = "brand_font_in_use";
  constructor() {
    super("Remove or replace this font in every Brand Profile before deleting it");
    this.name = "BrandFontReferenceError";
  }
}

export function parseBrandFontHeader(bytes: Uint8Array): "ttf" | "otf" | "woff2" {
  if (bytes.byteLength < 4) throw new BrandFontIntegrityError("brand_font_malformed");
  const signature = Buffer.from(bytes.subarray(0, 4));
  if (signature.toString("ascii") === "ttcf") throw new BrandFontIntegrityError("brand_font_collection_unsupported");
  if (signature.equals(Buffer.from([0x00, 0x01, 0x00, 0x00])) || signature.toString("ascii") === "true") return "ttf";
  if (signature.toString("ascii") === "OTTO") return "otf";
  if (signature.toString("ascii") === "wOF2") return "woff2";
  throw new BrandFontIntegrityError("brand_font_malformed");
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
    assertBrandMutationAllowed(scope, "brand.customFonts");
    const parsed = brandFontUploadSchema.parse(input);
    if (!isR2Configured()) throw new Error("R2 configuration is missing");
    const format = formatForContentType(parsed.contentType);
    const key = `${brandOwnerStoragePrefix(scope, "brand-fonts")}${randomUUID()}.${format}`;
    return { key, contentType: parsed.contentType, uploadUrl: await presignSingleUploadUrl({ key, contentType: parsed.contentType }) };
  }

  async finalizeUpload(scope: BrandActorScope, input: BrandFontFinalizeInput) {
    assertBrandMutationAllowed(scope, "brand.customFonts");
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
    const format = parseBrandFontHeader(bytes);
    if (format !== formatForContentType(parsed.contentType)) throw new BrandFontIntegrityError("brand_font_format_mismatch");
    if (fingerprint !== parsed.fingerprint) throw new BrandFontIntegrityError("brand_font_fingerprint_mismatch");
    const owner = resolveBrandOwner(scope);
    try {
      const created = await prisma.brandFont.create({ data: {
        ...owner,
        licenseConfirmedByUserId: scope.actorUserId,
        family: parsed.family,
        style: parsed.style,
        weight: parsed.weight,
        format: format as BrandFontFormat,
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

  async softDelete(scope: BrandActorScope, id: string, input: ReusableAssetSoftDeleteInput) {
    assertBrandMutationAllowed(scope, "brand.customFonts");
    const parsed = reusableAssetSoftDeleteSchema.parse(input);
    const prisma = this.requirePrisma();
    const font = await prisma.brandFont.findFirst({ where: { id, ...brandOwnerWhere(scope), deletedAt: null }, include: { profiles: { select: { id: true } } } });
    if (!font) throw new BrandFontIntegrityError("brand_font_not_found");
    if (font.profiles.length > 0 && !parsed.replacementId) throw new BrandFontReferenceError();
    const replacement = parsed.replacementId
      ? await prisma.brandFont.findFirst({ where: { id: parsed.replacementId, ...brandOwnerWhere(scope), deletedAt: null }, select: { id: true } })
      : null;
    if (parsed.replacementId && !replacement) throw new BrandFontIntegrityError("brand_font_replacement_invalid");
    await prisma.$transaction(async (tx) => {
      if (replacement) {
        await tx.brandProfileFont.updateMany({ where: { fontId: id }, data: { fontId: replacement.id } });
        await tx.brandProfile.updateMany({ where: { fonts: { some: { fontId: replacement.id } } }, data: { revision: { increment: 1 }, updatedByUserId: scope.actorUserId } });
      }
      await tx.brandFont.update({ where: { id }, data: { deletedAt: new Date() } });
    });
  }
}

export const brandFontService = new BrandFontService();
