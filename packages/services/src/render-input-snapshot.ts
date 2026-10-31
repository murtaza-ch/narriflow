import { Prisma, type PrismaClient } from "@prisma/client";
import { brandTemplateSnapshotSchema, brollCuesArraySchema, buildClipCutPlan, clipAspectRatioFromDb, resolveClipRenderTiming, resolvePricingTier } from "@narriflow/validators";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { ClipPreparationInput } from "@narriflow/validators/clip-preparation";
import { renderAssetObjectSchema, renderExecutionInputSchema, type RenderExecutionInput } from "@narriflow/validators/render-execution";
import { compileBrollSearchRequest, resolveBrollCutaways, type BrollSearch } from "./broll-plan";
import { documentFontReferences } from "./brand-font-contract";
import type { ReadyClipPreparation } from "./clip-preparation";
import { effectiveCaptionLanguage } from "./clip-export-subtitles";

type AssetObject = ReturnType<typeof renderAssetObjectSchema.parse>;
export interface RenderInputSnapshotDependencies {
  /** Exact server-selected keys only; HEAD metadata or committed full SHA, never media bytes. */
  object(key: string): Promise<AssetObject | null>;
  pexelsConfigured: boolean;
  searchStock: BrollSearch;
}

/** Frozen metadata retains source ownership and the existing optional-media policy. */
export function createRenderInputSnapshot(database: PrismaClient, dependencies: RenderInputSnapshotDependencies) {
  return async (reference: ExecutionDispatchReference, preparation: ClipPreparationInput, ready: ReadyClipPreparation): Promise<RenderExecutionInput> => {
    const metadata = await database.$transaction(async tx => {
      const group = await tx.renderGroup.findUniqueOrThrow({ where: { id: reference.subject.id }, include: { workflowRun: { include: { project: { include: { workspace: true, transcript: { select: { languageCode: true } } } } } }, members: true } });
      const project = group.workflowRun.project;
      if (reference.subject.kind !== "render_group" || group.generation !== reference.generation || group.deploymentEpoch !== reference.deploymentEpoch || group.preparationId !== ready.preparationId ||
        project.id !== preparation.projectId || project.sourceRevision !== preparation.sourceRevision || project.sourceStorageKey !== preparation.source.storageKey || group.clipId !== preparation.clipId) throw new Error("render_input_unavailable");
      const variants = await tx.clipRender.findMany({ where: { id: { in: group.members.map(member => member.clipRenderId) }, workflowRunId: group.workflowRunId }, include: { exportVariant: true }, orderBy: { id: "asc" } });
      if (!variants.length || variants.length > 4 || variants.length !== group.members.length || group.members.some(member => member.invalidatedAt)) throw new Error("render_input_unavailable");
      const clip = await tx.clip.findFirst({ where: { id: group.clipId, projectId: project.id } });
      const stored = (variants[0]!.exportVariant ? variants[0]!.clipSnapshot : clip) as Record<string, unknown> | null;
      if (!stored) throw new Error("render_input_invalid");
      const doc = preparation.document, workspace = project.workspace;
      const owner = workspace.personalOwnerUserId ? { userId: workspace.personalOwnerUserId, workspaceId: null } : { workspaceId: workspace.id };
      const visualIds = [...new Set([...doc.sceneBlocks.flatMap(block => block.content.kind === "image" || block.content.kind === "video" ? [block.content.asset.id] : []), ...doc.studioEdits.visualBroll.map(item => item.asset.id)])];
      const fontIds = [...new Set([...documentFontReferences(doc).map(font => font.id), ...doc.sceneBlocks.flatMap(block => block.content.kind === "text" && block.content.fontAsset ? [block.content.fontAsset.id] : [])])];
      const audioIds = [...new Set([doc.studioEdits.music.assetId, ...doc.studioEdits.sfx.map(item => item.assetId)].filter((id): id is string => id !== null))];
      const [visuals, fonts, audio] = await Promise.all([
        visualIds.length ? tx.visualAsset.findMany({ where: { id: { in: visualIds }, ...owner, deletedAt: null } }) : [],
        fontIds.length ? tx.brandFont.findMany({ where: { id: { in: fontIds }, ...owner, deletedAt: null } }) : [],
        audioIds.length ? tx.audioAsset.findMany({ where: { id: { in: audioIds }, deletedAt: null, OR: [{ userId: null, workspaceId: null }, { workspaceId: workspace.id }] } }) : [],
      ]);
      const broll = brollCuesArraySchema.safeParse(stored.brollCues);
      return { group, project, variants, visuals, fonts, audio, clip: { index: stored.index, title: stored.title, hookText: stored.hookText, category: stored.category, brollCues: broll.success ? broll.data : null } };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    const { group, project } = metadata;
    const configuration: unknown = JSON.parse(group.exportIdentity);
    if (!Array.isArray(configuration) || configuration.length !== 5 || typeof configuration[4] !== "boolean") throw new Error("render_input_invalid");
    const freeze = async (key: string, expectedSha?: string, expectedBytes?: number): Promise<AssetObject | null> => {
      const value = await dependencies.object(key);
      if (!value) return null;
      const object = renderAssetObjectSchema.parse(value);
      if (object.storageKey !== key || expectedSha && object.sha256 && expectedSha !== object.sha256 || expectedBytes !== undefined && expectedBytes !== object.byteLength) throw new Error("render_asset_identity_invalid");
      return expectedSha ? { ...object, sha256: expectedSha } : object;
    };
    async function boundedMap<T, R>(values: readonly T[], operation: (value: T) => Promise<R>) {
      const result: R[] = [];
      for (let offset = 0; offset < values.length; offset += 4) result.push(...await Promise.all(values.slice(offset, offset+4).map(operation)));
      return result;
    }
    const visuals = (await boundedMap(metadata.visuals, async asset => { const object = await freeze(asset.storageKey, asset.fingerprint, Number(asset.sizeBytes)); return object ? { name: `visual_${asset.id.replaceAll("-", "")}`, id: asset.id, kind: asset.kind, fingerprint: asset.fingerprint, object } : null; })).filter(value => value !== null);
    const fonts = (await boundedMap(metadata.fonts, async font => { const object = await freeze(font.storageKey, font.fingerprint, Number(font.sizeBytes)); return object ? { name: `font_${font.id.replaceAll("-", "")}`, id: font.id, family: font.family, format: font.format, fingerprint: font.fingerprint, object } : null; })).filter(value => value !== null);
    const audio = (await boundedMap(metadata.audio, async asset => { const object = await freeze(asset.storageKey); return object ? { name: `audio_${asset.id.replaceAll("-", "")}`, id: asset.id, title: asset.title, durationSec: asset.durationSec, object } : null; })).filter(value => value !== null);
    const brand = brandTemplateSnapshotSchema.safeParse(project.brandSnapshot);
    const logoObject = brand.success && brand.data.logoStorageKey ? await freeze(brand.data.logoStorageKey) : null;
    const variants = metadata.variants.map(variant => ({ renderId: variant.id, aspectRatio: variant.aspectRatio, resolution: variant.resolution,
      exportVariantId: variant.exportVariantId, export: variant.exportVariant ? { id: variant.exportVariant.exportId, watermark: variant.exportVariant.watermark } : null }));
    const timing = resolveClipRenderTiming({ llmModel: preparation.llmModel, startSec: preparation.document.clipStartSec, endSec: preparation.document.clipEndSec, utterances: preparation.document.transcriptSlice });
    const cutPlan = buildClipCutPlan(preparation.document.deletedRanges, { startSec: timing.startSec, endSec: timing.endSec });
    const duration = cutPlan.isUncut ? timing.durationSec : cutPlan.editedDurationSec;
    const clip = renderExecutionInputSchema.shape.clip.parse(metadata.clip);
    const request = dependencies.pexelsConfigured && preparation.sourceProbe.video && duration >= 12 && !preparation.document.brollUrl ? compileBrollSearchRequest({
      clipDurationSec: duration, rawCues: clip.brollCues, cutPlan, clipStartSec: timing.startSec, title: clip.title, hookText: clip.hookText, category: clip.category,
      aspects: variants.map(variant => clipAspectRatioFromDb[variant.aspectRatio]) }) : null;
    const resolved = request ? await resolveBrollCutaways(request, dependencies.searchStock) : [];
    return renderExecutionInputSchema.parse({ version: 1, kind: "render_group", groupId: group.id, workflowRunId: group.workflowRunId, workSetGeneration: group.workSetGeneration,
      watermark: configuration[4],
      preparation, prepared: { preview: ready.preview, result: ready.result }, workspace: { id: project.workspaceId, ownerUserId: project.workspace.ownerUserId, pricingTier: resolvePricingTier(project.workspace.pricingTier) },
      captionLanguage: effectiveCaptionLanguage(project), brandSnapshot: project.brandSnapshot, clip, variants,
      assets: { visuals, fonts, audio, logo: logoObject ? { name: "brand_logo", object: logoObject } : null }, autoBroll: { configured: dependencies.pexelsConfigured, request, resolved } });
  };
}
