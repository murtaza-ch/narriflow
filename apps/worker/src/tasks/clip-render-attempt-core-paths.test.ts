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
  WorkflowAttemptLost,
  WorkflowFailure,
} from "@narriflow/services";
import { studioEditsSchema } from "@narriflow/validators";
import type { TranscriptUtterance } from "@narriflow/validators";
import { parseRenderConfig } from "../render-config";
import { ProductionRenderMediaAdapter } from "../render-media-adapter";
import { productionRenderProcessAdapter } from "../render-process-adapter";
import { buildClipCutPlan } from "./cut-plan";
import {
  buildAudiogramArgs,
  buildMultiVideoArgs,
  buildSingleVideoArgs,
  ClipRenderAttempt,
  generateSrtFromSlice,
  type ClipRenderingWorkflowAttempt,
} from "./render-clips";

type PendingClipRender = Awaited<
  ReturnType<typeof clipService.getPendingClipRendersForWorkSet>
>[number];

type CoreRenderTopology =
  | "single-video"
  | "shared-multi-output"
  | "studio-per-output"
  | "audiogram";

type VariantState =
  | "pending"
  | "rendering"
  | "completed"
  | "retryable-failure"
  | "permanent-failure"
  | "superseded";

interface CoreVariantFixture {
  id: string;
  aspectRatio: "ratio_9_16" | "ratio_1_1";
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
    endSec: 7,
    llmModel: "test",
    transcriptSlice: [],
    deletedRanges: null,
    captionPreset: null,
    studioEdits: input.hasStudioEdit
      ? { sourceAudio: { volume: 100, muted: true } }
      : null,
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
  optionalDownloadFailure?: Error;
  optionalMediaInvalidFor?: "video" | "audio" | "image";
  backgroundDecodable?: boolean;
  faceAnalysisSamples?: Array<{ t: number; cx: number | null }> | null;
  faceAnalysisFailure?: Error;
  analysisPersistenceFailure?: Error;
  analysisProcessOutcome?:
    | "missing"
    | "timeout"
    | "nonzero"
    | "invalid"
    | "no-face"
    | "cancel";
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
    probeOutput(variantId: string, filePath: string): Promise<void>;
  };
  sourceAccess?: {
    presignedUrl: string;
    failRangedProbe?: boolean;
  };
  workspaceCleanupFailure?: Error;
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
  const failureDispositions = new Map<
    string,
    "retryable" | "permanent"
  >();
  const commands: CommandProbe[] = [];
  const uploadedVariantIds: string[] = [];
  const persistedVariantIds: string[] = [];
  const mutationVariantIds: string[] = [];
  const diagnostics: Array<{
    message: string;
    context?: Record<string, unknown>;
  }> = [];
  const brollCacheWrites: string[] = [];
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
      WORKER_AUTO_REFRAME: "0",
      WORKER_LAYOUT_ENGINE: "0",
      WORKER_SCREEN_LAYOUT: "0",
      WORKER_SPLIT: "0",
      WORKER_PIP_DETECT: "0",
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
      media: input.realMedia
        ? input.sourceAccess?.failRangedProbe
          ? {
              probe: async (request) => {
                if (request.sourcePath === input.sourceAccess?.presignedUrl) {
                  throw new WorkflowFailure(
                    "worker_command_failed",
                    "retryable",
                    "Injected ranged probe failure",
                  );
                }
                return new ProductionRenderMediaAdapter().probe(request);
              },
            }
          : new ProductionRenderMediaAdapter()
        : {
            probe: async () => ({
              width: input.topology === "audiogram" ? 0 : 1920,
              height: input.topology === "audiogram" ? 0 : 1080,
              hasVideo: input.topology !== "audiogram",
              hasAudio: true,
              fps: 30,
            }),
          },
      process: {
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
                return "not-json";
              case "no-face":
                return JSON.stringify({ samples: [] });
              case "cancel": {
                const reason = new DOMException(
                  "Injected analysis cancellation",
                  "AbortError",
                );
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
          if (
            ids.some((id) => input.failCommandsForVariantIds?.includes(id))
          ) {
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
            ? productionRenderProcessAdapter.execute(request)
            : "";
        },
      },
      project: {
        getUserPricingTier: async () => input.ownerTier ?? "pro",
        getProjectBrandSnapshot: async () => {
          if (input.projectBrandSnapshotFailure) {
            throw input.projectBrandSnapshotFailure;
          }
          return input.projectBrandSnapshot ?? null;
        },
        publishWorkflowProgress: async () => {},
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
          : { downloadUrlToFile: async () => {} }),
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
      ...(input.audioAssetFailure || input.audioAssetUrl
        ? {
            audioAsset: {
              resolveRenderSource: async () => {
                if (input.audioAssetFailure) throw input.audioAssetFailure;
                return input.audioAssetUrl
                  ? { url: input.audioAssetUrl, title: "Optional audio" }
                  : null;
              },
            },
          }
        : {}),
      ...(input.faceAnalysisSamples !== undefined ||
      input.faceAnalysisFailure ||
      input.multiFaceAnalysisSamples !== undefined ||
      input.pipAnalysisResult !== undefined
        ? {
            analysis: {
              extractFaceDetectionSegment: async (params) => ({
                path: params.sourcePath,
                startSec: params.clipStartSec,
              }),
              ...(input.faceAnalysisSamples !== undefined ||
              input.faceAnalysisFailure
                ? {
                    detectFacePath: async () => {
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
                    detectMultiFacePath: async () =>
                      input.multiFaceAnalysisSamples
                        ? { samples: input.multiFaceAnalysisSamples }
                        : null,
                    detectSceneCuts: async () => [],
                  }
                : {}),
              ...(input.pipAnalysisResult !== undefined
                ? {
                    detectPipPath: async () => input.pipAnalysisResult ?? null,
                  }
                : {}),
            },
          }
        : {}),
      clip: {
        completeClipAutoLayoutAnalysis: async () => {
          if (input.analysisPersistenceFailure) {
            throw input.analysisPersistenceFailure;
          }
          return false;
        },
        completeClipRenderVariant: async (variantId) => {
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
        failClipRenderVariant: async (variantId, code, disposition) => {
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
        getPendingClipRendersForWorkSet: async () =>
          pendingRenders.filter((render) => states.get(render.id) === "pending"),
        markClipRenderVariantRendering: async (variantId) => {
          mutationVariantIds.push(variantId);
          if (states.get(variantId) !== "pending") return false;
          states.set(variantId, "rendering");
          return true;
        },
        setClipLayoutAnalysis: async () => {
          if (input.analysisPersistenceFailure) {
            throw input.analysisPersistenceFailure;
          }
        },
      },
      storage: {
        presignDownloadUrl: async () => input.sourceAccess?.presignedUrl ?? "",
        downloadObjectToFile: async ({ key, filePath }) => {
          if (input.logoDownloadFailure && key.endsWith("/logo.png")) {
            throw input.logoDownloadFailure;
          }
          if (input.realMedia) {
            await copyFile(input.realMedia.sourcePath, filePath);
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
        mkdtemp: input.realMedia
          ? (prefix) => mkdtemp(prefix)
          : async () => "/tmp/narriflow-core-render-paths",
        rm: input.workspaceCleanupFailure
          ? async () => {
              throw input.workspaceCleanupFailure;
            }
          : input.realMedia
            ? rm
            : async () => {},
        stat: input.realMedia ? stat : async () => ({ size: 256 }) as never,
        writeFile: input.realMedia ? writeFile : async () => {},
      },
      diagnose: ({ message, context }) => diagnostics.push({ message, context }),
    },
  });

  return {
    attempt,
    brollCacheWrites,
    clipRenderAttempt,
    commands,
    diagnostics,
    failureCodes,
    failureDispositions,
    mutationVariantIds,
    persistedVariantIds,
    settlementCalls: () => settlementCalls,
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
    commandCount: 1,
    outputGroups: [["variant-9x16", "variant-1x1"]],
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

function buildLegacyCommands(input: {
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

  if (input.topology === "audiogram") {
    const cutPlan = buildClipCutPlan([], {
      startSec: input.startSec,
      endSec: input.endSec,
    });
    const studioEdits = studioEditsSchema.parse({});
    return outputs.map((output) =>
      buildAudiogramArgs({
        sourcePath: input.sourcePath,
        outputPath: output.outputPath,
        startSec: input.startSec,
        endSec: input.endSec,
        aspectRatio: output.aspectRatio,
        clipDurationSec,
        srtPath: input.srtPath ?? null,
        studioEdits,
        resolution: output.resolution,
        watermark: input.watermark,
        cutPlan,
      }),
    );
  }

  if (input.topology === "studio-per-output") {
    const cutPlan = buildClipCutPlan([], {
      startSec: input.startSec,
      endSec: input.endSec,
    });
    const studioEdits = studioEditsSchema.parse({
      sourceAudio: { volume: 100, muted: true },
    });
    return outputs.map((output) =>
      buildSingleVideoArgs({
        sourcePath: input.sourcePath,
        outputPath: output.outputPath,
        startSec: input.startSec,
        endSec: input.endSec,
        aspectRatio: output.aspectRatio,
        probe: input.probe,
        srtPath: input.srtPath ?? null,
        studioEdits,
        resolution: output.resolution,
        watermark: input.watermark,
        cutPlan,
      }),
    );
  }

  if (input.topology === "shared-multi-output") {
    return [
      buildMultiVideoArgs({
        sourcePath: input.sourcePath,
        outputs,
        startSec: input.startSec,
        endSec: input.endSec,
        probe: input.probe,
        srtPath: input.srtPath ?? null,
        watermark: input.watermark,
      }),
    ];
  }

  return [
    buildSingleVideoArgs({
      sourcePath: input.sourcePath,
      outputPath: outputs[0]!.outputPath,
      startSec: input.startSec,
      endSec: input.endSec,
      aspectRatio: outputs[0]!.aspectRatio,
      probe: input.probe,
      srtPath: input.srtPath ?? null,
      resolution: outputs[0]!.resolution,
      watermark: input.watermark,
    }),
  ];
}

function legacyCommandArgs(topology: CoreRenderTopology): readonly string[][] {
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
  return buildLegacyCommands({
    topology,
    sourcePath: "<source>",
    outputs:
      topology === "single-video" ? [outputs[0]!] : outputs,
    startSec: 2,
    endSec: 7,
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
  test(`ClipRenderAttempt preserves the ${fixture.topology} command topology through execute`, async () => {
    const harness = createCoreRenderPathTracer({ topology: fixture.topology });

    await expect(
      harness.clipRenderAttempt.execute({
        attempt: harness.attempt,
        signal: new AbortController().signal,
      }),
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
    expect(
      harness.commands.map((command) =>
        normalizeCommandArgs(command.args, command.outputVariantIds),
      ),
    ).toEqual(legacyCommandArgs(fixture.topology));
    expect(harness.uploadedVariantIds).toEqual(
      fixture.outputGroups.flat(),
    );
    expect(harness.persistedVariantIds).toEqual(
      fixture.outputGroups.flat(),
    );
    expect(harness.settlementCalls()).toBe(1);
  });
}

test("ClipRenderAttempt omits an unavailable brand logo and diagnoses the fallback", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    projectBrandSnapshotFailure: new Error(
      "https://signed.example/logo.png?secret=do-not-log",
    ),
  });

  await expect(
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
  expect(JSON.stringify(harness.diagnostics)).not.toContain("secret=do-not-log");
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
    interruptedHarness.clipRenderAttempt.execute({
      attempt: interruptedHarness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
  expect(JSON.stringify(harness.diagnostics)).not.toContain("secret=do-not-log");
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
      harness.clipRenderAttempt.execute({
        attempt: harness.attempt,
        signal: new AbortController().signal,
      }),
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
      harness.clipRenderAttempt.execute({
        attempt: harness.attempt,
        signal: new AbortController().signal,
      }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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

test("ClipRenderAttempt applies deterministic auto-reframe analysis to the final render request", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    configOverrides: { WORKER_AUTO_REFRAME: "1" },
    faceAnalysisSamples: [
      { t: 0, cx: 0.2 },
      { t: 1, cx: 0.5 },
      { t: 2, cx: 0.8 },
    ],
  });

  await expect(
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.commands).toHaveLength(1);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_reframe_applied",
    context: expect.objectContaining({
      phase: "media_analysis",
      analysisMode: "auto_reframe",
      selectedMode: "face_tracked",
      durationMs: expect.any(Number),
    }),
  });
});

test("ClipRenderAttempt keeps center framing when auto-reframe analysis is unavailable", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    configOverrides: { WORKER_AUTO_REFRAME: "1" },
    faceAnalysisSamples: null,
  });

  await expect(
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.commands).toHaveLength(1);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_reframe_skipped",
    context: expect.objectContaining({
      phase: "media_analysis",
      analysisMode: "auto_reframe",
      fallbackMode: "center_crop",
      failureCode: "analysis_unavailable",
      disposition: "degraded",
      durationMs: expect.any(Number),
    }),
  });
});

for (const analysisFailure of [
  "missing",
  "timeout",
  "nonzero",
  "invalid",
  "no-face",
] as const) {
  test(`ClipRenderAttempt degrades ${analysisFailure} face analysis to center framing`, async () => {
    const harness = createCoreRenderPathTracer({
      topology: "single-video",
      configOverrides: { WORKER_AUTO_REFRAME: "1" },
      analysisProcessOutcome: analysisFailure,
    });

    await expect(
      harness.clipRenderAttempt.execute({
        attempt: harness.attempt,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
    expect(harness.commands).toHaveLength(1);
    expect(harness.diagnostics).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          phase: "media_analysis",
          fallbackMode: "center_crop",
          failureCode:
            analysisFailure === "no-face"
              ? "no_usable_face_samples"
              : analysisFailure === "missing"
                ? "analysis_executable_missing"
                : analysisFailure === "timeout"
                  ? "analysis_timeout"
                  : analysisFailure === "nonzero"
                    ? "analysis_command_failed"
                    : "analysis_unavailable",
          disposition: "degraded",
        }),
      }),
    );
  });
}

test("ClipRenderAttempt propagates cancellation during active media analysis", async () => {
  const controller = new AbortController();
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    configOverrides: { WORKER_AUTO_REFRAME: "1" },
    analysisProcessOutcome: "cancel",
    analysisAbortController: controller,
  });

  const execution = harness.clipRenderAttempt.execute({
    attempt: harness.attempt,
    signal: controller.signal,
  });
  await expect(execution).rejects.toMatchObject({ name: "AbortError" });
  expect(controller.signal.aborted).toBe(true);
  expect(harness.commands).toHaveLength(0);
  expect(harness.persistedVariantIds).toHaveLength(0);
  expect(harness.settlementCalls()).toBe(0);
});

test("ClipRenderAttempt rejects stale media analysis without persisting output", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    configOverrides: { WORKER_AUTO_REFRAME: "1" },
    faceAnalysisFailure: new WorkflowAttemptLost({
      workflowRunId: "10000000-0000-4000-8000-000000000701",
      projectId: "20000000-0000-4000-8000-000000000702",
      stage: "clip_rendering",
      attemptId: "30000000-0000-4000-8000-000000000703",
      attemptCount: 1,
    }),
  });

  await expect(
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
  ).rejects.toBeInstanceOf(WorkflowAttemptLost);
  expect(harness.persistedVariantIds).toEqual([]);
  expect(harness.settlementCalls()).toBe(0);
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
    configOverrides: { WORKER_LAYOUT_ENGINE: "1", WORKER_AUTO_REFRAME: "1" },
    multiFaceAnalysisSamples: [
      {
        t: 0,
        faces: [{ cx: 0.5, cy: 0.4, w: 0.2, h: 0.3, score: 0.9 }],
      },
    ],
    analysisPersistenceFailure: ownershipLoss,
  });

  await expect(
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
  ).rejects.toBe(ownershipLoss);
  expect(harness.commands).toHaveLength(0);
  expect(harness.persistedVariantIds).toHaveLength(0);
  expect(harness.settlementCalls()).toBe(0);
});

test("ClipRenderAttempt keeps the screen layout when picture-in-picture analysis is unavailable", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: { studioEdits: { framing: { mode: "screen" } } },
    configOverrides: {
      WORKER_SCREEN_LAYOUT: "1",
      WORKER_PIP_DETECT: "1",
    },
    faceAnalysisSamples: null,
    pipAnalysisResult: null,
  });

  await expect(
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    message: "clip_screen_layout_applied",
    context: expect.objectContaining({ selectedMode: "center_crop" }),
  });
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
      WORKER_PIP_DETECT: "1",
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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

test("ClipRenderAttempt preserves speaker-band framing for a valid no-screen result", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "single-video",
    clipOverrides: { studioEdits: { framing: { mode: "screen" } } },
    configOverrides: {
      WORKER_SCREEN_LAYOUT: "1",
      WORKER_PIP_DETECT: "1",
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    message: "clip_screen_layout_applied",
    context: expect.objectContaining({ selectedMode: "face_tracked" }),
  });
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
    multiFaceAnalysisSamples: Array.from({ length: 12 }, (_, index) => ({
      t: index * 0.25,
      faces: [face(0.3), face(0.7)],
    })),
  });

  await expect(
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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

test("ClipRenderAttempt applies deterministic shot-layout analysis", async () => {
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
      WORKER_AUTO_REFRAME: "1",
      WORKER_LAYOUT_ENGINE: "1",
    },
    multiFaceAnalysisSamples: Array.from({ length: 12 }, (_, index) => ({
      t: index * 0.25,
      faces: [face(0.3), face(0.7)],
    })),
  });

  await expect(
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
  ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_layout_plan_applied",
    context: expect.objectContaining({
      phase: "media_analysis",
      analysisMode: "layout_engine",
      selectedMode: "shot_layout",
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
  test(`ClipRenderAttempt preserves the literal-0 ${disabledAnalysisCase.mode} fallback`, async () => {
    const harness = createCoreRenderPathTracer({
      topology: "single-video",
      clipOverrides: {
        studioEdits: { framing: { mode: disabledAnalysisCase.mode } },
      },
    });

    await expect(
      harness.clipRenderAttempt.execute({
        attempt: harness.attempt,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
    expect(harness.diagnostics).toContainEqual({
      message: disabledAnalysisCase.message,
      context: expect.objectContaining({
        phase: "media_analysis",
        analysisMode: disabledAnalysisCase.analysisMode,
        fallbackMode: "auto_reframe",
        failureCode: "analysis_disabled",
        disposition: "degraded",
      }),
    });
  });
}

test("ClipRenderAttempt contains a shared command failure to its planned variants", async () => {
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({
    status: "partial",
    requested: 3,
    succeeded: 1,
    failed: 2,
    superseded: 0,
    followUpWorkflowRunId: null,
  });
  expect(harness.commands.map((command) => command.outputVariantIds)).toEqual([
    ["group-a-9x16", "group-a-1x1"],
    ["group-b-9x16"],
  ]);
  expect(harness.states.get("group-a-9x16")).toBe("retryable-failure");
  expect(harness.states.get("group-a-1x1")).toBe("retryable-failure");
  expect(harness.states.get("group-b-9x16")).toBe("completed");
  expect(harness.uploadedVariantIds).toEqual(["group-b-9x16"]);
});

test("ClipRenderAttempt settles a per-output failure as terminal partial", async () => {
  const harness = createCoreRenderPathTracer({
    topology: "studio-per-output",
    failCommandsForVariantIds: ["variant-9x16"],
  });

  await expect(
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
  ).resolves.toMatchObject({
    status: "partial",
    requested: 2,
    succeeded: 1,
    failed: 1,
  });
  expect(harness.failureCodes.get("variant-9x16")).toBe(
    "render_upload_failed",
  );
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
      harness.clipRenderAttempt.execute({
        attempt: harness.attempt,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      status: "partial",
      requested: 2,
      succeeded: 1,
      failed: 1,
      superseded: 0,
      followUpWorkflowRunId: null,
    });
    expect(harness.commands.map((command) => command.outputVariantIds)).toEqual([
      ["variant-resumed"],
    ]);
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
      harness.clipRenderAttempt.execute({
        attempt: harness.attempt,
        signal: new AbortController().signal,
      }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({
    status: "completed",
    requested: 2,
    succeeded: 0,
    failed: 0,
    superseded: 2,
    followUpWorkflowRunId: null,
  });
  expect([...harness.states.values()]).toEqual([
    "superseded",
    "superseded",
  ]);
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

const captionCompatibilityUtterances: TranscriptUtterance[] = [
  {
    index: 0,
    speaker: 0,
    speakerLabel: "Speaker 1",
    startSec: 0.05,
    endSec: 0.32,
    text: "Core path",
    confidence: 0.99,
    words: [
      { word: "Core", startSec: 0.05, endSec: 0.16, confidence: 0.99 },
      { word: "path", startSec: 0.18, endSec: 0.32, confidence: 0.99 },
    ],
  },
];

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
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

describe("ClipRenderAttempt real-media compatibility fixtures", () => {
  let fixtureDirectory = "";
  let videoSourcePath = "";
  let audioSourcePath = "";
  let rangedVideoSourceUrl = "";
  let sourceServer: ReturnType<typeof createServer> | null = null;

  beforeAll(async () => {
    if (!ffmpegAvailable || !ffprobeAvailable) return;
    fixtureDirectory = await mkdtemp(
      join(tmpdir(), "narriflow-core-render-fixtures-"),
    );
    videoSourcePath = join(fixtureDirectory, "video-source.mp4");
    audioSourcePath = join(fixtureDirectory, "audio-source.m4a");
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
      throw new Error(`video fixture generation failed: ${videoFixture.stderr}`);
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
      throw new Error(`audio fixture generation failed: ${audioFixture.stderr}`);
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

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!sourceServer) return resolve();
      sourceServer.close((error) => (error ? reject(error) : resolve()));
    });
    if (fixtureDirectory) {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  for (const fixture of topologyFixtures) {
    test.skipIf(!ffmpegAvailable || !ffprobeAvailable)(
      `${fixture.topology} is byte- and probe-compatible with the offline legacy builder`,
      async () => {
        const renderedResults = new Map<
          string,
          { hash: string; probe: RenderedMediaProbe }
        >();
        const variants: CoreVariantFixture[] =
          fixture.topology === "single-video"
            ? [
                {
                  id: "variant-9x16",
                  aspectRatio: "ratio_9_16",
                  resolution: "720p",
                },
              ]
            : [
                {
                  id: "variant-9x16",
                  aspectRatio: "ratio_9_16",
                  resolution: "720p",
                },
                {
                  id: "variant-1x1",
                  aspectRatio: "ratio_1_1",
                  resolution: "720p",
                },
              ];
        const sourcePath =
          fixture.topology === "audiogram"
            ? audioSourcePath
            : videoSourcePath;
        const legacyDirectory = await mkdtemp(
          join(fixtureDirectory, `${fixture.topology}-legacy-`),
        );
        const legacySrtPath = join(legacyDirectory, "captions.srt");
        await writeFile(
          legacySrtPath,
          generateSrtFromSlice(captionCompatibilityUtterances, 0),
          "utf-8",
        );
        const legacyOutputs = variants.map((variant) => ({
          variantId: variant.id,
          aspectRatio:
            variant.aspectRatio === "ratio_1_1"
              ? ("1:1" as const)
              : ("9:16" as const),
          outputPath: join(legacyDirectory, `${variant.id}.mp4`),
          resolution: "720p" as const,
        }));
        const legacyCommands = buildLegacyCommands({
          topology: fixture.topology,
          sourcePath,
          outputs: legacyOutputs,
          startSec: 0,
          endSec: 0.4,
          probe: {
            width: 640,
            height: 360,
            hasVideo: fixture.topology !== "audiogram",
            hasAudio: true,
            fps: 24,
          },
          watermark: false,
          srtPath: legacySrtPath,
        });
        for (const args of legacyCommands) {
          const legacyRender = spawnSync("ffmpeg", args, {
            encoding: "utf-8",
          });
          if (legacyRender.status !== 0) {
            throw new Error(
              `legacy ${fixture.topology} render failed: ${legacyRender.stderr}`,
            );
          }
        }
        const legacyResults = new Map(
          await Promise.all(
            legacyOutputs.map(async (output) => [
              output.variantId,
              {
                hash: await hashRenderedMedia(output.outputPath),
                probe: probeRenderedMedia(output.variantId, output.outputPath),
              },
            ] as const),
          ),
        );
        const harness = createCoreRenderPathTracer({
          topology: fixture.topology,
          clipWindow: { startSec: 0, endSec: 0.4 },
          variants,
          transcriptSlice: captionCompatibilityUtterances,
          realMedia: {
            sourcePath,
            probeOutput: async (variantId, filePath) => {
              renderedResults.set(variantId, {
                hash: await hashRenderedMedia(filePath),
                probe: probeRenderedMedia(variantId, filePath),
              });
            },
          },
        });

        const outcome = await harness.clipRenderAttempt.execute({
          attempt: harness.attempt,
          signal: new AbortController().signal,
        });
        if (outcome.status !== "completed") {
          throw new Error(JSON.stringify(harness.diagnostics, null, 2));
        }
        expect(outcome).toMatchObject({
          status: "completed",
          succeeded: variants.length,
        });
        expect(
          harness.commands.map((command) =>
            normalizeCommandArgs(command.args, command.outputVariantIds),
          ),
        ).toEqual(
          legacyCommands.map((args, index) =>
            normalizeCommandArgs(args, fixture.outputGroups[index] ?? []),
          ),
        );
        expect(renderedResults).toEqual(legacyResults);
      },
      30_000,
    );
  }

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
        let result:
          | { hash: string; probe: RenderedMediaProbe }
          | undefined;
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
          harness.clipRenderAttempt.execute({
            attempt: harness.attempt,
            signal: new AbortController().signal,
          }),
        ).resolves.toMatchObject({ status: "completed", succeeded: 1 });
        if (!result) throw new Error(`missing output probe for ${input.id}`);
        return result;
      };

      const frozenClip = clipFixture({
        hasStudioEdit: false,
        overrides: { startSec: 0.2, endSec: 0.6 },
      });
      const exportResult = await renderOne({
        id: "variant-export",
        ownerTier: "free",
        liveWindow: { startSec: 0, endSec: 0.2 },
        exportVariant: { exportId: "export-frozen", watermark: false },
        clipSnapshot: frozenClip,
      });
      const ordinaryProResult = await renderOne({
        id: "variant-ordinary-pro",
        ownerTier: "pro",
        liveWindow: { startSec: 0.2, endSec: 0.6 },
      });
      const ordinaryFreeResult = await renderOne({
        id: "variant-ordinary-free",
        ownerTier: "free",
        liveWindow: { startSec: 0.2, endSec: 0.6 },
      });

      expect({ ...exportResult.probe, variantId: "same" }).toEqual({
        ...ordinaryProResult.probe,
        variantId: "same",
      });
      expect(exportResult.hash).toBe(ordinaryProResult.hash);
      expect(exportResult.hash).not.toBe(ordinaryFreeResult.hash);
      expect(exportResult.probe).toMatchObject({ width: 720, height: 1280 });
      expect(exportResult.probe.durationSec).toBeGreaterThanOrEqual(0.35);
      expect(exportResult.probe.durationSec).toBeLessThanOrEqual(0.5);
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable || !ffprobeAvailable)(
    "optional-asset degradation still produces probeable real media",
    async () => {
      let result: RenderedMediaProbe | undefined;
      const harness = createCoreRenderPathTracer({
        topology: "single-video",
        clipWindow: { startSec: 0, endSec: 0.4 },
        variants: [
          {
            id: "variant-optional-fallback",
            aspectRatio: "ratio_9_16",
            resolution: "720p",
          },
        ],
        projectBrandSnapshotFailure: new Error("brand lookup unavailable"),
        realMedia: {
          sourcePath: videoSourcePath,
          probeOutput: async (variantId, filePath) => {
            result = probeRenderedMedia(variantId, filePath);
          },
        },
      });

      await expect(
        harness.clipRenderAttempt.execute({
          attempt: harness.attempt,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ status: "completed", succeeded: 1 });
      expect(result).toMatchObject({ width: 720, height: 1280 });
      expect(harness.diagnostics).toContainEqual({
        message: "clip_render_optional_asset_fallback",
        context: expect.objectContaining({
          assetClass: "logo",
          disposition: "degraded",
        }),
      });
    },
    30_000,
  );

  for (const analysisCase of [
    {
      label: "auto-reframe",
      diagnostic: "clip_reframe_applied",
      configOverrides: { WORKER_AUTO_REFRAME: "1" },
      clipOverrides: {},
      faceAnalysisSamples: [
        { t: 0, cx: 0.25 },
        { t: 0.2, cx: 0.75 },
      ],
      multiFaceAnalysisSamples: undefined,
      pipAnalysisResult: undefined,
      resolution: "1080p" as const,
    },
    {
      label: "picture-in-picture screen layout",
      diagnostic: "clip_screen_pip_selected",
      configOverrides: { WORKER_SCREEN_LAYOUT: "1", WORKER_PIP_DETECT: "1" },
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
      configOverrides: { WORKER_SPLIT: "1" },
      clipOverrides: { studioEdits: { framing: { mode: "split" } } },
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
    {
      label: "shot-layout engine",
      diagnostic: "clip_layout_plan_applied",
      configOverrides: {
        WORKER_AUTO_REFRAME: "1",
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
          clipWindow: { startSec: 0, endSec: 0.4 },
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
          harness.clipRenderAttempt.execute({
            attempt: harness.attempt,
            signal: new AbortController().signal,
          }),
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
          clipWindow: { startSec: 0, endSec: 0.4 },
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
          harness.clipRenderAttempt.execute({
            attempt: harness.attempt,
            signal: new AbortController().signal,
          }),
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
