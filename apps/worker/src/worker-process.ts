import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowFailure } from "@narriflow/services";

const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_MEDIA_FPS = 30;
export const HTTP_SOURCE_RW_TIMEOUT_US = 30_000_000;
const MAX_DIAGNOSTIC_CHARS = 8_192;
const PROCESS_GROUP_REAP_TIMEOUT_MS = 1_000;
const RESOURCE_SAMPLE_INTERVAL_MS = 100;

export interface WorkerProcessRequest {
  command: string;
  args: readonly string[];
  signal: AbortSignal;
  deadlineMs: number;
  acceptableExitCodes?: readonly number[];
  captureStdout?: boolean;
  recordResourceSample?(rssBytes: number): void;
  diagnose?(event: WorkerProcessDiagnostic): void;
}

export interface WorkerProcessResult {
  exitCode: number;
  stdout: Buffer;
}

export interface WorkerProcessDiagnostic {
  operation: "spawn" | "timeout" | "exit" | "cancellation" | "termination" | "scratch_cleanup";
  status: "completed" | "failed";
  elapsedMs: number;
  failureCode?: string;
  disposition?: "retryable" | "permanent";
  terminationSignal?: NodeJS.Signals;
}

export interface WorkerMediaInspection {
  durationSec: number | null;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  hasVisualStream: boolean;
  fps: number;
}

export interface WorkerMediaInspectionRequest {
  sourcePath: string;
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
  ): Promise<T>;
}

export class WorkerProcessFailure extends WorkflowFailure {
  constructor(
    code: string,
    disposition: "retryable" | "permanent",
    message: string,
    public readonly diagnostic: string,
    public readonly exitCode: number | null = null,
    options?: ErrorOptions,
  ) {
    super(code, disposition, message, options);
    this.name = "WorkerProcessFailure";
  }
}

interface RawProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
}

export interface WorkerProcessModuleDependencies {
  killGraceMs?: number;
  execute?: (request: WorkerProcessRequest) => Promise<WorkerProcessResult>;
  createScratchDirectory?: (prefix: string) => Promise<string>;
  removeScratchDirectory?: (directory: string) => Promise<void>;
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

function redactUrlQueries(text: string): string {
  return text.replace(/\?[^\s"']+/g, "?[redacted]");
}

function boundedDiagnostic(text: string): string {
  return redactUrlQueries(text).slice(-MAX_DIAGNOSTIC_CHARS);
}

function cancellationFailureCode(signal: AbortSignal): string {
  return signal.reason instanceof Error &&
    "code" in signal.reason &&
    typeof signal.reason.code === "string"
    ? signal.reason.code
    : "worker_command_cancelled";
}

function exitFailure(
  code: number | null,
  stderr: string,
  invalidInput: boolean,
): WorkerProcessFailure {
  const diagnostic = boundedDiagnostic(stderr);
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
    } catch {
      return;
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
    if (this.dependencies.execute) return this.dependencies.execute(request);
    if (!Number.isFinite(request.deadlineMs) || request.deadlineMs <= 0) {
      throw new Error("Worker process deadline must be finite and positive");
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

    return new Promise((resolve, reject) => {
      const child = spawn(request.command, [...request.args], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const stdoutChunks: Buffer[] = [];
      let stderr = "";
      let invalidInput = false;
      let terminationReason: "timeout" | "cancellation" | null = null;
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
      const beginTermination = (reason: "timeout" | "cancellation"): void => {
        if (terminationReason) return;
        terminationReason = reason;
        diagnose({
          operation: reason,
          status: "failed",
          failureCode:
            reason === "timeout"
              ? "worker_command_timeout"
              : cancellationFailureCode(request.signal),
          ...(reason === "timeout" ? { disposition: "retryable" as const } : {}),
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
      child.stdout.on("data", (chunk: Buffer) => {
        if (request.captureStdout) stdoutChunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        invalidInput ||= PERMANENT_INPUT_EXIT_PATTERNS.some((pattern) => pattern.test(text));
        stderr = (stderr + text).slice(-MAX_DIAGNOSTIC_CHARS * 2);
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
        const failure =
          error.code === "ENOENT"
            ? new WorkerProcessFailure(
                "worker_command_missing",
                "permanent",
                "Required worker executable is unavailable",
                "",
                null,
              )
            : new WorkerProcessFailure(
                "worker_command_spawn_failed",
                "retryable",
                "Worker command could not be started",
                "",
                null,
                { cause: error },
              );
        diagnose({
          operation: "spawn",
          status: "failed",
          failureCode: failure.code,
          disposition: failure.disposition,
        });
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
        const accepted = request.acceptableExitCodes ?? [0];
        if (code !== null && accepted.includes(code)) {
          diagnose({ operation: "exit", status: "completed" });
          resolve({ exitCode: code, stdout: Buffer.concat(stdoutChunks) });
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

  async inspectMedia(request: WorkerMediaInspectionRequest): Promise<WorkerMediaInspection> {
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

    let data: {
      streams?: RawProbeStream[];
      format?: { duration?: string };
    };
    try {
      data = JSON.parse(result.stdout.toString("utf8")) as typeof data;
    } catch (error) {
      throw new WorkflowFailure(
        "source_media_invalid",
        "permanent",
        "Media inspection returned malformed output",
        error instanceof Error ? { cause: error } : undefined,
      );
    }
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
    return {
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
      width: videoStream?.width ?? 0,
      height: videoStream?.height ?? 0,
      hasVideo: Boolean(videoStream),
      hasAudio,
      hasVisualStream,
      fps: parseFrameRate(videoStream?.r_frame_rate),
    };
  }

  async withScratchDirectory<T>(
    prefix: string,
    work: (directory: string) => Promise<T>,
    diagnose?: (event: WorkerProcessDiagnostic) => void,
  ): Promise<T> {
    const create =
      this.dependencies.createScratchDirectory ??
      ((scratchPrefix: string) => mkdtemp(join(tmpdir(), scratchPrefix)));
    const remove =
      this.dependencies.removeScratchDirectory ??
      ((directory: string) => rm(directory, { recursive: true, force: true }));
    const directory = await create(prefix);
    const startedAtMs = Date.now();
    try {
      return await work(directory);
    } finally {
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
