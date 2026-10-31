import type { AdmissionTable } from "../platform/admission-table";

/** Ticket issuance resolves the current actor, membership and Project. */
export const progressAdmission = {
  "POST /projects/:projectId/progress-ticket": { kind: "project", capability: "content.view", projectParam: "projectId", tier: "stream" },
} as const satisfies AdmissionTable;

export const progressSocketAdmission = {
  "GET /progress/:projectId": { trust: "progress_connect_ticket" },
} as const satisfies AdmissionTable;
