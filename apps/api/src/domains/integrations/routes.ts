import { Hono } from "hono";
import type { ApiEnv } from "../../http/env";

/** Dependencies of the integrations routes. The owning ticket replaces this with the services it calls. */
export type IntegrationsRouteDeps = Record<string, never>;

/** First-party MCP continuation and status routes (signed-in plus signed continuation). */
export function createIntegrationsRoutes(_deps: IntegrationsRouteDeps) {
  return new Hono<ApiEnv>();
}

export type IntegrationsRoutes = ReturnType<typeof createIntegrationsRoutes>;
