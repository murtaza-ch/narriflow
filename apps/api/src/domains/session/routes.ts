import { createRouteApp } from "../../http/admission";
import { sessionAdmission } from "./admission";

/** Dependencies of the session routes. The owning ticket replaces this with the services it calls. */
export type SessionRouteDeps = Record<string, never>;

/** Identity bootstrap, Workspace selection and invite acceptance (signed-in admissions). */
export function createSessionRoutes(_deps: SessionRouteDeps) {
  return createRouteApp(sessionAdmission);
}

export type SessionRoutes = ReturnType<typeof createSessionRoutes>;
