import { expect, test } from "bun:test";
import type { RenderWorkSetOutcome } from "@narriflow/services";
import { parseRenderConfig } from "../render-config";
import {
  ClipRenderAttempt,
  type ClipRenderingWorkflowAttempt,
} from "./render-clips";

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
