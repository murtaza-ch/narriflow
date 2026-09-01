import { describe, expect, test } from "bun:test";

import {
  ThumbnailFrameOutputError,
  createFfmpegThumbnailFrameProcessor,
} from "./thumbnail-extraction";

const request = {
  jobId: "40000000-0000-4000-8000-000000000001",
  sourceStorageKey: "exports/frozen.mp4",
  sourceTimeSec: 7.25,
  destinationStorageKey: "visual-assets/extracted/frame.jpg",
};

describe("thumbnail extraction worker", () => {
  test("extracts exactly one JPEG frame and publishes the verified object", async () => {
    let args: string[] = [];
    let uploaded: { key: string; contentType: string } | null = null;
    const processor = createFfmpegThumbnailFrameProcessor({
      createTempDirectory: async () => "/tmp/narriflow-thumbnail-test",
      removeTempDirectory: async () => undefined,
      sourceUrl: async () => "https://signed.invalid/source",
      runFfmpeg: async (_binary, nextArgs) => {
        args = nextArgs;
      },
      probe: async () => ({ width: 1080, height: 1920, contentType: "image/jpeg" }),
      fileSize: async () => 52_000,
      fingerprint: async () => "a".repeat(64),
      upload: async (input) => {
        uploaded = { key: input.key, contentType: input.contentType };
      },
    });

    expect(await processor.extract(request)).toMatchObject({
      storageKey: request.destinationStorageKey,
      width: 1080,
      height: 1920,
      contentType: "image/jpeg",
      fingerprint: "a".repeat(64),
    });
    expect(args).toContain("7.250");
    expect(args).toContain("-frames:v");
    expect(args).toContain("1");
    expect(args).toContain("-an");
    expect(uploaded).toEqual({ key: request.destinationStorageKey, contentType: "image/jpeg" });
  });

  test("does not publish an output that fails the image probe", async () => {
    let uploaded = false;
    const processor = createFfmpegThumbnailFrameProcessor({
      createTempDirectory: async () => "/tmp/narriflow-thumbnail-test",
      removeTempDirectory: async () => undefined,
      sourceUrl: async () => "https://signed.invalid/source",
      runFfmpeg: async () => undefined,
      probe: async () => null,
      fileSize: async () => 10,
      fingerprint: async () => "a".repeat(64),
      upload: async () => {
        uploaded = true;
      },
    });

    await expect(processor.extract(request)).rejects.toBeInstanceOf(
      ThumbnailFrameOutputError,
    );
    expect(uploaded).toBe(false);
  });
});
