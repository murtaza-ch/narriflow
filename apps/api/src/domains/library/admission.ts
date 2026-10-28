import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the library routes, keyed by `METHOD /path` under `/api`. */
export const libraryAdmission = {
  "GET /workspace/search": { kind: "workspace", capability: "content.view" },
  "GET /library/search": { kind: "workspace", capability: "content.view", rate: { scope: "actor", prefix: "library-search", limit: 30 } },
  "GET /broll/search": { kind: "workspace", capability: "content.edit", rate: { scope: "actor", prefix: "broll-search", limit: 60 } },
  "GET /workspace/folders": { kind: "workspace", capability: "content.view" },
  // A retryable create: the limiter outcome is enforced after the immutable replay lookup.
  "POST /library/folders": { kind: "workspace", capability: "content.edit", deferRateRefusal: true },
  "PATCH /library/folders/:folderId": { kind: "workspace", capability: "content.edit" },
  "DELETE /library/folders/:folderId": { kind: "workspace", capability: "content.edit" },
} as const satisfies AdmissionTable;
