import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clipService,
  type MotionRenderAnalyticsMetadata,
  type RenderWorkSetOutcome,
  type WorkflowAttemptContext,
  WorkflowAttemptLost,
  WorkflowFailure,
} from "@narriflow/services";
import { parseRenderConfig } from "../render-config";
import { productionWorkerProcessModule, type WorkerProcessModule } from "../worker-process";
import { ClipRenderAttempt, type ClipRenderingWorkflowAttempt } from "./render-clips";

type PendingClipRender = Awaited<
  ReturnType<typeof clipService.getPendingClipRendersForWorkSet>
>[number];

function attemptContext(signal: AbortSignal): WorkflowAttemptContext {
  return { signal, reportProgress: async () => {} };
}

function frozenRenderingState(
  pendingRenders: PendingClipRender[],
  overrides: Partial<{
    sourceStorageKey: string | null;
    ownerTier: "free" | "pro";
  }> = {},
) {
  return {
    sourceStorageKey:
      overrides.sourceStorageKey === undefined
        ? "projects/project/source/input.mp4"
        : overrides.sourceStorageKey,
    sourceDurationSeconds: 10,
    userId: "user",
    workspaceId: null,
    ownerTier: overrides.ownerTier ?? "pro",
    brandSnapshot: { status: "available" as const, value: null },
    pendingRenders,
  };
}

type OrdinaryTracerFailure =
  | "begin"
  | "state_load"
  | "presign"
  | "ranged_probe"
  | "download"
  | "local_probe"
  | "command"
  | "command_missing"
  | "command_timeout_before_output"
  | "command_timeout_after_output"
  | "command_nonzero_exit"
  | "upload"
  | "guarded_completion"
  | "guarded_completion_rejected"
  | "object_cleanup"
  | "settlement"
  | "cleanup";

type SourceFailure = Extract<
  OrdinaryTracerFailure,
  "presign" | "ranged_probe" | "download" | "local_probe"
>;

function createOrdinaryTracer(input: {
  attemptId: string;
  diagnoseThrows?: boolean;
  failure?: OrdinaryTracerFailure;
  failureMessage?: string;
  commandDiagnosticContext?: Record<string, unknown>;
  initialVariantState?: "pending" | "completed";
  outcome: RenderWorkSetOutcome;
  failureWriteRejects?: boolean;
  waitForCommandAbort?: boolean;
  sourceFailures?: readonly SourceFailure[];
  sourceInterruption?: {
    operation: SourceFailure;
    reason: "cancellation" | "ownership_loss";
  };
  presignNeverResolves?: boolean;
  presignedUrl?: string;
  productionMedia?: Pick<WorkerProcessModule, "inspectMedia">;
  sourceMode?: "ranged" | "download";
  superseded?: boolean;
  exportBound?: boolean;
  workspaceDirectory?: string;
  downloadFixturePath?: string;
  motionTransition?: boolean;
}) {
  const attempt: ClipRenderingWorkflowAttempt = {
    workflowRunId: "10000000-0000-0000-0000-000000000051",
    projectId: "20000000-0000-0000-0000-000000000052",
    stage: "clip_rendering",
    attemptId: input.attemptId,
    attemptCount: 1,
  };
  const pendingRender = {
    id: "variant-ordinary",
    clipId: "clip-ordinary",
    aspectRatio: "ratio_9_16",
    resolution: "1080p",
    exportVariantId: input.exportBound ? "export-variant-ordinary" : null,
    exportVariant: input.exportBound
      ? {
          id: "export-variant-ordinary",
          exportId: "export-ordinary",
          watermark: false,
        }
      : null,
    clipSnapshot: null,
    clip: {
      id: "clip-ordinary",
      index: 0,
      startSec: 0,
      endSec: 10,
      llmModel: "test",
      transcriptSlice: [],
      deletedRanges: null,
      captionPreset: null,
      studioEdits: input.motionTransition
        ? { transition: { type: "slide-left", durationSec: 0.35 } }
        : null,
		editorDocumentVersion: 2,
		sceneBlocks: [],
		censorSegments: [],
		mediaMotions: [],
      brollCues: null,
      brollUrl: null,
      category: "other",
    },
  } as unknown as PendingClipRender;
  const injectedError = new Error(`injected ${input.failure ?? "none"}`);
  const actions: string[] = [];
  const uploadedKeys: string[] = [];
  const objectReferences: string[] = [];
  const deletedKeys: string[] = [];
  const uploads: Array<{
    key: string;
    contentType: string | undefined;
    metadata: Record<string, string> | undefined;
  }> = [];
  const diagnostics: Array<{
    message: string;
    context?: Record<string, unknown>;
  }> = [];
  const failureMotionAnalytics: MotionRenderAnalyticsMetadata[] = [];
  let variantState:
    | "pending"
    | "rendering"
    | "completed"
    | "failed"
    | "superseded" = input.initialVariantState ?? "pending";
  let beginCalls = 0;
  let settlementCalls = 0;
  let clockNowMs = 1_000;
  let nextTimerId = 1;
  const scheduledTimers = new Map<
    number,
    { callback: () => void; deadlineAtMs: number }
  >();
  const advanceClock = (elapsedMs: number): void => {
    clockNowMs += elapsedMs;
    const due = [...scheduledTimers.entries()]
      .filter(([, timer]) => timer.deadlineAtMs <= clockNowMs)
      .sort((left, right) => left[1].deadlineAtMs - right[1].deadlineAtMs);
    for (const [id, timer] of due) {
      scheduledTimers.delete(id);
      timer.callback();
    }
  };
  const sourceController = new AbortController();
  const shouldFail = (failure: SourceFailure) =>
    input.failure === failure || input.sourceFailures?.includes(failure);
  const interruptSource = (operation: SourceFailure): void => {
    if (input.sourceInterruption?.operation !== operation) return;
    const reason =
      input.sourceInterruption.reason === "ownership_loss"
        ? new WorkflowAttemptLost(attempt)
        : new DOMException("cancelled", "AbortError");
    sourceController.abort(reason);
    throw reason;
  };

  const clipRenderAttempt = new ClipRenderAttempt({
    run: {
      id: attempt.workflowRunId,
      projectId: attempt.projectId,
      project: {
        title: "Ordinary tracer",
        sourceStorageKey: `projects/${attempt.projectId}/source/input.mp3`,
        sourceDurationSeconds: 10,
        userId: "user",
        workspaceId: null,
      },
    },
    config: parseRenderConfig({
      WORKER_CLIP_RENDER_ATTEMPT_ENABLED: "1",
      WORKER_RENDER_SOURCE_MODE: input.sourceMode ?? "download",
      ...(input.presignNeverResolves
        ? { WORKER_STORAGE_TIMEOUT_MS: "5" }
        : {}),
      WORKER_LAYOUT_ENGINE: "0",
      WORKER_SCREEN_LAYOUT: "0",
      WORKER_SPLIT: "0",
      WORKER_BROLL: "0",
    }),
    lifecycle: {
      beginRenderWorkSet: async () => {
        beginCalls += 1;
        actions.push("begin");
        if (input.failure === "begin") throw injectedError;
        return { variantIds: [pendingRender.id] };
      },
      settleRenderWorkSet: async () => {
        settlementCalls += 1;
        actions.push("settle");
        if (input.failure === "settlement") throw injectedError;
        if (input.outcome.status === "requeued" && variantState === "failed") {
          variantState = "pending";
        }
        return input.outcome;
      },
    },
    adapters: {
      state: {
        getFrozenRenderingStateForWorkSet: async () => {
          actions.push("state_load");
          if (input.failure === "state_load") throw injectedError;
          return {
            sourceStorageKey: `projects/${attempt.projectId}/source/input.mp3`,
            sourceDurationSeconds: 10,
            userId: "user",
            workspaceId: null,
            ownerTier: "pro" as const,
            brandSnapshot: { status: "available" as const, value: null },
            pendingRenders:
              variantState === "pending" || variantState === "rendering"
                ? [pendingRender]
                : [],
          };
        },
      },
      workerProcess: {
        inspectMedia:
          input.productionMedia?.inspectMedia.bind(input.productionMedia) ??
          (async ({ sourcePath, signal, deadlineMs }) => {
            const mode = sourcePath.startsWith("https://") ? "ranged" : "local";
            if (
              input.sourceMode === "ranged" ||
              input.sourceInterruption?.operation === `${mode}_probe`
            ) {
              actions.push(`probe:${mode}`);
            }
            expect(signal).toBeInstanceOf(AbortSignal);
            expect(deadlineMs).toBeGreaterThan(0);
            interruptSource(`${mode}_probe`);
          if (shouldFail(`${mode}_probe`)) {
            throw new WorkflowFailure(
              mode === "ranged"
                ? "worker_command_failed"
                : "worker_command_input_invalid",
              mode === "ranged" ? "retryable" : "permanent",
              `injected ${mode} probe failure`,
              );
            }
            return {
              durationSec: 10,
              width: 0,
              height: 0,
              hasVideo: false,
              hasAudio: true,
              hasVisualStream: false,
              fps: 30,
            };
          }),
        execute: async ({ command, deadlineMs, diagnose, signal }) => {
          if (command === "ffprobe") {
            throw new Error("source probes must use inspectMedia");
          }
          expect(signal).toBeInstanceOf(AbortSignal);
          expect(deadlineMs).toBeGreaterThan(0);
          actions.push("command");
          if (input.waitForCommandAbort) {
            actions.push("command_started");
            return new Promise<never>((_resolve, reject) => {
              const abort = () => {
                actions.push("command_terminated");
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new DOMException("cancelled", "AbortError"),
                );
              };
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            });
          }
          if (input.failure === "command_timeout_after_output") {
            actions.push("output_created");
          }
          const commandFailure =
            input.failure === "command"
              ? new WorkflowFailure(
                  "ffmpeg_temporarily_unavailable",
                  "retryable",
                  input.failureMessage ?? "The encoder is temporarily unavailable",
                )
              : input.failure === "command_missing"
                ? new WorkflowFailure(
                    "worker_command_missing",
                    "permanent",
                    "Required render executable is unavailable",
                  )
                : input.failure === "command_nonzero_exit"
                  ? new WorkflowFailure(
                      "worker_command_failed",
                      "retryable",
                      "Render command exited nonzero",
                    )
                  : input.failure === "command_timeout_before_output" ||
                      input.failure === "command_timeout_after_output"
                    ? new WorkflowFailure(
                        "worker_command_timeout",
                        "retryable",
                        "Render command timed out",
                      )
                    : null;
          if (commandFailure) {
            diagnose?.({
              ...input.commandDiagnosticContext,
              operation: commandFailure.code.includes("timeout")
                ? "timeout"
                : commandFailure.code.includes("missing")
                  ? "spawn"
                  : "exit",
              status: "failed",
              elapsedMs: 25,
              failureCode: commandFailure.code,
              disposition: commandFailure.disposition,
            });
            throw commandFailure;
          }
          return { exitCode: 0, stdout: Buffer.alloc(0) };
        },
        withScratchDirectory: async (_prefix, work, diagnose) => {
          const directory = input.workspaceDirectory ?? "/tmp/narriflow-render-ordinary-tracer";
          try {
            return await work(directory);
          } finally {
            actions.push("workspace_cleanup");
            if (input.failure === "cleanup") {
              diagnose?.({
                operation: "scratch_cleanup",
                status: "failed",
                elapsedMs: 0,
                failureCode: "worker_scratch_cleanup_failed",
              });
            }
          }
        },
      },
      project: {
        reportProgress: async () => {},
      },
      clip: {
        completeClipAutoLayoutAnalysis: async () => false,
        completeClipRenderVariant: async (_attempt, _variantId, completion) => {
          actions.push("guarded_completion");
          if (input.failure === "guarded_completion") {
            throw new WorkflowAttemptLost(attempt);
          }
          if (input.failure === "guarded_completion_rejected") {
            throw injectedError;
          }
          if (input.superseded) {
            variantState = "superseded";
            return { persisted: false };
          }
          variantState = "completed";
          objectReferences.push(completion.storageKey);
          return { persisted: true };
        },
        failClipRenderVariant: async (
          _attempt,
          _variantId,
          code,
          disposition,
          motionAnalytics,
        ) => {
          actions.push(`variant_failure:${code}:${disposition}`);
          if (motionAnalytics) failureMotionAnalytics.push(motionAnalytics);
          if (input.failureWriteRejects) throw injectedError;
          variantState = "failed";
        },
        markClipRenderVariantRendering: async () => {
          actions.push("guarded_claim");
          variantState = "rendering";
          return true;
        },
        setClipLayoutAnalysis: async () => {},
      },
      storage: {
        presignDownloadUrl: async () => {
          actions.push("presign");
          interruptSource("presign");
          if (input.presignNeverResolves) {
            return new Promise<string>(() => {});
          }
          if (shouldFail("presign")) throw injectedError;
          return (
            input.presignedUrl ??
            "https://media.example/source.mp3?signature=secret"
          );
        },
        downloadObjectToFile: async ({ filePath }) => {
          if (input.sourceMode === "ranged" || shouldFail("download")) {
            actions.push("download");
          }
          interruptSource("download");
          if (shouldFail("download")) throw injectedError;
          if (input.downloadFixturePath) {
            await copyFile(input.downloadFixturePath, filePath);
          }
        },
        putFileFromPath: async ({ key, contentType, metadata }) => {
          actions.push("upload");
          if (input.failure === "upload") {
            throw new WorkflowFailure(
              "render_upload_failed",
              "retryable",
              "The object store is temporarily unavailable",
            );
          }
          uploads.push({ key, contentType, metadata });
          uploadedKeys.push(key);
          return { key };
        },
        deleteObject: async (key) => {
          actions.push("object_cleanup");
          if (input.failure === "object_cleanup") throw injectedError;
          deletedKeys.push(key);
          return { key };
        },
      },
      workspace: {
        stat: async () => ({ size: 100 }) as never,
      },
      clock: {
        nowMs: () => clockNowMs,
        setTimeout: (callback, delayMs) => {
          const id = nextTimerId++;
          scheduledTimers.set(id, {
            callback,
            deadlineAtMs: clockNowMs + delayMs,
          });
          return id as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: (handle) => {
          scheduledTimers.delete(handle as unknown as number);
        },
      },
      diagnose: ({ message, context }) => {
        if (input.diagnoseThrows) throw new Error("diagnostic sink unavailable");
        diagnostics.push({ message, context });
      },
    },
  });

  return {
    actions,
    advanceClock,
    attempt,
    beginCalls: () => beginCalls,
    clipRenderAttempt,
    deletedKeys,
    diagnostics,
    failureMotionAnalytics,
    injectedError,
    objectReferences,
    settlementCalls: () => settlementCalls,
    sourceSignal: sourceController.signal,
    uploads,
    uploadedKeys,
    variantState: () => variantState,
  };
}

function createUploadQueueTracer(input: {
  attemptId: string;
  configuredConcurrency?: number;
  variantCount: number;
}) {
  const attempt: ClipRenderingWorkflowAttempt = {
    workflowRunId: "10000000-0000-0000-0000-000000000071",
    projectId: "20000000-0000-0000-0000-000000000072",
    stage: "clip_rendering",
    attemptId: input.attemptId,
    attemptCount: 1,
  };
  const pendingRenders = Array.from({ length: input.variantCount }, (_, index) => ({
    id: `variant-${index}`,
    clipId: `clip-${index}`,
    aspectRatio: "ratio_9_16",
    resolution: "1080p",
    exportVariantId: null,
    exportVariant: null,
    clipSnapshot: null,
    clip: {
      id: `clip-${index}`,
      index,
      startSec: 0,
      endSec: 10,
      llmModel: "test",
      transcriptSlice: [],
      deletedRanges: null,
      captionPreset: null,
      studioEdits: null,
		editorDocumentVersion: 2,
		sceneBlocks: [],
		censorSegments: [],
		mediaMotions: [],
      brollCues: null,
      brollUrl: null,
      category: "other",
    },
  })) as unknown as PendingClipRender[];
  const states = new Map(pendingRenders.map((render) => [render.id, "pending"]));
  const actions: string[] = [];
  const objectReferences: string[] = [];
  const uploadStartedKeys: string[] = [];
  const uploadAbortedKeys: string[] = [];
  let activeUploads = 0;
  let maxActiveUploads = 0;
  let settlementCalls = 0;
  let cleanupActiveUploads: number | null = null;
  let releaseUploads = () => {};
  const uploadGate = new Promise<void>((resolve) => {
    releaseUploads = resolve;
  });

  const clipRenderAttempt = new ClipRenderAttempt({
    run: {
      id: attempt.workflowRunId,
      projectId: attempt.projectId,
      project: {
        title: "Upload queue tracer",
        sourceStorageKey: `projects/${attempt.projectId}/source/input.mp3`,
        sourceDurationSeconds: 10,
        userId: "user",
        workspaceId: null,
      },
    },
    config: parseRenderConfig({
      WORKER_CLIP_RENDER_ATTEMPT_ENABLED: "1",
      WORKER_RENDER_SOURCE_MODE: "download",
      ...(input.configuredConcurrency === undefined
        ? {}
        : { WORKER_UPLOAD_CONCURRENCY: String(input.configuredConcurrency) }),
      WORKER_LAYOUT_ENGINE: "0",
      WORKER_SCREEN_LAYOUT: "0",
      WORKER_SPLIT: "0",
      WORKER_BROLL: "0",
    }),
    lifecycle: {
      beginRenderWorkSet: async () => ({
        variantIds: pendingRenders.map((render) => render.id),
      }),
      settleRenderWorkSet: async () => {
        settlementCalls += 1;
        actions.push("settle");
        return {
          status: "completed",
          requested: input.variantCount,
          succeeded: input.variantCount,
          failed: 0,
          superseded: 0,
          followUpWorkflowRunId: null,
        };
      },
    },
    adapters: {
      state: {
        getFrozenRenderingStateForWorkSet: async () =>
          frozenRenderingState(
            pendingRenders.filter((render) => {
              const state = states.get(render.id);
              return state === "pending" || state === "rendering";
            }),
          ),
      },
      workerProcess: {
        inspectMedia: async () => ({
          durationSec: 10,
          width: 0,
          height: 0,
          hasVideo: false,
          hasAudio: true,
          hasVisualStream: false,
          fps: 30,
        }),
        execute: async () => ({ exitCode: 0, stdout: Buffer.alloc(0) }),
        withScratchDirectory: async (_prefix, work) => {
          try {
            return await work("/tmp/narriflow-render-upload-queue-tracer");
          } finally {
            cleanupActiveUploads = activeUploads;
            actions.push("workspace_cleanup");
          }
        },
      },
      project: {
        reportProgress: async () => {},
      },
      clip: {
        completeClipAutoLayoutAnalysis: async () => false,
        completeClipRenderVariant: async (_attempt, variantId, completion) => {
          states.set(variantId, "completed");
          objectReferences.push(completion.storageKey);
          return { persisted: true };
        },
        failClipRenderVariant: async (variantId) => {
          states.set(variantId, "failed");
        },
        markClipRenderVariantRendering: async (_attempt, variantId) => {
          states.set(variantId, "rendering");
          return true;
        },
        setClipLayoutAnalysis: async () => {},
      },
      storage: {
        downloadObjectToFile: async () => {},
        putFileFromPath: async ({ key, signal }) => {
          uploadStartedKeys.push(key);
          activeUploads += 1;
          maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
          actions.push(`upload_started:${key}`);
          try {
            await new Promise<void>((resolve, reject) => {
              let finished = false;
              const finish = (operation: () => void) => {
                if (finished) return;
                finished = true;
                signal?.removeEventListener("abort", onAbort);
                operation();
              };
              const onAbort = () =>
                finish(() => {
                  uploadAbortedKeys.push(key);
                  reject(
                    signal?.reason instanceof Error
                      ? signal.reason
                      : new DOMException("cancelled", "AbortError"),
                  );
                });
              signal?.addEventListener("abort", onAbort, { once: true });
              if (signal?.aborted) onAbort();
              else uploadGate.then(() => finish(resolve));
            });
            return { key };
          } finally {
            activeUploads -= 1;
            actions.push(`upload_stopped:${key}`);
          }
        },
        deleteObject: async (key) => ({ key }),
      },
      workspace: {
        stat: async () => ({ size: 100 }) as never,
      },
      diagnose: () => {},
    },
  });

  return {
    actions,
    attempt,
    cleanupActiveUploads: () => cleanupActiveUploads,
    clipRenderAttempt,
    maxActiveUploads: () => maxActiveUploads,
    objectReferences,
    releaseUploads,
    settlementCalls: () => settlementCalls,
    uploadAbortedKeys,
    uploadStartedKeys,
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 500; index += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for deterministic tracer state");
}

function createInterfaceGuardTracer(input: {
  enabled: boolean;
  runId?: string;
}) {
  const attempt: ClipRenderingWorkflowAttempt = {
    workflowRunId: "10000000-0000-0000-0000-000000000031",
    projectId: "20000000-0000-0000-0000-000000000032",
    stage: "clip_rendering",
    attemptId: "30000000-0000-4000-8000-000000000033",
    attemptCount: 1,
  };
  let beginCalls = 0;
  const clipRenderAttempt = new ClipRenderAttempt({
    run: {
      id: input.runId ?? attempt.workflowRunId,
      projectId: attempt.projectId,
      project: {
        title: "Interface guard",
        sourceStorageKey: null,
        sourceDurationSeconds: null,
        userId: "user",
        workspaceId: null,
      },
    },
    config: parseRenderConfig({
      WORKER_CLIP_RENDER_ATTEMPT_ENABLED: input.enabled ? "1" : "0",
    }),
    lifecycle: {
      beginRenderWorkSet: async () => {
        beginCalls += 1;
        return { variantIds: [] };
      },
      settleRenderWorkSet: async () => ({
        status: "completed",
        requested: 0,
        succeeded: 0,
        failed: 0,
        superseded: 0,
        followUpWorkflowRunId: null,
      }),
    },
  });

  return { attempt, beginCalls: () => beginCalls, clipRenderAttempt };
}

test("ClipRenderAttempt discards an uploaded object when cancellation wins before persistence", async () => {
  const controller = new AbortController();
  const actions: string[] = [];
  const attempt: ClipRenderingWorkflowAttempt = {
    workflowRunId: "10000000-0000-0000-0000-000000000001",
    projectId: "20000000-0000-0000-0000-000000000002",
    stage: "clip_rendering",
    attemptId: "30000000-0000-0000-0000-000000000003",
    attemptCount: 1,
  };
  const pendingRender = {
    id: "variant-1",
    clipId: "clip-1",
    aspectRatio: "ratio_9_16",
    resolution: "1080p",
    exportVariantId: null,
    exportVariant: null,
    clipSnapshot: null,
    clip: {
      id: "clip-1",
      index: 0,
      startSec: 0,
      endSec: 10,
      llmModel: "test",
      transcriptSlice: [],
      deletedRanges: null,
      captionPreset: null,
      studioEdits: null,
		editorDocumentVersion: 2,
		sceneBlocks: [],
		censorSegments: [],
		mediaMotions: [],
      brollCues: null,
      brollUrl: null,
      category: "other",
    },
  } as unknown as PendingClipRender;
  const clipRenderAttempt = new ClipRenderAttempt({
    run: {
      id: attempt.workflowRunId,
      projectId: attempt.projectId,
      project: {
        title: "Post-upload cancellation",
        sourceStorageKey: `projects/${attempt.projectId}/source/input.mp3`,
        sourceDurationSeconds: 10,
        userId: "user",
        workspaceId: null,
      },
    },
    config: parseRenderConfig({
      WORKER_CLIP_RENDER_ATTEMPT_ENABLED: "1",
      WORKER_RENDER_SOURCE_MODE: "download",
      WORKER_LAYOUT_ENGINE: "0",
      WORKER_SCREEN_LAYOUT: "0",
      WORKER_SPLIT: "0",
      WORKER_BROLL: "0",
    }),
    lifecycle: {
      beginRenderWorkSet: async () => ({ variantIds: [pendingRender.id] }),
      settleRenderWorkSet: async () => {
        actions.push("settle");
        throw new Error("settlement must not run after cancellation");
      },
    },
    adapters: {
      state: {
        getFrozenRenderingStateForWorkSet: async () => frozenRenderingState([pendingRender]),
      },
      workerProcess: {
        inspectMedia: async () => ({
          durationSec: 10,
          width: 0,
          height: 0,
          hasVideo: false,
          hasAudio: true,
          hasVisualStream: false,
          fps: 30,
        }),
        execute: async () => {
          actions.push("encode");
          return { exitCode: 0, stdout: Buffer.alloc(0) };
        },
        withScratchDirectory: async (_prefix, work) => {
          try {
            return await work("/tmp/narriflow-render-post-upload-cancel");
          } finally {
            actions.push("cleanup");
          }
        },
      },
      project: {
        reportProgress: async () => {},
      },
      clip: {
        completeClipAutoLayoutAnalysis: async () => false,
        completeClipRenderVariant: async () => {
          actions.push("persist");
          return { persisted: true };
        },
        failClipRenderVariant: async () => {
          actions.push("fail");
        },
        markClipRenderVariantRendering: async () => true,
        setClipLayoutAnalysis: async () => {},
      },
      storage: {
        downloadObjectToFile: async () => {},
        putFileFromPath: async ({ key }) => {
          actions.push("upload");
          controller.abort(new DOMException("cancelled", "AbortError"));
          return { key };
        },
        deleteObject: async (key) => {
          actions.push("discard");
          return { key };
        },
      },
      workspace: {
        stat: async () => ({ size: 100 }) as never,
      },
      diagnose: () => {},
    },
  });

  await expect(
    clipRenderAttempt.execute(attempt, attemptContext(controller.signal )),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(actions).toContain("upload");
  expect(actions).toContain("discard");
  expect(actions).toContain("cleanup");
  expect(actions).not.toContain("persist");
  expect(actions).not.toContain("settle");
  expect(actions).not.toContain("fail");
});

test("ClipRenderAttempt settles an empty frozen work set through execute", async () => {
  const attempt: ClipRenderingWorkflowAttempt = {
    workflowRunId: "10000000-0000-0000-0000-000000000001",
    projectId: "20000000-0000-0000-0000-000000000002",
    stage: "clip_rendering",
    attemptId: "30000000-0000-0000-0000-000000000003",
    attemptCount: 1,
  };
  const expected: RenderWorkSetOutcome = {
    status: "completed",
    requested: 0,
    succeeded: 0,
    failed: 0,
    superseded: 0,
    followUpWorkflowRunId: null,
  };
  const lifecycle = {
    beginRenderWorkSet: async () => ({ variantIds: [] }),
    settleRenderWorkSet: async () => expected,
  };
  const clipRenderAttempt = new ClipRenderAttempt({
    run: {
      id: attempt.workflowRunId,
      projectId: attempt.projectId,
      project: {
        title: "Empty work set",
        sourceStorageKey: null,
        sourceDurationSeconds: null,
        userId: "user",
        workspaceId: null,
      },
    },
    config: parseRenderConfig({ WORKER_CLIP_RENDER_ATTEMPT_ENABLED: "1" }),
    lifecycle,
    adapters: { diagnose: () => {} },
  });

  await expect(
    clipRenderAttempt.execute(attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual(expected);
});

test("ClipRenderAttempt rechecks cancellation after freezing an empty work set", async () => {
  const controller = new AbortController();
  const attempt: ClipRenderingWorkflowAttempt = {
    workflowRunId: "10000000-0000-0000-0000-000000000001",
    projectId: "20000000-0000-0000-0000-000000000002",
    stage: "clip_rendering",
    attemptId: "30000000-0000-0000-0000-000000000003",
    attemptCount: 1,
  };
  let settlementCalls = 0;
  const clipRenderAttempt = new ClipRenderAttempt({
    run: {
      id: attempt.workflowRunId,
      projectId: attempt.projectId,
      project: {
        title: "Cancelled frozen set",
        sourceStorageKey: null,
        sourceDurationSeconds: null,
        userId: "user",
        workspaceId: null,
      },
    },
    config: parseRenderConfig({ WORKER_CLIP_RENDER_ATTEMPT_ENABLED: "1" }),
    lifecycle: {
      beginRenderWorkSet: async () => {
        controller.abort(new DOMException("cancelled", "AbortError"));
        return { variantIds: [] };
      },
      settleRenderWorkSet: async () => {
        settlementCalls += 1;
        throw new Error("settlement must not run after cancellation");
      },
    },
  });

  await expect(
    clipRenderAttempt.execute(attempt, attemptContext(controller.signal )),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(settlementCalls).toBe(0);
});

test("ClipRenderAttempt drives failure and cleanup through construction adapters", async () => {
  const attempt: ClipRenderingWorkflowAttempt = {
    workflowRunId: "10000000-0000-0000-0000-000000000001",
    projectId: "20000000-0000-0000-0000-000000000002",
    stage: "clip_rendering",
    attemptId: "30000000-0000-0000-0000-000000000003",
    attemptCount: 1,
  };
  const expected: RenderWorkSetOutcome = {
    status: "failed",
    requested: 1,
    succeeded: 0,
    failed: 1,
    superseded: 0,
    followUpWorkflowRunId: null,
  };
  const mutations: string[] = [];
  const diagnostics: string[] = [];
  const clipRenderAttempt = new ClipRenderAttempt({
    run: {
      id: attempt.workflowRunId,
      projectId: attempt.projectId,
      project: {
        title: "Missing source",
        sourceStorageKey: null,
        sourceDurationSeconds: null,
        userId: "user",
        workspaceId: null,
      },
    },
    config: parseRenderConfig({ WORKER_CLIP_RENDER_ATTEMPT_ENABLED: "1" }),
    lifecycle: {
      beginRenderWorkSet: async () => ({ variantIds: ["variant-1"] }),
      settleRenderWorkSet: async () => {
        mutations.push("settle:start");
        await Promise.resolve();
        mutations.push("settle:complete");
        return expected;
      },
    },
    adapters: {
      state: {
        getFrozenRenderingStateForWorkSet: async () =>
          frozenRenderingState([{ id: "variant-1" } as PendingClipRender], {
            sourceStorageKey: null,
            ownerTier: "free",
          }),
      },
      project: {
        reportProgress: async () => {},
      },
      clip: {
        completeClipAutoLayoutAnalysis: async () => false,
        completeClipRenderVariant: async () => ({ persisted: true }),
        failClipRenderVariant: async (_attempt, _id, code, disposition) => {
          mutations.push(`fail:${code}:${disposition}`);
        },
        markClipRenderVariantRendering: async (_attempt, id) => {
          mutations.push(`mark:${id}`);
        },
        setClipLayoutAnalysis: async () => {},
      },
      workerProcess: {
        withScratchDirectory: async (_prefix, work) => {
          try {
            return await work("/tmp/narriflow-render-test");
          } finally {
            mutations.push("cleanup");
          }
        },
      },
      clock: { nowMs: () => 1_000 },
      diagnose: ({ message }) => diagnostics.push(message),
    },
  });

  await expect(
    clipRenderAttempt.execute(attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual(expected);
  expect(mutations).toEqual([
    "mark:variant-1",
    "fail:source_storage_key_missing:permanent",
    "settle:start",
    "settle:complete",
    "cleanup",
  ]);
  expect(diagnostics).toContain("clip_rendering_run_failed");
});

test("ClipRenderAttempt cancellation drains to cleanup without persisting outcomes", async () => {
  const controller = new AbortController();
  const attempt: ClipRenderingWorkflowAttempt = {
    workflowRunId: "10000000-0000-0000-0000-000000000001",
    projectId: "20000000-0000-0000-0000-000000000002",
    stage: "clip_rendering",
    attemptId: "30000000-0000-0000-0000-000000000003",
    attemptCount: 1,
  };
  const mutations: string[] = [];
  let settlementCalls = 0;
  const clipRenderAttempt = new ClipRenderAttempt({
    run: {
      id: attempt.workflowRunId,
      projectId: attempt.projectId,
      project: {
        title: "Cancelled render",
        sourceStorageKey: `projects/${attempt.projectId}/source/input.mp4`,
        sourceDurationSeconds: 10,
        userId: "user",
        workspaceId: null,
      },
    },
    config: parseRenderConfig({
      WORKER_CLIP_RENDER_ATTEMPT_ENABLED: "1",
      WORKER_RENDER_SOURCE_MODE: "download",
    }),
    lifecycle: {
      beginRenderWorkSet: async () => ({ variantIds: ["variant-1"] }),
      settleRenderWorkSet: async () => {
        settlementCalls += 1;
        throw new Error("settlement must not run after cancellation");
      },
    },
    adapters: {
      state: {
        getFrozenRenderingStateForWorkSet: async () =>
          frozenRenderingState([{ id: "variant-1" } as PendingClipRender], {
            sourceStorageKey: `projects/${attempt.projectId}/source/input.mp4`,
            ownerTier: "free",
          }),
      },
      project: {
        reportProgress: async () => {},
      },
      clip: {
        completeClipAutoLayoutAnalysis: async () => false,
        completeClipRenderVariant: async () => ({ persisted: true }),
        failClipRenderVariant: async () => {
          mutations.push("fail");
        },
        markClipRenderVariantRendering: async () => {
          mutations.push("mark");
        },
        setClipLayoutAnalysis: async () => {},
      },
      storage: {
        downloadObjectToFile: async () => {
          controller.abort(new DOMException("cancelled", "AbortError"));
          throw controller.signal.reason;
        },
      },
      workerProcess: {
        withScratchDirectory: async (_prefix, work) => {
          try {
            return await work("/tmp/narriflow-render-cancelled");
          } finally {
            mutations.push("cleanup");
          }
        },
      },
      diagnose: () => {},
    },
  });

  await expect(
    clipRenderAttempt.execute(attempt, attemptContext(controller.signal )),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(mutations).toEqual(["cleanup"]);
  expect(settlementCalls).toBe(0);
});

test("ClipRenderAttempt permanently rejects a stored document with an empty timeline", async () => {
  const attempt: ClipRenderingWorkflowAttempt = {
    workflowRunId: "10000000-0000-0000-0000-000000000011",
    projectId: "20000000-0000-0000-0000-000000000012",
    stage: "clip_rendering",
    attemptId: "30000000-0000-0000-0000-000000000013",
    attemptCount: 1,
  };
  const pendingRender = {
    id: "variant-empty-cut",
    clipId: "clip-empty-cut",
    aspectRatio: "ratio_9_16",
    resolution: "1080p",
    exportVariantId: null,
    exportVariant: null,
    clipSnapshot: null,
    clip: {
      id: "clip-empty-cut",
      index: 0,
      startSec: 0,
      endSec: 10,
      llmModel: "test",
      transcriptSlice: [],
      deletedRanges: [{ startSec: 0, endSec: 10 }],
      captionPreset: null,
      studioEdits: null,
		editorDocumentVersion: 2,
		sceneBlocks: [],
		censorSegments: [],
		mediaMotions: [],
      brollCues: null,
      brollUrl: null,
      category: "other",
    },
  } as unknown as PendingClipRender;
  const mutations: string[] = [];
  const expected: RenderWorkSetOutcome = {
    status: "failed",
    requested: 1,
    succeeded: 0,
    failed: 1,
    superseded: 0,
    followUpWorkflowRunId: null,
  };
  const clipRenderAttempt = new ClipRenderAttempt({
    run: {
      id: attempt.workflowRunId,
      projectId: attempt.projectId,
      project: {
        title: "Fully deleted clip",
        sourceStorageKey: `projects/${attempt.projectId}/source/input.mp4`,
        sourceDurationSeconds: 10,
        userId: "user",
        workspaceId: null,
      },
    },
    config: parseRenderConfig({
      WORKER_CLIP_RENDER_ATTEMPT_ENABLED: "1",
      WORKER_RENDER_SOURCE_MODE: "download",
      WORKER_LAYOUT_ENGINE: "0",
      WORKER_SCREEN_LAYOUT: "0",
      WORKER_SPLIT: "0",
      WORKER_BROLL: "0",
    }),
    lifecycle: {
      beginRenderWorkSet: async () => ({ variantIds: [pendingRender.id] }),
      settleRenderWorkSet: async () => {
        mutations.push("settle");
        return expected;
      },
    },
    adapters: {
      state: {
        getFrozenRenderingStateForWorkSet: async () => frozenRenderingState([pendingRender]),
      },
      workerProcess: {
        inspectMedia: async () => ({
          durationSec: 10,
          width: 1920,
          height: 1080,
          hasVideo: true,
          hasAudio: true,
          hasVisualStream: true,
          fps: 30,
        }),
        execute: async () => ({ exitCode: 0, stdout: Buffer.alloc(0) }),
        withScratchDirectory: async (_prefix, work) => {
          try {
            return await work("/tmp/narriflow-render-empty-cut");
          } finally {
            mutations.push("cleanup");
          }
        },
      },
      project: {
        reportProgress: async () => {},
      },
      clip: {
        completeClipAutoLayoutAnalysis: async () => false,
        completeClipRenderVariant: async () => ({ persisted: true }),
        failClipRenderVariant: async (_attempt, _id, code, disposition) => {
          mutations.push(`fail:${code}:${disposition}`);
        },
        markClipRenderVariantRendering: async (_attempt, id) => {
          mutations.push(`mark:${id}`);
          return true;
        },
        setClipLayoutAnalysis: async () => {},
      },
      storage: { downloadObjectToFile: async () => {} },
      workspace: {},
      diagnose: () => {},
    },
  });

  await expect(
    clipRenderAttempt.execute(attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual(expected);
  expect(mutations).toEqual([
    "mark:variant-empty-cut",
    "fail:editor_document_empty_timeline:permanent",
    "settle",
    "cleanup",
  ]);
});

test("ClipRenderAttempt leaves an unpersistable settlement for reaper recovery", async () => {
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000053",
    failure: "settlement",
    outcome: {
      status: "completed",
      requested: 1,
      succeeded: 1,
      failed: 0,
      superseded: 0,
      followUpWorkflowRunId: null,
    },
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).rejects.toBe(harness.injectedError);
  expect(harness.settlementCalls()).toBe(1);
  expect(harness.variantState()).toBe("completed");
  expect(harness.actions).not.toContainEqual(expect.stringMatching(/^variant_failure:/));
  expect(harness.actions.at(-1)).toBe("workspace_cleanup");
});

test("ClipRenderAttempt leaves replay settlement failure for reaper recovery", async () => {
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000054",
    failure: "settlement",
    initialVariantState: "completed",
    outcome: {
      status: "completed",
      requested: 1,
      succeeded: 1,
      failed: 0,
      superseded: 0,
      followUpWorkflowRunId: null,
    },
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).rejects.toBe(harness.injectedError);
  expect(harness.actions).toEqual([
    "begin",
    "state_load",
    "settle",
  ]);
});

test("ClipRenderAttempt refuses execution while the cutover control is disabled", async () => {
  const harness = createInterfaceGuardTracer({ enabled: false });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).rejects.toMatchObject({
    name: "ClipRenderAttemptDisabled",
    code: "clip_render_attempt_disabled",
  });
  expect(harness.beginCalls()).toBe(0);
});

test("ClipRenderAttempt rejects a stale attempt through its asynchronous interface", async () => {
  const harness = createInterfaceGuardTracer({
    enabled: true,
    runId: "a-different-workflow-run",
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).rejects.toBeInstanceOf(WorkflowAttemptLost);
  expect(harness.beginCalls()).toBe(0);
});

test("ClipRenderAttempt renders and settles one ordinary variant through execute", async () => {
  const expected: RenderWorkSetOutcome = {
    status: "completed",
    requested: 1,
    succeeded: 1,
    failed: 0,
    superseded: 0,
    followUpWorkflowRunId: null,
  };
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000053",
    outcome: expected,
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual(expected);
  expect(harness.variantState()).toBe("completed");
  expect(harness.uploadedKeys).toHaveLength(1);
  expect(harness.objectReferences).toEqual(harness.uploadedKeys);
  expect(harness.uploadedKeys[0]).toContain(harness.attempt.attemptId);
  expect(harness.uploads).toEqual([
    {
      key: harness.uploadedKeys[0],
      contentType: "video/mp4",
      metadata: {
        project_id: harness.attempt.projectId,
        clip_id: "clip-ordinary",
        workflow_run_id: harness.attempt.workflowRunId,
        format: "9:16",
      },
    },
  ]);
  expect(harness.actions).toEqual([
    "begin",
    "state_load",
    "guarded_claim",
    "command",
    "upload",
    "guarded_completion",
    "settle",
    "workspace_cleanup",
  ]);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_attempt_settled",
    context: expect.objectContaining({
      workflowRunId: harness.attempt.workflowRunId,
      workflowAttemptId: harness.attempt.attemptId,
      projectId: harness.attempt.projectId,
      stage: "clip_rendering",
      attemptCount: harness.attempt.attemptCount,
      phase: "settlement",
      operation: "settle_render_work_set",
      disposition: "completed",
      requested: 1,
      succeeded: 1,
      failed: 0,
      superseded: 0,
      retryState: "terminal",
    }),
  });
});

test("ClipRenderAttempt persists an attempt-unique export key with unchanged delivery metadata", async () => {
  const expected: RenderWorkSetOutcome = {
    status: "completed",
    requested: 1,
    succeeded: 1,
    failed: 0,
    superseded: 0,
    followUpWorkflowRunId: null,
  };
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000064",
    exportBound: true,
    outcome: expected,
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual(expected);
  expect(harness.uploadedKeys).toHaveLength(1);
  expect(harness.uploadedKeys[0]).toContain(
    `/exports/export-ordinary/export-variant-ordinary-9x16-${harness.attempt.attemptId}.mp4`,
  );
  expect(harness.objectReferences).toEqual(harness.uploadedKeys);
  expect(harness.uploads[0]).toEqual({
    key: harness.uploadedKeys[0],
    contentType: "video/mp4",
    metadata: {
      project_id: harness.attempt.projectId,
      clip_id: "clip-ordinary",
      workflow_run_id: harness.attempt.workflowRunId,
      format: "9:16",
    },
  });
});

for (const concurrencyCase of [
  { label: "defaults upload concurrency", configured: undefined, expected: 2 },
  { label: "caps upload concurrency", configured: 9, expected: 4 },
] as const) {
  test(`ClipRenderAttempt ${concurrencyCase.label} and drains every scheduled upload`, async () => {
    const harness = createUploadQueueTracer({
      attemptId:
        concurrencyCase.expected === 2
          ? "30000000-0000-4000-8000-000000000065"
          : "30000000-0000-4000-8000-000000000066",
      configuredConcurrency: concurrencyCase.configured,
      variantCount: 6,
    });
    const execution = harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal));

    await waitFor(
      () => harness.uploadStartedKeys.length === concurrencyCase.expected,
    );
    expect(harness.maxActiveUploads()).toBe(concurrencyCase.expected);
    expect(harness.settlementCalls()).toBe(0);
    harness.releaseUploads();

    await expect(execution).resolves.toMatchObject({
      status: "completed",
      requested: 6,
      succeeded: 6,
    });
    expect(harness.uploadStartedKeys).toHaveLength(6);
    expect(harness.objectReferences).toEqual(harness.uploadStartedKeys);
    expect(harness.settlementCalls()).toBe(1);
    expect(harness.cleanupActiveUploads()).toBe(0);
  });
}

test("ClipRenderAttempt aborts active uploads and leaves queued uploads unstarted after ownership loss", async () => {
  const harness = createUploadQueueTracer({
    attemptId: "30000000-0000-4000-8000-000000000067",
    variantCount: 5,
  });
  const controller = new AbortController();
  const execution = harness.clipRenderAttempt.execute(harness.attempt, attemptContext(controller.signal));

  await waitFor(() => harness.uploadStartedKeys.length === 2);
  const ownershipLoss = new WorkflowAttemptLost(harness.attempt);
  controller.abort(ownershipLoss);

  await expect(execution).rejects.toBe(ownershipLoss);
  expect(harness.uploadStartedKeys).toHaveLength(2);
  expect(harness.uploadAbortedKeys).toEqual(harness.uploadStartedKeys);
  expect(harness.objectReferences).toEqual([]);
  expect(harness.settlementCalls()).toBe(0);
  expect(harness.cleanupActiveUploads()).toBe(0);
  expect(harness.actions.at(-1)).toBe("workspace_cleanup");
});

test("ClipRenderAttempt resolves a ranged source through its media adapter", async () => {
  const expected: RenderWorkSetOutcome = {
    status: "completed",
    requested: 1,
    succeeded: 1,
    failed: 0,
    superseded: 0,
    followUpWorkflowRunId: null,
  };
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000062",
    outcome: expected,
    sourceMode: "ranged",
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual(expected);
  expect(harness.actions).toContain("presign");
  expect(harness.actions).toContain("probe:ranged");
  expect(harness.actions).not.toContain("probe:local");
});

test("ClipRenderAttempt falls back from a ranged probe to a downloaded local probe", async () => {
  const expected: RenderWorkSetOutcome = {
    status: "completed",
    requested: 1,
    succeeded: 1,
    failed: 0,
    superseded: 0,
    followUpWorkflowRunId: null,
  };
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000063",
    failure: "ranged_probe",
    outcome: expected,
    sourceMode: "ranged",
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual(expected);
  expect(harness.actions).toEqual(
    expect.arrayContaining([
      "presign",
      "probe:ranged",
      "download",
      "probe:local",
      "command",
    ]),
  );
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_source_operation_failed",
    context: expect.objectContaining({
      phase: "source_resolution",
      operation: "ranged_probe",
      failureCode: "worker_command_failed",
      disposition: "retryable",
    }),
  });
});

const FFMPEG_AVAILABLE =
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const FFPROBE_AVAILABLE =
  spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

test.skipIf(!FFMPEG_AVAILABLE || !FFPROBE_AVAILABLE)(
  "ClipRenderAttempt production media contract falls back from ranged access to a downloaded fixture",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "narriflow-source-fallback-contract-"),
    );
    const fixturePath = join(directory, "fixture.mp3");
    const workspaceDirectory = join(directory, "workspace");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("not media", { status: 200 }),
    });
    await mkdir(workspaceDirectory);
    try {
      const generated = spawnSync("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.2",
        "-c:a",
        "libmp3lame",
        fixturePath,
      ]);
      expect(generated.status).toBe(0);

      const harness = createOrdinaryTracer({
        attemptId: "30000000-0000-4000-8000-000000000068",
        downloadFixturePath: fixturePath,
        outcome: {
          status: "completed",
          requested: 1,
          succeeded: 1,
          failed: 0,
          superseded: 0,
          followUpWorkflowRunId: null,
        },
        presignedUrl: `http://127.0.0.1:${server.port}/unavailable.mp3`,
        productionMedia: productionWorkerProcessModule,
        sourceMode: "ranged",
        workspaceDirectory,
      });

      await expect(
        harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
      ).resolves.toMatchObject({ status: "completed" });
      expect(harness.actions).toEqual(
        expect.arrayContaining(["presign", "download", "command"]),
      );
      expect(harness.diagnostics).toContainEqual({
        message: "clip_render_source_operation_failed",
        context: expect.objectContaining({
          operation: "ranged_probe",
          failureCode: "worker_command_failed",
          disposition: "retryable",
        }),
      });
      expect(harness.diagnostics).toContainEqual({
        message: "clip_render_source_operation_completed",
        context: expect.objectContaining({ operation: "local_probe" }),
      });
    } finally {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("ClipRenderAttempt falls back when source presigning fails", async () => {
  const expected: RenderWorkSetOutcome = {
    status: "completed",
    requested: 1,
    succeeded: 1,
    failed: 0,
    superseded: 0,
    followUpWorkflowRunId: null,
  };
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000064",
    failure: "presign",
    outcome: expected,
    sourceMode: "ranged",
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual(expected);
  expect(harness.actions).toContain("download");
  expect(harness.actions).toContain("probe:local");
  expect(harness.actions).not.toContain("probe:ranged");
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_source_operation_failed",
    context: expect.objectContaining({
      operation: "source_presign",
      failureCode: "source_presign_failed",
      disposition: "retryable",
    }),
  });
});

test("ClipRenderAttempt bounds presigning and falls back to a local source", async () => {
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000067",
    outcome: {
      status: "completed",
      requested: 1,
      succeeded: 1,
      failed: 0,
      superseded: 0,
      followUpWorkflowRunId: null,
    },
    presignNeverResolves: true,
    sourceMode: "ranged",
  });

  const executing = harness.clipRenderAttempt.execute(harness.attempt, attemptContext(harness.sourceSignal));
  while (!harness.actions.includes("presign")) await Promise.resolve();
  harness.advanceClock(5);
  await expect(executing).resolves.toMatchObject({ status: "completed" });
  expect(harness.actions).toContain("download");
  expect(harness.actions).toContain("probe:local");
  expect(harness.actions).not.toContain("probe:ranged");
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_source_operation_failed",
    context: expect.objectContaining({
      operation: "source_presign",
      failureCode: "source_presign_timeout",
      disposition: "retryable",
    }),
  });
});

for (const reason of ["cancellation", "ownership_loss"] as const) {
  for (const operation of [
    "presign",
    "ranged_probe",
    "download",
    "local_probe",
  ] as const) {
    test(`ClipRenderAttempt stops source resolution after ${reason} during ${operation}`, async () => {
      const harness = createOrdinaryTracer({
        attemptId: `30000000-0000-4000-8000-00000000009${operation.length}`,
        outcome: {
          status: "failed",
          requested: 1,
          succeeded: 0,
          failed: 1,
          superseded: 0,
          followUpWorkflowRunId: null,
        },
        sourceInterruption: { operation, reason },
        ...(operation === "download"
          ? { sourceFailures: ["ranged_probe"] as const }
          : {}),
        sourceMode: operation === "local_probe" ? "download" : "ranged",
      });

      const executing = harness.clipRenderAttempt.execute(harness.attempt, attemptContext(harness.sourceSignal));
      await expect(executing).rejects.toMatchObject(
        reason === "ownership_loss"
          ? { name: "WorkflowAttemptLost" }
          : { name: "AbortError" },
      );

      const operationIndex = harness.actions.indexOf(
        operation.endsWith("probe") ? `probe:${operation.split("_")[0]}` : operation,
      );
      expect(operationIndex).toBeGreaterThanOrEqual(0);
      const forbidden =
        operation === "presign"
          ? ["probe:ranged", "download", "probe:local", "command"]
          : operation === "ranged_probe"
            ? ["download", "probe:local", "command"]
            : operation === "download"
              ? ["probe:local", "command"]
              : ["command"];
      for (const dependent of forbidden) {
        expect(harness.actions).not.toContain(dependent);
      }
      expect(
        harness.actions.some((action) => action.startsWith("variant_failure:")),
      ).toBe(false);
      expect(harness.settlementCalls()).toBe(0);
      expect(harness.actions).toContain("workspace_cleanup");
    });
  }
}

test("ClipRenderAttempt records a retryable failure when ranged probing and download both fail", async () => {
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000065",
    outcome: {
      status: "requeued",
      requested: 1,
      succeeded: 0,
      failed: 1,
      superseded: 0,
      followUpWorkflowRunId: null,
    },
    sourceFailures: ["ranged_probe", "download"],
    sourceMode: "ranged",
    motionTransition: true,
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "requeued" });
  expect(harness.actions).toContain(
    "variant_failure:source_download_failed:retryable",
  );
  expect(harness.actions).not.toContain("command");
  expect(harness.actions).not.toContain("upload");
  expect(harness.failureMotionAnalytics).toEqual([
    expect.objectContaining({
      motionFamily: ["transition:slide-left"],
      targetCount: 1,
      renderOutcome: "failed",
    }),
  ]);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_source_operation_failed",
    context: expect.objectContaining({
      operation: "source_download",
      failureCode: "source_download_failed",
      disposition: "retryable",
    }),
  });
});

test("ClipRenderAttempt classifies corrupt downloaded source media as permanent", async () => {
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000066",
    failure: "local_probe",
    outcome: {
      status: "failed",
      requested: 1,
      succeeded: 0,
      failed: 1,
      superseded: 0,
      followUpWorkflowRunId: null,
    },
    sourceMode: "download",
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "failed" });
  expect(harness.actions).toContain(
    "variant_failure:source_media_invalid:permanent",
  );
  expect(harness.actions).not.toContain("command");
  expect(harness.actions).not.toContain("upload");
});

for (const failure of [
  {
    name: "missing executable",
    injected: "command_missing",
    code: "worker_command_missing",
    disposition: "permanent",
    status: "failed",
  },
  {
    name: "timeout before output creation",
    injected: "command_timeout_before_output",
    code: "worker_command_timeout",
    disposition: "retryable",
    status: "requeued",
  },
  {
    name: "timeout after output creation",
    injected: "command_timeout_after_output",
    code: "worker_command_timeout",
    disposition: "retryable",
    status: "requeued",
  },
  {
    name: "nonzero exit",
    injected: "command_nonzero_exit",
    code: "worker_command_failed",
    disposition: "retryable",
    status: "requeued",
  },
] as const) {
  test(`ClipRenderAttempt classifies a ${failure.name} and skips dependent operations`, async () => {
    const harness = createOrdinaryTracer({
      attemptId: `30000000-0000-4000-8000-00000000007${failure.injected.length}`,
      failure: failure.injected,
      outcome: {
        status: failure.status,
        requested: 1,
        succeeded: 0,
        failed: 1,
        superseded: 0,
        followUpWorkflowRunId: null,
      },
    });

    await expect(
      harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
    ).resolves.toMatchObject({ status: failure.status });
    expect(harness.actions).toContain(
      `variant_failure:${failure.code}:${failure.disposition}`,
    );
    if (failure.injected === "command_timeout_after_output") {
      expect(harness.actions).toContain("output_created");
    }
    expect(harness.actions).not.toContain("upload");
    expect(harness.actions).not.toContain("guarded_completion");
  });
}

for (const interruption of ["cancellation", "ownership loss"] as const) {
  test(`ClipRenderAttempt waits for active command termination after ${interruption}`, async () => {
    const controller = new AbortController();
    const harness = createOrdinaryTracer({
      attemptId:
        interruption === "cancellation"
          ? "30000000-0000-4000-8000-000000000081"
          : "30000000-0000-4000-8000-000000000082",
      outcome: {
        status: "failed",
        requested: 1,
        succeeded: 0,
        failed: 1,
        superseded: 0,
        followUpWorkflowRunId: null,
      },
      waitForCommandAbort: true,
    });
    const executing = harness.clipRenderAttempt.execute(harness.attempt, attemptContext(controller.signal));
    while (!harness.actions.includes("command_started")) await Promise.resolve();
    const reason =
      interruption === "cancellation"
        ? new DOMException("cancelled", "AbortError")
        : new WorkflowAttemptLost(harness.attempt);
    controller.abort(reason);

    await expect(executing).rejects.toBe(reason);
    expect(harness.actions.indexOf("command_terminated")).toBeLessThan(
      harness.actions.indexOf("workspace_cleanup"),
    );
    expect(harness.actions).not.toContain("upload");
    expect(harness.actions).not.toContain("guarded_completion");
    expect(harness.actions.some((action) => action.startsWith("variant_failure:"))).toBe(
      false,
    );
    expect(harness.settlementCalls()).toBe(0);
  });
}

for (const failure of ["command", "upload"] as const) {
  test(`ClipRenderAttempt requeues a retryable ${failure} failure`, async () => {
    const expected: RenderWorkSetOutcome = {
      status: "requeued",
      requested: 1,
      succeeded: 0,
      failed: 1,
      superseded: 0,
      followUpWorkflowRunId: null,
    };
    const harness = createOrdinaryTracer({
      attemptId: `30000000-0000-4000-8000-00000000005${
        failure === "command" ? "4" : "5"
      }`,
      failure,
      outcome: expected,
    });

    await expect(
      harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
    ).resolves.toEqual(expected);
    expect(harness.variantState()).toBe("pending");
    expect(harness.actions).toContain(
      `variant_failure:${
        failure === "command"
          ? "ffmpeg_temporarily_unavailable"
          : "render_upload_failed"
      }:retryable`,
    );
    expect(harness.settlementCalls()).toBe(1);
    expect(harness.diagnostics).toContainEqual({
      message: "clip_render_attempt_settled",
      context: expect.objectContaining({
        workflowRunId: harness.attempt.workflowRunId,
        workflowAttemptId: harness.attempt.attemptId,
        projectId: harness.attempt.projectId,
        phase: "settlement",
        operation: "settle_render_work_set",
        disposition: expected.status,
        retryState: expected.status === "requeued" ? "retry_scheduled" : "terminal",
        requested: expected.requested,
        succeeded: expected.succeeded,
        failed: expected.failed,
        superseded: expected.superseded,
        followUpWorkflowRunId: null,
      }),
    });
    if (failure === "command") {
      expect(harness.diagnostics).toContainEqual({
        message: "clip_render_command_operation",
        context: expect.objectContaining({
          phase: "command_execution",
          operation: "exit",
          status: "failed",
          failureCode: "ffmpeg_temporarily_unavailable",
          disposition: "retryable",
          elapsedMs: 25,
        }),
      });
    }
  });
}

test("ClipRenderAttempt redacts signed access queries from diagnostics", async () => {
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000083",
    failure: "command",
    failureMessage:
      "Encoder rejected https://media.example/source.mp4?X-Amz-Signature=top-secret&token=private",
    outcome: {
      status: "requeued",
      requested: 1,
      succeeded: 0,
      failed: 1,
      superseded: 0,
      followUpWorkflowRunId: null,
    },
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "requeued" });

  const diagnostics = JSON.stringify(harness.diagnostics);
  expect(diagnostics).toContain("https://media.example/source.mp4?[redacted]");
  expect(diagnostics).not.toContain("top-secret");
  expect(diagnostics).not.toContain("token=private");
});

test("ClipRenderAttempt does not let a diagnostic sink failure reverse settlement", async () => {
  const expected: RenderWorkSetOutcome = {
    status: "completed",
    requested: 1,
    succeeded: 1,
    failed: 0,
    superseded: 0,
    followUpWorkflowRunId: null,
  };
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000084",
    diagnoseThrows: true,
    outcome: expected,
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual(expected);
  expect(harness.variantState()).toBe("completed");
  expect(harness.objectReferences).toEqual(harness.uploadedKeys);
  expect(harness.settlementCalls()).toBe(1);
});

test("ClipRenderAttempt observes a rejected background upload task before settlement", async () => {
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000063",
    failure: "upload",
    failureWriteRejects: true,
    outcome: {
      status: "requeued",
      requested: 1,
      succeeded: 0,
      failed: 1,
      superseded: 0,
      followUpWorkflowRunId: null,
    },
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).rejects.toBe(harness.injectedError);
  expect(harness.settlementCalls()).toBe(0);
  expect(harness.actions.indexOf("variant_failure:render_upload_failed:retryable"))
    .toBeLessThan(harness.actions.indexOf("workspace_cleanup"));
});

test("ClipRenderAttempt reports an owned deletion as superseded", async () => {
  const expected: RenderWorkSetOutcome = {
    status: "completed",
    requested: 1,
    succeeded: 0,
    failed: 0,
    superseded: 1,
    followUpWorkflowRunId: null,
  };
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000056",
    outcome: expected,
    superseded: true,
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual(expected);
  expect(harness.variantState()).toBe("superseded");
  expect(harness.deletedKeys).toEqual(harness.uploadedKeys);
  expect(harness.objectReferences).toEqual([]);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_variant_completion_stale_discarded",
    context: expect.objectContaining({
      workflowAttemptId: harness.attempt.attemptId,
      clipRenderId: "variant-ordinary",
      phase: "persistence",
      operation: "complete_clip_render_variant",
      failureCode: "variant_superseded",
      disposition: "superseded",
      objectKeyClass: "attempt_unique_render",
      cleanupResult: "deleted",
    }),
  });
});

test("ClipRenderAttempt diagnostics keep the owned attempt identity authoritative", async () => {
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000085",
    failure: "command",
    commandDiagnosticContext: {
      workflowRunId: "spoofed-run",
      workflowAttemptId: "spoofed-attempt",
      projectId: "spoofed-project",
      stage: "spoofed-stage",
      attemptCount: 99,
    },
    outcome: {
      status: "requeued",
      requested: 1,
      succeeded: 0,
      failed: 1,
      superseded: 0,
      followUpWorkflowRunId: null,
    },
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toMatchObject({ status: "requeued", failed: 1 });
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_command_operation",
    context: expect.objectContaining({
      workflowRunId: harness.attempt.workflowRunId,
      workflowAttemptId: harness.attempt.attemptId,
      projectId: harness.attempt.projectId,
      stage: harness.attempt.stage,
      attemptCount: harness.attempt.attemptCount,
    }),
  });
});

test("ClipRenderAttempt diagnoses provisional deletion failure without reversing supersession", async () => {
  const expected: RenderWorkSetOutcome = {
    status: "completed",
    requested: 1,
    succeeded: 0,
    failed: 0,
    superseded: 1,
    followUpWorkflowRunId: null,
  };
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000068",
    failure: "object_cleanup",
    outcome: expected,
    superseded: true,
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual(expected);
  expect(harness.variantState()).toBe("superseded");
  expect(harness.objectReferences).toEqual([]);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_provisional_cleanup_failed",
    context: expect.objectContaining({
      attemptId: harness.attempt.attemptId,
      phase: "cleanup",
      operation: "storage_delete",
      objectKey: harness.uploadedKeys[0],
      reason: "variant_superseded",
      failureCode: "provisional_object_delete_failed",
      disposition: "orphan_candidate",
    }),
  });
});

test("ClipRenderAttempt replays the same frozen work set idempotently", async () => {
  const expected: RenderWorkSetOutcome = {
    status: "completed",
    requested: 1,
    succeeded: 1,
    failed: 0,
    superseded: 0,
    followUpWorkflowRunId: null,
  };
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000057",
    outcome: expected,
  });
  const signal = new AbortController().signal;

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(signal)),
  ).resolves.toEqual(expected);
  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(signal)),
  ).resolves.toEqual(expected);
  expect(harness.beginCalls()).toBe(2);
  expect(harness.settlementCalls()).toBe(2);
  expect(harness.uploadedKeys).toHaveLength(1);
  expect(harness.objectReferences).toEqual(harness.uploadedKeys);
});

for (const failure of ["begin", "state_load"] as const) {
  test(`ClipRenderAttempt leaves a ${failure} infrastructure failure for recovery`, async () => {
    const harness = createOrdinaryTracer({
      attemptId: `30000000-0000-4000-8000-00000000005${
        failure === "begin" ? "8" : "9"
      }`,
      failure,
      outcome: {
        status: "failed",
        requested: 1,
        succeeded: 0,
        failed: 1,
        superseded: 0,
        followUpWorkflowRunId: null,
      },
    });

    await expect(
      harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
    ).rejects.toBe(harness.injectedError);
    expect(harness.settlementCalls()).toBe(0);
    expect(harness.uploadedKeys).toEqual([]);
  });
}

test("ClipRenderAttempt cleans a provisional object when guarded completion loses ownership", async () => {
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000060",
    failure: "guarded_completion",
    outcome: {
      status: "failed",
      requested: 1,
      succeeded: 0,
      failed: 1,
      superseded: 0,
      followUpWorkflowRunId: null,
    },
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).rejects.toBeInstanceOf(WorkflowAttemptLost);
  expect(harness.deletedKeys).toEqual(harness.uploadedKeys);
  expect(harness.objectReferences).toEqual([]);
  expect(harness.settlementCalls()).toBe(0);
  expect(
    harness.actions.some((action) => action.startsWith("variant_failure:")),
  ).toBe(false);
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_attempt_interrupted",
    context: expect.objectContaining({
      workflowRunId: harness.attempt.workflowRunId,
      workflowAttemptId: harness.attempt.attemptId,
      projectId: harness.attempt.projectId,
      phase: "ownership",
      operation: "execute",
      failureCode: "workflow_attempt_lost",
      disposition: "control",
      retryState: "reaper_owned",
    }),
  });
});

test("ClipRenderAttempt cleans a provisional object when guarded completion is rejected", async () => {
  const expected: RenderWorkSetOutcome = {
    status: "requeued",
    requested: 1,
    succeeded: 0,
    failed: 1,
    superseded: 0,
    followUpWorkflowRunId: null,
  };
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000062",
    failure: "guarded_completion_rejected",
    outcome: expected,
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual(expected);
  expect(harness.deletedKeys).toEqual(harness.uploadedKeys);
  expect(harness.objectReferences).toEqual([]);
  expect(harness.actions).toContain(
    "variant_failure:render_persistence_failed:retryable",
  );
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_variant_failed",
    context: expect.objectContaining({
      attemptId: harness.attempt.attemptId,
      phase: "persistence",
      operation: "complete_clip_render_variant",
      failureCode: "render_persistence_failed",
      disposition: "retryable",
      cleanupResult: "deleted",
    }),
  });
});

test("ClipRenderAttempt diagnoses cleanup failure without reversing settlement", async () => {
  const expected: RenderWorkSetOutcome = {
    status: "completed",
    requested: 1,
    succeeded: 1,
    failed: 0,
    superseded: 0,
    followUpWorkflowRunId: null,
  };
  const harness = createOrdinaryTracer({
    attemptId: "30000000-0000-4000-8000-000000000061",
    failure: "cleanup",
    outcome: expected,
  });

  await expect(
    harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal)),
  ).resolves.toEqual(expected);
  expect(harness.variantState()).toBe("completed");
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_workspace_cleanup_failed",
    context: expect.objectContaining({
      phase: "cleanup",
      operation: "scratch_cleanup",
    }),
  });
});
