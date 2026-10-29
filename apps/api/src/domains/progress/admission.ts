import type { AdmissionTable } from "../platform/admission-table";

/**
 * Admission of the progress routes, keyed by `METHOD /path` under `/api`.
 * The `stream` tier is the actor's connection-start limit (30/minute).
 */
export const progressAdmission = {
  "GET /stream/:projectId": {
    kind: "project",
    capability: "content.view",
    projectParam: "projectId",
    tier: "stream",
  },
} as const satisfies AdmissionTable;
