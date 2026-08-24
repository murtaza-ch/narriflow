import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionRenderMediaAdapter } from "./render-media-adapter";
import type { RenderProcessRequest } from "./render-process-adapter";

test("media adapter normalizes probe output and forwards operation controls", async () => {
  const controller = new AbortController();
  let received: RenderProcessRequest | null = null;
  const diagnostics: string[] = [];
  const adapter = new ProductionRenderMediaAdapter({
    execute: async (request) => {
      received = request;
      request.diagnose?.({
        operation: "spawn",
        status: "completed",
        elapsedMs: 2,
      });
      return JSON.stringify({
        streams: [
          {
            codec_type: "video",
            width: 1920,
            height: 1080,
            r_frame_rate: "30000/1001",
          },
          { codec_type: "audio" },
        ],
      });
    },
  });

  const probe = await adapter.probe({
    sourcePath: "https://media.example/source.mp4?signature=secret",
    signal: controller.signal,
    deadlineMs: 2_000,
    killGraceMs: 50,
    diagnose: (event) => diagnostics.push(event.operation),
  });

  expect(probe).toEqual({
    width: 1920,
    height: 1080,
    hasVideo: true,
    hasAudio: true,
    fps: 30000 / 1001,
  });
  expect(received).toMatchObject({
    command: "ffprobe",
    signal: controller.signal,
    deadlineMs: 2_000,
    killGraceMs: 50,
    captureStdout: true,
  });
  expect(received!.args).toContain("-rw_timeout");
  expect(diagnostics).toEqual(["spawn"]);
});

test("media adapter classifies malformed probe output as permanent invalid media", async () => {
  const adapter = new ProductionRenderMediaAdapter({
    execute: async () => "not json",
  });

  await expect(
    adapter.probe({
      sourcePath: "/tmp/corrupt.mp4",
      signal: new AbortController().signal,
      deadlineMs: 1_000,
      killGraceMs: 20,
    }),
  ).rejects.toMatchObject({
    code: "source_media_invalid",
    disposition: "permanent",
  });
});

const FFMPEG_AVAILABLE =
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const FFPROBE_AVAILABLE =
  spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

test.skipIf(!FFMPEG_AVAILABLE || !FFPROBE_AVAILABLE)(
  "media adapter probes an isolated real-media fixture",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "narriflow-media-contract-"));
    const sourcePath = join(directory, "source.mp4");
    try {
      const generated = spawnSync("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x180:r=24:d=0.2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.2",
        "-shortest",
        "-c:v",
        "mpeg4",
        "-c:a",
        "aac",
        sourcePath,
      ]);
      expect(generated.status).toBe(0);

      const probe = await new ProductionRenderMediaAdapter().probe({
        sourcePath,
        signal: new AbortController().signal,
        deadlineMs: 5_000,
        killGraceMs: 50,
      });
      expect(probe).toMatchObject({
        width: 320,
        height: 180,
        hasVideo: true,
        hasAudio: true,
        fps: 24,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
