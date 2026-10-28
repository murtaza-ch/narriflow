import { Hono } from "hono";
import type { ApiEnv } from "../../http/env";

/** Dependencies of the studio routes. The owning ticket replaces this with the services it calls. */
export type StudioRouteDeps = Record<string, never>;

/** Studio bootstrap, preview/layout reads and editor persistence. */
export function createStudioRoutes(_deps: StudioRouteDeps) {
  return new Hono<ApiEnv>();
}

export type StudioRoutes = ReturnType<typeof createStudioRoutes>;
