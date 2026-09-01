import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowAttemptLost } from "@narriflow/services";
import { ProductionRenderProcessAdapter } from "./render-process-adapter";

const adapter = new ProductionRenderProcessAdapter();

test("process adapter rejects a pre-aborted request without spawning", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancelled", "AbortError");
  const diagnostics: string[] = [];
  controller.abort(reason);

  await expect(
    adapter.execute({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      signal: controller.signal,
      deadlineMs: 1_000,
      killGraceMs: 20,
      captureStdout: false,
      diagnose: (event) => diagnostics.push(event.operation),
    }),
  ).rejects.toBe(reason);
  expect(diagnostics).toEqual(["cancellation"]);
});

test("process adapter classifies a missing executable as permanent", async () => {
  const diagnostics: Array<{ operation: string; failureCode?: string }> = [];
  await expect(
    adapter.execute({
      command: "narriflow-command-that-does-not-exist",
      args: [],
      signal: new AbortController().signal,
      deadlineMs: 1_000,
      killGraceMs: 20,
      captureStdout: false,
      diagnose: (event) => diagnostics.push(event),
    }),
  ).rejects.toMatchObject({
    code: "worker_command_missing",
    disposition: "permanent",
  });
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      operation: "spawn",
      failureCode: "worker_command_missing",
    }),
  );
});

test("process adapter classifies a known invalid input exit as permanent", async () => {
  await expect(
    adapter.execute({
      command: process.execPath,
      args: [
        "-e",
        "console.error('Invalid data found when processing input'); process.exit(1)",
      ],
      signal: new AbortController().signal,
      deadlineMs: 1_000,
      killGraceMs: 20,
      captureStdout: false,
    }),
  ).rejects.toMatchObject({
    code: "worker_command_input_invalid",
    disposition: "permanent",
  });
});

test("process adapter classifies an otherwise nonzero exit as retryable", async () => {
  await expect(
    adapter.execute({
      command: process.execPath,
      args: ["-e", "console.error('encoder unavailable'); process.exit(7)"],
      signal: new AbortController().signal,
      deadlineMs: 1_000,
      killGraceMs: 20,
      captureStdout: false,
    }),
  ).rejects.toMatchObject({
    code: "worker_command_failed",
    disposition: "retryable",
  });
});

test("process adapter samples the worker and active command memory", async () => {
  const baselineBytes = process.memoryUsage().rss;
  const samples: number[] = [];

  await adapter.execute({
    command: process.execPath,
    args: [
      "-e",
      "const held = Buffer.alloc(64 * 1024 * 1024, 1); setTimeout(() => process.exit(held[0] === 1 ? 0 : 1), 350)",
    ],
    signal: new AbortController().signal,
    deadlineMs: 2_000,
    killGraceMs: 20,
    captureStdout: false,
    recordResourceSample: (rssBytes) => samples.push(rssBytes),
  });

  expect(samples.length).toBeGreaterThan(0);
  expect(Math.max(...samples)).toBeGreaterThan(baselineBytes + 32 * 1024 * 1024);
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

test("process adapter reaps descendants when the root exits during TERM escalation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "narriflow-process-contract-"));
  const childPidPath = join(directory, "child.pid");
  const diagnostics: Array<{
    operation: string;
    terminationSignal?: string;
  }> = [];
  let childPid: number | null = null;

  try {
    await expect(
      adapter.execute({
        command: process.execPath,
        args: [
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            "const { writeFileSync } = require('node:fs');",
            "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
            `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        signal: new AbortController().signal,
        deadlineMs: 100,
        killGraceMs: 50,
        captureStdout: false,
        diagnose: (event) => diagnostics.push(event),
      }),
    ).rejects.toMatchObject({
      code: "worker_command_timeout",
      disposition: "retryable",
    });

    childPid = Number(await readFile(childPidPath, "utf8"));
    expect(() => process.kill(childPid!, 0)).toThrow();
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ operation: "timeout" }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        operation: "termination",
        terminationSignal: "SIGTERM",
      }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        operation: "termination",
        terminationSignal: "SIGKILL",
      }),
    );
  } finally {
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("process adapter propagates WorkflowAttemptLost after reaping", async () => {
  const controller = new AbortController();
  const diagnostics: Array<{ operation: string; terminationSignal?: string }> = [];
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
    diagnose: (event) => diagnostics.push(event),
  });
  controller.abort(new WorkflowAttemptLost(attempt));

  await expect(executing).rejects.toBeInstanceOf(WorkflowAttemptLost);
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ operation: "cancellation" }),
  );
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      operation: "termination",
      terminationSignal: "SIGTERM",
    }),
  );
});
