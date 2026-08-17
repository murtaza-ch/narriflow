import { expect, test } from "bun:test";
import { clipService, type RenderWorkSetOutcome } from "@narriflow/services";
import { parseRenderConfig } from "../render-config";
import {
  ClipRenderAttempt,
  type ClipRenderingWorkflowAttempt,
} from "./render-clips";

type PendingClipRender = Awaited<
  ReturnType<typeof clipService.getPendingClipRendersForWorkSet>
>[number];

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
      settleRenderWorkSet: async () => expected,
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
