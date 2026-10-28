import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the library routes, keyed by `METHOD /path` under `/api`. */
export const libraryAdmission = {
  "GET /workspace/search": { kind: "workspace", capability: "content.view" },
  "GET /library/search": { kind: "workspace", capability: "content.view", rate: { scope: "actor", prefix: "library-search", limit: 30 } },
  "GET /broll/search": { kind: "workspace", capability: "content.edit", rate: { scope: "actor", prefix: "broll-search", limit: 60 } },
} as const satisfies AdmissionTable;
