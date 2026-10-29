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
      releaseAttempt: async () => false,
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

test("worker shutdown reaches an active Workflow Attempt", async () => {
  const shutdown = new AbortController();
  const attempt = {
    workflowRunId: "run-shutdown",
    projectId: "project-shutdown",
    stage: "stt" as const,
    attemptId: "attempt-shutdown",
    attemptCount: 1,
    status: "running" as const,
    progress: 0,
    contentPackId: null,
    leaseExpiresAt: new Date(),
    project: { id: "project-shutdown", title: "", sourceMediaUrl: "", sourceType: "url" as const, sourceInput: null, sourceStorageKey: null, sourceMimeType: null, sourceDurationSeconds: null, userId: "user", workspaceId: null },
  } satisfies ClaimedWorkflowAttempt;
  let receivedSignal: AbortSignal | null = null;
  let processingStarted!: () => void;
  const processing = new Promise<void>((resolve) => { processingStarted = resolve; });

  const executing = executeNextWorkflowAttempt({
    stage: "stt",
    signal: shutdown.signal,
    lifecycle: {
      claim: async () => attempt,
      releaseAttempt: async () => false,
      runAttempt: async (_attempt, handler, options) => handler({
        signal: AbortSignal.any([new AbortController().signal, options?.signal ?? new AbortController().signal]),
        reportProgress: async () => {},
      }),
    },
    process: async (_attempt, context) => {
      receivedSignal = context.signal;
      processingStarted();
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
    },
  });
  await processing;
  shutdown.abort(new Error("worker_shutdown"));
  await executing;
  expect(receivedSignal?.aborted).toBe(true);
});

test("shutdown during claim never starts a Workflow Attempt handler", async () => {
  const shutdown = new AbortController();
  let releaseClaim!: () => void;
  const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
  let started = false;
  const executing = executeNextWorkflowAttempt({
    stage: "stt",
    signal: shutdown.signal,
    lifecycle: {
      claim: async () => { await claimGate; return null; },
      releaseAttempt: async () => false,
      runAttempt: async () => { started = true; },
    },
    process: async () => { started = true; },
  });
  shutdown.abort(new Error("worker_shutdown"));
  releaseClaim();
  expect(await executing).toBe(0);
  expect(started).toBe(false);
});

test("shutdown during a successful claim releases the claim without executing it", async () => {
  const shutdown = new AbortController();
  const attempt = { workflowRunId: "late-run", projectId: "late-project", stage: "dubbing" as const, attemptId: "late-attempt", attemptCount: 1 } as ClaimedWorkflowAttempt & { stage: "dubbing" };
  let releases = 0;
  let executions = 0;
  expect(await executeNextWorkflowAttempt({
    stage: "dubbing",
    signal: shutdown.signal,
    lifecycle: {
      claim: async () => { shutdown.abort(new Error("worker_shutdown")); return attempt; },
      runAttempt: async () => { executions += 1; },
      releaseAttempt: async (claimed: WorkflowAttemptRef) => { expect(claimed).toBe(attempt); releases += 1; return true; },
    },
    process: async () => { executions += 1; },
  })).toBe(0);
  expect(releases).toBe(1);
  expect(executions).toBe(0);
});

test("a shutdown interruption is worker control flow rather than a poll failure", async () => {
  const shutdown = new AbortController();
  const attempt: WorkflowAttemptRef = { workflowRunId: "run", projectId: "project", stage: "dubbing", attemptId: "attempt", attemptCount: 1 };
  expect(await executeClaimedWorkflowAttempt({
    attempt,
    signal: shutdown.signal,
    lifecycle: {
      runAttempt: async () => { shutdown.abort(new Error("worker_shutdown")); shutdown.signal.throwIfAborted(); },
    },
    process: async () => {},
  })).toBe("interrupted");
});

test("only the claimed attempt's execution runs under the held lease, not the claim", async () => {
  const attempt = {
    workflowRunId: "run-1",
    projectId: "project-1",
    stage: "stt",
    attemptId: "attempt-1",
    attemptCount: 1,
  } as ClaimedWorkflowAttempt & { stage: "stt" };
  const events: string[] = [];

  const processed = await executeNextWorkflowAttempt({
    stage: "stt",
    lifecycle: {
      claim: async () => {
        events.push("claim");
        return attempt;
      },
      releaseAttempt: async () => true,
      runAttempt: async (_attempt, handler) =>
        handler({ signal: new AbortController().signal, reportProgress: async () => {} }),
    },
    holdingLease: async (work) => {
      events.push("lease:start");
      try {
        return await work();
      } finally {
        events.push("lease:end");
      }
    },
    process: async () => {
      events.push("process");
    },
  });

  expect(processed).toBe(1);
  expect(events).toEqual(["claim", "lease:start", "process", "lease:end"]);
});
