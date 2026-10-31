export interface RenderConfigWarning {
  name: string;
  value: string;
  effective: unknown;
}

export interface RenderConfig {
  readonly sourceMode: "ranged" | "download";
  readonly uploadConcurrency: number;
  readonly x264Preset: string;
  readonly x264Crf: string;
  readonly renderCommandTimeoutMs: number;
  readonly probeCommandTimeoutMs: number;
  readonly compositionCommandMaxBytes: number;
  readonly remoteMediaTimeoutMs: number;
  readonly storageOperationTimeoutMs: number;
  readonly reframePython: string;
  readonly reframeModelPath: string;
  readonly reframeSampleFps: number;
  readonly reframeSceneThreshold: number;
  readonly autoLayoutBatchSize: number;
  readonly autoLayoutLeaseMs: number;
  readonly autoLayoutFailureBackoffMs: number;
  readonly pipMotionThreshold: number;
  readonly brollAssetCacheTtlMs: number;
  readonly pexelsConfigured: boolean;
  /** Encode deadline = clamp(realtime factor x edited duration x resolution x
   *  HDR weight, floor, renderCommandTimeoutMs). */
  readonly renderDeadlineFloorMs: number;
  readonly renderDeadlineRealtimeFactor: number;
  /** Size-aware transfer deadline = clamp(30s + bytes / minBytesPerSec, floor, ceiling),
   *  plus a no-progress bound for downloads. */
  readonly transferDeadlineFloorMs: number;
  readonly transferDeadlineCeilingMs: number;
  readonly transferMinBytesPerSec: number;
  readonly transferNoProgressMs: number;
  /** Finished outputs waiting for an upload slot, per replica. */
  readonly uploadMaxWaitingJobs: number;
  readonly uploadMaxWaitingBytes: number;
  /** Free space must stay above max(diskMinFreeBytes, fraction x volume) plus reservations. */
  readonly diskMinFreeBytes: number;
  readonly diskMinFreeFraction: number;
  /** Worker-managed scratch is bounded by min(scratchMaxBytes, fraction x volume). */
  readonly scratchMaxBytes: number;
  readonly scratchMaxVolumeFraction: number;
  /** How long admission waits (with backoff) for space before deferring the attempt. */
  readonly diskAdmissionWaitMs: number;
  readonly brollCacheMaxBytes: number;
  /** An unowned scratch folder is swept after max lease + this grace. */
  readonly scratchSweepGraceMs: number;
  readonly scratchSweepIntervalMs: number;
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

function boundedInteger(environment: RenderEnvironment, name: string, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const raw = environment[name]?.trim();
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boundedFraction(environment: RenderEnvironment, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = environment[name]?.trim();
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
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

  const pipMotionThreshold = positiveNumber(
    environment,
    "WORKER_PIP_MOTION_THRESHOLD",
    0.12,
  );
  if (pipMotionThreshold > 1) {
    throw new Error("WORKER_PIP_MOTION_THRESHOLD must be at most 1");
  }

  const brollAssetCacheTtlMs =
    positiveNumber(environment, "BROLL_ASSET_CACHE_TTL_HOURS", 24) *
    60 *
    60 *
    1000;
  const compositionCommandMaxBytes = positiveNumber(
    environment,
    "WORKER_COMPOSITION_MAX_COMMAND_BYTES",
    512 * 1024,
  );
  if (!Number.isInteger(compositionCommandMaxBytes)) {
    throw new Error("WORKER_COMPOSITION_MAX_COMMAND_BYTES must be an integer");
  }

  const renderCommandTimeoutMs = positiveNumber(
    environment,
    "WORKER_RENDER_FFMPEG_TIMEOUT_MS",
    30 * 60 * 1000,
  );
  const renderDeadlineFloorMs = boundedInteger(environment, "WORKER_RENDER_DEADLINE_FLOOR_MS", Math.max(1, Math.min(300_000, Math.floor(renderCommandTimeoutMs))), 1);
  if (renderDeadlineFloorMs > renderCommandTimeoutMs) {
    throw new Error("WORKER_RENDER_DEADLINE_FLOOR_MS must not exceed WORKER_RENDER_FFMPEG_TIMEOUT_MS");
  }
  const transferDeadlineFloorMs = boundedInteger(environment, "WORKER_TRANSFER_DEADLINE_FLOOR_MS", 120_000, 1_000);
  const transferDeadlineCeilingMs = boundedInteger(environment, "WORKER_TRANSFER_DEADLINE_CEILING_MS", 1_800_000, 1_000);
  if (transferDeadlineFloorMs > transferDeadlineCeilingMs) {
    throw new Error("WORKER_TRANSFER_DEADLINE_FLOOR_MS must not exceed WORKER_TRANSFER_DEADLINE_CEILING_MS");
  }

  return Object.freeze({
    sourceMode,
    uploadConcurrency,
    x264Preset,
    x264Crf,
    renderCommandTimeoutMs,
    renderDeadlineFloorMs,
    renderDeadlineRealtimeFactor: boundedFraction(environment, "WORKER_RENDER_DEADLINE_FACTOR", 20, 1, 1_000),
    transferDeadlineFloorMs,
    transferDeadlineCeilingMs,
    transferMinBytesPerSec: boundedInteger(environment, "WORKER_TRANSFER_MIN_BYTES_PER_SEC", 1024 * 1024, 1_024),
    transferNoProgressMs: boundedInteger(environment, "WORKER_TRANSFER_NO_PROGRESS_MS", 30_000, 1_000),
    uploadMaxWaitingJobs: boundedInteger(environment, "WORKER_UPLOAD_MAX_WAITING_JOBS", 2, 1, 16),
    uploadMaxWaitingBytes: boundedInteger(environment, "WORKER_UPLOAD_MAX_WAITING_BYTES", 512 * 1024 ** 2, 1_048_576),
    diskMinFreeBytes: boundedInteger(environment, "WORKER_DISK_MIN_FREE_BYTES", 1024 ** 3, 0),
    diskMinFreeFraction: boundedFraction(environment, "WORKER_DISK_MIN_FREE_FRACTION", 0.1, 0, 0.9),
    scratchMaxBytes: boundedInteger(environment, "WORKER_SCRATCH_MAX_BYTES", 8 * 1024 ** 3, 1_048_576),
    scratchMaxVolumeFraction: boundedFraction(environment, "WORKER_SCRATCH_MAX_VOLUME_FRACTION", 0.5, 0.05, 1),
    diskAdmissionWaitMs: boundedInteger(environment, "WORKER_DISK_ADMISSION_WAIT_MS", 5 * 60 * 1000, 0, 60 * 60 * 1000),
    brollCacheMaxBytes: boundedInteger(environment, "BROLL_ASSET_CACHE_MAX_BYTES", 1024 ** 3, 1_048_576),
    scratchSweepGraceMs: boundedInteger(environment, "WORKER_SCRATCH_SWEEP_GRACE_MS", 10 * 60 * 1000, 0),
    scratchSweepIntervalMs: boundedInteger(environment, "WORKER_SCRATCH_SWEEP_INTERVAL_MS", 10 * 60 * 1000, 10_000),
    probeCommandTimeoutMs: positiveNumber(
      environment,
      "WORKER_PROBE_TIMEOUT_MS",
      2 * 60 * 1000,
    ),
    compositionCommandMaxBytes,
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
    autoLayoutBatchSize: boundedInteger(environment, "WORKER_AUTO_LAYOUT_BATCH_SIZE", 2, 1, 10),
    autoLayoutLeaseMs: boundedInteger(environment, "WORKER_AUTO_LAYOUT_LEASE_MS", 180_000, 30_000, 900_000),
    autoLayoutFailureBackoffMs: boundedInteger(environment, "WORKER_AUTO_LAYOUT_FAILURE_BACKOFF_MS", 300_000, 0),
    pipMotionThreshold,
    brollAssetCacheTtlMs,
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
