import type { AdmissionTable } from "../platform/admission-table";

/**
 * Admission of the studio routes, keyed by `METHOD /path` under `/api`.
 *
 * The Studio itself is an editing surface, so its bootstrap, polls and
 * retained-asset reads need `content.edit` as the page did. Facts the services
 * already gate on `content.view` (censor policy, brand snapshot, censor
 * analytics) keep that capability. The document PUT/reset use the `editor`
 * tier: 120/minute per actor+Workspace+clip plus the 300/minute actor ceiling,
 * instead of the ordinary mutation bucket. The layout and preview polls are
 * ordinary reads (300/minute) and never inherit the document exemption.
 */
export const studioAdmission = {
  "GET /projects/:id/clips/:clipId/studio": { kind: "project", capability: "content.edit", projectParam: "id" },
  "GET /projects/:id/clips/:clipId/preview-source": { kind: "project", capability: "content.edit", projectParam: "id" },
  "GET /projects/:id/clips/:clipId/layout/auto": { kind: "project", capability: "content.edit", projectParam: "id" },
  "GET /projects/:id/clips/:clipId/layout/split": { kind: "project", capability: "content.edit", projectParam: "id" },
  "GET /projects/:id/clips/:clipId/layout/screen": { kind: "project", capability: "content.edit", projectParam: "id" },
  "GET /projects/:id/clips/:clipId/editor-assets": { kind: "project", capability: "content.edit", projectParam: "id" },
  "PUT /projects/:id/censor-terms": { kind: "project", capability: "content.edit", projectParam: "id" },
  "POST /projects/:id/clips/:clipId/censor-events": { kind: "project", capability: "content.view", projectParam: "id" },
  "GET /projects/:id/auto-censor": { kind: "project", capability: "content.view", projectParam: "id" },
  "GET /projects/:id/brand-snapshot": { kind: "project", capability: "content.view", projectParam: "id" },
  "GET /generated-images/capability": { kind: "workspace", capability: "content.edit" },
  "PATCH /projects/:id/clips/:clipId": { kind: "project", capability: "content.edit", projectParam: "id" },
  "GET /projects/:id/clips/:clipId/editor": { kind: "project", capability: "content.edit", projectParam: "id" },
  "PUT /projects/:id/clips/:clipId/editor": { kind: "project", capability: "content.edit", projectParam: "id", tier: "editor", editorClipParam: "clipId" },
  "POST /projects/:id/clips/:clipId/editor/reset": { kind: "project", capability: "content.edit", projectParam: "id", tier: "editor", editorClipParam: "clipId" },
} as const satisfies AdmissionTable;
