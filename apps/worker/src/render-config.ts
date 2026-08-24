export interface RenderConfigWarning {
  name: string;
  value: string;
  effective: unknown;
}

export interface RenderConfig {
  readonly clipRenderAttemptEnabled: boolean;
  readonly sourceMode: "ranged" | "download";
  readonly uploadConcurrency: number;
  readonly x264Preset: string;
  readonly x264Crf: string;
  readonly renderCommandTimeoutMs: number;
  readonly probeCommandTimeoutMs: number;
  readonly remoteMediaTimeoutMs: number;
  readonly storageOperationTimeoutMs: number;
  readonly processKillGraceMs: number;
  readonly reframePython: string;
  readonly reframeModelPath: string;
  readonly reframeSampleFps: number;
  readonly reframeSceneThreshold: number;
  readonly autoReframeEnabled: boolean;
  readonly layoutEngineEnabled: boolean;
  readonly screenLayoutEnabled: boolean;
  readonly splitEnabled: boolean;
  readonly pipDetectEnabled: boolean;
  readonly brollEnabled: boolean;
  readonly pexelsConfigured: boolean;
}

type RenderEnvironment = Record<string, string | undefined>;
const X264_PRESETS = new Set([
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
  "placebo",
]);

function positiveNumber(
  environment: RenderEnvironment,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a finite positive number`);
  }
  return parsed;
}

function featureEnabled(environment: RenderEnvironment, name: string): boolean {
  return environment[name] !== "0";
}

function enabledUnlessPaused(environment: RenderEnvironment, name: string): boolean {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") return true;
  if (value === "0") return false;
  if (value === "1") return true;
  throw new Error(`${name} must be either 0 or 1`);
}

export function parseRenderConfig(
  environment: RenderEnvironment,
  warn: (warning: RenderConfigWarning) => void = () => {},
): Readonly<RenderConfig> {
  const sourceMode = environment.WORKER_RENDER_SOURCE_MODE?.trim() || "ranged";
  if (sourceMode !== "ranged" && sourceMode !== "download") {
    throw new Error(
      "WORKER_RENDER_SOURCE_MODE must be either ranged or download",
    );
  }

  const configuredUploadConcurrency = positiveNumber(
    environment,
    "WORKER_UPLOAD_CONCURRENCY",
    2,
  );
  if (!Number.isInteger(configuredUploadConcurrency)) {
    throw new Error("WORKER_UPLOAD_CONCURRENCY must be an integer");
  }
  const uploadConcurrency = Math.min(4, configuredUploadConcurrency);
  if (configuredUploadConcurrency > 4) {
    warn({
      name: "WORKER_UPLOAD_CONCURRENCY",
      value: String(configuredUploadConcurrency),
      effective: uploadConcurrency,
    });
  }

  const x264CrfNumber = Number(environment.WORKER_X264_CRF?.trim() || "21");
  if (!Number.isFinite(x264CrfNumber) || x264CrfNumber < 0 || x264CrfNumber > 51) {
    throw new Error("WORKER_X264_CRF must be between 0 and 51");
  }
  const x264Crf = String(x264CrfNumber);
  if (x264CrfNumber < 18 || x264CrfNumber > 28) {
    warn({
      name: "WORKER_X264_CRF",
      value: environment.WORKER_X264_CRF?.trim() || x264Crf,
      effective: x264Crf,
    });
  }
  const x264Preset = environment.WORKER_X264_PRESET?.trim() || "veryfast";
  if (!X264_PRESETS.has(x264Preset)) {
    throw new Error(
      `WORKER_X264_PRESET must be one of ${[...X264_PRESETS].join(", ")}`,
    );
  }
  if (x264Preset !== "veryfast") {
    warn({
      name: "WORKER_X264_PRESET",
      value: x264Preset,
      effective: x264Preset,
    });
  }

  const reframeSceneThreshold = positiveNumber(
    environment,
    "REFRAME_SCENE_THRESHOLD",
    0.3,
  );
  if (reframeSceneThreshold > 1) {
    throw new Error("REFRAME_SCENE_THRESHOLD must be at most 1");
  }

  return Object.freeze({
    clipRenderAttemptEnabled: enabledUnlessPaused(
      environment,
      "WORKER_CLIP_RENDER_ATTEMPT_ENABLED",
    ),
    sourceMode,
    uploadConcurrency,
    x264Preset,
    x264Crf,
    renderCommandTimeoutMs: positiveNumber(
      environment,
      "WORKER_RENDER_FFMPEG_TIMEOUT_MS",
      30 * 60 * 1000,
    ),
    probeCommandTimeoutMs: positiveNumber(
      environment,
      "WORKER_PROBE_TIMEOUT_MS",
      2 * 60 * 1000,
    ),
    remoteMediaTimeoutMs: positiveNumber(
      environment,
      "WORKER_REMOTE_MEDIA_TIMEOUT_MS",
      45_000,
    ),
    storageOperationTimeoutMs: positiveNumber(
      environment,
      "WORKER_STORAGE_TIMEOUT_MS",
      2 * 60 * 1000,
    ),
    processKillGraceMs: positiveNumber(
      environment,
      "WORKER_PROCESS_KILL_GRACE_MS",
      5_000,
    ),
    reframePython: environment.REFRAME_PYTHON?.trim() || "python3",
    reframeModelPath:
      environment.REFRAME_MODEL_PATH?.trim() ||
      "/usr/local/share/narriflow/face_yunet.onnx",
    reframeSampleFps: positiveNumber(
      environment,
      "REFRAME_SAMPLE_FPS",
      4,
    ),
    reframeSceneThreshold,
    autoReframeEnabled: featureEnabled(environment, "WORKER_AUTO_REFRAME"),
    layoutEngineEnabled: featureEnabled(environment, "WORKER_LAYOUT_ENGINE"),
    screenLayoutEnabled: featureEnabled(environment, "WORKER_SCREEN_LAYOUT"),
    splitEnabled: featureEnabled(environment, "WORKER_SPLIT"),
    pipDetectEnabled: featureEnabled(environment, "WORKER_PIP_DETECT"),
    brollEnabled: featureEnabled(environment, "WORKER_BROLL"),
    pexelsConfigured: Boolean(environment.PEXELS_API_KEY?.trim()),
  });
}

export function parseWorkerRenderConfig(): Readonly<RenderConfig> {
  return parseRenderConfig(process.env, (warning) => {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "render_config_nonstandard_value",
        ...warning,
      }),
    );
  });
}
