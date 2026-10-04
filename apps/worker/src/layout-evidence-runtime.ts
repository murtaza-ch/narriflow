import { fileURLToPath } from "node:url";
import type { RenderConfig } from "./render-config";
import type { WorkerProcessModule } from "./worker-process";
import type { LayoutEvidenceDetectors } from "./layout-evidence";
import type { FaceSample } from "./tasks/reframe";
import type { MultiFaceSample } from "./tasks/two-up";
import type { PipCandidate } from "./tasks/screen-layout";

/** Process IO is shared by background and foreground layout evidence. */
export function createLayoutEvidenceDetectors(input: {
  workerProcess: WorkerProcessModule;
  config: Readonly<RenderConfig>;
  signal: AbortSignal;
  rethrowControl?: (error: unknown) => void;
}): LayoutEvidenceDetectors {
  const { workerProcess, config, signal } = input;
  const rethrowControl = (error: unknown): void => {
    signal.throwIfAborted();
    input.rethrowControl?.(error);
  };
  const log = (level: string, message: string, context?: Record<string, unknown>): void => {
    console.warn(JSON.stringify({ level, message, ...context }));
  };
  const execCommandOutput = async (command: string, args: string[]): Promise<string> => {
    signal.throwIfAborted();
    const result = await workerProcess.execute({ command, args, signal, deadlineMs: config.probeCommandTimeoutMs, captureStdout: true });
    signal.throwIfAborted();
    return result.stdout.toString("utf8");
  };
function logDetectionFailure(
  detector: string,
  failureCode: string,
  context?: Record<string, unknown>,
): void {
  log("error", "clip_face_detection_unavailable", {
    detector,
    phase: "media_analysis",
    analysisMode: detector,
    fallbackMode: "center_crop",
    failureCode,
    disposition: "degraded",
    durationMs: 0,
    ...context,
  });
}

function mediaAnalysisFailureCode(error: unknown): string {
  const code =
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "";
  if (code === "worker_command_missing") return "analysis_executable_missing";
  if (code === "worker_command_timeout") return "analysis_timeout";
  if (code === "worker_command_failed" || code === "worker_command_spawn_failed") {
    return "analysis_command_failed";
  }
  return "analysis_unavailable";
}

/**
 * Runs the YuNet Python face detector over a clip's range and returns the
 * per-sample normalized face centers, or null if detection is unavailable
 * (no python/opencv/model, or no faces) — callers fall back to a static crop.
 */
async function detectFacePath(params: {
  sourcePath: string;
  startSec: number;
  durationSec: number;
  logContext?: Record<string, unknown>;
}): Promise<{ samples: FaceSample[] } | null> {
  const scriptPath = fileURLToPath(
    new URL("../scripts/reframe_detect.py", import.meta.url),
  );
  const modelPath = config.reframeModelPath;
  const fps = String(config.reframeSampleFps);

  try {
    const out = await execCommandOutput(config.reframePython, [
      scriptPath,
      params.sourcePath,
      String(params.startSec),
      String(params.durationSec),
      fps,
      modelPath,
    ]);
    const parsed = JSON.parse(out) as {
      samples?: Array<{ t: number; cx: number | null }>;
      error?: string;
    };
    if (parsed.error || !Array.isArray(parsed.samples)) {
      logDetectionFailure(
        "face_single",
        "analysis_output_invalid",
        params.logContext,
      );
      return null;
    }
    return { samples: parsed.samples };
  } catch (error) {
    rethrowControl(error);
    logDetectionFailure(
      "face_single",
      mediaAnalysisFailureCode(error),
      params.logContext,
    );
    return null;
  }
}

/** `detectPipPath`'s success result — `movingPxFrac: null` iff
 *  `insufficientSamples` is true (M4/L4, adversarial review: `pip_detect.py`
 *  emits this when too few samples were taken, or the samples taken covered
 *  too little of the requested window, rather than a misleadingly-precise
 *  `0.0` that would read as "definitely screencast-like"). */
interface PipDetectResult {
  movingPxFrac: number | null;
  insufficientSamples: boolean;
  candidates: PipCandidate[];
}

/**
 * Element segmentation v1 ("screen" framing mode, vizard-parity.md's
 * element-segmentation spike): runs `pip_detect.py` over a clip's range and
 * returns the raw motion signal (`movingPxFrac`) + candidate facecam PiP
 * regions, or null if detection is unavailable (no python/opencv/numpy, or
 * the script itself errored) — same null-on-failure contract as
 * `detectFacePath`, callers fall back to the existing whole-frame face-
 * tracked/static-center bottom tile. Classification (`classifyScreencast`)
 * and selection (`selectPipRect`) are deliberately NOT done here — this
 * function is pure IO, screen-layout.ts owns the policy.
 */
async function detectPipPath(params: {
  sourcePath: string;
  startSec: number;
  durationSec: number;
}): Promise<PipDetectResult | null> {
  const scriptPath = fileURLToPath(
    new URL("../scripts/pip_detect.py", import.meta.url),
  );

  try {
    const out = await execCommandOutput(config.reframePython, [
      scriptPath,
      params.sourcePath,
      String(params.startSec),
      String(params.durationSec),
    ]);
    const parsed = JSON.parse(out) as {
      movingPxFrac?: number | null;
      insufficientSamples?: boolean;
      candidates?: PipCandidate[];
      error?: string;
    };
    if (
      parsed.error ||
      !Array.isArray(parsed.candidates) ||
      (parsed.movingPxFrac !== null &&
        parsed.movingPxFrac !== undefined &&
        typeof parsed.movingPxFrac !== "number")
    ) {
      logDetectionFailure("pip", "analysis_output_invalid");
      return null;
    }
    return {
      movingPxFrac: parsed.movingPxFrac ?? null,
      insufficientSamples: Boolean(parsed.insufficientSamples),
      candidates: parsed.candidates,
    };
  } catch (error) {
    rethrowControl(error);
    logDetectionFailure("pip", mediaAnalysisFailureCode(error));
    return null;
  }
}

/**
 * Multi-face sibling of `detectFacePath` (split packet B, vizard-parity.md
 * "Split-screen 2-up") — runs the same YuNet detector script in `--multi`
 * mode (see `reframe_detect.py`'s doc comment) so every sample carries ALL
 * detected faces (not just the dominant one), the raw input
 * `buildSplitLayoutPlan`'s clustering/shot-classification pipeline needs.
 * Same env/model/fps handling, same null-on-failure/no-model/no-python
 * contract as `detectFacePath` — callers fall back to single-speaker framing.
 */
async function detectMultiFacePath(params: {
  sourcePath: string;
  startSec: number;
  durationSec: number;
  logContext?: Record<string, unknown>;
}): Promise<{ samples: MultiFaceSample[] } | null> {
  const scriptPath = fileURLToPath(
    new URL("../scripts/reframe_detect.py", import.meta.url),
  );
  const modelPath = config.reframeModelPath;
  const fps = String(config.reframeSampleFps);

  try {
    const out = await execCommandOutput(config.reframePython, [
      scriptPath,
      params.sourcePath,
      String(params.startSec),
      String(params.durationSec),
      fps,
      modelPath,
      "--multi",
    ]);
    const parsed = JSON.parse(out) as {
      samples?: Array<{
        t: number;
        faces?: Array<{
          cx: number;
          cy: number;
          w: number;
          h: number;
          score: number;
          m?: number | null;
          fm?: number | null;
        }>;
      }>;
      error?: string;
    };
    if (parsed.error || !Array.isArray(parsed.samples)) {
      logDetectionFailure(
        "face_multi",
        "analysis_output_invalid",
        params.logContext,
      );
      return null;
    }
    return {
      samples: parsed.samples.map((s) => ({ t: s.t, faces: s.faces ?? [] })),
    };
  } catch (error) {
    rethrowControl(error);
    logDetectionFailure(
      "face_multi",
      mediaAnalysisFailureCode(error),
      params.logContext,
    );
    return null;
  }
}

/**
 * Scene-cut detection (layout-engine wiring): runs ffmpeg's scene-change
 * `select` filter over the SAME low-res local segment face detection uses
 * and returns clip-relative cut times in seconds. Best-effort: any failure
 * returns [] (the layout engine then treats the clip as one shot) — never
 * blocks a render. `-ss` before `-i` is frame-accurate here (default
 * accurate_seek decodes from the prior keyframe and discards preroll) and
 * resets output timestamps to ~0, which is exactly the clip-relative
 * timebase the detector samples use.
 */
async function detectSceneCuts(params: {
  sourcePath: string;
  startSec: number;
  durationSec: number;
  workflowRunId?: string;
  clipId?: string;
}): Promise<number[]> {
  const threshold = String(config.reframeSceneThreshold);
  try {
    const out = await execCommandOutput("ffmpeg", [
      "-hide_banner",
      "-nostats",
      ...(params.startSec > 0 ? ["-ss", String(params.startSec)] : []),
      "-t",
      String(params.durationSec),
      "-i",
      params.sourcePath,
      "-vf",
      `select='gt(scene,${threshold})',metadata=print:file=-`,
      "-an",
      "-f",
      "null",
      "-",
    ]);
    const cuts: number[] = [];
    for (const match of out.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)) {
      cuts.push(Number(match[1]));
    }
    return cuts;
  } catch (error) {
    rethrowControl(error);
    log("error", "clip_scene_detect_failed", {
      workflowRunId: params.workflowRunId,
      clipId: params.clipId,
      failureCode: "analysis_unavailable",
    });
    return [];
  }
}


  return { detectFacePath, detectMultiFacePath, detectPipPath, detectSceneCuts };
}
