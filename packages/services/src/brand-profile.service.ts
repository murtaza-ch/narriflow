import { Prisma, type BrandProfile, type BrandTemplate } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  brandProfileCreateSchema,
  brandProfileListSchema,
  brandProfileMembershipSchema,
  brandProfileSoftDeleteSchema,
  brandProfileUpdateSchema,
  brandTemplateSnapshotSchema,
  brandVisualIdentitySchema,
  brandVoiceGuidanceSchema,
  resolvePricingTier,
  type BrandProfileCreateInput,
  type BrandProfileListInput,
  type BrandProfileMembershipInput,
  type BrandProfileSoftDeleteInput,
  type BrandProfileUpdateInput,
  type BrandVisualIdentity,
  type BrandTemplateSnapshot,
} from "@narriflow/validators";
import {
  assertBrandApplicationAllowed,
  assertBrandMutationAllowedWithAnalytics,
  brandOwnerWhere,
  resolveBrandOwner,
  type BrandActorScope,
} from "./brand-ownership";
import { analyticsService } from "./analytics.service";
import { assertProgramWriteEnabled } from "./program-rollout";
import { headObject, presignDownloadUrl } from "./r2-storage";

export class BrandProfileNotFoundError extends Error {
  readonly code = "brand_profile_not_found";
  constructor() {
    super("Brand Profile not found");
    this.name = "BrandProfileNotFoundError";
  }
}

export class BrandProfileConflictError extends Error {
  readonly code = "brand_profile_conflict";
  constructor(message = "This Brand Profile changed in another session") {
    super(message);
    this.name = "BrandProfileConflictError";
  }
}

export class BrandProfileReferenceError extends Error {
  readonly code = "brand_profile_is_default";
  constructor() {
    super("Choose a different default Brand Profile before deleting this one");
    this.name = "BrandProfileReferenceError";
  }
}

export class BrandProfileMembershipError extends Error {
  readonly code = "brand_profile_membership_invalid";
  constructor() {
    super("The selected resource does not belong to this Brand Profile owner");
    this.name = "BrandProfileMembershipError";
  }
}

export class BrandProfileMissingAssetError extends Error {
  readonly code = "brand_profile_asset_missing";
  constructor() {
    super("Replace missing Brand Profile assets before applying this profile");
    this.name = "BrandProfileMissingAssetError";
  }
}

type SnapshotProfile = Pick<
  BrandProfile,
  "id" | "name" | "revision" | "visualIdentity" | "voiceGuidance" | "approvalRule"
> | {
  id: string;
  name: string;
  revision: number;
  visualIdentity: unknown;
  voiceGuidance: unknown;
  approvalRule: string;
};

type SnapshotTemplate = Pick<
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
>;

function templateSnapshot(template: SnapshotTemplate): BrandTemplateSnapshot {
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
  });
}

export function buildBrandProfileSnapshot(
  profile: SnapshotProfile,
  template: SnapshotTemplate | null,
) {
  return {
    version: 1 as const,
    profileId: profile.id,
    profileRevision: profile.revision,
    name: profile.name,
    identity: brandVisualIdentitySchema.parse(profile.visualIdentity),
    voice: brandVoiceGuidanceSchema.parse(profile.voiceGuidance),
    approvalRule: profile.approvalRule,
    style: template ? templateSnapshot(template) : null,
  };
}

export function resolveProfileStyleSelection(input: {
  requestedTemplateId: string | null;
  defaultTemplateId: string | null;
  memberTemplateIds: string[];
}): string | null {
  const selected = input.requestedTemplateId ?? input.defaultTemplateId;
  if (!selected) return null;
  if (!input.memberTemplateIds.includes(selected)) throw new BrandProfileMembershipError();
  return selected;
}

export function compatibilityProfileSlug() {
  return "migrated-brand-kit";
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

const profileInclude = {
  templates: { orderBy: { position: "asc" as const }, include: { template: true } },
  assets: { orderBy: { position: "asc" as const }, include: { asset: true } },
  fonts: { orderBy: { position: "asc" as const }, include: { font: true } },
  audio: { orderBy: { position: "asc" as const }, include: { audio: true } },
} satisfies Prisma.BrandProfileInclude;

type ProfileAggregate = Prisma.BrandProfileGetPayload<{ include: typeof profileInclude }>;

async function requireOwnedLogoAssets(
  tx: Prisma.TransactionClient,
  scope: BrandActorScope,
  identity: BrandVisualIdentity,
) {
  const assetIds = [
    identity.primaryLogoAssetId,
    identity.alternateLogoAssetId,
  ].filter((id): id is string => Boolean(id));
  if (assetIds.length === 0) return [];
  const uniqueIds = [...new Set(assetIds)];
  const owned = await tx.visualAsset.findMany({
    where: {
      id: { in: uniqueIds },
      ...brandOwnerWhere(scope),
      deletedAt: null,
      kind: "image",
    },
    select: { id: true },
  });
  if (owned.length !== uniqueIds.length) throw new BrandProfileMembershipError();
  return uniqueIds;
}

async function recordBrandEvent(
  scope: BrandActorScope,
  input: Parameters<typeof analyticsService.recordBrandProgramEvent>[0],
) {
  await analyticsService.recordBrandProgramEvent(input).catch(() => {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "brand_program_analytics_record_failed",
        workspaceId: scope.workspaceId,
        eventType: input.type,
      }),
    );
  });
}

async function brandObjectExists(key: string) {
  try {
    await headObject(key);
    return true;
  } catch {
    return false;
  }
}

async function safeAccessUrl(key: string) {
  try {
    if (!(await brandObjectExists(key))) return null;
    return await presignDownloadUrl({ key });
  } catch {
    return null;
  }
}

async function toAggregate(profile: ProfileAggregate) {
  return {
    id: profile.id,
    name: profile.name,
    slug: profile.slug,
    revision: profile.revision,
    identity: brandVisualIdentitySchema.parse(profile.visualIdentity),
    voice: brandVoiceGuidanceSchema.parse(profile.voiceGuidance),
    approvalRule: profile.approvalRule as "none" | "approval_required",
    defaultTemplateId: profile.defaultTemplateId,
    isCompatibility: profile.isCompatibility,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
    templates: profile.templates.map(({ template, position }) => ({
      id: template.id,
      name: template.name,
      position,
      isBuiltIn: template.isBuiltIn,
      primaryColor: template.primaryColor,
      secondaryColor: template.secondaryColor,
      accentColor: template.accentColor,
    })),
    assets: await Promise.all(
      profile.assets
        .filter(({ asset }) => !asset.deletedAt)
        .map(async ({ asset, role, position }) => {
          const accessUrl = await safeAccessUrl(asset.storageKey);
          return {
            id: asset.id,
            title: asset.title,
            kind: asset.kind,
            role,
            position,
            width: asset.width,
            height: asset.height,
            fingerprint: asset.fingerprint,
            accessUrl,
            missing: accessUrl === null,
          };
        }),
    ),
    fonts: await Promise.all(
      profile.fonts
        .filter(({ font }) => !font.deletedAt)
        .map(async ({ font, role, position }) => {
          const accessUrl = await safeAccessUrl(font.storageKey);
          return {
            id: font.id,
            family: font.family,
            style: font.style,
            weight: font.weight,
            role,
            position,
            fingerprint: font.fingerprint,
            accessUrl,
            missing: accessUrl === null,
          };
        }),
    ),
    audio: profile.audio.filter(({ audio }) => !audio.deletedAt).map(({ audio, position }) => ({
      id: audio.id,
      title: audio.title,
      kind: audio.kind,
      position,
      durationSec: audio.durationSec,
    })),
  };
}

export class BrandProfileService {
  private requirePrisma = requirePrisma;
  private objectExists = brandObjectExists;

  async list(scope: BrandActorScope, input?: BrandProfileListInput) {
    const parsed = brandProfileListSchema.parse(input ?? {});
    const prisma = this.requirePrisma();
    const rows = await prisma.brandProfile.findMany({
      where: {
        ...brandOwnerWhere(scope),
        ...(parsed.includeDeleted ? {} : { deletedAt: null }),
        ...(parsed.query ? { name: { contains: parsed.query, mode: "insensitive" } } : {}),
      },
      include: profileInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: parsed.limit,
      ...(parsed.cursor ? { cursor: { id: parsed.cursor }, skip: 1 } : {}),
    });
    return Promise.all(rows.map(toAggregate));
  }

  async getDefaultId(scope: BrandActorScope) {
    const prisma = this.requirePrisma();
    const owner = resolveBrandOwner(scope);
    if (owner.workspaceId) {
      return (await prisma.workspace.findUnique({ where: { id: owner.workspaceId }, select: { defaultBrandProfileId: true } }))?.defaultBrandProfileId ?? null;
    }
    return (await prisma.user.findUnique({ where: { id: owner.userId! }, select: { defaultBrandProfileId: true } }))?.defaultBrandProfileId ?? null;
  }

  async get(scope: BrandActorScope, id: string) {
    const prisma = this.requirePrisma();
    const profile = await prisma.brandProfile.findFirst({ where: { id, ...brandOwnerWhere(scope), deletedAt: null }, include: profileInclude });
    if (!profile) throw new BrandProfileNotFoundError();
    return toAggregate(profile);
  }

  async create(scope: BrandActorScope, input: BrandProfileCreateInput) {
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.profiles", "profile");
    const parsed = brandProfileCreateSchema.parse(input);
    const prisma = this.requirePrisma();
    const owner = resolveBrandOwner(scope);
    const created = await prisma.$transaction(async (tx) => {
      const identity = parsed.identity ?? brandVisualIdentitySchema.parse({});
      const logoAssetIds = await requireOwnedLogoAssets(tx, scope, identity);
      let template: BrandTemplate | null = null;
      if (parsed.defaultTemplateId) {
        template = await tx.brandTemplate.findFirst({ where: { id: parsed.defaultTemplateId, isBuiltIn: false, deletedAt: null, OR: [{ workspaceId: scope.workspaceId }, { userId: scope.workspaceOwnerUserId }] } });
        if (!template) throw new BrandProfileMembershipError();
      }
      const profile = await tx.brandProfile.create({ data: {
        ...owner,
        createdByUserId: scope.actorUserId,
        updatedByUserId: scope.actorUserId,
        name: parsed.name,
        slug: parsed.slug,
        visualIdentity: identity as Prisma.InputJsonValue,
        voiceGuidance: (parsed.voice ?? brandVoiceGuidanceSchema.parse({})) as Prisma.InputJsonValue,
        approvalRule: parsed.approvalRule,
        defaultTemplateId: template?.id ?? null,
      } });
      if (template) await tx.brandProfileTemplate.create({ data: { profileId: profile.id, templateId: template.id, position: 0 } });
      if (logoAssetIds.length) {
        await tx.brandProfileAsset.createMany({
          data: logoAssetIds.map((assetId, position) => ({
            profileId: profile.id,
            assetId,
            role: "logo" as const,
            position,
          })),
        });
      }
      return profile;
    });
    const aggregate = await this.get(scope, created.id);
    await recordBrandEvent(scope, {
      type: "brand_profile_created",
      workspaceId: scope.workspaceId,
      actorUserId: scope.actorUserId,
      metadata: {
        profileId: created.id,
        assetKind: "profile",
        planTier: resolvePricingTier(scope.pricingTier),
        outcome: "succeeded",
      },
    });
    return aggregate;
  }

  async update(scope: BrandActorScope, id: string, input: BrandProfileUpdateInput) {
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.profiles", "profile");
    const parsed = brandProfileUpdateSchema.parse(input);
    const prisma = this.requirePrisma();
    const current = await prisma.brandProfile.findFirst({
      where: { id, ...brandOwnerWhere(scope), deletedAt: null },
      select: { visualIdentity: true },
    });
    if (!current) throw new BrandProfileNotFoundError();
    const currentIdentity = brandVisualIdentitySchema.parse(current.visualIdentity);
    const nextLogoAssetIds = parsed.identity
      ? await requireOwnedLogoAssets(prisma, scope, parsed.identity)
      : null;
    const data: Prisma.BrandProfileUncheckedUpdateManyInput = { updatedByUserId: scope.actorUserId, revision: { increment: 1 } };
    if (parsed.name !== undefined) data.name = parsed.name;
    if (parsed.slug !== undefined) data.slug = parsed.slug;
    if (parsed.identity !== undefined) data.visualIdentity = parsed.identity as Prisma.InputJsonValue;
    if (parsed.voice !== undefined) data.voiceGuidance = parsed.voice as Prisma.InputJsonValue;
    if (parsed.approvalRule !== undefined) data.approvalRule = parsed.approvalRule;
    if (parsed.defaultTemplateId !== undefined) {
      if (parsed.defaultTemplateId) {
        const membership = await prisma.brandProfileTemplate.findFirst({
          where: {
            profileId: id,
            templateId: parsed.defaultTemplateId,
            template: { deletedAt: null },
          },
          select: { id: true },
        });
        if (!membership) throw new BrandProfileMembershipError();
      }
      data.defaultTemplateId = parsed.defaultTemplateId;
    }
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.brandProfile.updateMany({ where: { id, revision: parsed.revision, ...brandOwnerWhere(scope), deletedAt: null }, data });
      if (updated.count === 0 || !nextLogoAssetIds) return updated;
      const priorLogoIds = [
        currentIdentity.primaryLogoAssetId,
        currentIdentity.alternateLogoAssetId,
      ].filter((assetId): assetId is string => Boolean(assetId));
      const removedIds = priorLogoIds.filter((assetId) => !nextLogoAssetIds.includes(assetId));
      if (removedIds.length) {
        await tx.brandProfileAsset.deleteMany({
          where: { profileId: id, assetId: { in: removedIds }, role: "logo" },
        });
      }
      for (const [position, assetId] of nextLogoAssetIds.entries()) {
        await tx.brandProfileAsset.upsert({
          where: { profileId_assetId: { profileId: id, assetId } },
          create: { profileId: id, assetId, role: "logo", position },
          update: { role: "logo", position },
        });
      }
      return updated;
    });
    if (result.count === 0) {
      const exists = await prisma.brandProfile.count({ where: { id, ...brandOwnerWhere(scope), deletedAt: null } });
      if (!exists) throw new BrandProfileNotFoundError();
      throw new BrandProfileConflictError();
    }
    return this.get(scope, id);
  }

  async setMembership(scope: BrandActorScope, profileId: string, input: BrandProfileMembershipInput) {
    await assertBrandMutationAllowedWithAnalytics(
      scope,
      input.kind === "font" ? "brand.customFonts" : "brand.profiles",
      input.kind === "font" ? "font" : "profile",
    );
    const parsed = brandProfileMembershipSchema.parse(input);
    const prisma = this.requirePrisma();
    await prisma.$transaction(async (tx) => {
      const profile = await tx.brandProfile.findFirst({ where: { id: profileId, ...brandOwnerWhere(scope), deletedAt: null }, select: { id: true } });
      if (!profile) throw new BrandProfileNotFoundError();
      const owner = brandOwnerWhere(scope);
      if (parsed.kind === "template") {
        const resource = await tx.brandTemplate.findFirst({ where: { id: parsed.resourceId, isBuiltIn: false, deletedAt: null, OR: [{ workspaceId: scope.workspaceId }, { userId: scope.workspaceOwnerUserId }] }, select: { id: true } });
        if (!resource) throw new BrandProfileMembershipError();
        await tx.brandProfileTemplate.upsert({ where: { templateId: resource.id }, create: { profileId, templateId: resource.id, position: parsed.position }, update: { profileId, position: parsed.position } });
      } else if (parsed.kind === "asset") {
        const resource = await tx.visualAsset.findFirst({ where: { id: parsed.resourceId, ...owner, deletedAt: null }, select: { id: true } });
        if (!resource) throw new BrandProfileMembershipError();
        await tx.brandProfileAsset.upsert({ where: { profileId_assetId: { profileId, assetId: resource.id } }, create: { profileId, assetId: resource.id, role: parsed.role, position: parsed.position }, update: { role: parsed.role, position: parsed.position } });
      } else if (parsed.kind === "font") {
        const resource = await tx.brandFont.findFirst({ where: { id: parsed.resourceId, ...owner, deletedAt: null }, select: { id: true } });
        if (!resource) throw new BrandProfileMembershipError();
        await tx.brandProfileFont.upsert({ where: { profileId_role: { profileId, role: parsed.role } }, create: { profileId, fontId: resource.id, role: parsed.role, position: parsed.position }, update: { fontId: resource.id, position: parsed.position } });
      } else {
        const resource = await tx.audioAsset.findFirst({ where: { id: parsed.resourceId, deletedAt: null, OR: [{ userId: null }, { workspaceId: scope.workspaceId }, { userId: scope.workspaceOwnerUserId }] }, select: { id: true } });
        if (!resource) throw new BrandProfileMembershipError();
        await tx.brandProfileAudio.upsert({ where: { profileId_audioId: { profileId, audioId: resource.id } }, create: { profileId, audioId: resource.id, position: parsed.position }, update: { position: parsed.position } });
      }
      await tx.brandProfile.update({ where: { id: profileId }, data: { revision: { increment: 1 }, updatedByUserId: scope.actorUserId } });
    });
    return this.get(scope, profileId);
  }

  async setDefault(scope: BrandActorScope, id: string) {
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.profiles", "profile");
    const prisma = this.requirePrisma();
    const profile = await prisma.brandProfile.findFirst({ where: { id, ...brandOwnerWhere(scope), deletedAt: null }, select: { id: true } });
    if (!profile) throw new BrandProfileNotFoundError();
    const owner = resolveBrandOwner(scope);
    if (owner.workspaceId) await prisma.workspace.update({ where: { id: owner.workspaceId }, data: { defaultBrandProfileId: id } });
    else await prisma.user.update({ where: { id: owner.userId! }, data: { defaultBrandProfileId: id } });
  }

  async softDelete(scope: BrandActorScope, id: string, input: BrandProfileSoftDeleteInput) {
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.profiles", "profile");
    const parsed = brandProfileSoftDeleteSchema.parse(input);
    const prisma = this.requirePrisma();
    const profile = await prisma.brandProfile.findFirst({ where: { id, revision: parsed.revision, ...brandOwnerWhere(scope), deletedAt: null }, include: { defaultForUsers: { select: { id: true } }, defaultForWorkspaces: { select: { id: true } } } });
    if (!profile) throw new BrandProfileNotFoundError();
    if (profile.defaultForUsers.length || profile.defaultForWorkspaces.length) throw new BrandProfileReferenceError();
    await prisma.brandProfile.update({ where: { id }, data: { deletedAt: new Date(), revision: { increment: 1 }, updatedByUserId: scope.actorUserId } });
  }

  async resolveForProject(scope: BrandActorScope, input: { profileId: string; templateId?: string | null }) {
    assertProgramWriteEnabled("brand_kit_projection");
    try {
      assertBrandApplicationAllowed(scope);
    } catch (error) {
      await recordBrandEvent(scope, {
        type: "brand_premium_mutation_blocked",
        workspaceId: scope.workspaceId,
        actorUserId: scope.actorUserId,
        metadata: {
          profileId: input.profileId,
          assetKind: "profile",
          planTier: resolvePricingTier(scope.pricingTier),
          outcome: "blocked",
        },
      });
      throw error;
    }
    const prisma = this.requirePrisma();
    const profile = await prisma.brandProfile.findFirst({ where: { id: input.profileId, ...brandOwnerWhere(scope), deletedAt: null }, include: { templates: { include: { template: true } } } });
    if (!profile) throw new BrandProfileNotFoundError();
    const identity = brandVisualIdentitySchema.parse(profile.visualIdentity);
    const logoAssetIds = [
      identity.primaryLogoAssetId,
      identity.alternateLogoAssetId,
    ].filter((assetId): assetId is string => Boolean(assetId));
    if (logoAssetIds.length > 0) {
      const assets = await prisma.visualAsset.findMany({
        where: {
          id: { in: [...new Set(logoAssetIds)] },
          ...brandOwnerWhere(scope),
          deletedAt: null,
          kind: "image",
        },
        select: { storageKey: true },
      });
      if (
        assets.length !== new Set(logoAssetIds).size ||
        (await Promise.all(
          assets.map((asset) => this.objectExists(asset.storageKey)),
        )).some((exists) => !exists)
      ) {
        throw new BrandProfileMissingAssetError();
      }
    }
    const selectedId = resolveProfileStyleSelection({ requestedTemplateId: input.templateId ?? null, defaultTemplateId: profile.defaultTemplateId, memberTemplateIds: profile.templates.map((membership) => membership.templateId) });
    const selected = selectedId ? profile.templates.find((membership) => membership.templateId === selectedId)?.template ?? null : null;
    return {
      profileId: profile.id,
      profileSnapshot: buildBrandProfileSnapshot(profile, selected),
      templateId: selected?.id ?? null,
      templateSnapshot: selected ? templateSnapshot(selected) : null,
    };
  }

  async applyToProject(
    scope: BrandActorScope,
    projectId: string,
    input: { profileId: string; templateId?: string | null },
  ) {
    const resolved = await this.resolveForProject(scope, input);
    const prisma = this.requirePrisma();
    await prisma.$transaction(async (tx) => {
      const updated = await tx.project.updateMany({
        where: {
          id: projectId,
          workspaceId: scope.workspaceId,
        },
        data: {
          brandProfileId: resolved.profileId,
          brandProfileSnapshot: resolved.profileSnapshot as Prisma.InputJsonValue,
          brandTemplateId: resolved.templateId,
          brandSnapshot: resolved.templateSnapshot
            ? (resolved.templateSnapshot as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          updatedByUserId: scope.actorUserId,
        },
      });
      if (updated.count === 0) throw new BrandProfileNotFoundError();
      await tx.programAnalyticsEvent.create({
        data: {
          workspaceId: scope.workspaceId,
          actorUserId: scope.actorUserId,
          projectId,
          type: "brand_profile_applied",
          metadata: {
            profileId: resolved.profileId,
            ...(resolved.templateId ? { templateId: resolved.templateId } : {}),
            assetKind: "profile",
            planTier: resolvePricingTier(scope.pricingTier),
            outcome: "succeeded",
          },
        },
      });
    });
    return resolved;
  }

  async resolveProfileForTemplate(scope: BrandActorScope, templateId: string) {
    const prisma = this.requirePrisma();
    const membership = await prisma.brandProfileTemplate.findFirst({ where: { templateId, profile: { ...brandOwnerWhere(scope), deletedAt: null } }, select: { profileId: true } });
    return membership?.profileId ?? null;
  }

  async backfillCompatibilityProfiles(input: { cursor?: string; batchSize?: number; observe?: boolean } = {}) {
    const prisma = this.requirePrisma();
    const batchSize = Math.max(1, Math.min(500, input.batchSize ?? 100));
    const templates = await prisma.brandTemplate.findMany({
      where: { isBuiltIn: false, deletedAt: null },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      include: {
        workspace: { select: { ownerUserId: true, personalOwnerUserId: true, defaultBrandTemplateId: true } },
        user: { select: { defaultBrandTemplateId: true } },
      },
    });
    if (input.observe) {
      return { processedTemplates: templates.length, attachedTemplates: 0, createdProfiles: 0, nextCursor: templates.at(-1)?.id ?? null, done: templates.length < batchSize };
    }
    let attachedTemplates = 0;
    let createdProfiles = 0;
    for (const template of templates) {
      const personalOwnerId = template.workspace?.personalOwnerUserId ?? (template.workspaceId ? null : template.userId);
      const workspaceId = personalOwnerId ? null : template.workspaceId;
      const userId = personalOwnerId;
      const actorUserId = template.createdByUserId ?? personalOwnerId ?? template.workspace?.ownerUserId;
      if (!actorUserId || (!workspaceId && !userId)) continue;
      const existing = await prisma.brandProfile.findFirst({ where: { ...(workspaceId ? { workspaceId } : { userId }), slug: compatibilityProfileSlug() } });
      const profile = existing ?? await prisma.brandProfile.create({ data: {
        workspaceId,
        userId,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
        name: "Migrated brand kit",
        slug: compatibilityProfileSlug(),
        visualIdentity: brandVisualIdentitySchema.parse({}) as Prisma.InputJsonValue,
        voiceGuidance: brandVoiceGuidanceSchema.parse({}) as Prisma.InputJsonValue,
        defaultTemplateId: template.id,
        isCompatibility: true,
      } });
      if (!existing) createdProfiles += 1;
      const existingMembership = await prisma.brandProfileTemplate.findUnique({ where: { templateId: template.id }, select: { profileId: true } });
      if (!existingMembership) {
        const position = await prisma.brandProfileTemplate.count({ where: { profileId: profile.id } });
        await prisma.brandProfileTemplate.create({ data: { profileId: profile.id, templateId: template.id, position } });
        attachedTemplates += 1;
      }
      const ownerDefaultTemplateId = template.workspace?.defaultBrandTemplateId ?? template.user?.defaultBrandTemplateId ?? null;
      if (ownerDefaultTemplateId === template.id) {
        await prisma.brandProfile.update({ where: { id: profile.id }, data: { defaultTemplateId: template.id } });
        if (workspaceId) await prisma.workspace.update({ where: { id: workspaceId }, data: { defaultBrandProfileId: profile.id } });
        else await prisma.user.update({ where: { id: userId! }, data: { defaultBrandProfileId: profile.id } });
      }
    }
    return { processedTemplates: templates.length, attachedTemplates, createdProfiles, nextCursor: templates.at(-1)?.id ?? null, done: templates.length < batchSize };
  }
}

export const brandProfileService = new BrandProfileService();
