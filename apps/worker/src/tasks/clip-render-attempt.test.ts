import { expect, test } from "bun:test";
import {
  clipService,
  type RenderWorkSetOutcome,
  WorkflowAttemptLost,
  WorkflowFailure,
} from "@narriflow/services";
import { parseRenderConfig } from "../render-config";
import {
  ClipRenderAttempt,
  type ClipRenderingWorkflowAttempt,
} from "./render-clips";

type PendingClipRender = Awaited<
  ReturnType<typeof clipService.getPendingClipRendersForWorkSet>
>[number];

type OrdinaryTracerFailure =
  | "begin"
  | "state_load"
  | "command"
  | "upload"
  | "guarded_completion"
  | "settlement"
  | "cleanup";

function createOrdinaryTracer(input: {
  attemptId: string;
  failure?: OrdinaryTracerFailure;
  initialVariantState?: "pending" | "completed";
  outcome: RenderWorkSetOutcome;
  superseded?: boolean;
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
    exportVariantId: null,
    exportVariant: null,
    clipSnapshot: null,
    clip: {
      id: "clip-ordinary",
      index: 0,
      startSec: 0,
      endSec: 5,
      llmModel: "test",
      transcriptSlice: [],
      deletedRanges: null,
      captionPreset: null,
      studioEdits: null,
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
  const diagnostics: Array<{
    message: string;
    context?: Record<string, unknown>;
  }> = [];
  let variantState:
    | "pending"
    | "rendering"
    | "completed"
    | "failed"
    | "superseded" = input.initialVariantState ?? "pending";
  let beginCalls = 0;
  let settlementCalls = 0;

  const clipRenderAttempt = new ClipRenderAttempt({
    run: {
      id: attempt.workflowRunId,
      projectId: attempt.projectId,
      project: {
        title: "Ordinary tracer",
        sourceStorageKey: `projects/${attempt.projectId}/source/input.mp3`,
        sourceDurationSeconds: 5,
        userId: "user",
        workspaceId: null,
      },
    },
    config: parseRenderConfig({
      WORKER_CLIP_RENDER_ATTEMPT_ENABLED: "1",
      WORKER_RENDER_SOURCE_MODE: "download",
      WORKER_AUTO_REFRAME: "0",
      WORKER_LAYOUT_ENGINE: "0",
      WORKER_SCREEN_LAYOUT: "0",
      WORKER_SPLIT: "0",
      WORKER_PIP_DETECT: "0",
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
      process: {
        execute: async ({ command }) => {
          if (command === "ffprobe") {
            return JSON.stringify({ streams: [{ codec_type: "audio" }] });
          }
          actions.push("command");
          if (input.failure === "command") {
            throw new WorkflowFailure(
              "ffmpeg_temporarily_unavailable",
              "retryable",
              "The encoder is temporarily unavailable",
            );
          }
          return "";
        },
      },
      project: {
        getUserPricingTier: async () => {
          actions.push("state_load");
          if (input.failure === "state_load") throw injectedError;
          return "pro";
        },
        getProjectBrandSnapshot: async () => null,
        publishWorkflowProgress: async () => {},
      },
      clip: {
        completeClipAutoLayoutAnalysis: async () => false,
        completeClipRenderVariant: async (_variantId, completion) => {
          actions.push("guarded_completion");
          if (input.failure === "guarded_completion") {
            throw new WorkflowAttemptLost(attempt);
          }
          if (input.superseded) {
            variantState = "superseded";
            return { persisted: false };
          }
          variantState = "completed";
          objectReferences.push(completion.storageKey);
          return { persisted: true };
        },
        failClipRenderVariant: async (_variantId, code, disposition) => {
          actions.push(`variant_failure:${code}:${disposition}`);
          variantState = "failed";
        },
        getPendingClipRendersForWorkSet: async () =>
          variantState === "pending" || variantState === "rendering"
            ? [pendingRender]
            : [],
        markClipRenderVariantRendering: async () => {
          actions.push("guarded_claim");
          variantState = "rendering";
          return true;
        },
        setClipLayoutAnalysis: async () => {},
      },
      storage: {
        downloadObjectToFile: async () => {},
        putFileFromPath: async ({ key }) => {
          actions.push("upload");
          if (input.failure === "upload") {
            throw new WorkflowFailure(
              "render_upload_failed",
              "retryable",
              "The object store is temporarily unavailable",
            );
          }
          uploadedKeys.push(key);
          return { key };
        },
        deleteObject: async (key) => {
          actions.push("object_cleanup");
          deletedKeys.push(key);
          return { key };
        },
      },
      workspace: {
        mkdtemp: async () => "/tmp/narriflow-render-ordinary-tracer",
        rm: async () => {
          actions.push("workspace_cleanup");
          if (input.failure === "cleanup") throw injectedError;
        },
        stat: async () => ({ size: 100 }) as never,
      },
      clock: { nowMs: () => 1_000 },
      diagnose: ({ message, context }) =>
        diagnostics.push({ message, context }),
    },
  });

  return {
    actions,
    attempt,
    beginCalls: () => beginCalls,
    clipRenderAttempt,
    deletedKeys,
    diagnostics,
    injectedError,
    objectReferences,
    settlementCalls: () => settlementCalls,
    uploadedKeys,
    variantState: () => variantState,
  };
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
      endSec: 5,
      llmModel: "test",
      transcriptSlice: [],
      deletedRanges: null,
      captionPreset: null,
      studioEdits: null,
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
        sourceDurationSeconds: 5,
        userId: "user",
        workspaceId: null,
      },
    },
    config: parseRenderConfig({
      WORKER_CLIP_RENDER_ATTEMPT_ENABLED: "1",
      WORKER_RENDER_SOURCE_MODE: "download",
      WORKER_AUTO_REFRAME: "0",
      WORKER_LAYOUT_ENGINE: "0",
      WORKER_SCREEN_LAYOUT: "0",
      WORKER_SPLIT: "0",
      WORKER_PIP_DETECT: "0",
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
      process: {
        execute: async ({ command }) => {
          if (command === "ffprobe") {
            return JSON.stringify({ streams: [{ codec_type: "audio" }] });
          }
          actions.push("encode");
          return "";
        },
      },
      project: {
        getUserPricingTier: async () => "pro",
        getProjectBrandSnapshot: async () => null,
        publishWorkflowProgress: async () => {},
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
        getPendingClipRendersForWorkSet: async () => [pendingRender],
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
        mkdtemp: async () => "/tmp/narriflow-render-post-upload-cancel",
        rm: async () => {
          actions.push("cleanup");
        },
        stat: async () => ({ size: 100 }) as never,
      },
      diagnose: () => {},
    },
  });

  await expect(
    clipRenderAttempt.execute({ attempt, signal: controller.signal }),
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
    config: parseRenderConfig({}),
    lifecycle,
  });

  await expect(
    clipRenderAttempt.execute({
      attempt,
      signal: new AbortController().signal,
    }),
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
    config: parseRenderConfig({}),
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
    clipRenderAttempt.execute({ attempt, signal: controller.signal }),
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
      project: {
        getUserPricingTier: async () => "free",
        getProjectBrandSnapshot: async () => null,
        publishWorkflowProgress: async () => {},
      },
      clip: {
        completeClipAutoLayoutAnalysis: async () => false,
        completeClipRenderVariant: async () => ({ persisted: true }),
        failClipRenderVariant: async (_id, code, disposition) => {
          mutations.push(`fail:${code}:${disposition}`);
        },
        getPendingClipRendersForWorkSet: async () => [],
        markClipRenderVariantRendering: async (id) => {
          mutations.push(`mark:${id}`);
        },
        setClipLayoutAnalysis: async () => {},
      },
      workspace: {
        mkdtemp: async () => "/tmp/narriflow-render-test",
        rm: async () => {
          mutations.push("cleanup");
        },
      },
      clock: { nowMs: () => 1_000 },
      diagnose: ({ message }) => diagnostics.push(message),
    },
  });

  await expect(
    clipRenderAttempt.execute({
      attempt,
      signal: new AbortController().signal,
    }),
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
      project: {
        getUserPricingTier: async () => "free",
        getProjectBrandSnapshot: async () => null,
        publishWorkflowProgress: async () => {},
      },
      clip: {
        completeClipAutoLayoutAnalysis: async () => false,
        completeClipRenderVariant: async () => ({ persisted: true }),
        failClipRenderVariant: async () => {
          mutations.push("fail");
        },
        getPendingClipRendersForWorkSet: async () => [],
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
      workspace: {
        mkdtemp: async () => "/tmp/narriflow-render-cancelled",
        rm: async () => {
          mutations.push("cleanup");
        },
      },
      diagnose: () => {},
    },
  });

  await expect(
    clipRenderAttempt.execute({ attempt, signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(mutations).toEqual(["cleanup"]);
  expect(settlementCalls).toBe(0);
});

test("ClipRenderAttempt owns a fully deleted variant before permanently failing it", async () => {
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
      endSec: 5,
      llmModel: "test",
      transcriptSlice: [],
      deletedRanges: [{ startSec: 0, endSec: 5 }],
      captionPreset: null,
      studioEdits: null,
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
        sourceDurationSeconds: 5,
        userId: "user",
        workspaceId: null,
      },
    },
    config: parseRenderConfig({
      WORKER_RENDER_SOURCE_MODE: "download",
      WORKER_AUTO_REFRAME: "0",
      WORKER_LAYOUT_ENGINE: "0",
      WORKER_SCREEN_LAYOUT: "0",
      WORKER_SPLIT: "0",
      WORKER_PIP_DETECT: "0",
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
      process: {
        execute: async ({ command }) =>
          command === "ffprobe"
            ? JSON.stringify({
                streams: [
                  { codec_type: "video", width: 1920, height: 1080 },
                  { codec_type: "audio" },
                ],
              })
            : "",
      },
      project: {
        getUserPricingTier: async () => "pro",
        getProjectBrandSnapshot: async () => null,
        publishWorkflowProgress: async () => {},
      },
      clip: {
        completeClipAutoLayoutAnalysis: async () => false,
        completeClipRenderVariant: async () => ({ persisted: true }),
        failClipRenderVariant: async (_id, code, disposition) => {
          mutations.push(`fail:${code}:${disposition}`);
        },
        getPendingClipRendersForWorkSet: async () => [pendingRender],
        markClipRenderVariantRendering: async (id) => {
          mutations.push(`mark:${id}`);
          return true;
        },
        setClipLayoutAnalysis: async () => {},
      },
      storage: { downloadObjectToFile: async () => {} },
      workspace: {
        mkdtemp: async () => "/tmp/narriflow-render-empty-cut",
        rm: async () => mutations.push("cleanup"),
      },
      diagnose: () => {},
    },
  });

  await expect(
    clipRenderAttempt.execute({
      attempt,
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual(expected);
  expect(mutations).toEqual([
    "mark:variant-empty-cut",
    "fail:clip_cut_plan_empty:permanent",
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
  ).rejects.toBe(harness.injectedError);
  expect(harness.actions).toEqual([
    "begin",
    "state_load",
    "settle",
    "workspace_cleanup",
  ]);
});

test("ClipRenderAttempt refuses execution while the cutover control is disabled", async () => {
  const harness = createInterfaceGuardTracer({ enabled: false });

  await expect(
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual(expected);
  expect(harness.variantState()).toBe("completed");
  expect(harness.uploadedKeys).toHaveLength(1);
  expect(harness.objectReferences).toEqual(harness.uploadedKeys);
  expect(harness.uploadedKeys[0]).toContain(harness.attempt.attemptId);
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
});

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
      harness.clipRenderAttempt.execute({
        attempt: harness.attempt,
        signal: new AbortController().signal,
      }),
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
  });
}

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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual(expected);
  expect(harness.variantState()).toBe("superseded");
  expect(harness.deletedKeys).toEqual(harness.uploadedKeys);
  expect(harness.objectReferences).toEqual([]);
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
    harness.clipRenderAttempt.execute({ attempt: harness.attempt, signal }),
  ).resolves.toEqual(expected);
  await expect(
    harness.clipRenderAttempt.execute({ attempt: harness.attempt, signal }),
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
      harness.clipRenderAttempt.execute({
        attempt: harness.attempt,
        signal: new AbortController().signal,
      }),
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
  ).rejects.toBeInstanceOf(WorkflowAttemptLost);
  expect(harness.deletedKeys).toEqual(harness.uploadedKeys);
  expect(harness.objectReferences).toEqual([]);
  expect(harness.settlementCalls()).toBe(0);
  expect(
    harness.actions.some((action) => action.startsWith("variant_failure:")),
  ).toBe(false);
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
    harness.clipRenderAttempt.execute({
      attempt: harness.attempt,
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual(expected);
  expect(harness.variantState()).toBe("completed");
  expect(harness.diagnostics).toContainEqual({
    message: "clip_render_workspace_cleanup_failed",
    context: expect.objectContaining({
      phase: "cleanup",
      operation: "workspace_remove",
    }),
  });
});
