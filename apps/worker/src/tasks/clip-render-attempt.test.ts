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
