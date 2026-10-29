import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the clips routes, keyed by `METHOD /path` under `/api`. */
export const clipsAdmission = {
  "GET /projects/:id/clips": { kind: "project", capability: "content.view", projectParam: "id" },
  "GET /projects/:id/clips/:clipId/preview-peaks": { kind: "project", capability: "content.view", projectParam: "id" },
  "POST /projects/:id/clips/:clipId/title-suggestions": { kind: "project", capability: "processing.consume", projectParam: "id", rate: { scope: "actor", prefix: "clip-title-suggest", limit: 30 } },
  "POST /projects/:id/clips/:clipId/duplicate": { kind: "project", capability: "content.edit", projectParam: "id", rate: { scope: "actor", prefix: "clip-duplicate", limit: 30 }, deferRateRefusal: true },
  "POST /projects/:id/clips/:clipId/create-from-selection": { kind: "project", capability: "content.edit", projectParam: "id", deferRateRefusal: true },
  "POST /projects/:id/clips/create-from-range": { kind: "project", capability: "content.edit", projectParam: "id", deferRateRefusal: true },
  "DELETE /projects/:id/clips/:clipId": { kind: "project", capability: "content.edit", projectParam: "id" },
  "POST /projects/:id/clips/regenerate": { kind: "project", capability: "processing.consume", projectParam: "id", rate: { scope: "actor", prefix: "regenerate", limit: 20 } },
  "POST /projects/:id/clips/render": { kind: "project", capability: "processing.consume", projectParam: "id", rate: { scope: "actor", prefix: "render", limit: 20 } },
  "GET /projects/:id/campaign-operations": { kind: "project", capability: "content.view", projectParam: "id" },
  "POST /projects/:id/thumbnail-frames": { kind: "project", capability: "publishing.manage", projectParam: "id", rate: { scope: "actor", prefix: "thumbnail-frame", limit: 30 } },
  "GET /projects/:id/thumbnail-frames/:operationId": { kind: "project", capability: "content.view", projectParam: "id" },
  "POST /projects/:id/thumbnail-frames/:operationId/retry": { kind: "project", capability: "publishing.manage", projectParam: "id", rate: { scope: "actor", prefix: "thumbnail-frame-retry", limit: 20 } },
  "GET /projects/:id/campaign-operations/editor-action-catalog": { kind: "project", capability: "content.view", projectParam: "id" },
  "POST /projects/:id/campaign-operations/preview-editor-action": { kind: "project", capability: "content.view", projectParam: "id", rate: { scope: "actor", prefix: "preview-campaign-editor-action", limit: 60 } },
  "POST /projects/:id/campaign-operations/apply-brand-profile": { kind: "project", capability: "content.edit", projectParam: "id", rate: { scope: "actor", prefix: "apply-brand-profile-selected", limit: 20, windowSeconds: 3600 } },
  "POST /projects/:id/campaign-operations/apply-style": { kind: "project", capability: "content.edit", projectParam: "id", rate: { scope: "actor", prefix: "apply-style-selected", limit: 20, windowSeconds: 3600 } },
  "POST /projects/:id/campaign-operations/apply-motion": { kind: "project", capability: "content.edit", projectParam: "id", rate: { scope: "actor", prefix: "apply-motion-selected", limit: 20, windowSeconds: 3600 } },
  "POST /projects/:id/clips/apply-caption-preset": { kind: "project", capability: "content.edit", projectParam: "id" },
  "POST /projects/:id/clips/apply-studio-edits": { kind: "project", capability: "content.edit", projectParam: "id" },
  "GET /projects/:id/clips/previews": { kind: "project", capability: "content.view", projectParam: "id" },
  "GET /projects/:id/clips/:clipId/download": { kind: "project", capability: "content.download", projectParam: "id" },
} as const satisfies AdmissionTable;
