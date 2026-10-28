import type { Context } from "hono";
import type { ApiEnv } from "./http/env";

/** The slice of `Bun.Server` that handlers may use. */
export interface ServerHandle {
  /** Per-request idle timeout in seconds; 0 disables it for that request. */
  timeout(request: Request, seconds: number): void;
  requestIP(request: Request): { address: string } | null;
}

/**
 * Process lifecycle that routes can hook into. Long-lived work (the progress
 * stream) registers a closer; `beginDrain` runs them all on SIGTERM so no
 * subscriber outlives the process.
 *
 * Draining starts synchronously: from the first line of `beginDrain` the app
 * refuses new requests (`drainGate`), and a closer registered after that point
 * (a request that was already past admission when SIGTERM arrived) runs
 * immediately instead of waiting for a drain that has already happened.
 */
export interface ApiLifecycle {
  readonly draining: boolean;
  /**
   * Returns an unregister function; call it when the work ends on its own.
   * While draining the closer is invoked at once and the function is a no-op.
   */
  onDrain(closer: () => void | Promise<void>): () => void;
  /** Idempotent: every call resolves when the same drain has finished. */
  beginDrain(): Promise<void>;
}

function logCloserFailure(error: unknown): void {
  console.warn(
    JSON.stringify({
      level: "error",
      message: "api_drain_closer_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }),
  );
}

/** Runs one closer to completion; a synchronous throw or a rejection never stops the others. */
async function runCloser(closer: () => void | Promise<void>): Promise<void> {
  try {
    await closer();
  } catch (error) {
    logCloserFailure(error);
  }
}

export function createLifecycle(): ApiLifecycle {
  const closers = new Set<() => void | Promise<void>>();
  let draining = false;
  let drained: Promise<void> | undefined;
  return {
    get draining() {
      return draining;
    },
    onDrain(closer) {
      if (draining) {
        void runCloser(closer);
        return () => undefined;
      }
      closers.add(closer);
      return () => {
        closers.delete(closer);
      };
    },
    beginDrain() {
      draining = true;
      drained ??= Promise.all([...closers].map(runCloser)).then(() => {
        closers.clear();
      });
      return drained;
    },
  };
}

/** Hono `env` bindings supplied by `src/index.ts` (and by tests). */
export interface ServerBindings {
  server?: ServerHandle;
  lifecycle?: ApiLifecycle;
}

function bindings(c: Context<ApiEnv>): ServerBindings {
  return (c.env ?? {}) as ServerBindings;
}

/**
 * Bun closes a connection that is idle longer than `idleTimeout`, which would
 * kill an event stream between 15-second heartbeats. Call this once an SSE
 * request is admitted; ordinary requests keep the process-wide timeout.
 */
export function disableIdleTimeout(c: Context<ApiEnv>): void {
  bindings(c).server?.timeout(c.get("ingressRequest") ?? c.req.raw, 0);
}

export function getLifecycle(c: Context<ApiEnv>): ApiLifecycle | undefined {
  return bindings(c).lifecycle;
}

/** The socket peer address, for per-IP limits when no trusted ingress header applies. */
export function socketAddress(c: Context<ApiEnv>): string | undefined {
  return bindings(c).server?.requestIP(c.get("ingressRequest") ?? c.req.raw)?.address;
}
