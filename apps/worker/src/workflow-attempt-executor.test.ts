import { expect, test } from "bun:test";
import type {
  WorkflowAttemptContext,
  WorkflowAttemptRef,
} from "@narriflow/services";
import { WorkflowAttemptLost } from "@narriflow/services";
import { executeClaimedWorkflowAttempt } from "./workflow-attempt-executor";

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
