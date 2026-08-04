import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  assertPublicHttpUrl,
  assertResponseContentLength,
  clipService,
  createByteLimitTransform,
  deleteObject,
  downloadObjectToFile,
  guardedFetch,
  presignDownloadUrl,
  projectService,
  putFileFromPath,
  RemoteFetchError,
  UnsafeUrlError,
  type GuardedFetchOptions,
} from "@narriflow/services";
import {
  brandTemplateSnapshotSchema,
  brollCuesArraySchema,
  captionPresetSchema,
  CAPTION_CHUNK_SIZE,
  CAPTION_POSITION_Y_DEFAULTS,
  CATEGORY_BROLL_FALLBACK_QUERY,
  emojiForWord,
  clipAspectRatioDbSchema,
  clipAspectRatioFromDb,
  clipAspectRatioOptions,
  getEffectiveClipTiming,
  normalizeTranscriptSliceForClip,
  resolveEffectiveLogoSettings,
  resolveMusicFadeWindows,
  studioEditsSchema,
} from "@narriflow/validators";
import type {
  BrandTemplateSnapshot,
  CaptionPreset,
  ClipAspectRatio,
  ClipCategory,
  StudioEdits,
  StudioTextLayer,
  TranscriptUtterance,
} from "@narriflow/validators";
import {
  buildReframeSendcmdScript,
  REFRAME_CROP_NAME,
  smoothFacePath,
  type FaceSample,
} from "./reframe";
import {
  brollQueryForClip,
  dominantPexelsOrientation,
  getCachedBrollAssetPath,
  planBrollWindow,
  resolveBrollCutaways,
  saveBrollAssetToCache,
  type BrollCueInput,
} from "./broll";
import {
  notifyAutoRenderCompleted,
  notifyWorkflowFailureAfterSettlement,
} from "../notifications";

interface BrollCutaway {
  path: string;
  window: { startSec: number; endSec: number };
}

interface BrollPlan {
  cutaways: BrollCutaway[];
  /** Compact per-cutaway attribution, attached to the render as object metadata and logs. */
  credits: Array<{
    query: string;
    startSec: number;
    endSec: number;
    authorName: string | null;
    authorUrl: string | null;
    pageUrl: string | null;
  }>;
}

interface MusicPlan {
  path: string;
  volume: number;
  startOffsetSec: number;
  /** User-configured music fade in/out, seconds (0-5). Optional so existing
   *  test fixtures/call sites that predate this field keep compiling. */
  fadeInSec?: number;
  fadeOutSec?: number;
}

/** A resolved reframe crop for one output: the sendcmd script + its crop name. */
interface ReframeSpec {
  scriptPath: string;
  cropName: string;
}

interface LogoOverlay {
  filePath: string;
  position: BrandTemplateSnapshot["logoPosition"];
  opacity: number;
  scalePct: number;
}

const LOGO_MARGIN_PX = 24;

/**
 * Merge a clip's `studioEdits.logo` override over the base logo overlay
 * (built once per project from the frozen brand snapshot + downloaded logo
 * file, see `brandLogo` below) via the shared `resolveEffectiveLogoSettings`
 * helper — the same one the studio preview overlay uses, so burn-in and
 * preview can't fork (vizard-parity.md Phase A step 6). `base: null` (no
 * logo asset at all, e.g. no snapshot/no logoStorageKey/audio-only source)
 * always yields `null` — there's nothing to override. `enabled: false`
 * yields `null` too, skipping the overlay filter entirely for this clip.
 */
export function resolveClipLogoOverlay(
  base: LogoOverlay | null,
  overrides: StudioEdits["logo"] | null | undefined,
): LogoOverlay | null {
  if (!base) return null;
  const effective = resolveEffectiveLogoSettings(
    { position: base.position, opacity: base.opacity, scalePct: base.scalePct },
    overrides,
  );
  if (!effective.enabled) return null;
  return {
    filePath: base.filePath,
    position: effective.position,
    opacity: effective.opacity,
    scalePct: effective.scalePct,
  };
}

interface WorkflowRunJob {
  id: string;
  projectId: string;
  project: {
    title: string;
    sourceStorageKey: string | null;
    sourceDurationSeconds: number | null;
    userId: string;
  };
}

export function resolveRenderTimingForClip(input: {
  llmModel: string | null;
  startSec: number;
  endSec: number;
  utterances: TranscriptUtterance[];
}) {
  if (input.llmModel === "caption-only") {
    const startSec = Math.max(0, input.startSec);
    const endSec = Math.max(startSec + 0.01, input.endSec);
    return {
      startSec,
      endSec,
      durationSec: endSec - startSec,
      transcriptSlice: normalizeTranscriptSliceForClip(
        input.utterances,
        startSec,
        endSec,
      ),
    };
  }

  // tailPadSec 0: the clip's stored bounds were already pad- and collision-
  // normalized against the full transcript at detection/edit time, and the
  // slice passed here can't see the word that follows the clip — re-padding
  // from slice-only data used to push the rendered end ~0.25s past the
  // stored end, straight into the next sentence.
  return getEffectiveClipTiming({
    utterances: input.utterances,
    startSec: input.startSec,
    endSec: input.endSec,
    tailPadSec: 0,
  });
}

interface SourceProbe {
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

interface PendingRenderOutput {
  clipRenderId: string;
  clipId: string;
  clipIndex: number;
  aspectRatio: ClipAspectRatio;
  outputPath: string;
  storageKey: string;
  subtitlePath?: string | null;
  reframe?: ReframeSpec | null;
}

/**
 * Attempt-unique render storage key — mirrors `clipPreviewAttemptStorageKey`
 * from clip-preview.ts (see its comment for the full race it closes; the
 * short version below is render-specific).
 *
 * The key used to be a pure function of `(projectId, clipId, aspectRatio)`,
 * so two overlapping encodes for the same clip+aspect (e.g. an in-flight
 * render R1, an editor save that deletes R1's ClipRender row, then a
 * freshly-queued R2 that completes first) uploaded to the *same* object.
 * `completeClipRenderVariant`'s DB claim happens strictly after the upload,
 * so R1 — arriving late, its own row already gone — would still overwrite
 * R2's just-uploaded bytes at that shared key before its own row-update
 * failed, leaving downloads serving stale video with no error anywhere to
 * explain it.
 *
 * Each encode attempt now gets its own key. `completeClipRenderVariant`
 * persists this attempt's key as-is; nothing else re-derives a render's
 * storage key from `(projectId, clipId, aspectRatio)` — every reader (the
 * download endpoint, the project/clip storage deletion planner) reads the
 * persisted `ClipRender.storageKey` column verbatim.
 */
export function clipRenderAttemptStorageKey(
  projectId: string,
  clipId: string,
  aspectRatioSlug: string,
  attemptId: string,
): string {
  return `projects/${projectId}/renders/${clipId}/${aspectRatioSlug}-${attemptId}.mp4`;
}

class WorkflowWorkerError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const aspectRatioConfig = new Map(
  clipAspectRatioOptions.map((option) => [option.value, option]),
);

const captionStyleByAspectRatio: Record<
  ClipAspectRatio,
  { fontSize: number; marginV: number }
> = {
  "9:16": { fontSize: 24, marginV: 110 },
  "1:1": { fontSize: 22, marginV: 72 },
  "16:9": { fontSize: 28, marginV: 56 },
  "4:5": { fontSize: 23, marginV: 90 },
};

function log(
  level: "info" | "error",
  message: string,
  context?: Record<string, unknown>,
) {
  console.log(
    JSON.stringify({
      level,
      message,
      ts: new Date().toISOString(),
      ...context,
    }),
  );
}

// Encoding is the dominant cost of a render. veryfast/CRF21 measured
// quality-neutral against the previous medium/CRF23 on this codebase's own
// footage while cutting 34-47s per 60-minute source. Overridable per-env so
// it can be retuned without a deploy.
const DEFAULT_X264_PRESET = "veryfast";
const DEFAULT_X264_CRF = "21";

function x264Preset(): string {
  return process.env.WORKER_X264_PRESET?.trim() || DEFAULT_X264_PRESET;
}

function x264Crf(): string {
  return process.env.WORKER_X264_CRF?.trim() || DEFAULT_X264_CRF;
}

// B-roll/background-music downloads are short, small, user- or API-supplied
// assets — not the (up to hour-long) primary source media — so they get a
// much tighter timeout/size budget than ingest's source download. Bounded so
// a hostile or oversized URL can never OOM the worker or pin a slot for the
// whole reaper window.
const REMOTE_MEDIA_DOWNLOAD_TIMEOUT_MS = 45_000;
const REMOTE_MEDIA_MAX_BYTES = 250 * 1024 * 1024;

// Whole-process wall-clock bounds. With ranged reads, ffmpeg holds an HTTP
// connection for the entire encode; -rw_timeout bounds a single stalled read
// but (as clip-preview.ts's armProcessTimeout comment documents) a quiet
// stall can still evade it — and a child that never exits would hold the
// render loop's mutex forever with nothing detecting it. SIGTERM first,
// SIGKILL after a grace period.
const COMMAND_KILL_GRACE_MS = 5000;
const RENDER_COMMAND_TIMEOUT_MS = Number(
  process.env.WORKER_RENDER_FFMPEG_TIMEOUT_MS ?? String(30 * 60 * 1000),
);
const PROBE_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
// Presigned source URLs carry their auth in the query string and ffmpeg
// echoes the full URL into stderr on HTTP errors; strip query strings before
// any of it can reach an error message (and from there structured logs).
function redactUrlQueries(text: string): string {
  return text.replace(/\?[^\s"']+/g, "?[redacted]");
}
// Only the error-message tail is ever consumed; cap accumulation so a flaky
// HTTP source chattering -reconnect retries can't grow stderr unboundedly
// over a multi-minute encode.
const MAX_STDERR_CHARS = 8192;

function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; captureStdout: boolean },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, COMMAND_KILL_GRACE_MS);
    }, options.timeoutMs);

    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    if (options.captureStdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
    }

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-MAX_STDERR_CHARS);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimers();
      if (error.code === "ENOENT") {
        reject(
          new WorkflowWorkerError(
            "worker_command_missing",
            `${command} is not installed`,
          ),
        );
        return;
      }

      reject(error);
    });

    child.on("close", (code) => {
      clearTimers();

      if (timedOut) {
        reject(
          new WorkflowWorkerError(
            "worker_command_timeout",
            `${command} timed out after ${options.timeoutMs}ms`,
          ),
        );
        return;
      }

      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(
        new WorkflowWorkerError(
          "worker_command_failed",
          `${command} failed with code ${code}: ${redactUrlQueries(stderr.slice(-500))}`,
        ),
      );
    });
  });
}

async function execCommand(
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) {
  await runCommand(command, args, {
    timeoutMs: options?.timeoutMs ?? RENDER_COMMAND_TIMEOUT_MS,
    captureStdout: false,
  });
}

async function execCommandOutput(
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
): Promise<string> {
  return runCommand(command, args, {
    timeoutMs: options?.timeoutMs ?? RENDER_COMMAND_TIMEOUT_MS,
    captureStdout: true,
  });
}

/** Ranged source reads (default): every builder already puts `-ss` before
 *  `-i`, so handing ffmpeg a presigned HTTPS URL makes it range-request only
 *  the clip windows instead of the whole object — clip-preview.ts measured
 *  11.72s wall for a 38s cut off a 531MB 4K source with this exact pattern.
 *  For a 2h podcast, 6-10 clips read ~5-8% of the source bytes vs 100% for
 *  the old full-file download. `WORKER_RENDER_SOURCE_MODE=download` restores
 *  the old behavior; any presign/probe failure falls back to it per run. */
const RENDER_SOURCE_URL_TTL_SEC = 12 * 60 * 60;

// Mirrors clip-preview.ts's HTTP_SOURCE_ARGS: reconnect only on genuinely
// transient statuses, and bound a single stalled read so a quiet connection
// can't hang the ffmpeg child forever (execCommand has no per-render timeout
// here; the run-level reaper is the outer backstop).
const HTTP_SOURCE_RECONNECT_HTTP_ERROR_CODES = "429,500,502,503,504";
const HTTP_SOURCE_RW_TIMEOUT_US = 30_000_000; // 30s

function isHttpSource(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

function httpSourceInputArgs(input: string): string[] {
  if (!isHttpSource(input)) return [];
  return [
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
  ];
}

async function probeSource(sourcePath: string): Promise<SourceProbe> {
  const output = await execCommandOutput(
    "ffprobe",
    [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      ...(isHttpSource(sourcePath)
        ? ["-rw_timeout", String(HTTP_SOURCE_RW_TIMEOUT_US)]
        : []),
      sourcePath,
    ],
    { timeoutMs: PROBE_COMMAND_TIMEOUT_MS },
  );

  const data = JSON.parse(output) as {
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
    }>;
  };

  const streams = data.streams ?? [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const audioStream = streams.find((stream) => stream.codec_type === "audio");

  return {
    width: videoStream?.width ?? 0,
    height: videoStream?.height ?? 0,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
  };
}

/**
 * Probes a local media file's container duration. Used to size the B-roll
 * cutaway window against the *real* footage instead of a guess — required for
 * studio-picked B-roll, which (unlike the Pexels auto-search path) has no
 * API-reported duration up front. Returns null on any failure so callers can
 * treat it exactly like "no usable B-roll" and skip the cutaway.
 */
async function probeMediaDurationSec(filePath: string): Promise<number | null> {
  try {
    const output = await execCommandOutput(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_entries",
        "format=duration",
        filePath,
      ],
      { timeoutMs: PROBE_COMMAND_TIMEOUT_MS },
    );
    const data = JSON.parse(output) as { format?: { duration?: string } };
    const parsed = data.format?.duration ? Number(data.format.duration) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
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
}): Promise<{ samples: FaceSample[] } | null> {
  const scriptPath = fileURLToPath(
    new URL("../../scripts/reframe_detect.py", import.meta.url),
  );
  const modelPath =
    process.env.REFRAME_MODEL_PATH ??
    "/usr/local/share/narriflow/face_yunet.onnx";
  const fps = process.env.REFRAME_SAMPLE_FPS ?? "4";

  try {
    const out = await execCommandOutput("python3", [
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
    if (parsed.error || !Array.isArray(parsed.samples)) return null;
    return { samples: parsed.samples };
  } catch {
    return null;
  }
}

function formatSrtTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function generateSrtFromSlice(
  utterances: TranscriptUtterance[],
  clipStartSec: number,
  textTransform?: string,
): string {
  if (utterances.length === 0) {
    return "";
  }

  const cues: string[] = [];
  let cueIndex = 1;

  for (const utterance of utterances) {
    const words = utterance.words;

    if (words.length > 0) {
      // Word-level mode: group into fixed cues (matches the ASS/preview model)
      for (let i = 0; i < words.length; i += CAPTION_CHUNK_SIZE) {
        const group = words.slice(i, i + CAPTION_CHUNK_SIZE);
        const start = Math.max(0, group[0]!.startSec - clipStartSec);
        const end = Math.max(start + 0.1, group[group.length - 1]!.endSec - clipStartSec);
        const text = applyTextTransform(group.map((w) => w.word).join(" "), textTransform);
        cues.push(`${cueIndex}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${text}\n`);
        cueIndex++;
      }
    } else {
      // Fallback: utterance-level cue
      const start = Math.max(0, utterance.startSec - clipStartSec);
      const end = Math.max(start + 0.1, utterance.endSec - clipStartSec);
      const text = applyTextTransform(utterance.text, textTransform);
      cues.push(`${cueIndex}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${text}\n`);
      cueIndex++;
    }
  }

  return cues.join("\n");
}

function formatAssTimestamp(seconds: number): string {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(totalCs / 360_000);
  const m = Math.floor((totalCs % 360_000) / 6000);
  const s = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function hexToAssColor(hex: string, alphaHex = "00"): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `&H${alphaHex}${b}${g}${r}`;
}

/** ASS alpha is inverse of opacity: 0 alpha = fully opaque, FF = transparent. */
function assAlphaHex(opacity: number): string {
  const clamped = Math.max(0, Math.min(1, opacity));
  const alpha = Math.round((1 - clamped) * 255);
  return alpha.toString(16).toUpperCase().padStart(2, "0");
}

// Map preset font names to fonts actually bundled in the worker image. Impact
// is proprietary, so we substitute Anton (a metric-ish open display face).
const FONT_ALIASES: Record<string, string> = {
  Impact: "Anton",
};

function resolveFontName(name?: string | null): string {
  if (!name) return "Bebas Neue";
  const aliased = FONT_ALIASES[name] ?? name;
  // Strip characters that would break the ASS style / force_style filter
  // (commas, quotes, backslashes). Font names are letters/digits/space/hyphen.
  const safe = aliased.replace(/[^A-Za-z0-9 -]/g, "").trim();
  return safe.length > 0 ? safe : "Bebas Neue";
}

function applyTextTransform(text: string, transform?: string): string {
  switch (transform) {
    case "uppercase": return text.toUpperCase();
    case "lowercase": return text.toLowerCase();
    case "capitalize": return text.replace(/\b\w/g, (c) => c.toUpperCase());
    default: return text;
  }
}

/**
 * Builds an ASS subtitle file that burns captions matching the studio preview:
 * fixed cues of {@link CAPTION_CHUNK_SIZE} words, per-word highlight color,
 * optional highlight box and glow, position from the preset, and a light
 * entrance animation. This is the authoritative export path — the SRT path is
 * only a fallback for clips that have no caption preset.
 */
export function generateAssFromSlice(
  utterances: TranscriptUtterance[],
  clipStartSec: number,
  aspectRatio: ClipAspectRatio,
  captionPreset: CaptionPreset,
): string {
  const config = aspectRatioConfig.get(aspectRatio);
  if (!config) return "";

  const resX = config.width;
  const resY = config.height;
  const posXPct = captionPreset.positionX ?? 50;
  const posYPct =
    captionPreset.positionY ??
    CAPTION_POSITION_Y_DEFAULTS[captionPreset.position ?? "bottom"];
  const posXPx = Math.round((posXPct / 100) * resX);
  const posYPx = Math.round((posYPct / 100) * resY);

  // Font size is in render pixels at this output's resolution — identical to the
  // studio preview, which scales the same `fontSize` against each aspect's own
  // width (`renderWidth`). Using it raw keeps export == preview.
  const fontName = resolveFontName(captionPreset.fontName);
  const fontSize =
    captionPreset.fontSize ?? captionStyleByAspectRatio[aspectRatio].fontSize;
  const primaryColor = hexToAssColor(captionPreset.primaryColor ?? "#FFFFFF");
  const highlightColor = hexToAssColor(captionPreset.highlightColor ?? "#00FF88");
  const outlineColor = hexToAssColor(captionPreset.outlineColor ?? "#000000");
  const bold = captionPreset.bold !== false ? -1 : 0;
  const outlineWidth = captionPreset.outlineWidth ?? 2;
  const shadow = captionPreset.shadow ?? 1;
  const spacing = Math.round((captionPreset.letterSpacing ?? 0) * fontSize);

  // Backdrop behind the whole line: BorderStyle=3 (opaque box) with BackColour.
  let borderStyle = 1;
  let backColour = "&H00000000";
  if (captionPreset.backgroundColor) {
    borderStyle = 3;
    backColour = hexToAssColor(
      captionPreset.backgroundColor,
      assAlphaHex(captionPreset.backgroundOpacity ?? 0.6),
    );
  }

  // Glow: colored, blurred shadow applied to the whole cue.
  let glowOverride = "";
  if (captionPreset.glowColor) {
    const intensity = captionPreset.glowIntensity ?? 8;
    const glowAss = hexToAssColor(captionPreset.glowColor);
    const shadowDepth = Math.max(1, Math.round(intensity / 4));
    const blur = Math.max(1, Math.round(intensity / 2));
    glowOverride = `\\4c${glowAss}&\\shad${shadowDepth}\\blur${blur}`;
  }

  // Highlight box approximated by a thick colored border on the active word.
  const hasHighlightBox = Boolean(captionPreset.highlightBoxColor);
  const boxColor = hasHighlightBox
    ? hexToAssColor(captionPreset.highlightBoxColor!)
    : "";
  const boxAlpha = assAlphaHex(captionPreset.highlightBoxOpacity ?? 1);
  const boxBord = Math.max(outlineWidth, Math.round(fontSize * 0.16));

  const animation = captionPreset.animation ?? "word-by-word";

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${resX}`,
    `PlayResY: ${resY}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontName},${fontSize},${primaryColor},${primaryColor},${outlineColor},${backColour},${bold},0,0,0,100,100,${spacing},0,${borderStyle},${outlineWidth},${shadow},5,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events: string[] = [];
  const txtTransform = captionPreset.textTransform;

  const renderWord = (word: string, isActive: boolean): string => {
    if (!isActive) return word;
    if (hasHighlightBox) {
      return (
        `{\\1c${highlightColor}&\\bord${boxBord}\\3c${boxColor}&\\3a&H${boxAlpha}&}` +
        `${word}` +
        `{\\1c${primaryColor}&\\bord${outlineWidth}\\3c${outlineColor}&\\3a&H00&}`
      );
    }
    return `{\\1c${highlightColor}&}${word}{\\1c${primaryColor}&}`;
  };

  const entranceFor = (isChunkStart: boolean): string => {
    if (!isChunkStart) return "";
    let entrance = "\\fad(60,0)";
    if (
      animation === "grow" ||
      animation === "bounce" ||
      animation === "seamless-bounce" ||
      animation === "soft-landing"
    ) {
      entrance += "\\fscx82\\fscy82\\t(0,160,\\fscx100\\fscy100)";
    } else if (animation === "blur-in" && !captionPreset.glowColor) {
      entrance += "\\blur6\\t(0,200,\\blur0)";
    }
    return entrance;
  };

  for (const utterance of utterances) {
    const words = utterance.words;

    if (words.length > 0) {
      for (let i = 0; i < words.length; i += CAPTION_CHUNK_SIZE) {
        const group = words.slice(i, i + CAPTION_CHUNK_SIZE);
        const groupEnd = Math.max(0, group[group.length - 1]!.endSec - clipStartSec);
        const transformedWords = group.map((w) =>
          applyTextTransform(w.word, txtTransform),
        );

        for (let j = 0; j < group.length; j++) {
          const activeStart = Math.max(0, group[j]!.startSec - clipStartSec);
          const activeEnd =
            j + 1 < group.length
              ? Math.max(activeStart + 0.05, group[j + 1]!.startSec - clipStartSec)
              : Math.max(activeStart + 0.1, groupEnd);

          const text = group
            .map((w, k) => {
              const rendered = renderWord(transformedWords[k]!, k === j);
              const emoji = captionPreset.emojis ? emojiForWord(w.word) : null;
              return emoji ? `${rendered} ${emoji}` : rendered;
            })
            .join(" ");

          const override = `\\an5\\pos(${posXPx},${posYPx})${glowOverride}${entranceFor(j === 0)}`;
          events.push(
            `Dialogue: 0,${formatAssTimestamp(activeStart)},${formatAssTimestamp(activeEnd)},Default,,0,0,0,,{${override}}${text}`,
          );
        }
      }
    } else {
      const start = Math.max(0, utterance.startSec - clipStartSec);
      const end = Math.max(start + 0.1, utterance.endSec - clipStartSec);
      const text = applyTextTransform(utterance.text, txtTransform);
      const override = `\\an5\\pos(${posXPx},${posYPx})${glowOverride}\\fad(60,0)`;
      events.push(
        `Dialogue: 0,${formatAssTimestamp(start)},${formatAssTimestamp(end)},Default,,0,0,0,,{${override}}${text}`,
      );
    }
  }

  return header + "\n" + events.join("\n") + "\n";
}

function escapeSubtitlePath(filePath: string) {
  return filePath.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

/** #RRGGBB -> 0xRRGGBB for the ffmpeg `color` / `showwaves` filters. */
function hexToFfmpegRgb(hex: string): string {
  return `0x${hex.replace("#", "").slice(0, 6)}`;
}

function hexToFfmpegColor(hex: string): string {
  // Converts #RRGGBB to \&H00BBGGRR\& (FFmpeg ASS BGRA color format, alpha=00=opaque)
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `\\&H00${b}${g}${r}\\&`;
}

function escapeDrawtextValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/%/g, "\\%");
}

function buildTextLayerFilters(
  layers: StudioTextLayer[],
  clipDurationSec: number,
): string[] {
  return layers.map((layer) => {
    const endSec = Math.min(
      clipDurationSec,
      layer.endSec ?? clipDurationSec,
    );
    const startSec = Math.min(layer.startSec, endSec);
    const x = ((layer.positionX ?? 50) / 100).toFixed(4);
    const y = ((layer.positionY ?? 18) / 100).toFixed(4);
    const fontColor = hexToFfmpegRgb(layer.color);
    const border = layer.outlineWidth > 0
      ? `:borderw=${layer.outlineWidth}:bordercolor=${hexToFfmpegRgb(layer.outlineColor)}`
      : "";
    const box = layer.backgroundColor
      ? `:box=1:boxcolor=${hexToFfmpegRgb(layer.backgroundColor)}@${layer.backgroundOpacity.toFixed(3)}:boxborderw=10`
      : "";

    return (
      `drawtext=font='${escapeDrawtextValue(layer.fontName)}'` +
      `:text='${escapeDrawtextValue(layer.text)}'` +
      `:fontsize=${Math.round(layer.fontSize)}` +
      `:fontcolor=${fontColor}` +
      `:x=(w-text_w)*${x}:y=(h-text_h)*${y}` +
      `:enable='between(t\\,${startSec.toFixed(3)}\\,${endSec.toFixed(3)})'` +
      `:shadowcolor=black@0.45:shadowx=0:shadowy=2` +
      `${border}${box}`
    );
  });
}

function buildTransitionFilter(
  transition: StudioEdits["transition"] | undefined,
  clipDurationSec: number,
): string | null {
  if (!transition || transition.type === "none") return null;
  const duration = Math.min(transition.durationSec, clipDurationSec / 2);
  if (duration <= 0) return null;
  const outStart = Math.max(0, clipDurationSec - duration);
  const color = transition.type === "dip-white" ? ":color=white" : "";
  return `fade=t=in:st=0:d=${duration.toFixed(3)}${color},fade=t=out:st=${outStart.toFixed(3)}:d=${duration.toFixed(3)}${color}`;
}

function appendTransitionFilter(
  filterParts: string[],
  inputLabel: string,
  outputLabel: string,
  studioEdits: StudioEdits | null | undefined,
  clipDurationSec: number,
) {
  const transitionFilter = buildTransitionFilter(
    studioEdits?.transition,
    clipDurationSec,
  );
  if (!transitionFilter) return inputLabel;
  filterParts.push(`${inputLabel}${transitionFilter}${outputLabel}`);
  return outputLabel;
}

// Every render gets a short audio fade at each boundary: clip ends land at
// most ~0.25s after the last spoken word (and, when speech continues in the
// source, just a few ms before the next word), so a hard cut audibly clicks
// or clips a phoneme. The fade is short enough to be inaudible as an effect.
const AUDIO_FADE_IN_SEC = 0.04;
const AUDIO_FADE_OUT_SEC = 0.12;

export function buildAudioFadeChain(clipDurationSec: number) {
  const fadeOutStart = Math.max(0, clipDurationSec - AUDIO_FADE_OUT_SEC);
  return `afade=t=in:st=0:d=${AUDIO_FADE_IN_SEC.toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${AUDIO_FADE_OUT_SEC.toFixed(3)}`;
}

/**
 * Builds a `volume=` filter fragment for the source/dialogue track from
 * `studioEdits.sourceAudio`, or `null` when it's a no-op (unity gain, not
 * muted) — callers must skip appending it entirely in that case (the "unity
 * fast path") so untouched clips keep producing the exact same filter graph
 * they always have.
 */
function buildSourceGainFilter(
  sourceAudio: StudioEdits["sourceAudio"] | null | undefined,
): string | null {
  if (!sourceAudio) return null;
  if (sourceAudio.muted) return "volume=0.000";
  if (sourceAudio.volume === 100) return null;
  const gain = Math.max(0, Math.min(1, sourceAudio.volume / 100));
  return `volume=${gain.toFixed(3)}`;
}

/**
 * The dialogue-only (no music) audio chain: optional source gain/mute, then
 * the fixed boundary click-guard fade. Used by every build*Args call site
 * that has source audio and no music track to mix in.
 */
function buildDialogueAudioFilter(
  sourceAudio: StudioEdits["sourceAudio"] | null | undefined,
  clipDurationSec: number,
): string {
  const gainFilter = buildSourceGainFilter(sourceAudio);
  const fadeChain = buildAudioFadeChain(clipDurationSec);
  return gainFilter ? `${gainFilter},${fadeChain}` : fadeChain;
}

/**
 * User-configured music fade in/out (`studioEdits.music.fadeInSec/fadeOutSec`,
 * 0-5s each), as an `afade` filter suffix applied to the music branch only —
 * additive to (not a replacement for) the fixed click-guard chain on the
 * final mixed track.
 *
 * Clamping/overlap resolution comes from the shared
 * `resolveMusicFadeWindows` policy (packages/validators/src/studio-edits.ts)
 * rather than clamping each fade independently here — this used to clamp
 * fadeIn and fadeOut to the clip duration separately, which let a long
 * fade-in + long fade-out on a short clip overlap (e.g. both landing at full
 * length, fading in and out over the SAME seconds) instead of scaling both
 * down proportionally so fade-in ends before fade-out begins. The studio
 * preview already uses the shared helper; this keeps the render in lockstep.
 */
function buildMusicUserFadeSuffix(
  music: MusicPlan,
  clipDurationSec: number,
): string {
  const parts: string[] = [];
  const { fadeInSec, fadeOutSec, fadeOutStartSec } = resolveMusicFadeWindows(
    music.fadeInSec ?? 0,
    music.fadeOutSec ?? 0,
    clipDurationSec,
  );
  if (fadeInSec > 0) {
    parts.push(`afade=t=in:st=0:d=${fadeInSec.toFixed(3)}`);
  }
  if (fadeOutSec > 0) {
    parts.push(
      `afade=t=out:st=${fadeOutStartSec.toFixed(3)}:d=${fadeOutSec.toFixed(3)}`,
    );
  }
  return parts.length ? `,${parts.join(",")}` : "";
}

function buildMusicAudioFilter(params: {
  sourceHasAudio: boolean;
  musicInputIndex: number;
  music: MusicPlan;
  clipDurationSec: number;
  sourceAudio?: StudioEdits["sourceAudio"] | null;
}) {
  const volume = Math.max(0, Math.min(1, params.music.volume / 100));
  const duration = Math.max(0.1, params.clipDurationSec);
  const startOffset = Math.max(0, params.music.startOffsetSec || 0);
  const musicLabel = "[musica]";
  const fadeChain = buildAudioFadeChain(duration);
  const userFadeSuffix = buildMusicUserFadeSuffix(params.music, duration);
  // start=<offset> seeks into the (infinitely -stream_loop'd) music input so
  // the user's chosen point in the track plays first, instead of always the
  // first `duration` seconds of the file.
  const musicFilter =
    `[${params.musicInputIndex}:a]atrim=start=${startOffset.toFixed(3)}:duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${volume.toFixed(3)}${userFadeSuffix}${musicLabel}`;

  if (!params.sourceHasAudio) {
    return `${musicFilter};${musicLabel}${fadeChain}[outa]`;
  }

  // normalize=0: amix's default normalization divides every input by the
  // input count (i.e. -6dB per input for a 2-input mix), quietly ducking the
  // dialogue whenever music is added. The music's own level is already under
  // explicit user control via `volume=` above, so the dialogue must be mixed
  // at unity gain — modulo the user's own source-audio gain/mute, applied
  // here on the dialogue branch (before amix) same as the no-music path.
  const dialogueGainFilter = buildSourceGainFilter(params.sourceAudio);
  const dialogueFilter = dialogueGainFilter
    ? `[0:a]atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,${dialogueGainFilter}[maina]`
    : `[0:a]atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS[maina]`;

  return [
    dialogueFilter,
    musicFilter,
    `[maina]${musicLabel}amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${fadeChain}[outa]`,
  ].join(";");
}

function buildSubtitleFilter(
  aspectRatio: ClipAspectRatio,
  subtitlePath: string | null,
  captionPreset?: CaptionPreset | null,
) {
  if (!subtitlePath) {
    return null;
  }

  const escapedPath = escapeSubtitlePath(subtitlePath);

  // ASS files carry their own styling and positioning
  if (subtitlePath.endsWith(".ass")) {
    return `ass='${escapedPath}'`;
  }

  // SRT path: apply force_style
  const captionStyle = captionStyleByAspectRatio[aspectRatio];
  const fontSize = captionPreset?.fontSize ?? captionStyle.fontSize;

  const fontName = resolveFontName(captionPreset?.fontName);
  const primaryColor = captionPreset?.primaryColor
    ? hexToFfmpegColor(captionPreset.primaryColor)
    : "\\&H00FFFFFF\\&";
  const outlineColor = captionPreset?.outlineColor
    ? hexToFfmpegColor(captionPreset.outlineColor)
    : "\\&H00000000\\&";
  const outlineWidth = captionPreset?.outlineWidth ?? 2;
  const shadow = captionPreset?.shadow ?? 1;
  const bold = captionPreset?.bold !== false ? 1 : 0;
  const alignment =
    captionPreset?.position === "top" ? 8 :
    captionPreset?.position === "center" ? 5 : 2;

  const spacing = Math.round((captionPreset?.letterSpacing ?? 0) * fontSize);

  let borderStyle = 1;
  let backColour = "";
  if (captionPreset?.backgroundColor) {
    borderStyle = 3;
    const bgAlpha = Math.round((1 - (captionPreset.backgroundOpacity ?? 0.6)) * 255);
    const bgAlphaHex = bgAlpha.toString(16).toUpperCase().padStart(2, "0");
    const r = captionPreset.backgroundColor.slice(1, 3);
    const g = captionPreset.backgroundColor.slice(3, 5);
    const b = captionPreset.backgroundColor.slice(5, 7);
    backColour = `,BackColour=\\&H${bgAlphaHex}${b}${g}${r}\\&,BorderStyle=${borderStyle}`;
  }

  const forceStyle =
    `FontSize=${fontSize},Alignment=${alignment},MarginV=${captionStyle.marginV},FontName=${fontName},` +
    `PrimaryColour=${primaryColor},OutlineColour=${outlineColor},Outline=${outlineWidth},Shadow=${shadow},Bold=${bold}` +
    (spacing > 0 ? `,Spacing=${spacing}` : "") +
    backColour;

  return `subtitles='${escapedPath}':force_style='${forceStyle}'`;
}

function buildLogoOverlayPosition(
  position: BrandTemplateSnapshot["logoPosition"],
): { x: string; y: string } {
  const [vertical, horizontal] = position.split("-") as [
    "top" | "mid" | "bot",
    "left" | "center" | "right",
  ];
  let x: string;
  let y: string;

  if (horizontal === "left") x = `${LOGO_MARGIN_PX}`;
  else if (horizontal === "right") x = `W-w-${LOGO_MARGIN_PX}`;
  else x = `(W-w)/2`;

  if (vertical === "top") y = `${LOGO_MARGIN_PX}`;
  else if (vertical === "bot") y = `H-h-${LOGO_MARGIN_PX}`;
  else y = `(H-h)/2`;

  return { x, y };
}

function computeLogoTargetWidth(
  logo: LogoOverlay,
  videoWidth: number,
): number {
  return Math.max(40, Math.round(videoWidth * (logo.scalePct / 100)));
}

function buildLogoFilter(
  logo: LogoOverlay,
  videoWidth: number,
  inputStreamRef: string,
  outputStreamRef: string,
  logoInputIndex: number,
  scratchSuffix: string,
): string {
  const opacity = Math.max(0.1, Math.min(1, logo.opacity / 100));
  const targetWidth = computeLogoTargetWidth(logo, videoWidth);
  const { x, y } = buildLogoOverlayPosition(logo.position);
  const scratchLabel = `brandlogo${scratchSuffix}`;
  return [
    `[${logoInputIndex}:v]scale=${targetWidth}:-1,format=rgba,colorchannelmixer=aa=${opacity.toFixed(3)}[${scratchLabel}]`,
    `${inputStreamRef}[${scratchLabel}]overlay=${x}:${y}${outputStreamRef}`,
  ].join(";");
}

export function buildCropAndScaleFilter(
  probe: SourceProbe,
  aspectRatio: ClipAspectRatio,
  reframe?: ReframeSpec | null,
) {
  const config = aspectRatioConfig.get(aspectRatio);

  if (!config) {
    throw new WorkflowWorkerError(
      "unsupported_aspect_ratio",
      `Unsupported aspect ratio: ${aspectRatio}`,
    );
  }

  if (!probe.hasVideo) {
    return null;
  }

  if (probe.width <= 0 || probe.height <= 0) {
    throw new WorkflowWorkerError(
      "invalid_source_dimensions",
      `Source reported invalid video dimensions (${probe.width}x${probe.height})`,
    );
  }

  const srcRatio = probe.width / probe.height;
  const targetRatio = config.width / config.height;

  let cropW: number;
  let cropH: number;

  if (srcRatio >= targetRatio) {
    cropH = probe.height;
    cropW = Math.round(probe.height * targetRatio);
  } else {
    cropW = probe.width;
    cropH = Math.round(probe.width / targetRatio);
  }

  // Auto-reframe: when we crop horizontally (srcRatio >= targetRatio) and a face
  // path is available, drive crop x via sendcmd so the crop follows the speaker
  // instead of a static center crop.
  if (reframe && srcRatio >= targetRatio && cropW < probe.width) {
    const escaped = escapeSubtitlePath(reframe.scriptPath);
    return (
      `sendcmd=f='${escaped}',` +
      `${reframe.cropName}=w=${cropW}:h=${cropH}:x=${Math.round((probe.width - cropW) / 2)}:y=0,` +
      `scale=${config.width}:${config.height},format=yuv420p`
    );
  }

  return `crop=${cropW}:${cropH},scale=${config.width}:${config.height},format=yuv420p`;
}

function buildSingleVideoFilter(
  probe: SourceProbe,
  aspectRatio: ClipAspectRatio,
  srtPath: string | null,
  captionPreset?: CaptionPreset | null,
  reframe?: ReframeSpec | null,
  studioEdits?: StudioEdits | null,
  clipDurationSec = 0,
) {
  const chain = [buildCropAndScaleFilter(probe, aspectRatio, reframe)];
  if (studioEdits?.textLayers.length) {
    chain.push(...buildTextLayerFilters(studioEdits.textLayers, clipDurationSec));
  }
  const subtitleFilter = buildSubtitleFilter(aspectRatio, srtPath, captionPreset);

  if (subtitleFilter) {
    chain.push(subtitleFilter);
  }

  return chain.filter(Boolean).join(",");
}

export function buildSingleVideoArgs(params: {
  sourcePath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  aspectRatio: ClipAspectRatio;
  probe: SourceProbe;
  srtPath: string | null;
  captionPreset?: CaptionPreset | null;
  logo?: LogoOverlay | null;
  reframe?: ReframeSpec | null;
  studioEdits?: StudioEdits | null;
  music?: MusicPlan | null;
  applyFreeTierTreatment?: boolean;
}) {
  const clipDurationSec = params.endSec - params.startSec;
  const videoFilter = buildSingleVideoFilter(
    params.probe,
    params.aspectRatio,
    params.srtPath,
    params.captionPreset,
    params.reframe,
    params.studioEdits,
    clipDurationSec,
  );

  let finalLabel: string;
  const filterParts: string[] = [];
  if (params.logo) {
    const aspectConfig = aspectRatioConfig.get(params.aspectRatio);
    if (!aspectConfig) {
      throw new WorkflowWorkerError(
        "unsupported_aspect_ratio",
        `Unsupported aspect ratio: ${params.aspectRatio}`,
      );
    }
    filterParts.push(`[0:v]${videoFilter}[outvbase]`);
    filterParts.push(
      buildLogoFilter(
        params.logo,
        aspectConfig.width,
        "[outvbase]",
        "[outv]",
        1,
        "",
      ),
    );
    finalLabel = "[outv]";
  } else {
    filterParts.push(`[0:v]${videoFilter}[outv]`);
    finalLabel = "[outv]";
  }

  finalLabel = appendTransitionFilter(
    filterParts,
    finalLabel,
    "[outvtransition]",
    params.studioEdits,
    clipDurationSec,
  );

  if (params.applyFreeTierTreatment) {
    filterParts.push(
      `${finalLabel}${buildFreeTierWatermarkFilter(FREE_TIER_WATERMARK_TEXT)}[outvfree]`,
    );
    finalLabel = "[outvfree]";
  }

  const args = [
    "-y",
    ...httpSourceInputArgs(params.sourcePath),
    "-ss",
    String(params.startSec),
    "-t",
    String(params.endSec - params.startSec),
    "-i",
    params.sourcePath,
  ];

  if (params.logo) {
    args.push("-i", params.logo.filePath);
  }

  if (params.music) {
    const musicInputIndex = params.logo ? 2 : 1;
    args.push("-stream_loop", "-1", "-i", params.music.path);
    filterParts.push(
      buildMusicAudioFilter({
        sourceHasAudio: params.probe.hasAudio,
        musicInputIndex,
        music: params.music,
        clipDurationSec,
        sourceAudio: params.studioEdits?.sourceAudio,
      }),
    );
  } else if (params.probe.hasAudio) {
    filterParts.push(
      `[0:a:0]${buildDialogueAudioFilter(params.studioEdits?.sourceAudio, clipDurationSec)}[outa]`,
    );
  }

  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    finalLabel,
    "-c:v",
    "libx264",
    "-preset",
    x264Preset(),
    "-crf",
    x264Crf(),
  );

  if (params.music) {
    args.push("-map", "[outa]", "-c:a", "aac", "-b:a", "128k", "-shortest");
  } else if (params.probe.hasAudio) {
    args.push("-map", "[outa]", "-c:a", "aac", "-b:a", "128k");
  } else {
    args.push("-an");
  }

  // Explicit output-duration bound: whatever the filter graph does upstream
  // (an over-long B-roll/music input, a framesync quirk, etc.), the encoded
  // output can never exceed the clip's own planned duration.
  args.push(
    "-t",
    clipDurationSec.toFixed(3),
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "1024",
    params.outputPath,
  );

  return args;
}

/**
 * Builds an ffmpeg single-output render that overlays 1-4 B-roll cutaways on
 * top of the (cropped/reframed) source, each within its own non-overlapping
 * time window, then burns captions and the logo on top. The source audio
 * plays throughout (B-roll is silent). Each cutaway gets its own input,
 * chained through successive `overlay` stages so multiple recurring inserts
 * compose correctly (a single cutaway is just the N=1 case of this).
 */
export function buildBrollVideoArgs(params: {
  sourcePath: string;
  cutaways: Array<{
    path: string;
    window: { startSec: number; endSec: number };
  }>;
  outputPath: string;
  startSec: number;
  endSec: number;
  aspectRatio: ClipAspectRatio;
  probe: SourceProbe;
  srtPath: string | null;
  captionPreset?: CaptionPreset | null;
  logo?: LogoOverlay | null;
  reframe?: ReframeSpec | null;
  studioEdits?: StudioEdits | null;
  music?: MusicPlan | null;
  applyFreeTierTreatment?: boolean;
}) {
  if (params.cutaways.length === 0) {
    throw new WorkflowWorkerError(
      "broll_cutaways_empty",
      "buildBrollVideoArgs requires at least one cutaway",
    );
  }

  const config = aspectRatioConfig.get(params.aspectRatio);
  if (!config) {
    throw new WorkflowWorkerError(
      "unsupported_aspect_ratio",
      `Unsupported aspect ratio: ${params.aspectRatio}`,
    );
  }
  const { width: W, height: H } = config;

  const cropScale =
    buildCropAndScaleFilter(params.probe, params.aspectRatio, params.reframe) ??
    `scale=${W}:${H},format=yuv420p`;
  const subtitleFilter = buildSubtitleFilter(
    params.aspectRatio,
    params.srtPath,
    params.captionPreset,
  );

  const cutawayCount = params.cutaways.length;
  const logoInputIndex = 1 + cutawayCount;
  const clipDurationSec = params.endSec - params.startSec;

  const parts: string[] = [`[0:v]${cropScale}[stage0]`];
  let finalLabel = "[stage0]";

  params.cutaways.forEach((cutaway, index) => {
    const brollInputIndex = 1 + index; // input 0 is the source
    const start = cutaway.window.startSec;
    const end = cutaway.window.endSec;
    const brollLabel = `[broll${index}]`;
    const nextStageLabel = `[stage${index + 1}]`;
    parts.push(
      // Cover-fit this cutaway's B-roll to the frame and delay it to begin at
      // its own window's start.
      `[${brollInputIndex}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=PTS-STARTPTS+${start}/TB,format=yuv420p${brollLabel}`,
    );
    parts.push(
      `${finalLabel}${brollLabel}overlay=0:0:enable='between(t,${start},${end})'${nextStageLabel}`,
    );
    finalLabel = nextStageLabel;
  });

  if (params.studioEdits?.textLayers.length) {
    const textFilters = buildTextLayerFilters(
      params.studioEdits.textLayers,
      clipDurationSec,
    ).join(",");
    parts.push(`${finalLabel}${textFilters}[texted]`);
    finalLabel = "[texted]";
  }
  if (subtitleFilter) {
    parts.push(`${finalLabel}${subtitleFilter}[subbed]`);
    finalLabel = "[subbed]";
  }
  if (params.logo) {
    parts.push(
      buildLogoFilter(params.logo, W, finalLabel, "[outv]", logoInputIndex, ""),
    );
    finalLabel = "[outv]";
  }

  finalLabel = appendTransitionFilter(
    parts,
    finalLabel,
    "[outvtransition]",
    params.studioEdits,
    clipDurationSec,
  );

  if (params.applyFreeTierTreatment) {
    parts.push(
      `${finalLabel}${buildFreeTierWatermarkFilter(FREE_TIER_WATERMARK_TEXT)}[outvfree]`,
    );
    finalLabel = "[outvfree]";
  }

  const args = [
    "-y",
    ...httpSourceInputArgs(params.sourcePath),
    "-ss",
    String(params.startSec),
    "-t",
    String(params.endSec - params.startSec),
    "-i",
    params.sourcePath,
  ];

  for (const cutaway of params.cutaways) {
    // Each B-roll input gets its own `-t`, scoped to just this input (ffmpeg
    // resets per-input options at each `-i`), sized to exactly its own
    // cutaway window. Without this, `overlay` runs until the *longer* of its
    // two inputs finishes (shortest defaults to 0), so any B-roll asset
    // longer than its window silently stretched the whole rendered output
    // past its own planned end (frozen final frame, silent audio) — trimming
    // here means each B-roll stream can never outlast its own window.
    const windowDurationSec = Math.max(
      0.1,
      cutaway.window.endSec - cutaway.window.startSec,
    );
    args.push("-t", windowDurationSec.toFixed(3), "-i", cutaway.path);
  }

  if (params.logo) args.push("-i", params.logo.filePath);

  if (params.music) {
    const musicInputIndex = 1 + cutawayCount + (params.logo ? 1 : 0);
    args.push("-stream_loop", "-1", "-i", params.music.path);
    parts.push(
      buildMusicAudioFilter({
        sourceHasAudio: params.probe.hasAudio,
        musicInputIndex,
        music: params.music,
        clipDurationSec,
        sourceAudio: params.studioEdits?.sourceAudio,
      }),
    );
  } else if (params.probe.hasAudio) {
    parts.push(
      `[0:a:0]${buildDialogueAudioFilter(params.studioEdits?.sourceAudio, clipDurationSec)}[outa]`,
    );
  }

  args.push("-filter_complex", parts.join(";"), "-map", finalLabel);

  if (params.music) {
    args.push("-map", "[outa]", "-c:a", "aac", "-b:a", "128k", "-shortest");
  } else if (params.probe.hasAudio) {
    args.push("-map", "[outa]", "-c:a", "aac", "-b:a", "128k");
  } else {
    args.push("-an");
  }

  // Belt-and-suspenders output-duration bound (see buildSingleVideoArgs):
  // even with every B-roll input now trimmed, this guarantees the encoded
  // output can never exceed the clip's own planned duration.
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    x264Preset(),
    "-crf",
    x264Crf(),
    "-t",
    clipDurationSec.toFixed(3),
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "1024",
    params.outputPath,
  );

  return args;
}

interface DownloadUrlToFileTestOverrides {
  fetchImpl?: GuardedFetchOptions["fetchImpl"];
  resolver?: GuardedFetchOptions["resolver"];
  /** Overrides REMOTE_MEDIA_MAX_BYTES so the size-cap path can be tested
   *  without allocating hundreds of MB. Production call sites never pass it. */
  maxBytes?: number;
  /** Overrides REMOTE_MEDIA_DOWNLOAD_TIMEOUT_MS so the timeout path can be
   *  tested in milliseconds instead of 45s. Production call sites never pass it. */
  timeoutMs?: number;
}

/**
 * Downloads a remote B-roll/music asset to disk. Streams to disk (never
 * buffers the whole body in memory), enforces a bounded timeout and max size,
 * and validates every redirect hop — a raw `fetch` + `arrayBuffer()` here
 * previously let a single hostile URL OOM the worker or pin a worker slot for
 * up to the full reaper window. Callers are expected to catch and treat any
 * failure as "no B-roll/music" — a bad remote asset must never fail the whole
 * clip render.
 *
 * `testOverrides` is exposed (and this function exported) purely so tests can
 * inject a fake `fetchImpl`/`resolver`/`maxBytes` the same way
 * `packages/services`'s own `guardedFetch` tests do — production call sites
 * never pass it.
 */
export async function downloadUrlToFile(
  url: string,
  filePath: string,
  errorCode = "remote_media_download_failed",
  testOverrides?: DownloadUrlToFileTestOverrides,
): Promise<void> {
  const maxBytes = testOverrides?.maxBytes ?? REMOTE_MEDIA_MAX_BYTES;
  const timeoutMs = testOverrides?.timeoutMs ?? REMOTE_MEDIA_DOWNLOAD_TIMEOUT_MS;
  let response: Response;
  try {
    response = await guardedFetch(url, {
      timeoutMs,
      fetchImpl: testOverrides?.fetchImpl,
      resolver: testOverrides?.resolver,
    });
  } catch (error) {
    throw new WorkflowWorkerError(
      errorCode,
      `Remote media fetch failed: ${describeRemoteFetchError(error)}`,
    );
  }

  try {
    if (!response.ok || !response.body) {
      throw new WorkflowWorkerError(
        errorCode,
        `Remote media download failed with status ${response.status}`,
      );
    }

    try {
      assertResponseContentLength(response, maxBytes);
    } catch {
      throw new WorkflowWorkerError(
        errorCode,
        `Remote media declared size exceeds the ${maxBytes}-byte limit`,
      );
    }

    await pipeline(
      Readable.fromWeb(
        response.body as unknown as import("node:stream/web").ReadableStream,
      ),
      createByteLimitTransform(maxBytes),
      createWriteStream(filePath),
    );
  } catch (error) {
    if (error instanceof WorkflowWorkerError) {
      throw error;
    }
    throw new WorkflowWorkerError(
      errorCode,
      `Remote media download failed: ${describeRemoteFetchError(error)}`,
    );
  } finally {
    if (response.body && !response.body.locked) {
      await response.body.cancel().catch(() => undefined);
    }
  }
}

function describeRemoteFetchError(error: unknown): string {
  if (error instanceof RemoteFetchError) return error.code;
  if (error instanceof UnsafeUrlError) return error.message;
  if (error instanceof Error) return error.message;
  return "unknown";
}

export function buildMultiVideoArgs(params: {
  sourcePath: string;
  outputs: PendingRenderOutput[];
  startSec: number;
  endSec: number;
  probe: SourceProbe;
  srtPath: string | null;
  captionPreset?: CaptionPreset | null;
  logo?: LogoOverlay | null;
  applyFreeTierTreatment?: boolean;
}) {
  const clipDurationSec = params.endSec - params.startSec;
  const splitOutputs = params.outputs
    .map((_, index) => `[v${index}]`)
    .join("");

  const baseSections = [
    `[0:v]split=${params.outputs.length}${splitOutputs}`,
    ...params.outputs.map((output, index) => {
      const subtitlePath = output.subtitlePath ?? params.srtPath;
      const singleFilter = buildSingleVideoFilter(
        params.probe,
        output.aspectRatio,
        subtitlePath,
        params.captionPreset,
        output.reframe,
      );
      const baseLabel = params.logo ? `[outvbase${index}]` : `[outv${index}]`;
      return `[v${index}]${singleFilter}${baseLabel}`;
    }),
  ];

  const filterSections = [...baseSections];

  if (params.logo) {
    const logo = params.logo;
    const logoOpacity = Math.max(0.1, Math.min(1, logo.opacity / 100));
    const { x, y } = buildLogoOverlayPosition(logo.position);

    // Pre-process logo once (alpha-blend), then split into N branches and scale
    // each branch to that output's target video width.
    const logoSplitRefs = params.outputs
      .map((_, index) => `[logosrc${index}]`)
      .join("");
    filterSections.push(
      `[1:v]format=rgba,colorchannelmixer=aa=${logoOpacity.toFixed(3)},split=${params.outputs.length}${logoSplitRefs}`,
    );

    for (const [index, output] of params.outputs.entries()) {
      const aspectConfig = aspectRatioConfig.get(output.aspectRatio);
      if (!aspectConfig) {
        throw new WorkflowWorkerError(
          "unsupported_aspect_ratio",
          `Unsupported aspect ratio: ${output.aspectRatio}`,
        );
      }
      const targetWidth = computeLogoTargetWidth(logo, aspectConfig.width);
      filterSections.push(
        `[logosrc${index}]scale=${targetWidth}:-1[logo${index}]`,
        `[outvbase${index}][logo${index}]overlay=${x}:${y}[outv${index}]`,
      );
    }
  }

  // Per-output final label, overridden below when the free-tier watermark
  // needs to be folded in for that output.
  const finalLabels = params.outputs.map((_, index) => `[outv${index}]`);

  if (params.applyFreeTierTreatment) {
    for (const index of params.outputs.keys()) {
      filterSections.push(
        `${finalLabels[index]}${buildFreeTierWatermarkFilter(FREE_TIER_WATERMARK_TEXT)}[outvfree${index}]`,
      );
      finalLabels[index] = `[outvfree${index}]`;
    }
  }

  const args = [
    "-y",
    ...httpSourceInputArgs(params.sourcePath),
    "-ss",
    String(params.startSec),
    "-t",
    String(params.endSec - params.startSec),
    "-i",
    params.sourcePath,
  ];

  if (params.logo) {
    args.push("-i", params.logo.filePath);
  }

  if (params.probe.hasAudio) {
    const audioSplits = params.outputs.map((_, i) => `[aud${i}]`).join("");
    filterSections.push(
      `[0:a:0]asplit=${params.outputs.length}${audioSplits}`,
      ...params.outputs.map(
        (_, i) => `[aud${i}]${buildAudioFadeChain(clipDurationSec)}[outa${i}]`,
      ),
    );
  }

  args.push("-filter_complex", filterSections.join(";"));

  for (const [index, output] of params.outputs.entries()) {
    args.push("-map", finalLabels[index]!);

    if (params.probe.hasAudio) {
      args.push("-map", `[outa${index}]`, "-c:a", "aac", "-b:a", "128k");
    } else {
      args.push("-an");
    }

    // Explicit output-duration bound — see buildSingleVideoArgs.
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      x264Preset(),
      "-crf",
      x264Crf(),
      "-t",
      clipDurationSec.toFixed(3),
      "-movflags",
      "+faststart",
      "-max_muxing_queue_size",
      "1024",
      output.outputPath,
    );
  }

  return args;
}

/**
 * Renders an "audiogram" for audio-only sources (podcasts): an animated
 * waveform over a solid background with burned captions — instead of a black
 * screen. The waveform color follows the caption preset's highlight color.
 */
export function buildAudiogramArgs(params: {
  sourcePath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  aspectRatio: ClipAspectRatio;
  clipDurationSec: number;
  srtPath: string | null;
  captionPreset?: CaptionPreset | null;
  studioEdits?: StudioEdits | null;
  music?: MusicPlan | null;
  applyFreeTierTreatment?: boolean;
}) {
  const config = aspectRatioConfig.get(params.aspectRatio);

  if (!config) {
    throw new WorkflowWorkerError(
      "unsupported_aspect_ratio",
      `Unsupported aspect ratio: ${params.aspectRatio}`,
    );
  }

  const { width: W, height: H } = config;
  const bgColor = "0x0F172A";
  const waveColor = hexToFfmpegRgb(
    params.captionPreset?.highlightColor ?? "#00FF88",
  );
  const waveHeight = Math.round(H * 0.42);
  const subtitleFilter = buildSubtitleFilter(
    params.aspectRatio,
    params.srtPath,
    params.captionPreset,
  );

  const chain: string[] = params.music
    ? [
        `color=c=${bgColor}:s=${W}x${H}:d=${params.clipDurationSec}[bg]`,
        `[0:a]showwaves=s=${W}x${waveHeight}:mode=cline:colors=${waveColor}:rate=25[wave]`,
        `[bg][wave]overlay=0:(H-h)/2[comp]`,
      ]
    : [
        `color=c=${bgColor}:s=${W}x${H}:d=${params.clipDurationSec}[bg]`,
        // Split the audio so one branch drives the waveform and the other is
        // faded and mapped as the output track.
        `[0:a]asplit=2[wavesrc][fadesrc]`,
        `[wavesrc]showwaves=s=${W}x${waveHeight}:mode=cline:colors=${waveColor}:rate=25[wave]`,
        `[fadesrc]${buildDialogueAudioFilter(params.studioEdits?.sourceAudio, params.clipDurationSec)}[outa]`,
        `[bg][wave]overlay=0:(H-h)/2[comp]`,
      ];

  let finalLabel = "[comp]";
  if (params.studioEdits?.textLayers.length) {
    const textFilters = buildTextLayerFilters(
      params.studioEdits.textLayers,
      params.clipDurationSec,
    ).join(",");
    chain.push(`${finalLabel}${textFilters}[texted]`);
    finalLabel = "[texted]";
  }
  if (subtitleFilter) {
    chain.push(`${finalLabel}${subtitleFilter}[subbed]`);
    finalLabel = "[subbed]";
  }
  chain.push(`${finalLabel}format=yuv420p[outv]`);

  let videoOutputLabel = appendTransitionFilter(
    chain,
    "[outv]",
    "[outvtransition]",
    params.studioEdits,
    params.clipDurationSec,
  );

  if (params.applyFreeTierTreatment) {
    chain.push(
      `${videoOutputLabel}${buildFreeTierWatermarkFilter(FREE_TIER_WATERMARK_TEXT)}[outvfree]`,
    );
    videoOutputLabel = "[outvfree]";
  }

  const args = [
    "-y",
    ...httpSourceInputArgs(params.sourcePath),
    "-ss",
    String(params.startSec),
    "-t",
    String(params.endSec - params.startSec),
    "-i",
    params.sourcePath,
  ];

  if (params.music) {
    args.push("-stream_loop", "-1", "-i", params.music.path);
    chain.push(
      buildMusicAudioFilter({
        sourceHasAudio: true,
        musicInputIndex: 1,
        music: params.music,
        clipDurationSec: params.clipDurationSec,
        sourceAudio: params.studioEdits?.sourceAudio,
      }),
    );
  }

  args.push(
    "-filter_complex",
    chain.join(";"),
    "-map",
    videoOutputLabel,
  );

  args.push("-map", "[outa]");

  // -shortest (existing) already bounds this to the shorter of video/audio;
  // -t is a belt-and-suspenders explicit bound (see buildSingleVideoArgs).
  args.push(
    "-shortest",
    "-t",
    params.clipDurationSec.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    x264Preset(),
    "-crf",
    x264Crf(),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "1024",
    params.outputPath,
  );

  return args;
}

const FREE_TIER_WATERMARK_TEXT = "Made with Narriflow";

/**
 * Escapes a literal string for use as a drawtext `text` value inside a
 * filtergraph. Two escaping levels apply (see ffmpeg-utils "Quoting and
 * escaping" + filter docs): first the option value (`\`, `'`, `:`, `%` for
 * drawtext expansion), then the filtergraph parser (`\`, `'`, `,`, `;`,
 * `[`, `]`). Verified against ffmpeg 8 — quoting the value instead breaks
 * on embedded `'`.
 */
export function escapeDrawtextText(text: string): string {
  const optionLevel = text.replace(/[\\':%]/g, (char) => `\\${char}`);
  return optionLevel.replace(/[\\',;[\]]/g, (char) => `\\${char}`);
}

/**
 * Builds the free-tier export treatment as a filter-chain fragment (2/3
 * downscale, 1080p-class → 720p-class, plus a corner watermark) — meant to be
 * appended to the *end* of an already-built video filter chain (after
 * crop/scale/captions/logo/transition) so the whole render is a single
 * encode. Folded into each `build*Args` builder via `applyFreeTierTreatment`.
 */
function buildFreeTierWatermarkFilter(
  watermarkText: string,
  fontFilePath?: string | null,
): string {
  const drawtextOptions = [
    `text=${escapeDrawtextText(watermarkText)}`,
    "fontcolor=white@0.85",
    "borderw=2",
    "bordercolor=black@0.6",
    "fontsize=h/28",
    "x=w-tw-h/40",
    "y=h/40",
  ];

  if (fontFilePath) {
    drawtextOptions.push(`fontfile=${fontFilePath}`);
  }

  return [
    "scale=trunc(iw*2/3/2)*2:trunc(ih*2/3/2)*2",
    `drawtext=${drawtextOptions.join(":")}`,
  ].join(",");
}

/**
 * Free-tier export treatment as a standalone single-input ffmpeg pass. No
 * longer used by the render pipeline itself (see `applyFreeTierTreatment` on
 * each `build*Args` builder, which folds this same filter into the main
 * encode instead of re-encoding a second time) — kept as a tested, reusable
 * utility for the same transformation applied to an already-rendered file.
 */
export function buildFreeTierPostProcessArgs(params: {
  inputPath: string;
  outputPath: string;
  watermarkText: string; // e.g. "Made with Narriflow"
  fontFilePath?: string | null;
}): string[] {
  const filter = buildFreeTierWatermarkFilter(
    params.watermarkText,
    params.fontFilePath,
  );

  return [
    "-y",
    "-i",
    params.inputPath,
    "-vf",
    filter,
    "-c:v",
    "libx264",
    "-preset",
    x264Preset(),
    "-crf",
    x264Crf(),
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "1024",
    params.outputPath,
  ];
}

async function uploadRenderedOutput(params: {
  workflowRunId: string;
  projectId: string;
  output: PendingRenderOutput;
  clipDurationSec: number;
  applyFreeTierTreatment: boolean;
  /** Compact JSON-encoded Pexels attribution for any B-roll used in this
   *  render, so crediting is possible after the fact. There's no dedicated
   *  DB column reachable without a migration or editing clip.service.ts (out
   *  of scope here) — object storage metadata is the persistence mechanism
   *  this task owns end-to-end. See the B-roll upgrade report for the exact
   *  `Clip.brollAttribution Json?` follow-up if durable, per-clip-queryable
   *  attribution is wanted later. */
  brollCredits?: string | null;
  /** Wall-clock of the ffmpeg encode that produced this output. For the
   *  shared multi-output encode the same value is reported for every output
   *  it covered. */
  encodeMs?: number;
}): Promise<boolean> {
  if (params.applyFreeTierTreatment) {
    // The watermark + 720p-class downscale are folded directly into the main
    // render's filtergraph now (see `applyFreeTierTreatment` on each
    // build*Args builder) — the single required encode already produced the
    // treated output, so a failure to apply it already failed the whole clip
    // render upstream (no separate pass to fail here). This just verifies the
    // output landed at the expected resolution; if the probe itself throws,
    // it propagates like any other failure in this function and fails the
    // variant (caught by the caller).
    const treatedProbe = await probeSource(params.output.outputPath);
    log("info", "free_tier_export_treatment", {
      workflowRunId: params.workflowRunId,
      clipId: params.output.clipId,
      width: treatedProbe.width,
      height: treatedProbe.height,
    });
  }

  const outputStat = await stat(params.output.outputPath);

  const uploadStartedAtMs = Date.now();
  await putFileFromPath({
    key: params.output.storageKey,
    filePath: params.output.outputPath,
    contentType: "video/mp4",
    metadata: {
      project_id: params.projectId,
      clip_id: params.output.clipId,
      workflow_run_id: params.workflowRunId,
      format: params.output.aspectRatio,
      ...(params.brollCredits ? { broll_credits: params.brollCredits } : {}),
    },
  });
  const uploadMs = Date.now() - uploadStartedAtMs;

  const { persisted } = await clipService.completeClipRenderVariant(
    params.output.clipRenderId,
    {
      storageKey: params.output.storageKey,
      sizeBytes: Number(outputStat.size),
      durationSec: params.clipDurationSec,
    },
  );

  if (!persisted) {
    // The ClipRender row this attempt was rendering for is gone — an editor
    // save/reset invalidated it (deleted the row) while this encode was in
    // flight. The storage key is attempt-unique (clipRenderAttemptStorageKey),
    // so this object can never be the one any other row points at; deleting
    // it is always safe and never touches another attempt's bytes.
    await deleteObject(params.output.storageKey).catch(() => {});
    log("info", "clip_render_variant_completion_stale_discarded", {
      workflowRunId: params.workflowRunId,
      clipId: params.output.clipId,
      clipRenderId: params.output.clipRenderId,
      aspectRatio: params.output.aspectRatio,
    });
    return false;
  }

  log("info", "clip_render_variant_completed", {
    workflowRunId: params.workflowRunId,
    clipId: params.output.clipId,
    clipRenderId: params.output.clipRenderId,
    clipIndex: params.output.clipIndex,
    aspectRatio: params.output.aspectRatio,
    sizeBytes: Number(outputStat.size),
    uploadMs,
    ...(params.encodeMs !== undefined ? { encodeMs: params.encodeMs } : {}),
  });
  return true;
}

export async function processClipRenderingRun(run: WorkflowRunJob) {
  if (!run.project.sourceStorageKey) {
    await projectService.failClipRenderingWorkflowRun(
      run.id,
      "source_storage_key_missing",
    );
    log("error", "clip_rendering_run_failed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      code: "source_storage_key_missing",
    });
    await notifyWorkflowFailureAfterSettlement({
      workflowRunId: run.id,
      projectId: run.projectId,
      errorCode: "source_storage_key_missing",
      reason: "The project source file is unavailable.",
      autoRenderOnly: true,
    });
    return;
  }

  // Free-tier exports get a watermark + 720p cap; every paid tier (starter,
  // creator, pro) ships untouched 1080p renders. Looked up once per run.
  const ownerTier = await projectService.getUserPricingTier(
    run.project.userId,
  );
  const applyFreeTierTreatment = ownerTier === "free";

  const runStartedAtMs = Date.now();
  log("info", "clip_rendering_run_started", {
    workflowRunId: run.id,
    projectId: run.projectId,
    ownerTier,
  });

  const tempDir = await mkdtemp(join(tmpdir(), "narriflow-render-"));
  // Captured outside the try so the failure path can hand exactly this
  // attempt's variant ids to failClipRenderingWorkflowRun (see
  // all_clip_renders_failed below).
  let attemptVariantIds: string[] = [];

  try {
    const sourceExt = extname(run.project.sourceStorageKey) || ".bin";
    const localSourcePath = join(tempDir, `source${sourceExt}`);

    // `sourcePath` is what every ffmpeg builder receives as input: a presigned
    // URL in ranged mode (see RENDER_SOURCE_URL_TTL_SEC above), or the local
    // download in fallback/download mode. All builders seek with -ss before
    // -i, so both forms behave identically apart from what gets transferred.
    let sourcePath: string | null = null;
    let probe: SourceProbe | null = null;

    const configuredSourceMode = process.env.WORKER_RENDER_SOURCE_MODE;
    if (
      configuredSourceMode &&
      configuredSourceMode !== "ranged" &&
      configuredSourceMode !== "download"
    ) {
      log("error", "clip_rendering_unknown_source_mode", {
        workflowRunId: run.id,
        configuredSourceMode,
        effectiveMode: "ranged",
      });
    }

    if (configuredSourceMode !== "download") {
      try {
        const presignedUrl = await presignDownloadUrl({
          key: run.project.sourceStorageKey,
          expiresIn: RENDER_SOURCE_URL_TTL_SEC,
        });
        probe = await probeSource(presignedUrl);
        sourcePath = presignedUrl;
        log("info", "clip_rendering_source_mode", {
          workflowRunId: run.id,
          projectId: run.projectId,
          mode: "ranged",
        });
      } catch (error) {
        log("error", "clip_rendering_ranged_source_fallback", {
          workflowRunId: run.id,
          projectId: run.projectId,
          message: error instanceof Error ? error.message : "unknown",
        });
        sourcePath = null;
        probe = null;
      }
    }

    if (sourcePath === null || probe === null) {
      try {
        await downloadObjectToFile({
          key: run.project.sourceStorageKey,
          filePath: localSourcePath,
        });
      } catch (error) {
        throw new WorkflowWorkerError(
          "source_download_failed",
          `Failed to download source: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
      sourcePath = localSourcePath;
      probe = await probeSource(sourcePath);
    }

    log("info", "clip_rendering_source_probed", {
      workflowRunId: run.id,
      width: probe.width,
      height: probe.height,
      hasVideo: probe.hasVideo,
      hasAudio: probe.hasAudio,
    });

    let brandLogo: LogoOverlay | null = null;
    try {
      const rawSnapshot = await projectService.getProjectBrandSnapshot(run.projectId);
      if (rawSnapshot) {
        const snapshot = brandTemplateSnapshotSchema.parse(rawSnapshot);
        if (snapshot.logoStorageKey && probe.hasVideo) {
          const logoExt = extname(snapshot.logoStorageKey) || ".png";
          const logoPath = join(tempDir, `brand-logo${logoExt}`);
          try {
            await downloadObjectToFile({
              key: snapshot.logoStorageKey,
              filePath: logoPath,
            });
            brandLogo = {
              filePath: logoPath,
              position: snapshot.logoPosition,
              opacity: snapshot.logoOpacity,
              scalePct: snapshot.logoScalePct,
            };
          } catch (logoError) {
            log("error", "brand_logo_download_failed", {
              workflowRunId: run.id,
              projectId: run.projectId,
              key: snapshot.logoStorageKey,
              message:
                logoError instanceof Error ? logoError.message : "unknown",
            });
          }
        }
      }
    } catch (snapshotError) {
      log("error", "brand_snapshot_parse_failed", {
        workflowRunId: run.id,
        projectId: run.projectId,
        message:
          snapshotError instanceof Error ? snapshotError.message : "unknown",
      });
    }

    const pendingRenders = await clipService.getPendingClipRendersForProject(
      run.projectId,
    );

    if (pendingRenders.length === 0) {
      throw new WorkflowWorkerError(
        "no_renderable_clips",
        "No clip render variants with status=pending found",
      );
    }

    attemptVariantIds = pendingRenders.map((render) => render.id);

    const rendersByClipId = new Map<string, typeof pendingRenders>();

    for (const render of pendingRenders) {
      const existing = rendersByClipId.get(render.clipId) ?? [];
      existing.push(render);
      rendersByClipId.set(render.clipId, existing);
    }

    const clipGroups = [...rendersByClipId.values()].sort(
      (left, right) => left[0]!.clip.index - right[0]!.clip.index,
    );

    await projectService.publishWorkflowProgress({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "clip_rendering",
      status: "running",
      progress: 10,
      errorCode: null,
    });

    let renderedVariantCount = 0;

    for (let clipGroupIndex = 0; clipGroupIndex < clipGroups.length; clipGroupIndex++) {
      const renderGroup = clipGroups[clipGroupIndex]!;
      const clip = renderGroup[0]!.clip;
      const rawUtterances = clip.transcriptSlice as unknown as TranscriptUtterance[];
      const effective = resolveRenderTimingForClip({
        llmModel: clip.llmModel,
        utterances: rawUtterances,
        startSec: clip.startSec,
        endSec: clip.endSec,
      });
      const clipStartSec = effective.startSec;
      const clipEndSec = effective.endSec;
      const clipDurationSec = effective.durationSec;
      const utterances = effective.transcriptSlice;
      // Resilient parse: a single malformed stored caption JSON must not crash
      // the whole render group — fall back to no preset (plain SRT) instead.
      let captionPreset: CaptionPreset | null = null;
      if (clip.captionPreset) {
        const parsedPreset = captionPresetSchema.nullable().safeParse(
          clip.captionPreset,
        );
        if (parsedPreset.success) {
          captionPreset = parsedPreset.data;
        } else {
          log("error", "clip_caption_preset_parse_failed", {
            workflowRunId: run.id,
            clipId: clip.id,
            message: parsedPreset.error.issues[0]?.message ?? "invalid preset",
          });
        }
      }

      let studioEdits: StudioEdits = studioEditsSchema.parse({});
      if (clip.studioEdits) {
        const parsedEdits = studioEditsSchema.safeParse(clip.studioEdits);
        if (parsedEdits.success) {
          studioEdits = parsedEdits.data;
        } else {
          log("error", "clip_studio_edits_parse_failed", {
            workflowRunId: run.id,
            clipId: clip.id,
            message: parsedEdits.error.issues[0]?.message ?? "invalid edits",
          });
        }
      }

      // Per-clip effective logo: this clip's studioEdits.logo override
      // merged over the project-wide brandLogo (frozen snapshot + already
      // -downloaded file). `null` whenever there's no logo asset at all, or
      // this clip's override disables it.
      const logo = resolveClipLogoOverlay(brandLogo, studioEdits.logo);

      // ASS is the authoritative path and is used whenever a preset is present
      // (it carries per-word highlight, box, glow, position and animation so the
      // export matches the studio preview). SRT is only a no-preset fallback.
      let srtPath: string | null = null;
      if (!captionPreset && utterances.length > 0) {
        const srtContent = generateSrtFromSlice(utterances, clipStartSec);
        if (srtContent.length > 0) {
          srtPath = join(tempDir, `clip-${clip.id}.srt`);
          await writeFile(srtPath, srtContent, "utf-8");
        }
      }

      const outputs: PendingRenderOutput[] = renderGroup.map((render) => {
        const aspectRatio = clipAspectRatioFromDb[
          clipAspectRatioDbSchema.parse(render.aspectRatio)
        ];
        const slug =
          clipAspectRatioOptions.find((option) => option.value === aspectRatio)
            ?.slug ?? "9x16";

        return {
          clipRenderId: render.id,
          clipId: clip.id,
          clipIndex: clip.index,
          aspectRatio,
          outputPath: join(tempDir, `clip-${clip.id}-${slug}.mp4`),
          storageKey: clipRenderAttemptStorageKey(
            run.projectId,
            clip.id,
            slug,
            randomUUID(),
          ),
        };
      });

      // Per-aspect-ratio ASS files carry the full styled, word-synced captions.
      // Generated whenever a caption preset is present (positions are resolution
      // dependent, so one file per output).
      if (captionPreset && utterances.length > 0) {
        for (const output of outputs) {
          const assContent = generateAssFromSlice(
            utterances,
            clipStartSec,
            output.aspectRatio,
            captionPreset,
          );
          if (assContent.length > 0) {
            const assPath = join(
              tempDir,
              `clip-${clip.id}-${output.aspectRatio.replace(":", "x")}.ass`,
            );
            await writeFile(assPath, assContent, "utf-8");
            output.subtitlePath = assPath;
          }
        }
      }

      // Auto-reframe: for landscape sources cropped to a narrower ratio, detect
      // the speaker's face path once per clip and drive each portrait output's
      // crop x via sendcmd so the framing follows the speaker. Falls back to a
      // static center crop if python/opencv/model is unavailable or no face.
      const reframeEnabled = process.env.WORKER_AUTO_REFRAME !== "0";
      const srcRatio =
        probe.hasVideo && probe.height > 0 ? probe.width / probe.height : 0;
      const reframeOutputs = outputs.filter((output) => {
        const cfg = aspectRatioConfig.get(output.aspectRatio);
        if (!cfg) return false;
        const targetRatio = cfg.width / cfg.height;
        return (
          srcRatio >= targetRatio &&
          Math.round(probe.height * targetRatio) < probe.width
        );
      });

      if (reframeEnabled && srcRatio > 1.05 && reframeOutputs.length > 0) {
        // The YuNet detector (python3 + OpenCV) needs a frame-accurate local
        // file. In ranged mode, cut a low-res re-encoded segment of just this
        // clip's window (re-encode, not -c copy: a stream copy snaps to the
        // previous keyframe and would shift every face sample by up to a GOP).
        // Face centers are returned normalized, so 360p detection maps to the
        // full-res crop math unchanged. On any extraction failure just skip
        // detection — callers already fall back to a static center crop.
        let detectInput: string | null = sourcePath;
        let detectStartSec = clipStartSec;
        if (isHttpSource(sourcePath)) {
          const segmentPath = join(tempDir, `face-seg-${clip.id}.mp4`);
          try {
            await execCommand("ffmpeg", [
              "-y",
              ...httpSourceInputArgs(sourcePath),
              "-ss",
              String(clipStartSec),
              "-t",
              String(clipDurationSec),
              "-i",
              sourcePath,
              "-map",
              "0:v:0",
              "-vf",
              "scale=-2:360",
              "-c:v",
              "libx264",
              "-preset",
              "ultrafast",
              "-crf",
              "30",
              "-an",
              segmentPath,
            ]);
            detectInput = segmentPath;
            detectStartSec = 0;
          } catch (segmentError) {
            log("error", "clip_reframe_segment_extract_failed", {
              workflowRunId: run.id,
              clipId: clip.id,
              message:
                segmentError instanceof Error
                  ? segmentError.message
                  : "unknown",
            });
            detectInput = null;
          }
        }
        const detection = detectInput
          ? await detectFacePath({
              sourcePath: detectInput,
              startSec: detectStartSec,
              durationSec: clipDurationSec,
            })
          : null;
        const smoothed = detection ? smoothFacePath(detection.samples) : [];
        if (smoothed.length > 0) {
          const single = outputs.length === 1;
          for (let i = 0; i < outputs.length; i++) {
            const output = outputs[i]!;
            if (!reframeOutputs.includes(output)) continue;
            const cfg = aspectRatioConfig.get(output.aspectRatio)!;
            const cropW = Math.round(probe.height * (cfg.width / cfg.height));
            const cropName = single
              ? REFRAME_CROP_NAME
              : `${REFRAME_CROP_NAME}${i}`;
            const script = buildReframeSendcmdScript(
              smoothed,
              probe.width,
              cropW,
              cropName,
            );
            if (!script) continue;
            const scriptPath = join(
              tempDir,
              `reframe-${clip.id}-${output.aspectRatio.replace(":", "x")}.txt`,
            );
            await writeFile(scriptPath, script, "utf-8");
            output.reframe = { scriptPath, cropName };
          }
          log("info", "clip_reframe_applied", {
            workflowRunId: run.id,
            clipId: clip.id,
            outputs: outputs
              .filter((o) => o.reframe)
              .map((o) => o.aspectRatio),
          });
        }
      }

      // Stock B-roll: when a Pexels key is set, plan 2-4 recurring cutaways
      // (driven by the detection LLM's cues when present on the clip, else
      // the keyword-derived query spaced evenly across the clip) — a single
      // cutaway reads as accidental and is a known quality complaint about
      // competitors. Best-effort: any failure renders normally without
      // B-roll. The studio picker's explicit choice, when present, always
      // wins and stays a single cutaway — a user who hand-picked one asset
      // didn't ask to see it repeated.
      let brollPlan: BrollPlan | null = null;
      const brollEnabled =
        Boolean(process.env.PEXELS_API_KEY) && process.env.WORKER_BROLL !== "0";
      const userBrollUrl = clip.brollUrl ?? null;
      if (
        (brollEnabled || userBrollUrl) &&
        probe.hasVideo &&
        clipDurationSec >= 12
      ) {
        let safeUserBrollUrl: string | null = null;
        if (userBrollUrl) {
          try {
            assertPublicHttpUrl(userBrollUrl);
            safeUserBrollUrl = userBrollUrl;
          } catch (error) {
            log("error", "clip_broll_url_rejected", {
              workflowRunId: run.id,
              clipId: clip.id,
              reason:
                error instanceof UnsafeUrlError ? error.reason : "unknown",
            });
          }
        }

        if (safeUserBrollUrl) {
          const brollPath = join(tempDir, `broll-${clip.id}-manual.mp4`);
          try {
            await downloadUrlToFile(
              safeUserBrollUrl,
              brollPath,
              "broll_download_failed",
            );

            // A manual pick has no reported duration — probe the downloaded
            // file so the cutaway window (and therefore the B-roll input's
            // own -t trim in buildBrollVideoArgs) is sized against real
            // footage rather than a guess.
            const effectiveDurationSec = await probeMediaDurationSec(brollPath);
            const window =
              effectiveDurationSec !== null
                ? planBrollWindow(clipDurationSec, effectiveDurationSec)
                : null;

            if (window) {
              brollPlan = { cutaways: [{ path: brollPath, window }], credits: [] };
              log("info", "clip_broll_selected", {
                workflowRunId: run.id,
                clipId: clip.id,
                source: "studio_pick",
                cutawayCount: 1,
                brollDurationSec: effectiveDurationSec,
              });
            }
          } catch (error) {
            brollPlan = null;
            log("error", "clip_broll_prepare_failed", {
              workflowRunId: run.id,
              clipId: clip.id,
              source: "studio_pick",
              message: error instanceof Error ? error.message : "unknown",
            });
          }
        } else {
          // Auto path: consume LLM-provided cues when the clip carries them
          // (optional column — absent on existing rows and any clip not yet
          // produced by a detect-clips.ts that writes it), else fall back to
          // the keyword-derived query for every auto-placed slot.
          const rawBrollCues = (clip as { brollCues?: unknown }).brollCues;
          const brollCuesParsed = rawBrollCues
            ? brollCuesArraySchema.safeParse(rawBrollCues)
            : null;
          const cues: BrollCueInput[] | null =
            brollCuesParsed?.success && brollCuesParsed.data.length > 0
              ? brollCuesParsed.data
              : null;

          const category = clip.category as ClipCategory;
          const fallbackQuery = brollQueryForClip(
            clip.title,
            clip.hookText,
            category,
          );
          const broaderFallbackQuery =
            CATEGORY_BROLL_FALLBACK_QUERY[category] ?? null;

          if (cues || fallbackQuery) {
            const orientation = dominantPexelsOrientation(
              outputs.map((o) => o.aspectRatio),
            );
            const targetWidth = orientation === "landscape" ? 1920 : 1080;
            const targetHeight = orientation === "landscape" ? 1080 : 1920;

            try {
              const resolvedCutaways = await resolveBrollCutaways({
                clipDurationSec,
                cues,
                fallbackQuery,
                broaderFallbackQuery,
                orientation,
                targetWidth,
                targetHeight,
              });

              const cutaways: BrollCutaway[] = [];
              const credits: BrollPlan["credits"] = [];

              for (const [index, resolved] of resolvedCutaways.entries()) {
                try {
                  let brollPath = await getCachedBrollAssetPath(
                    resolved.downloadUrl,
                  );
                  if (!brollPath) {
                    const downloadedPath = join(
                      tempDir,
                      `broll-${clip.id}-${index}.mp4`,
                    );
                    await downloadUrlToFile(
                      resolved.downloadUrl,
                      downloadedPath,
                      "broll_download_failed",
                    );
                    await saveBrollAssetToCache(
                      resolved.downloadUrl,
                      downloadedPath,
                    );
                    brollPath = downloadedPath;
                  }
                  cutaways.push({
                    path: brollPath,
                    window: {
                      startSec: resolved.startSec,
                      endSec: resolved.endSec,
                    },
                  });
                  credits.push({
                    query: resolved.query,
                    startSec: resolved.startSec,
                    endSec: resolved.endSec,
                    authorName: resolved.attribution.authorName,
                    authorUrl: resolved.attribution.authorUrl,
                    pageUrl: resolved.attribution.pageUrl,
                  });
                } catch (error) {
                  log("error", "clip_broll_cutaway_download_failed", {
                    workflowRunId: run.id,
                    clipId: clip.id,
                    query: resolved.query,
                    message:
                      error instanceof Error ? error.message : "unknown",
                  });
                }
              }

              if (cutaways.length > 0) {
                brollPlan = { cutaways, credits };
                log("info", "clip_broll_selected", {
                  workflowRunId: run.id,
                  clipId: clip.id,
                  source: cues ? "cues" : "auto",
                  cutawayCount: cutaways.length,
                  credits,
                });
              }
            } catch (error) {
              log("error", "clip_broll_prepare_failed", {
                workflowRunId: run.id,
                clipId: clip.id,
                source: "auto",
                message: error instanceof Error ? error.message : "unknown",
              });
            }
          }
        }
      }

      let musicPlan: MusicPlan | null = null;
      if (studioEdits.music.url) {
        let musicUrlSafe = false;
        try {
          assertPublicHttpUrl(studioEdits.music.url);
          musicUrlSafe = true;
        } catch (error) {
          log("error", "clip_music_url_rejected", {
            workflowRunId: run.id,
            clipId: clip.id,
            reason: error instanceof UnsafeUrlError ? error.reason : "unknown",
          });
        }
        if (musicUrlSafe) {
          const musicPath = join(tempDir, `music-${clip.id}.bin`);
          try {
            await downloadUrlToFile(
              studioEdits.music.url,
              musicPath,
              "music_download_failed",
            );
            musicPlan = {
              path: musicPath,
              volume: studioEdits.music.volume,
              startOffsetSec: studioEdits.music.startOffsetSec,
              fadeInSec: studioEdits.music.fadeInSec,
              fadeOutSec: studioEdits.music.fadeOutSec,
            };
          } catch (musicError) {
            log("error", "clip_music_download_failed", {
              workflowRunId: run.id,
              clipId: clip.id,
              message:
                musicError instanceof Error ? musicError.message : "unknown",
            });
          }
        }
      }

      // sourceAudio (volume/mute) is only applied by the per-output builders
      // (buildSingleVideoArgs/buildBrollVideoArgs/buildAudiogramArgs), same
      // as music — buildMultiVideoArgs (the shared multi-output batch path)
      // never learned to thread either through its filter graph, so any
      // non-default sourceAudio setting must route through this same gate to
      // actually take effect for multi-output renders.
      const hasStudioVideoEdits =
        studioEdits.textLayers.length > 0 ||
        studioEdits.transition.type !== "none" ||
        Boolean(musicPlan) ||
        studioEdits.sourceAudio.muted ||
        studioEdits.sourceAudio.volume !== 100;

      await Promise.all(
        outputs.map((output) =>
          clipService.markClipRenderVariantRendering(output.clipRenderId),
        ),
      );

      if (!probe.hasVideo) {
        for (const output of outputs) {
          try {
            const ffmpegArgs = buildAudiogramArgs({
              sourcePath,
              outputPath: output.outputPath,
              startSec: clipStartSec,
              endSec: clipEndSec,
              aspectRatio: output.aspectRatio,
              clipDurationSec,
              srtPath: output.subtitlePath ?? srtPath,
              captionPreset,
              studioEdits,
              music: musicPlan,
              applyFreeTierTreatment,
            });

            const encodeStartedAtMs = Date.now();
            await execCommand("ffmpeg", ffmpegArgs);
            const persisted = await uploadRenderedOutput({
              workflowRunId: run.id,
              projectId: run.projectId,
              output,
              clipDurationSec,
              applyFreeTierTreatment,
              encodeMs: Date.now() - encodeStartedAtMs,
            });
            // Only count it if the ClipRender row actually claimed this
            // attempt's completion — a stale-discarded upload (the row was
            // deleted by a concurrent editor save/reset mid-encode) produced
            // real bytes but persisted nothing, so it must not count toward
            // "this run rendered something" (see the all-failed check below).
            if (persisted) renderedVariantCount += 1;
          } catch (error) {
            const errorCode =
              error instanceof WorkflowWorkerError
                ? error.code
                : "ffmpeg_render_failed";

            await clipService.failClipRenderVariant(output.clipRenderId, errorCode);

            log("error", "clip_render_variant_failed", {
              workflowRunId: run.id,
              clipId: output.clipId,
              clipRenderId: output.clipRenderId,
              clipIndex: output.clipIndex,
              aspectRatio: output.aspectRatio,
              code: errorCode,
              message:
                error instanceof Error ? error.message : "Unknown render error",
            });
          }
        }
      } else if (brollPlan || hasStudioVideoEdits) {
        // B-roll or other studio edits active: render each output individually
        // so each aspect ratio gets its own composited cutaway/text/fade/audio.
        const plan = brollPlan;
        const brollCredits =
          plan && plan.credits.length > 0 ? JSON.stringify(plan.credits) : null;
        for (const output of outputs) {
          try {
            const ffmpegArgs = plan
              ? buildBrollVideoArgs({
                  sourcePath,
                  cutaways: plan.cutaways,
                  outputPath: output.outputPath,
                  startSec: clipStartSec,
                  endSec: clipEndSec,
                  aspectRatio: output.aspectRatio,
                  probe,
                  srtPath: output.subtitlePath ?? srtPath,
                  captionPreset,
                  logo,
                  reframe: output.reframe,
                  studioEdits,
                  music: musicPlan,
                  applyFreeTierTreatment,
                })
              : buildSingleVideoArgs({
                  sourcePath,
                  outputPath: output.outputPath,
                  startSec: clipStartSec,
                  endSec: clipEndSec,
                  aspectRatio: output.aspectRatio,
                  probe,
                  srtPath: output.subtitlePath ?? srtPath,
                  captionPreset,
                  logo,
                  reframe: output.reframe,
                  studioEdits,
                  music: musicPlan,
                  applyFreeTierTreatment,
                });
            const encodeStartedAtMs = Date.now();
            await execCommand("ffmpeg", ffmpegArgs);
            const persisted = await uploadRenderedOutput({
              workflowRunId: run.id,
              projectId: run.projectId,
              output,
              clipDurationSec,
              applyFreeTierTreatment,
              brollCredits,
              encodeMs: Date.now() - encodeStartedAtMs,
            });
            if (persisted) renderedVariantCount += 1;
          } catch (error) {
            const errorCode =
              error instanceof WorkflowWorkerError
                ? error.code
                : "ffmpeg_render_failed";
            await clipService.failClipRenderVariant(output.clipRenderId, errorCode);
            log("error", "clip_render_variant_failed", {
              workflowRunId: run.id,
              clipId: output.clipId,
              clipRenderId: output.clipRenderId,
              clipIndex: output.clipIndex,
              aspectRatio: output.aspectRatio,
              code: errorCode,
              message:
                error instanceof Error ? error.message : "Unknown render error",
            });
          }
        }
      } else {
        try {
          const ffmpegArgs =
            outputs.length === 1
              ? buildSingleVideoArgs({
                  sourcePath,
                  outputPath: outputs[0]!.outputPath,
                  startSec: clipStartSec,
                  endSec: clipEndSec,
                  aspectRatio: outputs[0]!.aspectRatio,
                  probe,
                  srtPath: outputs[0]!.subtitlePath ?? srtPath,
                  captionPreset,
                  logo,
                  reframe: outputs[0]!.reframe,
                  applyFreeTierTreatment,
                })
              : buildMultiVideoArgs({
                  sourcePath,
                  outputs,
                  startSec: clipStartSec,
                  endSec: clipEndSec,
                  probe,
                  srtPath,
                  captionPreset,
                  logo,
                  applyFreeTierTreatment,
                });

          const encodeStartedAtMs = Date.now();
          await execCommand("ffmpeg", ffmpegArgs);
          const sharedEncodeMs = Date.now() - encodeStartedAtMs;

          for (const output of outputs) {
            try {
              const persisted = await uploadRenderedOutput({
                workflowRunId: run.id,
                projectId: run.projectId,
                output,
                clipDurationSec,
                applyFreeTierTreatment,
                encodeMs: sharedEncodeMs,
              });
              if (persisted) renderedVariantCount += 1;
            } catch (error) {
              const errorCode =
                error instanceof WorkflowWorkerError
                  ? error.code
                  : "render_upload_failed";

              await clipService.failClipRenderVariant(
                output.clipRenderId,
                errorCode,
              );

              log("error", "clip_render_variant_failed", {
                workflowRunId: run.id,
                clipId: output.clipId,
                clipRenderId: output.clipRenderId,
                clipIndex: output.clipIndex,
                aspectRatio: output.aspectRatio,
                code: errorCode,
                message:
                  error instanceof Error ? error.message : "Unknown render error",
              });
            }
          }
        } catch (error) {
          const errorCode =
            error instanceof WorkflowWorkerError
              ? error.code
              : "ffmpeg_render_failed";

          await Promise.all(
            outputs.map((output) =>
              clipService.failClipRenderVariant(output.clipRenderId, errorCode),
            ),
          );

          log("error", "clip_render_group_failed", {
            workflowRunId: run.id,
            clipId: clip.id,
            clipIndex: clip.index,
            aspectRatios: outputs.map((output) => output.aspectRatio),
            code: errorCode,
            message:
              error instanceof Error ? error.message : "Unknown render error",
          });
        }
      }

      const progress = 10 + Math.round(((clipGroupIndex + 1) / clipGroups.length) * 80);
      await projectService.publishWorkflowProgress({
        projectId: run.projectId,
        workflowRunId: run.id,
        stage: "clip_rendering",
        status: "running",
        progress,
        errorCode: null,
      });
    }

    if (renderedVariantCount === 0 && pendingRenders.length > 0) {
      // Every variant this attempt touched failed. Completing the run here
      // would report success over an empty result. The variants are NOT reset
      // here — failClipRenderingWorkflowRun (via the catch below, passed
      // retryVariantIds) resets them to pending only when the run actually
      // requeues; on the final attempt they stay `failed` with their real
      // per-variant error codes so the UI settles.
      throw new WorkflowWorkerError(
        "all_clip_renders_failed",
        `All ${pendingRenders.length} clip render variants failed`,
      );
    }

    await projectService.completeClipRenderingWorkflowRun(run.id, {
      failedVariantCount: pendingRenders.length - renderedVariantCount,
    });

    // A trigger that fired while this run was rendering had its variants
    // absorbed by the one-live-run guard but missed this run's snapshot.
    // Hand any such leftovers a fresh run (fresh attempt budget) so they
    // don't sit pending forever with nothing claiming them.
    const leftover = await clipService.getPendingClipRendersForProject(
      run.projectId,
    );
    if (leftover.length > 0) {
      await clipService.queueFollowUpRenderRun(run.projectId, run.id);
      log("info", "clip_rendering_follow_up_queued", {
        workflowRunId: run.id,
        projectId: run.projectId,
        leftoverVariantCount: leftover.length,
      });
    }

    log("info", "clip_rendering_run_completed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      totalClipGroups: clipGroups.length,
      totalVariantCount: pendingRenders.length,
      renderedVariantCount,
      failedVariantCount: pendingRenders.length - renderedVariantCount,
      totalMs: Date.now() - runStartedAtMs,
      sourceMode: isHttpSource(sourcePath) ? "ranged" : "download",
      encoder: "libx264",
      preset: x264Preset(),
    });
    await notifyAutoRenderCompleted({
      workflowRunId: run.id,
      projectId: run.projectId,
      clipCount: clipGroups.length,
    });
  } catch (error) {
    const code =
      error instanceof WorkflowWorkerError
        ? error.code
        : "workflow_unhandled_error";

    const message =
      error instanceof Error ? error.message : "Unknown worker error";
    await projectService.failClipRenderingWorkflowRun(
      run.id,
      code,
      code === "all_clip_renders_failed"
        ? { retryVariantIds: attemptVariantIds }
        : undefined,
    );

    log("error", "clip_rendering_run_failed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      code,
      message,
    });
    await notifyWorkflowFailureAfterSettlement({
      workflowRunId: run.id,
      projectId: run.projectId,
      errorCode: code,
      reason: message,
      autoRenderOnly: true,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
