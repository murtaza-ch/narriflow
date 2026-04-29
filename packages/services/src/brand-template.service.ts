import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { BrandTemplate, Prisma as PrismaTypes } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  brandTemplateInputSchema,
  brandTemplateUpdateSchema,
  captionPresetSchema,
  logoPositionSchema,
  presignBrandLogoSchema,
  type BrandTemplateInput,
  type BrandTemplateSnapshot,
  type BrandTemplateSummary,
  type BrandTemplateUpdate,
  type CaptionPreset,
  type LogoPosition,
  type PresignBrandLogoInput,
} from "@narriflow/validators";
import {
  deleteObject,
  isR2Configured,
  presignDownloadUrl,
  presignSingleUploadUrl,
} from "./r2-storage";

const FALLBACK_BUILT_IN_KEY = "karaoke";

export class BrandTemplateNotFoundError extends Error {
  constructor() {
    super("brand template not found");
    this.name = "BrandTemplateNotFoundError";
  }
}

export class BrandTemplateForbiddenError extends Error {
  constructor() {
    super("brand template is read-only");
    this.name = "BrandTemplateForbiddenError";
  }
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("Database client unavailable");
  }
  return prisma;
}

function toSummary(template: BrandTemplate): BrandTemplateSummary {
  return {
    id: template.id,
    userId: template.userId,
    name: template.name,
    isBuiltIn: template.isBuiltIn,
    builtInKey: template.builtInKey,
    captionPreset: captionPresetSchema.parse(template.captionPreset),
    logoStorageKey: template.logoStorageKey,
    logoPosition: logoPositionSchema.parse(template.logoPosition),
    logoOpacity: template.logoOpacity,
    logoScalePct: template.logoScalePct,
    primaryColor: template.primaryColor,
    secondaryColor: template.secondaryColor,
    accentColor: template.accentColor,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}

function applyBrandColorsToCaption(
  preset: CaptionPreset,
  primaryColor: string,
  secondaryColor: string,
): CaptionPreset {
  return {
    ...preset,
    primaryColor,
    highlightColor: secondaryColor,
    outlineColor: preset.outlineColor,
  };
}

export class BrandTemplateService {
  private requirePrisma = requirePrisma;

  buildSnapshot(template: BrandTemplate): BrandTemplateSnapshot {
    const captionPreset = captionPresetSchema.parse(template.captionPreset);
    return {
      templateId: template.id,
      captionPreset,
      logoStorageKey: template.logoStorageKey,
      logoPosition: logoPositionSchema.parse(template.logoPosition),
      logoOpacity: template.logoOpacity,
      logoScalePct: template.logoScalePct,
      primaryColor: template.primaryColor,
      secondaryColor: template.secondaryColor,
      accentColor: template.accentColor,
    };
  }

  async list(userId: string): Promise<{
    builtIns: BrandTemplateSummary[];
    mine: BrandTemplateSummary[];
    defaultId: string | null;
  }> {
    const prisma = this.requirePrisma();
    const [builtIns, mine, user] = await Promise.all([
      prisma.brandTemplate.findMany({
        where: { isBuiltIn: true, deletedAt: null },
        orderBy: { name: "asc" },
      }),
      prisma.brandTemplate.findMany({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: "desc" },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { defaultBrandTemplateId: true },
      }),
    ]);

    return {
      builtIns: builtIns.map(toSummary),
      mine: mine.map(toSummary),
      defaultId: user?.defaultBrandTemplateId ?? null,
    };
  }

  async get(userId: string, id: string): Promise<BrandTemplateSummary> {
    const prisma = this.requirePrisma();
    const template = await prisma.brandTemplate.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [{ isBuiltIn: true }, { userId }],
      },
    });
    if (!template) throw new BrandTemplateNotFoundError();
    return toSummary(template);
  }

  async getRaw(id: string, userId?: string): Promise<BrandTemplate | null> {
    const prisma = this.requirePrisma();
    const template = await prisma.brandTemplate.findFirst({
      where: { id, deletedAt: null },
    });
    if (!template) return null;
    if (!template.isBuiltIn && userId && template.userId !== userId) return null;
    return template;
  }

  async create(
    userId: string,
    input: BrandTemplateInput,
  ): Promise<BrandTemplateSummary> {
    const parsed = brandTemplateInputSchema.parse(input);
    const captionPreset = applyBrandColorsToCaption(
      parsed.captionPreset,
      parsed.primaryColor,
      parsed.secondaryColor,
    );

    const prisma = this.requirePrisma();
    const template = await prisma.brandTemplate.create({
      data: {
        userId,
        name: parsed.name,
        isBuiltIn: false,
        captionPreset: captionPreset as unknown as PrismaTypes.InputJsonValue,
        logoStorageKey: parsed.logoStorageKey ?? null,
        logoPosition: parsed.logoPosition,
        logoOpacity: parsed.logoOpacity,
        logoScalePct: parsed.logoScalePct,
        primaryColor: parsed.primaryColor,
        secondaryColor: parsed.secondaryColor,
        accentColor: parsed.accentColor ?? null,
      },
    });
    return toSummary(template);
  }

  async update(
    userId: string,
    id: string,
    input: BrandTemplateUpdate,
  ): Promise<BrandTemplateSummary> {
    const parsed = brandTemplateUpdateSchema.parse(input);
    const prisma = this.requirePrisma();

    const existing = await prisma.brandTemplate.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new BrandTemplateNotFoundError();
    if (existing.isBuiltIn || existing.userId !== userId) {
      throw new BrandTemplateForbiddenError();
    }

    const data: PrismaTypes.BrandTemplateUpdateInput = {};
    if (parsed.name !== undefined) data.name = parsed.name;
    if (parsed.logoStorageKey !== undefined) {
      data.logoStorageKey = parsed.logoStorageKey;
    }
    if (parsed.logoPosition !== undefined) data.logoPosition = parsed.logoPosition;
    if (parsed.logoOpacity !== undefined) data.logoOpacity = parsed.logoOpacity;
    if (parsed.logoScalePct !== undefined) data.logoScalePct = parsed.logoScalePct;
    if (parsed.primaryColor !== undefined) data.primaryColor = parsed.primaryColor;
    if (parsed.secondaryColor !== undefined) {
      data.secondaryColor = parsed.secondaryColor;
    }
    if (parsed.accentColor !== undefined) data.accentColor = parsed.accentColor;

    const nextPrimary = parsed.primaryColor ?? existing.primaryColor;
    const nextSecondary = parsed.secondaryColor ?? existing.secondaryColor;
    const baseCaption = parsed.captionPreset
      ? captionPresetSchema.parse(parsed.captionPreset)
      : captionPresetSchema.parse(existing.captionPreset);
    const nextCaption = applyBrandColorsToCaption(
      baseCaption,
      nextPrimary,
      nextSecondary,
    );
    data.captionPreset = nextCaption as unknown as PrismaTypes.InputJsonValue;

    const updated = await prisma.brandTemplate.update({
      where: { id },
      data,
    });

    // If the logo key was replaced or cleared, delete the old object so we
    // don't leak orphan files in R2.
    if (
      parsed.logoStorageKey !== undefined &&
      existing.logoStorageKey &&
      existing.logoStorageKey !== parsed.logoStorageKey
    ) {
      void deleteObject(existing.logoStorageKey).catch(() => {});
    }

    return toSummary(updated);
  }

  async softDelete(userId: string, id: string): Promise<void> {
    const prisma = this.requirePrisma();
    const existing = await prisma.brandTemplate.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new BrandTemplateNotFoundError();
    if (existing.isBuiltIn || existing.userId !== userId) {
      throw new BrandTemplateForbiddenError();
    }

    await prisma.$transaction(async (tx) => {
      await tx.brandTemplate.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await tx.user.updateMany({
        where: { id: userId, defaultBrandTemplateId: id },
        data: { defaultBrandTemplateId: null },
      });
    });

    if (existing.logoStorageKey) {
      void deleteObject(existing.logoStorageKey).catch(() => {});
    }
  }

  async setDefault(userId: string, id: string): Promise<void> {
    const prisma = this.requirePrisma();
    const template = await prisma.brandTemplate.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [{ isBuiltIn: true }, { userId }],
      },
    });
    if (!template) throw new BrandTemplateNotFoundError();

    await prisma.user.update({
      where: { id: userId },
      data: { defaultBrandTemplateId: id },
    });
  }

  async duplicate(
    userId: string,
    id: string,
    newName?: string,
  ): Promise<BrandTemplateSummary> {
    const prisma = this.requirePrisma();
    const source = await prisma.brandTemplate.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [{ isBuiltIn: true }, { userId }],
      },
    });
    if (!source) throw new BrandTemplateNotFoundError();

    const duplicated = await prisma.brandTemplate.create({
      data: {
        userId,
        name: newName?.trim() || `${source.name} (Copy)`,
        isBuiltIn: false,
        captionPreset: source.captionPreset as PrismaTypes.InputJsonValue,
        logoStorageKey: source.logoStorageKey,
        logoPosition: source.logoPosition,
        logoOpacity: source.logoOpacity,
        logoScalePct: source.logoScalePct,
        primaryColor: source.primaryColor,
        secondaryColor: source.secondaryColor,
        accentColor: source.accentColor,
      },
    });
    return toSummary(duplicated);
  }

  async ensureFirstUseDefault(userId: string): Promise<string | null> {
    const prisma = this.requirePrisma();
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { defaultBrandTemplateId: true },
    });
    if (!user) return null;
    if (user.defaultBrandTemplateId) {
      const stillExists = await prisma.brandTemplate.findFirst({
        where: { id: user.defaultBrandTemplateId, deletedAt: null },
        select: { id: true },
      });
      if (stillExists) return user.defaultBrandTemplateId;
    }

    const fallback = await prisma.brandTemplate.findFirst({
      where: { isBuiltIn: true, builtInKey: FALLBACK_BUILT_IN_KEY, deletedAt: null },
      select: { id: true },
    });
    if (!fallback) return null;

    await prisma.user.update({
      where: { id: userId },
      data: { defaultBrandTemplateId: fallback.id },
    });
    return fallback.id;
  }

  async resolveSnapshotForUser(
    userId: string,
    requestedTemplateId: string | null | undefined,
  ): Promise<{ snapshot: BrandTemplateSnapshot; templateId: string } | null> {
    const prisma = this.requirePrisma();

    let templateId: string | null = requestedTemplateId ?? null;
    if (!templateId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { defaultBrandTemplateId: true },
      });
      templateId = user?.defaultBrandTemplateId ?? null;
    }

    if (!templateId) {
      templateId = await this.ensureFirstUseDefault(userId);
    }
    if (!templateId) return null;

    const template = await prisma.brandTemplate.findFirst({
      where: {
        id: templateId,
        deletedAt: null,
        OR: [{ isBuiltIn: true }, { userId }],
      },
    });
    if (!template) return null;

    return { snapshot: this.buildSnapshot(template), templateId: template.id };
  }

  async presignLogoUpload(userId: string, input: PresignBrandLogoInput) {
    const parsed = presignBrandLogoSchema.parse(input);
    if (!isR2Configured()) {
      throw new Error("R2 configuration is missing");
    }
    const ext = parsed.contentType === "image/svg+xml"
      ? "svg"
      : parsed.contentType === "image/png"
        ? "png"
        : parsed.contentType === "image/webp"
          ? "webp"
          : "jpg";

    const key = `brand-templates/${userId}/${randomUUID()}.${ext}`;
    const uploadUrl = await presignSingleUploadUrl({
      key,
      contentType: parsed.contentType,
    });
    return { key, uploadUrl, contentType: parsed.contentType };
  }

  async getLogoDownloadUrl(
    userId: string,
    templateId: string,
  ): Promise<string | null> {
    const template = await this.getRaw(templateId, userId);
    if (!template?.logoStorageKey) return null;
    return presignDownloadUrl({ key: template.logoStorageKey });
  }
}

export const brandTemplateService = new BrandTemplateService();
