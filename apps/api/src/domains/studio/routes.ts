import { createRouteApp } from "../../http/admission";
import { studioAdmission } from "./admission";

/** Dependencies of the studio routes. The owning ticket replaces this with the services it calls. */
export type StudioRouteDeps = Record<string, never>;

/** Studio bootstrap, preview/layout reads and editor persistence. */
export function createStudioRoutes(_deps: StudioRouteDeps) {
  return createRouteApp(studioAdmission);
}

export type StudioRoutes = ReturnType<typeof createStudioRoutes>;
