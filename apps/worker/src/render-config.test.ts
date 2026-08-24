import { describe, expect, test } from "bun:test";
import { parseRenderConfig } from "./render-config";

describe("RenderConfig", () => {
  test("freezes current defaults and preserves literal zero kill switches", () => {
    const config = parseRenderConfig({
      WORKER_AUTO_REFRAME: "0",
      WORKER_LAYOUT_ENGINE: "0",
      WORKER_SCREEN_LAYOUT: "0",
      WORKER_SPLIT: "0",
      WORKER_PIP_DETECT: "0",
      WORKER_BROLL: "0",
    });

    expect(config).toMatchObject({
      sourceMode: "ranged",
      clipRenderAttemptEnabled: true,
      uploadConcurrency: 2,
      renderCommandTimeoutMs: 1_800_000,
      probeCommandTimeoutMs: 120_000,
      autoReframeEnabled: false,
      layoutEngineEnabled: false,
      screenLayoutEnabled: false,
      splitEnabled: false,
      pipDetectEnabled: false,
      brollEnabled: false,
      pexelsConfigured: false,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  test("renders by default and preserves an explicit operational pause", () => {
    expect(parseRenderConfig({}).clipRenderAttemptEnabled).toBe(true);
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
  });
});
