import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the projects routes, keyed by `METHOD /path` under `/api`. */
export const projectsAdmission = {
  "GET /projects": { kind: "workspace", capability: "content.view" },
  "POST /projects/:id/generate": { kind: "project", capability: "processing.consume", projectParam: "id", rate: { scope: "actor", prefix: "gen", limit: 20 } },
  "GET /projects/:id": { kind: "project", capability: "content.view", projectParam: "id" },
  "GET /projects/:id/runs/:workflowRunId": { kind: "project", capability: "content.view", projectParam: "id" },
  "GET /projects/:id/transcript": { kind: "project", capability: "content.view", projectParam: "id" },
  "GET /projects/:id/transcript/utterances": { kind: "project", capability: "content.view", projectParam: "id" },
  "GET /projects/:id/transcript/export": { kind: "project", capability: "content.download", projectParam: "id" },
  "GET /projects/:id/content-suite": { kind: "project", capability: "content.view", projectParam: "id" },
  "POST /projects/:id/content-suite": { kind: "project", capability: "processing.consume", projectParam: "id", rate: { scope: "actor", prefix: "content-suite", limit: 30 } },
  "GET /projects/:id/analytics": { kind: "project", capability: "content.view", projectParam: "id" },
  "GET /projects/:id/dubs": { kind: "project", capability: "content.view", projectParam: "id" },
  "POST /projects/:id/dubs": { kind: "project", capability: "processing.consume", projectParam: "id", rate: { scope: "actor", prefix: "dubs", limit: 20 } },
  "GET /projects/:id/dubs/:dubId/download": { kind: "project", capability: "content.download", projectParam: "id" },
} as const satisfies AdmissionTable;
