import { spawn } from "node:child_process";
import { WorkflowFailure } from "@narriflow/services";

const MAX_DIAGNOSTIC_CHARS = 8192;

function redactUrlQueries(text: string): string {
  return text.replace(/\?[^\s"']+/g, "?[redacted]");
}

const PERMANENT_INPUT_EXIT_PATTERNS = [
  /invalid data found when processing input/i,
  /moov atom not found/i,
] as const;

function cancellationFailureCode(signal: AbortSignal): string {
  return signal.reason instanceof Error &&
    "code" in signal.reason &&
    typeof signal.reason.code === "string"
    ? signal.reason.code
    : "render_command_cancelled";
}

function commandExitFailure(code: number | null, stderr: string): WorkflowFailure {
  const diagnostic = redactUrlQueries(stderr.slice(-500));
  if (PERMANENT_INPUT_EXIT_PATTERNS.some((pattern) => pattern.test(stderr))) {
    return new WorkflowFailure(
      "worker_command_input_invalid",
      "permanent",
      `Render command rejected invalid input: ${diagnostic}`,
    );
  }
  return new WorkflowFailure(
    "worker_command_failed",
    "retryable",
    `Render command failed with code ${code}: ${diagnostic}`,
  );
}

async function waitForProcessGroupExit(
  pid: number | undefined,
  timeoutMs: number,
): Promise<void> {
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

export interface RenderProcessRequest {
  command: string;
  args: readonly string[];
  signal: AbortSignal;
  deadlineMs: number;
  killGraceMs: number;
  captureStdout: boolean;
  diagnose?(event: RenderProcessDiagnostic): void;
}

export interface RenderProcessDiagnostic {
  operation: "spawn" | "timeout" | "exit" | "cancellation" | "termination";
  status: "completed" | "failed";
  elapsedMs: number;
  failureCode?: string;
  disposition?: "retryable" | "permanent";
  terminationSignal?: NodeJS.Signals;
}

export class ProductionRenderProcessAdapter {
  async execute(request: RenderProcessRequest): Promise<string> {
    if (!Number.isFinite(request.deadlineMs) || request.deadlineMs <= 0) {
      throw new Error("Render process deadline must be finite and positive");
    }
    if (!Number.isFinite(request.killGraceMs) || request.killGraceMs <= 0) {
      throw new Error("Render process kill grace must be finite and positive");
    }
    const startedAtMs = Date.now();
    const diagnose = (
      event: Omit<RenderProcessDiagnostic, "elapsedMs">,
    ): void => {
      try {
        request.diagnose?.({
          ...event,
          elapsedMs: Date.now() - startedAtMs,
        });
      } catch {
        // Diagnostics must never change command execution.
      }
    };
    if (request.signal.aborted) {
      diagnose({
        operation: "cancellation",
        status: "failed",
        failureCode: cancellationFailureCode(request.signal),
      });
      request.signal.throwIfAborted();
    }
    return new Promise<string>((resolve, reject) => {
      const child = spawn(request.command, [...request.args], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let terminationReason: "timeout" | "cancellation" | null = null;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const terminate = (signal: NodeJS.Signals) => {
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
          // The process may have exited between classification and delivery.
        }
      };
      const beginTermination = (reason: "timeout" | "cancellation") => {
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
        killTimer = setTimeout(
          () => terminate("SIGKILL"),
          request.killGraceMs,
        );
      };
      const timeoutTimer = setTimeout(() => {
        beginTermination("timeout");
      }, request.deadlineMs);
      const cancel = () => {
        beginTermination("cancellation");
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      if (request.signal.aborted) cancel();
      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        request.signal.removeEventListener("abort", cancel);
      };

      child.once("spawn", () => {
        diagnose({ operation: "spawn", status: "completed" });
      });

      if (request.captureStdout) {
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
      }
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-MAX_DIAGNOSTIC_CHARS);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        cleanup();
        const failure =
          error.code === "ENOENT"
            ? new WorkflowFailure(
                "worker_command_missing",
                "permanent",
                "Required render executable is unavailable",
              )
            : new WorkflowFailure(
                "worker_command_spawn_failed",
                "retryable",
                "Render command could not be started",
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
      child.on("close", async (code) => {
        if (settled) return;
        settled = true;
        if (terminationReason) {
          // The root may exit on TERM while a descendant ignores it. Sweep
          // the detached process group before reporting cancellation or
          // timeout completion so temporary files are safe to remove.
          terminate("SIGKILL");
          await waitForProcessGroupExit(child.pid, request.killGraceMs);
        }
        cleanup();
        if (terminationReason === "cancellation") {
          reject(
            request.signal.reason instanceof Error
              ? request.signal.reason
              : new DOMException("Render command cancelled", "AbortError"),
          );
        } else if (terminationReason === "timeout") {
          reject(
            new WorkflowFailure(
              "worker_command_timeout",
              "retryable",
              `Render command timed out after ${request.deadlineMs}ms`,
            ),
          );
        } else if (code === 0) {
          diagnose({ operation: "exit", status: "completed" });
          resolve(stdout);
        } else {
          const failure = commandExitFailure(code, stderr);
          diagnose({
            operation: "exit",
            status: "failed",
            failureCode: failure.code,
            disposition: failure.disposition,
          });
          reject(failure);
        }
      });
    });
  }
}

export const productionRenderProcessAdapter =
  new ProductionRenderProcessAdapter();
