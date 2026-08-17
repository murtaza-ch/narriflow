import { expect, test } from "bun:test";
import { WorkflowAttemptLost } from "@narriflow/services";
import { ProductionRenderProcessAdapter } from "./render-process-adapter";

const adapter = new ProductionRenderProcessAdapter();

test("process adapter classifies a missing executable as permanent", async () => {
  await expect(
    adapter.execute({
      command: "narriflow-command-that-does-not-exist",
      args: [],
      signal: new AbortController().signal,
      deadlineMs: 1_000,
      killGraceMs: 20,
      captureStdout: false,
    }),
  ).rejects.toMatchObject({
    code: "worker_command_missing",
    disposition: "permanent",
  });
});

test("process adapter terminates and reaps a timed out process", async () => {
  await expect(
    adapter.execute({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      signal: new AbortController().signal,
      deadlineMs: 20,
      killGraceMs: 20,
      captureStdout: false,
    }),
  ).rejects.toMatchObject({
    code: "worker_command_timeout",
    disposition: "retryable",
  });
});

test("process adapter propagates WorkflowAttemptLost after reaping", async () => {
  const controller = new AbortController();
  const attempt = {
    workflowRunId: "10000000-0000-0000-0000-000000000001",
    projectId: "20000000-0000-0000-0000-000000000002",
    stage: "clip_rendering" as const,
    attemptId: "30000000-0000-0000-0000-000000000003",
    attemptCount: 1,
  };
  const executing = adapter.execute({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    signal: controller.signal,
    deadlineMs: 5_000,
    killGraceMs: 20,
    captureStdout: false,
  });
  controller.abort(new WorkflowAttemptLost(attempt));

  await expect(executing).rejects.toBeInstanceOf(WorkflowAttemptLost);
});
