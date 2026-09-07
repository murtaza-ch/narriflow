import { describe, expect, test } from "bun:test";
import { parseRenderConfig } from "./render-config";

describe("RenderConfig", () => {
  test("exposes no composition renderer selector", () => {
    const config = parseRenderConfig({});

    expect(config).not.toHaveProperty("compositionRenderer");
    expect(config).not.toHaveProperty("compositionPath");
  });

  test("freezes current defaults and preserves literal zero kill switches", () => {
    const config = parseRenderConfig({
      WORKER_LAYOUT_ENGINE: "0",
      WORKER_SCREEN_LAYOUT: "0",
      WORKER_SPLIT: "0",
      WORKER_BROLL: "0",
    });

    expect(config).toMatchObject({
      sourceMode: "ranged",
      clipRenderAttemptEnabled: false,
      uploadConcurrency: 2,
      renderCommandTimeoutMs: 1_800_000,
      probeCommandTimeoutMs: 120_000,
      compositionCommandMaxBytes: 512 * 1024,
      layoutEngineEnabled: false,
      screenLayoutEnabled: false,
      splitEnabled: false,
      brollEnabled: false,
      pexelsConfigured: false,
      pipMotionThreshold: 0.12,
      brollAssetCacheTtlMs: 24 * 60 * 60 * 1000,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  test("keeps live claims dark by default and requires an explicit enable", () => {
    expect(parseRenderConfig({}).clipRenderAttemptEnabled).toBe(false);
    expect(
      parseRenderConfig({ WORKER_CLIP_RENDER_ATTEMPT_ENABLED: "1" })
        .clipRenderAttemptEnabled,
    ).toBe(true);
    expect(
      parseRenderConfig({ WORKER_CLIP_RENDER_ATTEMPT_ENABLED: "0" })
        .clipRenderAttemptEnabled,
    ).toBe(false);
    expect(() =>
      parseRenderConfig({ WORKER_CLIP_RENDER_ATTEMPT_ENABLED: "yes" }),
    ).toThrow("WORKER_CLIP_RENDER_ATTEMPT_ENABLED");
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
      parseRenderConfig({ WORKER_LAYOUT_ENGINE: "2" }),
    ).toThrow("WORKER_LAYOUT_ENGINE");
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
