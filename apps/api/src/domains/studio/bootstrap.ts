import { compositionAssetRef } from "@narriflow/composition-plan";
import {
  type BrandActorScope,
  ClipActionError,
  type autoCensorService,
  type brandFontService,
  type brandProfileService,
  type clipService,
  type generatedImageCapability,
  hasFeature,
  type presignDownloadUrl,
  type projectService,
  type sceneTemplateService,
  type visualAssetService,
} from "@narriflow/services";
import {
  brandPlanRequirement,
  type EditorDocument,
  brandTemplateSnapshotSchema,
  getEffectiveClipTiming,
  planFeatureRequirement,
  sceneTemplateDefinitionSchema,
} from "@narriflow/validators";

/** The services the Studio aggregate reads, injected so tests can observe them. */
export interface StudioReadDeps {
  clipService: Pick<
    typeof clipService,
    "getClipSnapshot" | "getClipPreviewSource" | "getClipEditorDocument"
  >;
  projectService: Pick<
    typeof projectService,
    "getProjectSnapshot" | "getProjectBrandSnapshot" | "getProjectBrandAudio" | "getCaptionLanguage"
  >;
  autoCensorService: Pick<typeof autoCensorService, "getPolicy">;
  visualAssetService: Pick<
    typeof visualAssetService,
    "list" | "resolveSceneReferences" | "resolveVisualBrollReferences"
  >;
  sceneTemplateService: Pick<typeof sceneTemplateService, "list">;
  brandFontService: Pick<
    typeof brandFontService,
    "list" | "resolveReferences" | "resolveSceneReferences"
  >;
  brandProfileService: Pick<typeof brandProfileService, "get">;
  presignDownloadUrl: typeof presignDownloadUrl;
  generatedImageCapability: typeof generatedImageCapability;
}

const PRESIGN_SECONDS = 3600;

/** The stored snapshot, or null when the project has none or it no longer parses. */
function parseBrandSnapshot(raw: unknown) {
  if (!raw) return null;
  const parsed = brandTemplateSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

type BrandSnapshot = NonNullable<ReturnType<typeof parseBrandSnapshot>>;

/**
 * The project's logo as the Studio shows it: a stable logical reference that
 * stays present when presigning fails (so the composition plan can degrade
 * deterministically), plus the snapshot's own per-clip defaults.
 */
function brandLogoOf(snapshot: BrandSnapshot | null, url: string | null) {
  if (!snapshot?.logoStorageKey) return null;
  return {
    url,
    ref: compositionAssetRef("logo", snapshot.logoStorageKey),
    position: snapshot.logoPosition,
    opacity: snapshot.logoOpacity,
    scalePct: snapshot.logoScalePct,
  };
}

/** A presign failure only means no playback or overlay; it never breaks the Studio. */
function presignOrNull(deps: StudioReadDeps, key: string | null | undefined) {
  return key
    ? deps.presignDownloadUrl({ key, expiresIn: PRESIGN_SECONDS }).catch(() => null)
    : Promise.resolve(null);
}

/**
 * Whether the plan allows Scenes in a clip. Inserting and editing template-backed
 * scenes needs only the plan feature; creating reusable Scene Templates follows
 * the shared-Workspace branding rule in Brand kit.
 */
function scenesRequirementOf(actor: BrandActorScope) {
  return planFeatureRequirement(actor.pricingTier, "brand.scenes");
}

/** A temporarily unavailable provider still shows the images already made. */
function imagesEntitled(
  deps: StudioReadDeps,
  actor: BrandActorScope,
): boolean {
  return deps.generatedImageCapability(actor).reason !== "entitlement_required";
}

type ActiveAssets = {
  visualAssets: ReturnType<StudioReadDeps["visualAssetService"]["list"]>;
  fonts: ReturnType<StudioReadDeps["brandFontService"]["list"]>;
};

/** Starts the document-independent reads, so they overlap the project and clip reads. */
function startActiveAssetReads(
  deps: StudioReadDeps,
  actor: BrandActorScope,
): ActiveAssets {
  const scenesEntitled = scenesRequirementOf(actor) === null;
  const visualAssets =
    scenesEntitled || imagesEntitled(deps, actor)
      ? deps.visualAssetService.list(actor)
      : Promise.resolve([]);
  const fonts = deps.brandFontService.list(actor);
  // These start before the reads that can fail first (a missing clip). Mark
  // them handled so a later rejection is never reported as unhandled; the
  // consumer still sees it when it awaits them.
  visualAssets.catch(() => undefined);
  fonts.catch(() => undefined);
  return { visualAssets, fonts };
}

/**
 * `later` entries replace `earlier` ones with the same id while keeping the
 * earlier position, so active (insertable) rows win over retained references.
 */
function mergeById<A extends { id: string }, B extends { id: string }>(
  earlier: readonly A[],
  later: readonly B[],
): Array<A | B> {
  const merged = new Map<string, A | B>();
  for (const row of earlier) merged.set(row.id, row);
  for (const row of later) merged.set(row.id, row);
  return [...merged.values()];
}

/**
 * The asset facts the Studio needs for a document: retained references
 * (deleted or inactive assets a document still points at, which stay
 * resolvable but not insertable) merged under the active, insertable ones.
 */
async function resolveStudioAssets(
  deps: StudioReadDeps,
  actor: BrandActorScope,
  input: {
    brandProfileId: string | null;
    document: EditorDocument;
    active: ActiveAssets;
  },
) {
  const { document } = input;
  const scenesEntitled = scenesRequirementOf(actor) === null;
  const fontReferences = [
    document.captionPreset.fontAsset,
    ...document.studioEdits.textLayers.map((layer) => layer.fontAsset),
  ].filter((ref): ref is NonNullable<typeof ref> => Boolean(ref));

  const [
    activeVisualAssets,
    activeFonts,
    activeProfile,
    retainedSceneVisualAssets,
    retainedBrollVisualAssets,
    retainedSceneFonts,
    retainedFonts,
  ] = await Promise.all([
    input.active.visualAssets,
    input.active.fonts,
    scenesEntitled && input.brandProfileId
      ? deps.brandProfileService.get(actor, input.brandProfileId).catch(() => null)
      : Promise.resolve(null),
    deps.visualAssetService.resolveSceneReferences(actor, document.sceneBlocks),
    deps.visualAssetService.resolveVisualBrollReferences(
      actor,
      document.studioEdits.visualBroll,
    ),
    scenesEntitled
      ? deps.brandFontService.resolveSceneReferences(actor, document.sceneBlocks)
      : Promise.resolve([]),
    deps.brandFontService.resolveReferences(actor, fontReferences),
  ]);

  const visualAssets = mergeById(
    mergeById(retainedSceneVisualAssets, retainedBrollVisualAssets),
    activeVisualAssets.map((asset) => ({
      ...asset,
      missing: asset.accessUrl === null,
      insertable: true as const,
    })),
  );

  const activeSceneFonts = (activeProfile?.fonts ?? []).map((font) => ({
    id: font.id,
    family: font.family,
    style: font.style,
    weight: font.weight,
    fingerprint: font.fingerprint,
    accessUrl: font.accessUrl,
    missing: font.missing,
    insertable: !font.missing,
  }));
  const sceneFonts = mergeById(retainedSceneFonts, activeSceneFonts);

  const fonts = mergeById(
    retainedFonts.map((font) => ({ ...font, insertable: false as const })),
    activeFonts.map((font) => ({ ...font, insertable: true as const })),
  );

  return { visualAssets, sceneFonts, fonts };
}

/**
 * `GET /projects/:id/brand-snapshot`: the frozen brand snapshot, its presigned
 * logo and the frozen brand audio, as the Studio's brand panels read them.
 */
export async function loadBrandSnapshot(
  deps: StudioReadDeps,
  actor: BrandActorScope,
  projectId: string,
) {
  const [raw, audio] = await Promise.all([
    deps.projectService.getProjectBrandSnapshot(actor, projectId),
    deps.projectService.getProjectBrandAudio(actor, projectId),
  ]);
  const snapshot = parseBrandSnapshot(raw);
  const logoUrl = await presignOrNull(deps, snapshot?.logoStorageKey);
  return { snapshot, brandLogo: brandLogoOf(snapshot, logoUrl), audio };
}

/**
 * `GET .../editor-assets`: the retained and active asset facts for one clip's
 * current document, without the rest of the Studio.
 */
export async function loadEditorAssets(
  deps: StudioReadDeps,
  actor: BrandActorScope,
  projectId: string,
  clipId: string,
) {
  const active = startActiveAssetReads(deps, actor);
  const [snapshot, editorDoc] = await Promise.all([
    deps.projectService.getProjectSnapshot(actor, projectId),
    deps.clipService.getClipEditorDocument(actor, projectId, clipId),
  ]);
  if (!snapshot.project) throw new ClipActionError("clip_not_found");
  return resolveStudioAssets(deps, actor, {
    brandProfileId: snapshot.project.brandProfileId,
    document: editorDoc.document,
    active,
  });
}

/**
 * The Studio's complete first paint in one read: everything the Studio page
 * used to gather with its own `Promise.all` chain, in two overlapping waves.
 * The QA composition-plan fixture stays web-only.
 */
export async function loadStudioBootstrap(
  deps: StudioReadDeps,
  actor: BrandActorScope,
  projectId: string,
  clipId: string,
) {
  const scenesRequirement = scenesRequirementOf(actor);
  const scenesEntitled = scenesRequirement === null;
  const active = startActiveAssetReads(deps, actor);

  // A missing clip fails the whole read as clip_not_found, whichever read
  // settles first.
  const [snapshot, clip, previewSource, rawBrandSnapshot, brandAudio, autoCensorPolicy, editorDoc, captionLanguage] =
    await Promise.all([
      deps.projectService.getProjectSnapshot(actor, projectId),
      deps.clipService.getClipSnapshot(actor, projectId, clipId),
      deps.clipService.getClipPreviewSource(actor, projectId, clipId),
      // The frozen brand snapshot captured at ingest: the source of truth for
      // the logo asset. The Studio only overrides how it is shown per clip.
      deps.projectService.getProjectBrandSnapshot(actor, projectId),
      // Brand music/SFX frozen with the profile; the Music and SFX tabs list them first.
      deps.projectService.getProjectBrandAudio(actor, projectId),
      deps.autoCensorService.getPolicy(actor, projectId),
      deps.clipService.getClipEditorDocument(actor, projectId, clipId),
      deps.projectService.getCaptionLanguage(actor, projectId),
    ]);
  const project = snapshot.project;
  if (!project) throw new ClipActionError("clip_not_found");

  const brandSnapshot = parseBrandSnapshot(rawBrandSnapshot);

  const [assets, sourceVideoUrl, brandLogoUrl, rawSceneTemplates] = await Promise.all([
    resolveStudioAssets(deps, actor, {
      brandProfileId: project.brandProfileId,
      document: editorDoc.document,
      active,
    }),
    // Source playback works for uploads and YouTube alike: both live in R2.
    presignOrNull(deps, project.sourceStorageKey),
    // The preview logo URL expires with the presign TTL; the render pipeline
    // downloads the logo fresh and is unaffected.
    presignOrNull(deps, brandSnapshot?.logoStorageKey),
    scenesEntitled && project.brandProfileId
      ? deps.sceneTemplateService.list(actor, project.brandProfileId)
      : Promise.resolve([]),
  ]);

  const sceneTemplates = rawSceneTemplates.flatMap((template) => {
    const definition = sceneTemplateDefinitionSchema.safeParse(template.definition);
    return definition.success
      ? [
          {
            id: template.id,
            name: template.name,
            revision: template.revision,
            fingerprint: template.fingerprint,
            role: template.role,
            definition: definition.data,
          },
        ]
      : [];
  });

  // tailPadSec 0: slice-only input, stored bounds are final. Must stay in
  // lockstep with toClipSnapshot, preview and render, or the timeline shows a
  // different duration than the rendered clip.
  const effective = getEffectiveClipTiming({
    utterances: clip.transcriptSlice,
    startSec: clip.startSec,
    endSec: clip.endSec,
    sourceDurationSec: project.sourceEdgeSec,
    tailPadSec: 0,
  });

  const generatedImagesCapability = deps.generatedImageCapability(actor);

  return {
    clipInfo: {
      id: clip.id,
      projectId: clip.projectId,
      title: clip.hookText,
      clipTitle: clip.title,
      duration: effective.durationSec,
      startSec: effective.startSec,
      endSec: effective.endSec,
      aspectRatio: clip.renderVariants[0]?.aspectRatio ?? ("9:16" as const),
      viralityScore: clip.viralityScore,
      category: clip.category,
      /** What captions are cased, shaped and directed in: the transcript's language, else the project's. */
      captionLanguage,
      sourceKind:
        project.sourceMimeType?.startsWith("audio/") || project.sourceType === "rss"
          ? ("audio" as const)
          : ("video" as const),
      wholeSource: clip.wholeSource,
      sourceEdgeSec: project.sourceEdgeSec,
      brollCues: clip.brollCues ?? [],
      can1080pExport: hasFeature(actor.pricingTier, "export.1080p"),
      exportHasWatermark: !hasFeature(actor.pricingTier, "export.noWatermark"),
      canPersistMotion: hasFeature(actor.pricingTier, "editor.motion"),
    },
    /** Effective transcript for the clip window; the web builds timeline segments from it. */
    utterances: effective.transcriptSlice,
    editor: {
      revision: editorDoc.revision,
      document: editorDoc.document,
      original: editorDoc.original,
      layoutAnalysis: editorDoc.layoutAnalysis,
      autoLayoutAnalysis: editorDoc.autoLayoutAnalysis,
      splitLayoutAnalysis: editorDoc.splitLayoutAnalysis,
      splitLayoutFailure: editorDoc.splitLayoutFailure,
      layoutAnalysisFailure: editorDoc.layoutAnalysisFailure,
    },
    source: {
      videoUrl: sourceVideoUrl,
      previewId: project.sourceStorageKey ?? project.id,
      // Once the source is purged a missing proxy can never arrive: the worker
      // that cuts it reads straight from source storage.
      purged: !project.sourceStorageKey,
    },
    preview: previewSource,
    brandLogo: brandLogoOf(brandSnapshot, brandLogoUrl),
    brandProfileId: project.brandProfileId,
    brandAudio,
    visualAssets: assets.visualAssets,
    sceneFonts: assets.sceneFonts,
    fonts: assets.fonts,
    sceneTemplates,
    sceneWriteCapabilities: {
      cards: scenesEntitled,
      images: scenesEntitled,
      videos: scenesEntitled,
      templates: scenesEntitled,
    },
    generatedImagesCapability,
    autoCensorPolicy,
    plan: {
      pricingTier: actor.pricingTier,
      scenesRequirement,
      fontRequirement: brandPlanRequirement(actor, "brand.customFonts"),
      canManageBilling: actor.role === "owner",
    },
  };
}

export type StudioBootstrap = Awaited<ReturnType<typeof loadStudioBootstrap>>;
export type StudioEditorAssets = Awaited<ReturnType<typeof loadEditorAssets>>;
