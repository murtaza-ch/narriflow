import type { ActorScope } from "./actor-scope";
import { workspaceService } from "./workspace.service";
import { randomUUID } from "node:crypto";
import { Prisma, type BrandTemplate } from "@prisma/client";
import {
  applyBrandColorsToCaption,
  brandTemplateInputSchema,
  brandTemplateSnapshotSchema,
  brandTemplateUpdateSchema,
  brandTitleSchema,
  captionPresetSchema,
  logoPositionSchema,
  presignBrandLogoSchema,
  type BrandTemplateInput,
  type BrandTemplateSnapshot,
  type BrandTemplateSummary,
  type BrandTemplateUpdate,
  type BrandTitle,
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
import { lockBrandOwner } from "./brand-ownership";
import { requirePlanFeature, requireWithinPlanLimit } from "./plan-features";
import { brandFontService } from "./brand-font.service";
import type { IntegrationMutation } from "./operation-receipt";
import { getOperationReceiptExecutor } from "./operation-receipt-runtime";
import { requirePrisma } from "./require-prisma";

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

/** A stored title column: null (none stored, or unreadable) is the built-in default. */
function storedTitle(value: unknown): BrandTitle | null {
  if (value === null || value === undefined) return null;
  const parsed = brandTitleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The title column value to write: SQL NULL for the built-in default. */
function titleColumn(title: BrandTitle | null): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  return title === null ? Prisma.DbNull : (title as unknown as Prisma.InputJsonValue);
}

export type BrandTemplateSnapshotSource = Pick<
  BrandTemplate,
  | "id"
  | "captionPreset"
  | "logoStorageKey"
  | "logoPosition"
  | "logoOpacity"
  | "logoScalePct"
  | "primaryColor"
  | "secondaryColor"
  | "accentColor"
  | "title"
>;

/**
 * The one template snapshot builder. Projects freeze it as `brandSnapshot` and
 * Brand Profiles as `style`; campaign checks compare the two as JSON, so both
 * go through this function and the schema's key order.
 */
export function brandTemplateSnapshot(template: BrandTemplateSnapshotSource): BrandTemplateSnapshot {
  return brandTemplateSnapshotSchema.parse({
    templateId: template.id,
    captionPreset: template.captionPreset,
    logoStorageKey: template.logoStorageKey,
    logoPosition: template.logoPosition,
    logoOpacity: template.logoOpacity,
    logoScalePct: template.logoScalePct,
    primaryColor: template.primaryColor,
    secondaryColor: template.secondaryColor,
    accentColor: template.accentColor,
    title: storedTitle(template.title),
  });
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
    title: storedTitle(template.title),
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
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

  /** Creates a custom template once the Workspace's active custom templates,
   * counted under its lock, leave room on its plan. Built-ins never count.
   * With a `mutation` the row and its Operation Receipt commit together, so a
   * retry with the same key returns the template it already made.
   * `prepare` resolves everything that depends on mutable state (the acting
   * member's plan, a duplicate's source, font selection) from the live actor.
   * With a receipt it runs only for new work, after the replay lookup, so a
   * deleted source or a downgrade since the acceptance cannot hide the replay. */
  private async createCounted(
    prisma: ReturnType<typeof requirePrisma>,
    scope: ActorScope,
    prepare: (
      actor: Awaited<ReturnType<typeof workspaceService.requireActor>>,
      tx: Prisma.TransactionClient,
    ) => Promise<Prisma.BrandTemplateUncheckedCreateInput>,
    receipt?: {
      mutation: IntegrationMutation;
      command: "create_brand_template" | "duplicate_brand_template";
      input: unknown;
    },
  ): Promise<BrandTemplateSummary> {
    const { workspaceId } = scope;
    const createIn = async (tx: Prisma.TransactionClient) => {
      const actor = await workspaceService.requireActor(scope.actorUserId, workspaceId, "brand.manage");
      const data = await prepare(actor, tx);
      await lockBrandOwner(tx, "brand-templates", { userId: null, workspaceId });
      const active = await tx.brandTemplate.count({
        where: { workspaceId, isBuiltIn: false, deletedAt: null },
      });
      requireWithinPlanLimit(actor.pricingTier, "brandTemplates", active);
      return toSummary(await tx.brandTemplate.create({ data }));
    };
    if (!receipt) return prisma.$transaction(createIn);
    const accepted = await getOperationReceiptExecutor().execute({
      identity: {
        workspaceId,
        actorUserId: scope.actorUserId,
        command: receipt.command,
        clientIdempotencyKey: receipt.mutation.clientIdempotencyKey,
      },
      input: receipt.input,
      authorize: async () => {
        await workspaceService.requireActor(scope.actorUserId, workspaceId, "brand.manage");
      },
      beforeAccept: receipt.mutation.beforeAccept,
      mutate: async (tx) => {
        const value = await createIn(tx);
        return { resourceType: "brand_template", resourceId: value.id, value };
      },
    });
    if (accepted.replayed) receipt.mutation.onReplay?.();
    return accepted.value;
  }

  buildSnapshot(template: BrandTemplateSnapshotSource): BrandTemplateSnapshot {
    return brandTemplateSnapshot(template);
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
    mutation?: IntegrationMutation,
  ): Promise<BrandTemplateSummary> {
    const parsed = brandTemplateInputSchema.parse(input);
    const prisma = this.requirePrisma();
    return this.createCounted(prisma, scope, async (actor) => {
      const assetOwnerUserId = actor.workspaceOwnerUserId;
      await brandFontService.assertSelection(actor, parsed.captionPreset.fontAsset);
      await brandFontService.assertSelection(actor, parsed.title?.style.fontAsset);
      assertOwnedLogoKey(assetOwnerUserId, parsed.logoStorageKey, scope);
      const captionPreset = applyBrandColorsToCaption(
        parsed.captionPreset,
        parsed.primaryColor,
        parsed.secondaryColor,
      );
      requirePlanFeature(actor.pricingTier, "brand.customTemplates");
      return {
        userId: assetOwnerUserId,
        workspaceId: scope.workspaceId,
        createdByUserId: scope.actorUserId,
        updatedByUserId: scope.actorUserId,
        name: parsed.name,
        isBuiltIn: false,
        captionPreset: captionPreset as unknown as Prisma.InputJsonValue,
        logoStorageKey: parsed.logoStorageKey ?? null,
        logoPosition: parsed.logoPosition,
        logoOpacity: parsed.logoOpacity,
        logoScalePct: parsed.logoScalePct,
        primaryColor: parsed.primaryColor,
        secondaryColor: parsed.secondaryColor,
        accentColor: parsed.accentColor ?? null,
        title: titleColumn(parsed.title ?? null),
      };
    }, mutation && { mutation, command: "create_brand_template", input: parsed });
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
    requirePlanFeature(actor.pricingTier, "brand.customTemplates");
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

    if (parsed.captionPreset?.fontAsset && JSON.stringify(parsed.captionPreset.fontAsset) !== JSON.stringify(captionPresetSchema.parse(existing.captionPreset).fontAsset)) {
      await brandFontService.assertSelection(actor, parsed.captionPreset.fontAsset);
    }
    // The title's uploaded font, when it changes (a stored one may since have been deleted; it then draws its family).
    const titleFont = parsed.title?.style.fontAsset;
    if (titleFont && JSON.stringify(titleFont) !== JSON.stringify(storedTitle(existing.title)?.style.fontAsset ?? null)) {
      await brandFontService.assertSelection(actor, titleFont);
    }

    const data: Prisma.BrandTemplateUpdateInput = { updatedByUserId: scope.actorUserId };
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
    if (parsed.title !== undefined) data.title = titleColumn(parsed.title);

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
    data.captionPreset = nextCaption as unknown as Prisma.InputJsonValue;

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
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "workspace.manage");
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
    if (!template.isBuiltIn) requirePlanFeature(actor.pricingTier, "brand.customTemplates");

    await prisma.workspace.update({ where: { id: context.workspaceId }, data: { defaultBrandTemplateId: id } });
  }

  async duplicate(
    scope: ActorScope,
    id: string,
    newName?: string,
    mutation?: IntegrationMutation,
  ): Promise<BrandTemplateSummary> {
    const prisma = this.requirePrisma();
    return this.createCounted(prisma, scope, async (actor, tx) => {
      requirePlanFeature(actor.pricingTier, "brand.customTemplates");
      const source = await tx.brandTemplate.findFirst({
        where: {
          id,
          deletedAt: null,
          OR: [{ isBuiltIn: true }, { workspaceId: scope.workspaceId }],
        },
      });
      if (!source) throw new BrandTemplateNotFoundError();
      return {
        userId: actor.workspaceOwnerUserId,
        workspaceId: scope.workspaceId,
        createdByUserId: scope.actorUserId,
        updatedByUserId: scope.actorUserId,
        name: newName?.trim() || `${source.name} (Copy)`,
        isBuiltIn: false,
        captionPreset: source.captionPreset as Prisma.InputJsonValue,
        logoStorageKey: source.logoStorageKey,
        logoPosition: source.logoPosition,
        logoOpacity: source.logoOpacity,
        logoScalePct: source.logoScalePct,
        primaryColor: source.primaryColor,
        secondaryColor: source.secondaryColor,
        accentColor: source.accentColor,
        title: titleColumn(storedTitle(source.title)),
      };
    }, mutation && { mutation, command: "duplicate_brand_template", input: { sourceId: id, name: newName?.trim() || null } });
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
    context: BrandWorkspaceContext,
  ): Promise<{ snapshot: BrandTemplateSnapshot; templateId: string } | null> {
    const prisma = this.requirePrisma();
    const workspace = await prisma.workspace.findUnique({
      where: { id: context.workspaceId },
      select: { defaultBrandTemplateId: true, pricingTier: true },
    });

    let templateId: string | null = requestedTemplateId ?? workspace?.defaultBrandTemplateId ?? null;

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
    // A custom template, requested or the Workspace default, is applied only
    // on a plan that includes custom templates; built-ins are free.
    if (!template.isBuiltIn) requirePlanFeature(workspace?.pricingTier, "brand.customTemplates");

    return { snapshot: this.buildSnapshot(template), templateId: template.id };
  }

  async presignLogoUpload(scope: ActorScope, input: PresignBrandLogoInput) {
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "brand.manage");
    requirePlanFeature(actor.pricingTier, "brand.customTemplates");
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
