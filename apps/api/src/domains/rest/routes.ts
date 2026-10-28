import { Hono } from "hono";
import type { ApiEnv } from "../../http/env";

/** Dependencies of the public REST app. The REST owner replaces this with the real services. */
export type RestRouteDeps = Record<string, never>;

/**
 * Public REST v1, mounted at `/api/v1` outside the first-party chain: it
 * authenticates `nf_` keys itself and keeps its own error envelope. Operations
 * are declared with `createRoute` on an OpenAPI app by the REST owner.
 */
export function createRestRoutes(_deps: RestRouteDeps) {
  return new Hono<ApiEnv>();
}

export type RestRoutes = ReturnType<typeof createRestRoutes>;
