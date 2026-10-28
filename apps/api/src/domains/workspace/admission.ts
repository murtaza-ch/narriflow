import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the workspace routes, keyed by `METHOD /path` under `/api`. */
export const workspaceAdmission = {
  "GET /workspace/bootstrap": { kind: "workspace", capability: "content.view" },
  "GET /workspace": { kind: "workspace", capability: "content.view" },
  "PATCH /workspace": { kind: "workspace", capability: "workspace.manage" },
  "GET /workspace/usage": { kind: "workspace", capability: "content.view" },
  "GET /workspace/members": { kind: "workspace", capability: "content.view" },
  // Invites create a credential and send email: receipt-backed, so the limiter outcome is
  // recorded here and enforced only after immutable replay lookup.
  "POST /workspace/invites": { kind: "workspace", capability: "members.invite", deferRateRefusal: true },
  "POST /workspace/invites/:inviteId/resend": { kind: "workspace", capability: "members.invite", deferRateRefusal: true },
  "DELETE /workspace/invites/:inviteId": { kind: "workspace", capability: "members.invite" },
  "PATCH /workspace/members/:memberId": { kind: "workspace", capability: "members.invite" },
  "DELETE /workspace/members/:memberId": { kind: "workspace", capability: "members.invite" },
  "PATCH /workspace/performance-guidance": { kind: "workspace", capability: "workspace.manage" },
  "GET /workspace/censor-words": { kind: "workspace", capability: "content.view" },
  "PUT /workspace/censor-words": { kind: "workspace", capability: "workspace.manage" },
  "DELETE /workspace/censor-words": { kind: "workspace", capability: "workspace.manage" },
  "POST /workspace/avatar/presign": { kind: "workspace", capability: "workspace.manage" },
  "PATCH /workspace/avatar": { kind: "workspace", capability: "workspace.manage" },
} as const satisfies AdmissionTable;
