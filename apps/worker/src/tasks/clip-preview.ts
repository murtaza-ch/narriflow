/**
 * Generates lightweight preview proxies for clips so the studio and the
 * project-page clip cards never have to stream the full (multi-hundred-MB
 * to multi-GB) source just to preview a few seconds of footage. Each proxy
 * is a small, 540p, faststart MP4 covering a clip's range plus a little
 * padding on each side, cut directly from the source with a fast input
 * seek.
 *
 * This deliberately *polls for clips missing a proxy* rather than being
 * triggered from detect-clips.ts, so it also backfills every pre-existing
 * clip and stays fully decoupled from the moment_detection/clip_rendering
 * workflow-run machinery — a proxy is either present or it isn't, there's
 * no "run" to track.
 *
 * See apps/worker/src/tasks/render-clips.ts / broll.ts for the house style
 * this mirrors (structured logs, small env-overridable encode knobs,
 * `-ss` before `-i` for a fast seek, per-item try/catch so one bad clip
 * never fails the batch).
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
  clipService,
  deleteObject,
  downloadObjectToFile,
  putFileFromPath,
} from "@narriflow/services";

type ClipPendingPreview = Awaited<
  ReturnType<typeof clipService.getClipsNeedingPreview>
>[number];

class ClipPreviewWorkerError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function log(
  level: "info" | "warn" | "error",
  message: string,
  context?: Record<string, unknown>,
) {
  // Structured logs per CLAUDE.md: console.warn(JSON.stringify({level,message,...ctx})).
  console.warn(
    JSON.stringify({
      level,
      message,
      ts: new Date().toISOString(),
      ...context,
    }),
  );
}

// ─── Env-overridable encode knobs ──────────────────────────────────────────
// Small, cheap-to-tune constants (mirrors render-clips.ts's WORKER_X264_*
// pattern) — kept local to this file since render-clips.ts's own helpers
// aren't exported and its own knobs target the full-quality render, not a
// throwaway preview.

const DEFAULT_PREVIEW_BATCH_SIZE = 5;
const DEFAULT_PREVIEW_PADDING_SEC = 4;
const DEFAULT_PREVIEW_MAX_HEIGHT = 540;
const DEFAULT_PREVIEW_X264_PRESET = "veryfast";
// CRF 30 at 540p measured ~1-2MB for a 30s talking-head clip in verification
// (see the worker's clip-preview report) — tune via env without a deploy.
const DEFAULT_PREVIEW_X264_CRF = "30";
const DEFAULT_PREVIEW_AUDIO_BITRATE = "64k";

function previewBatchSize(): number {
  const raw = Number(process.env.WORKER_CLIP_PREVIEW_BATCH_SIZE?.trim());
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_PREVIEW_BATCH_SIZE;
}

function previewPaddingSec(): number {
  const raw = Number(process.env.WORKER_CLIP_PREVIEW_PADDING_SEC?.trim());
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_PREVIEW_PADDING_SEC;
}

function previewMaxHeight(): number {
  const raw = Number(process.env.WORKER_CLIP_PREVIEW_MAX_HEIGHT?.trim());
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_PREVIEW_MAX_HEIGHT;
}

function previewX264Preset(): string {
  return (
    process.env.WORKER_CLIP_PREVIEW_X264_PRESET?.trim() ||
    DEFAULT_PREVIEW_X264_PRESET
  );
}

function previewX264Crf(): string {
  return (
    process.env.WORKER_CLIP_PREVIEW_X264_CRF?.trim() ||
    DEFAULT_PREVIEW_X264_CRF
  );
}

function previewAudioBitrate(): string {
  return (
    process.env.WORKER_CLIP_PREVIEW_AUDIO_BITRATE?.trim() ||
    DEFAULT_PREVIEW_AUDIO_BITRATE
  );
}

// ─── Pure window / time-mapping maths (unit-tested in clip-preview.test.ts) ─

export interface ClipPreviewWindow {
  /** The proxy's t=0, expressed in *source* time — persisted verbatim as
   *  the clip's `previewStartSec`. */
  startSec: number;
  /** The padded window's end, in source time. */
  endSec: number;
  durationSec: number;
}

/**
 * Computes the padded source-time window to cut a clip's preview proxy
 * from: `paddingSec` on each side (so small trim tweaks in the studio don't
 * need a re-cut), clamped to `[0, sourceDurationSec]`. When the source
 * duration isn't known, only the lower bound is clamped — ffmpeg's `-t`
 * naturally truncates at end-of-file, so a loose upper bound can't overrun
 * into anything that doesn't exist.
 */
export function computeClipPreviewWindow(
  clipStartSec: number,
  clipEndSec: number,
  sourceDurationSec: number | null,
  paddingSec: number = previewPaddingSec(),
): ClipPreviewWindow {
  const rawStart = clipStartSec - paddingSec;
  const rawEnd = clipEndSec + paddingSec;

  const startSec = Math.max(0, rawStart);
  const cappedEnd =
    sourceDurationSec !== null && sourceDurationSec > 0
      ? Math.min(rawEnd, sourceDurationSec)
      : rawEnd;
  // Never invert: a malformed/zero-length input clamps to a zero-duration
  // window rather than a negative one — callers treat durationSec <= 0 as
  // "skip this clip".
  const endSec = Math.max(startSec, cappedEnd);

  return {
    startSec: Number(startSec.toFixed(3)),
    endSec: Number(endSec.toFixed(3)),
    durationSec: Number((endSec - startSec).toFixed(3)),
  };
}

/**
 * Maps a source-time instant onto the preview proxy's own timeline. This is
 * the exact calculation the studio must mirror when it plays the proxy
 * instead of the source — an off-by-`previewStartSec` error here silently
 * desyncs every caption.
 */
export function sourceTimeToPreviewTime(
  sourceTimeSec: number,
  previewStartSec: number,
): number {
  return sourceTimeSec - previewStartSec;
}

/** Inverse of {@link sourceTimeToPreviewTime}. */
export function previewTimeToSourceTime(
  previewTimeSec: number,
  previewStartSec: number,
): number {
  return previewTimeSec + previewStartSec;
}

/** Mirrors how render outputs are keyed (`projects/<id>/renders/<clipId>/...`
 *  in render-clips.ts) under a clearly-separate `previews` namespace. */
export function clipPreviewStorageKey(projectId: string, clipId: string): string {
  return `projects/${projectId}/previews/${clipId}/preview.mp4`;
}

// ─── ffmpeg/ffprobe process helpers ────────────────────────────────────────
// Duplicated in shape from render-clips.ts's private execCommand/
// execCommandOutput (not exported there) — see the file header.

async function execCommand(command: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new ClipPreviewWorkerError(
            "worker_command_missing",
            `${command} is not installed`,
          ),
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new ClipPreviewWorkerError(
          "worker_command_failed",
          `${command} failed with code ${code}: ${stderr.slice(-500)}`,
        ),
      );
    });
  });
}

async function execCommandOutput(
  command: string,
  args: string[],
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new ClipPreviewWorkerError(
            "worker_command_missing",
            `${command} is not installed`,
          ),
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new ClipPreviewWorkerError(
          "worker_command_failed",
          `${command} failed with code ${code}: ${stderr.slice(-500)}`,
        ),
      );
    });
  });
}

interface SourceProbeLite {
  hasVideo: boolean;
  hasAudio: boolean;
}

async function probeSourceLite(sourcePath: string): Promise<SourceProbeLite> {
  const output = await execCommandOutput("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_streams",
    sourcePath,
  ]);
  const data = JSON.parse(output) as {
    streams?: Array<{ codec_type?: string }>;
  };
  const streams = data.streams ?? [];
  return {
    hasVideo: streams.some((stream) => stream.codec_type === "video"),
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
  };
}

/**
 * Builds the ffmpeg args for one preview cut: fast input seek (`-ss` before
 * `-i` — measured at 6.91s vs 94.29s for the naive `-ss` after `-i` form
 * elsewhere in this codebase; do not reorder), scaled to `maxHeight`,
 * H.264 + faststart, mono AAC audio when the source has any.
 */
export function buildClipPreviewArgs(params: {
  sourcePath: string;
  outputPath: string;
  windowStartSec: number;
  windowDurationSec: number;
  hasAudio: boolean;
  maxHeight?: number;
  x264Preset?: string;
  x264Crf?: string;
  audioBitrate?: string;
}): string[] {
  const maxHeight = params.maxHeight ?? previewMaxHeight();

  const args = [
    "-y",
    "-ss",
    String(params.windowStartSec),
    "-t",
    String(params.windowDurationSec),
    "-i",
    params.sourcePath,
    "-vf",
    `scale=-2:${maxHeight}`,
    "-map",
    "0:v:0",
    "-c:v",
    "libx264",
    "-preset",
    params.x264Preset ?? previewX264Preset(),
    "-crf",
    params.x264Crf ?? previewX264Crf(),
    "-pix_fmt",
    "yuv420p",
  ];

  if (params.hasAudio) {
    args.push(
      "-map",
      "0:a:0",
      "-c:a",
      "aac",
      "-ac",
      "1",
      "-b:a",
      params.audioBitrate ?? previewAudioBitrate(),
    );
  } else {
    args.push("-an");
  }

  // Explicit output-duration bound (belt-and-suspenders, matches
  // render-clips.ts's own convention) — whatever the input read did, the
  // encoded output can never exceed the requested window.
  args.push(
    "-t",
    params.windowDurationSec.toFixed(3),
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "1024",
    params.outputPath,
  );

  return args;
}

// ─── Orchestration ──────────────────────────────────────────────────────────

async function cutAndUploadClipPreview(params: {
  clip: ClipPendingPreview;
  sourcePath: string;
  tempDir: string;
}): Promise<boolean> {
  const { clip, sourcePath, tempDir } = params;

  const window = computeClipPreviewWindow(
    clip.startSec,
    clip.endSec,
    clip.sourceDurationSec,
  );

  if (window.durationSec <= 0) {
    log("error", "clip_preview_invalid_window", {
      clipId: clip.id,
      projectId: clip.projectId,
      startSec: clip.startSec,
      endSec: clip.endSec,
    });
    return false;
  }

  const probe = await probeSourceLite(sourcePath);
  if (!probe.hasVideo) {
    // Audio-only sources (podcasts) get an "audiogram" treatment at render
    // time (see render-clips.ts's buildAudiogramArgs); replicating that
    // waveform-on-solid-background pipeline for a throwaway proxy is out of
    // scope here, so these are deliberately skipped rather than half-done.
    log("warn", "clip_preview_skipped_no_video_stream", {
      clipId: clip.id,
      projectId: clip.projectId,
    });
    return false;
  }

  const outputPath = join(tempDir, `${clip.id}-preview.mp4`);
  const args = buildClipPreviewArgs({
    sourcePath,
    outputPath,
    windowStartSec: window.startSec,
    windowDurationSec: window.durationSec,
    hasAudio: probe.hasAudio,
  });

  await execCommand("ffmpeg", args);

  const key = clipPreviewStorageKey(clip.projectId, clip.id);
  await putFileFromPath({
    key,
    filePath: outputPath,
    contentType: "video/mp4",
    metadata: {
      project_id: clip.projectId,
      clip_id: clip.id,
      kind: "preview",
    },
  });

  const result = await clipService.completeClipPreview(clip.id, {
    storageKey: key,
    startSec: window.startSec,
    durationSec: window.durationSec,
  });

  if (!result.persisted) {
    // Lost the race to another worker cutting the same clip concurrently —
    // our upload is redundant, not wrong (deterministic key, same bytes
    // modulo encode nondeterminism), so just clean it up.
    await deleteObject(key).catch(() => {});
    log("info", "clip_preview_lost_claim_race", {
      clipId: clip.id,
      projectId: clip.projectId,
    });
    return false;
  }

  log("info", "clip_preview_generated", {
    clipId: clip.id,
    projectId: clip.projectId,
    previewStartSec: window.startSec,
    previewDurationSec: window.durationSec,
  });
  return true;
}

/**
 * Polls for clips missing a preview proxy (highest `viralityScore` first)
 * and cuts one for each, in small batches grouped by project so a
 * multi-hundred-MB source is downloaded at most once per tick no matter how
 * many of that project's clips are due.
 *
 * A clip failing (bad source, ffmpeg error, lost claim race, ...) is logged
 * and skipped — it never fails the batch or aborts processing of the rest.
 *
 * Call signature: `processPendingClipPreviews(batchSize?: number): Promise<number>`
 * — returns how many clips actually got a proxy persisted in this call.
 * Not wired into a poll loop here; apps/worker/src/index.ts owns that.
 */
export async function processPendingClipPreviews(
  batchSize: number = previewBatchSize(),
): Promise<number> {
  const candidates = await clipService.getClipsNeedingPreview(batchSize);
  if (candidates.length === 0) {
    return 0;
  }

  const byProject = new Map<string, ClipPendingPreview[]>();
  for (const clip of candidates) {
    const existing = byProject.get(clip.projectId);
    if (existing) {
      existing.push(clip);
    } else {
      byProject.set(clip.projectId, [clip]);
    }
  }

  let processed = 0;

  for (const [projectId, clips] of byProject) {
    const tempDir = await mkdtemp(join(tmpdir(), "clip-preview-"));

    try {
      const sourceStorageKey = clips[0]!.sourceStorageKey;
      const sourcePath = join(
        tempDir,
        `source${extname(sourceStorageKey) || ".mp4"}`,
      );

      try {
        await downloadObjectToFile({ key: sourceStorageKey, filePath: sourcePath });
      } catch (error) {
        log("error", "clip_preview_source_download_failed", {
          projectId,
          clipCount: clips.length,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        continue;
      }

      for (const clip of clips) {
        try {
          const didPersist = await cutAndUploadClipPreview({
            clip,
            sourcePath,
            tempDir,
          });
          if (didPersist) processed += 1;
        } catch (error) {
          log("error", "clip_preview_failed", {
            clipId: clip.id,
            projectId,
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  return processed;
}
