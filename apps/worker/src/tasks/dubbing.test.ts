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
