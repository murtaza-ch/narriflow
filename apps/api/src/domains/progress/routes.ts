import { createRouteApp } from "../../http/admission";
import { progressAdmission } from "./admission";

/** Dependencies of the progress routes. The owning ticket replaces this with the services it calls. */
export type ProgressRouteDeps = Record<string, never>;

/** The project progress stream (`/api/stream/:projectId`). */
export function createProgressRoutes(_deps: ProgressRouteDeps) {
  return createRouteApp(progressAdmission);
}

export type ProgressRoutes = ReturnType<typeof createProgressRoutes>;
