import type { ActorScope } from "./actor-scope";
import { workspaceService } from "./workspace.service";
import { randomUUID } from "node:crypto";
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
  type PresignBrandLogoInput,
} from "@narriflow/validators";
import {
  isR2Configured,
  presignDownloadUrl,
  presignSingleUploadUrl,
} from "./r2-storage";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

const FALLBACK_BUILT_IN_KEY = "karaoke";

type BrandWorkspaceContext = { workspaceId: string; actorUserId: string };

const brandTemplateFailureCatalog = {
  brand_template_not_found: "missing",
  brand_template_forbidden: "forbidden",
	brand_template_storage_unavailable: "unavailable",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type BrandTemplateFailureCode = keyof typeof brandTemplateFailureCatalog;

export class BrandTemplateError extends ExpectedDomainFailureError<BrandTemplateFailureCode> {
  constructor(code: BrandTemplateFailureCode, message: string) {
    super({ code, kind: brandTemplateFailureCatalog[code], message });
    this.name = "BrandTemplateError";
  }
}

function ownedTemplateWhere(userId: string, context?: BrandWorkspaceContext) {
  return context ? { workspaceId: context.workspaceId } : { userId };
}

export class BrandTemplateNotFoundError extends ExpectedDomainFailureError<"brand_template_not_found"> {
  constructor() {
    const code = "brand_template_not_found" satisfies BrandTemplateFailureCode;
    super({ code, kind: brandTemplateFailureCatalog[code], message: "Brand template not found" });
    this.name = "BrandTemplateNotFoundError";
  }
}

export class BrandTemplateForbiddenError extends ExpectedDomainFailureError<"brand_template_forbidden"> {
  constructor() {
    const code = "brand_template_forbidden" satisfies BrandTemplateFailureCode;
    super({ code, kind: brandTemplateFailureCatalog[code], message: "Brand template is read-only" });
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

/**
 * A client-supplied logo key must live under the caller's own presign prefix
 * (`brand-templates/{userId}/`). Without this, a user could point a template at
 * another tenant's R2 object and exfiltrate it via the logo download URL.
 */
function assertOwnedLogoKey(userId: string, key: string | null | undefined, context?: BrandWorkspaceContext) {
  if (!key) return;
  const prefix = context
    ? `workspaces/${context.workspaceId}/brand-templates/`
    : `brand-templates/${userId}/`;
  if (!key.startsWith(prefix)) {
    throw new BrandTemplateForbiddenError();
  }
}

/**
 * Brand-logo objects are immutable shared media references. A duplicate or a
 * persisted project brand snapshot may keep using an old key after its source
 * template is updated or soft-deleted, so those operations retain the object.
 * A future storage GC must inventory active/deleted templates and every project
 * snapshot, then apply a grace period before deleting an unreferenced logo.
 */

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

  async list(scope: ActorScope): Promise<{
    builtIns: BrandTemplateSummary[];
    mine: BrandTemplateSummary[];
    defaultId: string | null;
  }> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
    const prisma = this.requirePrisma();
    const [builtIns, mine, user] = await Promise.all([
      prisma.brandTemplate.findMany({
        where: { isBuiltIn: true, deletedAt: null },
        orderBy: { name: "asc" },
      }),
      prisma.brandTemplate.findMany({
        where: { workspaceId: scope.workspaceId, deletedAt: null },
        orderBy: { createdAt: "desc" },
      }),
      prisma.workspace.findUnique({ where: { id: scope.workspaceId }, select: { defaultBrandTemplateId: true } }),
    ]);

    return {
      builtIns: builtIns.map(toSummary),
      mine: mine.map(toSummary),
      defaultId: user?.defaultBrandTemplateId ?? null,
    };
  }

  async get(scope: ActorScope, id: string): Promise<BrandTemplateSummary> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
    const prisma = this.requirePrisma();
    const template = await prisma.brandTemplate.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [{ isBuiltIn: true }, { workspaceId: scope.workspaceId }],
      },
    });
    if (!template) throw new BrandTemplateNotFoundError();
    return toSummary(template);
  }

  // Runtime readers supply explicit asset ownership facts after actor admission.
  async getRaw(id: string, userId: string, context?: BrandWorkspaceContext): Promise<BrandTemplate | null> {
    const prisma = this.requirePrisma();
    const template = await prisma.brandTemplate.findFirst({
      where: { id, deletedAt: null },
    });
    if (!template) return null;
    if (!template.isBuiltIn) {
      if (context ? template.workspaceId !== context.workspaceId : template.userId !== userId) return null;
    }
    return template;
  }

  async create(
    scope: ActorScope,
    input: BrandTemplateInput,
  ): Promise<BrandTemplateSummary> {
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "brand.manage");
    const assetOwnerUserId = actor.workspaceOwnerUserId;
    const context = scope;
    const parsed = brandTemplateInputSchema.parse(input);
    assertOwnedLogoKey(assetOwnerUserId, parsed.logoStorageKey, context);
    const captionPreset = applyBrandColorsToCaption(
      parsed.captionPreset,
      parsed.primaryColor,
      parsed.secondaryColor,
    );

    const prisma = this.requirePrisma();
    const template = await prisma.brandTemplate.create({
      data: {
        userId: assetOwnerUserId,
        workspaceId: scope.workspaceId,
        createdByUserId: scope.actorUserId,
        updatedByUserId: scope.actorUserId,
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
    scope: ActorScope,
    id: string,
    input: BrandTemplateUpdate,
  ): Promise<BrandTemplateSummary> {
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "brand.manage");
    const assetOwnerUserId = actor.workspaceOwnerUserId;
    const context = scope;
    const parsed = brandTemplateUpdateSchema.parse(input);
    const prisma = this.requirePrisma();

    const existing = await prisma.brandTemplate.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new BrandTemplateNotFoundError();
    if (
      existing.isBuiltIn ||
      existing.workspaceId !== scope.workspaceId
    ) {
      throw new BrandTemplateForbiddenError();
    }

    const data: PrismaTypes.BrandTemplateUpdateInput = { updatedByUserId: scope.actorUserId };
    if (parsed.name !== undefined) data.name = parsed.name;
    if (parsed.logoStorageKey !== undefined) {
      assertOwnedLogoKey(assetOwnerUserId, parsed.logoStorageKey, context);
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

    return toSummary(updated);
  }

  async softDelete(scope: ActorScope, id: string): Promise<void> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "brand.manage");
    const prisma = this.requirePrisma();
    const existing = await prisma.brandTemplate.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new BrandTemplateNotFoundError();
    if (
      existing.isBuiltIn ||
      existing.workspaceId !== scope.workspaceId
    ) {
      throw new BrandTemplateForbiddenError();
    }

    await prisma.$transaction(async (tx) => {
      await tx.brandTemplate.update({
        where: { id },
        data: { deletedAt: new Date(), updatedByUserId: scope.actorUserId },
      });
      await tx.workspace.updateMany({
        where: { id: scope.workspaceId, defaultBrandTemplateId: id },
        data: { defaultBrandTemplateId: null },
      });
    });
  }

  async setDefault(scope: ActorScope, id: string): Promise<void> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "workspace.manage");
    const context = scope;
    const prisma = this.requirePrisma();
    const template = await prisma.brandTemplate.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [{ isBuiltIn: true }, { workspaceId: scope.workspaceId }],
      },
    });
    if (!template) throw new BrandTemplateNotFoundError();

      await prisma.workspace.update({ where: { id: context.workspaceId }, data: { defaultBrandTemplateId: id } });
  }

  async duplicate(
    scope: ActorScope,
    id: string,
    newName?: string,
  ): Promise<BrandTemplateSummary> {
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "brand.manage");
    const assetOwnerUserId = actor.workspaceOwnerUserId;
    const prisma = this.requirePrisma();
    const source = await prisma.brandTemplate.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [{ isBuiltIn: true }, { workspaceId: scope.workspaceId }],
      },
    });
    if (!source) throw new BrandTemplateNotFoundError();

    const duplicated = await prisma.brandTemplate.create({
      data: {
        userId: assetOwnerUserId,
        workspaceId: scope.workspaceId,
        createdByUserId: scope.actorUserId,
        updatedByUserId: scope.actorUserId,
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

  async ensureFirstUseDefault(userId: string, context?: BrandWorkspaceContext): Promise<string | null> {
    const prisma = this.requirePrisma();
    const owner = context
      ? await prisma.workspace.findUnique({ where: { id: context.workspaceId }, select: { defaultBrandTemplateId: true } })
      : await prisma.user.findUnique({ where: { id: userId }, select: { defaultBrandTemplateId: true } });
    if (!owner) return null;
    if (owner.defaultBrandTemplateId) {
      const stillExists = await prisma.brandTemplate.findFirst({
        where: { id: owner.defaultBrandTemplateId, deletedAt: null },
        select: { id: true },
      });
      if (stillExists) return owner.defaultBrandTemplateId;
    }

    const fallback = await prisma.brandTemplate.findFirst({
      where: { isBuiltIn: true, builtInKey: FALLBACK_BUILT_IN_KEY, deletedAt: null },
      select: { id: true },
    });
    if (!fallback) return null;

    if (context) {
      await prisma.workspace.update({ where: { id: context.workspaceId }, data: { defaultBrandTemplateId: fallback.id } });
    } else {
      await prisma.user.update({ where: { id: userId }, data: { defaultBrandTemplateId: fallback.id } });
    }
    return fallback.id;
  }

  async resolveSnapshotForUser(
    userId: string,
    requestedTemplateId: string | null | undefined,
    context?: BrandWorkspaceContext,
  ): Promise<{ snapshot: BrandTemplateSnapshot; templateId: string } | null> {
    const prisma = this.requirePrisma();

    let templateId: string | null = requestedTemplateId ?? null;
    if (!templateId) {
      const owner = context
        ? await prisma.workspace.findUnique({ where: { id: context.workspaceId }, select: { defaultBrandTemplateId: true } })
        : await prisma.user.findUnique({ where: { id: userId }, select: { defaultBrandTemplateId: true } });
      templateId = owner?.defaultBrandTemplateId ?? null;
    }

    if (!templateId) {
      templateId = await this.ensureFirstUseDefault(userId, context);
    }
    if (!templateId) return null;

    const template = await prisma.brandTemplate.findFirst({
      where: {
        id: templateId,
        deletedAt: null,
        OR: [{ isBuiltIn: true }, ownedTemplateWhere(userId, context)],
      },
    });
    if (!template) return null;

    return { snapshot: this.buildSnapshot(template), templateId: template.id };
  }

  async presignLogoUpload(scope: ActorScope, input: PresignBrandLogoInput) {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "brand.manage");
    const parsed = presignBrandLogoSchema.parse(input);
    if (!isR2Configured()) {
      throw new BrandTemplateError(
        "brand_template_storage_unavailable",
        "Brand template storage is temporarily unavailable",
      );
    }
    const ext = parsed.contentType === "image/svg+xml"
      ? "svg"
      : parsed.contentType === "image/png"
        ? "png"
        : parsed.contentType === "image/webp"
          ? "webp"
          : "jpg";

    const key = `workspaces/${scope.workspaceId}/brand-templates/${randomUUID()}.${ext}`;
    const uploadUrl = await presignSingleUploadUrl({
      key,
      contentType: parsed.contentType,
    });
    return { key, uploadUrl, contentType: parsed.contentType };
  }

  async getLogoDownloadUrl(
    scope: ActorScope,
    templateId: string,
  ): Promise<string | null> {
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
    const assetOwnerUserId = actor.workspaceOwnerUserId;
    const context = scope;
    const template = await this.getRaw(templateId, assetOwnerUserId, context);
    if (!template?.logoStorageKey) return null;
    return presignDownloadUrl({ key: template.logoStorageKey });
  }
}

export const brandTemplateService = new BrandTemplateService();
