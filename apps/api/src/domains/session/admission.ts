import type { AdmissionTable } from "../platform/admission-table";

/**
 * Admission of the session routes, keyed by `METHOD /path` under `/api`. All
 * are signed-in only: bootstrap, switching and invitation acceptance must work
 * from a restricted or removed Workspace, so no Workspace is selected or read.
 */
export const sessionAdmission = {
  "GET /session/bootstrap": { kind: "signed_in" },
  "POST /session/workspace-selection": { kind: "signed_in" },
  "GET /invites/:token": { kind: "signed_in" },
  "POST /invites/:token/accept": { kind: "signed_in" },
} as const satisfies AdmissionTable;
