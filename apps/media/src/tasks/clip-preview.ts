import { computeClipPreviewWindow as compileClipPreviewWindow } from "@narriflow/services/clip-preparation-policy";
import { executorProcessFailure } from "../worker-process";
/** Native preview encoding and waveform extraction. Admission, retries and publication belong to the service. */

import { passthroughColor, validateRenderOutput, type RenderOutputExpectation } from "../render-output-validation";
import { standardFrameRate } from "@narriflow/validators";
import type { ClipPreviewPeaks } from "@narriflow/services";
import { DEFAULT_CAPTION_PRESET } from "@narriflow/validators";
import type { CaptionPreset } from "@narriflow/validators";
import { resolveDisplayGeometry, type WorkerProcessModule } from "../worker-process";


export const DEFAULT_PREVIEW_PADDING_SEC = 4;
export const DEFAULT_PREVIEW_MAX_HEIGHT = 540;
export const DEFAULT_PREVIEW_X264_PRESET = "veryfast";
// CRF 30 at 540p measured ~1-2MB for a 30s talking-head clip in verification
// (see the worker's clip-preview report) — tune via env without a deploy.
export const DEFAULT_PREVIEW_X264_CRF = "30";
export const DEFAULT_PREVIEW_AUDIO_BITRATE = "64k";
// Preview encoding uses two threads within the container resource limit.
export const DEFAULT_PREVIEW_X264_THREADS = "2";

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
export const HTTP_SOURCE_RECONNECT_HTTP_ERROR_CODES = "429,500,502,503,504";
export const HTTP_SOURCE_RW_TIMEOUT_US = 30_000_000; // 30s

export const HTTP_SOURCE_ARGS = [
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
export const DEFAULT_PREVIEW_FFMPEG_TIMEOUT_MS = 120_000;
export const PREVIEW_PEAKS_MAX_STDOUT_BYTES = 32 * 1024 * 1024;

export function previewPaddingSec(): number {
  const raw = Number(process.env.WORKER_CLIP_PREVIEW_PADDING_SEC?.trim());
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_PREVIEW_PADDING_SEC;
}

export function previewMaxHeight(): number {
  const raw = Number(process.env.WORKER_CLIP_PREVIEW_MAX_HEIGHT?.trim());
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_PREVIEW_MAX_HEIGHT;
}

export function previewX264Preset(): string {
  return (
    process.env.WORKER_CLIP_PREVIEW_X264_PRESET?.trim() ||
    DEFAULT_PREVIEW_X264_PRESET
  );
}

export function previewX264Crf(): string {
  return (
    process.env.WORKER_CLIP_PREVIEW_X264_CRF?.trim() ||
    DEFAULT_PREVIEW_X264_CRF
  );
}

export function previewAudioBitrate(): string {
  return (
    process.env.WORKER_CLIP_PREVIEW_AUDIO_BITRATE?.trim() ||
    DEFAULT_PREVIEW_AUDIO_BITRATE
  );
}

export function previewX264Threads(): string {
  return (
    process.env.WORKER_CLIP_PREVIEW_X264_THREADS?.trim() ||
    DEFAULT_PREVIEW_X264_THREADS
  );
}

// ─── Waveform peaks knobs ───────────────────────────────────────────────────
// A cheap second ffmpeg pass over the already-cut proxy (not the remote
// source — see generateClipPreviewPeaks) decodes raw PCM, which this file
// bins in JS into a small peaks-per-second artifact for the studio's
// timeline waveform (packages/services/src/clip-preview-storage.ts owns the
// artifact's shape and its storage-key convention).

/** Chosen so it divides evenly by every sane DEFAULT_PREVIEW_PEAKS_PER_SEC
 *  value (8000 / 20 = 400 samples/bin) — plenty for max-abs amplitude
 *  binning, which only cares about peak magnitude, not frequency content. */
export const DEFAULT_PEAKS_PCM_SAMPLE_RATE_HZ = 8000;
export const DEFAULT_PREVIEW_PEAKS_PER_SEC = 20;
export const PREVIEW_PEAKS_FORMAT_VERSION = 1 as const;

export function previewPeaksPcmSampleRateHz(): number {
  const raw = Number(process.env.WORKER_CLIP_PREVIEW_PEAKS_PCM_HZ?.trim());
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_PEAKS_PCM_SAMPLE_RATE_HZ;
}

export function previewPeaksPerSec(): number {
  const raw = Number(process.env.WORKER_CLIP_PREVIEW_PEAKS_PER_SEC?.trim());
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_PREVIEW_PEAKS_PER_SEC;
}

export function previewFfmpegTimeoutMs(): number {
  const raw = Number(process.env.WORKER_CLIP_PREVIEW_FFMPEG_TIMEOUT_MS?.trim());
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_PREVIEW_FFMPEG_TIMEOUT_MS;
}

// ─── Pure window / time-mapping maths (unit-tested in clip-preview.test.ts) ─

export type { ClipPreviewWindow } from "@narriflow/services/clip-preparation-policy";
export function computeClipPreviewWindow(
  clipStartSec: number, clipEndSec: number, sourceDurationSec: number | null,
  paddingSec: number = previewPaddingSec(),
): import("@narriflow/services/clip-preparation-policy").ClipPreviewWindow {
  return compileClipPreviewWindow(clipStartSec, clipEndSec, sourceDurationSec, paddingSec);
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
 * Uses a separate `previews` namespace from the Clip Render Attempt's
 * `projects/<id>/renders/<clipId>/...` output keys —
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
  /** Displayed width / height of an anamorphic source. Its proxy is scaled to
   *  square pixels so the proxy's frame size is its displayed size. */
  squarePixelAspect?: number;
  x264Preset?: string;
  x264Crf?: string;
  audioBitrate?: string;
  x264Threads?: string;
}): string[] {
  const maxHeight = params.maxHeight ?? previewMaxHeight();
  const scaleFilter = params.squarePixelAspect
    ? `scale=${Math.max(2, Math.round((maxHeight * params.squarePixelAspect) / 2) * 2)}:${maxHeight},setsar=1`
    : `scale=-2:${maxHeight}`;

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
    scaleFilter,
    "-map",
    "0:v:0",
    "-c:v",
    "libx264",
    "-preset",
    params.x264Preset ?? previewX264Preset(),
    "-crf",
    params.x264Crf ?? previewX264Crf(),
    // Bound preview CPU use while full-quality export is in progress.
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

  // Bound the encoded output to the requested preview window even if the
  // source input lasts longer.
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
// matches the Clip Composition Plan's audiogram presentation: an animated
// waveform over a solid background. Kept deliberately
// cheaper than the render — this file's own 540p-equivalent encode knobs,
// and no burned-in captions/text-layers/transitions/music (all real-render-
// only concerns; the studio overlays captions in HTML at preview time).

/** #RRGGBB -> 0xRRGGBB for the preview's ffmpeg `color`/`showwaves` filters. */
export function hexToFfmpegRgb(hex: string): string {
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
 * like the Clip Composition Plan's audiogram layer, with the schema default
 * when no preset is available. It is composited
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
  // Match the background color of the Clip Composition Plan's audiogram layer.
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

// ─── Waveform peaks ─────────────────────────────────────────────────────────
// Phase B step 16 (vizard-parity): a real amplitude waveform for the studio
// timeline, computed from the SAME proxy this file already cuts — a cheap
// second ffmpeg pass over the small local proxy file (never the remote
// source), decoding to raw PCM and binning in JS. Deliberately not
// astats/ebur128 (built for loudness metering, not per-bin peak extraction)
// and deliberately not folded into the primary cut's own ffmpeg invocation
// (a second `-map`'d output on that command would complicate its already
// carefully-tuned args for video vs. audiogram vs. no-audio inputs, for a
// pass that's cheap enough on its own — proxies are ~1-3MB).

/**
 * Builds the ffmpeg args to decode `inputPath`'s audio to raw, headerless
 * mono PCM (`s16le`) at `sampleRateHz`, written to stdout. No `-y` (nothing
 * is written to a file) and no HTTP_SOURCE_ARGS (the input here is always
 * the already-downloaded local proxy file, never a remote URL).
 */
export function buildPeaksExtractionArgs(params: {
  inputPath: string;
  sampleRateHz: number;
}): string[] {
  return [
    "-i",
    params.inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(params.sampleRateHz),
    "-f",
    "s16le",
    "-",
  ];
}

/**
 * Bins a mono PCM signal into `peaksPerSec` amplitude samples per second of
 * audio, using max-abs amplitude within each bin (not RMS/average) so brief
 * transients — a word's onset, a laugh — are never smoothed away, which
 * matters for a waveform whose whole purpose is showing WHERE speech is
 * loud. The final bin may be shorter than the rest when `samples.length`
 * isn't an exact multiple of the bin width; it's still emitted (never
 * dropped), so `peaks.length` is always `Math.ceil(samples.length /
 * samplesPerBin)` and the artifact covers the full decoded duration.
 *
 * Pure and side-effect-free — no ffmpeg involved — so it's unit-testable
 * against synthetic Int16Array input.
 */
export function computeAmplitudePeaks(
  samples: Int16Array,
  pcmSampleRateHz: number,
  peaksPerSec: number,
): number[] {
  if (pcmSampleRateHz <= 0 || peaksPerSec <= 0 || samples.length === 0) {
    return [];
  }

  const samplesPerBin = pcmSampleRateHz / peaksPerSec;
  const totalBins = Math.ceil(samples.length / samplesPerBin);
  const peaks: number[] = new Array(totalBins);

  for (let bin = 0; bin < totalBins; bin++) {
    const start = Math.floor(bin * samplesPerBin);
    const end = Math.min(samples.length, Math.floor((bin + 1) * samplesPerBin));
    let maxAbs = 0;
    for (let i = start; i < end; i++) {
      const abs = Math.abs(samples[i]!);
      if (abs > maxAbs) maxAbs = abs;
    }
    // Int16 range is [-32768, 32767]; 32768 normalizes the max-magnitude
    // negative sample to exactly 1.0 rather than 0.99997-ish.
    peaks[bin] = maxAbs / 32768;
  }

  return peaks;
}

/**
 * Quantizes 0..1 amplitude floats to integers in [0, 100] for a compact JSON
 * payload (~20/s * 120s = 2400 small ints, a few KB — see
 * ClipPreviewPeaks's doc comment in packages/services). Clamped
 * defensively: {@link computeAmplitudePeaks} never produces a value outside
 * [0, 1], but this keeps the artifact's own contract (integers in [0, 100])
 * true regardless of caller.
 */
export function quantizePeaks(peaks: number[]): number[] {
  return peaks.map((p) => Math.max(0, Math.min(100, Math.round(p * 100))));
}

/**
 * Decodes `proxyFilePath`'s audio and bins it into the full
 * {@link ClipPreviewPeaks} artifact for `cutAndUploadClipPreview` to upload
 * alongside the proxy. `windowStartSec`/`windowDurationSec` are the SAME
 * padded preview-window values persisted as the clip's `previewStartSec`/
 * `previewDurationSec` — the artifact's own `startSec`/`durationSec` must
 * always agree with those so a bin's source time
 * (`startSec + i/peaksPerSec`) means the same thing to every reader.
 *
 * Throws (rather than returning a partial/empty result) on any ffmpeg
 * failure — callers decide how to degrade (see the try/catch around this
 * call in `cutAndUploadClipPreview`, which treats a failure here as
 * non-fatal to the proxy itself).
 */
export async function generateClipPreviewPeaks(params: {
  workerProcess: WorkerProcessModule;
  signal: AbortSignal;
  proxyFilePath: string;
  windowStartSec: number;
  windowDurationSec: number;
}): Promise<ClipPreviewPeaks> {
  const pcmSampleRateHz = previewPeaksPcmSampleRateHz();
  const peaksPerSec = previewPeaksPerSec();

  const pcmBuffer = (
    await params.workerProcess.execute({
      command: "ffmpeg",
      args: buildPeaksExtractionArgs({
        inputPath: params.proxyFilePath,
        sampleRateHz: pcmSampleRateHz,
      }),
      signal: params.signal,
      deadlineMs: previewFfmpegTimeoutMs(),
      captureStdout: true,
      maxStdoutBytes: PREVIEW_PEAKS_MAX_STDOUT_BYTES,
    })
  ).stdout;

  // Manual sample-by-sample copy rather than aliasing an Int16Array over
  // pcmBuffer's own backing ArrayBuffer: Int16Array's constructor requires
  // its byteOffset to be a multiple of 2, which Buffer.concat's output
  // isn't guaranteed to satisfy. A plain readInt16LE loop sidesteps that
  // entirely and is still fast — a two-minute proxy at 8kHz is under 1M
  // samples.
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = pcmBuffer.readInt16LE(i * 2);
  }

  const rawPeaks = computeAmplitudePeaks(samples, pcmSampleRateHz, peaksPerSec);

  return {
    version: PREVIEW_PEAKS_FORMAT_VERSION,
    sampleRateHz: null,
    peaksPerSec,
    startSec: params.windowStartSec,
    durationSec: params.windowDurationSec,
    peaks: quantizePeaks(rawPeaks),
  };
}

export async function persistOptionalClipPreviewPeaks(params: {
  workerProcess: WorkerProcessModule;
  signal: AbortSignal;
  proxyFilePath: string;
  windowStartSec: number;
  windowDurationSec: number;
  persist(peaks: ClipPreviewPeaks): Promise<unknown>;
  diagnose(error: unknown): void;
}): Promise<boolean> {
  try {
    const peaks = await generateClipPreviewPeaks(params);
    await params.persist(peaks);
    return true;
  } catch (error) {
    params.signal.throwIfAborted();
    if (executorProcessFailure(error)) throw error;
    params.diagnose(error);
    return false;
  }
}

/** Expected facts for the existing proxy command; source display geometry
 * drives its scale, and the waveform path has its own fixed 25 fps canvas. */
export function clipPreviewOutputExpectation(
  probe: Parameters<typeof resolveDisplayGeometry>[0] & { hasVideo: boolean; hasAudio: boolean; fps: number },
  durationSec: number,
  maxHeight: number = previewMaxHeight(),
): RenderOutputExpectation {
  const geometry = resolveDisplayGeometry(probe);
  const dimensions = probe.hasVideo ? {
    width: Math.max(2, Math.round(maxHeight * geometry.width / geometry.height / 2) * 2),
    height: maxHeight,
  } : audiogramPreviewDimensions(maxHeight);
  const video = probe.facts?.videos[0];
  const audio = probe.facts?.audios[0];
  const sar = !probe.hasVideo || geometry.anamorphic ? { numerator: 1, denominator: 1 } : {
    numerator: geometry.width * dimensions.height,
    denominator: geometry.height * dimensions.width,
  };
  return {
    durationSec, ...dimensions,
    frameRate: probe.hasVideo ? video?.rFrameRate ?? standardFrameRate(probe.fps) ?? { numerator: 30, denominator: 1 } : { numerator: 25, denominator: 1 },
    sampleAspectRatio: sar,
    audio: probe.hasAudio ? { channels: 1, ...(audio?.sampleRate ? { sampleRate: audio.sampleRate } : {}) } : null,
    color: passthroughColor(video),
  };
}

export async function encodeAndValidateClipPreview(params: {
  workerProcess: WorkerProcessModule;
  signal: AbortSignal;
  args: string[];
  outputPath: string;
  expected: RenderOutputExpectation;
  diagnose?: Parameters<typeof validateRenderOutput>[0]["diagnose"];
}) {
  await params.workerProcess.execute({ command: "ffmpeg", args: params.args, signal: params.signal, deadlineMs: previewFfmpegTimeoutMs() });
  return validateRenderOutput({ path: params.outputPath, expected: params.expected, workerProcess: params.workerProcess, signal: params.signal, diagnose: params.diagnose });
}
