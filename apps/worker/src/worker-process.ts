import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { WORKFLOW_LEASE_DURATION_MS, WorkflowFailure } from "@narriflow/services";
import { SOURCE_TIMECODE_PATTERN, standardFrameRate, type FrameRate, type SourceProbe, type MediaFacts } from "@narriflow/validators";

const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_MEDIA_FPS = 30;
export const HTTP_SOURCE_RW_TIMEOUT_US = 30_000_000;
const MAX_DIAGNOSTIC_CHARS = 8_192;
const DEFAULT_CAPTURED_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURED_STDOUT_BYTES = 64 * 1024 * 1024;
const PROCESS_GROUP_REAP_TIMEOUT_MS = 1_000;
const RESOURCE_SAMPLE_INTERVAL_MS = 100;
/** Base and average rates this far apart (relative) put the clock in question. */
const CLOCK_DISAGREEMENT_RATIO = 0.01;
/** No constant-rate source reports a base rate above this; ffprobe guesses
 *  90000/1 or 1000/1 for variable-rate files. */
const MAX_PLAUSIBLE_BASE_FPS = 240;
/** The rates a variable source may be normalized to, ascending. */
const NORMALIZED_RATES: readonly FrameRate[] = [
  { numerator: 15, denominator: 1 },
  { numerator: 24000, denominator: 1001 },
  { numerator: 24, denominator: 1 },
  { numerator: 25, denominator: 1 },
  { numerator: 30000, denominator: 1001 },
  { numerator: 30, denominator: 1 },
  { numerator: 50, denominator: 1 },
  { numerator: 60000, denominator: 1001 },
  { numerator: 60, denominator: 1 },
];
const STANDARD_RATE_TOLERANCE = 0.0002;
const NOT_BELOW_TOLERANCE = 0.01;
const FALLBACK_NORMALIZED_RATE: FrameRate = { numerator: 30, denominator: 1 };
/** Packets read for timestamp evidence (about ten seconds of video). */
const CLOCK_PACKET_BUDGET = 300;
const MIN_CLOCK_INTERVALS = 8;
/** An interval this far from the median (relative) is irregular, and this
 *  share of irregular intervals makes the stream variable. */
const IRREGULAR_INTERVAL_RATIO = 0.2;
const VARIABLE_INTERVAL_SHARE = 0.05;

export interface WorkerProcessRequest {
  command: string;
  args: readonly string[];
  signal: AbortSignal;
  deadlineMs: number;
  acceptableExitCodes?: readonly number[];
  captureStdout?: boolean;
  maxStdoutBytes?: number;
  /** Keep stderr lines matching this pattern for `WorkerProcessResult.stderrLines`.
   *  The bounded diagnostic tail drops early lines on a long encode, but a
   *  libass or drawtext warning is needed even when the process exits zero. */
  stderrLinePattern?: RegExp;
  recordResourceSample?(rssBytes: number): void;
  diagnose?(event: WorkerProcessDiagnostic): void;
}

export interface WorkerProcessResult {
  exitCode: number;
  stdout: Buffer;
  /** Redacted stderr lines that matched `stderrLinePattern` (first occurrences, bounded). */
  stderrLines?: readonly string[];
}

const MAX_CAPTURED_STDERR_LINES = 100;
const MAX_CAPTURED_STDERR_LINE_CHARS = 400;

export type WorkerExecutableClass = "ffmpeg" | "ffprobe" | "python" | "bun" | "node" | "deno" | "yt-dlp" | "other";
export interface WorkerProcessHealth {
  errno?: string;
  executableClass?: WorkerExecutableClass;
  failureScope?: "executor" | "configuration";
}

export interface WorkerProcessDiagnostic extends WorkerProcessHealth {
  operation:
    | "spawn"
    | "timeout"
    | "output_limit"
    | "exit"
    | "cancellation"
    | "termination"
    | "scratch_cleanup";
  status: "completed" | "failed";
  elapsedMs: number;
  failureCode?: string;
  disposition?: "retryable" | "permanent";
  terminationSignal?: NodeJS.Signals;
  diagnostic?: string;
}

export interface WorkerMediaInspection {
  durationSec: number | null;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  hasVisualStream: boolean;
  /** The rate every generated video branch runs at: the raw base rate, or
   *  `videoClock.constantRate` when the source needed normalizing. */
  fps: number;
  /** How the source's frame clock was judged. Present when the base and
   *  average rates disagreed, so timestamps were examined. */
  videoClock?: VideoClockDecision;
  /** The facts ingest stores on the Project for timeline exports. Every real
   * inspection carries it; fakes of other tests may leave it out. */
  sourceProbe?: SourceProbe;
  /** Always present on real inspections, including files without a duration. */
  facts?: MediaFacts;
  samples?: WorkerMediaSamples;
  /** Timestamp discontinuities of the first audio stream inside one clip's
   *  window (see `withAudioTimestampGaps`). Absent unless a gap was found, so
   *  an inspection of a continuous track is unchanged. */
  audioGaps?: AudioTimestampGaps;
}

/** A hole in the audio stream's own timestamps: packets resume `missingSec`
 *  later than the previous packet's end, at `atSec` into the clip window. */
export interface AudioTimestampGap {
  atSec: number;
  missingSec: number;
}

export interface AudioTimestampGaps {
  /** One audio packet's length, the unit a gap is measured against. */
  frameSec: number;
  gaps: readonly AudioTimestampGap[];
}

/** The constant rate an affected variable-frame-rate source is normalized to,
 *  with the facts behind the decision. */
export interface VideoClockDecision {
  baseRate: FrameRate | null;
  averageRate: FrameRate | null;
  /** From bounded packet timestamps; null when none could be read. */
  variable: boolean | null;
  packetsSampled: number;
  /** Set only for a source that needs normalizing: every video branch of its
   *  graph then runs at this rate. Null leaves the raw clock untouched. */
  constantRate: FrameRate | null;
  reason: "variable-timestamps" | "unrealistic-base-rate" | null;
}

/** The geometry every consumer plans in: display-oriented with square pixels.
 *  FFmpeg autorotation applies the display matrix exactly once when it decodes,
 *  so a consumer must never apply it again. */
export interface DisplayGeometry {
  width: number;
  height: number;
  /** The matrix rotates, reflects or swaps axes of the decoded frame. */
  oriented: boolean;
  /** Stream SAR is not 1:1, so the frame needs scaling to width x height with
   *  SAR 1:1 before any crop. */
  anamorphic: boolean;
}

const FIXED_ONE = 65536;

/** Resolve the first video stream's displayed geometry. Quarter-turn matrices
 *  and reflections are exact. A source without facts, or with an oblique
 *  matrix, keeps its coded dimensions. */
export function resolveDisplayGeometry(
  inspection: Pick<WorkerMediaInspection, "width" | "height" | "facts">,
): DisplayGeometry {
  const coded: DisplayGeometry = { width: inspection.width, height: inspection.height, oriented: false, anamorphic: false };
  const video = inspection.facts?.videos[0];
  if (!video || inspection.width <= 0 || inspection.height <= 0) return coded;
  const m = video.displayMatrix;
  let swapped = false;
  let oriented = false;
  if (m) {
    const axisAligned = Math.abs(m[0]!) === FIXED_ONE && Math.abs(m[4]!) === FIXED_ONE && m[1] === 0 && m[3] === 0;
    const quarterTurn = m[0] === 0 && m[4] === 0 && Math.abs(m[1]!) === FIXED_ONE && Math.abs(m[3]!) === FIXED_ONE;
    if (!axisAligned && !quarterTurn) return coded;
    swapped = quarterTurn;
    oriented = !(m[0] === FIXED_ONE && m[4] === FIXED_ONE);
  }
  const sar = video.sampleAspectRatio;
  const anamorphic = Boolean(sar && sar.numerator !== sar.denominator);
  const squareWidth = anamorphic ? Math.max(1, Math.round((inspection.width * sar!.numerator) / sar!.denominator)) : inspection.width;
  return {
    width: swapped ? inspection.height : squareWidth,
    height: swapped ? squareWidth : inspection.height,
    oriented,
    anamorphic,
  };
}

export interface WorkerMediaSampleRequest {
  kind: "frames" | "packets";
  streamIndex: number;
  startSec?: number;
  /** Input packet budget, not proof of a complete stream scan. At most 4096. */
  maxPackets: number;
}
export interface WorkerMediaSamples {
  kind: "frames" | "packets";
  streamIndex: number;
  startSec: number;
  maxPackets: number;
  items: Array<{
    streamIndex: number;
    pts: number | null;
    ptsSec: number | null;
    dts: number | null;
    dtsSec: number | null;
    duration: number | null;
    durationSec: number | null;
    bestEffortTimestampSec: number | null;
    samples: number | null;
    keyFrame: boolean | null;
    sizeBytes: number | null;
  }>;
}

export interface WorkerMediaInspectionRequest {
  sourcePath: string;
  /** Output validation obtains complete timestamps from its full decode. */
  analyzeVideoClock?: boolean;
  sample?: WorkerMediaSampleRequest;
  signal: AbortSignal;
  deadlineMs: number;
  diagnose?(event: WorkerProcessDiagnostic): void;
}

export interface WorkerProcessModule {
  execute(request: WorkerProcessRequest): Promise<WorkerProcessResult>;
  inspectMedia(request: WorkerMediaInspectionRequest): Promise<WorkerMediaInspection>;
  withScratchDirectory<T>(
    prefix: string,
    work: (directory: string) => Promise<T>,
    diagnose?: (event: WorkerProcessDiagnostic) => void,
    ownership?: ScratchOwnership,
  ): Promise<T>;
  start?(request: WorkerPersistentProcessRequest): Promise<WorkerPersistentProcess>;
}

/** Long-lived helpers (the YouTube token daemon) still use the same process
 * group and cancellation owner as one-shot commands. */
export interface WorkerPersistentProcessRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  startupDeadlineMs?: number;
  startupReadyMarker?: string;
  diagnose?(event: WorkerProcessDiagnostic): void;
}

export interface WorkerPersistentProcess {
  exited: Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }>;
  stop(): void;
}

/** Longest window the audio packet scan reads, and the most gaps it reports. */
const AUDIO_GAP_SCAN_MAX_WINDOW_SEC = 900;
const AUDIO_GAP_SCAN_MAX_GAPS = 64;
// Compact CSV fits 900 s even at 2.5 ms per packet with ample timestamp headroom.
const AUDIO_GAP_SCAN_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
export const AUDIO_GAP_SCAN_TIMEOUT_MS = 15_000;
const AUDIO_GAP_SCAN_MIN_PACKETS = 4;

/**
 * Finds holes in an audio stream's packet timestamps (seconds, any order). A
 * packet's own duration cannot tell: MP4 folds a hole into the previous
 * sample's duration. So one frame is the median step between packets, and a
 * hole is any step that leaves more than one whole frame unaccounted for.
 * Fewer than a handful of packets say nothing.
 */
export function findAudioTimestampGaps(
  packetTimesSec: readonly number[],
): { frameSec: number; gaps: Array<{ atSec: number; missingSec: number }> } | null {
  const times = packetTimesSec.filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length < AUDIO_GAP_SCAN_MIN_PACKETS) return null;
  const steps = times.slice(1).map((time, index) => time - times[index]!);
  const frameSec = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)]!;
  if (!(frameSec > 0)) return null;
  const gaps: Array<{ atSec: number; missingSec: number }> = [];
  steps.forEach((step, index) => {
    const missingSec = step - frameSec;
    if (missingSec > frameSec) gaps.push({ atSec: times[index + 1]!, missingSec });
  });
  return { frameSec, gaps };
}

/**
 * Scans the first audio stream's packets over one clip window (a bounded
 * `-read_intervals` read: no decode) and reports the holes in its timestamps.
 * Header facts cannot show these, and a stream with holes plays early after
 * every `atrim` + `asetpts=PTS-STARTPTS` stage unless it is realigned.
 *
 * Returns null when there is nothing to report or nothing could be read: a
 * failed scan never fails the render, the source simply keeps the clock its
 * headers prove.
 */
export async function inspectAudioTimestampGaps(
  processModule: Pick<WorkerProcessModule, "execute">,
  request: {
    sourcePath: string;
    inspection: Pick<WorkerMediaInspection, "hasAudio" | "facts">;
    /** The clip window on the source clock, as the render seeks it. */
    startSec: number;
    endSec: number;
    signal: AbortSignal;
    deadlineMs: number;
    diagnose?(event: WorkerProcessDiagnostic): void;
  },
): Promise<AudioTimestampGaps | null> {
  const audio = request.inspection.facts?.audios[0];
  const windowSec = request.endSec - request.startSec;
  if (!request.inspection.hasAudio || !audio || !(windowSec > 0) || windowSec > AUDIO_GAP_SCAN_MAX_WINDOW_SEC || ["vorbis", "opus"].includes(audio.codec ?? "")) return null;
  const facts = request.inspection.facts!;
  const origin = facts.format.startTimeSec ?? audio.startTimeSec ?? 0;
  const from = Math.max(0, origin + request.startSec);
  const to = origin + request.endSec;
  try {
    const result = await processModule.execute({
      command: "ffprobe",
      args: ["-v", "error", "-of", "csv=p=0", "-select_streams", Number.isInteger(audio.index) ? String(audio.index) : "a:0",
        "-read_intervals", `${from.toFixed(3)}%${to.toFixed(3)}`, "-show_packets", "-show_entries", "packet=pts_time",
        ...(/^https?:\/\//i.test(request.sourcePath) ? ["-rw_timeout", String(HTTP_SOURCE_RW_TIMEOUT_US)] : []),
        request.sourcePath],
      signal: request.signal, deadlineMs: Math.min(request.deadlineMs, AUDIO_GAP_SCAN_TIMEOUT_MS), captureStdout: true,
      maxStdoutBytes: AUDIO_GAP_SCAN_MAX_STDOUT_BYTES, diagnose: request.diagnose,
    });
    // Side-data columns can follow pts_time; only the first CSV field is evidence.
    const found = findAudioTimestampGaps(result.stdout.toString("utf8").split("\n").flatMap((line) => {
      const time = numberFact(line.split(",", 1)[0]?.trim());
      return time === null ? [] : [time];
    }));
    if (!found) return null;
    // The probe seeks to a keyframe before the interval, so its packets can start well
    // ahead of the clip. A hole counts only if the silence [atSec - missingSec, atSec]
    // overlaps the window; preroll or trailing holes are not this clip's defect.
    const gaps = found.gaps
      .map((gap) => ({ atSec: gap.atSec - origin - request.startSec, missingSec: gap.missingSec }))
      .filter((gap) => gap.atSec > 0 && gap.atSec - gap.missingSec < windowSec)
      .slice(0, AUDIO_GAP_SCAN_MAX_GAPS);
    return gaps.length === 0 ? null : { frameSec: found.frameSec, gaps };
  } catch (error) {
    request.signal.throwIfAborted();
    // The render continues without realignment. The error text can carry a
    // signed source URL, so only its class is logged.
    console.warn(JSON.stringify({ level: "warn", message: "worker_audio_gap_scan_skipped",
      reason: error instanceof Error ? error.name : "unknown", windowSec }));
    return null;
  }
}

/** The inspection with the clip window's audio timestamp gaps attached, or the same object when there are none. */
export async function withAudioTimestampGaps<T extends WorkerMediaInspection>(
  processModule: Pick<WorkerProcessModule, "execute">,
  inspection: T,
  request: Omit<Parameters<typeof inspectAudioTimestampGaps>[1], "inspection">,
): Promise<T> {
  const audioGaps = await inspectAudioTimestampGaps(processModule, { ...request, inspection });
  return audioGaps ? { ...inspection, audioGaps } : inspection;
}

export class WorkerProcessFailure extends WorkflowFailure implements WorkerProcessHealth {
  readonly errno?: string;
  readonly executableClass?: WorkerExecutableClass;
  readonly failureScope?: "executor" | "configuration";
  constructor(
    code: string,
    disposition: "retryable" | "permanent",
    message: string,
    public readonly diagnostic: string,
    public readonly exitCode: number | null = null,
    options?: ErrorOptions & WorkerProcessHealth,
  ) {
    super(code, disposition, message, options);
    this.name = "WorkerProcessFailure";
    this.errno = options?.errno;
    this.executableClass = options?.executableClass;
    this.failureScope = options?.failureScope;
  }
}

interface RawProbeStream {
  index?: number;
  codec_type?: string;
  profile?: string;
  coded_width?: number;
  coded_height?: number;
  sample_aspect_ratio?: string;
  time_base?: string;
  start_pts?: number;
  start_time?: string;
  duration_ts?: number;
  bit_rate?: string;
  pix_fmt?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  chroma_location?: string;
  field_order?: string;
  channel_layout?: string;
  sample_fmt?: string;
  initial_padding?: number;
  trailing_padding?: number;
  side_data_list?: Array<Record<string, unknown>>;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  tags?: Record<string, string>;
  nb_frames?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
}

export interface WorkerProcessModuleDependencies {
  admission?: WorkerProcessAdmission;
  killGraceMs?: number;
  spawn?: typeof spawn;
  execute?: (request: WorkerProcessRequest) => Promise<WorkerProcessResult>;
  createScratchDirectory?: (prefix: string) => Promise<string>;
  removeScratchDirectory?: (directory: string) => Promise<void>;
  /** Parent of every scratch directory this module creates (default: the OS temp directory). */
  scratchRoot?: string;
}

const PERMANENT_INPUT_EXIT_PATTERNS = [
  /invalid data found when processing input/i,
  /moov atom not found/i,
] as const;

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

function executableClass(command: string): WorkerExecutableClass {
  const name = basename(command).replace(/\.exe$/i, "");
  if (/^python(?:3(?:\.\d+)?)?$/.test(name)) return "python";
  return ["ffmpeg", "ffprobe", "bun", "node", "deno", "yt-dlp"].includes(name)
    ? name as WorkerExecutableClass : "other";
}

function processStartFailure(error: unknown, command: string): WorkerProcessFailure {
  const rawCode = error && typeof error === "object" && "code" in error ? error.code : null;
  const errno = typeof rawCode === "string" && /^E[A-Z0-9_]{1,31}$/.test(rawCode) ? rawCode : undefined;
  const configuration = errno === "ENOENT" || errno === "EACCES" || errno === "EPERM" || errno === "ENOEXEC";
  const health: WorkerProcessHealth = {
    ...(errno ? { errno } : {}), executableClass: executableClass(command),
    failureScope: configuration ? "configuration" : "executor",
  };
  return new WorkerProcessFailure(
    configuration ? "worker_command_unavailable" : "worker_command_spawn_failed",
    "retryable",
    configuration ? "Required worker executable is unavailable or forbidden" : "Worker command could not be started",
    `Could not start ${health.executableClass}${errno ? ` (${errno})` : ""}`,
    null,
    { cause: error, ...health },
  );
}

function startFailureDiagnostic(failure: WorkerProcessFailure): Omit<WorkerProcessDiagnostic, "elapsedMs"> {
  return {
    operation: "spawn", status: "failed", failureCode: failure.code, disposition: failure.disposition,
    errno: failure.errno, executableClass: failure.executableClass,
    failureScope: failure.failureScope, diagnostic: failure.diagnostic,
  };
}

function redactUrlSecrets(text: string): string {
  return text
    .replace(/\b((?:https?|socks4a?|socks5h?):\/\/)[^\s/"']+@/gi, "$1[redacted]@")
    .replace(/\?[^\s"']+/g, "?[redacted]");
}

function boundedDiagnostic(text: string): string {
  return redactUrlSecrets(text).slice(-MAX_DIAGNOSTIC_CHARS);
}

function cancellationFailureCode(signal: AbortSignal): string {
  return signal.reason instanceof Error &&
    "code" in signal.reason &&
    typeof signal.reason.code === "string"
    ? signal.reason.code
    : "worker_command_cancelled";
}

/** Finds process health failures even when an adapter retained them as a cause. */
export function executorProcessFailure(error: unknown): WorkerProcessFailure | null {
  for (let depth = 0; depth < 8 && error instanceof Error; depth += 1) {
    if (error instanceof WorkerProcessFailure && error.failureScope) return error;
    error = error.cause;
  }
  return null;
}

export interface WorkerProcessAdmission {
  beforeStart(command: string): void;
  failed(error: unknown): void;
}
let productionAdmission: WorkerProcessAdmission | undefined;
export function configureWorkerProcessAdmission(admission: WorkerProcessAdmission): void {
  productionAdmission = admission;
}

function exitFailure(
  code: number | null,
  stderr: string,
  invalidInput: boolean,
): WorkerProcessFailure {
  const diagnostic = boundedDiagnostic(stderr);
  if (/No such filter:\s*['"]?[a-z0-9_]+/i.test(diagnostic)) {
    return new WorkerProcessFailure("worker_render_filter_unavailable", "retryable",
      "Required FFmpeg filter is unavailable", diagnostic, code,
      { executableClass: "ffmpeg", failureScope: "configuration" });
  }
  if (invalidInput) {
    return new WorkerProcessFailure(
      "worker_command_input_invalid",
      "permanent",
      `Worker command rejected invalid input: ${diagnostic.slice(-500)}`,
      diagnostic,
      code,
    );
  }
  return new WorkerProcessFailure(
    "worker_command_failed",
    "retryable",
    `Worker command failed with code ${code}: ${diagnostic.slice(-500)}`,
    diagnostic,
    code,
  );
}

function safeDiagnose(
  diagnose: WorkerProcessRequest["diagnose"] | undefined,
  event: WorkerProcessDiagnostic,
): void {
  try {
    diagnose?.(event);
  } catch {
    // Diagnostics cannot change process execution.
  }
}

async function processTreeRssBytes(childPid: number | undefined): Promise<number> {
  if (process.platform === "linux") {
    try {
      const cgroupBytes = Number((await readFile("/sys/fs/cgroup/memory.current", "utf8")).trim());
      if (Number.isFinite(cgroupBytes) && cgroupBytes > 0) return cgroupBytes;
    } catch {
      // Non-cgroup Linux hosts fall through to process accounting.
    }
  }
  if (!childPid || process.platform === "win32") {
    return process.memoryUsage().rss;
  }
  return new Promise((resolve) => {
    const sampler = spawn("ps", ["-o", "rss=", "-p", `${process.pid},${childPid}`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    const finish = (rssBytes: number): void => {
      if (settled) return;
      settled = true;
      resolve(rssBytes);
    };
    sampler.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    sampler.once("error", () => finish(process.memoryUsage().rss));
    sampler.once("close", (code) => {
      if (code !== 0) {
        finish(process.memoryUsage().rss);
        return;
      }
      const rssBytes = stdout
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter((value) => Number.isFinite(value) && value > 0)
        .reduce((total, rssKiB) => total + rssKiB * 1024, 0);
      finish(rssBytes > 0 ? rssBytes : process.memoryUsage().rss);
    });
  });
}

async function waitForProcessGroupExit(pid: number | undefined, timeoutMs: number): Promise<void> {
  if (!pid || process.platform === "win32") return;
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      // macOS can return EPERM while a killed group is still exiting.
      // Only ESRCH confirms that its descendants have disappeared.
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function parseFrameRate(value: string | undefined): number {
  if (!value) return DEFAULT_MEDIA_FPS;
  const [numeratorText, denominatorText] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = denominatorText === undefined ? 1 : Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return DEFAULT_MEDIA_FPS;
  }
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_MEDIA_FPS;
}

/** ffprobe writes a rate as "30000/1001". */
function parseRational(value: string | undefined): FrameRate | null {
  const [numerator, denominator = 1] = (value ?? "").split("/").map(Number);
  return Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator) && numerator! > 0 && denominator > 0
    ? { numerator: numerator!, denominator }
    : null;
}

/** The video stream's rate as editors count it. The base rate (r_frame_rate)
 * is exact for constant-rate files, so a standard base rate wins; the average
 * is a fallback for variable-rate files, whose base rate is absurd (90000/1).
 * A rate matching no standard is kept as measured, for the export to refuse. */
function measuredFrameRate(stream: RawProbeStream): FrameRate | null {
  const base = parseRational(stream.r_frame_rate);
  const average = parseRational(stream.avg_frame_rate);
  for (const rate of [base, average]) {
    const standard = rate && standardFrameRate(rate.numerator / rate.denominator);
    if (standard) return standard;
  }
  return average ?? base;
}

/** Whether presentation times (seconds, any order) show a variable frame
 *  clock: too many intervals differ from the typical one. Null without enough
 *  evidence to say. */
export function hasVariableTimestamps(presentationTimesSec: readonly number[]): boolean | null {
  const times = presentationTimesSec.filter(Number.isFinite).sort((a, b) => a - b);
  const intervals = times.slice(1).map((time, index) => time - times[index]!);
  if (intervals.length < MIN_CLOCK_INTERVALS) return null;
  const median = [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)]!;
  if (!(median > 0)) return true;
  const irregular = intervals.filter((interval) => Math.abs(interval - median) > median * IRREGULAR_INTERVAL_RATIO).length;
  return irregular / intervals.length > VARIABLE_INTERVAL_SHARE;
}

/** The constant rate for a variable source: its measured average snapped to
 *  the smallest standard rate that is not below it (within 1%), so no motion
 *  is dropped and platforms see a rate they expect. An average that already is
 *  a standard rate is kept exactly. Above 60 is 60/1, below 15 is 15/1, and an
 *  unknown average is 30/1. */
export function chooseConstantFrameRate(average: FrameRate | null): FrameRate {
  if (!average) return FALLBACK_NORMALIZED_RATE;
  const fps = average.numerator / average.denominator;
  if (!(fps > 0)) return FALLBACK_NORMALIZED_RATE;
  const rateOf = (rate: FrameRate) => rate.numerator / rate.denominator;
  const exact = NORMALIZED_RATES.find((rate) => Math.abs(rateOf(rate) - fps) / fps <= STANDARD_RATE_TOLERANCE);
  if (exact) return exact;
  return NORMALIZED_RATES.find((rate) => rateOf(rate) * (1 + NOT_BELOW_TOLERANCE) >= fps) ?? NORMALIZED_RATES[NORMALIZED_RATES.length - 1]!;
}

/** Decide the clock of one video stream. `readPresentationTimesSec` is called
 *  only when the base and average rates are both known and disagree. */
export async function decideVideoClock(
  stream: Pick<RawProbeStream, "r_frame_rate" | "avg_frame_rate">,
  readPresentationTimesSec: () => Promise<number[] | null>,
): Promise<VideoClockDecision | null> {
  const baseRate = parseRational(stream.r_frame_rate);
  const averageRate = parseRational(stream.avg_frame_rate);
  if (!baseRate) return null;
  const base = baseRate.numerator / baseRate.denominator;
  if (averageRate && Math.abs(averageRate.numerator / averageRate.denominator - base) <= base * CLOCK_DISAGREEMENT_RATIO) return null;
  // Without an average there is nothing to compare, and nothing to choose a
  // rate from: only an impossible base rate is acted on.
  if (!averageRate && base <= MAX_PLAUSIBLE_BASE_FPS) return null;
  const times = averageRate ? await readPresentationTimesSec() : null;
  const variable = times ? hasVariableTimestamps(times) : null;
  const reason = variable ? "variable-timestamps" : base > MAX_PLAUSIBLE_BASE_FPS ? "unrealistic-base-rate" : null;
  return {
    baseRate, averageRate, variable, packetsSampled: times?.length ?? 0,
    constantRate: reason ? chooseConstantFrameRate(averageRate) : null, reason,
  };
}

function timecodeTag(tags: Record<string, string> | undefined): string | null {
  const entry = Object.entries(tags ?? {}).find(([key]) => key.toLowerCase() === "timecode");
  return entry && SOURCE_TIMECODE_PATTERN.test(entry[1]) ? entry[1] : null;
}

/** The start timecode the file carries: on the video stream, on a timecode
 * track, or on the container. */
function embeddedStartTimecode(streams: RawProbeStream[], formatTags: Record<string, string> | undefined): string | null {
  const videoFirst = [...streams].sort((a, b) => Number(b.codec_type === "video") - Number(a.codec_type === "video"));
  for (const stream of videoFirst) {
    const timecode = timecodeTag(stream.tags);
    if (timecode) return timecode;
  }
  return timecodeTag(formatTags);
}

function numberFact(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function integerFact(value: unknown, minimum = Number.MIN_SAFE_INTEGER): number | null {
  const parsed = numberFact(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}
function positiveFact(value: unknown): number | null {
  const parsed = numberFact(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}
function nonnegativeFact(value: unknown): number | null {
  const parsed = numberFact(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}
function textFact(value: unknown): string | null {
  return typeof value === "string" && value !== "unknown" && value !== "N/A" && value.length > 0
    ? value.slice(0, 256) : null;
}
function fractionFact(value: unknown): number | null {
  if (typeof value !== "string") return numberFact(value);
  const [n, d = "1"] = value.split("/");
  const numerator = numberFact(n), denominator = numberFact(d);
  return numerator !== null && denominator !== null && denominator !== 0 ? numerator / denominator : null;
}
function displayMatrix(value: unknown): number[] | null {
  if (typeof value !== "string") return null;
  const rows = value.trim().split("\n").map((row) => row.split(":")[1]?.trim().split(/\s+/).map(Number));
  const matrix = rows.flat();
  return matrix.length === 9 && matrix.every((v) => typeof v === "number" && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647)
    ? matrix as number[] : null;
}
function streamFacts(stream: RawProbeStream, fallbackIndex: number) {
  const startTimeSec = numberFact(stream.start_time);
  const durationSec = nonnegativeFact(stream.duration);
  return {
    index: integerFact(stream.index, 0) ?? fallbackIndex,
    codec: textFact(stream.codec_name), profile: textFact(stream.profile),
    timeBase: parseRational(stream.time_base), startPts: integerFact(stream.start_pts), startTimeSec,
    durationTs: integerFact(stream.duration_ts), durationSec,
    endTimeSec: startTimeSec !== null && durationSec !== null ? startTimeSec + durationSec : null,
    frameCount: integerFact(stream.nb_frames, 0), bitRate: nonnegativeFact(stream.bit_rate),
  };
}
function videoFacts(stream: RawProbeStream, index: number): MediaFacts["videos"][number] {
  const sideData = stream.side_data_list ?? [];
  const display = sideData.find((side) => side.side_data_type === "Display Matrix");
  const matrix = displayMatrix(display?.displaymatrix);
  const sar = parseRational(stream.sample_aspect_ratio?.replace(":", "/"));
  const width = integerFact(stream.width, 1), height = integerFact(stream.height, 1);
  const rotationTag = numberFact(stream.tags?.rotate);
  let rotationDeg: number | null = numberFact(display?.rotation) ?? rotationTag ?? 0;
  let reflected: boolean | null = false;
  let displayWidth: number | null = null, displayHeight: number | null = null;
  if (matrix) {
    // ISO BMFF uses row vectors; u/v/w use 2.30, the other entries 16.16.
    const scaleX = Math.hypot(matrix[0]!, matrix[3]!);
    const scaleY = Math.hypot(matrix[1]!, matrix[4]!);
    rotationDeg = scaleX && scaleY ? -Math.atan2(matrix[1]! / scaleY, matrix[0]! / scaleX) * 180 / Math.PI : null;
    const determinant = matrix[0]! * matrix[4]! - matrix[1]! * matrix[3]!;
    reflected = determinant === 0 ? null : determinant < 0;
  }
  if (width && height) {
    const squareWidth = width * (sar ? sar.numerator / sar.denominator : 1);
    if (matrix) {
      const points = [[0, 0], [squareWidth, 0], [0, height], [squareWidth, height]].map(([x, y]) => {
        const z = (matrix[2]! * x! + matrix[5]! * y! + matrix[8]!) / 2 ** 30;
        return [(matrix[0]! * x! + matrix[3]! * y! + matrix[6]!) / 65536 / z,
          (matrix[1]! * x! + matrix[4]! * y! + matrix[7]!) / 65536 / z];
      });
      displayWidth = positiveFact(Math.max(...points.map((p) => p[0]!)) - Math.min(...points.map((p) => p[0]!)));
      displayHeight = positiveFact(Math.max(...points.map((p) => p[1]!)) - Math.min(...points.map((p) => p[1]!)));
    } else {
      const angle = (rotationDeg ?? 0) * Math.PI / 180;
      displayWidth = Math.abs(squareWidth * Math.cos(angle)) + Math.abs(height * Math.sin(angle));
      displayHeight = Math.abs(squareWidth * Math.sin(angle)) + Math.abs(height * Math.cos(angle));
    }
    // Avoid trig noise on exact right angles without rounding anamorphic facts.
    if (displayWidth !== null && Math.abs(displayWidth - Math.round(displayWidth)) < 1e-8) displayWidth = Math.round(displayWidth);
    if (displayHeight !== null && Math.abs(displayHeight - Math.round(displayHeight)) < 1e-8) displayHeight = Math.round(displayHeight);
  }
  const mastering = sideData.find((side) => side.side_data_type === "Mastering display metadata");
  const light = sideData.find((side) => side.side_data_type === "Content light level metadata");
  const dovi = sideData.find((side) => side.side_data_type === "DOVI configuration record");
  return {
    ...streamFacts(stream, index), width, height,
    codedWidth: integerFact(stream.coded_width, 1), codedHeight: integerFact(stream.coded_height, 1),
    displayWidth, displayHeight, sampleAspectRatio: sar, displayMatrix: matrix,
    rotationDeg, reflected, avgFrameRate: parseRational(stream.avg_frame_rate), rFrameRate: parseRational(stream.r_frame_rate),
    pixelFormat: textFact(stream.pix_fmt), colorRange: textFact(stream.color_range), colorSpace: textFact(stream.color_space),
    colorTransfer: textFact(stream.color_transfer), colorPrimaries: textFact(stream.color_primaries),
    chromaLocation: textFact(stream.chroma_location), fieldOrder: textFact(stream.field_order),
    masteringDisplay: mastering ? {
      redX: fractionFact(mastering.red_x), redY: fractionFact(mastering.red_y),
      greenX: fractionFact(mastering.green_x), greenY: fractionFact(mastering.green_y),
      blueX: fractionFact(mastering.blue_x), blueY: fractionFact(mastering.blue_y),
      whitePointX: fractionFact(mastering.white_point_x), whitePointY: fractionFact(mastering.white_point_y),
      minLuminance: fractionFact(mastering.min_luminance), maxLuminance: fractionFact(mastering.max_luminance),
    } : null,
    contentLight: light ? { maxContent: nonnegativeFact(light.max_content), maxAverage: nonnegativeFact(light.max_average) } : null,
    dolbyVision: dovi ? {
      profile: integerFact(dovi.dv_profile, 0), level: integerFact(dovi.dv_level, 0),
      rpuPresent: dovi.rpu_present_flag === 1, enhancementLayerPresent: dovi.el_present_flag === 1, baseLayerPresent: dovi.bl_present_flag === 1,
      baseLayerSignalCompatibilityId: integerFact(dovi.dv_bl_signal_compatibility_id, 0),
    } : null,
  };
}
interface RawProbeData {
  streams?: RawProbeStream[];
  format?: { duration?: string; start_time?: string; size?: string; bit_rate?: string; format_name?: string; tags?: Record<string, string> };
  frames?: Array<Record<string, unknown>>;
  packets?: Array<Record<string, unknown>>;
}
function mediaFacts(data: RawProbeData): MediaFacts {
  const streams = data.streams ?? [];
  return {
    format: {
      name: textFact(data.format?.format_name), startTimeSec: numberFact(data.format?.start_time),
      durationSec: nonnegativeFact(data.format?.duration), sizeBytes: integerFact(data.format?.size, 0), bitRate: nonnegativeFact(data.format?.bit_rate),
    },
    attachedPictureCount: streams.filter(isAttachedPicture).length,
    videos: streams.flatMap((stream, index) => stream.codec_type === "video" && !isAttachedPicture(stream) ? [videoFacts(stream, index)] : []),
    audios: streams.flatMap((stream, index) => stream.codec_type === "audio" ? [{
      ...streamFacts(stream, index), sampleRate: integerFact(stream.sample_rate, 1), channels: integerFact(stream.channels, 1),
      channelLayout: textFact(stream.channel_layout), sampleFormat: textFact(stream.sample_fmt),
      initialPadding: integerFact(stream.initial_padding, 0), trailingPadding: integerFact(stream.trailing_padding, 0),
    }] : []),
  };
}
function parseProbeOutput(stdout: Buffer): RawProbeData {
  try {
    const data = JSON.parse(stdout.toString("utf8")) as RawProbeData;
    if (!data || typeof data !== "object" || Array.isArray(data) ||
      (data.streams !== undefined && (!Array.isArray(data.streams) || data.streams.some((stream) => !stream || typeof stream !== "object")))) throw new Error("Invalid probe structure");
    return data;
  } catch (error) {
    throw new WorkflowFailure("source_media_invalid", "permanent", "Media inspection returned malformed output", { cause: error });
  }
}

function buildSourceProbe(
  durationSec: number | null,
  streams: RawProbeStream[],
  formatTags: Record<string, string> | undefined,
  videoStream: RawProbeStream | undefined,
  audioStream: RawProbeStream | undefined,
  facts: MediaFacts,
): SourceProbe | undefined {
  if (durationSec === null) return undefined;
  const frameRate = videoStream ? measuredFrameRate(videoStream) : null;
  const sampleRate = Number(audioStream?.sample_rate);
  return {
    durationSec,
    facts,
    video: videoStream && videoStream.width && videoStream.height && frameRate
      ? { width: videoStream.width, height: videoStream.height, frameRate, startTimecode: embeddedStartTimecode(streams, formatTags) }
      : null,
    audio: audioStream && Number.isInteger(sampleRate) && sampleRate > 0
      ? { sampleRate, channels: audioStream.channels && audioStream.channels > 0 ? audioStream.channels : 2 }
      : null,
  };
}

function isAttachedPicture(stream: RawProbeStream): boolean {
  if (stream.codec_type !== "video") return false;
  if (stream.disposition?.attached_pic === 1) return true;
  if (stream.disposition?.attached_pic === 0) return false;
  const frameCount = Number(stream.nb_frames);
  if (!Number.isFinite(frameCount) || frameCount > 1) return false;
  if (stream.codec_name && STILL_IMAGE_CODEC_NAMES.has(stream.codec_name)) {
    return true;
  }
  const duration = Number(stream.duration);
  return !Number.isFinite(duration) || duration < 1;
}

class ProductionWorkerProcessModule implements WorkerProcessModule {
  private readonly killGraceMs: number;

  constructor(private readonly dependencies: WorkerProcessModuleDependencies) {
    this.killGraceMs = dependencies.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    if (!Number.isFinite(this.killGraceMs) || this.killGraceMs <= 0) {
      throw new Error("Worker process kill grace must be finite and positive");
    }
  }

  async execute(request: WorkerProcessRequest): Promise<WorkerProcessResult> {
    try {
      if (!request.signal.aborted) (this.dependencies.admission ?? (this === productionWorkerProcessModule ? productionAdmission : undefined))?.beforeStart(request.command);
      return await this.executeAdmitted(request);
    } catch (error) {
      (this.dependencies.admission ?? (this === productionWorkerProcessModule ? productionAdmission : undefined))?.failed(error);
      throw error;
    }
  }

  private async executeAdmitted(request: WorkerProcessRequest): Promise<WorkerProcessResult> {
    if (!Number.isFinite(request.deadlineMs) || request.deadlineMs <= 0) {
      throw new Error("Worker process deadline must be finite and positive");
    }
    const maxStdoutBytes = request.maxStdoutBytes ?? DEFAULT_CAPTURED_STDOUT_BYTES;
    if (
      !Number.isFinite(maxStdoutBytes) ||
      maxStdoutBytes <= 0 ||
      maxStdoutBytes > MAX_CAPTURED_STDOUT_BYTES
    ) {
      throw new Error(
        `Worker process stdout limit must be between 1 and ${MAX_CAPTURED_STDOUT_BYTES} bytes`,
      );
    }
    const startedAtMs = Date.now();
    const diagnose = (event: Omit<WorkerProcessDiagnostic, "elapsedMs">): void => {
      safeDiagnose(request.diagnose, {
        ...event,
        elapsedMs: Date.now() - startedAtMs,
      });
    };
    if (request.signal.aborted) {
      diagnose({
        operation: "cancellation",
        status: "failed",
        failureCode: cancellationFailureCode(request.signal),
      });
      request.signal.throwIfAborted();
    }

    if (this.dependencies.execute) return this.dependencies.execute(request);
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = (this.dependencies.spawn ?? spawn)(request.command, [...request.args], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        });
      } catch (error) {
        if (request.signal.aborted) { reject(request.signal.reason); return; }
        const failure = processStartFailure(error, request.command);
        diagnose(startFailureDiagnostic(failure));
        reject(failure);
        return;
      }
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = "";
      const stderrLines: string[] = [];
      let partialStderrLine = "";
      const collectStderrLines = (lines: readonly string[]): void => {
        const pattern = request.stderrLinePattern;
        if (!pattern) return;
        for (const line of lines) {
          if (stderrLines.length >= MAX_CAPTURED_STDERR_LINES || !pattern.test(line)) continue;
          stderrLines.push(redactUrlSecrets(line).slice(0, MAX_CAPTURED_STDERR_LINE_CHARS));
        }
      };
      let invalidInput = false;
      let terminationReason: "timeout" | "cancellation" | "output_limit" | null = null;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let resourceTimer: ReturnType<typeof setTimeout> | undefined;
      let resourceSampleActive = false;

      const sampleResources = async (): Promise<void> => {
        if (!request.recordResourceSample || settled || resourceSampleActive) {
          return;
        }
        resourceSampleActive = true;
        try {
          request.recordResourceSample(await processTreeRssBytes(child.pid));
        } catch {
          // Resource diagnostics cannot change process execution.
        } finally {
          resourceSampleActive = false;
          if (!settled) {
            resourceTimer = setTimeout(() => void sampleResources(), RESOURCE_SAMPLE_INTERVAL_MS);
          }
        }
      };

      const terminate = (signal: NodeJS.Signals): void => {
        diagnose({
          operation: "termination",
          status: "completed",
          terminationSignal: signal,
        });
        try {
          if (process.platform !== "win32" && child.pid) {
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
        } catch {
          // The process may exit between classification and delivery.
        }
      };
      const beginTermination = (
        reason: "timeout" | "cancellation" | "output_limit",
      ): void => {
        if (terminationReason) return;
        terminationReason = reason;
        diagnose({
          operation: reason,
          status: "failed",
          failureCode:
            reason === "timeout"
              ? "worker_command_timeout"
              : reason === "output_limit"
                ? "worker_command_output_too_large"
                : cancellationFailureCode(request.signal),
          ...(reason === "timeout"
            ? { disposition: "retryable" as const }
            : reason === "output_limit"
              ? { disposition: "permanent" as const }
              : {}),
        });
        terminate("SIGTERM");
        killTimer = setTimeout(() => terminate("SIGKILL"), this.killGraceMs);
      };
      const timeoutTimer = setTimeout(() => beginTermination("timeout"), request.deadlineMs);
      const cancel = (): void => beginTermination("cancellation");
      request.signal.addEventListener("abort", cancel, { once: true });
      if (request.signal.aborted) cancel();
      const cleanup = (): void => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        if (resourceTimer) clearTimeout(resourceTimer);
        request.signal.removeEventListener("abort", cancel);
      };

      child.once("spawn", () => {
        diagnose({ operation: "spawn", status: "completed" });
        void sampleResources();
      });
      child.stdout!.on("data", (chunk: Buffer) => {
        if (!request.captureStdout || terminationReason) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes) {
          beginTermination("output_limit");
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        invalidInput ||= PERMANENT_INPUT_EXIT_PATTERNS.some((pattern) => pattern.test(text));
        // Redact before truncation so a long signature cannot lose its query marker.
        stderr = boundedDiagnostic(stderr + text);
        if (request.stderrLinePattern) {
          const lines = (partialStderrLine + text).split(/\r\n|\r|\n/);
          partialStderrLine = lines.pop() ?? "";
          collectStderrLines(lines);
        }
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (terminationReason === "cancellation") {
          reject(request.signal.reason);
          return;
        }
        if (terminationReason === "timeout") {
          reject(
            new WorkerProcessFailure(
              "worker_command_timeout",
              "retryable",
              `Worker command timed out after ${request.deadlineMs}ms`,
              boundedDiagnostic(stderr),
            ),
          );
          return;
        }
        if (terminationReason === "output_limit") {
          reject(
            new WorkerProcessFailure(
              "worker_command_output_too_large",
              "permanent",
              `Worker command exceeded its ${maxStdoutBytes}-byte stdout limit`,
              boundedDiagnostic(stderr),
            ),
          );
          return;
        }
        const failure = processStartFailure(error, request.command);
        diagnose(startFailureDiagnostic(failure));
        reject(failure);
      });
      child.once("close", async (code) => {
        if (settled) return;
        settled = true;
        if (terminationReason) {
          terminate("SIGKILL");
          await waitForProcessGroupExit(
            child.pid,
            Math.max(this.killGraceMs, PROCESS_GROUP_REAP_TIMEOUT_MS),
          );
        }
        cleanup();
        if (terminationReason === "cancellation") {
          reject(request.signal.reason);
          return;
        }
        if (terminationReason === "timeout") {
          reject(
            new WorkerProcessFailure(
              "worker_command_timeout",
              "retryable",
              `Worker command timed out after ${request.deadlineMs}ms`,
              boundedDiagnostic(stderr),
              code,
            ),
          );
          return;
        }
        if (terminationReason === "output_limit") {
          reject(
            new WorkerProcessFailure(
              "worker_command_output_too_large",
              "permanent",
              `Worker command exceeded its ${maxStdoutBytes}-byte stdout limit`,
              boundedDiagnostic(stderr),
              code,
            ),
          );
          return;
        }
        const accepted = request.acceptableExitCodes ?? [0];
        if (code !== null && accepted.includes(code)) {
          diagnose({ operation: "exit", status: "completed" });
          collectStderrLines([partialStderrLine]);
          resolve({ exitCode: code, stdout: Buffer.concat(stdoutChunks), ...(request.stderrLinePattern ? { stderrLines } : {}) });
          return;
        }
        const failure = exitFailure(code, stderr, invalidInput);
        diagnose({
          operation: "exit",
          status: "failed",
          failureCode: failure.code,
          disposition: failure.disposition,
        });
        reject(failure);
      });
    });
  }

  async start(request: WorkerPersistentProcessRequest): Promise<WorkerPersistentProcess> {
    try {
      if (!request.signal.aborted) (this.dependencies.admission ?? (this === productionWorkerProcessModule ? productionAdmission : undefined))?.beforeStart(request.command);
      return await this.startAdmitted(request);
    } catch (error) {
      (this.dependencies.admission ?? (this === productionWorkerProcessModule ? productionAdmission : undefined))?.failed(error);
      throw error;
    }
  }

  private async startAdmitted(request: WorkerPersistentProcessRequest): Promise<WorkerPersistentProcess> {
    const startedAt = Date.now();
    const diagnose = (event: Omit<WorkerProcessDiagnostic, "elapsedMs">) =>
      safeDiagnose(request.diagnose, { ...event, elapsedMs: Date.now() - startedAt });
    if (request.signal.aborted) {
      diagnose({ operation: "cancellation", status: "failed", failureCode: cancellationFailureCode(request.signal) });
      request.signal.throwIfAborted();
    }
    const deadlineMs = request.startupDeadlineMs ?? 45_000;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      throw new Error("Worker helper startup deadline must be finite and positive");
    }
    if (request.startupReadyMarker && request.startupReadyMarker.length > MAX_DIAGNOSTIC_CHARS) {
      throw new Error("Worker helper readiness marker exceeds the capture limit");
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = (this.dependencies.spawn ?? spawn)(request.command, [...request.args], {
        cwd: request.cwd,
        env: request.env,
        // Keep stdin open for helpers that exit when their owner disappears.
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      request.signal.throwIfAborted();
      const failure = processStartFailure(error, request.command);
      diagnose(startFailureDiagnostic(failure));
      throw failure;
    }
    let closed = false;
    let startupSettled = false;
    let startupReady = false;
    let startupOutput = "";
    let startupErrors = "";
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const terminate = (signal: NodeJS.Signals): void => {
      diagnose({ operation: "termination", status: "completed", terminationSignal: signal });
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* process already exited */ }
    };
    const stop = (): void => {
      if (closed) return;
      terminate("SIGTERM");
      forceKill ??= setTimeout(() => terminate("SIGKILL"), this.killGraceMs);
    };
    let resolveStartup!: () => void;
    let rejectStartup!: (error: unknown) => void;
    const startup = new Promise<void>((resolve, reject) => {
      resolveStartup = () => {
        if (startupSettled) return;
        startupSettled = true;
        startupReady = true;
        startupOutput = "";
        startupErrors = "";
        resolve();
      };
      rejectStartup = (error) => {
        if (startupSettled) return;
        startupSettled = true;
        reject(error);
      };
    });
    const abort = () => {
      diagnose({ operation: "cancellation", status: "failed", failureCode: cancellationFailureCode(request.signal) });
      rejectStartup(request.signal.reason);
      stop();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (startupSettled) return;
      // Helper stdout can contain authentication tokens. It is only a readiness
      // signal, never a diagnostic or log payload.
      startupOutput = (startupOutput + chunk.toString()).slice(-MAX_DIAGNOSTIC_CHARS);
      if (request.startupReadyMarker && startupOutput.includes(request.startupReadyMarker)) resolveStartup();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (startupSettled) return;
      startupErrors = boundedDiagnostic(startupErrors + chunk.toString());
    });
    const exited = new Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }>((resolve) => {
      child.once("close", async (exitCode, signalCode) => {
        closed = true;
        // A detached descendant may survive after the parent's stdio closes.
        if (child.pid) terminate("SIGKILL");
        await waitForProcessGroupExit(child.pid, PROCESS_GROUP_REAP_TIMEOUT_MS);
        if (forceKill) clearTimeout(forceKill);
        request.signal.removeEventListener("abort", abort);
        startupOutput = "";
        diagnose({ operation: "exit", status: exitCode === 0 ? "completed" : "failed" });
        if (!startupReady) rejectStartup(new WorkerProcessFailure(
          "worker_process_startup_failed", "retryable", "Worker helper exited before readiness",
          boundedDiagnostic(startupErrors), exitCode,
          { executableClass: executableClass(request.command), failureScope: "executor" },
        ));
        startupErrors = "";
        resolve({ exitCode, signalCode });
      });
      child.once("spawn", () => {
        diagnose({ operation: "spawn", status: "completed", executableClass: executableClass(request.command) });
        if (!request.startupReadyMarker) resolveStartup();
      });
      child.once("error", (error) => {
        const failure = processStartFailure(error, request.command);
        diagnose(startFailureDiagnostic(failure));
        rejectStartup(failure);
        // Failed spawns have no PID. There is no process to terminate.
        if (child.pid) stop();
      });
    });
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timeout = setTimeout(() => {
      if (startupSettled) return;
      const failure = new WorkerProcessFailure(
        "worker_process_startup_timeout", "retryable", "Worker helper did not become ready",
        boundedDiagnostic(startupErrors), null,
        { executableClass: executableClass(request.command), failureScope: "executor" },
      );
      diagnose({ operation: "timeout", status: "failed", failureCode: failure.code,
        disposition: failure.disposition, executableClass: failure.executableClass, failureScope: failure.failureScope });
      rejectStartup(failure);
      stop();
    }, deadlineMs);
    try {
      await startup;
      request.signal.throwIfAborted();
    } catch (error) {
      if (child.pid) stop();
      await exited;
      request.signal.throwIfAborted();
      throw error;
    } finally { clearTimeout(timeout); }
    return { exited, stop };
  }

  async inspectMedia(request: WorkerMediaInspectionRequest): Promise<WorkerMediaInspection> {
    const startedAt = Date.now();
    const sample = request.sample;
    if (sample && (!Number.isSafeInteger(sample.streamIndex) || sample.streamIndex < 0 ||
      !Number.isInteger(sample.maxPackets) || sample.maxPackets < 1 || sample.maxPackets > 4096 ||
      !Number.isFinite(sample.startSec ?? 0) || (sample.startSec ?? 0) < 0 ||
      (sample.kind !== "frames" && sample.kind !== "packets"))) {
      throw new Error("Media sample requires a stream index, nonnegative start and a 1..4096 packet budget");
    }
    let result: WorkerProcessResult;
    try {
      result = await this.execute({
        command: "ffprobe",
        args: [
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_streams",
          "-show_format",
          ...(/^https?:\/\//i.test(request.sourcePath)
            ? ["-rw_timeout", String(HTTP_SOURCE_RW_TIMEOUT_US)]
            : []),
          request.sourcePath,
        ],
        signal: request.signal,
        deadlineMs: request.deadlineMs,
        captureStdout: true,
        diagnose: request.diagnose,
      });
    } catch (error) {
      if (error instanceof WorkflowFailure && error.code === "worker_command_input_invalid") {
        throw new WorkflowFailure(
          "source_media_invalid",
          "permanent",
          "Media could not be decoded",
          { cause: error },
        );
      }
      throw error;
    }

    const data = parseProbeOutput(result.stdout);
    const streams = data.streams ?? [];
    const hasAudio = streams.some((stream) => stream.codec_type === "audio");
    const hasVisualStream = streams.some((stream) => stream.codec_type === "video");
    if (!hasAudio && !hasVisualStream) {
      throw new WorkflowFailure(
        "source_media_invalid",
        "permanent",
        "Media has no readable audio or visual stream",
      );
    }
    const videoStream = streams.find(
      (stream) => stream.codec_type === "video" && !isAttachedPicture(stream),
    );
    const formatDuration = Number(data.format?.duration);
    const streamDuration = Math.max(
      0,
      ...streams.map((stream) => Number(stream.duration)).filter(Number.isFinite),
    );
    const duration =
      Number.isFinite(formatDuration) && formatDuration > 0 ? formatDuration : streamDuration;
    const durationSec = Number.isFinite(duration) && duration > 0 ? duration : null;
    const facts = mediaFacts(data);
    const videoClock = request.analyzeVideoClock !== false && videoStream ? await this.decideClock(request, startedAt, videoStream, streams.indexOf(videoStream)) : null;
    const sourceProbe = buildSourceProbe(
      durationSec,
      streams,
      data.format?.tags,
      videoStream,
      streams.find((stream) => stream.codec_type === "audio"),
      facts,
    );
    return {
      durationSec,
      width: videoStream?.width ?? 0,
      height: videoStream?.height ?? 0,
      hasVideo: Boolean(videoStream),
      hasAudio,
      hasVisualStream,
      fps: videoClock?.constantRate
        ? videoClock.constantRate.numerator / videoClock.constantRate.denominator
        : parseFrameRate(videoStream?.r_frame_rate),
      ...(videoClock ? { videoClock } : {}),
      ...(sourceProbe ? { sourceProbe } : {}),
      facts,
      ...(request.sample ? { samples: await this.inspectSamples(request, startedAt) } : {}),
    };
  }

  /** Examine the video clock when the stream's rates disagree. Missing
   *  timestamp evidence never fails the inspection: the source is rendered
   *  with the best clock the rates allow. */
  private async decideClock(
    request: WorkerMediaInspectionRequest,
    startedAt: number,
    stream: RawProbeStream,
    streamIndex: number,
  ): Promise<VideoClockDecision | null> {
    const decision = await decideVideoClock(stream, async () => {
      const deadlineMs = request.deadlineMs - (Date.now() - startedAt);
      if (deadlineMs <= 0) return null;
      try {
        const result = await this.execute({
          command: "ffprobe",
          args: ["-v", "error", "-print_format", "json", "-select_streams", String(stream.index ?? streamIndex),
            "-read_intervals", `%+#${CLOCK_PACKET_BUDGET}`, "-show_packets", "-show_entries", "packet=pts_time,dts_time",
            ...(/^https?:\/\//i.test(request.sourcePath) ? ["-rw_timeout", String(HTTP_SOURCE_RW_TIMEOUT_US)] : []),
            request.sourcePath],
          signal: request.signal, deadlineMs, captureStdout: true, maxStdoutBytes: 1024 * 1024, diagnose: request.diagnose,
        });
        const packets = parseProbeOutput(result.stdout).packets;
        if (!Array.isArray(packets)) return null;
        return packets.flatMap((packet) => {
          const time = numberFact(packet?.pts_time ?? packet?.dts_time);
          return time === null ? [] : [time];
        });
      } catch (error) {
        request.signal.throwIfAborted();
        if (executorProcessFailure(error)) throw error;
        return null;
      }
    });
    if (decision?.constantRate) {
      console.warn(JSON.stringify({
        level: "info", message: "Variable frame rate source normalized to a constant rate",
        reason: decision.reason, constantRate: decision.constantRate, baseRate: decision.baseRate,
        averageRate: decision.averageRate, variable: decision.variable, packetsSampled: decision.packetsSampled,
      }));
    }
    return decision;
  }

  private async inspectSamples(request: WorkerMediaInspectionRequest, startedAt: number): Promise<WorkerMediaSamples> {
    const sample = request.sample!;
    const deadlineMs = request.deadlineMs - (Date.now() - startedAt);
    if (deadlineMs <= 0) throw new WorkerProcessFailure("worker_command_timeout", "retryable", "Media inspection deadline exceeded", "");
    const result = await this.execute({
      command: "ffprobe",
      args: ["-v", "error", "-print_format", "json", "-select_streams", String(sample.streamIndex),
        "-read_intervals", `${sample.startSec ?? 0}%+#${sample.maxPackets}`,
        sample.kind === "frames" ? "-show_frames" : "-show_packets",
        "-show_entries", sample.kind === "frames"
          ? "frame=stream_index,pts,pts_time,pkt_dts,pkt_dts_time,duration,duration_time,pkt_duration,pkt_duration_time,best_effort_timestamp_time,nb_samples,key_frame,pkt_size"
          : "packet=stream_index,pts,pts_time,dts,dts_time,duration,duration_time,size,flags",
        ...(/^https?:\/\//i.test(request.sourcePath) ? ["-rw_timeout", String(HTTP_SOURCE_RW_TIMEOUT_US)] : []),
        request.sourcePath],
      signal: request.signal, deadlineMs, captureStdout: true, maxStdoutBytes: 4 * 1024 * 1024, diagnose: request.diagnose,
    });
    const data = parseProbeOutput(result.stdout);
    const entries = sample.kind === "frames" ? data.frames : data.packets;
    if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry !== "object")) {
      throw new WorkflowFailure("source_media_invalid", "permanent", "Media inspection returned malformed sample output");
    }
    return {
      ...sample, startSec: sample.startSec ?? 0,
      items: entries.slice(0, sample.maxPackets).map((entry) => ({
        streamIndex: integerFact(entry.stream_index, 0) ?? sample.streamIndex,
        pts: integerFact(entry.pts), ptsSec: numberFact(entry.pts_time),
        dts: integerFact(entry.dts ?? entry.pkt_dts), dtsSec: numberFact(entry.dts_time ?? entry.pkt_dts_time),
        duration: integerFact(entry.duration ?? entry.pkt_duration), durationSec: nonnegativeFact(entry.duration_time ?? entry.pkt_duration_time),
        bestEffortTimestampSec: numberFact(entry.best_effort_timestamp_time), samples: integerFact(entry.nb_samples, 0),
        keyFrame: entry.key_frame === undefined ? typeof entry.flags === "string" ? entry.flags.includes("K") : null : entry.key_frame === 1,
        sizeBytes: integerFact(entry.size ?? entry.pkt_size, 0),
      })),
    };
  }

  async withScratchDirectory<T>(
    prefix: string,
    work: (directory: string) => Promise<T>,
    diagnose?: (event: WorkerProcessDiagnostic) => void,
    ownership?: ScratchOwnership,
  ): Promise<T> {
    const create =
      this.dependencies.createScratchDirectory ??
      ((scratchPrefix: string) => mkdtemp(join(this.dependencies.scratchRoot ?? tmpdir(), scratchPrefix)));
    const remove =
      this.dependencies.removeScratchDirectory ??
      ((directory: string) => rm(directory, { recursive: true, force: true }));
    const directory = await create(prefix);
    const startedAtMs = Date.now();
    // Injected directories are the caller's own fixtures; only real ones carry ownership.
    const owned = this.dependencies.createScratchDirectory === undefined;
    try {
      if (owned) await registerScratchDirectory(directory, ownership);
      return await work(directory);
    } finally {
      if (owned) unregisterScratchDirectory(directory);
      try {
        await remove(directory);
      } catch (error) {
        const event: WorkerProcessDiagnostic = {
          operation: "scratch_cleanup",
          status: "failed",
          elapsedMs: Date.now() - startedAtMs,
          failureCode: "worker_scratch_cleanup_failed",
          disposition: "retryable",
        };
        safeDiagnose(diagnose, event);
        if (!diagnose) {
          console.warn(
            JSON.stringify({
              level: "warn",
              message: "worker_scratch_cleanup_failed",
              directory,
              error: boundedDiagnostic(error instanceof Error ? error.message : String(error)),
            }),
          );
        }
      }
    }
  }
}

export function createWorkerProcessModule(
  dependencies: WorkerProcessModuleDependencies = {},
): WorkerProcessModule {
  return new ProductionWorkerProcessModule(dependencies);
}

function productionKillGraceMs(): number {
  const configured = Number(process.env.WORKER_PROCESS_KILL_GRACE_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_KILL_GRACE_MS;
}

export const productionWorkerProcessModule = createWorkerProcessModule({
  killGraceMs: productionKillGraceMs(),
});

// --- Scratch ownership, heartbeat and abandoned-directory sweep ----------------
//
// Every scratch directory this module creates carries an owner marker. While the
// process lives, the marker's mtime is refreshed; a crash or SIGKILL leaves the
// directory behind with a marker that stops moving. The sweep removes only such
// marked directories, and only when no live local process (a fresh marker) and no
// unexpired database claim (the injected check) still owns them.

export const SCRATCH_OWNER_FILE = ".narriflow-scratch-owner.json";
const SCRATCH_DIRECTORY_PREFIX = "narriflow-";
const SCRATCH_HEARTBEAT_MS = 30_000;

/** Opaque references the database ownership check understands. */
export interface ScratchOwnership {
  workflowRunId?: string;
  attemptId?: string;
}

interface ScratchOwnerRecord {
  version: 1;
  instanceId: string;
  host: string;
  pid: number;
  createdAtMs: number;
  ownership?: ScratchOwnership;
}

const workerInstanceId = randomUUID();
const activeScratch = new Set<string>();
let scratchHeartbeat: ReturnType<typeof setInterval> | undefined;
let exitHookInstalled = false;

function touchActiveScratchMarkers(): void {
  const now = new Date();
  for (const directory of activeScratch) {
    utimes(join(directory, SCRATCH_OWNER_FILE), now, now).catch(() => {});
  }
}

async function registerScratchDirectory(directory: string, ownership: ScratchOwnership | undefined): Promise<void> {
  const record: ScratchOwnerRecord = {
    version: 1,
    instanceId: workerInstanceId,
    host: hostname(),
    pid: process.pid,
    createdAtMs: Date.now(),
    ...(ownership ? { ownership } : {}),
  };
  await writeFile(join(directory, SCRATCH_OWNER_FILE), JSON.stringify(record), { flag: "w" });
  activeScratch.add(directory);
  if (!scratchHeartbeat) {
    scratchHeartbeat = setInterval(touchActiveScratchMarkers, SCRATCH_HEARTBEAT_MS);
    scratchHeartbeat.unref();
  }
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // process.exit() and signal-driven shutdown skip `finally`: remove what is still live.
    process.once("exit", () => {
      for (const active of activeScratch) {
        try {
          rmSync(active, { recursive: true, force: true });
        } catch {
          // The startup sweep removes it later.
        }
      }
    });
  }
}

function unregisterScratchDirectory(directory: string): void {
  activeScratch.delete(directory);
  if (activeScratch.size === 0 && scratchHeartbeat) {
    clearInterval(scratchHeartbeat);
    scratchHeartbeat = undefined;
  }
}

/** Directories this process is using right now (for readiness and tests). */
export function activeScratchDirectories(): readonly string[] {
  return [...activeScratch];
}

export interface ScratchSweepOptions {
  /** Where scratch directories live (default: the OS temp directory). */
  root?: string;
  nowMs?: number;
  /** Marker age after which a directory counts as abandoned. Default: maximum lease plus `graceMs`. */
  staleAfterMs?: number;
  graceMs?: number;
  /** True while the database still holds an unexpired claim for the recorded work. */
  isOwnerActive?(ownership: ScratchOwnership | undefined): Promise<boolean>;
  remove?(directory: string): Promise<void>;
}

export interface ScratchSweepResult {
  scanned: number;
  removed: string[];
  skipped: Array<{ directory: string; reason: "unmarked" | "other_host" | "active_local" | "fresh" | "claim_active" }>;
  failed: string[];
}

function localScratchOwnerAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export async function sweepAbandonedScratch(options: ScratchSweepOptions = {}): Promise<ScratchSweepResult> {
  const root = options.root ?? tmpdir();
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? WORKFLOW_LEASE_DURATION_MS + (options.graceMs ?? 10 * 60 * 1000);
  const remove = options.remove ?? ((directory: string) => rm(directory, { recursive: true, force: true }));
  const result: ScratchSweepResult = { scanned: 0, removed: [], skipped: [], failed: [] };
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SCRATCH_DIRECTORY_PREFIX)) continue;
    const directory = join(root, entry.name);
    result.scanned += 1;
    const marker = join(directory, SCRATCH_OWNER_FILE);
    let record: ScratchOwnerRecord;
    let markerMtimeMs: number;
    try {
      record = JSON.parse(await readFile(marker, "utf8")) as ScratchOwnerRecord;
      markerMtimeMs = (await stat(marker)).mtimeMs;
    } catch {
      result.skipped.push({ directory, reason: "unmarked" });
      continue;
    }
    if (record.version !== 1 || typeof record.host !== "string") {
      result.skipped.push({ directory, reason: "unmarked" });
    } else if (record.host !== hostname()) {
      result.skipped.push({ directory, reason: "other_host" });
    } else if (activeScratch.has(directory) || localScratchOwnerAlive(record.pid)) {
      result.skipped.push({ directory, reason: "active_local" });
    } else if (nowMs - markerMtimeMs < staleAfterMs) {
      // A live local worker refreshes its marker; a young one may belong to it.
      result.skipped.push({ directory, reason: "fresh" });
    } else if (await options.isOwnerActive?.(record.ownership)) {
      result.skipped.push({ directory, reason: "claim_active" });
    } else {
      try {
        await remove(directory);
        result.removed.push(directory);
      } catch {
        result.failed.push(directory);
      }
    }
  }
  return result;
}
