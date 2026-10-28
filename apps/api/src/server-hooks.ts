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
 */
export interface ApiLifecycle {
  readonly draining: boolean;
  /** Returns an unregister function; call it when the work ends on its own. */
  onDrain(closer: () => void | Promise<void>): () => void;
  beginDrain(): Promise<void>;
}

export function createLifecycle(): ApiLifecycle {
  const closers = new Set<() => void | Promise<void>>();
  let draining = false;
  return {
    get draining() {
      return draining;
    },
    onDrain(closer) {
      closers.add(closer);
      return () => {
        closers.delete(closer);
      };
    },
    async beginDrain() {
      draining = true;
      const pending = [...closers];
      closers.clear();
      await Promise.allSettled(pending.map((closer) => closer()));
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
  bindings(c).server?.timeout(c.req.raw, 0);
}

export function getLifecycle(c: Context<ApiEnv>): ApiLifecycle | undefined {
  return bindings(c).lifecycle;
}

/** The socket peer address, for per-IP limits when no trusted ingress header applies. */
export function socketAddress(c: Context<ApiEnv>): string | undefined {
  return bindings(c).server?.requestIP(c.req.raw)?.address;
}
