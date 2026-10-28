import { Hono } from "hono";
import type { ApiEnv } from "../../http/env";

/** Dependencies of the progress routes. The owning ticket replaces this with the services it calls. */
export type ProgressRouteDeps = Record<string, never>;

/** The project progress stream (`/api/stream/:projectId`). */
export function createProgressRoutes(_deps: ProgressRouteDeps) {
  return new Hono<ApiEnv>();
}

export type ProgressRoutes = ReturnType<typeof createProgressRoutes>;
