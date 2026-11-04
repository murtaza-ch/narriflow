import type { Context } from "hono";
import type { ApiEnv } from "./http/env";

/** The slice of the runtime's server handle that handlers may use. */
export interface ServerHandle {
  requestIP(request: Request): { address: string } | null;
}

/** Hono `env` bindings supplied by `src/index.ts` (and by tests). */
export interface ServerBindings {
  server?: ServerHandle;
}

function bindings(c: Context<ApiEnv>): ServerBindings {
  return (c.env ?? {}) as ServerBindings;
}

/** The socket peer address, for per-IP limits when no trusted ingress header applies. */
export function socketAddress(c: Context<ApiEnv>): string | undefined {
  return bindings(c).server?.requestIP(c.get("ingressRequest") ?? c.req.raw)?.address;
}
