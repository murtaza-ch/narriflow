import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the exports routes, keyed by `METHOD /path` under `/api`. */
export const exportsAdmission = {
  "GET /workspace/exports": { kind: "workspace", capability: "content.view" },
  "GET /workspace/export-projects": { kind: "workspace", capability: "content.view" },
  "GET /workspace/exports/:exportId/download": { kind: "workspace", capability: "content.download" },
  "POST /workspace/exports/:exportId/retry": { kind: "workspace", capability: "processing.consume", rate: { scope: "actor", prefix: "clip-export-retry", limit: 12 } },
  "POST /projects/:id/export-bundles": { kind: "project", capability: "content.download", projectParam: "id", rate: { scope: "actor", prefix: "export-bundle", limit: 10, windowSeconds: 3600 } },
  "POST /projects/:id/export-bundles/preview": { kind: "project", capability: "content.download", projectParam: "id", rate: { scope: "actor", prefix: "export-bundle-preview", limit: 60 } },
  "GET /projects/:id/export-bundles": { kind: "project", capability: "content.view", projectParam: "id" },
  "GET /projects/:id/export-bundles/:bundleId": { kind: "project", capability: "content.view", projectParam: "id" },
  "POST /projects/:id/export-bundles/:bundleId/retry": { kind: "project", capability: "content.download", projectParam: "id", rate: { scope: "actor", prefix: "export-bundle-retry", limit: 10, windowSeconds: 3600 } },
  "POST /projects/:id/campaign-operations/:operationId/retry-export-bundle": { kind: "project", capability: "content.download", projectParam: "id", rate: { scope: "actor", prefix: "export-operation-retry", limit: 10, windowSeconds: 3600 } },
  "GET /projects/:id/export-bundles/:bundleId/download": { kind: "project", capability: "content.download", projectParam: "id" },
  "POST /projects/:id/clips/:clipId/exports": { kind: "project", capability: "processing.consume", projectParam: "id", rate: { scope: "actor", prefix: "clip-export", limit: 20 } },
  "GET /projects/:id/exports/current": { kind: "project", capability: "content.view", projectParam: "id" },
  "GET /projects/:id/clips/:clipId/exports/:exportId": { kind: "project", capability: "content.download", projectParam: "id" },
  "GET /projects/:id/clips/:clipId/exports/:exportId/subtitles/:format": { kind: "project", capability: "content.download", projectParam: "id" },
  "GET /projects/:id/clips/:clipId/timeline/:format": { kind: "project", capability: "content.download", projectParam: "id" },
  "GET /projects/:id/clips/:clipId/timeline-source": { kind: "project", capability: "content.download", projectParam: "id" },
  "POST /projects/:id/clips/:clipId/exports/:exportId/retry": { kind: "project", capability: "processing.consume", projectParam: "id", rate: { scope: "actor", prefix: "clip-export-retry", limit: 12 } },
  "POST /projects/:id/clips/:clipId/exports/:exportId/share-links": { kind: "project", capability: "content.edit", projectParam: "id", rate: { scope: "actor", prefix: "clip-share", limit: 10 } },
  "DELETE /projects/:id/clips/:clipId/exports/:exportId/share-links": { kind: "project", capability: "content.edit", projectParam: "id" },
} as const satisfies AdmissionTable;
