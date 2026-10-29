import { describe, expect, test } from "bun:test";
import { parseRenderConfig } from "./render-config";

describe("RenderConfig", () => {
  test("exposes no composition renderer selector", () => {
    const config = parseRenderConfig({});

    expect(config).not.toHaveProperty("compositionRenderer");
    expect(config).not.toHaveProperty("compositionPath");
  });

  test("freezes validated worker defaults", () => {
    const config = parseRenderConfig({});

    expect(config).toMatchObject({
      sourceMode: "ranged",
      uploadConcurrency: 2,
      renderCommandTimeoutMs: 1_800_000,
      probeCommandTimeoutMs: 120_000,
      compositionCommandMaxBytes: 512 * 1024,
      pexelsConfigured: false,
      pipMotionThreshold: 0.12,
      brollAssetCacheTtlMs: 24 * 60 * 60 * 1000,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  test("caps upload concurrency at four and warns for accepted nonstandard values", () => {
    const warnings: Array<{ name: string; value: string; effective: unknown }> = [];
    const config = parseRenderConfig(
      {
        WORKER_UPLOAD_CONCURRENCY: "9",
        WORKER_X264_CRF: "30",
        WORKER_X264_PRESET: "slow",
      },
      (warning) => warnings.push(warning),
    );

    expect(config.uploadConcurrency).toBe(4);
    expect(warnings).toEqual([
      { name: "WORKER_UPLOAD_CONCURRENCY", value: "9", effective: 4 },
      { name: "WORKER_X264_CRF", value: "30", effective: "30" },
      { name: "WORKER_X264_PRESET", value: "slow", effective: "slow" },
    ]);
  });

  test("rejects invalid enums and non-positive or non-finite deadlines", () => {
    expect(() =>
      parseRenderConfig({ WORKER_RENDER_SOURCE_MODE: "stream" }),
    ).toThrow("WORKER_RENDER_SOURCE_MODE");
    expect(() =>
      parseRenderConfig({ WORKER_RENDER_FFMPEG_TIMEOUT_MS: "0" }),
    ).toThrow("WORKER_RENDER_FFMPEG_TIMEOUT_MS");
    expect(() =>
      parseRenderConfig({ WORKER_PROBE_TIMEOUT_MS: "Infinity" }),
    ).toThrow("WORKER_PROBE_TIMEOUT_MS");
    expect(() =>
      parseRenderConfig({ WORKER_X264_PRESET: "warp-speed" }),
    ).toThrow("WORKER_X264_PRESET");
    expect(() =>
      parseRenderConfig({ WORKER_PIP_MOTION_THRESHOLD: "0" }),
    ).toThrow("WORKER_PIP_MOTION_THRESHOLD");
    expect(() =>
      parseRenderConfig({ WORKER_PIP_MOTION_THRESHOLD: "1.01" }),
    ).toThrow("WORKER_PIP_MOTION_THRESHOLD");
    expect(() =>
      parseRenderConfig({ WORKER_COMPOSITION_MAX_COMMAND_BYTES: "0" }),
    ).toThrow("WORKER_COMPOSITION_MAX_COMMAND_BYTES");
    expect(() =>
      parseRenderConfig({ WORKER_COMPOSITION_MAX_COMMAND_BYTES: "100.5" }),
    ).toThrow("WORKER_COMPOSITION_MAX_COMMAND_BYTES");
    expect(() =>
      parseRenderConfig({ BROLL_ASSET_CACHE_TTL_HOURS: "NaN" }),
    ).toThrow("BROLL_ASSET_CACHE_TTL_HOURS");
  });

  test("parses every render-affecting threshold and cache lifetime once", () => {
    const config = parseRenderConfig({
      WORKER_PIP_MOTION_THRESHOLD: "0.25",
      BROLL_ASSET_CACHE_TTL_HOURS: "0.5",
    });

    expect(config.pipMotionThreshold).toBe(0.25);
    expect(config.brollAssetCacheTtlMs).toBe(30 * 60 * 1000);
  });

});

test("validates background layout configuration and every detector setting", () => {
  expect(parseRenderConfig({ WORKER_AUTO_LAYOUT_BATCH_SIZE: "10", WORKER_AUTO_LAYOUT_LEASE_MS: "240000", WORKER_AUTO_LAYOUT_FAILURE_BACKOFF_MS: "0", REFRAME_SAMPLE_FPS: "2", REFRAME_SCENE_THRESHOLD: "0.4" })).toMatchObject({ autoLayoutBatchSize: 10, autoLayoutLeaseMs: 240000, autoLayoutFailureBackoffMs: 0, reframeSampleFps: 2, reframeSceneThreshold: 0.4 });
  for (const [name, invalid] of [
    ["WORKER_AUTO_LAYOUT_BATCH_SIZE", "11"], ["WORKER_AUTO_LAYOUT_BATCH_SIZE", "1.5"], ["WORKER_AUTO_LAYOUT_LEASE_MS", "0"], ["WORKER_AUTO_LAYOUT_LEASE_MS", "29999"], ["WORKER_AUTO_LAYOUT_LEASE_MS", "900001"], ["WORKER_AUTO_LAYOUT_FAILURE_BACKOFF_MS", "-1"], ["REFRAME_SAMPLE_FPS", "NaN"], ["REFRAME_SCENE_THRESHOLD", "1.1"],
  ]) expect(() => parseRenderConfig({ [name!]: invalid })).toThrow(name);
});

test("accepts exact background lease policy limits", () => {
  expect(parseRenderConfig({ WORKER_AUTO_LAYOUT_LEASE_MS: "30000" }).autoLayoutLeaseMs).toBe(30000);
  expect(parseRenderConfig({ WORKER_AUTO_LAYOUT_LEASE_MS: "900000" }).autoLayoutLeaseMs).toBe(900000);
});

describe("resource bounds", () => {
  test("defaults follow the spec and are recorded on the frozen config", () => {
    expect(parseRenderConfig({})).toMatchObject({
      renderDeadlineFloorMs: 300_000,
      renderDeadlineRealtimeFactor: 20,
      transferDeadlineFloorMs: 120_000,
      transferDeadlineCeilingMs: 1_800_000,
      transferMinBytesPerSec: 1024 * 1024,
      transferNoProgressMs: 30_000,
      uploadMaxWaitingJobs: 2,
      uploadMaxWaitingBytes: 512 * 1024 ** 2,
      diskMinFreeBytes: 1024 ** 3,
      diskMinFreeFraction: 0.1,
      scratchMaxBytes: 8 * 1024 ** 3,
      scratchMaxVolumeFraction: 0.5,
      brollCacheMaxBytes: 1024 ** 3,
    });
  });

  test("a short render ceiling lowers the default floor instead of rejecting startup", () => {
    expect(parseRenderConfig({ WORKER_RENDER_FFMPEG_TIMEOUT_MS: "60000" }).renderDeadlineFloorMs).toBe(60_000);
    expect(parseRenderConfig({ WORKER_RENDER_FFMPEG_TIMEOUT_MS: "2.5" }).renderDeadlineFloorMs).toBe(2);
  });

  test("rejects floors above ceilings and out-of-range limits by name", () => {
    for (const [name, invalid] of [
      ["WORKER_RENDER_DEADLINE_FLOOR_MS", "1800001"],
      ["WORKER_RENDER_DEADLINE_FACTOR", "0.5"],
      ["WORKER_TRANSFER_DEADLINE_FLOOR_MS", "1800001"],
      ["WORKER_TRANSFER_MIN_BYTES_PER_SEC", "10"],
      ["WORKER_TRANSFER_NO_PROGRESS_MS", "10"],
      ["WORKER_UPLOAD_MAX_WAITING_JOBS", "0"],
      ["WORKER_UPLOAD_MAX_WAITING_BYTES", "1.5"],
      ["WORKER_DISK_MIN_FREE_FRACTION", "0.95"],
      ["WORKER_SCRATCH_MAX_VOLUME_FRACTION", "0"],
      ["WORKER_DISK_ADMISSION_WAIT_MS", "-1"],
      ["BROLL_ASSET_CACHE_MAX_BYTES", "NaN"],
      ["WORKER_SCRATCH_SWEEP_INTERVAL_MS", "5"],
    ] as const) expect(() => parseRenderConfig({ [name]: invalid })).toThrow(name);
  });
});
