import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClipPendingAutoLayoutAnalysis } from "@narriflow/services";
import {
  analyzeClipAutoLayout,
  buildMultiFaceDetectorArgs,
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
    previewStorageKey: "projects/project-1/previews/clip-1.mp4",
    previewStartSec: 10,
    previewDurationSec: 10,
    autoLayoutClaimToken: "00000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

describe("analyzeClipAutoLayout", () => {
  test("keeps the detector CLI's fps-before-model positional contract", () => {
    expect(
      buildMultiFaceDetectorArgs({
        scriptPath: "/worker/reframe_detect.py",
        path: "/tmp/preview.mp4",
        startSec: 2.5,
        durationSec: 12,
        fps: "4",
        modelPath: "/worker/face_yunet.onnx",
      }),
    ).toEqual([
      "/worker/reframe_detect.py",
      "/tmp/preview.mp4",
      "2.5",
      "12",
      "4",
      "/worker/face_yunet.onnx",
      "--multi",
    ]);
  });

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

    const analysis = await analyzeClipAutoLayout({ clip: candidate(), previewPath: input });
    expect(analysis.sourceWidth).toBe(1);
    expect(analysis.sourceHeight).toBe(1);
    expect(analysis.segments).toEqual([]);
    expect(analysis.noSplitSegments).toEqual([]);
    expect(analysis.editedDurationSec).toBe(10);
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
      previewPath: input,
    });
    expect(analysis.deletedRanges).toEqual(deletedRanges);
    expect(analysis.editedDurationSec).toBe(8);
  });
});
