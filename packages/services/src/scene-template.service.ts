import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  sceneTemplateCreateSchema,
  sceneTemplateDefinitionSchema,
  sceneTemplateDeleteSchema,
  sceneTemplateUpdateSchema,
  type SceneBlock,
  type SceneTemplateDefinition,
  type SceneTemplateRole,
  resolvePricingTier,
} from "@narriflow/validators";
import { assertBrandMutationAllowedWithAnalytics, brandOwnerWhere, type BrandActorScope } from "./brand-ownership";
import { assertProgramWriteEnabled } from "./program-rollout";
import { withSerializableTransaction } from "./serializable-transaction";

export class SceneTemplateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SceneTemplateError";
  }
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

function definitionFingerprint(definition: SceneTemplateDefinition) {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

function sourceAssetId(definition: SceneTemplateDefinition) {
  return definition.content.kind === "image" || definition.content.kind === "video"
    ? definition.content.asset.id
    : null;
}

type SceneTemplateReferenceReader = Pick<Prisma.TransactionClient, "brandFont" | "visualAsset">;

async function assertDefinitionAsset(
  db: SceneTemplateReferenceReader,
  scope: BrandActorScope,
  profileId: string,
  definition: SceneTemplateDefinition,
) {
  const assetId = sourceAssetId(definition);
  if (!assetId) {
    if (definition.content.kind !== "text" || !definition.content.fontAsset) return;
    const font = await db.brandFont.findFirst({
      where: { id: definition.content.fontAsset.id, ...brandOwnerWhere(scope), deletedAt: null, profiles: { some: { profileId } } },
      select: { fingerprint: true, family: true },
    });
    if (!font || font.fingerprint !== definition.content.fontAsset.fingerprint || font.family !== definition.content.fontFamily) {
      throw new SceneTemplateError("scene_template_font_invalid", "Scene template font is missing or changed");
    }
    return;
  }
  const reference = definition.content.kind === "image" || definition.content.kind === "video" ? definition.content.asset : null;
  const asset = await db.visualAsset.findFirst({ where: { id: assetId, ...brandOwnerWhere(scope), deletedAt: null }, select: { fingerprint: true, kind: true } });
  if (!asset || !reference || asset.fingerprint !== reference.fingerprint || asset.kind !== definition.content.kind) {
    throw new SceneTemplateError("scene_template_asset_invalid", "Scene template asset is missing or changed");
  }
}

function defaultField(role: SceneTemplateRole) {
  if (role === "intro") return "defaultIntroSceneTemplateId" as const;
  if (role === "outro") return "defaultOutroSceneTemplateId" as const;
  return null;
}

export class SceneTemplateService {
  async list(scope: BrandActorScope, profileId: string) {
    return requirePrisma().sceneTemplate.findMany({ where: { profileId, profile: { ...brandOwnerWhere(scope), deletedAt: null }, deletedAt: null }, orderBy: [{ role: "asc" }, { name: "asc" }] });
  }

  async create(scope: BrandActorScope, profileId: string, value: unknown) {
    assertProgramWriteEnabled("scene_templates");
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.scenes", "scene");
    const input = sceneTemplateCreateSchema.parse(value);
    if (input.makeDefault && !defaultField(input.role)) throw new SceneTemplateError("scene_template_default_role_invalid", "Only intro and outro scenes can be defaults");
    if (input.makeDefault && resolvePricingTier(scope.pricingTier) !== "business") throw new SceneTemplateError("scene_template_default_feature_unavailable", "Default intro and outro scenes require Business");
    const prisma = requirePrisma();
    return withSerializableTransaction(prisma, async (tx) => {
      const profile = await tx.brandProfile.findFirst({ where: { id: profileId, ...brandOwnerWhere(scope), deletedAt: null }, select: { id: true } });
      if (!profile) throw new SceneTemplateError("scene_template_profile_not_found", "Brand Profile was not found");
      await assertDefinitionAsset(tx, scope, profileId, input.definition);
      const created = await tx.sceneTemplate.create({ data: { profileId, sourceAssetId: sourceAssetId(input.definition), createdByUserId: scope.actorUserId, name: input.name, role: input.role, definition: input.definition as Prisma.InputJsonValue, fingerprint: definitionFingerprint(input.definition) } });
      const field = input.makeDefault ? defaultField(input.role) : null;
      if (field) await tx.brandProfile.update({ where: { id: profileId }, data: { [field]: created.id, revision: { increment: 1 }, updatedByUserId: scope.actorUserId } });
      return created;
    });
  }

  async update(scope: BrandActorScope, profileId: string, templateId: string, value: unknown) {
    assertProgramWriteEnabled("scene_templates");
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.scenes", "scene");
    const input = sceneTemplateUpdateSchema.parse(value);
    if (input.makeDefault && resolvePricingTier(scope.pricingTier) !== "business") throw new SceneTemplateError("scene_template_default_feature_unavailable", "Default intro and outro scenes require Business");
    const prisma = requirePrisma();
    return withSerializableTransaction(prisma, async (tx) => {
      const current = await tx.sceneTemplate.findFirst({
        where: { id: templateId, profileId, profile: { ...brandOwnerWhere(scope), deletedAt: null }, deletedAt: null },
        include: { profile: { select: { defaultIntroSceneTemplateId: true, defaultOutroSceneTemplateId: true } } },
      });
      if (!current) throw new SceneTemplateError("scene_template_not_found", "Scene template was not found");
      if (current.revision !== input.expectedRevision) throw new SceneTemplateError("scene_template_revision_conflict", "Scene template changed before this update");
      const definition = input.definition ?? sceneTemplateDefinitionSchema.parse(current.definition);
      const role = (input.role ?? current.role) as SceneTemplateRole;
      await assertDefinitionAsset(tx, scope, profileId, definition);
      if (input.makeDefault && !defaultField(role)) throw new SceneTemplateError("scene_template_default_role_invalid", "Only intro and outro scenes can be defaults");
      const changed = await tx.sceneTemplate.updateMany({
        where: { id: current.id, revision: input.expectedRevision, deletedAt: null },
        data: { name: input.name, role, definition: definition as Prisma.InputJsonValue, sourceAssetId: sourceAssetId(definition), fingerprint: definitionFingerprint(definition), revision: { increment: 1 } },
      });
      if (changed.count !== 1) throw new SceneTemplateError("scene_template_revision_conflict", "Scene template changed before this update");
      const updated = await tx.sceneTemplate.findUniqueOrThrow({ where: { id: current.id } });
      const field = input.makeDefault ? defaultField(role) : null;
      const clearIntro = current.profile.defaultIntroSceneTemplateId === current.id &&
        (role !== "intro" || input.makeDefault === false);
      const clearOutro = current.profile.defaultOutroSceneTemplateId === current.id &&
        (role !== "outro" || input.makeDefault === false);
      if (field) {
        await tx.brandProfile.update({
          where: { id: profileId },
          data: {
            ...(field === "defaultIntroSceneTemplateId" ? { defaultIntroSceneTemplateId: updated.id } : {}),
            ...(field === "defaultOutroSceneTemplateId" ? { defaultOutroSceneTemplateId: updated.id } : {}),
            revision: { increment: 1 },
            updatedByUserId: scope.actorUserId,
          },
        });
      }
      if (clearIntro && field !== "defaultIntroSceneTemplateId") await tx.brandProfile.updateMany({ where: { id: profileId, defaultIntroSceneTemplateId: current.id }, data: { defaultIntroSceneTemplateId: null, revision: { increment: 1 }, updatedByUserId: scope.actorUserId } });
      if (clearOutro && field !== "defaultOutroSceneTemplateId") await tx.brandProfile.updateMany({ where: { id: profileId, defaultOutroSceneTemplateId: current.id }, data: { defaultOutroSceneTemplateId: null, revision: { increment: 1 }, updatedByUserId: scope.actorUserId } });
      return updated;
    });
  }

  async softDelete(scope: BrandActorScope, profileId: string, templateId: string, value: unknown) {
    assertProgramWriteEnabled("scene_templates");
    await assertBrandMutationAllowedWithAnalytics(scope, "brand.scenes", "scene");
    const input = sceneTemplateDeleteSchema.parse(value);
    const current = await requirePrisma().sceneTemplate.findFirst({
      where: { id: templateId, profileId, profile: { ...brandOwnerWhere(scope), deletedAt: null }, deletedAt: null },
      include: { profile: { select: { defaultIntroSceneTemplateId: true, defaultOutroSceneTemplateId: true } } },
    });
    if (!current) throw new SceneTemplateError("scene_template_not_found", "Scene template was not found");
    if (current.revision !== input.expectedRevision) throw new SceneTemplateError("scene_template_revision_conflict", "Scene template changed before this update");
    return requirePrisma().$transaction(async (tx) => {
      const deleted = await tx.sceneTemplate.updateMany({
        where: { id: current.id, revision: input.expectedRevision, deletedAt: null },
        data: { deletedAt: new Date(), revision: { increment: 1 } },
      });
      if (deleted.count !== 1) throw new SceneTemplateError("scene_template_revision_conflict", "Scene template changed before this update");
      if (current.profile.defaultIntroSceneTemplateId === current.id) await tx.brandProfile.updateMany({ where: { id: profileId, defaultIntroSceneTemplateId: current.id }, data: { defaultIntroSceneTemplateId: null, revision: { increment: 1 }, updatedByUserId: scope.actorUserId } });
      if (current.profile.defaultOutroSceneTemplateId === current.id) await tx.brandProfile.updateMany({ where: { id: profileId, defaultOutroSceneTemplateId: current.id }, data: { defaultOutroSceneTemplateId: null, revision: { increment: 1 }, updatedByUserId: scope.actorUserId } });
      return { ok: true };
    });
  }

  async freezeForInsertion(scope: BrandActorScope, profileId: string, templateId: string, input: { id: string; anchorSec: number }): Promise<SceneBlock> {
    const prisma = requirePrisma();
    const template = await prisma.sceneTemplate.findFirst({ where: { id: templateId, profileId, profile: { ...brandOwnerWhere(scope), deletedAt: null }, deletedAt: null } });
    if (!template) throw new SceneTemplateError("scene_template_not_found", "Scene template was not found");
    const definition = sceneTemplateDefinitionSchema.parse(template.definition);
    await assertDefinitionAsset(prisma, scope, profileId, definition);
    return {
      id: input.id,
      schemaVersion: 1,
      anchorSec: input.anchorSec,
      durationSec: definition.durationSec,
      content: structuredClone(definition.content),
      motion: structuredClone(definition.motion),
      templateSnapshot: { templateId: template.id, templateRevision: template.revision, fingerprint: template.fingerprint, name: template.name },
    };
  }
}

export const sceneTemplateService = new SceneTemplateService();
