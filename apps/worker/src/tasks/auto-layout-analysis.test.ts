import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LayoutEvidenceClaimLost, type ClipPendingAutoLayoutAnalysis } from "@narriflow/services";
import { parseRenderConfig } from "../render-config";
import type { WorkerProcessModule } from "../worker-process";
import {
  analyzeClipAutoLayout,
  processPendingAutoLayoutAnalyses,
} from "./auto-layout-analysis";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function candidate(overrides: Partial<ClipPendingAutoLayoutAnalysis> = {}): ClipPendingAutoLayoutAnalysis {
  return {
    id: "clip-1",
    projectId: "project-1",
    startSec: 10,
    endSec: 20,
    transcriptSlice: [],
    deletedRanges: [],
    editorRevision: 0,
    sourceStorageKey: "projects/project-1/source.mp4",
    previewStorageKey: "projects/project-1/previews/clip-1.mp4",
    previewStartSec: 10,
    previewDurationSec: 10,
    leaseMs: 180000,
    autoLayoutClaimToken: "00000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

describe("analyzeClipAutoLayout", () => {
  test("persists a valid empty visual plan for audio-only media", async () => {
    const dir = await mkdtemp(join(tmpdir(), "narriflow-auto-layout-test-"));
    tempDirs.push(dir);
    const input = join(dir, "audio.m4a");
    const generated = spawnSync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=10",
      "-c:a",
      "aac",
      input,
    ]);
    expect(generated.status).toBe(0);

    const analysis = await analyzeClipAutoLayout({ clip: candidate(), originalSourcePath: input, previewPath: input });
    expect(analysis.sourceWidth).toBe(1);
    expect(analysis.sourceHeight).toBe(1);
    expect(analysis.segments).toEqual([]);
    expect(analysis.noSplitSegments).toEqual([]);
    expect(analysis.editedDurationSec).toBe(10);
  });

  test("forwards the caller signal and skips visual subprocesses for audio-only media", async () => {
    const controller = new AbortController();
    let inspectedSignal: AbortSignal | undefined;
    const workerProcess: WorkerProcessModule = {
      execute: async () => {
        throw new Error("audio-only analysis must not start a visual subprocess");
      },
      inspectMedia: async (request) => {
        inspectedSignal = request.signal;
        return {
          durationSec: 10,
          width: 0,
          height: 0,
          hasVideo: false,
          hasAudio: true,
          hasVisualStream: false,
          fps: 30,
        };
      },
      withScratchDirectory: async (_prefix, work) => work("/tmp/unused"),
    };

    const analysis = await analyzeClipAutoLayout({
      clip: candidate(),
      originalSourcePath: "/tmp/original.m4a", previewPath: "/tmp/audio.m4a",
      signal: controller.signal,
      workerProcess,
    });

    expect(inspectedSignal).toBe(controller.signal);
    expect(analysis.segments).toEqual([]);
  });

  test("preserves shutdown cancellation from optional scene detection", async () => {
    const controller = new AbortController();
    const reason = { kind: "worker-shutdown" };
    const workerProcess: WorkerProcessModule = {
      execute: async (request) => {
        if (request.command === "ffmpeg") {
          controller.abort(reason);
          throw reason;
        }
        return {
          exitCode: 0,
          stdout: Buffer.from(JSON.stringify({ samples: [] })),
        };
      },
      inspectMedia: async () => ({
        durationSec: 10,
        width: 1920,
        height: 1080,
        hasVideo: true,
        hasAudio: true,
        hasVisualStream: true,
        fps: 30,
      }),
      withScratchDirectory: async (_prefix, work) => work("/tmp/unused"),
    };

    await expect(
      analyzeClipAutoLayout({
        clip: candidate(),
        originalSourcePath: "/tmp/original.mp4", previewPath: "/tmp/video.mp4",
        signal: controller.signal,
        workerProcess,
      }),
    ).rejects.toBe(reason);
  });

  test("rejects a transient durable publication failure so the claim runner applies backoff", async () => {
    const workerProcess: WorkerProcessModule = {
      execute: async () => { throw new Error("audio needs no detector"); },
      inspectMedia: async () => ({ durationSec: 10, width: 0, height: 0, hasVideo: false, hasAudio: true, hasVisualStream: false, fps: 30 }),
      withScratchDirectory: async (_prefix, work) => work("unused"),
    };
    await expect(analyzeClipAutoLayout({ clip: candidate(), previewPath: "proxy.m4a", originalSourcePath: "original.m4a", workerProcess, persist: async () => { throw new Error("database unavailable"); } })).rejects.toThrow("automatic_layout_evidence_persist_failed");
  });

  test("uses edited duration and fingerprints deleted source ranges", async () => {
    const dir = await mkdtemp(join(tmpdir(), "narriflow-auto-layout-test-"));
    tempDirs.push(dir);
    const input = join(dir, "audio.m4a");
    const generated = spawnSync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      "10",
      "-c:a",
      "aac",
      input,
    ]);
    expect(generated.status).toBe(0);

    const deletedRanges = [{ startSec: 13, endSec: 15 }];
    const analysis = await analyzeClipAutoLayout({
      clip: candidate({ deletedRanges }),
      originalSourcePath: input, previewPath: input,
    });
    expect(analysis.deletedRanges).toEqual(deletedRanges);
    expect(analysis.editedDurationSec).toBe(8);
  });
});

test("background processor uses the claim signal and configured backoff after publication failure", async () => {
  const claim = candidate();
  const claimController = new AbortController();
  const external = new AbortController();
  const deferrals: Date[] = [];
  type Options = NonNullable<Parameters<typeof processPendingAutoLayoutAnalyses>[0]>;
  const lifecycle: NonNullable<Options["lifecycle"]> = {
    claimAutomatic: async (leaseMs) => { expect(leaseMs).toBe(30000); return claim; },
    runAutomaticClaim: async (received, work, options) => { expect(received).toBe(claim); expect(options?.signal).toBe(external.signal); return work({ signal: claimController.signal }); },
    completeAutomatic: async () => { throw new Error("publication unavailable"); },
    deferAutomatic: async (id, token, retryAt) => { expect(id).toBe(claim.id); expect(token).toBe(claim.autoLayoutClaimToken); deferrals.push(retryAt); return true; },
  };
  const workerProcess: WorkerProcessModule = {
    inspectMedia: async (request) => { expect(request.sourcePath).toBe("original-source.m4a"); expect(request.signal).toBe(claimController.signal); return { durationSec: 10, width: 0, height: 0, hasVideo: false, hasAudio: true, hasVisualStream: false, fps: 30 }; },
    execute: async () => { throw new Error("audio needs no detector"); },
    withScratchDirectory: async (_prefix, work) => work("scratch"),
  };
  const before = Date.now();
  expect(await processPendingAutoLayoutAnalyses({ limit: 1, signal: external.signal, lifecycle, workerProcess, config: parseRenderConfig({ WORKER_AUTO_LAYOUT_LEASE_MS: "30000", WORKER_AUTO_LAYOUT_FAILURE_BACKOFF_MS: "10000" }), storage: {
    presignDownloadUrl: async (request) => { expect(request.key).toBe(claim.sourceStorageKey); return "original-source.m4a"; },
    downloadObjectToFile: async (request) => { expect(request.key).toBe(claim.previewStorageKey); expect(request.signal).toBe(claimController.signal); return { key: request.key, contentType: "audio/mp4" }; },
  } })).toBe(0);
  expect(deferrals).toHaveLength(1);
  expect(deferrals[0]!.getTime()).toBeGreaterThanOrEqual(before + 10000);
  expect(deferrals[0]!.getTime()).toBeLessThanOrEqual(Date.now() + 10000);
});

test("background ownership loss stops source work without ordinary failure deferral", async () => {
  const claim = candidate();
  const controller = new AbortController();
  const lost = new LayoutEvidenceClaimLost(claim.id);
  let inspected = false;
  let persisted = false;
  let deferred = false;
  type Options = NonNullable<Parameters<typeof processPendingAutoLayoutAnalyses>[0]>;
  const lifecycle: NonNullable<Options["lifecycle"]> = {
    claimAutomatic: async () => claim,
    runAutomaticClaim: async (_received, work) => work({ signal: controller.signal }),
    completeAutomatic: async () => { persisted = true; return true; },
    deferAutomatic: async () => { deferred = true; return true; },
  };
  const workerProcess: WorkerProcessModule = {
    inspectMedia: async () => { inspected = true; throw new Error("claim is already lost"); },
    execute: async () => { throw new Error("claim is already lost"); },
    withScratchDirectory: async (_prefix, work) => work("scratch"),
  };
  expect(await processPendingAutoLayoutAnalyses({ limit: 1, lifecycle, workerProcess, config: parseRenderConfig({}), storage: {
    presignDownloadUrl: async () => "original.mp4",
    downloadObjectToFile: async (request) => { expect(request.signal).toBe(controller.signal); controller.abort(lost); throw lost; },
  } })).toBe(0);
  expect(inspected).toBe(false);
  expect(persisted).toBe(false);
  expect(deferred).toBe(false);
});
