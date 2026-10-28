import { Hono } from "hono";
import type { ApiEnv } from "../../http/env";

/** Dependencies of the session routes. The owning ticket replaces this with the services it calls. */
export type SessionRouteDeps = Record<string, never>;

/** Identity bootstrap, Workspace selection and invite acceptance (signed-in admissions). */
export function createSessionRoutes(_deps: SessionRouteDeps) {
  return new Hono<ApiEnv>();
}

export type SessionRoutes = ReturnType<typeof createSessionRoutes>;
