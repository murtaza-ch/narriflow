import { AsyncLocalStorage } from "node:async_hooks";
import {
  createWriteStream as productionCreateWriteStream,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline as productionPipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { getPrismaClient } from "@narriflow/db/client";
import {
  automaticLayoutInputFingerprint,
  compositionAssetRef,
  planClipComposition,
  screenLayoutInputFingerprint,
  splitLayoutInputFingerprint,
  type ClipCompositionPlan,
  type CompositionCaptionVisualLayer,
  type CompositionEvidenceAvailability,
  type CompositionMode,
  type ScreenLayoutEvidence,
  type ScreenLayoutFailureReason,
  type SplitLayoutEvidence,
  type SplitLayoutFailureReason,
} from "@narriflow/composition-plan";
import {
  assertPublicHttpUrl,
  assertResponseContentLength,
  analyticsService,
  audioAssetService as productionAudioAssetService,
  clipService as productionClipService,
  createByteLimitTransform,
  decodeClipEditorDocumentFromStorage,
  deleteObject as productionDeleteObject,
  downloadObjectToFile as productionDownloadObjectToFile,
  guardedFetch as productionGuardedFetch,
  getWorkflowRunLifecycle,
  hasFeature,
  motionRenderAnalyticsMetadata,
  presignDownloadUrl as productionPresignDownloadUrl,
  putFileFromPath as productionPutFileFromPath,
  rethrowWorkflowAttemptLost,
  RemoteFetchError,
  UnsafeUrlError,
  WorkflowAttemptLost,
  WorkflowFailure,
  workflowFailureFromUnknown,
  workflowHttpFailureDisposition,
  type GuardedFetchOptions,
  type MotionRenderAnalyticsMetadata,
  type RenderWorkSetOutcome,
  type WorkflowAttemptContext,
  type WorkflowAttemptRef,
} from "@narriflow/services";
import {
  AUDIO_UPLOAD_MAX_BYTES,
  brandTemplateSnapshotSchema,
  brollCuesArraySchema,
  CAPTION_CHUNK_SIZE,
  CAPTION_POSITION_Y_DEFAULTS,
  CATEGORY_BROLL_FALLBACK_QUERY,
  emojiForWord,
  clipAspectRatioDbSchema,
  clipAspectRatioFromDb,
  clipAspectRatioOptions,
  clipAutoLayoutAnalysisSchema,
  clipSplitLayoutFailureSchema,
  clipLayoutAnalysisV2Schema,
  clipLayoutAnalysisFailureSchema,
  clipAutoLayoutMatchesInputs,
  clipRenderResolutionSchema,
  formatCaptionWord,
  getEffectiveClipTiming,
  normalizeTranscriptSliceForClip,
  parseClipAutoLayoutAnalysis,
  parseClipSplitLayoutAnalysis,
  parseClipLayoutAnalysis,
  resolveEffectiveFramingMode,
  resolveEffectiveLogoSettings,
  resolveSpeakerLayoutScene,
  SCREEN_LAYOUT_ENGINE_VERSION,
  sourceRangeToEdited,
  sourceToEdited,
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
  EditorDocument,
  EditedTimeMap,
  StudioEdits,
  StudioSpeakerLayoutOverride,
  TranscriptUtterance,
} from "@narriflow/validators";
import { buildClipCutPlan, type ClipCutPlan } from "./cut-plan";
import {
  buildAutoLayoutPlan,
  speechWordsFromUtterances,
} from "./layout-engine";
import {
  remapFaceSamplesForCutPlan,
  smoothFacePath,
  type FaceSample,
  type SmoothedSample,
} from "./reframe";
import {
  buildSplitLayoutPlan,
  deriveSingleFaceSamplesFromMulti,
  remapMultiFaceSamplesForCutPlan,
  type BuildSplitLayoutPlanResult,
  type MultiFaceSample,
  type SplitLayoutSegment,
} from "./two-up";
import {
  classifyScreencast,
  confirmsFaceInRect,
  selectPipRect,
  type PipCandidate,
  type PipRect,
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
  HTTP_SOURCE_RW_TIMEOUT_US,
  ProductionRenderMediaAdapter,
  productionRenderMediaAdapter,
  type RenderMediaProbe,
} from "../render-media-adapter";
import { productionRenderDiagnosticAdapter } from "../render-diagnostic-adapter";
import {
  bindCompositionPlanAudioInputs,
  compileCompositionPlanAudiogram,
  compileCompositionPlanAudioSchedule,
  compileCompositionPlanInsertedSceneSequence,
  compileCompositionPlanSceneAudio,
  compileCompositionPlanVideo,
  compileCompositionPlanVisualLayers,
  type BoundCompositionAudioRenderRequest,
} from "../composition-ffmpeg-adapter";
import { escapeDrawtextText } from "../ffmpeg-text";
import { classifyRenderObjectKey } from "../render-object-key";
import {
  productionRenderClockAdapter,
  productionRenderWorkspaceAdapter,
  type RenderClockAdapter,
  type RenderWorkspaceAdapter,
} from "../render-runtime-adapters";

interface BrollCutaway {
  ref: string;
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

interface ResolvedMusicAsset {
  path: string;
  ref: string;
  durationSec?: number;
}

/**
 * One resolved, downloaded SFX asset binding. Composition policy such as
 * edited-time placement and gain remains exclusively in the plan.
 */
interface ResolvedSfxAsset {
  path: string;
  id: string;
  ref: string;
  durationSec: number;
}

/**
 * Resolved per-clip canvas background (vizard-parity.md Phase C item 2) —
 * built once per clip render (see the main flow below, mirroring how
 * `ResolvedMusicAsset` is resolved from `studioEdits.music`) and threaded into
 * whichever per-output builder actually runs. `color` is always populated
 * (falls back to black) so it doubles as the mode="image" fallback when the
 * image URL was invalid or its download failed upstream. `imagePath` is the
 * local downloaded file, set only when mode="image" AND the download
 * actually succeeded. The composition plan compiler falls back to the solid
 * color whenever it's null, so a bad image URL degrades gracefully.
 */
interface BackgroundPlan {
  mode: "color" | "image";
  color: string;
  imagePath: string | null;
}

interface LogoOverlay {
  filePath: string;
  ref: string;
  position: BrandTemplateSnapshot["logoPosition"];
  opacity: number;
  scalePct: number;
}

/**
 * Merge a clip's `studioEdits.logo` override over the base logo overlay
 * (built once per project from the frozen brand snapshot + downloaded logo
 * file, see `brandLogo` below) via the shared `resolveEffectiveLogoSettings`
 * helper — the same one the studio preview overlay uses, so burn-in and
 * preview can't fork (vizard-parity.md Phase A step 6). `base: null` (no
 * logo asset at all, e.g. no snapshot/no logoStorageKey)
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
    ref: base.ref,
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

export function sceneAssetOwnerWhere(input: {
	projectUserId: string;
	workspaceId: string | null;
	workspace: { personalOwnerUserId: string | null; pricingTier: string } | null;
}) {
	if (
		input.workspace?.personalOwnerUserId &&
		input.workspace.pricingTier !== "business"
	) {
		return { userId: input.workspace.personalOwnerUserId, workspaceId: null };
	}
	return input.workspaceId
		? { workspaceId: input.workspaceId }
		: { userId: input.projectUserId, workspaceId: null };
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

type CompositionPeakRssScope =
  | "worker_and_command_cgroup"
  | "worker_and_command_processes"
  | "worker_only";

interface CompositionResourceMeasurement {
  rssBytes: number;
  scope: CompositionPeakRssScope;
}

interface ClipRenderAttemptAdapters {
  media: Pick<typeof productionRenderMediaAdapter, "probe">;
  process: Pick<typeof productionRenderProcessAdapter, "execute">;
  state: Pick<
    typeof productionClipService,
    "getFrozenRenderingStateForWorkSet"
  >;
  project: {
    reportProgress(attempt: WorkflowAttemptRef, progress: number): Promise<void>;
  };
  clip: {
    markClipRenderVariantRendering(
      attempt: WorkflowAttemptRef,
      clipRenderId: string,
    ): Promise<boolean>;
    completeClipRenderVariant(
      attempt: WorkflowAttemptRef,
      clipRenderId: string,
      input: {
        storageKey: string;
        sizeBytes: number;
        durationSec: number;
        motionAnalytics?: MotionRenderAnalyticsMetadata;
      },
    ): Promise<{ persisted: boolean }>;
    failClipRenderVariant(
      attempt: WorkflowAttemptRef,
      clipRenderId: string,
      errorCode: string,
      disposition?: "retryable" | "permanent",
      motionAnalytics?: MotionRenderAnalyticsMetadata,
    ): Promise<void>;
    completeClipAutoLayoutAnalysis(
      attempt: WorkflowAttemptRef,
      clipId: string,
      analysis: unknown,
      expected: { editorRevision: number; previewStorageKey: string },
    ): Promise<boolean>;
    completeClipSplitLayoutAnalysis(
      attempt: WorkflowAttemptRef,
      clipId: string,
      analysis: unknown,
      expected: { editorRevision: number; previewStorageKey: string },
    ): Promise<boolean>;
    completeClipSplitLayoutFailure(
      attempt: WorkflowAttemptRef,
      clipId: string,
      failure: unknown,
      expected: { editorRevision: number; previewStorageKey: string },
    ): Promise<boolean>;
    setClipLayoutAnalysis(
      attempt: WorkflowAttemptRef,
      clipId: string,
      analysis: unknown,
      expected: { editorRevision: number; previewStorageKey: string },
    ): Promise<void>;
    setClipLayoutAnalysisFailure(
      attempt: WorkflowAttemptRef,
      clipId: string,
      failure: unknown,
      expected: { editorRevision: number; previewStorageKey: string },
    ): Promise<void>;
  };
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
  resource: {
    measure(): CompositionResourceMeasurement;
  };
  composition: {
    compileVideo: typeof compileCompositionPlanVideo;
    compileSceneAudio: typeof compileCompositionPlanSceneAudio;
    compileVisualLayers: typeof compileCompositionPlanVisualLayers;
  };
  diagnose(input: {
    level: "info" | "error";
    message: string;
    context?: Record<string, unknown>;
  }): void;
}

type ClipRenderAttemptAdapterOverrides = Partial<
  Omit<
    ClipRenderAttemptAdapters,
    "analysis" | "clip" | "composition" | "optionalAssets" | "storage" | "workspace" | "clock" | "resource"
  >
> & {
  analysis?: Partial<ClipRenderAttemptAdapters["analysis"]>;
  clip?: Partial<ClipRenderAttemptAdapters["clip"]>;
  optionalAssets?: Partial<ClipRenderAttemptAdapters["optionalAssets"]>;
  storage?: Partial<ClipRenderAttemptAdapters["storage"]>;
  workspace?: Partial<ClipRenderAttemptAdapters["workspace"]>;
  clock?: Partial<ClipRenderAttemptAdapters["clock"]>;
  resource?: Partial<ClipRenderAttemptAdapters["resource"]>;
  composition?: Partial<ClipRenderAttemptAdapters["composition"]>;
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
  /** Target resolution for this specific render row (vizard-parity Phase C
   *  export options) — read off the ClipRender row, already entitlement-
   *  clamped by clip.service's triggerClipRendering/autoQueueDefaultRenders.
   *  Drives the per-output 2/3 downscale; independent of the watermark,
   *  which is a run-level entitlement (see `applyWatermark` below). */
  resolution: ClipRenderResolution;
  watermark: boolean;
}


interface RenderExecutionContext {
  config: Readonly<RenderConfig>;
  signal: AbortSignal;
  adapters: ClipRenderAttemptAdapters;
}

const renderExecutionStorage = new AsyncLocalStorage<RenderExecutionContext>();
const defaultRenderConfig = parseRenderConfig({});
// ClipService methods live on the class prototype. Keep a plain adapter
// object here because ClipRenderAttempt merges partial test overrides with
// object spread; spreading the service instance itself drops every prototype
// method and only fails in a real worker process.
const productionClipMutationAdapter: ClipRenderAttemptAdapters["clip"] = {
  markClipRenderVariantRendering: (attempt, clipRenderId) =>
    getWorkflowRunLifecycle().markClipRenderVariantRendering(
      attempt,
      clipRenderId,
    ),
  completeClipRenderVariant: async (attempt, clipRenderId, input) => {
    const persisted = await getWorkflowRunLifecycle().completeClipRenderVariant(
      attempt,
      clipRenderId,
      input,
    );
    if (persisted) {
      await recordRenderAnalytics(clipRenderId, "completed", input.motionAnalytics);
    }
    return { persisted };
  },
  failClipRenderVariant: async (
    attempt,
    clipRenderId,
    errorCode,
    disposition = "retryable",
    motionAnalytics,
  ) => {
    const persisted = await getWorkflowRunLifecycle().failClipRenderVariant(
      attempt,
      clipRenderId,
      errorCode,
      disposition,
    );
    if (persisted) {
      await recordRenderAnalytics(clipRenderId, "failed", motionAnalytics);
    }
  },
  completeClipAutoLayoutAnalysis: (attempt, clipId, analysis, expected) =>
    getWorkflowRunLifecycle().completeClipAutoLayoutAnalysis(attempt, {
      clipId,
      analysis: analysis as never,
      ...expected,
    }),
  completeClipSplitLayoutAnalysis: (attempt, clipId, analysis, expected) =>
    getWorkflowRunLifecycle().completeClipSplitLayoutAnalysis(attempt, {
      clipId,
      analysis: analysis as never,
      ...expected,
    }),
  completeClipSplitLayoutFailure: (attempt, clipId, failure, expected) =>
    getWorkflowRunLifecycle().completeClipSplitLayoutFailure(attempt, {
      clipId,
      failure: failure as never,
      ...expected,
    }),
  setClipLayoutAnalysis: async (attempt, clipId, analysis, expected) => {
    await getWorkflowRunLifecycle().setClipLayoutAnalysis(attempt, {
      clipId,
      analysis: analysis as never,
      ...expected,
    });
  },
  setClipLayoutAnalysisFailure: async (attempt, clipId, failure, expected) => {
    await getWorkflowRunLifecycle().setClipLayoutAnalysisFailure(attempt, {
      clipId,
      failure: failure as never,
      ...expected,
    });
  },
};

async function recordRenderAnalytics(
  clipRenderId: string,
  outcome: "completed" | "failed",
  motionAnalytics?: MotionRenderAnalyticsMetadata,
) {
  const prisma = getPrismaClient();
  if (!prisma) return;
  const render = await prisma.clipRender.findUnique({
    where: { id: clipRenderId },
    select: {
      aspectRatio: true,
      clipId: true,
      clip: { select: { projectId: true } },
    },
  });
  if (!render) return;
  const events = [];
  if (outcome === "completed") {
    events.push(
      analyticsService.recordProjectEvent({
        projectId: render.clip.projectId,
        clipId: render.clipId,
        type: "render_completed",
        metadata: { aspectRatio: render.aspectRatio },
      }),
    );
  }
  if (motionAnalytics && motionAnalytics.targetCount > 0) {
    events.push(
      analyticsService.recordProjectEvent({
        projectId: render.clip.projectId,
        clipId: render.clipId,
        type: "motion_render_outcome",
        metadata: {
          aspectRatio: render.aspectRatio,
          ...motionAnalytics,
          renderOutcome: outcome,
        },
      }),
    );
  }
  await Promise.all(events).catch((error) => {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "render_analytics_record_failed",
        projectId: render.clip.projectId,
        clipId: render.clipId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
}

function measureCompositionResource(): CompositionResourceMeasurement {
  if (process.platform === "linux") {
    try {
      const cgroupBytes = Number(
        readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim(),
      );
      if (Number.isFinite(cgroupBytes) && cgroupBytes > 0) {
        return {
          rssBytes: cgroupBytes,
          scope: "worker_and_command_cgroup",
        };
      }
    } catch {
      // Non-cgroup hosts are measured as the worker plus active command.
    }
  }
  return {
    rssBytes: process.memoryUsage().rss,
    scope:
      process.platform === "win32"
        ? "worker_only"
        : "worker_and_command_processes",
  };
}

const productionClipRenderAttemptAdapters: ClipRenderAttemptAdapters = {
  media: productionRenderMediaAdapter,
  process: productionRenderProcessAdapter,
  state: productionClipService,
  project: {
    reportProgress: (attempt, progress) =>
      getWorkflowRunLifecycle().reportProgress(attempt, progress),
  },
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
  resource: {
    measure: measureCompositionResource,
  },
  composition: {
    compileVideo: compileCompositionPlanVideo,
    compileSceneAudio: compileCompositionPlanSceneAudio,
    compileVisualLayers: compileCompositionPlanVisualLayers,
  },
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

function compositionContractFailure(error: unknown): WorkflowWorkerError | null {
  if (!(error instanceof Error)) return null;
  if (
    !error.message.startsWith("invalid_clip_composition_") &&
    !error.message.startsWith("clip_composition_") &&
    error.message !== "unsupported_clip_composition_plan_version"
  ) {
    return null;
  }
  return new WorkflowWorkerError(
    "invalid_clip_composition_plan",
    `Clip Composition Plan adapter rejected ${error.message}`,
    "permanent",
  );
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
  try {
    currentRenderAdapters().diagnose({
      level,
      message,
      context: sanitizeRenderDiagnosticValue(context) as
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
  log("error", "clip_render_optional_asset_fallback", {
    ...input.context,
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

function commandSizeBytes(command: string, args: readonly string[]): number {
  const encoder = new TextEncoder();
  return [command, ...args].reduce(
    (total, value) => total + encoder.encode(value).byteLength + 1,
    0,
  );
}

function assertCompositionCommandWithinBudget(
  args: readonly string[],
  context: Record<string, unknown>,
): void {
  const measuredBytes = commandSizeBytes("ffmpeg", args);
  const maximumBytes = currentRenderConfig().compositionCommandMaxBytes;
  if (measuredBytes <= maximumBytes) return;
  log("error", "clip_composition_budget_rejected", {
    ...context,
    phase: "composition_command",
    failureCode: "composition_command_budget_exceeded",
    disposition: "permanent",
    budget: "command_bytes",
    measured: measuredBytes,
    maximum: maximumBytes,
    commandGrouping: "independent",
  });
  throw new WorkflowWorkerError(
    "composition_command_budget_exceeded",
    "Clip Composition Plan command exceeds the configured byte budget",
    "permanent",
  );
}

function startCompositionResourceSampling(
  record?: (rssBytes: number) => void,
): () => void {
  if (!record) return () => {};
  const clock = currentRenderAdapters().clock;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sample = () => {
    if (!active) return;
    const measurement = measureCompositionResourceSafely();
    if (measurement) {
      recordCompositionResourceSampleSafely(record, measurement.rssBytes);
    }
    timer = clock.setTimeout(sample, 100);
  };
  sample();
  return () => {
    active = false;
    if (timer) clock.clearTimeout(timer);
    const measurement = measureCompositionResourceSafely();
    if (measurement) {
      recordCompositionResourceSampleSafely(record, measurement.rssBytes);
    }
  };
}

const resourceMeasurementFallback: CompositionResourceMeasurement = {
  rssBytes: 0,
  scope: "worker_only",
};

function diagnoseCompositionResourceFailure(
  failureCode: "resource_probe_failed" | "resource_record_failed",
): void {
  log(
    "error",
    failureCode === "resource_probe_failed"
      ? "clip_composition_resource_probe_failed"
      : "clip_composition_resource_record_failed",
    {
      phase: "diagnostics",
      failureCode,
      disposition: "degraded",
    },
  );
}

function measureCompositionResourceSafely():
  | CompositionResourceMeasurement
  | null {
  try {
    const measurement = currentRenderAdapters().resource.measure();
    if (
      !Number.isFinite(measurement.rssBytes) ||
      measurement.rssBytes < 0
    ) {
      throw new Error("invalid resource measurement");
    }
    return measurement;
  } catch {
    diagnoseCompositionResourceFailure("resource_probe_failed");
    return null;
  }
}

function recordCompositionResourceSampleSafely(
  record: ((rssBytes: number) => void) | undefined,
  rssBytes: number,
): void {
  if (!record) return;
  try {
    record(rssBytes);
  } catch {
    diagnoseCompositionResourceFailure("resource_record_failed");
  }
}

async function executeRenderCommandWithOptionalFallback(input: {
  primaryArgs: string[];
  fallbackArgs?: () => string[];
  optionalAssets: Array<{
    assetClass: OptionalAssetClass;
    failureCode: string;
  }>;
  context: Record<string, unknown>;
  recordCommand?: (args: readonly string[]) => void;
  recordSourceDecodeCompleted?: () => void;
  recordResourceSample?: (rssBytes: number) => void;
}): Promise<"primary" | "fallback"> {
  const execute = async (args: string[]): Promise<void> => {
    assertCompositionCommandWithinBudget(args, input.context);
    input.recordCommand?.(args);
    const safeRecordResourceSample = input.recordResourceSample
      ? (rssBytes: number): void =>
          recordCompositionResourceSampleSafely(
            input.recordResourceSample,
            rssBytes,
          )
      : undefined;
    const stopSampling = startCompositionResourceSampling(
      safeRecordResourceSample,
    );
    try {
      await execCommand("ffmpeg", args, {
        recordResourceSample: safeRecordResourceSample,
      });
      input.recordSourceDecodeCompleted?.();
    } finally {
      stopSampling();
    }
  };
  try {
    await execute(input.primaryArgs);
    return "primary";
  } catch (error) {
    rethrowRenderControlFlow(error);
    if (!input.fallbackArgs || input.optionalAssets.length === 0) throw error;
    const fallbackArgs = input.fallbackArgs();
    await execute(fallbackArgs);
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
  options: {
    timeoutMs: number;
    captureStdout: boolean;
    recordResourceSample?: (rssBytes: number) => void;
  },
): Promise<string> {
  const config = currentRenderConfig();
  return currentRenderAdapters().process.execute({
    command,
    args,
    signal: currentRenderSignal() ?? new AbortController().signal,
    deadlineMs: options.timeoutMs,
    killGraceMs: config.processKillGraceMs,
    captureStdout: options.captureStdout,
    recordResourceSample: options.recordResourceSample,
    diagnose: diagnoseRenderProcessOperation,
  });
}

function diagnoseRenderProcessOperation(event: RenderProcessDiagnostic): void {
  log(
    event.status === "failed" ? "error" : "info",
    "clip_render_command_operation",
    {
      phase: "command_execution",
      ...event,
    },
  );
}

async function execCommand(
  command: string,
  args: string[],
  options?: {
    timeoutMs?: number;
    recordResourceSample?: (rssBytes: number) => void;
  },
) {
  await runCommand(command, args, {
    timeoutMs:
      options?.timeoutMs ?? currentRenderConfig().renderCommandTimeoutMs,
    captureStdout: false,
    recordResourceSample: options?.recordResourceSample,
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
    recordResourceSample: undefined,
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

/** M6 (adversarial review): every reason `decidePipUsage` can return —
 *  `"ok"` means every gate passed and the caller should prefer the PiP
 *  crop; anything else means fall through to the existing band (face-
 *  tracked sendcmd or static-center) behavior. Ordered top-to-bottom the
 *  same way `decidePipUsage` itself checks them (first blocking reason
 *  wins) — see that function's own doc comment for what each one means. */
export type PipUsageReason =
  | "segment_extract_failed"
  | "detection_unavailable"
  | "insufficient_samples"
  | "not_screencast_like"
  | "no_candidate"
  | "face_not_in_rect"
  | "ok";

export interface DecidePipUsageParams {
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
}

/**
 * Pure, ordered PiP decision matrix. Target-specific crop geometry belongs
 * to the composition planner.
 *
 * Ordered top-to-bottom, first blocking reason wins:
 *  1. `segment_extract_failed` — `extractFaceDetectionSegment` failed (HTTP
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
 *  8. `ok` — every gate passed; the caller should use the PiP crop.
 */
export function decidePipUsage(
  params: DecidePipUsageParams,
): { useRect: boolean; reason: PipUsageReason } {
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
 * fails, the stale envelope is simply not read, and fresh identity-complete
 * evidence is persisted after all Screen facts are resolved. The
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
  detectInput: { path: string; startSec: number } | null;
  /** The clip's real source-time detection window — written into a freshly
   *  persisted envelope's `sourceStartSec`/`sourceDurationSec` (see
   *  `layoutAnalysisMatchesWindow`'s doc comment for why this, not
   *  `detectInput.startSec`). */
  startSec: number;
  durationSec: number;
  detect: (params: {
    sourcePath: string;
    startSec: number;
    durationSec: number;
  }) => Promise<PipDetectionResult | null>;
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
 * into one dependency-injected, unit-testable function. Persistence belongs
 * to the caller after PiP and face-band facts are conclusive, so only the
 * identity-complete Screen envelope can ever be written.
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

  if (!params.detectInput) {
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
  // Select the candidate before the caller performs face confirmation and
  // constructs the identity-complete Screen evidence envelope.
  const selectedRect = selectPipRect(pip.candidates);

  return { detectionResult, selectedRect, candidateCount, analysisSource: "fresh" };
}

/** Converts detected face motion into bounded Screen face-band evidence for
 * the composition planner. */
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

/** Why Screen evidence is unavailable for this clip. `disabled` is never returned BY
 *  `decideScreenFallback` itself — it short-circuits before the function is
 *  even called (the `WORKER_SCREEN_LAYOUT=0` kill switch), same pattern as
 *  split's own `disabled` reason. */
export type ScreenFallbackReason = "disabled" | "broll_conflict" | null;

/**
 * Pure Screen evidence fallback decision. B-roll currently wins because its
 * placement occupies the full composition; unlike Split, Screen has no
 * detection-availability or cluster-count fallback, since an
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

/** Serializes the caption schedule already owned by the composition plan.
 * No transcript filtering, chunking, formatting, or timing decisions are
 * allowed here: video exports must render the exact cues Studio previews. */
export function generateAssFromCompositionCaptionLayers(input: {
  layers: readonly CompositionCaptionVisualLayer[];
  canvas: { width: number; height: number };
}): string {
  const layer = input.layers[0];
  if (!layer) return "";
  const captionPreset = layer.preset;
  const fontName = resolveFontName(captionPreset.fontName);
  const fontSize =
    captionPreset.fontSize ??
    Math.round(input.canvas.width * (72 / 1080));
  const primaryColor = hexToAssColor(captionPreset.primaryColor ?? "#FFFFFF");
  const highlightColor = hexToAssColor(captionPreset.highlightColor ?? "#00FF88");
  const outlineColor = hexToAssColor(captionPreset.outlineColor ?? "#000000");
  const bold = captionPreset.bold !== false ? -1 : 0;
  const outlineWidth = captionPreset.outlineWidth ?? 2;
  const shadow = captionPreset.shadow ?? 1;
  const spacing = Math.round((captionPreset.letterSpacing ?? 0) * fontSize);
  let borderStyle = 1;
  let backColour = "&H00000000";
  if (captionPreset.backgroundColor) {
    borderStyle = 3;
    backColour = hexToAssColor(
      captionPreset.backgroundColor,
      assAlphaHex(captionPreset.backgroundOpacity ?? 0.6),
    );
  }
  let glowOverride = "";
  if (captionPreset.glowColor) {
    const intensity = captionPreset.glowIntensity ?? 8;
    glowOverride =
      `\\4c${hexToAssColor(captionPreset.glowColor)}&` +
      `\\shad${Math.max(1, Math.round(intensity / 4))}` +
      `\\blur${Math.max(1, Math.round(intensity / 2))}`;
  }
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
    `PlayResX: ${input.canvas.width}`,
    `PlayResY: ${input.canvas.height}`,
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
  const renderWord = (word: string, active: boolean): string => {
    if (!active) return word;
    if (hasHighlightBox) {
      return (
        `{\\1c${highlightColor}&\\bord${boxBord}\\3c${boxColor}&\\3a&H${boxAlpha}&}` +
        `${word}` +
        `{\\1c${primaryColor}&\\bord${outlineWidth}\\3c${outlineColor}&\\3a&H00&}`
      );
    }
    return `{\\1c${highlightColor}&}${word}{\\1c${primaryColor}&}`;
  };
  const entrance = (): string => {
    let value = "\\fad(60,0)";
    if (
      animation === "grow" ||
      animation === "bounce" ||
      animation === "seamless-bounce" ||
      animation === "soft-landing"
    ) {
      value += "\\fscx82\\fscy82\\t(0,160,\\fscx100\\fscy100)";
    } else if (animation === "blur-in" && !captionPreset.glowColor) {
      value += "\\blur6\\t(0,200,\\blur0)";
    }
    return value;
  };
  const events: string[] = [];
  for (const cue of input.layers) {
    const posXPx = Math.round((cue.anchor.xPct / 100) * input.canvas.width);
    const posYPx = Math.round((cue.anchor.yPct / 100) * input.canvas.height);
    cue.words.forEach((activeWord, activeIndex) => {
      const text = cue.words
        .map((word, index) => {
          const rendered = renderWord(word.text, index === activeIndex);
          return word.emoji ? `${rendered} ${word.emoji}` : rendered;
        })
        .join(" ");
      const override =
        `\\an5\\pos(${posXPx},${posYPx})${glowOverride}` +
        (activeIndex === 0 ? entrance() : "");
      events.push(
        `Dialogue: 0,${formatAssTimestamp(activeWord.startSec)},${formatAssTimestamp(activeWord.endSec)},Default,,0,0,0,,{${override}}${text}`,
      );
    });
  }
  return header + "\n" + events.join("\n") + "\n";
}

/** #RRGGBB -> 0xRRGGBB for the ffmpeg `color` / `showwaves` filters. */
function hexToFfmpegRgb(hex: string): string {
  return `0x${hex.replace("#", "").slice(0, 6)}`;
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
 * input (e.g. planned visual layers and B-roll `between(t,...)`
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

function buildAudioFadeChain(
  fades: BoundCompositionAudioRenderRequest["outputFades"],
) {
  const fadeInDuration = fades.fadeIn.endSec - fades.fadeIn.startSec;
  const fadeOutDuration = fades.fadeOut.endSec - fades.fadeOut.startSec;
  const fadeInStart = fades.fadeIn.startSec === 0
    ? "0"
    : fades.fadeIn.startSec.toFixed(3);
  return `afade=t=in:st=${fadeInStart}:d=${fadeInDuration.toFixed(3)},afade=t=out:st=${fades.fadeOut.startSec.toFixed(3)}:d=${fadeOutDuration.toFixed(3)}`;
}

/**
 * Builds a gain filter fragment for the source/dialogue track from
 * `studioEdits.sourceAudio`, or `null` when it's a no-op (unity gain, not
 * muted) — callers must skip appending it entirely in that case (the "unity
 * fast path") so untouched clips keep producing the exact same filter graph
 * they always have.
 */
function buildSourceGainFilter(
  audio: BoundCompositionAudioRenderRequest,
): string | null {
  const sourceAudio = audio.source;
  const censorWindows = audio.censors
    .map(
      (censor) =>
        `between(t,${censor.startSec.toFixed(6)},${censor.endSec.toFixed(6)})`,
    )
    .join("+");
  if (censorWindows) {
    const gain = sourceAudio.muted ? 0 : sourceAudio.gain;
    return `aeval=exprs='if(${censorWindows},0,val(ch)*${gain.toFixed(6)})':c=same`;
  }
  if (sourceAudio.muted) return "volume=0.000";
  if (sourceAudio.gain === 1) return null;
  return `volume=${sourceAudio.gain.toFixed(3)}`;
}

/**
 * The dialogue-only (no music) audio chain: optional source gain/mute, then
 * the fixed boundary click-guard fade. Used by every build*Args call site
 * that has source audio and no music track to mix in.
 */
function buildDialogueAudioFilter(
  audio: BoundCompositionAudioRenderRequest,
): string {
  const gainFilter = buildSourceGainFilter(audio);
  const fadeChain = buildAudioFadeChain(audio.outputFades);
  return gainFilter ? `${gainFilter},${fadeChain}` : fadeChain;
}

function buildCensorBeepAudioFilter(params: {
  censor: Extract<BoundCompositionAudioRenderRequest["censors"][number], { treatment: "beep" }>;
  clipDurationSec: number;
  label: string;
}): string {
  const durationSec = params.censor.endSec - params.censor.startSec;
  const fadeOutStartSec = Math.max(0, durationSec - params.censor.fadeOutSec);
  const prefix = params.label.replace(/[[\]]/g, "");
  const toneLabel = `[${prefix}_tone]`;
  const delayedLabel = `[${prefix}_delayed]`;
  // FFmpeg's sine source emits at 1/8 peak amplitude. Compensate here so
  // levelDb means the same thing in export as it does in the Web Audio preview.
  const ffmpegSineSourcePeak = 1 / 8;
  const tone = [
    `sine=frequency=${params.censor.frequencyHz}:sample_rate=48000:duration=${durationSec.toFixed(6)}`,
    `volume=${(params.censor.gain / ffmpegSineSourcePeak).toFixed(6)}`,
    `afade=t=in:st=0:d=${params.censor.fadeInSec.toFixed(6)}`,
    `afade=t=out:st=${fadeOutStartSec.toFixed(6)}:d=${params.censor.fadeOutSec.toFixed(6)}`,
  ].join(",");
  const delayed = params.censor.startSec > 0
    ? `anullsrc=channel_layout=mono:sample_rate=48000:d=${params.censor.startSec.toFixed(6)}[${prefix}_silence];${tone}${toneLabel};[${prefix}_silence]${toneLabel}concat=n=2:v=0:a=1${delayedLabel}`
    : `${tone}${delayedLabel}`;
  return `${delayed};${delayedLabel}${[
    "apad",
    `atrim=duration=${Math.max(0.1, params.clipDurationSec).toFixed(3)}`,
    "asetpts=PTS-STARTPTS",
  ].join(",")}${params.label}`;
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
  music: NonNullable<BoundCompositionAudioRenderRequest["music"]>,
): string {
  const parts: string[] = [];
  const fadeInSec = music.fades.fadeIn.endSec - music.fades.fadeIn.startSec;
  const fadeOutSec = music.fades.fadeOut.endSec - music.fades.fadeOut.startSec;
  if (fadeInSec > 0) {
    const startSec = music.fades.fadeIn.startSec === 0
      ? "0"
      : music.fades.fadeIn.startSec.toFixed(3);
    parts.push(
      `afade=t=in:st=${startSec}:d=${fadeInSec.toFixed(3)}`,
    );
  }
  if (fadeOutSec > 0) {
    parts.push(
      `afade=t=out:st=${music.fades.fadeOut.startSec.toFixed(3)}:d=${fadeOutSec.toFixed(3)}`,
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
  sfx: BoundCompositionAudioRenderRequest["soundEffects"][number];
  clipDurationSec: number;
  label: string;
}): string {
  const duration = Math.max(0.1, params.clipDurationSec);
  const delayMs = Math.max(
    0,
    Math.round(params.sfx.activeRange.startSec * 1000),
  );
  return `[${params.sfxInputIndex}:a]adelay=${delayMs}:all=1,volume=${params.sfx.gain.toFixed(3)},atrim=duration=${params.sfx.activeRange.endSec.toFixed(3)},apad,atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS${params.label}`;
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
function buildMusicDuckingSuffix(
  music: NonNullable<BoundCompositionAudioRenderRequest["music"]>,
): string {
  if (!music.ducking.enabled || music.ducking.windows.length === 0) return "";
  const expr = buildDuckingVolumeExpression([...music.ducking.windows], {
    duckedGainFraction: music.ducking.duckedGainFraction,
    attackSec: music.ducking.attackSec,
    releaseSec: music.ducking.releaseSec,
  });
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
  audio: BoundCompositionAudioRenderRequest;
  resolvedSceneAssets?: Readonly<Record<string, { path: string; kind: "image" | "video"; hasAudio: boolean }>>;
  clipDurationSec: number;
  /** Label to read the dialogue/source audio from — defaults to `[0:a]`
   *  (the raw source input). Cut-concat renders pass `[acat]` instead so the
   *  dialogue mix reads the concatenated edited-timeline audio, same as
   *  every other downstream audio consumer (vizard-parity Phase B step 7). */
  dialogueInputRef?: string;
  musicInputIndex: number | null;
  sfxInputIndexes: readonly number[];
}): string {
  const duration = Math.max(0.1, params.clipDurationSec);
  const fadeChain = buildAudioFadeChain(params.audio.outputFades);
  const dialogueInputRef = params.dialogueInputRef ?? "[0:a]";
  const sfxEntries = params.audio.soundEffects
    .map((plan, index) => ({ plan, inputIndex: params.sfxInputIndexes[index]! }))
    .filter((entry) => entry.plan.activeRange.startSec < duration);
  const beepEntries = params.audio.censors.filter(
    (censor): censor is Extract<typeof censor, { treatment: "beep" }> =>
      censor.treatment === "beep",
  );

  const branchFilters: string[] = [];
  const branchLabels: string[] = [];

  if (params.audio.source.available) {
    // normalize=0 below: amix's default normalization divides every input by
    // the input count (i.e. -6dB per input for a 2-input mix), quietly
    // ducking the dialogue whenever music/SFX is added. Each branch's own
    // level is already under explicit control (music `volume=`, SFX
    // `volume=`, dialogue gain), so every branch must mix at unity gain —
    // applied here on the dialogue branch (before amix) same as the
    // no-music path.
    const dialogueGainFilter = buildSourceGainFilter(params.audio);
    const label = "[maina]";
    branchFilters.push(
      dialogueGainFilter
        ? `${dialogueInputRef}atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,${dialogueGainFilter}${label}`
        : `${dialogueInputRef}atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS${label}`,
    );
    branchLabels.push(label);
  }

  beepEntries.forEach((censor, index) => {
    const label = `[censor${index}a]`;
    branchFilters.push(
      buildCensorBeepAudioFilter({
        censor,
        clipDurationSec: duration,
        label,
      }),
    );
    branchLabels.push(label);
  });

  if (params.audio.music && params.musicInputIndex != null) {
    const plan = params.audio.music;
    const label = "[musica]";
    const userFadeSuffix = buildMusicUserFadeSuffix(plan);
    const duckingSuffix = buildMusicDuckingSuffix(plan);
    // start=<offset> seeks into the (infinitely -stream_loop'd) music input
    // so the user's chosen point in the track plays first, instead of
    // always the first `duration` seconds of the file.
    branchFilters.push(
      `[${params.musicInputIndex}:a]atrim=start=${plan.startOffsetSec.toFixed(3)}:duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${plan.gain.toFixed(3)}${userFadeSuffix}${duckingSuffix}${label}`,
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
    const limiter = beepEntries.length > 0
      ? "alimiter=limit=0.950:level=disabled,"
      : "";
    return `${branchFilters[0]};${branchLabels[0]}${limiter}${fadeChain}[outa]`;
  }

  const limiter = beepEntries.length > 0
    ? ",alimiter=limit=0.950:level=disabled"
    : "";
  return [
    ...branchFilters,
    `${branchLabels.join("")}amix=inputs=${branchLabels.length}:duration=first:dropout_transition=0:normalize=0${limiter},${fadeChain}[outa]`,
  ].join(";");
}

function assertBoundAudioMatchesPlan(
  plan: ClipCompositionPlan,
  audio: BoundCompositionAudioRenderRequest | undefined,
): asserts audio is BoundCompositionAudioRenderRequest {
  const planned = compileCompositionPlanAudioSchedule(plan);
  if (!audio || audio.scheduleFingerprint !== planned.scheduleFingerprint) {
    throw new Error("clip_composition_audio_input_mismatch");
  }
}

export function buildSingleVideoArgs(params: {
  sourcePath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  aspectRatio: ClipAspectRatio;
  probe: SourceProbe;
  srtPath: string | null;
  logo?: LogoOverlay | null;
  /** The sole versioned composition policy for every video render. */
  composition: {
    plan: ClipCompositionPlan;
    targetId: string;
  };
  audio: BoundCompositionAudioRenderRequest;
  /** Resolved canvas background (vizard-parity Phase C item 2) — presence
   *  implies "on" (mode is always "color" or "image"); omit/null preserves
   *  today's crop-to-fill behavior. See `BackgroundPlan`. */
  background?: BackgroundPlan | null;
  /** Non-empty `deletedRanges` cut plan (vizard-parity Phase B step 7).
   *  Omitted/uncut: byte-identical to the pre-cut-concat filter graph. */
  cutPlan?: ClipCutPlan | null;
  resolvedSceneAssets?: Readonly<Record<string, { path: string; kind: "image" | "video"; hasAudio: boolean }>>;
  resolvedSceneFonts?: Readonly<Record<string, string>>;
}) {
  assertBoundAudioMatchesPlan(params.composition.plan, params.audio);
  if (params.cutPlan?.isEmpty) {
    throw new WorkflowWorkerError(
      "clip_cut_plan_empty",
      "cutPlan has no renderable segments — caller must guard before building ffmpeg args",
      "permanent",
    );
  }
  const isCut = Boolean(params.cutPlan && !params.cutPlan.isUncut);
  const clipDurationSec = params.composition.plan.editedDurationSec;

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
  const plannedTarget = params.composition.plan.targets.find(
    (target) => target.id === params.composition.targetId,
  );
  if (!plannedTarget) throw new Error("clip_composition_target_missing");
  const plannedLogo = plannedTarget.visualLayers.find(
    (layer) => layer.kind === "logo",
  );
  if (Boolean(plannedLogo) !== Boolean(params.logo)) {
    throw new Error("clip_composition_logo_asset_mismatch");
  }
  let nextInputIndex = 1;
  const bgImageInputIndex = usesBackgroundImage ? nextInputIndex++ : null;
  const sceneAssetRefs = [...new Set(plannedTarget.scenes.flatMap((scene) =>
    scene.layers.flatMap((layer) => layer.kind === "inserted-scene" && layer.sourceRef ? [layer.sourceRef] : []),
  ))];
  const hasInsertedScenes = plannedTarget.scenes.some((scene) =>
    scene.layers.some((layer) => layer.kind === "inserted-scene"));
  const sceneInputStartIndex = sceneAssetRefs.length > 0 ? nextInputIndex : null;
  nextInputIndex += sceneAssetRefs.length;
  const logoInputIndex = plannedLogo ? nextInputIndex++ : null;
  const musicInputIndex = params.audio.music ? nextInputIndex++ : null;
  const sfxInputIndexes = params.audio.soundEffects.map(() => nextInputIndex++);

  const filterParts: string[] = cutConcat ? [...cutConcat.filterParts] : [];

  const compiled = currentRenderAdapters().composition.compileVideo({
    plan: params.composition.plan,
    targetId: params.composition.targetId,
    videoInputLabel,
    outputLabel: "[composition_base]",
    backgroundImageInputIndex: bgImageInputIndex,
    fps: params.probe.fps,
    resolvedSceneAssets: params.resolvedSceneAssets,
    resolvedSceneFonts: params.resolvedSceneFonts,
    sceneInputStartIndex: sceneInputStartIndex ?? undefined,
  });
  filterParts.push(...compiled.filterParts);
  const sceneAudio = currentRenderAdapters().composition.compileSceneAudio({
    plan: params.composition.plan,
    targetId: params.composition.targetId,
    sourceAudioLabel: audioInputLabel,
    sceneInputs: sceneAssetRefs.map((sourceRef, index) => ({
      sourceRef,
      inputIndex: sceneInputStartIndex! + index,
      hasAudio: params.resolvedSceneAssets?.[sourceRef]?.hasAudio ?? false,
    })),
  });
  filterParts.push(...sceneAudio.filterParts);
  const sceneDialogueLabel = hasInsertedScenes ? sceneAudio.outputLabel : null;
  const visual = currentRenderAdapters().composition.compileVisualLayers({
    plan: params.composition.plan,
    targetId: params.composition.targetId,
    inputLabel: "[composition_base]",
    outputLabel: "[outv]",
    subtitlePath: params.srtPath,
    logoInputIndex,
  });
  filterParts.push(...visual.filterParts);
  if (
    visual.logoInput &&
    (!params.logo || visual.logoInput.sourceRef !== params.logo.ref)
  ) {
    throw new Error("clip_composition_logo_asset_mismatch");
  }
  const finalLabel = "[outv]";

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

  for (const sourceRef of sceneAssetRefs) {
    const asset = params.resolvedSceneAssets?.[sourceRef];
    if (!asset) throw new Error("clip_composition_scene_input_missing");
    if (asset.kind === "image") args.push("-loop", "1");
    else args.push("-stream_loop", "-1");
    args.push("-i", asset.path);
  }

  if (plannedLogo && params.logo) {
    args.push("-i", params.logo.filePath);
  }

  if (params.audio.music) {
    args.push("-stream_loop", "-1", "-i", params.audio.music.path);
  }

  for (const sfx of params.audio.soundEffects) {
    // No -stream_loop: SFX is one-shot, never looped, unlike music above.
    args.push("-i", sfx.path);
  }

  const audioForRender = sceneDialogueLabel
    ? { ...params.audio, source: { ...params.audio.source, available: true } }
    : params.audio;
  const hasMixedAudio =
    Boolean(params.audio.music) ||
    sfxInputIndexes.length > 0 ||
    params.audio.censors.some((censor) => censor.treatment === "beep");
  if (hasMixedAudio) {
    filterParts.push(
      buildAudioMixFilter({
        audio: audioForRender,
        clipDurationSec,
        dialogueInputRef: sceneDialogueLabel ?? (cutConcat ? cutConcat.audioLabel! : undefined),
        musicInputIndex,
        sfxInputIndexes,
      }),
    );
  } else if (sceneDialogueLabel || audioInputLabel) {
    filterParts.push(
      `${sceneDialogueLabel ?? audioInputLabel}${buildDialogueAudioFilter(audioForRender)}[outa]`,
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
  } else if (sceneDialogueLabel || params.probe.hasAudio) {
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
 * Builds FFmpeg args from a composition plan containing B-roll layers. Asset
 * paths are keyed by the plan's sourceRef; the adapter validates and compiles
 * every planned interval so callers cannot supply a parallel timing model.
 */
export function buildBrollVideoArgs(params: {
  sourcePath: string;
  resolvedBrollAssets: Readonly<Record<string, string>>;
  outputPath: string;
  startSec: number;
  endSec: number;
  aspectRatio: ClipAspectRatio;
  probe: SourceProbe;
  srtPath: string | null;
  logo?: LogoOverlay | null;
  composition: {
    plan: ClipCompositionPlan;
    targetId: string;
  };
  audio: BoundCompositionAudioRenderRequest;
  /** Resolved canvas background (vizard-parity Phase C item 2) — see
   *  `buildSingleVideoArgs`'s param doc; same contract here. */
  background?: BackgroundPlan | null;
  /** See `buildSingleVideoArgs` — same cut-concat contract. */
  cutPlan?: ClipCutPlan | null;
  resolvedSceneAssets?: Readonly<Record<string, { path: string; kind: "image" | "video"; hasAudio: boolean }>>;
  resolvedSceneFonts?: Readonly<Record<string, string>>;
}) {
  assertBoundAudioMatchesPlan(params.composition.plan, params.audio);
  if (Object.keys(params.resolvedBrollAssets).length === 0) {
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
  const plannedTargetForScenes = params.composition.plan.targets.find((target) => target.id === params.composition.targetId);
  if (!plannedTargetForScenes) throw new Error("clip_composition_target_missing");
  const sceneAssetRefs = [...new Set(plannedTargetForScenes.scenes.flatMap((scene) =>
    scene.layers.flatMap((layer) => layer.kind === "inserted-scene" && layer.sourceRef ? [layer.sourceRef] : []),
  ))];
  const hasInsertedScenes = plannedTargetForScenes.scenes.some((scene) =>
    scene.layers.some((layer) => layer.kind === "inserted-scene"));
  const isCut = Boolean(params.cutPlan && !params.cutPlan.isUncut);
  const clipDurationSec = params.composition.plan.editedDurationSec;

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
  const compiledComposition = currentRenderAdapters().composition.compileVideo({
      plan: params.composition.plan,
      targetId: params.composition.targetId,
      videoInputLabel,
      outputLabel: "[stage0]",
      backgroundImageInputIndex: bgImageInputIndex,
      fps: params.probe.fps,
      resolvedBrollAssets: params.resolvedBrollAssets,
      brollInputStartIndex: 1 + bgOffset,
      resolvedSceneAssets: params.resolvedSceneAssets,
      resolvedSceneFonts: params.resolvedSceneFonts,
      sceneInputStartIndex: sceneAssetRefs.length > 0
        ? 1 + bgOffset + Object.keys(params.resolvedBrollAssets).length
        : undefined,
  });
  const cutawayCount = compiledComposition.brollInputs.length;
  const plannedTarget = params.composition.plan.targets.find(
    (target) => target.id === params.composition.targetId,
  );
  if (!plannedTarget) throw new Error("clip_composition_target_missing");
  const plannedLogo = plannedTarget.visualLayers.find(
    (layer) => layer.kind === "logo",
  );
  if (Boolean(plannedLogo) !== Boolean(params.logo)) {
    throw new Error("clip_composition_logo_asset_mismatch");
  }
  const logoInputIndex = plannedLogo ? 1 + bgOffset + cutawayCount + sceneAssetRefs.length : null;
  parts.push(...compiledComposition.filterParts);
  const sceneAudio = currentRenderAdapters().composition.compileSceneAudio({
    plan: params.composition.plan,
    targetId: params.composition.targetId,
    sourceAudioLabel: audioInputLabel,
    sceneInputs: sceneAssetRefs.map((sourceRef, index) => ({
      sourceRef,
      inputIndex: 1 + bgOffset + cutawayCount + index,
      hasAudio: params.resolvedSceneAssets?.[sourceRef]?.hasAudio ?? false,
    })),
  });
  parts.push(...sceneAudio.filterParts);
  const sceneDialogueLabel = hasInsertedScenes ? sceneAudio.outputLabel : null;
  const visual = currentRenderAdapters().composition.compileVisualLayers({
    plan: params.composition.plan,
    targetId: params.composition.targetId,
    inputLabel: "[stage0]",
    outputLabel: "[outv]",
    subtitlePath: params.srtPath,
    logoInputIndex,
  });
  parts.push(...visual.filterParts);
  if (
    visual.logoInput &&
    (!params.logo || visual.logoInput.sourceRef !== params.logo.ref)
  ) {
    throw new Error("clip_composition_logo_asset_mismatch");
  }
  const finalLabel = "[outv]";

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

  for (const cutaway of compiledComposition.brollInputs) {
    // Each B-roll input gets its own `-t`, scoped to just this input (ffmpeg
    // resets per-input options at each `-i`), sized to exactly its own
    // cutaway window. Without this, `overlay` runs until the *longer* of its
    // two inputs finishes (shortest defaults to 0), so any B-roll asset
    // longer than its window silently stretched the whole rendered output
    // past its own planned end (frozen final frame, silent audio) — trimming
    // here means each B-roll stream can never outlast its own window.
    const windowDurationSec = Math.max(
      0.1,
      cutaway.endSec - cutaway.startSec,
    );
    if (cutaway.kind === "image") args.push("-loop", "1");
    args.push("-t", windowDurationSec.toFixed(3), "-i", cutaway.path);
  }

  for (const sourceRef of sceneAssetRefs) {
    const asset = params.resolvedSceneAssets?.[sourceRef];
    if (!asset) throw new Error("clip_composition_scene_input_missing");
    if (asset.kind === "image") args.push("-loop", "1");
    else args.push("-stream_loop", "-1");
    args.push("-i", asset.path);
  }

  if (plannedLogo && params.logo) args.push("-i", params.logo.filePath);

  // Music, then SFX, each consume the next input slot — same order as
  // buildSingleVideoArgs. musicInputIndex is computed unconditionally
  // (even when music is absent) so sfxInputIndexes can be derived from it
  // without duplicating the bgOffset/cutawayCount/logo arithmetic.
  const musicInputIndex = 1 + bgOffset + cutawayCount + sceneAssetRefs.length + (plannedLogo ? 1 : 0);
  const sfxInputIndexes = params.audio.soundEffects.map(
    (_, i) => musicInputIndex + (params.audio.music ? 1 : 0) + i,
  );

  if (params.audio.music) {
    args.push("-stream_loop", "-1", "-i", params.audio.music.path);
  }
  for (const sfx of params.audio.soundEffects) {
    args.push("-i", sfx.path);
  }

  const audioForRender = sceneDialogueLabel
    ? { ...params.audio, source: { ...params.audio.source, available: true } }
    : params.audio;
  const hasMixedAudio =
    Boolean(params.audio.music) ||
    sfxInputIndexes.length > 0 ||
    params.audio.censors.some((censor) => censor.treatment === "beep");
  if (hasMixedAudio) {
    parts.push(
      buildAudioMixFilter({
        audio: audioForRender,
        clipDurationSec,
        dialogueInputRef: sceneDialogueLabel ?? (cutConcat ? cutConcat.audioLabel! : undefined),
        musicInputIndex: params.audio.music ? musicInputIndex : null,
        sfxInputIndexes,
      }),
    );
  } else if (sceneDialogueLabel || audioInputLabel) {
    parts.push(
      `${sceneDialogueLabel ?? audioInputLabel}${buildDialogueAudioFilter(audioForRender)}[outa]`,
    );
  }

  args.push("-filter_complex", parts.join(";"), "-map", finalLabel);

  if (hasMixedAudio) {
    args.push("-map", "[outa]", "-c:a", "aac", "-b:a", "128k", "-shortest");
  } else if (sceneDialogueLabel || params.probe.hasAudio) {
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

export function buildAudiogramArgs(params: {
  sourcePath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  aspectRatio: ClipAspectRatio;
  composition: {
    plan: ClipCompositionPlan;
    targetId: string;
  };
  clipDurationSec: number;
  srtPath: string | null;
  logo?: LogoOverlay | null;
  audio: BoundCompositionAudioRenderRequest;
  resolvedSceneAssets?: Readonly<Record<string, { path: string; kind: "image" | "video"; hasAudio: boolean }>>;
  resolvedSceneFonts?: Readonly<Record<string, string>>;
  /** See `buildSingleVideoArgs` — same cut-concat contract, applied to the
   *  audio stream only (audiogram sources have no video track). Callers must
   *  pass `clipDurationSec` already set to the plan's edited duration when
   *  cut — this builder does not derive it itself. */
  cutPlan?: ClipCutPlan | null;
}) {
  assertBoundAudioMatchesPlan(params.composition.plan, params.audio);
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

  const audiogram = compileCompositionPlanAudiogram(
    params.composition.plan,
    params.composition.targetId,
  );
  const { width: W, height: H } = audiogram.canvas;
  const plannedTarget = params.composition.plan.targets.find(
    (target) => target.id === params.composition.targetId,
  );
  if (!plannedTarget) throw new Error("clip_composition_target_missing");
  const insertedLayers = plannedTarget.scenes.flatMap((scene) =>
    scene.layers.filter((layer) => layer.kind === "inserted-scene"),
  );
  const hasInsertedScenes = insertedLayers.length > 0;
  const sceneAssetRefs = [...new Set(insertedLayers.flatMap((layer) => layer.sourceRef ? [layer.sourceRef] : []))];
  const sourceVisualDurationSec = plannedTarget.scenes.reduce(
    (maximum, scene) => Math.max(maximum, scene.sourceRange?.endSec ?? 0),
    0,
  );
  const outputDurationSec = params.composition.plan.editedDurationSec;
  if (W !== config.width || H !== config.height) {
    throw new WorkflowWorkerError(
      "invalid_clip_composition_target",
      "Audiogram plan canvas does not match the requested aspect ratio",
      "permanent",
    );
  }
  const bgColor = audiogram.backgroundColor.replace("#", "0x");
  const waveColor = hexToFfmpegRgb(audiogram.waveformColor);
  const waveHeight = audiogram.waveformHeight;
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
  const hasMusicOrSfx =
    Boolean(params.audio.music) ||
    params.audio.soundEffects.length > 0 ||
    params.audio.censors.some((censor) => censor.treatment === "beep");

  const plannedLogo = plannedTarget.visualLayers.find(
    (layer) => layer.kind === "logo",
  );
  if (Boolean(plannedLogo) !== Boolean(params.logo)) {
    throw new Error("clip_composition_logo_asset_mismatch");
  }

  const sceneInputStartIndex = sceneAssetRefs.length > 0 ? 1 : null;
  const logoInputIndex = plannedLogo ? 1 + sceneAssetRefs.length : null;
  const musicInputIndex = 1 + sceneAssetRefs.length + (plannedLogo ? 1 : 0);
  const sfxInputIndexes = params.audio.soundEffects.map(
    (_, index) => musicInputIndex + (params.audio.music ? 1 : 0) + index,
  );
  const chain: string[] = cutConcat ? [...cutConcat.filterParts] : [];
  let dialogueAudioLabel: string;
  if (hasInsertedScenes) {
    if (sourceVisualDurationSec <= 0) throw new Error("invalid_clip_composition_source_scenes");
    chain.push(
      `${audioInputLabel}asplit=2[wavesrc][sceneaudiosrc]`,
      `color=c=${bgColor}:s=${W}x${H}:d=${sourceVisualDurationSec.toFixed(3)}[bg]`,
      `[wavesrc]showwaves=s=${W}x${waveHeight}:mode=cline:colors=${waveColor}:rate=25[wave]`,
      `[bg][wave]overlay=0:(H-h)/2[audiogram_source]`,
    );
    const sequence = compileCompositionPlanInsertedSceneSequence({
      plan: params.composition.plan,
      targetId: params.composition.targetId,
      baseVideoLabel: "[audiogram_source]",
      outputLabel: "[comp]",
      fps: 25,
      resolvedSceneAssets: params.resolvedSceneAssets,
      resolvedSceneFonts: params.resolvedSceneFonts,
      sceneInputStartIndex: sceneInputStartIndex ?? undefined,
    });
    chain.push(...sequence.filterParts);
    const sceneAudio = compileCompositionPlanSceneAudio({
      plan: params.composition.plan,
      targetId: params.composition.targetId,
      sourceAudioLabel: "[sceneaudiosrc]",
      sceneInputs: sceneAssetRefs.map((sourceRef, index) => ({
        sourceRef,
        inputIndex: sceneInputStartIndex! + index,
        hasAudio: params.resolvedSceneAssets?.[sourceRef]?.hasAudio ?? false,
      })),
    });
    chain.push(...sceneAudio.filterParts);
    if (!sceneAudio.outputLabel) throw new Error("clip_composition_scene_audio_missing");
    dialogueAudioLabel = sceneAudio.outputLabel;
    if (!hasMusicOrSfx) {
      chain.push(`${dialogueAudioLabel}${buildDialogueAudioFilter(params.audio)}[outa]`);
    }
  } else {
    dialogueAudioLabel = cutConcat ? "[dlgsrc]" : audioInputLabel;
    if (hasMusicOrSfx && cutConcat) {
      chain.push(`${audioInputLabel}asplit=2[wavesrc][dlgsrc]`);
    }
    const waveSourceLabel = hasMusicOrSfx && cutConcat ? "[wavesrc]" : audioInputLabel;
    chain.push(
      ...(hasMusicOrSfx
        ? [
            `color=c=${bgColor}:s=${W}x${H}:d=${outputDurationSec.toFixed(3)}[bg]`,
            `${waveSourceLabel}showwaves=s=${W}x${waveHeight}:mode=cline:colors=${waveColor}:rate=25[wave]`,
            `[bg][wave]overlay=0:(H-h)/2[comp]`,
          ]
        : [
            `color=c=${bgColor}:s=${W}x${H}:d=${outputDurationSec.toFixed(3)}[bg]`,
            `${audioInputLabel}asplit=2[wavesrc][fadesrc]`,
            `[wavesrc]showwaves=s=${W}x${waveHeight}:mode=cline:colors=${waveColor}:rate=25[wave]`,
            `[fadesrc]${buildDialogueAudioFilter(params.audio)}[outa]`,
            `[bg][wave]overlay=0:(H-h)/2[comp]`,
          ]),
    );
  }

  const visual = currentRenderAdapters().composition.compileVisualLayers({
    plan: params.composition.plan,
    targetId: params.composition.targetId,
    inputLabel: "[comp]",
    outputLabel: "[composition_visual]",
    subtitlePath: params.srtPath,
    logoInputIndex,
  });
  chain.push(...visual.filterParts);
  if (
    visual.logoInput &&
    (!params.logo || visual.logoInput.sourceRef !== params.logo.ref)
  ) {
    throw new Error("clip_composition_logo_asset_mismatch");
  }
  chain.push("[composition_visual]format=yuv420p[outv]");
  const videoOutputLabel = "[outv]";

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

  for (const sourceRef of sceneAssetRefs) {
    const asset = params.resolvedSceneAssets?.[sourceRef];
    if (!asset) throw new Error("clip_composition_scene_input_missing");
    if (asset.kind === "image") args.push("-loop", "1");
    else args.push("-stream_loop", "-1");
    args.push("-i", asset.path);
  }
  if (plannedLogo && params.logo) {
    args.push("-i", params.logo.filePath);
  }
  if (params.audio.music) {
    args.push("-stream_loop", "-1", "-i", params.audio.music.path);
  }
  for (const sfx of params.audio.soundEffects) {
    args.push("-i", sfx.path);
  }

  if (hasMusicOrSfx) {
    chain.push(
      buildAudioMixFilter({
        audio: params.audio,
        clipDurationSec: outputDurationSec,
        dialogueInputRef: dialogueAudioLabel,
        musicInputIndex: params.audio.music ? musicInputIndex : null,
        sfxInputIndexes,
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
    outputDurationSec.toFixed(3),
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
 * `buildFreeTierPostProcessArgs` below still tests. Video plans now declare
 * these independent treatment facts directly. The standalone free-tier
 * utility below shares these low-level primitives with the plan compiler.
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
 * Free-tier export treatment as a standalone single-input ffmpeg pass. Kept
 * as a tested utility for applying the same transformation to an already-
 * rendered file; planned video rendering does not call this second pass.
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
  attempt: WorkflowAttemptRef;
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
  motionAnalytics: MotionRenderAnalyticsMetadata;
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
        attemptId: params.attempt.attemptId,
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
        params.attempt,
        params.output.clipRenderId,
        {
          storageKey: params.output.storageKey,
          sizeBytes: Number(outputStat.size),
          durationSec: params.clipDurationSec,
          motionAnalytics: params.motionAnalytics,
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
      resource: {
        ...productionClipRenderAttemptAdapters.resource,
        ...dependencies.adapters?.resource,
      },
      composition: {
        ...productionClipRenderAttemptAdapters.composition,
        ...dependencies.adapters?.composition,
      },
    };
  }

  async execute(
    attempt: ClipRenderingWorkflowAttempt,
    context: WorkflowAttemptContext,
  ): Promise<RenderWorkSetOutcome> {
    if (!this.#config.clipRenderAttemptEnabled) {
      throw new ClipRenderAttemptDisabled();
    }
    if (
      attempt.workflowRunId !== this.#run.id ||
      attempt.projectId !== this.#run.projectId
    ) {
      throw new WorkflowAttemptLost(attempt);
    }
    const ownershipController = new AbortController();
    const signal = AbortSignal.any([
      context.signal,
      ownershipController.signal,
    ]);
    const adapters: ClipRenderAttemptAdapters = {
      ...this.#adapters,
      diagnose: (event) =>
        this.#adapters.diagnose({
          ...event,
          context: {
            ...event.context,
            workflowRunId: attempt.workflowRunId,
            workflowAttemptId: attempt.attemptId,
            projectId: attempt.projectId,
            stage: attempt.stage,
            attemptCount: attempt.attemptCount,
          },
        }),
    };
    return renderExecutionStorage.run(
      {
        config: this.#config,
        signal,
        adapters,
      },
      async () => {
        const attemptStartedAtMs = currentTimeMs();
        try {
          signal.throwIfAborted();
          const workSet = await this.#lifecycle.beginRenderWorkSet(attempt);
          signal.throwIfAborted();
          const outcome =
            workSet.variantIds.length === 0
              ? await this.#lifecycle.settleRenderWorkSet(attempt)
              : await executeClipRenderAttempt(
                  this.#run,
                  signal,
                  attempt,
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
  const motionAnalyticsByRenderId = new Map<
    string,
    MotionRenderAnalyticsMetadata
  >();

  try {
    // Freeze the document-derived baseline before any source I/O. Source
    // resolution and probing can fail before composition planning, but those
    // failures still belong in motion outcome analytics. Planner notices
    // enrich this baseline later when planning is reached.
    for (const render of pendingRenders) {
      const storedClip = render.clipSnapshot ?? render.clip;
      try {
        const editorDocument = decodeClipEditorDocumentFromStorage(
          storedClip,
          frozenState.sourceDurationSeconds,
        );
        motionAnalyticsByRenderId.set(
          render.id,
          motionRenderAnalyticsMetadata(editorDocument, {
            applyScope: "clip",
            renderOutcome: "completed",
          }),
        );
      } catch {
        // Keep document corruption on its existing post-source failure path.
        // There is no trustworthy motion payload to classify here.
      }
    }

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
    let brandLogoWasRequested = false;
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
        if (snapshot.logoStorageKey) {
          brandLogoWasRequested = true;
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
                ref: compositionAssetRef("logo", snapshot.logoStorageKey),
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

    await currentRenderAdapters().project.reportProgress(attempt, 10);

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
        motionAnalytics: MotionRenderAnalyticsMetadata;
      },
    ) => {
      uploadQueue.schedule(async () => {
        try {
          const persisted = await uploadRenderedOutput({
            attempt,
            workflowRunId: run.id,
            projectId: run.projectId,
            output,
            clipDurationSec: params.clipDurationSec,
            brollCredits: params.brollCredits,
            encodeMs: params.encodeMs,
            motionAnalytics: params.motionAnalytics,
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
              attempt,
              output.clipRenderId,
              errorCode,
              disposition,
              { ...params.motionAnalytics, renderOutcome: "failed" },
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
      const storedClip = renderGroup[0]!.clipSnapshot ?? renderGroup[0]!.clip;
      const editorDocument = decodeClipEditorDocumentFromStorage(
        storedClip,
        frozenState.sourceDurationSeconds,
      );
      let motionAnalytics = motionRenderAnalyticsMetadata(editorDocument, {
        applyScope: "clip",
        renderOutcome: "completed",
      });
      // Export-bound rows carry a complete frozen rendering snapshot. This
      // metadata view deliberately excludes document decoding: every
      // document-owned field above crossed the canonical persistence codec.
      const clip = renderGroup[0]!.clipSnapshot
        ? (renderGroup[0]!.clipSnapshot as unknown as (typeof renderGroup)[number]["clip"])
        : renderGroup[0]!.clip;
      const effective = resolveRenderTimingForClip({
        llmModel: clip.llmModel,
        utterances: editorDocument.transcriptSlice,
        startSec: editorDocument.clipStartSec,
        endSec: editorDocument.clipEndSec,
      });
      const clipStartSec = effective.startSec;
      const clipEndSec = effective.endSec;
      const utterances = effective.transcriptSlice;

      const deletedRanges = editorDocument.deletedRanges;
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
      const initialResourceMeasurement =
        measureCompositionResourceSafely() ?? resourceMeasurementFallback;
      const compositionResources = {
        planVersion: null as number | null,
        planFingerprint: null as string | null,
        requestedMode: null as CompositionMode | null,
        effectiveModes: [] as CompositionMode[],
        sceneCount: 0,
        visualLayerCount: 0,
        planningDurationMs: 0,
        analysisRequestKeys: new Set<string>(),
        analysisExecutionCount: 0,
        detectorExecutionCount: 0,
        extractedSegmentCount: 0,
        commandCount: 0,
        sourceDecodeCount: 0,
        commandBytes: 0,
        encodeDurationMs: 0,
        peakRssBytes: initialResourceMeasurement.rssBytes,
        peakRssScope: initialResourceMeasurement.scope,
      };
      const recordCompositionCommand = (args: readonly string[]): void => {
        compositionResources.commandCount += 1;
        compositionResources.commandBytes += commandSizeBytes("ffmpeg", args);
        const measurement = measureCompositionResourceSafely();
        if (measurement) {
          compositionResources.peakRssScope = measurement.scope;
          recordCompositionResourceSample(measurement.rssBytes);
        }
      };
      const recordCompositionResourceSample = (rssBytes: number): void => {
        compositionResources.peakRssBytes = Math.max(
          compositionResources.peakRssBytes,
          rssBytes,
        );
      };
      const recordCompositionSourceDecodeCompleted = (): void => {
        compositionResources.sourceDecodeCount += 1;
      };
      const recordCompositionEncodeCompleted = (startedAtMs: number): number => {
        const durationMs = Math.max(0, currentTimeMs() - startedAtMs);
        compositionResources.encodeDurationMs += durationMs;
        const measurement = measureCompositionResourceSafely();
        if (measurement) {
          compositionResources.peakRssScope = measurement.scope;
          recordCompositionResourceSample(measurement.rssBytes);
        }
        return durationMs;
      };
      let sharedAnalysisSegmentPromise: ReturnType<
        ClipRenderAttemptAdapters["analysis"]["extractFaceDetectionSegment"]
      > | null = null;
      const getSharedAnalysisSegment = () => {
        if (!sharedAnalysisSegmentPromise) {
          sharedAnalysisSegmentPromise = currentRenderAdapters()
            .analysis.extractFaceDetectionSegment({
              sourcePath,
              tempDir,
              clipId: clip.id,
              workflowRunId: run.id,
              clipStartSec,
              durationSec: effective.durationSec,
            })
            .then((segment) => {
              if (segment && segment.path !== sourcePath) {
                compositionResources.extractedSegmentCount += 1;
              }
              return segment;
            })
            .catch((error) => {
              rethrowRenderControlFlow(error);
              log("error", "clip_reframe_segment_extract_failed", {
                workflowRunId: run.id,
                clipId: clip.id,
                ...mediaAnalysisDiagnostic({
                  analysisMode: "segment_extraction",
                  fallbackMode: "composition_plan",
                  failureCode: "analysis_input_unavailable",
                }),
              });
              return null;
            });
        }
        return sharedAnalysisSegmentPromise;
      };
      // Time map used by the audio-only subtitle path and by the composition
      // planner to retime source-absolute words onto the edited timeline.
      const captionTimeMap = cutPlan.isUncut ? null : cutPlan.map;

      const captionPreset = editorDocument.captionPreset;
      const studioEdits = editorDocument.studioEdits;

      // Per-clip effective logo: this clip's studioEdits.logo override
      // merged over the project-wide brandLogo (frozen snapshot + already
      // -downloaded file). `null` whenever there's no logo asset at all, or
      // this clip's override disables it.
      const logo = resolveClipLogoOverlay(brandLogo, studioEdits.logo);
      const plannedLogoSettings = brandLogo
        ? resolveEffectiveLogoSettings(
            {
              position: brandLogo.position,
              opacity: brandLogo.opacity,
              scalePct: brandLogo.scalePct,
            },
            studioEdits.logo,
          )
        : null;

      // SRT remains only for audio-only, no-preset audiograms. Video captions
      // are serialized from the Composition Plan after planning below.
      let srtPath: string | null = null;
      if (!probe.hasVideo && utterances.length > 0) {
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
      for (const output of outputs) {
        motionAnalyticsByRenderId.set(output.clipRenderId, motionAnalytics);
      }

      // Claim the variants before every terminal branch. Lifecycle failure
      // settlement is fenced to rows owned by this render attempt; failing a
      // still-pending row is intentionally rejected as stale.
      await Promise.all(
        outputs.map((output) =>
          currentRenderAdapters().clip.markClipRenderVariantRendering(
            attempt,
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
              attempt,
              output.clipRenderId,
              "clip_cut_plan_empty",
              "permanent",
              { ...motionAnalytics, renderOutcome: "failed" },
            ),
          ),
        );
        const progress =
          10 + Math.round(((clipGroupIndex + 1) / clipGroups.length) * 80);
        await currentRenderAdapters().project.reportProgress(attempt, progress);
        continue;
      }

      // Per-aspect-ratio ASS files carry the full styled, word-synced captions.
      // Generated whenever a caption preset is present (positions are resolution
      // dependent, so one file per output).
      if (!probe.hasVideo && utterances.length > 0) {
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
      const userBrollUrl = editorDocument.brollUrl;
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
                  cutaways: [
                    {
                      ref: compositionAssetRef("broll", safeUserBrollUrl),
                      path: brollPath,
                      window,
                    },
                  ],
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
                    ref: compositionAssetRef("broll", resolved.downloadUrl),
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
      // Missing or unavailable evidence remains planner input and produces
      // an explicit Center fallback.
      const layoutEngineEnabled = currentRenderConfig().layoutEngineEnabled;
      const compositionSourceIdentity = compositionAssetRef(
        "source",
        run.projectId,
      );
      const compositionDocument: EditorDocument = {
        ...editorDocument,
        clipStartSec,
        clipEndSec,
        captionPreset,
        transcriptSlice: utterances,
        studioEdits,
        brollUrl: editorDocument.brollUrl,
        deletedRanges,
      };
      const sceneAssetReferences = [...new Map([
        ...compositionDocument.sceneBlocks.flatMap((block) =>
          block.content.kind === "image" || block.content.kind === "video"
            ? [[block.content.asset.id, { ...block.content.asset, kind: block.content.kind }] as const]
            : [],
        ),
        ...studioEdits.visualBroll.map((placement) =>
          [placement.asset.id, { ...placement.asset, kind: "image" as const }] as const,
        ),
      ]).values()];
      const sceneFontReferences = [...new Map(
        compositionDocument.sceneBlocks.flatMap((block) =>
          block.content.kind === "text" && block.content.fontAsset
            ? [[block.content.fontAsset.id, {
                ...block.content.fontAsset,
                family: block.content.fontFamily,
              }] as const]
            : [],
        ),
      ).values()];
      const resolvedSceneAssets: Record<string, { path: string; kind: "image" | "video"; hasAudio: boolean }> = {};
      const resolvedSceneFonts: Record<string, string> = {};
      const prisma = sceneAssetReferences.length > 0 || sceneFontReferences.length > 0
        ? getPrismaClient()
        : null;
      if ((sceneAssetReferences.length > 0 || sceneFontReferences.length > 0) && !prisma) {
        throw new WorkflowWorkerError("scene_asset_database_unavailable", "Scene assets cannot be resolved", "retryable");
      }
      const workspace = prisma && run.project.workspaceId
        ? await prisma.workspace.findUnique({
            where: { id: run.project.workspaceId },
            select: { personalOwnerUserId: true, pricingTier: true },
          })
        : null;
      const sceneOwnerWhere = sceneAssetOwnerWhere({
        projectUserId: run.project.userId,
        workspaceId: run.project.workspaceId,
        workspace,
      });
      if (sceneAssetReferences.length > 0 && prisma) {
        const assets = await prisma.visualAsset.findMany({
          where: {
            id: { in: sceneAssetReferences.map((asset) => asset.id) },
            ...sceneOwnerWhere,
          },
          select: { id: true, kind: true, fingerprint: true, storageKey: true },
        });
        const byId = new Map(assets.map((asset) => [asset.id, asset]));
        for (const reference of sceneAssetReferences) {
          const asset = byId.get(reference.id);
          if (!asset || asset.fingerprint !== reference.fingerprint || asset.kind !== reference.kind) {
            throw new WorkflowWorkerError("scene_asset_unavailable", "An inserted scene asset is missing or changed", "permanent");
          }
          const path = join(tempDir, `scene-${asset.id}${extname(asset.storageKey) || (asset.kind === "image" ? ".png" : ".mp4")}`);
          await currentRenderAdapters().storage.downloadObjectToFile({
            key: asset.storageKey,
            filePath: path,
            signal: renderStorageSignal(),
          });
          const decodable = await currentRenderAdapters().optionalAssets.validateOptionalMedia(path, asset.kind);
          if (!decodable) throw new WorkflowWorkerError("scene_asset_invalid", "An inserted scene asset is not decodable", "permanent");
          const sceneProbe = asset.kind === "video" ? await probeSource(path) : null;
          if (sceneProbe) {
            const sceneDurationSec = await probeMediaDurationSec(path);
            const invalidRange = compositionDocument.sceneBlocks.some((block) =>
              block.content.kind === "video" &&
              block.content.asset.id === asset.id &&
              (sceneDurationSec === null || block.content.sourceEndSec > sceneDurationSec + 0.05));
            if (invalidRange || sceneDurationSec === null) {
              throw new WorkflowWorkerError("scene_asset_range_invalid", "An inserted video scene exceeds its source duration", "permanent");
            }
          }
          resolvedSceneAssets[compositionAssetRef("visual_asset", `${asset.id}:${asset.fingerprint}`)] = { path, kind: asset.kind, hasAudio: sceneProbe?.hasAudio ?? false };
        }
      }
      if (sceneFontReferences.length > 0 && prisma) {
        const fonts = await prisma.brandFont.findMany({
          where: {
            id: { in: sceneFontReferences.map((font) => font.id) },
            ...sceneOwnerWhere,
          },
          select: {
            id: true,
            family: true,
            fingerprint: true,
            storageKey: true,
            format: true,
          },
        });
        const byId = new Map(fonts.map((font) => [font.id, font]));
        for (const reference of sceneFontReferences) {
          const font = byId.get(reference.id);
          if (
            !font ||
            font.fingerprint !== reference.fingerprint ||
            font.family !== reference.family
          ) {
            throw new WorkflowWorkerError(
              "scene_font_unavailable",
              "An inserted scene font is missing or changed",
              "permanent",
            );
          }
          const path = join(
            tempDir,
            `scene-font-${font.id}.${font.format.toLowerCase()}`,
          );
          await currentRenderAdapters().storage.downloadObjectToFile({
            key: font.storageKey,
            filePath: path,
            signal: renderStorageSignal(),
          });
          resolvedSceneFonts[
            compositionAssetRef("brand_font", `${font.id}:${font.fingerprint}`)
          ] = path;
        }
      }
      const sceneVisualAvailability = Object.fromEntries(
        compositionDocument.sceneBlocks.flatMap((scene) =>
          scene.content.kind === "image" || scene.content.kind === "video"
            ? [[scene.id, {
                state: "available" as const,
                ref: compositionAssetRef(
                  "visual_asset",
                  `${scene.content.asset.id}:${scene.content.asset.fingerprint}`,
                ),
              }]]
            : [],
        ),
      );
      const sceneFontAvailability = Object.fromEntries(
        compositionDocument.sceneBlocks.flatMap((scene) =>
          scene.content.kind === "text" && scene.content.fontAsset
            ? [[scene.id, {
                state: "available" as const,
                ref: compositionAssetRef(
                  "brand_font",
                  `${scene.content.fontAsset.id}:${scene.content.fontAsset.fingerprint}`,
                ),
              }]]
            : [],
        ),
      );
      const persistedAutoLayout = parseClipAutoLayoutAnalysis(
        clip.autoLayoutAnalysis,
      );
      const persistedAutoLayoutEligible = Boolean(
        layoutEngineEnabled &&
          persistedAutoLayout &&
          persistedAutoLayout.engine === "shot-layout-v1" &&
          persistedAutoLayout.sourceIdentity === compositionSourceIdentity &&
          clipAutoLayoutMatchesInputs(persistedAutoLayout, {
            clipStartSec,
            clipEndSec,
            deletedRanges,
          }) &&
          Math.abs(persistedAutoLayout.editedDurationSec - clipDurationSec) <=
            0.075,
      );
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
      const automaticEvidenceProbe =
        probe.hasVideo &&
        resolveEffectiveFramingMode(studioEdits) === "auto"
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
                          clipStartSec,
                          clipEndSec,
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
              assets: {
                backgroundImage: { state: "missing" },
                sceneVisuals: sceneVisualAvailability,
                sceneFonts: sceneFontAvailability,
              },
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
      if (automaticEvidenceRequested) {
        if (
          automaticEvidenceProbe &&
          automaticEvidenceProbe.status !== "invalid"
        ) {
          for (const request of automaticEvidenceProbe.plan.evidenceRequests) {
            compositionResources.analysisRequestKeys.add(request.key);
          }
        }
        compositionResources.analysisExecutionCount += 1;
        let engineHandled = false;
        if (persistedAutoLayoutEligible && persistedAutoLayout) {
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
          ? await getSharedAnalysisSegment()
          : null;

        if (!engineHandled && layoutEngineEnabled && detectInput) {
          compositionResources.detectorExecutionCount += 2;
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
                clipStartSec,
                clipEndSec,
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
                .completeClipAutoLayoutAnalysis(attempt, clip.id, envelope, {
                  editorRevision: clip.editorRevision,
                  previewStorageKey: clip.previewStorageKey,
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
                fallbackMode: "composition_plan",
                failureCode: "analysis_unavailable",
              }),
              reason: "detection_unavailable",
            });
          }
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

      // Resolve the evidence needed by the shared planner for Screen mode.
      const screenLayoutEnabled = currentRenderConfig().screenLayoutEnabled;
      const isScreenMode =
        resolveEffectiveFramingMode(studioEdits) === "screen" && probe.hasVideo;
      if (isScreenMode) {
        if (!screenLayoutEnabled) {
          screenLayoutEvidenceForPlan = { state: "disabled" };
          log("info", "clip_screen_fallback", {
            workflowRunId: run.id,
            clipId: clip.id,
            ...mediaAnalysisDiagnostic({
              analysisMode: "screen_layout",
              fallbackMode: "composition_plan",
              failureCode: "analysis_disabled",
            }),
            reason: "disabled",
          });
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
                fallbackMode: "composition_plan",
                failureCode: screenFallbackReason,
              }),
              reason: screenFallbackReason,
            });
          } else {
            const screenEngineVersion = SCREEN_LAYOUT_ENGINE_VERSION;
            const screenFingerprint = screenLayoutInputFingerprint({
              sourceIdentity: compositionSourceIdentity,
              clipStartSec,
              clipEndSec,
              deletedRanges,
              engineVersion: screenEngineVersion,
            });
            const persistedAnalysisRaw = parseClipLayoutAnalysis(
              clip.layoutAnalysis,
            );
            const persistedAnalysis =
              persistedAnalysisRaw !== null &&
              layoutAnalysisMatchesWindow(
                persistedAnalysisRaw,
                clipStartSec,
                effective.durationSec,
              ) &&
              persistedAnalysisRaw.engine === screenEngineVersion &&
              persistedAnalysisRaw.sourceIdentity === compositionSourceIdentity &&
              persistedAnalysisRaw.inputFingerprint === screenFingerprint
                ? persistedAnalysisRaw
                : null;
            const reuseExactScreenPlan = persistedAnalysis !== null;
            if (!reuseExactScreenPlan) {
              compositionResources.analysisRequestKeys.add(
                `screen-layout:${screenFingerprint}`,
              );
              compositionResources.analysisExecutionCount += 1;
            }
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
              : await getSharedAnalysisSegment();

            // PiP persistence packet B (read-before-detect): a persisted
            // `Clip.layoutAnalysis` envelope whose detection window still
            // matches THIS render's `clipStartSec`/`effective.durationSec`
            // (`layoutAnalysisMatchesWindow`) means `pip_detect.py` already
            // ran for this exact source range — reuse its
            // movingPxFrac/insufficientSamples/pipRect instead of paying for
            // the script again. A window mismatch (most commonly a trim
            // moving `clipStartSec`/
            // `endSec`) is the envelope's own invalidation — see that
            // function's doc comment — so the stale value is simply never
            // read here, not explicitly deleted.
            // The read-before-detect decision lives in `resolvePipAnalysis`.
            // The identity-complete envelope is persisted below only after
            // both PiP and face-band facts are conclusive.
            if (!reuseExactScreenPlan && detectInput) {
              compositionResources.detectorExecutionCount += 1;
            }
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
                  detectInput,
                  startSec: clipStartSec,
                  durationSec: effective.durationSec,
                  detect: currentRenderAdapters().analysis.detectPipPath,
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
            if (detectInput) {
              compositionResources.detectorExecutionCount += 1;
            }
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
              segmentExtracted: reuseExactScreenPlan || Boolean(detectInput),
              detection: detectionResult,
              selectedRect,
              faceConfirmed: reuseExactScreenPlan
                ? persistedAnalysis.pipUsable
                : faceConfirmed,
              screencastThreshold: currentRenderConfig().pipMotionThreshold,
            };
            // Clip-level evidence gate. Target-specific geometry is resolved
            // later by the composition planner.
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

            const faceBandSegments = reuseExactScreenPlan
              ? persistedAnalysis.faceBandSegments
              : faceBandSegmentsForCompositionPlan({
                  samples: detection?.samples ?? null,
                  cutPlan,
                  clipStartSec,
                  editedDurationSec: clipDurationSec,
                });
            const screenAnalysisConclusive =
              reuseExactScreenPlan || Boolean(detectionResult && detection);
            if (!screenAnalysisConclusive) {
              const failureReason = detectionResult
                ? "analysis_unavailable"
                : "detection_unavailable";
              screenLayoutEvidenceForPlan = {
                state: "failed",
                reason: failureReason,
              };
              const failure = clipLayoutAnalysisFailureSchema.parse({
                version: 2,
                engine: screenEngineVersion,
                state: "failed",
                sourceIdentity: compositionSourceIdentity,
                inputFingerprint: screenFingerprint,
                analyzedAtISO: new Date(currentTimeMs()).toISOString(),
                reason: failureReason,
              });
              if (clip.previewStorageKey) {
                try {
                  await currentRenderAdapters().clip.setClipLayoutAnalysisFailure(
                    attempt,
                    clip.id,
                    failure,
                    {
                      editorRevision: clip.editorRevision,
                      previewStorageKey: clip.previewStorageKey,
                    },
                  );
                } catch (persistError) {
                  rethrowRenderControlFlow(persistError);
                  log("error", "clip_screen_layout_failure_persist_failed", {
                    workflowRunId: run.id,
                    clipId: clip.id,
                    reason: failureReason,
                  });
                }
              }
            } else if (persistedAnalysis === null) {
              const screenEnvelope = clipLayoutAnalysisV2Schema.parse({
                version: 2,
                engine: screenEngineVersion,
                sourceIdentity: compositionSourceIdentity,
                inputFingerprint: screenFingerprint,
                analyzedAtISO: new Date(currentTimeMs()).toISOString(),
                sourceStartSec: clipStartSec,
                sourceDurationSec: effective.durationSec,
                clipStartSec,
                clipEndSec,
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
              if (clip.previewStorageKey) {
                try {
                  await currentRenderAdapters().clip.setClipLayoutAnalysis(
                    attempt,
                    clip.id,
                    screenEnvelope,
                    {
                      editorRevision: clip.editorRevision,
                      previewStorageKey: clip.previewStorageKey,
                    },
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
            }
            if (screenAnalysisConclusive) {
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
            }
            if (screenAnalysisConclusive && !pipRect && !faceBandSegments) {
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

      // Resolve the evidence needed by the shared planner for Split mode.
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
              fallbackMode: "composition_plan",
              failureCode: "analysis_disabled",
            }),
            reason: "disabled",
          });
        } else {
          const splitEngineVersion = "explicit-split-v1";
          const splitFingerprint = splitLayoutInputFingerprint({
            sourceIdentity: compositionSourceIdentity,
            clipStartSec,
            clipEndSec,
            deletedRanges,
            engineVersion: splitEngineVersion,
          });
          const persistedSplitAnalysis = parseClipSplitLayoutAnalysis(
            clip.splitLayoutAnalysis,
          );
          const reusableSplitAnalysis =
            !brollPlan &&
            persistedSplitAnalysis?.sourceIdentity === compositionSourceIdentity &&
            persistedSplitAnalysis.sourceWidth === probe.width &&
            persistedSplitAnalysis.sourceHeight === probe.height &&
            clipAutoLayoutMatchesInputs(persistedSplitAnalysis, {
              clipStartSec,
              clipEndSec,
              deletedRanges,
            }) &&
            Math.abs(
              persistedSplitAnalysis.editedDurationSec - clipDurationSec,
            ) <= 0.075
              ? persistedSplitAnalysis
              : null;
          let detectionAvailable = false;
          let plan: BuildSplitLayoutPlanResult | null = null;
          let multiDetection: { samples: MultiFaceSample[] } | null = null;

          if (reusableSplitAnalysis) {
            detectionAvailable = true;
            plan = {
              segments: reusableSplitAnalysis.segments,
              clusterCount: reusableSplitAnalysis.speakerCount,
              cappedFromSegmentCount: null,
            };
          } else if (!brollPlan) {
            compositionResources.analysisRequestKeys.add(
              `split-speaker-layout:${splitFingerprint}`,
            );
            compositionResources.analysisExecutionCount += 1;
            const detectInput = await getSharedAnalysisSegment();
            // Same source<->edited timeline contract as the single-face path
            // above: detection scans the full uncut clip window in
            // elapsed-uncut-source seconds; `remapMultiFaceSamplesForCutPlan`
            // drops samples inside a cut and remaps the rest onto the edited
            // timeline used by `buildSplitLayoutPlan` and the shared planner.
            if (detectInput) {
              compositionResources.detectorExecutionCount += 1;
            }
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
            if (fallbackReason !== "broll_conflict" && clip.previewStorageKey) {
              const failure = clipSplitLayoutFailureSchema.parse({
                version: 1,
                engine: splitEngineVersion,
                state: "failed",
                sourceIdentity: compositionSourceIdentity,
                inputFingerprint: splitFingerprint,
                analyzedAtISO: new Date(currentTimeMs()).toISOString(),
                reason: fallbackReason,
              });
              await currentRenderAdapters()
                .clip.completeClipSplitLayoutFailure(attempt, clip.id, failure, {
                  editorRevision: clip.editorRevision,
                  previewStorageKey: clip.previewStorageKey,
                })
                .catch((error) => {
                  rethrowRenderControlFlow(error);
                  log("error", "clip_split_layout_failure_persist_failed", {
                    workflowRunId: run.id,
                    clipId: clip.id,
                    reason: fallbackReason,
                  });
                });
            }
            log("info", "clip_split_fallback", {
              workflowRunId: run.id,
              clipId: clip.id,
              ...mediaAnalysisDiagnostic({
                analysisMode: "split_layout",
                fallbackMode: "composition_plan",
                failureCode: fallbackReason,
              }),
              reason: fallbackReason,
            });
          } else if (plan) {
            const fallbackSegments = reusableSplitAnalysis
              ? reusableSplitAnalysis.noSplitSegments
              : (faceBandSegmentsForCompositionPlan({
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
                ]);
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
            splitLayoutEvidenceForPlan = {
              state: "available",
              value: {
                sourceIdentity: compositionSourceIdentity,
                inputFingerprint: splitFingerprint,
                engineVersion: splitEngineVersion,
                source: reusableSplitAnalysis
                  ? "durable-explicit"
                  : "explicit-detector",
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
              clipStartSec,
              clipEndSec,
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
            if (!reusableSplitAnalysis && clip.previewStorageKey) {
              await currentRenderAdapters()
                .clip
                .completeClipSplitLayoutAnalysis(
                  attempt,
                  clip.id,
                  splitPreviewEnvelope,
                  {
                  editorRevision: clip.editorRevision,
                  previewStorageKey: clip.previewStorageKey,
                  },
                )
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

          }
        }
      }

      let musicPlan: ResolvedMusicAsset | null = null;
      // Library asset (vizard-parity.md "Music/SFX library" —
      // `studioMusicSchema.assetId`) wins over the pasted `url` at render
      // time — same precedence the schema's own doc comment documents.
      // Resolution failure (deleted row, DB hiccup) is treated exactly like
      // a failed download below: log and skip music entirely, never fail
      // the whole clip (the existing `music_download_failed` policy this
      // mirrors never actually fails the clip either — see the catch below,
      // which only logs).
      let musicUrl: string | null = null;
      let musicDurationSec: number | undefined;
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
          musicDurationSec = resolved?.durationSec;
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
                ref: compositionAssetRef(
                  "music",
                  studioEdits.music.assetId ?? musicUrl,
                ),
                durationSec: musicDurationSec,
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

      // One-shot SFX placements (vizard-parity.md "Music/SFX library" —
      // `studioEdits.sfx[]`). Each placement is resolved/downloaded
      // independently and best-effort: a single bad placement is skipped
      // (logged) rather than failing every other placement or the whole
      // clip, mirroring the music download policy above.
      const sfxPlans: ResolvedSfxAsset[] = [];
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
        let sfxDurationSec: number | null = null;
        try {
          const resolved = await currentRenderAdapters().audioAsset.resolveRenderSource(
            frozenState.userId,
            placement.assetId,
            frozenState.workspaceId,
          );
          sfxUrl = resolved?.url ?? null;
          sfxDurationSec = resolved?.durationSec ?? null;
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
          if (decodable && sfxDurationSec && sfxDurationSec > 0) {
            sfxPlans.push({
              path: sfxPath,
              id: placement.id,
              ref: compositionAssetRef("sound-effect", placement.assetId),
              durationSec: sfxDurationSec,
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
        ...(brollPlan || studioEdits.visualBroll.length > 0
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
      let plannedAudio: BoundCompositionAudioRenderRequest | null = null;
      let fallbackAudio: BoundCompositionAudioRenderRequest | null = null;
      let compositionPlan: ClipCompositionPlan | null = null;
      let fallbackCompositionPlan: ClipCompositionPlan | null = null;
      {
        const planWithAssetAvailability = (
          backgroundImage:
            | { state: "missing" | "failed" }
            | { state: "available"; ref: string },
          availability: {
            broll?: boolean;
            logo?: boolean;
            music?: boolean;
            soundEffects?: boolean;
          } = {},
        ) => {
          const visualBrollAvailable = studioEdits.visualBroll.every((placement) =>
            Boolean(resolvedSceneAssets[compositionAssetRef("visual_asset", `${placement.asset.id}:${placement.asset.fingerprint}`)]),
          );
          const brollAvailable = availability.broll ?? (Boolean(brollPlan) || visualBrollAvailable);
          const logoAvailable = availability.logo ?? Boolean(brandLogo);
          const musicAvailable = availability.music ?? Boolean(musicPlan);
          const soundEffectsAvailable =
            availability.soundEffects ?? sfxPlans.length > 0;
          return planClipComposition({
            document: compositionDocument,
            source: {
              identity: compositionSourceIdentity,
              kind: probe.hasVideo ? "video" : "audio",
              width: probe.hasVideo ? probe.width : 0,
              height: probe.hasVideo ? probe.height : 0,
              hasAudio: probe.hasAudio,
            },
            evidence: {
              automaticLayout: automaticLayoutAnalysisForPlan
                ? {
                    state: "available",
                    value: {
                      sourceIdentity: compositionSourceIdentity,
                      inputFingerprint: automaticLayoutInputFingerprint({
                        sourceIdentity: compositionSourceIdentity,
                        clipStartSec,
                        clipEndSec,
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
            assets: {
              backgroundImage,
              sceneVisuals: sceneVisualAvailability,
              sceneFonts: sceneFontAvailability,
              ...(studioEdits.music.assetId || studioEdits.music.url
                ? {
                    music: musicAvailable && musicPlan?.ref
                      ? {
                          state: "available" as const,
                          ref: musicPlan.ref,
                          durationSec: musicPlan.durationSec,
                        }
                      : { state: "failed" as const },
                  }
                : {}),
              soundEffects: Object.fromEntries(
                studioEdits.sfx.map((placement) => {
                  const resolved = soundEffectsAvailable
                    ? sfxPlans.find(
                        (candidate) => candidate.id === placement.id,
                      )
                    : undefined;
                  return [
                    placement.id,
                    resolved?.ref
                      ? {
                          state: "available" as const,
                          ref: resolved.ref,
                          durationSec: resolved.durationSec,
                        }
                      : { state: "failed" as const },
                  ];
                }),
              ),
              ...(studioEdits.visualBroll.length > 0 && brollAvailable
                ? {
                    broll: {
                      state: "available" as const,
                      placements: studioEdits.visualBroll.map((placement) => ({
                        id: placement.id,
                        ref: compositionAssetRef("visual_asset", `${placement.asset.id}:${placement.asset.fingerprint}`),
                        kind: "image" as const,
                        startSec: placement.startSec,
                        endSec: placement.endSec,
                      })),
                    },
                  }
                : brollPlan && brollAvailable
                ? {
                    broll: {
                      state: "available" as const,
                      placements: brollPlan.cutaways.map((cutaway, index) => ({
                        id: `cutaway-${index}`,
                        ref: cutaway.ref,
                        startSec: cutaway.window.startSec,
                        endSec: cutaway.window.endSec,
                      })),
                    },
                  }
                : userBrollUrl || brollPlan || studioEdits.visualBroll.length > 0
                  ? { broll: { state: "failed" as const } }
                  : {}),
              ...(brandLogo && logoAvailable && plannedLogoSettings
                ? {
                    logo: {
                      state: "available" as const,
                      ref: brandLogo.ref,
                      settings: plannedLogoSettings,
                    },
                  }
                : brandLogoWasRequested
                  ? { logo: { state: "failed" as const } }
                  : {}),
            },
            capabilities: {
              automaticSpeakerLayout: currentRenderConfig().layoutEngineEnabled,
              automaticSpeakerEngineVersion: "shot-layout-v1",
              explicitSplitLayout: currentRenderConfig().splitEnabled,
              splitEngineVersion: "explicit-split-v1",
              screenLayout: currentRenderConfig().screenLayoutEnabled,
              screenEngineVersion: SCREEN_LAYOUT_ENGINE_VERSION,
            },
            targets: outputs.map((output) => {
              const target = aspectRatioConfig.get(output.aspectRatio)!;
              return {
                id: output.clipRenderId,
                aspectRatio: output.aspectRatio,
                width: target.width,
                height: target.height,
                outputTreatment: {
                  resolution: output.resolution,
                  watermark: output.watermark,
                },
              };
            }),
          });
        };
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
        const planned = planWithAssetAvailability(
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
        compositionResources.planVersion = planned.plan.version;
        compositionResources.planFingerprint = planned.plan.fingerprint;
        compositionResources.requestedMode = requestedCompositionMode;
        compositionResources.effectiveModes = planned.plan.targets.map(
          (target) => target.effectiveMode,
        );
        compositionResources.planningDurationMs = planningDurationMs;
        const sceneCount = planned.plan.targets.reduce(
          (count, target) => count + target.scenes.length,
          0,
        );
        const visualLayerCount = planned.plan.targets.reduce(
          (count, target) => count + target.visualLayers.length,
          0,
        );
        compositionResources.sceneCount = sceneCount;
        compositionResources.visualLayerCount = visualLayerCount;
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
          planVersion: planned.plan.version,
          planFingerprint: planned.plan.fingerprint,
          planFidelity: planned.plan.fidelity,
          audioScheduleFingerprint: planned.plan.audioSchedule.fingerprint,
          audioSchedule: {
            sourceAvailable: planned.plan.audioSchedule.source.available,
            musicIncluded: Boolean(planned.plan.audioSchedule.music),
            duckingWindowCount:
              planned.plan.audioSchedule.music?.ducking.windows.length ?? 0,
            soundEffectCount:
              planned.plan.audioSchedule.soundEffects.length,
          },
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
            visualLayerKinds: target.visualLayers.map((layer) => layer.kind),
          })),
          sceneCount,
          visualLayerCount,
          noticeCodes: planned.plan.notices.map((notice) => notice.code),
          optionalDegradationCount: planned.plan.notices.filter(
            (notice) => notice.fidelity === "degraded",
          ).length,
        });
        compositionPlan = planned.plan;
        motionAnalytics = motionRenderAnalyticsMetadata(compositionDocument, {
          applyScope: "clip",
          fallbackCodes: planned.plan.notices
            .map((notice) => notice.code)
            .filter((code) => code.includes("motion")),
          renderOutcome: "completed",
        });
        for (const output of outputs) {
          motionAnalyticsByRenderId.set(output.clipRenderId, motionAnalytics);
        }
        plannedAudio = bindCompositionPlanAudioInputs(
          compileCompositionPlanAudioSchedule(compositionPlan),
          {
            music:
              musicPlan
                ? { sourceRef: musicPlan.ref, path: musicPlan.path }
                : null,
            soundEffects: sfxPlans.map((effect) => ({
              id: effect.id,
              sourceRef: effect.ref,
              path: effect.path,
            })),
          },
        );
        for (const output of outputs) {
          const target = compositionPlan.targets.find(
            (candidate) => candidate.id === output.clipRenderId,
          );
          if (!target) {
            throw new WorkflowWorkerError(
              "invalid_clip_composition_plan",
              `Clip Composition Plan target missing for ${output.clipRenderId}`,
              "permanent",
            );
          }
          const assContent = generateAssFromCompositionCaptionLayers({
            layers: target.visualLayers.filter(
              (layer): layer is CompositionCaptionVisualLayer =>
                layer.kind === "caption",
            ),
            canvas: target.canvas,
          });
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
        if (optionalCommandAssets.length > 0) {
          const fallbackPlan = planWithAssetAvailability(
            backgroundImageAvailability.state === "available"
              ? { state: "failed" }
              : backgroundImageAvailability,
            {
              broll: false,
              logo: false,
              music: false,
              soundEffects: false,
            },
          );
          if (fallbackPlan.status !== "invalid") {
            fallbackCompositionPlan = fallbackPlan.plan;
            fallbackAudio = bindCompositionPlanAudioInputs(
              compileCompositionPlanAudioSchedule(fallbackPlan.plan),
              {},
            );
          }
        }
      }

      if (!probe.hasVideo) {
        if (!compositionPlan || !plannedAudio) {
          throw new WorkflowWorkerError(
            "clip_composition_plan_missing",
            "Audio-only render requires a Clip Composition Plan",
            "permanent",
          );
        }
        for (const output of outputs) {
          try {
            const compositionForOutput = {
              plan: compositionPlan,
              targetId: output.clipRenderId,
            };
            const fallbackCompositionForOutput =
              fallbackCompositionPlan && fallbackAudio
                ? {
                    plan: fallbackCompositionPlan,
                    targetId: output.clipRenderId,
                  }
                : null;
            const audioOptionalAssets = optionalCommandAssets.filter(
              ({ assetClass }) =>
                assetClass === "logo" ||
                assetClass === "music" ||
                assetClass === "sound_effect",
            );
            const ffmpegArgs = buildAudiogramArgs({
              sourcePath,
              outputPath: output.outputPath,
              startSec: clipStartSec,
              endSec: clipEndSec,
              aspectRatio: output.aspectRatio,
              composition: compositionForOutput,
              clipDurationSec,
              srtPath: output.subtitlePath ?? srtPath,
              logo,
              audio: plannedAudio,
              cutPlan,
              resolvedSceneAssets,
              resolvedSceneFonts,
            });

            const encodeStartedAtMs = currentTimeMs();
            await executeRenderCommandWithOptionalFallback({
              primaryArgs: ffmpegArgs,
              fallbackArgs:
                fallbackCompositionForOutput &&
                fallbackAudio &&
                audioOptionalAssets.length > 0
                  ? () =>
                      buildAudiogramArgs({
                        sourcePath,
                        outputPath: output.outputPath,
                        startSec: clipStartSec,
                        endSec: clipEndSec,
                        aspectRatio: output.aspectRatio,
                        composition: fallbackCompositionForOutput,
                        clipDurationSec,
                        srtPath: output.subtitlePath ?? srtPath,
                        logo: null,
                        audio: fallbackAudio,
                        cutPlan,
                        resolvedSceneAssets,
                        resolvedSceneFonts,
                      })
                  : undefined,
              optionalAssets: audioOptionalAssets,
              context: {
                workflowRunId: run.id,
                clipId: clip.id,
                clipRenderId: output.clipRenderId,
              },
              recordCommand: recordCompositionCommand,
              recordSourceDecodeCompleted:
                recordCompositionSourceDecodeCompleted,
              recordResourceSample: recordCompositionResourceSample,
            });
            const encodeDurationMs =
              recordCompositionEncodeCompleted(encodeStartedAtMs);
            // Upload runs in the bounded background queue (overlaps the next
            // clip's work). The stale-discard/`persisted` counting and the
            // upload-failure variant marking both live in `scheduleUpload`;
            // this catch now only ever sees ENCODE failures.
            scheduleUpload(output, {
              clipDurationSec,
              encodeMs: encodeDurationMs,
              motionAnalytics,
            });
          } catch (error) {
            rethrowWorkflowAttemptLost(error);
            rethrowRenderCancellation(error);
            const errorCode =
              error instanceof WorkflowFailure
                ? error.code
                : "ffmpeg_render_failed";

            await currentRenderAdapters().clip.failClipRenderVariant(
              attempt,
              output.clipRenderId,
              errorCode,
              error instanceof WorkflowFailure
                ? error.disposition
                : "retryable",
              { ...motionAnalytics, renderOutcome: "failed" },
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
        // Every video output is compiled from the shared composition plan.
        const plan = brollPlan;
        const brollCredits =
          plan && plan.credits.length > 0 ? JSON.stringify(plan.credits) : null;
        for (const output of outputs) {
          if (!compositionPlan || !plannedAudio) {
            throw new WorkflowWorkerError(
              "clip_composition_plan_missing",
              "Video render requires a Clip Composition Plan",
              "permanent",
            );
          }
          const compositionForOutput = {
            plan: compositionPlan,
            targetId: output.clipRenderId,
          };
          const optionalAssetFallbackPlan =
            fallbackCompositionPlan ?? compositionPlan;
          const fallbackCompositionForOutput = {
            plan: optionalAssetFallbackPlan,
            targetId: output.clipRenderId,
          };
          try {
            const resolvedBrollAssets = {
              ...Object.fromEntries(
                plan?.cutaways.map((cutaway) => [cutaway.ref, cutaway.path]) ?? [],
              ),
              ...Object.fromEntries(studioEdits.visualBroll.flatMap((placement) => {
                const ref = compositionAssetRef("visual_asset", `${placement.asset.id}:${placement.asset.fingerprint}`);
                const asset = resolvedSceneAssets[ref];
                return asset ? [[ref, asset.path] as const] : [];
              })),
            };
            const ffmpegArgs = Object.keys(resolvedBrollAssets).length > 0
              ? buildBrollVideoArgs({
                  sourcePath,
                  resolvedBrollAssets,
                  outputPath: output.outputPath,
                  startSec: clipStartSec,
                  endSec: clipEndSec,
                  aspectRatio: output.aspectRatio,
                  probe,
                  srtPath: output.subtitlePath ?? srtPath,
                  logo,
                  composition: compositionForOutput,
                  audio: plannedAudio,
                  background: backgroundPlan,
                  cutPlan,
                  resolvedSceneAssets,
                  resolvedSceneFonts,
                })
              : buildSingleVideoArgs({
                  sourcePath,
                  outputPath: output.outputPath,
                  startSec: clipStartSec,
                  endSec: clipEndSec,
                  aspectRatio: output.aspectRatio,
                  probe,
                  srtPath: output.subtitlePath ?? srtPath,
                  logo,
                  composition: compositionForOutput,
                  audio: plannedAudio,
                  background: backgroundPlan,
                  cutPlan,
                  resolvedSceneAssets,
                  resolvedSceneFonts,
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
                        logo: null,
                        composition: fallbackCompositionForOutput,
                        audio: fallbackAudio ?? plannedAudio,
                        background: fallbackBackgroundPlan,
                        cutPlan,
                        resolvedSceneAssets,
                        resolvedSceneFonts,
                      })
                  : undefined,
              optionalAssets: optionalCommandAssets,
              context: {
                workflowRunId: run.id,
                clipId: clip.id,
                clipRenderId: output.clipRenderId,
              },
              recordCommand: recordCompositionCommand,
              recordSourceDecodeCompleted:
                recordCompositionSourceDecodeCompleted,
              recordResourceSample: recordCompositionResourceSample,
            });
            const encodeDurationMs =
              recordCompositionEncodeCompleted(encodeStartedAtMs);
            // Bounded background upload — see `scheduleUpload`. This catch
            // now only ever sees encode/build failures.
            scheduleUpload(output, {
              clipDurationSec,
              brollCredits:
                commandMode === "primary" ? brollCredits : null,
              encodeMs: encodeDurationMs,
              motionAnalytics,
            });
          } catch (error) {
            rethrowWorkflowAttemptLost(error);
            rethrowRenderCancellation(error);
            const contractFailure = compositionContractFailure(error);
            const renderFailure =
              error instanceof WorkflowFailure ? error : contractFailure;
            const errorCode =
              renderFailure
                ? renderFailure.code
                : "ffmpeg_render_failed";
            await currentRenderAdapters().clip.failClipRenderVariant(
              attempt,
              output.clipRenderId,
              errorCode,
              renderFailure
                ? renderFailure.disposition
                : "retryable",
              { ...motionAnalytics, renderOutcome: "failed" },
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
      }

      const finalResourceMeasurement = measureCompositionResourceSafely();
      if (finalResourceMeasurement) {
        compositionResources.peakRssScope = finalResourceMeasurement.scope;
        recordCompositionResourceSample(finalResourceMeasurement.rssBytes);
      }
      log("info", "clip_composition_resources", {
        workflowRunId: run.id,
        clipId: clip.id,
        planVersion: compositionResources.planVersion,
        planFingerprint: compositionResources.planFingerprint,
        requestedMode: compositionResources.requestedMode,
        effectiveModes: compositionResources.effectiveModes,
        sceneCount: compositionResources.sceneCount,
        visualLayerCount: compositionResources.visualLayerCount,
        commandGrouping: "independent",
        targetCount: outputs.length,
        analysisRequestCount:
          compositionResources.analysisRequestKeys.size,
        analysisRequestKeys: [
          ...compositionResources.analysisRequestKeys,
        ].sort(),
        analysisExecutionCount:
          compositionResources.analysisExecutionCount,
        detectorExecutionCount:
          compositionResources.detectorExecutionCount,
        extractedSegmentCount:
          compositionResources.extractedSegmentCount,
        commandCount: compositionResources.commandCount,
        sourceDecodeCount: compositionResources.sourceDecodeCount,
        commandBytes: compositionResources.commandBytes,
        planningDurationMs: compositionResources.planningDurationMs,
        encodeDurationMs: compositionResources.encodeDurationMs,
        peakRssBytes: compositionResources.peakRssBytes,
        peakRssScope: compositionResources.peakRssScope,
      });

      const progress = 10 + Math.round(((clipGroupIndex + 1) / clipGroups.length) * 80);
      await currentRenderAdapters().project.reportProgress(attempt, progress);
    }

    // Settle every in-flight upload before reading `renderedVariantCount` —
    // the all-failed check and run completion below must see the final
    // truth, and render settlement must never race a
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
        attempt,
        clipRenderId,
      );
      await currentRenderAdapters().clip.failClipRenderVariant(
        attempt,
        clipRenderId,
        code,
        failure.disposition,
        motionAnalyticsByRenderId.has(clipRenderId)
          ? {
              ...motionAnalyticsByRenderId.get(clipRenderId)!,
              renderOutcome: "failed",
            }
          : undefined,
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
