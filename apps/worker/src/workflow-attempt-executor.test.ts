import { expect, test } from "bun:test";
import type {
  ClaimedWorkflowAttempt,
  WorkflowAttemptContext,
  WorkflowAttemptRef,
} from "@narriflow/services";
import { WorkflowAttemptLost } from "@narriflow/services";
import {
  executeClaimedWorkflowAttempt,
  executeNextWorkflowAttempt,
} from "./workflow-attempt-executor";

test("a claimed Workflow Attempt is passed explicitly to its stage", async () => {
  const attempt: WorkflowAttemptRef = {
    workflowRunId: "run-1",
    projectId: "project-1",
    stage: "stt",
    attemptId: "attempt-1",
    attemptCount: 1,
  };
  const context: WorkflowAttemptContext = {
    signal: new AbortController().signal,
    reportProgress: async () => {},
  };
  let receivedAttempt: WorkflowAttemptRef | null = null;
  let receivedContext: WorkflowAttemptContext | null = null;

  const outcome = await executeClaimedWorkflowAttempt({
    attempt,
    lifecycle: {
      runAttempt: async (_attempt, handler) => handler(context),
    },
    process: async (claimedAttempt, executionContext) => {
      receivedAttempt = claimedAttempt;
      receivedContext = executionContext;
    },
  });

  expect(outcome).toBe("completed");
  expect(receivedAttempt).toBe(attempt);
  expect(receivedContext).toBe(context);
});

test("ownership loss is reported as a worker control outcome", async () => {
  const attempt: WorkflowAttemptRef = {
    workflowRunId: "run-1",
    projectId: "project-1",
    stage: "dubbing",
    attemptId: "attempt-1",
    attemptCount: 1,
  };
  const lost = new WorkflowAttemptLost(attempt);
  let reported: WorkflowAttemptLost | null = null;

  const outcome = await executeClaimedWorkflowAttempt({
    attempt,
    lifecycle: {
      runAttempt: async () => {
        throw lost;
      },
    },
    process: async () => {},
    onAttemptLost: (error) => {
      reported = error;
    },
  });

  expect(outcome).toBe("lost");
  expect(reported).toBe(lost);
});

test("the next-stage executor claims once and passes the exact attempt and context", async () => {
  const attempt: ClaimedWorkflowAttempt & { stage: "clip_rendering" } = {
    workflowRunId: "run-2",
    projectId: "project-2",
    stage: "clip_rendering",
    attemptId: "attempt-2",
    attemptCount: 1,
    status: "running",
    progress: 10,
    contentPackId: null,
    leaseExpiresAt: new Date("2026-09-05T00:01:00.000Z"),
    project: {
      id: "project-2",
      title: "Explicit attempt",
      sourceMediaUrl: "https://example.com/video.mp4",
      sourceType: "url",
      sourceInput: null,
      sourceStorageKey: null,
      sourceMimeType: "video/mp4",
      sourceDurationSeconds: 60,
      userId: "user-2",
      workspaceId: null,
    },
  };
  const context: WorkflowAttemptContext = {
    signal: new AbortController().signal,
    reportProgress: async () => {},
  };
  let receivedAttempt: WorkflowAttemptRef | null = null;
  let receivedContext: WorkflowAttemptContext | null = null;

  const claimed = await executeNextWorkflowAttempt({
    stage: "clip_rendering",
    lifecycle: {
      claim: async (stage) => {
        expect(stage).toBe("clip_rendering");
        return attempt;
      },
      runAttempt: async (claimedAttempt, handler) => {
        expect(claimedAttempt).toBe(attempt);
        return handler(context);
      },
    },
    process: async (claimedAttempt, executionContext) => {
      receivedAttempt = claimedAttempt;
      receivedContext = executionContext;
    },
  });

  expect(claimed).toBe(1);
  expect(receivedAttempt).toBe(attempt);
  expect(receivedContext).toBe(context);
});
