import { Hono } from "hono";
import type { ApiEnv } from "../../http/env";

/** Dependencies of the developer routes. The owning ticket replaces this with the services it calls. */
export type DeveloperRouteDeps = Record<string, never>;

/** Developer settings: API keys, callback signing secret and webhook subscriptions. */
export function createDeveloperRoutes(_deps: DeveloperRouteDeps) {
  return new Hono<ApiEnv>();
}

export type DeveloperRoutes = ReturnType<typeof createDeveloperRoutes>;
