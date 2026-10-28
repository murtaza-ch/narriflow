import { createRouteApp } from "../../http/admission";
import { integrationsAdmission } from "./admission";

/** Dependencies of the integrations routes. The owning ticket replaces this with the services it calls. */
export type IntegrationsRouteDeps = Record<string, never>;

/** First-party MCP continuation and status routes (signed-in plus signed continuation). */
export function createIntegrationsRoutes(_deps: IntegrationsRouteDeps) {
  return createRouteApp(integrationsAdmission);
}

export type IntegrationsRoutes = ReturnType<typeof createIntegrationsRoutes>;
