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
import { randomUUID } from "node:crypto";
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
// A preview cut now runs on its own poll loop rather than inside the shared
// I/O mutex (see index.ts), but it can still race a full clip render for
// CPU on the same box — render-clips.ts's own comment measured that ffmpeg
// already saturates all cores per job, so an uncapped preview encode would
// contend with an in-progress render. Two threads keeps a ~4-45s preview cut
// fast without meaningfully starving a render.
const DEFAULT_PREVIEW_X264_THREADS = "2";

/** Presign lifetime for the streamed source. Kept generous even though each
 *  clip now gets its own fresh presign (see the "Refresh per clip" comment
 *  on processPendingClipPreviews) — this is just the per-URL TTL, not a
 *  batch-wide budget anymore. */
const SOURCE_STREAM_URL_TTL_SEC = 3600;

/** ffmpeg reads the source over HTTPS rather than from disk, so a transient
 *  network blip mid-cut would otherwise abort the encode. These make it
 *  reconnect instead. Harmless when the input happens to be a local path.
 *
 *  `-reconnect_on_http_error` only covers status codes actually worth
 *  retrying: 429 (rate limited) and the transient 5xx family. Deliberately
 *  excludes e.g. 403/404 (never recoverable by retrying the same URL) and
 *  501/505 (protocol-level, retrying changes nothing).
 *
 *  `-rw_timeout` (microseconds) bounds a single stalled read/write — without
 *  it, a connection that goes quiet mid-transfer (rather than erroring or
 *  closing) hangs the ffmpeg child forever; the reconnect flags above never
 *  even trigger because nothing has "failed" yet. This is a per-I/O-op
 *  timeout, not a whole-process one — execCommand's own timeoutMs (below) is
 *  the wall-clock backstop for the process as a whole. */
const HTTP_SOURCE_RECONNECT_HTTP_ERROR_CODES = "429,500,502,503,504";
const HTTP_SOURCE_RW_TIMEOUT_US = 30_000_000; // 30s

const HTTP_SOURCE_ARGS = [
  "-reconnect",
  "1",
  "-reconnect_streamed",
  "1",
  "-reconnect_on_network_error",
  "1",
  "-reconnect_on_http_error",
  HTTP_SOURCE_RECONNECT_HTTP_ERROR_CODES,
  "-reconnect_delay_max",
  "10",
  "-rw_timeout",
  String(HTTP_SOURCE_RW_TIMEOUT_US),
] as const;

// A whole-process wall-clock bound on ffmpeg/ffprobe children. Without this,
// a stalled read (or a pathological input) blocks this task's own poll
// loop's mutex indefinitely — see index.ts's pollClipPreviewQueue, which
// depends on this task always eventually returning. ffprobe only reads a
// small header's worth of the stream, so it gets a much tighter budget than
// a full cut. Measured a real cut at 11.72s wall for a 38s window off a
// 531 MB 4K source (see processPendingClipPreviews); 120s leaves generous
// headroom for a slower network or a longer padded window before killing it.
const DEFAULT_PREVIEW_FFMPEG_TIMEOUT_MS = 120_000;
const DEFAULT_PREVIEW_FFPROBE_TIMEOUT_MS = 30_000;
/** Grace period between SIGTERM and SIGKILL when a child ignores the
 *  timeout's first signal. */
const FORCE_KILL_GRACE_MS = 5_000;

// A permanently-broken clip (corrupt source slice, unsupported codec, ...)
// must not monopolize every tick's batch forever — see the
// ClipPreviewFailureBackoff class below. Base delay doubles per consecutive
// failure, capped at maxDelayMs.
const DEFAULT_PREVIEW_FAILURE_BACKOFF_BASE_MS = 30_000; // 30s
const DEFAULT_PREVIEW_FAILURE_BACKOFF_MAX_MS = 30 * 60_000; // 30 min
const DEFAULT_PREVIEW_FAILURE_BACKOFF_MAX_ENTRIES = 500;

// getClipsNeedingPreview's own `take` clamps to 25 regardless of what's
// requested (see clip.service.ts) — this just says "ask for that much" so a
// backoff-skipped top-N doesn't starve the rest of the queue (Fix 3). Safe
// to request more than the service will ever return.
const DEFAULT_PREVIEW_CANDIDATE_POOL_SIZE = 25;

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

function previewX264Threads(): string {
  return (
    process.env.WORKER_CLIP_PREVIEW_X264_THREADS?.trim() ||
    DEFAULT_PREVIEW_X264_THREADS
  );
}

function previewFfmpegTimeoutMs(): number {
  const raw = Number(process.env.WORKER_CLIP_PREVIEW_FFMPEG_TIMEOUT_MS?.trim());
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_PREVIEW_FFMPEG_TIMEOUT_MS;
}

function previewFfprobeTimeoutMs(): number {
  const raw = Number(
    process.env.WORKER_CLIP_PREVIEW_FFPROBE_TIMEOUT_MS?.trim(),
  );
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_PREVIEW_FFPROBE_TIMEOUT_MS;
}

function previewFailureBackoffBaseMs(): number {
  const raw = Number(
    process.env.WORKER_CLIP_PREVIEW_FAILURE_BACKOFF_BASE_MS?.trim(),
  );
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_PREVIEW_FAILURE_BACKOFF_BASE_MS;
}

function previewFailureBackoffMaxMs(): number {
  const raw = Number(
    process.env.WORKER_CLIP_PREVIEW_FAILURE_BACKOFF_MAX_MS?.trim(),
  );
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_PREVIEW_FAILURE_BACKOFF_MAX_MS;
}

/**
 * In-process exponential backoff for clips whose preview keeps failing.
 *
 * `getClipsNeedingPreview` returns the highest-virality clips still missing a
 * proxy, in the same order, every tick. Without this, a handful of clips that
 * can never succeed (corrupt source range, unsupported codec) would refill the
 * batch forever and no lower-ranked clip would ever be attempted — burning
 * ffprobe/ffmpeg work on each pass. Backing them off lets the queue drain past
 * them while still retrying periodically in case the cause was transient.
 *
 * Deliberately in-process: a durable version needs `attempts` / `nextAttemptAt`
 * / terminal-error columns on `Clip`, which is a migration. Losing this state on
 * restart is acceptable — the worst case is one extra attempt per clip per boot.
 * Bounded so a long-lived worker can't grow it without limit.
 */
export class ClipPreviewFailureBackoff {
  private readonly entries = new Map<
    string,
    { failures: number; nextAttemptAtMs: number }
  >();

  constructor(
    private readonly baseMs: number = previewFailureBackoffBaseMs(),
    private readonly maxMs: number = previewFailureBackoffMaxMs(),
    private readonly maxEntries: number = DEFAULT_PREVIEW_FAILURE_BACKOFF_MAX_ENTRIES,
  ) {}

  /** True when this clip is still inside its backoff window. */
  shouldSkip(clipId: string, nowMs: number): boolean {
    const entry = this.entries.get(clipId);
    return entry !== undefined && nowMs < entry.nextAttemptAtMs;
  }

  recordFailure(clipId: string, nowMs: number): void {
    const failures = (this.entries.get(clipId)?.failures ?? 0) + 1;
    // 2^(n-1) * base, capped. Math.min guards against overflow at high n.
    const delayMs = Math.min(this.maxMs, this.baseMs * 2 ** (failures - 1));
    this.entries.set(clipId, { failures, nextAttemptAtMs: nowMs + delayMs });

    if (this.entries.size > this.maxEntries) {
      // Map preserves insertion order, so the oldest key is the first one.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** A clip that finally succeeded should not carry its history forward. */
  recordSuccess(clipId: string): void {
    this.entries.delete(clipId);
  }
}

/** Module-level so backoff survives across poll ticks within one process. */
const previewFailureBackoff = new ClipPreviewFailureBackoff();

function previewCandidatePoolSize(): number {
  const raw = Number(
    process.env.WORKER_CLIP_PREVIEW_CANDIDATE_POOL_SIZE?.trim(),
  );
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_PREVIEW_CANDIDATE_POOL_SIZE;
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

/**
 * Mirrors how render outputs are keyed (`projects/<id>/renders/<clipId>/...`
 * in render-clips.ts) under a clearly-separate `previews` namespace —
 * deliberately **attempt-unique**, never derivable from just `(projectId,
 * clipId)`.
 *
 * This used to be a pure function of `(projectId, clipId)`, so every worker
 * racing to cut the same clip's proxy uploaded to the *same* object. The DB
 * claim (`completeClipPreview`'s conditional `previewStorageKey IS NULL`
 * update) happens strictly after the upload, so the race's loser — having
 * already uploaded to that shared key — would call `deleteObject` on it as
 * "cleanup," deleting the *winner's* object out from under it the instant
 * the winner's row was live. The clip was left pointing at a
 * `previewStorageKey` for an object that no longer existed: a permanently
 * broken preview with no error anywhere to explain it. Concurrent PUTs to
 * one key also risk R2's documented ~1 write/second/key limit.
 *
 * Each upload *attempt* now gets its own key instead. The claim in
 * `cutAndUploadClipPreview` still decides who "wins" the clip, but winning
 * or losing no longer touches the other attempt's bytes at all — the loser
 * deletes exactly the object it just uploaded (see the call site), which by
 * construction can never be the key the winner's row points to. No
 * "promotion" step is needed: the winner simply persists this attempt's own
 * key as-is (`completeClipPreview`'s `storageKey` input), since nothing else
 * in the codebase re-derives a clip's preview key from `(projectId, clipId)`
 * — every reader (`getClipPreviewSource`, `getClipDownloadUrl`, the project
 * deletion planner) reads the persisted `previewStorageKey` column verbatim.
 *
 * Orphan case: if this process dies between the upload and the
 * `completeClipPreview` claim (or dies before the loser's cleanup delete
 * runs), that attempt's object is never referenced by any row and is never
 * revisited — a real, if rare, leak. Not handled here: the follow-up is a
 * sweeper that lists the per-clip previews prefix in R2, diffs it against
 * `Clip.previewStorageKey`, and deletes unreferenced keys past a grace
 * period. (Do not write that prefix as a glob in a block comment — the
 * star-slash sequence closes the comment early.)
 */
export function clipPreviewAttemptStorageKey(
  projectId: string,
  clipId: string,
  attemptId: string,
): string {
  return `projects/${projectId}/previews/${clipId}/${attemptId}.mp4`;
}

// ─── ffmpeg/ffprobe process helpers ────────────────────────────────────────
// Duplicated in shape from render-clips.ts's private execCommand/
// execCommandOutput (not exported there) — see the file header.

/**
 * Starts a wall-clock timer that SIGTERMs `child` on expiry and escalates to
 * SIGKILL if it hasn't exited within {@link FORCE_KILL_GRACE_MS}. Returns a
 * `{ timedOut, cancel }` handle: callers check `timedOut.current` from their
 * `close` handler to tell a real timeout apart from an ordinary non-zero
 * exit, and must call `cancel()` once the child settles so the timer doesn't
 * keep the process alive. Shared by execCommand/execCommandOutput so a
 * stalled ffmpeg/ffprobe child (e.g. a source read that goes quiet without
 * erroring — see HTTP_SOURCE_ARGS's `-rw_timeout` comment for why that can
 * still happen) can never block this task's poll loop indefinitely.
 */
function armProcessTimeout(
  child: ReturnType<typeof spawn>,
  timeoutMs: number | undefined,
): { timedOut: { current: boolean }; cancel: () => void } {
  const timedOut = { current: false };
  if (!timeoutMs) {
    return { timedOut, cancel: () => {} };
  }

  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const termTimer = setTimeout(() => {
    timedOut.current = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, FORCE_KILL_GRACE_MS);
  }, timeoutMs);

  return {
    timedOut,
    cancel: () => {
      clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
    },
  };
}

async function execCommand(
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const { timedOut, cancel } = armProcessTimeout(child, options?.timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      cancel();
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
      cancel();
      if (timedOut.current) {
        reject(
          new ClipPreviewWorkerError(
            "worker_command_timeout",
            `${command} timed out after ${options?.timeoutMs}ms and was killed`,
          ),
        );
        return;
      }
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
  options?: { timeoutMs?: number },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const { timedOut, cancel } = armProcessTimeout(child, options?.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      cancel();
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
      cancel();
      if (timedOut.current) {
        reject(
          new ClipPreviewWorkerError(
            "worker_command_timeout",
            `${command} timed out after ${options?.timeoutMs}ms and was killed`,
          ),
        );
        return;
      }
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
  /** Stream duration in seconds, as ffprobe reports it (a numeric string).
   *  Corroborating signal for the nb_frames<=1 fallback below — see
   *  isAttachedPictureStream. */
  duration?: string;
  /** ffprobe's codec name for this stream (e.g. "h264", "mjpeg", "png").
   *  Corroborating signal for the nb_frames<=1 fallback below. */
  codec_name?: string;
  disposition?: { attached_pic?: number };
}

/** Attached pictures are always encoded with a still-image codec — never a
 *  real motion-video codec. A single h264/vp9/hevc/... frame is exactly the
 *  legitimate-still-image-video case that must NOT be caught here. */
const STILL_IMAGE_CODEC_NAMES: ReadonlySet<string> = new Set([
  "mjpeg",
  "png",
  "bmp",
  "gif",
  "tiff",
  "webp",
  "jpeg2000",
  "jpegls",
]);

/** Below this, a video stream's reported duration is treated as "no
 *  meaningful duration" — i.e. a static image rather than a timed track. A
 *  true embedded cover-art stream typically reports no duration at all
 *  (ffprobe can't compute one for a single untimed picture); a legitimate
 *  still-image video stretched across the clip's audio reports a duration
 *  close to the clip's own length, comfortably above this. */
const NEGLIGIBLE_STREAM_DURATION_SEC = 1;

/**
 * A podcast MP3/M4A/FLAC's embedded cover art (ID3 `APIC`, FLAC/M4A cover
 * picture blocks, ...) shows up to ffprobe as its own *video* stream —
 * almost always flagged `disposition.attached_pic = 1`. Naively treating
 * that stream as "this source has video" routes a podcast through the video
 * cut-and-scale path, which produces a proxy that's a single frozen JPEG for
 * the whole clip duration (there's nothing moving to encode). This tells the
 * two apart.
 *
 * `disposition.attached_pic` is the primary, authoritative signal in either
 * direction: ffprobe (and the muxers/taggers that produce this metadata) set
 * it deliberately, so it's trusted outright when present — including an
 * explicit `0`, which must never be second-guessed by the frame-count
 * fallback below.
 *
 * When the flag is absent (some muxers/tagging tools embed cover art without
 * ever setting it), this falls back to a frame-count heuristic — but
 * `nb_frames <= 1` alone is not enough: a legitimate single-frame video with
 * audio (e.g. a static-background lyric video, or any real footage that
 * happens to encode as one long-duration keyframe) would misclassify as
 * cover art and wrongly render as an audiogram instead of showing its real
 * frame. The fallback only fires when a *second*, independent signal also
 * points at "static image, not a timed video track": either the stream's
 * codec is a still-image format (never used for real motion video), or the
 * stream reports no meaningful duration.
 */
export function isAttachedPictureStream(stream: ProbeStreamLite): boolean {
  if (stream.codec_type !== "video") return false;

  // Primary signal — authoritative in both directions when present.
  if (stream.disposition?.attached_pic === 1) return true;
  if (stream.disposition?.attached_pic === 0) return false;

  // No explicit disposition flag: fall back to nb_frames <= 1, corroborated
  // by a second signal (see the doc comment above).
  const frameCount = Number(stream.nb_frames);
  const looksLikeSingleFrame = Number.isFinite(frameCount) && frameCount <= 1;
  if (!looksLikeSingleFrame) return false;

  if (stream.codec_name && STILL_IMAGE_CODEC_NAMES.has(stream.codec_name)) {
    return true;
  }

  const duration = Number(stream.duration);
  const hasNoMeaningfulDuration =
    !Number.isFinite(duration) || duration < NEGLIGIBLE_STREAM_DURATION_SEC;
  return hasNoMeaningfulDuration;
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
  const output = await execCommandOutput(
    "ffprobe",
    ["-v", "quiet", "-print_format", "json", "-show_streams", sourcePath],
    { timeoutMs: previewFfprobeTimeoutMs() },
  );
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
  x264Threads?: string;
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
    // Capped so a preview cut can't saturate the box while a full render
    // (which already uses every core — see render-clips.ts) is in progress.
    "-threads",
    params.x264Threads ?? previewX264Threads(),
    "-pix_fmt",
    "yuv420p",
  ];

  if (params.hasAudio) {
    // Deliberately NO boundary fade here (unlike the full renders): the
    // preview window is the clip padded by ±4s so studio boundary editing
    // can audition past the clip edges — a fade at the window (or clip)
    // boundary would silence exactly the audio that flow needs to hear.
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
  x264Threads?: string;
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
    "-threads",
    params.x264Threads ?? previewX264Threads(),
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

  // Bounded: without this a stalled ffmpeg (dead R2 socket that never errors,
  // pathological input) would hold the preview loop's mutex indefinitely.
  await execCommand("ffmpeg", args, { timeoutMs: previewFfmpegTimeoutMs() });

  // Attempt-unique key. Two workers racing the same clip used to upload to
  // one shared key and claim afterwards, so the loser's cleanup deleted the
  // very object the winner's row now pointed at (and concurrent writes to a
  // single key also breach R2's ~1 write/sec/key limit). With a per-attempt
  // key the loser can only ever delete its own bytes.
  const key = clipPreviewAttemptStorageKey(clip.projectId, clip.id, randomUUID());
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
    // The clip boundary window this cut was made for (see
    // ClipPendingPreview's comment) — NOT `window`, which is the padded
    // preview window derived from it. A boundary edit/reset that lands
    // while this cut was in flight moves the clip's stored startSec/endSec
    // away from these values, so the service's claim correctly rejects a
    // stale attempt instead of persisting a proxy for the wrong window.
    expectedClipStartSec: clip.startSec,
    expectedClipEndSec: clip.endSec,
  });

  if (!result.persisted) {
    // Lost the race to another worker cutting the same clip concurrently.
    // `key` is this attempt's own unique object, so deleting it can never
    // touch the bytes the winning row points at.
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
  // Ask for a wider pool than we intend to cut, then drop the clips currently
  // inside a failure backoff window. Without the wider pool, N permanently
  // broken top-ranked clips would fill the batch every tick and nothing below
  // them would ever be attempted.
  const nowMs = Date.now();
  const pool = await clipService.getClipsNeedingPreview(
    previewCandidatePoolSize(),
  );
  const eligible = pool.filter(
    (clip) => !previewFailureBackoff.shouldSkip(clip.id, nowMs),
  );
  const skipped = pool.length - eligible.length;
  if (skipped > 0) {
    log("info", "clip_preview_backoff_skipped", { skipped });
  }

  const candidates = eligible.slice(0, batchSize);
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
          // Losing the claim race isn't a failure of *this* clip, but the
          // proxy does now exist, so clearing any history is still correct.
          previewFailureBackoff.recordSuccess(clip.id);
        } catch (error) {
          previewFailureBackoff.recordFailure(clip.id, Date.now());
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
