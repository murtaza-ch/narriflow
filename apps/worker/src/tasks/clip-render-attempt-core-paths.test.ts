import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AudioAssetAccessError,
  clipService,
  type RenderWorkSetOutcome,
  type WorkflowAttemptContext,
  WorkflowAttemptLost,
  WorkflowFailure,
} from "@narriflow/services";
import {
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import type { TranscriptUtterance } from "@narriflow/validators";
import {
  compositionAssetRef,
  planClipComposition,
  screenLayoutInputFingerprint,
} from "@narriflow/composition-plan";
import { parseRenderConfig } from "../render-config";
import { productionWorkerProcessModule } from "../worker-process";
import {
  bindCompositionPlanAudioInputs,
  compileCompositionPlanAudioSchedule,
} from "../composition-ffmpeg-adapter";
import { buildClipCutPlan } from "./cut-plan";
import {
  buildAudiogramArgs,
  ClipRenderAttempt,
  type ClipRenderingWorkflowAttempt,
} from "./render-clips";

type PendingClipRender = Awaited<
  ReturnType<typeof clipService.getPendingClipRendersForWorkSet>
>[number];

function attemptContext(signal: AbortSignal): WorkflowAttemptContext {
  return { signal, reportProgress: async () => {} };
}

type CoreRenderTopology =
  "single-video" | "shared-multi-output" | "studio-per-output" | "audiogram";

type VariantState =
  | "pending"
  | "rendering"
  | "completed"
  | "retryable-failure"
  | "permanent-failure"
  | "superseded";

interface CoreVariantFixture {
  id: string;
  aspectRatio: "ratio_9_16" | "ratio_1_1" | "ratio_16_9" | "ratio_4_5";
  clipId?: string;
  clipIndex?: number;
  initialState?: VariantState;
  resolution?: "720p" | "1080p";
  exportVariant?: {
    exportId: string;
    watermark: boolean;
  } | null;
  clipSnapshot?: Record<string, unknown> | null;
}

interface CommandProbe {
  outputVariantIds: string[];
  args: readonly string[];
}

function clipFixture(input: {
  hasStudioEdit: boolean;
  overrides?: Record<string, unknown>;
}) {
  return {
    id: "clip-core-paths",
    index: 0,
    startSec: 2,
    endSec: 12,
    llmModel: "test",
    transcriptSlice: [],
    deletedRanges: null,
    captionPreset: null,
    studioEdits: input.hasStudioEdit
      ? { sourceAudio: { volume: 100, muted: true } }
      : null,
		editorDocumentVersion: 2,
		sceneBlocks: [],
		censorSegments: [],
		mediaMotions: [],
    brollCues: null,
    brollUrl: null,
    category: "other",
    ...input.overrides,
  };
}

function createCoreRenderPathTracer(input: {
  topology: CoreRenderTopology;
  attemptCount?: number;
  clipWindow?: { startSec: number; endSec: number };
  variants?: CoreVariantFixture[];
  failCommandsForVariantIds?: readonly string[];
  failFirstRenderCommand?: boolean;
  commandFailureDisposition?: "retryable" | "permanent";
  failCommandsContaining?: string;
  failUploadsForVariantIds?: readonly string[];
  rejectPersistenceForVariantIds?: readonly string[];
  supersedeCompletionsForVariantIds?: readonly string[];
  ownerTier?: "free" | "pro";
  transcriptSlice?: TranscriptUtterance[];
  clipOverrides?: Record<string, unknown>;
  projectBrandSnapshot?: unknown;
  projectBrandSnapshotFailure?: Error;
  logoDownloadFailure?: Error;
  configOverrides?: Record<string, string>;
  brollProviderFailure?: Error;
  brollCutaways?: Array<{
    query: string;
    downloadUrl: string;
    startSec: number;
    endSec: number;
    attribution: {
      authorName: string;
      authorUrl: string;
      pageUrl: string;
    };
  }>;
  brollDurationSec?: number | null;
  audioAssetFailure?: Error;
  audioAssetUrl?: string;
  audioAssets?: Readonly<
    Record<string, { url: string; durationSec: number }>
  >;
  optionalMediaFiles?: Readonly<Record<string, string>>;
  optionalDownloadFailure?: Error;
  optionalMediaInvalidFor?: "video" | "audio" | "image";
  backgroundDecodable?: boolean;
  faceAnalysisSamples?: Array<{ t: number; cx: number | null }> | null;
  faceAnalysisFailure?: Error;
  analysisExtractionFailure?: Error;
  analysisPersistenceFailure?: Error;
  analysisProcessOutcome?:
    "missing" | "timeout" | "nonzero" | "invalid" | "no-face" | "cancel";
  analysisAbortController?: AbortController;
  multiFaceAnalysisSamples?: Array<{
    t: number;
    faces: Array<{
      cx: number;
      cy: number;
      w: number;
      h: number;
      score: number;
    }>;
  }> | null;
  pipAnalysisResult?: {
    movingPxFrac: number | null;
    insufficientSamples: boolean;
    candidates: Array<{
      x: number;
      y: number;
      w: number;
      h: number;
      areaFrac: number;
      fillFrac: number;
      cornerAdjacent: boolean;
      medianDiffMean: number;
    }>;
  } | null;
  realMedia?: {
    sourcePath: string;
    logoPath?: string;
    probeOutput(variantId: string, filePath: string): Promise<void>;
  };
  sourceAccess?: {
    presignedUrl: string;
    failRangedProbe?: boolean;
  };
  compositionAdapterFailure?: Error;
  workspaceCleanupFailure?: Error;
  resourceMeasure?: () => {
    rssBytes: number;
    scope:
      | "worker_and_command_cgroup"
      | "worker_and_command_processes"
      | "worker_only";
  };
}) {
  const attempt: ClipRenderingWorkflowAttempt = {
    workflowRunId: "10000000-0000-4000-8000-000000000701",
    projectId: "20000000-0000-4000-8000-000000000702",
    stage: "clip_rendering",
    attemptId: "30000000-0000-4000-8000-000000000703",
    attemptCount: input.attemptCount ?? 1,
  };
  const defaultVariants: CoreVariantFixture[] =
    input.topology === "single-video"
      ? [{ id: "variant-9x16", aspectRatio: "ratio_9_16" }]
      : [
          { id: "variant-9x16", aspectRatio: "ratio_9_16" },
          { id: "variant-1x1", aspectRatio: "ratio_1_1" },
        ];
  const variantFixtures = input.variants ?? defaultVariants;
  const pendingRenders = variantFixtures.map((variant) => ({
    id: variant.id,
    clipId: variant.clipId ?? "clip-core-paths",
    aspectRatio: variant.aspectRatio,
    resolution: variant.resolution ?? "1080p",
    exportVariantId: variant.exportVariant ? `export-${variant.id}` : null,
    exportVariant: variant.exportVariant
      ? {
          id: `export-${variant.id}`,
          exportId: variant.exportVariant.exportId,
          watermark: variant.exportVariant.watermark,
        }
      : null,
    clipSnapshot: variant.clipSnapshot ?? null,
    clip: clipFixture({
      hasStudioEdit: input.topology === "studio-per-output",
      overrides: {
        id: variant.clipId ?? "clip-core-paths",
        index: variant.clipIndex ?? 0,
        transcriptSlice: input.transcriptSlice ?? [],
        ...input.clipOverrides,
        ...input.clipWindow,
      },
    }),
  })) as unknown as PendingClipRender[];
  const states = new Map(
    variantFixtures.map((variant) => [
      variant.id,
      variant.initialState ?? "pending",
    ]),
  );
  const failureCodes = new Map<string, string>();
  const failureDispositions = new Map<string, "retryable" | "permanent">();
  const commands: CommandProbe[] = [];
  const uploadedVariantIds: string[] = [];
  const persistedVariantIds: string[] = [];
  const mutationVariantIds: string[] = [];
  const diagnostics: Array<{
    message: string;
    context?: Record<string, unknown>;
  }> = [];
  const brollCacheWrites: string[] = [];
  const persistedAutoLayouts: Array<unknown> = [];
  const persistedSplitLayouts: Array<unknown> = [];
  const persistedScreenLayouts: Array<unknown> = [];
  let analysisExtractionCount = 0;
  let faceDetectorCount = 0;
  let multiFaceDetectorCount = 0;
  let pipDetectorCount = 0;
  let sceneDetectorCount = 0;
  let workspaceCleanupCount = 0;
  let settlementCalls = 0;

  const variantIdFromPath = (path: string): string | null =>
    variantFixtures.find((variant) => path.includes(variant.id))?.id ?? null;
  const outputVariantIds = (args: readonly string[]): string[] =>
    args.flatMap((arg) => {
      if (!arg.endsWith(".mp4") || !arg.includes("/clip-")) return [];
      const variantId = variantIdFromPath(arg);
      return variantId ? [variantId] : [];
    });
  const recordCommand = (args: readonly string[]): string[] => {
    const ids = outputVariantIds(args);
    commands.push({
      outputVariantIds: ids,
      args: [...args],
    });
    return ids;
  };

  const settle = (): RenderWorkSetOutcome => {
    settlementCalls += 1;
    const requested = variantFixtures.length;
    const succeeded = [...states.values()].filter(
      (state) => state === "completed",
    ).length;
    const superseded = [...states.values()].filter(
      (state) => state === "superseded",
    ).length;
    const retryableIds = variantFixtures.flatMap((variant) => {
      const state = states.get(variant.id);
      return state === "pending" ||
        state === "rendering" ||
        state === "retryable-failure"
        ? [variant.id]
        : [];
    });
    const permanentFailed = [...states.values()].filter(
      (state) => state === "permanent-failure",
    ).length;

    if (
      succeeded === 0 &&
      retryableIds.length > 0 &&
      attempt.attemptCount < 3
    ) {
      for (const variantId of retryableIds) states.set(variantId, "pending");
      return {
        status: "requeued",
        requested,
        succeeded,
        failed: permanentFailed,
        superseded,
        followUpWorkflowRunId: null,
      };
    }

    const failed = requested - succeeded - superseded;
    return {
      status:
        succeeded > 0 && failed > 0
          ? "partial"
          : succeeded > 0 || failed === 0
            ? "completed"
            : "failed",
      requested,
      succeeded,
      failed,
      superseded,
      followUpWorkflowRunId: null,
    };
  };

  const clipRenderAttempt = new ClipRenderAttempt({
    run: {
      id: attempt.workflowRunId,
      projectId: attempt.projectId,
      project: {
        title: "Core render paths",
        sourceStorageKey: `projects/${attempt.projectId}/source/input.${
          input.topology === "audiogram" ? "m4a" : "mp4"
        }`,
        sourceDurationSeconds: 20,
        userId: "user-core-paths",
        workspaceId: null,
      },
    },
    config: parseRenderConfig({
      WORKER_CLIP_RENDER_ATTEMPT_ENABLED: "1",
      WORKER_RENDER_SOURCE_MODE: input.sourceAccess ? "ranged" : "download",
      WORKER_LAYOUT_ENGINE: "0",
      WORKER_SCREEN_LAYOUT: "0",
      WORKER_SPLIT: "0",
      WORKER_BROLL: "0",
      ...input.configOverrides,
    }),
    lifecycle: {
      beginRenderWorkSet: async () => ({
        variantIds: variantFixtures.map((variant) => variant.id),
      }),
      settleRenderWorkSet: async () => settle(),
    },
    adapters: {
      state: {
        getFrozenRenderingStateForWorkSet: async () => ({
          sourceStorageKey: `projects/${attempt.projectId}/source/input.${
            input.topology === "audiogram" ? "m4a" : "mp4"
          }`,
          sourceDurationSeconds: 20,
          userId: "user-core-paths",
          workspaceId: null,
          ownerTier: input.ownerTier ?? "pro",
          brandSnapshot: input.projectBrandSnapshotFailure
            ? { status: "unavailable" as const }
            : {
                status: "available" as const,
                value: input.projectBrandSnapshot ?? null,
              },
          pendingRenders: pendingRenders.filter(
            (render) => states.get(render.id) === "pending",
          ),
        }),
      },
      workerProcess: {
        inspectMedia: async (request) => {
          if (input.realMedia) {
            if (
              input.sourceAccess?.failRangedProbe &&
              request.sourcePath === input.sourceAccess.presignedUrl
            ) {
              throw new WorkflowFailure(
                "worker_command_failed",
                "retryable",
                "Injected ranged probe failure",
              );
            }
            return productionWorkerProcessModule.inspectMedia(request);
          }
          return {
            durationSec: 20,
            width: input.topology === "audiogram" ? 0 : 1920,
            height: input.topology === "audiogram" ? 0 : 1080,
            hasVideo: input.topology !== "audiogram",
            hasAudio: true,
            hasVisualStream: input.topology !== "audiogram",
            fps: 30,
          };
        },
        execute: async (request) => {
          const { command, args } = request;
          if (command !== "ffmpeg") {
            switch (input.analysisProcessOutcome) {
              case "missing":
                throw new WorkflowFailure(
                  "worker_command_missing",
                  "permanent",
                  "Injected missing analysis executable",
                );
              case "timeout":
                throw new WorkflowFailure(
                  "worker_command_timeout",
                  "retryable",
                  "Injected analysis timeout",
                );
              case "nonzero":
                throw new WorkflowFailure(
                  "worker_command_failed",
                  "retryable",
                  "Injected nonzero analysis exit",
                );
              case "invalid":
                return { exitCode: 0, stdout: Buffer.from("not-json") };
              case "no-face":
                return {
                  exitCode: 0,
                  stdout: Buffer.from(JSON.stringify({ samples: [] })),
                };
              case "cancel": {
                const reason = new DOMException("Injected analysis cancellation", "AbortError");
                input.analysisAbortController?.abort(reason);
                request.signal.throwIfAborted();
                throw reason;
              }
              default:
                throw new Error(`Unexpected analysis command: ${command}`);
            }
          }
          expect(command).toBe("ffmpeg");
          const ids = recordCommand(args);
          if (input.failFirstRenderCommand && commands.length === 1) {
            throw new WorkflowFailure(
              "worker_command_input_invalid",
              "permanent",
              "Injected first optional-media command failure",
            );
          }
          if (ids.some((id) => input.failCommandsForVariantIds?.includes(id))) {
            throw new WorkflowFailure(
              "ffmpeg_render_failed",
              input.commandFailureDisposition ?? "retryable",
              "Injected command failure",
            );
          }
          if (
            input.failCommandsContaining &&
            args.some((arg) => arg.includes(input.failCommandsContaining!))
          ) {
            throw new WorkflowFailure(
              "worker_command_input_invalid",
              "permanent",
              "Injected optional-media command failure",
            );
          }
          return input.realMedia
            ? productionWorkerProcessModule.execute(request)
            : { exitCode: 0, stdout: Buffer.alloc(0) };
        },
        withScratchDirectory: async (_prefix, work, diagnose) => {
          const path = input.realMedia
            ? await mkdtemp(join(tmpdir(), "narriflow-core-render-paths-"))
            : "/tmp/narriflow-core-render-paths";
          try {
            return await work(path);
          } finally {
            workspaceCleanupCount += 1;
            if (input.workspaceCleanupFailure) {
              diagnose?.({
                operation: "scratch_cleanup",
                status: "failed",
                elapsedMs: 0,
                failureCode: "worker_scratch_cleanup_failed",
              });
            } else if (input.realMedia) {
              await rm(path, { recursive: true, force: true });
            }
          }
        },
      },
      ...(input.compositionAdapterFailure
        ? {
            composition: {
              compileVisualLayers: () => {
                throw input.compositionAdapterFailure;
              },
            },
          }
        : {}),
      project: {
        reportProgress: async () => {},
      },
      optionalAssets: {
        validateOptionalMedia: async (_path, kind) =>
          input.optionalMediaInvalidFor !== kind,
        ...(input.brollProviderFailure
          ? {
              resolveBrollCutaways: async () => {
                throw input.brollProviderFailure;
              },
            }
          : input.brollCutaways
            ? {
                resolveBrollCutaways: async () => input.brollCutaways!,
                getCachedBrollAssetPath: async () => null,
                saveBrollAssetToCache: async (url: string) => {
                  brollCacheWrites.push(url);
                },
              }
            : {}),
        ...(input.optionalDownloadFailure
          ? {
              downloadUrlToFile: async () => {
                throw input.optionalDownloadFailure;
              },
            }
          : {
              downloadUrlToFile: async (url, filePath) => {
                const sourcePath = input.optionalMediaFiles?.[url];
                if (sourcePath) await copyFile(sourcePath, filePath);
              },
            }),
        ...(input.backgroundDecodable !== undefined
          ? {
              probeBackgroundImageDecodable: async () =>
                input.backgroundDecodable!,
            }
          : {}),
        ...(input.brollDurationSec !== undefined
          ? {
              probeMediaDurationSec: async () => input.brollDurationSec!,
            }
          : {}),
      },
      ...(input.audioAssetFailure || input.audioAssetUrl || input.audioAssets
        ? {
            audioAsset: {
              resolveRenderSource: async (_userId, assetId) => {
                if (input.audioAssetFailure) throw input.audioAssetFailure;
                const asset = input.audioAssets?.[assetId];
                if (asset) {
                  return {
                    url: asset.url,
                    title: "Optional audio",
                    durationSec: asset.durationSec,
                  };
                }
                return input.audioAssetUrl
                  ? {
                      url: input.audioAssetUrl,
                      title: "Optional audio",
                      durationSec: 0.4,
                    }
                  : null;
              },
            },
          }
        : {}),
      ...(input.faceAnalysisSamples !== undefined ||
      input.faceAnalysisFailure ||
      input.analysisExtractionFailure ||
      input.multiFaceAnalysisSamples !== undefined ||
      input.pipAnalysisResult !== undefined
        ? {
            analysis: {
              extractFaceDetectionSegment: async (params) => {
                analysisExtractionCount += 1;
                if (input.analysisExtractionFailure) {
                  throw input.analysisExtractionFailure;
                }
                return {
                  path: `${params.tempDir}/extracted-analysis.mp4`,
                  startSec: 0,
                };
              },
              ...(input.faceAnalysisSamples !== undefined ||
              input.faceAnalysisFailure
                ? {
                    detectFacePath: async () => {
                      faceDetectorCount += 1;
                      if (input.faceAnalysisFailure) {
                        throw input.faceAnalysisFailure;
                      }
                      return input.faceAnalysisSamples
                        ? { samples: input.faceAnalysisSamples }
                        : null;
                    },
                  }
                : {}),
              ...(input.multiFaceAnalysisSamples !== undefined
                ? {
                    detectMultiFacePath: async () => {
                      multiFaceDetectorCount += 1;
                      return input.multiFaceAnalysisSamples
                        ? { samples: input.multiFaceAnalysisSamples }
                        : null;
                    },
                    detectSceneCuts: async () => {
                      sceneDetectorCount += 1;
                      return [];
                    },
                  }
                : {}),
              ...(input.pipAnalysisResult !== undefined
                ? {
                    detectPipPath: async () => {
                      pipDetectorCount += 1;
                      return input.pipAnalysisResult ?? null;
                    },
                  }
                : {}),
            },
          }
        : {}),
      clip: {
        completeClipAutoLayoutAnalysis: async (_attempt, _clipId, analysis) => {
          if (input.analysisPersistenceFailure) {
            throw input.analysisPersistenceFailure;
          }
          persistedAutoLayouts.push(analysis);
          return false;
        },
        completeClipSplitLayoutAnalysis: async (_attempt, _clipId, analysis) => {
          if (input.analysisPersistenceFailure) {
            throw input.analysisPersistenceFailure;
          }
          persistedSplitLayouts.push(analysis);
          return true;
        },
        completeClipSplitLayoutFailure: async (_attempt, _clipId, failure) => {
          persistedSplitLayouts.push(failure);
          return true;
        },
        completeClipRenderVariant: async (_attempt, variantId) => {
          mutationVariantIds.push(variantId);
          if (input.rejectPersistenceForVariantIds?.includes(variantId)) {
            throw new Error("Injected guarded persistence rejection");
          }
          if (input.supersedeCompletionsForVariantIds?.includes(variantId)) {
            states.set(variantId, "superseded");
            return { persisted: false };
          }
          states.set(variantId, "completed");
          persistedVariantIds.push(variantId);
          return { persisted: true };
        },
        failClipRenderVariant: async (_attempt, variantId, code, disposition) => {
          mutationVariantIds.push(variantId);
          states.set(
            variantId,
            disposition === "retryable"
              ? "retryable-failure"
              : "permanent-failure",
          );
          failureCodes.set(variantId, code);
          failureDispositions.set(variantId, disposition);
        },
        markClipRenderVariantRendering: async (_attempt, variantId) => {
          mutationVariantIds.push(variantId);
          if (states.get(variantId) !== "pending") return false;
          states.set(variantId, "rendering");
          return true;
        },
        setClipLayoutAnalysis: async (_attempt, _clipId, analysis) => {
          if (input.analysisPersistenceFailure) {
            throw input.analysisPersistenceFailure;
          }
          persistedScreenLayouts.push(analysis);
        },
        setClipLayoutAnalysisFailure: async (_attempt, _clipId, failure) => {
          persistedScreenLayouts.push(failure);
        },
      },
      storage: {
        presignDownloadUrl: async () => input.sourceAccess?.presignedUrl ?? "",
        downloadObjectToFile: async ({ key, filePath }) => {
          if (input.logoDownloadFailure && key.endsWith("/logo.png")) {
            throw input.logoDownloadFailure;
          }
          if (input.realMedia) {
            await copyFile(
              key.endsWith("/logo.png") && input.realMedia.logoPath
                ? input.realMedia.logoPath
                : input.realMedia.sourcePath,
              filePath,
            );
          }
        },
        putFileFromPath: async ({ filePath, key }) => {
          const variantId = variantIdFromPath(filePath);
          if (!variantId) throw new Error(`Unknown output path: ${filePath}`);
          if (input.failUploadsForVariantIds?.includes(variantId)) {
            throw new WorkflowFailure(
              "render_upload_failed",
              "retryable",
              "Injected upload failure",
            );
          }
          await input.realMedia?.probeOutput(variantId, filePath);
          uploadedVariantIds.push(variantId);
          return { key };
        },
        deleteObject: async (key) => ({ key }),
      },
      workspace: {
        stat: input.realMedia ? stat : async () => ({ size: 256 }) as never,
        writeFile: input.realMedia ? writeFile : async () => {},
      },
      ...(input.resourceMeasure
        ? { resource: { measure: input.resourceMeasure } }
        : {}),
      diagnose: ({ message, context }) =>
        diagnostics.push({ message, context }),
    },
  });

  return {
    attempt,
    analysisCounts: () => ({
      extraction: analysisExtractionCount,
      face: faceDetectorCount,
      multiFace: multiFaceDetectorCount,
      pip: pipDetectorCount,
      scene: sceneDetectorCount,
    }),
    brollCacheWrites,
    clipRenderAttempt,
    commands,
    diagnostics,
    failureCodes,
    failureDispositions,
    mutationVariantIds,
    persistedVariantIds,
    persistedAutoLayouts,
    persistedSplitLayouts,
    persistedScreenLayouts,
    settlementCalls: () => settlementCalls,
    workspaceCleanupCount: () => workspaceCleanupCount,
    states,
    uploadedVariantIds,
  };
}

const topologyFixtures: Array<{
  topology: CoreRenderTopology;
  commandCount: number;
  outputGroups: string[][];
}> = [
  {
    topology: "single-video",
    commandCount: 1,
    outputGroups: [["variant-9x16"]],
  },
  {
    topology: "shared-multi-output",
    commandCount: 2,
    outputGroups: [["variant-9x16"], ["variant-1x1"]],
  },
  {
    topology: "studio-per-output",
    commandCount: 2,
    outputGroups: [["variant-9x16"], ["variant-1x1"]],
  },
  {
    topology: "audiogram",
    commandCount: 2,
    outputGroups: [["variant-9x16"], ["variant-1x1"]],
  },
];

const deterministicProbe = {
  width: 1920,
  height: 1080,
  hasVideo: true,
  hasAudio: true,
  fps: 30,
};

function buildBaselineCommands(input: {
  topology: CoreRenderTopology;
  sourcePath: string;
  outputs: Array<{
    variantId: string;
    aspectRatio: "9:16" | "1:1";
    outputPath: string;
    resolution: "720p" | "1080p";
  }>;
  startSec: number;
  endSec: number;
  probe: typeof deterministicProbe;
  watermark: boolean;
  srtPath?: string | null;
}): readonly string[][] {
  const outputs = input.outputs.map((output) => ({
    clipRenderId: output.variantId,
    clipId: "clip-core-paths",
    clipIndex: 0,
    aspectRatio: output.aspectRatio,
    outputPath: output.outputPath,
    storageKey: "unused",
    resolution: output.resolution,
    watermark: input.watermark,
  }));
  const clipDurationSec = input.endSec - input.startSec;

  if (input.topology !== "audiogram") {
    throw new Error("baseline commands are only defined for audio-only renders");
  }
  const cutPlan = buildClipCutPlan([], {
    startSec: input.startSec,
    endSec: input.endSec,
  });
  const studioEdits = studioEditsSchema.parse({});
  return outputs.map((output) => {
    const canvas = {
      "9:16": { width: 1080, height: 1920 },
      "1:1": { width: 1080, height: 1080 },
      "16:9": { width: 1920, height: 1080 },
      "4:5": { width: 1080, height: 1350 },
    }[output.aspectRatio];
    const planned = planClipComposition({
      document: editorDocumentSchema.parse({
    version: 2,
        clipStartSec: 0,
        clipEndSec: clipDurationSec,
        captionPreset: captionPresetSchema.parse({}),
        transcriptSlice: [],
        studioEdits,
        brollUrl: null,
        deletedRanges: [],
      }),
      source: {
        identity: "audio:baseline",
        kind: "audio",
        width: 0,
        height: 0,
      },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        {
          id: output.clipRenderId,
          aspectRatio: output.aspectRatio,
          ...canvas,
        },
      ],
    });
    if (planned.status === "invalid") throw new Error(planned.error.code);
    const audio = bindCompositionPlanAudioInputs(
      compileCompositionPlanAudioSchedule(planned.plan),
      {},
    );
    return buildAudiogramArgs({
      sourcePath: input.sourcePath,
      outputPath: output.outputPath,
      startSec: input.startSec,
      endSec: input.endSec,
      aspectRatio: output.aspectRatio,
      composition: { plan: planned.plan, targetId: output.clipRenderId },
      audio,
      clipDurationSec,
      srtPath: input.srtPath ?? null,
      resolution: output.resolution,
      watermark: input.watermark,
      cutPlan,
    });
  });
}

function baselineCommandArgs(
  topology: CoreRenderTopology,
): readonly string[][] {
  const outputPath = (variantId: string) => `<output:${variantId}>`;
  const outputs = [
    {
      variantId: "variant-9x16",
      aspectRatio: "9:16" as const,
      outputPath: outputPath("variant-9x16"),
      resolution: "1080p" as const,
    },
    {
      variantId: "variant-1x1",
      aspectRatio: "1:1" as const,
      outputPath: outputPath("variant-1x1"),
      resolution: "1080p" as const,
    },
  ];
  return buildBaselineCommands({
    topology,
    sourcePath: "<source>",
    outputs: topology === "single-video" ? [outputs[0]!] : outputs,
    startSec: 2,
    endSec: 12,
    probe: deterministicProbe,
    watermark: false,
  });
}

function normalizeCommandArgs(
  args: readonly string[],
  variantIds: readonly string[],
): readonly string[] {
  return args.map((arg) => {
    if (/\/[^/]*source\.(?:mp4|m4a)$/.test(arg)) return "<source>";
    if (arg.endsWith(".srt")) return "<subtitle>";
    const variantId = variantIds.find(
      (candidate) => arg.endsWith(".mp4") && arg.includes(candidate),
    );
    return variantId
      ? `<output:${variantId}>`
      : arg.replace(/subtitles='[^']+\.srt'/g, "subtitles='<subtitle>'");
  });
}

for (const fixture of topologyFixtures) {
  test(`ClipRenderAttempt routes ${fixture.topology} through the expected command topology`, async () => {
    const harness = createCoreRenderPathTracer({
      topology: fixture.topology,
      resourceMeasure: () => ({
        rssBytes: 12_345,
        scope: "worker_only",
      }),
    });

    await expect(
      harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
    ).resolves.toEqual({
      status: "completed",
      requested: fixture.topology === "single-video" ? 1 : 2,
      succeeded: fixture.topology === "single-video" ? 1 : 2,
      failed: 0,
      superseded: 0,
      followUpWorkflowRunId: null,
    });
    expect(harness.commands).toHaveLength(fixture.commandCount);
    expect(harness.commands.map((command) => command.outputVariantIds)).toEqual(
      fixture.outputGroups,
    );
    if (fixture.topology === "audiogram") {
      expect(
        harness.commands.map((command) =>
          normalizeCommandArgs(command.args, command.outputVariantIds),
        ),
      ).toEqual(baselineCommandArgs(fixture.topology));
    } else {
      expect(harness.diagnostics).toContainEqual({
        message: "clip_composition_plan",
        context: expect.objectContaining({ requestedMode: "auto" }),
      });
    }
    expect(harness.uploadedVariantIds).toEqual(fixture.outputGroups.flat());
    expect(harness.persistedVariantIds).toEqual(fixture.outputGroups.flat());
    expect(harness.settlementCalls()).toBe(1);
    expect(harness.diagnostics).toContainEqual({
      message: "clip_composition_resources",
      context: expect.objectContaining({
        planVersion: 2,
        planFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
        requestedMode: expect.any(String),
        effectiveModes: expect.any(Array),
        sceneCount: expect.any(Number),
        visualLayerCount: expect.any(Number),
        commandGrouping: "independent",
        targetCount: fixture.outputGroups.flat().length,
        commandCount: fixture.commandCount,
        sourceDecodeCount: fixture.commandCount,
        commandBytes: expect.any(Number),
        planningDurationMs: expect.any(Number),
        encodeDurationMs: expect.any(Number),
        peakRssBytes: 12_345,
        peakRssScope: "worker_only",
      }),
    });
  });
}

test("ClipRenderAttempt isolates resource probe failure from rendering and settlement", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    resourceMeasure: () => {
      throw new Error("Injected resource probe failure");
    },
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.persistedVariantIds).toEqual(["variant-9x16"]);
  expect(harness.settlementCalls()).toBe(1);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_composition_resource_probe_failed",
    context: expect.objectContaining({
      phase: "diagnostics",
      failureCode: "resource_probe_failed",
    }),
  });
});

test("ClipRenderAttempt accepts the exact composition command budget and rejects one byte less before FFmpeg", async () => {
  const baseline = createCoreRenderPathTracer({ topology: "single-video" });
  await baseline.clipRenderAttempt.execute(baseline.attempt, attemptContext(new AbortController().signal));
  const command = baseline.commands[0];
  if (!command) throw new Error("baseline command missing");
  const encoder = new TextEncoder();
  const exactBytes = ["ffmpeg", ...command.args].reduce(
    (total, value) => total + encoder.encode(value).byteLength + 1,
    0,
  );

  const accepted = createCoreRenderPathTracer({
    topology: "single-video",
    configOverrides: {
      WORKER_COMPOSITION_MAX_COMMAND_BYTES: String(exactBytes),
    },
  });
  await expect(
    accepted.clipRenderAttempt.execute(accepted.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1 });

  const rejected = createCoreRenderPathTracer({
    topology: "single-video",
    configOverrides: {
      WORKER_COMPOSITION_MAX_COMMAND_BYTES: String(exactBytes - 1),
    },
  });
  await expect(
    rejected.clipRenderAttempt.execute(rejected.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "failed", failed: 1 });
  expect(rejected.commands).toHaveLength(0);
  expect(rejected.failureCodes.get("variant-9x16")).toBe(
    "composition_command_budget_exceeded",
  );
  expect(rejected.failureDispositions.get("variant-9x16")).toBe("permanent");
  expect(rejected.diagnostics).toContainEqual({
    message: "clip_composition_budget_rejected",
    context: expect.objectContaining({
      phase: "composition_command",
      failureCode: "composition_command_budget_exceeded",
      disposition: "permanent",
      budget: "command_bytes",
      measured: exactBytes,
      maximum: exactBytes - 1,
      commandGrouping: "independent",
    }),
  });
});

test("ClipRenderAttempt deduplicates keyed analysis and extraction across mixed targets", async () => {
  const face = (cx: number) => ({
    cx,
    cy: 0.3,
    w: 0.1,
    h: 0.2,
    score: 0.9,
  });
  const multiFaceAnalysisSamples = Array.from({ length: 12 }, (_, index) => ({
    t: index * 0.25,
    faces: [face(0.3), face(0.7)],
  }));
  const cases = [
    {
      label: "Automatic",
      input: {
        topology: "studio-per-output" as const,
        configOverrides: { WORKER_LAYOUT_ENGINE: "1" },
        multiFaceAnalysisSamples,
      },
      counts: { extraction: 1, face: 0, multiFace: 1, pip: 0, scene: 1 },
      requestKey: /^automatic-speaker-layout:[0-9a-f]{16}$/,
      detectorExecutionCount: 2,
    },
    {
      label: "Split",
      input: {
        topology: "studio-per-output" as const,
        clipOverrides: { studioEdits: { framing: { mode: "split" } } },
        configOverrides: { WORKER_SPLIT: "1" },
        multiFaceAnalysisSamples,
      },
      counts: { extraction: 1, face: 0, multiFace: 1, pip: 0, scene: 0 },
      requestKey: /^split-speaker-layout:[0-9a-f]{16}$/,
      detectorExecutionCount: 1,
    },
    {
      label: "Screen",
      input: {
        topology: "studio-per-output" as const,
        clipOverrides: { studioEdits: { framing: { mode: "screen" } } },
        configOverrides: { WORKER_SCREEN_LAYOUT: "1" },
        faceAnalysisSamples: Array.from({ length: 8 }, (_, index) => ({
          t: index * 0.25,
          cx: 0.88,
        })),
        pipAnalysisResult: {
          movingPxFrac: 0.04,
          insufficientSamples: false,
          candidates: [qualifyingPipCandidate],
        },
      },
      counts: { extraction: 1, face: 1, multiFace: 0, pip: 1, scene: 0 },
      requestKey: /^screen-layout:[0-9a-f]{16}$/,
      detectorExecutionCount: 2,
    },
  ];

  for (const analysisCase of cases) {
    const harness = createCoreRenderPathTracer(analysisCase.input);
    await expect(
      harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
      analysisCase.label,
    ).resolves.toMatchObject({ status: "completed", succeeded: 2 });
    expect(harness.analysisCounts(), analysisCase.label).toEqual(
      analysisCase.counts,
    );
    expect(harness.workspaceCleanupCount(), analysisCase.label).toBe(1);
    expect(harness.diagnostics, analysisCase.label).toContainEqual({
      message: "clip_composition_resources",
      context: expect.objectContaining({
        analysisRequestCount: 1,
        analysisRequestKeys: [expect.stringMatching(analysisCase.requestKey)],
        analysisExecutionCount: 1,
        detectorExecutionCount: analysisCase.detectorExecutionCount,
        extractedSegmentCount: 1,
      }),
    });
  }
});

test("ClipRenderAttempt degrades shared extraction failure without changing settlement", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "studio-per-output",
    configOverrides: { WORKER_LAYOUT_ENGINE: "1" },
    analysisExtractionFailure: new Error("Injected extraction failure"),
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 2, failed: 0 });
  expect(harness.analysisCounts()).toEqual({
    extraction: 1,
    face: 0,
    multiFace: 0,
    pip: 0,
    scene: 0,
  });
  expect(harness.commands).toHaveLength(2);
  expect(harness.workspaceCleanupCount()).toBe(1);
  expect(harness.settlementCalls()).toBe(1);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_reframe_segment_extract_failed",
    context: expect.objectContaining({
      phase: "media_analysis",
      analysisMode: "segment_extraction",
      failureCode: "analysis_input_unavailable",
      disposition: "degraded",
    }),
  });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_composition_resources",
    context: expect.objectContaining({
      analysisExecutionCount: 1,
      detectorExecutionCount: 0,
      extractedSegmentCount: 0,
    }),
  });
});

test("ClipRenderAttempt rejects unknown evidence versions before writes or commands", async () => {
  const cases = [
    {
      label: "Automatic",
      clipOverrides: {
        autoLayoutAnalysis: { version: 99, engine: "shot-layout-v99" },
      },
      configOverrides: { WORKER_LAYOUT_ENGINE: "1" },
    },
    {
      label: "Screen",
      clipOverrides: {
        studioEdits: { framing: { mode: "screen" } },
        layoutAnalysis: { version: 99, engine: "screen-layout-v99" },
      },
      configOverrides: { WORKER_SCREEN_LAYOUT: "1" },
    },
    {
      label: "Split",
      clipOverrides: {
        studioEdits: { framing: { mode: "split" } },
        splitLayoutAnalysis: { version: 99, engine: "explicit-split-v99" },
      },
      configOverrides: { WORKER_SPLIT: "1" },
    },
  ];

  for (const evidenceCase of cases) {
    const harness = createCoreRenderPathTracer({
      topology: "single-video",
      clipOverrides: evidenceCase.clipOverrides,
      configOverrides: evidenceCase.configOverrides,
    });
    await expect(
      harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
      evidenceCase.label,
    ).resolves.toMatchObject({ status: "failed", succeeded: 0, failed: 1 });
    expect(harness.commands, evidenceCase.label).toHaveLength(0);
    expect(harness.persistedAutoLayouts, evidenceCase.label).toHaveLength(0);
    expect(harness.persistedSplitLayouts, evidenceCase.label).toHaveLength(0);
    expect(harness.persistedScreenLayouts, evidenceCase.label).toHaveLength(0);
    expect(harness.persistedVariantIds, evidenceCase.label).toHaveLength(0);
    expect(harness.failureCodes.get("variant-9x16"), evidenceCase.label).toBe(
      "unsupported_clip_composition_evidence_version",
    );
    expect(
      harness.failureDispositions.get("variant-9x16"),
      evidenceCase.label,
    ).toBe("permanent");
    expect(harness.settlementCalls(), evidenceCase.label).toBe(1);
  }
});

test("ClipRenderAttempt skips analysis for Center, Fit, B-roll-short-circuited, and audio-only plans", async () => {
  const cases = [
    {
      topology: "single-video" as const,
      clipOverrides: { studioEdits: { framing: { mode: "center" } } },
    },
    {
      topology: "single-video" as const,
      clipOverrides: {
        studioEdits: { background: { mode: "color", color: "#000000" } },
      },
    },
    {
      topology: "single-video" as const,
      clipWindow: { startSec: 0, endSec: 15 },
      clipOverrides: {
        studioEdits: { framing: { mode: "screen" } },
        brollUrl: "https://media.example/broll.mp4",
      },
      brollDurationSec: 20,
    },
    { topology: "audiogram" as const },
  ];
  for (const analysisCase of cases) {
    const harness = createCoreRenderPathTracer({
      ...analysisCase,
      configOverrides: {
        WORKER_LAYOUT_ENGINE: "1",
        WORKER_SPLIT: "1",
        WORKER_SCREEN_LAYOUT: "1",
      },
      faceAnalysisSamples: [{ t: 0, cx: 0.5 }],
      multiFaceAnalysisSamples: [{
        t: 0,
        faces: [{ cx: 0.5, cy: 0.5, w: 0.2, h: 0.2, score: 0.9 }],
      }],
      pipAnalysisResult: {
        movingPxFrac: 0.04,
        insufficientSamples: false,
        candidates: [qualifyingPipCandidate],
      },
    });
    await harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal));
    expect(harness.analysisCounts()).toEqual({
      extraction: 0,
      face: 0,
      multiFace: 0,
      pip: 0,
      scene: 0,
    });
    expect(harness.diagnostics).toContainEqual({
      message: "clip_composition_resources",
      context: expect.objectContaining({
        analysisRequestCount: 0,
        analysisRequestKeys: [],
        analysisExecutionCount: 0,
        detectorExecutionCount: 0,
        extractedSegmentCount: 0,
      }),
    });
  }
});

test("ClipRenderAttempt omits an unavailable brand logo and diagnoses the fallback", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    projectBrandSnapshotFailure: new Error(
      "https://signed.example/logo.png?secret=do-not-log",
    ),
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({
      phase: "lookup",
      assetClass: "logo",
      failureCode: "brand_snapshot_unavailable",
      disposition: "degraded",
    }),
  });
  expect(JSON.stringify(harness.diagnostics)).not.toContain(
    "secret=do-not-log",
  );
});

test("ClipRenderAttempt retries an audio-only render without a command-failing logo", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "audiogram",
    failFirstRenderCommand: true,
    projectBrandSnapshot: {
      templateId: null,
      captionPreset: {},
      logoStorageKey: "projects/brand/logo.png",
      logoPosition: "bot-right",
      logoOpacity: 80,
      logoScalePct: 15,
      primaryColor: "#FFFFFF",
      secondaryColor: "#00FF88",
      accentColor: null,
    },
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 2, failed: 0 });
  expect(harness.commands).toHaveLength(3);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({
      phase: "command",
      assetClass: "logo",
      failureCode: "brand_logo_command_failed",
      disposition: "degraded",
    }),
  });
});

test("ClipRenderAttempt propagates ownership loss during brand logo download", async () => {
  const brandSnapshot = {
    templateId: null,
    captionPreset: {},
    logoStorageKey: "projects/brand/logo.png",
    logoPosition: "bot-right",
    logoOpacity: 80,
    logoScalePct: 15,
    primaryColor: "#FFFFFF",
    secondaryColor: "#00FF88",
    accentColor: null,
  };
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    projectBrandSnapshot: brandSnapshot,
  });
  const ownershipLoss = new WorkflowAttemptLost(harness.attempt);
  const interruptedHarness = createCoreRenderPathTracer({
    topology: "single-video",
    projectBrandSnapshot: brandSnapshot,
    logoDownloadFailure: ownershipLoss,
  });

  await expect(
    interruptedHarness.clipRenderAttempt.execute(interruptedHarness.attempt, attemptContext(new AbortController().signal)),
  ).rejects.toBe(ownershipLoss);
  expect(interruptedHarness.commands).toHaveLength(0);
  expect(interruptedHarness.persistedVariantIds).toHaveLength(0);
  expect(interruptedHarness.settlementCalls()).toBe(0);
});

test("ClipRenderAttempt omits a stored brand logo that fails decode validation", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    projectBrandSnapshot: {
      templateId: null,
      captionPreset: {},
      logoStorageKey: "projects/brand/logo.png",
      logoPosition: "bot-right",
      logoOpacity: 80,
      logoScalePct: 15,
      primaryColor: "#FFFFFF",
      secondaryColor: "#00FF88",
      accentColor: null,
    },
    optionalMediaInvalidFor: "image",
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({
      phase: "decode",
      assetClass: "logo",
      failureCode: "brand_logo_invalid",
    }),
  });
});

test("ClipRenderAttempt omits an invalid stored brand snapshot", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    projectBrandSnapshot: { logoStorageKey: "projects/brand/logo.png" },
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({
      phase: "parse",
      assetClass: "logo",
      failureCode: "brand_snapshot_invalid",
    }),
  });
});

test("ClipRenderAttempt skips unavailable stock B-roll through its optional-asset adapter", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipWindow: { startSec: 0, endSec: 15 },
    clipOverrides: { title: "Build a camera", hookText: "Workshop" },
    configOverrides: { WORKER_BROLL: "1", PEXELS_API_KEY: "configured" },
    brollProviderFailure: new Error(
      "provider rejected https://signed.example/video?secret=do-not-log",
    ),
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({
      phase: "lookup",
      assetClass: "broll",
      failureCode: "broll_provider_unavailable",
      disposition: "degraded",
    }),
  });
  expect(JSON.stringify(harness.diagnostics)).not.toContain(
    "secret=do-not-log",
  );
});

const resolvedBrollFixture = {
  query: "camera workshop",
  downloadUrl: "https://media.example/stock.mp4",
  startSec: 3,
  endSec: 6,
  attribution: {
    authorName: "Fixture Author",
    authorUrl: "https://media.example/author",
    pageUrl: "https://media.example/video",
  },
};

test("ClipRenderAttempt validates downloaded stock B-roll before caching it", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipWindow: { startSec: 0, endSec: 15 },
    clipOverrides: { title: "Build a camera", hookText: "Workshop" },
    configOverrides: { WORKER_BROLL: "1", PEXELS_API_KEY: "configured" },
    brollCutaways: [resolvedBrollFixture],
    optionalMediaInvalidFor: "video",
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.brollCacheWrites).toEqual([]);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({
      phase: "decode",
      assetClass: "broll",
      failureCode: "broll_media_invalid",
    }),
  });
});

test("ClipRenderAttempt preserves stock B-roll attribution after successful selection", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipWindow: { startSec: 0, endSec: 15 },
    clipOverrides: { title: "Build a camera", hookText: "Workshop" },
    configOverrides: { WORKER_BROLL: "1", PEXELS_API_KEY: "configured" },
    brollCutaways: [resolvedBrollFixture],
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.brollCacheWrites).toEqual([resolvedBrollFixture.downloadUrl]);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_broll_selected",
    context: expect.objectContaining({
      cutawayCount: 1,
      credits: [expect.objectContaining({ authorName: "Fixture Author" })],
    }),
  });
});

test("ClipRenderAttempt retries a failed stock B-roll composition without B-roll", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipWindow: { startSec: 0, endSec: 15 },
    clipOverrides: { title: "Build a camera", hookText: "Workshop" },
    configOverrides: { WORKER_BROLL: "1", PEXELS_API_KEY: "configured" },
    brollCutaways: [resolvedBrollFixture],
    failFirstRenderCommand: true,
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.commands).toHaveLength(2);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({
      phase: "command",
      assetClass: "broll",
      failureCode: "broll_command_failed",
    }),
  });
});

for (const brollFailure of [
  {
    label: "probe",
    input: { brollDurationSec: null },
    phase: "probe",
    failureCode: "broll_media_unusable",
  },
  {
    label: "decode",
    input: { optionalMediaInvalidFor: "video" as const },
    phase: "decode",
    failureCode: "broll_media_invalid",
  },
]) {
  test(`ClipRenderAttempt skips manual B-roll after ${brollFailure.label} failure`, async () => {
    const harness = createCoreRenderPathTracer({
      topology: "single-video",
      clipWindow: { startSec: 0, endSec: 15 },
      clipOverrides: { brollUrl: "https://media.example/broll.mp4" },
      ...brollFailure.input,
    });

    await expect(
      harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
    ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
    expect(harness.commands).toHaveLength(1);
    expect(harness.diagnostics).toContainEqual({
      message: "clip_render_optional_asset_fallback",
      context: expect.objectContaining({
        phase: brollFailure.phase,
        assetClass: "broll",
        failureCode: brollFailure.failureCode,
      }),
    });
  });
}

for (const optionalAudioCase of [
  {
    label: "music",
    assetClass: "music",
    failureCode: "music_asset_unavailable",
    studioEdits: {
      music: { assetId: "40000000-0000-4000-8000-000000000704" },
    },
  },
  {
    label: "sound effect",
    assetClass: "sound_effect",
    failureCode: "sound_effect_asset_unavailable",
    studioEdits: {
      sfx: [
        {
          id: "impact",
          assetId: "50000000-0000-4000-8000-000000000705",
          startSec: 1,
        },
      ],
    },
  },
] as const) {
  test(`ClipRenderAttempt skips unavailable ${optionalAudioCase.label} without exposing access data`, async () => {
    const harness = createCoreRenderPathTracer({
      topology: "single-video",
      clipOverrides: { studioEdits: optionalAudioCase.studioEdits },
      audioAssetFailure: new Error(
        "https://signed.example/audio?credential=do-not-log",
      ),
    });

    await expect(
      harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
    ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
    expect(harness.diagnostics).toContainEqual({
      message: "clip_render_optional_asset_fallback",
      context: expect.objectContaining({
        phase: "lookup",
        assetClass: optionalAudioCase.assetClass,
        failureCode: optionalAudioCase.failureCode,
        disposition: "degraded",
      }),
    });
    expect(JSON.stringify(harness.diagnostics)).not.toContain("credential");
  });
}

test("ClipRenderAttempt skips music when its refreshed access location cannot download", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      studioEdits: {
        music: { url: "https://media.example/music.mp3", volume: 25 },
      },
    },
    optionalDownloadFailure: new Error(
      "https://media.example/music.mp3?credential=do-not-log",
    ),
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({
      phase: "download",
      assetClass: "music",
      failureCode: "music_download_failed",
      disposition: "degraded",
    }),
  });
});

test("ClipRenderAttempt skips corrupt music after decode validation", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      studioEdits: {
        music: { url: "https://media.example/music.mp3", volume: 25 },
      },
    },
    optionalMediaInvalidFor: "audio",
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.commands).toHaveLength(1);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({
      phase: "decode",
      assetClass: "music",
      failureCode: "music_media_invalid",
      disposition: "degraded",
    }),
  });
});

test("ClipRenderAttempt skips a corrupt sound effect after decode validation", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      studioEdits: {
        sfx: [
          {
            id: "impact",
            assetId: "50000000-0000-4000-8000-000000000705",
            startSec: 1,
          },
        ],
      },
    },
    audioAssetUrl: "https://media.example/impact.mp3",
    optionalMediaInvalidFor: "audio",
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({
      phase: "decode",
      assetClass: "sound_effect",
      failureCode: "sound_effect_media_invalid",
    }),
  });
});

test("ClipRenderAttempt retries a failed sound-effect mix without sound effects", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      studioEdits: {
        sfx: [
          {
            id: "impact",
            assetId: "50000000-0000-4000-8000-000000000705",
            startSec: 1,
          },
        ],
      },
    },
    audioAssetUrl: "https://media.example/impact.mp3",
    failFirstRenderCommand: true,
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.commands).toHaveLength(2);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({
      phase: "command",
      assetClass: "sound_effect",
      failureCode: "sound_effect_mix_failed",
    }),
  });
});

test("ClipRenderAttempt retries a failed optional music mix without music", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      studioEdits: {
        music: { url: "https://media.example/music.mp3", volume: 25 },
      },
    },
    failCommandsContaining: "music-",
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.commands).toHaveLength(2);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({
      phase: "command",
      assetClass: "music",
      failureCode: "music_mix_failed",
      disposition: "degraded",
    }),
  });
});

test("ClipRenderAttempt does not report degradation when the required fallback command also fails", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      studioEdits: {
        music: { url: "https://media.example/music.mp3", volume: 25 },
      },
    },
    failCommandsForVariantIds: ["variant-9x16"],
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "requeued", succeeded: 0 });
  expect(harness.diagnostics).not.toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({ phase: "command" }),
  });
});

test("ClipRenderAttempt classifies an optional music access refresh failure", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      studioEdits: {
        music: { assetId: "40000000-0000-4000-8000-000000000704" },
      },
    },
    audioAssetFailure: new AudioAssetAccessError(),
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({
      phase: "presign",
      assetClass: "music",
      failureCode: "music_presign_failed",
    }),
  });
});

test("ClipRenderAttempt settles output when optional workspace cleanup fails", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      studioEdits: {
        music: { url: "https://media.example/music.mp3", volume: 25 },
      },
    },
    workspaceCleanupFailure: new Error("Injected cleanup failure"),
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({
      phase: "cleanup",
      assetClass: "music",
      failureCode: "optional_asset_cleanup_failed",
      disposition: "degraded",
    }),
  });
});

test("ClipRenderAttempt uses the frozen solid color when a background image is corrupt", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      studioEdits: {
        background: {
          mode: "image",
          color: "#123456",
          imageUrl: "https://media.example/background.jpg",
        },
      },
    },
    backgroundDecodable: false,
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.commands).toHaveLength(1);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({
      phase: "probe",
      assetClass: "background",
      failureCode: "background_image_invalid",
      disposition: "degraded",
    }),
  });
});

test("ClipRenderAttempt uses the frozen solid color when background decode fails", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      studioEdits: {
        background: {
          mode: "image",
          color: "#123456",
          imageUrl: "https://media.example/background.jpg",
        },
      },
    },
    backgroundDecodable: true,
    optionalMediaInvalidFor: "image",
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_optional_asset_fallback",
    context: expect.objectContaining({
      phase: "decode",
      assetClass: "background",
      failureCode: "background_image_decode_failed",
    }),
  });
});

test("ClipRenderAttempt propagates ownership loss from fenced analysis persistence", async () => {
  const baseline = createCoreRenderPathTracer({ topology: "single-video" });
  const ownershipLoss = new WorkflowAttemptLost(baseline.attempt);
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      previewStorageKey: "projects/test/previews/current.mp4",
      editorRevision: 0,
    },
    configOverrides: { WORKER_LAYOUT_ENGINE: "1" },
    multiFaceAnalysisSamples: [
      {
        t: 0,
        faces: [{ cx: 0.5, cy: 0.4, w: 0.2, h: 0.3, score: 0.9 }],
      },
    ],
    analysisPersistenceFailure: ownershipLoss,
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).rejects.toBe(ownershipLoss);
  expect(harness.commands).toHaveLength(0);
  expect(harness.persistedVariantIds).toHaveLength(0);
  expect(harness.settlementCalls()).toBe(0);
});

test("ClipRenderAttempt records degraded Screen evidence when analysis is unavailable", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      studioEdits: { framing: { mode: "screen" } },
      previewStorageKey: "projects/test/previews/current.mp4",
      editorRevision: 0,
    },
    configOverrides: {
      WORKER_SCREEN_LAYOUT: "1",
    },
    faceAnalysisSamples: null,
    pipAnalysisResult: null,
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_screen_pip_fallback",
    context: expect.objectContaining({
      phase: "media_analysis",
      analysisMode: "picture_in_picture",
      fallbackMode: "speaker_band",
      failureCode: "detection_unavailable",
      disposition: "degraded",
      durationMs: expect.any(Number),
    }),
  });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_composition_plan",
    context: expect.objectContaining({
      requestedMode: "screen",
      noticeCodes: ["screen_detection_unavailable"],
    }),
  });
  expect(harness.persistedScreenLayouts).toContainEqual(
    expect.objectContaining({
      state: "failed",
      reason: "detection_unavailable",
      sourceIdentity: expect.any(String),
      inputFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
    }),
  );
});

const qualifyingPipCandidate = {
  x: 0.8,
  y: 0.05,
  w: 0.18,
  h: 0.3,
  areaFrac: 0.054,
  fillFrac: 0.8,
  cornerAdjacent: true,
  medianDiffMean: 22,
};

test("ClipRenderAttempt selects a qualifying picture-in-picture crop", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: { studioEdits: { framing: { mode: "screen" } } },
    configOverrides: {
      WORKER_SCREEN_LAYOUT: "1",
    },
    faceAnalysisSamples: Array.from({ length: 8 }, (_, index) => ({
      t: index * 0.25,
      cx: 0.88,
    })),
    pipAnalysisResult: {
      movingPxFrac: 0.04,
      insufficientSamples: false,
      candidates: [qualifyingPipCandidate],
    },
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_screen_pip_selected",
    context: expect.objectContaining({
      phase: "media_analysis",
      analysisMode: "picture_in_picture",
      selectedMode: "pip_crop",
      analysisSource: "fresh",
    }),
  });
});

test("ClipRenderAttempt always compiles Screen through the shared plan", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      studioEdits: { framing: { mode: "screen" } },
      previewStorageKey: "projects/test/previews/current.mp4",
      editorRevision: 0,
    },
    configOverrides: {
      WORKER_SCREEN_LAYOUT: "1",
    },
    faceAnalysisSamples: Array.from({ length: 8 }, (_, index) => ({
      t: index * 0.25,
      cx: 0.88,
    })),
    pipAnalysisResult: {
      movingPxFrac: 0.04,
      insufficientSamples: false,
      candidates: [qualifyingPipCandidate],
    },
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  const graph = harness.commands[0]?.args.join(" ") ?? "";
  expect(graph).toContain("composition_scene_0_layer_0_src");
  expect(graph).toContain("force_original_aspect_ratio=decrease");
  expect(graph).not.toContain("screen_top_src");
  expect(harness.diagnostics).toContainEqual({
    message: "clip_composition_plan",
    context: expect.objectContaining({
      requestedMode: "screen",
      effectiveModes: ["screen"],
    }),
  });
  expect(harness.persistedScreenLayouts.at(-1)).toMatchObject({
    version: 2,
    engine: "screen-layout-v2",
    sourceIdentity: expect.any(String),
    inputFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
    sourceWidth: 1920,
    sourceHeight: 1080,
    faceBandSegments: expect.arrayContaining([
      expect.objectContaining({ layout: "single" }),
    ]),
  });
});

test("ClipRenderAttempt reuses matching Screen v2 evidence without rerunning or downgrading face analysis", async () => {
  const sourceIdentity = compositionAssetRef(
    "source",
    "20000000-0000-4000-8000-000000000702",
  );
  const engine = "screen-layout-v2";
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      studioEdits: { framing: { mode: "screen" } },
      layoutAnalysis: {
        version: 2,
        engine,
        sourceIdentity,
        inputFingerprint: screenLayoutInputFingerprint({
          sourceIdentity,
          clipStartSec: 2,
          clipEndSec: 12,
          deletedRanges: [],
          engineVersion: engine,
        }),
        analyzedAtISO: "2026-08-26T00:00:00.000Z",
        sourceStartSec: 2,
        sourceDurationSec: 10,
        clipStartSec: 2,
        clipEndSec: 12,
        movingPxFrac: 0.04,
        insufficientSamples: false,
        pipRect: qualifyingPipCandidate,
        pipUsable: true,
        sourceWidth: 1920,
        sourceHeight: 1080,
        deletedRanges: [],
        faceBandSegments: [
          { startSec: 0, endSec: 10, layout: "single", cxNorm: 0.88 },
        ],
      },
    },
    configOverrides: {
      WORKER_SCREEN_LAYOUT: "1",
    },
    faceAnalysisFailure: new Error("face analysis must not rerun"),
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.persistedScreenLayouts).toHaveLength(0);
  expect(harness.analysisCounts()).toEqual({
    extraction: 0,
    face: 0,
    multiFace: 0,
    pip: 0,
    scene: 0,
  });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_composition_plan",
    context: expect.objectContaining({
      evidenceSource: "durable-pip",
      effectiveModes: ["screen"],
    }),
  });
});

test("ClipRenderAttempt preserves speaker-band framing for a valid no-screen result", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: { studioEdits: { framing: { mode: "screen" } } },
    configOverrides: {
      WORKER_SCREEN_LAYOUT: "1",
    },
    faceAnalysisSamples: Array.from({ length: 8 }, (_, index) => ({
      t: index * 0.25,
      cx: 0.88,
    })),
    pipAnalysisResult: {
      movingPxFrac: 0.4,
      insufficientSamples: false,
      candidates: [qualifyingPipCandidate],
    },
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_screen_pip_fallback",
    context: expect.objectContaining({
      phase: "media_analysis",
      analysisMode: "picture_in_picture",
      fallbackMode: "speaker_band",
      failureCode: "not_screencast_like",
      disposition: "degraded",
    }),
  });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_composition_plan",
    context: expect.objectContaining({
      requestedMode: "screen",
      noticeCodes: ["screen_face_band_fallback"],
    }),
  });
  const graph = harness.commands[0]?.args.join(" ") ?? "";
  expect(graph).toContain("composition_scene_0_layer_1_src");
  expect(graph).not.toContain("sendcmd=");
});

test("ClipRenderAttempt applies a deterministic split-layout analysis", async () => {
  const face = (cx: number) => ({
    cx,
    cy: 0.3,
    w: 0.1,
    h: 0.2,
    score: 0.9,
  });
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: { studioEdits: { framing: { mode: "split" } } },
    configOverrides: { WORKER_SPLIT: "1" },
    multiFaceAnalysisSamples: Array.from({ length: 40 }, (_, index) => ({
      t: index * 0.25,
      faces: [face(0.3), face(0.7)],
    })),
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_split_applied",
    context: expect.objectContaining({
      phase: "media_analysis",
      analysisMode: "split_layout",
      selectedMode: "two_up",
      durationMs: expect.any(Number),
    }),
  });
});

test("ClipRenderAttempt reuses matching durable Split evidence without rerunning or downgrading analysis", async () => {
  const sourceIdentity = compositionAssetRef(
    "source",
    "20000000-0000-4000-8000-000000000702",
  );
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      studioEdits: { framing: { mode: "split" } },
      previewStorageKey: "projects/test/previews/current.mp4",
      editorRevision: 0,
      splitLayoutAnalysis: {
        version: 1,
        engine: "explicit-split-v1",
        sourceIdentity,
        analyzedAtISO: "2026-08-26T00:00:00.000Z",
        clipStartSec: 2,
        clipEndSec: 12,
        deletedRanges: [],
        editedDurationSec: 10,
        sourceWidth: 1920,
        sourceHeight: 1080,
        segments: [
          {
            startSec: 0,
            endSec: 10,
            layout: "two-up",
            topCxNorm: 0.3,
            bottomCxNorm: 0.7,
          },
        ],
        noSplitSegments: [
          {
            startSec: 0,
            endSec: 10,
            layout: "single",
            cxNorm: 0.3,
          },
        ],
        shotCount: 1,
        soloShotCount: 0,
        multiShotCount: 1,
        twoUpSegmentCount: 1,
        speakerCount: 2,
        mappedSpeakerCount: 2,
      },
    },
    configOverrides: { WORKER_SPLIT: "1" },
    multiFaceAnalysisSamples: null,
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.persistedSplitLayouts).toHaveLength(0);
  expect(harness.analysisCounts()).toEqual({
    extraction: 0,
    face: 0,
    multiFace: 0,
    pip: 0,
    scene: 0,
  });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_composition_plan",
    context: expect.objectContaining({
      evidenceSource: "durable-explicit",
      effectiveModes: ["split"],
    }),
  });
});

test("ClipRenderAttempt compiles explicit Split through the shared plan", async () => {
  const face = (cx: number) => ({
    cx,
    cy: 0.3,
    w: 0.1,
    h: 0.2,
    score: 0.9,
  });
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      studioEdits: { framing: { mode: "split" } },
      previewStorageKey: "projects/test/previews/current.mp4",
      editorRevision: 0,
    },
    configOverrides: {
      WORKER_SPLIT: "1",
    },
    multiFaceAnalysisSamples: Array.from({ length: 12 }, (_, index) => ({
      t: index * 0.25,
      faces: [face(0.3), face(0.7)],
    })),
  });

  const splitResult = await harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal));
  if (splitResult.status !== "completed") {
    throw new Error(
      JSON.stringify({
        splitResult,
        diagnostics: harness.diagnostics,
        failures: [...harness.failureCodes],
      }),
    );
  }
  expect(splitResult).toMatchObject({
    status: "completed",
    succeeded: 1,
    failed: 0,
  });
  const graph = harness.commands[0]?.args.join(" ") ?? "";
  expect(graph).toContain("composition_scene_0_layer_0_src");
  expect(graph).not.toContain("split_seg0_src");
  expect(harness.diagnostics).toContainEqual({
    message: "clip_composition_plan",
    context: expect.objectContaining({
      requestedMode: "split",
      effectiveModes: ["split"],
    }),
  });
  expect(harness.persistedAutoLayouts).toHaveLength(0);
  expect(harness.persistedSplitLayouts).toHaveLength(1);
  expect(harness.persistedSplitLayouts[0]).toMatchObject({
    engine: "explicit-split-v1",
    segments: expect.arrayContaining([
      expect.objectContaining({ layout: "two-up" }),
    ]),
    noSplitSegments: expect.arrayContaining([
      expect.objectContaining({ layout: "single" }),
    ]),
  });
});

test("ClipRenderAttempt keeps Split rendering when preview evidence persistence fails", async () => {
  const face = (cx: number) => ({
    cx,
    cy: 0.3,
    w: 0.1,
    h: 0.2,
    score: 0.9,
  });
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: {
      studioEdits: { framing: { mode: "split" } },
      previewStorageKey: "projects/test/previews/current.mp4",
      editorRevision: 0,
    },
    configOverrides: {
      WORKER_SPLIT: "1",
    },
    multiFaceAnalysisSamples: Array.from({ length: 12 }, (_, index) => ({
      t: index * 0.25,
      faces: [face(0.3), face(0.7)],
    })),
    analysisPersistenceFailure: new Error("injected persistence failure"),
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_split_layout_analysis_persist_failed",
    context: expect.objectContaining({
      analysisMode: "split_layout",
      failureCode: "analysis_persist_failed",
    }),
  });
});

test("ClipRenderAttempt degrades only the ineligible Split target", async () => {
  const face = (cx: number) => ({
    cx,
    cy: 0.3,
    w: 0.1,
    h: 0.2,
    score: 0.9,
  });
  const harness = createCoreRenderPathTracer({
    topology: "studio-per-output",
    clipOverrides: { studioEdits: { framing: { mode: "split" } } },
    configOverrides: {
      WORKER_SPLIT: "1",
    },
    multiFaceAnalysisSamples: Array.from({ length: 12 }, (_, index) => ({
      t: index * 0.25,
      faces: [face(0.2 + (index % 6) * 0.04), face(0.7)],
    })),
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 2, failed: 0 });
  const verticalGraph =
    harness.commands
      .find((command) => command.outputVariantIds.includes("variant-9x16"))
      ?.args.join(" ") ?? "";
  const squareGraph =
    harness.commands
      .find((command) => command.outputVariantIds.includes("variant-1x1"))
      ?.args.join(" ") ?? "";
  expect(verticalGraph).toContain("vstack=inputs=2");
  expect(squareGraph).not.toContain("vstack=inputs=2");
  expect(squareGraph).toContain("composition_scene_0_src");
  expect(squareGraph).not.toContain("sendcmd=f=");
  expect(harness.diagnostics).toContainEqual({
    message: "clip_composition_plan",
    context: expect.objectContaining({
      requestedMode: "split",
      effectiveModes: ["split", "auto"],
      noticeCodes: ["split_target_ineligible"],
    }),
  });
});

test("ClipRenderAttempt reuses matching durable Automatic evidence without rerunning analysis", async () => {
  const sourceIdentity = compositionAssetRef(
    "source",
    "20000000-0000-4000-8000-000000000702",
  );
  const segment = {
    startSec: 0,
    endSec: 10,
    layout: "single" as const,
    cxNorm: 0.46,
  };
  const harness = createCoreRenderPathTracer({
    topology: "studio-per-output",
    clipOverrides: {
      autoLayoutAnalysis: {
        version: 1,
        engine: "shot-layout-v1",
        sourceIdentity,
        analyzedAtISO: "2026-08-26T00:00:00.000Z",
        clipStartSec: 2,
        clipEndSec: 12,
        deletedRanges: [],
        editedDurationSec: 10,
        sourceWidth: 1920,
        sourceHeight: 1080,
        segments: [segment],
        noSplitSegments: [segment],
        shotCount: 1,
        soloShotCount: 1,
        multiShotCount: 0,
        twoUpSegmentCount: 0,
        speakerCount: 1,
        mappedSpeakerCount: 1,
      },
    },
    configOverrides: { WORKER_LAYOUT_ENGINE: "1" },
    multiFaceAnalysisSamples: null,
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 2, failed: 0 });
  expect(harness.persistedAutoLayouts).toHaveLength(0);
  expect(harness.analysisCounts()).toEqual({
    extraction: 0,
    face: 0,
    multiFace: 0,
    pip: 0,
    scene: 0,
  });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_composition_resources",
    context: expect.objectContaining({
      analysisRequestCount: 0,
      analysisExecutionCount: 0,
      detectorExecutionCount: 0,
      extractedSegmentCount: 0,
      commandCount: 2,
      sourceDecodeCount: 2,
    }),
  });
});

test("ClipRenderAttempt rejects shot-layout evidence truncated before the canonical window", async () => {
  const face = (cx: number) => ({
    cx,
    cy: 0.3,
    w: 0.1,
    h: 0.2,
    score: 0.9,
  });
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    configOverrides: {
      WORKER_LAYOUT_ENGINE: "1",
    },
    multiFaceAnalysisSamples: Array.from({ length: 12 }, (_, index) => ({
      t: index * 0.25,
      faces: [face(0.3), face(0.7)],
    })),
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_layout_plan_fallback",
    context: expect.objectContaining({
      phase: "media_analysis",
      analysisMode: "layout_engine",
      failureCode: "no_trustworthy_faces",
      durationMs: expect.any(Number),
    }),
  });
});

for (const disabledAnalysisCase of [
  {
    mode: "screen",
    message: "clip_screen_fallback",
    analysisMode: "screen_layout",
  },
  {
    mode: "split",
    message: "clip_split_fallback",
    analysisMode: "split_layout",
  },
] as const) {
  test(`ClipRenderAttempt reports the literal-0 ${disabledAnalysisCase.mode} capability fallback`, async () => {
    const harness = createCoreRenderPathTracer({
      topology: "single-video",
      clipOverrides: {
        studioEdits: { framing: { mode: disabledAnalysisCase.mode } },
      },
    });

    await expect(
      harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
    ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
    expect(harness.analysisCounts()).toEqual({
      extraction: 0,
      face: 0,
      multiFace: 0,
      pip: 0,
      scene: 0,
    });
    expect(harness.diagnostics).toContainEqual({
      message: disabledAnalysisCase.message,
      context: expect.objectContaining({
        phase: "media_analysis",
        analysisMode: disabledAnalysisCase.analysisMode,
        fallbackMode: "composition_plan",
        failureCode: "analysis_disabled",
        disposition: "degraded",
      }),
    });
  });
}

for (const disabledPlanCase of [
  { mode: "screen" },
  { mode: "split" },
] as const) {
  test(`ClipRenderAttempt uses the planned ${disabledPlanCase.mode} fallback when analysis is disabled`, async () => {
    const harness = createCoreRenderPathTracer({
      topology: "single-video",
      clipOverrides: {
        studioEdits: { framing: { mode: disabledPlanCase.mode } },
      },
      configOverrides: {},
      faceAnalysisSamples: [
        { t: 0, cx: 0.2 },
        { t: 1, cx: 0.5 },
        { t: 2, cx: 0.8 },
      ],
    });

    await expect(
      harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
    ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
    const graph = harness.commands[0]?.args.join(" ") ?? "";
    expect(graph).not.toContain("sendcmd=");
    expect(
      harness.diagnostics.some(
        (diagnostic) => diagnostic.message === "clip_reframe_applied",
      ),
    ).toBe(false);
    expect(harness.diagnostics).toContainEqual({
      message: "clip_composition_plan",
      context: expect.objectContaining({
        requestedMode: disabledPlanCase.mode,
        effectiveModes: ["center"],
      }),
    });
  });
}

test("ClipRenderAttempt contains a per-output command failure to its variant", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "shared-multi-output",
    variants: [
      {
        id: "group-a-9x16",
        clipId: "clip-group-a",
        clipIndex: 0,
        aspectRatio: "ratio_9_16",
      },
      {
        id: "group-a-1x1",
        clipId: "clip-group-a",
        clipIndex: 0,
        aspectRatio: "ratio_1_1",
      },
      {
        id: "group-b-9x16",
        clipId: "clip-group-b",
        clipIndex: 1,
        aspectRatio: "ratio_9_16",
      },
    ],
    failCommandsForVariantIds: ["group-a-9x16"],
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual({
    status: "partial",
    requested: 3,
    succeeded: 2,
    failed: 1,
    superseded: 0,
    followUpWorkflowRunId: null,
  });
  expect(harness.commands.map((command) => command.outputVariantIds)).toEqual([
    ["group-a-9x16"],
    ["group-a-1x1"],
    ["group-b-9x16"],
  ]);
  expect(harness.states.get("group-a-9x16")).toBe("retryable-failure");
  expect(harness.states.get("group-a-1x1")).toBe("completed");
  expect(harness.states.get("group-b-9x16")).toBe("completed");
  expect(harness.uploadedVariantIds).toEqual(["group-a-1x1", "group-b-9x16"]);
});

test("ClipRenderAttempt permanently classifies a composition adapter contract failure before FFmpeg", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    compositionAdapterFailure: new Error(
      "invalid_clip_composition_visual_layers",
    ),
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "failed", succeeded: 0, failed: 1 });
  expect(harness.commands).toHaveLength(0);
  expect(harness.failureCodes.get("variant-9x16")).toBe(
    "invalid_clip_composition_plan",
  );
  expect(harness.failureDispositions.get("variant-9x16")).toBe("permanent");
});

test("ClipRenderAttempt settles a per-output failure as terminal partial", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "studio-per-output",
    failCommandsForVariantIds: ["variant-9x16"],
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual({
    status: "partial",
    requested: 2,
    succeeded: 1,
    failed: 1,
    superseded: 0,
    followUpWorkflowRunId: null,
  });
  expect(harness.commands.map((command) => command.outputVariantIds)).toEqual([
    ["variant-9x16"],
    ["variant-1x1"],
  ]);
  expect(harness.persistedVariantIds).toEqual(["variant-1x1"]);
  expect(harness.states.get("variant-9x16")).toBe("retryable-failure");
  expect(harness.states.get("variant-1x1")).toBe("completed");
  expect(harness.commands).toHaveLength(2);
  expect(harness.settlementCalls()).toBe(1);
});

test("ClipRenderAttempt contains an audiogram command failure to one output", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "audiogram",
    failCommandsForVariantIds: ["variant-9x16"],
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual({
    status: "partial",
    requested: 2,
    succeeded: 1,
    failed: 1,
    superseded: 0,
    followUpWorkflowRunId: null,
  });
  expect(harness.states.get("variant-9x16")).toBe("retryable-failure");
  expect(harness.states.get("variant-1x1")).toBe("completed");
  expect(harness.persistedVariantIds).toEqual(["variant-1x1"]);
});

test("ClipRenderAttempt records one failed upload without discarding sibling output", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "shared-multi-output",
    failUploadsForVariantIds: ["variant-9x16"],
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({
    status: "partial",
    requested: 2,
    succeeded: 1,
    failed: 1,
  });
  expect(harness.failureCodes.get("variant-9x16")).toBe("render_upload_failed");
  expect(harness.failureDispositions.get("variant-9x16")).toBe("retryable");
  expect(harness.states.get("variant-1x1")).toBe("completed");
  expect(harness.persistedVariantIds).toEqual(["variant-1x1"]);
});

for (const resumedDeliveryFailure of [
  {
    label: "upload",
    failureCode: "render_upload_failed",
    input: { failUploadsForVariantIds: ["variant-resumed"] },
  },
  {
    label: "guarded persistence",
    failureCode: "render_persistence_failed",
    input: { rejectPersistenceForVariantIds: ["variant-resumed"] },
  },
] as const) {
  test(`ClipRenderAttempt preserves completed work when resumed ${resumedDeliveryFailure.label} fails`, async () => {
    const harness = createCoreRenderPathTracer({
      topology: "shared-multi-output",
      variants: [
        {
          id: "variant-completed",
          aspectRatio: "ratio_9_16",
          initialState: "completed",
        },
        {
          id: "variant-resumed",
          aspectRatio: "ratio_1_1",
        },
      ],
      ...resumedDeliveryFailure.input,
    });

    await expect(
      harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
    ).resolves.toEqual({
      status: "partial",
      requested: 2,
      succeeded: 1,
      failed: 1,
      superseded: 0,
      followUpWorkflowRunId: null,
    });
    expect(harness.commands.map((command) => command.outputVariantIds)).toEqual(
      [["variant-resumed"]],
    );
    expect(harness.states.get("variant-completed")).toBe("completed");
    expect(harness.states.get("variant-resumed")).toBe("retryable-failure");
    expect(harness.failureCodes.get("variant-resumed")).toBe(
      resumedDeliveryFailure.failureCode,
    );
  });
}

test("ClipRenderAttempt resumes only pending work and counts the whole Render Work Set", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "shared-multi-output",
    variants: [
      {
        id: "variant-completed",
        aspectRatio: "ratio_9_16",
        initialState: "completed",
      },
      {
        id: "variant-permanent",
        aspectRatio: "ratio_1_1",
        initialState: "permanent-failure",
      },
      {
        id: "variant-resumed",
        clipId: "clip-resumed",
        clipIndex: 1,
        aspectRatio: "ratio_9_16",
      },
    ],
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual({
    status: "partial",
    requested: 3,
    succeeded: 2,
    failed: 1,
    superseded: 0,
    followUpWorkflowRunId: null,
  });
  expect(harness.commands.map((command) => command.outputVariantIds)).toEqual([
    ["variant-resumed"],
  ]);
  expect(harness.states.get("variant-completed")).toBe("completed");
  expect(harness.states.get("variant-permanent")).toBe("permanent-failure");
  expect(harness.states.get("variant-resumed")).toBe("completed");
  expect(harness.mutationVariantIds).toEqual([
    "variant-resumed",
    "variant-resumed",
  ]);
});

for (const retryCase of [
  {
    label: "requeues a causal retryable failure",
    attemptCount: 1,
    expectedStatus: "requeued",
    expectedState: "pending",
  },
  {
    label: "fails after retry exhaustion",
    attemptCount: 3,
    expectedStatus: "failed",
    expectedState: "retryable-failure",
  },
] as const) {
  test(`ClipRenderAttempt ${retryCase.label} when no variant succeeds`, async () => {
    const harness = createCoreRenderPathTracer({
      topology: "single-video",
      attemptCount: retryCase.attemptCount,
      failCommandsForVariantIds: ["variant-9x16"],
    });

    await expect(
      harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
    ).resolves.toMatchObject({
      status: retryCase.expectedStatus,
      requested: 1,
      succeeded: 0,
      failed: retryCase.expectedStatus === "requeued" ? 0 : 1,
    });
    expect(harness.states.get("variant-9x16")).toBe(retryCase.expectedState);
  });
}

test("ClipRenderAttempt fails a zero-success permanent command without requeueing", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    commandFailureDisposition: "permanent",
    failCommandsForVariantIds: ["variant-9x16"],
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual({
    status: "failed",
    requested: 1,
    succeeded: 0,
    failed: 1,
    superseded: 0,
    followUpWorkflowRunId: null,
  });
  expect(harness.states.get("variant-9x16")).toBe("permanent-failure");
  expect(harness.failureDispositions.get("variant-9x16")).toBe("permanent");
});

test("ClipRenderAttempt completes a Render Work Set whose variants are all superseded", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "shared-multi-output",
    supersedeCompletionsForVariantIds: ["variant-9x16", "variant-1x1"],
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual({
    status: "completed",
    requested: 2,
    succeeded: 0,
    failed: 0,
    superseded: 2,
    followUpWorkflowRunId: null,
  });
  expect([...harness.states.values()]).toEqual(["superseded", "superseded"]);
  expect(harness.persistedVariantIds).toEqual([]);
});

const ffmpegAvailable =
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const ffprobeAvailable =
  spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

interface RenderedMediaProbe {
  variantId: string;
  width: number;
  height: number;
  durationSec: number;
  videoCodec: string | null;
  audioCodec: string | null;
}


function probeRenderedMedia(
  variantId: string,
  filePath: string,
): RenderedMediaProbe {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      filePath,
    ],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new Error(`ffprobe failed for ${variantId}: ${result.stderr}`);
  }
  const data = JSON.parse(result.stdout) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
    }>;
    format?: { duration?: string };
  };
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  return {
    variantId,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    durationSec: Number(data.format?.duration ?? 0),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
  };
}

async function hashRenderedMedia(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function hashRenderedFrame(filePath: string, timeSec: number): string {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      timeSec.toFixed(3),
      "-i",
      filePath,
      "-frames:v",
      "1",
      "-f",
      "framemd5",
      "-",
    ],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new Error(`frame probe failed at ${timeSec}s: ${result.stderr}`);
  }
  const frame = result.stdout
    .split("\n")
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (!frame) throw new Error(`missing frame at ${timeSec}s`);
  return frame.split(",").at(-1)?.trim() ?? "";
}

function meanVolumeDb(filePath: string, startSec: number): number {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "info",
      "-ss",
      startSec.toFixed(3),
      "-t",
      "0.120",
      "-i",
      filePath,
      "-vn",
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new Error(`volume probe failed: ${result.stderr}`);
  }
  const match = result.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
  if (!match) throw new Error(`mean volume missing: ${result.stderr}`);
  return Number(match[1]);
}

describe("ClipRenderAttempt real-media plan fixtures", () => {
  let fixtureDirectory = "";
  let videoSourcePath = "";
  let audioSourcePath = "";
  let longAudioSourcePath = "";
  let musicSourcePath = "";
  let sfxSourcePath = "";
  let logoSourcePath = "";
  let rangedVideoSourceUrl = "";
  let sourceServer: ReturnType<typeof createServer> | null = null;

  beforeAll(async () => {
    if (!ffmpegAvailable || !ffprobeAvailable) return;
    fixtureDirectory = await mkdtemp(
      join(tmpdir(), "narriflow-core-render-fixtures-"),
    );
    videoSourcePath = join(fixtureDirectory, "video-source.mp4");
    audioSourcePath = join(fixtureDirectory, "audio-source.m4a");
    longAudioSourcePath = join(fixtureDirectory, "long-audio-source.m4a");
    musicSourcePath = join(fixtureDirectory, "music-source.m4a");
    sfxSourcePath = join(fixtureDirectory, "sfx-source.m4a");
    logoSourcePath = join(fixtureDirectory, "brand-logo.png");
    const videoFixture = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=24:duration=0.8",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=0.8",
        "-shortest",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        videoSourcePath,
      ],
      { encoding: "utf-8" },
    );
    if (videoFixture.status !== 0) {
      throw new Error(
        `video fixture generation failed: ${videoFixture.stderr}`,
      );
    }
    const audioFixture = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=0.8",
        "-c:a",
        "aac",
        audioSourcePath,
      ],
      { encoding: "utf-8" },
    );
    if (audioFixture.status !== 0) {
      throw new Error(
        `audio fixture generation failed: ${audioFixture.stderr}`,
      );
    }
    for (const fixture of [
      { path: longAudioSourcePath, frequency: 440, duration: 10 },
      { path: musicSourcePath, frequency: 880, duration: 0.4 },
      { path: sfxSourcePath, frequency: 1760, duration: 0.2 },
    ]) {
      const generated = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=${fixture.frequency}:sample_rate=48000:duration=${fixture.duration}`,
          "-c:a",
          "aac",
          fixture.path,
        ],
        { encoding: "utf-8" },
      );
      if (generated.status !== 0) {
        throw new Error(`audio fixture generation failed: ${generated.stderr}`);
      }
    }
    const logoFixture = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x5B6CFF:s=120x60:d=0.1",
        "-frames:v",
        "1",
        "-update",
        "1",
        logoSourcePath,
      ],
      { encoding: "utf-8" },
    );
    if (logoFixture.status !== 0) {
      throw new Error(
        `logo fixture generation failed: ${logoFixture.stderr}`,
      );
    }
    const sourceBytes = await readFile(videoSourcePath);
    sourceServer = createServer((request, response) => {
      if (request.url !== "/video-source.mp4") {
        response.writeHead(404).end();
        return;
      }
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      if (!range) {
        response.writeHead(200, {
          "accept-ranges": "bytes",
          "content-length": sourceBytes.length,
          "content-type": "video/mp4",
        });
        response.end(sourceBytes);
        return;
      }
      const start = Number(range[1]);
      const end = range[2]
        ? Math.min(Number(range[2]), sourceBytes.length - 1)
        : sourceBytes.length - 1;
      response.writeHead(206, {
        "accept-ranges": "bytes",
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${sourceBytes.length}`,
        "content-type": "video/mp4",
      });
      response.end(sourceBytes.subarray(start, end + 1));
    });
    await new Promise<void>((resolve, reject) => {
      sourceServer?.once("error", reject);
      sourceServer?.listen(0, "127.0.0.1", resolve);
    });
    const address = sourceServer.address();
    if (!address || typeof address === "string") {
      throw new Error("real-media source server did not bind a TCP port");
    }
    rangedVideoSourceUrl = `http://127.0.0.1:${address.port}/video-source.mp4`;
  });

  test.skipIf(!ffmpegAvailable || !ffprobeAvailable)(
    "renders the planner-owned caption, text, logo, transition, and output treatment stack",
    async () => {
      let output: RenderedMediaProbe | undefined;
      let boundaryFrameHashes: string[] = [];
      const harness = createCoreRenderPathTracer({
        topology: "studio-per-output",
        ownerTier: "free",
        clipWindow: { startSec: 0, endSec: 10 },
        variants: [
          {
            id: "variant-visual-stack",
            aspectRatio: "ratio_9_16",
            resolution: "720p",
          },
        ],
        transcriptSlice: [
          {
            index: 0,
            speaker: 0,
            speakerLabel: "Speaker 1",
            startSec: 0.1,
            endSec: 0.6,
            text: "Plan first",
            confidence: 0.99,
            words: [
              { word: "Plan", startSec: 0.1, endSec: 0.3, confidence: 0.99 },
              { word: "first", startSec: 0.3, endSec: 0.6, confidence: 0.99 },
            ],
          },
        ],
        clipOverrides: {
          captionPreset: { visible: true },
          studioEdits: {
            framing: { mode: "center" },
            textLayers: [
              { id: "hook", text: "Plan first", startSec: 0.15, endSec: 0.65 },
            ],
            transition: { type: "dip-white", durationSec: 0.2 },
          },
        },
        projectBrandSnapshot: {
          templateId: null,
          captionPreset: {},
          logoStorageKey: "projects/brand/logo.png",
          logoPosition: "top-right",
          logoOpacity: 80,
          logoScalePct: 15,
          primaryColor: "#FFFFFF",
          secondaryColor: "#00FF88",
          accentColor: null,
        },
        realMedia: {
          sourcePath: videoSourcePath,
          logoPath: logoSourcePath,
          probeOutput: async (variantId, filePath) => {
            output = probeRenderedMedia(variantId, filePath);
            boundaryFrameHashes = [0, 0.1, 0.15, 0.2, 0.3, 0.6, 0.65, 0.75].map(
              (timeSec) => hashRenderedFrame(filePath, timeSec),
            );
          },
        },
      });

      await expect(
        harness.clipRenderAttempt.execute(
          harness.attempt,
          attemptContext(new AbortController().signal),
        ),
      ).resolves.toMatchObject({
        status: "completed",
        succeeded: 1,
        failed: 0,
      });

      expect(output).toMatchObject({
        variantId: "variant-visual-stack",
        width: 720,
        height: 1280,
        videoCodec: "h264",
        audioCodec: "aac",
      });
      expect(output?.durationSec).toBeGreaterThan(0.7);
      expect(boundaryFrameHashes).toHaveLength(8);
      expect(boundaryFrameHashes.every(Boolean)).toBe(true);
      expect(new Set(boundaryFrameHashes).size).toBeGreaterThanOrEqual(6);
      const graph = harness.commands[0]?.args.join(" ") ?? "";
      expect(graph).toContain("drawtext=font='Arial':text='Plan first'");
      expect(graph).toContain("ass='");
      expect(graph).toContain("colorchannelmixer=aa=0.800");
      expect(graph).toContain("fade=t=in:st=0.000:d=0.200:color=white");
      expect(graph).toContain("drawtext=text=Made with Narriflow");
    },
  );

  test.skipIf(!ffmpegAvailable || !ffprobeAvailable)(
    "renders the existing audio-only audiogram while omitting unsupported backgrounds",
    async () => {
      let output: RenderedMediaProbe | undefined;
      let frameHashes: string[] = [];
      const harness = createCoreRenderPathTracer({
        topology: "audiogram",
        clipWindow: { startSec: 0, endSec: 10 },
        variants: [
          {
            id: "variant-audiogram-plan",
            aspectRatio: "ratio_9_16",
            resolution: "720p",
          },
        ],
        ownerTier: "free",
        clipOverrides: {
          studioEdits: {
            background: { mode: "color", color: "#123456" },
            transition: { type: "dip-white", durationSec: 0.2 },
            textLayers: [
              {
                id: "audio-hook",
                text: "Listen closely",
                startSec: 0.1,
                endSec: 0.7,
              },
            ],
          },
        },
        projectBrandSnapshot: {
          templateId: null,
          captionPreset: {},
          logoStorageKey: "projects/brand/logo.png",
          logoPosition: "top-right",
          logoOpacity: 80,
          logoScalePct: 15,
          primaryColor: "#FFFFFF",
          secondaryColor: "#00FF88",
          accentColor: null,
        },
        realMedia: {
          sourcePath: audioSourcePath,
          logoPath: logoSourcePath,
          probeOutput: async (variantId, filePath) => {
            output = probeRenderedMedia(variantId, filePath);
            frameHashes = [0.05, 0.2, 0.6].map((timeSec) =>
              hashRenderedFrame(filePath, timeSec),
            );
          },
        },
      });

      await expect(
        harness.clipRenderAttempt.execute(
          harness.attempt,
          attemptContext(new AbortController().signal),
        ),
      ).resolves.toMatchObject({
        status: "completed",
        succeeded: 1,
        failed: 0,
      });

      expect(output).toMatchObject({
        variantId: "variant-audiogram-plan",
        width: 720,
        height: 1280,
        videoCodec: "h264",
        audioCodec: "aac",
      });
      expect(output?.durationSec).toBeGreaterThan(0.7);
      expect(frameHashes.every(Boolean)).toBe(true);
      expect(new Set(frameHashes).size).toBeGreaterThanOrEqual(2);
      const graph = harness.commands[0]?.args.join(" ") ?? "";
      expect(graph).toContain("showwaves=");
      expect(graph).toContain("color=c=0x0F172A");
      expect(graph).not.toContain("color=c=0x123456");
      expect(graph).toContain("text='Listen closely'");
      expect(graph).toContain("colorchannelmixer=aa=0.800");
      expect(graph).toContain("fade=t=in:st=0.000:d=0.200:color=white");
      expect(graph).toContain("drawtext=text=Made with Narriflow");
      expect(harness.diagnostics).toContainEqual({
        message: "clip_composition_plan",
        context: expect.objectContaining({
          planFidelity: "degraded",
          effectiveModes: ["audiogram"],
          noticeCodes: ["audio_only_background_unsupported"],
          optionalDegradationCount: 1,
        }),
      });
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable || !ffprobeAvailable)(
    "renders the plan-owned loop, fades, ducking, and SFX stop through ClipRenderAttempt",
    async () => {
      const musicAssetId = "60000000-0000-4000-8000-000000000706";
      const sfxAssetId = "70000000-0000-4000-8000-000000000707";
      const musicUrl = "https://media.example/music.m4a";
      const sfxUrl = "https://media.example/sfx.m4a";
      let windows: Record<string, number> = {};
      const harness = createCoreRenderPathTracer({
        topology: "audiogram",
        clipWindow: { startSec: 0, endSec: 10 },
        variants: [
          {
            id: "variant-audio-schedule",
            aspectRatio: "ratio_1_1",
            resolution: "720p",
          },
        ],
        transcriptSlice: [
          {
            index: 0,
            speaker: 0,
            speakerLabel: "Speaker 1",
            startSec: 1.12,
            endSec: 1.88,
            text: "planned speech",
            confidence: 1,
            words: [
              {
                word: "planned",
                startSec: 1.12,
                endSec: 1.88,
                confidence: 1,
              },
            ],
          },
        ],
        clipOverrides: {
          studioEdits: {
            sourceAudio: { volume: 100, muted: true },
            music: {
              assetId: musicAssetId,
              url: null,
              volume: 80,
              startOffsetSec: 0,
              fadeInSec: 1,
              fadeOutSec: 1,
              ducking: true,
            },
            sfx: [
              {
                id: "impact",
                assetId: sfxAssetId,
                startSec: 1.5,
                volume: 100,
              },
            ],
          },
        },
        audioAssets: {
          [musicAssetId]: { url: musicUrl, durationSec: 0.4 },
          [sfxAssetId]: { url: sfxUrl, durationSec: 0.2 },
        },
        optionalMediaFiles: {
          [musicUrl]: musicSourcePath,
          [sfxUrl]: sfxSourcePath,
        },
        realMedia: {
          sourcePath: longAudioSourcePath,
          probeOutput: async (_variantId, filePath) => {
            windows = {
              fadeIn: meanVolumeDb(filePath, 0.08),
              fullMusic: meanVolumeDb(filePath, 0.75),
              duckedMusic: meanVolumeDb(filePath, 1.2),
              sfx: meanVolumeDb(filePath, 1.54),
              afterSfx: meanVolumeDb(filePath, 1.82),
              fadeOut: meanVolumeDb(filePath, 9.5),
            };
          },
        },
      });

      await expect(
        harness.clipRenderAttempt.execute(
          harness.attempt,
          attemptContext(new AbortController().signal),
        ),
      ).resolves.toMatchObject({
        status: "completed",
        succeeded: 1,
        failed: 0,
      });
      expect(windows.fullMusic).toBeGreaterThan(windows.fadeIn + 8);
      expect(windows.fullMusic).toBeGreaterThan(windows.duckedMusic + 5);
      expect(windows.sfx).toBeGreaterThan(windows.duckedMusic + 3);
      expect(windows.sfx).toBeGreaterThan(windows.afterSfx + 3);
      expect(windows.fullMusic).toBeGreaterThan(windows.fadeOut + 8);
    },
    30_000,
  );

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!sourceServer) return resolve();
      sourceServer.close((error) => (error ? reject(error) : resolve()));
    });
    if (fixtureDirectory) {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });


  test.skipIf(!ffmpegAvailable || !ffprobeAvailable)(
    "frozen export state overrides live clip timing and free-plan watermark",
    async () => {
      const renderOne = async (input: {
        id: string;
        ownerTier: "free" | "pro";
        liveWindow: { startSec: number; endSec: number };
        exportVariant?: CoreVariantFixture["exportVariant"];
        clipSnapshot?: Record<string, unknown> | null;
      }) => {
        let result: { hash: string; probe: RenderedMediaProbe } | undefined;
        const harness = createCoreRenderPathTracer({
          topology: "single-video",
          ownerTier: input.ownerTier,
          clipWindow: input.liveWindow,
          variants: [
            {
              id: input.id,
              aspectRatio: "ratio_9_16",
              resolution: "720p",
              exportVariant: input.exportVariant,
              clipSnapshot: input.clipSnapshot,
            },
          ],
          realMedia: {
            sourcePath: videoSourcePath,
            probeOutput: async (variantId, filePath) => {
              result = {
                hash: await hashRenderedMedia(filePath),
                probe: probeRenderedMedia(variantId, filePath),
              };
            },
          },
        });
        await expect(
          harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
        ).resolves.toMatchObject({ status: "completed", succeeded: 1 });
        if (!result) throw new Error(`missing output probe for ${input.id}`);
        return result;
      };

      const frozenClip = clipFixture({
        hasStudioEdit: false,
        overrides: { startSec: 0, endSec: 10 },
      });
      const exportResult = await renderOne({
        id: "variant-export",
        ownerTier: "free",
        liveWindow: { startSec: 0.1, endSec: 10.1 },
        exportVariant: { exportId: "export-frozen", watermark: false },
        clipSnapshot: frozenClip,
      });
      const ordinaryProResult = await renderOne({
        id: "variant-ordinary-pro",
        ownerTier: "pro",
        liveWindow: { startSec: 0, endSec: 10 },
      });
      const ordinaryFreeResult = await renderOne({
        id: "variant-ordinary-free",
        ownerTier: "free",
        liveWindow: { startSec: 0, endSec: 10 },
      });

      expect({ ...exportResult.probe, variantId: "same" }).toEqual({
        ...ordinaryProResult.probe,
        variantId: "same",
      });
      expect(exportResult.hash).toBe(ordinaryProResult.hash);
      expect(exportResult.hash).not.toBe(ordinaryFreeResult.hash);
      expect(exportResult.probe).toMatchObject({ width: 720, height: 1280 });
      expect(exportResult.probe.durationSec).toBeGreaterThanOrEqual(0.35);
      expect(exportResult.probe.durationSec).toBeLessThanOrEqual(0.9);
    },
    30_000,
  );

  for (const optionalCase of [
    {
      label: "brand logo",
      assetClass: "logo",
      phase: "lookup",
      failureCode: "brand_snapshot_unavailable",
      input: {
        projectBrandSnapshotFailure: new Error("brand lookup unavailable"),
      },
    },
    {
      label: "B-roll",
      assetClass: "broll",
      phase: "lookup",
      failureCode: "broll_provider_unavailable",
      input: {
        clipWindow: { startSec: 0, endSec: 15 },
        clipOverrides: { title: "Build a camera", hookText: "Workshop" },
        configOverrides: {
          WORKER_BROLL: "1",
          PEXELS_API_KEY: "configured",
        },
        brollProviderFailure: new Error("B-roll provider unavailable"),
      },
    },
    {
      label: "music",
      assetClass: "music",
      phase: "lookup",
      failureCode: "music_asset_unavailable",
      input: {
        clipOverrides: {
          studioEdits: {
            music: { assetId: "40000000-0000-4000-8000-000000000704" },
          },
        },
        audioAssetFailure: new Error("music lookup unavailable"),
      },
    },
    {
      label: "sound effect",
      assetClass: "sound_effect",
      phase: "lookup",
      failureCode: "sound_effect_asset_unavailable",
      input: {
        clipOverrides: {
          studioEdits: {
            sfx: [
              {
                id: "impact",
                assetId: "50000000-0000-4000-8000-000000000705",
                startSec: 0.1,
              },
            ],
          },
        },
        audioAssetFailure: new Error("sound-effect lookup unavailable"),
      },
    },
    {
      label: "background image",
      assetClass: "background",
      phase: "probe",
      failureCode: "background_image_invalid",
      input: {
        clipOverrides: {
          studioEdits: {
            background: {
              mode: "image",
              color: "#123456",
              imageUrl: "https://media.example/background.jpg",
            },
          },
        },
        backgroundDecodable: false,
      },
    },
  ] as const) {
    test.skipIf(!ffmpegAvailable || !ffprobeAvailable)(
      `${optionalCase.label} degradation still produces probeable real media`,
      async () => {
        let result: RenderedMediaProbe | undefined;
        const harness = createCoreRenderPathTracer({
          topology: "single-video",
          clipWindow: { startSec: 0, endSec: 10 },
          variants: [
            {
              id: "variant-optional-fallback",
              aspectRatio: "ratio_9_16",
              resolution: "720p",
            },
          ],
          ...optionalCase.input,
          realMedia: {
            sourcePath: videoSourcePath,
            probeOutput: async (variantId, filePath) => {
              result = probeRenderedMedia(variantId, filePath);
            },
          },
        });

        await expect(
          harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
        ).resolves.toMatchObject({ status: "completed", succeeded: 1 });
        expect(result).toMatchObject({ width: 720, height: 1280 });
        expect(harness.diagnostics).toContainEqual({
          message: "clip_render_optional_asset_fallback",
          context: expect.objectContaining({
            assetClass: optionalCase.assetClass,
            phase: optionalCase.phase,
            failureCode: optionalCase.failureCode,
            disposition: "degraded",
          }),
        });
      },
      30_000,
    );
  }

  for (const analysisCase of [
    {
      label: "picture-in-picture screen layout",
      diagnostic: "clip_screen_pip_selected",
      configOverrides: {
        WORKER_SCREEN_LAYOUT: "1",
      },
      clipOverrides: { studioEdits: { framing: { mode: "screen" } } },
      faceAnalysisSamples: Array.from({ length: 8 }, (_, index) => ({
        t: index * 0.04,
        cx: 0.88,
      })),
      multiFaceAnalysisSamples: undefined,
      pipAnalysisResult: {
        movingPxFrac: 0.04,
        insufficientSamples: false,
        candidates: [qualifyingPipCandidate],
      },
      resolution: "720p" as const,
    },
    {
      label: "split layout",
      diagnostic: "clip_split_applied",
      configOverrides: {
        WORKER_SPLIT: "1",
      },
      clipOverrides: { studioEdits: { framing: { mode: "split" } } },
      faceAnalysisSamples: undefined,
      multiFaceAnalysisSamples: Array.from({ length: 40 }, (_, index) => ({
        t: index * 0.25,
        faces: [
          { cx: 0.3, cy: 0.3, w: 0.1, h: 0.2, score: 0.9 },
          { cx: 0.7, cy: 0.3, w: 0.1, h: 0.2, score: 0.9 },
        ],
      })),
      pipAnalysisResult: undefined,
      resolution: "720p" as const,
    },
    {
      label: "truncated shot-layout evidence",
      diagnostic: "clip_layout_plan_fallback",
      configOverrides: {
        WORKER_LAYOUT_ENGINE: "1",
      },
      clipOverrides: {},
      faceAnalysisSamples: undefined,
      multiFaceAnalysisSamples: Array.from({ length: 8 }, (_, index) => ({
        t: index * 0.04,
        faces: [
          { cx: 0.3, cy: 0.3, w: 0.1, h: 0.2, score: 0.9 },
          { cx: 0.7, cy: 0.3, w: 0.1, h: 0.2, score: 0.9 },
        ],
      })),
      pipAnalysisResult: undefined,
      resolution: "720p" as const,
    },
  ]) {
    test.skipIf(!ffmpegAvailable || !ffprobeAvailable)(
      `${analysisCase.label} produces probeable real media`,
      async () => {
        let result: RenderedMediaProbe | undefined;
        const harness = createCoreRenderPathTracer({
          topology: "single-video",
          clipWindow: { startSec: 0, endSec: 10 },
          variants: [
            {
              id: `variant-${analysisCase.label}`,
              aspectRatio: "ratio_9_16",
              resolution: analysisCase.resolution,
            },
          ],
          configOverrides: analysisCase.configOverrides,
          clipOverrides: analysisCase.clipOverrides,
          faceAnalysisSamples: analysisCase.faceAnalysisSamples,
          multiFaceAnalysisSamples: analysisCase.multiFaceAnalysisSamples,
          pipAnalysisResult: analysisCase.pipAnalysisResult,
          realMedia: {
            sourcePath: videoSourcePath,
            probeOutput: async (variantId, filePath) => {
              result = probeRenderedMedia(variantId, filePath);
            },
          },
        });

        await expect(
          harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
        ).resolves.toMatchObject({ status: "completed", succeeded: 1 });
        expect(result).toMatchObject({
          width: analysisCase.resolution === "1080p" ? 1080 : 720,
          height: analysisCase.resolution === "1080p" ? 1920 : 1280,
        });
        expect(harness.diagnostics).toContainEqual({
          message: analysisCase.diagnostic,
          context: expect.objectContaining({ phase: "media_analysis" }),
        });
      },
      30_000,
    );
  }

  for (const plannedMode of ["split", "screen"] as const) {
    test.skipIf(!ffmpegAvailable || !ffprobeAvailable)(
      `${plannedMode} composition renders every target through ClipRenderAttempt`,
      async () => {
        const probes = new Map<string, RenderedMediaProbe>();
        const variants: CoreVariantFixture[] = [
          {
            id: `${plannedMode}-9x16`,
            aspectRatio: "ratio_9_16",
            resolution: "720p",
          },
          {
            id: `${plannedMode}-1x1`,
            aspectRatio: "ratio_1_1",
            resolution: "720p",
          },
          {
            id: `${plannedMode}-16x9`,
            aspectRatio: "ratio_16_9",
            resolution: "720p",
          },
          {
            id: `${plannedMode}-4x5`,
            aspectRatio: "ratio_4_5",
            resolution: "720p",
          },
        ];
        const face = (cx: number) => ({
          cx,
          cy: 0.3,
          w: 0.1,
          h: 0.2,
          score: 0.9,
        });
        const harness = createCoreRenderPathTracer({
          topology: "studio-per-output",
          clipWindow: { startSec: 0, endSec: 10 },
          variants,
          clipOverrides: { studioEdits: { framing: { mode: plannedMode } } },
          configOverrides:
            plannedMode === "split"
              ? { WORKER_SPLIT: "1" }
              : {
                  WORKER_SCREEN_LAYOUT: "1",
                },
          faceAnalysisSamples:
            plannedMode === "screen"
              ? Array.from({ length: 8 }, (_, index) => ({
                  t: index * 0.04,
                  cx: 0.88,
                }))
              : undefined,
          multiFaceAnalysisSamples:
            plannedMode === "split"
              ? Array.from({ length: 8 }, (_, index) => ({
                  t: index * 0.04,
                  faces: [face(0.3), face(0.7)],
                }))
              : undefined,
          pipAnalysisResult:
            plannedMode === "screen"
              ? {
                  movingPxFrac: 0.04,
                  insufficientSamples: false,
                  candidates: [qualifyingPipCandidate],
                }
              : undefined,
          realMedia: {
            sourcePath: videoSourcePath,
            probeOutput: async (variantId, filePath) => {
              probes.set(variantId, probeRenderedMedia(variantId, filePath));
            },
          },
        });

        await expect(
          harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
        ).resolves.toMatchObject({
          status: "completed",
          succeeded: variants.length,
        });
        expect(
          Object.fromEntries(
            [...probes].map(([id, probe]) => [id, [probe.width, probe.height]]),
          ),
        ).toEqual({
          [`${plannedMode}-9x16`]: [720, 1280],
          [`${plannedMode}-1x1`]: [720, 720],
          [`${plannedMode}-16x9`]: [1280, 720],
          [`${plannedMode}-4x5`]: [720, 900],
        });
        expect(harness.diagnostics).toContainEqual({
          message: "clip_composition_plan",
          context: expect.objectContaining({
            requestedMode: plannedMode,
          }),
        });
      },
      60_000,
    );
  }

  for (const sourceCase of [
    { label: "ranged", failRangedProbe: false },
    { label: "download fallback", failRangedProbe: true },
  ]) {
    test.skipIf(!ffmpegAvailable || !ffprobeAvailable)(
      `${sourceCase.label} source access produces probeable real media`,
      async () => {
        let result: RenderedMediaProbe | undefined;
        const harness = createCoreRenderPathTracer({
          topology: "single-video",
          clipWindow: { startSec: 0, endSec: 10 },
          variants: [
            {
              id: `variant-source-${sourceCase.label}`,
              aspectRatio: "ratio_9_16",
              resolution: "720p",
            },
          ],
          sourceAccess: {
            presignedUrl: rangedVideoSourceUrl,
            failRangedProbe: sourceCase.failRangedProbe,
          },
          realMedia: {
            sourcePath: videoSourcePath,
            probeOutput: async (variantId, filePath) => {
              result = probeRenderedMedia(variantId, filePath);
            },
          },
        });

        await expect(
          harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
        ).resolves.toMatchObject({ status: "completed", succeeded: 1 });
        expect(result).toMatchObject({ width: 720, height: 1280 });
        expect(harness.diagnostics).toContainEqual({
          message: "clip_render_source_operation_completed",
          context: expect.objectContaining({
            phase: "source_resolution",
            operation: sourceCase.failRangedProbe
              ? "source_download"
              : "ranged_probe",
          }),
        });
      },
      30_000,
    );
  }
});
