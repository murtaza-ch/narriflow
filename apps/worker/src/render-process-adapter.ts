import { spawn } from "node:child_process";
import { WorkflowFailure } from "@narriflow/services";

const MAX_DIAGNOSTIC_CHARS = 8192;

function redactUrlQueries(text: string): string {
  return text.replace(/\?[^\s"']+/g, "?[redacted]");
}

export interface RenderProcessRequest {
  command: string;
  args: readonly string[];
  signal: AbortSignal;
  deadlineMs: number;
  killGraceMs: number;
  captureStdout: boolean;
}

export class ProductionRenderProcessAdapter {
  execute(request: RenderProcessRequest): Promise<string> {
    if (!Number.isFinite(request.deadlineMs) || request.deadlineMs <= 0) {
      throw new Error("Render process deadline must be finite and positive");
    }
    if (!Number.isFinite(request.killGraceMs) || request.killGraceMs <= 0) {
      throw new Error("Render process kill grace must be finite and positive");
    }
    request.signal.throwIfAborted();
    return new Promise<string>((resolve, reject) => {
      const child = spawn(request.command, [...request.args], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const terminate = (signal: NodeJS.Signals) => {
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
      const escalate = () => {
        terminate("SIGTERM");
        killTimer = setTimeout(
          () => terminate("SIGKILL"),
          request.killGraceMs,
        );
      };
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        escalate();
      }, request.deadlineMs);
      const cancel = () => {
        cancelled = true;
        escalate();
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      if (request.signal.aborted) cancel();
      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        request.signal.removeEventListener("abort", cancel);
      };

      if (request.captureStdout) {
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
      }
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-MAX_DIAGNOSTIC_CHARS);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        cleanup();
        reject(
          error.code === "ENOENT"
            ? new WorkflowFailure(
                "worker_command_missing",
                "permanent",
                "Required render executable is unavailable",
              )
            : error,
        );
      });
      child.on("close", (code) => {
        cleanup();
        if (cancelled) {
          reject(
            request.signal.reason instanceof Error
              ? request.signal.reason
              : new DOMException("Render command cancelled", "AbortError"),
          );
        } else if (timedOut) {
          reject(
            new WorkflowFailure(
              "worker_command_timeout",
              "retryable",
              `Render command timed out after ${request.deadlineMs}ms`,
            ),
          );
        } else if (code === 0) {
          resolve(stdout);
        } else {
          reject(
            new WorkflowFailure(
              "worker_command_failed",
              "retryable",
              `Render command failed with code ${code}: ${redactUrlQueries(stderr.slice(-500))}`,
            ),
          );
        }
      });
    });
  }
}

export const productionRenderProcessAdapter =
  new ProductionRenderProcessAdapter();
