import type { Server } from "node:http";
import { assertRenderEnvironment, loadLock } from "../scripts/check-render-environment";
import { executorProcessFailure, WorkerProcessFailure } from "./worker-process";

/** Port ownership is established before any polling, including startup sweeps. */
export async function reserveWorkerHealthPort(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function verifySharedRenderEnvironment(): Promise<void> {
  const fingerprint = await assertRenderEnvironment();
  // The golden CLI allows report-only hosts. Shared queues never do.
  if (!loadLock().platforms[fingerprint.platform] || !fingerprint.glyphRender.sha256 ||
    Object.values(fingerprint.filters).some((present) => !present) ||
    Object.values(fingerprint.encoders).some((present) => !present)) {
    throw new Error("shared_render_runtime_unverified");
  }
}

const mediaStartedByFailure = new WeakMap<Error, boolean>();
export function recordRenderInterruption(error: unknown, mediaStarted: boolean): void {
  if (error instanceof Error) mediaStartedByFailure.set(error, mediaStarted);
}
export function renderInterruptionMediaStarted(error: unknown): boolean {
  return error instanceof Error && mediaStartedByFailure.get(error) === true;
}

/** Health recovery is independent of the existing poll stall watchdog. */
export class RenderExecutorHealth {
  private state: "starting" | "healthy" | "quarantined" | "recycling" = "starting";
  private failure: WorkerProcessFailure | null = null;
  private nextCheckAtMs = 0;
  private failedChecks = 0;
  private checking = false;

  constructor(private readonly dependencies: {
    check(): Promise<void>;
    recycle(): void;
    nowMs?: () => number;
    checkDelayMs?: number;
    diagnose?: (event: Record<string, unknown>) => void;
  }) {}

  snapshot() {
    return { state: this.state, ready: this.state === "healthy", failedChecks: this.failedChecks,
      failureCode: this.failure?.code ?? null, errno: this.failure?.errno,
      executableClass: this.failure?.executableClass, nextCheckAtMs: this.nextCheckAtMs };
  }

  beforeStart = (command: string): void => {
    // YouTube intake has its own supervisor; it cannot determine render health.
    if (!["ffmpeg", "ffprobe", "python", "python3"].includes(command.split("/").pop() ?? "") && !command.includes("python")) return;
    this.assertReady();
  };

  assertReady(): void {
    if (this.state !== "healthy") throw this.failure ?? new WorkerProcessFailure(
      "render_executor_unready", "retryable", "Render executor is not ready", "", null,
      { failureScope: "executor" });
  }

  failed = (error: unknown): void => {
    const failure = executorProcessFailure(error);
    if (!failure || (failure.executableClass && !["ffmpeg", "ffprobe", "python"].includes(failure.executableClass)) || this.state === "quarantined" || this.state === "recycling") return;
    this.failure = failure;
    this.state = "quarantined";
    this.failedChecks = 0;
    this.nextCheckAtMs = this.now() + (this.dependencies.checkDelayMs ?? 30_000);
    this.dependencies.diagnose?.({ message: "render_executor_quarantined", failureCode: failure.code,
      errno: failure.errno, executableClass: failure.executableClass, failureScope: failure.failureScope });
  };

  private now(): number { return this.dependencies.nowMs?.() ?? Date.now(); }

  async checkIfDue(): Promise<void> {
    if (this.checking || this.state === "recycling" || this.state === "healthy" || this.now() < this.nextCheckAtMs) return;
    this.checking = true;
    try {
      // Fingerprint probes use their own bounded process owner, so quarantine
      // never needs a process-wide admission bypass.
      await this.dependencies.check();
      this.state = "healthy";
      this.failure = null;
      this.failedChecks = 0;
    } catch {
      if (!this.failure) this.dependencies.diagnose?.({ message: "render_environment_invalid", failureScope: "configuration" });
      this.failure ??= new WorkerProcessFailure("render_environment_invalid", "retryable",
        "Render runtime verification failed", "", null, { failureScope: "configuration" });
      this.state = "quarantined";
      this.failedChecks += 1;
      this.nextCheckAtMs = this.now() + (this.dependencies.checkDelayMs ?? 30_000);
      if (this.failedChecks >= 2) {
        this.state = "recycling";
        this.dependencies.recycle();
      }
    } finally { this.checking = false; }
  }
}
