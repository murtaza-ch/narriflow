import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the workspace routes, keyed by `METHOD /path` under `/api`. */
export const workspaceAdmission = {
  "POST /workspace/avatar/presign": { kind: "workspace", capability: "workspace.manage" },
  "PATCH /workspace/avatar": { kind: "workspace", capability: "workspace.manage" },
} as const satisfies AdmissionTable;
