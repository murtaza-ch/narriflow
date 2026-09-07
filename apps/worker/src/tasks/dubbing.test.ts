import { describe, expect, test } from "bun:test";
import type {
  WorkerMediaInspectionRequest,
  WorkerProcessModule,
  WorkerProcessRequest,
} from "../worker-process";
import { muxDubbedVideo, probeDubbedMediaDuration } from "./dubbing";

describe("dubbing process contract", () => {
  test("muxes the dubbed audio with the exact Workflow Attempt signal", async () => {
    const controller = new AbortController();
    let request: WorkerProcessRequest | undefined;
    const workerProcess: WorkerProcessModule = {
      execute: async (received) => {
        request = received;
        return { exitCode: 0, stdout: Buffer.alloc(0) };
      },
      inspectMedia: async () => {
        throw new Error("unexpected media inspection");
      },
      withScratchDirectory: async (_prefix, work) => work("/tmp/unused"),
    };

    await muxDubbedVideo({
      workerProcess,
      signal: controller.signal,
      videoPath: "/tmp/base.mp4",
      audioPath: "/tmp/dub.mp3",
      outputPath: "/tmp/output.mp4",
    });

    expect(request).toMatchObject({
      command: "ffmpeg",
      signal: controller.signal,
      deadlineMs: 10 * 60 * 1_000,
    });
    expect(request?.args).toEqual([
      "-y",
      "-i",
      "/tmp/base.mp4",
      "-i",
      "/tmp/dub.mp3",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-shortest",
      "-movflags",
      "+faststart",
      "/tmp/output.mp4",
    ]);
  });

  test("reads dubbed duration through normalized media inspection", async () => {
    const controller = new AbortController();
    let request: WorkerMediaInspectionRequest | undefined;
    const workerProcess: WorkerProcessModule = {
      execute: async () => {
        throw new Error("unexpected command execution");
      },
      inspectMedia: async (received) => {
        request = received;
        return {
          durationSec: 12.75,
          width: 1080,
          height: 1920,
          hasVideo: true,
          hasAudio: true,
          hasVisualStream: true,
          fps: 30,
        };
      },
      withScratchDirectory: async (_prefix, work) => work("/tmp/unused"),
    };

    await expect(
      probeDubbedMediaDuration(workerProcess, controller.signal, "/tmp/output.mp4"),
    ).resolves.toBe(12.75);
    expect(request).toEqual({
      sourcePath: "/tmp/output.mp4",
      signal: controller.signal,
      deadlineMs: 30_000,
    });
  });
});

import type { ClaimedWorkflowAttempt } from "@narriflow/services";
import { processDubbingRun } from "./dubbing";

test("an empty dubbing work set completes without requiring a speech provider", async () => {
  const attempt: ClaimedWorkflowAttempt = {
    workflowRunId: "run-dub-empty", projectId: "project-dub-empty", stage: "dubbing",
    attemptId: "attempt-dub-empty", attemptCount: 1,
  };
  let outcome = "pending";
  let cleaned = false;
  const workerProcess: WorkerProcessModule = {
    execute: async () => { throw new Error("empty work should not encode"); },
    inspectMedia: async () => { throw new Error("empty work should not probe"); },
    withScratchDirectory: async (_prefix, work) => {
      try { return await work("/tmp/unused"); } finally { cleaned = true; }
    },
  };
  await processDubbingRun(attempt, {
    signal: new AbortController().signal, reportProgress: async () => {},
  }, workerProcess, {
    getPendingDubs: async () => [],
    lifecycle: {
      completeDubbing: async () => { outcome = "completed"; },
      failAttempt: async () => { outcome = "failed"; },
      markDubProcessing: async () => { throw new Error("unexpected claim"); },
      completeDub: async () => { throw new Error("unexpected completion"); },
      failDub: async () => { throw new Error("unexpected failure"); },
    },
  });
  expect(outcome).toBe("completed");
  expect(cleaned).toBe(true);
});

test("dubbing ownership loss aborts without recording a failed Workflow Run", async () => {
  const { WorkflowAttemptLost } = await import("@narriflow/services");
  const attempt: ClaimedWorkflowAttempt = {
    workflowRunId: "run-dub-lost", projectId: "project-dub-lost", stage: "dubbing",
    attemptId: "attempt-dub-lost", attemptCount: 1,
  };
  let failed = false;
  let cleaned = false;
  const lost = new WorkflowAttemptLost(attempt);
  const workerProcess: WorkerProcessModule = {
    execute: async () => { throw new Error("unexpected encode"); },
    inspectMedia: async () => { throw new Error("unexpected probe"); },
    withScratchDirectory: async (_prefix, work) => {
      try { return await work("/tmp/unused"); } finally { cleaned = true; }
    },
  };
  await expect(processDubbingRun(attempt, {
    signal: new AbortController().signal, reportProgress: async () => {},
  }, workerProcess, {
    getPendingDubs: async () => { throw lost; },
    lifecycle: {
      completeDubbing: async () => { throw new Error("unexpected settlement"); },
      failAttempt: async () => { failed = true; },
      markDubProcessing: async () => { throw new Error("unexpected claim"); },
      completeDub: async () => { throw new Error("unexpected completion"); },
      failDub: async () => { throw new Error("unexpected failure"); },
    },
  })).rejects.toBe(lost);
  expect(failed).toBe(false);
  expect(cleaned).toBe(true);
});

test("a missing source render fails each claimed dub and settles the attempt once", async () => {
  type PendingDub = Awaited<ReturnType<typeof import("@narriflow/services").dubbingService.getPendingDubsForProject>>[number];
  const attempt: ClaimedWorkflowAttempt = {
    workflowRunId: "run-dub-missing", projectId: "project-dub-missing", stage: "dubbing",
    attemptId: "attempt-dub-missing", attemptCount: 1,
  };
  // Only source-render validation fields are read on this failure path.
  const dubs = ["dub-one", "dub-two"].map((id) => ({
    id, clipId: `clip-${id}`, aspectRatio: "ratio_9_16", clip: { renders: [] },
  } as unknown as PendingDub));
  const claimed: string[] = [];
  const failures: Array<{ id: string; code: string }> = [];
  const settlements: Array<{ code: string; disposition: string }> = [];
  let cleaned = false;
  await processDubbingRun(attempt, {
    signal: new AbortController().signal, reportProgress: async () => {},
  }, {
    execute: async () => { throw new Error("missing source should not encode"); },
    inspectMedia: async () => { throw new Error("missing source should not probe"); },
    withScratchDirectory: async (_prefix, work) => {
      try { return await work("/tmp/unused"); } finally { cleaned = true; }
    },
  }, {
    getPendingDubs: async () => dubs,
    lifecycle: {
      markDubProcessing: async (received, id) => { expect(received).toEqual(attempt); claimed.push(id); return { count: 1 }; },
      failDub: async (received, id, code) => { expect(received).toEqual(attempt); failures.push({ id, code }); return { count: 1 }; },
      completeDub: async () => { throw new Error("unexpected dub completion"); },
      completeDubbing: async () => { throw new Error("unexpected successful settlement"); },
      failAttempt: async (_received, failure) => { settlements.push(failure); },
    },
  });
  expect(claimed).toEqual(["dub-one", "dub-two"]);
  expect(failures).toEqual([
    { id: "dub-one", code: "base_render_missing" },
    { id: "dub-two", code: "base_render_missing" },
  ]);
  expect(settlements).toMatchObject([{ code: "dubbing_failed", disposition: "permanent" }]);
  expect(cleaned).toBe(true);
});
