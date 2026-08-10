import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clipService,
  downloadObjectToFile,
  type ClipPendingAutoLayoutAnalysis,
} from "@narriflow/services";
import {
  clipAutoLayoutAnalysisSchema,
  sourceToEdited,
  type ClipAutoLayoutAnalysis,
} from "@narriflow/validators";
import { buildClipCutPlan, type ClipCutPlan } from "./cut-plan";
import {
  buildAutoLayoutPlan,
  speechWordsFromUtterances,
} from "./layout-engine";
import {
  remapMultiFaceSamplesForCutPlan,
  type MultiFaceSample,
} from "./two-up";

const DEFAULT_BATCH_SIZE = 2;
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_KILL_GRACE_MS = 5_000;
const FAILURE_BACKOFF_MS = 5 * 60_000;

function log(
  level: "info" | "warn" | "error",
  message: string,
  context?: Record<string, unknown>,
) {
  console.warn(
    JSON.stringify({ level, message, ts: new Date().toISOString(), ...context }),
  );
}

function batchSize(): number {
  const value = Number(process.env.WORKER_AUTO_LAYOUT_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  return Number.isFinite(value) && value > 0 ? Math.min(10, Math.floor(value)) : DEFAULT_BATCH_SIZE;
}

function leaseMs(): number {
  const value = Number(process.env.WORKER_AUTO_LAYOUT_LEASE_MS ?? 180_000);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 180_000;
}

function failureBackoffMs(): number {
  const value = Number(
    process.env.WORKER_AUTO_LAYOUT_FAILURE_BACKOFF_MS ?? FAILURE_BACKOFF_MS,
  );
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : FAILURE_BACKOFF_MS;
}

function runOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), COMMAND_KILL_GRACE_MS);
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${COMMAND_TIMEOUT_MS}ms`));
      } else if (code !== 0) {
        reject(new Error(`${command} failed with code ${code}: ${stderr.slice(-500)}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function probeVideo(path: string): Promise<{
  hasVideo: boolean;
  width: number;
  height: number;
}> {
  const output = await runOutput("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,disposition",
    "-of",
    "json",
    path,
  ]);
  const parsed = JSON.parse(output) as {
    streams?: Array<{
      width?: number;
      height?: number;
      disposition?: { attached_pic?: number };
    }>;
  };
  const stream = parsed.streams?.find(
    (candidate) => candidate.disposition?.attached_pic !== 1,
  );
  return {
    hasVideo: Boolean(stream && (stream.width ?? 0) > 0 && (stream.height ?? 0) > 0),
    width: stream?.width ?? 1,
    height: stream?.height ?? 1,
  };
}

async function detectFaces(params: {
  path: string;
  startSec: number;
  durationSec: number;
}): Promise<MultiFaceSample[]> {
  const scriptPath = fileURLToPath(
    new URL("../../scripts/reframe_detect.py", import.meta.url),
  );
  const python = process.env.REFRAME_PYTHON ?? "python3";
  const model =
    process.env.REFRAME_MODEL_PATH ??
    "/usr/local/share/narriflow/face_yunet.onnx";
  const fps = process.env.REFRAME_SAMPLE_FPS ?? "4";
  const output = await runOutput(
    python,
    buildMultiFaceDetectorArgs({
      scriptPath,
      path: params.path,
      startSec: params.startSec,
      durationSec: params.durationSec,
      fps,
      modelPath: model,
    }),
  );
  const parsed = JSON.parse(output) as {
    error?: string;
    samples?: MultiFaceSample[];
  };
  if (parsed.error) throw new Error(parsed.error);
  if (!Array.isArray(parsed.samples)) throw new Error("malformed face detector output");
  return parsed.samples;
}

/** Kept pure/exported so the Python process boundary cannot silently drift.
 *  reframe_detect.py's positional contract is video,start,duration,fps,model. */
export function buildMultiFaceDetectorArgs(params: {
  scriptPath: string;
  path: string;
  startSec: number;
  durationSec: number;
  fps: string;
  modelPath: string;
}): string[] {
  return [
    params.scriptPath,
    params.path,
    String(params.startSec),
    String(params.durationSec),
    params.fps,
    params.modelPath,
    "--multi",
  ];
}

async function detectSceneCuts(params: {
  path: string;
  startSec: number;
  durationSec: number;
}): Promise<number[]> {
  const threshold = process.env.REFRAME_SCENE_THRESHOLD ?? "0.3";
  const output = await runOutput("ffmpeg", [
    "-hide_banner",
    "-nostats",
    ...(params.startSec > 0 ? ["-ss", String(params.startSec)] : []),
    "-t",
    String(params.durationSec),
    "-i",
    params.path,
    "-vf",
    `select='gt(scene,${threshold})',metadata=print:file=-`,
    "-an",
    "-f",
    "null",
    "-",
  ]);
  return [...output.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)].map(
    (match) => Number(match[1]),
  );
}

function remapSceneCuts(
  cuts: number[],
  cutPlan: ClipCutPlan,
  clipStartSec: number,
): number[] {
  if (cutPlan.isUncut) {
    return [...new Set(cuts.map((time) => Math.round(time * 1000) / 1000))].sort(
      (a, b) => a - b,
    );
  }
  const output: number[] = [];
  for (const cut of cuts) {
    const sourceSec = clipStartSec + cut;
    const kept = cutPlan.segments.some(
      (segment) =>
        sourceSec >= segment.sourceStartSec &&
        sourceSec <= segment.sourceEndSec,
    );
    if (kept) output.push(sourceToEdited(cutPlan.map, sourceSec));
  }
  for (const segment of cutPlan.segments.slice(1)) {
    output.push(segment.editedStartSec);
  }
  return [...new Set(output.map((time) => Math.round(time * 1000) / 1000))].sort(
    (a, b) => a - b,
  );
}

export async function analyzeClipAutoLayout(params: {
  clip: ClipPendingAutoLayoutAnalysis;
  previewPath: string;
}): Promise<ClipAutoLayoutAnalysis> {
  const { clip, previewPath } = params;
  const probe = await probeVideo(previewPath);
  const rawDurationSec = clip.endSec - clip.startSec;
  const cutPlan = buildClipCutPlan(clip.deletedRanges, {
    startSec: clip.startSec,
    endSec: clip.endSec,
  });
  const editedDurationSec = cutPlan.isUncut
    ? rawDurationSec
    : cutPlan.editedDurationSec;
  if (cutPlan.isEmpty || editedDurationSec <= 0) {
    throw new Error("clip has no renderable duration");
  }

  let fullPlan = buildAutoLayoutPlan({
    samples: [],
    sceneCuts: [],
    words: [],
    durationSec: editedDurationSec,
    allowTwoUp: true,
  });
  let noSplitPlan = buildAutoLayoutPlan({
    samples: [],
    sceneCuts: [],
    words: [],
    durationSec: editedDurationSec,
    allowTwoUp: false,
  });

  if (probe.hasVideo) {
    const previewOffsetSec = Math.max(0, clip.startSec - clip.previewStartSec);
    const availableDurationSec = Math.max(
      0,
      clip.previewDurationSec - previewOffsetSec,
    );
    const detectionDurationSec = Math.min(rawDurationSec, availableDurationSec);
    if (detectionDurationSec <= 0) {
      throw new Error("preview proxy does not cover clip window");
    }
    const [samples, sceneCuts] = await Promise.all([
      detectFaces({
        path: previewPath,
        startSec: previewOffsetSec,
        durationSec: detectionDurationSec,
      }),
      detectSceneCuts({
        path: previewPath,
        startSec: previewOffsetSec,
        durationSec: detectionDurationSec,
      }).catch((error) => {
        log("warn", "clip_auto_layout_scene_detection_failed", {
          clipId: clip.id,
          message: error instanceof Error ? error.message : "unknown",
        });
        return [];
      }),
    ]);
    const remappedSamples = remapMultiFaceSamplesForCutPlan(
      samples,
      cutPlan,
      clip.startSec,
    );
    const remappedCuts = remapSceneCuts(sceneCuts, cutPlan, clip.startSec);
    const words = speechWordsFromUtterances(
      clip.transcriptSlice,
      cutPlan,
      clip.startSec,
      clip.endSec,
    );
    const options = {
      frameOptions: {
        maxZoom: probe.height >= 720 ? 1.4 : 1.25,
      },
      activeSpeakerCuts: false,
    } as const;
    fullPlan = buildAutoLayoutPlan({
      samples: remappedSamples,
      sceneCuts: remappedCuts,
      words,
      durationSec: editedDurationSec,
      allowTwoUp: true,
      options,
    });
    noSplitPlan = buildAutoLayoutPlan({
      samples: remappedSamples,
      sceneCuts: remappedCuts,
      words,
      durationSec: editedDurationSec,
      allowTwoUp: false,
      options,
    });
  }

  return clipAutoLayoutAnalysisSchema.parse({
    version: 1,
    engine: "shot-layout-v1",
    analyzedAtISO: new Date().toISOString(),
    clipStartSec: clip.startSec,
    clipEndSec: clip.endSec,
    deletedRanges: clip.deletedRanges,
    editedDurationSec,
    sourceWidth: probe.width,
    sourceHeight: probe.height,
    segments: fullPlan.segments,
    noSplitSegments: noSplitPlan.segments,
    shotCount: fullPlan.shotCount,
    soloShotCount: fullPlan.soloShotCount,
    multiShotCount: fullPlan.multiShotCount,
    twoUpSegmentCount: fullPlan.twoUpSegmentCount,
    speakerCount: fullPlan.speakerCount,
    mappedSpeakerCount: fullPlan.mappedSpeakerCount,
  });
}

export async function processPendingAutoLayoutAnalyses(
  limit = batchSize(),
): Promise<number> {
  if (process.env.WORKER_AUTO_LAYOUT_ANALYSIS === "0") return 0;
  let completed = 0;

  // Claim immediately before each sequential analysis. Pre-claiming a whole
  // batch would let later leases expire while the first clip is still being
  // processed, inviting another replica to duplicate the expensive work.
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const clip = await clipService.claimNextClipForAutoLayoutAnalysis(leaseMs());
    if (!clip) break;
    const tempDir = await mkdtemp(join(tmpdir(), "narriflow-auto-layout-"));
    const previewPath = join(tempDir, "preview.mp4");
    try {
      await downloadObjectToFile({
        key: clip.previewStorageKey,
        filePath: previewPath,
      });
      const analysis = await analyzeClipAutoLayout({ clip, previewPath });
      const persisted = await clipService.completeClaimedClipAutoLayoutAnalysis(
        clip.id,
        analysis,
        {
          editorRevision: clip.editorRevision,
          previewStorageKey: clip.previewStorageKey,
          claimToken: clip.autoLayoutClaimToken,
        },
      );
      if (persisted) {
        completed += 1;
        log("info", "clip_auto_layout_analysis_completed", {
          clipId: clip.id,
          projectId: clip.projectId,
          segmentCount: analysis.segments.length,
          twoUpSegmentCount: analysis.twoUpSegmentCount,
          shotCount: analysis.shotCount,
          mappedSpeakerCount: analysis.mappedSpeakerCount,
        });
      } else {
        // Usually means an editor mutation invalidated this attempt or a
        // foreground render published the same plan first. This token-scoped
        // release is a no-op if either path already cleared/replaced it.
        await clipService.deferClaimedClipAutoLayoutAnalysis(
          clip.id,
          clip.autoLayoutClaimToken,
          new Date(),
        );
      }
    } catch (error) {
      await clipService
        .deferClaimedClipAutoLayoutAnalysis(
          clip.id,
          clip.autoLayoutClaimToken,
          new Date(Date.now() + failureBackoffMs()),
        )
        .catch((deferError) => {
          log("error", "clip_auto_layout_analysis_defer_failed", {
            clipId: clip.id,
            projectId: clip.projectId,
            message:
              deferError instanceof Error ? deferError.message : "unknown",
          });
        });
      log("error", "clip_auto_layout_analysis_failed", {
        clipId: clip.id,
        projectId: clip.projectId,
        message: error instanceof Error ? error.message : "unknown",
        python: process.env.REFRAME_PYTHON ?? "python3",
        modelPath:
          process.env.REFRAME_MODEL_PATH ??
          "/usr/local/share/narriflow/face_yunet.onnx",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
  return completed;
}
