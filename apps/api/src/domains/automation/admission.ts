import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the automation routes, keyed by `METHOD /path` under `/api`. */
export const automationAdmission = {
  "GET /autopilot/rules": { kind: "workspace", capability: "content.view" },
  "POST /autopilot/rules": { kind: "workspace", capability: "content.edit", rate: { scope: "workspace", prefix: "autopilot-create", limit: 5, windowSeconds: 3600 } },
  "PATCH /autopilot/rules/:ruleId": { kind: "workspace", capability: "content.edit" },
  "DELETE /autopilot/rules/:ruleId": { kind: "workspace", capability: "content.edit" },
  "POST /autopilot/rules/:ruleId/take-over": { kind: "workspace", capability: "workspace.manage" },
  "POST /autopilot/rules/:ruleId/run-now": { kind: "workspace", capability: "processing.consume", rate: { scope: "workspace", prefix: "autopilot-run", limit: 10, windowSeconds: 3600 } },
} as const satisfies AdmissionTable;
