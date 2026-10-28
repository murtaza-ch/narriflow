import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the automation routes, keyed by `METHOD /path` under `/api`. */
export const automationAdmission = {
  // Autopilot rules. Create and run-now are receipt-backed: the limiter outcome is recorded and
  // enforced only after the immutable replay lookup.
  "GET /autopilot/rules": { kind: "workspace", capability: "content.view" },
  "POST /autopilot/rules": { kind: "workspace", capability: "content.edit", deferRateRefusal: true, rate: { scope: "workspace", prefix: "autopilot-create", limit: 5, windowSeconds: 3600 } },
  "PATCH /autopilot/rules/:ruleId": { kind: "workspace", capability: "content.edit" },
  "DELETE /autopilot/rules/:ruleId": { kind: "workspace", capability: "content.edit" },
  "POST /autopilot/rules/:ruleId/take-over": { kind: "workspace", capability: "workspace.manage" },
  "POST /autopilot/rules/:ruleId/run-now": { kind: "workspace", capability: "processing.consume", deferRateRefusal: true, rate: { scope: "workspace", prefix: "autopilot-run", limit: 10, windowSeconds: 3600 } },
  // Screen aggregates.
  "GET /automation": { kind: "workspace", capability: "content.view" },
  "GET /automation/standing-grants": { kind: "workspace", capability: "content.view" },
  // Standing grants belong to Owners and Admins, who hold workspace.manage.
  "POST /automation/standing-grants": { kind: "workspace", capability: "workspace.manage" },
  "POST /automation/standing-grants/:grantId/renew": { kind: "workspace", capability: "workspace.manage" },
  "POST /automation/standing-grants/:grantId/pause": { kind: "workspace", capability: "workspace.manage" },
  "POST /automation/standing-grants/:grantId/revoke": { kind: "workspace", capability: "workspace.manage" },
  // Zoom. The callback is provider navigation without a session; the stored one-use state is its credential.
  "GET /zoom/connections": { kind: "workspace", capability: "content.view" },
  "DELETE /zoom/connections/:connectionId": { kind: "workspace", capability: "content.edit" },
  "POST /zoom/oauth/start": { kind: "workspace", capability: "content.edit", rate: { scope: "actor", prefix: "zoom-connect", limit: 10, windowSeconds: 3600 } },
  "GET /zoom/oauth/callback": { trust: "oauth_state" },
  "POST /webhooks/zoom": { trust: "provider_signature" },
} as const satisfies AdmissionTable;
