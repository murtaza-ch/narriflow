import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the ingest routes, keyed by `METHOD /path` under `/api`. */
export const ingestAdmission = {
  "GET /ingest/configuration": { kind: "workspace", capability: "processing.consume" },
  "GET /ingest/link/metadata": { kind: "workspace", capability: "content.view" },
  "POST /ingest/link": { kind: "workspace", capability: "processing.consume" },
  // Each commit makes one Drive API call on the person's behalf.
  "POST /ingest/drive": { kind: "workspace", capability: "processing.consume", rate: { scope: "workspace", prefix: "drive-import", limit: 10 } },
  "POST /ingest/rss/preview": { kind: "workspace", capability: "processing.consume", rate: { scope: "workspace", prefix: "rss-preview", limit: 20 } },
  "POST /ingest/rss/import": { kind: "workspace", capability: "processing.consume", rate: { scope: "workspace", prefix: "rss-import", limit: 5 } },
  "GET /ingest/:projectId": { kind: "project", capability: "content.view", projectParam: "projectId" },
  "GET /ingest/:projectId/resume": { kind: "project", capability: "processing.consume", projectParam: "projectId" },
  "POST /ingest/:projectId/retry": { kind: "project", capability: "processing.consume", projectParam: "projectId" },
  "PUT /projects/:id/generation/draft": { kind: "project", capability: "content.edit", projectParam: "id" },
  "POST /projects/:id/generation/finalize": { kind: "project", capability: "content.edit", projectParam: "id" },
  "POST /upload-sessions/open": { kind: "workspace", capability: "processing.consume", rate: { scope: "actor", prefix: "upload-session-open", limit: 60 } },
  "POST /upload-sessions/finalize": { kind: "workspace", capability: "processing.consume", rate: { scope: "actor", prefix: "upload-session-finalize", limit: 60 } },
  // Multipart parts and status polls are bursts of small POSTs; they have their own
  // ceilings (120/minute) and must not draw on the ordinary 60/minute control bucket.
  "POST /upload-sessions/grants": { kind: "workspace", capability: "processing.consume", tier: "read", rate: { scope: "actor", prefix: "upload-session-grants", limit: 120 } },
  "POST /upload-sessions/status": { kind: "workspace", capability: "processing.consume", tier: "read", rate: { scope: "actor", prefix: "upload-session-status", limit: 120 } },
  "POST /upload-sessions/discard": { kind: "workspace", capability: "processing.consume", rate: { scope: "actor", prefix: "upload-session-discard", limit: 30 } },
} as const satisfies AdmissionTable;
