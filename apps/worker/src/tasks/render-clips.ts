import { AsyncLocalStorage } from "node:async_hooks";
import { createWriteStream as productionCreateWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline as productionPipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  automaticLayoutInputFingerprint,
  compositionAssetRef,
  planClipComposition,
  screenLayoutInputFingerprint,
  splitLayoutInputFingerprint,
  type ClipCompositionPlan,
  type CompositionEvidenceAvailability,
  type CompositionRect,
  type ScreenLayoutEvidence,
  type ScreenLayoutFailureReason,
  type SplitLayoutEvidence,
  type SplitLayoutFailureReason,
  type CompositionTargetPlan,
} from "@narriflow/composition-plan";
import {
  assertPublicHttpUrl,
  assertResponseContentLength,
  audioAssetService as productionAudioAssetService,
  clipService as productionClipService,
  createByteLimitTransform,
  deleteObject as productionDeleteObject,
  downloadObjectToFile as productionDownloadObjectToFile,
  guardedFetch as productionGuardedFetch,
  hasFeature,
  presignDownloadUrl as productionPresignDownloadUrl,
  projectService as productionProjectService,
  putFileFromPath as productionPutFileFromPath,
  rethrowWorkflowAttemptLost,
  RemoteFetchError,
  UnsafeUrlError,
  WorkflowAttemptLost,
  WorkflowFailure,
  workflowFailureFromUnknown,
  workflowHttpFailureDisposition,
  type GuardedFetchOptions,
  type RenderWorkSetOutcome,
  type WorkflowAttemptRef,
} from "@narriflow/services";
import {
  AUDIO_UPLOAD_MAX_BYTES,
  brandTemplateSnapshotSchema,
  brollCuesArraySchema,
  captionPresetSchema,
  CAPTION_CHUNK_SIZE,
  CAPTION_POSITION_Y_DEFAULTS,
  CATEGORY_BROLL_FALLBACK_QUERY,
  emojiForWord,
  clipAspectRatioDbSchema,
  clipAspectRatioFromDb,
  clipAspectRatioOptions,
  clipAutoLayoutAnalysisSchema,
  clipLayoutAnalysisV2Schema,
  clipAutoLayoutMatchesInputs,
  clipRenderResolutionSchema,
  computeSpeechWindows,
  deletedRangesSchema,
  extractSpeechWordIntervals,
  formatCaptionWord,
  getEffectiveClipTiming,
  MAX_DUCKING_WINDOWS,
  normalizeTranscriptSliceForClip,
  parseClipAutoLayoutAnalysis,
  parseClipSplitLayoutAnalysis,
  parseClipLayoutAnalysis,
  resolveEffectiveFramingMode,
  resolveEffectiveLogoSettings,
  resolveMusicFadeWindows,
  resolveSpeakerLayoutScene,
  sourceRangeToEdited,
  sourceToEdited,
  studioEditsSchema,
} from "@narriflow/validators";
import type {
  BrandTemplateSnapshot,
  CaptionPreset,
  ClipAspectRatio,
  ClipAutoLayoutAnalysis,
  ClipAutoLayoutSegment,
  ClipCategory,
  ClipLayoutAnalysis,
  ClipRenderResolution,
  DuckingWindow,
  EditorDocument,
  EditedTimeMap,
  SourceRange,
  StudioEdits,
  StudioTextLayer,
  StudioSpeakerLayoutOverride,
  TranscriptUtterance,
} from "@narriflow/validators";
import { buildClipCutPlan, type ClipCutPlan } from "./cut-plan";
import {
  buildAutoLayoutPlan,
  speechWordsFromUtterances,
} from "./layout-engine";
import {
  buildReframeSendcmdScript,
  cropXForCenter,
  REFRAME_CROP_NAME,
  remapFaceSamplesForCutPlan,
  smoothFacePath,
  type FaceSample,
  type SmoothedSample,
} from "./reframe";
import {
  buildSplitFilterChain,
  buildSplitLayoutPlan,
  computeTileCrop,
  deriveSingleFaceSamplesFromMulti,
  remapMultiFaceSamplesForCutPlan,
  splitTilesAreDistinct,
  type BuildSplitLayoutPlanResult,
  type MultiFaceSample,
  type SplitLayoutSegment,
} from "./two-up";
import {
  buildScreenSpeakerFilterChain,
  classifyScreencast,
  confirmsFaceInRect,
  fitPipCropToTile,
  pipCropTooSmall,
  screenBottomIsTrackable,
  screenTileGeometry,
  selectPipRect,
  SCREEN_BOTTOM_CROP_NAME,
  type PipCandidate,
  type PipRect,
  type ScreenSpeakerBottomSpec,
} from "./screen-layout";
import {
  brollQueryForClip,
  dominantPexelsOrientation,
  getCachedBrollAssetPath,
  planBrollWindow,
  remapBrollCuesForCutPlan,
  resolveBrollCutaways,
  saveBrollAssetToCache,
  type BrollCueInput,
} from "./broll";
import { buildDuckingVolumeExpression } from "./ducking";
import { parseRenderConfig, type RenderConfig } from "../render-config";
import {
  clipExportAttemptStorageKey,
  clipRenderAttemptStorageKey,
} from "../render-object-key";
export { clipRenderAttemptStorageKey } from "../render-object-key";
import {
  productionRenderProcessAdapter,
  type RenderProcessDiagnostic,
} from "../render-process-adapter";
import {
  DEFAULT_RENDER_MEDIA_FPS,
  HTTP_SOURCE_RW_TIMEOUT_US,
  ProductionRenderMediaAdapter,
  productionRenderMediaAdapter,
  type RenderMediaProbe,
} from "../render-media-adapter";
import { productionRenderDiagnosticAdapter } from "../render-diagnostic-adapter";
import { compileCompositionPlanVideo } from "../composition-ffmpeg-adapter";
import { classifyRenderObjectKey } from "../render-object-key";
import {
  productionRenderClockAdapter,
  productionRenderWorkspaceAdapter,
  type RenderClockAdapter,
  type RenderWorkspaceAdapter,
} from "../render-runtime-adapters";

interface BrollCutaway {
  path: string;
  window: { startSec: number; endSec: number };
}

interface BrollPlan {
  cutaways: BrollCutaway[];
  /** Compact per-cutaway attribution, attached to the render as object metadata and logs. */
  credits: Array<{
    query: string;
    startSec: number;
    endSec: number;
    authorName: string | null;
    authorUrl: string | null;
    pageUrl: string | null;
  }>;
}

interface MusicPlan {
  path: string;
  volume: number;
  startOffsetSec: number;
  /** User-configured music fade in/out, seconds (0-5). Optional so existing
   *  test fixtures/call sites that predate this field keep compiling. */
  fadeInSec?: number;
  fadeOutSec?: number;
  /**
   * Auto-ducking v1 (vizard-parity.md "Music/SFX library"): merged/padded
   * speech windows on the EDITED timeline (`computeSpeechWindows`'s
   * output), set only when `studioEdits.music.ducking` is true. Absent or
   * empty means "no-op" — `buildAudioMixFilter` omits the `volume=`
   * automation stage entirely rather than emitting a no-op expression.
   */
  duckingWindows?: DuckingWindow[];
}

/**
 * One resolved, downloaded one-shot SFX placement (vizard-parity.md
 * "Music/SFX library" — see `studioSfxPlacementSchema`'s doc comment for
 * the placement contract). `startSec` stays in EDITED-timeline seconds,
 * same convention as the schema — the render pipeline never needs to remap
 * it through a `timeMap`, unlike transcript-derived timings.
 */
interface SfxPlan {
  path: string;
  startSec: number;
  volume: number;
}

/**
 * Resolved per-clip canvas background (vizard-parity.md Phase C item 2) —
 * built once per clip render (see the main flow below, mirroring how
 * `MusicPlan` is resolved from `studioEdits.music`) and threaded into
 * whichever per-output builder actually runs. `color` is always populated
 * (falls back to black) so it doubles as the mode="image" fallback when the
 * image URL was invalid or its download failed upstream. `imagePath` is the
 * local downloaded file, set only when mode="image" AND the download
 * actually succeeded — `buildFitAndBackgroundFilter` falls back to the solid
 * color whenever it's null, so a bad image URL degrades gracefully instead
 * of failing the render.
 */
interface BackgroundPlan {
  mode: "color" | "image";
  color: string;
  imagePath: string | null;
}

/** A resolved reframe crop for one output: the sendcmd script + its crop name. */
interface ReframeSpec {
  scriptPath: string;
  cropName: string;
}

interface LogoOverlay {
  filePath: string;
  position: BrandTemplateSnapshot["logoPosition"];
  opacity: number;
  scalePct: number;
}

const LOGO_MARGIN_PX = 24;

/**
 * Merge a clip's `studioEdits.logo` override over the base logo overlay
 * (built once per project from the frozen brand snapshot + downloaded logo
 * file, see `brandLogo` below) via the shared `resolveEffectiveLogoSettings`
 * helper — the same one the studio preview overlay uses, so burn-in and
 * preview can't fork (vizard-parity.md Phase A step 6). `base: null` (no
 * logo asset at all, e.g. no snapshot/no logoStorageKey/audio-only source)
 * always yields `null` — there's nothing to override. `enabled: false`
 * yields `null` too, skipping the overlay filter entirely for this clip.
 */
export function resolveClipLogoOverlay(
  base: LogoOverlay | null,
  overrides: StudioEdits["logo"] | null | undefined,
): LogoOverlay | null {
  if (!base) return null;
  const effective = resolveEffectiveLogoSettings(
    { position: base.position, opacity: base.opacity, scalePct: base.scalePct },
    overrides,
  );
  if (!effective.enabled) return null;
  return {
    filePath: base.filePath,
    position: effective.position,
    opacity: effective.opacity,
    scalePct: effective.scalePct,
  };
}

interface WorkflowRunJob {
  id: string;
  projectId: string;
  project: {
    title: string;
    sourceStorageKey: string | null;
    sourceDurationSeconds: number | null;
    userId: string;
    workspaceId: string | null;
  };
}

export type ClipRenderingWorkflowAttempt = Omit<WorkflowAttemptRef, "stage"> & {
  stage: "clip_rendering";
};

interface ClipRenderAttemptLifecycle {
  beginRenderWorkSet(attempt: WorkflowAttemptRef): Promise<{
    variantIds: readonly string[];
  }>;
  settleRenderWorkSet(attempt: WorkflowAttemptRef): Promise<RenderWorkSetOutcome>;
}

interface ClipRenderAttemptAdapters {
  media: Pick<typeof productionRenderMediaAdapter, "probe">;
  process: Pick<typeof productionRenderProcessAdapter, "execute">;
  state: Pick<
    typeof productionClipService,
    "getFrozenRenderingStateForWorkSet"
  >;
  project: Pick<
    typeof productionProjectService,
    "publishWorkflowProgress"
  >;
  clip: Pick<
    typeof productionClipService,
    | "completeClipRenderVariant"
    | "completeClipAutoLayoutAnalysis"
    | "completeClipSplitLayoutAnalysis"
    | "failClipRenderVariant"
    | "markClipRenderVariantRendering"
    | "setClipLayoutAnalysis"
  >;
  audioAsset: Pick<typeof productionAudioAssetService, "resolveRenderSource">;
  optionalAssets: {
    downloadUrlToFile: typeof downloadUrlToFile;
    validateOptionalMedia: typeof validateOptionalMedia;
    resolveBrollCutaways: typeof resolveBrollCutaways;
    getCachedBrollAssetPath: typeof getCachedBrollAssetPath;
    saveBrollAssetToCache: typeof saveBrollAssetToCache;
    probeMediaDurationSec: typeof probeMediaDurationSec;
    probeBackgroundImageDecodable: typeof probeBackgroundImageDecodable;
  };
  analysis: {
    extractFaceDetectionSegment: typeof extractFaceDetectionSegment;
    detectFacePath: typeof detectFacePath;
    detectMultiFacePath: typeof detectMultiFacePath;
    detectSceneCuts: typeof detectSceneCuts;
    detectPipPath: typeof detectPipPath;
  };
  remoteMedia: {
    createWriteStream: typeof productionCreateWriteStream;
    guardedFetch: typeof productionGuardedFetch;
    pipeline: typeof productionPipeline;
  };
  storage: {
    deleteObject: typeof productionDeleteObject;
    downloadObjectToFile: typeof productionDownloadObjectToFile;
    presignDownloadUrl: typeof productionPresignDownloadUrl;
    putFileFromPath: typeof productionPutFileFromPath;
  };
  workspace: RenderWorkspaceAdapter;
  clock: RenderClockAdapter;
  diagnose(input: {
    level: "info" | "error";
    message: string;
    context?: Record<string, unknown>;
  }): void;
}

type ClipRenderAttemptAdapterOverrides = Partial<
  Omit<
    ClipRenderAttemptAdapters,
    "analysis" | "clip" | "optionalAssets" | "storage" | "workspace" | "clock"
  >
> & {
  analysis?: Partial<ClipRenderAttemptAdapters["analysis"]>;
  clip?: Partial<ClipRenderAttemptAdapters["clip"]>;
  optionalAssets?: Partial<ClipRenderAttemptAdapters["optionalAssets"]>;
  storage?: Partial<ClipRenderAttemptAdapters["storage"]>;
  workspace?: Partial<ClipRenderAttemptAdapters["workspace"]>;
  clock?: Partial<ClipRenderAttemptAdapters["clock"]>;
};

interface ClipRenderAttemptDependencies {
  run: WorkflowRunJob;
  config: Readonly<RenderConfig>;
  lifecycle: ClipRenderAttemptLifecycle;
  adapters?: ClipRenderAttemptAdapterOverrides;
}

export function resolveRenderTimingForClip(input: {
  llmModel: string | null;
  startSec: number;
  endSec: number;
  utterances: TranscriptUtterance[];
}) {
  if (input.llmModel === "caption-only") {
    const startSec = Math.max(0, input.startSec);
    const endSec = Math.max(startSec + 0.01, input.endSec);
    return {
      startSec,
      endSec,
      durationSec: endSec - startSec,
      transcriptSlice: normalizeTranscriptSliceForClip(
        input.utterances,
        startSec,
        endSec,
      ),
    };
  }

  // tailPadSec 0: the clip's stored bounds were already pad- and collision-
  // normalized against the full transcript at detection/edit time, and the
  // slice passed here can't see the word that follows the clip — re-padding
  // from slice-only data used to push the rendered end ~0.25s past the
  // stored end, straight into the next sentence.
  return getEffectiveClipTiming({
    utterances: input.utterances,
    startSec: input.startSec,
    endSec: input.endSec,
    tailPadSec: 0,
  });
}

type SourceProbe = RenderMediaProbe;

interface PendingRenderOutput {
  clipRenderId: string;
  clipId: string;
  clipIndex: number;
  aspectRatio: ClipAspectRatio;
  outputPath: string;
  storageKey: string;
  subtitlePath?: string | null;
  reframe?: ReframeSpec | null;
  /** Screen packet B ("screen" framing mode): this output's resolved bottom
   *  (speaker) tile spec — a sendcmd-driven face crop when detection
   *  succeeded, else a static center crop. Set by `applyScreenSpeakerLayout`,
   *  consumed by `buildSingleVideoArgs`'s `screen` param (mirrors how
   *  `reframe` above is set by `applyAutoReframe` and consumed via
   *  `params.reframe`). Never set for a non-"screen" clip. */
  screenBottom?: ScreenSpeakerBottomSpec | null;
  /** Target resolution for this specific render row (vizard-parity Phase C
   *  export options) — read off the ClipRender row, already entitlement-
   *  clamped by clip.service's triggerClipRendering/autoQueueDefaultRenders.
   *  Drives the per-output 2/3 downscale; independent of the watermark,
   *  which is a run-level entitlement (see `applyWatermark` below). */
  resolution: ClipRenderResolution;
  watermark: boolean;
}

interface CompositionShadowLayerSnapshot {
  kind: "background" | "source-video";
  role: string | null;
  zIndex: number;
  sourceCrop: CompositionRect | null;
  destination: CompositionRect;
  rotationDeg: number;
  backgroundColor: string | null;
  backgroundImage: boolean;
}

interface CompositionShadowTargetSnapshot {
  effectiveMode: "auto" | "center" | "fit" | "split" | "screen";
  dynamicReframe: boolean;
  scenes: Array<{
    startSec: number;
    endSec: number;
    layers: CompositionShadowLayerSnapshot[];
  }>;
  noticeCodes: string[];
}

function legacyObjectFitGeometry(input: {
  source: { width: number; height: number };
  target: { width: number; height: number };
  fit: "cover" | "contain";
}): { sourceCrop: CompositionRect; destination: CompositionRect } {
  if (input.fit === "contain") {
    const scale = Math.min(
      input.target.width / input.source.width,
      input.target.height / input.source.height,
    );
    const width = Math.min(
      input.target.width,
      Math.max(2, Math.round((input.source.width * scale) / 2) * 2),
    );
    const height = Math.min(
      input.target.height,
      Math.max(2, Math.round((input.source.height * scale) / 2) * 2),
    );
    return {
      sourceCrop: {
        x: 0,
        y: 0,
        width: input.source.width,
        height: input.source.height,
      },
      destination: {
        x: Math.round((input.target.width - width) / 2),
        y: Math.round((input.target.height - height) / 2),
        width,
        height,
      },
    };
  }
  const sourceRatio = input.source.width / input.source.height;
  const targetRatio = input.target.width / input.target.height;
  const width =
    sourceRatio >= targetRatio
      ? Math.round(input.source.height * targetRatio)
      : input.source.width;
  const height =
    sourceRatio >= targetRatio
      ? input.source.height
      : Math.round(input.source.width / targetRatio);
  return {
    sourceCrop: {
      x: Math.max(0, Math.round((input.source.width - width) / 2)),
      y: Math.max(0, Math.round((input.source.height - height) / 2)),
      width,
      height,
    },
    destination: {
      x: 0,
      y: 0,
      width: input.target.width,
      height: input.target.height,
    },
  };
}

function normalizedFramePixels(
  frame: {
    frameX: number;
    frameY: number;
    frameWidth: number;
    frameHeight: number;
  },
  target: { width: number; height: number },
): CompositionRect {
  const width = Math.max(
    2,
    Math.min(target.width, Math.round(frame.frameWidth * target.width)),
  );
  const height = Math.max(
    2,
    Math.min(target.height, Math.round(frame.frameHeight * target.height)),
  );
  return {
    x: Math.max(
      0,
      Math.min(target.width - width, Math.round(frame.frameX * target.width)),
    ),
    y: Math.max(
      0,
      Math.min(target.height - height, Math.round(frame.frameY * target.height)),
    ),
    width,
    height,
  };
}

/** Independent projection of the established FFmpeg branches. This is
 * diagnostic-only and never drives rendering or planner output. */
export function buildLegacyCompositionShadowTarget(input: {
  targetId: string;
  aspectRatio: ClipAspectRatio;
  target: { width: number; height: number };
  source: { width: number; height: number };
  durationSec: number;
  requestedMode: "auto" | "center" | "fit" | "split" | "screen";
  automaticSegments: SplitLayoutSegment[] | null;
  splitSegments?: SplitLayoutSegment[] | null;
  screenBottom?: ScreenSpeakerBottomSpec | null;
  dynamicReframe?: boolean;
  speakerLayoutOverrides: StudioSpeakerLayoutOverride[];
  background: BackgroundPlan | null;
}): CompositionShadowTargetSnapshot {
  if (
    (input.requestedMode === "auto" || input.requestedMode === "split") &&
    (input.requestedMode === "auto"
      ? input.automaticSegments
      : input.splitSegments) &&
    (input.requestedMode === "auto"
      ? input.automaticSegments!.length
      : input.splitSegments!.length) > 0
  ) {
    const segments =
      input.requestedMode === "auto"
        ? input.automaticSegments!
        : input.splitSegments!;
    return {
      effectiveMode: input.requestedMode,
      dynamicReframe: false,
      noticeCodes: [],
      scenes: segments.map((segment) => {
        const resolved = resolveSpeakerLayoutScene(
          segment,
          input.speakerLayoutOverrides,
          input.aspectRatio,
        );
        return {
          startSec: segment.startSec,
          endSec: segment.endSec,
          layers: resolved.layers.map((layer, index) => {
            const destination = normalizedFramePixels(layer, input.target);
            const { cropW: baseCropWidth, cropH: baseCropHeight } =
              computeTileCrop(
                input.source.width,
                input.source.height,
                destination.width / destination.height,
              );
            const zoom = Math.min(4, Math.max(1, layer.cropZoom));
            const width = Math.max(2, Math.round(baseCropWidth / zoom));
            const height = Math.max(2, Math.round(baseCropHeight / zoom));
            return {
              kind: "source-video" as const,
              role: layer.role,
              zIndex: index,
              sourceCrop: {
                x: cropXForCenter(layer.cropCxNorm, input.source.width, width),
                y: cropXForCenter(layer.cropCyNorm, input.source.height, height),
                width,
                height,
              },
              destination,
              rotationDeg: layer.rotationDeg,
              backgroundColor: null,
              backgroundImage: false,
            };
          }),
        };
      }),
    };
  }

  if (input.requestedMode === "screen" && input.screenBottom) {
    const tile = screenTileGeometry(input.aspectRatio, input.source);
    const bottomCrop = input.screenBottom.pipRect
      ? {
          x: input.screenBottom.pipRect.x,
          y: input.screenBottom.pipRect.y,
          width: input.screenBottom.pipRect.w,
          height: input.screenBottom.pipRect.h,
        }
      : {
          x: cropXForCenter(
            input.screenBottom.cx,
            input.source.width,
            tile.cropW,
          ),
          y: cropXForCenter(0.5, input.source.height, tile.cropH),
          width: tile.cropW,
          height: tile.cropH,
        };
    return {
      effectiveMode: "screen",
      dynamicReframe: Boolean(input.screenBottom.reframe),
      noticeCodes: [],
      scenes: [
        {
          startSec: 0,
          endSec: input.durationSec,
          layers: [
            {
              kind: "source-video",
              role: null,
              zIndex: 0,
              sourceCrop: {
                x: 0,
                y: 0,
                width: input.source.width,
                height: input.source.height,
              },
              destination: {
                x: 0,
                y: 0,
                width: tile.tileWidth,
                height: tile.topHeight,
              },
              rotationDeg: 0,
              backgroundColor: null,
              backgroundImage: false,
            },
            {
              kind: "source-video",
              role: null,
              zIndex: 1,
              sourceCrop: bottomCrop,
              destination: {
                x: 0,
                y: tile.topHeight,
                width: tile.tileWidth,
                height: tile.bottomHeight,
              },
              rotationDeg: 0,
              backgroundColor: null,
              backgroundImage: false,
            },
          ],
        },
      ],
    };
  }

  const fit = input.requestedMode === "fit";
  const geometry = legacyObjectFitGeometry({
    source: input.source,
    target: input.target,
    fit: fit ? "contain" : "cover",
  });
  return {
    effectiveMode: fit ? "fit" : "center",
    dynamicReframe: Boolean(
      input.requestedMode === "auto" && input.dynamicReframe,
    ),
    noticeCodes: [],
    scenes: [
      {
        startSec: 0,
        endSec: input.durationSec,
        layers: [
          ...(fit
            ? [
                {
                  kind: "background" as const,
                  role: null,
                  zIndex: 0,
                  sourceCrop: null,
                  destination: {
                    x: 0,
                    y: 0,
                    width: input.target.width,
                    height: input.target.height,
                  },
                  rotationDeg: 0,
                  backgroundColor: input.background?.color ?? "#000000",
                  backgroundImage: Boolean(
                    input.background?.mode === "image" &&
                      input.background.imagePath,
                  ),
                },
              ]
            : []),
          {
            kind: "source-video" as const,
            role: null,
            zIndex: fit ? 1 : 0,
            sourceCrop: geometry.sourceCrop,
            destination: geometry.destination,
            rotationDeg: 0,
            backgroundColor: null,
            backgroundImage: false,
          },
        ],
      },
    ],
  };
}

function compositionShadowLayer(layer: CompositionTargetPlan["scenes"][number]["layers"][number]): CompositionShadowLayerSnapshot {
  return {
    kind: layer.kind,
    role: layer.kind === "source-video" ? (layer.speaker?.role ?? null) : null,
    zIndex: layer.zIndex,
    sourceCrop: layer.kind === "source-video" ? layer.sourceCrop : null,
    destination: layer.destination,
    rotationDeg: layer.rotationDeg,
    backgroundColor: layer.kind === "background" ? layer.color : null,
    backgroundImage: layer.kind === "background" ? Boolean(layer.imageRef) : false,
  };
}

function shadowRectsDiffer(
  left: CompositionRect | null,
  right: CompositionRect | null,
): boolean {
  if (!left || !right) return left !== right;
  return (["x", "y", "width", "height"] as const).some(
    (key) => Math.abs(left[key] - right[key]) > 1,
  );
}

export function compareCompositionShadowTarget(input: {
  planned: CompositionTargetPlan;
  plannedNoticeCodes: string[];
  legacy: CompositionShadowTargetSnapshot;
}) {
  const plannedScenes = input.planned.scenes.map((scene) => ({
    startSec: scene.startSec,
    endSec: scene.endSec,
    layers: scene.layers.map(compositionShadowLayer),
  }));
  const scenePairs = plannedScenes.map((scene, index) => ({
    planned: scene,
    legacy: input.legacy.scenes[index] ?? null,
  }));
  const topology = (layers: CompositionShadowLayerSnapshot[]) =>
    layers.map((layer) => `${layer.kind}:${layer.role ?? "none"}:${layer.zIndex}`);
  const comparison = {
    effectiveModeMismatch:
      input.planned.effectiveMode !== input.legacy.effectiveMode,
    dynamicReframeMismatch: input.legacy.dynamicReframe,
    sceneCountMismatch: plannedScenes.length !== input.legacy.scenes.length,
    sceneBoundsMismatch: scenePairs.some(
      ({ planned, legacy }) =>
        !legacy ||
        Math.abs(planned.startSec - legacy.startSec) > 0.075 ||
        Math.abs(planned.endSec - legacy.endSec) > 0.075,
    ),
    layerTopologyMismatch: scenePairs.some(
      ({ planned, legacy }) =>
        !legacy ||
        JSON.stringify(topology(planned.layers)) !==
          JSON.stringify(topology(legacy.layers)),
    ),
    geometryMismatch: scenePairs.some(({ planned, legacy }) => {
      if (!legacy || planned.layers.length !== legacy.layers.length) return true;
      return planned.layers.some((layer, index) => {
        const legacyLayer = legacy.layers[index]!;
        return (
          shadowRectsDiffer(layer.sourceCrop, legacyLayer.sourceCrop) ||
          shadowRectsDiffer(layer.destination, legacyLayer.destination)
        );
      });
    }),
    rotationMismatch: scenePairs.some(({ planned, legacy }) =>
      planned.layers.some(
        (layer, index) =>
          !legacy?.layers[index] ||
          Math.abs(layer.rotationDeg - legacy.layers[index]!.rotationDeg) > 0.01,
      ),
    ),
    backgroundMismatch: scenePairs.some(({ planned, legacy }) =>
      planned.layers.some((layer, index) => {
        if (layer.kind !== "background") return false;
        const legacyLayer = legacy?.layers[index];
        return (
          !legacyLayer ||
          layer.backgroundColor !== legacyLayer.backgroundColor ||
          layer.backgroundImage !== legacyLayer.backgroundImage
        );
      }),
    ),
    noticeMismatch:
      JSON.stringify(input.plannedNoticeCodes) !==
      JSON.stringify(input.legacy.noticeCodes),
  };
  return {
    legacy: input.legacy,
    plannedScenes,
    comparison,
    mismatchCount: Object.values(comparison).filter(Boolean).length,
  };
}

interface RenderExecutionContext {
  config: Readonly<RenderConfig>;
  signal: AbortSignal;
  attempt: ClipRenderingWorkflowAttempt;
  adapters: ClipRenderAttemptAdapters;
}

const renderExecutionStorage = new AsyncLocalStorage<RenderExecutionContext>();
const defaultRenderConfig = parseRenderConfig({});
// ClipService methods live on the class prototype. Keep a plain adapter
// object here because ClipRenderAttempt merges partial test overrides with
// object spread; spreading the service instance itself drops every prototype
// method and only fails in a real worker process.
const productionClipMutationAdapter: ClipRenderAttemptAdapters["clip"] = {
  completeClipRenderVariant: (...args) =>
    productionClipService.completeClipRenderVariant(...args),
  completeClipAutoLayoutAnalysis: (...args) =>
    productionClipService.completeClipAutoLayoutAnalysis(...args),
  completeClipSplitLayoutAnalysis: (...args) =>
    productionClipService.completeClipSplitLayoutAnalysis(...args),
  failClipRenderVariant: (...args) =>
    productionClipService.failClipRenderVariant(...args),
  markClipRenderVariantRendering: (...args) =>
    productionClipService.markClipRenderVariantRendering(...args),
  setClipLayoutAnalysis: (...args) =>
    productionClipService.setClipLayoutAnalysis(...args),
};
const productionClipRenderAttemptAdapters: ClipRenderAttemptAdapters = {
  media: productionRenderMediaAdapter,
  process: productionRenderProcessAdapter,
  state: productionClipService,
  project: productionProjectService,
  clip: productionClipMutationAdapter,
  audioAsset: productionAudioAssetService,
  optionalAssets: {
    downloadUrlToFile,
    validateOptionalMedia,
    resolveBrollCutaways,
    getCachedBrollAssetPath,
    saveBrollAssetToCache,
    probeMediaDurationSec,
    probeBackgroundImageDecodable,
  },
  analysis: {
    extractFaceDetectionSegment,
    detectFacePath,
    detectMultiFacePath,
    detectSceneCuts,
    detectPipPath,
  },
  remoteMedia: {
    createWriteStream: productionCreateWriteStream,
    guardedFetch: productionGuardedFetch,
    pipeline: productionPipeline,
  },
  storage: {
    deleteObject: productionDeleteObject,
    downloadObjectToFile: productionDownloadObjectToFile,
    presignDownloadUrl: productionPresignDownloadUrl,
    putFileFromPath: productionPutFileFromPath,
  },
  workspace: {
    ...productionRenderWorkspaceAdapter,
  },
  clock: productionRenderClockAdapter,
  diagnose: productionRenderDiagnosticAdapter.diagnose,
};

function currentRenderConfig(): Readonly<RenderConfig> {
  return renderExecutionStorage.getStore()?.config ?? defaultRenderConfig;
}

function currentRenderSignal(): AbortSignal | undefined {
  return renderExecutionStorage.getStore()?.signal;
}

function rethrowRenderCancellation(error: unknown): void {
  const signal = currentRenderSignal();
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  if (error instanceof Error) throw error;
  throw new DOMException("Clip render cancelled", "AbortError");
}

function rethrowRenderControlFlow(error: unknown): void {
  rethrowWorkflowAttemptLost(error);
  rethrowRenderCancellation(error);
}

async function withRenderOperationDeadline<T>(input: {
  operation: () => Promise<T>;
  deadlineMs: number;
  timeoutFailure: () => WorkflowFailure;
}): Promise<T> {
  const signal = currentRenderSignal();
  const clock = currentRenderAdapters().clock;
  signal?.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = clock.setTimeout(() => {
      finish(() => reject(input.timeoutFailure()));
    }, input.deadlineMs);
    const cleanup = () => {
      clock.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    };
    const onAbort = () => {
      finish(() => {
        if (signal?.reason instanceof Error) reject(signal.reason);
        else reject(new DOMException("Clip render cancelled", "AbortError"));
      });
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(input.operation)
      .then(
        (value) => {
          if (signal?.aborted) onAbort();
          else finish(() => resolve(value));
        },
        (error: unknown) => finish(() => reject(error)),
      );
  });
}

function currentRenderAdapters(): ClipRenderAttemptAdapters {
  return (
    renderExecutionStorage.getStore()?.adapters ??
    productionClipRenderAttemptAdapters
  );
}

function currentTimeMs(): number {
  return currentRenderAdapters().clock.nowMs();
}

function renderStorageSignal(includeAttemptSignal = true): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(
    currentRenderConfig().storageOperationTimeoutMs,
  );
  const attemptSignal = includeAttemptSignal ? currentRenderSignal() : undefined;
  return attemptSignal
    ? AbortSignal.any([attemptSignal, timeoutSignal])
    : timeoutSignal;
}

/**
 * Attempt-unique render storage key — mirrors `clipPreviewAttemptStorageKey`
 * from clip-preview.ts (see its comment for the full race it closes; the
 * short version below is render-specific).
 *
 * The key used to be a pure function of `(projectId, clipId, aspectRatio)`,
 * so two overlapping encodes for the same clip+aspect (e.g. an in-flight
 * render R1, an editor save that deletes R1's ClipRender row, then a
 * freshly-queued R2 that completes first) uploaded to the *same* object.
 * `completeClipRenderVariant`'s DB claim happens strictly after the upload,
 * so R1 — arriving late, its own row already gone — would still overwrite
 * R2's just-uploaded bytes at that shared key before its own row-update
 * failed, leaving downloads serving stale video with no error anywhere to
 * explain it.
 *
 * Each encode attempt now gets its own key. `completeClipRenderVariant`
 * persists this attempt's key as-is; nothing else re-derives a render's
 * storage key from `(projectId, clipId, aspectRatio)` — every reader (the
 * download endpoint, the project/clip storage deletion planner) reads the
 * persisted `ClipRender.storageKey` column verbatim.
 */
class WorkflowWorkerError extends WorkflowFailure {
  constructor(
    code: string,
    message: string,
    disposition: "retryable" | "permanent" = "retryable",
  ) {
    super(code, disposition, message);
  }
}

class RenderPersistenceFailure extends WorkflowWorkerError {
  readonly cleanupResult: "deleted" | "orphan_candidate";

  constructor(
    cause: unknown,
    cleanupResult: "deleted" | "orphan_candidate",
  ) {
    super(
      "render_persistence_failed",
      cause instanceof Error
        ? `Guarded render persistence failed: ${cause.message}`
        : "Guarded render persistence failed",
      "retryable",
    );
    this.name = "RenderPersistenceFailure";
    this.cleanupResult = cleanupResult;
  }
}

const aspectRatioConfig = new Map(
  clipAspectRatioOptions.map((option) => [option.value, option]),
);

const captionStyleByAspectRatio: Record<
  ClipAspectRatio,
  { fontSize: number; marginV: number }
> = {
  "9:16": { fontSize: 24, marginV: 110 },
  "1:1": { fontSize: 22, marginV: 72 },
  "16:9": { fontSize: 28, marginV: 56 },
  "4:5": { fontSize: 23, marginV: 90 },
};

const RENDER_DIAGNOSTIC_SECRET_KEY =
  /(?:authorization|credential|password|secret|signature|token)/i;

function sanitizeRenderDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\bhttps?:\/\/[^\s"'?]+\?[^\s"']+/gi, (url) =>
      url.replace(/\?.*$/, "?[redacted]"),
    );
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeRenderDiagnosticValue);
  }
  if (
    value &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        RENDER_DIAGNOSTIC_SECRET_KEY.test(key)
          ? "[redacted]"
          : sanitizeRenderDiagnosticValue(nestedValue),
      ]),
    );
  }
  return value;
}

function log(
  level: "info" | "error",
  message: string,
  context?: Record<string, unknown>,
) {
  const attempt = renderExecutionStorage.getStore()?.attempt;
  const enrichedContext = attempt
    ? {
        ...context,
        workflowRunId: attempt.workflowRunId,
        workflowAttemptId: attempt.attemptId,
        projectId: attempt.projectId,
        stage: attempt.stage,
        attemptCount: attempt.attemptCount,
      }
    : context;
  try {
    currentRenderAdapters().diagnose({
      level,
      message,
      context: sanitizeRenderDiagnosticValue(enrichedContext) as
        | Record<string, unknown>
        | undefined,
    });
  } catch {
    // Diagnostic delivery must never change Clip Render Attempt settlement.
  }
}

type OptionalAssetClass =
  | "logo"
  | "broll"
  | "music"
  | "sound_effect"
  | "background";

function diagnoseOptionalAssetFallback(input: {
  assetClass: OptionalAssetClass;
  phase:
    | "lookup"
    | "parse"
    | "presign"
    | "download"
    | "probe"
    | "decode"
    | "command"
    | "cleanup";
  failureCode: string;
  context: Record<string, unknown>;
}): void {
  const attempt = renderExecutionStorage.getStore()?.attempt;
  log("error", "clip_render_optional_asset_fallback", {
    ...input.context,
    ...(attempt ? { workflowAttemptId: attempt.attemptId } : {}),
    phase: input.phase,
    assetClass: input.assetClass,
    failureCode: input.failureCode,
    disposition: "degraded",
  });
}

function optionalAccessFailure(error: unknown, assetClass: "music" | "sound_effect") {
  const code =
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "";
  const presignFailure = code.includes("presign") || code.includes("access_url");
  return {
    phase: presignFailure ? ("presign" as const) : ("lookup" as const),
    failureCode: presignFailure
      ? `${assetClass}_presign_failed`
      : `${assetClass}_asset_unavailable`,
  };
}

function mediaAnalysisDiagnostic(input: {
  analysisMode: string;
  selectedMode?: string;
  fallbackMode?: string;
  failureCode?: string;
  durationMs?: number;
}): Record<string, unknown> {
  return {
    phase: "media_analysis",
    analysisMode: input.analysisMode,
    ...(input.selectedMode ? { selectedMode: input.selectedMode } : {}),
    ...(input.fallbackMode ? { fallbackMode: input.fallbackMode } : {}),
    ...(input.failureCode
      ? { failureCode: input.failureCode, disposition: "degraded" }
      : {}),
    durationMs: Math.max(0, input.durationMs ?? 0),
  };
}

async function executeRenderCommandWithOptionalFallback(input: {
  primaryArgs: string[];
  fallbackArgs?: () => string[];
  optionalAssets: Array<{
    assetClass: OptionalAssetClass;
    failureCode: string;
  }>;
  context: Record<string, unknown>;
}): Promise<"primary" | "fallback"> {
  try {
    await execCommand("ffmpeg", input.primaryArgs);
    return "primary";
  } catch (error) {
    rethrowRenderControlFlow(error);
    if (!input.fallbackArgs || input.optionalAssets.length === 0) throw error;
    await execCommand("ffmpeg", input.fallbackArgs());
    for (const asset of input.optionalAssets) {
      diagnoseOptionalAssetFallback({
        assetClass: asset.assetClass,
        phase: "command",
        failureCode: asset.failureCode,
        context: input.context,
      });
    }
    return "fallback";
  }
}

// Encoding is the dominant cost of a render. veryfast/CRF21 measured
// quality-neutral against the previous medium/CRF23 on this codebase's own
// footage while cutting 34-47s per 60-minute source. Overridable per-env so
// it can be retuned without a deploy.
const DEFAULT_X264_PRESET = "veryfast";
const DEFAULT_X264_CRF = "21";

function x264Preset(): string {
  return currentRenderConfig().x264Preset || DEFAULT_X264_PRESET;
}

function x264Crf(): string {
  return currentRenderConfig().x264Crf || DEFAULT_X264_CRF;
}

// B-roll/background-music downloads are short, small, user- or API-supplied
// assets — not the (up to hour-long) primary source media — so they get a
// much tighter timeout/size budget than ingest's source download. Bounded so
// a hostile or oversized URL can never OOM the worker or pin a slot for the
// whole reaper window.
const REMOTE_MEDIA_MAX_BYTES = 250 * 1024 * 1024;

function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; captureStdout: boolean },
): Promise<string> {
  const config = currentRenderConfig();
  return currentRenderAdapters().process.execute({
    command,
    args,
    signal: currentRenderSignal() ?? new AbortController().signal,
    deadlineMs: options.timeoutMs,
    killGraceMs: config.processKillGraceMs,
    captureStdout: options.captureStdout,
    diagnose: diagnoseRenderProcessOperation,
  });
}

function diagnoseRenderProcessOperation(event: RenderProcessDiagnostic): void {
  const attempt = renderExecutionStorage.getStore()?.attempt;
  log(
    event.status === "failed" ? "error" : "info",
    "clip_render_command_operation",
    {
      workflowRunId: attempt?.workflowRunId,
      projectId: attempt?.projectId,
      workflowAttemptId: attempt?.attemptId,
      phase: "command_execution",
      ...event,
    },
  );
}

async function execCommand(
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) {
  await runCommand(command, args, {
    timeoutMs:
      options?.timeoutMs ?? currentRenderConfig().renderCommandTimeoutMs,
    captureStdout: false,
  });
}

async function execCommandOutput(
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
): Promise<string> {
  return runCommand(command, args, {
    timeoutMs:
      options?.timeoutMs ?? currentRenderConfig().renderCommandTimeoutMs,
    captureStdout: true,
  });
}

/** Ranged source reads (default): every builder already puts `-ss` before
 *  `-i`, so handing ffmpeg a presigned HTTPS URL makes it range-request only
 *  the clip windows instead of the whole object — clip-preview.ts measured
 *  11.72s wall for a 38s cut off a 531MB 4K source with this exact pattern.
 *  For a 2h podcast, 6-10 clips read ~5-8% of the source bytes vs 100% for
 *  the old full-file download. `WORKER_RENDER_SOURCE_MODE=download` restores
 *  the old behavior; any presign/probe failure falls back to it per run. */
const RENDER_SOURCE_URL_TTL_SEC = 12 * 60 * 60;

// Mirrors clip-preview.ts's HTTP_SOURCE_ARGS: reconnect only on genuinely
// transient statuses, and bound a single stalled read so a quiet connection
// can't hang the ffmpeg child forever (execCommand has no per-render timeout
// here; the run-level reaper is the outer backstop).
const HTTP_SOURCE_RECONNECT_HTTP_ERROR_CODES = "429,500,502,503,504";
function isHttpSource(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

function httpSourceInputArgs(input: string): string[] {
  if (!isHttpSource(input)) return [];
  return [
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_on_network_error",
    "1",
    "-reconnect_on_http_error",
    HTTP_SOURCE_RECONNECT_HTTP_ERROR_CODES,
    "-reconnect_delay_max",
    "10",
    "-rw_timeout",
    String(HTTP_SOURCE_RW_TIMEOUT_US),
  ];
}

async function probeSource(sourcePath: string): Promise<SourceProbe> {
  const config = currentRenderConfig();
  return currentRenderAdapters().media.probe({
    sourcePath,
    signal: currentRenderSignal() ?? new AbortController().signal,
    deadlineMs: config.probeCommandTimeoutMs,
    killGraceMs: config.processKillGraceMs,
    diagnose: diagnoseRenderProcessOperation,
  });
}

type RequiredSourceOperation =
  | "source_presign"
  | "ranged_probe"
  | "source_download"
  | "local_probe";

function diagnoseRequiredSourceOperation(input: {
  attempt: ClipRenderingWorkflowAttempt;
  operation: RequiredSourceOperation;
  startedAtMs: number;
  failure?: WorkflowFailure;
}): void {
  log(
    input.failure ? "error" : "info",
    input.failure
      ? "clip_render_source_operation_failed"
      : "clip_render_source_operation_completed",
    {
      workflowRunId: input.attempt.workflowRunId,
      projectId: input.attempt.projectId,
      workflowAttemptId: input.attempt.attemptId,
      phase: "source_resolution",
      operation: input.operation,
      ...(input.failure
        ? {
            failureCode: input.failure.code,
            disposition: input.failure.disposition,
          }
        : {}),
      elapsedMs: currentTimeMs() - input.startedAtMs,
    },
  );
}

async function resolveRequiredSource(input: {
  sourceStorageKey: string | null;
  tempDir: string;
  attempt: ClipRenderingWorkflowAttempt;
}): Promise<{ sourcePath: string; probe: SourceProbe }> {
  const sourceStorageKey = input.sourceStorageKey;
  if (!sourceStorageKey) {
    throw new WorkflowFailure(
      "source_storage_key_missing",
      "permanent",
      "The project source file is unavailable",
    );
  }

  const sourceExt = extname(sourceStorageKey) || ".bin";
  const localSourcePath = join(input.tempDir, `source${sourceExt}`);
  currentRenderSignal()?.throwIfAborted();
  if (currentRenderConfig().sourceMode !== "download") {
    let presignedUrl: string | null = null;
    const presignStartedAtMs = currentTimeMs();
    try {
      presignedUrl = await withRenderOperationDeadline({
        operation: () =>
          currentRenderAdapters().storage.presignDownloadUrl({
            key: sourceStorageKey,
            expiresIn: RENDER_SOURCE_URL_TTL_SEC,
          }),
        deadlineMs: currentRenderConfig().storageOperationTimeoutMs,
        timeoutFailure: () =>
          new WorkflowFailure(
            "source_presign_timeout",
            "retryable",
            "Required source presigning timed out",
          ),
      });
      currentRenderSignal()?.throwIfAborted();
      diagnoseRequiredSourceOperation({
        attempt: input.attempt,
        operation: "source_presign",
        startedAtMs: presignStartedAtMs,
      });
    } catch (error) {
      rethrowRenderControlFlow(error);
      const failure =
        error instanceof WorkflowFailure &&
        error.code === "source_presign_timeout"
          ? error
          : new WorkflowFailure(
              "source_presign_failed",
              "retryable",
              "Required source could not be presigned",
            );
      diagnoseRequiredSourceOperation({
        attempt: input.attempt,
        operation: "source_presign",
        startedAtMs: presignStartedAtMs,
        failure,
      });
    }

    if (presignedUrl) {
      currentRenderSignal()?.throwIfAborted();
      const probeStartedAtMs = currentTimeMs();
      try {
        const probe = await probeSource(presignedUrl);
        currentRenderSignal()?.throwIfAborted();
        diagnoseRequiredSourceOperation({
          attempt: input.attempt,
          operation: "ranged_probe",
          startedAtMs: probeStartedAtMs,
        });
        return { sourcePath: presignedUrl, probe };
      } catch (error) {
        rethrowRenderControlFlow(error);
        diagnoseRequiredSourceOperation({
          attempt: input.attempt,
          operation: "ranged_probe",
          startedAtMs: probeStartedAtMs,
          failure: workflowFailureFromUnknown(error),
        });
      }
    }
  }

  currentRenderSignal()?.throwIfAborted();
  const downloadStartedAtMs = currentTimeMs();
  try {
    await currentRenderAdapters().storage.downloadObjectToFile({
      key: sourceStorageKey,
      filePath: localSourcePath,
      signal: renderStorageSignal(),
    });
    currentRenderSignal()?.throwIfAborted();
    diagnoseRequiredSourceOperation({
      attempt: input.attempt,
      operation: "source_download",
      startedAtMs: downloadStartedAtMs,
    });
  } catch (error) {
    rethrowRenderControlFlow(error);
    const failure = new WorkflowFailure(
      "source_download_failed",
      "retryable",
      "Failed to download required source",
    );
    diagnoseRequiredSourceOperation({
      attempt: input.attempt,
      operation: "source_download",
      startedAtMs: downloadStartedAtMs,
      failure,
    });
    throw failure;
  }

  currentRenderSignal()?.throwIfAborted();
  const probeStartedAtMs = currentTimeMs();
  try {
    const probe = await probeSource(localSourcePath);
    currentRenderSignal()?.throwIfAborted();
    diagnoseRequiredSourceOperation({
      attempt: input.attempt,
      operation: "local_probe",
      startedAtMs: probeStartedAtMs,
    });
    return { sourcePath: localSourcePath, probe };
  } catch (error) {
    rethrowRenderControlFlow(error);
    const originalFailure = workflowFailureFromUnknown(error);
    const failure =
      originalFailure.code === "worker_command_input_invalid"
        ? new WorkflowFailure(
            "source_media_invalid",
            "permanent",
            "Required source media could not be read",
            error instanceof Error ? { cause: error } : undefined,
          )
        : originalFailure;
    diagnoseRequiredSourceOperation({
      attempt: input.attempt,
      operation: "local_probe",
      startedAtMs: probeStartedAtMs,
      failure,
    });
    throw failure;
  }
}

/**
 * Decides whether a downloaded canvas-background image should be used as-is
 * or degraded to the solid-color fallback, given whether ffprobe found a
 * decodable video/image stream in it. Kept as a pure function, separate from
 * the ffprobe I/O in `probeBackgroundImageDecodable` below, specifically so
 * the degrade decision is unit-testable without shelling out to ffprobe —
 * tests can stub `decodable` directly.
 */
export function resolveBackgroundPlanForDownloadedImage(params: {
  decodable: boolean;
  color: string;
  imagePath: string;
}): BackgroundPlan {
  if (!params.decodable) {
    return { mode: "color", color: params.color, imagePath: null };
  }
  return { mode: "image", color: params.color, imagePath: params.imagePath };
}

/**
 * Probes a downloaded canvas-background file for a decodable video/image
 * stream. `downloadUrlToFile` only validates HTTP status/size/SSRF — a URL
 * that 200s with an HTML page (e.g. the user pasted a page URL instead of a
 * direct image URL) downloads "successfully" but isn't actually decodable,
 * and feeding it to ffmpeg as `-i` fails every render variant. Mirrors
 * `probeSource`'s ffprobe invocation; returns false (never throws) on any
 * probe failure or parse error so the caller can degrade to the color
 * fallback exactly like a download failure.
 */
async function probeBackgroundImageDecodable(filePath: string): Promise<boolean> {
  try {
    const output = await execCommandOutput(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_streams", filePath],
      { timeoutMs: currentRenderConfig().probeCommandTimeoutMs },
    );
    const data = JSON.parse(output) as {
      streams?: Array<{ codec_type?: string }>;
    };
    return (data.streams ?? []).some((stream) => stream.codec_type === "video");
  } catch (error) {
    rethrowRenderControlFlow(error);
    return false;
  }
}

/**
 * Probes a local media file's container duration. Used to size the B-roll
 * cutaway window against the *real* footage instead of a guess — required for
 * studio-picked B-roll, which (unlike the Pexels auto-search path) has no
 * API-reported duration up front. Returns null on any failure so callers can
 * treat it exactly like "no usable B-roll" and skip the cutaway.
 */
async function probeMediaDurationSec(filePath: string): Promise<number | null> {
  try {
    const output = await execCommandOutput(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_entries",
        "format=duration",
        filePath,
      ],
      { timeoutMs: currentRenderConfig().probeCommandTimeoutMs },
    );
    const data = JSON.parse(output) as { format?: { duration?: string } };
    const parsed = data.format?.duration ? Number(data.format.duration) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch (error) {
    rethrowRenderControlFlow(error);
    return null;
  }
}

type OptionalMediaKind = "video" | "audio" | "image";

async function validateOptionalMedia(
  filePath: string,
  kind: OptionalMediaKind,
): Promise<boolean> {
  try {
    const config = currentRenderConfig();
    const signal = currentRenderSignal() ?? new AbortController().signal;
    const probe = await currentRenderAdapters().media.probe({
      sourcePath: filePath,
      signal,
      deadlineMs: config.probeCommandTimeoutMs,
      killGraceMs: config.processKillGraceMs,
      diagnose: diagnoseRenderProcessOperation,
    });
    const expectedStream =
      kind === "audio" ? probe.hasAudio : probe.hasVideo;
    if (!expectedStream) return false;
    await execCommand(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        filePath,
        "-map",
        kind === "audio" ? "0:a:0" : "0:v:0",
        "-f",
        "null",
        "-",
      ],
      { timeoutMs: config.probeCommandTimeoutMs },
    );
    return true;
  } catch (error) {
    rethrowRenderControlFlow(error);
    return false;
  }
}

/** Python interpreter the detector scripts run under. `REFRAME_PYTHON` lets
 *  a deployment point at a venv that actually has opencv installed (the
 *  system `python3` frequently doesn't — the exact silent-center-crop
 *  failure the logging below exists to surface). */
function reframePythonBin(): string {
  return currentRenderConfig().reframePython;
}

/** Shared failure logging for the null-on-failure detector wrappers below.
 *  These fallbacks used to be completely silent (bare `catch { return null }`),
 *  which let a missing python/opencv/model degrade every render to a static
 *  center crop with zero log evidence — never again. `context` carries the
 *  run/clip correlation ids every other error log in this file has. */
function logDetectionFailure(
  detector: string,
  failureCode: string,
  context?: Record<string, unknown>,
): void {
  log("error", "clip_face_detection_unavailable", {
    detector,
    phase: "media_analysis",
    analysisMode: detector,
    fallbackMode: "center_crop",
    failureCode,
    disposition: "degraded",
    durationMs: 0,
    ...context,
  });
}

function mediaAnalysisFailureCode(error: unknown): string {
  const code =
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "";
  if (code === "worker_command_missing") return "analysis_executable_missing";
  if (code === "worker_command_timeout") return "analysis_timeout";
  if (code === "worker_command_failed" || code === "worker_command_spawn_failed") {
    return "analysis_command_failed";
  }
  return "analysis_unavailable";
}

/**
 * Runs the YuNet Python face detector over a clip's range and returns the
 * per-sample normalized face centers, or null if detection is unavailable
 * (no python/opencv/model, or no faces) — callers fall back to a static crop.
 */
async function detectFacePath(params: {
  sourcePath: string;
  startSec: number;
  durationSec: number;
  logContext?: Record<string, unknown>;
}): Promise<{ samples: FaceSample[] } | null> {
  const scriptPath = fileURLToPath(
    new URL("../../scripts/reframe_detect.py", import.meta.url),
  );
  const modelPath = currentRenderConfig().reframeModelPath;
  const fps = String(currentRenderConfig().reframeSampleFps);

  try {
    const out = await execCommandOutput(reframePythonBin(), [
      scriptPath,
      params.sourcePath,
      String(params.startSec),
      String(params.durationSec),
      fps,
      modelPath,
    ]);
    const parsed = JSON.parse(out) as {
      samples?: Array<{ t: number; cx: number | null }>;
      error?: string;
    };
    if (parsed.error || !Array.isArray(parsed.samples)) {
      logDetectionFailure(
        "face_single",
        "analysis_output_invalid",
        params.logContext,
      );
      return null;
    }
    return { samples: parsed.samples };
  } catch (error) {
    rethrowRenderControlFlow(error);
    logDetectionFailure(
      "face_single",
      mediaAnalysisFailureCode(error),
      params.logContext,
    );
    return null;
  }
}

/** `detectPipPath`'s success result — `movingPxFrac: null` iff
 *  `insufficientSamples` is true (M4/L4, adversarial review: `pip_detect.py`
 *  emits this when too few samples were taken, or the samples taken covered
 *  too little of the requested window, rather than a misleadingly-precise
 *  `0.0` that would read as "definitely screencast-like"). */
interface PipDetectResult {
  movingPxFrac: number | null;
  insufficientSamples: boolean;
  candidates: PipCandidate[];
}

/**
 * Element segmentation v1 ("screen" framing mode, vizard-parity.md's
 * element-segmentation spike): runs `pip_detect.py` over a clip's range and
 * returns the raw motion signal (`movingPxFrac`) + candidate facecam PiP
 * regions, or null if detection is unavailable (no python/opencv/numpy, or
 * the script itself errored) — same null-on-failure contract as
 * `detectFacePath`, callers fall back to the existing whole-frame face-
 * tracked/static-center bottom tile. Classification (`classifyScreencast`)
 * and selection (`selectPipRect`) are deliberately NOT done here — this
 * function is pure IO, screen-layout.ts owns the policy.
 */
async function detectPipPath(params: {
  sourcePath: string;
  startSec: number;
  durationSec: number;
}): Promise<PipDetectResult | null> {
  const scriptPath = fileURLToPath(
    new URL("../../scripts/pip_detect.py", import.meta.url),
  );

  try {
    const out = await execCommandOutput(reframePythonBin(), [
      scriptPath,
      params.sourcePath,
      String(params.startSec),
      String(params.durationSec),
    ]);
    const parsed = JSON.parse(out) as {
      movingPxFrac?: number | null;
      insufficientSamples?: boolean;
      candidates?: PipCandidate[];
      error?: string;
    };
    if (
      parsed.error ||
      !Array.isArray(parsed.candidates) ||
      (parsed.movingPxFrac !== null &&
        parsed.movingPxFrac !== undefined &&
        typeof parsed.movingPxFrac !== "number")
    ) {
      logDetectionFailure("pip", "analysis_output_invalid");
      return null;
    }
    return {
      movingPxFrac: parsed.movingPxFrac ?? null,
      insufficientSamples: Boolean(parsed.insufficientSamples),
      candidates: parsed.candidates,
    };
  } catch (error) {
    rethrowRenderControlFlow(error);
    logDetectionFailure("pip", mediaAnalysisFailureCode(error));
    return null;
  }
}

/**
 * Multi-face sibling of `detectFacePath` (split packet B, vizard-parity.md
 * "Split-screen 2-up") — runs the same YuNet detector script in `--multi`
 * mode (see `reframe_detect.py`'s doc comment) so every sample carries ALL
 * detected faces (not just the dominant one), the raw input
 * `buildSplitLayoutPlan`'s clustering/shot-classification pipeline needs.
 * Same env/model/fps handling, same null-on-failure/no-model/no-python
 * contract as `detectFacePath` — callers fall back to single-speaker framing.
 */
async function detectMultiFacePath(params: {
  sourcePath: string;
  startSec: number;
  durationSec: number;
  logContext?: Record<string, unknown>;
}): Promise<{ samples: MultiFaceSample[] } | null> {
  const scriptPath = fileURLToPath(
    new URL("../../scripts/reframe_detect.py", import.meta.url),
  );
  const modelPath = currentRenderConfig().reframeModelPath;
  const fps = String(currentRenderConfig().reframeSampleFps);

  try {
    const out = await execCommandOutput(reframePythonBin(), [
      scriptPath,
      params.sourcePath,
      String(params.startSec),
      String(params.durationSec),
      fps,
      modelPath,
      "--multi",
    ]);
    const parsed = JSON.parse(out) as {
      samples?: Array<{
        t: number;
        faces?: Array<{
          cx: number;
          cy: number;
          w: number;
          h: number;
          score: number;
          m?: number | null;
          fm?: number | null;
        }>;
      }>;
      error?: string;
    };
    if (parsed.error || !Array.isArray(parsed.samples)) {
      logDetectionFailure(
        "face_multi",
        "analysis_output_invalid",
        params.logContext,
      );
      return null;
    }
    return {
      samples: parsed.samples.map((s) => ({ t: s.t, faces: s.faces ?? [] })),
    };
  } catch (error) {
    rethrowRenderControlFlow(error);
    logDetectionFailure(
      "face_multi",
      mediaAnalysisFailureCode(error),
      params.logContext,
    );
    return null;
  }
}

/**
 * Scene-cut detection (layout-engine wiring): runs ffmpeg's scene-change
 * `select` filter over the SAME low-res local segment face detection uses
 * and returns clip-relative cut times in seconds. Best-effort: any failure
 * returns [] (the layout engine then treats the clip as one shot) — never
 * blocks a render. `-ss` before `-i` is frame-accurate here (default
 * accurate_seek decodes from the prior keyframe and discards preroll) and
 * resets output timestamps to ~0, which is exactly the clip-relative
 * timebase the detector samples use.
 */
async function detectSceneCuts(params: {
  sourcePath: string;
  startSec: number;
  durationSec: number;
  workflowRunId: string;
  clipId: string;
}): Promise<number[]> {
  const threshold = String(currentRenderConfig().reframeSceneThreshold);
  try {
    const out = await execCommandOutput("ffmpeg", [
      "-hide_banner",
      "-nostats",
      ...(params.startSec > 0 ? ["-ss", String(params.startSec)] : []),
      "-t",
      String(params.durationSec),
      "-i",
      params.sourcePath,
      "-vf",
      `select='gt(scene,${threshold})',metadata=print:file=-`,
      "-an",
      "-f",
      "null",
      "-",
    ]);
    const cuts: number[] = [];
    for (const match of out.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)) {
      cuts.push(Number(match[1]));
    }
    return cuts;
  } catch (error) {
    rethrowRenderControlFlow(error);
    log("error", "clip_scene_detect_failed", {
      workflowRunId: params.workflowRunId,
      clipId: params.clipId,
      ...mediaAnalysisDiagnostic({
        analysisMode: "scene_detection",
        fallbackMode: "single_shot",
        failureCode: "analysis_unavailable",
      }),
    });
    return [];
  }
}

/**
 * Scene-cut sibling of `remapMultiFaceSamplesForCutPlan`: drops cuts inside
 * a deleted range and remaps the rest from elapsed-uncut-source seconds onto
 * the edited timeline. Every kept-segment boundary is ALSO a scene cut on
 * the edited timeline (the concat joins footage that was never adjacent),
 * so those are appended too.
 */
export function remapSceneCutsForCutPlan(
  cuts: number[],
  cutPlan: ClipCutPlan,
  clipStartSec: number,
): number[] {
  if (cutPlan.isUncut) {
    // Same normalization contract as the cut branch below (sorted, deduped
    // at ms precision) so callers never see two shapes of output.
    return [...new Set(cuts.map((t) => Math.round(t * 1000) / 1000))].sort(
      (a, b) => a - b,
    );
  }
  const out: number[] = [];
  for (const cut of cuts) {
    const sourceSec = clipStartSec + cut;
    const segment = cutPlan.segments.find(
      (s) => sourceSec >= s.sourceStartSec && sourceSec <= s.sourceEndSec,
    );
    if (!segment) continue;
    out.push(sourceToEdited(cutPlan.map, sourceSec));
  }
  for (const segment of cutPlan.segments.slice(1)) {
    out.push(segment.editedStartSec);
  }
  return [...new Set(out.map((t) => Math.round(t * 1000) / 1000))].sort(
    (a, b) => a - b,
  );
}

/**
 * Extracts a low-res local segment for face detection when the source is an
 * HTTP(S) presigned URL (the YuNet detector needs a frame-accurate local
 * file) — shared by both the single-face auto-reframe path and the
 * multi-face split-detection path (split packet B), which previously
 * duplicated this exact extraction. Re-encodes (never `-c copy`: a stream
 * copy snaps to the previous keyframe and would shift every face sample by
 * up to a GOP). Returns the ORIGINAL `sourcePath`/`clipStartSec` unchanged
 * for a local/non-HTTP source (no extraction needed), or null on any
 * extraction failure — callers already fall back to a static/center crop.
 * `suffix` keeps the two call sites' temp files from colliding when both run
 * for the same clip (split falling back to auto-reframe within one render).
 */
async function extractFaceDetectionSegment(params: {
  sourcePath: string;
  tempDir: string;
  clipId: string;
  workflowRunId: string;
  clipStartSec: number;
  durationSec: number;
  suffix?: string;
}): Promise<{ path: string; startSec: number } | null> {
  if (!isHttpSource(params.sourcePath)) {
    return { path: params.sourcePath, startSec: params.clipStartSec };
  }
  const segmentPath = join(
    params.tempDir,
    `face-seg-${params.clipId}${params.suffix ?? ""}.mp4`,
  );
  try {
    await execCommand("ffmpeg", [
      "-y",
      ...httpSourceInputArgs(params.sourcePath),
      "-ss",
      String(params.clipStartSec),
      "-t",
      String(params.durationSec),
      "-i",
      params.sourcePath,
      "-map",
      "0:v:0",
      "-vf",
      "scale=-2:360",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "30",
      "-an",
      segmentPath,
    ]);
    return { path: segmentPath, startSec: 0 };
  } catch (segmentError) {
    rethrowRenderControlFlow(segmentError);
    log("error", "clip_reframe_segment_extract_failed", {
      workflowRunId: params.workflowRunId,
      clipId: params.clipId,
      ...mediaAnalysisDiagnostic({
        analysisMode: "segment_extraction",
        fallbackMode: "center_crop",
        failureCode: "analysis_input_unavailable",
      }),
    });
    return null;
  }
}

/**
 * Drives every `reframeOutputs` output's crop via sendcmd from an already-
 * detected single-face sample list — the exact logic
 * the Clip Render Attempt's "auto" framing branch used to inline,
 * extracted (split packet B) so the split-mode fallback path below (footage
 * that can't support a real 2-up) can reuse it verbatim instead of
 * re-implementing the same remap -> smooth -> sendcmd-script pipeline a
 * second time. Returns whether a reframe was actually applied (false: no
 * samples, or they produced zero usable smoothed points) purely for the
 * caller's own logging/bookkeeping.
 *
 * Takes ALREADY-DETECTED `samples` rather than running `detectFacePath`
 * itself (M2, adversarial review): a split-mode clip that falls back after
 * multi-face detection already ran and succeeded can derive these from that
 * multi-face result (`deriveSingleFaceSamplesFromMulti`) instead of paying
 * for a second full YuNet pass — see this function's call sites for which
 * path each one takes.
 */
async function applyAutoReframe(params: {
  samples: FaceSample[] | null;
  cutPlan: ClipCutPlan;
  clipStartSec: number;
  probe: SourceProbe;
  outputs: PendingRenderOutput[];
  reframeOutputs: PendingRenderOutput[];
  tempDir: string;
  clipId: string;
  workflowRunId: string;
}): Promise<boolean> {
  const analysisStartedAtMs = currentTimeMs();
  let smoothed: SmoothedSample[] = [];
  if (params.samples) {
    const segmentGroups = remapFaceSamplesForCutPlan(
      params.samples,
      params.cutPlan,
      params.clipStartSec,
    );
    smoothed = segmentGroups.flatMap((group) => smoothFacePath(group));
  }
  if (smoothed.length === 0) {
    // The static-center-crop fallback used to be silent — surface WHY the
    // reframe didn't happen so a missing detector can't hide again.
    log("info", "clip_reframe_skipped", {
      workflowRunId: params.workflowRunId,
      clipId: params.clipId,
      phase: "media_analysis",
      analysisMode: "auto_reframe",
      fallbackMode: "center_crop",
      failureCode: params.samples
        ? "no_usable_face_samples"
        : "analysis_unavailable",
      disposition: "degraded",
      durationMs: Math.max(0, currentTimeMs() - analysisStartedAtMs),
      reason: params.samples
        ? "no_usable_face_samples"
        : "detection_unavailable",
    });
    return false;
  }

  const single = params.outputs.length === 1;
  for (let i = 0; i < params.outputs.length; i++) {
    const output = params.outputs[i]!;
    if (!params.reframeOutputs.includes(output)) continue;
    const cfg = aspectRatioConfig.get(output.aspectRatio)!;
    const cropW = Math.round(params.probe.height * (cfg.width / cfg.height));
    const cropName = single ? REFRAME_CROP_NAME : `${REFRAME_CROP_NAME}${i}`;
    const script = buildReframeSendcmdScript(
      smoothed,
      params.probe.width,
      cropW,
      cropName,
    );
    if (!script) continue;
    const scriptPath = join(
      params.tempDir,
      `reframe-${params.clipId}-${output.aspectRatio.replace(":", "x")}.txt`,
    );
    await currentRenderAdapters().workspace.writeFile(
      scriptPath,
      script,
      "utf-8",
    );
    output.reframe = { scriptPath, cropName };
  }
  log("info", "clip_reframe_applied", {
    workflowRunId: params.workflowRunId,
    clipId: params.clipId,
    phase: "media_analysis",
    analysisMode: "auto_reframe",
    selectedMode: "face_tracked",
    durationMs: Math.max(0, currentTimeMs() - analysisStartedAtMs),
    outputs: params.outputs.filter((o) => o.reframe).map((o) => o.aspectRatio),
  });
  return true;
}

/** M6 (adversarial review): every reason `decidePipUsage` can return —
 *  `"ok"` means every gate passed and the caller should prefer the PiP
 *  crop; anything else means fall through to the existing band (face-
 *  tracked sendcmd or static-center) behavior. Ordered top-to-bottom the
 *  same way `decidePipUsage` itself checks them (first blocking reason
 *  wins) — see that function's own doc comment for what each one means. */
export type PipUsageReason =
  | "disabled"
  | "segment_extract_failed"
  | "detection_unavailable"
  | "insufficient_samples"
  | "not_screencast_like"
  | "no_candidate"
  | "face_not_in_rect"
  | "pip_too_small"
  | "ok";

export interface DecidePipUsageParams {
  /** `WORKER_PIP_DETECT` kill switch state. */
  pipDetectEnabled: boolean;
  /** Whether `extractFaceDetectionSegment` produced a usable local segment
   *  (both `pip_detect.py` and `detectFacePath` run against the SAME
   *  segment — see this module's doc comment on the "real screen layout"
   *  wiring). */
  segmentExtracted: boolean;
  /** `detectPipPath`'s result, or `null` when the script itself failed/was
   *  unavailable (no python/opencv/numpy). */
  detection: { movingPxFrac: number | null; insufficientSamples: boolean } | null;
  /** `classifyScreencast`'s threshold override — defaults to
   *  `pipMotionThreshold()` inside `classifyScreencast` itself when
   *  omitted, same as every other caller. */
  screencastThreshold?: number;
  /** `selectPipRect`'s result over `detection`'s candidates. */
  selectedRect: PipRect | null;
  /** `confirmsFaceInRect`'s result for `selectedRect` — H2, adversarial
   *  review: only meaningful when `selectedRect` is non-null; irrelevant
   *  otherwise since an earlier gate (`no_candidate`) already blocks first. */
  faceConfirmed: boolean;
  /** M3 (adversarial review): the PER-OUTPUT `fitPipCropToTile` result
   *  compared against that output's own tile width
   *  (`pipCropTooSmall`, screen-layout.ts) — omit (or pass `null`) to skip
   *  this gate entirely, e.g. for a clip-level "would we even attempt the
   *  rect at all" check made before any output-specific fitting has run. */
  fit?: { fittedCropWidth: number; tileWidth: number } | null;
}

/**
 * M6 (adversarial review): the PiP decision matrix, pulled out of what used
 * to be a chain of inline if/else branches spread across the "real screen
 * layout" wiring below AND (for `pip_too_small`) `applyScreenSpeakerLayout`'s
 * per-output loop — a single pure, exported, ordered gate so the whole
 * matrix (not just individual branches) is unit-testable, and so the SAME
 * ordering can't drift between a clip-level check (`fit: null`, run once
 * before any per-output geometry exists) and a per-output check (`fit` set,
 * run inside `applyScreenSpeakerLayout`'s loop) — both call sites share this
 * one function rather than reimplementing the ladder twice.
 *
 * Ordered top-to-bottom, first blocking reason wins:
 *  1. `disabled` — `WORKER_PIP_DETECT=0` kill switch.
 *  2. `segment_extract_failed` — `extractFaceDetectionSegment` failed (HTTP
 *     source, extraction itself errored).
 *  3. `detection_unavailable` — `pip_detect.py` failed/unavailable (no
 *     python/opencv/numpy, or it errored).
 *  4. `insufficient_samples` — M4/L4: `pip_detect.py` couldn't sample enough
 *     of the requested window to trust `movingPxFrac` either direction
 *     (fails safe: NEVER treated as "definitely screencast-like").
 *  5. `not_screencast_like` — `classifyScreencast` rejected the clip's
 *     overall motion profile.
 *  6. `no_candidate` — `selectPipRect` found no qualifying region.
 *  7. `face_not_in_rect` — H2: `confirmsFaceInRect` couldn't confirm a face
 *     actually sits inside the selected rect — the guard against motion
 *     segmentation's measured false positive (a hand gesture near the frame
 *     edge on real talking-head footage reads as a corner-adjacent, dense,
 *     compact motion blob just like a genuine facecam overlay).
 *  8. `pip_too_small` — M3: the per-output fitted crop is too narrow
 *     relative to its tile to be worth preferring over the band fallback.
 *  9. `ok` — every gate passed; the caller should use the PiP crop.
 */
export function decidePipUsage(
  params: DecidePipUsageParams,
): { useRect: boolean; reason: PipUsageReason } {
  if (!params.pipDetectEnabled) return { useRect: false, reason: "disabled" };
  if (!params.segmentExtracted) return { useRect: false, reason: "segment_extract_failed" };
  if (!params.detection) return { useRect: false, reason: "detection_unavailable" };
  if (params.detection.insufficientSamples || params.detection.movingPxFrac === null) {
    return { useRect: false, reason: "insufficient_samples" };
  }
  if (!classifyScreencast(params.detection.movingPxFrac, params.screencastThreshold)) {
    return { useRect: false, reason: "not_screencast_like" };
  }
  if (!params.selectedRect) return { useRect: false, reason: "no_candidate" };
  if (!params.faceConfirmed) return { useRect: false, reason: "face_not_in_rect" };
  if (params.fit && pipCropTooSmall(params.fit.fittedCropWidth, params.fit.tileWidth)) {
    return { useRect: false, reason: "pip_too_small" };
  }
  return { useRect: true, reason: "ok" };
}

/**
 * PiP persistence packet B: does a persisted `Clip.layoutAnalysis` envelope
 * still describe THIS render's detection window? The screen-mode block below
 * writes `sourceStartSec`/`sourceDurationSec` as `clipStartSec`/
 * `effective.durationSec` — the clip's real source-time detection window —
 * deliberately NOT `detectInput.startSec` (the coordinates actually passed
 * to `detectPipPath`), because `extractFaceDetectionSegment` re-bases an
 * HTTP source's extracted segment to start at 0 regardless of where in the
 * source it was cut from; comparing against that would make every HTTP-
 * sourced clip's window look identical no matter how it was trimmed. Reading
 * `clipStartSec`/`effective.durationSec` on both the write and read side
 * keeps the comparison meaningful for local AND HTTP sources alike.
 *
 * No separate invalidation hook exists for a trim (or any other edit that
 * moves the clip's `startSec`/`endSec`) — a trim changes
 * `clipStartSec`/`effective.durationSec` on the NEXT render, this match
 * fails, the stale envelope is simply not read, and the fresh detection that
 * runs instead overwrites it via `clipService.setClipLayoutAnalysis`. The
 * mismatch itself IS the invalidation.
 *
 * `epsilonSec` absorbs float round-trip noise (JSON storage through
 * `Prisma.InputJsonValue`, floating-point arithmetic in
 * `resolveRenderTimingForClip`) without being loose enough to treat a real,
 * perceptible trim as a match.
 */
export function layoutAnalysisMatchesWindow(
  analysis: Pick<ClipLayoutAnalysis, "sourceStartSec" | "sourceDurationSec">,
  startSec: number,
  durationSec: number,
  epsilonSec = 0.05,
): boolean {
  return (
    Math.abs(analysis.sourceStartSec - startSec) <= epsilonSec &&
    Math.abs(analysis.sourceDurationSec - durationSec) <= epsilonSec
  );
}

/** Builds a `Clip.layoutAnalysis` v1 envelope from its constituent parts —
 *  shared by `resolvePipAnalysis`'s own early (conclusive-negative) persist
 *  and the screen-mode block's later (post-`decidePipUsage`) persist below,
 *  so the two write sites can't drift on which fields land where. */
function buildLayoutAnalysisEnvelope(params: {
  startSec: number;
  durationSec: number;
  /** H2 (adversarial review): the RAW `Clip.startSec`/`Clip.endSec` row —
   *  see the schema's own doc comment (`clip-layout-analysis.ts`) for why
   *  this is a SEPARATE pair from `startSec`/`durationSec` above (the
   *  snapped render window). */
  rawClipStartSec: number;
  rawClipEndSec: number;
  movingPxFrac: number | null;
  insufficientSamples: boolean;
  pipRect: PipRect | null;
  pipUsable: boolean;
}): ClipLayoutAnalysis {
  return {
    version: 1,
    analyzedAtISO: new Date(currentTimeMs()).toISOString(),
    sourceStartSec: params.startSec,
    sourceDurationSec: params.durationSec,
    clipStartSec: params.rawClipStartSec,
    clipEndSec: params.rawClipEndSec,
    movingPxFrac: params.movingPxFrac,
    insufficientSamples: params.insufficientSamples,
    pipRect: params.pipRect,
    pipUsable: params.pipUsable,
  };
}

/** `detectPipPath`'s success result shape, standalone so `resolvePipAnalysis`'s
 *  injected `detect` param (and its test doubles) don't need to reference
 *  `detectPipPath` itself. Identical shape to that function's private
 *  `PipDetectResult` — kept as two names since one is this module's public,
 *  DI-facing contract and the other is `detectPipPath`'s own internal return
 *  type; they're structurally the same on purpose. */
export interface PipDetectionResult {
  movingPxFrac: number | null;
  insufficientSamples: boolean;
  candidates: PipCandidate[];
}

export interface ResolvePipAnalysisParams {
  /** The persisted `Clip.layoutAnalysis` envelope, ALREADY checked by the
   *  caller against this render's window (`layoutAnalysisMatchesWindow`) —
   *  `null` means "nothing usable to reuse" (column was null, parse failed,
   *  or the window no longer matches), not literally "column is null." */
  persisted: ClipLayoutAnalysis | null;
  /** `WORKER_PIP_DETECT` kill switch — mirrors `decidePipUsage`'s own
   *  `pipDetectEnabled`. When false, neither `detect` nor `persist` is ever
   *  called: the kill switch means "no persistence side effects at all,"
   *  not just "no fresh detection." */
  pipDetectEnabled: boolean;
  detectInput: { path: string; startSec: number } | null;
  /** The clip's real source-time detection window — written into a freshly
   *  persisted envelope's `sourceStartSec`/`sourceDurationSec` (see
   *  `layoutAnalysisMatchesWindow`'s doc comment for why this, not
   *  `detectInput.startSec`). */
  startSec: number;
  durationSec: number;
  /** H2 (adversarial review): the RAW `Clip.startSec`/`Clip.endSec` row —
   *  written into a freshly persisted envelope's `clipStartSec`/`clipEndSec`.
   *  See `buildLayoutAnalysisEnvelope`'s doc comment for why this is a
   *  separate pair from `startSec`/`durationSec` above. */
  rawClipStartSec: number;
  rawClipEndSec: number;
  detect: (params: {
    sourcePath: string;
    startSec: number;
    durationSec: number;
  }) => Promise<PipDetectionResult | null>;
  /** Injected so tests can fake persistence without a database — see this
   *  function's own doc comment for exactly when it's called. Errors are
   *  caught and logged here (log-and-continue): a persistence miss must
   *  never fail an otherwise-successful render. */
  persist: (envelope: ClipLayoutAnalysis) => Promise<void>;
  /** Merged into the `clip_screen_layout_analysis_persist_failed` log on a
   *  `persist` failure — purely for observability, no behavioral effect. */
  logContext?: Record<string, unknown>;
}

export interface ResolvePipAnalysisResult {
  detectionResult: { movingPxFrac: number | null; insufficientSamples: boolean } | null;
  selectedRect: PipRect | null;
  /** `null` for a persisted-hit (no fresh candidate list exists to count —
   *  L1, adversarial review: NOT `0`, which would misleadingly read as "ran
   *  detection, found zero candidates") or when detection never ran at all
   *  (disabled, no segment, or the script failed/was unavailable); the
   *  fresh-detection candidate count otherwise. */
  candidateCount: number | null;
  analysisSource: "persisted" | "fresh" | null;
}

/**
 * M2 (adversarial review): the PiP persistence read-before-detect /
 * write-after-detect decision, pulled out of the screen-mode render block
 * into one dependency-injected, unit-testable function — `detect`/`persist`
 * are injected so tests can fake both without touching `pip_detect.py` or
 * the database.
 *
 * Persistence split (C1, adversarial review): this function ONLY persists
 * the CONCLUSIVE-NEGATIVE case — a fresh detection whose `selectPipRect`
 * found no qualifying candidate at all (`selectedRect === null`). That
 * case's `pipUsable` is unconditionally `false` (`decidePipUsage`'s
 * `no_candidate` gate rejects a null `selectedRect` regardless of face
 * confirmation), so there's nothing left to wait for. Every OTHER fresh-
 * detection outcome (a non-null `selectedRect`) leaves persistence to the
 * CALLER, which must write the envelope only AFTER running `decidePipUsage`
 * with THAT render's own `faceConfirmed` — `pipUsable` genuinely can't be
 * known here, since face confirmation runs after this function returns (see
 * render-clips.ts's screen-mode block, and `ClipLayoutAnalysis.pipUsable`'s
 * own doc comment for why the persisted `pipRect` is never nulled out just
 * because a gate failed).
 */
export async function resolvePipAnalysis(
  params: ResolvePipAnalysisParams,
): Promise<ResolvePipAnalysisResult> {
  if (params.persisted) {
    return {
      detectionResult: {
        movingPxFrac: params.persisted.movingPxFrac,
        insufficientSamples: params.persisted.insufficientSamples,
      },
      selectedRect: params.persisted.pipRect,
      candidateCount: null,
      analysisSource: "persisted",
    };
  }

  if (!params.pipDetectEnabled || !params.detectInput) {
    return {
      detectionResult: null,
      selectedRect: null,
      candidateCount: null,
      analysisSource: null,
    };
  }

  const pip = await params.detect({
    sourcePath: params.detectInput.path,
    startSec: params.detectInput.startSec,
    durationSec: params.durationSec,
  });
  if (!pip) {
    return {
      detectionResult: null,
      selectedRect: null,
      candidateCount: null,
      analysisSource: null,
    };
  }

  const detectionResult = {
    movingPxFrac: pip.movingPxFrac,
    insufficientSamples: pip.insufficientSamples,
  };
  const candidateCount = pip.candidates.length;
  // Selected NOW (pre face-confirmation) — the envelope persists this
  // SELECTED rect, not the raw candidate list. `decidePipUsage`'s
  // `face_not_in_rect` gate (fed by `faceConfirmed`, computed by the caller
  // further down from THIS render's own face samples) still runs on every
  // render, fresh or persisted, since face confirmation isn't a geometry
  // fact that's safe to cache — see `ClipLayoutAnalysis`'s doc comment.
  const selectedRect = selectPipRect(pip.candidates);

  if (!selectedRect) {
    const envelope = buildLayoutAnalysisEnvelope({
      startSec: params.startSec,
      durationSec: params.durationSec,
      rawClipStartSec: params.rawClipStartSec,
      rawClipEndSec: params.rawClipEndSec,
      movingPxFrac: pip.movingPxFrac,
      insufficientSamples: pip.insufficientSamples,
      pipRect: null,
      pipUsable: false,
    });
    try {
      await params.persist(envelope);
    } catch (persistError) {
      rethrowRenderControlFlow(persistError);
      log("error", "clip_screen_layout_analysis_persist_failed", {
        ...params.logContext,
        ...mediaAnalysisDiagnostic({
          analysisMode: "picture_in_picture",
          fallbackMode: "render_without_persisted_analysis",
          failureCode: "analysis_persist_failed",
        }),
      });
    }
  }

  return { detectionResult, selectedRect, candidateCount, analysisSource: "fresh" };
}

/**
 * Screen packet B ("screen" framing mode, the worker render path): drives
 * every `outputs[]` entry's screen-layout BOTTOM (speaker) tile via sendcmd
 * from an already-detected single-face sample list — the sibling of
 * `applyAutoReframe` above, same remap -> smooth -> sendcmd-script pipeline,
 * but setting a `ScreenSpeakerBottomSpec` (consumed by
 * `buildScreenSpeakerFilterChain`'s `bottom` param, threaded through
 * `buildSingleVideoArgs`'s `screen` param) on EVERY output rather than only
 * the subset `applyAutoReframe`'s `reframeOutputs` filter would select — a
 * screen-mode bottom tile always crops the source to a tile-aspect region,
 * there's no "source already narrow enough to skip cropping" escape hatch
 * the way a full-frame reframe has.
 *
 * Deliberately does NOT fall back to the whole-clip auto-reframe path when
 * no face is detected (unlike split, which gives up on the whole 2-up and
 * re-frames the entire output around the single face instead): the
 * static-center crop this sets per output when `smoothed` is empty, a given
 * output's sendcmd script comes back empty (e.g. every sample landed on the
 * same x), or the output has no lateral room to track in at all
 * (`screenBottomIsTrackable` — H3, adversarial review: 1:1/16:9 against a
 * landscape source) IS the fallback. A screen layout with a centered bottom
 * tile is still a real, useful render — the whole point of this framing mode
 * is the TOP tile (the full source frame, always rendered, never cropped),
 * so losing speaker tracking on the bottom tile is a minor degradation, not
 * a reason to throw away the layout entirely. Returns whether a face-tracked
 * OR PiP-tracked (not static-center) crop was actually applied to at least
 * one output, purely for the caller's `clip_screen_bottom_center_fallback`
 * logging.
 *
 * Element segmentation v1 (this packet): `params.pipRect`, when set, means
 * the CLIP-LEVEL gates in `decidePipUsage` (everything except `pip_too_small`,
 * which needs per-output geometry) already passed — see
 * `ScreenSpeakerBottomSpec.pipRect`'s doc comment for why a confirmed
 * facecam PiP crop is preferred over face-tracking/static-center (it's a
 * real sub-region of the frame, not an approximation of one) and why
 * `screenBottomIsTrackable` doesn't gate it (that gate is specifically about
 * a *sendcmd-driven* crop having lateral room to move; a static PiP crop
 * doesn't move). H2/M3 (adversarial review): `params.pipRect` being set is
 * NOT the final word per output — this function still runs `decidePipUsage`
 * again PER OUTPUT with that output's own `fitPipCropToTile` result, since
 * `pip_too_small` can differ by output aspect ratio (a rect that fits a 9:16
 * tile comfortably might be too small relative to a 16:9 tile's width). Any
 * output `decidePipUsage` rejects at that point falls through to the SAME
 * face-tracked/static-center logic as when `pipRect` was never set — it
 * does not get a "no fallback" carve-out just because a candidate rect
 * existed at the clip level.
 */
function faceBandSegmentsForCompositionPlan(input: {
  samples: FaceSample[] | null;
  cutPlan: ClipCutPlan;
  clipStartSec: number;
  editedDurationSec: number;
}): ClipAutoLayoutSegment[] | null {
  if (!input.samples || input.samples.length === 0) return null;
  const points = remapFaceSamplesForCutPlan(
    input.samples,
    input.cutPlan,
    input.clipStartSec,
  )
    .flatMap((group) => smoothFacePath(group))
    .filter(
      (sample) =>
        Number.isFinite(sample.t) &&
        Number.isFinite(sample.cx) &&
        sample.t >= 0 &&
        sample.t < input.editedDurationSec - 0.001,
    )
    .sort((left, right) => left.t - right.t);
  if (points.length === 0) return null;

  const deduplicated: SmoothedSample[] = [];
  for (const point of points) {
    const previous = deduplicated.at(-1);
    if (previous && Math.abs(previous.t - point.t) <= 0.001) {
      deduplicated[deduplicated.length - 1] = point;
      continue;
    }
    deduplicated.push(point);
  }

  const bounded =
    deduplicated.length <= 64
      ? deduplicated
      : Array.from({ length: 64 }, (_, index) => {
          const time = (index / 64) * input.editedDurationSec;
          let selected = deduplicated[0]!;
          for (const candidate of deduplicated) {
            if (candidate.t > time) break;
            selected = candidate;
          }
          return { t: time, cx: selected.cx };
        });

  return bounded.map((point, index) => ({
    startSec: index === 0 ? 0 : point.t,
    endSec: bounded[index + 1]?.t ?? input.editedDurationSec,
    layout: "single" as const,
    cxNorm: point.cx,
    cyNorm: 0.5,
    zoom: 1,
  }));
}

async function applyScreenSpeakerLayout(params: {
  samples: FaceSample[] | null;
  pipRect: PipRect | null;
  /** The SAME base inputs `decidePipUsage` was already called with (minus
   *  `fit`) to decide whether `pipRect` should even be non-null — reused
   *  here, per output, WITH `fit` filled in, to catch `pip_too_small`. Only
   *  consulted when `pipRect` is non-null. */
  pipUsageBase: Omit<DecidePipUsageParams, "fit">;
  cutPlan: ClipCutPlan;
  clipStartSec: number;
  probe: SourceProbe;
  outputs: PendingRenderOutput[];
  tempDir: string;
  clipId: string;
  workflowRunId: string;
}): Promise<boolean> {
  let smoothed: SmoothedSample[] = [];
  if (params.samples) {
    const segmentGroups = remapFaceSamplesForCutPlan(
      params.samples,
      params.cutPlan,
      params.clipStartSec,
    );
    smoothed = segmentGroups.flatMap((group) => smoothFacePath(group));
  }

  const single = params.outputs.length === 1;
  let appliedPip = false;
  let appliedFaceTracking = false;

  for (let i = 0; i < params.outputs.length; i++) {
    const output = params.outputs[i]!;
    const { tileRatio, tileWidth } = screenTileGeometry(output.aspectRatio, params.probe);

    if (params.pipRect) {
      const fitted = fitPipCropToTile(params.pipRect, tileRatio, params.probe);
      const decision = decidePipUsage({
        ...params.pipUsageBase,
        fit: { fittedCropWidth: fitted.w, tileWidth },
      });
      if (decision.useRect) {
        output.screenBottom = { cx: 0.5, pipRect: fitted };
        appliedPip = true;
        // L3 (adversarial review): logs BOTH the normalized rect
        // (`selectPipRect`'s output, same for every output) and this
        // OUTPUT's own fitted source-pixel rect — the normalized rect alone
        // can't answer "what did ffmpeg actually crop for the 16:9 output,"
        // since that's `fitPipCropToTile`'s per-output result, not a value
        // that exists until this loop runs.
        log("info", "clip_screen_pip_detected", {
          workflowRunId: params.workflowRunId,
          clipId: params.clipId,
          ...mediaAnalysisDiagnostic({
            analysisMode: "picture_in_picture",
            selectedMode: "pip_crop",
          }),
          aspectRatio: output.aspectRatio,
          normalizedRect: params.pipRect,
          sourcePxRect: fitted,
        });
        continue;
      }
      log("info", "clip_screen_pip_fallback", {
        workflowRunId: params.workflowRunId,
        clipId: params.clipId,
        ...mediaAnalysisDiagnostic({
          analysisMode: "picture_in_picture",
          fallbackMode: "speaker_band",
          failureCode: decision.reason,
        }),
        aspectRatio: output.aspectRatio,
        reason: decision.reason,
      });
      // Falls through to the face-tracked/static-center logic below for
      // THIS output only — other outputs in the same loop may still use
      // the rect just fine.
    }

    // H3 (adversarial review): wide/square targets (1:1, 16:9 against a
    // landscape source) have no lateral room for the bottom tile's crop to
    // move — `computeTileCrop`'s width already equals the full source
    // width, so `cropXForCenter`'s clamp forces every possible face
    // position to the identical `x`. Driving that with a sendcmd script
    // would be a pure no-op that still costs a script file and an extra
    // filter stage, and used to still log `bottomTracking: "face"` even
    // though nothing was actually tracked. Skip it outright and render an
    // honest static-center bottom tile instead.
    if (!screenBottomIsTrackable(output.aspectRatio, params.probe)) {
      output.screenBottom = { cx: 0.5, reframe: null };
      log("info", "clip_screen_bottom_center_fallback", {
        workflowRunId: params.workflowRunId,
        clipId: params.clipId,
        ...mediaAnalysisDiagnostic({
          analysisMode: "screen_layout",
          fallbackMode: "center_crop",
          failureCode: "no_lateral_room",
        }),
        reason: "no_lateral_room",
        aspectRatio: output.aspectRatio,
      });
      continue;
    }

    // H1 (adversarial review): geometry comes from the SAME
    // `screenTileGeometry` `buildScreenSpeakerFilterChain` uses — this used
    // to re-derive tileHeight/tileRatio/cropW independently, which is
    // exactly how C1's odd-tile-height fix could have landed here and not
    // there with no error (ffmpeg clamps a mismatched `x`, it doesn't
    // reject it).
    const { cropW } = screenTileGeometry(output.aspectRatio, params.probe);
    const cropName = single ? SCREEN_BOTTOM_CROP_NAME : `${SCREEN_BOTTOM_CROP_NAME}${i}`;

    const script =
      smoothed.length > 0
        ? buildReframeSendcmdScript(smoothed, params.probe.width, cropW, cropName)
        : "";

    if (script) {
      const scriptPath = join(
        params.tempDir,
        `screen-bottom-${params.clipId}-${output.aspectRatio.replace(":", "x")}.txt`,
      );
      await currentRenderAdapters().workspace.writeFile(
        scriptPath,
        script,
        "utf-8",
      );
      output.screenBottom = { cx: 0.5, reframe: { scriptPath, cropName } };
      appliedFaceTracking = true;
    } else {
      output.screenBottom = { cx: 0.5, reframe: null };
    }
  }

  log("info", "clip_screen_layout_applied", {
    workflowRunId: params.workflowRunId,
    clipId: params.clipId,
    ...mediaAnalysisDiagnostic({
      analysisMode: "screen_layout",
      selectedMode: appliedPip
        ? "pip_crop"
        : appliedFaceTracking
          ? "face_tracked"
          : "center_crop",
    }),
    bottomTracking: appliedPip ? "pip" : appliedFaceTracking ? "face" : "center",
  });
  return appliedPip || appliedFaceTracking;
}

/** Why screen packet B's screen-share layout couldn't render for this clip —
 *  `null` means it's rendering as the real top-fit/bottom-speaker layout
 *  (with either a face-tracked or static-center bottom tile — see
 *  `applyScreenSpeakerLayout`'s doc comment for why "no face detected" is
 *  NOT one of these reasons, unlike split's `detection_unavailable`/
 *  `insufficient_clusters`/etc.). `disabled` is never returned BY
 *  `decideScreenFallback` itself — it short-circuits before the function is
 *  even called (the `WORKER_SCREEN_LAYOUT=0` kill switch), same pattern as
 *  split's own `disabled` reason. */
export type ScreenFallbackReason = "disabled" | "broll_conflict" | null;

/**
 * Pure fallback-decision logic for screen packet B: given what's known about
 * this clip so far, should it fall back to single-speaker framing instead of
 * the real screen-share layout? v1 policy mirrors split's own
 * `decideSplitFallback` exactly for the one condition both share: B-roll
 * always wins ("b-roll replaces the whole 2-up/screen frame" composition is
 * future work for either layout), independent of whether a face would
 * otherwise be found for the bottom tile — unlike split, screen has no
 * detection-availability or cluster-count reasons to fall back on, since an
 * undetected face just means a static-center bottom tile (still a real
 * screen layout), not a reason to abandon the layout altogether.
 */
export function decideScreenFallback(params: {
  hasBrollPlan: boolean;
}): ScreenFallbackReason {
  if (params.hasBrollPlan) return "broll_conflict";
  return null;
}

/** Why split packet B's segment-aware 2-up couldn't render for this clip —
 *  `null` means it's rendering as a real 2-up. Every non-null reason routes
 *  through the SAME fallback as today's pre-packet-B behavior: single-speaker
 *  framing (auto-reframe if it can run, else a static center crop) — never a
 *  failed render.
 *
 *  `disabled` (L1) and `tiles_not_distinct` (H1) are never returned BY
 *  `decideSplitFallback` itself — `disabled` short-circuits before it's even
 *  called (the `WORKER_SPLIT=0` kill switch), and `tiles_not_distinct` is
 *  decided PER OUTPUT aspect ratio, not per clip (see `splitTilesAreDistinct`
 *  and its call site) — both are still part of this union because they're
 *  logged through the same `clip_split_fallback` reason field. */
export type SplitFallbackReason =
  | "disabled"
  | "broll_conflict"
  | "detection_unavailable"
  | "insufficient_clusters"
  | "empty_plan"
  | "no_two_up_segments"
  | "tiles_not_distinct"
  | null;

/**
 * Pure fallback-decision logic for split packet B (vizard-parity.md
 * "Split-screen 2-up", scope item 4/5): given what happened upstream, should
 * this clip fall back to single-speaker framing instead of a real 2-up, and
 * why (for the `clip_split_fallback` structured log)? Order matters —
 * `hasBrollPlan` is checked FIRST because it's a policy choice (v1: "b-roll
 * replaces the whole 2-up frame" is future work, so B-roll always wins),
 * independent of whether detection would otherwise have succeeded.
 */
export function decideSplitFallback(params: {
  hasBrollPlan: boolean;
  detectionAvailable: boolean;
  plan: BuildSplitLayoutPlanResult | null;
}): SplitFallbackReason {
  if (params.hasBrollPlan) return "broll_conflict";
  if (!params.detectionAvailable) return "detection_unavailable";
  if (!params.plan || params.plan.segments.length === 0) {
    return (params.plan?.clusterCount ?? 0) < 2 ? "insufficient_clusters" : "empty_plan";
  }
  // M4 (adversarial review): a plan with zero "two-up" segments (every
  // segment collapsed to "single" — e.g. a clip that never actually shows
  // two clustered faces at once, only ever solo close-ups/b-roll) has
  // nothing for a 2-up render to actually show; the spike's conclusion was
  // that such a plan should route through the existing single-shot
  // auto-reframe path exactly like any other non-split clip, not stretch a
  // single-face crop into a pointless top/bottom-identical stack.
  if (params.plan.segments.every((segment) => segment.layout === "single")) {
    return "no_two_up_segments";
  }
  return null;
}

/**
 * Whether this clip's framing choice ALONE forces the per-output render
 * path (`hasStudioVideoEdits` in the Clip Render Attempt) rather than the
 * shared `buildMultiVideoArgs` batch path — true only for the effective
 * "split" mode (split packet B): a 2-up composition needs its own
 * `buildSplitFilterChain` filter graph per output, which
 * `buildMultiVideoArgs`'s shared crop-to-fill path has no concept of, same
 * reason a canvas background/cut-concat/music force it above. Note this is
 * necessary but not sufficient for a clip to actually render as 2-up — it
 * only decides which ffmpeg-arg builder family runs; `decideSplitFallback`
 * (evaluated once detection/broll are known) decides whether that per-output
 * call ends up passing a real split plan or falls back to single-speaker
 * framing.
 *
 * L1 (adversarial review): also false whenever the `WORKER_SPLIT=0` kill
 * switch is set, even if `studioEdits.framing.mode` is still "split" — with
 * the switch off, split must route through EXACTLY the same batch path
 * "auto"/"center" use, not force the per-output path just to immediately
 * fall back inside it every time.
 *
 * Screen packet B: "screen" gets the exact same treatment via its own
 * `WORKER_SCREEN_LAYOUT=0` kill switch — a screen-share clip forces the
 * per-output path (`buildScreenSpeakerFilterChain`'s top-fit/bottom-speaker
 * composition, threaded through `buildSingleVideoArgs`'s `screen` param)
 * unless that switch is set, in which case it fully reverts routing to the
 * shared batch path exactly like split's own kill switch does. Only one of
 * "split"/"screen" is ever true for a given clip (`resolveEffectiveFramingMode`
 * returns a single value), so there's no ordering concern between the two
 * branches below.
 *
 * M4 (adversarial review): this predicate's return value never even gets
 * consulted for an audio-only clip — `probe.hasVideo` gates the split/screen
 * detection blocks in the Clip Render Attempt BEFORE either mode's plan
 * exists, and `buildAudiogramArgs` (the audio-only render path) ignores
 * `studioEdits.framing` entirely — so a `true` here for "split"/"screen" on
 * an audio-only clip is a value nothing downstream reads, not a live
 * routing decision.
 */
export function framingForcesPerOutputRender(
  studioEdits: StudioEdits,
  config: Readonly<RenderConfig> = currentRenderConfig(),
): boolean {
  const mode = resolveEffectiveFramingMode(studioEdits);
  if (mode === "split") return config.splitEnabled;
  if (mode === "screen") return config.screenLayoutEnabled;
  return false;
}

/** Applies aspect-specific Studio speaker-layer edits to the derived AI plan
 * without mutating the persisted analysis. Unedited scenes retain their
 * original references and stay on the established fast crop/vstack path. */
export function applySpeakerLayoutOverridesToSegments(
  segments: SplitLayoutSegment[],
  overrides: StudioSpeakerLayoutOverride[],
  aspectRatio: ClipAspectRatio,
): SplitLayoutSegment[] {
  if (overrides.length === 0) return segments;
  let changed = false;
  const resolved = segments.map((segment) => {
    const scene = resolveSpeakerLayoutScene(segment, overrides, aspectRatio);
    if (!scene.overrideId) return segment;
    changed = true;
    if (segment.layout === "single") {
      const layer = scene.layers.find((candidate) => candidate.role === "single")!;
      return {
        ...segment,
        cxNorm: layer.cropCxNorm,
        cyNorm: layer.cropCyNorm,
        zoom: layer.cropZoom,
        frame: {
          x: layer.frameX,
          y: layer.frameY,
          width: layer.frameWidth,
          height: layer.frameHeight,
          rotationDeg: layer.rotationDeg,
        },
      };
    }
    const top = scene.layers.find((candidate) => candidate.role === "top")!;
    const bottom = scene.layers.find((candidate) => candidate.role === "bottom")!;
    return {
      ...segment,
      topCxNorm: top.cropCxNorm,
      topCyNorm: top.cropCyNorm,
      topZoom: top.cropZoom,
      bottomCxNorm: bottom.cropCxNorm,
      bottomCyNorm: bottom.cropCyNorm,
      bottomZoom: bottom.cropZoom,
      topFrame: {
        x: top.frameX,
        y: top.frameY,
        width: top.frameWidth,
        height: top.frameHeight,
        rotationDeg: top.rotationDeg,
      },
      bottomFrame: {
        x: bottom.frameX,
        y: bottom.frameY,
        width: bottom.frameWidth,
        height: bottom.frameHeight,
        rotationDeg: bottom.rotationDeg,
      },
    };
  });
  return changed ? resolved : segments;
}

function formatSrtTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/**
 * Vizard-parity Phase B step 7: when `timeMap` is provided (a clip with
 * non-empty `deletedRanges`), every timestamp is remapped source→edited via
 * the shared `sourceToEdited` helper instead of the plain `clipStartSec`
 * subtraction, and words/utterances that fall entirely inside a deleted
 * range are dropped rather than emitted. `timeMap` omitted (the overwhelming
 * common case — no cuts) keeps the exact original arithmetic, byte-identical
 * to pre-cut-concat output.
 */
export function generateSrtFromSlice(
  utterances: TranscriptUtterance[],
  clipStartSec: number,
  textTransform?: string,
  timeMap?: EditedTimeMap | null,
  /** Vizard-parity Phase C punctuation toggle — absent/true keeps punctuation
   *  as transcribed (byte-identical to before this field existed); false
   *  routes every word token through the shared `formatCaptionWord` helper
   *  (same one the ASS builder and the studio preview use) before joining a
   *  cue's text, and empty tokens (pure punctuation, e.g. "...") are dropped
   *  rather than emitted as a stray space. */
  punctuation = true,
): string {
  if (utterances.length === 0) {
    return "";
  }

  const toEdited = (sourceSec: number): number =>
    timeMap ? sourceToEdited(timeMap, sourceSec) : sourceSec - clipStartSec;
  const isVisible = (range: { startSec: number; endSec: number }): boolean =>
    !timeMap || sourceRangeToEdited(timeMap, range) !== null;
  const formatWord = (word: string): string =>
    formatCaptionWord(word, { punctuation });

  const cues: string[] = [];
  let cueIndex = 1;

  for (const utterance of utterances) {
    const rawWords = utterance.words;
    const words = timeMap ? rawWords.filter(isVisible) : rawWords;

    if (rawWords.length > 0) {
      // Word-level mode: group into fixed cues (matches the ASS/preview model)
      for (let i = 0; i < words.length; i += CAPTION_CHUNK_SIZE) {
        const group = words.slice(i, i + CAPTION_CHUNK_SIZE);
        const start = Math.max(0, toEdited(group[0]!.startSec));
        const end = Math.max(start + 0.1, toEdited(group[group.length - 1]!.endSec));
        const groupText = group
          .map((w) => formatWord(w.word))
          .filter((w) => w.length > 0)
          .join(" ");
        if (groupText.length === 0) continue;
        const text = applyTextTransform(groupText, textTransform);
        cues.push(`${cueIndex}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${text}\n`);
        cueIndex++;
      }
    } else {
      // Fallback: utterance-level cue
      if (!isVisible(utterance)) continue;
      const start = Math.max(0, toEdited(utterance.startSec));
      const end = Math.max(start + 0.1, toEdited(utterance.endSec));
      const utteranceText = utterance.text
        .split(/\s+/)
        .filter(Boolean)
        .map(formatWord)
        .filter((w) => w.length > 0)
        .join(" ");
      if (utteranceText.length === 0) continue;
      const text = applyTextTransform(utteranceText, textTransform);
      cues.push(`${cueIndex}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${text}\n`);
      cueIndex++;
    }
  }

  return cues.join("\n");
}

function formatAssTimestamp(seconds: number): string {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(totalCs / 360_000);
  const m = Math.floor((totalCs % 360_000) / 6000);
  const s = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function hexToAssColor(hex: string, alphaHex = "00"): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `&H${alphaHex}${b}${g}${r}`;
}

/** ASS alpha is inverse of opacity: 0 alpha = fully opaque, FF = transparent. */
function assAlphaHex(opacity: number): string {
  const clamped = Math.max(0, Math.min(1, opacity));
  const alpha = Math.round((1 - clamped) * 255);
  return alpha.toString(16).toUpperCase().padStart(2, "0");
}

// Map preset font names to fonts actually bundled in the worker image. Impact
// is proprietary, so we substitute Anton (a metric-ish open display face).
const FONT_ALIASES: Record<string, string> = {
  Impact: "Anton",
};

function resolveFontName(name?: string | null): string {
  if (!name) return "Bebas Neue";
  const aliased = FONT_ALIASES[name] ?? name;
  // Strip characters that would break the ASS style / force_style filter
  // (commas, quotes, backslashes). Font names are letters/digits/space/hyphen.
  const safe = aliased.replace(/[^A-Za-z0-9 -]/g, "").trim();
  return safe.length > 0 ? safe : "Bebas Neue";
}

function applyTextTransform(text: string, transform?: string): string {
  switch (transform) {
    case "uppercase": return text.toUpperCase();
    case "lowercase": return text.toLowerCase();
    case "capitalize": return text.replace(/\b\w/g, (c) => c.toUpperCase());
    default: return text;
  }
}

/**
 * Builds an ASS subtitle file that burns captions matching the studio preview:
 * fixed cues of {@link CAPTION_CHUNK_SIZE} words, per-word highlight color,
 * optional highlight box and glow, position from the preset, and a light
 * entrance animation. This is the authoritative export path — the SRT path is
 * only a fallback for clips that have no caption preset.
 */
/**
 * Vizard-parity Phase B step 7: see `generateSrtFromSlice`'s doc comment —
 * same `timeMap` contract (source→edited remap + drop-fully-deleted-words,
 * byte-identical output when `timeMap` is omitted).
 */
export function generateAssFromSlice(
  utterances: TranscriptUtterance[],
  clipStartSec: number,
  aspectRatio: ClipAspectRatio,
  captionPreset: CaptionPreset,
  timeMap?: EditedTimeMap | null,
): string {
  const config = aspectRatioConfig.get(aspectRatio);
  if (!config) return "";

  const resX = config.width;
  const resY = config.height;
  const posXPct = captionPreset.positionX ?? 50;
  const posYPct =
    captionPreset.positionY ??
    CAPTION_POSITION_Y_DEFAULTS[captionPreset.position ?? "bottom"];
  const posXPx = Math.round((posXPct / 100) * resX);
  const posYPx = Math.round((posYPct / 100) * resY);

  // Font size is in render pixels at this output's resolution — identical to the
  // studio preview, which scales the same `fontSize` against each aspect's own
  // width (`renderWidth`). Using it raw keeps export == preview.
  const fontName = resolveFontName(captionPreset.fontName);
  const fontSize =
    captionPreset.fontSize ?? captionStyleByAspectRatio[aspectRatio].fontSize;
  const primaryColor = hexToAssColor(captionPreset.primaryColor ?? "#FFFFFF");
  const highlightColor = hexToAssColor(captionPreset.highlightColor ?? "#00FF88");
  const outlineColor = hexToAssColor(captionPreset.outlineColor ?? "#000000");
  const bold = captionPreset.bold !== false ? -1 : 0;
  const outlineWidth = captionPreset.outlineWidth ?? 2;
  const shadow = captionPreset.shadow ?? 1;
  const spacing = Math.round((captionPreset.letterSpacing ?? 0) * fontSize);

  // Backdrop behind the whole line: BorderStyle=3 (opaque box) with BackColour.
  let borderStyle = 1;
  let backColour = "&H00000000";
  if (captionPreset.backgroundColor) {
    borderStyle = 3;
    backColour = hexToAssColor(
      captionPreset.backgroundColor,
      assAlphaHex(captionPreset.backgroundOpacity ?? 0.6),
    );
  }

  // Glow: colored, blurred shadow applied to the whole cue.
  let glowOverride = "";
  if (captionPreset.glowColor) {
    const intensity = captionPreset.glowIntensity ?? 8;
    const glowAss = hexToAssColor(captionPreset.glowColor);
    const shadowDepth = Math.max(1, Math.round(intensity / 4));
    const blur = Math.max(1, Math.round(intensity / 2));
    glowOverride = `\\4c${glowAss}&\\shad${shadowDepth}\\blur${blur}`;
  }

  // Highlight box approximated by a thick colored border on the active word.
  const hasHighlightBox = Boolean(captionPreset.highlightBoxColor);
  const boxColor = hasHighlightBox
    ? hexToAssColor(captionPreset.highlightBoxColor!)
    : "";
  const boxAlpha = assAlphaHex(captionPreset.highlightBoxOpacity ?? 1);
  const boxBord = Math.max(outlineWidth, Math.round(fontSize * 0.16));

  const animation = captionPreset.animation ?? "word-by-word";

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${resX}`,
    `PlayResY: ${resY}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontName},${fontSize},${primaryColor},${primaryColor},${outlineColor},${backColour},${bold},0,0,0,100,100,${spacing},0,${borderStyle},${outlineWidth},${shadow},5,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events: string[] = [];
  const txtTransform = captionPreset.textTransform;
  const toEdited = (sourceSec: number): number =>
    timeMap ? sourceToEdited(timeMap, sourceSec) : sourceSec - clipStartSec;
  const isVisible = (range: { startSec: number; endSec: number }): boolean =>
    !timeMap || sourceRangeToEdited(timeMap, range) !== null;

  const renderWord = (word: string, isActive: boolean): string => {
    if (!isActive) return word;
    if (hasHighlightBox) {
      return (
        `{\\1c${highlightColor}&\\bord${boxBord}\\3c${boxColor}&\\3a&H${boxAlpha}&}` +
        `${word}` +
        `{\\1c${primaryColor}&\\bord${outlineWidth}\\3c${outlineColor}&\\3a&H00&}`
      );
    }
    return `{\\1c${highlightColor}&}${word}{\\1c${primaryColor}&}`;
  };

  const entranceFor = (isChunkStart: boolean): string => {
    if (!isChunkStart) return "";
    let entrance = "\\fad(60,0)";
    if (
      animation === "grow" ||
      animation === "bounce" ||
      animation === "seamless-bounce" ||
      animation === "soft-landing"
    ) {
      entrance += "\\fscx82\\fscy82\\t(0,160,\\fscx100\\fscy100)";
    } else if (animation === "blur-in" && !captionPreset.glowColor) {
      entrance += "\\blur6\\t(0,200,\\blur0)";
    }
    return entrance;
  };

  for (const utterance of utterances) {
    const rawWords = utterance.words;
    const words = timeMap ? rawWords.filter(isVisible) : rawWords;

    if (rawWords.length > 0) {
      for (let i = 0; i < words.length; i += CAPTION_CHUNK_SIZE) {
        const group = words.slice(i, i + CAPTION_CHUNK_SIZE);
        const groupEnd = Math.max(0, toEdited(group[group.length - 1]!.endSec));
        // Punctuation stripping happens BEFORE textTransform (formatCaptionWord
        // operates on the raw transcript token) — a word that strips to "" is
        // skipped from the rendered line below, never emitted as a bare space.
        const transformedWords = group.map((w) =>
          applyTextTransform(
            formatCaptionWord(w.word, { punctuation: captionPreset.punctuation !== false }),
            txtTransform,
          ),
        );

        for (let j = 0; j < group.length; j++) {
          const activeStart = Math.max(0, toEdited(group[j]!.startSec));
          const activeEnd =
            j + 1 < group.length
              ? Math.max(activeStart + 0.05, toEdited(group[j + 1]!.startSec))
              : Math.max(activeStart + 0.1, groupEnd);

          const text = group
            .map((w, k) => {
              const formatted = transformedWords[k]!;
              if (formatted.length === 0) return null;
              const rendered = renderWord(formatted, k === j);
              // Emoji lookup always reads the RAW word (not the
              // punctuation-formatted one): emojiForWord already strips every
              // non-a-z character via its own key normalization, so stripping
              // edge punctuation first can never change which keyword matches
              // — this keeps emoji behavior identical whether punctuation
              // display is on or off, as required.
              const emoji = captionPreset.emojis ? emojiForWord(w.word) : null;
              return emoji ? `${rendered} ${emoji}` : rendered;
            })
            .filter((t): t is string => t !== null)
            .join(" ");
          // Whole window has nothing to show (every word in the group was
          // pure punctuation) — skip the event instead of emitting a blank
          // Dialogue line.
          if (text.length === 0) continue;

          const override = `\\an5\\pos(${posXPx},${posYPx})${glowOverride}${entranceFor(j === 0)}`;
          events.push(
            `Dialogue: 0,${formatAssTimestamp(activeStart)},${formatAssTimestamp(activeEnd)},Default,,0,0,0,,{${override}}${text}`,
          );
        }
      }
    } else {
      if (!isVisible(utterance)) continue;
      const start = Math.max(0, toEdited(utterance.startSec));
      const end = Math.max(start + 0.1, toEdited(utterance.endSec));
      const utteranceText = utterance.text
        .split(/\s+/)
        .filter(Boolean)
        .map((w) =>
          formatCaptionWord(w, { punctuation: captionPreset.punctuation !== false }),
        )
        .filter((w) => w.length > 0)
        .join(" ");
      if (utteranceText.length === 0) continue;
      const text = applyTextTransform(utteranceText, txtTransform);
      const override = `\\an5\\pos(${posXPx},${posYPx})${glowOverride}\\fad(60,0)`;
      events.push(
        `Dialogue: 0,${formatAssTimestamp(start)},${formatAssTimestamp(end)},Default,,0,0,0,,{${override}}${text}`,
      );
    }
  }

  return header + "\n" + events.join("\n") + "\n";
}

function escapeSubtitlePath(filePath: string) {
  return filePath.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

/** #RRGGBB -> 0xRRGGBB for the ffmpeg `color` / `showwaves` filters. */
function hexToFfmpegRgb(hex: string): string {
  return `0x${hex.replace("#", "").slice(0, 6)}`;
}

function hexToFfmpegColor(hex: string): string {
  // Converts #RRGGBB to \&H00BBGGRR\& (FFmpeg ASS BGRA color format, alpha=00=opaque)
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `\\&H00${b}${g}${r}\\&`;
}

function escapeDrawtextValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/%/g, "\\%");
}

function buildTextLayerFilters(
  layers: StudioTextLayer[],
  clipDurationSec: number,
): string[] {
  return layers.map((layer) => {
    const endSec = Math.min(
      clipDurationSec,
      layer.endSec ?? clipDurationSec,
    );
    const startSec = Math.min(layer.startSec, endSec);
    const x = ((layer.positionX ?? 50) / 100).toFixed(4);
    const y = ((layer.positionY ?? 18) / 100).toFixed(4);
    const fontColor = hexToFfmpegRgb(layer.color);
    const border = layer.outlineWidth > 0
      ? `:borderw=${layer.outlineWidth}:bordercolor=${hexToFfmpegRgb(layer.outlineColor)}`
      : "";
    const box = layer.backgroundColor
      ? `:box=1:boxcolor=${hexToFfmpegRgb(layer.backgroundColor)}@${layer.backgroundOpacity.toFixed(3)}:boxborderw=10`
      : "";

    return (
      `drawtext=font='${escapeDrawtextValue(layer.fontName)}'` +
      `:text='${escapeDrawtextValue(layer.text)}'` +
      `:fontsize=${Math.round(layer.fontSize)}` +
      `:fontcolor=${fontColor}` +
      `:x=(w-text_w)*${x}:y=(h-text_h)*${y}` +
      `:enable='between(t\\,${startSec.toFixed(3)}\\,${endSec.toFixed(3)})'` +
      `:shadowcolor=black@0.45:shadowx=0:shadowy=2` +
      `${border}${box}`
    );
  });
}

/**
 * `fade`/`fade-black` both dip through black — ffmpeg's `fade` filter
 * defaults to black when `color` is omitted, which is what made
 * `fade-black` work today even before this explicit mapping existed.
 * `fade-black` is kept as its own transition type (vs. relying on that
 * default) so the mapping stays correct if `fade`'s meaning ever changes,
 * and so the two are named for what they visibly do.
 */
export function buildTransitionFilter(
  transition: StudioEdits["transition"] | undefined,
  clipDurationSec: number,
): string | null {
  if (!transition || transition.type === "none") return null;
  const duration = Math.min(transition.durationSec, clipDurationSec / 2);
  if (duration <= 0) return null;
  const outStart = Math.max(0, clipDurationSec - duration);
  const color =
    transition.type === "dip-white"
      ? ":color=white"
      : transition.type === "fade-black"
        ? ":color=black"
        : "";
  return `fade=t=in:st=0:d=${duration.toFixed(3)}${color},fade=t=out:st=${outStart.toFixed(3)}:d=${duration.toFixed(3)}${color}`;
}

function appendTransitionFilter(
  filterParts: string[],
  inputLabel: string,
  outputLabel: string,
  studioEdits: StudioEdits | null | undefined,
  clipDurationSec: number,
) {
  const transitionFilter = buildTransitionFilter(
    studioEdits?.transition,
    clipDurationSec,
  );
  if (!transitionFilter) return inputLabel;
  filterParts.push(`${inputLabel}${transitionFilter}${outputLabel}`);
  return outputLabel;
}

export interface CutConcatResult {
  filterParts: string[];
  /** Label (with brackets, e.g. "[vcat]") every downstream video filter must
   *  read from instead of the raw source input. */
  videoLabel: string | null;
  /** Label (with brackets) every downstream audio filter must read from
   *  instead of the raw source input, or null when `includeAudio` was false. */
  audioLabel: string | null;
}

/**
 * Builds the cut/concat prefix of the filter graph for a clip's kept source
 * segments (vizard-parity.md Phase B step 7): each kept segment is trimmed
 * out of the SAME single source input (`-ss clipStartSec -t clipDurationSec
 * -i sourcePath`, unchanged from today) via `trim`/`atrim` + `setpts`/
 * `asetpts`, then concatenated into one continuous edited-timeline stream —
 * BEFORE crop/scale, captions, text layers, logo, transitions, music, gain,
 * or fades, so every one of those sees one continuous video/audio pair and
 * needs no cut-awareness of its own.
 *
 * Returns `null` when `cutPlan.isUncut` — callers MUST fall back to
 * referencing the raw input labels directly (`[0:v]` / `[0:a:0]`) in that
 * case, which is what keeps the single-segment path byte-identical to
 * pre-cut-concat renders (no filter-graph changes at all for the common
 * no-deletions case).
 *
 * `trim`/`atrim` operate on the SAME input-relative time base that every
 * other filter in this file already assumes for a `-ss X -i ...`-seeked
 * input (e.g. `buildTextLayerFilters`'/`buildBrollVideoArgs`' `between(t,...)`
 * windows) — i.e. 0 at `clipStartSec`, not absolute source time — so segment
 * bounds are expressed as `segment.sourceStartSec/EndSec - clipStartSec`.
 */
function buildCutConcatFilter(params: {
  cutPlan: ClipCutPlan;
  clipStartSec: number;
  /** Default true — set false for the audio-only audiogram path, which has
   *  no `[0:v]` stream to trim. */
  includeVideo?: boolean;
  includeAudio: boolean;
  videoInputRef?: string;
  audioInputRef?: string;
  videoOutLabel?: string;
  audioOutLabel?: string;
}): CutConcatResult | null {
  if (params.cutPlan.isUncut) return null;

  const includeVideo = params.includeVideo ?? true;
  const segments = params.cutPlan.segments;
  const videoInputRef = params.videoInputRef ?? "[0:v]";
  const audioInputRef = params.audioInputRef ?? "[0:a:0]";
  const videoOutLabel = params.videoOutLabel ?? "[vcat]";
  const audioOutLabel = params.audioOutLabel ?? "[acat]";

  const filterParts: string[] = [];
  const vLabels: string[] = [];
  const aLabels: string[] = [];

  segments.forEach((segment, index) => {
    const start = (segment.sourceStartSec - params.clipStartSec).toFixed(3);
    const end = (segment.sourceEndSec - params.clipStartSec).toFixed(3);

    if (includeVideo) {
      const vLabel = `vseg${index}`;
      filterParts.push(
        `${videoInputRef}trim=start=${start}:end=${end},setpts=PTS-STARTPTS[${vLabel}]`,
      );
      vLabels.push(`[${vLabel}]`);
    }

    if (params.includeAudio) {
      const aLabel = `aseg${index}`;
      filterParts.push(
        `${audioInputRef}atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[${aLabel}]`,
      );
      aLabels.push(`[${aLabel}]`);
    }
  });

  if (segments.length === 1) {
    // A single kept segment needs no `concat` — the trim/setpts stage above
    // already produced the final continuous stream (still a real cut when
    // the segment doesn't span the whole clip window, e.g. a deletion at the
    // very start/end — `concat` filter with n=1 would be a no-op anyway, but
    // skipping it keeps the graph simpler and matches ffmpeg's own guidance
    // against degenerate single-input concats).
    // `copy` (video) and `acopy` (audio) are distinct ffmpeg filters — using
    // the video-only `copy` on an audio pad label would fail at encode time.
    const rename = (label: string, out: string, filterName: "copy" | "acopy") =>
      filterParts.push(`${label}${filterName}${out}`);
    if (includeVideo) rename(vLabels[0]!, videoOutLabel, "copy");
    if (params.includeAudio) rename(aLabels[0]!, audioOutLabel, "acopy");
    return {
      filterParts,
      videoLabel: includeVideo ? videoOutLabel : null,
      audioLabel: params.includeAudio ? audioOutLabel : null,
    };
  }

  if (includeVideo && params.includeAudio) {
    const interleaved = segments.map((_, i) => `${vLabels[i]}${aLabels[i]}`).join("");
    filterParts.push(
      `${interleaved}concat=n=${segments.length}:v=1:a=1${videoOutLabel}${audioOutLabel}`,
    );
    return { filterParts, videoLabel: videoOutLabel, audioLabel: audioOutLabel };
  }

  if (includeVideo) {
    const interleaved = vLabels.join("");
    filterParts.push(
      `${interleaved}concat=n=${segments.length}:v=1:a=0${videoOutLabel}`,
    );
    return { filterParts, videoLabel: videoOutLabel, audioLabel: null };
  }

  // Audio-only (audiogram path): no video stream to concat at all.
  const interleaved = aLabels.join("");
  filterParts.push(
    `${interleaved}concat=n=${segments.length}:v=0:a=1${audioOutLabel}`,
  );
  return { filterParts, videoLabel: null, audioLabel: audioOutLabel };
}

// Every render gets a short audio fade at each boundary: clip ends land at
// most ~0.25s after the last spoken word (and, when speech continues in the
// source, just a few ms before the next word), so a hard cut audibly clicks
// or clips a phoneme. The fade is short enough to be inaudible as an effect.
const AUDIO_FADE_IN_SEC = 0.04;
const AUDIO_FADE_OUT_SEC = 0.12;

export function buildAudioFadeChain(clipDurationSec: number) {
  const fadeOutStart = Math.max(0, clipDurationSec - AUDIO_FADE_OUT_SEC);
  return `afade=t=in:st=0:d=${AUDIO_FADE_IN_SEC.toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${AUDIO_FADE_OUT_SEC.toFixed(3)}`;
}

/**
 * Builds a `volume=` filter fragment for the source/dialogue track from
 * `studioEdits.sourceAudio`, or `null` when it's a no-op (unity gain, not
 * muted) — callers must skip appending it entirely in that case (the "unity
 * fast path") so untouched clips keep producing the exact same filter graph
 * they always have.
 */
function buildSourceGainFilter(
  sourceAudio: StudioEdits["sourceAudio"] | null | undefined,
): string | null {
  if (!sourceAudio) return null;
  if (sourceAudio.muted) return "volume=0.000";
  if (sourceAudio.volume === 100) return null;
  const gain = Math.max(0, Math.min(1, sourceAudio.volume / 100));
  return `volume=${gain.toFixed(3)}`;
}

/**
 * The dialogue-only (no music) audio chain: optional source gain/mute, then
 * the fixed boundary click-guard fade. Used by every build*Args call site
 * that has source audio and no music track to mix in.
 */
function buildDialogueAudioFilter(
  sourceAudio: StudioEdits["sourceAudio"] | null | undefined,
  clipDurationSec: number,
): string {
  const gainFilter = buildSourceGainFilter(sourceAudio);
  const fadeChain = buildAudioFadeChain(clipDurationSec);
  return gainFilter ? `${gainFilter},${fadeChain}` : fadeChain;
}

/**
 * User-configured music fade in/out (`studioEdits.music.fadeInSec/fadeOutSec`,
 * 0-5s each), as an `afade` filter suffix applied to the music branch only —
 * additive to (not a replacement for) the fixed click-guard chain on the
 * final mixed track.
 *
 * Clamping/overlap resolution comes from the shared
 * `resolveMusicFadeWindows` policy (packages/validators/src/studio-edits.ts)
 * rather than clamping each fade independently here — this used to clamp
 * fadeIn and fadeOut to the clip duration separately, which let a long
 * fade-in + long fade-out on a short clip overlap (e.g. both landing at full
 * length, fading in and out over the SAME seconds) instead of scaling both
 * down proportionally so fade-in ends before fade-out begins. The studio
 * preview already uses the shared helper; this keeps the render in lockstep.
 */
function buildMusicUserFadeSuffix(
  music: MusicPlan,
  clipDurationSec: number,
): string {
  const parts: string[] = [];
  const { fadeInSec, fadeOutSec, fadeOutStartSec } = resolveMusicFadeWindows(
    music.fadeInSec ?? 0,
    music.fadeOutSec ?? 0,
    clipDurationSec,
  );
  if (fadeInSec > 0) {
    parts.push(`afade=t=in:st=0:d=${fadeInSec.toFixed(3)}`);
  }
  if (fadeOutSec > 0) {
    parts.push(
      `afade=t=out:st=${fadeOutStartSec.toFixed(3)}:d=${fadeOutSec.toFixed(3)}`,
    );
  }
  return parts.length ? `,${parts.join(",")}` : "";
}

/**
 * One-shot SFX branch (vizard-parity.md "Music/SFX library" —
 * `studioSfxPlacementSchema`): `adelay` pads the branch with silence so
 * playback starts at `startSec` (EDITED-timeline seconds, same convention
 * the schema uses), then `atrim=duration=D` bounds it to the clip's own end
 * so a placement near the tail never rings past it. `all=1` delays every
 * channel by the same amount regardless of the source's channel count —
 * `adelay`'s default (`all=0`) requires one delay value per channel, so a
 * mono SFX file would only delay its first channel and leave the rest
 * unaffected. Never loops (one-shot, unlike music) — callers must not pass
 * `-stream_loop` on this input.
 *
 * `apad` runs BEFORE `atrim`, not after: `atrim=duration=D` is a MAX bound,
 * not a pad — a stream shorter than D (the common case: `adelay` + a
 * short one-shot SFX file, no infinite loop backing it the way music has)
 * simply ends early, and `atrim` does nothing to extend it. Without `apad`,
 * this branch's real output duration is `startSec` + the SFX file's own
 * length, which can be far shorter than the clip. Downstream, `amix
 * duration=first`/`-shortest` anchor on whichever branch is SHORTEST when
 * there's no dialogue branch to anchor on (e.g. a silent source, the SFX
 * branch alone) — an unpadded short SFX branch silently truncated the WHOLE
 * encode to its own length, dropping every later placement and however much
 * of the clip followed. `apad` pads the branch with silence indefinitely so
 * `atrim=duration=D` always has enough stream to cut down TO exactly D,
 * restoring the invariant `buildAudioMixFilter`'s own doc comment already
 * assumed every branch honored.
 */
function buildSfxAudioFilter(params: {
  sfxInputIndex: number;
  sfx: SfxPlan;
  clipDurationSec: number;
  label: string;
}): string {
  const duration = Math.max(0.1, params.clipDurationSec);
  const delayMs = Math.max(0, Math.round(params.sfx.startSec * 1000));
  const volume = Math.max(0, Math.min(1, params.sfx.volume / 100));
  return `[${params.sfxInputIndex}:a]adelay=${delayMs}:all=1,volume=${volume.toFixed(3)},apad,atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS${params.label}`;
}

/**
 * Ducking automation suffix for the music branch (vizard-parity.md
 * "Music/SFX library" — `studioMusicSchema.ducking`): a single-quoted
 * ffmpeg `volume=` expression, same quoting technique as
 * `enable='between(t,...)'` elsewhere in this file, so the commas inside
 * `buildDuckingVolumeExpression`'s `if(...)`/`between(...)` calls don't get
 * misread as filter-chain separators. Applied AFTER the music's base
 * `volume=` and user fade suffix, composing rather than replacing them.
 * `""` (no-op, byte-identical output) whenever `duckingWindows` is
 * absent/empty — the common case for every clip that isn't using ducking.
 */
function buildMusicDuckingSuffix(music: MusicPlan): string {
  if (!music.duckingWindows || music.duckingWindows.length === 0) return "";
  const expr = buildDuckingVolumeExpression(music.duckingWindows);
  return expr ? `,volume='${expr}':eval=frame` : "";
}

/**
 * The single audio-mixing choke point for every render path that has music
 * and/or one-shot SFX active (see call sites in `buildSingleVideoArgs`,
 * `buildBrollVideoArgs`, `buildAudiogramArgs`) — generalizes what used to be
 * a fixed dialogue+music 2-input `amix` into dialogue (0 or 1 branch) +
 * music (0 or 1 branch) + SFX (0-20 branches), mixed in that order so
 * `duration=first` stays anchored on the dialogue branch whenever dialogue
 * is present. Every branch is built to be EXACTLY `clipDurationSec` long
 * before the mix, so `duration=first` is a formality (all branches already
 * share one duration) rather than a real anchor choice — dialogue and music
 * get there via a plain `atrim=duration=D` because they're backed by a
 * stream that's always at least D long (the source itself, or a
 * `-stream_loop -1`'d music file); one-shot SFX branches are NOT backed by
 * anything that long on their own (a short SFX file plus `adelay` can end
 * far short of D), so `buildSfxAudioFilter` pads with `apad` BEFORE its own
 * `atrim=duration=D` to actually guarantee this invariant instead of just
 * assuming it (see that function's doc comment for the truncation bug this
 * fixes).
 *
 * Byte-identical to the pre-SFX/pre-ducking dialogue+music filter whenever
 * `sfx` is empty and `music.duckingWindows` is unset — both new suffixes
 * collapse to `""` in that case, and a single dialogue+music branch pair
 * takes the same 2-input `amix` path as before.
 *
 * SFX placements whose `startSec` has drifted at/past `clipDurationSec`
 * (shouldn't happen — callers are expected to filter these out earlier so
 * the download/input never happens — kept here too as a defensive second
 * gate) are silently dropped rather than mixed in as an always-silent
 * branch.
 */
function buildAudioMixFilter(params: {
  sourceHasAudio: boolean;
  clipDurationSec: number;
  sourceAudio?: StudioEdits["sourceAudio"] | null;
  /** Label to read the dialogue/source audio from — defaults to `[0:a]`
   *  (the raw source input). Cut-concat renders pass `[acat]` instead so the
   *  dialogue mix reads the concatenated edited-timeline audio, same as
   *  every other downstream audio consumer (vizard-parity Phase B step 7). */
  dialogueInputRef?: string;
  music?: { inputIndex: number; plan: MusicPlan } | null;
  sfx?: Array<{ inputIndex: number; plan: SfxPlan }>;
}): string {
  const duration = Math.max(0.1, params.clipDurationSec);
  const fadeChain = buildAudioFadeChain(duration);
  const dialogueInputRef = params.dialogueInputRef ?? "[0:a]";
  const sfxEntries = (params.sfx ?? []).filter(
    (entry) => entry.plan.startSec < duration,
  );

  const branchFilters: string[] = [];
  const branchLabels: string[] = [];

  if (params.sourceHasAudio) {
    // normalize=0 below: amix's default normalization divides every input by
    // the input count (i.e. -6dB per input for a 2-input mix), quietly
    // ducking the dialogue whenever music/SFX is added. Each branch's own
    // level is already under explicit control (music `volume=`, SFX
    // `volume=`, dialogue gain), so every branch must mix at unity gain —
    // applied here on the dialogue branch (before amix) same as the
    // no-music path.
    const dialogueGainFilter = buildSourceGainFilter(params.sourceAudio);
    const label = "[maina]";
    branchFilters.push(
      dialogueGainFilter
        ? `${dialogueInputRef}atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,${dialogueGainFilter}${label}`
        : `${dialogueInputRef}atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS${label}`,
    );
    branchLabels.push(label);
  }

  if (params.music) {
    const { plan } = params.music;
    const volume = Math.max(0, Math.min(1, plan.volume / 100));
    const startOffset = Math.max(0, plan.startOffsetSec || 0);
    const label = "[musica]";
    const userFadeSuffix = buildMusicUserFadeSuffix(plan, duration);
    const duckingSuffix = buildMusicDuckingSuffix(plan);
    // start=<offset> seeks into the (infinitely -stream_loop'd) music input
    // so the user's chosen point in the track plays first, instead of
    // always the first `duration` seconds of the file.
    branchFilters.push(
      `[${params.music.inputIndex}:a]atrim=start=${startOffset.toFixed(3)}:duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${volume.toFixed(3)}${userFadeSuffix}${duckingSuffix}${label}`,
    );
    branchLabels.push(label);
  }

  sfxEntries.forEach(({ inputIndex, plan }, index) => {
    const label = `[sfx${index}a]`;
    branchFilters.push(
      buildSfxAudioFilter({
        sfxInputIndex: inputIndex,
        sfx: plan,
        clipDurationSec: duration,
        label,
      }),
    );
    branchLabels.push(label);
  });

  if (branchLabels.length === 0) {
    // No dialogue, no music, no SFX. Callers only reach this function when
    // at least music or SFX is present (see the `hasMixedAudio` gate at
    // each call site), so this only fires when every SFX placement got
    // dropped by the defensive duration filter above AND there's no source
    // audio and no music — degrade to silence rather than emit an amix with
    // zero inputs.
    return `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration.toFixed(3)}[outa]`;
  }

  if (branchLabels.length === 1) {
    return `${branchFilters[0]};${branchLabels[0]}${fadeChain}[outa]`;
  }

  return [
    ...branchFilters,
    `${branchLabels.join("")}amix=inputs=${branchLabels.length}:duration=first:dropout_transition=0:normalize=0,${fadeChain}[outa]`,
  ].join(";");
}

/**
 * The ONE choke point every render path (single-video, fit+background,
 * multi-video, B-roll cutaway, audiogram — see call sites) routes subtitle
 * burn-in through, so gating `captionPreset.visible === false` here turns
 * subtitles off everywhere at once instead of needing a check duplicated at
 * every call site. Text layers, logo, background, and transitions are all
 * composed independently and are unaffected by this gate.
 */
function buildSubtitleFilter(
  aspectRatio: ClipAspectRatio,
  subtitlePath: string | null,
  captionPreset?: CaptionPreset | null,
) {
  if (!subtitlePath || captionPreset?.visible === false) {
    return null;
  }

  const escapedPath = escapeSubtitlePath(subtitlePath);

  // ASS files carry their own styling and positioning
  if (subtitlePath.endsWith(".ass")) {
    return `ass='${escapedPath}'`;
  }

  // SRT path: apply force_style
  const captionStyle = captionStyleByAspectRatio[aspectRatio];
  const fontSize = captionPreset?.fontSize ?? captionStyle.fontSize;

  const fontName = resolveFontName(captionPreset?.fontName);
  const primaryColor = captionPreset?.primaryColor
    ? hexToFfmpegColor(captionPreset.primaryColor)
    : "\\&H00FFFFFF\\&";
  const outlineColor = captionPreset?.outlineColor
    ? hexToFfmpegColor(captionPreset.outlineColor)
    : "\\&H00000000\\&";
  const outlineWidth = captionPreset?.outlineWidth ?? 2;
  const shadow = captionPreset?.shadow ?? 1;
  const bold = captionPreset?.bold !== false ? 1 : 0;
  const alignment =
    captionPreset?.position === "top" ? 8 :
    captionPreset?.position === "center" ? 5 : 2;

  const spacing = Math.round((captionPreset?.letterSpacing ?? 0) * fontSize);

  let borderStyle = 1;
  let backColour = "";
  if (captionPreset?.backgroundColor) {
    borderStyle = 3;
    const bgAlpha = Math.round((1 - (captionPreset.backgroundOpacity ?? 0.6)) * 255);
    const bgAlphaHex = bgAlpha.toString(16).toUpperCase().padStart(2, "0");
    const r = captionPreset.backgroundColor.slice(1, 3);
    const g = captionPreset.backgroundColor.slice(3, 5);
    const b = captionPreset.backgroundColor.slice(5, 7);
    backColour = `,BackColour=\\&H${bgAlphaHex}${b}${g}${r}\\&,BorderStyle=${borderStyle}`;
  }

  const forceStyle =
    `FontSize=${fontSize},Alignment=${alignment},MarginV=${captionStyle.marginV},FontName=${fontName},` +
    `PrimaryColour=${primaryColor},OutlineColour=${outlineColor},Outline=${outlineWidth},Shadow=${shadow},Bold=${bold}` +
    (spacing > 0 ? `,Spacing=${spacing}` : "") +
    backColour;

  return `subtitles='${escapedPath}':force_style='${forceStyle}'`;
}

function buildLogoOverlayPosition(
  position: BrandTemplateSnapshot["logoPosition"],
): { x: string; y: string } {
  const [vertical, horizontal] = position.split("-") as [
    "top" | "mid" | "bot",
    "left" | "center" | "right",
  ];
  let x: string;
  let y: string;

  if (horizontal === "left") x = `${LOGO_MARGIN_PX}`;
  else if (horizontal === "right") x = `W-w-${LOGO_MARGIN_PX}`;
  else x = `(W-w)/2`;

  if (vertical === "top") y = `${LOGO_MARGIN_PX}`;
  else if (vertical === "bot") y = `H-h-${LOGO_MARGIN_PX}`;
  else y = `(H-h)/2`;

  return { x, y };
}

function computeLogoTargetWidth(
  logo: LogoOverlay,
  videoWidth: number,
): number {
  return Math.max(40, Math.round(videoWidth * (logo.scalePct / 100)));
}

function buildLogoFilter(
  logo: LogoOverlay,
  videoWidth: number,
  inputStreamRef: string,
  outputStreamRef: string,
  logoInputIndex: number,
  scratchSuffix: string,
): string {
  const opacity = Math.max(0.1, Math.min(1, logo.opacity / 100));
  const targetWidth = computeLogoTargetWidth(logo, videoWidth);
  const { x, y } = buildLogoOverlayPosition(logo.position);
  const scratchLabel = `brandlogo${scratchSuffix}`;
  return [
    `[${logoInputIndex}:v]scale=${targetWidth}:-1,format=rgba,colorchannelmixer=aa=${opacity.toFixed(3)}[${scratchLabel}]`,
    `${inputStreamRef}[${scratchLabel}]overlay=${x}:${y}${outputStreamRef}`,
  ].join(";");
}

export function buildCropAndScaleFilter(
  probe: SourceProbe,
  aspectRatio: ClipAspectRatio,
  reframe?: ReframeSpec | null,
) {
  const config = aspectRatioConfig.get(aspectRatio);

  if (!config) {
    throw new WorkflowWorkerError(
      "unsupported_aspect_ratio",
      `Unsupported aspect ratio: ${aspectRatio}`,
      "permanent",
    );
  }

  if (!probe.hasVideo) {
    return null;
  }

  if (probe.width <= 0 || probe.height <= 0) {
    throw new WorkflowWorkerError(
      "invalid_source_dimensions",
      `Source reported invalid video dimensions (${probe.width}x${probe.height})`,
      "permanent",
    );
  }

  const srcRatio = probe.width / probe.height;
  const targetRatio = config.width / config.height;

  let cropW: number;
  let cropH: number;

  if (srcRatio >= targetRatio) {
    cropH = probe.height;
    cropW = Math.round(probe.height * targetRatio);
  } else {
    cropW = probe.width;
    cropH = Math.round(probe.width / targetRatio);
  }

  // Auto-reframe: when we crop horizontally (srcRatio >= targetRatio) and a face
  // path is available, drive crop x via sendcmd so the crop follows the speaker
  // instead of a static center crop.
  if (reframe && srcRatio >= targetRatio && cropW < probe.width) {
    const escaped = escapeSubtitlePath(reframe.scriptPath);
    return (
      `sendcmd=f='${escaped}',` +
      `${reframe.cropName}=w=${cropW}:h=${cropH}:x=${Math.round((probe.width - cropW) / 2)}:y=0,` +
      `scale=${config.width}:${config.height},format=yuv420p`
    );
  }

  return `crop=${cropW}:${cropH},scale=${config.width}:${config.height},format=yuv420p`;
}

/**
 * Whether the (relatively expensive: ffmpeg segment extraction + python/
 * opencv face detection) auto-reframe face-path detection should run for
 * this clip — vizard-parity.md Phase C-2 stage 1 (framing modes). Routes
 * through the single shared `resolveEffectiveFramingMode` so this can never
 * disagree with the fit/crop builder branch below:
 *  - "auto": run detection (today's only behavior, unchanged).
 *  - "center": skip detection entirely — cheaper, and `buildCropAndScaleFilter`
 *    already falls back to a static center crop whenever `reframe` is absent.
 *  - "fit": also skipped, but for a different reason — the fit branch never
 *    crops at all, so a detected face path would never be consumed. (In
 *    practice this never gets called for "fit" either, since the caller's
 *    own gate gets there first, but the mode check agrees regardless.)
 *  - "split" (split packet B): also `false` here — this is `=== "auto"`, not
 *    an exhaustive switch — but split is NOT actually undetected: it runs
 *    its own multi-face detection (`detectMultiFacePath` ->
 *    `buildSplitLayoutPlan`) through a separate gate in
 *    the Clip Render Attempt, guarded directly on
 *    `resolveEffectiveFramingMode(studioEdits) === "split"` rather than this
 *    function. This function staying `false` for split just means split
 *    clips skip the SINGLE-face auto-reframe path — which they still fall
 *    back to (via `applyAutoReframe`, called directly rather than through
 *    this gate) whenever the multi-face plan isn't usable, see
 *    `decideSplitFallback`.
 *  - "screen" (screen packet B): also `false` here, same `!== "auto"`
 *    reasoning as "split" — screen is NOT actually undetected either: it runs
 *    its own single-face detection (`detectFacePath`, same detector as
 *    "auto" but through its own gate) via `applyScreenSpeakerLayout`, through
 *    a separate gate in the Clip Render Attempt guarded directly on
 *    `resolveEffectiveFramingMode(studioEdits) === "screen"` rather than this
 *    function. This function staying `false` for screen just means screen
 *    clips skip the whole-frame SINGLE-face auto-reframe path — which they
 *    only fall back to (via `applyAutoReframe`, called directly rather than
 *    through this gate) when the screen layout itself is disabled or
 *    conflicts with B-roll, see `decideScreenFallback`. An undetected face
 *    within an otherwise-active screen layout does NOT fall back to this
 *    path — it degrades to a static-center BOTTOM TILE while the screen
 *    layout itself keeps rendering (see `applyScreenSpeakerLayout`'s doc
 *    comment).
 */
export function shouldRunAutoReframeDetection(studioEdits: StudioEdits): boolean {
  return resolveEffectiveFramingMode(studioEdits) === "auto";
}

/** Text-layer drawtext filters + caption burn-in, comma-joined (or `""` when
 *  neither is present) — the part of `buildSingleVideoFilter`'s chain that
 *  has nothing to do with crop/fit, extracted so the fit+background path
 *  (`buildFitAndBackgroundFilter`) can fold the exact same chain onto ITS
 *  composed frame instead of duplicating this logic. */
function buildTextAndCaptionChain(
  studioEdits: StudioEdits | null | undefined,
  clipDurationSec: number,
  aspectRatio: ClipAspectRatio,
  srtPath: string | null,
  captionPreset?: CaptionPreset | null,
): string {
  const chain: (string | null)[] = [];
  if (studioEdits?.textLayers.length) {
    chain.push(...buildTextLayerFilters(studioEdits.textLayers, clipDurationSec));
  }
  chain.push(buildSubtitleFilter(aspectRatio, srtPath, captionPreset));
  return chain.filter(Boolean).join(",");
}

function buildSingleVideoFilter(
  probe: SourceProbe,
  aspectRatio: ClipAspectRatio,
  srtPath: string | null,
  captionPreset?: CaptionPreset | null,
  reframe?: ReframeSpec | null,
  studioEdits?: StudioEdits | null,
  clipDurationSec = 0,
) {
  const cropScale = buildCropAndScaleFilter(probe, aspectRatio, reframe);
  const textAndCaptionChain = buildTextAndCaptionChain(
    studioEdits,
    clipDurationSec,
    aspectRatio,
    srtPath,
    captionPreset,
  );
  return [cropScale, textAndCaptionChain].filter(Boolean).join(",");
}

/**
 * Builds the "fit" pad/background composition filter_complex PARTS
 * (vizard-parity.md Phase C item 2), used INSTEAD of
 * `buildCropAndScaleFilter` whenever `studioEdits.background.mode !== "off"`:
 * the source letterboxes ("fit" — scale to contain, never crop) and the
 * empty frame is filled with a solid color or an image.
 *
 * Returns filter_complex PARTS (not a single comma-chain the way
 * `buildCropAndScaleFilter` does) because image mode needs a SECOND ffmpeg
 * input (the downloaded background image) composited via `overlay`, which
 * cannot be expressed as a chain hanging off one input label. Color mode
 * (and the fallback used when an image URL/download failed upstream) is
 * expressed the same way — a single-part pad chain — so callers have one
 * code path regardless of mode.
 *
 * Unlike `buildCropAndScaleFilter` this never needs the source probe: the
 * target frame is always the aspect ratio's fixed W×H, and ffmpeg's `scale`
 * filter reads the actual input dimensions at run time. There is
 * deliberately no `reframe` parameter either — auto-reframe never applies
 * here (nothing is cropped), so callers simply don't thread `output.reframe`
 * through when background is active.
 *
 * `trailingChain` (an already-comma-joined fragment, e.g. text layers +
 * caption burn-in from `buildTextAndCaptionChain`) is folded into the LAST
 * part so the composed frame and any per-clip overlays land in one filter
 * statement — mirrors how `buildCropAndScaleFilter`'s callers append the
 * same chain after crop+scale today. Pass `""` to leave the composed frame
 * as the final output (`buildBrollVideoArgs` does this and applies its own
 * text/caption steps afterward, once cutaways are overlaid on top).
 *
 * Image mode's `[bgimg]` chain also pins its frame rate to `fps` (defaults
 * to `DEFAULT_RENDER_MEDIA_FPS` when omitted). This matters because the still
 * image is `overlay`'s MAIN (first) framesync input, so without an explicit
 * `fps=` the composed output's rate silently inherits the image2 demuxer's
 * default of 25 fps regardless of the actual source rate — verified with
 * real ffmpeg: a 30fps or 60fps source both collapsed to 25fps output in
 * every image-background combination. Color mode never hits `overlay` at
 * all, so it's unaffected and doesn't take an `fps` param.
 */
export function buildFitAndBackgroundFilter(params: {
  aspectRatio: ClipAspectRatio;
  background: { mode: "color" | "image"; color: string | null; imagePath: string | null };
  videoInputLabel: string;
  outputLabel: string;
  /** ffmpeg input index of the downloaded background image — only consumed
   *  when `background.mode === "image"` AND `background.imagePath` is set;
   *  omit/null falls back to the solid-color pad even when mode is "image"
   *  (e.g. the URL was invalid or the download failed upstream). */
  imageInputIndex?: number | null;
  trailingChain?: string;
  /** Source frame rate to pin the image-mode `[bgimg]` chain to (see doc
   *  comment above) — callers pass `probe.fps`. Ignored in color mode.
   *  Defaults to `DEFAULT_RENDER_MEDIA_FPS` if omitted or non-positive. */
  fps?: number;
}): string[] {
  const config = aspectRatioConfig.get(params.aspectRatio);
  if (!config) {
    throw new WorkflowWorkerError(
      "unsupported_aspect_ratio",
      `Unsupported aspect ratio: ${params.aspectRatio}`,
      "permanent",
    );
  }
  const { width: W, height: H } = config;
  const suffix = params.trailingChain ? `,${params.trailingChain}` : "";

  if (
    params.background.mode === "image" &&
    params.background.imagePath &&
    params.imageInputIndex != null
  ) {
    const fps =
      params.fps && params.fps > 0 ? params.fps : DEFAULT_RENDER_MEDIA_FPS;
    return [
      `[${params.imageInputIndex}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps}[bgimg]`,
      `${params.videoInputLabel}scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[bgfitv]`,
      `[bgimg][bgfitv]overlay=(W-w)/2:(H-h)/2,format=yuv420p${suffix}${params.outputLabel}`,
    ];
  }

  const ffColor = hexToFfmpegRgb(params.background.color ?? "#000000");
  return [
    `${params.videoInputLabel}scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${ffColor},format=yuv420p${suffix}${params.outputLabel}`,
  ];
}

export function buildSingleVideoArgs(params: {
  sourcePath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  aspectRatio: ClipAspectRatio;
  probe: SourceProbe;
  srtPath: string | null;
  captionPreset?: CaptionPreset | null;
  logo?: LogoOverlay | null;
  reframe?: ReframeSpec | null;
  /** Versioned composition policy. When present, the FFmpeg adapter consumes
   *  its exact scene geometry before any legacy framing branch can run. */
  composition?: {
    plan: ClipCompositionPlan;
    targetId: string;
  } | null;
  studioEdits?: StudioEdits | null;
  music?: MusicPlan | null;
  /** One-shot SFX placements (vizard-parity.md "Music/SFX library") —
   *  empty/omitted preserves today's behavior exactly (no new inputs, no
   *  mix branch). See `SfxPlan`. */
  sfx?: SfxPlan[] | null;
  /** Resolved canvas background (vizard-parity Phase C item 2) — presence
   *  implies "on" (mode is always "color" or "image"); omit/null preserves
   *  today's crop-to-fill behavior. See `BackgroundPlan`. */
  background?: BackgroundPlan | null;
  /** Segment-aware stacked 2-up plan (split packet B, vizard-parity.md
   *  "Split-screen 2-up") — presence means the effective framing mode is
   *  "split" AND a real plan was built (never coexists with `background`;
   *  see `resolveEffectiveFramingMode`'s doc comment). Checked AFTER
   *  `background` and BEFORE the plain crop-and-scale fallback, so a split
   *  clip that couldn't build a plan this render (see
   *  `decideSplitFallback`) transparently falls through to the same
   *  `params.reframe`-driven crop the "auto"/"center" modes use. */
  split?: { segments: SplitLayoutSegment[] } | null;
  /** Screen-share layout plan (screen packet B, "screen" framing mode) —
   *  presence means the effective framing mode is "screen" (never coexists
   *  with `background` or `split`; see `resolveEffectiveFramingMode`'s doc
   *  comment). Checked AFTER `split` and BEFORE the plain crop-and-scale
   *  fallback — mutually exclusive with `split` in practice (only one
   *  effective mode is ever active), so the check order between the two
   *  doesn't matter functionally, but mirrors `split`'s own placement
   *  relative to `background`/the fallback. Unlike `split`, there's no
   *  "empty plan" case: `applyScreenSpeakerLayout` always sets a bottom-tile
   *  spec (face-tracked or static-center) whenever screen mode is active and
   *  not disabled/B-roll-conflicted — see `output.screenBottom`. */
  screen?: { bottom: ScreenSpeakerBottomSpec } | null;
  /** Target resolution (vizard-parity Phase C export options) — "720p"
   *  applies the 2/3 downscale, "1080p"/omitted renders at base resolution. */
  resolution?: ClipRenderResolution;
  /** Corner watermark, gated by hasFeature(ownerTier, "export.noWatermark")
   *  — independent of `resolution` (see `buildExportTreatmentFilter`). */
  watermark?: boolean;
  /** Non-empty `deletedRanges` cut plan (vizard-parity Phase B step 7).
   *  Omitted/uncut: byte-identical to the pre-cut-concat filter graph. */
  cutPlan?: ClipCutPlan | null;
}) {
  if (params.cutPlan?.isEmpty) {
    throw new WorkflowWorkerError(
      "clip_cut_plan_empty",
      "cutPlan has no renderable segments — caller must guard before building ffmpeg args",
      "permanent",
    );
  }
  const isCut = Boolean(params.cutPlan && !params.cutPlan.isUncut);
  const clipDurationSec = isCut
    ? params.cutPlan!.editedDurationSec
    : params.endSec - params.startSec;

  const cutConcat = isCut
    ? buildCutConcatFilter({
        cutPlan: params.cutPlan!,
        clipStartSec: params.startSec,
        includeAudio: params.probe.hasAudio,
      })
    : null;
  const videoInputLabel = cutConcat ? cutConcat.videoLabel! : "[0:v]";
  const audioInputLabel = cutConcat
    ? cutConcat.audioLabel
    : params.probe.hasAudio
      ? "[0:a:0]"
      : null;

  // Input index bookkeeping: source is always 0; background image (fit mode
  // only, when a local downloaded path is available), logo, music, then each
  // SFX placement each consume the next slot IF present — same order the
  // args are pushed in below. Byte-identical to before this feature when
  // `background`/`sfx` are absent/off (bgImageInputIndex stays null,
  // logoInputIndex/musicInputIndex fall back to the same 1/2 values the old
  // hardcoded literals used, sfxInputIndexes stays an empty array).
  const usesBackgroundImage = Boolean(
    params.background?.mode === "image" && params.background.imagePath,
  );
  let nextInputIndex = 1;
  const bgImageInputIndex = usesBackgroundImage ? nextInputIndex++ : null;
  const logoInputIndex = params.logo ? nextInputIndex++ : null;
  const musicInputIndex = params.music ? nextInputIndex++ : null;
  const sfxInputIndexes = (params.sfx ?? []).map(() => nextInputIndex++);

  const textAndCaptionChain = buildTextAndCaptionChain(
    params.studioEdits,
    clipDurationSec,
    params.aspectRatio,
    params.srtPath,
    params.captionPreset,
  );

  let finalLabel: string;
  const filterParts: string[] = cutConcat ? [...cutConcat.filterParts] : [];
  const composedOutputLabel = params.logo ? "[outvbase]" : "[outv]";

  if (params.composition) {
    const compiled = compileCompositionPlanVideo({
      plan: params.composition.plan,
      targetId: params.composition.targetId,
      videoInputLabel,
      outputLabel: composedOutputLabel,
      trailingChain: textAndCaptionChain,
      backgroundImageInputIndex: bgImageInputIndex,
      fps: params.probe.fps,
    });
    filterParts.push(...compiled.filterParts);
  } else if (params.background) {
    // Fit mode (vizard-parity Phase C item 2): letterbox instead of
    // crop-to-fill, background color/image fills the empty frame.
    // Auto-reframe never applies here — `params.reframe` is deliberately not
    // threaded through (see buildFitAndBackgroundFilter's doc comment).
    filterParts.push(
      ...buildFitAndBackgroundFilter({
        aspectRatio: params.aspectRatio,
        background: params.background,
        videoInputLabel,
        outputLabel: composedOutputLabel,
        imageInputIndex: bgImageInputIndex,
        trailingChain: textAndCaptionChain,
        fps: params.probe.fps,
      }),
    );
  } else if (params.split && params.split.segments.length > 0) {
    // Split packet B: segment-aware stacked 2-up. Reads from `videoInputLabel`
    // (the same post-cut-concat-aware label the crop-and-scale fallback below
    // uses) because plan segments are already expressed on the EDITED
    // timeline — see `buildSplitFilterChain`'s doc comment. `params.reframe`
    // is irrelevant here (it's mutually exclusive with a real split plan:
    // either this clip built a plan, or it fell back to the `else` branch
    // below with `params.reframe` set instead — never both).
    filterParts.push(
      ...buildSplitFilterChain({
        aspectRatio: params.aspectRatio,
        probe: { width: params.probe.width, height: params.probe.height },
        segments: params.split.segments,
        videoInputLabel,
        outputLabel: composedOutputLabel,
        trailingChain: textAndCaptionChain,
      }),
    );
  } else if (params.screen) {
    // Screen packet B: static two-tile top-fit/bottom-speaker layout. Reads
    // from `videoInputLabel` for the same reason `split` does (plan/spec is
    // already expressed against the post-cut-concat-aware label). `params.
    // reframe` is irrelevant here (it's mutually exclusive with a real
    // screen plan: either screen mode is active and this branch runs, or it
    // fell back to the plain `else` branch below with `params.reframe` set
    // instead — never both, same contract `split` already established).
    filterParts.push(
      ...buildScreenSpeakerFilterChain({
        aspectRatio: params.aspectRatio,
        probe: { width: params.probe.width, height: params.probe.height },
        bottom: params.screen.bottom,
        videoInputLabel,
        outputLabel: composedOutputLabel,
        trailingChain: textAndCaptionChain,
      }),
    );
  } else {
    const cropScale = buildCropAndScaleFilter(
      params.probe,
      params.aspectRatio,
      params.reframe,
    );
    const chain = [cropScale, textAndCaptionChain].filter(Boolean).join(",");
    filterParts.push(`${videoInputLabel}${chain}${composedOutputLabel}`);
  }

  if (params.logo) {
    const aspectConfig = aspectRatioConfig.get(params.aspectRatio);
    if (!aspectConfig) {
      throw new WorkflowWorkerError(
        "unsupported_aspect_ratio",
        `Unsupported aspect ratio: ${params.aspectRatio}`,
        "permanent",
      );
    }
    filterParts.push(
      buildLogoFilter(
        params.logo,
        aspectConfig.width,
        "[outvbase]",
        "[outv]",
        logoInputIndex!,
        "",
      ),
    );
  }
  finalLabel = "[outv]";

  finalLabel = appendTransitionFilter(
    filterParts,
    finalLabel,
    "[outvtransition]",
    params.studioEdits,
    clipDurationSec,
  );

  const singleExportTreatment = buildExportTreatmentFilter(
    params.resolution,
    params.watermark,
  );
  if (singleExportTreatment) {
    filterParts.push(`${finalLabel}${singleExportTreatment}[outvfree]`);
    finalLabel = "[outvfree]";
  }

  const args = [
    "-y",
    ...httpSourceInputArgs(params.sourcePath),
    "-ss",
    String(params.startSec),
    "-t",
    String(params.endSec - params.startSec),
    "-i",
    params.sourcePath,
  ];

  if (bgImageInputIndex != null) {
    args.push("-i", params.background!.imagePath!);
  }

  if (params.logo) {
    args.push("-i", params.logo.filePath);
  }

  if (params.music) {
    args.push("-stream_loop", "-1", "-i", params.music.path);
  }

  for (const sfx of params.sfx ?? []) {
    // No -stream_loop: SFX is one-shot, never looped, unlike music above.
    args.push("-i", sfx.path);
  }

  const hasMixedAudio = Boolean(params.music) || sfxInputIndexes.length > 0;
  if (hasMixedAudio) {
    filterParts.push(
      buildAudioMixFilter({
        sourceHasAudio: params.probe.hasAudio,
        clipDurationSec,
        sourceAudio: params.studioEdits?.sourceAudio,
        dialogueInputRef: cutConcat ? cutConcat.audioLabel! : undefined,
        music: params.music
          ? { inputIndex: musicInputIndex!, plan: params.music }
          : null,
        sfx: (params.sfx ?? []).map((plan, i) => ({
          inputIndex: sfxInputIndexes[i]!,
          plan,
        })),
      }),
    );
  } else if (audioInputLabel) {
    filterParts.push(
      `${audioInputLabel}${buildDialogueAudioFilter(params.studioEdits?.sourceAudio, clipDurationSec)}[outa]`,
    );
  }

  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    finalLabel,
    "-c:v",
    "libx264",
    "-preset",
    x264Preset(),
    "-crf",
    x264Crf(),
  );

  if (hasMixedAudio) {
    args.push("-map", "[outa]", "-c:a", "aac", "-b:a", "128k", "-shortest");
  } else if (params.probe.hasAudio) {
    args.push("-map", "[outa]", "-c:a", "aac", "-b:a", "128k");
  } else {
    args.push("-an");
  }

  // Explicit output-duration bound: whatever the filter graph does upstream
  // (an over-long B-roll/music input, a framesync quirk, etc.), the encoded
  // output can never exceed the clip's own planned duration.
  args.push(
    "-t",
    clipDurationSec.toFixed(3),
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "1024",
    params.outputPath,
  );

  return args;
}

/**
 * Builds an ffmpeg single-output render that overlays 1-4 B-roll cutaways on
 * top of the (cropped/reframed) source, each within its own non-overlapping
 * time window, then burns captions and the logo on top. The source audio
 * plays throughout (B-roll is silent). Each cutaway gets its own input,
 * chained through successive `overlay` stages so multiple recurring inserts
 * compose correctly (a single cutaway is just the N=1 case of this).
 *
 * The source base can use the same segment layout plan as a normal render;
 * B-roll then replaces that composed base only inside its cutaway windows.
 * This preserves Vizard-style speaker framing before and after B-roll rather
 * than downgrading the entire clip to a single-face/center crop.
 */
export function buildBrollVideoArgs(params: {
  sourcePath: string;
  cutaways: Array<{
    path: string;
    window: { startSec: number; endSec: number };
  }>;
  outputPath: string;
  startSec: number;
  endSec: number;
  aspectRatio: ClipAspectRatio;
  probe: SourceProbe;
  srtPath: string | null;
  captionPreset?: CaptionPreset | null;
  logo?: LogoOverlay | null;
  reframe?: ReframeSpec | null;
  composition?: {
    plan: ClipCompositionPlan;
    targetId: string;
  } | null;
  split?: { segments: SplitLayoutSegment[] } | null;
  studioEdits?: StudioEdits | null;
  music?: MusicPlan | null;
  /** One-shot SFX placements — see `buildSingleVideoArgs`'s param doc; same
   *  contract here. */
  sfx?: SfxPlan[] | null;
  /** Resolved canvas background (vizard-parity Phase C item 2) — see
   *  `buildSingleVideoArgs`'s param doc; same contract here. */
  background?: BackgroundPlan | null;
  /** See `buildSingleVideoArgs`'s param docs — same contract here. */
  resolution?: ClipRenderResolution;
  watermark?: boolean;
  /** See `buildSingleVideoArgs` — same cut-concat contract. */
  cutPlan?: ClipCutPlan | null;
}) {
  if (params.cutaways.length === 0) {
    throw new WorkflowWorkerError(
      "broll_cutaways_empty",
      "buildBrollVideoArgs requires at least one cutaway",
      "permanent",
    );
  }
  if (params.cutPlan?.isEmpty) {
    throw new WorkflowWorkerError(
      "clip_cut_plan_empty",
      "cutPlan has no renderable segments — caller must guard before building ffmpeg args",
      "permanent",
    );
  }

  const config = aspectRatioConfig.get(params.aspectRatio);
  if (!config) {
    throw new WorkflowWorkerError(
      "unsupported_aspect_ratio",
      `Unsupported aspect ratio: ${params.aspectRatio}`,
      "permanent",
    );
  }
  const { width: W, height: H } = config;

  const subtitleFilter = buildSubtitleFilter(
    params.aspectRatio,
    params.srtPath,
    params.captionPreset,
  );

  const cutawayCount = params.cutaways.length;
  // Input index bookkeeping: source(0), background image (fit mode only,
  // when a local downloaded path is available), then the cutaways, then
  // logo, then music — same order the args are pushed in below. `bgOffset`
  // is 0 when background is absent/off, so every index below is
  // byte-identical to before this feature in that case.
  const usesBackgroundImage = Boolean(
    params.background?.mode === "image" && params.background.imagePath,
  );
  const bgImageInputIndex = usesBackgroundImage ? 1 : null;
  const bgOffset = usesBackgroundImage ? 1 : 0;
  const logoInputIndex = 1 + bgOffset + cutawayCount;
  const isCut = Boolean(params.cutPlan && !params.cutPlan.isUncut);
  const clipDurationSec = isCut
    ? params.cutPlan!.editedDurationSec
    : params.endSec - params.startSec;

  const cutConcat = isCut
    ? buildCutConcatFilter({
        cutPlan: params.cutPlan!,
        clipStartSec: params.startSec,
        includeAudio: params.probe.hasAudio,
      })
    : null;
  const videoInputLabel = cutConcat ? cutConcat.videoLabel! : "[0:v]";
  const audioInputLabel = cutConcat
    ? cutConcat.audioLabel
    : params.probe.hasAudio
      ? "[0:a:0]"
      : null;

  const parts: string[] = cutConcat ? [...cutConcat.filterParts] : [];
  if (params.composition) {
    parts.push(
      ...compileCompositionPlanVideo({
        plan: params.composition.plan,
        targetId: params.composition.targetId,
        videoInputLabel,
        outputLabel: "[stage0]",
        backgroundImageInputIndex: bgImageInputIndex,
        fps: params.probe.fps,
      }).filterParts,
    );
  } else if (params.background) {
    // Fit mode (vizard-parity Phase C item 2): letterbox the base frame
    // instead of cropping to fill; cutaways/text/captions/logo still overlay
    // on top of it exactly as they do today, unaware of how [stage0] was
    // composed. Auto-reframe never applies here (nothing is cropped) —
    // `params.reframe` is deliberately not threaded through.
    parts.push(
      ...buildFitAndBackgroundFilter({
        aspectRatio: params.aspectRatio,
        background: params.background,
        videoInputLabel,
        outputLabel: "[stage0]",
        imageInputIndex: bgImageInputIndex,
        fps: params.probe.fps,
      }),
    );
  } else if (params.split && params.split.segments.length > 0) {
    parts.push(
      ...buildSplitFilterChain({
        aspectRatio: params.aspectRatio,
        probe: { width: params.probe.width, height: params.probe.height },
        segments: params.split.segments,
        videoInputLabel,
        outputLabel: "[stage0]",
      }),
    );
  } else {
    const cropScale =
      buildCropAndScaleFilter(params.probe, params.aspectRatio, params.reframe) ??
      `scale=${W}:${H},format=yuv420p`;
    parts.push(`${videoInputLabel}${cropScale}[stage0]`);
  }
  let finalLabel = "[stage0]";

  params.cutaways.forEach((cutaway, index) => {
    const brollInputIndex = 1 + bgOffset + index; // input 0 is the source
    const start = cutaway.window.startSec;
    const end = cutaway.window.endSec;
    const brollLabel = `[broll${index}]`;
    const nextStageLabel = `[stage${index + 1}]`;
    parts.push(
      // Cover-fit this cutaway's B-roll to the frame and delay it to begin at
      // its own window's start.
      `[${brollInputIndex}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=PTS-STARTPTS+${start}/TB,format=yuv420p${brollLabel}`,
    );
    parts.push(
      `${finalLabel}${brollLabel}overlay=0:0:enable='between(t,${start},${end})'${nextStageLabel}`,
    );
    finalLabel = nextStageLabel;
  });

  if (params.studioEdits?.textLayers.length) {
    const textFilters = buildTextLayerFilters(
      params.studioEdits.textLayers,
      clipDurationSec,
    ).join(",");
    parts.push(`${finalLabel}${textFilters}[texted]`);
    finalLabel = "[texted]";
  }
  if (subtitleFilter) {
    parts.push(`${finalLabel}${subtitleFilter}[subbed]`);
    finalLabel = "[subbed]";
  }
  if (params.logo) {
    parts.push(
      buildLogoFilter(params.logo, W, finalLabel, "[outv]", logoInputIndex, ""),
    );
    finalLabel = "[outv]";
  }

  finalLabel = appendTransitionFilter(
    parts,
    finalLabel,
    "[outvtransition]",
    params.studioEdits,
    clipDurationSec,
  );

  const brollExportTreatment = buildExportTreatmentFilter(
    params.resolution,
    params.watermark,
  );
  if (brollExportTreatment) {
    parts.push(`${finalLabel}${brollExportTreatment}[outvfree]`);
    finalLabel = "[outvfree]";
  }

  const args = [
    "-y",
    ...httpSourceInputArgs(params.sourcePath),
    "-ss",
    String(params.startSec),
    "-t",
    String(params.endSec - params.startSec),
    "-i",
    params.sourcePath,
  ];

  if (bgImageInputIndex != null) {
    args.push("-i", params.background!.imagePath!);
  }

  for (const cutaway of params.cutaways) {
    // Each B-roll input gets its own `-t`, scoped to just this input (ffmpeg
    // resets per-input options at each `-i`), sized to exactly its own
    // cutaway window. Without this, `overlay` runs until the *longer* of its
    // two inputs finishes (shortest defaults to 0), so any B-roll asset
    // longer than its window silently stretched the whole rendered output
    // past its own planned end (frozen final frame, silent audio) — trimming
    // here means each B-roll stream can never outlast its own window.
    const windowDurationSec = Math.max(
      0.1,
      cutaway.window.endSec - cutaway.window.startSec,
    );
    args.push("-t", windowDurationSec.toFixed(3), "-i", cutaway.path);
  }

  if (params.logo) args.push("-i", params.logo.filePath);

  // Music, then SFX, each consume the next input slot — same order as
  // buildSingleVideoArgs. musicInputIndex is computed unconditionally
  // (even when music is absent) so sfxInputIndexes can be derived from it
  // without duplicating the bgOffset/cutawayCount/logo arithmetic.
  const musicInputIndex = 1 + bgOffset + cutawayCount + (params.logo ? 1 : 0);
  const sfxInputIndexes = (params.sfx ?? []).map(
    (_, i) => musicInputIndex + (params.music ? 1 : 0) + i,
  );

  if (params.music) {
    args.push("-stream_loop", "-1", "-i", params.music.path);
  }
  for (const sfx of params.sfx ?? []) {
    args.push("-i", sfx.path);
  }

  const hasMixedAudio = Boolean(params.music) || sfxInputIndexes.length > 0;
  if (hasMixedAudio) {
    parts.push(
      buildAudioMixFilter({
        sourceHasAudio: params.probe.hasAudio,
        clipDurationSec,
        sourceAudio: params.studioEdits?.sourceAudio,
        dialogueInputRef: cutConcat ? cutConcat.audioLabel! : undefined,
        music: params.music
          ? { inputIndex: musicInputIndex, plan: params.music }
          : null,
        sfx: (params.sfx ?? []).map((plan, i) => ({
          inputIndex: sfxInputIndexes[i]!,
          plan,
        })),
      }),
    );
  } else if (audioInputLabel) {
    parts.push(
      `${audioInputLabel}${buildDialogueAudioFilter(params.studioEdits?.sourceAudio, clipDurationSec)}[outa]`,
    );
  }

  args.push("-filter_complex", parts.join(";"), "-map", finalLabel);

  if (hasMixedAudio) {
    args.push("-map", "[outa]", "-c:a", "aac", "-b:a", "128k", "-shortest");
  } else if (params.probe.hasAudio) {
    args.push("-map", "[outa]", "-c:a", "aac", "-b:a", "128k");
  } else {
    args.push("-an");
  }

  // Belt-and-suspenders output-duration bound (see buildSingleVideoArgs):
  // even with every B-roll input now trimmed, this guarantees the encoded
  // output can never exceed the clip's own planned duration.
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    x264Preset(),
    "-crf",
    x264Crf(),
    "-t",
    clipDurationSec.toFixed(3),
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "1024",
    params.outputPath,
  );

  return args;
}

interface DownloadUrlToFileOverrides {
  /** Test-only: inject a fake fetch implementation. Production call sites
   *  never pass it. */
  fetchImpl?: GuardedFetchOptions["fetchImpl"];
  /** Test-only: inject a fake DNS resolver. Production call sites never
   *  pass it. */
  resolver?: GuardedFetchOptions["resolver"];
  /**
   * Overrides REMOTE_MEDIA_MAX_BYTES for this call. Tests use it to exercise
   * the size-cap path without allocating hundreds of MB — but (M6,
   * vizard-parity.md "Music/SFX library") this is also real PRODUCTION
   * usage now: AudioAsset-resolved SFX and music downloads pass
   * `AUDIO_UPLOAD_MAX_BYTES` (the same 50MB ceiling enforced at upload time)
   * here instead of silently inheriting the much larger 250MB B-roll/
   * pasted-URL budget — an uploaded asset already went through that gate
   * once, so a render pulling it back down should never be able to exceed
   * it. Pasted-URL music (no `assetId`) deliberately keeps the 250MB
   * default; it predates this change and isn't bounded by the upload gate.
   */
  maxBytes?: number;
  /** Overrides RenderConfig.remoteMediaTimeoutMs so the timeout path can be
   *  tested in milliseconds instead of 45s. Production call sites never pass it. */
  timeoutMs?: number;
}

/**
 * Downloads a remote B-roll/music/SFX asset to disk. Streams to disk (never
 * buffers the whole body in memory), enforces a bounded timeout and max size,
 * and validates every redirect hop — a raw `fetch` + `arrayBuffer()` here
 * previously let a single hostile URL OOM the worker or pin a worker slot for
 * up to the full reaper window. Callers are expected to catch and treat any
 * failure as "no B-roll/music/SFX" — a bad remote asset must never fail the
 * whole clip render.
 *
 * `overrides` is exposed (and this function exported) so tests can inject a
 * fake `fetchImpl`/`resolver` the same way `packages/services`'s own
 * `guardedFetch` tests do — those two fields are test-only. `maxBytes` is
 * NOT test-only (see `DownloadUrlToFileOverrides`'s doc comment) — production
 * call sites pass it to tighten the default 250MB budget down to
 * `AUDIO_UPLOAD_MAX_BYTES` for AudioAsset-resolved downloads.
 */
export async function downloadUrlToFile(
  url: string,
  filePath: string,
  errorCode = "remote_media_download_failed",
  overrides?: DownloadUrlToFileOverrides,
): Promise<void> {
  const maxBytes = overrides?.maxBytes ?? REMOTE_MEDIA_MAX_BYTES;
  const timeoutMs =
    overrides?.timeoutMs ?? currentRenderConfig().remoteMediaTimeoutMs;
  let response: Response;
  try {
    response = await currentRenderAdapters().remoteMedia.guardedFetch(url, {
      timeoutMs,
      fetchImpl: overrides?.fetchImpl,
      resolver: overrides?.resolver,
    });
  } catch (error) {
    throw new WorkflowWorkerError(
      errorCode,
      `Remote media fetch failed: ${describeRemoteFetchError(error)}`,
    );
  }

  try {
    if (!response.ok || !response.body) {
      throw new WorkflowWorkerError(
        errorCode,
        `Remote media download failed with status ${response.status}`,
        workflowHttpFailureDisposition(response.status),
      );
    }

    try {
      assertResponseContentLength(response, maxBytes);
    } catch {
      throw new WorkflowWorkerError(
        errorCode,
        `Remote media declared size exceeds the ${maxBytes}-byte limit`,
        "permanent",
      );
    }

    await currentRenderAdapters().remoteMedia.pipeline(
      Readable.fromWeb(
        response.body as unknown as import("node:stream/web").ReadableStream,
      ),
      createByteLimitTransform(maxBytes),
      currentRenderAdapters().remoteMedia.createWriteStream(filePath),
    );
  } catch (error) {
    rethrowWorkflowAttemptLost(error);
    rethrowRenderCancellation(error);
    if (error instanceof WorkflowFailure) {
      throw error;
    }
    throw new WorkflowWorkerError(
      errorCode,
      `Remote media download failed: ${describeRemoteFetchError(error)}`,
      error instanceof RemoteFetchError &&
        error.code === "remote_response_too_large"
        ? "permanent"
        : "retryable",
    );
  } finally {
    if (response.body && !response.body.locked) {
      await response.body.cancel().catch(() => undefined);
    }
  }
}

function describeRemoteFetchError(error: unknown): string {
  if (error instanceof RemoteFetchError) return error.code;
  if (error instanceof UnsafeUrlError) return error.message;
  if (error instanceof Error) return error.message;
  return "unknown";
}

/**
 * Shared multi-output batch render (no B-roll, no other studio edits, no
 * split). Has no `split` param at all — split packet B forces every "split"
 * clip through the per-output `buildSingleVideoArgs`/`buildBrollVideoArgs`
 * path instead (see `framingForcesPerOutputRender` and its use in
 * the Clip Render Attempt's `hasStudioVideoEdits` gate), because
 * `buildSplitFilterChain`'s segment-concat graph replaces the base
 * composition entirely — something this function's shared crop-to-fill
 * `[0:v]split=N` fan-out has no concept of. Plain reframe (`output.reframe`,
 * "auto" mode) DOES still flow through here unchanged.
 */
export function buildMultiVideoArgs(params: {
  sourcePath: string;
  outputs: PendingRenderOutput[];
  startSec: number;
  endSec: number;
  probe: SourceProbe;
  srtPath: string | null;
  captionPreset?: CaptionPreset | null;
  logo?: LogoOverlay | null;
  composition?: ClipCompositionPlan | null;
  /** Run-level watermark entitlement (see `buildSingleVideoArgs`'s param
   *  doc) — uniform across every output in this shared-encode batch, unlike
   *  `resolution`, which each `PendingRenderOutput` carries individually
   *  (`outputs[i].resolution`) since different rows in the same batch can
   *  target different resolutions. */
  watermark?: boolean;
}) {
  const clipDurationSec = params.endSec - params.startSec;
  const splitOutputs = params.outputs
    .map((_, index) => `[v${index}]`)
    .join("");

  const baseSections = [
    `[0:v]split=${params.outputs.length}${splitOutputs}`,
    ...params.outputs.flatMap((output, index) => {
      const subtitlePath = output.subtitlePath ?? params.srtPath;
      const trailingChain = buildSubtitleFilter(
        output.aspectRatio,
        subtitlePath,
        params.captionPreset,
      );
      const baseLabel = params.logo ? `[outvbase${index}]` : `[outv${index}]`;
      if (params.composition) {
        return compileCompositionPlanVideo({
          plan: params.composition,
          targetId: output.clipRenderId,
          videoInputLabel: `[v${index}]`,
          outputLabel: baseLabel,
          trailingChain: trailingChain ?? undefined,
        }).filterParts;
      }
      const singleFilter = buildSingleVideoFilter(
        params.probe,
        output.aspectRatio,
        subtitlePath,
        params.captionPreset,
        output.reframe,
      );
      return [`[v${index}]${singleFilter}${baseLabel}`];
    }),
  ];

  const filterSections = [...baseSections];

  if (params.logo) {
    const logo = params.logo;
    const logoOpacity = Math.max(0.1, Math.min(1, logo.opacity / 100));
    const { x, y } = buildLogoOverlayPosition(logo.position);

    // Pre-process logo once (alpha-blend), then split into N branches and scale
    // each branch to that output's target video width.
    const logoSplitRefs = params.outputs
      .map((_, index) => `[logosrc${index}]`)
      .join("");
    filterSections.push(
      `[1:v]format=rgba,colorchannelmixer=aa=${logoOpacity.toFixed(3)},split=${params.outputs.length}${logoSplitRefs}`,
    );

    for (const [index, output] of params.outputs.entries()) {
      const aspectConfig = aspectRatioConfig.get(output.aspectRatio);
      if (!aspectConfig) {
        throw new WorkflowWorkerError(
          "unsupported_aspect_ratio",
          `Unsupported aspect ratio: ${output.aspectRatio}`,
          "permanent",
        );
      }
      const targetWidth = computeLogoTargetWidth(logo, aspectConfig.width);
      filterSections.push(
        `[logosrc${index}]scale=${targetWidth}:-1[logo${index}]`,
        `[outvbase${index}][logo${index}]overlay=${x}:${y}[outv${index}]`,
      );
    }
  }

  // Per-output final label, overridden below when that output's export
  // treatment (resolution downscale and/or watermark) needs to be folded in.
  const finalLabels = params.outputs.map((_, index) => `[outv${index}]`);

  for (const [index, output] of params.outputs.entries()) {
    const exportTreatment = buildExportTreatmentFilter(
      output.resolution,
      params.watermark,
    );
    if (exportTreatment) {
      filterSections.push(
        `${finalLabels[index]}${exportTreatment}[outvfree${index}]`,
      );
      finalLabels[index] = `[outvfree${index}]`;
    }
  }

  const args = [
    "-y",
    ...httpSourceInputArgs(params.sourcePath),
    "-ss",
    String(params.startSec),
    "-t",
    String(params.endSec - params.startSec),
    "-i",
    params.sourcePath,
  ];

  if (params.logo) {
    args.push("-i", params.logo.filePath);
  }

  if (params.probe.hasAudio) {
    const audioSplits = params.outputs.map((_, i) => `[aud${i}]`).join("");
    filterSections.push(
      `[0:a:0]asplit=${params.outputs.length}${audioSplits}`,
      ...params.outputs.map(
        (_, i) => `[aud${i}]${buildAudioFadeChain(clipDurationSec)}[outa${i}]`,
      ),
    );
  }

  args.push("-filter_complex", filterSections.join(";"));

  for (const [index, output] of params.outputs.entries()) {
    args.push("-map", finalLabels[index]!);

    if (params.probe.hasAudio) {
      args.push("-map", `[outa${index}]`, "-c:a", "aac", "-b:a", "128k");
    } else {
      args.push("-an");
    }

    // Explicit output-duration bound — see buildSingleVideoArgs.
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      x264Preset(),
      "-crf",
      x264Crf(),
      "-t",
      clipDurationSec.toFixed(3),
      "-movflags",
      "+faststart",
      "-max_muxing_queue_size",
      "1024",
      output.outputPath,
    );
  }

  return args;
}

/**
 * Renders an "audiogram" for audio-only sources (podcasts): an animated
 * waveform over a solid background with burned captions — instead of a black
 * screen. The waveform color follows the caption preset's highlight color.
 *
 * Ignores `studioEdits.framing` entirely (no `split`/`screen` param, no face
 * detection) — there is no video stream, so neither "split-screen 2-up" nor
 * "screen"'s top-fit/bottom-speaker layout has anything to seat a face or a
 * screen-share frame into. Split packet B and screen packet B don't change
 * this: an audio-only clip never reaches the split/screen detection blocks
 * in the Clip Render Attempt (`probe.hasVideo` gates both), so
 * `studioEdits.framing.mode === "split"` or `"screen"` on an audio-only clip
 * silently renders the same waveform panel as any other mode, exactly like
 * it already did before either feature existed.
 */
export function buildAudiogramArgs(params: {
  sourcePath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  aspectRatio: ClipAspectRatio;
  clipDurationSec: number;
  srtPath: string | null;
  captionPreset?: CaptionPreset | null;
  studioEdits?: StudioEdits | null;
  music?: MusicPlan | null;
  /** One-shot SFX placements — see `buildSingleVideoArgs`'s param doc. The
   *  audiogram path supports SFX the same way it already supports music
   *  (unlike `background`, which it deliberately ignores — see the
   *  divergence comment on the audio-only branch in the main render flow). */
  sfx?: SfxPlan[] | null;
  /** See `buildSingleVideoArgs`'s param docs — same contract here. */
  resolution?: ClipRenderResolution;
  watermark?: boolean;
  /** See `buildSingleVideoArgs` — same cut-concat contract, applied to the
   *  audio stream only (audiogram sources have no video track). Callers must
   *  pass `clipDurationSec` already set to the plan's edited duration when
   *  cut — this builder does not derive it itself. */
  cutPlan?: ClipCutPlan | null;
}) {
  const config = aspectRatioConfig.get(params.aspectRatio);

  if (!config) {
    throw new WorkflowWorkerError(
      "unsupported_aspect_ratio",
      `Unsupported aspect ratio: ${params.aspectRatio}`,
      "permanent",
    );
  }
  if (params.cutPlan?.isEmpty) {
    throw new WorkflowWorkerError(
      "clip_cut_plan_empty",
      "cutPlan has no renderable segments — caller must guard before building ffmpeg args",
      "permanent",
    );
  }

  const { width: W, height: H } = config;
  const bgColor = "0x0F172A";
  const waveColor = hexToFfmpegRgb(
    params.captionPreset?.highlightColor ?? "#00FF88",
  );
  const waveHeight = Math.round(H * 0.42);
  const subtitleFilter = buildSubtitleFilter(
    params.aspectRatio,
    params.srtPath,
    params.captionPreset,
  );

  const isCut = Boolean(params.cutPlan && !params.cutPlan.isUncut);
  const cutConcat = isCut
    ? buildCutConcatFilter({
        cutPlan: params.cutPlan!,
        clipStartSec: params.startSec,
        includeVideo: false,
        includeAudio: true,
        audioInputRef: "[0:a]",
      })
    : null;
  const audioInputLabel = cutConcat ? cutConcat.audioLabel! : "[0:a]";

  // Music and/or SFX (vizard-parity.md "Music/SFX library" — the audiogram
  // path follows whatever it already does for music, so SFX shares the same
  // gate) both mix into the OUTPUT track only, never the waveform — the
  // waveform always visualizes the raw dialogue signal.
  const hasMusicOrSfx = Boolean(params.music) || (params.sfx?.length ?? 0) > 0;

  const chain: string[] = cutConcat ? [...cutConcat.filterParts] : [];
  // With music/SFX AND a real cut, `audioInputLabel` is `[acat]` — a named
  // filter pad produced by the cut-concat `concat`/`acopy` stage above, not
  // a raw demuxed stream. Unlike `[0:a]` (which ffmpeg happily fans out to
  // multiple consumers), a named pad is a single link: feeding it into both
  // showwaves below AND buildAudioMixFilter's dialogueInputRef without an
  // explicit split silently rebinds the second consumer to the raw uncut
  // `[0:a]`, leaking deleted audio into the export (ffmpeg 8.0.1-reproduced).
  // Split explicitly, same as the no-music/no-sfx branch already does below.
  const dialogueAudioLabel = cutConcat ? "[dlgsrc]" : audioInputLabel;
  if (hasMusicOrSfx && cutConcat) {
    chain.push(`${audioInputLabel}asplit=2[wavesrc][dlgsrc]`);
  }
  const waveSourceLabel =
    hasMusicOrSfx && cutConcat ? "[wavesrc]" : audioInputLabel;
  chain.push(
    ...(hasMusicOrSfx
      ? [
          `color=c=${bgColor}:s=${W}x${H}:d=${params.clipDurationSec}[bg]`,
          `${waveSourceLabel}showwaves=s=${W}x${waveHeight}:mode=cline:colors=${waveColor}:rate=25[wave]`,
          `[bg][wave]overlay=0:(H-h)/2[comp]`,
        ]
      : [
          `color=c=${bgColor}:s=${W}x${H}:d=${params.clipDurationSec}[bg]`,
          // Split the audio so one branch drives the waveform and the other is
          // faded and mapped as the output track.
          `${audioInputLabel}asplit=2[wavesrc][fadesrc]`,
          `[wavesrc]showwaves=s=${W}x${waveHeight}:mode=cline:colors=${waveColor}:rate=25[wave]`,
          `[fadesrc]${buildDialogueAudioFilter(params.studioEdits?.sourceAudio, params.clipDurationSec)}[outa]`,
          `[bg][wave]overlay=0:(H-h)/2[comp]`,
        ]),
  );

  let finalLabel = "[comp]";
  if (params.studioEdits?.textLayers.length) {
    const textFilters = buildTextLayerFilters(
      params.studioEdits.textLayers,
      params.clipDurationSec,
    ).join(",");
    chain.push(`${finalLabel}${textFilters}[texted]`);
    finalLabel = "[texted]";
  }
  if (subtitleFilter) {
    chain.push(`${finalLabel}${subtitleFilter}[subbed]`);
    finalLabel = "[subbed]";
  }
  chain.push(`${finalLabel}format=yuv420p[outv]`);

  let videoOutputLabel = appendTransitionFilter(
    chain,
    "[outv]",
    "[outvtransition]",
    params.studioEdits,
    params.clipDurationSec,
  );

  const audiogramExportTreatment = buildExportTreatmentFilter(
    params.resolution,
    params.watermark,
  );
  if (audiogramExportTreatment) {
    chain.push(`${videoOutputLabel}${audiogramExportTreatment}[outvfree]`);
    videoOutputLabel = "[outvfree]";
  }

  const args = [
    "-y",
    ...httpSourceInputArgs(params.sourcePath),
    "-ss",
    String(params.startSec),
    "-t",
    String(params.endSec - params.startSec),
    "-i",
    params.sourcePath,
  ];

  // Music, then SFX — same order as buildSingleVideoArgs/buildBrollVideoArgs.
  // Input 0 is the (audio-only) source, so music (if present) is always 1.
  const musicInputIndex = 1;
  const sfxInputIndexes = (params.sfx ?? []).map(
    (_, i) => (params.music ? 2 : 1) + i,
  );

  if (params.music) {
    args.push("-stream_loop", "-1", "-i", params.music.path);
  }
  for (const sfx of params.sfx ?? []) {
    args.push("-i", sfx.path);
  }

  if (hasMusicOrSfx) {
    chain.push(
      buildAudioMixFilter({
        sourceHasAudio: true,
        clipDurationSec: params.clipDurationSec,
        sourceAudio: params.studioEdits?.sourceAudio,
        dialogueInputRef: dialogueAudioLabel,
        music: params.music
          ? { inputIndex: musicInputIndex, plan: params.music }
          : null,
        sfx: (params.sfx ?? []).map((plan, i) => ({
          inputIndex: sfxInputIndexes[i]!,
          plan,
        })),
      }),
    );
  }

  args.push(
    "-filter_complex",
    chain.join(";"),
    "-map",
    videoOutputLabel,
  );

  args.push("-map", "[outa]");

  // -shortest (existing) already bounds this to the shorter of video/audio;
  // -t is a belt-and-suspenders explicit bound (see buildSingleVideoArgs).
  args.push(
    "-shortest",
    "-t",
    params.clipDurationSec.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    x264Preset(),
    "-crf",
    x264Crf(),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "1024",
    params.outputPath,
  );

  return args;
}

const FREE_TIER_WATERMARK_TEXT = "Made with Narriflow";

/**
 * Escapes a literal string for use as a drawtext `text` value inside a
 * filtergraph. Two escaping levels apply (see ffmpeg-utils "Quoting and
 * escaping" + filter docs): first the option value (`\`, `'`, `:`, `%` for
 * drawtext expansion), then the filtergraph parser (`\`, `'`, `,`, `;`,
 * `[`, `]`). Verified against ffmpeg 8 — quoting the value instead breaks
 * on embedded `'`.
 */
export function escapeDrawtextText(text: string): string {
  const optionLevel = text.replace(/[\\':%]/g, (char) => `\\${char}`);
  return optionLevel.replace(/[\\',;[\]]/g, (char) => `\\${char}`);
}

/**
 * The 2/3 downscale fragment for a "720p" export (1080p-class output ->
 * 720p-class), keyed off the row's `resolution` (vizard-parity Phase C
 * export options) rather than a hardcoded free-tier assumption. "1080p"
 * renders at the base resolution for the aspect ratio — no scale filter.
 */
function buildResolutionScaleFilter(resolution: ClipRenderResolution): string {
  return resolution === "720p" ? "scale=trunc(iw*2/3/2)*2:trunc(ih*2/3/2)*2" : "";
}

/**
 * The corner "Made with Narriflow" drawtext fragment, independent of any
 * resolution scale. Gated by `hasFeature(ownerTier, "export.noWatermark")`
 * — never a resolution or raw tier check — so a paid user who picks 720p
 * still gets no watermark, and (in principle) a future tier could ship one
 * resolution behavior independent of the other.
 */
function buildWatermarkDrawtextFilter(
  watermarkText: string,
  fontFilePath?: string | null,
): string {
  const drawtextOptions = [
    `text=${escapeDrawtextText(watermarkText)}`,
    "fontcolor=white@0.85",
    "borderw=2",
    "bordercolor=black@0.6",
    "fontsize=h/28",
    "x=w-tw-h/40",
    "y=h/40",
  ];

  if (fontFilePath) {
    drawtextOptions.push(`fontfile=${fontFilePath}`);
  }

  return `drawtext=${drawtextOptions.join(":")}`;
}

/**
 * Combines the 720p downscale + watermark into one filter-chain fragment —
 * meant to be appended to the *end* of an already-built video filter chain
 * (after crop/scale/captions/logo/transition) so the whole render is a
 * single encode. This exact combination (both always on together) is what
 * `buildFreeTierPostProcessArgs` below still tests; the main render pipeline
 * no longer applies them as a fused pair (see `buildExportTreatmentFilter`),
 * since resolution and watermark are now independent, entitlement-driven
 * knobs (vizard-parity Phase C export options).
 */
function buildFreeTierWatermarkFilter(
  watermarkText: string,
  fontFilePath?: string | null,
): string {
  return [
    buildResolutionScaleFilter("720p"),
    buildWatermarkDrawtextFilter(watermarkText, fontFilePath),
  ].join(",");
}

/**
 * Per-output export treatment fragment: an optional 720p downscale (driven
 * by that row's resolution) followed by an optional watermark (driven by
 * the run's ownerTier entitlement) — the two Phase C knobs a render can
 * combine. Returns "" when neither applies, so callers can skip appending a
 * filter stage entirely (byte-identical to pre-Phase-C output for a paid,
 * 1080p, no-watermark render).
 */
function buildExportTreatmentFilter(
  resolution: ClipRenderResolution | undefined,
  watermark: boolean | undefined,
): string {
  const parts = [
    resolution ? buildResolutionScaleFilter(resolution) : "",
    watermark ? buildWatermarkDrawtextFilter(FREE_TIER_WATERMARK_TEXT) : "",
  ].filter(Boolean);
  return parts.join(",");
}

/**
 * Free-tier export treatment as a standalone single-input ffmpeg pass. No
 * longer used by the render pipeline itself (see `buildExportTreatmentFilter`
 * on each `build*Args` builder, which folds the same downscale/watermark
 * fragments into the main encode instead of re-encoding a second time) —
 * kept as a tested, reusable utility for the same transformation applied to
 * an already-rendered file.
 */
export function buildFreeTierPostProcessArgs(params: {
  inputPath: string;
  outputPath: string;
  watermarkText: string; // e.g. "Made with Narriflow"
  fontFilePath?: string | null;
}): string[] {
  const filter = buildFreeTierWatermarkFilter(
    params.watermarkText,
    params.fontFilePath,
  );

  return [
    "-y",
    "-i",
    params.inputPath,
    "-vf",
    filter,
    "-c:v",
    "libx264",
    "-preset",
    x264Preset(),
    "-crf",
    x264Crf(),
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "1024",
    params.outputPath,
  ];
}

/**
 * Bounded background task queue for overlapping R2 uploads with the next
 * clip's detection/encode (measured: upload is ~50-60% of per-clip wall time
 * on a residential uplink and is pure network wait while ffmpeg sits idle).
 *
 * Semantics callers rely on:
 *  - At most `limit` tasks run concurrently; excess tasks queue FIFO.
 *  - `schedule` never throws. Task rejection is recorded immediately, every
 *    later task still gets its turn, and `drain()` rethrows the first error
 *    only after the complete scheduled set has settled.
 *  - Attempt cancellation rejects queued tasks without starting them. Active
 *    tasks receive the same signal through their storage adapter.
 *  - `drain()` resolves only when every scheduled task (including ones
 *    scheduled after a previous drain) has settled. Idempotent; safe to call
 *    from both the success path and `finally`.
 */
function createBoundedTaskQueue(limit: number, signal?: AbortSignal): {
  schedule: (task: () => Promise<void>) => void;
  drain: () => Promise<void>;
  /** Number of tasks scheduled over the queue's lifetime (for logging). */
  scheduledCount: () => number;
} {
  const concurrency = Math.min(4, Math.max(1, Math.floor(limit)));
  let active = 0;
  let scheduled = 0;
  let settled = 0;
  let firstError: unknown = null;
  const waiting: Array<() => Promise<void>> = [];
  const inFlight = new Set<Promise<void>>();

  const cancellationReason = () =>
    signal?.reason instanceof Error
      ? signal.reason
      : new DOMException("Clip render cancelled", "AbortError");

  const recordError = (error: unknown) => {
    if (firstError === null) firstError = error;
  };

  signal?.addEventListener(
    "abort",
    () => {
      const rejectedCount = waiting.splice(0, waiting.length).length;
      settled += rejectedCount;
      if (rejectedCount > 0) recordError(cancellationReason());
    },
    { once: true },
  );

  const pump = () => {
    while (active < concurrency && waiting.length > 0) {
      const task = waiting.shift()!;
      active += 1;
      const p = Promise.resolve()
        .then(task)
        .catch(recordError)
        .finally(() => {
          active -= 1;
          settled += 1;
          inFlight.delete(p);
          pump();
        });
      inFlight.add(p);
    }
  };

  return {
    schedule: (task) => {
      scheduled += 1;
      if (signal?.aborted) {
        settled += 1;
        recordError(cancellationReason());
        return;
      }
      waiting.push(task);
      pump();
    },
    drain: async () => {
      // New tasks can be scheduled while draining (not expected today, but
      // cheap to be correct about): loop until truly quiet.
      while (inFlight.size > 0 || waiting.length > 0) {
        await Promise.all([...inFlight]);
      }
      if (settled !== scheduled) {
        throw new Error("Upload queue drained before every scheduled task settled");
      }
      if (firstError !== null) throw firstError;
    },
    scheduledCount: () => scheduled,
  };
}

/** Upload concurrency for the Clip Render Attempt's bounded queue —
 *  2 keeps one upload streaming while a burst finishes, without letting a
 *  slow uplink stack every clip's file into concurrent connections. */
function uploadConcurrency(): number {
  return currentRenderConfig().uploadConcurrency;
}

async function commitProvisionalRenderUpload<T>(input: {
  signal?: AbortSignal;
  complete: () => Promise<T>;
  discard: (
    reason: string,
  ) => Promise<"deleted" | "orphan_candidate">;
}): Promise<T> {
  try {
    input.signal?.throwIfAborted();
    return await input.complete();
  } catch (error) {
    const reason = input.signal?.aborted
      ? "attempt_cancelled_after_upload"
      : error instanceof WorkflowAttemptLost
        ? "ownership_lost"
        : "persistence_rejected";
    const cleanupResult = await input.discard(reason);
    if (input.signal?.aborted || error instanceof WorkflowAttemptLost) {
      throw error;
    }
    throw new RenderPersistenceFailure(error, cleanupResult);
  }
}

async function uploadRenderedOutput(params: {
  workflowRunId: string;
  projectId: string;
  output: PendingRenderOutput;
  clipDurationSec: number;
  /** Compact JSON-encoded Pexels attribution for any B-roll used in this
   *  render, so crediting is possible after the fact. There's no dedicated
   *  DB column reachable without a migration or editing clip.service.ts (out
   *  of scope here) — object storage metadata is the persistence mechanism
   *  this task owns end-to-end. See the B-roll upgrade report for the exact
   *  `Clip.brollAttribution Json?` follow-up if durable, per-clip-queryable
   *  attribution is wanted later. */
  brollCredits?: string | null;
  /** Wall-clock of the ffmpeg encode that produced this output. For the
   *  shared multi-output encode the same value is reported for every output
   *  it covered. */
  encodeMs?: number;
}): Promise<boolean> {
  const deleteProvisionalObject = async (reason: string) => {
    try {
      await currentRenderAdapters().storage.deleteObject(
        params.output.storageKey,
        {
        signal: renderStorageSignal(false),
        },
      );
      return "deleted" as const;
    } catch (error) {
      log("error", "clip_render_provisional_cleanup_failed", {
        workflowRunId: params.workflowRunId,
        attemptId: renderExecutionStorage.getStore()?.attempt.attemptId,
        projectId: params.projectId,
        clipId: params.output.clipId,
        clipRenderId: params.output.clipRenderId,
        phase: "cleanup",
        operation: "storage_delete",
        reason,
        objectKey: params.output.storageKey,
        objectKeyClass: params.output.storageKey.includes("/exports/")
          ? "export_attempt"
          : "ordinary_attempt",
        failureCode: "provisional_object_delete_failed",
        disposition: "orphan_candidate",
        cleanupResult: "orphan_candidate",
        errorCode: error instanceof Error ? error.name : "storage_delete_failed",
      });
      return "orphan_candidate" as const;
    }
  };
  if (params.output.resolution === "720p") {
    // The downscale (and any watermark) is folded directly into the main
    // render's filtergraph now (see `buildExportTreatmentFilter` on each
    // build*Args builder) — the single required encode already produced the
    // treated output, so a failure to apply it already failed the whole clip
    // render upstream (no separate pass to fail here). This just verifies the
    // output landed at the expected resolution; if the probe itself throws,
    // it propagates like any other failure in this function and fails the
    // variant (caught by the caller).
    const treatedProbe = await probeSource(params.output.outputPath);
    log("info", "resolution_export_treatment", {
      workflowRunId: params.workflowRunId,
      clipId: params.output.clipId,
      resolution: params.output.resolution,
      width: treatedProbe.width,
      height: treatedProbe.height,
    });
  }

  const outputStat = await currentRenderAdapters().workspace.stat(
    params.output.outputPath,
  );

  const uploadStartedAtMs = currentTimeMs();
  await currentRenderAdapters().storage.putFileFromPath({
    key: params.output.storageKey,
    filePath: params.output.outputPath,
    contentType: "video/mp4",
    metadata: {
      project_id: params.projectId,
      clip_id: params.output.clipId,
      workflow_run_id: params.workflowRunId,
      format: params.output.aspectRatio,
      ...(params.brollCredits ? { broll_credits: params.brollCredits } : {}),
    },
    signal: renderStorageSignal(),
  });
  const uploadMs = currentTimeMs() - uploadStartedAtMs;

  const { persisted } = await commitProvisionalRenderUpload({
    signal: currentRenderSignal(),
    complete: () =>
      currentRenderAdapters().clip.completeClipRenderVariant(
        params.output.clipRenderId,
        {
          storageKey: params.output.storageKey,
          sizeBytes: Number(outputStat.size),
          durationSec: params.clipDurationSec,
        },
      ),
    discard: deleteProvisionalObject,
  });

  if (!persisted) {
    // The ClipRender row this attempt was rendering for is gone — an editor
    // save/reset invalidated it (deleted the row) while this encode was in
    // flight. The storage key is attempt-unique (clipRenderAttemptStorageKey),
    // so this object can never be the one any other row points at; deleting
    // it is always safe and never touches another attempt's bytes.
    const cleanupResult = await deleteProvisionalObject("variant_superseded");
    log("info", "clip_render_variant_completion_stale_discarded", {
      workflowRunId: params.workflowRunId,
      clipId: params.output.clipId,
      clipRenderId: params.output.clipRenderId,
      aspectRatio: params.output.aspectRatio,
      phase: "persistence",
      operation: "complete_clip_render_variant",
      failureCode: "variant_superseded",
      disposition: "superseded",
      objectKeyClass: classifyRenderObjectKey(params.output.storageKey),
      cleanupResult,
    });
    return false;
  }

  log("info", "clip_render_variant_completed", {
    workflowRunId: params.workflowRunId,
    clipId: params.output.clipId,
    clipRenderId: params.output.clipRenderId,
    clipIndex: params.output.clipIndex,
    aspectRatio: params.output.aspectRatio,
    sizeBytes: Number(outputStat.size),
    uploadMs,
    ...(params.encodeMs !== undefined ? { encodeMs: params.encodeMs } : {}),
  });
  return true;
}

class ClipRenderAttemptDisabled extends Error {
  readonly code = "clip_render_attempt_disabled";

  constructor() {
    super("Clip Render Attempt cutover is disabled");
    this.name = "ClipRenderAttemptDisabled";
  }
}

export class ClipRenderAttempt {
  readonly #run: WorkflowRunJob;
  readonly #config: Readonly<RenderConfig>;
  readonly #lifecycle: ClipRenderAttemptLifecycle;
  readonly #adapters: ClipRenderAttemptAdapters;

  constructor(dependencies: ClipRenderAttemptDependencies) {
    this.#run = dependencies.run;
    this.#config = dependencies.config;
    this.#lifecycle = dependencies.lifecycle;
    this.#adapters = {
      ...productionClipRenderAttemptAdapters,
      ...dependencies.adapters,
      media:
        dependencies.adapters?.media ??
        (dependencies.adapters?.process
          ? new ProductionRenderMediaAdapter(dependencies.adapters.process)
          : productionRenderMediaAdapter),
      optionalAssets: {
        ...productionClipRenderAttemptAdapters.optionalAssets,
        ...dependencies.adapters?.optionalAssets,
      },
      analysis: {
        ...productionClipRenderAttemptAdapters.analysis,
        ...dependencies.adapters?.analysis,
      },
      clip: {
        ...productionClipRenderAttemptAdapters.clip,
        ...dependencies.adapters?.clip,
      },
      storage: {
        ...productionClipRenderAttemptAdapters.storage,
        ...dependencies.adapters?.storage,
      },
      workspace: {
        ...productionClipRenderAttemptAdapters.workspace,
        ...dependencies.adapters?.workspace,
      },
      clock: {
        ...productionClipRenderAttemptAdapters.clock,
        ...dependencies.adapters?.clock,
      },
    };
  }

  async execute(input: {
    attempt: ClipRenderingWorkflowAttempt;
    signal: AbortSignal;
  }): Promise<RenderWorkSetOutcome> {
    if (!this.#config.clipRenderAttemptEnabled) {
      throw new ClipRenderAttemptDisabled();
    }
    if (
      input.attempt.workflowRunId !== this.#run.id ||
      input.attempt.projectId !== this.#run.projectId
    ) {
      throw new WorkflowAttemptLost(input.attempt);
    }
    const ownershipController = new AbortController();
    const signal = AbortSignal.any([
      input.signal,
      ownershipController.signal,
    ]);
    return renderExecutionStorage.run(
      {
        config: this.#config,
        signal,
        attempt: input.attempt,
        adapters: this.#adapters,
      },
      async () => {
        const attemptStartedAtMs = currentTimeMs();
        try {
          signal.throwIfAborted();
          const workSet = await this.#lifecycle.beginRenderWorkSet(input.attempt);
          signal.throwIfAborted();
          const outcome =
            workSet.variantIds.length === 0
              ? await this.#lifecycle.settleRenderWorkSet(input.attempt)
              : await executeClipRenderAttempt(
                  this.#run,
                  signal,
                  input.attempt,
                  this.#lifecycle,
                  workSet.variantIds,
                  (error) => ownershipController.abort(error),
                );
          log("info", "clip_render_attempt_settled", {
            phase: "settlement",
            operation: "settle_render_work_set",
            disposition: outcome.status,
            retryState:
              outcome.status === "requeued" ? "retry_scheduled" : "terminal",
            requested: outcome.requested,
            succeeded: outcome.succeeded,
            failed: outcome.failed,
            superseded: outcome.superseded,
            followUpWorkflowRunId: outcome.followUpWorkflowRunId,
            elapsedMs: currentTimeMs() - attemptStartedAtMs,
          });
          return outcome;
        } catch (error) {
          if (error instanceof WorkflowAttemptLost) {
            log("error", "clip_render_attempt_interrupted", {
              phase: "ownership",
              operation: "execute",
              failureCode: error.code,
              disposition: "control",
              retryState: "reaper_owned",
              elapsedMs: currentTimeMs() - attemptStartedAtMs,
            });
          }
          throw error;
        }
      },
    );
  }
}

async function executeClipRenderAttempt(
  run: WorkflowRunJob,
  signal: AbortSignal,
  attempt: ClipRenderingWorkflowAttempt,
  lifecycle: ClipRenderAttemptLifecycle,
  workSetVariantIds: readonly string[],
  abortAttempt: (error: WorkflowAttemptLost) => void,
): Promise<RenderWorkSetOutcome> {
  signal.throwIfAborted();
  const frozenState =
    await currentRenderAdapters().state.getFrozenRenderingStateForWorkSet(
      run.projectId,
      run.id,
    );
  signal.throwIfAborted();

  const pendingRenders = (frozenState?.pendingRenders ?? []).filter((render) =>
    workSetVariantIds.includes(render.id),
  );
  if (!frozenState || pendingRenders.length === 0) {
    return lifecycle.settleRenderWorkSet(attempt);
  }

  // Watermark presence is a run-level entitlement (vizard-parity Phase C
  // export options) — looked up once per run, same as before, but now
  // through the shared hasFeature helper instead of a bare tier check so
  // this is the only place billing.service's PLAN_FEATURES matrix needs to
  // be consulted for it. Resolution, by contrast, is per-row (see
  // `PendingRenderOutput.resolution`, already entitlement-clamped when the
  // row was created by clip.service's triggerClipRendering/
  // autoQueueDefaultRenders) — a single run can, in principle, cover rows at
  // different resolutions.
  const ownerTier = frozenState.ownerTier;
  const applyWatermark = !hasFeature(ownerTier, "export.noWatermark");

  const runStartedAtMs = currentTimeMs();
  log("info", "clip_rendering_run_started", {
    workflowRunId: run.id,
    projectId: run.projectId,
    ownerTier,
  });

  const tempDir = await currentRenderAdapters().workspace.mkdtemp(
    join(tmpdir(), "narriflow-render-"),
  );
  const touchedOptionalAssetClasses = new Set<OptionalAssetClass>();
  // Captured outside the try so `finally` can settle in-flight background
  // uploads before deleting tempDir (their source files live there).
  let uploadQueueRef: { drain: () => Promise<void> } | null = null;
  let settlementStarted = false;

  try {
    // `sourcePath` is what every ffmpeg builder receives as input: a presigned
    // URL in ranged mode (see RENDER_SOURCE_URL_TTL_SEC above), or the local
    // download in fallback/download mode. All builders seek with -ss before
    // -i, so both forms behave identically apart from what gets transferred.
    const { sourcePath, probe } = await resolveRequiredSource({
      sourceStorageKey: frozenState.sourceStorageKey,
      tempDir,
      attempt,
    });

    log("info", "clip_rendering_source_probed", {
      workflowRunId: run.id,
      width: probe.width,
      height: probe.height,
      hasVideo: probe.hasVideo,
      hasAudio: probe.hasAudio,
    });

    let brandLogo: LogoOverlay | null = null;
    let rawBrandSnapshot: unknown = null;
    if (frozenState.brandSnapshot.status === "available") {
      rawBrandSnapshot = frozenState.brandSnapshot.value;
    } else {
      diagnoseOptionalAssetFallback({
        assetClass: "logo",
        phase: "lookup",
        failureCode: "brand_snapshot_unavailable",
        context: { workflowRunId: run.id, projectId: run.projectId },
      });
    }
    if (rawBrandSnapshot) {
      try {
        const snapshot = brandTemplateSnapshotSchema.parse(rawBrandSnapshot);
        if (snapshot.logoStorageKey && probe.hasVideo) {
          touchedOptionalAssetClasses.add("logo");
          const logoExt = extname(snapshot.logoStorageKey) || ".png";
          const logoPath = join(tempDir, `brand-logo${logoExt}`);
          try {
            await currentRenderAdapters().storage.downloadObjectToFile({
              key: snapshot.logoStorageKey,
              filePath: logoPath,
              signal: renderStorageSignal(),
            });
            const decodable =
              await currentRenderAdapters().optionalAssets.validateOptionalMedia(
                logoPath,
                "image",
              );
            if (decodable) {
              brandLogo = {
                filePath: logoPath,
                position: snapshot.logoPosition,
                opacity: snapshot.logoOpacity,
                scalePct: snapshot.logoScalePct,
              };
            } else {
              diagnoseOptionalAssetFallback({
                assetClass: "logo",
                phase: "decode",
                failureCode: "brand_logo_invalid",
                context: { workflowRunId: run.id, projectId: run.projectId },
              });
            }
          } catch (error) {
            rethrowRenderControlFlow(error);
            diagnoseOptionalAssetFallback({
              assetClass: "logo",
              phase: "download",
              failureCode: "brand_logo_download_failed",
              context: {
                workflowRunId: run.id,
                projectId: run.projectId,
              },
            });
          }
        }
      } catch (error) {
        rethrowRenderControlFlow(error);
        diagnoseOptionalAssetFallback({
          assetClass: "logo",
          phase: "parse",
          failureCode: "brand_snapshot_invalid",
          context: { workflowRunId: run.id, projectId: run.projectId },
        });
      }
    }

    // A clip may now have several immutable export revisions queued at once.
    // Group by export (or by clip for the ordinary mutable latest-render row)
    // so aspect variants from different frozen snapshots can never be encoded
    // together.
    const rendersByClipId = new Map<string, typeof pendingRenders>();

    for (const render of pendingRenders) {
      const groupKey = render.exportVariant
        ? `export:${render.exportVariant.exportId}`
        : `latest:${render.clipId}`;
      const existing = rendersByClipId.get(groupKey) ?? [];
      existing.push(render);
      rendersByClipId.set(groupKey, existing);
    }

    const clipGroups = [...rendersByClipId.values()].sort(
      (left, right) => left[0]!.clip.index - right[0]!.clip.index,
    );

    await currentRenderAdapters().project.publishWorkflowProgress({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "clip_rendering",
      status: "running",
      progress: 10,
      errorCode: null,
    });

    let renderedVariantCount = 0;

    // Uploads run in a bounded background queue so the next clip's
    // detection/encode overlaps the previous clip's R2 upload (the dominant
    // per-clip wall-time cost on a slow uplink). Every task owns its own
    // error handling — an upload failure marks ITS variant failed and never
    // fails the run — and `renderedVariantCount` is only read after
    // `uploadQueue.drain()` below, so the all-failed check and run
    // completion always see the settled truth.
    const uploadQueue = createBoundedTaskQueue(uploadConcurrency(), signal);
    uploadQueueRef = uploadQueue;
    const scheduleUpload = (
      output: PendingRenderOutput,
      params: {
        clipDurationSec: number;
        brollCredits?: string | null;
        encodeMs: number;
      },
    ) => {
      uploadQueue.schedule(async () => {
        try {
          const persisted = await uploadRenderedOutput({
            workflowRunId: run.id,
            projectId: run.projectId,
            output,
            clipDurationSec: params.clipDurationSec,
            brollCredits: params.brollCredits,
            encodeMs: params.encodeMs,
          });
          if (persisted) renderedVariantCount += 1;
        } catch (error) {
          if (error instanceof WorkflowAttemptLost) {
            abortAttempt(error);
            return;
          }
          rethrowRenderCancellation(error);
          const errorCode =
            error instanceof WorkflowFailure
              ? error.code
              : "render_upload_failed";
          const disposition =
            error instanceof WorkflowFailure
              ? error.disposition
              : "retryable";
          await currentRenderAdapters()
            .clip
            .failClipRenderVariant(
              output.clipRenderId,
              errorCode,
              disposition,
            );
          const persistenceFailure =
            error instanceof RenderPersistenceFailure ? error : null;
          log("error", "clip_render_variant_failed", {
            workflowRunId: run.id,
            attemptId: attempt.attemptId,
            clipId: output.clipId,
            clipRenderId: output.clipRenderId,
            clipIndex: output.clipIndex,
            aspectRatio: output.aspectRatio,
            code: errorCode,
            failureCode: errorCode,
            disposition,
            phase: persistenceFailure ? "persistence" : "upload",
            operation: persistenceFailure
              ? "complete_clip_render_variant"
              : "storage_put",
            ...(persistenceFailure
              ? { cleanupResult: persistenceFailure.cleanupResult }
              : {}),
            message:
              error instanceof Error ? error.message : "Unknown render error",
          });
        }
      });
    };

    for (let clipGroupIndex = 0; clipGroupIndex < clipGroups.length; clipGroupIndex++) {
      signal?.throwIfAborted();
      const renderGroup = clipGroups[clipGroupIndex]!;
      // Export-bound rows carry a complete frozen rendering snapshot. The
      // cast is deliberate: the snapshot stores the exact Clip fields used by
      // this worker and omits unrelated DB metadata/relations.
      const clip = renderGroup[0]!.clipSnapshot
        ? (renderGroup[0]!.clipSnapshot as unknown as (typeof renderGroup)[number]["clip"])
        : renderGroup[0]!.clip;
      const rawUtterances = clip.transcriptSlice as unknown as TranscriptUtterance[];
      const effective = resolveRenderTimingForClip({
        llmModel: clip.llmModel,
        utterances: rawUtterances,
        startSec: clip.startSec,
        endSec: clip.endSec,
      });
      const clipStartSec = effective.startSec;
      const clipEndSec = effective.endSec;
      const utterances = effective.transcriptSlice;

      // Vizard-parity Phase B step 7: resilient parse, same pattern as
      // captionPreset/studioEdits below — a single malformed stored
      // deletedRanges JSON must not crash the whole render group.
      let deletedRanges: SourceRange[] = [];
      if (clip.deletedRanges) {
        const parsedRanges = deletedRangesSchema.safeParse(clip.deletedRanges);
        if (parsedRanges.success) {
          deletedRanges = parsedRanges.data;
        } else {
          log("error", "clip_deleted_ranges_parse_failed", {
            workflowRunId: run.id,
            clipId: clip.id,
            message: parsedRanges.error.issues[0]?.message ?? "invalid deletedRanges",
          });
        }
      }
      const cutPlan = buildClipCutPlan(deletedRanges, {
        startSec: clipStartSec,
        endSec: clipEndSec,
      });
      if (cutPlan.droppedSliverCount > 0) {
        log("info", "clip_cut_plan_slivers_dropped", {
          workflowRunId: run.id,
          clipId: clip.id,
          droppedSliverCount: cutPlan.droppedSliverCount,
        });
      }
      // Every downstream duration-dependent consumer (captions, text layers,
      // transitions, music, B-roll cutaway planning, the audiogram
      // waveform/background, and the final `-t` output bound) reads THIS
      // value — the edited (post-cut) duration when the clip has real cuts,
      // otherwise the exact original `effective.durationSec` (not
      // `cutPlan.editedDurationSec`, which is ms-rounded — keeping the raw
      // value for the untouched common case is what makes the no-deletions
      // render byte-identical to before this change).
      const clipDurationSec = cutPlan.isUncut
        ? effective.durationSec
        : cutPlan.editedDurationSec;
      // Time map used to retime caption cues (source-absolute word/utterance
      // times -> edited timeline). Null for the uncut common case so
      // generateSrtFromSlice/generateAssFromSlice take their original,
      // unmodified codepath.
      const captionTimeMap = cutPlan.isUncut ? null : cutPlan.map;

      // Resilient parse: a single malformed stored caption JSON must not crash
      // the whole render group — fall back to no preset (plain SRT) instead.
      let captionPreset: CaptionPreset | null = null;
      if (clip.captionPreset) {
        const parsedPreset = captionPresetSchema.nullable().safeParse(
          clip.captionPreset,
        );
        if (parsedPreset.success) {
          captionPreset = parsedPreset.data;
        } else {
          log("error", "clip_caption_preset_parse_failed", {
            workflowRunId: run.id,
            clipId: clip.id,
            message: parsedPreset.error.issues[0]?.message ?? "invalid preset",
          });
        }
      }

      let studioEdits: StudioEdits = studioEditsSchema.parse({});
      if (clip.studioEdits) {
        const parsedEdits = studioEditsSchema.safeParse(clip.studioEdits);
        if (parsedEdits.success) {
          studioEdits = parsedEdits.data;
        } else {
          log("error", "clip_studio_edits_parse_failed", {
            workflowRunId: run.id,
            clipId: clip.id,
            message: parsedEdits.error.issues[0]?.message ?? "invalid edits",
          });
        }
      }

      // Per-clip effective logo: this clip's studioEdits.logo override
      // merged over the project-wide brandLogo (frozen snapshot + already
      // -downloaded file). `null` whenever there's no logo asset at all, or
      // this clip's override disables it.
      const logo = resolveClipLogoOverlay(brandLogo, studioEdits.logo);

      // ASS is the authoritative path and is used whenever a preset is present
      // (it carries per-word highlight, box, glow, position and animation so the
      // export matches the studio preview). SRT is only a no-preset fallback.
      let srtPath: string | null = null;
      if (!captionPreset && utterances.length > 0) {
        const srtContent = generateSrtFromSlice(
          utterances,
          clipStartSec,
          undefined,
          captionTimeMap,
        );
        if (srtContent.length > 0) {
          srtPath = join(tempDir, `clip-${clip.id}.srt`);
          await currentRenderAdapters().workspace.writeFile(
            srtPath,
            srtContent,
            "utf-8",
          );
        }
      }

      const outputs: PendingRenderOutput[] = renderGroup.map((render) => {
        const aspectRatio = clipAspectRatioFromDb[
          clipAspectRatioDbSchema.parse(render.aspectRatio)
        ];
        const slug =
          clipAspectRatioOptions.find((option) => option.value === aspectRatio)
            ?.slug ?? "9x16";
        // Tolerant parse, same fallback as clip.service's
        // toClipRenderVariantSnapshot — a row written before this column
        // existed (or an unexpected value) degrades to the column's own DB
        // default rather than failing the whole clip.
        const resolution =
          clipRenderResolutionSchema.safeParse(render.resolution).data ??
          "1080p";

        return {
          clipRenderId: render.id,
          clipId: clip.id,
          clipIndex: clip.index,
          aspectRatio,
          outputPath: join(tempDir, `clip-${clip.id}-${render.id}-${slug}.mp4`),
          storageKey: render.exportVariant
            ? clipExportAttemptStorageKey({
                projectId: run.projectId,
                exportId: render.exportVariant.exportId,
                variantId: render.exportVariantId!,
                aspectRatioSlug: slug,
                attemptId: attempt.attemptId,
              })
            : clipRenderAttemptStorageKey(
                run.projectId,
                clip.id,
                slug,
                attempt.attemptId,
              ),
          resolution,
          watermark: render.exportVariant?.watermark ?? applyWatermark,
        };
      });

      // Claim the variants before every terminal branch. Lifecycle failure
      // settlement is fenced to rows owned by this render attempt; failing a
      // still-pending row is intentionally rejected as stale.
      await Promise.all(
        outputs.map((output) =>
          currentRenderAdapters().clip.markClipRenderVariantRendering(
            output.clipRenderId,
          ),
        ),
      );

      // Guard (vizard-parity Phase B step 7): deletedRanges covering the
      // whole clip window (or leaving only sub-50ms slivers) leaves nothing
      // renderable. Fail every variant in this group with a structured error
      // instead of ever attempting a zero/near-zero-duration encode, and
      // skip straight to the next clip group.
      if (cutPlan.isEmpty) {
        log("error", "clip_cut_plan_empty", {
          workflowRunId: run.id,
          clipId: clip.id,
          clipIndex: clip.index,
          deletedRangeCount: deletedRanges.length,
        });
        await Promise.all(
          outputs.map((output) =>
            currentRenderAdapters().clip.failClipRenderVariant(
              output.clipRenderId,
              "clip_cut_plan_empty",
              "permanent",
            ),
          ),
        );
        const progress =
          10 + Math.round(((clipGroupIndex + 1) / clipGroups.length) * 80);
        await currentRenderAdapters().project.publishWorkflowProgress({
          projectId: run.projectId,
          workflowRunId: run.id,
          stage: "clip_rendering",
          status: "running",
          progress,
          errorCode: null,
        });
        continue;
      }

      // Per-aspect-ratio ASS files carry the full styled, word-synced captions.
      // Generated whenever a caption preset is present (positions are resolution
      // dependent, so one file per output).
      if (captionPreset && utterances.length > 0) {
        for (const output of outputs) {
          const assContent = generateAssFromSlice(
            utterances,
            clipStartSec,
            output.aspectRatio,
            captionPreset,
            captionTimeMap,
          );
          if (assContent.length > 0) {
            const assPath = join(
              tempDir,
              `clip-${clip.id}-${output.aspectRatio.replace(":", "x")}.ass`,
            );
            await currentRenderAdapters().workspace.writeFile(
              assPath,
              assContent,
              "utf-8",
            );
            output.subtitlePath = assPath;
          }
        }
      }

      // Auto-reframe: for landscape sources cropped to a narrower ratio, detect
      // the speaker's face path once per clip and drive each portrait output's
      // crop x via sendcmd so the framing follows the speaker. Falls back to a
      // static center crop if python/opencv/model is unavailable or no face.
      const reframeEnabled = currentRenderConfig().autoReframeEnabled;
      const srcRatio =
        probe.hasVideo && probe.height > 0 ? probe.width / probe.height : 0;
      const reframeOutputs = outputs.filter((output) => {
        const cfg = aspectRatioConfig.get(output.aspectRatio);
        if (!cfg) return false;
        const targetRatio = cfg.width / cfg.height;
        return (
          srcRatio >= targetRatio &&
          Math.round(probe.height * targetRatio) < probe.width
        );
      });

      // Framing modes (vizard-parity Phase C-2 stage 1): only "auto" ever
      // consumes a detected face path — fit never crops, center wants a
      // static crop, and split/screen run their own detection through their
      // own gates below (see `shouldRunAutoReframeDetection`'s doc comment).
      //
      // The detection itself now runs BELOW the B-roll plan (layout-engine
      // wiring), not here: the segment-based layout plan replaces the whole
      // base composition (same reason split forces the per-output path), so
      // it must know whether B-roll cutaways won first — the same "b-roll
      // always wins the whole frame" v1 policy split and screen already
      // follow. A b-roll clip keeps the legacy single-face EMA reframe,
      // which `buildBrollVideoArgs` threads through per output.
      const autoFramingActive =
        reframeEnabled &&
        srcRatio > 1.05 &&
        reframeOutputs.length > 0 &&
        shouldRunAutoReframeDetection(studioEdits);

      // Stock B-roll: when a Pexels key is set, plan 2-4 recurring cutaways
      // (driven by the detection LLM's cues when present on the clip, else
      // the keyword-derived query spaced evenly across the clip) — a single
      // cutaway reads as accidental and is a known quality complaint about
      // competitors. Best-effort: any failure renders normally without
      // B-roll. The studio picker's explicit choice, when present, always
      // wins and stays a single cutaway — a user who hand-picked one asset
      // didn't ask to see it repeated.
      let brollPlan: BrollPlan | null = null;
      const brollEnabled =
        currentRenderConfig().pexelsConfigured &&
        currentRenderConfig().brollEnabled;
      const userBrollUrl = clip.brollUrl ?? null;
      if (
        (brollEnabled || userBrollUrl) &&
        probe.hasVideo &&
        clipDurationSec >= 12
      ) {
        let safeUserBrollUrl: string | null = null;
        if (userBrollUrl) {
          try {
            assertPublicHttpUrl(userBrollUrl);
            safeUserBrollUrl = userBrollUrl;
          } catch {
            diagnoseOptionalAssetFallback({
              assetClass: "broll",
              phase: "lookup",
              failureCode: "broll_url_rejected",
              context: { workflowRunId: run.id, clipId: clip.id },
            });
          }
        }

        if (safeUserBrollUrl) {
          touchedOptionalAssetClasses.add("broll");
          const brollPath = join(tempDir, `broll-${clip.id}-manual.mp4`);
          try {
            await currentRenderAdapters().optionalAssets.downloadUrlToFile(
              safeUserBrollUrl,
              brollPath,
              "broll_download_failed",
            );
            const decodable =
              await currentRenderAdapters().optionalAssets.validateOptionalMedia(
                brollPath,
                "video",
              );
            if (!decodable) {
              diagnoseOptionalAssetFallback({
                assetClass: "broll",
                phase: "decode",
                failureCode: "broll_media_invalid",
                context: { workflowRunId: run.id, clipId: clip.id },
              });
            } else {
              // A manual pick has no reported duration — probe the downloaded
              // file so the cutaway window (and therefore the B-roll input's
              // own -t trim in buildBrollVideoArgs) is sized against real
              // footage rather than a guess.
              const effectiveDurationSec =
                await currentRenderAdapters().optionalAssets.probeMediaDurationSec(
                  brollPath,
                );
              const window =
                effectiveDurationSec !== null
                  ? planBrollWindow(clipDurationSec, effectiveDurationSec)
                  : null;

              if (window) {
                brollPlan = {
                  cutaways: [{ path: brollPath, window }],
                  credits: [],
                };
                log("info", "clip_broll_selected", {
                  workflowRunId: run.id,
                  clipId: clip.id,
                  source: "studio_pick",
                  cutawayCount: 1,
                  brollDurationSec: effectiveDurationSec,
                });
              } else {
                diagnoseOptionalAssetFallback({
                  assetClass: "broll",
                  phase: "probe",
                  failureCode: "broll_media_unusable",
                  context: { workflowRunId: run.id, clipId: clip.id },
                });
              }
            }
          } catch (error) {
            rethrowRenderControlFlow(error);
            brollPlan = null;
            diagnoseOptionalAssetFallback({
              assetClass: "broll",
              phase: "download",
              failureCode: "broll_download_failed",
              context: {
                workflowRunId: run.id,
                clipId: clip.id,
                source: "studio_pick",
              },
            });
          }
        } else {
          // Auto path: consume LLM-provided cues when the clip carries them
          // (optional column — absent on existing rows and any clip not yet
          // produced by a detect-clips.ts that writes it), else fall back to
          // the keyword-derived query for every auto-placed slot.
          const rawBrollCues = (clip as { brollCues?: unknown }).brollCues;
          const brollCuesParsed = rawBrollCues
            ? brollCuesArraySchema.safeParse(rawBrollCues)
            : null;
          if (brollCuesParsed && !brollCuesParsed.success) {
            diagnoseOptionalAssetFallback({
              assetClass: "broll",
              phase: "parse",
              failureCode: "broll_cues_invalid",
              context: { workflowRunId: run.id, clipId: clip.id },
            });
          }
          const rawCues: BrollCueInput[] | null =
            brollCuesParsed?.success && brollCuesParsed.data.length > 0
              ? brollCuesParsed.data
              : null;
          // Fix #2: brollCues[].atSec are uncut clip-relative seconds, but
          // clipDurationSec/planBrollCutaways below operate on the edited
          // (post-cut) timeline once deletedRanges are in play — remap
          // through the same cutPlan.map every other cut-concat consumer
          // (captions, reframe) uses, dropping cues whose moment was cut.
          const remappedCues = remapBrollCuesForCutPlan(
            rawCues,
            cutPlan,
            clipStartSec,
          );
          const cues: BrollCueInput[] | null =
            remappedCues && remappedCues.length > 0 ? remappedCues : null;

          const category = clip.category as ClipCategory;
          const fallbackQuery = brollQueryForClip(
            clip.title,
            clip.hookText,
            category,
          );
          const broaderFallbackQuery =
            CATEGORY_BROLL_FALLBACK_QUERY[category] ?? null;

          if (cues || fallbackQuery) {
            const orientation = dominantPexelsOrientation(
              outputs.map((o) => o.aspectRatio),
            );
            const targetWidth = orientation === "landscape" ? 1920 : 1080;
            const targetHeight = orientation === "landscape" ? 1080 : 1920;

            try {
              const resolvedCutaways =
                await currentRenderAdapters().optionalAssets.resolveBrollCutaways({
                  clipDurationSec,
                  cues,
                  fallbackQuery,
                  broaderFallbackQuery,
                  orientation,
                  targetWidth,
                  targetHeight,
                });

              const cutaways: BrollCutaway[] = [];
              const credits: BrollPlan["credits"] = [];

              for (const [index, resolved] of resolvedCutaways.entries()) {
                try {
                  touchedOptionalAssetClasses.add("broll");
                  let brollPath =
                    await currentRenderAdapters().optionalAssets.getCachedBrollAssetPath(
                      resolved.downloadUrl,
                      currentRenderConfig().brollAssetCacheTtlMs,
                    );
                  let downloadedForCache = false;
                  if (!brollPath) {
                    const downloadedPath = join(
                      tempDir,
                      `broll-${clip.id}-${index}.mp4`,
                    );
                    await currentRenderAdapters().optionalAssets.downloadUrlToFile(
                      resolved.downloadUrl,
                      downloadedPath,
                      "broll_download_failed",
                    );
                    brollPath = downloadedPath;
                    downloadedForCache = true;
                  }
                  const decodable =
                    await currentRenderAdapters().optionalAssets.validateOptionalMedia(
                      brollPath,
                      "video",
                    );
                  if (!decodable) {
                    diagnoseOptionalAssetFallback({
                      assetClass: "broll",
                      phase: "decode",
                      failureCode: "broll_media_invalid",
                      context: {
                        workflowRunId: run.id,
                        clipId: clip.id,
                        query: resolved.query,
                      },
                    });
                    continue;
                  }
                  if (downloadedForCache) {
                    try {
                      await currentRenderAdapters().optionalAssets.saveBrollAssetToCache(
                        resolved.downloadUrl,
                        brollPath,
                      );
                    } catch (error) {
                      rethrowRenderControlFlow(error);
                      diagnoseOptionalAssetFallback({
                        assetClass: "broll",
                        phase: "cleanup",
                        failureCode: "broll_cache_write_failed",
                        context: {
                          workflowRunId: run.id,
                          clipId: clip.id,
                          query: resolved.query,
                        },
                      });
                    }
                  }
                  cutaways.push({
                    path: brollPath,
                    window: {
                      startSec: resolved.startSec,
                      endSec: resolved.endSec,
                    },
                  });
                  credits.push({
                    query: resolved.query,
                    startSec: resolved.startSec,
                    endSec: resolved.endSec,
                    authorName: resolved.attribution.authorName,
                    authorUrl: resolved.attribution.authorUrl,
                    pageUrl: resolved.attribution.pageUrl,
                  });
                } catch (error) {
                  rethrowRenderControlFlow(error);
                  diagnoseOptionalAssetFallback({
                    assetClass: "broll",
                    phase: "download",
                    failureCode: "broll_download_failed",
                    context: {
                      workflowRunId: run.id,
                      clipId: clip.id,
                      query: resolved.query,
                    },
                  });
                }
              }

              if (cutaways.length > 0) {
                brollPlan = { cutaways, credits };
                log("info", "clip_broll_selected", {
                  workflowRunId: run.id,
                  clipId: clip.id,
                  source: cues ? "cues" : "auto",
                  cutawayCount: cutaways.length,
                  credits,
                });
              }
            } catch (error) {
              rethrowRenderControlFlow(error);
              diagnoseOptionalAssetFallback({
                assetClass: "broll",
                phase: "lookup",
                failureCode: "broll_provider_unavailable",
                context: {
                  workflowRunId: run.id,
                  clipId: clip.id,
                  source: "auto",
                },
              });
            }
          }
        }
      }

      // Auto framing (layout-engine wiring, deferred from the gate above so
      // the B-roll decision is known). Two tiers:
      //   1. Layout engine (default, `WORKER_LAYOUT_ENGINE=0` reverts):
      //      multi-face detection + scene cuts + diarized words -> a
      //      segment-based plan (per-shot solo crops with vertical framing/
      //      zoom, stable two-up splits for multi-face shots) rendered
      //      through the same `split` machinery packet B landed. Falls back
      //      to tier 2 whenever the footage has no dynamic structure (the
      //      detection is unavailable. The exact plan is persisted and reused
      //      by the studio, making preview and export one contract.
      //   2. Legacy single-face EMA reframe (`applyAutoReframe`) only when
      //      analysis is disabled/unavailable.
      const layoutEngineEnabled = currentRenderConfig().layoutEngineEnabled;
      const compositionSourceIdentity = compositionAssetRef(
        "source",
        run.projectId,
      );
      const compositionDocument: EditorDocument = {
        clipStartSec: clip.startSec,
        clipEndSec: clip.endSec,
        captionPreset: captionPreset ?? captionPresetSchema.parse({}),
        transcriptSlice: utterances,
        studioEdits,
        brollUrl: clip.brollUrl ?? null,
        deletedRanges,
      };
      const persistedAutoLayout = parseClipAutoLayoutAnalysis(
        clip.autoLayoutAnalysis,
      );
      const persistedAutoLayoutEligible = Boolean(
        layoutEngineEnabled &&
          persistedAutoLayout &&
          persistedAutoLayout.engine === "shot-layout-v1" &&
          persistedAutoLayout.sourceIdentity === compositionSourceIdentity &&
          clipAutoLayoutMatchesInputs(persistedAutoLayout, {
            clipStartSec: clip.startSec,
            clipEndSec: clip.endSec,
            deletedRanges,
          }) &&
          Math.abs(persistedAutoLayout.editedDurationSec - clipDurationSec) <=
            0.075,
      );
      let autoLayoutSegmentsFull: SplitLayoutSegment[] | null = null;
      let autoLayoutSegmentsNoSplit: SplitLayoutSegment[] | null = null;
      let automaticLayoutAnalysisForPlan: ClipAutoLayoutAnalysis | null =
        persistedAutoLayoutEligible ? persistedAutoLayout : null;
      const automaticLayoutEvidenceFailure: "failed" | "disabled" =
        layoutEngineEnabled ? "failed" : "disabled";
      let automaticLayoutEvidenceSource:
        | "durable"
        | "analysis"
        | "failed"
        | "disabled" = persistedAutoLayoutEligible
        ? "durable"
        : automaticLayoutEvidenceFailure;
      const autoCompositionControl = currentRenderConfig().compositionAuto;
      const automaticEvidenceProbe =
        probe.hasVideo &&
        resolveEffectiveFramingMode(studioEdits) === "auto" &&
        !brollPlan &&
        autoCompositionControl !== "legacy"
          ? planClipComposition({
              document: compositionDocument,
              source: {
                identity: compositionSourceIdentity,
                kind: "video",
                width: probe.width,
                height: probe.height,
              },
              evidence: {
                automaticLayout: automaticLayoutAnalysisForPlan
                  ? {
                      state: "available",
                      value: {
                        sourceIdentity: compositionSourceIdentity,
                        inputFingerprint: automaticLayoutInputFingerprint({
                          sourceIdentity: compositionSourceIdentity,
                          clipStartSec: clip.startSec,
                          clipEndSec: clip.endSec,
                          deletedRanges,
                          engineVersion: "shot-layout-v1",
                        }),
                        engineVersion: "shot-layout-v1",
                        analysis: automaticLayoutAnalysisForPlan,
                      },
                    }
                  : {
                      state: layoutEngineEnabled ? "missing" : "disabled",
                    },
              },
              assets: { backgroundImage: { state: "missing" } },
              capabilities: {
                automaticSpeakerLayout: layoutEngineEnabled,
                automaticSpeakerEngineVersion: "shot-layout-v1",
              },
              targets: outputs.map((output) => {
                const target = aspectRatioConfig.get(output.aspectRatio)!;
                return {
                  id: output.clipRenderId,
                  aspectRatio: output.aspectRatio,
                  width: target.width,
                  height: target.height,
                };
              }),
            })
          : null;
      const automaticEvidenceRequested = Boolean(
        automaticEvidenceProbe &&
          automaticEvidenceProbe.status !== "invalid" &&
          automaticEvidenceProbe.plan.evidenceRequests.length > 0,
      );
      if (autoFramingActive || automaticEvidenceRequested) {
        let engineHandled = false;
        if (persistedAutoLayoutEligible && persistedAutoLayout) {
          autoLayoutSegmentsFull =
            persistedAutoLayout.segments.length > 0
              ? persistedAutoLayout.segments
              : null;
          autoLayoutSegmentsNoSplit =
            persistedAutoLayout.noSplitSegments.length > 0
              ? persistedAutoLayout.noSplitSegments
              : null;
          automaticLayoutAnalysisForPlan = persistedAutoLayout;
          engineHandled = true;
          log("info", "clip_layout_plan_reused", {
            workflowRunId: run.id,
            clipId: clip.id,
            ...mediaAnalysisDiagnostic({
              analysisMode: "layout_engine",
              selectedMode: "persisted_shot_layout",
            }),
            segmentCount: persistedAutoLayout.segments.length,
            twoUpSegmentCount: persistedAutoLayout.twoUpSegmentCount,
            analyzedAtISO: persistedAutoLayout.analyzedAtISO,
          });
        }

        // Detection deliberately scans the full uncut clip. It only runs on
        // a persisted-plan miss; the normal render path is now a cheap read.
        const detectInput = !engineHandled
          ? await currentRenderAdapters().analysis.extractFaceDetectionSegment({
              sourcePath,
              tempDir,
              clipId: clip.id,
              workflowRunId: run.id,
              clipStartSec,
              durationSec: effective.durationSec,
            })
          : null;

        if (!engineHandled && layoutEngineEnabled && detectInput) {
          const [multiDetection, sceneCuts] = await Promise.all([
            currentRenderAdapters().analysis.detectMultiFacePath({
              sourcePath: detectInput.path,
              startSec: detectInput.startSec,
              durationSec: effective.durationSec,
            }),
            currentRenderAdapters().analysis.detectSceneCuts({
              sourcePath: detectInput.path,
              startSec: detectInput.startSec,
              durationSec: effective.durationSec,
              workflowRunId: run.id,
              clipId: clip.id,
            }),
          ]);

          if (multiDetection) {
            const remappedSamples = remapMultiFaceSamplesForCutPlan(
              multiDetection.samples,
              cutPlan,
              clipStartSec,
            );
            const remappedCuts = remapSceneCutsForCutPlan(
              sceneCuts,
              cutPlan,
              clipStartSec,
            );
            const words = speechWordsFromUtterances(
              utterances,
              cutPlan,
              clipStartSec,
              clipEndSec,
            );
            const planBase = {
              samples: remappedSamples,
              sceneCuts: remappedCuts,
              words,
              durationSec: clipDurationSec,
              // Resolution-aware zoom ceiling (adversarial review M4): the
              // 9:16 base crop of a 16:9 source is already a ~1.78x
              // upscale, so zoom multiplies it — a 1080p source at zoom
              // 1.4 lands at ~2.5x and visibly softens. Spend zoom budget
              // only where the pixels exist.
              options: {
                frameOptions: {
                  maxZoom:
                    probe.height >= 1440 ? 1.4 : probe.height >= 1080 ? 1.25 : 1.1,
                },
                activeSpeakerCuts: false,
              },
            };
            const fullPlan = buildAutoLayoutPlan({ ...planBase, allowTwoUp: true });
            const noSplitPlan = buildAutoLayoutPlan({
              ...planBase,
              allowTwoUp: false,
            });

            const envelope: ClipAutoLayoutAnalysis =
              clipAutoLayoutAnalysisSchema.parse({
                version: 1,
                engine: "shot-layout-v1",
                sourceIdentity: compositionSourceIdentity,
                analyzedAtISO: new Date(currentTimeMs()).toISOString(),
                clipStartSec: clip.startSec,
                clipEndSec: clip.endSec,
                deletedRanges,
                editedDurationSec: clipDurationSec,
                sourceWidth: probe.width,
                sourceHeight: probe.height,
                segments: fullPlan.segments,
                noSplitSegments: noSplitPlan.segments,
                shotCount: fullPlan.shotCount,
                soloShotCount: fullPlan.soloShotCount,
                multiShotCount: fullPlan.multiShotCount,
                twoUpSegmentCount: fullPlan.twoUpSegmentCount,
                speakerCount: fullPlan.speakerCount,
                mappedSpeakerCount: fullPlan.mappedSpeakerCount,
              });
            automaticLayoutAnalysisForPlan = envelope;
            automaticLayoutEvidenceSource = "analysis";
            if (clip.previewStorageKey) {
              await currentRenderAdapters()
                .clip
                .completeClipAutoLayoutAnalysis(clip.id, envelope, {
                  editorRevision: clip.editorRevision,
                  previewStorageKey: clip.previewStorageKey,
                  replaceExisting: Boolean(
                    persistedAutoLayout && !persistedAutoLayoutEligible,
                  ),
                })
                .catch((error) => {
                  rethrowRenderControlFlow(error);
                  log("error", "clip_auto_layout_analysis_persist_failed", {
                    workflowRunId: run.id,
                    clipId: clip.id,
                    ...mediaAnalysisDiagnostic({
                      analysisMode: "layout_engine",
                      fallbackMode: "render_without_persisted_analysis",
                      failureCode: "analysis_persist_failed",
                    }),
                  });
                });
            }

            if (fullPlan.segments.length > 0) {
              if (autoFramingActive) {
                autoLayoutSegmentsFull = fullPlan.segments;
              }
              // Outputs whose aspect ratio can't seat two distinct tiles
              // (H1's same geometry gate split uses) get a two-up-free
              // variant of the SAME plan instead of a whole-clip fallback.
              const anyIneligible = autoFramingActive && outputs.some(
                (output) =>
                  reframeOutputs.includes(output) &&
                  !splitTilesAreDistinct(output.aspectRatio, probe),
              );
              if (anyIneligible) {
                autoLayoutSegmentsNoSplit =
                  noSplitPlan.segments.length > 0 ? noSplitPlan.segments : null;
                if (!autoLayoutSegmentsNoSplit) {
                  // Rare: the demoted plan collapsed to nothing — those
                  // outputs fall back to the legacy EMA reframe instead.
                  await applyAutoReframe({
                    samples: deriveSingleFaceSamplesFromMulti(
                      multiDetection.samples,
                    ),
                    cutPlan,
                    clipStartSec,
                    probe,
                    outputs,
                    reframeOutputs: outputs.filter(
                      (output) =>
                        reframeOutputs.includes(output) &&
                        !splitTilesAreDistinct(output.aspectRatio, probe),
                    ),
                    tempDir,
                    clipId: clip.id,
                    workflowRunId: run.id,
                  });
                }
              }
              engineHandled = true;
              log("info", "clip_layout_plan_applied", {
                workflowRunId: run.id,
                clipId: clip.id,
                ...mediaAnalysisDiagnostic({
                  analysisMode: "layout_engine",
                  selectedMode: "shot_layout",
                }),
                segmentCount: fullPlan.segments.length,
                twoUpSegmentCount: fullPlan.twoUpSegmentCount,
                shotCount: fullPlan.shotCount,
                soloShotCount: fullPlan.soloShotCount,
                multiShotCount: fullPlan.multiShotCount,
                speakerCount: fullPlan.speakerCount,
                mappedSpeakerCount: fullPlan.mappedSpeakerCount,
                sceneCutCount: remappedCuts.length,
              });
            } else {
              // Detection completed but found no trustworthy face structure.
              // Treat that as a conclusive centered-layout analysis instead
              // of paying for a second detector pass on every render.
              log("info", "clip_layout_plan_fallback", {
                workflowRunId: run.id,
                clipId: clip.id,
                ...mediaAnalysisDiagnostic({
                  analysisMode: "layout_engine",
                  fallbackMode: "center_crop",
                  failureCode: "no_trustworthy_faces",
                }),
                reason: "no_trustworthy_faces",
                shotCount: fullPlan.shotCount,
                soloShotCount: fullPlan.soloShotCount,
                multiShotCount: fullPlan.multiShotCount,
                speakerCount: fullPlan.speakerCount,
              });
              engineHandled = true;
            }
          } else {
            log("info", "clip_layout_plan_fallback", {
              workflowRunId: run.id,
              clipId: clip.id,
              ...mediaAnalysisDiagnostic({
                analysisMode: "layout_engine",
                fallbackMode: "legacy_auto_reframe",
                failureCode: "analysis_unavailable",
              }),
              reason: "detection_unavailable",
            });
          }
        }

        if (!engineHandled && autoFramingActive) {
          // Legacy tier: single-face EMA reframe (engine disabled,
          // extraction failed, or detection unavailable — the last
          // still calls applyAutoReframe so the skip reason is logged and
          // the static-center fallback stays explicit).
          const detection = detectInput
            ? await currentRenderAdapters().analysis.detectFacePath({
                sourcePath: detectInput.path,
                startSec: detectInput.startSec,
                durationSec: effective.durationSec,
                logContext: { workflowRunId: run.id, clipId: clip.id },
              })
            : null;
          await applyAutoReframe({
            samples: detection?.samples ?? null,
            cutPlan,
            clipStartSec,
            probe,
            outputs,
            reframeOutputs,
            tempDir,
            clipId: clip.id,
            workflowRunId: run.id,
          });
        }
      }

      let splitLayoutEvidenceForPlan: CompositionEvidenceAvailability<
        SplitLayoutEvidence,
        SplitLayoutFailureReason
      > = {
        state: "missing",
      };
      let screenLayoutEvidenceForPlan: CompositionEvidenceAvailability<
        ScreenLayoutEvidence,
        ScreenLayoutFailureReason
      > = {
        state: "missing",
      };

      // Screen packet B ("screen" framing mode, the worker render path): when
      // the clip's effective framing mode is "screen", run single-face
      // detection (NOT `detectMultiFacePath` — screen mode only ever needs
      // the dominant/single face for the bottom tile, unlike split's
      // cluster-seat detection) and set every output's `screenBottom` spec
      // (`applyScreenSpeakerLayout`, mirroring `applyAutoReframe`).
      // Evaluated AFTER the B-roll plan above for the same reason split is:
      // the v1 B-roll conflict policy needs to know whether this clip
      // already has cutaways before deciding whether to build a screen
      // layout at all (`decideScreenFallback`'s "broll_conflict" reason).
      const screenLayoutEnabled = currentRenderConfig().screenLayoutEnabled;
      const isScreenMode =
        resolveEffectiveFramingMode(studioEdits) === "screen" && probe.hasVideo;
      if (isScreenMode) {
        if (!screenLayoutEnabled) {
          screenLayoutEvidenceForPlan = { state: "disabled" };
          // Kill switch (mirrors split's `disabled` reason): fully reverts
          // routing — `framingForcesPerOutputRender` also returns false for
          // "screen" when this is set, so the clip renders through the exact
          // same shared/batch path "auto"/"center" use, falling back to
          // plain whole-frame single-face auto-reframe (never a static
          // screen layout, never a failed render) exactly like split's own
          // `disabled` branch does below.
          log("info", "clip_screen_fallback", {
            workflowRunId: run.id,
            clipId: clip.id,
            ...mediaAnalysisDiagnostic({
              analysisMode: "screen_layout",
              fallbackMode: "auto_reframe",
              failureCode: "analysis_disabled",
            }),
            reason: "disabled",
          });
          if (reframeEnabled && srcRatio > 1.05 && reframeOutputs.length > 0) {
            const detectInput =
              await currentRenderAdapters().analysis.extractFaceDetectionSegment({
              sourcePath,
              tempDir,
              clipId: clip.id,
              workflowRunId: run.id,
              clipStartSec,
              durationSec: effective.durationSec,
              suffix: "-screenfallback",
            });
            const detection = detectInput
              ? await currentRenderAdapters().analysis.detectFacePath({
                  sourcePath: detectInput.path,
                  startSec: detectInput.startSec,
                  durationSec: effective.durationSec,
                  logContext: { workflowRunId: run.id, clipId: clip.id },
                })
              : null;
            await applyAutoReframe({
              samples: detection?.samples ?? null,
              cutPlan,
              clipStartSec,
              probe,
              outputs,
              reframeOutputs,
              tempDir,
              clipId: clip.id,
              workflowRunId: run.id,
            });
          }
        } else {
          const screenFallbackReason = decideScreenFallback({
            hasBrollPlan: Boolean(brollPlan),
          });

          if (screenFallbackReason) {
            screenLayoutEvidenceForPlan = {
              state: "failed",
              reason: screenFallbackReason,
            };
            log("info", "clip_screen_fallback", {
              workflowRunId: run.id,
              clipId: clip.id,
              ...mediaAnalysisDiagnostic({
                analysisMode: "screen_layout",
                fallbackMode: "auto_reframe",
                failureCode: screenFallbackReason,
              }),
              reason: screenFallbackReason,
            });
            // B-roll conflict: fall back to whole-frame single-speaker
            // auto-reframe framing exactly like split's own broll_conflict
            // branch — forced here since `shouldRunAutoReframeDetection`
            // deliberately excludes "screen".
            if (reframeEnabled && srcRatio > 1.05 && reframeOutputs.length > 0) {
              const detectInput =
                await currentRenderAdapters().analysis.extractFaceDetectionSegment({
                sourcePath,
                tempDir,
                clipId: clip.id,
                workflowRunId: run.id,
                clipStartSec,
                durationSec: effective.durationSec,
                suffix: "-screenfallback",
              });
              const detection = detectInput
                ? await currentRenderAdapters().analysis.detectFacePath({
                    sourcePath: detectInput.path,
                    startSec: detectInput.startSec,
                    durationSec: effective.durationSec,
                    logContext: { workflowRunId: run.id, clipId: clip.id },
                  })
                : null;
              await applyAutoReframe({
                samples: detection?.samples ?? null,
                cutPlan,
                clipStartSec,
                probe,
                outputs,
                reframeOutputs,
                tempDir,
                clipId: clip.id,
                workflowRunId: run.id,
              });
            }
          } else {
            const screenEngineVersion = "screen-layout-v1";
            const pipDetectEnabled = currentRenderConfig().pipDetectEnabled;
            const screenFingerprint = screenLayoutInputFingerprint({
              sourceIdentity: compositionSourceIdentity,
              clipStartSec: clip.startSec,
              clipEndSec: clip.endSec,
              deletedRanges,
              engineVersion: screenEngineVersion,
            });
            const persistedAnalysisRaw = pipDetectEnabled
              ? parseClipLayoutAnalysis(clip.layoutAnalysis)
              : null;
            const persistedAnalysis =
              persistedAnalysisRaw !== null &&
              layoutAnalysisMatchesWindow(
                persistedAnalysisRaw,
                clipStartSec,
                effective.durationSec,
              ) &&
              (persistedAnalysisRaw.version === 1 ||
                (persistedAnalysisRaw.engine === screenEngineVersion &&
                  persistedAnalysisRaw.sourceIdentity ===
                    compositionSourceIdentity &&
                  persistedAnalysisRaw.inputFingerprint === screenFingerprint))
                ? persistedAnalysisRaw
                : null;
            const reuseExactScreenPlan =
              persistedAnalysis?.version === 2 &&
              currentRenderConfig().compositionScreen === "plan";
            // Real screen layout: element segmentation v1 (vizard-parity.md's
            // element-segmentation spike) tries the actual facecam PiP
            // rectangle FIRST — only when the source is screencast-like
            // (`classifyScreencast`), a corner-adjacent, compact motion blob
            // was actually found (`selectPipRect`), AND H2 (adversarial
            // review) a face is confirmed to actually sit inside it
            // (`confirmsFaceInRect`) does this win; every other case (a
            // genuine talking-head source — motion segmentation's own
            // measured false positive is a hand gesture near the frame edge
            // reading as a corner-adjacent compact blob — a frozen/still
            // facecam that motion segmentation can't see, no python/opencv/
            // numpy) falls straight through to the pre-existing whole-frame
            // single-face detection below, byte-identical to before this
            // packet. Both detectors share the SAME extracted segment
            // (`detectInput`) — no reason to extract it twice.
            const detectInput = reuseExactScreenPlan
              ? null
              : await currentRenderAdapters().analysis.extractFaceDetectionSegment({
              sourcePath,
              tempDir,
              clipId: clip.id,
              workflowRunId: run.id,
              clipStartSec,
              durationSec: effective.durationSec,
              suffix: "-screen",
            });

            // PiP persistence packet B (read-before-detect): a persisted
            // `Clip.layoutAnalysis` envelope whose detection window still
            // matches THIS render's `clipStartSec`/`effective.durationSec`
            // (`layoutAnalysisMatchesWindow`) means `pip_detect.py` already
            // ran for this exact source range — reuse its
            // movingPxFrac/insufficientSamples/pipRect instead of paying for
            // the script again. Gated on `pipDetectEnabled` too: the
            // `WORKER_PIP_DETECT=0` kill switch must mean "no persistence
            // side effects at all," not just "no fresh detection." A window
            // mismatch (most commonly a trim moving `clipStartSec`/
            // `endSec`) is the envelope's own invalidation — see that
            // function's doc comment — so the stale value is simply never
            // read here, not explicitly deleted.
            // M2 (adversarial review): the read-before-detect/write-after-
            // detect decision itself lives in `resolvePipAnalysis` (a
            // dependency-injected, unit-tested pure function) — this block
            // just wires it to the real `detectPipPath`/
            // `clipService.setClipLayoutAnalysis`. `resolvePipAnalysis` only
            // persists the CONCLUSIVE-negative case (a fresh detection with
            // no qualifying candidate); the non-null-`selectedRect` case is
            // persisted below, AFTER `decidePipUsage` — see C1/that
            // function's own doc comment for why.
            const resolvedPip = reuseExactScreenPlan
              ? {
                  detectionResult: {
                    movingPxFrac: persistedAnalysis.movingPxFrac,
                    insufficientSamples: persistedAnalysis.insufficientSamples,
                    candidates: [],
                  },
                  selectedRect: persistedAnalysis.pipRect,
                  candidateCount: persistedAnalysis.pipRect ? 1 : 0,
                  analysisSource: "persisted" as const,
                }
              : await resolvePipAnalysis({
                  persisted: persistedAnalysis,
                  pipDetectEnabled,
                  detectInput,
                  startSec: clipStartSec,
                  durationSec: effective.durationSec,
                  rawClipStartSec: clip.startSec,
                  rawClipEndSec: clip.endSec,
                  detect: currentRenderAdapters().analysis.detectPipPath,
                  persist: (envelope) =>
                    currentRenderAdapters().clip.setClipLayoutAnalysis(
                      clip.id,
                      envelope,
                    ),
                  logContext: { workflowRunId: run.id, clipId: clip.id },
                });
            const {
              detectionResult,
              selectedRect,
              candidateCount,
              analysisSource,
            } = resolvedPip;

            // Face detection runs on the same segment both to confirm a new
            // PiP candidate and to support the whole-frame speaker fallback.
            // An exact v2 plan already contains both decisions, so reusing it
            // deliberately skips this pass and cannot downgrade durable
            // evidence after a transient detector failure.
            const detection = detectInput
              ? await currentRenderAdapters().analysis.detectFacePath({
                  sourcePath: detectInput.path,
                  startSec: detectInput.startSec,
                  durationSec: effective.durationSec,
                  logContext: { workflowRunId: run.id, clipId: clip.id },
                })
              : null;
            const faceConfirmed = confirmsFaceInRect(detection?.samples ?? null, selectedRect);

            const pipUsageBase: DecidePipUsageParams = {
              pipDetectEnabled,
              segmentExtracted: reuseExactScreenPlan || Boolean(detectInput),
              detection: detectionResult,
              selectedRect,
              faceConfirmed: reuseExactScreenPlan
                ? persistedAnalysis.pipUsable
                : faceConfirmed,
              screencastThreshold: currentRenderConfig().pipMotionThreshold,
            };
            // Clip-level check only (no `fit` — that's per-output, decided
            // again inside `applyScreenSpeakerLayout`'s loop): every gate
            // except M3's `pip_too_small` is decided once here, since none
            // of them depend on a specific output's tile geometry.
            const clipLevelPipDecision = reuseExactScreenPlan
              ? {
                  useRect: persistedAnalysis.pipUsable,
                  reason: persistedAnalysis.pipUsable
                    ? ("ok" as const)
                    : ("no_candidate" as const),
                }
              : decidePipUsage(pipUsageBase);
            const pipRect = clipLevelPipDecision.useRect ? selectedRect : null;

            if (pipRect) {
              log("info", "clip_screen_pip_selected", {
                workflowRunId: run.id,
                clipId: clip.id,
                ...mediaAnalysisDiagnostic({
                  analysisMode: "picture_in_picture",
                  selectedMode: "pip_crop",
                }),
                movingPxFrac: detectionResult?.movingPxFrac ?? null,
                rect: pipRect,
                analysisSource,
              });
            } else {
              log("info", "clip_screen_pip_fallback", {
                workflowRunId: run.id,
                clipId: clip.id,
                ...mediaAnalysisDiagnostic({
                  analysisMode: "picture_in_picture",
                  fallbackMode: "speaker_band",
                  failureCode: clipLevelPipDecision.reason,
                }),
                reason: clipLevelPipDecision.reason,
                movingPxFrac: detectionResult?.movingPxFrac ?? null,
                candidateCount,
                analysisSource,
              });
            }

            const appliedTracking = await applyScreenSpeakerLayout({
              samples: detection?.samples ?? null,
              pipRect,
              pipUsageBase,
              cutPlan,
              clipStartSec,
              probe,
              outputs,
              tempDir,
              clipId: clip.id,
              workflowRunId: run.id,
            });
            const faceBandSegments = reuseExactScreenPlan
              ? persistedAnalysis.faceBandSegments
              : faceBandSegmentsForCompositionPlan({
                  samples: detection?.samples ?? null,
                  cutPlan,
                  clipStartSec,
                  editedDurationSec: clipDurationSec,
                });
            const screenAnalysisConclusive = Boolean(
              detectionResult && detection,
            );
            if (
              pipDetectEnabled &&
              persistedAnalysis?.version !== 2 &&
              screenAnalysisConclusive
            ) {
              const screenEnvelope = clipLayoutAnalysisV2Schema.parse({
                version: 2,
                engine: screenEngineVersion,
                sourceIdentity: compositionSourceIdentity,
                inputFingerprint: screenFingerprint,
                analyzedAtISO: new Date(currentTimeMs()).toISOString(),
                sourceStartSec: clipStartSec,
                sourceDurationSec: effective.durationSec,
                clipStartSec: clip.startSec,
                clipEndSec: clip.endSec,
                movingPxFrac: detectionResult?.movingPxFrac ?? null,
                insufficientSamples:
                  detectionResult?.insufficientSamples ?? false,
                pipRect: selectedRect,
                pipUsable: clipLevelPipDecision.useRect,
                sourceWidth: probe.width,
                sourceHeight: probe.height,
                deletedRanges,
                faceBandSegments,
              });
              try {
                await currentRenderAdapters().clip.setClipLayoutAnalysis(
                  clip.id,
                  screenEnvelope,
                );
              } catch (persistError) {
                rethrowRenderControlFlow(persistError);
                log("error", "clip_screen_layout_analysis_persist_failed", {
                  workflowRunId: run.id,
                  clipId: clip.id,
                  ...mediaAnalysisDiagnostic({
                    analysisMode: "screen_layout",
                    fallbackMode: "render_without_persisted_analysis",
                    failureCode: "analysis_persist_failed",
                  }),
                });
              }
            }
            screenLayoutEvidenceForPlan = {
              state: "available",
              value: {
                sourceIdentity: compositionSourceIdentity,
                inputFingerprint: screenFingerprint,
                engineVersion: screenEngineVersion,
                source:
                  analysisSource === "persisted" ? "durable-pip" : "analysis",
                pictureInPicture: pipRect
                  ? {
                      state: "confirmed",
                      rect: {
                        x: pipRect.x,
                        y: pipRect.y,
                        width: pipRect.w,
                        height: pipRect.h,
                      },
                    }
                  : { state: "unavailable" },
                faceBand: faceBandSegments
                  ? { state: "available", segments: faceBandSegments }
                  : { state: "unavailable" },
              },
            };
            if (!appliedTracking) {
              log("info", "clip_screen_bottom_center_fallback", {
                workflowRunId: run.id,
                clipId: clip.id,
                ...mediaAnalysisDiagnostic({
                  analysisMode: "screen_layout",
                  fallbackMode: "center_crop",
                  failureCode: detection
                    ? "no_face_detected"
                    : "analysis_unavailable",
                }),
                reason: detection ? "no_face_detected" : "detection_unavailable",
              });
            }
          }
        }
      }

      // Split packet B (vizard-parity.md "Split-screen 2-up"): when the
      // clip's effective framing mode is "split", detect multi-face segments
      // and build the per-segment 2-up layout plan. Evaluated AFTER the
      // B-roll plan above (not alongside the single-face auto-reframe block)
      // because the v1 B-roll/split conflict policy needs to know whether
      // this clip already has cutaways: "b-roll replaces the whole 2-up
      // frame" composition is future work, so a clip with both simply falls
      // back to single-speaker framing (`decideSplitFallback`'s
      // "broll_conflict" reason) rather than attempting to combine them.
      let splitPlan: BuildSplitLayoutPlanResult | null = null;
      // H1 (adversarial review): the subset of `outputs` whose ASPECT RATIO
      // can't produce laterally distinct 2-up tiles even when `splitPlan` is
      // non-null (e.g. this clip's 9:16 output gets a real split, but its
      // 1:1/16:9 outputs of the SAME clip can't — see `splitTilesAreDistinct`).
      // Populated below, consumed by the per-output render loop, which routes
      // exactly these outputs through `params.reframe`/center-crop instead of
      // `params.split`.
      let splitIneligibleOutputs: PendingRenderOutput[] = [];
      const splitEnabled = currentRenderConfig().splitEnabled;
      const isSplitMode =
        resolveEffectiveFramingMode(studioEdits) === "split" && probe.hasVideo;
      if (isSplitMode) {
        // L1 (adversarial review): the WORKER_SPLIT=0 kill switch gets its
        // own fallback reason ("disabled") instead of masquerading as
        // "detection_unavailable" — it never even attempts detection, which
        // is a materially different situation to log/debug from "detection
        // ran and failed." Short-circuits before `decideSplitFallback` is
        // even called (that function has no way to distinguish "disabled"
        // from "detection never ran for another reason" from its params
        // alone).
        if (!splitEnabled) {
          splitLayoutEvidenceForPlan = { state: "disabled" };
          log("info", "clip_split_fallback", {
            workflowRunId: run.id,
            clipId: clip.id,
            ...mediaAnalysisDiagnostic({
              analysisMode: "split_layout",
              fallbackMode: "auto_reframe",
              failureCode: "analysis_disabled",
            }),
            reason: "disabled",
          });
          if (reframeEnabled && srcRatio > 1.05 && reframeOutputs.length > 0) {
            const detectInput =
              await currentRenderAdapters().analysis.extractFaceDetectionSegment({
              sourcePath,
              tempDir,
              clipId: clip.id,
              workflowRunId: run.id,
              clipStartSec,
              durationSec: effective.durationSec,
              suffix: "-splitfallback",
            });
            const detection = detectInput
              ? await currentRenderAdapters().analysis.detectFacePath({
                  sourcePath: detectInput.path,
                  startSec: detectInput.startSec,
                  durationSec: effective.durationSec,
                  logContext: { workflowRunId: run.id, clipId: clip.id },
                })
              : null;
            await applyAutoReframe({
              samples: detection?.samples ?? null,
              cutPlan,
              clipStartSec,
              probe,
              outputs,
              reframeOutputs,
              tempDir,
              clipId: clip.id,
              workflowRunId: run.id,
            });
          }
        } else {
          let detectionAvailable = false;
          let plan: BuildSplitLayoutPlanResult | null = null;
          // Hoisted so the fallback branch below (M2, adversarial review)
          // can derive single-face samples from this multi-face result
          // instead of re-running the python detector from scratch.
          let multiDetection: { samples: MultiFaceSample[] } | null = null;

          if (!brollPlan) {
            const detectInput =
              await currentRenderAdapters().analysis.extractFaceDetectionSegment({
              sourcePath,
              tempDir,
              clipId: clip.id,
              workflowRunId: run.id,
              clipStartSec,
              durationSec: effective.durationSec,
              suffix: "-split",
            });
            // Same source<->edited timeline contract as the single-face path
            // above: detection scans the full uncut clip window in
            // elapsed-uncut-source seconds; `remapMultiFaceSamplesForCutPlan`
            // drops samples inside a cut and remaps the rest onto the edited
            // timeline `buildSplitLayoutPlan`'s segments (and therefore
            // `buildSplitFilterChain`'s `trim` windows) are expressed in.
            multiDetection = detectInput
              ? await currentRenderAdapters().analysis.detectMultiFacePath({
                  sourcePath: detectInput.path,
                  startSec: detectInput.startSec,
                  durationSec: effective.durationSec,
                  logContext: { workflowRunId: run.id, clipId: clip.id },
                })
              : null;
            detectionAvailable = Boolean(multiDetection);
            if (multiDetection) {
              const remapped = remapMultiFaceSamplesForCutPlan(
                multiDetection.samples,
                cutPlan,
                clipStartSec,
              );
              plan = buildSplitLayoutPlan(remapped, clipDurationSec);
            }
          }

          const fallbackReason = decideSplitFallback({
            hasBrollPlan: Boolean(brollPlan),
            detectionAvailable,
            plan,
          });

          if (fallbackReason) {
            splitLayoutEvidenceForPlan = {
              state: "failed",
              reason: fallbackReason,
            };
            log("info", "clip_split_fallback", {
              workflowRunId: run.id,
              clipId: clip.id,
              ...mediaAnalysisDiagnostic({
                analysisMode: "split_layout",
                fallbackMode: "auto_reframe",
                failureCode: fallbackReason,
              }),
              reason: fallbackReason,
            });
            // Fall back to single-speaker framing exactly like "auto" mode —
            // forced here since `shouldRunAutoReframeDetection` (and the
            // block above gated on it) deliberately excludes "split".
            if (reframeEnabled && srcRatio > 1.05 && reframeOutputs.length > 0) {
              // M2 (adversarial review): only re-run the single-face python
              // detector when multi-face detection never actually ran
              // (kill switch is handled above; here that's the
              // `broll_conflict` path, which is decided BEFORE detection
              // runs at all — see the `!brollPlan` guard above). When multi
              // detection did run (and either found <2 clusters or produced
              // an empty/all-single plan), reuse ITS samples instead of a
              // second extraction + a second full YuNet pass.
              const samples = multiDetection
                ? deriveSingleFaceSamplesFromMulti(multiDetection.samples)
                : (
                    await (async () => {
                      const detectInput =
                        await currentRenderAdapters().analysis.extractFaceDetectionSegment({
                        sourcePath,
                        tempDir,
                        clipId: clip.id,
                        workflowRunId: run.id,
                        clipStartSec,
                        durationSec: effective.durationSec,
                        suffix: "-splitfallback",
                      });
                      return detectInput
                        ? await currentRenderAdapters().analysis.detectFacePath({
                            sourcePath: detectInput.path,
                            startSec: detectInput.startSec,
                            durationSec: effective.durationSec,
                            logContext: { workflowRunId: run.id, clipId: clip.id },
                          })
                        : null;
                    })()
                  )?.samples ?? null;
              await applyAutoReframe({
                samples,
                cutPlan,
                clipStartSec,
                probe,
                outputs,
                reframeOutputs,
                tempDir,
                clipId: clip.id,
                workflowRunId: run.id,
              });
            }
          } else if (plan) {
            splitPlan = plan;
            const fallbackSegments = faceBandSegmentsForCompositionPlan({
              samples: multiDetection
                ? deriveSingleFaceSamplesFromMulti(multiDetection.samples)
                : null,
              cutPlan,
              clipStartSec,
              editedDurationSec: clipDurationSec,
            }) ?? [
              {
                startSec: 0,
                endSec: clipDurationSec,
                layout: "single" as const,
                cxNorm: 0.5,
                cyNorm: 0.5,
                zoom: 1,
              },
            ];
            const explicitSegments: ClipAutoLayoutSegment[] = plan.segments.map(
              (segment) =>
                segment.layout === "single"
                  ? {
                      startSec: segment.startSec,
                      endSec: segment.endSec,
                      layout: "single" as const,
                      cxNorm: segment.cxNorm,
                      cyNorm: segment.cyNorm ?? 0.5,
                      zoom: segment.zoom ?? 1,
                    }
                  : {
                      startSec: segment.startSec,
                      endSec: segment.endSec,
                      layout: "two-up" as const,
                      topCxNorm: segment.topCxNorm,
                      bottomCxNorm: segment.bottomCxNorm,
                      topCyNorm: segment.topCyNorm ?? 0.5,
                      bottomCyNorm: segment.bottomCyNorm ?? 0.5,
                      topZoom: segment.topZoom ?? 1,
                      bottomZoom: segment.bottomZoom ?? 1,
                    },
            );
            const splitEngineVersion = "explicit-split-v1";
            splitLayoutEvidenceForPlan = {
              state: "available",
              value: {
                sourceIdentity: compositionSourceIdentity,
                inputFingerprint: splitLayoutInputFingerprint({
                  sourceIdentity: compositionSourceIdentity,
                  clipStartSec: clip.startSec,
                  clipEndSec: clip.endSec,
                  deletedRanges,
                  engineVersion: splitEngineVersion,
                }),
                engineVersion: splitEngineVersion,
                source: "explicit-detector",
                segments: explicitSegments,
                fallbackSegments,
              },
            };
            const twoUpSegmentCount = explicitSegments.filter(
              (segment) => segment.layout === "two-up",
            ).length;
            // The shared scene envelope is also the browser's durable Split
            // evidence. Its explicit engine discriminator prevents an Auto
            // consumer from silently treating detector-specific scenes as a
            // shot-layout result when the user switches modes later.
            const splitPreviewEnvelope = parseClipSplitLayoutAnalysis({
              version: 1,
              engine: "explicit-split-v1",
              sourceIdentity: compositionSourceIdentity,
              analyzedAtISO: new Date(currentTimeMs()).toISOString(),
              clipStartSec: clip.startSec,
              clipEndSec: clip.endSec,
              deletedRanges,
              editedDurationSec: clipDurationSec,
              sourceWidth: probe.width,
              sourceHeight: probe.height,
              segments: explicitSegments,
              noSplitSegments: fallbackSegments,
              shotCount: explicitSegments.length,
              soloShotCount: explicitSegments.length - twoUpSegmentCount,
              multiShotCount: twoUpSegmentCount,
              twoUpSegmentCount,
              speakerCount: plan.clusterCount,
              mappedSpeakerCount: plan.clusterCount,
            });
            if (!splitPreviewEnvelope) {
              throw new Error("invalid_split_layout_analysis");
            }
            if (clip.previewStorageKey) {
              await currentRenderAdapters()
                .clip
                .completeClipSplitLayoutAnalysis(clip.id, splitPreviewEnvelope, {
                  editorRevision: clip.editorRevision,
                  previewStorageKey: clip.previewStorageKey,
                })
                .catch((error) => {
                  rethrowRenderControlFlow(error);
                  log("error", "clip_split_layout_analysis_persist_failed", {
                    workflowRunId: run.id,
                    clipId: clip.id,
                    ...mediaAnalysisDiagnostic({
                      analysisMode: "split_layout",
                      fallbackMode: "render_without_persisted_analysis",
                      failureCode: "analysis_persist_failed",
                    }),
                  });
                });
            }
            if (plan.cappedFromSegmentCount) {
              log("info", "clip_split_segments_capped", {
                workflowRunId: run.id,
                clipId: clip.id,
                originalSegmentCount: plan.cappedFromSegmentCount,
                cappedTo: plan.segments.length,
              });
            }
            log("info", "clip_split_applied", {
              workflowRunId: run.id,
              clipId: clip.id,
              ...mediaAnalysisDiagnostic({
                analysisMode: "split_layout",
                selectedMode: "two_up",
              }),
              segmentCount: plan.segments.length,
              clusterCount: plan.clusterCount,
            });

            // H1 (adversarial review): a real plan exists, but not every
            // OUTPUT's aspect ratio can render it distinctly — a 9:16 output
            // might have plenty of lateral crop room while this SAME clip's
            // 1:1/16:9 output can't (the tile crop consumes the full source
            // width, forcing both tiles' x to 0 regardless of cx). Those
            // outputs fall back to single-speaker framing individually
            // rather than the whole clip giving up on split.
            splitIneligibleOutputs = outputs.filter(
              (output) => !splitTilesAreDistinct(output.aspectRatio, probe),
            );
            if (splitIneligibleOutputs.length > 0) {
              for (const output of splitIneligibleOutputs) {
                log("info", "clip_split_fallback", {
                  workflowRunId: run.id,
                  clipId: clip.id,
                  ...mediaAnalysisDiagnostic({
                    analysisMode: "split_layout",
                    fallbackMode: "auto_reframe",
                    failureCode: "tiles_not_distinct",
                  }),
                  reason: "tiles_not_distinct",
                  aspectRatio: output.aspectRatio,
                });
              }
              if (reframeEnabled && srcRatio > 1.05) {
                // Reuse the multi-face samples this clip already detected
                // (M2's same reasoning) — no second extraction/detection
                // pass needed since `multiDetection` is guaranteed non-null
                // here (a `plan` only exists when it succeeded).
                const samples = multiDetection
                  ? deriveSingleFaceSamplesFromMulti(multiDetection.samples)
                  : null;
                await applyAutoReframe({
                  samples,
                  cutPlan,
                  clipStartSec,
                  probe,
                  outputs,
                  reframeOutputs: splitIneligibleOutputs,
                  tempDir,
                  clipId: clip.id,
                  workflowRunId: run.id,
                });
              }
            }
          }
        }
      }

      let musicPlan: MusicPlan | null = null;
      // Library asset (vizard-parity.md "Music/SFX library" —
      // `studioMusicSchema.assetId`) wins over the pasted `url` at render
      // time — same precedence the schema's own doc comment documents.
      // Resolution failure (deleted row, DB hiccup) is treated exactly like
      // a failed download below: log and skip music entirely, never fail
      // the whole clip (the existing `music_download_failed` policy this
      // mirrors never actually fails the clip either — see the catch below,
      // which only logs).
      let musicUrl: string | null = null;
      // M6 (vizard-parity.md "Music/SFX library"): an AudioAsset-resolved
      // music track already passed the AUDIO_UPLOAD_MAX_BYTES gate once at
      // upload time (or is a curated row seeded well under it) — downloading
      // it back down for a render must not silently inherit the much larger
      // 250MB pasted-URL/B-roll budget. A pasted `url` (no assetId) predates
      // this change and keeps the original 250MB policy.
      let musicUrlIsAssetResolved = false;
      if (studioEdits.music.assetId) {
        try {
          const resolved = await currentRenderAdapters().audioAsset.resolveRenderSource(
            frozenState.userId,
            studioEdits.music.assetId,
            frozenState.workspaceId,
          );
          musicUrl = resolved?.url ?? null;
          musicUrlIsAssetResolved = Boolean(resolved);
          if (!resolved) {
            diagnoseOptionalAssetFallback({
              assetClass: "music",
              phase: "lookup",
              failureCode: "music_asset_unavailable",
              context: { workflowRunId: run.id, clipId: clip.id },
            });
          }
        } catch (error) {
          rethrowRenderControlFlow(error);
          const accessFailure = optionalAccessFailure(error, "music");
          diagnoseOptionalAssetFallback({
            assetClass: "music",
            ...accessFailure,
            context: { workflowRunId: run.id, clipId: clip.id },
          });
        }
      } else {
        musicUrl = studioEdits.music.url;
      }

      if (musicUrl) {
        let musicUrlSafe = false;
        try {
          assertPublicHttpUrl(musicUrl);
          musicUrlSafe = true;
        } catch {
          diagnoseOptionalAssetFallback({
            assetClass: "music",
            phase: "lookup",
            failureCode: "music_url_rejected",
            context: { workflowRunId: run.id, clipId: clip.id },
          });
        }
        if (musicUrlSafe) {
          touchedOptionalAssetClasses.add("music");
          const musicPath = join(tempDir, `music-${clip.id}.bin`);
          try {
            await currentRenderAdapters().optionalAssets.downloadUrlToFile(
              musicUrl,
              musicPath,
              "music_download_failed",
              musicUrlIsAssetResolved ? { maxBytes: AUDIO_UPLOAD_MAX_BYTES } : undefined,
            );
            const decodable =
              await currentRenderAdapters().optionalAssets.validateOptionalMedia(
                musicPath,
                "audio",
              );
            if (decodable) {
              musicPlan = {
                path: musicPath,
                volume: studioEdits.music.volume,
                startOffsetSec: studioEdits.music.startOffsetSec,
                fadeInSec: studioEdits.music.fadeInSec,
                fadeOutSec: studioEdits.music.fadeOutSec,
              };
            } else {
              diagnoseOptionalAssetFallback({
                assetClass: "music",
                phase: "decode",
                failureCode: "music_media_invalid",
                context: { workflowRunId: run.id, clipId: clip.id },
              });
            }
          } catch (error) {
            rethrowRenderControlFlow(error);
            diagnoseOptionalAssetFallback({
              assetClass: "music",
              phase: "download",
              failureCode: "music_download_failed",
              context: { workflowRunId: run.id, clipId: clip.id },
            });
          }
        }
      }

      // Auto-ducking v1 (vizard-parity.md "Music/SFX library"): only
      // computed when a music track actually resolved AND the user turned
      // ducking on. Word intervals are derived from the SAME
      // `captionTimeMap`/`utterances` the caption burn-in above already
      // uses, so ducking can't drift from what the captions themselves
      // consider "speech" on this clip's edited timeline. An empty
      // transcript naturally yields `duckingWindows: []`, which
      // `buildAudioMixFilter`/`buildMusicDuckingSuffix` treat as a no-op
      // (filter omitted entirely, not a `volume='1'` stage).
      if (musicPlan && studioEdits.music.ducking) {
        const wordIntervals = extractSpeechWordIntervals(
          utterances,
          clipStartSec,
          captionTimeMap,
        );
        const speechWindows = computeSpeechWindows(wordIntervals, clipDurationSec);
        if (speechWindows.length > MAX_DUCKING_WINDOWS) {
          log("info", "clip_ducking_windows_capped", {
            workflowRunId: run.id,
            clipId: clip.id,
            windowCount: speechWindows.length,
            cappedTo: MAX_DUCKING_WINDOWS,
          });
        }
        musicPlan.duckingWindows = speechWindows;
      }

      // One-shot SFX placements (vizard-parity.md "Music/SFX library" —
      // `studioEdits.sfx[]`). Each placement is resolved/downloaded
      // independently and best-effort: a single bad placement is skipped
      // (logged) rather than failing every other placement or the whole
      // clip, mirroring the music download policy above.
      const sfxPlans: SfxPlan[] = [];
      for (const placement of studioEdits.sfx) {
        if (placement.startSec >= clipDurationSec) {
          log("info", "clip_sfx_skipped_beyond_duration", {
            workflowRunId: run.id,
            clipId: clip.id,
            sfxId: placement.id,
            startSec: placement.startSec,
            clipDurationSec,
          });
          continue;
        }

        let sfxUrl: string | null = null;
        try {
          const resolved = await currentRenderAdapters().audioAsset.resolveRenderSource(
            frozenState.userId,
            placement.assetId,
            frozenState.workspaceId,
          );
          sfxUrl = resolved?.url ?? null;
          if (!resolved) {
            diagnoseOptionalAssetFallback({
              assetClass: "sound_effect",
              phase: "lookup",
              failureCode: "sound_effect_asset_unavailable",
              context: {
                workflowRunId: run.id,
                clipId: clip.id,
                sfxId: placement.id,
              },
            });
          }
        } catch (error) {
          rethrowRenderControlFlow(error);
          const accessFailure = optionalAccessFailure(error, "sound_effect");
          diagnoseOptionalAssetFallback({
            assetClass: "sound_effect",
            ...accessFailure,
            context: {
              workflowRunId: run.id,
              clipId: clip.id,
              sfxId: placement.id,
            },
          });
        }
        if (!sfxUrl) continue;

        let sfxUrlSafe = false;
        try {
          assertPublicHttpUrl(sfxUrl);
          sfxUrlSafe = true;
        } catch (error) {
          rethrowRenderControlFlow(error);
          diagnoseOptionalAssetFallback({
            assetClass: "sound_effect",
            phase: "lookup",
            failureCode: "sound_effect_url_rejected",
            context: {
              workflowRunId: run.id,
              clipId: clip.id,
              sfxId: placement.id,
            },
          });
        }
        if (!sfxUrlSafe) continue;

        const sfxPath = join(tempDir, `sfx-${clip.id}-${placement.id}.bin`);
        touchedOptionalAssetClasses.add("sound_effect");
        try {
          // M6: SFX placements are always resolved through an AudioAsset
          // (`assetId` is required by `studioSfxPlacementSchema`) — bounded
          // by the same AUDIO_UPLOAD_MAX_BYTES the upload gate enforced,
          // not the larger 250MB B-roll/pasted-URL budget.
          await currentRenderAdapters().optionalAssets.downloadUrlToFile(
            sfxUrl,
            sfxPath,
            "sfx_download_failed",
            {
              maxBytes: AUDIO_UPLOAD_MAX_BYTES,
            },
          );
          const decodable =
            await currentRenderAdapters().optionalAssets.validateOptionalMedia(
              sfxPath,
              "audio",
            );
          if (decodable) {
            sfxPlans.push({
              path: sfxPath,
              startSec: placement.startSec,
              volume: placement.volume,
            });
          } else {
            diagnoseOptionalAssetFallback({
              assetClass: "sound_effect",
              phase: "decode",
              failureCode: "sound_effect_media_invalid",
              context: {
                workflowRunId: run.id,
                clipId: clip.id,
                sfxId: placement.id,
              },
            });
          }
        } catch (error) {
          rethrowRenderControlFlow(error);
          diagnoseOptionalAssetFallback({
            assetClass: "sound_effect",
            phase: "download",
            failureCode: "sound_effect_download_failed",
            context: {
              workflowRunId: run.id,
              clipId: clip.id,
              sfxId: placement.id,
            },
          });
        }
      }

      // Canvas background (vizard-parity Phase C item 2): mirrors the music
      // plan above — resolve once per clip, downloading the background image
      // (if any) to a local file so the per-output builders never touch the
      // network themselves. A bad/unsafe image URL, a failed download, or a
      // downloaded file that ffprobe can't find a decodable video/image
      // stream in (e.g. the URL 200s with an HTML page instead of an image)
      // degrades to the solid-color fallback (black if no color was chosen
      // either) rather than failing the render — same "best effort, never
      // fail the clip" policy the music/B-roll downloads follow.
      //
      // Gated on the resolved effective mode (Phase C-2 stage 1), not the
      // raw `background.mode`, so this can't drift from the reframe-skip
      // gate above or the builder branch below — they're all
      // `resolveEffectiveFramingMode(studioEdits) === "fit"` by definition
      // (`background.mode !== "off"` always wins as "fit"), so this reads
      // identically to before for every existing clip. This stays a plain
      // `=== "fit"` check, not an exhaustive switch — a split clip
      // (background off) leaves `backgroundPlan` null exactly like center
      // does today, and instead of falling through to the plain
      // crop-to-fill builder path, `buildSingleVideoArgs`/`buildBrollVideoArgs`
      // check `params.split` (built from `splitPlan` above, split packet B)
      // BEFORE the crop-to-fill fallback — see those builders' `else if`
      // branch order.
      let backgroundPlan: BackgroundPlan | null = null;
      if (resolveEffectiveFramingMode(studioEdits) === "fit") {
        const fallbackColor = studioEdits.background.color ?? "#000000";
        backgroundPlan = { mode: "color", color: fallbackColor, imagePath: null };

        if (studioEdits.background.mode === "image" && studioEdits.background.imageUrl) {
          let imageUrlSafe = false;
          try {
            assertPublicHttpUrl(studioEdits.background.imageUrl);
            imageUrlSafe = true;
          } catch {
            diagnoseOptionalAssetFallback({
              assetClass: "background",
              phase: "lookup",
              failureCode: "background_image_url_rejected",
              context: { workflowRunId: run.id, clipId: clip.id },
            });
          }
          if (imageUrlSafe) {
            touchedOptionalAssetClasses.add("background");
            const backgroundImagePath = join(tempDir, `background-${clip.id}.bin`);
            try {
              await currentRenderAdapters().optionalAssets.downloadUrlToFile(
                studioEdits.background.imageUrl,
                backgroundImagePath,
                "background_image_download_failed",
              );
              const probeDecodable =
                await currentRenderAdapters().optionalAssets.probeBackgroundImageDecodable(
                  backgroundImagePath,
                );
              const decodable =
                probeDecodable &&
                (await currentRenderAdapters().optionalAssets.validateOptionalMedia(
                  backgroundImagePath,
                  "image",
                ));
              if (!decodable) {
                diagnoseOptionalAssetFallback({
                  assetClass: "background",
                  phase: probeDecodable ? "decode" : "probe",
                  failureCode: probeDecodable
                    ? "background_image_decode_failed"
                    : "background_image_invalid",
                  context: { workflowRunId: run.id, clipId: clip.id },
                });
              }
              backgroundPlan = resolveBackgroundPlanForDownloadedImage({
                decodable,
                color: fallbackColor,
                imagePath: backgroundImagePath,
              });
            } catch (error) {
              rethrowRenderControlFlow(error);
              diagnoseOptionalAssetFallback({
                assetClass: "background",
                phase: "download",
                failureCode: "background_image_download_failed",
                context: { workflowRunId: run.id, clipId: clip.id },
              });
              // backgroundPlan stays the color fallback set above.
            }
          }
        }
      }

      const optionalCommandAssets: Array<{
        assetClass: OptionalAssetClass;
        failureCode: string;
      }> = [
        ...(logo
          ? [{ assetClass: "logo" as const, failureCode: "brand_logo_command_failed" }]
          : []),
        ...(brollPlan
          ? [{ assetClass: "broll" as const, failureCode: "broll_command_failed" }]
          : []),
        ...(musicPlan
          ? [{ assetClass: "music" as const, failureCode: "music_mix_failed" }]
          : []),
        ...(sfxPlans.length > 0
          ? [
              {
                assetClass: "sound_effect" as const,
                failureCode: "sound_effect_mix_failed",
              },
            ]
          : []),
        ...(backgroundPlan?.mode === "image"
          ? [
              {
                assetClass: "background" as const,
                failureCode: "background_image_command_failed",
              },
            ]
          : []),
      ];
      const fallbackBackgroundPlan: BackgroundPlan | null =
        backgroundPlan?.mode === "image"
          ? { mode: "color", color: backgroundPlan.color, imagePath: null }
          : backgroundPlan;

      const requestedCompositionMode = resolveEffectiveFramingMode(studioEdits);
      let compositionPlan: ClipCompositionPlan | null = null;
      let fallbackCompositionPlan: ClipCompositionPlan | null = null;
      const compositionControl =
        requestedCompositionMode === "center"
          ? currentRenderConfig().compositionCenter
          : requestedCompositionMode === "fit"
            ? currentRenderConfig().compositionFit
            : requestedCompositionMode === "auto"
              ? currentRenderConfig().compositionAuto
              : requestedCompositionMode === "split"
                ? currentRenderConfig().compositionSplit
                : requestedCompositionMode === "screen"
                  ? currentRenderConfig().compositionScreen
                  : "legacy";
      if (
        probe.hasVideo &&
        (requestedCompositionMode === "center" ||
          requestedCompositionMode === "fit" ||
          requestedCompositionMode === "auto" ||
          requestedCompositionMode === "split" ||
          requestedCompositionMode === "screen") &&
        !(requestedCompositionMode === "auto" && brollPlan) &&
        !(
          (requestedCompositionMode === "split" ||
            requestedCompositionMode === "screen") &&
          brollPlan
        ) &&
        compositionControl !== "legacy"
      ) {
        const planWithBackgroundAvailability = (
          backgroundImage:
            | { state: "missing" | "failed" }
            | { state: "available"; ref: string },
        ) =>
          planClipComposition({
            document: compositionDocument,
            source: {
              identity: compositionSourceIdentity,
              kind: "video",
              width: probe.width,
              height: probe.height,
            },
            evidence: {
              automaticLayout: automaticLayoutAnalysisForPlan
                ? {
                    state: "available",
                    value: {
                      sourceIdentity: compositionSourceIdentity,
                      inputFingerprint: automaticLayoutInputFingerprint({
                        sourceIdentity: compositionSourceIdentity,
                        clipStartSec: clip.startSec,
                        clipEndSec: clip.endSec,
                        deletedRanges,
                        engineVersion: "shot-layout-v1",
                      }),
                      engineVersion: "shot-layout-v1",
                      analysis: automaticLayoutAnalysisForPlan,
                    },
                  }
                : { state: automaticLayoutEvidenceFailure },
              splitLayout: splitLayoutEvidenceForPlan,
              screenLayout: screenLayoutEvidenceForPlan,
            },
            assets: { backgroundImage },
            capabilities: {
              automaticSpeakerLayout: currentRenderConfig().layoutEngineEnabled,
              automaticSpeakerEngineVersion: "shot-layout-v1",
              explicitSplitLayout: currentRenderConfig().splitEnabled,
              splitEngineVersion: "explicit-split-v1",
              screenLayout: currentRenderConfig().screenLayoutEnabled,
              screenEngineVersion: "screen-layout-v1",
            },
            targets: outputs.map((output) => {
              const target = aspectRatioConfig.get(output.aspectRatio)!;
              return {
                id: output.clipRenderId,
                aspectRatio: output.aspectRatio,
                width: target.width,
                height: target.height,
              };
            }),
          });
        const backgroundImageAvailability =
          requestedCompositionMode === "fit" &&
          backgroundPlan?.mode === "image" &&
          backgroundPlan.imagePath &&
          studioEdits.background.imageUrl
            ? {
                state: "available" as const,
                ref: compositionAssetRef(
                  "background",
                  studioEdits.background.imageUrl,
                ),
              }
            : requestedCompositionMode === "fit" &&
                studioEdits.background.mode === "image"
              ? ({ state: "failed" } as const)
              : ({ state: "missing" } as const);
        const planningStartedAtMs = currentTimeMs();
        const planned = planWithBackgroundAvailability(
          backgroundImageAvailability,
        );
        const planningDurationMs = Math.max(
          0,
          currentTimeMs() - planningStartedAtMs,
        );
        if (planned.status === "invalid") {
          throw new WorkflowWorkerError(
            planned.error.code,
            `Clip Composition Plan rejected ${planned.error.code}`,
            "permanent",
          );
        }
        const sceneCount = planned.plan.targets.reduce(
          (count, target) => count + target.scenes.length,
          0,
        );
        const compositionEvidenceDiagnostics =
          requestedCompositionMode === "auto"
            ? {
                source: automaticLayoutEvidenceSource,
                version: automaticLayoutAnalysisForPlan?.version ?? null,
              }
            : requestedCompositionMode === "split" &&
                splitLayoutEvidenceForPlan.state === "available"
              ? {
                  source: splitLayoutEvidenceForPlan.value.source,
                  version: splitLayoutEvidenceForPlan.value.engineVersion,
                }
              : requestedCompositionMode === "screen" &&
                  screenLayoutEvidenceForPlan.state === "available"
                ? {
                    source: screenLayoutEvidenceForPlan.value.source,
                    version: screenLayoutEvidenceForPlan.value.engineVersion,
                  }
                : { source: null, version: null };
        log("info", "clip_composition_plan", {
          workflowRunId: run.id,
          clipId: clip.id,
          adapter: "ffmpeg",
          control: compositionControl,
          planVersion: planned.plan.version,
          planFingerprint: planned.plan.fingerprint,
          planningDurationMs,
          requestedMode: requestedCompositionMode,
          evidenceSource: compositionEvidenceDiagnostics.source,
          evidenceVersion: compositionEvidenceDiagnostics.version,
          evidenceRequestCount: planned.plan.evidenceRequests.length,
          effectiveModes: planned.plan.targets.map(
            (target) => target.effectiveMode,
          ),
          targets: planned.plan.targets.map((target) => ({
            id: target.id,
            aspectRatio: target.aspectRatio,
            canvas: target.canvas,
            scenes: target.scenes.map((scene) => ({
              startSec: scene.startSec,
              endSec: scene.endSec,
              layerKinds: scene.layers.map((layer) => layer.kind),
            })),
          })),
          sceneCount,
          noticeCodes: planned.plan.notices.map((notice) => notice.code),
        });
        if (compositionControl === "shadow") {
          for (const target of planned.plan.targets) {
            const output = outputs.find(
              (candidate) => candidate.clipRenderId === target.id,
            );
            if (!output) continue;
            const legacyAutomaticSegments =
              requestedCompositionMode === "auto" &&
              autoLayoutSegmentsFull &&
              reframeOutputs.includes(output)
                ? splitTilesAreDistinct(output.aspectRatio, probe)
                  ? autoLayoutSegmentsFull
                  : autoLayoutSegmentsNoSplit
                : null;
            const legacy = buildLegacyCompositionShadowTarget({
              targetId: target.id,
              aspectRatio: output.aspectRatio,
              target: {
                width: target.canvas.width,
                height: target.canvas.height,
              },
              source: { width: probe.width, height: probe.height },
              durationSec: clipDurationSec,
              requestedMode: requestedCompositionMode,
              automaticSegments: legacyAutomaticSegments,
              splitSegments:
                requestedCompositionMode === "split" &&
                splitPlan &&
                !splitIneligibleOutputs.includes(output)
                  ? splitPlan.segments
                  : null,
              screenBottom:
                requestedCompositionMode === "screen"
                  ? output.screenBottom
                  : null,
              dynamicReframe: Boolean(
                output.reframe && !legacyAutomaticSegments,
              ),
              speakerLayoutOverrides: studioEdits.speakerLayoutOverrides,
              background: backgroundPlan,
            });
            const shadow = compareCompositionShadowTarget({
              planned: target,
              plannedNoticeCodes: planned.plan.notices
                .filter((notice) => notice.targetId === target.id)
                .map((notice) => notice.code),
              legacy,
            });
            log("info", "clip_composition_shadow", {
              workflowRunId: run.id,
              clipId: clip.id,
              adapter: "ffmpeg",
              planVersion: planned.plan.version,
              planFingerprint: planned.plan.fingerprint,
              requestedMode: requestedCompositionMode,
              targetId: target.id,
              aspectRatio: target.aspectRatio,
              effectiveMode: target.effectiveMode,
              ...shadow,
            });
          }
        }
        if (compositionControl === "plan") {
          const preservesTrackedFallback =
            (requestedCompositionMode === "split" &&
              splitLayoutEvidenceForPlan.state !== "available") ||
            (requestedCompositionMode === "screen" &&
              screenLayoutEvidenceForPlan.state !== "available");
          if (preservesTrackedFallback) {
            log("info", "clip_composition_plan_retained_legacy_fallback", {
              workflowRunId: run.id,
              clipId: clip.id,
              requestedMode: requestedCompositionMode,
              evidenceState:
                requestedCompositionMode === "split"
                  ? splitLayoutEvidenceForPlan.state
                  : screenLayoutEvidenceForPlan.state,
            });
          } else {
            compositionPlan = planned.plan;
            if (backgroundImageAvailability.state === "available") {
              const fallbackPlan = planWithBackgroundAvailability({
                state: "failed",
              });
              if (fallbackPlan.status !== "invalid") {
                fallbackCompositionPlan = fallbackPlan.plan;
              }
            }
          }
        }
      }

      // sourceAudio (volume/mute) is only applied by the per-output builders
      // (buildSingleVideoArgs/buildBrollVideoArgs/buildAudiogramArgs), same
      // as music — buildMultiVideoArgs (the shared multi-output batch path)
      // never learned to thread either through its filter graph, so any
      // non-default sourceAudio setting must route through this same gate to
      // actually take effect for multi-output renders.
      //
      // Cut-concat (vizard-parity Phase B step 7) is threaded through the
      // same gate rather than taught to buildMultiVideoArgs directly: that
      // path only ever handles multiple *plain* outputs (no B-roll, no other
      // studio edits), and inserting cut/concat there would mean
      // implementing the same trim+concat-before-split logic a third time
      // for a case that's cheap to route through the already-cut-aware
      // per-output builders instead.
      //
      // A canvas background also forces this gate: it changes the base
      // composition itself (fit+pad instead of crop-to-fill), which
      // buildMultiVideoArgs's shared crop-to-fill path has no concept of.
      //
      // SFX (vizard-parity.md "Music/SFX library") forces it for the same
      // reason music does — buildMultiVideoArgs never learned a mix filter
      // at all, so any SFX placement must route through the per-output
      // builders. Ducking doesn't need its own clause: it only ever
      // modifies the music branch, which is already gated by
      // `Boolean(musicPlan)`.
      //
      // Split (packet B) forces it for the same reason a canvas background
      // does: `buildSplitFilterChain`'s segment-concat graph replaces the
      // base composition entirely, which `buildMultiVideoArgs`'s shared
      // crop-to-fill path has no concept of (unlike plain reframe, which
      // `buildMultiVideoArgs` DOES thread through per output via
      // `output.reframe`). Gated on the effective mode
      // (`framingForcesPerOutputRender`), not `Boolean(splitPlan)`, so a
      // split clip always takes the per-output path even on a render where
      // it fell back to single-speaker framing (`splitPlan` null) — keeps
      // the routing decision simple/stable across renders rather than
      // flapping between the batch and per-output path from one run to the
      // next as detection succeeds or fails.
      const hasStudioVideoEdits =
        studioEdits.textLayers.length > 0 ||
        studioEdits.transition.type !== "none" ||
        Boolean(musicPlan) ||
        sfxPlans.length > 0 ||
        studioEdits.sourceAudio.muted ||
        studioEdits.sourceAudio.volume !== 100 ||
        !cutPlan.isUncut ||
        Boolean(backgroundPlan) ||
        framingForcesPerOutputRender(studioEdits) ||
        // Layout-engine plan (auto mode): the segment-concat graph replaces
        // the base composition exactly like split's does, so it needs the
        // per-output path for the same reason. Unlike split this IS gated on
        // plan presence — auto mode has no user-visible mode toggle to keep
        // routing stable against, and a plan-less render through the batch
        // path is byte-identical to before the engine existed.
        Boolean(autoLayoutSegmentsFull) ||
        // A ready Automatic Clip Composition Plan is scene/branch-heavy even
        // when it came from durable evidence outside the legacy reframe gate.
        // Keep it on the established safer per-output topology.
        Boolean(
          compositionPlan?.targets.some(
            (target) => target.effectiveMode === "auto",
          ),
        );

      if (!probe.hasVideo) {
        // Known divergence: audio-only sources render via buildAudiogramArgs,
        // which has no `background` param and always uses its own fixed
        // waveform-panel color (see its `bgColor` constant) — a canvas
        // background configured in studioEdits is silently ignored here even
        // though the studio preview still shows it for these sources. Not
        // fixed as part of vizard-parity.md Phase C item 2; revisit if
        // audiogram background support becomes a real ask.
        for (const output of outputs) {
          try {
            const ffmpegArgs = buildAudiogramArgs({
              sourcePath,
              outputPath: output.outputPath,
              startSec: clipStartSec,
              endSec: clipEndSec,
              aspectRatio: output.aspectRatio,
              clipDurationSec,
              srtPath: output.subtitlePath ?? srtPath,
              captionPreset,
              studioEdits,
              music: musicPlan,
              sfx: sfxPlans,
              resolution: output.resolution,
              watermark: output.watermark,
              cutPlan,
            });

            const encodeStartedAtMs = currentTimeMs();
            await executeRenderCommandWithOptionalFallback({
              primaryArgs: ffmpegArgs,
              fallbackArgs:
                musicPlan || sfxPlans.length > 0
                  ? () =>
                      buildAudiogramArgs({
                        sourcePath,
                        outputPath: output.outputPath,
                        startSec: clipStartSec,
                        endSec: clipEndSec,
                        aspectRatio: output.aspectRatio,
                        clipDurationSec,
                        srtPath: output.subtitlePath ?? srtPath,
                        captionPreset,
                        studioEdits,
                        music: null,
                        sfx: [],
                        resolution: output.resolution,
                        watermark: output.watermark,
                        cutPlan,
                      })
                  : undefined,
              optionalAssets: optionalCommandAssets.filter(
                ({ assetClass }) =>
                  assetClass === "music" || assetClass === "sound_effect",
              ),
              context: {
                workflowRunId: run.id,
                clipId: clip.id,
                clipRenderId: output.clipRenderId,
              },
            });
            // Upload runs in the bounded background queue (overlaps the next
            // clip's work). The stale-discard/`persisted` counting and the
            // upload-failure variant marking both live in `scheduleUpload`;
            // this catch now only ever sees ENCODE failures.
            scheduleUpload(output, {
              clipDurationSec,
              encodeMs: currentTimeMs() - encodeStartedAtMs,
            });
          } catch (error) {
            rethrowWorkflowAttemptLost(error);
            rethrowRenderCancellation(error);
            const errorCode =
              error instanceof WorkflowFailure
                ? error.code
                : "ffmpeg_render_failed";

            await currentRenderAdapters().clip.failClipRenderVariant(
              output.clipRenderId,
              errorCode,
              error instanceof WorkflowFailure
                ? error.disposition
                : "retryable",
            );

            log("error", "clip_render_variant_failed", {
              workflowRunId: run.id,
              clipId: output.clipId,
              clipRenderId: output.clipRenderId,
              clipIndex: output.clipIndex,
              aspectRatio: output.aspectRatio,
              code: errorCode,
              message:
                error instanceof Error ? error.message : "Unknown render error",
            });
          }
        }
      } else if (brollPlan || hasStudioVideoEdits) {
        // B-roll or other studio edits active: render each output individually
        // so each aspect ratio gets its own composited cutaway/text/fade/audio.
        const plan = brollPlan;
        const brollCredits =
          plan && plan.credits.length > 0 ? JSON.stringify(plan.credits) : null;
        for (const output of outputs) {
          const fullAutoSegmentsForOutput = autoLayoutSegmentsFull
            ? applySpeakerLayoutOverridesToSegments(
                autoLayoutSegmentsFull,
                studioEdits.speakerLayoutOverrides,
                output.aspectRatio,
              )
            : null;
          const noSplitAutoSegmentsForOutput = autoLayoutSegmentsNoSplit
            ? applySpeakerLayoutOverridesToSegments(
                autoLayoutSegmentsNoSplit,
                studioEdits.speakerLayoutOverrides,
                output.aspectRatio,
              )
            : null;
          const useLegacySplitFallback =
            requestedCompositionMode === "split" &&
            splitIneligibleOutputs.includes(output);
          const compositionForOutput =
            compositionPlan && !useLegacySplitFallback
              ? { plan: compositionPlan, targetId: output.clipRenderId }
              : null;
          const optionalAssetFallbackPlan =
            fallbackCompositionPlan ?? compositionPlan;
          const fallbackCompositionForOutput =
            optionalAssetFallbackPlan && !useLegacySplitFallback
              ? {
                  plan: optionalAssetFallbackPlan,
                  targetId: output.clipRenderId,
                }
              : null;
          try {
            const ffmpegArgs = plan
              ? buildBrollVideoArgs({
                  sourcePath,
                  cutaways: plan.cutaways,
                  outputPath: output.outputPath,
                  startSec: clipStartSec,
                  endSec: clipEndSec,
                  aspectRatio: output.aspectRatio,
                  probe,
                  srtPath: output.subtitlePath ?? srtPath,
                  captionPreset,
                  logo,
                  reframe: output.reframe,
                  composition: compositionForOutput,
                  split: fullAutoSegmentsForOutput
                    ? reframeOutputs.includes(output)
                      ? splitTilesAreDistinct(output.aspectRatio, probe)
                        ? { segments: fullAutoSegmentsForOutput }
                        : noSplitAutoSegmentsForOutput
                          ? { segments: noSplitAutoSegmentsForOutput }
                          : null
                      : null
                    : null,
                  studioEdits,
                  music: musicPlan,
                  sfx: sfxPlans,
                  background: backgroundPlan,
                  resolution: output.resolution,
                  watermark: output.watermark,
                  cutPlan,
                })
              : buildSingleVideoArgs({
                  sourcePath,
                  outputPath: output.outputPath,
                  startSec: clipStartSec,
                  endSec: clipEndSec,
                  aspectRatio: output.aspectRatio,
                  probe,
                  srtPath: output.subtitlePath ?? srtPath,
                  captionPreset,
                  logo,
                  reframe: output.reframe,
                  composition: compositionForOutput,
                  studioEdits,
                  music: musicPlan,
                  sfx: sfxPlans,
                  background: backgroundPlan,
                  // Split packet B: `splitPlan` is only ever non-null when
                  // `backgroundPlan` is null and `brollPlan` is null (fit
                  // wins as "fit" before `framing.mode` is read at all;
                  // b-roll always wins the fallback per `decideSplitFallback`
                  // above), so there's no ordering conflict with the
                  // `background` param above.
                  //
                  // H1 (adversarial review): gated PER OUTPUT, not just per
                  // clip — `splitIneligibleOutputs` (populated above) already
                  // got a `params.reframe`/center-crop fallback applied, so
                  // this output must NOT also receive `split` (which would
                  // render laterally-identical duplicate tiles for its
                  // aspect ratio).
                  //
                  // Layout-engine plans (auto mode) ride the same param:
                  // full plan for outputs that can seat two-up tiles, the
                  // demoted no-split variant otherwise (or none at all when
                  // that variant collapsed — those outputs already got the
                  // legacy reframe applied above).
                  split: fullAutoSegmentsForOutput
                    ? reframeOutputs.includes(output)
                      ? splitTilesAreDistinct(output.aspectRatio, probe)
                        ? { segments: fullAutoSegmentsForOutput }
                        : noSplitAutoSegmentsForOutput
                          ? { segments: noSplitAutoSegmentsForOutput }
                          : null
                      : null
                    : splitPlan && !splitIneligibleOutputs.includes(output)
                      ? { segments: splitPlan.segments }
                      : null,
                  // Screen packet B: `output.screenBottom` is only ever set
                  // by `applyScreenSpeakerLayout`, which only ever runs when
                  // `backgroundPlan`/`splitPlan` are both null (fit wins as
                  // "fit" before `framing.mode` is read; only one of split/
                  // screen's gates is ever active per clip) — no ordering
                  // conflict with `background`/`split` above. Unlike split,
                  // no per-output ineligibility filter is needed: a screen
                  // layout's two tiles are always distinct content (see
                  // screen-layout.ts's doc comment), and
                  // `applyScreenSpeakerLayout` sets every output's
                  // `screenBottom` (face-tracked or static-center) whenever
                  // it runs at all.
                  screen: output.screenBottom
                    ? { bottom: output.screenBottom }
                    : null,
                  resolution: output.resolution,
                  watermark: output.watermark,
                  cutPlan,
                });
            const encodeStartedAtMs = currentTimeMs();
            const commandMode = await executeRenderCommandWithOptionalFallback({
              primaryArgs: ffmpegArgs,
              fallbackArgs:
                optionalCommandAssets.length > 0
                  ? () =>
                      buildSingleVideoArgs({
                        sourcePath,
                        outputPath: output.outputPath,
                        startSec: clipStartSec,
                        endSec: clipEndSec,
                        aspectRatio: output.aspectRatio,
                        probe,
                        srtPath: output.subtitlePath ?? srtPath,
                        captionPreset,
                        logo: null,
                        reframe: output.reframe,
                        composition: fallbackCompositionForOutput,
                        studioEdits,
                        music: null,
                        sfx: [],
                        background: fallbackBackgroundPlan,
                        split: fullAutoSegmentsForOutput
                          ? reframeOutputs.includes(output)
                            ? splitTilesAreDistinct(output.aspectRatio, probe)
                              ? { segments: fullAutoSegmentsForOutput }
                              : noSplitAutoSegmentsForOutput
                                ? { segments: noSplitAutoSegmentsForOutput }
                                : null
                            : null
                          : splitPlan &&
                              !splitIneligibleOutputs.includes(output)
                            ? { segments: splitPlan.segments }
                            : null,
                        screen: output.screenBottom
                          ? { bottom: output.screenBottom }
                          : null,
                        resolution: output.resolution,
                        watermark: output.watermark,
                        cutPlan,
                      })
                  : undefined,
              optionalAssets: optionalCommandAssets,
              context: {
                workflowRunId: run.id,
                clipId: clip.id,
                clipRenderId: output.clipRenderId,
              },
            });
            // Bounded background upload — see `scheduleUpload`. This catch
            // now only ever sees encode/build failures.
            scheduleUpload(output, {
              clipDurationSec,
              brollCredits:
                commandMode === "primary" ? brollCredits : null,
              encodeMs: currentTimeMs() - encodeStartedAtMs,
            });
          } catch (error) {
            rethrowWorkflowAttemptLost(error);
            rethrowRenderCancellation(error);
            const errorCode =
              error instanceof WorkflowFailure
                ? error.code
                : "ffmpeg_render_failed";
            await currentRenderAdapters().clip.failClipRenderVariant(
              output.clipRenderId,
              errorCode,
              error instanceof WorkflowFailure
                ? error.disposition
                : "retryable",
            );
            log("error", "clip_render_variant_failed", {
              workflowRunId: run.id,
              clipId: output.clipId,
              clipRenderId: output.clipRenderId,
              clipIndex: output.clipIndex,
              aspectRatio: output.aspectRatio,
              code: errorCode,
              message:
                error instanceof Error ? error.message : "Unknown render error",
            });
          }
        }
      } else {
        try {
          const ffmpegArgs =
            outputs.length === 1
              ? buildSingleVideoArgs({
                  sourcePath,
                  outputPath: outputs[0]!.outputPath,
                  startSec: clipStartSec,
                  endSec: clipEndSec,
                  aspectRatio: outputs[0]!.aspectRatio,
                  probe,
                  srtPath: outputs[0]!.subtitlePath ?? srtPath,
                  captionPreset,
                  logo,
                  reframe: outputs[0]!.reframe,
                  composition: compositionPlan
                    ? {
                        plan: compositionPlan,
                        targetId: outputs[0]!.clipRenderId,
                      }
                    : null,
                  resolution: outputs[0]!.resolution,
                  watermark: outputs[0]!.watermark,
                })
              : buildMultiVideoArgs({
                  sourcePath,
                  outputs,
                  startSec: clipStartSec,
                  endSec: clipEndSec,
                  probe,
                  srtPath,
                  captionPreset,
                  logo,
                  composition: compositionPlan,
                  watermark: outputs[0]!.watermark,
                });

          const encodeStartedAtMs = currentTimeMs();
          await executeRenderCommandWithOptionalFallback({
            primaryArgs: ffmpegArgs,
            fallbackArgs:
              logo
                ? () =>
                    outputs.length === 1
                      ? buildSingleVideoArgs({
                          sourcePath,
                          outputPath: outputs[0]!.outputPath,
                          startSec: clipStartSec,
                          endSec: clipEndSec,
                          aspectRatio: outputs[0]!.aspectRatio,
                          probe,
                          srtPath: outputs[0]!.subtitlePath ?? srtPath,
                          captionPreset,
                          logo: null,
                          reframe: outputs[0]!.reframe,
                          composition: compositionPlan
                            ? {
                                plan: compositionPlan,
                                targetId: outputs[0]!.clipRenderId,
                              }
                            : null,
                          resolution: outputs[0]!.resolution,
                          watermark: outputs[0]!.watermark,
                        })
                      : buildMultiVideoArgs({
                          sourcePath,
                          outputs,
                          startSec: clipStartSec,
                          endSec: clipEndSec,
                          probe,
                          srtPath,
                          captionPreset,
                          logo: null,
                          composition: compositionPlan,
                          watermark: outputs[0]!.watermark,
                        })
                : undefined,
            optionalAssets: optionalCommandAssets.filter(
              ({ assetClass }) => assetClass === "logo",
            ),
            context: { workflowRunId: run.id, clipId: clip.id },
          });
          const sharedEncodeMs = currentTimeMs() - encodeStartedAtMs;

          // Bounded background uploads — per-output failure marking (the
          // former inline try/catch here) lives in `scheduleUpload`.
          for (const output of outputs) {
            scheduleUpload(output, {
              clipDurationSec,
              encodeMs: sharedEncodeMs,
            });
          }
        } catch (error) {
          rethrowWorkflowAttemptLost(error);
          rethrowRenderCancellation(error);
          const errorCode =
            error instanceof WorkflowFailure
              ? error.code
              : "ffmpeg_render_failed";

          await Promise.all(
            outputs.map((output) =>
              currentRenderAdapters().clip.failClipRenderVariant(
                output.clipRenderId,
                errorCode,
                error instanceof WorkflowFailure
                  ? error.disposition
                  : "retryable",
              ),
            ),
          );

          log("error", "clip_render_group_failed", {
            workflowRunId: run.id,
            clipId: clip.id,
            clipIndex: clip.index,
            aspectRatios: outputs.map((output) => output.aspectRatio),
            code: errorCode,
            message:
              error instanceof Error ? error.message : "Unknown render error",
          });
        }
      }

      const progress = 10 + Math.round(((clipGroupIndex + 1) / clipGroups.length) * 80);
      await currentRenderAdapters().project.publishWorkflowProgress({
        projectId: run.projectId,
        workflowRunId: run.id,
        stage: "clip_rendering",
        status: "running",
        progress,
        errorCode: null,
      });
    }

    // Settle every in-flight upload before reading `renderedVariantCount` —
    // the all-failed check and run completion below must see the final
    // truth, and completeClipRenderingWorkflowRun must never race a
    // completeClipRenderVariant write.
    const drainStartedAtMs = currentTimeMs();
    await uploadQueue.drain();
    signal.throwIfAborted();
    log("info", "clip_render_upload_drain", {
      workflowRunId: run.id,
      projectId: run.projectId,
      scheduledUploads: uploadQueue.scheduledCount(),
      drainMs: currentTimeMs() - drainStartedAtMs,
    });

    settlementStarted = true;
    const outcome = await lifecycle.settleRenderWorkSet(attempt);

    log("info", "clip_rendering_run_completed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      totalClipGroups: clipGroups.length,
      totalVariantCount: pendingRenders.length,
      renderedVariantCount,
      failedVariantCount: pendingRenders.length - renderedVariantCount,
      totalMs: currentTimeMs() - runStartedAtMs,
      sourceMode: isHttpSource(sourcePath) ? "ranged" : "download",
      encoder: "libx264",
      preset: x264Preset(),
      status: outcome.status,
      supersededVariantCount: outcome.superseded,
      followUpWorkflowRunId: outcome.followUpWorkflowRunId,
    });
    return outcome;
  } catch (error) {
    if (error instanceof WorkflowAttemptLost) {
      abortAttempt(error);
      throw error;
    }
    rethrowRenderCancellation(error);
    if (settlementStarted) throw error;
    if (uploadQueueRef) {
      await uploadQueueRef.drain();
    }
    const failure = workflowFailureFromUnknown(error);
    const code = failure.code;

    const message =
      error instanceof Error ? error.message : "Unknown worker error";
    for (const clipRenderId of workSetVariantIds) {
      await currentRenderAdapters().clip.markClipRenderVariantRendering(
        clipRenderId,
      );
      await currentRenderAdapters().clip.failClipRenderVariant(
        clipRenderId,
        code,
        failure.disposition,
      );
    }

    log("error", "clip_rendering_run_failed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      code,
      message,
    });
    const outcome = await lifecycle.settleRenderWorkSet(attempt);
    return outcome;
  } finally {
    // A failure path can reach here with uploads still in flight (their
    // output files live in tempDir) — settle them before deleting it, so a
    // late-succeeding upload can't read a half-deleted file. Idempotent on
    // the success path (already drained above). Never let a drain error
    // block cleanup.
    if (uploadQueueRef) await uploadQueueRef.drain().catch(() => {});
    await currentRenderAdapters()
      .workspace.rm(tempDir, { recursive: true, force: true })
      .catch((error) => {
        for (const assetClass of touchedOptionalAssetClasses) {
          diagnoseOptionalAssetFallback({
            assetClass,
            phase: "cleanup",
            failureCode: "optional_asset_cleanup_failed",
            context: { workflowRunId: run.id, projectId: run.projectId },
          });
        }
        log("error", "clip_render_workspace_cleanup_failed", {
          workflowRunId: run.id,
          projectId: run.projectId,
          phase: "cleanup",
          operation: "workspace_remove",
          errorCode:
            error instanceof Error ? error.name : "workspace_remove_failed",
        });
      });
  }
}
