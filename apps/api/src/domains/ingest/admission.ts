import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the ingest routes, keyed by `METHOD /path` under `/api`. */
export const ingestAdmission = {
  "POST /ingest/link": { kind: "workspace", capability: "processing.consume" },
  "POST /ingest/rss/preview": { kind: "workspace", capability: "processing.consume", rate: { scope: "workspace", prefix: "rss-preview", limit: 20 } },
  "POST /ingest/rss/import": { kind: "workspace", capability: "processing.consume", rate: { scope: "workspace", prefix: "rss-import", limit: 5 } },
  "GET /ingest/:projectId": { kind: "project", capability: "content.view", projectParam: "projectId" },
} as const satisfies AdmissionTable;
