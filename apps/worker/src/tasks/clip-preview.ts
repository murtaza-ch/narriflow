/**
 * Generates lightweight preview proxies for clips so the studio and the
 * project-page clip cards never have to stream the full (multi-hundred-MB
 * to multi-GB) source just to preview a few seconds of footage. Each proxy
 * is a small, 540p, faststart MP4 covering a clip's range plus a little
 * padding on each side, cut directly from the source with a fast input
 * seek.
 *
 * Audio-only sources (podcast MP3/WAV/M4A — a first-class Narriflow source
 * type, not an edge case) get an "audiogram" proxy instead of no proxy at
 * all: an animated ffmpeg `showwaves` waveform over a solid background,
 * mirroring the treatment render-clips.ts's `buildAudiogramArgs` gives the
 * real render, but capped at 540p with no burned-in captions (the studio
 * overlays captions in HTML at preview time). These clips must never be
 * left with nothing to preview — that's worse than the pre-proxy
 * full-source-streaming behaviour this feature exists to replace. Telling
 * "real video" apart from a podcast MP3's embedded cover-art image (which
 * ffprobe reports as its own video stream) is the load-bearing bit — see
 * `classifyMediaStreams`.
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
import { join } from "node:path";
import {
  clipService,
  deleteObject,
  presignDownloadUrl,
  putFileFromPath,
} from "@narriflow/services";
import { DEFAULT_CAPTION_PRESET } from "@narriflow/validators";
import type { CaptionPreset } from "@narriflow/validators";

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

/** Presign lifetime for the streamed source. Generous enough to cover a whole
 *  batch of cuts off one URL, short enough that a leaked log line is stale fast. */
const SOURCE_STREAM_URL_TTL_SEC = 3600;

/** ffmpeg reads the source over HTTPS rather than from disk, so a transient
 *  network blip mid-cut would otherwise abort the encode. These make it
 *  reconnect instead. Harmless when the input happens to be a local path. */
const HTTP_SOURCE_ARGS = [
  "-reconnect",
  "1",
  "-reconnect_streamed",
  "1",
  "-reconnect_on_network_error",
  "1",
  "-reconnect_delay_max",
  "10",
] as const;

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

/** Result of classifying a source's streams — see {@link classifyMediaStreams}.
 *  `hasVideo` is true only for a *real* (non-cover-art) video stream. */
interface SourceProbeLite {
  hasVideo: boolean;
  hasAudio: boolean;
}

/** The handful of ffprobe `-show_streams` fields this file needs to tell a
 *  real video stream apart from a podcast's embedded cover-art image and
 *  from audio. Deliberately narrower than ffprobe's full stream schema. */
export interface ProbeStreamLite {
  codec_type?: string;
  nb_frames?: string;
  disposition?: { attached_pic?: number };
}

/**
 * A podcast MP3/M4A/FLAC's embedded cover art (ID3 `APIC`, FLAC/M4A cover
 * picture blocks, ...) shows up to ffprobe as its own *video* stream —
 * almost always flagged `disposition.attached_pic = 1` and/or reporting
 * exactly one total frame. Naively treating that stream as "this source has
 * video" routes a podcast through the video cut-and-scale path, which
 * produces a proxy that's a single frozen JPEG for the whole clip duration
 * (there's nothing moving to encode). This tells the two apart.
 */
export function isAttachedPictureStream(stream: ProbeStreamLite): boolean {
  if (stream.codec_type !== "video") return false;
  if (stream.disposition?.attached_pic === 1) return true;
  // Fallback for muxers/tagging tools that embed cover art without setting
  // the disposition flag: a "video" stream reporting 0 or 1 total frames is
  // never a moving picture, only ever a single embedded still.
  const frameCount = Number(stream.nb_frames);
  return Number.isFinite(frameCount) && frameCount <= 1;
}

/**
 * Classifies a probed source's streams into "has real playable video" (at
 * least one video stream that isn't just embedded cover art) and "has
 * audio". A source with both a genuine video stream and a separate
 * attached-picture stream (e.g. a video file carrying an embedded
 * thumbnail) still counts as having video — only sources whose *only*
 * video stream(s) are cover art fall through to the audio-only path. Pure
 * and exported so this classification is unit-testable against synthetic
 * ffprobe stream lists without spawning ffprobe (see clip-preview.test.ts).
 */
export function classifyMediaStreams(streams: ProbeStreamLite[]): SourceProbeLite {
  return {
    hasVideo: streams.some(
      (stream) => stream.codec_type === "video" && !isAttachedPictureStream(stream),
    ),
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
  };
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
  const data = JSON.parse(output) as { streams?: ProbeStreamLite[] };
  return classifyMediaStreams(data.streams ?? []);
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
    ...HTTP_SOURCE_ARGS,
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

// ─── Audio-only ("audiogram") preview path ─────────────────────────────────
// Podcast/audio sources have no video frame to cut+scale, so instead of
// leaving them with no preview at all (the pre-existing behaviour), this
// mirrors render-clips.ts's `buildAudiogramArgs` treatment for the real
// render: an animated waveform over a solid background. Kept deliberately
// cheaper than the render — this file's own 540p-equivalent encode knobs,
// and no burned-in captions/text-layers/transitions/music (all real-render-
// only concerns; the studio overlays captions in HTML at preview time).

/** #RRGGBB -> 0xRRGGBB for the ffmpeg `color`/`showwaves` filters. Mirrors
 *  render-clips.ts's private helper of the same name (not exported there,
 *  so duplicated here — see this file's header). */
function hexToFfmpegRgb(hex: string): string {
  return `0x${hex.replace("#", "").slice(0, 6)}`;
}

export interface AudiogramPreviewDimensions {
  width: number;
  height: number;
}

/**
 * The audiogram preview's synthetic canvas size. Unlike the video path
 * (which scales *from* the source's own frame, preserving whatever aspect
 * ratio it already has), there's no source frame here to preserve an aspect
 * from — and `ClipPendingPreview` carries no per-clip render aspect ratio to
 * key off (a single clip can have several render aspect ratios; this proxy
 * is always exactly one file). So this always builds a 16:9 canvas, the
 * same way `maxHeight` already behaves for this file's video sources (which
 * are typically landscape pre-reframe source footage): 960x540 at the
 * default 540 — literally half of 1080p in each dimension. Both dimensions
 * are rounded to even numbers since libx264's yuv420p output requires it.
 */
export function audiogramPreviewDimensions(
  maxHeight: number = previewMaxHeight(),
): AudiogramPreviewDimensions {
  const height = Math.max(2, Math.floor(maxHeight / 2) * 2);
  const width = Math.max(2, Math.round((height * 16) / 9 / 2) * 2);
  return { width, height };
}

/**
 * Builds the ffmpeg args for one audio-only clip's preview: an animated
 * `showwaves` waveform, colored from the caption preset's highlight color
 * exactly like render-clips.ts's `buildAudiogramArgs` (falling back to the
 * same schema-derived default when no preset is available), composited
 * over a solid background at a fixed 16:9 canvas. Same fast `-ss`-before-
 * `-i` seek and padded-window semantics as {@link buildClipPreviewArgs} —
 * callers pass the identical `computeClipPreviewWindow` output.
 */
export function buildAudiogramPreviewArgs(params: {
  sourcePath: string;
  outputPath: string;
  windowStartSec: number;
  windowDurationSec: number;
  maxHeight?: number;
  x264Preset?: string;
  x264Crf?: string;
  audioBitrate?: string;
  captionPreset?: CaptionPreset | null;
}): string[] {
  const { width: W, height: H } = audiogramPreviewDimensions(params.maxHeight);
  // Matches render-clips.ts's buildAudiogramArgs background color exactly,
  // to keep the preview in visual lockstep with the real render. Not
  // exported there (a local literal inside that function), so duplicated
  // rather than imported.
  const bgColor = "0x0F172A";
  const waveColor = hexToFfmpegRgb(
    params.captionPreset?.highlightColor ?? DEFAULT_CAPTION_PRESET.highlightColor,
  );
  const waveHeight = Math.round(H * 0.42);

  const chain = [
    `color=c=${bgColor}:s=${W}x${H}:d=${params.windowDurationSec}[bg]`,
    `[0:a]showwaves=s=${W}x${waveHeight}:mode=cline:colors=${waveColor}:rate=25[wave]`,
    `[bg][wave]overlay=0:(H-h)/2[comp]`,
    `[comp]format=yuv420p[outv]`,
  ];

  return [
    "-y",
    ...HTTP_SOURCE_ARGS,
    "-ss",
    String(params.windowStartSec),
    "-t",
    String(params.windowDurationSec),
    "-i",
    params.sourcePath,
    "-filter_complex",
    chain.join(";"),
    "-map",
    "[outv]",
    "-map",
    "0:a:0",
    "-c:v",
    "libx264",
    "-preset",
    params.x264Preset ?? previewX264Preset(),
    "-crf",
    params.x264Crf ?? previewX264Crf(),
    "-c:a",
    "aac",
    "-ac",
    "1",
    "-b:a",
    params.audioBitrate ?? previewAudioBitrate(),
    // -shortest bounds this to the shorter of video/audio (the background's
    // own `d=` runs for the full requested window regardless of how much
    // audio actually decoded); the trailing -t is a belt-and-suspenders
    // explicit bound, matching buildClipPreviewArgs's own convention.
    "-shortest",
    "-t",
    params.windowDurationSec.toFixed(3),
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "1024",
    params.outputPath,
  ];
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
  if (!probe.hasVideo && !probe.hasAudio) {
    // Neither a real video stream nor audio — e.g. a corrupt file, or one
    // that's *only* an attached-picture stream with no audio alongside it.
    // Nothing playable to build a proxy from; skip rather than crash the
    // batch (mirrors the invalid-window guard above).
    log("error", "clip_preview_no_playable_stream", {
      clipId: clip.id,
      projectId: clip.projectId,
    });
    return false;
  }

  const outputPath = join(tempDir, `${clip.id}-preview.mp4`);
  const previewKind: "video" | "audiogram" = probe.hasVideo ? "video" : "audiogram";
  const args = probe.hasVideo
    ? buildClipPreviewArgs({
        sourcePath,
        outputPath,
        windowStartSec: window.startSec,
        windowDurationSec: window.durationSec,
        hasAudio: probe.hasAudio,
      })
    : buildAudiogramPreviewArgs({
        sourcePath,
        outputPath,
        windowStartSec: window.startSec,
        windowDurationSec: window.durationSec,
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
    previewKind,
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

      // Stream the source over HTTP rather than downloading it. Sources here
      // are 531 MB - 1.1 GB; pulling one down to cut a ~30s window took over
      // five minutes and, because this task runs on the I/O poll loop, blocked
      // ingest and STT for the whole download. Handing ffmpeg a presigned URL
      // with `-ss` before `-i` makes it range-request only the bytes it needs:
      // measured 11.72s wall for a 38s cut off a 531 MB 4K source, producing
      // the same 1.4 MB output. Each clip in the batch re-uses this one URL.
      let sourcePath: string;
      try {
        sourcePath = await presignDownloadUrl({
          key: sourceStorageKey,
          expiresIn: SOURCE_STREAM_URL_TTL_SEC,
        });
      } catch (error) {
        log("error", "clip_preview_source_presign_failed", {
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
